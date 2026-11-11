//! Append-only JSON-lines files in the app data folder (2.18):
//! - `logs/actions/<project>.jsonl`: what the user and the AI did, read back by the AI;
//! - `logs/chats/<project>.<session>.jsonl`: every AI request, response and Claude Code event,
//!   raw (images left out), so a conversation's tool inputs and results are never lost.
//! Lines are only ever added. Each call writes its lines with one `write_all` on a file opened in
//! append mode, so concurrent appends keep whole lines.

use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const KINDS: [&str; 2] = ["actions", "chats"];
/// `tail` reads at most this much from the end of a file.
const TAIL_BYTES: u64 = 16 << 20;

pub fn path(data_dir: &Path, kind: &str, name: &str) -> Result<PathBuf, String> {
    if !KINDS.contains(&kind) {
        return Err(format!("잘못된 기록 종류: {kind}"));
    }
    let name = super::safe_name(name)?;
    let d = data_dir.join("logs").join(kind);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.join(format!("{name}.jsonl")))
}

/// Adds lines (newlines inside a line become spaces, so one entry stays one line).
pub fn append(p: &Path, lines: &[String]) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }
    let mut buf = String::with_capacity(lines.iter().map(|l| l.len() + 1).sum());
    for l in lines {
        buf.push_str(&l.replace(['\n', '\r'], " "));
        buf.push('\n');
    }
    let mut f = OpenOptions::new().create(true).append(true).open(p).map_err(|e| e.to_string())?;
    f.write_all(buf.as_bytes()).map_err(|e| e.to_string())
}

/// The last `max` whole lines (oldest first); an empty list when the file does not exist.
pub fn tail(p: &Path, max: usize) -> Result<Vec<String>, String> {
    let mut f = match std::fs::File::open(p) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let from = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(from)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.split('\n').collect();
    // Starting mid-file: the first piece is part of a line.
    if from > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    let lines: Vec<String> = lines.into_iter().map(str::trim_end).filter(|l| !l.is_empty()).map(String::from).collect();
    let skip = lines.len().saturating_sub(max);
    Ok(lines.into_iter().skip(skip).collect())
}

#[tauri::command]
pub fn jsonl_append(app: super::St<'_>, kind: String, name: String, lines: Vec<String>) -> Result<(), String> {
    append(&path(&app.data_dir, &kind, &name)?, &lines)?;
    // The same lines in the project's folder (기록\작업.jsonl, 대화\원본\<sid>.jsonl).
    super::project::mirror(&app.data_dir, &kind, &name, &lines);
    Ok(())
}

#[tauri::command]
pub fn jsonl_tail(app: super::St<'_>, kind: String, name: String, max: usize) -> Result<Vec<String>, String> {
    tail(&path(&app.data_dir, &kind, &name)?, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("reelcut-jsonl-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn appends_and_reads_the_tail() {
        let d = tmp("tail");
        let p = path(&d, "actions", "p1").unwrap();
        assert!(tail(&p, 10).unwrap().is_empty());
        append(&p, &["{\"seq\":1}".into(), "{\"seq\":2,\n\"x\":1}".into()]).unwrap();
        append(&p, &["{\"seq\":3}".into()]).unwrap();
        let all = tail(&p, 10).unwrap();
        assert_eq!(all, vec!["{\"seq\":1}", "{\"seq\":2, \"x\":1}", "{\"seq\":3}"]);
        assert_eq!(tail(&p, 2).unwrap(), vec!["{\"seq\":2, \"x\":1}", "{\"seq\":3}"]);
    }

    #[test]
    fn rejects_bad_names_and_kinds() {
        let d = tmp("names");
        assert!(path(&d, "actions", "../x").is_err());
        assert!(path(&d, "secrets", "p1").is_err());
        assert!(path(&d, "chats", "p1.s1").is_ok());
    }

    #[test]
    fn concurrent_appends_keep_whole_lines() {
        let d = tmp("conc");
        let p = path(&d, "chats", "p.s").unwrap();
        let hs: Vec<_> = (0..8)
            .map(|i| {
                let p = p.clone();
                std::thread::spawn(move || {
                    for j in 0..200 {
                        append(&p, &[format!("{{\"w\":{i},\"j\":{j},\"pad\":\"{}\"}}", "x".repeat(300))]).unwrap();
                    }
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        let lines = tail(&p, 10_000).unwrap();
        assert_eq!(lines.len(), 1600);
        assert!(lines.iter().all(|l| serde_json::from_str::<serde_json::Value>(l).is_ok()));
    }
}
