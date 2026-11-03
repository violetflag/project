//! Media the editor can hold: what a file is (plain video, audio, still, or a 360 recording such
//! as DJI Osmo 360 `.osv`/`.lrf`), filmstrips, waveforms and frames for the AI agent. The
//! preview plays the files themselves (an .osv through its .lrf); nothing is transcoded for it.

use crate::ff;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const VIDEO_EXT: [&str; 20] = ["mp4", "mov", "m4v", "mkv", "webm", "avi", "mts", "m2ts", "ts", "mxf", "wmv", "flv", "3gp", "mpg", "mpeg", "osv", "lrf", "insv", "lrv", "360"];
pub const AUDIO_EXT: [&str; 9] = ["wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "aif", "aiff"];
pub const IMAGE_EXT: [&str; 6] = ["jpg", "jpeg", "png", "webp", "bmp", "gif"];

pub fn ext_of(path: &str) -> String {
    Path::new(path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

pub fn is_media(path: &Path) -> bool {
    let e = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    VIDEO_EXT.contains(&e.as_str()) || AUDIO_EXT.contains(&e.as_str()) || IMAGE_EXT.contains(&e.as_str())
}

/// Files under `paths` (files kept as they are, folders walked) that look like media, skipping
/// hidden entries. Sorted by path inside each folder.
pub fn expand(paths: &[String]) -> Vec<(String, String)> {
    // (file, folder it was found under relative to the dropped folder, "" for top level)
    let mut out = Vec::new();
    fn walk(dir: &Path, rel: &str, out: &mut Vec<(String, String)>, depth: u32) {
        if depth > 8 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                walk(&p, &r, out, depth + 1);
            } else if is_media(&p) {
                out.push((p.to_string_lossy().into_owned(), rel.to_string()));
            }
        }
    }
    for p in paths {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            let name = pb.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            walk(&pb, &name, &mut out, 0);
        } else if is_media(&pb) {
            out.push((p.clone(), String::new()));
        }
    }
    out
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct VStream {
    pub index: u32,
    pub width: u32,
    pub height: u32,
    pub codec: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct MediaInfo {
    pub path: String,
    pub name: String,
    pub ext: String,
    /// video | audio | image
    pub kind: String,
    pub size: u64,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub vcodec: String,
    pub acodec: String,
    pub channels: u32,
    pub has_audio: bool,
    pub videos: Vec<VStream>,
    /// DJI metadata track (gyro/attitude) present.
    pub djmd: bool,
    /// none | dual (two fisheye tracks, Osmo 360 .osv) | dfisheye (two fisheyes side by side,
    /// .lrf) | equirect
    pub layout360: String,
    /// The low-resolution DJI companion file (same name, .lrf) when there is one.
    pub lrf: Option<String>,
    pub created: u64,
    /// Recording time from the container (creation_time), ISO text.
    pub recorded: String,
    pub bit_depth: u32,
}

fn st(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn num<T: std::str::FromStr>(v: &Value, k: &str) -> Option<T> {
    match v.get(k)? {
        Value::String(x) => x.parse().ok(),
        Value::Number(n) => n.to_string().parse().ok(),
        _ => None,
    }
}

/// The DJI low-res companion: CAM_..._0007_D.OSV ↔ CAM_..._0007_D.LRF in the same folder.
pub fn companion_lrf(path: &str) -> Option<String> {
    let p = Path::new(path);
    let stem = p.file_stem()?.to_string_lossy().to_lowercase();
    let dir = p.parent()?;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let q = e.path();
        let ext = q.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        if (ext == "lrf" || ext == "lrv") && q.file_stem().map(|s| s.to_string_lossy().to_lowercase()) == Some(stem.clone()) {
            return Some(q.to_string_lossy().into_owned());
        }
    }
    None
}

pub fn inspect(ffprobe: &Path, path: &str) -> Result<MediaInfo, String> {
    let args: Vec<String> = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path].iter().map(|x| x.to_string()).collect();
    let (ok, out, err) = ff::output(ffprobe, &args)?;
    if !ok {
        return Err(format!("파일을 읽을 수 없습니다: {}", err.trim()));
    }
    let j: Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let streams = j.get("streams").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let fmt = j.get("format").cloned().unwrap_or(Value::Null);
    let ext = ext_of(path);
    let mut m = MediaInfo {
        path: path.to_string(),
        name: Path::new(path).file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default(),
        ext: ext.clone(),
        size: num::<u64>(&fmt, "size").or_else(|| std::fs::metadata(path).ok().map(|m| m.len())).unwrap_or(0),
        duration: num::<f64>(&fmt, "duration").unwrap_or(0.0),
        layout360: "none".into(),
        recorded: fmt.pointer("/tags/creation_time").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        created: std::fs::metadata(path).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0),
        bit_depth: 8,
        ..Default::default()
    };
    let mut first_video: Option<&Value> = None;
    for s in &streams {
        let ctype = st(s, "codec_type");
        let tag = st(s, "codec_tag_string");
        if tag == "djmd" || st(s, "codec_name") == "djmd" {
            m.djmd = true;
        }
        if s.pointer("/tags/handler_name").and_then(|x| x.as_str()).is_some_and(|h| h.to_lowercase().contains("dji meta")) {
            m.djmd = true;
        }
        if ctype == "video" && s.pointer("/disposition/attached_pic").and_then(|x| x.as_i64()).unwrap_or(0) == 0 && st(s, "codec_name") != "mjpeg" {
            m.videos.push(VStream { index: num(s, "index").unwrap_or(0), width: num(s, "width").unwrap_or(0), height: num(s, "height").unwrap_or(0), codec: st(s, "codec_name") });
            if first_video.is_none() {
                first_video = Some(s);
            }
        }
        if ctype == "audio" && !m.has_audio {
            m.has_audio = true;
            m.acodec = st(s, "codec_name");
            m.channels = num(s, "channels").unwrap_or(2);
        }
    }
    let image = IMAGE_EXT.contains(&ext.as_str());
    if let Some(v) = first_video {
        m.kind = if image { "image".into() } else { "video".into() };
        m.width = num(v, "width").unwrap_or(0);
        m.height = num(v, "height").unwrap_or(0);
        let rot = v
            .get("side_data_list")
            .and_then(|x| x.as_array())
            .and_then(|l| l.iter().find_map(|d| d.get("rotation").and_then(|r| r.as_f64())))
            .unwrap_or(0.0);
        if (rot.abs() as i64) % 180 == 90 {
            std::mem::swap(&mut m.width, &mut m.height);
        }
        let fr = st(v, "avg_frame_rate");
        let fr = if fr == "0/0" || fr.is_empty() { st(v, "r_frame_rate") } else { fr };
        m.fps = fr.split_once('/').and_then(|(a, b)| Some(a.parse::<f64>().ok()? / b.parse::<f64>().ok().filter(|b| *b > 0.0)?)).unwrap_or(30.0);
        m.vcodec = st(v, "codec_name");
        let pf = st(v, "pix_fmt");
        m.bit_depth = crate::probe::bit_depth_of(&pf, num(v, "bits_per_raw_sample"));
        let spherical = v
            .get("side_data_list")
            .and_then(|x| x.as_array())
            .is_some_and(|l| l.iter().any(|d| d.get("projection").and_then(|p| p.as_str()).is_some_and(|p| p.contains("equirect"))));
        let two_to_one = m.width == m.height * 2;
        let dji360_ext = ["osv", "insv", "lrf", "lrv", "360"].contains(&ext.as_str());
        m.layout360 = if m.videos.len() >= 2 && m.videos[0].width == m.videos[1].width && m.videos[0].height == m.videos[1].height && (dji360_ext || m.djmd) && m.videos[0].width.abs_diff(m.videos[0].height) * 10 < m.videos[0].width {
            "dual".into()
        } else if spherical {
            "equirect".into()
        } else if two_to_one && dji360_ext {
            "dfisheye".into()
        } else {
            "none".into()
        };
        if m.layout360 == "dual" {
            m.width = m.videos[0].width * 2;
            m.height = m.videos[0].height;
        }
        if image {
            m.duration = 5.0;
        }
    } else if m.has_audio {
        m.kind = "audio".into();
    } else {
        return Err("영상이나 소리가 없는 파일입니다.".into());
    }
    if m.duration <= 0.0 && m.kind != "image" {
        return Err("길이를 알 수 없는 파일입니다.".into());
    }
    if ["osv", "insv", "360"].contains(&ext.as_str()) {
        m.lrf = companion_lrf(path);
    }
    Ok(m)
}

fn s(a: &[&str]) -> Vec<String> {
    a.iter().map(|x| x.to_string()).collect()
}

/// How a 360 recording is turned into pictures.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Lens {
    /// none | dual | dfisheye | equirect
    pub layout: String,
    /// The two lenses in the other order.
    #[serde(default)]
    pub swap: bool,
    /// Each fisheye's field of view in degrees (Osmo 360 about 190).
    #[serde(default = "lens_fov")]
    pub fov: f64,
    /// Seam stitching of the two lenses (on by default; see `stitch`).
    #[serde(default)]
    pub stitch: Option<crate::stitch::Stitch>,
    /// Stabilisation (horizon lock by default; see `motion`).
    #[serde(default)]
    pub stab: Option<crate::motion::Stab>,
}
fn lens_fov() -> f64 {
    190.0
}

/// The filter that makes one side-by-side dual-fisheye (or equirect) picture `[name]` from input
/// `i`, before v360. For `dual` the two tracks are stacked; `swap` exchanges the lenses.
pub fn lens_source(i: usize, lens: &Lens, scale_each: Option<u32>, name: &str) -> String {
    let sc = |l: &str| scale_each.map(|w| format!("[{l}]scale={w}:{w}[{l}s];")).unwrap_or_default();
    match lens.layout.as_str() {
        "dual" => {
            let (a, b) = if lens.swap { (1, 0) } else { (0, 1) };
            if let Some(w) = scale_each {
                format!("[{i}:v:{a}]scale={w}:{w}[{name}a];[{i}:v:{b}]scale={w}:{w}[{name}b];[{name}a][{name}b]hstack[{name}]")
            } else {
                let _ = sc;
                format!("[{i}:v:{a}][{i}:v:{b}]hstack[{name}]")
            }
        }
        "dfisheye" if lens.swap => format!("[{i}:v:0]split[{name}l][{name}r];[{name}l]crop=iw/2:ih:0:0[{name}a];[{name}r]crop=iw/2:ih:iw/2:0[{name}b];[{name}b][{name}a]hstack[{name}]"),
        _ => format!("[{i}:v:0]null[{name}]"),
    }
}

/// v360 input options for a lens.
pub fn v360_in(lens: &Lens) -> String {
    match lens.layout.as_str() {
        "equirect" => "input=equirect".into(),
        _ => format!("input=dfisheye:ih_fov={0}:iv_fov={0}", lens.fov),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct View {
    pub yaw: f64,
    pub pitch: f64,
    pub roll: f64,
    /// Horizontal field of view of the flat picture, degrees.
    pub hfov: f64,
}

/// v360 to a flat w×h picture looking along `view` (normalised first: v360 refuses a yaw of 195).
pub fn v360_flat(lens: &Lens, view: &View, w: u32, h: u32) -> String {
    let v = crate::framing::norm_view(view);
    let hf = v.hfov;
    let vf = 2.0 * ((hf.to_radians() / 2.0).tan() * h as f64 / w as f64).atan().to_degrees();
    format!("v360={}:output=flat:h_fov={hf:.3}:v_fov={vf:.3}:yaw={:.3}:pitch={:.3}:roll={:.3}:w={w}:h={h}:interp=lanczos", v360_in(lens), v.yaw, v.pitch, v.roll)
}

/// A strip of `count` small frames side by side (for timeline clips).
pub fn filmstrip(ffmpeg: &Path, path: &str, duration: f64, count: u32, out: &Path) -> Result<(), String> {
    let count = count.clamp(1, 60);
    let every = (duration / count as f64).max(0.05);
    let mut a = s(&["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-skip_frame", "nokey", "-i", path, "-vf"]);
    a.push(format!("fps=1/{every:.3},scale=160:90:force_original_aspect_ratio=increase,crop=160:90,tile={count}x1"));
    a.extend(s(&["-frames:v", "1", "-q:v", "5"]));
    a.push(out.to_string_lossy().into_owned());
    let (ok, _, err) = ff::output(ffmpeg, &a)?;
    if !ok || !out.exists() {
        // -skip_frame nokey can starve short clips of frames; retry decoding every frame.
        a.retain(|x| x != "-skip_frame" && x != "nokey");
        let (ok2, _, err2) = ff::output(ffmpeg, &a)?;
        if !ok2 {
            return Err(format!("{err}\n{err2}"));
        }
    }
    Ok(())
}

/// Loudness peaks, 50 per second, 0–255, from the first audio track.
pub fn waveform(ffmpeg: &Path, path: &str) -> Result<Vec<u8>, String> {
    let a = s(&["-hide_banner", "-nostdin", "-loglevel", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "4000", "-f", "s16le", "-"]);
    let o = ff::command(ffmpeg).args(&a).stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
    let samples: Vec<i16> = o.stdout.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
    let mut peaks = Vec::with_capacity(samples.len() / 80 + 1);
    for chunk in samples.chunks(80) {
        let m = chunk.iter().map(|x| (*x as i32).unsigned_abs()).max().unwrap_or(0) as f64 / 32768.0;
        // dB-ish curve so quiet speech still shows
        let db = if m <= 1e-5 { -100.0 } else { 20.0 * m.log10() };
        let v = ((db + 60.0) / 60.0).clamp(0.0, 1.0);
        peaks.push((v * 255.0).round() as u8);
    }
    Ok(peaks)
}

#[derive(Clone, Debug, Deserialize)]
pub struct FrameReq {
    pub path: String,
    pub times: Vec<f64>,
    #[serde(default)]
    pub width: Option<u32>,
    /// For a 360 file: look along this view instead of showing the raw picture.
    #[serde(default)]
    pub view: Option<View>,
    /// How that 360 file is laid out (equirect when missing).
    #[serde(default)]
    pub lens: Option<Lens>,
}

pub fn jpeg_b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// JPEG frames (base64) at the given times.
pub fn frames(ffmpeg: &Path, req: &FrameReq) -> Result<Vec<String>, String> {
    let w = req.width.unwrap_or(768).clamp(64, 1920);
    let mut out = Vec::new();
    // A 360 view: the lenses put side by side (two tracks of an .osv are stacked), then v360.
    let graph = req.view.as_ref().map(|v| {
        let lens = req.lens.clone().filter(|l| !l.layout.is_empty() && l.layout != "none").unwrap_or(Lens { layout: "equirect".into(), swap: false, fov: 360.0, stitch: None, stab: None });
        let h = (w as f64 * 9.0 / 16.0).round() as u32 / 2 * 2;
        format!("{};[s]{}[o]", lens_source(0, &lens, None, "s"), v360_flat(&lens, v, w, h))
    });
    for &t in req.times.iter().take(16) {
        let mut a = s(&["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", &format!("{:.3}", t.max(0.0)), "-i", &req.path, "-frames:v", "1"]);
        match &graph {
            Some(g) => a.extend(s(&["-filter_complex", g, "-map", "[o]"])),
            None => a.extend(s(&["-vf", &format!("scale={w}:-2")])),
        }
        a.extend(s(&["-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "-"]));
        let o = ff::command(ffmpeg).args(&a).stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
        if o.stdout.is_empty() {
            return Err(format!("{t:.1}초 장면을 읽지 못했습니다: {}", String::from_utf8_lossy(&o.stderr).trim()));
        }
        out.push(jpeg_b64(&o.stdout));
    }
    Ok(out)
}

/// The grid drawn over a level panorama: lines every 1/8 of the width (120 px of a 960 scale,
/// labelled 0–960), every 1/4 of the height (120 px of 480) with the horizon (240) in red, and
/// the time.
pub fn eq_grid(t: f64) -> String {
    let font = if cfg!(windows) { "fontfile='C\\:/Windows/Fonts/arial.ttf':" } else { "" };
    let mut f = vec!["drawgrid=w=iw/8:h=ih/4:t=1:c=yellow@0.7".to_string(), "drawbox=x=0:y=ih/2-1:w=iw:h=3:c=red@0.9:t=fill".to_string()];
    for k in 0..=8 {
        let x = if k == 8 { "w-tw-3".to_string() } else { format!("{k}*w/8+3") };
        f.push(format!("drawtext={font}text='{}':x={x}:y=4:fontsize=h/26:fontcolor=yellow:box=1:boxcolor=black@0.55", k * 120));
    }
    for (k, label) in [(1, "120"), (2, "240"), (3, "360")] {
        f.push(format!("drawtext={font}text='{label}':x=3:y={k}*h/4+3:fontsize=h/30:fontcolor=yellow:box=1:boxcolor=black@0.55"));
    }
    f.push(format!("drawtext={font}text='t={t:.1}s':x=w-tw-6:y=h-th-6:fontsize=h/22:fontcolor=white:box=1:boxcolor=black@0.6"));
    f.join(",")
}

/// Level panoramas without the engine (an equirect file, or stitching turned off): ffmpeg's v360
/// from the lenses as filmed. One JPEG per time.
pub fn equirect_stills(ffmpeg: &Path, info: &MediaInfo, lens: &Lens, times: &[f64], w: u32, vf: &dyn Fn(f64) -> String, out_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let h = (w / 2) & !1;
    let mut outs = Vec::new();
    for (i, &t) in times.iter().enumerate() {
        let out = out_dir.join(format!("eq-{i}.jpg"));
        let conv = if lens.layout == "equirect" { format!("scale={w}:{h}") } else { format!("v360={}:output=equirect:w={w}:h={h}", v360_in(lens)) };
        let g = format!("{};[s]{conv},{}[o]", lens_source(0, lens, None, "s"), vf(t));
        let a = s(&["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-ss", &format!("{:.3}", t.max(0.0)), "-i", &info.path, "-filter_complex", &g, "-map", "[o]", "-frames:v", "1", "-q:v", "3", &out.to_string_lossy()]);
        let (ok, _, err) = ff::output(ffmpeg, &a)?;
        if !ok || !out.is_file() {
            return Err(format!("{t:.1}초 장면을 만들지 못했습니다: {}", err.trim()));
        }
        outs.push(out);
    }
    Ok(outs)
}

/// One image with tiles every `every` seconds (cols × rows), with the time burned into each tile.
pub fn contact_sheet(ffmpeg: &Path, path: &str, start: f64, every: f64, cols: u32, rows: u32, tile_w: u32) -> Result<String, String> {
    let n = cols * rows;
    let font = if cfg!(windows) { "fontfile='C\\:/Windows/Fonts/arial.ttf':" } else { "" };
    let vf = format!(
        "fps=1/{every:.3},scale={tile_w}:-2,drawtext={font}text='%{{pts\\:hms}}':x=4:y=4:fontsize=14:fontcolor=white:box=1:boxcolor=black@0.6,tile={cols}x{rows}"
    );
    let a = s(&["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", &format!("{start:.3}"), "-copyts", "-i", path, "-vf", &vf, "-frames:v", "1", "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "-"]);
    let _ = n;
    let o = ff::command(ffmpeg).args(&a).stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
    if o.stdout.is_empty() {
        // drawtext may be missing from the build; try without the time stamps.
        let vf2 = format!("fps=1/{every:.3},scale={tile_w}:-2,tile={cols}x{rows}");
        let a2 = s(&["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", &format!("{start:.3}"), "-i", path, "-vf", &vf2, "-frames:v", "1", "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "-"]);
        let o2 = ff::command(ffmpeg).args(&a2).stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
        if o2.stdout.is_empty() {
            return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
        }
        return Ok(jpeg_b64(&o2.stdout));
    }
    Ok(jpeg_b64(&o.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_view_args() {
        let f = v360_flat(&Lens { layout: "dfisheye".into(), swap: false, fov: 190.0, stitch: None, stab: None }, &View { yaw: 30.0, pitch: -10.0, roll: 0.0, hfov: 90.0 }, 1920, 1080);
        assert!(f.starts_with("v360=input=dfisheye:ih_fov=190:iv_fov=190:output=flat:h_fov=90.000:v_fov=58.716"), "{f}");
        assert!(f.contains("yaw=30.000:pitch=-10.000"));
    }

    #[test]
    fn views_out_of_range_are_normalised() {
        let l = Lens { layout: "dfisheye".into(), swap: false, fov: 190.0, stitch: None, stab: None };
        for (yaw, want) in [(195.0, "yaw=-165.000"), (-190.0, "yaw=170.000"), (540.0, "yaw=180.000")] {
            let f = v360_flat(&l, &View { yaw, pitch: 120.0, roll: 365.0, hfov: 400.0 }, 1280, 720);
            assert!(f.contains(want) && f.contains("pitch=89.000") && f.contains("roll=5.000") && f.contains("h_fov=160.000"), "{f}");
        }
    }

    #[test]
    fn dual_source_swaps() {
        let l = Lens { layout: "dual".into(), swap: true, fov: 190.0, stitch: None, stab: None };
        assert_eq!(lens_source(2, &l, None, "x"), "[2:v:1][2:v:0]hstack[x]");
    }
}
