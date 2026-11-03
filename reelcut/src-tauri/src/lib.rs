mod args;
mod cc;
mod ff;
mod framing;
mod hw;
mod live;
mod media;
mod probe;
mod qwen;
mod render;
mod stitch;
mod pano;
mod motion;
mod transcribe;
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

#[tauri::command]
fn store_set(app: St<'_>, name: String, value: String) -> Result<(), String> {
    let dir = app.store_dir();
    let p = dir.join(format!("{}.json", safe_name(&name)?));
    let tmp = dir.join(format!("{}.json.tmp", name));
    std::fs::write(&tmp, value).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
fn store_delete(app: St<'_>, name: String) -> Result<(), String> {
    let p = app.store_dir().join(format!("{}.json", safe_name(&name)?));
    if p.exists() {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
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

/// What the stabilisation found for a recording (gyro or picture), once analysed.
#[tauri::command]
fn motion_info(app: St<'_>, path: String) -> Option<Value> {
    let t = std::fs::read_to_string(app.dir("motion").join(format!("{}-m1.json", file_key(&path)))).ok()?;
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

/// The address of a live preview stream or still frame (see `live`) for a file the WebView cannot play.
#[tauri::command]
fn live_url(app: St<'_>, req: live::Req) -> String {
    app.live.url(req)
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

#[tauri::command]
async fn waveform(app: St<'_>, path: String) -> Result<Vec<u8>, String> {
    let app = app.inner().clone();
    blocking(move || {
        let out = app.dir("waves").join(format!("{}.bin", file_key(&path)));
        if let Ok(b) = std::fs::read(&out) {
            return Ok(b);
        }
        let w = media::waveform(&app.bins.ffmpeg, &path)?;
        let _ = std::fs::write(&out, &w);
        Ok(w)
    })
    .await
}

#[tauri::command]
async fn frames(app: St<'_>, req: FrameReq) -> Result<Vec<String>, String> {
    let app = app.inner().clone();
    blocking(move || media::frames(&app.bins.ffmpeg, &req)).await
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
    let out2 = out.clone();
    let n360 = plan.segs.iter().map(|s| (&s.kind, &s.lens)).chain(plan.overlays.iter().map(|o| (&o.kind, &o.lens))).filter(|(k, l)| k.as_str() == "video" && l.as_ref().map(|l| matches!(l.layout.as_str(), "dual" | "dfisheye") && stitch::active(l)).unwrap_or(false)).count();
    std::thread::spawn(move || {
        let mut built = built;
        let t0 = std::time::Instant::now();
        // 360 clips first go through Reelcut's 360 engine (seam per frame, stabilisation) into
        // flat pictures; the main render then treats them as ordinary clips.
        let (pre_w, pre_end) = if n360 > 0 { (60.0, 60.0) } else { (0.0, 0.0) };
        if n360 > 0 {
            match engine_prepass(&app, &tag, gen, &plan, &work, |f| emit(&handle, &id, "export", f * pre_w, "running", "-1", json!({ "stage": "360" }))) {
                Ok(Some(p2)) => match render::build(&p2, &hw, &graph_file.to_string_lossy(), app.ffmpeg_major() >= 7, has_ass, &part).and_then(|b| std::fs::write(&graph_file, &b.graph).map(|_| b).map_err(|e| e.to_string())) {
                    Ok(b) => built = b,
                    Err(e) => eprintln!("360 engine render plan failed, using the ffmpeg stitch: {e}"),
                },
                Ok(None) => {}
                Err(e) if e == CANCELLED => {
                    let _ = std::fs::remove_dir_all(&work);
                    emit(&handle, &id, "export", 0.0, "cancelled", &e, Value::Null);
                    return;
                }
                Err(e) => eprintln!("360 engine failed, using the ffmpeg stitch: {e}"),
            }
        }
        let dur = built.duration.max(0.1);
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
                let warn = match &check {
                    Some(c) if (c.duration - dur).abs() > 1.0 => format!("결과 길이({:.1}초)가 예상({:.1}초)과 다릅니다", c.duration, dur),
                    None => "결과 파일을 다시 읽지 못했습니다".into(),
                    _ => String::new(),
                };
                emit(&handle, &id, "export", 100.0, "done", &warn, json!({ "path": out2, "size": size, "seconds": t0.elapsed().as_secs_f64(), "duration": dur }));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                emit(&handle, &id, "export", 0.0, if e == CANCELLED { "cancelled" } else { "error" }, &e, Value::Null);
            }
        }
        let _ = std::fs::remove_dir_all(&work);
    });
    Ok(out)
}

/// Renders every 360 clip of the plan (main track and overlays) flat through the engine and
/// returns the plan with those clips pointing at the results; None when nothing needed it.
fn engine_prepass(app: &App, tag: &str, gen: u64, plan: &render::Plan, work: &Path, on: impl Fn(f64)) -> Result<Option<render::Plan>, String> {
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
    let total: f64 = jobs.iter().map(|j| j.dur.max(0.1)).sum();
    let mut done = 0.0;
    let mut p2 = plan.clone();
    let (w, h) = (plan.width.max(16) & !1, plan.height.max(16) & !1);
    for (n, j) in jobs.iter().enumerate() {
        let info = media::inspect(&app.bins.ffprobe, &j.path)?;
        if !motion::engine_lens(&info, &j.lens) {
            continue;
        }
        let share = j.dur.max(0.1) / total;
        // Analysis (only the first time for a recording) counts as a fifth of the clip's share.
        let m = motion::motion_for(&app.dir("motion"), &app.bins.ffmpeg, &app.bins.ffprobe, &app.jobs, tag, gen, &info, &j.lens, &file_key(&j.path), |f| on((done + f * share * 0.2) / 1.0))?;
        let mut keys = j.keys.clone();
        keys.sort_by(|a, b| a.t.total_cmp(&b.t));
        let still = j.view.clone().unwrap_or(View { yaw: 0.0, pitch: 0.0, roll: 0.0, hfov: 100.0 });
        // Prepared once: the engine asks for the view on every frame (clips may carry 20 000 keys).
        let curve = framing::Curve::new(&keys);
        let view_at = move |t: f64| if keys.len() >= 2 { curve.at(t) } else if keys.len() == 1 { framing::norm_view(&keys[0].view) } else { framing::norm_view(&still) };
        let out = work.join(format!("360-{n}.mkv"));
        let base = done + share * 0.2;
        motion::render_flat(&app.bins.ffmpeg, &app.jobs, tag, gen, &info, &j.lens, m.as_ref(), j.start, j.dur, j.speed, w, h, &view_at, &out, |f| on(base + f * share * 0.8))?;
        done += share;
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
        let r = cc::run(&st.cc, cc::Turn { model, effort, system, prompt, session, workdir, data: st.data_dir.clone() }, |v| {
            let _ = h2.emit("cc", json!({ "kind": "line", "data": v }));
        });
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let res = app.path().resource_dir().ok();
            let home = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("reelcut"));
            let data_dir = resolve_data_dir(&home);
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
            let st = Arc::new(App { bins, data_dir, cache_dir, hw: Mutex::new(None), jobs: Jobs::default(), cc: bridge, live });
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
            app_info,
            qwen_status,
            set_data_dir,
            qwen_setup,
            hw_info,
            store_get,
            store_set,
            store_delete,
            store_list,
            expand_paths,
            inspect,
            analyze_motion,
            live_url,
            eq_sheet,
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
            claude,
            cc_status,
            cc_login,
            cc_setup,
            cc_run,
            cc_answer,
            cc_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running reelcut");
}
