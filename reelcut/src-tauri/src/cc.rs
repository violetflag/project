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

// ---------------------------------------------------------------- Reelcut's own copy of Claude Code

/// Like Selects, Reelcut keeps its own pinned Claude Code in its data folder (downloaded from the
/// npm registry on first connect, checked against the published sha512) and its own sign-in
/// (CLAUDE_CONFIG_DIR), separate from any Claude Code or Claude desktop app on the PC.
pub const CC_VERSION: &str = "2.1.317";

fn platform() -> Option<(&'static str, &'static str)> {
    let p = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => ("win32-x64", "sha512-kqVqDRmi5iTQMPpCg9JmYuJm2Cwv8CIh9AVvkLEq4tpb3uOCcUvybmJ5l+6gouDlFa76FbFupvmRmmowFYygfA=="),
        ("windows", "aarch64") => ("win32-arm64", "sha512-fhCTwE3Vt1QHhxBcjhJqTQUJ3INAPWhtitvCVoQY10Mnigfbo+uO7Dxo0MTk5iv6J4t6kM2Qh/QYLuL3aF61Wg=="),
        ("linux", "x86_64") => ("linux-x64", "sha512-u19fYJ4llqi+dAGAj6P1BNu/CRSe0rv4O8Mv/5SQPU5oXCYmUssbJgrBI6rWbIFRAE3YcLCzKlwdHbzlSXBlSA=="),
        ("macos", "aarch64") => ("darwin-arm64", "sha512-Xnf9K4aGBuoYaODmEZ0o/lRvuYUCv2ZIDP+AXv15WVITryGgrsSA7CFL7KH+43kC6WhK8i6oysF6EbGdgBW4Aw=="),
        ("macos", "x86_64") => ("darwin-x64", "sha512-CyElNeIVipIXwn7oRY3a5PpeOm0RuwekKLNCZq/gFnrkmSMBnqSWlAKKc8Q1W2UBFlkejwbzI+uPfgD51aiJGw=="),
        _ => return None,
    };
    Some(p)
}

const EXE: &str = if cfg!(windows) { "claude.exe" } else { "claude" };

pub fn own_exe(data: &Path) -> PathBuf {
    data.join("claude").join(CC_VERSION).join(EXE)
}

/// Reelcut's own Claude sign-in lives here.
pub fn config_dir(data: &Path) -> PathBuf {
    data.join("claude").join("config")
}

/// Downloads and checks Reelcut's copy of Claude Code. `on(percent, message)`.
pub fn download(data: &Path, mut on: impl FnMut(f64, &str)) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha512};
    let exe = own_exe(data);
    if exe.is_file() {
        return Ok(exe);
    }
    let (plat, integrity) = platform().ok_or("이 컴퓨터 종류는 지원하지 않습니다")?;
    let url = format!("https://registry.npmjs.org/@anthropic-ai/claude-code-{plat}/-/claude-code-{plat}-{CC_VERSION}.tgz");
    let dir = exe.parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    on(0.0, "Claude Code 내려받는 중");
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(20)).timeout_read(Duration::from_secs(120)).build();
    let resp = agent.get(&url).call().map_err(|e| format!("내려받기 실패: {e}"))?;
    let total: f64 = resp.header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let tgz = dir.join("package.tgz.part");
    let mut f = std::fs::File::create(&tgz).map_err(|e| e.to_string())?;
    let mut r = resp.into_reader();
    let mut h = Sha512::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut got = 0f64;
    let mut last = 0f64;
    loop {
        let n = r.read(&mut buf).map_err(|e| format!("내려받기 끊김: {e}"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        got += n as f64;
        if total > 0.0 && got - last > 2_000_000.0 {
            last = got;
            on(got / total * 90.0, &format!("Claude Code 내려받는 중 {:.0}/{:.0}MB", got / 1e6, total / 1e6));
        }
    }
    drop(f);
    let sum = h.finalize();
    on(92.0, "압축 푸는 중");
    let r = unpack_checked(&tgz, &sum, integrity, &exe);
    let _ = std::fs::remove_file(&tgz);
    r?;
    on(100.0, "완료");
    Ok(exe)
}

/// Checks the package's sha512 against the published integrity, then puts its executable at `exe`.
fn unpack_checked(tgz: &Path, sha512: &[u8], integrity: &str, exe: &Path) -> Result<(), String> {
    use base64::Engine;
    let sum = format!("sha512-{}", base64::engine::general_purpose::STANDARD.encode(sha512));
    if sum != integrity {
        return Err("내려받은 파일이 공식 파일과 다릅니다 (무결성 확인 실패)".into());
    }
    let gz = flate2::read::GzDecoder::new(std::fs::File::open(tgz).map_err(|e| e.to_string())?);
    let mut ar = tar::Archive::new(gz);
    let tmp = exe.with_extension("part");
    let mut found = false;
    for e in ar.entries().map_err(|e| e.to_string())? {
        let mut e = e.map_err(|e| e.to_string())?;
        let name = e.path().map_err(|e| e.to_string())?.to_string_lossy().into_owned();
        if name == format!("package/{EXE}") || name == format!("package/bin/{EXE}") {
            e.unpack(&tmp).map_err(|e| e.to_string())?;
            found = true;
            break;
        }
    }
    if !found {
        return Err("패키지 안에 실행 파일이 없습니다".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    std::fs::rename(&tmp, exe).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- finding and checking `claude`

/// Reelcut's own copy first; REELCUT_CLAUDE overrides it (tests, development).
pub fn find(data: &Path) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("REELCUT_CLAUDE") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let own = own_exe(data);
    own.is_file().then_some(own)
}

fn cmd(bin: &Path, data: &Path) -> Command {
    let mut c = Command::new(bin);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c.stdin(Stdio::null());
    env(&mut c, data);
    c
}

/// Reelcut's own sign-in, and nothing that would switch billing away from the Claude plan.
fn env(c: &mut Command, data: &Path) {
    if std::env::var_os("REELCUT_CLAUDE_KEEP_ENV").is_none() {
        let _ = std::fs::create_dir_all(config_dir(data));
        c.env("CLAUDE_CONFIG_DIR", config_dir(data));
        for k in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_BASE_URL"] {
            c.env_remove(k);
        }
    }
}

fn out(bin: &Path, data: &Path, args: &[&str]) -> Result<(bool, String, String), String> {
    let o = cmd(bin, data).args(args).output().map_err(|e| e.to_string())?;
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

pub fn status(data: &Path) -> Status {
    let Some(bin) = find(data) else { return Status::default() };
    let mut s = Status { found: true, path: bin.to_string_lossy().into_owned(), ..Default::default() };
    if let Ok((_, o, _)) = out(&bin, data, &["--version"]) {
        s.version = o.split_whitespace().next().unwrap_or("").to_string();
    }
    match out(&bin, data, &["auth", "status", "--json"]) {
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
pub fn login(data: &Path) -> Result<(), String> {
    let bin = find(data).ok_or("Claude Code를 먼저 내려받아야 합니다")?;
    let mut c = Command::new(&bin);
    c.args(["auth", "login", "--claudeai"]);
    env(&mut c, data);
    #[cfg(windows)]
    c.creation_flags(CREATE_NEW_CONSOLE);
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- one agent turn

pub struct Turn {
    pub model: String,
    pub effort: String,
    pub system: String,
    pub prompt: String,
    pub session: Option<String>,
    pub workdir: PathBuf,
    pub data: PathBuf,
}

fn help_text(bin: &Path, data: &Path) -> String {
    static HELP: Mutex<Option<(PathBuf, String)>> = Mutex::new(None);
    if let Some((p, h)) = HELP.lock().as_ref() {
        if p == bin {
            return h.clone();
        }
    }
    let h = out(bin, data, &["--help"]).map(|(_, o, e)| o + &e).unwrap_or_default();
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
    let bin = find(&t.data).ok_or("Claude 계정이 연결되지 않았습니다. 설정에서 'Claude 계정 연결'을 눌러 주세요.")?;
    std::fs::create_dir_all(&t.workdir).map_err(|e| e.to_string())?;
    let cfg = t.workdir.join("mcp.json");
    std::fs::write(&cfg, serde_json::to_vec(&json!({ "mcpServers": { SERVER: { "type": "http", "url": bridge.url() } } })).unwrap()).map_err(|e| e.to_string())?;
    let help = help_text(&bin, &t.data);
    let a = args(&t, &cfg, |f| help.contains(f));
    let mut c = cmd(&bin, &t.data);
    c.args(&a)
        .current_dir(&t.workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("MCP_TOOL_TIMEOUT", "10800000")
        .env("MCP_TIMEOUT", "30000")
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
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
        let t = Turn { model: "claude-haiku-5-5".into(), effort: "low".into(), system: "s".into(), prompt: "p".into(), session: Some("abc".into()), workdir: PathBuf::from("."), data: PathBuf::from(".") };
        let a = args(&t, Path::new("m.json"), |_| true);
        assert!(a.windows(2).any(|w| w[0] == "--resume" && w[1] == "abc"));
        assert!(a.windows(2).any(|w| w[0] == "--tools" && w[1].is_empty()));
        let a = args(&t, Path::new("m.json"), |_| false);
        assert!(!a.contains(&"--effort".to_string()) && !a.contains(&"--tools".to_string()));
        assert!(a.contains(&"--disallowedTools".to_string()));
    }

    /// Downloads the pinned package for this platform and checks it. REELCUT_CC_DOWNLOAD=1
    #[test]
    fn cc_download() {
        if std::env::var("REELCUT_CC_DOWNLOAD").is_err() {
            return;
        }
        let dir = std::env::temp_dir().join("reelcut-cc-dl");
        let _ = std::fs::remove_dir_all(&dir);
        let mut last = 0.0;
        // REELCUT_CC_TGZ: a package fetched by other means (behind a TLS-inspecting proxy).
        let exe = if let Ok(t) = std::env::var("REELCUT_CC_TGZ") {
            use sha2::{Digest, Sha512};
            let exe = own_exe(&dir);
            std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
            let sum = Sha512::digest(std::fs::read(&t).unwrap());
            assert!(unpack_checked(Path::new(&t), &[0u8; 64], platform().unwrap().1, &exe).is_err(), "bad hash must fail");
            unpack_checked(Path::new(&t), &sum, platform().unwrap().1, &exe).unwrap();
            last = 100.0;
            exe
        } else {
            download(&dir, |p, m| {
                last = p;
                println!("{p:.0}% {m}");
            })
            .unwrap()
        };
        assert!(exe.is_file() && last == 100.0);
        let o = cmd(&exe, &dir).arg("--version").output().unwrap();
        let v = String::from_utf8_lossy(&o.stdout).to_string();
        assert!(v.contains(CC_VERSION), "{v}");
        let s = status(&dir);
        assert!(s.found && s.version.contains(CC_VERSION));
        println!("signed in: {} ({})", s.logged_in, s.method);
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
            Turn { model: "claude-haiku-5-5".into(), effort: "low".into(), system: "Answer in Korean. Use the tool when asked about the secret word.".into(), prompt: "비밀 단어가 뭐야? 도구로 확인해서 그 단어만 말해.".into(), session: None, workdir: dir.clone(), data: dir.clone() },
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
            Turn { model: "claude-haiku-5-5".into(), effort: "low".into(), system: "Answer in Korean. Use the tool when asked about the secret word.".into(), prompt: "방금 그 단어를 한 번 더 말해 줘. 도구는 쓰지 마.".into(), session, workdir: dir.clone(), data: dir },
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
