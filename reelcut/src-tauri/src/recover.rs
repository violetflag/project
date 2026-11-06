//! 대화 복구 (2.18 WP12): Claude Code conversations that no project refers to any more (their
//! project was deleted before 2.17.3 kept a trash) become readable again. Claude Code keeps every
//! conversation as `<session>.jsonl` in its own folder, and 2.17.3 copies them to `claude-archive`;
//! a project's chats name theirs in `ccSession`. Those named by no project (the trash counts)
//! are listed, and their messages are rebuilt as chats for "복구된 대화" projects. Nothing is
//! moved or changed; importing the same conversation twice is impossible because the new project
//! names it.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Clone)]
pub struct Found {
    pub session: String,
    /// First and last message, ms.
    pub started: u64,
    pub ended: u64,
    pub messages: usize,
    /// What the user first asked (shortened).
    pub first: String,
    /// The project name the conversation mentions ("프로젝트: …"), if any.
    pub project: Option<String>,
    pub title: Option<String>,
    pub bytes: u64,
}

fn ok_session(s: &str) -> bool {
    !s.is_empty() && s.len() <= 80 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Every transcript file, by session; the bigger copy wins (the archive may be older).
pub fn transcripts(dirs: &[PathBuf]) -> HashMap<String, PathBuf> {
    let mut out: HashMap<String, PathBuf> = HashMap::new();
    for root in dirs {
        for d in std::fs::read_dir(root).into_iter().flatten().flatten() {
            for f in std::fs::read_dir(d.path()).into_iter().flatten().flatten() {
                let p = f.path();
                let Some(s) = p.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".jsonl")).map(String::from) else { continue };
                if !ok_session(&s) {
                    continue;
                }
                let len = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
                if out.get(&s).is_none_or(|q| len(q) < len(&p)) {
                    out.insert(s, p);
                }
            }
        }
    }
    out
}

/// Every string value of `"<key>":"…"` in a text.
fn values_of(text: &str, key: &str, out: &mut HashSet<String>) {
    let key = format!("\"{key}\":\"");
    let mut rest = text;
    while let Some(i) = rest.find(&key) {
        rest = &rest[i + key.len()..];
        if let Some(j) = rest.find('"') {
            if ok_session(&rest[..j]) {
                out.insert(rest[..j].to_string());
            }
            rest = &rest[j..];
        }
    }
}

/// Sessions the projects (and the projects in the trash) refer to: each chat's current one, the
/// ones it used before a compaction (`ccPast`), and every session the app's own records of that
/// project show (older chats moved to a new session without keeping the old one's name).
pub fn referenced(store: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut ids = HashSet::new();
    for dir in [store.to_path_buf(), store.join("_trash")] {
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            let Some(id) = n.strip_prefix("project-").map(|r| r.split("--").next().unwrap_or(r).trim_end_matches(".json").to_string()) else { continue };
            let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
            ids.insert(id);
            values_of(&text, "ccSession", &mut out);
            let key = "\"ccPast\":[";
            let mut rest = text.as_str();
            while let Some(i) = rest.find(key) {
                rest = &rest[i + key.len()..];
                let end = rest.find(']').unwrap_or(rest.len());
                for s in rest[..end].split(',').map(|x| x.trim().trim_matches('"')) {
                    if ok_session(s) {
                        out.insert(s.to_string());
                    }
                }
                rest = &rest[end..];
            }
        }
    }
    if let Some(logs) = store.parent().map(|d| d.join("logs").join("chats")) {
        for e in std::fs::read_dir(logs).into_iter().flatten().flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if !n.split('.').next().is_some_and(|pid| ids.contains(pid)) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
            values_of(&text, "session_id", &mut out);
            values_of(&text, "session", &mut out);
        }
    }
    out
}

fn ms(ts: &str) -> Option<u64> {
    // "2026-11-03T04:33:45.298Z" → ms since 1970 (UTC; days from civil date).
    let (date, time) = ts.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time = time.trim_end_matches('Z');
    let mut t = time.split(':');
    let (h, mi) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
    let s: f64 = t.next().unwrap_or("0").split(['+', '-']).next()?.parse().ok()?;
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60) as f64 * 1000.0 + s * 1000.0) as u64)
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(" "),
        _ => String::new(),
    }
}

/// What the user typed, without the app's state blocks (`<project-state>…`).
fn user_words(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let tail = &rest[i + 1..];
        let name: String = tail.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
        let close = format!("</{name}>");
        match (name.is_empty(), tail.find(&close)) {
            (false, Some(j)) => rest = &tail[j + close.len()..],
            _ => {
                out.push('<');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Messages of a transcript as the app's chat holds them: main-line user and assistant messages
/// in order, the pieces of one answer joined, thinking left out.
pub fn messages(file: &Path) -> (Vec<Value>, Option<String>, u64, u64) {
    let text = std::fs::read_to_string(file).unwrap_or_default();
    let mut out: Vec<Value> = Vec::new();
    let mut last_id: Option<String> = None;
    let mut title = None;
    let (mut first, mut last) = (0u64, 0u64);
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["type"] == "ai-title" {
            title = v["aiTitle"].as_str().map(String::from);
            continue;
        }
        if !(v["type"] == "user" || v["type"] == "assistant") || v["isSidechain"] == true {
            continue;
        }
        let m = &v["message"];
        let Some(role) = m["role"].as_str().filter(|r| *r == "user" || *r == "assistant") else { continue };
        if let Some(t) = v["timestamp"].as_str().and_then(ms) {
            if first == 0 {
                first = t;
            }
            last = t;
        }
        let blocks: Vec<Value> = match &m["content"] {
            Value::String(s) => vec![json!({ "type": "text", "text": s })],
            Value::Array(a) => a.iter().filter(|b| b["type"] != "thinking" && b["type"] != "redacted_thinking").cloned().collect(),
            _ => continue,
        };
        if blocks.is_empty() {
            continue;
        }
        let id = m["id"].as_str().map(String::from);
        let same_answer = role == "assistant" && id.is_some() && id == last_id;
        let same_role = out.last().is_some_and(|p| p["role"] == role);
        if same_answer || same_role {
            if let Some(a) = out.last_mut().and_then(|p| p["content"].as_array_mut()) {
                a.extend(blocks);
            }
        } else {
            out.push(json!({ "role": role, "content": blocks }));
        }
        last_id = if role == "assistant" { id } else { None };
    }
    (out, title, first, last)
}

/// Conversations no project names, newest first.
pub fn scan(dirs: &[PathBuf], store: &Path) -> Vec<Found> {
    let refs = referenced(store);
    let mut v: Vec<Found> = transcripts(dirs)
        .into_iter()
        .filter(|(s, _)| !refs.contains(s))
        .filter_map(|(session, p)| {
            let (msgs, title, started, ended) = messages(&p);
            if msgs.is_empty() {
                return None;
            }
            let first = msgs.iter().find(|m| m["role"] == "user").map(|m| user_words(&text_of(&m["content"]))).unwrap_or_default();
            let all = std::fs::read_to_string(&p).unwrap_or_default();
            let project = all.find("프로젝트: ").map(|i| {
                let rest = &all[i + "프로젝트: ".len()..];
                rest.chars().take_while(|c| !matches!(c, '\\' | '"' | '\n' | '|' | '<')).take(60).collect::<String>().trim().to_string()
            }).filter(|s| !s.is_empty());
            Some(Found { session, started, ended, messages: msgs.len(), first: first.chars().take(120).collect(), project, title, bytes: std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) })
        })
        .collect();
    v.sort_by(|a, b| b.started.cmp(&a.started));
    v
}

fn dirs(data: &Path) -> Vec<PathBuf> {
    vec![super::cc::config_dir(data).join("projects"), data.join("claude-archive")]
}

#[tauri::command]
pub async fn recover_scan(app: super::St<'_>) -> Result<Vec<Found>, String> {
    let app = app.inner().clone();
    super::blocking(move || Ok(scan(&dirs(&app.data_dir), &app.store_dir()))).await
}

/// The chats for the chosen conversations (kept on their Claude Code session, so asking again
/// continues where they stopped).
#[tauri::command]
pub async fn recover_chats(app: super::St<'_>, sessions: Vec<String>) -> Result<Vec<Value>, String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let all = transcripts(&dirs(&app.data_dir));
        let mut out = Vec::new();
        for s in sessions {
            let Some(p) = all.get(&s) else { continue };
            let (msgs, title, started, ended) = messages(p);
            let first = msgs.iter().find(|m| m["role"] == "user").map(|m| user_words(&text_of(&m["content"]))).unwrap_or_default();
            let title = title.unwrap_or_else(|| first.chars().take(30).collect());
            out.push(json!({ "id": format!("r{}", s.replace('-', "").chars().take(12).collect::<String>()), "title": title, "created": started, "updated": ended, "messages": msgs, "ccSession": s, "chatMode": "account" }));
        }
        Ok(out)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("reelcut-recover-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn line(v: Value) -> String {
        v.to_string() + "\n"
    }

    #[test]
    fn finds_conversations_no_project_names_and_rebuilds_them() {
        let d = tmp("scan");
        let cfg = d.join("config/projects/C--agent");
        let arch = d.join("archive/C--agent");
        let store = d.join("store");
        for x in [&cfg, &arch, &store.join("_trash")] {
            std::fs::create_dir_all(x).unwrap();
        }
        let t = |i: u32| format!("2026-11-0{i}T01:00:00.000Z");
        let convo = [
            line(json!({ "type": "ai-title", "aiTitle": "쌍둥이 쇼츠", "sessionId": "aaa-1" })),
            line(json!({ "type": "user", "timestamp": t(1), "message": { "role": "user", "content": "<project-state>열린 편집본: d1 | 미디어 3개</project-state>\n둘 다 나오게 편집해 줘" } })),
            line(json!({ "type": "assistant", "timestamp": t(1), "message": { "id": "m1", "role": "assistant", "content": [{ "type": "thinking", "thinking": "…" }] } })),
            line(json!({ "type": "assistant", "timestamp": t(1), "message": { "id": "m1", "role": "assistant", "content": [{ "type": "text", "text": "네" }] } })),
            line(json!({ "type": "assistant", "timestamp": t(1), "message": { "id": "m1", "role": "assistant", "content": [{ "type": "tool_use", "id": "t1", "name": "x", "input": {} }] } })),
            line(json!({ "type": "user", "timestamp": t(2), "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "프로젝트: 제주 여행\n열린 편집본: d1" }] } })),
            line(json!({ "type": "assistant", "isSidechain": true, "message": { "id": "s", "role": "assistant", "content": [{ "type": "text", "text": "옆길" }] } })),
            line(json!({ "type": "assistant", "timestamp": t(2), "message": { "id": "m2", "role": "assistant", "content": [{ "type": "text", "text": "끝" }] } })),
        ]
        .concat();
        std::fs::write(cfg.join("aaa-1.jsonl"), &convo).unwrap();
        // An older, shorter archive copy of the same session loses to the full one.
        std::fs::write(arch.join("aaa-1.jsonl"), &convo[..200]).unwrap();
        // Named by a project, and by a project in the trash: not listed.
        std::fs::write(cfg.join("bbb-2.jsonl"), line(json!({ "type": "user", "message": { "role": "user", "content": "x" } }))).unwrap();
        std::fs::write(cfg.join("ccc-3.jsonl"), line(json!({ "type": "user", "message": { "role": "user", "content": "y" } }))).unwrap();
        std::fs::write(store.join("project-p1.json"), r#"{"chats":[{"ccSession":"bbb-2"}]}"#).unwrap();
        std::fs::write(store.join("_trash/project-p2--5.json"), r#"{"chats":[{"ccSession":"ccc-3"}]}"#).unwrap();
        // No messages at all: not listed.
        std::fs::write(cfg.join("ddd-4.jsonl"), line(json!({ "type": "mode", "mode": "normal" }))).unwrap();
        // A live project's chat before a compaction (kept in ccPast), and one only the app's own
        // record of that project names: not listed either.
        for s in ["eee-5", "fff-6", "ggg-7"] {
            std::fs::write(cfg.join(format!("{s}.jsonl")), line(json!({ "type": "user", "message": { "role": "user", "content": "z" } }))).unwrap();
        }
        std::fs::write(store.join("project-p3.json"), r#"{"chats":[{"ccPast":["eee-5", "fff-6"]}]}"#).unwrap();
        std::fs::create_dir_all(d.join("logs/chats")).unwrap();
        std::fs::write(d.join("logs/chats/p3.s1.jsonl"), line(json!({ "t": 1, "raw": { "kind": "cc", "event": { "type": "system", "session_id": "ggg-7" } } }))).unwrap();
        // The same record for a project that no longer exists anywhere does not count.
        std::fs::write(d.join("logs/chats/gone.s1.jsonl"), line(json!({ "t": 1, "raw": { "kind": "cc", "event": { "session_id": "aaa-1" } } }))).unwrap();

        let dirs = [d.join("config/projects"), d.join("archive")];
        let f = scan(&dirs, &store);
        assert_eq!(f.len(), 1, "{f:?}");
        assert_eq!(f[0].session, "aaa-1");
        assert_eq!(f[0].project.as_deref(), Some("제주 여행"));
        assert_eq!(f[0].first, "둘 다 나오게 편집해 줘");
        assert_eq!(f[0].title.as_deref(), Some("쌍둥이 쇼츠"));
        assert_eq!(f[0].messages, 4);
        assert!(f[0].ended > f[0].started && f[0].started == ms("2026-11-01T01:00:00.000Z").unwrap());

        let (m, ..) = messages(&cfg.join("aaa-1.jsonl"));
        assert_eq!(m[1]["content"].as_array().unwrap().len(), 2, "one answer in one message, no thinking: {}", m[1]);
        assert_eq!(m[3]["content"][0]["text"], "끝");
        assert!(!m.iter().any(|x| x.to_string().contains("옆길")));
    }

    #[test]
    fn times_and_words() {
        assert_eq!(ms("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(ms("2026-11-05T12:00:00Z"), Some(1_793_880_000_000));
        assert_eq!(user_words("<user-actions>a\nb</user-actions>\n\n자막 넣어 <b>굵게</b>"), "자막 넣어");
        assert_eq!(user_words("3 < 5 이면"), "3 < 5 이면");
    }
}
