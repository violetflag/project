//! What ffprobe says about the source file (PRD F1).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Audio {
    pub index: u32,
    pub codec: String,
    pub channels: u32,
    pub layout: String,
    pub sample_rate: u32,
    /// bits/s; estimated from the format bitrate when the stream does not say.
    pub bit_rate: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Sub {
    pub index: u32,
    pub codec: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Source {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub duration: f64,
    pub vindex: u32,
    /// Display size (rotation applied).
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub fps: f64,
    pub vcodec: String,
    pub pix_fmt: String,
    pub bit_depth: u32,
    pub chroma: String,
    pub color_primaries: String,
    pub color_trc: String,
    pub colorspace: String,
    pub color_range: String,
    pub hdr: bool,
    pub audio: Vec<Audio>,
    pub subs: Vec<Sub>,
    pub attachments: u32,
    pub format: String,
    /// File times, ms since 1970 (for sorting clips to merge).
    #[serde(default)]
    pub created: u64,
    #[serde(default)]
    pub modified: u64,
    /// The video stream's time base, e.g. "1/15000": the concat demuxer only joins clips that share it.
    #[serde(default)]
    pub time_base: String,
}

fn file_times(path: &str) -> (u64, u64) {
    let ms = |t: std::io::Result<std::time::SystemTime>| t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    std::fs::metadata(path).map(|m| (ms(m.created()), ms(m.modified()))).unwrap_or((0, 0))
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn num<T: std::str::FromStr>(v: &Value, k: &str) -> Option<T> {
    match v.get(k)? {
        Value::String(x) => x.parse().ok(),
        Value::Number(n) => n.to_string().parse().ok(),
        _ => None,
    }
}

fn ratio(r: &str) -> Option<(u32, u32)> {
    let (a, b) = r.split_once('/')?;
    let (a, b) = (a.parse::<u32>().ok()?, b.parse::<u32>().ok()?);
    (a > 0 && b > 0).then_some((a, b))
}

pub fn bit_depth_of(pix_fmt: &str, raw: Option<u32>) -> u32 {
    if let Some(b) = raw.filter(|b| *b >= 8) {
        return b;
    }
    if pix_fmt.contains("12") {
        12
    } else if pix_fmt.contains("10") || pix_fmt.starts_with("p010") {
        10
    } else {
        8
    }
}

pub fn chroma_of(pix_fmt: &str) -> &'static str {
    if pix_fmt.contains("444") {
        "4:4:4"
    } else if pix_fmt.contains("422") {
        "4:2:2"
    } else {
        "4:2:0"
    }
}

pub fn probe(ffprobe: &Path, path: &str) -> Result<Source, String> {
    let args: Vec<String> = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path].iter().map(|x| x.to_string()).collect();
    let (ok, out, err) = crate::ff::output(ffprobe, &args)?;
    if !ok {
        return Err(format!("파일을 읽을 수 없습니다. 손상되었거나 영상이 아닙니다.\n{}", err.trim()));
    }
    let j: Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let streams = j.get("streams").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let fmt = j.get("format").cloned().unwrap_or(Value::Null);

    let v = streams
        .iter()
        .find(|st| s(st, "codec_type") == "video" && st.pointer("/disposition/attached_pic").and_then(|x| x.as_i64()).unwrap_or(0) == 0)
        .ok_or("영상 트랙이 없는 파일입니다.")?;

    let duration = num::<f64>(&fmt, "duration").or_else(|| num(v, "duration")).unwrap_or(0.0);
    if duration <= 0.0 {
        return Err("영상 길이를 알 수 없습니다. 파일이 손상되었을 수 있습니다.".into());
    }
    let (fps_num, fps_den) = ratio(&s(v, "avg_frame_rate")).or_else(|| ratio(&s(v, "r_frame_rate"))).unwrap_or((30, 1));
    let pix_fmt = s(v, "pix_fmt");
    let (mut width, mut height) = (num::<u32>(v, "width").unwrap_or(0), num::<u32>(v, "height").unwrap_or(0));
    let rotation = v
        .get("side_data_list")
        .and_then(|x| x.as_array())
        .and_then(|l| l.iter().find_map(|d| d.get("rotation").and_then(|r| r.as_f64())))
        .or_else(|| v.pointer("/tags/rotate").and_then(|x| x.as_str()).and_then(|x| x.parse().ok()))
        .unwrap_or(0.0);
    if (rotation.abs() as i64) % 180 == 90 {
        std::mem::swap(&mut width, &mut height);
    }
    let trc = s(v, "color_transfer");
    let size = num::<u64>(&fmt, "size").or_else(|| std::fs::metadata(path).ok().map(|m| m.len())).unwrap_or(0);

    let audio_streams: Vec<&Value> = streams.iter().filter(|st| s(st, "codec_type") == "audio").collect();
    let audio = audio_streams
        .iter()
        .map(|a| Audio {
            index: num(a, "index").unwrap_or(0),
            codec: s(a, "codec_name"),
            channels: num(a, "channels").unwrap_or(2),
            layout: s(a, "channel_layout"),
            sample_rate: num(a, "sample_rate").unwrap_or(48000),
            bit_rate: num::<u64>(a, "bit_rate").or_else(|| {
                // MKV keeps per-stream statistics in tags.
                a.pointer("/tags/BPS").and_then(|x| x.as_str()).and_then(|x| x.parse().ok())
            }),
        })
        .collect();
    let subs = streams
        .iter()
        .filter(|st| s(st, "codec_type") == "subtitle")
        .map(|st| Sub { index: num(st, "index").unwrap_or(0), codec: s(st, "codec_name") })
        .collect();
    let attachments = streams.iter().filter(|st| s(st, "codec_type") == "attachment").count() as u32;
    let (created, modified) = file_times(path);

    Ok(Source {
        created,
        modified,
        time_base: s(v, "time_base"),
        path: path.to_string(),
        name: Path::new(path).file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default(),
        size,
        duration,
        vindex: num(v, "index").unwrap_or(0),
        width,
        height,
        fps_num,
        fps_den,
        fps: fps_num as f64 / fps_den as f64,
        vcodec: s(v, "codec_name"),
        bit_depth: bit_depth_of(&pix_fmt, num(v, "bits_per_raw_sample")),
        chroma: chroma_of(&pix_fmt).into(),
        pix_fmt,
        color_primaries: s(v, "color_primaries"),
        hdr: trc == "smpte2084" || trc == "arib-std-b67",
        color_trc: trc,
        colorspace: s(v, "color_space"),
        color_range: s(v, "color_range"),
        audio,
        subs,
        attachments,
        format: s(&fmt, "format_name"),
    })
}

/// Stream durations and counts of a finished file, for the check after compressing (PRD F6).
#[derive(Debug, Default, Serialize, Clone)]
pub struct Check {
    pub video: Option<f64>,
    pub audio: Option<f64>,
    pub n_video: u32,
    pub n_audio: u32,
    pub n_subs: u32,
    pub duration: f64,
}

fn tag_duration(st: &Value) -> Option<f64> {
    // MKV: tags.DURATION = "00:12:34.123000000"
    let t = st.pointer("/tags/DURATION").and_then(|x| x.as_str())?;
    let mut parts = t.split(':');
    let (h, m, sec) = (parts.next()?.parse::<f64>().ok()?, parts.next()?.parse::<f64>().ok()?, parts.next()?.parse::<f64>().ok()?);
    Some(h * 3600.0 + m * 60.0 + sec)
}

pub fn check(ffprobe: &Path, path: &str) -> Result<Check, String> {
    let args: Vec<String> = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path].iter().map(|x| x.to_string()).collect();
    let (ok, out, err) = crate::ff::output(ffprobe, &args)?;
    if !ok {
        return Err(err);
    }
    let j: Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let mut c = Check { duration: j.pointer("/format/duration").and_then(|x| x.as_str()).and_then(|x| x.parse().ok()).unwrap_or(0.0), ..Default::default() };
    for st in j.get("streams").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
        let d = num::<f64>(&st, "duration").or_else(|| tag_duration(&st));
        match s(&st, "codec_type").as_str() {
            "video" => {
                c.n_video += 1;
                if c.video.is_none() {
                    c.video = d;
                }
            }
            "audio" => {
                c.n_audio += 1;
                if c.audio.is_none() {
                    c.audio = d;
                }
            }
            "subtitle" => c.n_subs += 1,
            _ => {}
        }
    }
    Ok(c)
}

