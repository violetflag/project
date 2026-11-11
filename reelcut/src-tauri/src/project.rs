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
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

pub const EXT: &str = "reelcut";
pub const FORMAT: u64 = 1;
const TRASH: &str = "_휴지통";
const CHATS: &str = "대화";
const RAW: &str = "원본";
pub const PRIVATE: &str = "비공개";
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

static TMP_N: AtomicU64 = AtomicU64::new(0);

/// A whole file or nothing: written beside (under a name no other write uses), flushed to disk,
/// then moved over the old one. Moving is retried a few times, as antivirus and sync programs
/// hold new files open for a moment.
pub fn write_atomic(p: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let mut tmp = p.as_os_str().to_owned();
    tmp.push(format!(".{}-{}.tmp", std::process::id(), TMP_N.fetch_add(1, Ordering::Relaxed)));
    let tmp = PathBuf::from(tmp);
    let wrote = std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display())).and_then(|mut f| f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| e.to_string()));
    if let Err(e) = wrote {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
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
    let _ = std::fs::remove_file(&tmp);
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
    // The folder was renamed in Explorer: the project file follows it, so the folder never holds
    // an old copy next to the new one.
    if !file.exists() {
        if let Some(old) = project_files(dir).into_iter().find(|p| file_id(p).as_deref() == Some(id.as_str())) {
            let old_bak = PathBuf::from(format!("{}.bak", old.display()));
            let _ = std::fs::rename(&old, &file);
            if old_bak.is_file() {
                let _ = std::fs::rename(&old_bak, dir.join(format!("{base}.{EXT}.bak")));
            }
        }
    }
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
    // Pictures anywhere else (the single `chat` of projects last saved before 2.3) never stay in
    // the project file either.
    pictures_out(&mut proj, img, &mut out.pictures)?;
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

/// The project id of a project file, from its first bytes (the id is written before the project,
/// so a large file is not read whole), else from the whole file.
fn file_id(p: &Path) -> Option<String> {
    use std::io::Read;
    let mut head = vec![0u8; 4096];
    let n = std::fs::File::open(p).and_then(|mut f| f.read(&mut head)).ok()?;
    let s = String::from_utf8_lossy(&head[..n]);
    let quick = s.find("\"id\":\"").and_then(|i| {
        let rest = &s[i + 6..];
        rest.find('"').map(|j| rest[..j].to_string())
    });
    match quick {
        Some(id) if s.trim_start().starts_with('{') && ok_id(&id).is_ok() => Some(id),
        _ => read_doc(p).ok().and_then(|d| d["id"].as_str().map(String::from)),
    }
}

/// The project a folder belongs to: the id in its project file, or in that file's `.bak` when the
/// file itself was moved away.
pub fn folder_id(dir: &Path) -> Option<String> {
    project_files(dir).iter().find_map(|p| file_id(p)).or_else(|| {
        let base = dir.file_name()?.to_string_lossy().into_owned();
        file_id(&dir.join(format!("{base}.{EXT}.bak")))
    })
}

/// A folder Reelcut made for a project: it holds Reelcut's README, or `<folder>.reelcut` (or its
/// `.bak`) together with one of Reelcut's own sub-folders. Not some folder a lone `.reelcut` file
/// was dropped into (the Desktop, Downloads, a drive, the user's footage folder named like the
/// project, a folder that happens to have a 대화 sub-folder). Only such folders are written into,
/// renamed or moved to the trash.
pub fn is_project_folder(dir: &Path) -> bool {
    let Some(base) = dir.file_name().map(|n| n.to_string_lossy().into_owned()) else { return false };
    if dir.parent().is_none() || !dir.is_dir() {
        return false;
    }
    let marked = std::fs::read_to_string(dir.join("README.txt")).is_ok_and(|t| t.trim_start_matches('\u{feff}').starts_with("Reelcut 프로젝트 폴더"));
    let file = dir.join(format!("{base}.{EXT}")).is_file() || dir.join(format!("{base}.{EXT}.bak")).is_file();
    marked || (file && [CHATS, LOGS, BACKUPS].iter().any(|s| dir.join(s).is_dir())) || holds_own_chats(dir)
}

/// A project file here whose conversations are in this folder's 대화 (conversation ids are random,
/// so no other folder matches by chance): a project folder renamed in Explorer, whose project file
/// keeps its old name until the next save, even when its README was deleted.
fn holds_own_chats(dir: &Path) -> bool {
    dir.join(CHATS).is_dir()
        && project_files(dir).iter().filter_map(|p| read_doc(p).ok()).any(|d| {
            d.pointer("/project/chats").and_then(Value::as_array).is_some_and(|cs| {
                cs.iter().filter_map(|c| c["id"].as_str()).any(|sid| ok_id(sid).is_ok() && dir.join(CHATS).join(format!("{sid}.jsonl")).is_file())
            })
        })
}

/// Holds nothing but what Reelcut puts into a project folder, so renaming it or moving it to the
/// trash can never take the user's own files with it.
fn only_ours(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    let ext = format!(".{EXT}");
    let bak = format!(".{EXT}.bak");
    entries.flatten().all(|e| {
        let n = e.file_name().to_string_lossy().into_owned();
        let l = n.to_ascii_lowercase();
        l.ends_with(&ext)
            || l.ends_with(&bak)
            || l.ends_with(".tmp")
            || [CHATS, LOGS, BACKUPS].contains(&n.as_str())
            || ["readme.txt", "desktop.ini", "thumbs.db", ".ds_store"].contains(&l.as_str())
    })
}

/// On a drive (or network share) that is not connected now: an external drive left unplugged.
fn drive_gone(p: &Path) -> bool {
    p.ancestors().filter(|d| !d.as_os_str().is_empty()).last().is_some_and(|d| !d.exists())
}

fn ms_of(t: SystemTime) -> Option<u64> {
    t.duration_since(SystemTime::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

fn now_ms() -> u64 {
    ms_of(SystemTime::now()).unwrap_or(0)
}

/// The folder holds the project file this app wrote last (by its digest), not a copy saved at
/// another moment.
fn holds_sum(dir: &Path, id: &str, sum: &str) -> bool {
    project_files(dir).iter().any(|p| file_id(p).as_deref() == Some(id) && std::fs::read(p).is_ok_and(|b| digest(&b) == sum))
}

/// The project file was written before the project's folder was made again: it is the folder the
/// user moved away, not a copy of the one made since (a copy keeps the time its file was last
/// written). `at` 0 is a record from 2.18.1, which kept no time: the made folder's own creation
/// time stands in for it.
fn written_before(file: &Path, at: u64, made: &Path) -> bool {
    let at = if at > 0 { Some(at) } else { std::fs::metadata(made).and_then(|m| m.created()).ok().and_then(ms_of) };
    let written = std::fs::metadata(file).and_then(|m| m.modified()).ok().and_then(ms_of);
    matches!((written, at), (Some(w), Some(a)) if w < a)
}

/// Inside a `_휴지통` folder (a deleted project, or pruned backups).
fn in_trash(p: &Path) -> bool {
    p.components().any(|c| c.as_os_str() == TRASH)
}

fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Under the system's temporary folder (a `.reelcut` opened from inside a zip is extracted there,
/// and Windows clears it).
fn in_temp(p: &Path, temp: &Path) -> bool {
    canon(p).starts_with(canon(temp))
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
    pictures_in(&mut proj, &places);
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
    // Windows keeps the project file's time on a copy; a backup's time is when it was made.
    let _ = std::fs::File::options().write(true).open(bdir.join(&name)).and_then(|f| f.set_modified(SystemTime::now()));
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
    /// Project id → the project name its folder last followed. The folder is renamed only when the
    /// project is renamed in the app, never because the user renamed the folder in Explorer.
    #[serde(default)]
    pub names: HashMap<String, String>,
    /// Projects whose folder vanished (or could not be told apart from a copy) and was made again
    /// by a save, with when (ms). When the user then opens the folder they moved, whose project
    /// file was written before that moment, it takes over instead of opening as a copy; a copy of
    /// the folder made since still opens as a copy.
    #[serde(default, deserialize_with = "recreated_in")]
    pub recreated: HashMap<String, u64>,
    /// Project id → digest of the project file its last save wrote, so a folder found again after
    /// a rename or move is the one this app wrote, not a snapshot copy the user made beside it.
    #[serde(default)]
    pub sums: HashMap<String, String>,
    /// When that file was written (ms): a copy of the folder whose file is older than this (a
    /// snapshot made in Explorer) opens as a copy, never as the project's folder.
    #[serde(default)]
    pub sum_at: HashMap<String, u64>,
}

/// `recreated` as 2.18.1 wrote it (a list of ids, no time) or as a map of id → ms.
fn recreated_in<'de, D: serde::Deserializer<'de>>(d: D) -> Result<HashMap<String, u64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Any {
        At(HashMap<String, u64>),
        Ids(Vec<String>),
    }
    Ok(match Any::deserialize(d)? {
        Any::At(m) => m,
        Any::Ids(v) => v.into_iter().map(|id| (id, 0)).collect(),
    })
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
    /// The project's registered folder, when it is still there and still this project's (another
    /// project may have been given the same path after the user renamed or deleted the folder).
    pub fn folder(&self, id: &str) -> Option<PathBuf> {
        self.file.folders.get(id).map(PathBuf::from).filter(|p| p.is_dir() && folder_id(p).is_none_or(|x| x == id))
    }
    pub fn unbind(&mut self, id: &str) -> Result<(), String> {
        let a = self.file.folders.remove(id).is_some();
        let b = self.file.names.remove(id).is_some();
        let c = self.file.recreated.remove(id).is_some();
        if a || b || c {
            self.store()?;
        }
        Ok(())
    }
    /// Takes a folder the user moved, renamed or opened as this project's folder, as it is named.
    pub fn adopt(&mut self, id: &str, dir: &Path, name: &str) -> Result<(), String> {
        self.file.folders.insert(id.to_string(), dir.to_string_lossy().into_owned());
        self.file.names.insert(id.to_string(), folder_name(name));
        self.file.recreated.remove(id);
        // What this folder holds now is what later finds and opens compare with (not the file of
        // a folder made meanwhile, which a takeover just moved to the trash).
        match project_files(dir).into_iter().find(|p| file_id(p).as_deref() == Some(id)) {
            Some(p) => {
                if let Ok(b) = std::fs::read(&p) {
                    self.file.sums.insert(id.to_string(), digest(&b));
                    let t = std::fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(ms_of);
                    self.file.sum_at.insert(id.to_string(), t.unwrap_or_else(now_ms));
                }
            }
            None => {
                self.file.sums.remove(id);
                self.file.sum_at.remove(id);
            }
        }
        self.store()
    }
    /// The project's folder when it has one: where it was registered, or (after it was renamed or
    /// moved in Explorer, or deleted with the project and brought back from Home's 휴지통) found
    /// again by its id. Nothing is made.
    pub fn locate(&mut self, root: &Path, id: &str, name: Option<&str>) -> Option<PathBuf> {
        self.find(root, id, name).0
    }
    /// `locate`, and whether folders of this project were seen that could not be told apart (a
    /// snapshot copy beside the folder the user renamed).
    fn find(&mut self, root: &Path, id: &str, name: Option<&str>) -> (Option<PathBuf>, bool) {
        if let Some(d) = self.folder(id) {
            return (Some(d), false);
        }
        let old = self.file.folders.get(id).map(PathBuf::from);
        // On a drive that is not plugged in: nothing is looked for elsewhere, so nothing takes its
        // place, and saves go back to it once the drive is there again.
        if old.as_deref().is_some_and(drive_gone) {
            return (None, false);
        }
        let (found, seen) = find_folder(root, id, old.as_deref(), self.file.sums.get(id).map(String::as_str));
        let Some(found) = found else { return (None, seen) };
        let name = name.map(String::from).unwrap_or_else(|| name_in(&found));
        let found = if in_trash(&found) {
            match untrash(&found, root, &folder_name(&name), id, &self.file.folders) {
                Some(f) => f,
                None => return (None, seen),
            }
        } else {
            found
        };
        if self.adopt(id, &found, &name).is_err() {
            return (None, seen);
        }
        (Some(found), seen)
    }
    /// The project's folder, made under `root` the first time ("이름 (2)" when the name is taken
    /// by another project), and renamed when the project was renamed in the app. A folder on a
    /// drive that is not connected is an error, not a reason to make another.
    pub fn folder_for(&mut self, root: &Path, id: &str, name: &str) -> Result<PathBuf, String> {
        ok_id(id)?;
        let want = folder_name(name);
        let (found, seen) = self.find(root, id, Some(name));
        if let Some(dir) = found {
            return self.follow_name(root, id, &want, dir);
        }
        if let Some(old) = self.file.folders.get(id).filter(|p| drive_gone(Path::new(p))) {
            return Err(format!("프로젝트 폴더가 있는 드라이브가 연결되어 있지 않습니다: {old}"));
        }
        let vanished = self.file.folders.contains_key(id) || seen;
        std::fs::create_dir_all(root).map_err(|e| format!("{}: {e}", root.display()))?;
        let dir = free_name(root, &want, id, &self.file.folders).ok_or("폴더 이름을 정하지 못했습니다")?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        self.file.folders.insert(id.to_string(), dir.to_string_lossy().into_owned());
        self.file.names.insert(id.to_string(), want);
        if vanished {
            self.file.recreated.insert(id.to_string(), now_ms());
        }
        self.store()?;
        Ok(dir)
    }
    /// Notes the digest of the project file a save wrote.
    pub fn note_sum(&mut self, id: &str, sum: &str) -> Result<(), String> {
        if self.file.sums.get(id).map(String::as_str) == Some(sum) {
            return Ok(());
        }
        self.file.sums.insert(id.to_string(), sum.to_string());
        self.file.sum_at.insert(id.to_string(), now_ms());
        self.store()
    }
    /// Renames the folder (and its project file) after the project was renamed in the app.
    fn follow_name(&mut self, root: &Path, id: &str, want: &str, dir: PathBuf) -> Result<PathBuf, String> {
        let last = self.file.names.get(id).cloned();
        if last.as_deref() == Some(want) {
            return Ok(dir);
        }
        let base = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let named = base == want || (base.starts_with(&format!("{want} (")) && base.ends_with(')'));
        // Already so named, or a folder from before names were kept: it stays as it is.
        if named || last.is_none() {
            self.file.names.insert(id.to_string(), want.to_string());
            self.store()?;
            return Ok(dir);
        }
        if !self.renames_tried.insert((id.to_string(), want.to_string())) || !is_project_folder(&dir) || !only_ours(&dir) || root.starts_with(&dir) {
            return Ok(dir);
        }
        let parent = dir.parent().map(Path::to_path_buf).unwrap_or_else(|| root.to_path_buf());
        let Some(to) = free_name(&parent, want, id, &self.file.folders) else { return Ok(dir) };
        if to.exists() || std::fs::rename(&dir, &to).is_err() {
            return Ok(dir);
        }
        // The project file follows the folder's name.
        let new_base = to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        for (old, new) in [(format!("{base}.{EXT}"), format!("{new_base}.{EXT}")), (format!("{base}.{EXT}.bak"), format!("{new_base}.{EXT}.bak"))] {
            let _ = std::fs::rename(to.join(old), to.join(new));
        }
        self.file.folders.insert(id.to_string(), to.to_string_lossy().into_owned());
        self.file.names.insert(id.to_string(), want.to_string());
        self.store()?;
        Ok(to)
    }
}

/// `<parent>\<name>`, or "<name> (2)", … : the first that does not exist (and is not another
/// project's registered folder) or already is this project.
fn free_name(parent: &Path, name: &str, id: &str, folders: &HashMap<String, String>) -> Option<PathBuf> {
    let taken: HashSet<PathBuf> = folders.iter().filter(|(k, _)| k.as_str() != id).map(|(_, v)| PathBuf::from(v)).collect();
    (1..1000)
        .map(|n| parent.join(if n == 1 { name.to_string() } else { format!("{name} ({n})") }))
        .find(|p| !taken.contains(p) && (!p.exists() || (p.is_dir() && folder_id(p).as_deref() == Some(id))))
}

/// A project folder whose registered place is gone: renamed or moved within the projects folder
/// or its old parent folder, or (newest first) in `_휴지통` after the project was deleted from Home
/// (only then: a folder moved there because the user's own folder took over never comes back).
/// When the digest of the project's last written file is known, only the one folder holding it
/// is taken; a snapshot copy beside it, or two folders that cannot be told apart, give none. The
/// flag says folders of this project were seen.
fn find_folder(root: &Path, id: &str, old: Option<&Path>, sum: Option<&str>) -> (Option<PathBuf>, bool) {
    let mut parents = vec![root.to_path_buf()];
    if let Some(p) = old.and_then(Path::parent).filter(|p| *p != root && !in_trash(p)) {
        parents.push(p.to_path_buf());
    }
    let mut found: Vec<PathBuf> = Vec::new();
    for parent in &parents {
        for e in std::fs::read_dir(parent).into_iter().flatten().flatten() {
            let p = e.path();
            if e.file_name() != TRASH && p.is_dir() && is_project_folder(&p) && folder_id(&p).as_deref() == Some(id) && !found.contains(&p) {
                found.push(p);
            }
        }
    }
    let seen = !found.is_empty();
    if let Some(s) = sum {
        found.retain(|p| holds_sum(p, id, s));
    }
    if found.len() == 1 {
        return (found.pop(), seen);
    }
    if seen || old.is_some() {
        return (None, seen);
    }
    let mut trashed: Vec<(bool, SystemTime, PathBuf)> = std::fs::read_dir(root.join(TRASH))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && folder_id(p).as_deref() == Some(id))
        .map(|p| (sum.is_some_and(|s| holds_sum(&p, id, s)), std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH), p))
        // Never a folder made meanwhile and moved there by a takeover: only the one holding the
        // last written file, when that is known.
        .filter(|x| sum.is_none() || x.0)
        .collect();
    trashed.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    (trashed.into_iter().next().map(|x| x.2), false)
}

/// The project name written in a folder's project file.
fn name_in(dir: &Path) -> String {
    project_files(dir).iter().find_map(|p| read_doc(p).ok()).and_then(|d| d.pointer("/project/name").and_then(Value::as_str).map(String::from)).unwrap_or_else(|| "프로젝트".into())
}

/// Moves a project folder back out of `_휴지통` (the project was restored), noting it beside the
/// deletion record.
fn untrash(dir: &Path, root: &Path, want: &str, id: &str, folders: &HashMap<String, String>) -> Option<PathBuf> {
    let to = free_name(root, want, id, folders)?;
    if to.exists() {
        return None;
    }
    std::fs::rename(dir, &to).ok()?;
    let _ = append(&root.join(TRASH).join("삭제 기록.txt"), &[format!("되살림  {}  →  {}", dir.display(), to.display())]);
    Some(to)
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

/// Where the copies of the Claude Code conversations go. They hold the frames the AI looked at,
/// so, like the pictures, they stay in the app data when the folder is synced to a cloud service.
pub fn transcripts_dir(data: &Path, dir: &Path, id: &str) -> PathBuf {
    if synced_by(dir).is_some() { data.join("private").join(id).join("claude-code") } else { dir.join(CHATS).join(PRIVATE).join("claude-code") }
}

/// Copies of the Claude Code conversations this project's chats use (now and before a
/// compaction), from `claude-archive` into `to`.
pub fn copy_transcripts(data: &Path, to: &Path, project: &Value) {
    let sessions: Vec<String> = project["chats"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|c| c["ccSession"].as_str().into_iter().chain(c["ccPast"].as_array().into_iter().flatten().filter_map(Value::as_str)).map(String::from).collect::<Vec<_>>())
        .filter(|s| ok_id(s).is_ok())
        .collect();
    if sessions.is_empty() {
        return;
    }
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

/// Which of these paths exist (one call for a whole project's media). Off the window's thread: a
/// sleeping external drive or a lost network drive can take seconds to answer.
#[tauri::command]
pub async fn paths_exist(paths: Vec<String>) -> Result<Vec<bool>, String> {
    super::blocking(move || Ok(paths.iter().map(|p| Path::new(p).exists()).collect())).await
}

/// The project file in the first of these folders that holds one (a project folder dropped on
/// the window or opened from Explorer).
#[tauri::command]
pub async fn project_file_in(paths: Vec<String>) -> Result<Option<String>, String> {
    super::blocking(move || Ok(paths.iter().map(PathBuf::from).filter(|p| p.is_dir()).find_map(|p| project_files(&p).into_iter().next()).map(|f| f.to_string_lossy().into_owned()))).await
}

// ---------------------------------------------------------------- commands

static REG: Mutex<Option<Reg>> = parking_lot::const_mutex(None);
static WRITTEN: Mutex<Option<Written>> = parking_lot::const_mutex(None);
/// One project save at a time, from the store file to the last folder file: two saves never
/// share a file, and an older one never lands after a newer one.
static STORE_WRITE: Mutex<()> = parking_lot::const_mutex(());
/// One folder change at a time (saves, migration, backups, trash, open). Lock order:
/// STORE_WRITE, SAVING, REG; the others are taken alone and briefly.
static SAVING: Mutex<()> = parking_lot::const_mutex(());
/// Project id → the folder its last save wrote. Log lines are mirrored only there (never into a
/// folder that is gone or now another project's), and a folder new to the project gets the logs
/// whole.
static OWNED: Mutex<Option<HashMap<String, PathBuf>>> = parking_lot::const_mutex(None);
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

/// The project's folder if it has one (found again when it was moved), without making one.
fn located(data: &Path, docs: Option<&Path>, home: &Path, id: &str) -> (Option<PathBuf>, PathBuf) {
    with_reg(data, |r| {
        let root = r.root(docs, home);
        (r.locate(&root, id, None), root)
    })
}

/// Writes the project's folder (after the store); the folder's own logs are filled the first time.
pub fn save_folder(data: &Path, docs: Option<&Path>, home: &Path, project: &Value, saved_at: &str) -> Result<Wrote, String> {
    let id = ok_id(project["id"].as_str().unwrap_or(""))?.to_string();
    let name = project["name"].as_str().unwrap_or("프로젝트").to_string();
    let _one = SAVING.lock();
    let dir = with_reg(data, |r| {
        let root = r.root(docs, home);
        r.folder_for(&root, &id, &name)
    })?;
    let img = img_dir(data, &dir, &id);
    let (wrote, sum) = {
        let mut w = WRITTEN.lock();
        let w = w.get_or_insert_with(HashMap::new);
        let wrote = write_folder(&dir, &img, project, env!("CARGO_PKG_VERSION"), saved_at, w)?;
        let sum = w.get(&wrote.file).cloned();
        (wrote, sum)
    };
    if let Some(s) = sum {
        let _ = with_reg(data, |r| r.note_sum(&id, &s));
    }
    let fresh = OWNED.lock().get_or_insert_with(HashMap::new).insert(id.clone(), dir.clone()).as_ref() != Some(&dir);
    if fresh {
        sync_logs(data, &dir, &id);
    }
    let due = {
        let mut g = CC_COPIED.lock();
        let m = g.get_or_insert_with(HashMap::new);
        let due = fresh || m.get(&id).is_none_or(|t| t.elapsed() > Duration::from_secs(60));
        if due {
            m.insert(id.clone(), Instant::now());
        }
        due
    };
    if due {
        copy_transcripts(data, &transcripts_dir(data, &dir, &id), project);
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
        let project: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        let _one = STORE_WRITE.lock();
        let safe = super::safe_name(&format!("project-{id}"))?;
        let p = app.store_dir().join(format!("{safe}.json"));
        if let Err(e) = super::back_up(&app.data_dir, &safe, &p, super::now_ms()) {
            app.log("backup", &format!("{safe}: {e}"));
        }
        super::write_atomic(&p, json.as_bytes())?;
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

/// A file in a project's `백업` folder: the project file beside that folder, when it is the same
/// project.
fn backup_of(p: &Path) -> Option<PathBuf> {
    let b = p.parent()?;
    if b.file_name()? != BACKUPS {
        return None;
    }
    let dir = b.parent()?;
    let main = project_files(dir).into_iter().next()?;
    (file_id(&main).is_some() && file_id(&main) == file_id(p)).then_some(main)
}

/// Opens a `.reelcut` file. `conflict` is set when another folder already holds this project (a
/// copied folder): the app then opens it as a copy with a new id. A folder the user moved or
/// renamed becomes the project's folder; a lone file (on the Desktop, from a zip) is read but its
/// folder is never taken; a deleted project's folder opened from `_휴지통` comes back. A backup
/// opens its project, with `backup` naming the file to offer.
#[tauri::command]
pub async fn project_open(app: super::St<'_>, handle: tauri::AppHandle, path: String, time: String) -> Result<Value, String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let (docs, home) = places(&handle);
        let (v, notes) = open_file(&app.data_dir, docs.as_deref(), &home, Path::new(&path), &time, &std::env::temp_dir())?;
        for n in notes {
            app.log("project", &n);
        }
        Ok(v)
    })
    .await
}

/// `project_open` without the app: what it returns, and lines for the log.
pub fn open_file(data: &Path, docs: Option<&Path>, home: &Path, path: &Path, time: &str, temp: &Path) -> Result<(Value, Vec<String>), String> {
    let mut notes = Vec::new();
    let p = path.to_path_buf();
    let p = if p.is_dir() { project_files(&p).into_iter().next().ok_or("이 폴더에 .reelcut 파일이 없습니다")? } else { p };
    let (p, backup) = match backup_of(&p) {
        Some(main) => (main, Some(p)),
        None => (p, None),
    };
    let probe = file_id(&p).or_else(|| {
        let mut b = p.as_os_str().to_owned();
        b.push(".bak");
        file_id(Path::new(&b))
    });
    let id = probe.unwrap_or_default();
    let private = data.join("private").join(if ok_id(&id).is_ok() { id.as_str() } else { "_" }).join("img");
    let o = read_folder(&p, &private)?;
    let id = o.project["id"].as_str().map(String::from).unwrap_or_default();
    ok_id(&id)?;
    let name = o.project["name"].as_str().unwrap_or("프로젝트").to_string();
    let ours = is_project_folder(&o.folder) && !in_temp(&o.folder, temp);
    let _one = SAVING.lock();
    let (conflict, folder, gone) = with_reg(data, |r| -> Result<(bool, PathBuf, Option<PathBuf>), String> {
        let root = r.root(docs, home);
        let reg = r.folder(&id);
        let here = canon(&o.folder);
        // A lone file somewhere (the Desktop, a zip) is read, and its folder never taken.
        if !ours || reg.as_ref().is_some_and(|d| canon(d) == here) {
            return Ok((false, o.folder.clone(), None));
        }
        match reg {
            // A deleted project's folder opened from _휴지통 comes back to the projects folder.
            None if in_trash(&o.folder) => match untrash(&o.folder, &root, &folder_name(&name), &id, &r.file.folders) {
                Some(back) => {
                    r.adopt(&id, &back, &name)?;
                    Ok((false, back, None))
                }
                None => Ok((false, o.folder.clone(), None)),
            },
            // Moved or renamed while the app was closed, or first opened on this PC. When the
            // project is registered and what its last save wrote is known, its own folder (renamed
            // or moved beside it) is looked for first, and a copy older than that last write (a
            // snapshot made in Explorer) opens as a copy.
            None => {
                if let Some(sum) = r.file.folders.contains_key(&id).then(|| r.file.sums.get(&id).cloned()).flatten() {
                    if let Some(d) = r.locate(&root, &id, Some(&name)) {
                        return Ok(if canon(&d) == here { (false, d, None) } else { (true, o.folder.clone(), None) });
                    }
                    let at = r.file.sum_at.get(&id).copied().unwrap_or(0);
                    if at > 0 && !holds_sum(&o.folder, &id, &sum) && written_before(&p, at, &o.folder) {
                        return Ok((true, o.folder.clone(), None));
                    }
                }
                r.adopt(&id, &o.folder, &name)?;
                Ok((false, o.folder.clone(), None))
            }
            Some(_) if in_trash(&o.folder) => Ok((true, o.folder.clone(), None)),
            // The folder the user moved, opened after a save had made a new one: it takes over,
            // and the new one goes to the trash.
            Some(made) if r.file.recreated.get(&id).is_some_and(|&at| written_before(&p, at, &made)) => {
                r.adopt(&id, &o.folder, &name)?;
                let gone = (is_project_folder(&made) && only_ours(&made) && !root.starts_with(&made)).then(|| trash_folder(&made, &root, time).ok()).flatten();
                Ok((false, o.folder.clone(), gone))
            }
            Some(_) => Ok((true, o.folder.clone(), None)),
        }
    })?;
    if folder != o.folder || gone.is_some() {
        OWNED.lock().get_or_insert_with(HashMap::new).remove(&id);
        notes.push(format!("open {}: folder {}{}", p.display(), folder.display(), gone.map(|g| format!(", the one made meanwhile moved to {}", g.display())).unwrap_or_default()));
    }
    if !o.warnings.is_empty() {
        notes.push(format!("open {}: {}", p.display(), o.warnings.join(" / ")));
    }
    // A backup in a copied folder: the copy is made from what the backup holds (the folder's own
    // backups are not the project's, so it could not be picked afterwards).
    let backup_project = backup.as_ref().filter(|_| conflict).and_then(|b| read_doc(b).ok()).map(|d| d["project"].clone());
    let backup = backup.as_ref().and_then(|b| b.file_name()).map(|n| n.to_string_lossy().into_owned());
    let v = json!({ "project": o.project, "folder": folder.to_string_lossy(), "from": o.from, "warnings": o.warnings, "conflict": conflict, "backup": backup, "backupProject": backup_project });
    Ok((v, notes))
}

/// The project's folder and file, if it has one.
#[tauri::command]
pub async fn project_info(app: super::St<'_>, handle: tauri::AppHandle, id: String) -> Result<Option<Value>, String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let (docs, home) = places(&handle);
        let _one = SAVING.lock();
        let Some(dir) = located(&app.data_dir, docs.as_deref(), &home, &id).0 else { return Ok(None) };
        let file = project_files(&dir).into_iter().next();
        Ok(Some(json!({ "folder": dir.to_string_lossy(), "file": file.map(|f| f.to_string_lossy().into_owned()) })))
    })
    .await
}

/// 파일 > 프로젝트 묶어 내보내기: the project folder as one file, without `비공개` unless asked.
#[tauri::command]
pub async fn project_pack(app: super::St<'_>, handle: tauri::AppHandle, id: String, dest: String, private: bool) -> Result<Value, String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let (docs, home) = places(&handle);
        let _one = SAVING.lock();
        let Some(dir) = located(&app.data_dir, docs.as_deref(), &home, &id).0 else { return Err("프로젝트 폴더를 찾지 못했습니다".into()) };
        let files = crate::pack::pack_files(&dir, private);
        let bytes = crate::pack::write_zip(Path::new(&dest), &files)?;
        Ok(json!({ "files": files.len(), "bytes": bytes }))
    })
    .await
}

/// A `.reelcutpack` becomes a new folder beside the other projects. Returns its project file.
#[tauri::command]
pub async fn project_unpack(app: super::St<'_>, handle: tauri::AppHandle, path: String) -> Result<Value, String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let (docs, home) = places(&handle);
        let root = with_reg(&app.data_dir, |r| r.root(docs.as_deref(), &home));
        crate::pack::unpack(Path::new(&path), &root)
    })
    .await
}

/// A pack opened on the PC that already has its project: the project opened as a copy with a folder
/// of its own, so the folder just unpacked goes. Only a project folder right under the root.
#[tauri::command]
pub async fn project_unpack_drop(app: super::St<'_>, handle: tauri::AppHandle, folder: String) -> Result<(), String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let (docs, home) = places(&handle);
        let root = with_reg(&app.data_dir, |r| r.root(docs.as_deref(), &home));
        let dir = PathBuf::from(&folder);
        if dir.parent() != Some(root.as_path()) || !is_project_folder(&dir) {
            return Err(format!("{folder}: 풀어 놓은 폴더가 아닙니다"));
        }
        std::fs::remove_dir_all(&dir).map_err(|e| format!("{folder}: {e}"))
    })
    .await
}

/// 도움말 > 진단 파일 만들기: the logs only, no pictures or conversations.
#[tauri::command]
pub async fn diag_bundle(app: super::St<'_>, dest: String) -> Result<Value, String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let files = crate::pack::diag_files(&app.data_dir);
        let bytes = crate::pack::write_zip(Path::new(&dest), &files)?;
        Ok(json!({ "files": files.len(), "bytes": bytes }))
    })
    .await
}

/// Where new project folders go, the default, and why the default is not Documents.
#[tauri::command]
pub async fn project_root(app: super::St<'_>, handle: tauri::AppHandle) -> Result<Value, String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let (docs, home) = places(&handle);
        let (def, synced) = default_root(docs.as_deref(), &home);
        let root = with_reg(&app.data_dir, |r| r.root(docs.as_deref(), &home));
        Ok(json!({ "root": root.to_string_lossy(), "default": def.to_string_lossy(), "custom": root != def, "docsSyncedBy": synced, "rootSyncedBy": synced_by(&root) }))
    })
    .await
}

/// Changes where new project folders go ("" = the default). Folders already made stay put.
#[tauri::command]
pub async fn project_set_root(app: super::St<'_>, path: String) -> Result<(), String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let path = path.trim().to_string();
        if !path.is_empty() {
            std::fs::create_dir_all(&path).map_err(|e| format!("{path}: {e}"))?;
        }
        with_reg(&app.data_dir, |r| {
            r.file.root = path;
            r.store()
        })
    })
    .await
}

/// A dated copy of the project file in `백업\`, then the old ones are thinned out.
#[tauri::command]
pub async fn project_backup(app: super::St<'_>, handle: tauri::AppHandle, id: String, reason: String, time: String) -> Result<Option<String>, String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let (docs, home) = places(&handle);
        let _one = SAVING.lock();
        let (dir, root) = located(&app.data_dir, docs.as_deref(), &home, &id);
        let Some(dir) = dir else { return Ok(None) };
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
pub async fn project_backups(app: super::St<'_>, handle: tauri::AppHandle, id: String) -> Result<Vec<Backup>, String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let (docs, home) = places(&handle);
        let _one = SAVING.lock();
        Ok(located(&app.data_dir, docs.as_deref(), &home, &id).0.map(|d| list_backups(&d)).unwrap_or_default())
    })
    .await
}

/// The project as a backup holds it (its pictures and conversations are not part of a backup).
#[tauri::command]
pub async fn project_backup_read(app: super::St<'_>, handle: tauri::AppHandle, id: String, file: String) -> Result<Value, String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let (docs, home) = places(&handle);
        let dir = {
            let _one = SAVING.lock();
            located(&app.data_dir, docs.as_deref(), &home, &id).0.ok_or("프로젝트 폴더가 없습니다")?
        };
        let p = inside(&dir.join(BACKUPS), &file).ok_or("잘못된 파일")?;
        Ok(read_doc(&p)?["project"].clone())
    })
    .await
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
pub async fn project_trash(app: super::St<'_>, handle: tauri::AppHandle, id: String, time: String) -> Result<(), String> {
    let app = app.inner().clone();
    super::blocking(move || {
        let (docs, home) = places(&handle);
        if let Some((from, to)) = trash_project(&app.data_dir, docs.as_deref(), &home, &id, &time)? {
            app.log("delete", &format!("project folder {} → {}", from.display(), to.display()));
        }
        Ok(())
    })
    .await
}

/// Home's delete: the project's folder goes to `_휴지통` when Reelcut made it, it holds only
/// Reelcut's own files and it can be moved there; then the project lets go of it. A folder left
/// where it is (it holds the user's files, is on another drive, or that drive is unplugged now)
/// stays registered, so restoring the project from Home's 휴지통 finds that folder again.
pub fn trash_project(data: &Path, docs: Option<&Path>, home: &Path, id: &str, time: &str) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let _one = SAVING.lock();
    let r = with_reg(data, |r| {
        let root = r.root(docs, home);
        let dir = r.folder(id);
        let moved = match &dir {
            Some(d) if is_project_folder(d) && only_ours(d) && !root.starts_with(d) && !in_trash(d) => trash_folder(d, &root, time).ok().map(|to| (d.clone(), to)),
            _ => None,
        };
        let kept = moved.is_none() && (dir.is_some() || r.file.folders.get(id).is_some_and(|p| drive_gone(Path::new(p))));
        if !kept {
            r.unbind(id)?;
        }
        Ok(moved)
    });
    OWNED.lock().get_or_insert_with(HashMap::new).remove(id);
    r
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

/// Called by `jsonl_append` after the app-data copy is written: the same lines go into the folder
/// the project's last save wrote, while that folder is there. Never makes the folder itself.
pub fn mirror(_data: &Path, kind: &str, name: &str, lines: &[String]) {
    let id = name.split('.').next().unwrap_or(name);
    let Some(dir) = OWNED.lock().as_ref().and_then(|m| m.get(id).cloned()) else { return };
    if !dir.is_dir() {
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
        let base = std::env::temp_dir();
        let dir = base.join("Reelcut").join("여행");
        let media = base.join("DJI").join("CAM_0001.OSV");
        let r = relative(&dir, &media).unwrap();
        assert_eq!(r, "../../DJI/CAM_0001.OSV");
        assert_eq!(normalize(&dir.join(&r)), normalize(&media));
        assert_eq!(relative(&dir, Path::new("relative.osv")), None);
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
        assert_eq!(o.project.pointer("/assets/0/info/path").and_then(Value::as_str), Some(&*moved.join("DJI").join("CAM_0001.OSV").to_string_lossy()));
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
        copy_transcripts(&data, &transcripts_dir(&data, &dir, "l1"), &p);
        assert!(dir.join("대화/비공개/claude-code/abc-1.jsonl").is_file());
        // Deleting moves the folder to the trash with a readable note.
        let to = trash_folder(&dir, &root.join("Docs/Reelcut"), "2026-11-05 1200").unwrap();
        assert!(to.join("기록.reelcut").is_file() && !dir.exists());
        assert!(std::fs::read_to_string(root.join("Docs/Reelcut/_휴지통/삭제 기록.txt")).unwrap().contains("기록"));
    }

    #[test]
    fn a_renamed_folder_keeps_one_project_file() {
        let root = tmp("renamed");
        let media = root.join("CAM_0001.OSV");
        std::fs::write(&media, b"x").unwrap();
        let dir = root.join("옛이름");
        std::fs::create_dir_all(&dir).unwrap();
        let img = img_dir(&root.join("data"), &dir, "p1");
        let p = sample("p1", "옛이름", &media);
        let mut w = Written::new();
        write_folder(&dir, &img, &p, "2.18.1", "t", &mut w).unwrap();
        write_folder(&dir, &img, &p, "2.18.1", "t2", &mut w).unwrap();
        let to = root.join("새이름");
        std::fs::rename(&dir, &to).unwrap();
        let mut w = Written::new();
        let out = write_folder(&to, &img, &p, "2.18.1", "t3", &mut w).unwrap();
        assert_eq!(out.file, to.join("새이름.reelcut"));
        assert_eq!(project_files(&to), vec![to.join("새이름.reelcut")]);
        assert!(to.join("새이름.reelcut.bak").is_file() && !to.join("옛이름.reelcut.bak").exists());
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
        assert_eq!(found.get("a").map(String::as_str), Some(&*root.join("새 폴더").join("2026-10").join("CAM_0001.OSV").to_string_lossy()));
        assert!(found.get("b").is_some_and(|p| p.ends_with("cam_0002.osv")));
        assert!(!found.contains_key("c") && !found.contains_key("d"));
    }

    #[test]
    fn pictures_go_to_the_app_data_when_the_folder_is_synced() {
        let data = Path::new("/d");
        assert_eq!(img_dir(data, Path::new("/u/OneDrive/Reelcut/a"), "p"), PathBuf::from("/d/private/p/img"));
        assert_eq!(img_dir(data, Path::new("/u/Reelcut/a"), "p"), PathBuf::from("/u/Reelcut/a/대화/비공개/img"));
    }

    fn reg_folder(data: &Path, id: &str) -> Option<PathBuf> {
        with_reg(data, |r| r.folder(id))
    }

    /// The file was last written a minute ago (time passes between saves on a real PC; here they
    /// can fall in the same millisecond).
    fn age(p: &Path) {
        let f = std::fs::File::options().write(true).open(p).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(60)).unwrap();
    }

    /// An Explorer copy of a folder: the files keep the time they were last written.
    fn copy_tree(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for e in std::fs::read_dir(from).unwrap().flatten() {
            let (a, b) = (e.path(), to.join(e.file_name()));
            if a.is_dir() {
                copy_tree(&a, &b);
            } else {
                std::fs::copy(&a, &b).unwrap();
                let t = std::fs::metadata(&a).unwrap().modified().unwrap();
                std::fs::File::options().write(true).open(&b).unwrap().set_modified(t).unwrap();
            }
        }
    }

    fn open_at(data: &Path, docs: &Path, root: &Path, file: &Path, time: &str) -> Value {
        open_file(data, Some(docs), root, file, time, &root.join("tmp")).unwrap().0
    }

    #[test]
    fn a_folder_on_an_unplugged_drive_is_waited_for_not_replaced() {
        let root = tmp("drive");
        let (data, docs) = (root.join("data"), root.join("Docs"));
        let p = sample("drA", "여행", Path::new("/x"));
        save_folder(&data, Some(&docs), &root, &p, "t").unwrap();
        // The project's folder is on an external drive that is not plugged in at this start (a
        // drive letter that is not there; on Linux a relative "Zq:" stands in for it).
        let gone = "Zq:/영상/여행";
        assert!(drive_gone(Path::new(gone)) && !drive_gone(&root));
        with_reg(&data, |r| {
            r.file.folders.insert("drA".into(), gone.into());
            r.store()
        })
        .unwrap();
        // The save says so, and no other folder takes the drive's place…
        let e = save_folder(&data, Some(&docs), &root, &p, "t2").unwrap_err();
        assert!(e.contains("드라이브") && e.contains(gone), "{e}");
        assert!(with_reg(&data, |r| r.locate(&docs.join("Reelcut"), "drA", None)).is_none());
        // …so the registration still points at the drive for when it is back.
        let (folder, made) = with_reg(&data, |r| (r.file.folders.get("drA").cloned(), r.file.recreated.contains_key("drA")));
        assert_eq!((folder.as_deref(), made), (Some(gone), false));
    }

    #[test]
    fn a_folder_the_takeover_put_in_the_trash_never_comes_back() {
        let root = tmp("revive");
        let (data, docs) = (root.join("data"), root.join("Docs"));
        let p = sample("rvA", "여행", Path::new("/x"));
        let dir = save_folder(&data, Some(&docs), &root, &p, "t").unwrap().file.parent().unwrap().to_path_buf();
        // Moved next to the footage on E:, a save made the folder again, and opening the moved one
        // took over: the folder made meanwhile went to _휴지통.
        let away = root.join("E").join("영상").join("여행");
        std::fs::create_dir_all(away.parent().unwrap()).unwrap();
        std::fs::rename(&dir, &away).unwrap();
        age(&away.join("여행.reelcut"));
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t").unwrap().file.parent(), Some(dir.as_path()));
        assert_eq!(open_at(&data, &docs, &root, &away.join("여행.reelcut"), "2026-11-05 1200")["conflict"], json!(false));
        let trashed = docs.join("Reelcut/_휴지통/여행 (2026-11-05 1200)");
        assert!(trashed.is_dir() && !dir.exists());
        save_folder(&data, Some(&docs), &root, &p, "t2").unwrap();
        age(&away.join("여행.reelcut"));
        // A start while E: is away: the folder in _휴지통 stays there…
        let parked = root.join("parked");
        std::fs::rename(root.join("E"), &parked).unwrap();
        save_folder(&data, Some(&docs), &root, &p, "t3").unwrap();
        assert!(trashed.is_dir());
        // …and with E: back, opening the user's folder still takes over (no '(사본)').
        std::fs::rename(&parked, root.join("E")).unwrap();
        assert_eq!(open_at(&data, &docs, &root, &away.join("여행.reelcut"), "2026-11-05 1300")["conflict"], json!(false));
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t4").unwrap().file, away.join("여행.reelcut"));
    }

    #[test]
    fn a_footage_folder_named_like_the_project_is_never_taken() {
        let root = tmp("footage");
        let (data, docs) = (root.join("data"), root.join("Docs"));
        let p = sample("ftA", "여행", Path::new("/x"));
        let w = save_folder(&data, Some(&docs), &root, &p, "t").unwrap();
        // The user keeps a copy of the project file beside the clips, in a folder named like it,
        // and opens it there after deleting the project from Home (or on a new PC).
        let clips = root.join("Videos").join("여행");
        std::fs::create_dir_all(&clips).unwrap();
        std::fs::write(clips.join("CAM_0001.OSV"), b"v").unwrap();
        std::fs::copy(&w.file, clips.join("여행.reelcut")).unwrap();
        with_reg(&data, |r| r.unbind("ftA")).unwrap();
        assert!(!is_project_folder(&clips));
        assert_eq!(open_at(&data, &docs, &root, &clips.join("여행.reelcut"), "t")["conflict"], json!(false));
        assert_eq!(with_reg(&data, |r| r.file.folders.get("ftA").cloned()), None);
        // Saves go into the project's own folder; nothing is written beside the clips.
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t2").unwrap().file, w.file);
        let mut names: Vec<String> = std::fs::read_dir(&clips).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["CAM_0001.OSV", "여행.reelcut"]);
        // A Desktop that happens to have a 대화 folder is not Reelcut's either.
        let desk = root.join("Desktop");
        std::fs::create_dir_all(desk.join(CHATS)).unwrap();
        assert!(!is_project_folder(&desk));
        // A folder Reelcut made, where the user also put clips, is never renamed (or moved to the
        // trash, which checks the same).
        let dir = w.file.parent().unwrap().to_path_buf();
        assert!(only_ours(&dir));
        std::fs::write(dir.join("CAM_0002.OSV"), b"v").unwrap();
        assert!(!only_ours(&dir));
        let mut q = p.clone();
        q["name"] = json!("제주");
        assert_eq!(save_folder(&data, Some(&docs), &root, &q, "t3").unwrap().file.parent(), Some(dir.as_path()));
        assert!(dir.join("CAM_0002.OSV").is_file());
    }

    #[test]
    fn a_copy_of_a_folder_made_again_still_opens_as_a_copy() {
        let root = tmp("recopy");
        let (data, docs) = (root.join("data"), root.join("Docs"));
        let p = sample("rcA", "여행", Path::new("/x"));
        let dir = save_folder(&data, Some(&docs), &root, &p, "t").unwrap().file.parent().unwrap().to_path_buf();
        // Moved away while the app was closed: a save makes the folder again, and work goes on in it.
        let away = root.join("E").join("여행");
        std::fs::create_dir_all(away.parent().unwrap()).unwrap();
        std::fs::rename(&dir, &away).unwrap();
        age(&away.join("여행.reelcut"));
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t2").unwrap().file.parent(), Some(dir.as_path()));
        assert!(with_reg(&data, |r| r.file.recreated.get("rcA").is_some_and(|&t| t > 0)));
        save_folder(&data, Some(&docs), &root, &p, "t3").unwrap();
        // Weeks later the user copies that folder onto a USB stick to try something: the copy opens
        // as a copy, and the project's folder stays where it is.
        let usb = root.join("USB").join("여행");
        copy_tree(&dir, &usb);
        assert_eq!(open_at(&data, &docs, &root, &usb.join("여행.reelcut"), "2026-12-01 0900")["conflict"], json!(true));
        assert!(dir.is_dir() && reg_folder(&data, "rcA") == Some(dir.clone()));
        // The folder the user moved away still takes over.
        assert_eq!(open_at(&data, &docs, &root, &away.join("여행.reelcut"), "2026-12-01 1000")["conflict"], json!(false));
        assert!(!dir.exists());
        // A registry from 2.18.1 (a list of ids, no time) still loads, nothing else lost.
        let r: RegFile = serde_json::from_str(r#"{"root":"D:/R","folders":{"x1":"D:/R/a"},"recreated":["x1"]}"#).unwrap();
        assert_eq!((r.recreated.get("x1"), r.folders.len(), r.root.as_str()), (Some(&0), 1, "D:/R"));
    }

    #[test]
    fn a_project_deleted_from_home_comes_back_to_the_folder_it_left_in_place() {
        let root = tmp("keepdel");
        let (data, docs) = (root.join("data"), root.join("Docs"));
        let p = sample("kdA", "여행", Path::new("/x"));
        let dir = save_folder(&data, Some(&docs), &root, &p, "t").unwrap().file.parent().unwrap().to_path_buf();
        // Kept next to the footage: moved there, a save made the folder again, and opening the
        // moved one took over (the folder made meanwhile went to _휴지통).
        let away = root.join("Videos").join("여행");
        std::fs::create_dir_all(away.parent().unwrap()).unwrap();
        std::fs::rename(&dir, &away).unwrap();
        age(&away.join("여행.reelcut"));
        save_folder(&data, Some(&docs), &root, &p, "t2").unwrap();
        assert_eq!(open_at(&data, &docs, &root, &away.join("여행.reelcut"), "2026-11-05 1200")["conflict"], json!(false));
        assert!(docs.join("Reelcut/_휴지통/여행 (2026-11-05 1200)").is_dir());
        // The user puts an export in it, then deletes the project on Home: the folder stays
        // where it is (it holds their file) and stays the project's.
        std::fs::write(away.join("여행 완성.mp4"), b"v").unwrap();
        assert_eq!(trash_project(&data, Some(&docs), &root, "kdA", "2026-11-05 1300").unwrap(), None);
        assert!(away.join("여행 완성.mp4").is_file() && away.join("여행.reelcut").is_file());
        // Brought back from Home's 휴지통: saves go to that folder, nothing is revived from
        // _휴지통, and opening it is not a copy.
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t3").unwrap().file, away.join("여행.reelcut"));
        assert!(!dir.exists() && docs.join("Reelcut/_휴지통/여행 (2026-11-05 1200)").is_dir());
        assert_eq!(open_at(&data, &docs, &root, &away.join("여행.reelcut"), "t")["conflict"], json!(false));
        // A folder holding only Reelcut's files goes to _휴지통 and comes back on restore.
        std::fs::remove_file(away.join("여행 완성.mp4")).unwrap();
        let (from, to) = trash_project(&data, Some(&docs), &root, "kdA", "2026-11-05 1400").unwrap().unwrap();
        assert_eq!(from, away);
        assert!(to.is_dir() && with_reg(&data, |r| r.file.folders.get("kdA").is_none()));
        let back = save_folder(&data, Some(&docs), &root, &p, "t4").unwrap().file;
        assert_eq!(back, dir.join("여행.reelcut"));
        assert!(!to.exists() && docs.join("Reelcut/_휴지통/여행 (2026-11-05 1200)").is_dir());
    }

    #[test]
    fn a_folder_taken_over_is_followed_when_renamed_later() {
        let root = tmp("tkren");
        let (data, docs) = (root.join("data"), root.join("Docs"));
        let p = sample("trA", "여행", Path::new("/x"));
        let dir = save_folder(&data, Some(&docs), &root, &p, "t").unwrap().file.parent().unwrap().to_path_buf();
        let away = root.join("D").join("영상").join("여행");
        std::fs::create_dir_all(away.parent().unwrap()).unwrap();
        std::fs::rename(&dir, &away).unwrap();
        age(&away.join("여행.reelcut"));
        save_folder(&data, Some(&docs), &root, &p, "t2").unwrap();
        // Taken over by a double-click, with no save after it; then renamed in Explorer.
        assert_eq!(open_at(&data, &docs, &root, &away.join("여행.reelcut"), "2026-11-05 1200")["conflict"], json!(false));
        let renamed = away.with_file_name("여행 최종");
        std::fs::rename(&away, &renamed).unwrap();
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t3").unwrap().file, renamed.join("여행 최종.reelcut"));
        assert!(!dir.exists());
    }

    #[test]
    fn a_snapshot_opened_before_the_next_save_opens_as_a_copy() {
        let root = tmp("snapopen");
        let (data, docs) = (root.join("data"), root.join("Docs"));
        let mut p = sample("soA", "여행", Path::new("/x"));
        let dir = save_folder(&data, Some(&docs), &root, &p, "t1").unwrap().file.parent().unwrap().to_path_buf();
        let snap = dir.with_file_name("여행 - 복사본");
        copy_tree(&dir, &snap);
        age(&snap.join("여행.reelcut"));
        let kept = std::fs::read(snap.join("여행.reelcut")).unwrap();
        p["drafts"][0]["name"] = json!("둘째 편집본");
        save_folder(&data, Some(&docs), &root, &p, "t2").unwrap();
        // The original is renamed, and the snapshot is double-clicked before any save.
        let renamed = dir.with_file_name("여행 최종");
        std::fs::rename(&dir, &renamed).unwrap();
        assert_eq!(open_at(&data, &docs, &root, &snap.join("여행.reelcut"), "t")["conflict"], json!(true));
        assert_eq!(reg_folder(&data, "soA"), Some(renamed.clone()));
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t3").unwrap().file, renamed.join("여행 최종.reelcut"));
        assert_eq!(std::fs::read(snap.join("여행.reelcut")).unwrap(), kept);
        // Moved out of sight instead: the snapshot, older than the last save, is still a copy.
        let moved = root.join("Archive").join("여행 최종");
        std::fs::create_dir_all(moved.parent().unwrap()).unwrap();
        std::fs::rename(&renamed, &moved).unwrap();
        assert_eq!(open_at(&data, &docs, &root, &snap.join("여행.reelcut"), "t")["conflict"], json!(true));
        assert_eq!(std::fs::read(snap.join("여행.reelcut")).unwrap(), kept);
        // The moved folder itself, unchanged since the last save, is the project's folder.
        assert_eq!(open_at(&data, &docs, &root, &moved.join("여행 최종.reelcut"), "t")["conflict"], json!(false));
        assert_eq!(reg_folder(&data, "soA"), Some(moved));
    }

    #[test]
    fn a_renamed_folder_without_its_readme_is_still_followed() {
        let root = tmp("noreadme");
        let (data, docs) = (root.join("data"), root.join("Docs"));
        let p = sample("nrA", "여행", Path::new("/x"));
        let dir = save_folder(&data, Some(&docs), &root, &p, "t").unwrap().file.parent().unwrap().to_path_buf();
        std::fs::remove_file(dir.join("README.txt")).unwrap();
        let renamed = dir.with_file_name("여행 최종");
        std::fs::rename(&dir, &renamed).unwrap();
        // Its project file still has the old name; its conversations show it is the project's.
        assert!(is_project_folder(&renamed));
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t2").unwrap().file, renamed.join("여행 최종.reelcut"));
        assert!(!dir.exists());
        // A README saved with a byte-order mark still counts.
        std::fs::write(renamed.join("README.txt"), format!("\u{feff}{README}")).unwrap();
        std::fs::remove_dir_all(renamed.join(CHATS)).unwrap();
        assert!(is_project_folder(&renamed));
    }

    #[test]
    fn a_snapshot_copy_is_never_taken_for_the_project_folder() {
        let root = tmp("snap");
        let (data, docs) = (root.join("data"), root.join("Docs"));
        let mut p = sample("snA", "여행", Path::new("/x"));
        let dir = save_folder(&data, Some(&docs), &root, &p, "t1").unwrap().file.parent().unwrap().to_path_buf();
        // Before a big edit the user copies the folder in Explorer as a snapshot, then works on.
        let snap = dir.with_file_name("여행 - 복사본");
        copy_tree(&dir, &snap);
        let kept = std::fs::read(snap.join("여행.reelcut")).unwrap();
        p["drafts"][0]["name"] = json!("둘째 편집본");
        save_folder(&data, Some(&docs), &root, &p, "t2").unwrap();
        // The original is renamed: the next save follows it, not the snapshot listed first.
        let renamed = dir.with_file_name("여행 최종");
        std::fs::rename(&dir, &renamed).unwrap();
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t2").unwrap().file, renamed.join("여행 최종.reelcut"));
        // Then moved into a sub-folder, where it is not looked for: the snapshot is not taken
        // either; a new folder is made, and the snapshot is left exactly as it was.
        let moved = docs.join("Reelcut").join("2025").join("여행 최종");
        std::fs::create_dir_all(moved.parent().unwrap()).unwrap();
        std::fs::rename(&renamed, &moved).unwrap();
        age(&moved.join("여행 최종.reelcut"));
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t3").unwrap().file.parent(), Some(dir.as_path()));
        assert_eq!(std::fs::read(snap.join("여행.reelcut")).unwrap(), kept);
        assert!(!snap.join("여행 - 복사본.reelcut").exists());
        // Opening the moved original takes over; the snapshot opens as a copy.
        assert_eq!(open_at(&data, &docs, &root, &moved.join("여행 최종.reelcut"), "2026-11-06 0900")["conflict"], json!(false));
        assert_eq!(open_at(&data, &docs, &root, &snap.join("여행.reelcut"), "t")["conflict"], json!(true));
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t4").unwrap().file, moved.join("여행 최종.reelcut"));
    }

    #[test]
    fn a_lone_file_never_takes_the_folder_it_was_dropped_in() {
        let root = tmp("lone");
        let (data, docs, temp) = (root.join("data"), root.join("Docs"), root.join("tmp"));
        let p = sample("lone1", "여행", Path::new("/x"));
        let w = save_folder(&data, Some(&docs), &root, &p, "t").unwrap();
        let dir = w.file.parent().unwrap().to_path_buf();
        // The user drags 여행.reelcut onto the Desktop, next to their own files, and opens it there.
        let desk = root.join("Desktop");
        std::fs::create_dir_all(&desk).unwrap();
        std::fs::write(desk.join("가족사진.jpg"), b"j").unwrap();
        std::fs::rename(&w.file, desk.join("여행.reelcut")).unwrap();
        let (v, _) = open_file(&data, Some(&docs), &root, &desk.join("여행.reelcut"), "2026-11-05 1200", &temp).unwrap();
        assert_eq!((v["conflict"].as_bool(), v["project"]["name"].as_str()), (Some(false), Some("여행")));
        assert_eq!(reg_folder(&data, "lone1"), Some(dir.clone()));
        // Saves go on into the project's own folder; the Desktop is left as it was.
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t2").unwrap().file, w.file);
        let mut names: Vec<String> = std::fs::read_dir(&desk).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["가족사진.jpg", "여행.reelcut"]);
        // A whole project folder opened from the temporary folder (inside a zip): read, not taken.
        let z = temp.join("zip").join("여행");
        std::fs::create_dir_all(&z).unwrap();
        std::fs::copy(&w.file, z.join("여행.reelcut")).unwrap();
        std::fs::create_dir_all(z.join(CHATS)).unwrap();
        let (v, _) = open_file(&data, Some(&docs), &root, &z.join("여행.reelcut"), "t", &temp).unwrap();
        assert_eq!(v["conflict"].as_bool(), Some(false));
        assert_eq!(reg_folder(&data, "lone1"), Some(dir));
    }

    #[test]
    fn a_folder_taken_by_another_project_is_never_written_for_the_first() {
        let root = tmp("stale");
        let (data, docs) = (root.join("data"), root.join("Docs"));
        let a = sample("stA", "새 프로젝트", Path::new("/x"));
        let da = save_folder(&data, Some(&docs), &root, &a, "t").unwrap().file.parent().unwrap().to_path_buf();
        // The user renames A's folder in Explorer, then makes B with the same default name.
        let renamed = da.with_file_name("제주도");
        std::fs::rename(&da, &renamed).unwrap();
        let b = sample("stB", "새 프로젝트", Path::new("/x"));
        let db = save_folder(&data, Some(&docs), &root, &b, "t").unwrap().file.parent().unwrap().to_path_buf();
        assert_eq!(db.file_name().unwrap(), "새 프로젝트 (2)");
        // A's next save finds its folder by its id and keeps the user's name for it.
        let wa = save_folder(&data, Some(&docs), &root, &a, "t").unwrap();
        assert_eq!(wa.file, renamed.join("제주도.reelcut"));
        // Even a registration that points at B's folder is not used for A.
        with_reg(&data, |r| {
            r.file.folders.insert("stA".into(), db.to_string_lossy().into_owned());
            r.store()
        })
        .unwrap();
        assert_eq!(reg_folder(&data, "stA"), None);
        assert_eq!(save_folder(&data, Some(&docs), &root, &a, "t").unwrap().file, renamed.join("제주도.reelcut"));
        assert_eq!((folder_id(&db).as_deref(), folder_id(&renamed).as_deref()), (Some("stB"), Some("stA")));
    }

    #[test]
    fn a_renamed_or_moved_folder_is_followed_not_made_again() {
        let root = tmp("moved");
        let (data, docs, temp) = (root.join("data"), root.join("Docs"), root.join("tmp"));
        let mut p = sample("mvA", "여행", Path::new("/x"));
        let dir = save_folder(&data, Some(&docs), &root, &p, "t").unwrap().file.parent().unwrap().to_path_buf();
        // Renamed in Explorer while the app is open: a log line does not make a new 여행 folder…
        let renamed = dir.with_file_name("여행 최종");
        std::fs::rename(&dir, &renamed).unwrap();
        mirror(&data, "actions", "mvA", &["{\"seq\":2}".into()]);
        assert!(!dir.exists());
        // …and the next save finds it and leaves the user's name.
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t").unwrap().file, renamed.join("여행 최종.reelcut"));
        assert!(!dir.exists());
        // Renaming the project in the app still renames its folder.
        p["name"] = json!("제주");
        let named = save_folder(&data, Some(&docs), &root, &p, "t").unwrap().file.parent().unwrap().to_path_buf();
        assert_eq!(named.file_name().unwrap(), "제주");
        // Moved next to the footage elsewhere: a save makes a new folder; opening the moved one makes
        // it the project's folder again, and the one made meanwhile goes to the trash.
        let away = root.join("D").join("영상").join("제주");
        std::fs::create_dir_all(away.parent().unwrap()).unwrap();
        std::fs::rename(&named, &away).unwrap();
        age(&away.join("제주.reelcut"));
        let made = save_folder(&data, Some(&docs), &root, &p, "t").unwrap().file.parent().unwrap().to_path_buf();
        assert_eq!(made, named);
        let (v, _) = open_file(&data, Some(&docs), &root, &away.join("제주.reelcut"), "2026-11-05 1300", &temp).unwrap();
        assert_eq!(v["conflict"].as_bool(), Some(false));
        assert!(!made.exists() && docs.join("Reelcut/_휴지통/제주 (2026-11-05 1300)").is_dir());
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t").unwrap().file, away.join("제주.reelcut"));
        // A real copy of the folder still opens as a copy.
        let copy = root.join("USB").join("제주");
        std::fs::create_dir_all(copy.join(CHATS)).unwrap();
        std::fs::copy(away.join("제주.reelcut"), copy.join("제주.reelcut")).unwrap();
        let (v, _) = open_file(&data, Some(&docs), &root, &copy.join("제주.reelcut"), "t", &temp).unwrap();
        assert_eq!(v["conflict"].as_bool(), Some(true));
    }

    #[test]
    fn a_deleted_projects_folder_comes_back_with_its_backups() {
        let root = tmp("trash");
        let (data, docs, temp) = (root.join("data"), root.join("Docs"), root.join("tmp"));
        let r = docs.join("Reelcut");
        let p = sample("dlA", "가족", Path::new("/x"));
        let w = save_folder(&data, Some(&docs), &root, &p, "t").unwrap();
        let dir = w.file.parent().unwrap().to_path_buf();
        backup(&dir, &w.file, "수동", "2026-11-05 1000").unwrap().unwrap();
        // Deleted from Home: the folder goes to _휴지통 and the project lets go of it.
        let to = trash_folder(&dir, &r, "2026-11-05 1100").unwrap();
        with_reg(&data, |g| g.unbind("dlA")).unwrap();
        // Brought back from Home's 휴지통: the next save brings the folder, and its backups, back.
        assert_eq!(save_folder(&data, Some(&docs), &root, &p, "t").unwrap().file, w.file);
        assert!(!to.exists());
        assert_eq!(list_backups(&dir).len(), 1);
        // Deleted again, then opened from _휴지통 by a double click: back as well.
        let to = trash_folder(&dir, &r, "2026-11-05 1200").unwrap();
        with_reg(&data, |g| g.unbind("dlA")).unwrap();
        let (v, _) = open_file(&data, Some(&docs), &root, &to.join("가족.reelcut"), "t", &temp).unwrap();
        assert_eq!((v["conflict"].as_bool(), v["folder"].as_str()), (Some(false), Some(&*dir.to_string_lossy())));
        assert!(w.file.is_file() && !to.exists());
        assert!(std::fs::read_to_string(r.join("_휴지통/삭제 기록.txt")).unwrap().contains("되살림"));
    }

    #[test]
    fn a_backup_opened_from_explorer_opens_its_project() {
        let root = tmp("bkopen");
        let (data, docs, temp) = (root.join("data"), root.join("Docs"), root.join("tmp"));
        let w = save_folder(&data, Some(&docs), &root, &sample("bkA", "여행", Path::new("/x")), "t").unwrap();
        let dir = w.file.parent().unwrap().to_path_buf();
        let b = backup(&dir, &w.file, "수동", "2026-11-05 1000").unwrap().unwrap();
        let (v, _) = open_file(&data, Some(&docs), &root, &dir.join(BACKUPS).join(&b), "t", &temp).unwrap();
        assert_eq!((v["backup"].as_str(), v["conflict"].as_bool()), (Some(b.as_str()), Some(false)));
        // Its conversations come from the project folder, not from 백업.
        assert_eq!(v["project"]["chats"][0]["messages"].as_array().map(Vec::len), Some(3));
        assert!(v["warnings"].as_array().is_some_and(Vec::is_empty));
        assert!(v["backupProject"].is_null());
        // The same backup in a copy of the folder (a USB stick): it opens as a copy, made from what
        // the backup holds.
        let usb = root.join("USB").join("여행");
        copy_tree(&dir, &usb);
        let (v, _) = open_file(&data, Some(&docs), &root, &usb.join(BACKUPS).join(&b), "t", &temp).unwrap();
        assert_eq!((v["backup"].as_str(), v["conflict"].as_bool()), (Some(b.as_str()), Some(true)));
        assert_eq!(v["backupProject"]["drafts"][0]["name"].as_str(), Some("첫 편집본"));
    }

    #[test]
    fn no_picture_reaches_a_synced_folder_or_the_project_file() {
        let d = Path::new("/d");
        assert_eq!(transcripts_dir(d, Path::new("/u/OneDrive/Reelcut/a"), "p"), PathBuf::from("/d/private/p/claude-code"));
        assert_eq!(transcripts_dir(d, Path::new("/u/Reelcut/a"), "p"), PathBuf::from("/u/Reelcut/a/대화/비공개/claude-code"));
        // A project last saved before 2.3 keeps its one conversation in `chat`, pictures and all.
        let root = tmp("legacy");
        let mut p = sample("lgA", "옛 프로젝트", Path::new("/x"));
        p["chat"] = json!([{ "role": "user", "content": [{ "type": "tool_result", "content": [{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": PNG } }] }] }]);
        let dir = root.join("R").join("옛 프로젝트");
        std::fs::create_dir_all(&dir).unwrap();
        let w = write_folder(&dir, &img_dir(&root, &dir, "lgA"), &p, "v", "t", &mut Written::new()).unwrap();
        assert!(!std::fs::read_to_string(&w.file).unwrap().contains(PNG));
        assert_eq!(read_folder(&w.file, &root).unwrap().project, p);
        // Transcripts the chats used before a compaction are copied too.
        let data = root.join("data");
        std::fs::create_dir_all(data.join("claude-archive/C--x")).unwrap();
        std::fs::write(data.join("claude-archive/C--x/old-1.jsonl"), "o").unwrap();
        let mut q = p.clone();
        q["chats"][0]["ccPast"] = json!(["old-1"]);
        let to = transcripts_dir(&data, &dir, "lgA");
        copy_transcripts(&data, &to, &q);
        assert!(to.join("old-1.jsonl").is_file());
    }

    #[test]
    fn a_backup_is_dated_when_it_is_made() {
        let root = tmp("btime");
        let f = root.join("p.reelcut");
        std::fs::write(&f, "{}").unwrap();
        std::fs::File::options().write(true).open(&f).unwrap().set_modified(SystemTime::now() - Duration::from_secs(40 * 86_400)).unwrap();
        backup(&root, &f, "열기", "2026-11-05 1000").unwrap().unwrap();
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis() as u64;
        assert!(now - list_backups(&root)[0].time < 60_000);
    }

    #[test]
    fn writes_at_the_same_moment_never_mix() {
        let root = tmp("race");
        let f = root.join("project-x.json");
        let hs: Vec<_> = (0..4u8)
            .map(|i| {
                let f = f.clone();
                std::thread::spawn(move || (0..8).map(|_| write_atomic(&f, &vec![b'a' + i; 1 << 20])).collect::<Vec<_>>())
            })
            .collect();
        for h in hs {
            assert!(h.join().unwrap().iter().all(Result::is_ok));
        }
        let b = std::fs::read(&f).unwrap();
        assert!(b.len() == 1 << 20 && b.iter().all(|x| *x == b[0]));
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1, "no temporary file is left");
    }
}
