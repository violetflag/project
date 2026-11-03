//! Export: a Draft (the clips in order, already resolved by the editor) into one file. Two ways
//! to encode: "standard" (H.264/AAC MP4 at a chosen resolution, like the original app's export)
//! and "shrink" (the compression presets of the Shrink app: AV1/HEVC/H.264 at a CRF, Opus audio,
//! fps cap, denoise), sharing `args.rs` with Shrink so the result is the same.

use crate::args::{self, Settings};
use crate::hw::Hw;
use crate::media::{self, Lens, View};
use crate::probe::{Audio, Source};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Seg {
    pub path: String,
    /// video | image | audio
    pub kind: String,
    /// Source seconds.
    pub start: f64,
    pub dur: f64,
    #[serde(default = "one")]
    pub speed: f64,
    #[serde(default = "one")]
    pub volume: f64,
    #[serde(default)]
    pub has_audio: bool,
    #[serde(default)]
    pub lens: Option<Lens>,
    #[serde(default)]
    pub view: Option<View>,
    /// fit | fill
    #[serde(default)]
    pub fit: String,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Music {
    pub path: String,
    pub start: f64,
    pub dur: f64,
    /// Seconds on the timeline.
    pub at: f64,
    #[serde(default = "one")]
    pub volume: f64,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
}

fn one() -> f64 {
    1.0
}
fn fhd_rate() -> u32 {
    8000
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Plan {
    pub segs: Vec<Seg>,
    #[serde(default)]
    pub music: Vec<Music>,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// ASS subtitles to burn in (captions), or empty.
    #[serde(default)]
    pub ass: String,
    /// standard | shrink | audio
    pub mode: String,
    /// For "standard": video bitrate in kbit/s (4K 32000, FHD 8000, HD 5000, SD 2000).
    #[serde(default = "fhd_rate")]
    pub vbitrate: u32,
    /// For "shrink": the Shrink settings (codec av1/hevc/h264, crf, speed, fps, res, denoise, audio…).
    #[serde(default)]
    pub settings: Option<Settings>,
    pub out: String,
}

fn v(a: &[&str]) -> Vec<String> {
    a.iter().map(|x| x.to_string()).collect()
}

fn atempo(speed: f64) -> String {
    // atempo takes 0.5–2.0 per stage
    let mut s = speed.clamp(0.0625, 16.0);
    let mut parts = Vec::new();
    while s > 2.0 {
        parts.push("atempo=2.0".to_string());
        s /= 2.0;
    }
    while s < 0.5 {
        parts.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    if (s - 1.0).abs() > 1e-4 {
        parts.push(format!("atempo={s:.5}"));
    }
    parts.join(",")
}

/// The stand-in "source" the encoder settings are computed for: the timeline itself.
pub fn timeline_source(p: &Plan) -> Source {
    let total: f64 = p.segs.iter().map(|s| s.dur / s.speed.max(0.01)).sum();
    let fps_num = (p.fps * 1000.0).round() as u32;
    Source {
        path: String::new(),
        name: String::new(),
        size: 0,
        duration: total,
        vindex: 0,
        width: p.width,
        height: p.height,
        fps_num,
        fps_den: 1000,
        fps: p.fps,
        vcodec: "rawvideo".into(),
        pix_fmt: "yuv420p".into(),
        bit_depth: 8,
        chroma: "4:2:0".into(),
        color_primaries: "bt709".into(),
        color_trc: "bt709".into(),
        colorspace: "bt709".into(),
        color_range: "tv".into(),
        hdr: false,
        audio: vec![Audio { index: 0, codec: "pcm_f32le".into(), channels: 2, layout: "stereo".into(), sample_rate: 48000, bit_rate: None }],
        subs: vec![],
        attachments: 0,
        format: String::new(),
        created: 0,
        modified: 0,
        time_base: String::new(),
    }
}

pub struct Built {
    pub args: Vec<String>,
    pub graph: String,
    pub duration: f64,
}

/// Inputs + filter graph + encoder options. `graph_file` is where the caller writes the graph
/// (passed with `-filter_complex_script`/`-/filter_complex`), `new_syntax` for ffmpeg 7+.
pub fn build(p: &Plan, hw: &Hw, graph_file: &str, new_syntax: bool, has_ass: bool, out: &str) -> Result<Built, String> {
    if p.segs.is_empty() {
        return Err("타임라인이 비어 있습니다.".into());
    }
    let (w, h) = (p.width.max(16) / 2 * 2, p.height.max(16) / 2 * 2);
    let fps = if p.fps > 0.0 { p.fps } else { 30.0 };
    let mut inputs: Vec<String> = Vec::new();
    let mut g = String::new();
    let mut n_in = 0usize;
    let mut labels = String::new();
    let audio_only = p.mode == "audio";
    for (i, sg) in p.segs.iter().enumerate() {
        let speed = sg.speed.clamp(0.0625, 16.0);
        let out_dur = sg.dur / speed;
        let vi = n_in;
        if sg.kind == "image" {
            inputs.extend(v(&["-loop", "1", "-framerate", &format!("{fps:.3}"), "-t", &format!("{:.3}", out_dur), "-i", &sg.path]));
        } else {
            inputs.extend(v(&["-ss", &format!("{:.3}", sg.start.max(0.0)), "-t", &format!("{:.3}", sg.dur), "-i", &sg.path]));
        }
        n_in += 1;
        if !audio_only {
            let mut chain: Vec<String> = Vec::new();
            let lens = sg.lens.clone().filter(|l| l.layout != "none" && !l.layout.is_empty());
            let src_label;
            if sg.kind == "audio" {
                // Black picture under an audio-only clip.
                g += &format!("color=c=black:s={w}x{h}:r={fps:.3}:d={out_dur:.3}[bk{i}];");
                src_label = format!("bk{i}");
            } else if let Some(l) = &lens {
                g += &media::lens_source(vi, l, None, &format!("ls{i}"));
                g += ";";
                src_label = format!("ls{i}");
                let view = sg.view.clone().unwrap_or(View { yaw: 0.0, pitch: 0.0, roll: 0.0, hfov: 100.0 });
                chain.push(media::v360_flat(l, &view, w, h));
            } else {
                src_label = format!("{vi}:v:0");
                if sg.fit == "fill" {
                    chain.push(format!("scale={w}:{h}:force_original_aspect_ratio=increase:flags=bicubic,crop={w}:{h}"));
                } else {
                    chain.push(format!("scale={w}:{h}:force_original_aspect_ratio=decrease:flags=bicubic,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"));
                }
            }
            chain.push("setsar=1".into());
            if sg.kind != "audio" {
                chain.push(format!("setpts=(PTS-STARTPTS)/{speed:.5}"));
            }
            chain.push(format!("fps={fps:.5}"));
            chain.push("format=yuv420p".into());
            if sg.fade_in > 0.0 {
                chain.push(format!("fade=t=in:st=0:d={:.3}", sg.fade_in));
            }
            if sg.fade_out > 0.0 {
                chain.push(format!("fade=t=out:st={:.3}:d={:.3}", (out_dur - sg.fade_out).max(0.0), sg.fade_out));
            }
            // Exactly the clip length so audio and picture stay together across the concat.
            chain.push(format!("trim=duration={out_dur:.4}"));
            g += &format!("[{src_label}]{}[v{i}];", chain.join(","));
            labels += &format!("[v{i}]");
        }
        // audio
        let mut ach: Vec<String> = vec!["aresample=48000".into(), "aformat=sample_fmts=fltp:channel_layouts=stereo".into(), "asetpts=PTS-STARTPTS".into()];
        let at = atempo(speed);
        if !at.is_empty() {
            ach.push(at);
        }
        if (sg.volume - 1.0).abs() > 1e-3 {
            ach.push(format!("volume={:.3}", sg.volume.max(0.0)));
        }
        if sg.fade_in > 0.0 {
            ach.push(format!("afade=t=in:st=0:d={:.3}", sg.fade_in));
        }
        if sg.fade_out > 0.0 {
            ach.push(format!("afade=t=out:st={:.3}:d={:.3}", (out_dur - sg.fade_out).max(0.0), sg.fade_out));
        }
        ach.push(format!("apad,atrim=duration={out_dur:.4}"));
        if sg.has_audio && sg.kind != "image" && sg.volume > 0.0 {
            g += &format!("[{vi}:a:0]{}[a{i}];", ach.join(","));
        } else {
            g += &format!("anullsrc=r=48000:cl=stereo,atrim=duration={out_dur:.4}[a{i}];");
        }
        labels += &format!("[a{i}]");
    }
    let n = p.segs.len();
    let duration: f64 = p.segs.iter().map(|s| s.dur / s.speed.clamp(0.0625, 16.0)).sum();
    if audio_only {
        g += &format!("{labels}concat=n={n}:v=0:a=1[ac]");
    } else {
        g += &format!("{labels}concat=n={n}:v=1:a=1[vc][ac]");
    }
    // music
    let mut amix_inputs = vec!["[ac]".to_string()];
    for (k, m) in p.music.iter().enumerate() {
        inputs.extend(v(&["-ss", &format!("{:.3}", m.start.max(0.0)), "-t", &format!("{:.3}", m.dur), "-i", &m.path]));
        let mi = n_in;
        n_in += 1;
        let ms = (m.at.max(0.0) * 1000.0).round() as u64;
        let mut ch = vec!["aresample=48000".to_string(), "aformat=sample_fmts=fltp:channel_layouts=stereo".into(), "asetpts=PTS-STARTPTS".into(), format!("volume={:.3}", m.volume.max(0.0))];
        if m.fade_in > 0.0 {
            ch.push(format!("afade=t=in:st=0:d={:.3}", m.fade_in));
        }
        if m.fade_out > 0.0 {
            ch.push(format!("afade=t=out:st={:.3}:d={:.3}", (m.dur - m.fade_out).max(0.0), m.fade_out));
        }
        ch.push(format!("adelay={ms}|{ms}"));
        g += &format!(";[{mi}:a:0]{}[m{k}]", ch.join(","));
        amix_inputs.push(format!("[m{k}]"));
    }
    let alabel = if amix_inputs.len() > 1 {
        g += &format!(";{}amix=inputs={}:duration=first:normalize=0:dropout_transition=0[am]", amix_inputs.join(""), amix_inputs.len());
        "[am]"
    } else {
        "[ac]"
    };
    let src = timeline_source(p);
    let threads = hw.threads.max(1);
    let mut a = inputs;
    let mut vlabel = "[vc]".to_string();
    if !audio_only {
        let mut post: Vec<String> = Vec::new();
        if has_ass {
            post.push("subtitles=captions.ass".into());
        }
        if p.mode == "shrink" {
            if let Some(s) = &p.settings {
                post.extend(args::filters(s, &src));
            }
        }
        if !post.is_empty() {
            g += &format!(";[vc]{}[vo]", post.join(","));
            vlabel = "[vo]".into();
        }
    }
    let _ = graph_file;
    if new_syntax {
        a.extend(v(&["-/filter_complex", graph_file]));
    } else {
        a.extend(v(&["-filter_complex_script", graph_file]));
    }
    if !audio_only {
        a.extend(v(&["-map", &vlabel]));
    }
    a.extend(v(&["-map", alabel, "-filter_threads", &threads.to_string()]));
    match p.mode.as_str() {
        "audio" => {
            a.extend(v(&["-c:a", "pcm_s16le", "-f", "wav"]));
        }
        "shrink" => {
            let s = p.settings.clone().ok_or("압축 설정이 없습니다")?;
            let enc = args::encoder(&s, &src, hw)?;
            a.extend(args::video_args(&enc, &s, &src, threads));
            a.extend(args::audio_track_args(&s, &src.audio[0], 0, &s.container));
            if s.container == "mp4" {
                a.extend(v(&["-movflags", "+faststart", "-f", "mp4"]));
            } else {
                a.extend(v(&["-f", "matroska"]));
            }
        }
        _ => {
            // Standard: H.264 at a fixed bitrate per resolution, AAC 256k, BT.709 tags (what the
            // original app's export does). The GPU H.264 encoder when it works, else x264.
            let rate = p.vbitrate.clamp(500, 200_000);
            let (b, max, buf) = (format!("{rate}k"), format!("{}k", rate * 3 / 2), format!("{}k", rate * 2));
            let enc = hw.h264.clone().unwrap_or_else(|| "libx264".into());
            if enc == "libx264" {
                a.extend(v(&["-c:v", "libx264", "-preset", "medium", "-b:v", &b, "-maxrate", &max, "-bufsize", &buf, "-pix_fmt", "yuv420p", "-threads", &threads.to_string()]));
            } else if enc.ends_with("_nvenc") {
                a.extend(v(&["-c:v", &enc, "-preset", "p5", "-rc", "vbr", "-b:v", &b, "-maxrate", &max, "-bufsize", &buf, "-pix_fmt", "yuv420p"]));
            } else if enc.ends_with("_qsv") {
                a.extend(v(&["-c:v", &enc, "-preset", "medium", "-b:v", &b, "-maxrate", &max, "-bufsize", &buf, "-pix_fmt", "nv12"]));
            } else {
                a.extend(v(&["-c:v", &enc, "-rc", "vbr_peak", "-b:v", &b, "-maxrate", &max, "-bufsize", &buf, "-pix_fmt", "nv12"]));
            }
            a.extend(v(&["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]));
            a.extend(v(&["-g", &((fps * 2.0).round() as u32).to_string(), "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", "-f", "mp4"]));
        }
    }
    a.push(out.to_string());
    Ok(Built { args: a, graph: g, duration })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(path: &str, start: f64, dur: f64) -> Seg {
        Seg { path: path.into(), kind: "video".into(), start, dur, speed: 1.0, volume: 1.0, has_audio: true, lens: None, view: None, fit: String::new(), fade_in: 0.0, fade_out: 0.0 }
    }

    #[test]
    fn two_clips_graph() {
        let p = Plan { segs: vec![seg("a.mp4", 1.0, 2.0), seg("b.mp4", 0.0, 3.0)], music: vec![], width: 1920, height: 1080, fps: 30.0, ass: String::new(), mode: "standard".into(), vbitrate: 8000, settings: None, out: "o.mp4".into() };
        let b = build(&p, &Hw::default(), "g.txt", false, false, "o.part.mp4").unwrap();
        assert!(b.graph.contains("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][ac]"), "{}", b.graph);
        assert!((b.duration - 5.0).abs() < 1e-9);
        assert!(b.args.contains(&"-filter_complex_script".to_string()));
        assert!(b.args.contains(&"libx264".to_string()));
    }

    #[test]
    fn speed_and_360() {
        let mut s = seg("c.osv", 0.0, 4.0);
        s.speed = 2.0;
        s.lens = Some(Lens { layout: "dual".into(), swap: false, fov: 190.0 });
        s.view = Some(View { yaw: 10.0, pitch: 0.0, roll: 0.0, hfov: 90.0 });
        let p = Plan { segs: vec![s], music: vec![], width: 1280, height: 720, fps: 30.0, ass: String::new(), mode: "standard".into(), vbitrate: 8000, settings: None, out: "o.mp4".into() };
        let b = build(&p, &Hw::default(), "g.txt", true, false, "o.part.mp4").unwrap();
        assert!(b.graph.contains("[0:v:0][0:v:1]hstack[ls0]"));
        assert!(b.graph.contains("v360=input=dfisheye"));
        assert!(b.graph.contains("atempo=2.0") || b.graph.contains("atempo=2.00000"), "{}", b.graph);
        assert!((b.duration - 2.0).abs() < 1e-9);
    }

    #[test]
    fn atempo_chain() {
        assert_eq!(atempo(1.0), "");
        assert_eq!(atempo(4.0), "atempo=2.0,atempo=2.00000");
        assert_eq!(atempo(0.25), "atempo=0.5,atempo=0.50000");
        assert_eq!(atempo(1.5), "atempo=1.50000");
    }
}
