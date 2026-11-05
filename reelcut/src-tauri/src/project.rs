//! Project folders (2.18 WP6): every project is also a folder the user can see in Explorer,
//! `Documents\Reelcut\<이름>\`, holding a `.reelcut` file that opens the project on a double
//! click, each AI conversation as its own file, the action log, the AI's raw records and dated
//! backups. The app's own store (`data_dir/store`) stays as it was, so 2.17 can still open it;
//! every save writes both.
//!
//! ```text
//! <root>\<이름>\
//!   <이름>.reelcut            the project (JSON, format 1), no pictures, chats only listed
//!   <이름>.reelcut.bak        the save before
//!   README.txt               what each folder holds
//!   대화\<sid>.jsonl          one conversation: header line, then one message per line
//!   대화\원본\<sid>.jsonl     every AI request, answer and Claude Code event as it happened
//!   대화\비공개\img\          pictures the AI looked at (frames of the family: never share)
//!   대화\비공개\claude-code\  copies of the Claude Code conversations
//!   기록\작업.jsonl           what the user and the AI did (the AI reads this)
//!   백업\<YYYY-MM-DD HHmm> <사유>.reelcut
//! <root>\_휴지통\             deleted project folders and pruned backups, never erased
//! ```
//!
//! When the root sits in a folder a cloud service syncs (OneDrive, Dropbox, Google Drive,
//! iCloud), pictures go to `data_dir/private/<id>/img` instead, so frames of the children never
//! leave the PC.

use base64::Engine;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

pub const EXT: &str = "reelcut";
pub const FORMAT: u64 = 1;
const TRASH: &str = "_휴지통";
const CHATS: &str = "대화";
const RAW: &str = "원본";
const PRIVATE: &str = "비공개";
const LOGS: &str = "기록";
const BACKUPS: &str = "백업";
const ACTIONS_FILE: &str = "작업.jsonl";

/// Backup reasons that are never pruned.
const KEEP_REASONS: [&str; 3] = ["복구", "옮겨오기 전", "수동"];
const KEEP_ALL: Duration = Duration::from_secs(24 * 3600);
const KEEP_DAILY: Duration = Duration::from_secs(30 * 24 * 3600);
const MAX_BACKUPS: usize = 200;
const MAX_BACKUP_BYTES: u64 = 500 << 20;

const README: &str = "Reelcut 프로젝트 폴더\r\n\
\r\n\
- <이름>.reelcut : 프로젝트 파일입니다. 두 번 누르면 Reelcut에서 열립니다.\r\n\
- <이름>.reelcut.bak : 바로 전에 저장한 내용입니다.\r\n\
- 대화 : AI와 나눈 대화가 하나씩 들어 있습니다. '원본'에는 AI가 주고받은 내용이 빠짐없이 남습니다.\r\n\
- 대화\\비공개 : AI가 본 사진(영상 장면)과 Claude Code 대화입니다. 가족이 나오는 장면이 있으니 다른 사람과 공유하지 마세요.\r\n\
- 기록\\작업.jsonl : 직접 한 편집과 AI가 한 편집이 순서대로 남습니다. AI가 이어서 작업할 때 읽습니다.\r\n\
- 백업 : 날짜와 이유가 붙은 이전 상태입니다. Reelcut의 파일 > 백업에서 되살리기로 되돌릴 수 있습니다.\r\n\
\r\n\
원본 영상은 이 폴더로 옮겨지지 않습니다. 영상 파일을 옮기거나 지우면 다시 연결해야 합니다.\r\n";

// ---------------------------------------------------------------- names and places

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// A project name as a Windows folder name: no `<>:"/\|?*` or control characters, no trailing
/// dot or space, not a reserved device name, at most 60 characters.
pub fn folder_name(name: &str) -> String {
    let mut s: String = name.chars().map(|c| if (c as u32) < 32 || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    s = s.trim().to_string();
    if s.chars().count() > 60 {
        s = s.chars().take(60).collect();
    }
    let s = s.trim_end_matches(['.', ' ']).trim_start().to_string();
    if s.is_empty() || s.chars().all(|c| c == '.' || c == '_') {
        return "프로젝트".into();
    }
    if s == TRASH {
        return "휴지통 프로젝트".into();
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return format!("_{s}");
    }
    s
}

/// The cloud service that syncs this folder, if any.
pub fn synced_by(p: &Path) -> Option<&'static str> {
    for c in p.components() {
        let n = c.as_os_str().to_string_lossy().to_lowercase();
        if n.starts_with("onedrive") {
            return Some("OneDrive");
        }
        if n.contains("dropbox") {
            return Some("Dropbox");
        }
        if n.contains("google drive") || n.contains("googledrive") || n == "내 드라이브" || n == "my drive" {
            return Some("Google Drive");
        }
        if n.contains("icloud") {
            return Some("iCloud");
        }
    }
    None
}

/// `Documents\Reelcut`, or `<home>\Reelcut` when Documents is synced to a cloud service.
pub fn default_root(docs: Option<&Path>, home: &Path) -> (PathBuf, Option<&'static str>) {
    match docs {
        Some(d) if synced_by(d).is_none() => (d.join("Reelcut"), None),
        Some(d) => (home.join("Reelcut"), synced_by(d)),
        None => (home.join("Reelcut"), None),
    }
}

/// `to` relative to the folder `from` ("../../DJI/a.osv"), when both are on one drive.
pub fn relative(from: &Path, to: &Path) -> Option<String> {
    let a: Vec<Component> = from.components().collect();
    let b: Vec<Component> = to.components().collect();
    if a.is_empty() || b.is_empty() || a[0] != b[0] || !to.is_absolute() {
        return None;
    }
    let same = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut parts: Vec<String> = vec!["..".to_string(); a.len() - same];
    parts.extend(b[same..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    Some(parts.join("/"))
}

/// `a/b/../c` → `a/c`, without touching the disk.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c.as_os_str()),
        }
    }
    out
}

/// A file name inside the project folder that stays inside it.
fn inside(dir: &Path, rel: &str) -> Option<PathBuf> {
    let r = Path::new(rel);
    if r.is_absolute() || r.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(dir.join(r))
}

fn ok_id(id: &str) -> Result<&str, String> {
    if id.is_empty() || id.len() > 80 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("잘못된 id: {id}"));
    }
    Ok(id)
}

// ---------------------------------------------------------------- writing

/// A whole file or nothing: written beside, flushed to disk, then moved over the old one. Moving
/// is retried a few times, as antivirus and sync programs hold new files open for a moment.
pub fn write_atomic(p: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let mut tmp = p.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let mut f = std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| e.to_string())?;
    drop(f);
    let mut last = String::new();
    for i in 0..6 {
        match std::fs::rename(&tmp, p) {
            Ok(()) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
        if i < 5 {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    Err(format!("{}: {last}", p.display()))
}

fn append(p: &Path, lines: &[String]) -> Result<(), String> {
    use std::io::Write;
    if lines.is_empty() {
        return Ok(());
    }
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let mut buf = String::new();
    for l in lines {
        buf.push_str(&l.replace(['\n', '\r'], " "));
        buf.push('\n');
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(p).map_err(|e| e.to_string())?;
    f.write_all(buf.as_bytes()).map_err(|e| e.to_string())
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().take(10).map(|b| format!("{b:02x}")).collect()
}

/// Pictures in a message (base64 image blocks, anywhere inside it) become files and references.
fn pictures_out(v: &mut Value, img: &Path, wrote: &mut u32) -> Result<(), String> {
    match v {
        Value::Array(a) => {
            for x in a {
                pictures_out(x, img, wrote)?;
            }
        }
        Value::Object(o) => {
            let is_img = o.get("type").and_then(Value::as_str) == Some("image") && o.get("source").and_then(|s| s.get("type")).and_then(Value::as_str) == Some("base64");
            if is_img {
                let media = o["source"]["media_type"].as_str().unwrap_or("image/jpeg").to_string();
                let data = o["source"]["data"].as_str().unwrap_or("");
                let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
                let ext = match media.as_str() {
                    "image/png" => "png",
                    "image/webp" => "webp",
                    "image/gif" => "gif",
                    _ => "jpg",
                };
                let name = format!("{}.{ext}", digest(&bytes));
                let f = img.join(&name);
                if !f.is_file() {
                    write_atomic(&f, &bytes)?;
                    *wrote += 1;
                }
                *v = json!({ "type": "image_ref", "file": format!("{PRIVATE}/img/{name}"), "media_type": media });
                return Ok(());
            }
            for (_, x) in o.iter_mut() {
                pictures_out(x, img, wrote)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// The reverse: references become base64 pictures again, or a note when the file is gone.
fn pictures_in(v: &mut Value, places: &[PathBuf]) {
    match v {
        Value::Array(a) => a.iter_mut().for_each(|x| pictures_in(x, places)),
        Value::Object(o) => {
            if o.get("type").and_then(Value::as_str) == Some("image_ref") {
                let file = o.get("file").and_then(Value::as_str).unwrap_or("");
                let name = file.rsplit('/').next().unwrap_or("");
                let media = o.get("media_type").and_then(Value::as_str).unwrap_or("image/jpeg").to_string();
                let bytes = (!name.is_empty() && !name.contains("..")).then(|| places.iter().find_map(|d| std::fs::read(d.join(name)).ok())).flatten();
                *v = match bytes {
                    Some(b) => json!({ "type": "image", "source": { "type": "base64", "media_type": media, "data": base64::engine::general_purpose::STANDARD.encode(b) } }),
                    None => json!({ "type": "text", "text": "[사진: 비공개 폴더에서 찾지 못했습니다]" }),
                };
                return;
            }
            o.iter_mut().for_each(|(_, x)| pictures_in(x, places));
        }
        _ => {}
    }
}

/// What one save wrote, for the tests and the log.
#[derive(Default, Debug, Serialize)]
pub struct Wrote {
    pub file: PathBuf,
    pub chats: u32,
    pub pictures: u32,
    pub skipped: u32,
}

/// Content of the last write of each file, so unchanged conversations are not written again.
pub type Written = HashMap<PathBuf, String>;

fn write_if_changed(p: &Path, bytes: &[u8], written: &mut Written) -> Result<bool, String> {
    let h = digest(bytes);
    if written.get(p) == Some(&h) && p.is_file() {
        return Ok(false);
    }
    write_atomic(p, bytes)?;
    written.insert(p.to_path_buf(), h);
    Ok(true)
}

/// Writes the project into its folder: the `.reelcut` file (the previous one kept as `.bak`),
/// one file per conversation and the README.
pub fn write_folder(dir: &Path, img: &Path, project: &Value, app: &str, saved_at: &str, written: &mut Written) -> Result<Wrote, String> {
    let id = ok_id(project["id"].as_str().unwrap_or(""))?.to_string();
    let base = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "프로젝트".into());
    let file = dir.join(format!("{base}.{EXT}"));
    let mut out = Wrote { file: file.clone(), ..Default::default() };
    let mut proj = project.clone();
    if let Some(chats) = proj.get_mut("chats").and_then(Value::as_array_mut) {
        for c in chats.iter_mut() {
            let Some(o) = c.as_object_mut() else { continue };
            let Ok(sid) = ok_id(o.get("id").and_then(Value::as_str).unwrap_or("")).map(String::from) else { continue };
            let messages = o.remove("messages").unwrap_or(Value::Array(vec![]));
            let context = o.remove("context");
            let rel = format!("{CHATS}/{sid}.jsonl");
            o.insert("file".into(), json!(rel));
            let mut lines = vec![json!({ "header": Value::Object(o.clone()) }).to_string()];
            for mut m in messages.as_array().cloned().unwrap_or_default() {
                pictures_out(&mut m, img, &mut out.pictures)?;
                lines.push(m.to_string());
            }
            for mut m in context.and_then(|c| c.as_array().cloned()).unwrap_or_default() {
                pictures_out(&mut m, img, &mut out.pictures)?;
                lines.push(json!({ "context": m }).to_string());
            }
            let text = lines.join("\n") + "\n";
            if write_if_changed(&dir.join(CHATS).join(format!("{sid}.jsonl")), text.as_bytes(), written)? {
                out.chats += 1;
            } else {
                out.skipped += 1;
            }
        }
    }
    if let Some(assets) = proj.get_mut("assets").and_then(Value::as_array_mut) {
        for a in assets.iter_mut() {
            if let Some(r) = a.pointer("/info/path").and_then(Value::as_str).and_then(|p| relative(dir, Path::new(p))) {
                a["rel"] = json!(r);
            }
        }
    }
    let doc = json!({ "format": FORMAT, "app": app, "savedAt": saved_at, "id": id, "project": proj });
    let bytes = serde_json::to_vec(&doc).map_err(|e| e.to_string())?;
    // The last good save stays beside the new one.
    let h = digest(&bytes);
    if written.get(&file) != Some(&h) || !file.is_file() {
        if file.is_file() {
            let mut bak = file.as_os_str().to_owned();
            bak.push(".bak");
            let _ = std::fs::copy(&file, PathBuf::from(bak));
        }
        write_atomic(&file, &bytes)?;
        written.insert(file.clone(), h);
    }
    let readme = dir.join("README.txt");
    if !readme.is_file() {
        let _ = std::fs::write(readme, README);
    }
    Ok(out)
}

// ---------------------------------------------------------------- reading

/// A project read back from its folder.
#[derive(Debug, Serialize)]
pub struct Opened {
    pub project: Value,
    pub folder: PathBuf,
    /// Which file it came from: the project file, its `.bak`, or a backup.
    pub from: String,
    pub warnings: Vec<String>,
}

/// The `.reelcut` files in a folder, newest first.
fn project_files(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == EXT) && p.is_file())
        .map(|p| (std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH), p))
        .collect();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().map(|x| x.1).collect()
}

fn read_doc(p: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", p.display()))?;
    let f = v.get("format").and_then(Value::as_u64).unwrap_or(0);
    if f == 0 || f > FORMAT || !v.get("project").is_some_and(Value::is_object) {
        return Err(format!("{}: Reelcut 프로젝트 파일이 아니거나 더 새 버전에서 저장됨 (format {f})", p.display()));
    }
    Ok(v)
}

/// The id written in the folder's project file.
pub fn folder_id(dir: &Path) -> Option<String> {
    project_files(dir).iter().find_map(|p| read_doc(p).ok()).and_then(|d| d["id"].as_str().map(String::from))
}

/// Reads a project file: falls back to its `.bak` and then to the newest backup, saying so;
/// conversations come back from their files with their pictures.
pub fn read_folder(path: &Path, private: &Path) -> Result<Opened, String> {
    let dir = path.parent().ok_or("폴더가 없습니다")?.to_path_buf();
    let mut warnings = Vec::new();
    let mut bak = path.as_os_str().to_owned();
    bak.push(".bak");
    let mut tries: Vec<(String, PathBuf)> = vec![("file".into(), path.to_path_buf()), ("bak".into(), PathBuf::from(bak))];
    let mut backups = list_backups(&dir);
    backups.sort_by(|a, b| b.time.cmp(&a.time));
    tries.extend(backups.into_iter().map(|b| (format!("backup:{}", b.file), dir.join(BACKUPS).join(&b.file))));
    let mut found = None;
    for (from, p) in tries {
        match read_doc(&p) {
            Ok(d) => {
                found = Some((from, d));
                break;
            }
            Err(e) if p.exists() => warnings.push(e),
            Err(_) => {}
        }
    }
    let (from, doc) = found.ok_or_else(|| if warnings.is_empty() { format!("{}: 파일이 없습니다", path.display()) } else { warnings.join(" / ") })?;
    let mut proj = doc["project"].clone();
    let places = [dir.join(CHATS).join(PRIVATE).join("img"), private.to_path_buf()];
    if let Some(chats) = proj.get_mut("chats").and_then(Value::as_array_mut) {
        for c in chats.iter_mut() {
            let Some(o) = c.as_object_mut() else { continue };
            let rel = o.remove("file").and_then(|f| f.as_str().map(String::from)).unwrap_or_default();
            let mut messages = Vec::new();
            let mut context = Vec::new();
            match inside(&dir, &rel).map(|p| std::fs::read_to_string(&p)) {
                Some(Ok(text)) => {
                    for (i, line) in text.lines().enumerate() {
                        let Ok(mut v) = serde_json::from_str::<Value>(line) else {
                            if !line.trim().is_empty() {
                                warnings.push(format!("{rel} {}번째 줄을 읽지 못함", i + 1));
                            }
                            continue;
                        };
                        if v.get("header").is_some() {
                            continue;
                        }
                        if let Some(mut m) = v.get_mut("context").map(Value::take) {
                            pictures_in(&mut m, &places);
                            context.push(m);
                        } else {
                            pictures_in(&mut v, &places);
                            messages.push(v);
                        }
                    }
                }
                _ => warnings.push(format!("대화 파일이 없습니다: {rel}")),
            }
            o.insert("messages".into(), Value::Array(messages));
            if !context.is_empty() {
                o.insert("context".into(), Value::Array(context));
            }
        }
    }
    // Media found again through its path relative to the project folder (the folder moved
    // together with the footage, or another drive letter).
    if let Some(assets) = proj.get_mut("assets").and_then(Value::as_array_mut) {
        for a in assets.iter_mut() {
            let gone = a.pointer("/info/path").and_then(Value::as_str).is_none_or(|p| !Path::new(p).exists());
            if let (true, Some(rel)) = (gone, a.get("rel").and_then(Value::as_str)) {
                let p = normalize(&dir.join(rel));
                if p.exists() && a["info"].is_object() {
                    a["info"]["path"] = json!(p.to_string_lossy());
                }
            }
            if let Some(o) = a.as_object_mut() {
                o.remove("rel");
            }
        }
    }
    Ok(Opened { project: proj, folder: dir, from, warnings })
}

// ---------------------------------------------------------------- backups

#[derive(Debug, Serialize, Clone)]
pub struct Backup {
    pub file: String,
    /// Modified time, ms.
    pub time: u64,
    pub reason: String,
    pub size: u64,
}

fn reason_of(file: &str) -> String {
    let stem = file.strip_suffix(&format!(".{EXT}")).unwrap_or(file);
    // "2026-11-05 1003 AI 작업 전 (2)" → "AI 작업 전"
    let rest = stem.get(16..).unwrap_or("").trim();
    let rest = match rest.rfind(" (") {
        Some(i) if rest.ends_with(')') && rest[i + 2..rest.len() - 1].chars().all(|c| c.is_ascii_digit()) => &rest[..i],
        _ => rest,
    };
    rest.to_string()
}

pub fn list_backups(dir: &Path) -> Vec<Backup> {
    let mut v: Vec<Backup> = std::fs::read_dir(dir.join(BACKUPS))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().into_owned();
            if !file.ends_with(&format!(".{EXT}")) {
                return None;
            }
            let m = e.metadata().ok()?;
            let time = m.modified().ok()?.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_millis() as u64;
            Some(Backup { reason: reason_of(&file), file, time, size: m.len() })
        })
        .collect();
    v.sort_by(|a, b| b.time.cmp(&a.time));
    v
}

/// Copies the project file to `백업\<time> <reason>.reelcut`. `time` is the user's local time,
/// "YYYY-MM-DD HHmm". "열기" is taken once a day.
pub fn backup(dir: &Path, file: &Path, reason: &str, time: &str) -> Result<Option<String>, String> {
    if !file.is_file() {
        return Ok(None);
    }
    let reason = folder_name(reason);
    let time: String = time.chars().filter(|c| c.is_ascii_digit() || *c == '-' || *c == ' ').collect();
    if time.len() != 15 {
        return Err(format!("잘못된 시각: {time}"));
    }
    let bdir = dir.join(BACKUPS);
    if reason == "열기" && list_backups(dir).iter().any(|b| b.reason == "열기" && b.file.starts_with(&time[..10])) {
        return Ok(None);
    }
    std::fs::create_dir_all(&bdir).map_err(|e| e.to_string())?;
    let mut name = format!("{time} {reason}.{EXT}");
    let mut n = 2;
    while bdir.join(&name).exists() {
        name = format!("{time} {reason} ({n}).{EXT}");
        n += 1;
    }
    std::fs::copy(file, bdir.join(&name)).map_err(|e| e.to_string())?;
    Ok(Some(name))
}

/// Which backups to put away: everything from the last day stays, then the newest of each day
/// for 30 days, then the newest of each week; at most 200 files and 500 MB. 복구, 옮겨오기 전 and
/// 수동 always stay.
pub fn prunable(list: &[Backup], now: u64) -> Vec<String> {
    let mut list = list.to_vec();
    list.sort_by(|a, b| b.time.cmp(&a.time));
    let mut keep: Vec<&Backup> = Vec::new();
    let mut out = Vec::new();
    let mut seen: HashSet<(u8, u64)> = HashSet::new();
    for b in &list {
        let age = now.saturating_sub(b.time);
        let fixed = KEEP_REASONS.contains(&b.reason.as_str());
        let stays = fixed
            || age < KEEP_ALL.as_millis() as u64
            || if age < KEEP_DAILY.as_millis() as u64 { seen.insert((0, age / 86_400_000)) } else { seen.insert((1, age / (7 * 86_400_000))) };
        if stays {
            keep.push(b);
        } else {
            out.push(b.file.clone());
        }
    }
    // Over the caps: the oldest that may go, go.
    let mut bytes: u64 = keep.iter().map(|b| b.size).sum();
    let mut count = keep.len();
    for b in keep.iter().rev() {
        if count <= MAX_BACKUPS && bytes <= MAX_BACKUP_BYTES {
            break;
        }
        if KEEP_REASONS.contains(&b.reason.as_str()) {
            continue;
        }
        out.push(b.file.clone());
        count -= 1;
        bytes = bytes.saturating_sub(b.size);
    }
    out
}

/// Moves pruned backups to `<root>\_휴지통\백업\<folder>\`; nothing is erased.
pub fn prune(dir: &Path, root: &Path, now: u64) -> usize {
    let names = prunable(&list_backups(dir), now);
    if names.is_empty() {
        return 0;
    }
    let base = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let to = root.join(TRASH).join(BACKUPS).join(base);
    let _ = std::fs::create_dir_all(&to);
    names.iter().filter(|n| std::fs::rename(dir.join(BACKUPS).join(n), to.join(n)).is_ok()).count()
}

// ---------------------------------------------------------------- the list of project folders

#[derive(Default, Serialize, Deserialize, Clone, Debug)]
pub struct RegFile {
    /// Where new project folders go ("" = the default).
    #[serde(default)]
    pub root: String,
    /// Project id → its folder.
    #[serde(default)]
    pub folders: HashMap<String, String>,
}

pub struct Reg {
    data: PathBuf,
    pub file: RegFile,
    /// Renames tried once per name, so a folder Explorer holds open is not retried every save.
    renames_tried: HashSet<(String, String)>,
}

impl Reg {
    pub fn load(data: &Path) -> Reg {
        let file = std::fs::read_to_string(data.join("projects.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Reg { data: data.to_path_buf(), file, renames_tried: HashSet::new() }
    }
    fn store(&self) -> Result<(), String> {
        write_atomic(&self.data.join("projects.json"), &serde_json::to_vec_pretty(&self.file).map_err(|e| e.to_string())?)
    }
    pub fn root(&self, docs: Option<&Path>, home: &Path) -> PathBuf {
        if self.file.root.is_empty() { default_root(docs, home).0 } else { PathBuf::from(&self.file.root) }
    }
    pub fn folder(&self, id: &str) -> Option<PathBuf> {
        self.file.folders.get(id).map(PathBuf::from).filter(|p| p.is_dir())
    }
    pub fn bind(&mut self, id: &str, dir: &Path) -> Result<(), String> {
        if self.file.folders.get(id).map(String::as_str) != Some(&*dir.to_string_lossy()) {
            self.file.folders.insert(id.to_string(), dir.to_string_lossy().into_owned());
            self.store()?;
        }
        Ok(())
    }
    pub fn unbind(&mut self, id: &str) -> Result<(), String> {
        if self.file.folders.remove(id).is_some() {
            self.store()?;
        }
        Ok(())
    }
    /// The project's folder, made under `root` the first time ("이름 (2)" when the name is taken
    /// by another project), and renamed when the project was renamed.
    pub fn folder_for(&mut self, root: &Path, id: &str, name: &str) -> Result<PathBuf, String> {
        ok_id(id)?;
        let want = folder_name(name);
        if let Some(dir) = self.folder(id) {
            let base = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let named = base == want || (base.starts_with(&format!("{want} (")) && base.ends_with(')'));
            if named || !self.renames_tried.insert((id.to_string(), want.clone())) {
                return Ok(dir);
            }
            let parent = dir.parent().map(Path::to_path_buf).unwrap_or_else(|| root.to_path_buf());
            let Some(to) = free_name(&parent, &want, id) else { return Ok(dir) };
            if to.exists() || std::fs::rename(&dir, &to).is_err() {
                return Ok(dir);
            }
            // The project file follows the folder's name.
            let new_base = to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            for (old, new) in [(format!("{base}.{EXT}"), format!("{new_base}.{EXT}")), (format!("{base}.{EXT}.bak"), format!("{new_base}.{EXT}.bak"))] {
                let _ = std::fs::rename(to.join(old), to.join(new));
            }
            self.bind(id, &to)?;
            return Ok(to);
        }
        std::fs::create_dir_all(root).map_err(|e| format!("{}: {e}", root.display()))?;
        let dir = free_name(root, &want, id).ok_or("폴더 이름을 정하지 못했습니다")?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        self.bind(id, &dir)?;
        Ok(dir)
    }
}

/// `<parent>\<name>`, or "<name> (2)", … : the first that does not exist or already is this project.
fn free_name(parent: &Path, name: &str, id: &str) -> Option<PathBuf> {
    (1..1000).map(|n| parent.join(if n == 1 { name.to_string() } else { format!("{name} ({n})") })).find(|p| !p.exists() || (p.is_dir() && folder_id(p).as_deref() == Some(id)))
}

/// Where the pictures of a project go: inside the folder, or in the app data when the folder is
/// synced to a cloud service.
pub fn img_dir(data: &Path, dir: &Path, id: &str) -> PathBuf {
    if synced_by(dir).is_some() { data.join("private").join(id).join("img") } else { dir.join(CHATS).join(PRIVATE).join("img") }
}

/// The app-data copies of the logs, copied whole into the folder when the folder's copy is
/// shorter (a new folder, or one made before the log was mirrored), then kept by `mirror`.
pub fn sync_logs(data: &Path, dir: &Path, id: &str) {
    let mut pairs = vec![(data.join("logs").join("actions").join(format!("{id}.jsonl")), dir.join(LOGS).join(ACTIONS_FILE))];
    let prefix = format!("{id}.");
    for e in std::fs::read_dir(data.join("logs").join("chats")).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if let Some(sid) = n.strip_prefix(&prefix).and_then(|s| s.strip_suffix(".jsonl")) {
            pairs.push((e.path(), dir.join(CHATS).join(RAW).join(format!("{sid}.jsonl"))));
        }
    }
    for (from, to) in pairs {
        let len = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        if from.is_file() && len(&to) < len(&from) {
            if let Some(d) = to.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let _ = std::fs::copy(&from, &to);
        }
    }
}

/// The folder copy of a log line batch (`jsonl` writes the app-data copy).
pub fn mirror_path(dir: &Path, kind: &str, name: &str) -> Option<PathBuf> {
    match kind {
        "actions" => Some(dir.join(LOGS).join(ACTIONS_FILE)),
        "chats" => name.split_once('.').map(|(_, sid)| dir.join(CHATS).join(RAW).join(format!("{sid}.jsonl"))),
        _ => None,
    }
}

/// Copies of the Claude Code conversations this project's chats use, from `claude-archive`.
pub fn copy_transcripts(data: &Path, dir: &Path, project: &Value) {
    let sessions: Vec<String> = project["chats"].as_array().into_iter().flatten().filter_map(|c| c["ccSession"].as_str().map(String::from)).filter(|s| ok_id(s).is_ok()).collect();
    if sessions.is_empty() {
        return;
    }
    let to = dir.join(CHATS).join(PRIVATE).join("claude-code");
    for d in std::fs::read_dir(data.join("claude-archive")).into_iter().flatten().flatten() {
        for s in &sessions {
            let f = d.path().join(format!("{s}.jsonl"));
            let len = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            if f.is_file() && len(&f) != len(&to.join(format!("{s}.jsonl"))) {
                let _ = std::fs::create_dir_all(&to);
                let _ = std::fs::copy(&f, to.join(format!("{s}.jsonl")));
            }
        }
    }
}

/// Moves a project folder to `<root>\_휴지통\<이름> (<time>)\`.
pub fn trash_folder(dir: &Path, root: &Path, time: &str) -> Result<PathBuf, String> {
    let base = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let time: String = time.chars().filter(|c| c.is_ascii_digit() || *c == '-' || *c == ' ').collect();
    let t = root.join(TRASH);
    std::fs::create_dir_all(&t).map_err(|e| e.to_string())?;
    let mut to = t.join(format!("{base} ({time})"));
    let mut n = 2;
    while to.exists() {
        to = t.join(format!("{base} ({time}) {n}"));
        n += 1;
    }
    std::fs::rename(dir, &to).map_err(|e| e.to_string())?;
    append(&t.join("삭제 기록.txt"), &[format!("{time}  {base}  →  {}", to.display())])?;
    Ok(to)
}

// ---------------------------------------------------------------- moved footage

#[derive(Deserialize, Debug, Clone)]
pub struct Wanted {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub size: u64,
}

/// Looks for moved media under `root` (8 folders deep, project folders skipped): the same file
/// name, and the same size when the size is known. Returns asset id → new path.
pub fn relink_search(root: &Path, wanted: &[Wanted]) -> HashMap<String, String> {
    let want: HashMap<String, Vec<&Wanted>> = wanted.iter().fold(HashMap::new(), |mut m, w| {
        m.entry(w.name.to_lowercase()).or_default().push(w);
        m
    });
    let mut out: HashMap<String, String> = HashMap::new();
    fn walk(d: &Path, depth: u32, want: &HashMap<String, Vec<&Wanted>>, out: &mut HashMap<String, String>, seen: &mut u32) {
        if depth > 8 || *seen > 200_000 {
            return;
        }
        for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
            *seen += 1;
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "$RECYCLE.BIN" {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                if !crate::media::is_project_dir(&p) {
                    walk(&p, depth + 1, want, out, seen);
                }
                continue;
            }
            let Some(ws) = want.get(&name.to_lowercase()) else { continue };
            let len = e.metadata().map(|m| m.len()).unwrap_or(0);
            for w in ws {
                if (w.size == 0 || w.size == len) && !out.contains_key(&w.id) {
                    out.insert(w.id.clone(), p.to_string_lossy().into_owned());
                }
            }
        }
    }
    let mut seen = 0;
    walk(root, 0, &want, &mut out, &mut seen);
    out
}

#[tauri::command]
pub async fn relink_search_cmd(folder: String, wanted: Vec<Wanted>) -> Result<HashMap<String, String>, String> {
    super::blocking(move || Ok(relink_search(Path::new(&folder), &wanted))).await
}

/// Which of these paths exist (one call for a whole project's media).
#[tauri::command]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).exists()).collect()
}

// ---------------------------------------------------------------- commands

static REG: Mutex<Option<Reg>> = parking_lot::const_mutex(None);
static WRITTEN: Mutex<Option<Written>> = parking_lot::const_mutex(None);
/// One save at a time; the registry lock is held only briefly, so log appends never wait for a save.
static SAVING: Mutex<()> = parking_lot::const_mutex(());
static SYNCED: Mutex<Option<HashSet<String>>> = parking_lot::const_mutex(None);
static CC_COPIED: Mutex<Option<HashMap<String, Instant>>> = parking_lot::const_mutex(None);

fn with_reg<T>(data: &Path, f: impl FnOnce(&mut Reg) -> T) -> T {
    let mut g = REG.lock();
    if g.as_ref().is_none_or(|r| r.data != data) {
        *g = Some(Reg::load(data));
    }
    f(g.as_mut().unwrap())
}

fn places(h: &tauri::AppHandle) -> (Option<PathBuf>, PathBuf) {
    use tauri::Manager;
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    (h.path().document_dir().ok(), home)
}

/// Writes the project's folder (after the store); the folder's own logs are filled the first time.
pub fn save_folder(data: &Path, docs: Option<&Path>, home: &Path, project: &Value, saved_at: &str) -> Result<Wrote, String> {
    let id = ok_id(project["id"].as_str().unwrap_or(""))?.to_string();
    let name = project["name"].as_str().unwrap_or("프로젝트").to_string();
    let dir = with_reg(data, |r| {
        let root = r.root(docs, home);
        r.folder_for(&root, &id, &name)
    })?;
    let _one = SAVING.lock();
    let img = img_dir(data, &dir, &id);
    let wrote = {
        let mut w = WRITTEN.lock();
        write_folder(&dir, &img, project, env!("CARGO_PKG_VERSION"), saved_at, w.get_or_insert_with(HashMap::new))?
    };
    if SYNCED.lock().get_or_insert_with(HashSet::new).insert(id.clone()) {
        sync_logs(data, &dir, &id);
    }
    let due = {
        let mut g = CC_COPIED.lock();
        let m = g.get_or_insert_with(HashMap::new);
        let due = m.get(&id).is_none_or(|t| t.elapsed() > Duration::from_secs(60));
        if due {
            m.insert(id.clone(), Instant::now());
        }
        due
    };
    if due {
        copy_transcripts(data, &dir, project);
    }
    Ok(wrote)
}

/// Saves the project: the app store first (as 2.17 did, with its backups), then the folder. A
/// folder that cannot be written does not fail the save; the error comes back to be shown.
#[tauri::command]
pub async fn project_save(app: super::St<'_>, handle: tauri::AppHandle, id: String, json: String, saved_at: String) -> Result<Value, String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let id = ok_id(&id)?.to_string();
        let safe = super::safe_name(&format!("project-{id}"))?;
        let p = app.store_dir().join(format!("{safe}.json"));
        if let Err(e) = super::back_up(&app.data_dir, &safe, &p, super::now_ms()) {
            app.log("backup", &format!("{safe}: {e}"));
        }
        super::write_atomic(&p, json.as_bytes())?;
        let project: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        let (docs, home) = places(&handle);
        match save_folder(&app.data_dir, docs.as_deref(), &home, &project, &saved_at) {
            Ok(w) => Ok(json!({ "file": w.file.to_string_lossy(), "folder": w.file.parent().map(|d| d.to_string_lossy().into_owned()) })),
            Err(e) => {
                app.log("project", &format!("{id}: {e}"));
                Ok(json!({ "error": e }))
            }
        }
    })
    .await
}

/// Opens a `.reelcut` file. `conflict` is set when another folder already holds this project (a
/// copied folder): the app then opens it as a copy with a new id.
#[tauri::command]
pub async fn project_open(app: super::St<'_>, path: String) -> Result<Value, String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let p = PathBuf::from(&path);
        let p = if p.is_dir() { project_files(&p).into_iter().next().ok_or("이 폴더에 .reelcut 파일이 없습니다")? } else { p };
        let probe = read_doc(&p).ok().or_else(|| {
            let mut b = p.as_os_str().to_owned();
            b.push(".bak");
            read_doc(Path::new(&b)).ok()
        });
        let id = probe.as_ref().and_then(|d| d["id"].as_str().map(String::from)).unwrap_or_default();
        let private = app.data_dir.join("private").join(if ok_id(&id).is_ok() { id.as_str() } else { "_" }).join("img");
        let o = read_folder(&p, &private)?;
        let id = o.project["id"].as_str().map(String::from).unwrap_or_default();
        ok_id(&id)?;
        let canon = |d: &Path| std::fs::canonicalize(d).unwrap_or_else(|_| d.to_path_buf());
        let conflict = with_reg(&app.data_dir, |r| -> Result<bool, String> {
            match r.folder(&id) {
                Some(other) if canon(&other) != canon(&o.folder) && folder_id(&other).as_deref() == Some(id.as_str()) => Ok(true),
                _ => {
                    r.bind(&id, &o.folder)?;
                    Ok(false)
                }
            }
        })?;
        if !o.warnings.is_empty() {
            app.log("project", &format!("open {}: {}", p.display(), o.warnings.join(" / ")));
        }
        Ok(json!({ "project": o.project, "folder": o.folder.to_string_lossy(), "from": o.from, "warnings": o.warnings, "conflict": conflict }))
    })
    .await
}

/// The project's folder and file, if it has one.
#[tauri::command]
pub fn project_info(app: super::St<'_>, id: String) -> Option<Value> {
    let dir = with_reg(&app.data_dir, |r| r.folder(&id))?;
    let file = project_files(&dir).into_iter().next();
    Some(json!({ "folder": dir.to_string_lossy(), "file": file.map(|f| f.to_string_lossy().into_owned()) }))
}

/// Where new project folders go, the default, and why the default is not Documents.
#[tauri::command]
pub fn project_root(app: super::St<'_>, handle: tauri::AppHandle) -> Value {
    let (docs, home) = places(&handle);
    let (def, synced) = default_root(docs.as_deref(), &home);
    let root = with_reg(&app.data_dir, |r| r.root(docs.as_deref(), &home));
    json!({ "root": root.to_string_lossy(), "default": def.to_string_lossy(), "custom": root != def, "docsSyncedBy": synced, "rootSyncedBy": synced_by(&root) })
}

/// Changes where new project folders go ("" = the default). Folders already made stay put.
#[tauri::command]
pub fn project_set_root(app: super::St<'_>, path: String) -> Result<(), String> {
    let path = path.trim().to_string();
    if !path.is_empty() {
        std::fs::create_dir_all(&path).map_err(|e| format!("{path}: {e}"))?;
    }
    with_reg(&app.data_dir, |r| {
        r.file.root = path;
        r.store()
    })
}

/// A dated copy of the project file in `백업\`, then the old ones are thinned out.
#[tauri::command]
pub async fn project_backup(app: super::St<'_>, handle: tauri::AppHandle, id: String, reason: String, time: String) -> Result<Option<String>, String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let (docs, home) = places(&handle);
        let (dir, root) = with_reg(&app.data_dir, |r| (r.folder(&id), r.root(docs.as_deref(), &home)));
        let Some(dir) = dir else { return Ok(None) };
        let _one = SAVING.lock();
        let Some(file) = project_files(&dir).into_iter().next() else { return Ok(None) };
        let made = backup(&dir, &file, &reason, &time)?;
        if made.is_some() {
            let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            prune(&dir, &root, now);
        }
        Ok(made)
    })
    .await
}

#[tauri::command]
pub fn project_backups(app: super::St<'_>, id: String) -> Vec<Backup> {
    with_reg(&app.data_dir, |r| r.folder(&id)).map(|d| list_backups(&d)).unwrap_or_default()
}

/// The project as a backup holds it (its pictures and conversations are not part of a backup).
#[tauri::command]
pub fn project_backup_read(app: super::St<'_>, id: String, file: String) -> Result<Value, String> {
    let dir = with_reg(&app.data_dir, |r| r.folder(&id)).ok_or("프로젝트 폴더가 없습니다")?;
    let p = inside(&dir.join(BACKUPS), &file).ok_or("잘못된 파일")?;
    Ok(read_doc(&p)?["project"].clone())
}

/// Gives every project in the app store its folder (first start of 2.18, or again from 설정).
/// Projects that already have a readable folder are left as they are; the store is only read.
#[tauri::command]
pub async fn project_migrate(app: super::St<'_>, handle: tauri::AppHandle, saved_at: String, force: bool) -> Result<Value, String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let (docs, home) = places(&handle);
        Ok(migrate(&app.store_dir(), &app.data_dir, docs.as_deref(), &home, &saved_at, force))
    })
    .await
}

pub fn migrate(store: &Path, data: &Path, docs: Option<&Path>, home: &Path, saved_at: &str, force: bool) -> Value {
    let (mut saved, mut skipped, mut failed) = (0, 0, Vec::<String>::new());
    let mut names: Vec<PathBuf> = std::fs::read_dir(store).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_file() && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("project-") && n.to_string_lossy().ends_with(".json"))).collect();
    names.sort();
    for p in names {
        let doc: Value = match std::fs::read_to_string(&p).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())) {
            Ok(v) => v,
            Err(e) => {
                failed.push(format!("{}: {e}", p.display()));
                continue;
            }
        };
        let id = doc["id"].as_str().unwrap_or("").to_string();
        let done = with_reg(data, |r| r.folder(&id)).is_some_and(|d| folder_id(&d).as_deref() == Some(id.as_str()));
        if done && !force {
            skipped += 1;
            continue;
        }
        match save_folder(data, docs, home, &doc, saved_at) {
            Ok(_) => saved += 1,
            Err(e) => failed.push(format!("{}: {e}", doc["name"].as_str().unwrap_or(&id))),
        }
    }
    json!({ "saved": saved, "skipped": skipped, "failed": failed })
}

/// Moves a deleted project's folder to the trash (the store copy has its own trash).
#[tauri::command]
pub fn project_trash(app: super::St<'_>, handle: tauri::AppHandle, id: String, time: String) -> Result<(), String> {
    let (docs, home) = places(&handle);
    let (dir, root) = with_reg(&app.data_dir, |r| (r.folder(&id), r.root(docs.as_deref(), &home)));
    let Some(dir) = dir else { return Ok(()) };
    let _one = SAVING.lock();
    let to = trash_folder(&dir, &root, &time)?;
    with_reg(&app.data_dir, |r| r.unbind(&id))?;
    SYNCED.lock().get_or_insert_with(HashSet::new).remove(&id);
    app.log("delete", &format!("project folder {} → {}", dir.display(), to.display()));
    Ok(())
}

/// For 다른 이름으로 저장: the copy starts with the original's action log.
#[tauri::command]
pub fn project_copy_logs(app: super::St<'_>, from: String, to: String) -> Result<(), String> {
    let a = super::jsonl::path(&app.data_dir, "actions", &from)?;
    let b = super::jsonl::path(&app.data_dir, "actions", &to)?;
    if a.is_file() && !b.exists() {
        std::fs::copy(&a, &b).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Called by `jsonl_append` after the app-data copy is written.
pub fn mirror(data: &Path, kind: &str, name: &str, lines: &[String]) {
    let id = name.split('.').next().unwrap_or(name);
    let Some(dir) = with_reg(data, |r| r.file.folders.get(id).map(PathBuf::from)) else { return };
    // Until the first save has filled the folder's logs, `sync_logs` copies them whole.
    if !SYNCED.lock().as_ref().is_some_and(|s| s.contains(id)) {
        return;
    }
    if let Some(p) = mirror_path(&dir, kind, name) {
        let _ = append(&p, lines);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("reelcut-project-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn sample(id: &str, name: &str, media: &Path) -> Value {
        json!({
            "id": id, "name": name, "created": 1, "updated": 2, "folders": [],
            "assets": [{ "id": "a1", "folder": "", "info": { "path": media.to_string_lossy(), "name": "CAM_0001.OSV", "size": 1 } }],
            "drafts": [{ "id": "d1", "name": "첫 편집본", "clips": [] }],
            "activeChat": "s1",
            "chats": [{
                "id": "s1", "title": "대화", "created": 1, "updated": 2, "ccSession": "abc-1",
                "messages": [
                    { "role": "user", "content": [{ "type": "text", "text": "둘 다 나오게" }] },
                    { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": [{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": PNG } }] }] },
                    { "role": "assistant", "content": [{ "type": "text", "text": "네" }] }
                ],
                "context": [{ "role": "user", "content": "요약" }]
            }]
        })
    }

    #[test]
    fn folder_names_are_safe_on_windows() {
        assert_eq!(folder_name("제주 여행"), "제주 여행");
        assert_eq!(folder_name("a/b:c*?"), "a_b_c__");
        assert_eq!(folder_name("끝에 점... "), "끝에 점");
        assert_eq!(folder_name("CON"), "_CON");
        assert_eq!(folder_name("nul.txt"), "_nul.txt");
        assert_eq!(folder_name("  "), "프로젝트");
        assert_eq!(folder_name("_휴지통"), "휴지통 프로젝트");
        assert_eq!(folder_name(&"가".repeat(80)).chars().count(), 60);
    }

    #[test]
    fn synced_documents_are_not_the_default() {
        let home = Path::new("/home/u");
        assert_eq!(default_root(Some(Path::new("/home/u/Documents")), home), (PathBuf::from("/home/u/Documents/Reelcut"), None));
        assert_eq!(default_root(Some(Path::new("/home/u/OneDrive/문서")), home), (PathBuf::from("/home/u/Reelcut"), Some("OneDrive")));
        assert_eq!(default_root(Some(Path::new("/home/u/OneDrive - 회사/Documents")), home).1, Some("OneDrive"));
        assert_eq!(synced_by(Path::new("/g/내 드라이브/x")), Some("Google Drive"));
        assert_eq!(synced_by(Path::new("/home/u/Videos")), None);
    }

    #[test]
    fn relative_paths_and_back() {
        let dir = Path::new("/r/Reelcut/여행");
        let r = relative(dir, Path::new("/r/DJI/CAM_0001.OSV")).unwrap();
        assert_eq!(r, "../../DJI/CAM_0001.OSV");
        assert_eq!(normalize(&dir.join(&r)), PathBuf::from("/r/DJI/CAM_0001.OSV"));
        assert_eq!(relative(dir, Path::new("relative.osv")), None);
    }

    #[test]
    fn saves_and_opens_the_same_project() {
        let root = tmp("roundtrip");
        let media = root.join("DJI").join("CAM_0001.OSV");
        std::fs::create_dir_all(media.parent().unwrap()).unwrap();
        std::fs::write(&media, b"x").unwrap();
        let mut reg = Reg::load(&root.join("data"));
        let dir = reg.folder_for(&root.join("Reelcut"), "p1", "제주: 여행").unwrap();
        assert_eq!(dir.file_name().unwrap(), "제주_ 여행");
        let img = img_dir(&root.join("data"), &dir, "p1");
        let p = sample("p1", "제주: 여행", &media);
        let mut w = Written::new();
        let out = write_folder(&dir, &img, &p, "2.18.0", "2026-11-05T10:00:00+09:00", &mut w).unwrap();
        assert_eq!((out.chats, out.pictures), (1, 1));
        assert!(dir.join("README.txt").is_file());
        // The project file holds no pictures and no messages.
        let text = std::fs::read_to_string(&out.file).unwrap();
        assert!(!text.contains(PNG) && !text.contains("둘 다 나오게"));
        let chat = std::fs::read_to_string(dir.join("대화/s1.jsonl")).unwrap();
        assert!(chat.contains("image_ref") && !chat.contains(PNG));
        assert_eq!(std::fs::read_dir(&img).unwrap().count(), 1);
        // Unchanged: the conversation is not written again.
        let again = write_folder(&dir, &img, &p, "2.18.0", "t", &mut w).unwrap();
        assert_eq!((again.chats, again.skipped), (0, 1));
        assert!(text.contains("\"rel\":\"../../DJI/CAM_0001.OSV\""), "{text}");
        // Read back: equal to what was saved.
        let o = read_folder(&out.file, &root.join("none")).unwrap();
        assert_eq!(o.from, "file");
        assert!(o.warnings.is_empty(), "{:?}", o.warnings);
        assert_eq!(o.project, p);
        // The footage and the project folder moved together (another drive letter): found by `rel`.
        let moved = root.join("moved");
        std::fs::create_dir_all(moved.join("Reelcut")).unwrap();
        std::fs::rename(&dir, moved.join("Reelcut").join("제주_ 여행")).unwrap();
        std::fs::rename(root.join("DJI"), moved.join("DJI")).unwrap();
        let o = read_folder(&moved.join("Reelcut/제주_ 여행").join(out.file.file_name().unwrap()), &root).unwrap();
        assert_eq!(o.project.pointer("/assets/0/info/path").and_then(Value::as_str), Some(&*moved.join("DJI/CAM_0001.OSV").to_string_lossy()));
    }

    #[test]
    fn falls_back_to_bak_then_backups() {
        let root = tmp("fallback");
        let mut reg = Reg::load(&root.join("data"));
        let dir = reg.folder_for(&root.join("R"), "p2", "가").unwrap();
        let img = img_dir(&root.join("data"), &dir, "p2");
        let mut w = Written::new();
        let mut p = sample("p2", "가", Path::new("/nope.osv"));
        let f = write_folder(&dir, &img, &p, "v", "t1", &mut w).unwrap().file;
        backup(&dir, &f, "수동", "2026-11-05 1000").unwrap().unwrap();
        p["name"] = json!("나");
        write_folder(&dir, &img, &p, "v", "t2", &mut w).unwrap();
        std::fs::write(&f, "{ broken").unwrap();
        let o = read_folder(&f, &root).unwrap();
        assert_eq!((o.from.as_str(), o.project["name"].as_str()), ("bak", Some("가")));
        assert_eq!(o.warnings.len(), 1);
        let mut bak = f.as_os_str().to_owned();
        bak.push(".bak");
        std::fs::write(PathBuf::from(bak), "").unwrap();
        let o = read_folder(&f, &root).unwrap();
        assert!(o.from.starts_with("backup:") && o.project["name"] == "가");
    }

    #[test]
    fn names_collide_and_renames_follow() {
        let root = tmp("names");
        let mut reg = Reg::load(&root.join("data"));
        let r = root.join("R");
        let a = reg.folder_for(&r, "pa", "여행").unwrap();
        let mut w = Written::new();
        write_folder(&a, &img_dir(&root, &a, "pa"), &sample("pa", "여행", Path::new("/x")), "v", "t", &mut w).unwrap();
        let b = reg.folder_for(&r, "pb", "여행").unwrap();
        assert_eq!(b.file_name().unwrap(), "여행 (2)");
        // Same project again: same folder; renamed: the folder and its file follow.
        assert_eq!(reg.folder_for(&r, "pa", "여행").unwrap(), a);
        let c = reg.folder_for(&r, "pa", "제주").unwrap();
        assert_eq!(c.file_name().unwrap(), "제주");
        assert!(c.join("제주.reelcut").is_file() && !a.exists());
        // The registry survives a restart.
        assert_eq!(Reg::load(&root.join("data")).folder("pa"), Some(c));
    }

    #[test]
    fn backups_are_thinned_but_never_erased() {
        let day = 86_400_000u64;
        let now = 400 * day;
        let mk = |file: &str, age: u64| Backup { file: file.into(), time: now - age, reason: reason_of(file), size: 1 };
        let list = vec![
            mk("2026-11-05 1000 AI 작업 전.reelcut", 3_600_000),
            mk("2026-11-05 0900 AI 작업 전 (2).reelcut", 7_200_000),
            mk("2026-11-03 1000 열기.reelcut", 2 * day + 1000),
            mk("2026-11-03 0900 1시간마다.reelcut", 2 * day + 5000),
            mk("2026-01-01 0900 수동.reelcut", 300 * day),
            mk("2026-01-02 0900 열기.reelcut", 299 * day),
            mk("2026-01-03 0900 열기.reelcut", 298 * day),
        ];
        assert_eq!(reason_of("2026-11-05 0900 AI 작업 전 (2).reelcut"), "AI 작업 전");
        let out = prunable(&list, now);
        assert!(out.contains(&"2026-11-03 0900 1시간마다.reelcut".to_string()));
        assert!(!out.contains(&"2026-11-03 1000 열기.reelcut".to_string()));
        assert!(!out.iter().any(|f| f.contains("수동") || f.starts_with("2026-11-05")));
        // Two in one old week: the newer stays.
        assert_eq!(out.iter().filter(|f| f.starts_with("2026-01-0")).count(), 1);

        let root = tmp("backups");
        let dir = root.join("R").join("p");
        std::fs::create_dir_all(dir.join(BACKUPS)).unwrap();
        let f = dir.join("p.reelcut");
        std::fs::write(&f, "{}").unwrap();
        assert!(backup(&dir, &f, "열기", "2026-11-05 1000").unwrap().is_some());
        assert!(backup(&dir, &f, "열기", "2026-11-05 1130").unwrap().is_none());
        let old = backup(&dir, &f, "1시간마다", "2026-10-01 0900").unwrap().unwrap();
        let older = backup(&dir, &f, "1시간마다", "2026-10-01 0800").unwrap().unwrap();
        let set = |n: &str, ago: u64| std::fs::File::options().write(true).open(dir.join(BACKUPS).join(n)).unwrap().set_modified(SystemTime::now() - Duration::from_millis(ago)).unwrap();
        set(&old, 35 * day);
        set(&older, 35 * day + 1000);
        assert_eq!(prune(&dir, &root.join("R"), SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis() as u64), 1);
        assert!(root.join("R/_휴지통/백업/p").join(&older).is_file());
        assert_eq!(list_backups(&dir).len(), 2);
    }

    #[test]
    fn migration_twice_gives_the_same_tree() {
        let root = tmp("migrate");
        let store = root.join("data").join("store");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join("project-m1.json"), sample("m1", "하나", Path::new("/x")).to_string()).unwrap();
        std::fs::write(store.join("project-m2.json"), sample("m2", "하나", Path::new("/x")).to_string()).unwrap();
        std::fs::write(store.join("project-bad.json"), "{").unwrap();
        std::fs::write(store.join("settings.json"), "{}").unwrap();
        let docs = root.join("Documents");
        let data = root.join("data");
        let r1 = migrate(&store, &data, Some(&docs), &root, "t", false);
        assert_eq!((r1["saved"].as_u64(), r1["failed"].as_array().map(Vec::len)), (Some(2), Some(1)));
        let tree = |d: &Path| {
            let mut v: Vec<(String, Vec<u8>)> = Vec::new();
            fn walk(d: &Path, base: &Path, v: &mut Vec<(String, Vec<u8>)>) {
                for e in std::fs::read_dir(d).unwrap().flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        walk(&p, base, v)
                    } else {
                        v.push((p.strip_prefix(base).unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap()));
                    }
                }
            }
            walk(d, d, &mut v);
            v.sort();
            v
        };
        let before = tree(&docs.join("Reelcut"));
        assert!(before.iter().any(|(n, _)| n.ends_with("하나 (2).reelcut")));
        let r2 = migrate(&store, &data, Some(&docs), &root, "t2", false);
        assert_eq!(r2["skipped"].as_u64(), Some(2));
        assert_eq!(tree(&docs.join("Reelcut")), before);
        // The store is only read.
        assert!(store.join("project-m1.json").is_file());
    }

    #[test]
    fn logs_reach_the_folder() {
        let root = tmp("logs");
        let data = root.join("data");
        std::fs::create_dir_all(data.join("logs/actions")).unwrap();
        std::fs::create_dir_all(data.join("logs/chats")).unwrap();
        std::fs::write(data.join("logs/actions/l1.jsonl"), "{\"seq\":1}\n").unwrap();
        std::fs::write(data.join("logs/chats/l1.s9.jsonl"), "{\"raw\":1}\n").unwrap();
        let p = sample("l1", "기록", Path::new("/x"));
        let w = save_folder(&data, Some(&root.join("Docs")), &root, &p, "t").unwrap();
        let dir = w.file.parent().unwrap().to_path_buf();
        assert_eq!(std::fs::read_to_string(dir.join("기록/작업.jsonl")).unwrap(), "{\"seq\":1}\n");
        assert_eq!(std::fs::read_to_string(dir.join("대화/원본/s9.jsonl")).unwrap(), "{\"raw\":1}\n");
        mirror(&data, "actions", "l1", &["{\"seq\":2}".into()]);
        mirror(&data, "chats", "l1.s9", &["{\"raw\":2}".into()]);
        assert_eq!(std::fs::read_to_string(dir.join("기록/작업.jsonl")).unwrap().lines().count(), 2);
        assert_eq!(std::fs::read_to_string(dir.join("대화/원본/s9.jsonl")).unwrap().lines().count(), 2);
        // Claude Code transcripts the chats use are copied into the private folder.
        std::fs::create_dir_all(data.join("claude-archive/C--x")).unwrap();
        std::fs::write(data.join("claude-archive/C--x/abc-1.jsonl"), "t").unwrap();
        copy_transcripts(&data, &dir, &p);
        assert!(dir.join("대화/비공개/claude-code/abc-1.jsonl").is_file());
        // Deleting moves the folder to the trash with a readable note.
        let to = trash_folder(&dir, &root.join("Docs/Reelcut"), "2026-11-05 1200").unwrap();
        assert!(to.join("기록.reelcut").is_file() && !dir.exists());
        assert!(std::fs::read_to_string(root.join("Docs/Reelcut/_휴지통/삭제 기록.txt")).unwrap().contains("기록"));
    }

    #[test]
    fn moved_footage_is_found_by_name_and_size() {
        let root = tmp("relink");
        std::fs::create_dir_all(root.join("새 폴더/2026-10")).unwrap();
        std::fs::create_dir_all(root.join("Reelcut/여행")).unwrap();
        std::fs::write(root.join("새 폴더/2026-10/CAM_0001.OSV"), b"abc").unwrap();
        std::fs::write(root.join("새 폴더/cam_0002.osv"), b"x").unwrap();
        // A same-named file inside a project folder is not footage.
        std::fs::write(root.join("Reelcut/여행/여행.reelcut"), b"{}").unwrap();
        std::fs::write(root.join("Reelcut/여행/CAM_0003.OSV"), b"y").unwrap();
        let w = |id: &str, name: &str, size: u64| Wanted { id: id.into(), name: name.into(), size };
        let found = relink_search(&root, &[w("a", "CAM_0001.OSV", 3), w("b", "CAM_0002.OSV", 0), w("c", "CAM_0003.OSV", 1), w("d", "CAM_0001.OSV", 99)]);
        assert_eq!(found.get("a").map(String::as_str), Some(&*root.join("새 폴더/2026-10/CAM_0001.OSV").to_string_lossy()));
        assert!(found.get("b").is_some_and(|p| p.ends_with("cam_0002.osv")));
        assert!(!found.contains_key("c") && !found.contains_key("d"));
    }

    #[test]
    fn pictures_go_to_the_app_data_when_the_folder_is_synced() {
        let data = Path::new("/d");
        assert_eq!(img_dir(data, Path::new("/u/OneDrive/Reelcut/a"), "p"), PathBuf::from("/d/private/p/img"));
        assert_eq!(img_dir(data, Path::new("/u/Reelcut/a"), "p"), PathBuf::from("/u/Reelcut/a/대화/비공개/img"));
    }
}
