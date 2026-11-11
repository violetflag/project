//! The ffmpeg arguments for a set of settings (PRD F2/F3, requirements §2–§6, §11–§12). The same
//! builder makes the final file, the 5 s preview chunks and the 2 s estimate samples, so what the
//! preview shows is what compressing produces.

use crate::hw::Hw;
use crate::probe::{Audio, Source};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Settings {
    /// av1 | hevc | h264
    pub codec: String,
    pub crf: u32,
    /// SVT-AV1 preset number: 6 | 8 | 10 | 12
    pub speed: u32,
    /// src, or the most frames per second to keep (any number below the source's)
    pub fps: String,
    /// src | 2160 | 1440 | 1080 | 720 (short side)
    pub res: String,
    /// 0 off, 1 light, 2 medium, 3 strong
    pub denoise: u32,
    /// copy | opus | aac | flac
    pub acodec: String,
    /// kbit/s for a stereo track (opus/aac)
    pub abr: u32,
    /// mkv | mp4
    pub container: String,
    /// 화면 콘텐츠: drop frames that did not change.
    pub screen: bool,
    /// 가변 fps: frames keep their own timestamps (no padding to a fixed rate), and a lower
    /// maximum drops frames only where the source is faster than it.
    #[serde(default = "yes")]
    pub vfr: bool,
}

fn yes() -> bool {
    true
}

fn v<S: AsRef<str>>(a: &[S]) -> Vec<String> {
    a.iter().map(|x| x.as_ref().to_string()).collect()
}

/// The encoder that makes this codec here: the GPU one when the test encode passed, else x26x.
/// AV1 is GPU-only (requirements §3). H.264 GPU encoders take 8-bit only, so a 10-bit source
/// goes to libx264 to keep its bit depth (requirements §12).
pub fn encoder(s: &Settings, src: &Source, hw: &Hw) -> Result<String, String> {
    match s.codec.as_str() {
        "av1" => hw.av1.clone().ok_or_else(|| "이 PC의 그래픽카드는 AV1 인코딩을 지원하지 않습니다".to_string()),
        "hevc" => Ok(hw.hevc.clone().unwrap_or_else(|| "libx265".into())),
        "h264" => Ok(if src.bit_depth > 8 { "libx264".into() } else { hw.h264.clone().unwrap_or_else(|| "libx264".into()) }),
        c => Err(format!("알 수 없는 코덱: {c}")),
    }
}

/// The highest frame rate to keep, or None to keep the source's. 59.94/29.97-style sources keep
/// their NTSC timing (60000/1001); a value not below the source is no change (requirements §2).
pub fn target_fps(s: &Settings, src: &Source) -> Option<(u32, u32)> {
    let t: f64 = s.fps.parse().ok()?;
    if t <= 0.0 || src.fps <= t * 1.001 + 0.01 {
        return None;
    }
    let whole = (t - t.round()).abs() < 1e-6;
    Some(if src.fps_den == 1001 && whole { (t.round() as u32 * 1000, 1001) } else if whole { (t.round() as u32, 1) } else { ((t * 1000.0).round() as u32, 1000) })
}

pub fn out_fps(s: &Settings, src: &Source) -> f64 {
    target_fps(s, src).map(|(n, d)| n as f64 / d as f64).unwrap_or(src.fps)
}

/// The target short side, or None when it would not make the picture smaller.
pub fn target_short(s: &Settings, src: &Source) -> Option<u32> {
    let t: u32 = s.res.parse().ok()?;
    (t < src.width.min(src.height)).then_some(t)
}

pub fn filters(s: &Settings, src: &Source) -> Vec<String> {
    let mut f = Vec::new();
    if s.screen {
        f.push("mpdecimate".to_string());
    }
    if let Some((n, d)) = target_fps(s, src) {
        if s.vfr {
            // Keep a frame only when at least 1/max s has passed since the last one kept: faster
            // stretches are thinned to the maximum, slower ones are left alone (no duplicates).
            let gap = d as f64 / n as f64 - 0.0005;
            f.push(format!("select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,{gap:.5})'"));
        } else {
            f.push(if d == 1 { format!("fps={n}") } else { format!("fps={n}/{d}") });
        }
    }
    if let Some(t) = target_short(s, src) {
        f.push(if src.width >= src.height { format!("scale=-2:{t}:flags=lanczos") } else { format!("scale={t}:-2:flags=lanczos") });
    }
    match s.denoise {
        1 => f.push("hqdn3d=2:1.5:3:2.25".into()),
        2 => f.push("hqdn3d=4:3:6:4.5".into()),
        3 => f.push("nlmeans=s=3:p=7:r=9".into()),
        _ => {}
    }
    f
}

const X26X: [(u32, &str); 4] = [(6, "slow"), (8, "medium"), (10, "fast"), (12, "veryfast")];
const NVENC: [(u32, &str); 4] = [(6, "p7"), (8, "p5"), (10, "p3"), (12, "p1")];

fn pick(t: &[(u32, &'static str)], speed: u32) -> &'static str {
    t.iter().find(|(k, _)| *k == speed).map(|(_, v)| *v).unwrap_or(t[1].1)
}

/// The ICQ value (1–51) for a QSV encoder that matches the x26x/SVT quality number the UI shows.
/// Measured with VMAF on a 1440p dashcam clip (Intel Arc B390, 2026-11-03): the presets'
/// numbers (AV1 22/28/34, HEVC 20/24/28, H.264 18/21/25) land at about 5 / 2.5 / 1.3 Mbps,
/// VMAF 90 / 88 / 83, all below the 9 Mbps source. The raw number as ICQ made files bigger
/// than the source.
pub fn qsv_icq(enc: &str, crf: u32) -> u32 {
    // AV1: through (22 → 26), (28 → 28), (34 → 32); QSV's speed presets do not change the size,
    // so 보관 relies on this value alone to stay well under the source (about 55 % with FLAC audio).
    let c = crf as f64;
    let q = match enc {
        "av1_qsv" if crf <= 22 => 1.0 + c * 25.0 / 22.0,
        "av1_qsv" if crf < 28 => 26.0 + (c - 22.0) / 3.0,
        "av1_qsv" => 28.0 + (c - 28.0) * 2.0 / 3.0,
        "hevc_qsv" => c + 4.0,
        _ => c + 8.0,
    };
    (q.round() as u32).clamp(1, 51)
}

/// `-c:v …` with quality, speed, pixel format, key frame interval, threads and colour tags.
pub fn video_args(enc: &str, s: &Settings, src: &Source, threads: u32) -> Vec<String> {
    let ten = src.bit_depth > 8;
    let gop = (out_fps(s, src) * 10.0).round().max(1.0) as u32;
    let crf = s.crf;
    let mut a = v(&["-c:v", enc]);
    if enc.starts_with("lib") {
        a.extend(v(&["-preset", pick(&X26X, s.speed), "-crf", &crf.to_string(), "-pix_fmt", if ten { "yuv420p10le" } else { "yuv420p" }]));
        if enc == "libx265" {
            a.extend(v(&["-x265-params", &format!("pools={threads}:log-level=error")]));
            if s.container == "mp4" {
                a.extend(v(&["-tag:v", "hvc1"]));
            }
        } else {
            a.extend(v(&["-threads", &threads.to_string()]));
        }
    } else if enc.ends_with("_nvenc") {
        let cq = if enc == "av1_nvenc" { crf.clamp(1, 63) } else { crf.clamp(1, 51) };
        a.extend(v(&["-preset", pick(&NVENC, s.speed), "-tune", "hq", "-rc", "vbr", "-cq", &cq.to_string(), "-b:v", "0", "-spatial-aq", "1"]));
        a.extend(v(&["-pix_fmt", if ten { "p010le" } else { "nv12" }]));
        if enc == "hevc_nvenc" && s.container == "mp4" {
            a.extend(v(&["-tag:v", "hvc1"]));
        }
    } else if enc.ends_with("_qsv") {
        a.extend(v(&["-preset", pick(&X26X, s.speed), "-global_quality:v", &qsv_icq(enc, crf).to_string()]));
        a.extend(v(&["-pix_fmt", if ten { "p010le" } else { "nv12" }]));
        if enc == "hevc_qsv" && s.container == "mp4" {
            a.extend(v(&["-tag:v", "hvc1"]));
        }
    } else if enc.ends_with("_amf") {
        let qp = if enc == "av1_amf" { (crf * 4).min(255) } else { crf.min(51) };
        let quality = if enc == "av1_amf" {
            match s.speed { 6 => "high_quality", 8 => "quality", 10 => "balanced", _ => "speed" }
        } else {
            match s.speed { 6 => "quality", 8 => "balanced", _ => "speed" }
        };
        a.extend(v(&["-rc", "cqp", "-qp_i", &qp.to_string(), "-qp_p", &qp.to_string(), "-quality", quality]));
        if enc != "av1_amf" {
            a.extend(v(&["-qp_b", &qp.to_string()]));
        }
        a.extend(v(&["-pix_fmt", if ten { "p010le" } else { "nv12" }]));
    }
    a.extend(v(&["-g", &gop.to_string()]));
    for (opt, val) in [("-color_primaries", &src.color_primaries), ("-color_trc", &src.color_trc), ("-colorspace", &src.colorspace), ("-color_range", &src.color_range)] {
        if !val.is_empty() && val != "unknown" && val != "reserved" {
            a.extend(v(&[opt, val.as_str()]));
        }
    }
    // VFR keeps each frame's own time; CFR pads or drops to one steady rate.
    a.extend(v(&["-fps_mode", if s.vfr || s.screen { "vfr" } else { "cfr" }]));
    a
}

const LOSSLESS: [&str; 8] = ["flac", "alac", "truehd", "mlp", "wavpack", "tta", "ape", "dts"];
const MP4_OK: [&str; 7] = ["aac", "mp3", "opus", "ac3", "eac3", "alac", "flac"];

pub fn is_pcm(codec: &str) -> bool {
    codec.starts_with("pcm_")
}

/// The bitrate (bit/s) one track gets: the stereo value, scaled with the channel count for 5.1+.
pub fn track_bitrate(s: &Settings, a: &Audio) -> u64 {
    let scale = (a.channels.max(2) as f64 / 2.0).max(1.0);
    (s.abr as f64 * 1000.0 * scale) as u64
}

/// What happens to one audio track: "copy", or the codec it is re-encoded to.
pub fn audio_plan(s: &Settings, a: &Audio, container: &str) -> &'static str {
    let mp4 = container == "mp4";
    let can_copy = !mp4 || MP4_OK.contains(&a.codec.as_str());
    match s.acodec.as_str() {
        "copy" => {
            if can_copy {
                "copy"
            } else if is_pcm(&a.codec) || LOSSLESS.contains(&a.codec.as_str()) {
                if mp4 { "aac" } else { "flac" }
            } else {
                "aac"
            }
        }
        "flac" => "flac",
        c => {
            // A lossy source already at or below the chosen bitrate is copied, not re-encoded
            // (PRD F2): another lossy pass would only lose more.
            let lossy = !is_pcm(&a.codec) && !LOSSLESS.contains(&a.codec.as_str());
            if lossy && can_copy && a.bit_rate.is_some_and(|b| b <= track_bitrate(s, a) + 8000) {
                "copy"
            } else if c == "aac" {
                "aac"
            } else {
                "opus"
            }
        }
    }
}

/// Per-output-track audio options for track number `i` (output audio index).
pub fn audio_track_args(s: &Settings, a: &Audio, i: usize, container: &str) -> Vec<String> {
    let sp = |o: &str| format!("{o}:a:{i}");
    let bitrate = track_bitrate(s, a);
    match audio_plan(s, a, container) {
        "copy" => v(&[sp("-c"), "copy".into()]),
        "flac" => v(&[sp("-c"), "flac".into(), sp("-compression_level"), "8".into()]),
        "aac" => {
            let b = if s.acodec == "aac" { bitrate } else { (192_000.0 * (a.channels.max(2) as f64 / 2.0)) as u64 };
            v(&[sp("-c"), "aac".into(), sp("-b"), b.to_string()])
        }
        _ => {
            let mut o = v(&[sp("-c"), "libopus".into(), sp("-b"), bitrate.to_string(), sp("-vbr"), "on".into(), sp("-compression_level"), "10".into(), sp("-application"), (if s.abr <= 48 { "voip" } else { "audio" }).into()]);
            if a.channels > 2 {
                o.extend(v(&[sp("-mapping_family"), "1".into(), sp("-filter"), "aformat=channel_layouts=7.1|5.1|stereo".into()]));
            }
            o
        }
    }
}

/// Size in bytes the audio will take in the result (for the estimate).
pub fn audio_bytes(s: &Settings, src: &Source) -> u64 {
    src.audio
        .iter()
        .map(|a| {
            let orig = a.bit_rate.unwrap_or(192_000);
            let rate = match audio_plan(s, a, &s.container) {
                "copy" => orig,
                "flac" => {
                    if is_pcm(&a.codec) || LOSSLESS.contains(&a.codec.as_str()) {
                        // FLAC keeps about 55–60% of 16-bit PCM.
                        (a.sample_rate as u64 * a.channels as u64 * 16) * 58 / 100
                    } else {
                        // Decoded lossy audio packs worse than real recordings.
                        (a.sample_rate as u64 * a.channels as u64 * 16) * 70 / 100
                    }
                }
                "aac" => if s.acodec == "aac" { track_bitrate(s, a) } else { (192_000.0 * (a.channels.max(2) as f64 / 2.0)) as u64 },
                _ => track_bitrate(s, a),
            };
            (rate as f64 / 8.0 * src.duration) as u64
        })
        .sum()
}

fn vf(s: &Settings, src: &Source) -> Vec<String> {
    let f = filters(s, src);
    if f.is_empty() { vec![] } else { v(&["-vf".to_string(), f.join(",")]) }
}

/// The whole command for the final file (PRD F6). `out` is the `.part` path.
pub fn full(src: &Source, s: &Settings, enc: &str, threads: u32, out: &str) -> Vec<String> {
    let mp4 = s.container == "mp4";
    let mut a = v(&["-i", &src.path, "-map", &format!("0:{}", src.vindex)]);
    for st in &src.audio {
        a.extend(v(&["-map", &format!("0:{}", st.index)]));
    }
    let text_subs: Vec<_> = src.subs.iter().filter(|x| ["mov_text", "subrip", "ass", "ssa", "webvtt", "text"].contains(&x.codec.as_str())).collect();
    if mp4 {
        for st in &text_subs {
            a.extend(v(&["-map", &format!("0:{}", st.index)]));
        }
    } else {
        a.extend(v(&["-map", "0:s?", "-map", "0:t?"]));
    }
    a.extend(v(&["-map_metadata", "0", "-map_chapters", "0", "-filter_threads", &threads.to_string()]));
    a.extend(vf(s, src));
    a.extend(video_args(enc, s, src, threads));
    for (i, st) in src.audio.iter().enumerate() {
        a.extend(audio_track_args(s, st, i, &s.container));
    }
    if mp4 {
        if !text_subs.is_empty() {
            a.extend(v(&["-c:s", "mov_text"]));
        }
        a.extend(v(&["-movflags", "+faststart", "-f", "mp4"]));
    } else {
        a.extend(mkv_subs(&src.subs));
        a.extend(v(&["-c:t", "copy", "-f", "matroska"]));
    }
    a.push(out.to_string());
    a
}

/// MKV cannot hold MP4's mov_text (dashcams put GPS data there): it becomes SRT; the rest is copied.
fn mkv_subs(subs: &[crate::probe::Sub]) -> Vec<String> {
    let mut a = Vec::new();
    for (i, st) in subs.iter().enumerate() {
        a.extend(v(&[format!("-c:s:{i}"), (if st.codec == "mov_text" { "srt" } else { "copy" }).to_string()]));
    }
    a
}

/// Whether clips can be joined by the concat demuxer (same video and audio format; frame rates
/// may differ), so nothing has to be scaled or resampled first.
pub fn concat_compatible(clips: &[Source]) -> bool {
    let Some(f) = clips.first() else { return false };
    clips.iter().all(|c| {
        c.vcodec == f.vcodec
            && c.width == f.width
            && c.height == f.height
            && c.pix_fmt == f.pix_fmt
            && c.audio.len() == f.audio.len()
            && c.audio.iter().zip(&f.audio).all(|(a, b)| a.codec == b.codec && a.sample_rate == b.sample_rate && a.channels == b.channels)
            && c.subs.len() == f.subs.len()
    })
}

/// Whether the concat demuxer can read the clips as they are: it keeps the first clip's time
/// base for every later one, so a 15 fps clip (1/15000) after a 30 fps one (1/30000) comes out
/// with its timestamps halved and its frames dropped. Clips that differ are first copied into
/// MKV (time base 1/1000 for all).
pub fn same_time_base(clips: &[Source]) -> bool {
    clips.iter().all(|c| c.time_base == clips[0].time_base && c.fps_num == clips[0].fps_num && c.fps_den == clips[0].fps_den)
}

/// The clip list a concat demuxer reads; paths quoted the way ffmpeg's concat format wants.
pub fn concat_list(clips: &[Source]) -> String {
    clips.iter().map(|c| format!("file '{}'\n", c.path.replace('\\', "/").replace('\'', "'\\''"))).collect()
}

/// One stand-in Source for a joined sequence: the first clip's format with the total length,
/// the highest frame rate and the summed size.
pub fn merged_source(clips: &[Source]) -> Source {
    let mut m = clips[0].clone();
    m.duration = clips.iter().map(|c| c.duration).sum();
    m.size = clips.iter().map(|c| c.size).sum();
    if let Some(fast) = clips.iter().max_by(|a, b| a.fps.total_cmp(&b.fps)) {
        (m.fps, m.fps_num, m.fps_den) = (fast.fps, fast.fps_num, fast.fps_den);
    }
    m
}

/// Inputs and a filter graph that put `pieces` (path, start, length, has audio) end to end at
/// one size, frame rate and audio format; for clips the concat demuxer cannot join, and for
/// spans of a joined original that cross clip boundaries. Gives `[v]` and, with `audio`, `[a]`.
pub fn span_graph(pieces: &[(String, f64, f64, bool)], w: u32, h: u32, fps: Option<f64>, audio: bool) -> (Vec<String>, String) {
    let fps_f = fps.map(|f| format!("fps={f:.3},")).unwrap_or_default();
    let mut inputs = Vec::new();
    let mut graph = String::new();
    let mut n_in = 0;
    let mut labels = String::new();
    for (i, (path, ss, t, has_a)) in pieces.iter().enumerate() {
        inputs.extend(v(&["-ss", &format!("{ss:.3}"), "-t", &format!("{t:.3}"), "-i", path]));
        let vi = n_in;
        n_in += 1;
        graph += &format!("[{vi}:v:0]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=bicubic,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,{fps_f}format=yuv420p[v{i}];");
        labels += &format!("[v{i}]");
        if audio {
            if *has_a {
                graph += &format!("[{vi}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}];");
            } else {
                inputs.extend(v(&["-f", "lavfi", "-t", &format!("{t:.3}"), "-i", "anullsrc=r=48000:cl=stereo"]));
                graph += &format!("[{n_in}:a:0]aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}];");
                n_in += 1;
            }
            labels += &format!("[a{i}]");
        }
    }
    graph += &format!("{labels}concat=n={}:v=1:a={}[v]{}", pieces.len(), audio as u8, if audio { "[a]" } else { "" });
    (inputs, graph)
}

/// The command that joins `clips` and compresses them into `out` (the `.part` path).
pub fn merge(clips: &[Source], s: &Settings, enc: &str, threads: u32, list_file: &str, out: &str) -> Vec<String> {
    let m = merged_source(clips);
    let mp4 = s.container == "mp4";
    let mut a = Vec::new();
    if concat_compatible(clips) {
        a.extend(v(&["-f", "concat", "-safe", "0", "-i", list_file, "-map", "0:v:0"]));
        for i in 0..m.audio.len() {
            a.extend(v(&["-map".to_string(), format!("0:a:{i}")]));
        }
        if !mp4 && !m.subs.is_empty() {
            a.extend(v(&["-map", "0:s?"]));
        }
        a.extend(v(&["-filter_threads", &threads.to_string()]));
        a.extend(vf(s, &m));
        a.extend(video_args(enc, s, &m, threads));
        for (i, st) in m.audio.iter().enumerate() {
            a.extend(audio_track_args(s, st, i, &s.container));
        }
        if !mp4 {
            a.extend(mkv_subs(&m.subs));
        }
    } else {
        let audio = clips.iter().any(|c| !c.audio.is_empty());
        let pieces: Vec<_> = clips.iter().map(|c| (c.path.clone(), 0.0, c.duration, !c.audio.is_empty())).collect();
        // With 가변 fps each clip keeps its own frame rate; CFR evens them out at the highest.
        let (inputs, mut graph) = span_graph(&pieces, m.width, m.height, (!s.vfr).then_some(m.fps), audio);
        let f = filters(s, &m);
        graph += &format!(";[v]{}[vo]", if f.is_empty() { "null".to_string() } else { f.join(",") });
        a.extend(inputs);
        a.extend(v(&["-filter_complex".to_string(), graph, "-map".into(), "[vo]".into()]));
        if audio {
            a.extend(v(&["-map", "[a]"]));
        }
        a.extend(v(&["-filter_threads", &threads.to_string()]));
        let mut m8 = m.clone();
        m8.bit_depth = 8; // the graph made it yuv420p
        a.extend(video_args(enc, s, &m8, threads));
        if audio {
            let st = Audio { index: 0, codec: "pcm_f32le".into(), channels: 2, layout: "stereo".into(), sample_rate: 48000, bit_rate: None };
            a.extend(audio_track_args(s, &st, 0, &s.container));
        }
    }
    a.extend(v(&["-map_metadata", "-1"]));
    if mp4 {
        a.extend(v(&["-movflags", "+faststart", "-f", "mp4"]));
    } else {
        a.extend(v(&["-f", "matroska"]));
    }
    a.push(out.to_string());
    a
}

/// Video only, `len` seconds from `start`: the estimate samples and the preview's encode step.
pub fn segment(src: &Source, s: &Settings, enc: &str, threads: u32, start: f64, len: f64, out: &str) -> Vec<String> {
    let mut a = v(&["-ss", &format!("{start:.3}"), "-t", &format!("{len:.3}"), "-i", &src.path, "-map", &format!("0:{}", src.vindex), "-an", "-sn", "-dn", "-filter_threads", &threads.to_string()]);
    a.extend(vf(s, src));
    a.extend(video_args(enc, s, src, threads));
    a.extend(v(&["-f", "matroska", out]));
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src() -> Source {
        Source {
            path: "in.mp4".into(),
            name: "in.mp4".into(),
            size: 1,
            duration: 60.0,
            vindex: 0,
            width: 3840,
            height: 2160,
            fps_num: 60000,
            fps_den: 1001,
            fps: 59.94,
            vcodec: "h264".into(),
            pix_fmt: "yuv420p".into(),
            bit_depth: 8,
            chroma: "4:2:0".into(),
            color_primaries: "bt709".into(),
            color_trc: "bt709".into(),
            colorspace: "bt709".into(),
            color_range: "tv".into(),
            hdr: false,
            audio: vec![Audio { index: 1, codec: "aac".into(), channels: 2, layout: "stereo".into(), sample_rate: 48000, bit_rate: Some(256_000) }],
            subs: vec![],
            attachments: 0,
            format: "mov,mp4".into(),
            created: 0,
            modified: 0,
            time_base: "1/60000".into(),
        }
    }

    fn set() -> Settings {
        Settings { codec: "av1".into(), crf: 28, speed: 8, fps: "src".into(), res: "src".into(), denoise: 0, acodec: "opus".into(), abr: 128, container: "mkv".into(), screen: false, vfr: true }
    }

    #[test]
    fn fps_never_goes_up_and_keeps_ntsc() {
        let mut s = set();
        s.fps = "60".into();
        assert_eq!(target_fps(&s, &src()), None);
        s.fps = "30".into();
        assert_eq!(target_fps(&s, &src()), Some((30000, 1001)));
        let mut low = src();
        low.fps = 24.0;
        low.fps_den = 1;
        assert_eq!(target_fps(&s, &low), None);
    }

    #[test]
    fn fps_cap_is_vfr_by_default_and_any_value() {
        let mut s = set();
        s.fps = "24".into();
        assert_eq!(target_fps(&s, &src()), Some((24000, 1001)));
        let f = filters(&s, &src()).join(",");
        assert!(f.starts_with("select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,0.04121)'"), "{f}");
        assert!(video_args("av1_qsv", &s, &src(), 16).join(" ").contains("-fps_mode vfr"));
        s.vfr = false;
        assert_eq!(filters(&s, &src()), vec!["fps=24000/1001"]);
        assert!(video_args("av1_qsv", &s, &src(), 16).join(" ").contains("-fps_mode cfr"));
        s.fps = "120".into();
        assert_eq!(target_fps(&s, &src()), None);
    }

    #[test]
    fn scale_only_down_and_portrait_aware() {
        let mut s = set();
        s.res = "1080".into();
        assert_eq!(filters(&s, &src()), vec!["scale=-2:1080:flags=lanczos"]);
        let mut p = src();
        (p.width, p.height) = (1080, 1920);
        assert!(filters(&s, &p).is_empty());
        s.res = "720".into();
        assert_eq!(filters(&s, &p), vec!["scale=720:-2:flags=lanczos"]);
    }

    #[test]
    fn audio_copies_when_already_small() {
        let mut s = set();
        let mut a = src().audio[0].clone();
        assert_eq!(audio_plan(&s, &a, "mkv"), "opus");
        a.bit_rate = Some(96_000);
        assert_eq!(audio_plan(&s, &a, "mkv"), "copy");
        a.codec = "pcm_s16le".into();
        a.bit_rate = Some(1_536_000);
        s.acodec = "copy".into();
        assert_eq!(audio_plan(&s, &a, "mp4"), "aac");
        assert_eq!(audio_plan(&s, &a, "mkv"), "copy");
    }

    #[test]
    fn qsv_av1_quality_is_mapped() {
        let a = video_args("av1_qsv", &set(), &src(), 16);
        let i = a.iter().position(|x| x == "-global_quality:v").unwrap();
        assert_eq!(a[i + 1], "28");
        assert_eq!(qsv_icq("av1_qsv", 0), 1);
        assert_eq!(qsv_icq("av1_qsv", 22), 26);
        assert_eq!(qsv_icq("av1_qsv", 34), 32);
        assert_eq!(qsv_icq("av1_qsv", 63), 51);
        assert_eq!(qsv_icq("hevc_qsv", 24), 28);
        assert_eq!(qsv_icq("h264_qsv", 21), 29);
        assert!(a.contains(&"-g".to_string()) && a.contains(&"599".to_string()));
    }

    #[test]
    fn merge_uses_concat_demuxer_when_formats_match() {
        let (a, mut b) = (src(), src());
        b.path = "C:\\x\\it's.mp4".into();
        b.fps = 30.0;
        assert!(concat_compatible(&[a.clone(), b.clone()]));
        assert_eq!(concat_list(&[b.clone()]), "file 'C:/x/it'\\''s.mp4'\n");
        let c = merge(&[a.clone(), b.clone()], &set(), "av1_qsv", 16, "l.txt", "o.part").join(" ");
        assert!(c.starts_with("-f concat -safe 0 -i l.txt -map 0:v:0 -map 0:a:0"));
        assert!(c.contains("-g 599"), "gop from the fastest clip: {c}");
        b.width = 1280;
        assert!(!concat_compatible(&[a.clone(), b.clone()]));
        let c = merge(&[a, b], &set(), "av1_qsv", 16, "l.txt", "o.part").join(" ");
        assert!(c.contains("concat=n=2:v=1:a=1[v][a]") && c.contains("-map [vo] -map [a]"), "{c}");
    }

    #[test]
    fn full_command_maps_everything() {
        let c = full(&src(), &set(), "av1_qsv", 16, "out.mkv.part");
        let j = c.join(" ");
        assert!(j.contains("-map 0:0 -map 0:1 -map 0:s? -map 0:t?"));
        assert!(j.contains("-c:a:0 libopus -b:a:0 128000"));
        assert!(j.ends_with("-f matroska out.mkv.part"));
    }
    /// Real run against SHRINK_TEST_FILE with this PC's encoders: `cargo test real_encode -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_encode() {
        let path = std::env::var("SHRINK_TEST_FILE").expect("SHRINK_TEST_FILE");
        let bins = crate::ff::locate(None);
        let src = crate::probe::probe(&bins.ffprobe, &path).unwrap();
        println!("{src:?}");
        let hw = crate::hw::detect(&bins.ffmpeg, &std::env::temp_dir().join("shrink-hw-test.json"), true);
        println!("{hw:?}");
        let jobs = crate::ff::Jobs::default();
        for codec in ["av1", "hevc", "h264"] {
            let mut s = set();
            s.codec = codec.into();
            s.crf = match codec { "av1" => 28, "hevc" => 24, _ => 21 };
            let Ok(enc) = encoder(&s, &src, &hw) else { continue };
            let out = std::env::temp_dir().join(format!("shrink-seg-{codec}.mkv"));
            let r = crate::ff::run_ffmpeg(&jobs, "t", 0, &bins.ffmpeg, &segment(&src, &s, &enc, hw.threads, 10.0, 2.0, out.to_str().unwrap()), |_| {}).unwrap();
            println!("{codec} {enc}: {} bytes, elapsed {:.2}s steady {:?}", std::fs::metadata(&out).unwrap().len(), r.elapsed, r.steady);
        }
        let s = set();
        let enc = encoder(&s, &src, &hw).unwrap();
        let out = std::env::temp_dir().join("shrink-full.mkv.part");
        let cmd = full(&src, &s, &enc, hw.threads, out.to_str().unwrap());
        println!("ffmpeg {}", cmd.join(" "));
        let r = crate::ff::run_ffmpeg(&jobs, "t", 0, &bins.ffmpeg, &cmd, |_| {}).unwrap();
        println!("full: {} bytes in {:.1}s", std::fs::metadata(&out).unwrap().len(), r.elapsed);
        println!("{:?}", crate::probe::check(&bins.ffprobe, out.to_str().unwrap()));
    }
}