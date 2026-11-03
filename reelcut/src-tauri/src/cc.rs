//! "Claude 계정" mode: the editing agent runs through Claude Code (the `claude` command), signed in
//! with the user's Claude subscription, so it uses the plan's usage limits instead of per-token API
//! billing. Reelcut's editing tools reach it through a small MCP server on 127.0.0.1: each
//! `tools/call` is handed to the app (the tool code lives in the webview) and the answer goes back.

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

pub const SERVER: &str = "reelcut";

/// Hands a tool call to the app: (call id, tool name, input).
pub type ToolSink = Arc<dyn Fn(String, String, Value) + Send + Sync>;

pub struct Bridge {
    pub port: u16,
    pub token: String,
    tools: Mutex<Value>,
    pending: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    next: Mutex<u64>,
    child: Mutex<Option<Child>>,
    sink: Mutex<Option<ToolSink>>,
}

impl Bridge {
    /// Starts the MCP server on a free local port.
    pub fn start() -> std::io::Result<Arc<Bridge>> {
        let l = TcpListener::bind("127.0.0.1:0")?;
        let port = l.local_addr()?.port();
        let token = format!("{:x}{:x}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        let b = Arc::new(Bridge {
            port,
            token,
            tools: Mutex::new(json!([])),
            pending: Mutex::new(HashMap::new()),
            next: Mutex::new(0),
            child: Mutex::new(None),
            sink: Mutex::new(None),
        });
        let b2 = b.clone();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let b3 = b2.clone();
                std::thread::spawn(move || {
                    let _ = b3.serve(s);
                });
            }
        });
        Ok(b)
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp/{}", self.port, self.token)
    }

    pub fn set_sink(&self, f: ToolSink) {
        *self.sink.lock() = Some(f);
    }

    /// Tools in Messages API shape ({name, description, input_schema}).
    pub fn set_tools(&self, tools: &Value) {
        let list: Vec<Value> = tools
            .as_array()
            .map(|a| a.iter().map(|t| json!({ "name": t["name"], "description": t["description"], "inputSchema": t["input_schema"] })).collect())
            .unwrap_or_default();
        *self.tools.lock() = Value::Array(list);
    }

    /// The app's answer to a tool call: {content:[…MCP content…], isError}.
    pub fn answer(&self, id: &str, result: Value) -> bool {
        if let Some(tx) = self.pending.lock().remove(id) {
            return tx.send(result).is_ok();
        }
        false
    }

    /// Fails every waiting tool call (used when the run stops).
    pub fn fail_pending(&self, why: &str) {
        for (_, tx) in self.pending.lock().drain() {
            let _ = tx.send(json!({ "content": [{ "type": "text", "text": why }], "isError": true }));
        }
    }

    fn call_tool(&self, name: &str, input: Value) -> Value {
        let sink = self.sink.lock().clone();
        let Some(sink) = sink else {
            return json!({ "content": [{ "type": "text", "text": "앱이 준비되지 않았습니다" }], "isError": true });
        };
        let id = {
            let mut n = self.next.lock();
            *n += 1;
            format!("t{}", *n)
        };
        let (tx, rx) = mpsc::channel();
        self.pending.lock().insert(id.clone(), tx);
        sink(id.clone(), name.to_string(), input);
        match rx.recv_timeout(Duration::from_secs(3 * 3600)) {
            Ok(v) => v,
            Err(_) => {
                self.pending.lock().remove(&id);
                json!({ "content": [{ "type": "text", "text": "도구가 응답하지 않았습니다" }], "isError": true })
            }
        }
    }

    fn rpc(&self, req: &Value) -> Option<Value> {
        let id = req.get("id").cloned()?; // notifications get no answer
        let method = req["method"].as_str().unwrap_or("");
        let result = match method {
            "initialize" => Ok(json!({
                "protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": SERVER, "version": env!("CARGO_PKG_VERSION") },
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": self.tools.lock().clone() })),
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("").to_string();
                let input = req["params"].get("arguments").cloned().unwrap_or(json!({}));
                Ok(self.call_tool(&name, input))
            }
            "resources/list" => Ok(json!({ "resources": [] })),
            "prompts/list" => Ok(json!({ "prompts": [] })),
            _ => Err(json!({ "code": -32601, "message": format!("method not found: {method}") })),
        };
        Some(match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
        })
    }

    fn serve(&self, mut s: TcpStream) -> std::io::Result<()> {
        s.set_read_timeout(Some(Duration::from_secs(60)))?;
        let mut r = BufReader::new(s.try_clone()?);
        loop {
            let mut line = String::new();
            if r.read_line(&mut line)? == 0 {
                return Ok(());
            }
            let mut parts = line.split_whitespace();
            let method = parts.next().unwrap_or("").to_string();
            let path = parts.next().unwrap_or("").to_string();
            let mut len = 0usize;
            let mut close = false;
            loop {
                let mut h = String::new();
                if r.read_line(&mut h)? == 0 {
                    return Ok(());
                }
                let h = h.trim_end();
                if h.is_empty() {
                    break;
                }
                let lower = h.to_ascii_lowercase();
                if let Some(v) = lower.strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
                if lower.starts_with("connection:") && lower.contains("close") {
                    close = true;
                }
            }
            let mut body = vec![0u8; len];
            r.read_exact(&mut body)?;
            let ok_path = path.split('?').next() == Some(&format!("/mcp/{}", self.token));
            let (status, out): (&str, Vec<u8>) = if !ok_path {
                ("404 Not Found", Vec::new())
            } else if method == "POST" {
                match serde_json::from_slice::<Value>(&body) {
                    Ok(Value::Array(reqs)) => {
                        let res: Vec<Value> = reqs.iter().filter_map(|q| self.rpc(q)).collect();
                        if res.is_empty() { ("202 Accepted", Vec::new()) } else { ("200 OK", serde_json::to_vec(&res).unwrap_or_default()) }
                    }
                    Ok(q) => match self.rpc(&q) {
                        Some(v) => ("200 OK", serde_json::to_vec(&v).unwrap_or_default()),
                        None => ("202 Accepted", Vec::new()),
                    },
                    Err(_) => ("400 Bad Request", Vec::new()),
                }
            } else if method == "DELETE" {
                ("200 OK", Vec::new())
            } else {
                ("405 Method Not Allowed", Vec::new())
            };
            let ctype = if out.is_empty() { "" } else { "Content-Type: application/json\r\n" };
            let head = format!("HTTP/1.1 {status}\r\n{ctype}Content-Length: {}\r\n{}\r\n", out.len(), if close { "Connection: close\r\n" } else { "" });
            s.write_all(head.as_bytes())?;
            s.write_all(&out)?;
            s.flush()?;
            if close {
                return Ok(());
            }
        }
    }

    /// Stops a running agent turn.
    pub fn stop(&self) -> bool {
        let killed = if let Some(mut c) = self.child.lock().take() { c.kill().is_ok() } else { false };
        self.fail_pending("사용자가 멈췄습니다.");
        killed
    }
}

// ---------------------------------------------------------------- finding and checking `claude`

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default()
}

/// The Claude Code executable: REELCUT_CLAUDE, PATH, then the native installer's folder.
pub fn find() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("REELCUT_CLAUDE") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    if let Some(paths) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&paths) {
            let p = d.join(exe);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let h = home();
    for p in [h.join(".local").join("bin").join(exe), h.join(".claude").join("local").join(exe)] {
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn cmd(bin: &Path) -> Command {
    let mut c = Command::new(bin);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c.stdin(Stdio::null());
    c
}

fn out(bin: &Path, args: &[&str]) -> Result<(bool, String, String), String> {
    let o = cmd(bin).args(args).output().map_err(|e| e.to_string())?;
    Ok((o.status.success(), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned()))
}

#[derive(Serialize, Clone, Default)]
pub struct Status {
    pub found: bool,
    pub path: String,
    pub version: String,
    pub logged_in: bool,
    /// "claude.ai" (subscription) or "console" etc., as Claude Code reports it
    pub method: String,
    pub account: String,
    pub plan: String,
    pub error: String,
}

pub fn status() -> Status {
    let Some(bin) = find() else { return Status::default() };
    let mut s = Status { found: true, path: bin.to_string_lossy().into_owned(), ..Default::default() };
    if let Ok((_, o, _)) = out(&bin, &["--version"]) {
        s.version = o.split_whitespace().next().unwrap_or("").to_string();
    }
    match out(&bin, &["auth", "status", "--json"]) {
        Ok((_, o, e)) => match serde_json::from_str::<Value>(o.trim()) {
            Ok(v) => {
                let st = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
                s.logged_in = v.get("loggedIn").and_then(|x| x.as_bool()).unwrap_or(false);
                s.method = st("authMethod");
                s.account = [st("email"), st("orgName")].into_iter().find(|x| !x.is_empty()).unwrap_or_default();
                s.plan = st("subscriptionType");
            }
            Err(_) => s.error = format!("{}{}", o.trim(), e.trim()).chars().take(300).collect(),
        },
        Err(e) => s.error = e,
    }
    s
}

/// Opens a console window running `claude auth login` (the browser sign-in for the Claude plan).
pub fn login() -> Result<(), String> {
    let bin = find().ok_or("Claude Code가 없습니다. 먼저 설치하세요.")?;
    let mut c = Command::new(&bin);
    c.args(["auth", "login", "--claudeai"]);
    #[cfg(windows)]
    c.creation_flags(CREATE_NEW_CONSOLE);
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Installs Claude Code with Anthropic's official installer, in a visible console window.
pub fn install() -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex; Write-Host ''; Write-Host '설치가 끝났습니다. 이 창을 닫고 Reelcut에서 다시 확인을 누르세요.'; Read-Host"]);
        c.creation_flags(CREATE_NEW_CONSOLE);
        return c.spawn().map(|_| ()).map_err(|e| e.to_string());
    }
    #[cfg(not(windows))]
    {
        Command::new("sh").args(["-c", "curl -fsSL https://claude.ai/install.sh | bash"]).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------- one agent turn

pub struct Turn {
    pub model: String,
    pub effort: String,
    pub system: String,
    pub prompt: String,
    pub session: Option<String>,
    pub workdir: PathBuf,
}

fn help_text(bin: &Path) -> String {
    static HELP: Mutex<Option<(PathBuf, String)>> = Mutex::new(None);
    if let Some((p, h)) = HELP.lock().as_ref() {
        if p == bin {
            return h.clone();
        }
    }
    let h = out(bin, &["--help"]).map(|(_, o, e)| o + &e).unwrap_or_default();
    *HELP.lock() = Some((bin.to_path_buf(), h.clone()));
    h
}

/// Command-line arguments for one turn. `has` says whether this Claude Code knows a flag.
pub fn args(t: &Turn, mcp_config: &Path, has: impl Fn(&str) -> bool) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose"].iter().map(|s| s.to_string()).collect();
    a.extend(["--model".into(), t.model.clone()]);
    if has("--effort") && !t.effort.is_empty() {
        a.extend(["--effort".into(), t.effort.clone()]);
    }
    a.extend(["--system-prompt".into(), t.system.clone()]);
    a.extend(["--mcp-config".into(), mcp_config.to_string_lossy().into_owned(), "--strict-mcp-config".into()]);
    if has("--tools") {
        a.extend(["--tools".into(), String::new()]);
    } else {
        a.extend(["--disallowedTools".into(), "Bash Edit Write Read Glob Grep WebFetch WebSearch NotebookEdit Task TodoWrite".into()]);
    }
    a.extend(["--allowedTools".into(), format!("mcp__{SERVER}")]);
    if has("dontAsk") {
        a.extend(["--permission-mode".into(), "dontAsk".into()]);
    }
    if has("--disable-slash-commands") {
        a.push("--disable-slash-commands".into());
    }
    if let Some(s) = t.session.as_ref().filter(|s| !s.is_empty()) {
        a.extend(["--resume".into(), s.clone()]);
    }
    a
}

/// Runs one turn: streams each stdout JSON line to `on_line`, returns (exit ok, stderr tail).
pub fn run(bridge: &Bridge, t: Turn, mut on_line: impl FnMut(Value)) -> Result<(bool, String), String> {
    let bin = find().ok_or("Claude Code가 없습니다. 설정에서 설치하세요.")?;
    std::fs::create_dir_all(&t.workdir).map_err(|e| e.to_string())?;
    let cfg = t.workdir.join("mcp.json");
    std::fs::write(&cfg, serde_json::to_vec(&json!({ "mcpServers": { SERVER: { "type": "http", "url": bridge.url() } } })).unwrap()).map_err(|e| e.to_string())?;
    let help = help_text(&bin);
    let a = args(&t, &cfg, |f| help.contains(f));
    let mut c = cmd(&bin);
    c.args(&a)
        .current_dir(&t.workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("MCP_TOOL_TIMEOUT", "10800000")
        .env("MCP_TIMEOUT", "30000")
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        // An API key in the environment would bill per token instead of the Claude plan.
        .env_remove("ANTHROPIC_API_KEY");
    let mut child = c.spawn().map_err(|e| format!("Claude Code를 실행하지 못했습니다: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    *bridge.child.lock() = Some(child);
    let prompt = t.prompt.clone();
    std::thread::spawn(move || {
        let _ = stdin.write_all(prompt.as_bytes());
    });
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut s);
        s
    });
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
            on_line(v);
        }
    }
    let err = err_thread.join().unwrap_or_default();
    let ok = match bridge.child.lock().take() {
        Some(mut c) => c.wait().map(|s| s.success()).unwrap_or(false),
        None => false, // stopped
    };
    bridge.fail_pending("에이전트가 끝났습니다.");
    let tail: String = err.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
    Ok((ok, tail))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(port: u16, path: &str, body: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        let mut o = String::new();
        s.read_to_string(&mut o).unwrap();
        o
    }

    #[test]
    fn mcp_server_lists_and_calls_tools() {
        let b = Bridge::start().unwrap();
        b.set_tools(&json!([{ "name": "echo", "description": "d", "input_schema": { "type": "object" } }]));
        let b2 = b.clone();
        b.set_sink(Arc::new(move |id, name, input| {
            let b3 = b2.clone();
            std::thread::spawn(move || {
                b3.answer(&id, json!({ "content": [{ "type": "text", "text": format!("{name}:{}", input["x"]) }], "isError": false }));
            });
        }));
        let p = format!("/mcp/{}", b.token);
        let r = post(b.port, &p, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#);
        assert!(r.starts_with("HTTP/1.1 200") && r.contains("\"reelcut\""), "{r}");
        let r = post(b.port, &p, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert!(r.starts_with("HTTP/1.1 202"), "{r}");
        let r = post(b.port, &p, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
        assert!(r.contains("\"inputSchema\"") && r.contains("\"echo\""), "{r}");
        let r = post(b.port, &p, r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"x":7}}}"#);
        assert!(r.contains("echo:7"), "{r}");
        assert!(post(b.port, "/mcp/wrong", "{}").starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn args_use_only_known_flags() {
        let t = Turn { model: "claude-haiku-5-5".into(), effort: "low".into(), system: "s".into(), prompt: "p".into(), session: Some("abc".into()), workdir: PathBuf::from(".") };
        let a = args(&t, Path::new("m.json"), |_| true);
        assert!(a.windows(2).any(|w| w[0] == "--resume" && w[1] == "abc"));
        assert!(a.windows(2).any(|w| w[0] == "--tools" && w[1].is_empty()));
        let a = args(&t, Path::new("m.json"), |_| false);
        assert!(!a.contains(&"--effort".to_string()) && !a.contains(&"--tools".to_string()));
        assert!(a.contains(&"--disallowedTools".to_string()));
    }

    /// Real Claude Code end to end (costs a little usage). REELCUT_CC_LIVE=1 cargo test cc_live -- --nocapture
    #[test]
    fn cc_live() {
        if std::env::var("REELCUT_CC_LIVE").is_err() {
            return;
        }
        let b = Bridge::start().unwrap();
        b.set_tools(&json!([{ "name": "get_secret_word", "description": "Returns the secret word.", "input_schema": { "type": "object", "properties": {} } }]));
        let b2 = b.clone();
        let calls = Arc::new(Mutex::new(Vec::<String>::new()));
        let c2 = calls.clone();
        b.set_sink(Arc::new(move |id, name, _| {
            c2.lock().push(name.clone());
            let b3 = b2.clone();
            std::thread::spawn(move || {
                b3.answer(&id, json!({ "content": [{ "type": "text", "text": "보라색깃발" }], "isError": false }));
            });
        }));
        let dir = std::env::temp_dir().join("reelcut-cc-live");
        let mut session = None;
        let mut text = String::new();
        let (ok, err) = run(
            &b,
            Turn { model: "claude-haiku-5-5".into(), effort: "low".into(), system: "Answer in Korean. Use the tool when asked about the secret word.".into(), prompt: "비밀 단어가 뭐야? 도구로 확인해서 그 단어만 말해.".into(), session: None, workdir: dir.clone() },
            |v| {
                if v["type"] == "system" {
                    session = v["session_id"].as_str().map(String::from);
                }
                if v["type"] == "result" {
                    text = v["result"].as_str().unwrap_or("").to_string();
                }
                println!("{}", v.to_string().chars().take(300).collect::<String>());
            },
        )
        .unwrap();
        println!("ok={ok} err={err}");
        assert!(ok, "{err}");
        assert!(calls.lock().iter().any(|n| n == "get_secret_word"), "tool not called");
        assert!(text.contains("보라색깃발"), "{text}");
        // Second turn resumes the same conversation.
        let mut text2 = String::new();
        let (ok, err) = run(
            &b,
            Turn { model: "claude-haiku-5-5".into(), effort: "low".into(), system: "Answer in Korean. Use the tool when asked about the secret word.".into(), prompt: "방금 그 단어를 한 번 더 말해 줘. 도구는 쓰지 마.".into(), session, workdir: dir },
            |v| {
                if v["type"] == "result" {
                    text2 = v["result"].as_str().unwrap_or("").to_string();
                }
            },
        )
        .unwrap();
        assert!(ok, "{err}");
        assert!(text2.contains("보라색깃발"), "{text2}");
    }
}
