mod analysis;
mod args;
mod diag;
mod logs;
mod cc;
mod faces;
mod ff;
mod framing;
mod hw;
mod jsonl;
mod live;
mod media;
mod probe;
mod proj;
mod project;
mod pack;
mod recover;
mod qwen;
mod render;
mod shots;
mod stitch;
mod pano;
mod motion;
mod transcribe;
#[cfg(test)]
mod store_tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("reelcut-store-{name}-{}", now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn writes_whole_files_and_backs_up_at_intervals() {
        let d = temp("backup");
        let p = d.join("project-a.json");
        write_atomic(&p, b"one").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"one");
        assert!(!d.join("project-a.json.tmp").exists());
        let start = 1_800_000_000_000u128;
        back_up(&d, "project-a", &p, start).unwrap();
        // Too soon for another version.
        back_up(&d, "project-a", &p, start + 1000).unwrap();
        let versions = |d: &Path| std::fs::read_dir(d.join("backups/project-a")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("v-")).count();
        assert_eq!(versions(&d), 1);
        for i in 1..70u128 {
            back_up(&d, "project-a", &p, start + i * BACKUP_EVERY_MS).unwrap();
        }
        assert_eq!(versions(&d), BACKUP_VERSIONS);
        assert!(d.join(format!("backups/project-a/daily-{}.json", &stamp(start)[..10])).is_file());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn deleted_projects_come_back() {
        let d = temp("trash");
        let p = d.join("project-c.json");
        std::fs::write(&p, "{}").unwrap();
        let to = move_to_trash(&d, "project-c", &p, 1234).unwrap();
        assert!(!p.exists() && to.is_file());
        assert_eq!(restore_from_trash(&d, "project-c--1234.json").unwrap(), "project-c");
        assert!(p.is_file());
        // Never over a project that is there, and only files from the trash.
        std::fs::write(d.join("_trash/project-c--5.json"), "{}").unwrap();
        assert!(restore_from_trash(&d, "project-c--5.json").is_err());
        assert!(restore_from_trash(&d, "../project-c--5.json").is_err());
        let log = d.join("logs/deletions.jsonl");
        append_line(&log, "{\"a\":1}");
        append_line(&log, "{\"a\":2}");
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn no_backup_before_the_first_save() {
        let d = temp("first");
        back_up(&d, "project-b", &d.join("project-b.json"), 5).unwrap();
        assert!(!d.join("backups").exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod itest;

use ff::{Bins, Jobs, CANCELLED};
use hw::Hw;
use media::{FrameReq, Lens, MediaInfo};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

struct App {
    bins: Bins,
    data_dir: PathBuf,
    cache_dir: PathBuf,
    hw: Mutex<Option<Hw>>,
    jobs: Jobs,
    cc: Arc<cc::Bridge>,
    live: Arc<live::Live>,
    faces: faces::Detector,
}

type St<'a> = State<'a, Arc<App>>;

impl App {
    fn hw(&self) -> Hw {
        if let Some(h) = self.hw.lock().clone() {
            return h;
        }
        let h = hw::detect(&self.bins.ffmpeg, &self.data_dir.join("hw.json"), false);
        *self.hw.lock() = Some(h.clone());
        h
    }
    fn dir(&self, name: &str) -> PathBuf {
        let d = self.cache_dir.join(name);
        let _ = std::fs::create_dir_all(&d);
        d
    }
    fn log(&self, kind: &str, text: &str) {
        logs::log(kind, text);
    }
    fn store_dir(&self) -> PathBuf {
        let d = self.data_dir.join("store");
        let _ = std::fs::create_dir_all(&d);
        d
    }
    fn models_dir(&self) -> PathBuf {
        self.data_dir.join("models")
    }
    fn ffmpeg_major(&self) -> u32 {
        let v = self.hw().ffmpeg_version;
        v.trim_start_matches(|c: char| !c.is_ascii_digit()).split(|c: char| !c.is_ascii_digit()).next().and_then(|x| x.parse().ok()).unwrap_or(6)
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn hash<T: Hash>(t: &T) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    t.hash(&mut h);
    h.finish()
}

/// Identity of a file version: path + size + modified time.
fn file_key(path: &str) -> String {
    // The same file however its path is spelled.
    let spelled = if cfg!(windows) { path.replace('/', "\\") } else { path.to_string() };
    let path = spelled.as_str();
    let m = std::fs::metadata(path).ok();
    let size = m.as_ref().map(|m| m.len()).unwrap_or(0);
    let mt = m.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    format!("{:016x}", hash(&(path, size, mt)))
}

#[derive(Serialize, Clone)]
struct JobEvent {
    id: String,
    kind: String,
    pct: f64,
    /// running | done | error | cancelled
    state: String,
    message: String,
    result: Value,
}

fn emit(h: &tauri::AppHandle, id: &str, kind: &str, pct: f64, state: &str, message: &str, result: Value) {
    let _ = h.emit("job", JobEvent { id: id.into(), kind: kind.into(), pct, state: state.into(), message: message.into(), result });
}

// ---------------------------------------------------------------- environment

#[tauri::command]
async fn app_info(app: St<'_>) -> Result<Value, String> {
    let app = app.inner().clone();
    blocking(move || {
        let hw = app.hw();
        Ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "ffmpeg": app.bins.ffmpeg.to_string_lossy(),
            "ffmpegOk": app.bins.ffmpeg.is_file() || hw.ffmpeg_version.len() > 0,
            "ffmpegVersion": hw.ffmpeg_version,
            "whisper": app.bins.whisper.to_string_lossy(),
            "whisperOk": app.bins.whisper.is_file(),
            "dataDir": app.data_dir.to_string_lossy(),
            "cacheDir": app.cache_dir.to_string_lossy(),
            "hw": hw,
            "platform": std::env::consts::OS,
            "videosDir": dirs_videos(),
        }))
    })
    .await
}

fn dirs_videos() -> String {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    let v = Path::new(&home).join("Videos");
    if v.is_dir() { v.to_string_lossy().into_owned() } else { home }
}

#[tauri::command]
async fn hw_info(app: St<'_>, force: bool) -> Result<Hw, String> {
    let app = app.inner().clone();
    blocking(move || {
        if force || app.hw.lock().is_none() {
            let h = hw::detect(&app.bins.ffmpeg, &app.data_dir.join("hw.json"), force);
            *app.hw.lock() = Some(h);
        }
        Ok(app.hw())
    })
    .await
}

// ---------------------------------------------------------------- storage (JSON documents)

fn safe_name(name: &str) -> Result<String, String> {
    if name.is_empty() || name.len() > 120 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') || name.contains("..") {
        return Err(format!("잘못된 이름: {name}"));
    }
    Ok(name.to_string())
}

#[tauri::command]
fn store_get(app: St<'_>, name: String) -> Result<Option<String>, String> {
    let p = app.store_dir().join(format!("{}.json", safe_name(&name)?));
    Ok(std::fs::read_to_string(p).ok())
}

/// Writes a file so that a crash leaves either the old one or the new one, never half of it.
/// Whole or not at all, under a temporary name no other write uses (two saves at once never
/// write into one temporary file).
fn write_atomic(p: &Path, value: &[u8]) -> Result<(), String> {
    project::write_atomic(p, value)
}

const BACKUP_VERSIONS: usize = 50;
const BACKUP_DAYS: usize = 30;
const BACKUP_EVERY_MS: u128 = 600_000;

/// `v-<ms>.json` copies of a project before it is replaced, at most one every ten minutes, plus
/// the first copy of each day. The newest 50 and 30 stay.
fn back_up(data: &Path, name: &str, current: &Path, now: u128) -> Result<(), String> {
    if !current.is_file() {
        return Ok(());
    }
    let d = data.join("backups").join(name);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let names: Vec<String> = std::fs::read_dir(&d).map_err(|e| e.to_string())?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    let mut versions: Vec<u128> = names.iter().filter_map(|n| n.strip_prefix("v-")?.strip_suffix(".json")?.parse().ok()).collect();
    versions.sort_unstable();
    if versions.last().is_none_or(|v| now.saturating_sub(*v) >= BACKUP_EVERY_MS) {
        std::fs::copy(current, d.join(format!("v-{now}.json"))).map_err(|e| e.to_string())?;
        versions.push(now);
    }
    while versions.len() > BACKUP_VERSIONS {
        let _ = std::fs::remove_file(d.join(format!("v-{}.json", versions.remove(0))));
    }
    let today = format!("daily-{}.json", &stamp(now)[..10]);
    if !names.contains(&today) {
        std::fs::copy(current, d.join(&today)).map_err(|e| e.to_string())?;
    }
    let mut days: Vec<&String> = names.iter().filter(|n| n.starts_with("daily-")).collect();
    days.sort();
    let over = (days.len() + 1).saturating_sub(BACKUP_DAYS);
    for n in days.into_iter().take(over) {
        let _ = std::fs::remove_file(d.join(n));
    }
    Ok(())
}

use logs::{now_ms, stamp};

#[tauri::command]
fn store_set(app: St<'_>, name: String, value: String) -> Result<(), String> {
    let dir = app.store_dir();
    let safe = safe_name(&name)?;
    let p = dir.join(format!("{safe}.json"));
    if safe.starts_with("project-") {
        // A failed copy must not stop the save itself.
        if let Err(e) = back_up(&app.data_dir, &safe, &p, now_ms()) {
            app.log("backup", &format!("{safe}: {e}"));
        }
    }
    write_atomic(&p, value.as_bytes())
}

/// Never removes anything: the file moves to the trash folder, from which Home can bring it back,
/// and `logs/deletions.jsonl` says what went where, by whom and why.
#[tauri::command]
fn store_delete(app: St<'_>, name: String, by: Option<String>, reason: Option<String>) -> Result<(), String> {
    let dir = app.store_dir();
    let safe = safe_name(&name)?;
    let p = dir.join(format!("{safe}.json"));
    if p.exists() {
        let doc: Value = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        let bytes = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        let to = move_to_trash(&dir, &safe, &p, now_ms())?;
        let line = json!({ "t": stamp(now_ms()), "id": safe, "name": doc["name"], "from": p.to_string_lossy(), "to": to.to_string_lossy(), "by": by.as_deref().unwrap_or("user"), "reason": reason.as_deref().unwrap_or(""), "bytes": bytes });
        append_line(&app.data_dir.join("logs").join("deletions.jsonl"), &line.to_string());
        app.log("delete", &line.to_string());
    }
    Ok(())
}

fn move_to_trash(store: &Path, safe: &str, p: &Path, now: u128) -> Result<PathBuf, String> {
    let trash = store.join("_trash");
    std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let to = trash.join(format!("{safe}--{now}.json"));
    std::fs::rename(p, &to).map_err(|e| e.to_string())?;
    Ok(to)
}

fn append_line(p: &Path, line: &str) {
    use std::io::Write;
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let _ = writeln!(f, "{line}");
        let _ = f.sync_data();
    }
}

/// What the trash holds: file, project name and when it was deleted (ms), newest first.
#[tauri::command]
fn trash_list(app: St<'_>) -> Vec<Value> {
    let mut out: Vec<(u128, Value)> = Vec::new();
    for e in std::fs::read_dir(app.store_dir().join("_trash")).into_iter().flatten().flatten() {
        let file = e.file_name().to_string_lossy().into_owned();
        let Some((_, at)) = file.strip_suffix(".json").and_then(|s| s.rsplit_once("--")) else { continue };
        let at: u128 = at.parse().unwrap_or(0);
        let doc: Value = std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        out.push((at, json!({ "file": file, "at": at as u64, "name": doc["name"], "drafts": doc["drafts"].as_array().map(|a| a.len()), "assets": doc["assets"].as_array().map(|a| a.len()) })));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|x| x.1).collect()
}

fn restore_from_trash(store: &Path, file: &str) -> Result<String, String> {
    let stem = file.strip_suffix(".json").ok_or("잘못된 파일")?;
    let (name, _) = stem.rsplit_once("--").ok_or("잘못된 파일")?;
    safe_name(stem)?;
    let safe = safe_name(name)?;
    let to = store.join(format!("{safe}.json"));
    if to.exists() {
        return Err("같은 프로젝트가 이미 있습니다".into());
    }
    std::fs::rename(store.join("_trash").join(file), &to).map_err(|e| e.to_string())?;
    Ok(safe)
}

#[tauri::command]
fn trash_restore(app: St<'_>, file: String) -> Result<(), String> {
    let safe = restore_from_trash(&app.store_dir(), &file)?;
    append_line(&app.data_dir.join("logs").join("deletions.jsonl"), &json!({ "t": stamp(now_ms()), "id": safe, "restored": file }).to_string());
    app.log("restore", &format!("{file} restored as {safe}"));
    Ok(())
}

#[tauri::command]
fn log_event(app: St<'_>, kind: String, text: String) {
    app.log(&kind, &text);
}

#[tauri::command]
fn store_list(app: St<'_>, prefix: String) -> Result<Vec<String>, String> {
    let mut v = Vec::new();
    for e in std::fs::read_dir(app.store_dir()).map_err(|e| e.to_string())?.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if let Some(stem) = n.strip_suffix(".json") {
            if stem.starts_with(&prefix) {
                v.push(stem.to_string());
            }
        }
    }
    v.sort();
    Ok(v)
}

// ---------------------------------------------------------------- media

#[tauri::command]
fn expand_paths(paths: Vec<String>) -> Vec<(String, String)> {
    media::expand(&paths)
}

#[tauri::command]
async fn inspect(app: St<'_>, path: String) -> Result<MediaInfo, String> {
    let app = app.inner().clone();
    blocking(move || media::inspect(&app.bins.ffprobe, &path)).await
}

/// Lines the two lenses of a 360 recording up from where they overlap and matches their
/// brightness (DJI Studio-style self-calibration); the result goes on the asset's lens.
#[tauri::command]
async fn calibrate_360(app: St<'_>, info: MediaInfo, lens: Lens) -> Result<stitch::Stitch, String> {
    let app = app.inner().clone();
    blocking(move || stitch::calibrate(&app.bins.ffmpeg, &app.bins.ffprobe, &info, &lens)).await
}

/// The stabilising turn of each frame (base64 of f32 w, x, y, z), for the preview to look the same
/// way as the export. None until the recording has been analysed.
#[tauri::command]
async fn motion_track(app: St<'_>, path: String, lens: Lens) -> Result<Option<Value>, String> {
    let app = app.inner().clone();
    blocking(move || {
        let info = media::inspect(&app.bins.ffprobe, &path)?;
        let Ok(t) = std::fs::read_to_string(app.dir("motion").join(format!("{}{}", file_key(&path), motion::TRACK_FILE))) else { return Ok(None) };
        let m: motion::Motion = serde_json::from_str(&t).map_err(|e| e.to_string())?;
        if !motion::usable(&m, &info) {
            return Ok(None);
        }
        let q = motion::stab_track(&m, &motion::stab_of(&lens));
        if q.is_empty() {
            return Ok(None);
        }
        let mut b = Vec::with_capacity(q.len() * 16);
        for v in &q {
            for x in v {
                b.extend_from_slice(&x.to_le_bytes());
            }
        }
        Ok(Some(json!({ "fps": m.fps, "quats": media::jpeg_b64(&b) })))
    })
    .await
}

/// What the stabilisation found for a recording (gyro or picture), once analysed.
#[tauri::command]
fn motion_info(app: St<'_>, path: String) -> Option<Value> {
    let t = std::fs::read_to_string(app.dir("motion").join(format!("{}{}", file_key(&path), motion::TRACK_FILE))).ok()?;
    let m: motion::Motion = serde_json::from_str(&t).ok()?;
    Some(json!({ "source": m.source, "note": m.note, "readout": m.readout, "product": m.product }))
}

/// Works out how the camera moved (360 stabilisation) in the background, so the first export of
/// the recording does not have to; progress and the end come as "motion" job events. The result
/// is cached by `motion::motion_for` and read back with `motion_info`.
#[tauri::command]
fn analyze_motion(handle: tauri::AppHandle, app: St<'_>, id: String, info: MediaInfo, lens: Lens) {
    let app = app.inner().clone();
    let tag = format!("motion:{id}");
    let gen = app.jobs.generation(&tag);
    std::thread::spawn(move || {
        let r = motion::motion_for(&app.dir("motion"), &app.bins.ffmpeg, &app.bins.ffprobe, &app.jobs, &tag, gen, &info, &lens, &file_key(&info.path), |f| {
            emit(&handle, &id, "motion", (f * 100.0).min(99.0), "running", "", Value::Null);
        });
        match r {
            Ok(Some(_)) => emit(&handle, &id, "motion", 100.0, "done", "", Value::Null),
            Ok(None) => emit(&handle, &id, "motion", 0.0, "error", "흔들림을 분석하지 못했습니다", Value::Null),
            Err(e) => emit(&handle, &id, "motion", 0.0, if e == CANCELLED { "cancelled" } else { "error" }, &e, Value::Null),
        }
    });
}

#[derive(serde::Deserialize)]
struct EqReq {
    path: String,
    #[serde(default)]
    lens: Option<Lens>,
    times: Vec<f64>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    grid: Option<bool>,
}

/// Level 360 panoramas for placing views (the AI reads positions off them): for each time, a
/// width × width/2 equirectangular JPEG (base64) in the export's stabilised orientation, with a
/// grid every 120 px of a 960-wide scale (labelled), the horizon at 240 and lines at 120/360 of
/// a 480-high scale.
#[tauri::command]
async fn eq_sheet(app: St<'_>, req: EqReq) -> Result<Vec<String>, String> {
    let app = app.inner().clone();
    blocking(move || {
        let info = media::inspect(&app.bins.ffprobe, &req.path)?;
        let mut lens = req.lens.unwrap_or_default();
        if lens.layout.is_empty() || lens.layout == "none" {
            lens.layout = info.layout360.clone();
        }
        if lens.layout == "none" {
            return Err("360 영상이 아닙니다".into());
        }
        if lens.fov <= 0.0 {
            lens.fov = 190.0;
        }
        let w = req.width.unwrap_or(960).clamp(320, 2048) & !1;
        let h = (w / 2) & !1;
        let times: Vec<f64> = req.times.iter().copied().filter(|t| t.is_finite()).take(16).collect();
        let vf = |t: f64| if req.grid.unwrap_or(true) { media::eq_grid(t) } else { "null".to_string() };
        let tag = "eqsheet";
        let gen = app.jobs.generation(tag);
        let dir = app.dir("eqsheet").join(format!("{:x}", hash(&(&req.path, std::time::SystemTime::now()))));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let res = if motion::engine_lens(&info, &lens) {
            let m = motion::motion_for(&app.dir("motion"), &app.bins.ffmpeg, &app.bins.ffprobe, &app.jobs, tag, gen, &info, &lens, &file_key(&req.path), |_| {})?;
            let sphere = |_t: f64| (pano::I3, None);
            motion::stills(&app.bins.ffmpeg, &app.jobs, tag, gen, &info, &lens, m.as_ref(), &times, w, h, &sphere, &vf, &dir)
        } else {
            media::equirect_stills(&app.bins.ffmpeg, &info, &lens, &times, w, &vf, &dir)
        };
        let out = res.and_then(|files| files.iter().map(|f| std::fs::read(f).map(|b| media::jpeg_b64(&b)).map_err(|e| e.to_string())).collect());
        let _ = std::fs::remove_dir_all(&dir);
        out
    })
    .await
}

/// A 360 lens that goes through the engine (stitching on, whatever the clip's own setting), with
/// its motion track, for looking at the level picture.
fn engine_for(app: &App, tag: &str, gen: u64, path: &str, lens: Option<Lens>) -> Result<(MediaInfo, Lens, Option<motion::Motion>), String> {
    let info = media::inspect(&app.bins.ffprobe, path)?;
    let mut lens = lens.unwrap_or_default();
    if lens.layout.is_empty() || lens.layout == "none" {
        lens.layout = info.layout360.clone();
    }
    if !matches!(lens.layout.as_str(), "dual" | "dfisheye") {
        return Err("두 렌즈 360 영상에서만 쓸 수 있습니다".into());
    }
    if lens.fov <= 0.0 {
        lens.fov = 190.0;
    }
    if !motion::engine_lens(&info, &lens) {
        lens.stitch = None;
    }
    let m = motion::motion_for(&app.dir("motion"), &app.bins.ffmpeg, &app.bins.ffprobe, &app.jobs, tag, gen, &info, &lens, &file_key(path), |_| {})?;
    Ok((info, lens, m))
}

#[derive(serde::Deserialize)]
struct FindFaces {
    path: String,
    #[serde(default)]
    lens: Option<Lens>,
    times: Vec<f64>,
}

/// Faces on the level panorama at each time (x, y, w, h on the sheet's 960×480 scale).
#[tauri::command]
async fn find_faces(app: St<'_>, req: FindFaces) -> Result<Vec<Value>, String> {
    let app = app.inner().clone();
    blocking(move || {
        let gen = app.jobs.generation("faces");
        let (info, lens, m) = engine_for(&app, "faces", gen, &req.path, req.lens)?;
        let items: Vec<(f64, pano::M3, Option<(f64, f64)>)> = req.times.iter().copied().filter(|t| t.is_finite()).take(16).map(|t| (t, pano::I3, None)).collect();
        let mut out = Vec::new();
        let mut err = None;
        motion::look_at(&app.bins.ffmpeg, &app.jobs, "faces", gen, &info, &lens, m.as_ref(), &items, 1920, 960, &mut |_, t, f| match app.faces.detect_sphere(f) {
            Ok(faces) => out.push(json!({ "t": t, "faces": faces })),
            Err(e) => err = Some(e),
        })?;
        err.map_or(Ok(out), Err)
    })
    .await
}

#[tauri::command]
fn dir_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[derive(serde::Deserialize)]
struct ScriptFiles {
    op: String,
    path: String,
    #[serde(default)]
    text: String,
    roots: Vec<String>,
}

/// A script's only way to files: listing and reading inside `roots`, writing a named file into the first.
#[tauri::command]
async fn script_files(req: ScriptFiles) -> Result<Value, String> {
    blocking(move || {
        let roots: Vec<PathBuf> = req.roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).collect();
        let inside = |p: &str| -> Result<PathBuf, String> {
            let c = std::fs::canonicalize(p).map_err(|e| format!("{p}: {e}"))?;
            if roots.iter().any(|r| c.starts_with(r)) {
                Ok(c)
            } else {
                Err(format!("이 위치는 스크립트에서 쓸 수 없습니다: {p}"))
            }
        };
        match req.op.as_str() {
            "list" => {
                let mut out = Vec::new();
                for e in std::fs::read_dir(inside(&req.path)?).map_err(|e| e.to_string())?.flatten() {
                    let m = e.metadata().map_err(|e| e.to_string())?;
                    out.push(json!({ "name": e.file_name().to_string_lossy(), "path": e.path().to_string_lossy(), "dir": m.is_dir(), "size": m.len() }));
                }
                Ok(json!(out))
            }
            "read" => {
                let p = inside(&req.path)?;
                if std::fs::metadata(&p).map_err(|e| e.to_string())?.len() > 5 << 20 {
                    return Err("5MB가 넘는 파일은 읽을 수 없습니다".into());
                }
                Ok(json!(String::from_utf8_lossy(&std::fs::read(&p).map_err(|e| e.to_string())?)))
            }
            "write" => {
                if req.path.is_empty() || req.path.contains(['/', '\\', ':']) || req.path.starts_with('.') {
                    return Err("파일 이름만 쓸 수 있습니다".into());
                }
                let dir = roots.first().ok_or("내보낼 폴더가 없습니다")?;
                let p = dir.join(&req.path);
                std::fs::write(&p, req.text.as_bytes()).map_err(|e| e.to_string())?;
                Ok(json!(p.to_string_lossy()))
            }
            o => Err(format!("모르는 동작: {o}")),
        }
    })
    .await
}

/// Loudness of a stretch of a file, for the 소리 고르게 button.
#[tauri::command]
async fn loudness(app: St<'_>, path: String, start: f64, dur: f64) -> Result<Value, String> {
    let app = app.inner().clone();
    blocking(move || {
        analysis::integrated(&app.bins.ffmpeg, &path, start, start + dur)
    })
    .await
}

/// A developer's check: how close the export's picture is to the live preview's, in numbers.
#[tauri::command]
async fn diag_parity(app: St<'_>, path: String, lens: Lens, times: Vec<f64>, yaws: Vec<f64>) -> Result<Vec<Value>, String> {
    let app = app.inner().clone();
    blocking(move || {
        let info = media::inspect(&app.bins.ffprobe, &path)?;
        diag::parity(&app.bins.ffmpeg, &app.jobs, &info, &lens, &times, &yaws, &app.data_dir.join("diag"))
    })
    .await
}

#[derive(serde::Deserialize)]
struct MeasureReq {
    what: String,
    path: String,
    from: f64,
    to: f64,
    #[serde(default)]
    threshold: f64,
}

/// Loudness, beats, picture changes or sound events of a stretch of a file.
#[tauri::command]
async fn measure(app: St<'_>, req: MeasureReq) -> Result<Value, String> {
    let app = app.inner().clone();
    blocking(move || {
        let ff = &app.bins.ffmpeg;
        match req.what.as_str() {
            "loudness" => analysis::loudness(ff, &req.path, req.from, req.to),
            "beats" => analysis::beats(ff, &req.path, req.from, req.to),
            "events" => analysis::events(ff, &req.path, req.from, req.to).map(|v| json!(v)),
            "scenes" => analysis::scene_cuts(ff, &req.path, req.from, req.to, if req.threshold > 0.0 { req.threshold } else { 0.3 }).map(|v| json!(v)),
            w => Err(format!("모르는 측정: {w}")),
        }
    })
    .await
}

#[derive(serde::Deserialize)]
struct GazeReq {
    path: String,
    #[serde(default)]
    lens: Option<Lens>,
    from: f64,
    to: f64,
    step: f64,
}

/// Faces and which way they point every `step` seconds of a stretch (at most 240 looks).
#[tauri::command]
async fn scan_gaze(app: St<'_>, req: GazeReq) -> Result<Vec<Value>, String> {
    let app = app.inner().clone();
    blocking(move || {
        let step = req.step.clamp(0.5, 60.0);
        let times: Vec<f64> = (0..240).map(|i| req.from + i as f64 * step).take_while(|t| *t < req.to).collect();
        let info = media::inspect(&app.bins.ffprobe, &req.path)?;
        let gen = app.jobs.generation("gaze");
        let mut out = Vec::new();
        if matches!(info.layout360.as_str(), "dual" | "dfisheye") {
            let (info, lens, m) = engine_for(&app, "gaze", gen, &req.path, req.lens)?;
            let items: Vec<(f64, pano::M3, Option<(f64, f64)>)> = times.iter().copied().map(|t| (t, pano::I3, None)).collect();
            let mut err = None;
            let mut seen = std::collections::HashSet::new();
            motion::look_at(&app.bins.ffmpeg, &app.jobs, "gaze", gen, &info, &lens, m.as_ref(), &items, 1920, 960, &mut |_, t, f| {
                if !seen.insert(t.to_bits()) {
                    return;
                }
                match app.faces.detect_sphere(f) {
                    Ok(faces) => out.push(json!({ "t": t, "faces": faces })),
                    Err(e) => err = Some(e),
                }
            })?;
            return err.map_or(Ok(out), Err);
        }
        // An ordinary video: pictures fitted into the detector's square, in time order.
        const S: usize = 640;
        let vf = format!("fps=1/{step},scale={S}:{S}:force_original_aspect_ratio=decrease,pad={S}:{S}:0:0,format=bgr24");
        let mut c = ff::command(&app.bins.ffmpeg)
            .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", &format!("{:.3}", req.from.max(0.0)), "-t", &format!("{:.3}", (req.to - req.from).max(0.0)), "-i", &req.path, "-an", "-vf", &vf, "-f", "rawvideo", "-"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut pipe = c.stdout.take().ok_or("ffmpeg 출력 없음")?;
        let mut buf = vec![0u8; S * S * 3];
        let mut i = 0;
        while i < times.len() && std::io::Read::read_exact(&mut pipe, &mut buf).is_ok() {
            out.push(json!({ "t": times[i], "faces": app.faces.detect_bgr(&buf, S, S)? }));
            i += 1;
        }
        let _ = c.kill();
        let _ = c.wait();
        Ok(out)
    })
    .await
}

#[derive(serde::Deserialize)]
struct TrackSubject {
    name: String,
    /// [t, x, y] marks on the panorama sheet.
    seeds: Vec<(f64, f32, f32)>,
}
#[derive(serde::Deserialize)]
struct TrackReq {
    path: String,
    #[serde(default)]
    lens: Option<Lens>,
    from: f64,
    to: f64,
    subjects: Vec<TrackSubject>,
}

/// Follows heads through a stretch of a 360 recording from the marks given: 5 pictures a second on
/// the level panorama, template matching carried by face detections once a second. Returns each
/// person's marks and how much of the stretch they were followed for.
#[tauri::command]
async fn track_people(app: St<'_>, req: TrackReq) -> Result<Vec<Value>, String> {
    let app = app.inner().clone();
    blocking(move || {
        if req.to - req.from > 180.0 {
            return Err("한 번에 3분까지 추적합니다. 구간을 나눠 주세요.".to_string());
        }
        let gen = app.jobs.generation("track");
        let (info, lens, m) = engine_for(&app, "track", gen, &req.path, req.lens)?;
        let mut samples: Vec<faces::Sample> = Vec::new();
        motion::sphere_run(&app.bins.ffmpeg, &app.jobs, "track", gen, &info, &lens, m.as_ref(), req.from, req.to, 5.0, 1920, &mut |k, t, f| {
            let found = if k % 5 == 0 { app.faces.detect_sphere(f).unwrap_or_default() } else { Vec::new() };
            samples.push(faces::Sample { t, luma: faces::luma_small(f), faces: found });
        })?;
        Ok(req
            .subjects
            .iter()
            .map(|s| {
                let tr = faces::track(&samples, &s.seeds);
                let pct = if samples.is_empty() { 0 } else { tr.len() * 100 / samples.len() };
                json!({ "name": s.name, "tracked": pct, "marks": tr.iter().map(|(t, x, y)| [(*t * 100.0).round() / 100.0, (*x as f64 * 10.0).round() / 10.0, (*y as f64 * 10.0).round() / 10.0]).collect::<Vec<_>>() })
            })
            .collect())
    })
    .await
}

#[derive(serde::Deserialize)]
struct FaceCheck {
    path: String,
    #[serde(default)]
    lens: Option<Lens>,
    /// Source time and the view at that time.
    items: Vec<(f64, media::View)>,
    /// Width / height of the picture (16:9 when missing).
    #[serde(default)]
    aspect: Option<f64>,
}

/// Faces in the flat picture each view shows, and which of them touch the frame edge.
#[tauri::command]
async fn face_check(app: St<'_>, req: FaceCheck) -> Result<Vec<Value>, String> {
    let app = app.inner().clone();
    blocking(move || {
        let gen = app.jobs.generation("faces");
        let (info, lens, m) = engine_for(&app, "faces", gen, &req.path, req.lens)?;
        let items: Vec<(f64, pano::M3, Option<(f64, f64)>)> = req.items.iter().take(16).map(|(t, v)| {
            let v = framing::norm_view(v);
            (*t, stitch::matrix(stitch::ypr(v.yaw, v.pitch, v.roll)), Some((v.hfov, v.dist)))
        }).collect();
        let mut out = Vec::new();
        // The detector takes up to 640 on a side.
        let asp = req.aspect.unwrap_or(16.0 / 9.0).clamp(0.3, 4.0);
        let (fw, fh) = if asp >= 1.0 { (640u32, ((640.0 / asp) as u32) & !1) } else { (((640.0 * asp) as u32) & !1, 640u32) };
        motion::look_at(&app.bins.ffmpeg, &app.jobs, "faces", gen, &info, &lens, m.as_ref(), &items, fw, fh, &mut |_, t, f| {
            let found = app.faces.detect_frame(f).unwrap_or_default();
            let edges: Vec<&str> = found.iter().filter_map(|m| faces::edge_of(m, fw as f32, fh as f32)).collect();
            out.push(json!({ "t": t, "faces": found.len(), "edges": edges }));
        })?;
        Ok(out)
    })
    .await
}

/// Looks for blurry, shaky and too dark stretches of a recording, with progress as "shots" job
/// events. A two-lens recording is read through its .lrf when there is one (much quicker).
#[tauri::command]
async fn scan_shots(handle: tauri::AppHandle, app: St<'_>, id: String, info: MediaInfo, from: Option<f64>, to: Option<f64>) -> Result<Vec<shots::Bad>, String> {
    let app = app.inner().clone();
    blocking(move || {
        let tag = format!("shots:{id}");
        let gen = app.jobs.generation(&tag);
        let path = if info.layout360 == "dual" { info.lrf.clone().unwrap_or_else(|| info.path.clone()) } else { info.path.clone() };
        let from = from.unwrap_or(0.0).max(0.0);
        let dur = (to.unwrap_or(info.duration).min(info.duration) - from).max(0.5);
        let app2 = app.clone();
        let h2 = handle.clone();
        let id2 = id.clone();
        let tag2 = tag.clone();
        let res = shots::measure(&app.bins.ffmpeg, &path, 0, from, dur, move |f| emit(&h2, &id2, "shots", f * 100.0, "running", "", Value::Null), move || app2.jobs.generation(&tag2) != gen);
        match &res {
            Ok(_) => emit(&handle, &id, "shots", 100.0, "done", "", Value::Null),
            Err(e) => emit(&handle, &id, "shots", 0.0, "error", e, Value::Null),
        }
        Ok(shots::judge(&res?, from))
    })
    .await
}

/// The address of a live preview stream or still frame (see `live`) for a file the WebView cannot play.
#[tauri::command]
fn live_url(app: St<'_>, req: live::Req) -> String {
    app.live.url(req)
}

#[tauri::command]
fn live_sharp(app: St<'_>, on: bool) {
    app.live.set_sharp(on);
}

/// Ends the live preview of a viewer slot (paused, or moved to another file).
#[tauri::command]
fn live_stop(app: St<'_>, slot: String) -> bool {
    app.live.stop(&slot)
}

#[tauri::command]
async fn filmstrip(app: St<'_>, path: String, duration: f64, count: u32) -> Result<String, String> {
    let app = app.inner().clone();
    blocking(move || {
        let out = app.dir("strips").join(format!("{}-{count}.jpg", file_key(&path)));
        if !out.is_file() {
            media::filmstrip(&app.bins.ffmpeg, &path, duration, count, &out)?;
        }
        Ok(out.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
async fn poster(app: St<'_>, path: String, at: f64) -> Result<String, String> {
    let app = app.inner().clone();
    blocking(move || {
        let out = app.dir("posters").join(format!("{}-{}.jpg", file_key(&path), (at * 10.0) as i64));
        if !out.is_file() {
            let a: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-ss", &format!("{at:.2}"), "-i", &path, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", &out.to_string_lossy()].iter().map(|x| x.to_string()).collect();
            let (ok, _, err) = ff::output(&app.bins.ffmpeg, &a)?;
            if !ok {
                return Err(err);
            }
        }
        Ok(out.to_string_lossy().into_owned())
    })
    .await
}

fn wave_of(app: &App, path: &str) -> Result<Vec<u8>, String> {
    let out = app.dir("waves").join(format!("{}.bin", file_key(path)));
    if let Ok(b) = std::fs::read(&out) {
        return Ok(b);
    }
    let w = media::waveform(&app.bins.ffmpeg, path)?;
    let _ = std::fs::write(&out, &w);
    Ok(w)
}

#[tauri::command]
async fn waveform(app: St<'_>, path: String) -> Result<Vec<u8>, String> {
    let app = app.inner().clone();
    blocking(move || wave_of(&app, &path)).await
}

/// How far recording `b` lags recording `a`, by comparing their sound. Seconds of `a` where `b`
/// starts, and how clear the match is (0–1).
#[tauri::command]
async fn sync_audio(app: St<'_>, a: String, b: String) -> Result<Value, String> {
    let app = app.inner().clone();
    blocking(move || {
        let (x, y) = (wave_of(&app, &a)?, wave_of(&app, &b)?);
        let (offset, clear) = media::sync_offset(&x, &y);
        Ok(json!({ "offset": offset, "clear": clear }))
    })
    .await
}

#[derive(serde::Deserialize)]
struct AutoColorReq {
    path: String,
    start: f64,
    end: f64,
    #[serde(default)]
    lens: Option<Lens>,
    #[serde(default)]
    view: Option<media::View>,
}

/// A suggested exposure, contrast and white balance from five pictures of a stretch of a file
/// (a 360 clip as seen through its view).
#[tauri::command]
async fn auto_color(app: St<'_>, req: AutoColorReq) -> Result<Value, String> {
    let app = app.inner().clone();
    blocking(move || {
        let times: Vec<f64> = (0..5).map(|i| req.start + (req.end - req.start).max(0.0) * (i as f64 + 0.5) / 5.0).collect();
        let mut pics = Vec::new();
        if let (Some(v), Some(lens)) = (&req.view, req.lens.clone().filter(|l| matches!(l.layout.as_str(), "dual" | "dfisheye"))) {
            let gen = app.jobs.generation("color");
            let (info, lens, m) = engine_for(&app, "color", gen, &req.path, Some(lens))?;
            let v = framing::norm_view(v);
            let rot = stitch::matrix(stitch::ypr(v.yaw, v.pitch, v.roll));
            let items: Vec<(f64, pano::M3, Option<(f64, f64)>)> = times.iter().map(|t| (*t, rot, Some((v.hfov, v.dist)))).collect();
            motion::look_at(&app.bins.ffmpeg, &app.jobs, "color", gen, &info, &lens, m.as_ref(), &items, 320, 180, &mut |_, _, f| pics.push((faces::crop_bgr(f, 0, 0, f.w, f.h), f.w, f.h)))?;
        } else {
            for t in &times {
                let a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", &format!("{:.3}", t.max(0.0)), "-i", &req.path, "-frames:v", "1", "-map", "0:v:0", "-vf", "scale=160:90,format=bgr24", "-f", "rawvideo", "-"].iter().map(|x| x.to_string()).collect();
                let o = ff::command(&app.bins.ffmpeg).args(&a).stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
                if o.stdout.len() >= 160 * 90 * 3 {
                    pics.push((o.stdout, 160, 90));
                }
            }
        }
        let (exposure, contrast, temperature) = media::auto_color(&pics);
        Ok(json!({ "exposure": exposure, "contrast": contrast, "temperature": temperature }))
    })
    .await
}

#[tauri::command]
async fn frames(app: St<'_>, req: FrameReq) -> Result<Vec<String>, String> {
    let app = app.inner().clone();
    blocking(move || {
        // A view of a two-lens 360 recording goes through the engine, stabilised and levelled like
        // the export and the level panorama, so a direction read off the panorama shows the same
        // thing here (a tilted camera would otherwise point the raw lenses somewhere else).
        if let (Some(v), Some(lens)) = (&req.view, &req.lens) {
            if matches!(lens.layout.as_str(), "dual" | "dfisheye") {
                let info = media::inspect(&app.bins.ffprobe, &req.path)?;
                let mut lens = lens.clone();
                if lens.fov <= 0.0 {
                    lens.fov = 190.0;
                }
                if motion::engine_lens(&info, &lens) {
                    let tag = "frames";
                    let gen = app.jobs.generation(tag);
                    let m = motion::motion_for(&app.dir("motion"), &app.bins.ffmpeg, &app.bins.ffprobe, &app.jobs, tag, gen, &info, &lens, &file_key(&req.path), |_| {})?;
                    let w = req.width.unwrap_or(768).clamp(64, 1920) & !1;
                    let h = ((w as f64 / req.aspect.unwrap_or(16.0 / 9.0).clamp(0.3, 4.0)).round() as u32) & !1;
                    let v = framing::norm_view(v);
                    let rot = stitch::matrix(stitch::ypr(v.yaw, v.pitch, v.roll));
                    let look = move |_t: f64| (rot, Some((v.hfov, v.dist)));
                    let dir = app.dir("frames").join(format!("{:x}", hash(&(&req.path, std::time::SystemTime::now()))));
                    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                    let times: Vec<f64> = req.times.iter().copied().filter(|t| t.is_finite()).take(16).collect();
                    let out = motion::stills(&app.bins.ffmpeg, &app.jobs, tag, gen, &info, &lens, m.as_ref(), &times, w, h, &look, &|_| "null".to_string(), &dir)
                        .and_then(|files| files.iter().map(|f| std::fs::read(f).map(|b| media::jpeg_b64(&b)).map_err(|e| e.to_string())).collect());
                    let _ = std::fs::remove_dir_all(&dir);
                    return out;
                }
            }
        }
        media::frames(&app.bins.ffmpeg, &req)
    })
    .await
}

#[tauri::command]
async fn contact_sheet(app: St<'_>, path: String, start: f64, every: f64, cols: u32, rows: u32, tile_w: u32) -> Result<String, String> {
    let app = app.inner().clone();
    blocking(move || media::contact_sheet(&app.bins.ffmpeg, &path, start, every.max(0.5), cols.clamp(1, 10), rows.clamp(1, 10), tile_w.clamp(80, 480))).await
}

// ---------------------------------------------------------------- transcription

#[tauri::command]
fn whisper_models(app: St<'_>) -> Vec<transcribe::ModelInfo> {
    transcribe::models(&app.models_dir())
}

#[tauri::command]
fn download_model(handle: tauri::AppHandle, app: St<'_>, id: String) -> Result<(), String> {
    let app = app.inner().clone();
    let gen = app.jobs.generation("download");
    std::thread::spawn(move || {
        let r = transcribe::download(&app.models_dir(), &id, &app.jobs, gen, |d, t| {
            let pct = if t > 0 { d as f64 / t as f64 * 100.0 } else { 0.0 };
            emit(&handle, &id, "download", pct, "running", &format!("{} / {} MB", d / 1_048_576, t / 1_048_576), Value::Null);
        });
        match r {
            Ok(p) => emit(&handle, &id, "download", 100.0, "done", "", json!(p.to_string_lossy())),
            Err(e) => emit(&handle, &id, "download", 0.0, if e == CANCELLED { "cancelled" } else { "error" }, &e, Value::Null),
        }
    });
    Ok(())
}

#[tauri::command]
fn transcribe(handle: tauri::AppHandle, app: St<'_>, id: String, path: String, model: String, lang: String, engine: Option<String>) -> Result<(), String> {
    let app = app.inner().clone();
    let tag = format!("transcribe:{id}");
    let gen = app.jobs.generation(&tag);
    let engine = engine.unwrap_or_else(|| "whisper".into());
    let model_path = if engine == "qwen" { PathBuf::new() } else { transcribe::model_path(&app.models_dir(), &model)? };
    std::thread::spawn(move || {
        let work = app.dir("transcribe").join(&id);
        let r = transcribe::Run { ffmpeg: &app.bins.ffmpeg, whisper: &app.bins.whisper, model: model_path, media: path, lang, work: work.clone(), threads: hw::threads(), engine, data: app.data_dir.clone() };
        let res = transcribe::run(&r, &app.jobs, &tag, gen, |p| emit(&handle, &id, "transcribe", p, "running", "", Value::Null));
        let _ = std::fs::remove_dir_all(&work);
        match res {
            Ok((lang, words)) => emit(&handle, &id, "transcribe", 100.0, "done", "", json!({ "lang": lang, "words": words })),
            Err(e) => emit(&handle, &id, "transcribe", 0.0, if e == CANCELLED { "cancelled" } else { "error" }, &e, Value::Null),
        }
    });
    Ok(())
}

#[tauri::command]
async fn qwen_status(app: St<'_>, deep: bool) -> Result<qwen::Status, String> {
    let app = app.inner().clone();
    blocking(move || Ok(qwen::status(&app.data_dir, deep))).await
}

/// Installs the Qwen3-ASR engine in the background ("job" events, kind "qwen-setup", id "qwen").
#[tauri::command]
fn qwen_setup(handle: tauri::AppHandle, app: St<'_>) -> Result<(), String> {
    let app = app.inner().clone();
    let tag = "qwen-setup".to_string();
    let gen = app.jobs.generation(&tag);
    std::thread::spawn(move || {
        let gpus = app.hw().gpus;
        let r = qwen::setup(&app.data_dir, &gpus, &app.jobs, &tag, gen, |p, m| emit(&handle, "qwen", "qwen-setup", p, "running", m, Value::Null));
        match r {
            Ok(_) => emit(&handle, "qwen", "qwen-setup", 100.0, "done", "", Value::Null),
            Err(e) => emit(&handle, "qwen", "qwen-setup", 0.0, if e == CANCELLED { "cancelled" } else { "error" }, &e, Value::Null),
        }
    });
    Ok(())
}

// ---------------------------------------------------------------- export

fn unique_out(path: &str) -> String {
    let p = PathBuf::from(path);
    if !p.exists() {
        return path.to_string();
    }
    let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    for i in 2..1000 {
        let q = dir.join(format!("{stem} ({i}).{ext}"));
        if !q.exists() {
            return q.to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

#[tauri::command]
fn export(handle: tauri::AppHandle, app: St<'_>, id: String, plan: render::Plan) -> Result<String, String> {
    let app = app.inner().clone();
    let out = unique_out(&plan.out);
    if let Some(parent) = Path::new(&out).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("저장 폴더를 만들 수 없습니다: {e}"))?;
    }
    let tag = "export".to_string();
    let gen = app.jobs.cancel(&tag);
    let work = app.dir("export").join(&id);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let has_ass = !plan.ass.trim().is_empty();
    if has_ass {
        std::fs::write(work.join("captions.ass"), &plan.ass).map_err(|e| e.to_string())?;
    }
    let ext = Path::new(&out).extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "mp4".into());
    let part = Path::new(&out).with_extension(format!("part.{ext}")).to_string_lossy().into_owned();
    let graph_file = work.join("graph.txt");
    let hw = app.hw();
    let built = render::build(&plan, &hw, &graph_file.to_string_lossy(), app.ffmpeg_major() >= 7, has_ass, &part)?;
    std::fs::write(&graph_file, &built.graph).map_err(|e| e.to_string())?;
    app.log("export", &format!("{id} start: {} clips, {}x{}, {} fps, mode {}, to {out}", plan.segs.len(), plan.width, plan.height, plan.fps, plan.mode));
    let out2 = out.clone();
    let n360 = plan.segs.iter().map(|s| (&s.kind, &s.lens)).chain(plan.overlays.iter().map(|o| (&o.kind, &o.lens))).filter(|(k, l)| k.as_str() == "video" && l.as_ref().map(|l| matches!(l.layout.as_str(), "dual" | "dfisheye") && stitch::active(l)).unwrap_or(false)).count();
    std::thread::spawn(move || {
        let mut built = built;
        let t0 = std::time::Instant::now();
        let warnings: Mutex<Vec<String>> = Mutex::default();
        let elog = logs::export_log_path(&id);
        let note = |v: Value| {
            if let Some(p) = &elog {
                let _ = logs::append_jsonl(p, &v);
            }
        };
        note(json!({ "t": stamp(now_ms()), "event": "start", "id": id, "clips": plan.segs.len(), "w": plan.width, "h": plan.height, "fps": plan.fps, "mode": plan.mode, "out": out2, "loudnorm": plan.loudnorm }));
        // 360 clips first go through Reelcut's 360 engine (seam per frame, stabilisation) into
        // flat pictures; the main render then treats them as ordinary clips.
        // The 360 stage is nearly all of the time (measured: 23 of 24 minutes).
        let (pre_w, pre_end) = if n360 > 0 { (90.0, 90.0) } else { (0.0, 0.0) };
        let started = std::time::Instant::now();
        if n360 > 0 {
            match engine_prepass(&app, &tag, gen, &plan, &work, &warnings, |f| {
                let left = if f > 0.01 { started.elapsed().as_secs_f64() * (1.0 - f) / f + 60.0 } else { -1.0 };
                emit(&handle, &id, "export", f * pre_w, "running", &format!("{left:.0}"), json!({ "stage": "360" }))
            }) {
                Ok(Some(p2)) => match render::build(&p2, &hw, &graph_file.to_string_lossy(), app.ffmpeg_major() >= 7, has_ass, &part).and_then(|b| std::fs::write(&graph_file, &b.graph).map(|_| b).map_err(|e| e.to_string())) {
                    Ok(b) => built = b,
                    Err(e) => {
                        app.log("export", &format!("{id} 360 engine render plan failed, using the ffmpeg stitch: {e}"));
                        warnings.lock().push(format!("360 처리 계획을 만들지 못해 간단한 방식으로 내보냈습니다: {e}"));
                    }
                },
                Ok(None) => {}
                Err(e) if e == CANCELLED => {
                    let _ = std::fs::remove_dir_all(&work);
                    emit(&handle, &id, "export", 0.0, "cancelled", &e, Value::Null);
                    return;
                }
                Err(e) => {
                    app.log("export", &format!("{id} 360 engine failed, using the ffmpeg stitch: {e}"));
                    warnings.lock().push(format!("360 엔진이 실패해 간단한 방식으로 내보냈습니다: {e}"));
                }
            }
        }
        let dur = built.duration.max(0.1);
        let t_final = std::time::Instant::now();
        if n360 > 0 {
            app.log("export", &format!("{id} 360 stage done in {:.1}s", t0.elapsed().as_secs_f64()));
            note(json!({ "t": stamp(now_ms()), "event": "360-stage", "seconds": t0.elapsed().as_secs_f64() }));
        }
        app.log("export", &format!("{id} final pass: {}", built.args.join(" ")));
        let res = ff::run_ffmpeg_in(&app.jobs, &tag, gen, &app.bins.ffmpeg, &built.args, Some(&work), |p| {
            let pct = pre_end + ((p.out_time / dur * 100.0).min(99.5)) * (100.0 - pre_end) / 100.0;
            let left = if pct > 1.0 { t0.elapsed().as_secs_f64() * (100.0 - pct) / pct } else { -1.0 };
            emit(&handle, &id, "export", pct, "running", &format!("{left:.0}"), json!({ "size": p.total_size, "speed": p.speed }));
        });
        match res {
            Ok(_) => {
                let _ = std::fs::rename(&part, &out2);
                let size = std::fs::metadata(&out2).map(|m| m.len()).unwrap_or(0);
                let check = probe::check(&app.bins.ffprobe, &out2).ok();
                note(json!({ "t": stamp(now_ms()), "event": "done", "seconds": t0.elapsed().as_secs_f64(), "final_seconds": t_final.elapsed().as_secs_f64(), "duration": dur, "size": size, "warnings": *warnings.lock() }));
                app.log("export", &format!("{id} done: {:.1} s of video in {:.1}s (final pass {:.1}s), {size} bytes", dur, t0.elapsed().as_secs_f64(), t_final.elapsed().as_secs_f64()));
                let warn = match &check {
                    Some(c) if (c.duration - dur).abs() > 1.0 => format!("결과 길이({:.1}초)가 예상({:.1}초)과 다릅니다", c.duration, dur),
                    None => "결과 파일을 다시 읽지 못했습니다".into(),
                    _ => String::new(),
                };
                emit(&handle, &id, "export", 100.0, "done", &warn, json!({ "path": out2, "size": size, "seconds": t0.elapsed().as_secs_f64(), "duration": dur, "warnings": *warnings.lock() }));
            }
            Err(e) => {
                note(json!({ "t": stamp(now_ms()), "event": "ended", "error": e, "warnings": *warnings.lock() }));
                app.log("export", &format!("{id} ended: {e}"));
                let _ = std::fs::remove_file(&part);
                emit(&handle, &id, "export", 0.0, if e == CANCELLED { "cancelled" } else { "error" }, &e, Value::Null);
            }
        }
        let _ = std::fs::remove_dir_all(&work);
    });
    Ok(out)
}

/// Oldest clips go first once the engine's kept clips pass `limit_mb`.
fn prune_engine_cache(dir: &Path, limit_mb: u64) {
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = std::fs::read_dir(dir).into_iter().flatten().flatten().filter_map(|e| {
        let m = e.metadata().ok()?;
        Some((m.modified().ok()?, m.len(), e.path()))
    }).collect();
    files.sort_by_key(|f| f.0);
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    for (_, len, p) in files {
        if total <= limit_mb << 20 {
            break;
        }
        let _ = std::fs::remove_file(p);
        total -= len;
    }
}

/// Renders every 360 clip of the plan (main track and overlays) flat through the engine and
/// returns the plan with those clips pointing at the results; None when nothing needed it.
fn engine_prepass(app: &App, tag: &str, gen: u64, plan: &render::Plan, work: &Path, warnings: &Mutex<Vec<String>>, on: impl Fn(f64) + Sync) -> Result<Option<render::Plan>, String> {
    use media::View;
    struct Job {
        main: bool,
        i: usize,
        path: String,
        start: f64,
        dur: f64,
        speed: f64,
        lens: Lens,
        view: Option<View>,
        keys: Vec<render::ViewKey>,
    }
    let mut jobs: Vec<Job> = Vec::new();
    for (i, s) in plan.segs.iter().enumerate() {
        if let Some(l) = s.lens.clone().filter(|l| s.kind == "video" && matches!(l.layout.as_str(), "dual" | "dfisheye") && stitch::active(l)) {
            jobs.push(Job { main: true, i, path: s.path.clone(), start: s.start, dur: s.dur, speed: s.speed, lens: l, view: s.view.clone(), keys: s.view_keys.clone() });
        }
    }
    for (i, o) in plan.overlays.iter().enumerate() {
        if let Some(l) = o.lens.clone().filter(|l| o.kind == "video" && matches!(l.layout.as_str(), "dual" | "dfisheye") && stitch::active(l)) {
            jobs.push(Job { main: false, i, path: o.path.clone(), start: o.start, dur: o.dur, speed: o.speed, lens: l, view: o.view.clone(), keys: o.view_keys.clone() });
        }
    }
    if jobs.is_empty() {
        return Ok(None);
    }
    let total_frames: f64 = jobs.iter().map(|j| j.dur.max(0.1)).sum();
    let (w, h) = (plan.width.max(16) & !1, plan.height.max(16) & !1);
    let gpu = app.hw().tested.iter().any(|(n, ok)| n.ends_with("_qsv") && *ok);
    // Room for lossless stepping stones (about 3 bits per pixel), or else lossy ones.
    let est_mb = total_frames * plan.fps * (w as f64 * h as f64 * 3.0 / 8.0) / 1_048_576.0;
    let lossless = hw::free_mb(work) as f64 >= 2.0 * est_mb;
    if !lossless {
        warnings.lock().push("디스크 공간이 적어 중간 파일을 작게 만들었습니다".into());
    }
    let workers = hw::clip_workers(hw::avail_mb(), gpu).min(jobs.len()).max(1);
    app.log("export", &format!("360 stage: {} clips, {workers} at once, gpu {gpu}, lossless {lossless}", jobs.len()));
    // Each recording's motion once, before the clips share it.
    let mut prepared = Vec::with_capacity(jobs.len());
    for (n, j) in jobs.iter().enumerate() {
        let info = media::inspect(&app.bins.ffprobe, &j.path)?;
        if !motion::engine_lens(&info, &j.lens) {
            prepared.push(None);
            continue;
        }
        let m = motion::motion_for(&app.dir("motion"), &app.bins.ffmpeg, &app.bins.ffprobe, &app.jobs, tag, gen, &info, &j.lens, &file_key(&j.path), |f| on(f * 0.02))?;
        if m.is_none() && motion::stab_of(&j.lens).mode != "off" {
            let w = format!("흔들림 정보가 없어 {} 번째 360 클립은 보정 없이 내보냈습니다", n + 1);
            app.log("export", &w);
            warnings.lock().push(w);
        }
        prepared.push(Some((info, m)));
    }
    let done: Mutex<Vec<f64>> = Mutex::new(vec![0.0; jobs.len()]);
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results: Mutex<Vec<Option<Result<std::path::PathBuf, String>>>> = Mutex::new((0..jobs.len()).map(|_| None).collect());
    let cache_dir = app.dir("engine-cache");
    let worker = || loop {
        let n = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if n >= jobs.len() {
            return;
        }
        let j = &jobs[n];
        let Some((info, m)) = &prepared[n] else { continue };
        let mut keys = j.keys.clone();
        keys.sort_by(|a, b| a.t.total_cmp(&b.t));
        let still = j.view.clone().unwrap_or(View { yaw: 0.0, pitch: 0.0, roll: 0.0, hfov: 100.0, dist: 0.0 });
        let hfov_min = keys.iter().map(|k| k.view.hfov).fold(if keys.is_empty() { still.hfov } else { f64::MAX }, f64::min);
        let dist_min = keys.iter().map(|k| k.view.dist).fold(if keys.is_empty() { still.dist } else { 1.0 }, f64::min);
        let lens_files = info.videos.first().map(|v| v.width).unwrap_or(info.width / 2);
        let how = motion::FlatOptions { lens_px: Some(motion::lens_px_for(stitch::params(&j.lens).fov, w, hfov_min, dist_min, lens_files)), gpu, lossless };
        // Prepared once: the engine asks for the view on every frame (clips may carry 20 000 keys).
        let curve = framing::Curve::new(&keys);
        let view_at = move |t: f64| if keys.len() >= 2 { curve.at(t) } else if keys.len() == 1 { framing::norm_view(&keys[0].view) } else { framing::norm_view(&still) };
        let share = j.dur.max(0.1) / total_frames;
        let report = |f: f64| {
            let mut d = done.lock();
            d[n] = f * share;
            on(0.02 + d.iter().sum::<f64>() * 0.98);
        };
        let key = hash(&serde_json::to_string(&json!({ "v": motion::ENGINE_VERSION, "path": j.path, "size": info.size, "lens": j.lens, "keys": j.keys, "view": j.view, "start": j.start, "dur": j.dur, "speed": j.speed, "w": w, "h": h })).unwrap_or_default());
        let cached = cache_dir.join(format!("{key:x}.mkv"));
        let result = if cached.is_file() {
            report(1.0);
            app.log("export", &format!("360 clip {n}: already made, reusing it"));
            Ok(cached)
        } else {
            let tmp = work.join(format!("360-{n}.mkv"));
            let t_clip = std::time::Instant::now();
            let first = motion::render_flat(&app.bins.ffmpeg, &app.jobs, tag, gen, info, &j.lens, m.as_ref(), j.start, j.dur, j.speed, w, h, &how, &view_at, &tmp, &report);
            let run = match first {
                Err(e) if how.gpu && e != CANCELLED => {
                    // The chip refuses now and then when it is busy: once more before giving it up.
                    app.log("export", &format!("{n}번 360 클립을 그래픽 칩으로 다시 시도합니다: {}", logs::tail_lines(&e, 1)));
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    motion::render_flat(&app.bins.ffmpeg, &app.jobs, tag, gen, info, &j.lens, m.as_ref(), j.start, j.dur, j.speed, w, h, &how, &view_at, &tmp, &report)
                }
                other => other,
            };
            let run = match run {
                Err(e) if how.gpu && e != CANCELLED => {
                    let w0 = format!("{n}번 360 클립을 그래픽 칩으로 풀지 못해 CPU로 다시 처리했습니다: {}", logs::tail_lines(&e, 2));
                    app.log("export", &w0);
                    warnings.lock().push(w0);
                    let soft = motion::FlatOptions { gpu: false, ..how.clone() };
                    motion::render_flat(&app.bins.ffmpeg, &app.jobs, tag, gen, info, &j.lens, m.as_ref(), j.start, j.dur, j.speed, w, h, &soft, &view_at, &tmp, &report)
                }
                other => other,
            };
            run.map(|_| {
                let took = t_clip.elapsed().as_secs_f64();
                app.log("export", &format!("360 clip {n}: source {:.2}+{:.2}s in {took:.1}s ({:.1} fps, lens {:?}, seam {})", j.start, j.dur, j.dur * info.fps / took.max(0.001), how.lens_px, if stitch::params(&j.lens).precise() { "flow" } else { "linear" }));
                // Kept for the next export with the same clip; the work folder goes away.
                if std::fs::rename(&tmp, &cached).is_ok() { cached } else { tmp }
            })
        };
        report(1.0);
        let stop = result.is_err();
        results.lock()[n] = Some(result);
        if stop {
            app.jobs.cancel(tag);
            return;
        }
    };
    std::thread::scope(|sc| {
        for _ in 0..workers {
            sc.spawn(&worker);
        }
    });
    prune_engine_cache(&cache_dir, 20 * 1024);
    let mut p2 = plan.clone();
    let results = results.into_inner();
    for (n, j) in jobs.iter().enumerate() {
        let out = match &results[n] {
            Some(Ok(p)) => p.clone(),
            Some(Err(e)) => return Err(e.clone()),
            None => continue,
        };
        let path = out.to_string_lossy().into_owned();
        let flat_tf = |t: &Option<render::Transform>| t.clone().map(|t| render::Transform { rotation: 0.0, crop_l: 0.0, crop_r: 0.0, crop_t: 0.0, crop_b: 0.0, ..t });
        if j.main {
            let s = &mut p2.segs[j.i];
            s.path = path;
            s.start = 0.0;
            s.lens = None;
            s.view = None;
            s.view_keys.clear();
            s.fit = "fill".into();
            s.transform = flat_tf(&s.transform);
        } else {
            let o = &mut p2.overlays[j.i];
            o.path = path;
            o.start = 0.0;
            o.lens = None;
            o.view = None;
            o.view_keys.clear();
            o.fit = "fill".into();
            o.transform = flat_tf(&o.transform);
        }
    }
    Ok(Some(p2))
}

/// Saves the captions as a subtitle file next to the exported video.
#[tauri::command]
fn save_srt(video: String, text: String) -> Result<String, String> {
    let p = Path::new(&video).with_extension("srt");
    std::fs::write(&p, format!("\u{feff}{text}")).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().into_owned())
}

/// 현재 화면을 사진으로 저장: a picture `frames` gave.
#[tauri::command]
fn save_base64(dest: String, b64: String) -> Result<(), String> {
    use base64::Engine;
    let b = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
    std::fs::write(&dest, b).map_err(|e| format!("{dest}: {e}"))
}

/// 대본 저장: with a BOM, so Notepad and Excel read the Korean.
#[tauri::command]
fn save_text(dest: String, text: String) -> Result<(), String> {
    std::fs::write(&dest, format!("\u{feff}{text}")).map_err(|e| format!("{dest}: {e}"))
}

#[tauri::command]
fn cancel(app: St<'_>, tag: String) -> u64 {
    app.jobs.cancel(&tag)
}

// ---------------------------------------------------------------- shell helpers

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        ff::command(Path::new("explorer.exe")).arg(format!("/select,{}", path)).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let dir = Path::new(&path).parent().map(|p| p.to_path_buf()).unwrap_or_default();
        std::process::Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn initial_files() -> Vec<String> {
    std::env::args().skip(1).filter(|a| !a.starts_with('-') && Path::new(a).exists()).collect()
}

/// Files handed over by later starts (Explorer starts the app once per selected file). They wait
/// here until the window takes them, so none is lost while it is still starting.
static OPEN_QUEUE: parking_lot::Mutex<Vec<String>> = parking_lot::const_mutex(Vec::new());

#[tauri::command]
fn take_open_files() -> Vec<String> {
    std::mem::take(&mut *OPEN_QUEUE.lock())
}

/// Calls the Claude Messages API from the native side (no browser CORS, the key stays out of
/// page requests). `body` is the request JSON; returns the response JSON or the API error text.
#[tauri::command]
async fn claude(key: String, body: Value, betas: Vec<String>) -> Result<Value, String> {
    blocking(move || {
        let agent = ureq::AgentBuilder::new().timeout_read(std::time::Duration::from_secs(900)).timeout_connect(std::time::Duration::from_secs(20)).build();
        let mut req = agent.post("https://api.anthropic.com/v1/messages").set("x-api-key", &key).set("anthropic-version", "2023-06-01").set("content-type", "application/json");
        if !betas.is_empty() {
            req = req.set("anthropic-beta", &betas.join(","));
        }
        match req.send_json(body) {
            Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(code, r)) => {
                let text = r.into_string().unwrap_or_default();
                Err(format!("HTTP {code}: {text}"))
            }
            Err(e) => Err(format!("연결 실패: {e}")),
        }
    })
    .await
}

/// Claude Code (signed in with the Claude plan): is it installed, who is signed in.
#[tauri::command]
async fn cc_status(app: St<'_>) -> Result<cc::Status, String> {
    let data = app.data_dir.clone();
    blocking(move || Ok(cc::status(&data))).await
}

#[tauri::command]
fn cc_login(app: St<'_>) -> Result<(), String> {
    cc::login(&app.data_dir)
}

/// Downloads Reelcut's own copy of Claude Code (job kind "cc-setup", id "claude").
#[tauri::command]
fn cc_setup(handle: tauri::AppHandle, app: St<'_>) -> Result<(), String> {
    let data = app.data_dir.clone();
    std::thread::spawn(move || {
        let h = handle.clone();
        let r = cc::download(&data, |pct, msg| emit(&h, "claude", "cc-setup", pct, "running", msg, Value::Null));
        match r {
            Ok(p) => emit(&handle, "claude", "cc-setup", 100.0, "done", "", json!({ "path": p })),
            Err(e) => emit(&handle, "claude", "cc-setup", 0.0, "error", &e, Value::Null),
        }
    });
    Ok(())
}

/// Starts one agent turn through Claude Code. Output lines arrive as "cc" events
/// ({kind:"line", data} … {kind:"exit", ok, err}); tool calls arrive as "cc-tool" events.
#[tauri::command]
fn cc_run(handle: tauri::AppHandle, app: St<'_>, model: String, effort: String, system: String, prompt: String, session: Option<String>, tools: Value) -> Result<(), String> {
    let st = app.inner().clone();
    st.cc.set_tools(&tools);
    let workdir = st.data_dir.join("agent");
    std::thread::spawn(move || {
        let h2 = handle.clone();
        let mut seen = session.clone();
        let r = cc::run(&st.cc, cc::Turn { model, effort, system, prompt, session, workdir, data: st.data_dir.clone() }, |v| {
            if let Some(id) = v["session_id"].as_str() {
                seen = Some(id.to_string());
            }
            let _ = h2.emit("cc", json!({ "kind": "line", "data": v }));
        });
        if let Some(id) = seen {
            if let Err(e) = cc::archive_session(&st.data_dir, &id) {
                st.log("archive", &format!("{id}: {e}"));
            }
        }
        let (ok, err) = match r {
            Ok(x) => x,
            Err(e) => (false, e),
        };
        let _ = handle.emit("cc", json!({ "kind": "exit", "ok": ok, "err": err }));
    });
    Ok(())
}

#[tauri::command]
fn cc_answer(app: St<'_>, id: String, result: Value) -> bool {
    app.cc.answer(&id, result)
}

#[tauri::command]
fn cc_stop(app: St<'_>) -> bool {
    app.cc.stop()
}

/// Where projects, settings and speech models live: REELCUT_DATA, else the folder named in
/// `<app data>/data-dir.txt` (set from 설정), else the app data folder itself.
fn resolve_data_dir(home: &Path) -> PathBuf {
    if let Ok(p) = std::env::var("REELCUT_DATA") {
        let p = PathBuf::from(p.trim());
        if p.is_dir() {
            return p;
        }
    }
    if let Ok(t) = std::fs::read_to_string(home.join("data-dir.txt")) {
        let p = PathBuf::from(t.trim());
        if !t.trim().is_empty() && p.is_dir() {
            return p;
        }
    }
    home.to_path_buf()
}

/// Points the app at another data folder ("" = back to the default) and restarts it.
#[tauri::command]
fn set_data_dir(handle: tauri::AppHandle, path: String) -> Result<(), String> {
    let home = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    if !path.trim().is_empty() && !Path::new(path.trim()).is_dir() {
        return Err("폴더가 없습니다".into());
    }
    std::fs::write(home.join("data-dir.txt"), path.trim()).map_err(|e| e.to_string())?;
    handle.restart();
}

pub fn run() {
    tauri::Builder::default()
        // A second start (a .reelcut or video opened from Explorer) hands its files to this window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            let files: Vec<String> = argv.into_iter().skip(1).filter(|a| !a.starts_with('-') && Path::new(a).exists()).collect();
            if !files.is_empty() {
                OPEN_QUEUE.lock().extend(files);
                let _ = app.emit("open-files", ());
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let res = app.path().resource_dir().ok();
            let home = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("reelcut"));
            let data_dir = resolve_data_dir(&home);
            logs::init(&data_dir);
            let cache_dir = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir().join("reelcut-cache"));
            let _ = std::fs::create_dir_all(&data_dir);
            let _ = std::fs::create_dir_all(&cache_dir);
            let bridge = cc::Bridge::start().expect("local agent bridge");
            let h = app.handle().clone();
            bridge.set_sink(Arc::new(move |id, name, input| {
                let _ = h.emit("cc-tool", json!({ "id": id, "name": name, "input": input }));
            }));
            let bins = ff::locate(res.as_deref());
            let live = live::Live::start(bins.ffmpeg.clone()).expect("local preview server");
            let st = Arc::new(App { bins, data_dir, cache_dir, hw: Mutex::new(None), jobs: Jobs::default(), cc: bridge, live, faces: faces::Detector::default() });
            // Detect encoders in the background so the first export does not wait for it.
            let st2 = st.clone();
            std::thread::spawn(move || {
                let hw = st2.hw();
                st2.live.set_qsv(hw.tested.iter().any(|(n, ok)| n.ends_with("_qsv") && *ok));
                // 2.5.0 dropped preview copies (proxies): clear the ones older versions made.
                for d in [st2.cache_dir.join("proxies"), st2.data_dir.join("proxies")] {
                    if d.is_dir() {
                        let _ = std::fs::remove_dir_all(&d);
                    }
                }
            });
            app.manage(st);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            motion_info,
            motion_track,
            app_info,
            qwen_status,
            set_data_dir,
            qwen_setup,
            hw_info,
            store_get,
            store_set,
            store_delete,
            trash_list,
            trash_restore,
            log_event,
            store_list,
            expand_paths,
            inspect,
            analyze_motion,
            live_url,
            eq_sheet,
            sync_audio,
            auto_color,
            save_srt,
            scan_shots,
            find_faces,
            scan_gaze,
            measure,
            diag_parity,
            loudness,
            script_files,
            dir_exists,
            track_people,
            face_check,
            live_stop,
            calibrate_360,
            filmstrip,
            poster,
            waveform,
            frames,
            contact_sheet,
            whisper_models,
            download_model,
            transcribe,
            export,
            cancel,
            reveal,
            path_exists,
            initial_files,
            take_open_files,
            claude,
            cc_status,
            cc_login,
            cc_setup,
            cc_run,
            cc_answer,
            cc_stop,
            jsonl::jsonl_append,
            jsonl::jsonl_tail,
            project::project_save,
            project::project_open,
            project::project_info,
            live_sharp,
            save_base64,
            save_text,
            project::project_root,
            project::project_pack,
            project::project_unpack,
            project::project_unpack_drop,
            project::diag_bundle,
            project::project_set_root,
            project::project_backup,
            project::project_backups,
            project::project_backup_read,
            project::project_migrate,
            project::project_trash,
            project::project_copy_logs,
            project::relink_search_cmd,
            project::paths_exist,
            project::project_file_in,
            recover::recover_scan,
            recover::recover_chats
        ])
        .run(tauri::generate_context!())
        .expect("error while running reelcut");
}
