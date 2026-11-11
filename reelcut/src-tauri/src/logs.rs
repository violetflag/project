//! What happened, on disk, for when something looks wrong later: `logs/reelcut.log` for people and
//! JSON lines for anything a program reads back. The release build has no console.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn init(data_dir: &Path) {
    let _ = DIR.set(data_dir.join("logs"));
}

pub fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// UTC time as "YYYY-MM-DD HH:MM:SS".
pub fn stamp(ms: u128) -> String {
    let secs = (ms / 1000) as i64;
    let (day, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Days to a calendar date (Howard Hinnant's civil_from_days).
    let z = day + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", rem / 3600, rem / 60 % 60, rem % 60)
}

/// One line in `logs/reelcut.log`; the old file is kept once when it passes 5 MB.
pub fn log(kind: &str, text: &str) {
    let Some(dir) = DIR.get() else { return };
    let _ = std::fs::create_dir_all(dir);
    let p = dir.join("reelcut.log");
    if std::fs::metadata(&p).map(|m| m.len() > 5 << 20).unwrap_or(false) {
        let _ = std::fs::rename(&p, dir.join("reelcut.old.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{} [{kind}] {}", stamp(now_ms()), text.replace('\n', " "));
    }
}

/// One whole JSON line per call, on disk before it returns.
pub fn append_jsonl(p: &Path, v: &Value) -> std::io::Result<()> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    let mut line = v.to_string();
    line.push('\n');
    // A single write in append mode, so lines from several threads never mix.
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(p)?;
    f.write_all(line.as_bytes())?;
    f.sync_data()
}

/// `logs/exports/<time>.jsonl` for one export.
pub fn export_log_path(id: &str) -> Option<PathBuf> {
    let t = stamp(now_ms()).replace([':', ' '], "-");
    DIR.get().map(|d| d.join("exports").join(format!("{t}-{id}.jsonl")))
}

/// The last lines of an ffmpeg error, with its progress noise dropped.
pub fn tail_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty() && !l.starts_with("frame=")).collect();
    lines[lines.len().saturating_sub(n)..].join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stamps_are_calendar_times() {
        assert_eq!(stamp(0), "1970-01-01 00:00:00");
        assert_eq!(stamp(1_793_880_000_000), "2026-11-05 12:00:00");
    }

    #[test]
    fn appends_from_many_threads_keep_whole_lines() {
        let d = std::env::temp_dir().join(format!("reelcut-logs-{}", now_ms()));
        let p = d.join("a/b.jsonl");
        std::thread::scope(|s| {
            for t in 0..8 {
                let p = &p;
                s.spawn(move || {
                    for i in 0..50 {
                        append_jsonl(p, &json!({ "t": t, "i": i, "pad": "x".repeat(200) })).unwrap();
                    }
                });
            }
        });
        let text = std::fs::read_to_string(&p).unwrap();
        assert_eq!(text.lines().count(), 400);
        assert!(text.lines().all(|l| serde_json::from_str::<Value>(l).is_ok()));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn keeps_the_end_of_an_error() {
        assert_eq!(tail_lines("a\n\nframe=1\nb\nc", 2), "b | c");
    }
}
