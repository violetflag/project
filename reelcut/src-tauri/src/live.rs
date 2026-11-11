//! Live preview for files the WebView cannot play itself: an Osmo 360 `.osv` (two HEVC lens
//! tracks), 10-bit HEVC, ProRes and the like. Like DJI Studio's own player, nothing is made ahead:
//! the bundled ffmpeg decodes the original from the asked time and lays a stitched 360 recording's two
//! lenses side by side (the viewer's shader joins them with the export's lens values and seam), encodes
//! low-latency H.264 as fragmented MP4 and streams it from a local HTTP server the viewer's video
//! element plays. While paused, single frames come as JPEG. ffmpeg runs only
//! while something is being looked at, and nothing is written to disk (recent frames stay in memory).

use crate::ff;
use crate::media::{self, Lens, MediaInfo};
use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// What the viewer asks for: a stream from `t` (seconds in the file) or one frame at `t`.
#[derive(Clone, Debug, Deserialize)]
pub struct Req {
    /// Which picture this is for ("main" = the viewer); a new request ends the slot's old ffmpeg.
    pub slot: String,
    pub info: MediaInfo,
    #[serde(default)]
    pub lens: Option<Lens>,
    pub t: f64,
    /// stream | frame
    pub kind: String,
    /// Playback speed for a stream (ffmpeg reads the file this much faster than real time).
    #[serde(default)]
    pub rate: Option<f64>,
}

pub struct Live {
    pub port: u16,
    ffmpeg: PathBuf,
    next: Mutex<u64>,
    reqs: Mutex<VecDeque<(String, Req)>>,
    /// The ffmpeg serving each slot (generation, process).
    slots: Mutex<HashMap<String, (u64, Child)>>,
    frames: Mutex<VecDeque<(String, Arc<Vec<u8>>)>>,
    /// Intel Quick Sync works here: an .osv's two 4K HEVC tracks are decoded and shrunk on the GPU
    /// (software decoding of a real Osmo 360 file barely keeps up with real time).
    qsv: AtomicBool,
    /// 미리보기 선명하게: a larger stitched sphere (still real time on John's PC: 56 pictures a
    /// second at 6 cores against 65 at 3).
    sharp: AtomicBool,
}

const KEEP_REQS: usize = 64;
const KEEP_FRAMES: usize = 48;

impl Live {
    /// Starts the server on a free local port.
    pub fn start(ffmpeg: PathBuf) -> std::io::Result<Arc<Live>> {
        let l = TcpListener::bind("127.0.0.1:0")?;
        let live = Arc::new(Live { port: l.local_addr()?.port(), ffmpeg, next: Mutex::new(1), reqs: Mutex::default(), slots: Mutex::default(), frames: Mutex::default(), qsv: AtomicBool::new(false) , sharp: AtomicBool::new(true) });
        let me = live.clone();
        std::thread::spawn(move || {
            for c in l.incoming().flatten() {
                let me = me.clone();
                std::thread::spawn(move || me.serve(c));
            }
        });
        Ok(live)
    }

    /// Whether streams may decode with Quick Sync (set once the encoders have been tested).
    pub fn set_qsv(&self, on: bool) {
        self.qsv.store(on, Ordering::Relaxed);
    }

    /// 설정 > 미리보기 선명하게: from the next stream or still.
    pub fn set_sharp(&self, on: bool) {
        self.sharp.store(on, Ordering::Relaxed);
    }

    /// Registers a request and returns the URL that answers it.
    pub fn url(&self, req: Req) -> String {
        let id = {
            let mut n = self.next.lock();
            *n += 1;
            format!("{:x}{:x}", *n, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0))
        };
        let ext = if req.kind == "frame" { "jpg" } else { "mp4" };
        let kind = req.kind.clone();
        let mut q = self.reqs.lock();
        q.push_back((id.clone(), req));
        while q.len() > KEEP_REQS {
            q.pop_front();
        }
        format!("http://127.0.0.1:{}/{kind}/{id}.{ext}", self.port)
    }

    /// Ends whatever ffmpeg serves `slot` (the viewer paused or moved on).
    pub fn stop(&self, slot: &str) -> bool {
        match self.slots.lock().remove(slot) {
            Some((_, mut c)) => {
                let _ = c.kill();
                let _ = c.wait();
                true
            }
            None => false,
        }
    }

    fn serve(&self, mut c: TcpStream) {
        let mut line = String::new();
        let mut rd = BufReader::new(match c.try_clone() {
            Ok(x) => x,
            Err(_) => return,
        });
        if rd.read_line(&mut line).is_err() {
            return;
        }
        // Headers are not needed (a Range request still gets the whole stream).
        loop {
            let mut h = String::new();
            if rd.read_line(&mut h).map(|n| n == 0).unwrap_or(true) || h.trim().is_empty() {
                break;
            }
        }
        let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
        let mut parts = path.trim_start_matches('/').splitn(2, '/');
        let (kind, file) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let id = file.split('.').next().unwrap_or("");
        let req = self.reqs.lock().iter().find(|(k, _)| k == id).map(|(_, r)| r.clone());
        let Some(req) = req.filter(|r| r.kind == kind) else {
            let _ = c.write_all(b"HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        };
        if kind == "frame" {
            self.frame(c, &req);
        } else {
            self.stream(c, &req);
        }
    }

    /// Spawns ffmpeg for a slot, ending the one it replaces; returns its generation.
    fn spawn(&self, slot: &str, args: &[String]) -> Option<(u64, std::process::ChildStdout)> {
        let mut child = ff::command(&self.ffmpeg).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
        let out = child.stdout.take()?;
        let mut slots = self.slots.lock();
        let gen = slots.get(slot).map(|(g, _)| g + 1).unwrap_or(1);
        if let Some((_, mut old)) = slots.insert(slot.to_string(), (gen, child)) {
            let _ = old.kill();
            let _ = old.wait();
        }
        Some((gen, out))
    }

    fn release(&self, slot: &str, gen: u64) {
        let mut slots = self.slots.lock();
        if slots.get(slot).is_some_and(|(g, _)| *g == gen) {
            if let Some((_, mut c)) = slots.remove(slot) {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }

    fn stream(&self, mut c: TcpStream, req: &Req) {
        let gpu = self.qsv.load(Ordering::Relaxed) && qsv_fits(&req.info, req.lens.as_ref());
        let started = self.start_stream(req, &self.stream_args(req, gpu)).or_else(|| {
            // Quick Sync refused this file: decode it in software instead.
            if gpu { self.start_stream(req, &self.stream_args(req, false)) } else { None }
        });
        let Some((gen, mut out, first)) = started else {
            let _ = c.write_all(b"HTTP/1.1 500 Internal Server Error\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        };
        let _ = c.set_nodelay(true);
        let head = "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        if c.write_all(head.as_bytes()).is_ok() && c.write_all(&first).is_ok() {
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                match out.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if c.write_all(&buf[..n]).is_err() {
                            break;
                        }
                    }
                }
            }
        }
        self.release(&req.slot, gen);
        let _ = c.shutdown(std::net::Shutdown::Write);
    }

    /// Starts ffmpeg and waits for its first bytes (none = it could not open the file).
    fn start_stream(&self, req: &Req, a: &[String]) -> Option<(u64, std::process::ChildStdout, Vec<u8>)> {
        let (gen, mut out) = self.spawn(&req.slot, a)?;
        let mut first = vec![0u8; 64 * 1024];
        match out.read(&mut first) {
            Ok(n) if n > 0 => {
                first.truncate(n);
                Some((gen, out, first))
            }
            _ => {
                self.release(&req.slot, gen);
                None
            }
        }
    }

    fn stream_args(&self, req: &Req, gpu: bool) -> Vec<String> {
        let rate = req.rate.unwrap_or(1.0).clamp(0.25, 16.0);
        let mut a = s(&["-hide_banner", "-nostdin", "-loglevel", "error"]);
        if gpu {
            // Depth 1: see `pano::Source::decode_args`. The stabilising turn is picked by the picture's time.
            a.extend(s(&["-hwaccel", "qsv", "-hwaccel_output_format", "qsv", "-async_depth", "1"]));
        }
        a.extend(s(&["-ss", &format!("{:.3}", req.t.max(0.0))]));
        // Real time after a short head start, so ffmpeg works only as fast as the picture plays.
        a.extend(s(&["-readrate", &format!("{rate:.3}"), "-readrate_initial_burst", "2", "-i", &req.info.path]));
        let sharp = self.sharp.load(Ordering::Relaxed);
        let mut pic = picture_lenses(&req.info, req.lens.as_ref(), gpu, sharp).unwrap_or_else(|| picture_with(&req.info, req.lens.as_ref(), gpu, sharp));
        if matches!(req.info.layout360.as_str(), "dual" | "dfisheye") {
            let first = (req.t.max(0.0) * req.info.fps.max(1.0) - 1e-3).ceil().max(0.0) as u64;
            pic[1] = pic[1].replace("[pv]", &format!(",{}[pv]", frame_marks(first)));
        }
        a.extend(pic);
        if req.info.has_audio {
            a.extend(s(&["-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"]));
        }
        let g = (req.info.fps.max(1.0) / 2.0).round().max(1.0).to_string();
        a.extend(s(&["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "21", "-pix_fmt", "yuv420p", "-g", &g, "-bf", "0"]));
        a.extend(s(&["-f", "mp4", "-frag_duration", "100000", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-"]));
        a
    }

    fn frame(&self, mut c: TcpStream, req: &Req) {
        let fps = req.info.fps.max(1.0);
        let sharp = self.sharp.load(Ordering::Relaxed);
        let key = format!("{}|{}|{}|{sharp}", req.info.path, (req.t * fps).round() as i64, serde_json::to_string(&req.lens).unwrap_or_default());
        let hit = self.frames.lock().iter().find(|(k, _)| *k == key).map(|(_, b)| b.clone());
        let jpg = match hit {
            Some(b) => Some(b),
            None => {
                let mut a = s(&["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", &format!("{:.3}", req.t.max(0.0)), "-i", &req.info.path]);
                a.extend(picture_lenses(&req.info, req.lens.as_ref(), false, sharp).unwrap_or_else(|| picture_with(&req.info, req.lens.as_ref(), false, sharp)));
                a.extend(s(&["-frames:v", "1", "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", "-"]));
                let slot = format!("{}:frame", req.slot);
                self.spawn(&slot, &a).and_then(|(gen, mut out)| {
                    let mut b = Vec::new();
                    let ok = out.read_to_end(&mut b).is_ok() && !b.is_empty();
                    self.release(&slot, gen);
                    ok.then(|| {
                        let b = Arc::new(b);
                        let mut f = self.frames.lock();
                        f.push_back((key, b.clone()));
                        while f.len() > KEEP_FRAMES {
                            f.pop_front();
                        }
                        b
                    })
                })
            }
        };
        match jpg {
            Some(b) => {
                let head = format!("HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", b.len());
                let _ = c.write_all(head.as_bytes()).and_then(|_| c.write_all(&b));
            }
            None => {
                let _ = c.write_all(b"HTTP/1.1 500 Internal Server Error\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
        }
        let _ = c.shutdown(std::net::Shutdown::Write);
    }
}

fn s(a: &[&str]) -> Vec<String> {
    a.iter().map(|x| x.to_string()).collect()
}

/// A strip under a 360 stream's picture holding each frame's number in the file, as black and white
/// blocks: the viewer reads it from the very picture it draws, so the turn for that frame is never
/// taken for another (timing alone cannot promise that; a turn one frame off shakes the view).
/// Bit 0 first, then one block always white. See `src/gl360.ts`.
fn frame_marks(first: u64) -> String {
    let mut f = "pad=iw:ih+16:0:0:black".to_string();
    for b in 0..20u32 {
        f += &format!(",drawbox=x={}:y=ih-16:w=32:h=16:color=white:t=fill:enable='eq(mod(floor((n+{first})/{}),2),1)'", b * 32, 1u64 << b);
    }
    f + ",drawbox=x=640:y=ih-16:w=32:h=16:color=white:t=fill"
}

/// The picture as ffmpeg options (`-filter_complex … -map [pv]`): a two-lens 360 recording as
/// the 2048×1024 stitched sphere (the viewer draws a flat view of it), anything else at most
/// 1080 lines high.
pub fn picture(info: &MediaInfo, lens: Option<&Lens>) -> Vec<String> {
    picture_with(info, lens, false, false)
}

/// Quick Sync is used for a stitched two-track recording (the heavy case).
fn qsv_fits(info: &MediaInfo, lens: Option<&Lens>) -> bool {
    let l = Lens { layout: info.layout360.clone(), ..lens.cloned().unwrap_or(Lens { layout: String::new(), swap: false, fov: 190.0, stitch: None, stab: None }) };
    info.layout360 == "dual" && crate::stitch::active(&l)
}

/// A stitched recording as ffmpeg options: the back lens on the left half, the front lens on the right,
/// with their colour match; the viewer's shader does the rest (`gl360.ts`, kind "lenses"). None when
/// this recording is not stitched. Like DJI Studio, which joins the lenses on the graphics chip too.
pub fn picture_lenses(info: &MediaInfo, lens: Option<&Lens>, gpu: bool, sharp: bool) -> Option<Vec<String>> {
    let each = if sharp { 1536u32 } else { 1024 };
    let layout = lens.map(|l| l.layout.as_str()).filter(|l| !l.is_empty() && *l != "none").unwrap_or(info.layout360.as_str()).to_string();
    let l = Lens { layout: layout.clone(), ..lens.cloned().unwrap_or(Lens { layout: String::new(), swap: false, fov: 190.0, stitch: None, stab: None }) };
    if !crate::stitch::active(&l) {
        return None;
    }
    let st = crate::stitch::params(&l);
    let lut = |g: &[f64; 3]| crate::stitch::gain_lut(g).map(|x| format!(",{x}")).unwrap_or_default();
    let (la, lb) = (lut(&st.gain_a), lut(&st.gain_b));
    let graph = if layout == "dual" {
        let (ia, ib) = if l.swap { (1, 0) } else { (0, 1) };
        let pre = if gpu { format!("vpp_qsv=w={each}:h={each}:format=nv12,hwdownload,format=nv12") } else { format!("scale={each}:{each}:flags=area") };
        format!("[0:v:{ia}]{pre},format=yuv420p{la}[la];[0:v:{ib}]{pre},format=yuv420p{lb}[lb];[la][lb]hstack=inputs=2[pv]")
    } else {
        let (xa, xb) = if l.swap { ("iw/2", "0") } else { ("0", "iw/2") };
        format!("[0:v:0]split=2[sl][sr];[sl]crop=iw/2:ih:{xa}:0,scale={each}:{each}:flags=area,format=yuv420p{la}[la];[sr]crop=iw/2:ih:{xb}:0,scale={each}:{each}:flags=area,format=yuv420p{lb}[lb];[la][lb]hstack=inputs=2[pv]")
    };
    Some(s(&["-filter_complex", &graph, "-map", "[pv]"]))
}

/// `picture`, with each lens decoded and shrunk on the GPU when `gpu` (the input opened with
/// `-hwaccel qsv -hwaccel_output_format qsv`).
pub fn picture_with(info: &MediaInfo, lens: Option<&Lens>, gpu: bool, sharp: bool) -> Vec<String> {
    let (each, sw) = if sharp { (1536u32, 3072u32) } else { (1024, 2048) };
    let sh = sw / 2;
    let layout = lens.map(|l| l.layout.as_str()).filter(|l| !l.is_empty() && *l != "none").unwrap_or(info.layout360.as_str()).to_string();
    let graph = if layout == "none" {
        "[0:v:0]scale=-2:'min(1080,ih)':flags=bilinear,format=yuv420p[pv]".to_string()
    } else {
        let l = Lens { layout: layout.clone(), ..lens.cloned().unwrap_or(Lens { layout: String::new(), swap: false, fov: 190.0, stitch: None, stab: None }) };
        let g = if layout == "equirect" {
            "[0:v:0]scale=2048:1024:flags=bilinear,format=yuv420p[pv]".to_string()
        } else if crate::stitch::active(&l) {
            // Both lenses shrunk, the seam blended; linear sampling is plenty for a preview.
            let g = if gpu && layout == "dual" {
                crate::stitch::graph(0, &l, None, &format!("vpp_qsv=w={each}:h={each}:format=nv12,hwdownload,format=nv12"), &crate::stitch::Out::Equi { w: sw, h: sh }, None, "sb")
            } else {
                crate::stitch::graph(0, &l, Some(each), "", &crate::stitch::Out::Equi { w: sw, h: sh }, None, "sb")
            };
            format!("{};[sb]format=yuv420p[pv]", g.replace("interp=lanczos", "interp=linear"))
        } else {
            let each = if layout == "dual" { Some(1024) } else { None };
            format!("{};[sb]v360={}:output=equirect:w=2048:h=1024:interp=linear,format=yuv420p[pv]", media::lens_source(0, &l, each, "sb"), media::v360_in(&l))
        };
        g
    };
    s(&["-filter_complex", &graph, "-map", "[pv]"])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(layout: &str) -> MediaInfo {
        MediaInfo { path: "x.osv".into(), kind: "video".into(), layout360: layout.into(), fps: 30.0, has_audio: true, ..Default::default() }
    }

    #[test]
    fn a_stitched_stream_is_the_two_lenses_side_by_side() {
        let a = picture_lenses(&info("dual"), None, true, true).unwrap();
        assert!(a[1].contains("[0:v:0]vpp_qsv=w=1536:h=1536") && a[1].contains("[0:v:1]vpp_qsv") && a[1].ends_with("[la][lb]hstack=inputs=2[pv]"), "{}", a[1]);
        assert!(!a[1].contains("v360"), "{}", a[1]);
        let off = Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: Some(crate::stitch::Stitch { on: false, ..Default::default() }), stab: None };
        assert!(picture_lenses(&info("dual"), Some(&off), false, false).is_none());
        assert!(picture_lenses(&info("none"), None, false, false).is_none());
        // The back lens is always on the left.
        let sw = Lens { layout: "dual".into(), swap: true, fov: 190.0, stitch: None, stab: None };
        assert!(picture_lenses(&info("dual"), Some(&sw), false, false).unwrap()[1].starts_with("[0:v:1]"));
    }

    #[test]
    fn frames_are_numbered_from_where_the_stream_starts() {
        let m = frame_marks(8841);
        assert!(m.starts_with("pad=iw:ih+16:0:0:black,"), "{m}");
        assert_eq!(m.matches("drawbox").count(), 21);
        assert!(m.contains("x=32:y=ih-16") && m.contains("floor((n+8841)/2)"), "{m}");
        assert!(m.ends_with("x=640:y=ih-16:w=32:h=16:color=white:t=fill"), "{m}");
    }

    #[test]
    fn the_sharp_preview_is_a_larger_sphere() {
        let a = picture_with(&info("dual"), None, true, true);
        assert!(a[1].contains("output=equirect:w=3072:h=1536") && a[1].contains("vpp_qsv=w=1536:h=1536"), "{}", a[1]);
        let b = picture_with(&info("dual"), None, true, false);
        assert!(b[1].contains("output=equirect:w=2048:h=1024") && b[1].contains("vpp_qsv=w=1024:h=1024"), "{}", b[1]);
    }

    #[test]
    fn osv_is_stitched_to_a_sphere() {
        let a = picture(&info("dual"), None);
        let g = &a[1];
        assert!(g.contains("[0:v:0]") && g.contains("[0:v:1]"), "{g}");
        assert!(g.contains("output=equirect:w=2048:h=1024") && g.contains("maskedmerge"), "{g}");
        assert!(!g.contains("lanczos") && g.ends_with("[pv]"), "{g}");
    }

    #[test]
    fn stitch_off_and_flat_files() {
        let off = Lens { layout: "dual".into(), swap: true, fov: 190.0, stitch: Some(crate::stitch::Stitch { on: false, ..Default::default() }), stab: None };
        let g = &picture(&info("dual"), Some(&off))[1];
        assert!(g.starts_with("[0:v:1]scale=1024:1024[sba];[0:v:0]scale=1024:1024[sbb];[sba][sbb]hstack[sb];[sb]v360=input=dfisheye:ih_fov=190:iv_fov=190:output=equirect"), "{g}");
        let flat = &picture(&info("none"), None)[1];
        assert_eq!(flat, "[0:v:0]scale=-2:'min(1080,ih)':flags=bilinear,format=yuv420p[pv]");
    }

    /// A stream and a still frame of the fixture .osv through the server (REELCUT_FX).
    #[test]
    fn serves_stream_and_frame() {
        let Ok(fx) = std::env::var("REELCUT_FX") else { return };
        let bin = |n: &str| PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join(n);
        let osv = media::inspect(&bin("ffprobe"), &PathBuf::from(fx).join("CAM_0001.OSV").to_string_lossy()).unwrap();
        let live = Live::start(bin("ffmpeg")).unwrap();
        let get = |url: &str| -> (String, Vec<u8>, f64) {
            let t0 = std::time::Instant::now();
            let rest = url.trim_start_matches("http://");
            let (host, path) = rest.split_once('/').unwrap();
            let mut c = TcpStream::connect(host).unwrap();
            write!(c, "GET /{path} HTTP/1.1\r\nHost: {host}\r\nRange: bytes=0-\r\n\r\n").unwrap();
            let mut all = Vec::new();
            // A reset after the last byte still leaves what came in `all`.
            let _ = c.read_to_end(&mut all);
            let at = all.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            (String::from_utf8_lossy(&all[..at]).into_owned(), all[at + 4..].to_vec(), t0.elapsed().as_secs_f64())
        };
        let (h, body, secs) = get(&live.url(Req { slot: "t".into(), info: osv.clone(), lens: None, t: 2.0, kind: "frame".into(), rate: None }));
        assert!(h.starts_with("HTTP/1.1 200") && h.contains("image/jpeg") && body.starts_with(&[0xff, 0xd8]), "{h}");
        println!("frame {} KiB in {secs:.2}s", body.len() / 1024);
        let (h, body, secs) = get(&live.url(Req { slot: "t".into(), info: osv, lens: None, t: 3.0, kind: "stream".into(), rate: Some(4.0) }));
        assert!(h.contains("video/mp4") && body.windows(4).any(|w| w == b"moof"), "{h}");
        println!("stream {} KiB in {secs:.2}s", body.len() / 1024);
        assert!(!live.stop("t"), "the slot ends with its stream");
    }
}
