//! Export: a Draft (the clips in order, already resolved by the editor) into one file. Two ways
//! to encode: "standard" (H.264/AAC MP4 at a chosen resolution, like the original app's export)
//! and "shrink" (the compression presets of the Shrink app: AV1/HEVC/H.264 at a CRF, Opus audio,
//! fps cap, denoise), sharing `args.rs` with Shrink so the result is the same.

use crate::args::{self, Settings};
use crate::hw::Hw;
use crate::media::{self, Lens, View};
use crate::stitch;
use crate::probe::{Audio, Source};
use serde::{Deserialize, Serialize};

/// Where a picture sits in the frame. x/y move its centre by a fraction of the frame width and
/// height (0 = centred); crops are fractions of the source cut from each edge; rotation is in
/// degrees, clockwise.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotation: f64,
    pub crop_l: f64,
    pub crop_r: f64,
    pub crop_t: f64,
    pub crop_b: f64,
    pub opacity: f64,
}

impl Default for Transform {
    fn default() -> Self {
        Transform { x: 0.0, y: 0.0, scale: 1.0, rotation: 0.0, crop_l: 0.0, crop_r: 0.0, crop_t: 0.0, crop_b: 0.0, opacity: 1.0 }
    }
}

impl Transform {
    fn crops(&self) -> [f64; 4] {
        [self.crop_l, self.crop_r, self.crop_t, self.crop_b].map(|c| c.clamp(0.0, 0.45))
    }
    fn cropped(&self) -> bool {
        self.crops().iter().any(|c| *c > 1e-4)
    }
    fn rotated(&self) -> bool {
        self.rotation.abs() > 1e-3
    }
    fn opacity(&self) -> f64 {
        self.opacity.clamp(0.0, 1.0)
    }
    fn identity(&self) -> bool {
        self.x.abs() < 1e-4 && self.y.abs() < 1e-4 && (self.scale - 1.0).abs() < 1e-4 && !self.rotated() && !self.cropped() && self.opacity() > 0.999
    }
}

/// Colour correction. Neutral values: exposure 0 (stops), contrast 1, saturation 1,
/// temperature 6500 (Kelvin), lut "" (else an absolute path to a .cube file).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ColorAdj {
    pub exposure: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub temperature: f64,
    pub lut: String,
}

impl Default for ColorAdj {
    fn default() -> Self {
        ColorAdj { exposure: 0.0, contrast: 1.0, saturation: 1.0, temperature: 6500.0, lut: String::new() }
    }
}

/// A 360 view at `t` seconds from the start of the clip, in output time (after speed).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ViewKey {
    pub t: f64,
    pub view: View,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Seg {
    pub path: String,
    /// video | image | audio | gap (black and silent, no file)
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
    #[serde(default)]
    pub transform: Option<Transform>,
    #[serde(default)]
    pub color: Option<ColorAdj>,
    #[serde(default)]
    pub denoise: bool,
    /// With two or more, the 360 view moves between them (replaces `view`).
    #[serde(default)]
    pub view_keys: Vec<ViewKey>,
    /// Cross-dissolve from the previous clip, seconds (0 = cut).
    #[serde(default)]
    pub xin: f64,
}

impl Default for Seg {
    fn default() -> Self {
        Seg {
            path: String::new(),
            kind: "video".into(),
            start: 0.0,
            dur: 0.0,
            speed: 1.0,
            volume: 1.0,
            has_audio: false,
            lens: None,
            view: None,
            fit: String::new(),
            fade_in: 0.0,
            fade_out: 0.0,
            transform: None,
            color: None,
            denoise: false,
            view_keys: vec![],
            xin: 0.0,
        }
    }
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
    #[serde(default)]
    pub denoise: bool,
}

impl Default for Music {
    fn default() -> Self {
        Music { path: String::new(), start: 0.0, dur: 0.0, at: 0.0, volume: 1.0, fade_in: 0.0, fade_out: 0.0, denoise: false }
    }
}

/// A picture on track V2/V3 drawn over the main track. Its sound is off unless `volume` > 0.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Overlay {
    pub path: String,
    /// video | image
    pub kind: String,
    /// Source seconds.
    pub start: f64,
    pub dur: f64,
    #[serde(default = "one")]
    pub speed: f64,
    /// Seconds on the timeline.
    pub at: f64,
    /// 2 or 3; higher draws on top.
    #[serde(default = "two")]
    pub track: u8,
    #[serde(default)]
    pub volume: f64,
    #[serde(default)]
    pub has_audio: bool,
    #[serde(default)]
    pub lens: Option<Lens>,
    #[serde(default)]
    pub view: Option<View>,
    #[serde(default)]
    pub view_keys: Vec<ViewKey>,
    /// fit | fill (the box the picture is sized to before `transform.scale`)
    #[serde(default)]
    pub fit: String,
    #[serde(default)]
    pub transform: Option<Transform>,
    #[serde(default)]
    pub color: Option<ColorAdj>,
    #[serde(default)]
    pub denoise: bool,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
}

impl Default for Overlay {
    fn default() -> Self {
        Overlay {
            path: String::new(),
            kind: "video".into(),
            start: 0.0,
            dur: 0.0,
            speed: 1.0,
            at: 0.0,
            track: 2,
            volume: 0.0,
            has_audio: false,
            lens: None,
            view: None,
            view_keys: vec![],
            fit: String::new(),
            transform: None,
            color: None,
            denoise: false,
            fade_in: 0.0,
            fade_out: 0.0,
        }
    }
}

fn one() -> f64 {
    1.0
}
fn two() -> u8 {
    2
}
fn fhd_rate() -> u32 {
    8000
}
fn aac_rate() -> u32 {
    256
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
    /// Tracks V2/V3.
    #[serde(default)]
    pub overlays: Vec<Overlay>,
    /// Even out the loudness of the final mix (-14 LUFS).
    #[serde(default)]
    pub loudnorm: bool,
    /// Lower the music while the main track has sound.
    #[serde(default)]
    pub duck: bool,
    /// For "standard": AAC bitrate in kbit/s.
    #[serde(default = "aac_rate")]
    pub abr: u32,
}

impl Default for Plan {
    fn default() -> Self {
        Plan {
            segs: vec![],
            music: vec![],
            width: 1920,
            height: 1080,
            fps: 30.0,
            ass: String::new(),
            mode: "standard".into(),
            vbitrate: fhd_rate(),
            settings: None,
            out: String::new(),
            overlays: vec![],
            loudnorm: false,
            duck: false,
            abr: aac_rate(),
        }
    }
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

const DENOISE: &str = "afftdn=nf=-25";

/// A file path as a filter option value: forward slashes and `\:`/`\'` for the option parser,
/// then single quotes for the graph parser (a `'` in the path leaves and re-enters the quotes).
fn filter_path(p: &str) -> String {
    let inner = p.replace('\\', "/").replace('\'', "\\'").replace(':', "\\:");
    format!("'{}'", inner.replace('\'', "'\\''"))
}

/// LUT, then eq, then colour temperature; nothing for neutral values. Exposure is a gamma
/// curve, 2^(0.75 × stops), so black and white stay put while the mid-tones move.
fn color_filters(c: &Option<ColorAdj>) -> Vec<String> {
    let Some(c) = c else { return vec![] };
    let mut f = Vec::new();
    if !c.lut.trim().is_empty() {
        f.push(format!("lut3d=file={}", filter_path(c.lut.trim())));
    }
    let mut eq = Vec::new();
    if (c.contrast - 1.0).abs() > 1e-3 {
        eq.push(format!("contrast={:.3}", c.contrast.clamp(0.0, 3.0)));
    }
    if (c.saturation - 1.0).abs() > 1e-3 {
        eq.push(format!("saturation={:.3}", c.saturation.clamp(0.0, 3.0)));
    }
    if c.exposure.abs() > 1e-3 {
        eq.push(format!("gamma={:.3}", 2f64.powf(0.75 * c.exposure.clamp(-2.0, 2.0))));
    }
    if !eq.is_empty() {
        f.push(format!("eq={}", eq.join(":")));
    }
    if (c.temperature - 6500.0).abs() >= 1.0 {
        f.push(format!("colortemperature=temperature={:.0}", c.temperature.clamp(1000.0, 40000.0)));
    }
    f
}

fn wrap180(d: f64) -> f64 {
    (d + 180.0).rem_euclid(360.0) - 180.0
}

/// The view at `t` (keys sorted by time): linear between keys, the nearest key outside them.
/// Yaw takes the shorter way round.
fn view_at(keys: &[ViewKey], t: f64) -> View {
    let (first, last) = (&keys[0], &keys[keys.len() - 1]);
    if t <= first.t {
        return first.view.clone();
    }
    if t >= last.t {
        return last.view.clone();
    }
    let i = keys.windows(2).position(|w| t < w[1].t).unwrap_or(keys.len() - 2);
    let (a, b) = (&keys[i].view, &keys[i + 1].view);
    let span = keys[i + 1].t - keys[i].t;
    let f = if span > 1e-9 { (t - keys[i].t) / span } else { 1.0 };
    let lerp = |x: f64, y: f64| x + (y - x) * f;
    View { yaw: wrap180(a.yaw + wrap180(b.yaw - a.yaw) * f), pitch: lerp(a.pitch, b.pitch), roll: lerp(a.roll, b.roll), hfov: lerp(a.hfov, b.hfov) }
}

const KEY_STEP: f64 = 1.0 / 15.0;

/// A moving 360 view: `sendcmd` that sets the changed angles every 1/15 s, then the named v360
/// (`v360@name`) starting at the first view. v360 rebuilds its maps on every command, so the
/// zoom goes as one `d_fov` (the same h/v pair `media::v360_flat` makes) instead of two. Needs
/// `reset_rot=1`, else each command turns the view further instead of setting it. None when the
/// keys never move the view within `len`.
fn view_anim(lens: &Lens, keys: &[ViewKey], name: &str, w: u32, h: u32, len: f64) -> Option<(String, String)> {
    let mut keys = keys.to_vec();
    keys.sort_by(|a, b| a.t.total_cmp(&b.t));
    let dfov = |hf: f64| 2.0 * ((hf.clamp(20.0, 160.0).to_radians() / 2.0).tan() * (w as f64).hypot(h as f64) / w as f64).atan().to_degrees();
    let vals = |vw: &View| [wrap180(vw.yaw), vw.pitch.clamp(-180.0, 180.0), vw.roll.clamp(-180.0, 180.0), dfov(vw.hfov)].map(|x| format!("{x:.3}"));
    let (v0, steps) = view_steps(&keys, len);
    let mut prev = vals(&v0);
    let mut cmds = Vec::new();
    for (t, vw) in steps {
        let cur = vals(&vw);
        let set: Vec<String> = ["yaw", "pitch", "roll", "d_fov"].iter().zip(cur.iter().zip(&prev)).filter(|(_, (c, p))| c != p).map(|(o, (c, _))| format!("v360@{name} {o} {c}")).collect();
        if !set.is_empty() {
            cmds.push(format!("{t:.3} {}", set.join(", ")));
        }
        prev = cur;
    }
    if cmds.is_empty() {
        return None;
    }
    let v360 = media::v360_flat(lens, &v0, w, h).replacen("v360=", &format!("v360@{name}="), 1) + ":reset_rot=1";
    Some((format!("sendcmd=c='{}'", cmds.join(";")), v360))
}

/// The start view and the view every 1/15 s (output seconds) up to the last key or `len`.
/// `keys` sorted by time.
fn view_steps(keys: &[ViewKey], len: f64) -> (View, Vec<(f64, View)>) {
    let mut v0 = view_at(keys, 0.0);
    v0.yaw = wrap180(v0.yaw);
    let end = keys[keys.len() - 1].t.min(len);
    let mut times: Vec<f64> = (1..).map(|k| k as f64 * KEY_STEP).take_while(|t| *t < end - 1e-6).collect();
    if end > 0.0 {
        times.push(end);
    }
    let steps = times.into_iter().map(|t| (t, view_at(keys, t))).collect();
    (v0, steps)
}

/// The 360 picture stitched from both lenses (`stitch`): the graph text up to `[ls]` and whether
/// the speed's setpts is already in.
fn stitched(p: &Pic, l: &Lens, ls: &str, w: u32, h: u32) -> (String, bool) {
    let moving = p.keys.len() >= 2 && view_anim(l, p.keys, &p.vname, w, h, p.len).is_some();
    let mut keys = p.keys.to_vec();
    keys.sort_by(|a, b| a.t.total_cmp(&b.t));
    let still = if p.keys.len() >= 2 { view_at(&keys, 0.0) } else { p.view.clone().unwrap_or(View { yaw: 0.0, pitch: 0.0, roll: 0.0, hfov: 100.0 }) };
    let moves = moving.then(|| {
        let (v0, steps) = view_steps(&keys, p.len);
        stitch::Moves { v0, steps }
    });
    let pre = if moving { speed_pts(p.speed) } else { String::new() };
    (stitch::graph(p.vi, l, None, &pre, &stitch::Out::Flat { view: &still, w, h }, moves.as_ref(), ls) + ";", moving)
}

fn even(x: f64) -> u32 {
    ((x / 2.0).round() as u32).max(1) * 2
}

/// One clip's picture source, shared by the main track and the overlays.
struct Pic<'a> {
    vi: usize,
    tag: String,
    vname: String,
    lens: Option<Lens>,
    view: &'a Option<View>,
    keys: &'a [ViewKey],
    fit: &'a str,
    tf: Option<Transform>,
    color: Vec<String>,
    speed: f64,
    len: f64,
}

fn speed_pts(speed: f64) -> String {
    format!("setpts=(PTS-STARTPTS)/{speed:.5}")
}

/// Graph text that comes first (the 360 lens stacking), the label the chain reads, and the
/// filters up to a sized picture: the 360 view, or crop + fit/fill; then colour; then the
/// transform's scale. `pad` keeps the plain main-track fit (black bars to the full frame). The
/// flag says whether the speed's setpts is already in (a moving view runs on output time).
fn shape(p: &Pic, w: u32, h: u32, pad: bool) -> (String, String, Vec<String>, bool) {
    let mut chain = Vec::new();
    let s = p.tf.as_ref().map(|t| t.scale.clamp(0.05, 8.0)).unwrap_or(1.0);
    let (bw, bh) = (even(w as f64 * s), even(h as f64 * s));
    if let Some(l) = &p.lens {
        let ls = format!("ls{}", p.tag);
        if stitch::active(l) {
            let (pre, timed) = stitched(p, l, &ls, w, h);
            chain.extend(p.color.iter().cloned());
            if (s - 1.0).abs() > 1e-4 {
                chain.push(format!("scale={bw}:{bh}:flags=bicubic"));
            }
            return (pre, ls, chain, timed);
        }
        let pre = media::lens_source(p.vi, l, None, &ls) + ";";
        let moving = if p.keys.len() >= 2 { view_anim(l, p.keys, &p.vname, w, h, p.len) } else { None };
        let timed = moving.is_some();
        if let Some((cmd, v360)) = moving {
            chain.extend([speed_pts(p.speed), cmd, v360]);
        } else {
            let view = if p.keys.len() >= 2 {
                let mut k = p.keys.to_vec();
                k.sort_by(|a, b| a.t.total_cmp(&b.t));
                view_at(&k, 0.0)
            } else {
                p.view.clone().unwrap_or(View { yaw: 0.0, pitch: 0.0, roll: 0.0, hfov: 100.0 })
            };
            chain.push(media::v360_flat(l, &view, w, h));
        }
        chain.extend(p.color.iter().cloned());
        if (s - 1.0).abs() > 1e-4 {
            chain.push(format!("scale={bw}:{bh}:flags=bicubic"));
        }
        return (pre, ls, chain, timed);
    }
    if let Some(t) = p.tf.as_ref().filter(|t| t.cropped()) {
        let [l, r, tp, b] = t.crops();
        chain.push(format!("crop=iw*{:.4}:ih*{:.4}:iw*{l:.4}:ih*{tp:.4}", 1.0 - l - r, 1.0 - tp - b));
    }
    let fill = p.fit == "fill";
    if pad {
        if fill {
            chain.push(format!("scale={w}:{h}:force_original_aspect_ratio=increase:flags=bicubic,crop={w}:{h}"));
            chain.extend(p.color.iter().cloned());
        } else {
            chain.push(format!("scale={w}:{h}:force_original_aspect_ratio=decrease:flags=bicubic"));
            chain.extend(p.color.iter().cloned());
            chain.push(format!("pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"));
        }
    } else {
        if fill {
            chain.push(format!("scale={bw}:{bh}:force_original_aspect_ratio=increase:flags=bicubic,crop={bw}:{bh}"));
        } else {
            chain.push(format!("scale={bw}:{bh}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic"));
        }
        chain.extend(p.color.iter().cloned());
    }
    (String::new(), format!("{}:v:0", p.vi), chain, false)
}

/// Alpha steps of a transform: rotation (not for 360) with transparent corners, and opacity.
/// `alpha` forces a picture with an alpha plane even when neither is set (overlays).
fn alpha_filters(t: &Transform, rotate: bool, alpha: bool) -> Vec<String> {
    let rot = rotate && t.rotated();
    let op = t.opacity();
    let mut f = Vec::new();
    if alpha || rot || op < 0.999 {
        f.push("format=yuva420p".to_string());
    }
    if rot {
        let a = t.rotation.to_radians();
        f.push(format!("rotate=a={a:.6}:ow=ceil(rotw({a:.6})/2)*2:oh=ceil(roth({a:.6})/2)*2:c=black@0"));
    }
    if op < 0.999 {
        f.push(format!("lutyuv=a=val*{op:.3}"));
    }
    f
}

/// overlay position: the picture's centre moved by x/y of the frame.
fn place(t: &Transform, w: u32, h: u32) -> String {
    format!("x=(W-w)/2{:+.2}:y=(H-h)/2{:+.2}", t.x * w as f64, t.y * h as f64)
}

/// Length of each main-track clip on the timeline and the dissolve into it: at most half of
/// either neighbour, 0 for a cut (and always for the first clip).
fn joins(p: &Plan) -> (Vec<f64>, Vec<f64>) {
    let fps = if p.fps > 0.0 { p.fps } else { 30.0 };
    let lens: Vec<f64> = p.segs.iter().map(|s| s.dur / s.speed.clamp(0.0625, 16.0)).collect();
    let xin = (0..lens.len())
        .map(|i| {
            if i == 0 {
                return 0.0;
            }
            let d = p.segs[i].xin.clamp(0.0, lens[i - 1].min(lens[i]) / 2.0);
            if d < 0.5 / fps { 0.0 } else { d }
        })
        .collect();
    (lens, xin)
}

/// The timeline's length: the clips end to end, less the dissolves.
pub fn timeline_duration(p: &Plan) -> f64 {
    let (lens, xin) = joins(p);
    lens.iter().sum::<f64>() - xin.iter().sum::<f64>()
}

/// The stand-in "source" the encoder settings are computed for: the timeline itself.
pub fn timeline_source(p: &Plan) -> Source {
    let total = timeline_duration(p);
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

fn lens_of(l: &Option<Lens>) -> Option<Lens> {
    l.clone().filter(|l| l.layout != "none" && !l.layout.is_empty())
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
    let (lens_t, xin) = joins(p);
    for (i, sg) in p.segs.iter().enumerate() {
        let speed = sg.speed.clamp(0.0625, 16.0);
        let out_dur = sg.dur / speed;
        let vi = n_in;
        let blank = sg.kind == "audio" || sg.kind == "gap";
        if sg.kind == "image" {
            inputs.extend(v(&["-loop", "1", "-framerate", &format!("{fps:.3}"), "-t", &format!("{:.3}", out_dur), "-i", &sg.path]));
            n_in += 1;
        } else if sg.kind != "gap" {
            inputs.extend(v(&["-ss", &format!("{:.3}", sg.start.max(0.0)), "-t", &format!("{:.3}", sg.dur), "-i", &sg.path]));
            n_in += 1;
        }
        if !audio_only {
            let tf = sg.transform.clone().filter(|t| !t.identity());
            let mut chain: Vec<String>;
            let src_label;
            let mut timed = false;
            if blank {
                // Black picture under an audio-only clip or a gap.
                g += &format!("color=c=black:s={w}x{h}:r={fps:.3}:d={out_dur:.3}[bk{i}];");
                src_label = format!("bk{i}");
                chain = Vec::new();
            } else {
                let pic = Pic { vi, tag: i.to_string(), vname: format!("k{i}"), lens: lens_of(&sg.lens), view: &sg.view, keys: &sg.view_keys, fit: &sg.fit, tf: tf.clone(), color: color_filters(&sg.color), speed, len: out_dur };
                let (pre, src, c, t) = shape(&pic, w, h, tf.is_none());
                g += &pre;
                (src_label, chain, timed) = (src, c, t);
            }
            chain.push("setsar=1".into());
            let mut tail: Vec<String> = Vec::new();
            match tf.as_ref().filter(|_| !blank) {
                Some(t) => {
                    // Transformed: the picture goes onto a black frame at its offset.
                    chain.extend(alpha_filters(t, lens_of(&sg.lens).is_none(), false));
                    if !timed {
                        chain.push(speed_pts(speed));
                    }
                    g += &format!("[{src_label}]{}[t{i}];", chain.join(","));
                    g += &format!("color=c=black:s={w}x{h}:r={fps:.3}:d={out_dur:.3}[cv{i}];");
                    tail.push(format!("overlay={}", place(t, w, h)));
                }
                None => {
                    if !blank && !timed {
                        chain.push(speed_pts(speed));
                    }
                }
            }
            tail.push(format!("fps={fps:.5}"));
            tail.push("format=yuv420p".into());
            if sg.fade_in > 0.0 {
                tail.push(format!("fade=t=in:st=0:d={:.3}", sg.fade_in));
            }
            if sg.fade_out > 0.0 {
                tail.push(format!("fade=t=out:st={:.3}:d={:.3}", (out_dur - sg.fade_out).max(0.0), sg.fade_out));
            }
            // Exactly the clip length so audio and picture stay together across the concat.
            tail.push(format!("trim=duration={out_dur:.4}"));
            if tf.is_some() && !blank {
                g += &format!("[cv{i}][t{i}]{}[v{i}];", tail.join(","));
            } else {
                chain.extend(tail);
                g += &format!("[{src_label}]{}[v{i}];", chain.join(","));
            }
            labels += &format!("[v{i}]");
        }
        // audio
        let mut ach: Vec<String> = vec!["aresample=48000".into(), "aformat=sample_fmts=fltp:channel_layouts=stereo".into(), "asetpts=PTS-STARTPTS".into()];
        if sg.denoise {
            ach.push(DENOISE.into());
        }
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
        if sg.has_audio && sg.kind != "image" && sg.kind != "gap" && sg.volume > 0.0 {
            g += &format!("[{vi}:a:0]{}[a{i}];", ach.join(","));
        } else {
            g += &format!("anullsrc=r=48000:cl=stereo,atrim=duration={out_dur:.4}[a{i}];");
        }
        labels += &format!("[a{i}]");
    }
    let n = p.segs.len();
    let duration = timeline_duration(p);
    // Clips joined by dissolves form groups; inside a group they are simply concatenated.
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for i in 0..n {
        if i == 0 || xin[i] > 0.0 {
            groups.push(vec![i]);
        } else {
            groups.last_mut().unwrap().push(i);
        }
    }
    if groups.len() == 1 {
        if audio_only {
            g += &format!("{labels}concat=n={n}:v=0:a=1[ac]");
        } else {
            g += &format!("{labels}concat=n={n}:v=1:a=1[vc][ac]");
        }
    } else {
        let mut acc = (String::new(), String::new());
        let mut len = 0.0;
        let last = groups.len() - 1;
        for (k, grp) in groups.iter().enumerate() {
            let glen: f64 = grp.iter().map(|i| lens_t[*i]).sum();
            let (gv, ga) = if grp.len() == 1 {
                let i = grp[0];
                if !audio_only {
                    // xfade wants the same time base on both sides; concat changes it.
                    g += &format!("[v{i}]settb=AVTB[gv{k}];");
                }
                (format!("[gv{k}]"), format!("[a{i}]"))
            } else {
                if audio_only {
                    let lab: String = grp.iter().map(|i| format!("[a{i}]")).collect();
                    g += &format!("{lab}concat=n={}:v=0:a=1[ga{k}];", grp.len());
                } else {
                    let lab: String = grp.iter().map(|i| format!("[v{i}][a{i}]")).collect();
                    g += &format!("{lab}concat=n={}:v=1:a=1[gc{k}][ga{k}];[gc{k}]settb=AVTB[gv{k}];", grp.len());
                }
                (format!("[gv{k}]"), format!("[ga{k}]"))
            };
            if k == 0 {
                acc = (gv, ga);
                len = glen;
                continue;
            }
            let d = xin[grp[0]];
            let (ov, oa) = if k == last { ("[vc]".to_string(), "[ac]".to_string()) } else { (format!("[xv{k}]"), format!("[xa{k}]")) };
            if !audio_only {
                g += &format!("{}{gv}xfade=transition=fade:duration={d:.4}:offset={:.4}{ov};", acc.0, len - d);
            }
            g += &format!("{}{ga}acrossfade=d={d:.4}{oa};", acc.1);
            acc = (ov, oa);
            len += glen - d;
        }
        g.pop();
    }
    // music
    let duck = p.duck && !p.music.is_empty();
    let mut amix_inputs = vec![if duck { "[ac1]".to_string() } else { "[ac]".to_string() }];
    if duck {
        g += ";[ac]asplit=2[ac1][ack]";
    }
    let mut music_labels = Vec::new();
    for (k, m) in p.music.iter().enumerate() {
        inputs.extend(v(&["-ss", &format!("{:.3}", m.start.max(0.0)), "-t", &format!("{:.3}", m.dur), "-i", &m.path]));
        let mi = n_in;
        n_in += 1;
        let ms = (m.at.max(0.0) * 1000.0).round() as u64;
        let mut ch = vec!["aresample=48000".to_string(), "aformat=sample_fmts=fltp:channel_layouts=stereo".into(), "asetpts=PTS-STARTPTS".into()];
        if m.denoise {
            ch.push(DENOISE.into());
        }
        ch.push(format!("volume={:.3}", m.volume.max(0.0)));
        if m.fade_in > 0.0 {
            ch.push(format!("afade=t=in:st=0:d={:.3}", m.fade_in));
        }
        if m.fade_out > 0.0 {
            ch.push(format!("afade=t=out:st={:.3}:d={:.3}", (m.dur - m.fade_out).max(0.0), m.fade_out));
        }
        ch.push(format!("adelay={ms}|{ms}"));
        g += &format!(";[{mi}:a:0]{}[m{k}]", ch.join(","));
        music_labels.push(format!("[m{k}]"));
    }
    if duck {
        // The music (all items together) is pressed down whenever the main track is loud.
        let bus = if music_labels.len() == 1 {
            music_labels[0].clone()
        } else {
            g += &format!(";{}amix=inputs={}:duration=longest:normalize=0:dropout_transition=0[mb]", music_labels.join(""), music_labels.len());
            "[mb]".to_string()
        };
        g += &format!(";{bus}[ack]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[md]");
        amix_inputs.push("[md]".into());
    } else {
        amix_inputs.extend(music_labels);
    }
    // overlays (V2, then V3; on one track by start), cut at the timeline's end
    let mut vbase = "[vc]".to_string();
    let mut ovs: Vec<&Overlay> = p.overlays.iter().filter(|o| o.dur > 0.0 && o.at.max(0.0) < duration - 1e-3).collect();
    ovs.sort_by(|a, b| a.track.cmp(&b.track).then(a.at.total_cmp(&b.at)));
    for (k, o) in ovs.iter().enumerate() {
        let image = o.kind == "image";
        let speed = if image { 1.0 } else { o.speed.clamp(0.0625, 16.0) };
        let full = o.dur / speed;
        let at = o.at.max(0.0);
        let len = full.min(duration - at);
        let picture = !audio_only && (image || o.kind == "video");
        let sound = o.kind == "video" && o.has_audio && o.volume > 0.0;
        if !picture && !sound {
            continue;
        }
        let oi = n_in;
        n_in += 1;
        if image {
            inputs.extend(v(&["-loop", "1", "-framerate", &format!("{fps:.3}"), "-t", &format!("{len:.3}"), "-i", &o.path]));
        } else {
            inputs.extend(v(&["-ss", &format!("{:.3}", o.start.max(0.0)), "-t", &format!("{:.3}", o.dur), "-i", &o.path]));
        }
        if picture {
            let lens = lens_of(&o.lens).filter(|_| !image);
            let tf = o.transform.clone().unwrap_or_default();
            let pic = Pic { vi: oi, tag: format!("o{k}"), vname: format!("o{k}"), lens: lens.clone(), view: &o.view, keys: &o.view_keys, fit: &o.fit, tf: Some(tf.clone()), color: color_filters(&o.color), speed, len: full };
            let (pre, src, mut chain, timed) = shape(&pic, w, h, false);
            g += ";";
            g += &pre;
            chain.push("setsar=1".into());
            chain.extend(alpha_filters(&tf, lens.is_none(), true));
            if !timed {
                chain.push(speed_pts(speed));
            }
            chain.push(format!("fps={fps:.5}"));
            if o.fade_in > 0.0 {
                chain.push(format!("fade=t=in:st=0:d={:.3}:alpha=1", o.fade_in));
            }
            if o.fade_out > 0.0 {
                chain.push(format!("fade=t=out:st={:.3}:d={:.3}:alpha=1", (full - o.fade_out).max(0.0), o.fade_out));
            }
            chain.push(format!("trim=duration={len:.4}"));
            chain.push(format!("setpts=PTS-STARTPTS+{at:.4}/TB"));
            g += &format!("[{src}]{}[ov{k}]", chain.join(","));
            g += &format!(";{vbase}[ov{k}]overlay={}:eof_action=pass:enable='between(t,{at:.3},{:.3})'[vx{k}]", place(&tf, w, h), at + len);
            vbase = format!("[vx{k}]");
        }
        if sound {
            let ms = (at * 1000.0).round() as u64;
            let mut ch = vec!["aresample=48000".to_string(), "aformat=sample_fmts=fltp:channel_layouts=stereo".into(), "asetpts=PTS-STARTPTS".into()];
            if o.denoise {
                ch.push(DENOISE.into());
            }
            let t = atempo(speed);
            if !t.is_empty() {
                ch.push(t);
            }
            ch.push(format!("volume={:.3}", o.volume));
            if o.fade_in > 0.0 {
                ch.push(format!("afade=t=in:st=0:d={:.3}", o.fade_in));
            }
            if o.fade_out > 0.0 {
                ch.push(format!("afade=t=out:st={:.3}:d={:.3}", (full - o.fade_out).max(0.0), o.fade_out));
            }
            ch.push(format!("atrim=duration={len:.4}"));
            ch.push(format!("adelay={ms}|{ms}"));
            g += &format!(";[{oi}:a:0]{}[oa{k}]", ch.join(","));
            amix_inputs.push(format!("[oa{k}]"));
        }
    }
    let mut alabel = if amix_inputs.len() > 1 {
        g += &format!(";{}amix=inputs={}:duration=first:normalize=0:dropout_transition=0[am]", amix_inputs.join(""), amix_inputs.len());
        "[am]".to_string()
    } else {
        amix_inputs[0].clone()
    };
    if p.loudnorm {
        // loudnorm works at 192 kHz; back to 48 kHz after it.
        g += &format!(";{alabel}loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[an]");
        alabel = "[an]".into();
    }
    let src = timeline_source(p);
    let threads = hw.threads.max(1);
    let mut a = inputs;
    let mut vlabel = vbase.clone();
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
            g += &format!(";{vbase}{}[vo]", post.join(","));
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
    a.extend(v(&["-map", &alabel, "-filter_threads", &threads.to_string()]));
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
            // Standard: H.264 at a fixed bitrate per resolution, AAC (256k unless the plan says
            // otherwise), BT.709 tags (what the original app's export does). The GPU H.264
            // encoder when it works, else x264.
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
            let abr = format!("{}k", p.abr.clamp(32, 512));
            a.extend(v(&["-g", &((fps * 2.0).round() as u32).to_string(), "-c:a", "aac", "-b:a", &abr, "-movflags", "+faststart", "-f", "mp4"]));
        }
    }
    a.push(out.to_string());
    Ok(Built { args: a, graph: g, duration })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hard-seam lens of 2.1 and before (stitching turned off).
    fn off() -> Option<stitch::Stitch> {
        Some(stitch::Stitch { on: false, ..Default::default() })
    }

    #[test]
    fn osv_is_stitched_by_default() {
        let lens = Some(Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: None });
        let mut s = Seg { lens: lens.clone(), view: Some(View { yaw: 10.0, pitch: 0.0, roll: 0.0, hfov: 90.0 }), ..seg("c.osv", 0.0, 4.0) };
        s.speed = 2.0;
        let g = graph(&Plan { segs: vec![s], width: 1280, height: 720, ..plan(vec![]) }).graph;
        assert!(g.starts_with("[0:v:0]null[ls0_fa];[0:v:1]split=2[ls0_fb][ls0_ft];"), "{g}");
        assert!(g.contains("[ls0_A][ls0_B][ls0_M]maskedmerge[ls0];[ls0]setsar=1,setpts=(PTS-STARTPTS)/2.00000"), "{g}");
        assert!(!g.contains("dfisheye"), "{g}");
        // a moving view: the speed goes first on each lens, and the commands turn all three v360s
        let o = Overlay { path: "c.osv".into(), dur: 4.0, at: 0.0, lens, view_keys: vec![key(0.0, 0.0, 90.0), key(1.0, 30.0, 90.0)], ..Default::default() };
        let g = graph(&Plan { overlays: vec![o], ..plan(vec![seg("a.mp4", 0.0, 6.0)]) }).graph;
        assert!(g.contains("[1:v:0]setpts=(PTS-STARTPTS)/1.00000,sendcmd=c='0.067 v360@lso0a yaw -178.000;"), "{g}");
        assert!(g.contains("sendcmd=c='0.067 v360@lso0b yaw 2.000, v360@lso0m yaw 2.000;"), "{g}");
        assert!(g.contains("maskedmerge[lso0];[lso0]setsar=1,format=yuva420p,fps="), "{g}");
    }

    fn seg(path: &str, start: f64, dur: f64) -> Seg {
        Seg { path: path.into(), kind: "video".into(), start, dur, has_audio: true, ..Default::default() }
    }

    fn plan(segs: Vec<Seg>) -> Plan {
        Plan { segs, width: 1920, height: 1080, out: "o.mp4".into(), ..Default::default() }
    }

    fn graph(p: &Plan) -> Built {
        build(p, &Hw::default(), "g.txt", true, false, "o.part").unwrap()
    }

    fn osv(start: f64, dur: f64) -> Seg {
        Seg { lens: Some(Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: off() }), view: Some(View { yaw: 10.0, pitch: 0.0, roll: 0.0, hfov: 90.0 }), ..seg("c.osv", start, dur) }
    }

    fn key(t: f64, yaw: f64, hfov: f64) -> ViewKey {
        ViewKey { t, view: View { yaw, pitch: 0.0, roll: 0.0, hfov } }
    }

    #[test]
    fn two_clips_graph() {
        let p = Plan { segs: vec![seg("a.mp4", 1.0, 2.0), seg("b.mp4", 0.0, 3.0)], music: vec![], width: 1920, height: 1080, fps: 30.0, ass: String::new(), mode: "standard".into(), vbitrate: 8000, settings: None, out: "o.mp4".into(), ..Default::default() };
        let b = build(&p, &Hw::default(), "g.txt", false, false, "o.part.mp4").unwrap();
        assert!(b.graph.contains("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][ac]"), "{}", b.graph);
        assert!((b.duration - 5.0).abs() < 1e-9);
        assert!(b.args.contains(&"-filter_complex_script".to_string()));
        assert!(b.args.contains(&"libx264".to_string()));
        assert!(b.args.join(" ").contains("-c:a aac -b:a 256k"));
    }

    #[test]
    fn speed_and_360() {
        let mut s = seg("c.osv", 0.0, 4.0);
        s.speed = 2.0;
        s.lens = Some(Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: off() });
        s.view = Some(View { yaw: 10.0, pitch: 0.0, roll: 0.0, hfov: 90.0 });
        let p = Plan { segs: vec![s], width: 1280, height: 720, ..plan(vec![]) };
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

    /// Plans without the new fields give the graphs the earlier version made, byte for byte.
    #[test]
    fn old_plans_unchanged() {
        let mut a = seg("a.mp4", 1.0, 2.0);
        a.fade_in = 0.5;
        a.volume = 0.5;
        let c = Seg { speed: 2.0, ..osv(0.0, 4.0) };
        let shrink = Settings { codec: "hevc".into(), crf: 28, speed: 8, fps: "src".into(), res: "720".into(), denoise: 1, acodec: "opus".into(), abr: 96, container: "mkv".into(), screen: false, vfr: true };
        let p = Plan { segs: vec![c, a.clone()], width: 1280, height: 720, fps: 29.97, mode: "shrink".into(), settings: Some(shrink), ..plan(vec![]) };
        let b = build(&p, &Hw::default(), "g.txt", true, true, "o.part").unwrap();
        assert_eq!(b.graph, "[0:v:0][0:v:1]hstack[ls0];[ls0]v360=input=dfisheye:ih_fov=190:iv_fov=190:output=flat:h_fov=90.000:v_fov=58.716:yaw=10.000:pitch=0.000:roll=0.000:w=1280:h=720:interp=lanczos,setsar=1,setpts=(PTS-STARTPTS)/2.00000,fps=29.97000,format=yuv420p,trim=duration=2.0000[v0];[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,atempo=2.00000,apad,atrim=duration=2.0000[a0];[1:v:0]scale=1280:720:force_original_aspect_ratio=decrease:flags=bicubic,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=(PTS-STARTPTS)/1.00000,fps=29.97000,format=yuv420p,fade=t=in:st=0:d=0.500,trim=duration=2.0000[v1];[1:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=0.500,afade=t=in:st=0:d=0.500,apad,atrim=duration=2.0000[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][ac];[vc]subtitles=captions.ass,hqdn3d=2:1.5:3:2.25[vo]");
        let i = Seg { kind: "image".into(), ..seg("p.png", 0.0, 2.0) };
        let s = Seg { kind: "audio".into(), ..seg("s.mp3", 0.0, 2.0) };
        let m = Music { path: "song.mp3".into(), start: 0.0, dur: 20.0, at: 0.5, volume: 0.3, fade_in: 1.0, fade_out: 1.0, ..Default::default() };
        let p = Plan { segs: vec![a, i, s], music: vec![m.clone(), m], mode: "audio".into(), ..plan(vec![]) };
        let b = graph(&p);
        assert_eq!(b.graph, "[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=0.500,afade=t=in:st=0:d=0.500,apad,atrim=duration=2.0000[a0];anullsrc=r=48000:cl=stereo,atrim=duration=2.0000[a1];[2:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=duration=2.0000[a2];[a0][a1][a2]concat=n=3:v=0:a=1[ac];[3:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=0.300,afade=t=in:st=0:d=1.000,afade=t=out:st=19.000:d=1.000,adelay=500|500[m0];[4:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=0.300,afade=t=in:st=0:d=1.000,afade=t=out:st=19.000:d=1.000,adelay=500|500[m1];[ac][m0][m1]amix=inputs=3:duration=first:normalize=0:dropout_transition=0[am]");
        assert_eq!(b.args.iter().filter(|x| *x == "-i").count(), 5);
    }

    #[test]
    fn old_json_still_reads() {
        let j = r#"{"segs":[{"path":"a.mp4","kind":"video","start":0,"dur":2}],"music":[{"path":"m.mp3","start":0,"dur":3,"at":1}],"width":1280,"height":720,"fps":30,"mode":"standard","out":"o.mp4"}"#;
        let p: Plan = serde_json::from_str(j).unwrap();
        assert!(p.overlays.is_empty() && !p.loudnorm && !p.duck && p.abr == 256);
        let s = &p.segs[0];
        assert!(s.transform.is_none() && s.color.is_none() && !s.denoise && s.view_keys.is_empty() && s.xin == 0.0);
        assert!(!p.music[0].denoise);
        let j = r#"{"segs":[{"path":"a.mp4","kind":"video","start":0,"dur":2,"transform":{"scale":0.5},"color":{"saturation":1.2},"denoise":true,"view_keys":[{"t":0,"view":{"yaw":0,"pitch":0,"roll":0,"hfov":90}}],"xin":0.5}],
            "overlays":[{"path":"b.png","kind":"image","start":0,"dur":2,"at":1}],"width":1280,"height":720,"fps":30,"mode":"standard","out":"o.mp4","loudnorm":true,"duck":true,"abr":192}"#;
        let p: Plan = serde_json::from_str(j).unwrap();
        let t = p.segs[0].transform.clone().unwrap();
        assert_eq!((t.scale, t.opacity, t.x), (0.5, 1.0, 0.0));
        let c = p.segs[0].color.clone().unwrap();
        assert_eq!((c.contrast, c.saturation, c.temperature), (1.0, 1.2, 6500.0));
        let o = &p.overlays[0];
        assert_eq!((o.track, o.speed, o.volume), (2, 1.0, 0.0));
    }

    #[test]
    fn gap_is_black_and_silent_without_input() {
        let gap = Seg { kind: "gap".into(), path: String::new(), dur: 2.0, ..Default::default() };
        let p = Plan { segs: vec![gap, seg("b.mp4", 0.0, 3.0)], width: 1280, height: 720, ..plan(vec![]) };
        let b = graph(&p);
        assert!(b.graph.starts_with("color=c=black:s=1280x720:r=30.000:d=2.000[bk0];[bk0]setsar=1,fps=30.00000,format=yuv420p,trim=duration=2.0000[v0];anullsrc=r=48000:cl=stereo,atrim=duration=2.0000[a0];[0:v:0]"), "{}", b.graph);
        assert!(b.graph.contains("[0:a:0]") && !b.graph.contains("[1:"), "{}", b.graph);
        assert_eq!(b.args.iter().filter(|x| *x == "-i").count(), 1);
        assert!((b.duration - 5.0).abs() < 1e-9);
        let b = graph(&Plan { mode: "audio".into(), ..p });
        assert!(b.graph.starts_with("anullsrc=r=48000:cl=stereo,atrim=duration=2.0000[a0];[0:a:0]"), "{}", b.graph);
    }

    #[test]
    fn transform_crops_scales_rotates_and_places() {
        let ident = Seg { transform: Some(Transform::default()), ..seg("a.mp4", 0.0, 2.0) };
        assert_eq!(graph(&plan(vec![ident])).graph, graph(&plan(vec![seg("a.mp4", 0.0, 2.0)])).graph);
        let t = Transform { x: 0.25, y: -0.1, scale: 0.5, rotation: 30.0, crop_l: 0.1, crop_r: 0.1, crop_t: 0.0, crop_b: 0.2, opacity: 1.0 };
        let b = graph(&plan(vec![Seg { transform: Some(t), ..seg("a.mp4", 0.0, 2.0) }]));
        let want = "[0:v:0]crop=iw*0.8000:ih*0.8000:iw*0.1000:ih*0.0000,scale=960:540:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,rotate=a=0.523599:ow=ceil(rotw(0.523599)/2)*2:oh=ceil(roth(0.523599)/2)*2:c=black@0,setpts=(PTS-STARTPTS)/1.00000[t0];color=c=black:s=1920x1080:r=30.000:d=2.000[cv0];[cv0][t0]overlay=x=(W-w)/2+480.00:y=(H-h)/2-108.00,fps=30.00000,format=yuv420p,trim=duration=2.0000[v0];";
        assert!(b.graph.starts_with(want), "{}", b.graph);
        // fill keeps its crop to the (scaled) box; opacity fades toward the black frame
        let t = Transform { scale: 0.5, opacity: 0.4, ..Default::default() };
        let b = graph(&plan(vec![Seg { transform: Some(t), fit: "fill".into(), ..seg("a.mp4", 0.0, 2.0) }]));
        assert!(b.graph.contains("scale=960:540:force_original_aspect_ratio=increase:flags=bicubic,crop=960:540,setsar=1,format=yuva420p,lutyuv=a=val*0.400,"), "{}", b.graph);
        // 360: no crop or rotation, but scale and offset
        let t = Transform { x: -0.2, scale: 0.5, rotation: 45.0, crop_l: 0.2, ..Default::default() };
        let b = graph(&plan(vec![Seg { transform: Some(t), ..osv(0.0, 2.0) }]));
        assert!(b.graph.contains("interp=lanczos,scale=960:540:flags=bicubic,setsar=1,setpts"), "{}", b.graph);
        assert!(!b.graph.contains("rotate") && !b.graph.contains("crop=") && b.graph.contains("overlay=x=(W-w)/2-384.00"), "{}", b.graph);
        assert!((b.duration - 2.0).abs() < 1e-9);
    }

    #[test]
    fn colour_order_escaping_and_neutral() {
        assert!(color_filters(&Some(ColorAdj::default())).is_empty());
        assert!(color_filters(&None).is_empty());
        let c = ColorAdj { exposure: 1.0, contrast: 1.2, saturation: 0.8, temperature: 5000.0, lut: r"C:\Lut Dir\it's.cube".into() };
        assert_eq!(
            color_filters(&Some(c)),
            vec![r"lut3d=file='C\:/Lut Dir/it\'\''s.cube'", "eq=contrast=1.200:saturation=0.800:gamma=1.682", "colortemperature=temperature=5000"]
        );
        // between the fit scale and the pad, so the black bars stay black
        let b = graph(&plan(vec![Seg { color: Some(ColorAdj { saturation: 1.5, ..Default::default() }), ..seg("a.mp4", 0.0, 2.0) }]));
        assert!(b.graph.starts_with("[0:v:0]scale=1920:1080:force_original_aspect_ratio=decrease:flags=bicubic,eq=saturation=1.500,pad=1920:1080"), "{}", b.graph);
        let b = graph(&plan(vec![Seg { color: Some(ColorAdj { exposure: -2.0, ..Default::default() }), ..osv(0.0, 2.0) }]));
        assert!(b.graph.contains("interp=lanczos,eq=gamma=0.354,setsar=1"), "{}", b.graph);
    }

    #[test]
    fn denoise_on_clip_and_music() {
        let p = Plan { segs: vec![Seg { denoise: true, ..seg("a.mp4", 0.0, 2.0) }], music: vec![Music { path: "m.mp3".into(), dur: 5.0, denoise: true, ..Default::default() }], ..plan(vec![]) };
        let b = graph(&p);
        assert!(b.graph.contains("[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,afftdn=nf=-25,apad"), "{}", b.graph);
        assert!(b.graph.contains("[1:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,afftdn=nf=-25,volume=1.000"), "{}", b.graph);
    }

    #[test]
    fn view_keys_interpolate() {
        let k = vec![key(1.0, 170.0, 100.0), key(3.0, -170.0, 60.0)];
        assert_eq!(view_at(&k, 0.0).yaw, 170.0);
        let mid = view_at(&k, 2.0);
        assert!((mid.yaw.abs() - 180.0).abs() < 1e-9 && (mid.hfov - 80.0).abs() < 1e-9, "{mid:?}");
        assert!((view_at(&k, 2.5).yaw + 175.0).abs() < 1e-9);
        assert_eq!(view_at(&k, 9.0).hfov, 60.0);
    }

    #[test]
    fn view_keys_send_commands() {
        let s = Seg { speed: 2.0, view_keys: vec![key(2.0, 60.0, 90.0), key(0.0, -60.0, 90.0)], ..osv(0.0, 8.0) };
        let b = graph(&Plan { width: 1280, height: 720, ..plan(vec![s]) });
        let g = &b.graph;
        assert!(g.contains("[ls0]setpts=(PTS-STARTPTS)/2.00000,sendcmd=c='0.067 v360@k0 yaw -56.000;0.133 v360@k0 yaw -52.000;"), "{g}");
        assert!(g.contains(";2.000 v360@k0 yaw 60.000',v360@k0=input=dfisheye:ih_fov=190:iv_fov=190:output=flat:h_fov=90.000:v_fov=58.716:yaw=-60.000:pitch=0.000:roll=0.000:w=1280:h=720:interp=lanczos:reset_rot=1,setsar=1,fps="), "{g}");
        assert_eq!(g.matches("setpts=(PTS").count(), 1, "{g}");
        assert_eq!(g.matches("v360@k0 yaw").count(), 30);
        // zoom goes as d_fov, the diagonal of the same h/v pair
        let s = Seg { view_keys: vec![key(0.0, 0.0, 90.0), key(1.0, 0.0, 60.0)], ..osv(0.0, 4.0) };
        let g = graph(&Plan { width: 1280, height: 720, ..plan(vec![s]) }).graph;
        assert!(g.contains("1.000 v360@k0 d_fov 67.043'") && !g.contains("v360@k0 yaw"), "{g}");
        // keys that never move: a still view, as before
        let s = Seg { view_keys: vec![key(0.0, 20.0, 90.0), key(1.0, 20.0, 90.0)], ..osv(0.0, 4.0) };
        let g = graph(&plan(vec![s])).graph;
        assert!(!g.contains("sendcmd") && g.contains("[ls0]v360=input=dfisheye") && g.contains(":yaw=20.000:"), "{g}");
    }

    #[test]
    fn dissolves_shorten_the_timeline() {
        let mut segs = vec![seg("a.mp4", 0.0, 4.0), seg("b.mp4", 0.0, 3.0), seg("c.mp4", 0.0, 2.0), seg("d.mp4", 0.0, 2.0)];
        segs[1].xin = 1.0;
        segs[3].xin = 5.0; // clamped to half of 2 s
        let p = plan(segs);
        let b = graph(&p);
        assert!((b.duration - (11.0 - 1.0 - 1.0)).abs() < 1e-9, "{}", b.duration);
        assert!((timeline_source(&p).duration - b.duration).abs() < 1e-9);
        let g = &b.graph;
        assert!(g.contains("[v0]settb=AVTB[gv0];[v1][a1][v2][a2]concat=n=2:v=1:a=1[gc1][ga1];[gc1]settb=AVTB[gv1];[gv0][gv1]xfade=transition=fade:duration=1.0000:offset=3.0000[xv1];[a0][ga1]acrossfade=d=1.0000[xa1];"), "{g}");
        assert!(g.contains("[v3]settb=AVTB[gv2];[xv1][gv2]xfade=transition=fade:duration=1.0000:offset=7.0000[vc];[xa1][a3]acrossfade=d=1.0000[ac]"), "{g}");
        assert!(!g.contains("concat=n=4"));
        // the first clip's xin means nothing; audio-only uses acrossfade alone
        let mut segs = vec![seg("a.mp4", 0.0, 4.0), seg("b.mp4", 0.0, 3.0)];
        segs[0].xin = 2.0;
        segs[1].xin = 0.5;
        let b = graph(&Plan { mode: "audio".into(), ..plan(segs) });
        assert!((b.duration - 6.5).abs() < 1e-9);
        assert!(b.graph.contains("[a0][a1]acrossfade=d=0.5000[ac]") && !b.graph.contains("xfade=") && !b.graph.contains("[v"), "{}", b.graph);
    }

    #[test]
    fn overlays_stack_by_track_and_keep_the_length() {
        let base = plan(vec![seg("a.mp4", 0.0, 6.0)]);
        let v3 = Overlay { path: "logo.png".into(), kind: "image".into(), dur: 20.0, at: 2.0, track: 3, transform: Some(Transform { opacity: 0.5, scale: 0.25, x: 0.3, y: 0.3, ..Default::default() }), fade_in: 0.5, ..Default::default() };
        let v2 = Overlay { path: "pip.mp4".into(), kind: "video".into(), start: 1.0, dur: 3.0, at: 1.0, has_audio: true, transform: Some(Transform { scale: 0.4, x: -0.25, y: -0.25, ..Default::default() }), ..Default::default() };
        let late = Overlay { path: "x.mp4".into(), at: 6.5, dur: 2.0, ..Default::default() };
        let p = Plan { overlays: vec![v3.clone(), v2.clone(), late], ..base.clone() };
        let b = graph(&p);
        assert!((b.duration - 6.0).abs() < 1e-9);
        let g = &b.graph;
        let a = b.args.join(" ");
        assert!(a.contains("-ss 1.000 -t 3.000 -i pip.mp4 -loop 1 -framerate 30.000 -t 4.000 -i logo.png") && !a.contains("x.mp4"), "{a}");
        assert!(g.contains(";[1:v:0]scale=768:432:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,setpts=(PTS-STARTPTS)/1.00000,fps=30.00000,trim=duration=3.0000,setpts=PTS-STARTPTS+1.0000/TB[ov0];[vc][ov0]overlay=x=(W-w)/2-480.00:y=(H-h)/2-270.00:eof_action=pass:enable='between(t,1.000,4.000)'[vx0]"), "{g}");
        assert!(g.contains(";[2:v:0]scale=480:270:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,format=yuva420p,lutyuv=a=val*0.500,setpts=(PTS-STARTPTS)/1.00000,fps=30.00000,fade=t=in:st=0:d=0.500:alpha=1,trim=duration=4.0000,setpts=PTS-STARTPTS+2.0000/TB[ov1];[vx0][ov1]overlay=x=(W-w)/2+576.00:y=(H-h)/2+324.00:eof_action=pass:enable='between(t,2.000,6.000)'[vx1]"), "{g}");
        assert!(b.args.windows(2).any(|w| w[0] == "-map" && w[1] == "[vx1]"));
        // muted by default; with a volume the sound joins the mix at its place
        assert!(!g.contains("[1:a:0]") && g.ends_with("[vx1]"), "{g}");
        let p = Plan { overlays: vec![Overlay { volume: 0.7, ..v2.clone() }], ..base.clone() };
        let b = graph(&p);
        assert!(b.graph.contains(";[1:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=0.700,atrim=duration=3.0000,adelay=1000|1000[oa0];[ac][oa0]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[am]"), "{}", b.graph);
        // audio-only keeps the overlay's sound, not its picture
        let b = graph(&Plan { mode: "audio".into(), overlays: vec![Overlay { volume: 0.7, ..v2.clone() }, v3.clone()], ..base.clone() });
        assert!(b.graph.contains("[oa0]") && !b.graph.contains("overlay=") && !b.args.join(" ").contains("logo.png"), "{}", b.graph);
        assert!((b.duration - 6.0).abs() < 1e-9);
    }

    #[test]
    fn overlay_360_gets_its_own_view() {
        let o = Overlay { path: "c.osv".into(), dur: 4.0, at: 0.0, lens: Some(Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: off() }), view_keys: vec![key(0.0, 0.0, 90.0), key(1.0, 30.0, 90.0)], ..Default::default() };
        let g = graph(&Plan { overlays: vec![o], ..plan(vec![seg("a.mp4", 0.0, 6.0)]) }).graph;
        assert!(g.contains(";[1:v:0][1:v:1]hstack[lso0];[lso0]setpts=(PTS-STARTPTS)/1.00000,sendcmd=c='0.067 v360@o0 yaw 2.000;"), "{g}");
        assert!(g.contains("reset_rot=1,setsar=1,format=yuva420p,fps="), "{g}");
    }

    #[test]
    fn loudnorm_duck_and_aac_rate() {
        let m = Music { path: "m.mp3".into(), dur: 30.0, volume: 0.5, ..Default::default() };
        let p = Plan { music: vec![m.clone(), Music { at: 10.0, ..m.clone() }], duck: true, loudnorm: true, abr: 192, ..plan(vec![seg("a.mp4", 0.0, 6.0)]) };
        let b = graph(&p);
        let g = &b.graph;
        assert!(g.contains("concat=n=1:v=1:a=1[vc][ac];[ac]asplit=2[ac1][ack];"), "{g}");
        assert!(g.contains(";[m0][m1]amix=inputs=2:duration=longest:normalize=0:dropout_transition=0[mb];[mb][ack]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[md];[ac1][md]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[am];[am]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[an]"), "{g}");
        assert!(b.args.windows(2).any(|w| w[0] == "-map" && w[1] == "[an]"));
        assert!(b.args.join(" ").contains("-c:a aac -b:a 192k"));
        // one music item is the bus itself; duck without music does nothing
        let g = graph(&Plan { music: vec![m], duck: true, ..plan(vec![seg("a.mp4", 0.0, 6.0)]) }).graph;
        assert!(g.contains(";[m0][ack]sidechaincompress") && g.contains("[ac1][md]amix=inputs=2"), "{g}");
        let b = graph(&Plan { duck: true, loudnorm: true, mode: "audio".into(), ..plan(vec![seg("a.mp4", 0.0, 6.0)]) });
        assert!(b.graph.ends_with("concat=n=1:v=0:a=1[ac];[ac]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[an]") && !b.graph.contains("asplit"), "{}", b.graph);
    }

    /// Every feature through the real ffmpeg: REELCUT_FX=<fixtures> FFDIR=<ffmpeg dir>
    /// cargo test render_real_ffmpeg -- --nocapture
    #[test]
    fn render_real_ffmpeg() {
        use crate::ff::{self, Jobs};
        use std::path::{Path, PathBuf};
        let Ok(fx) = std::env::var("REELCUT_FX") else { return };
        let fx = PathBuf::from(fx);
        let bin = |n: &str| PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join(n);
        let (ffmpeg, ffprobe) = (bin("ffmpeg"), bin("ffprobe"));
        let work = fx.join("work_render");
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let jobs = Jobs::default();
        let dur = |p: &Path| -> f64 {
            let (_, out, _) = ff::output(&ffprobe, &v(&["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", &p.to_string_lossy()])).unwrap();
            out.trim().parse().unwrap_or(0.0)
        };
        let shot = |file: &str, t: f64, jpg: &str| {
            let (ok, _, err) = ff::output(&ffmpeg, &v(&["-y", "-v", "error", "-ss", &format!("{t}"), "-i", &work.join(file).to_string_lossy(), "-frames:v", "1", "-q:v", "3", &work.join(jpg).to_string_lossy()])).unwrap();
            assert!(ok, "{err}");
        };
        let walk = fx.join("walk.mp4").to_string_lossy().into_owned();
        let osv_path = fx.join("CAM_0001.OSV").to_string_lossy().into_owned();
        let song = fx.join("song.mp3").to_string_lossy().into_owned();
        // an identity LUT in a folder with a space and an apostrophe, and a still for V3
        let lut_dir = work.join("lut dir's");
        std::fs::create_dir_all(&lut_dir).unwrap();
        let lut = lut_dir.join("identity.cube");
        std::fs::write(&lut, "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n").unwrap();
        let still = work.join("still.png");
        let (ok, _, err) = ff::output(&ffmpeg, &v(&["-y", "-v", "error", "-ss", "2", "-i", &walk, "-frames:v", "1", "-vf", "drawbox=c=red:t=24", &still.to_string_lossy()])).unwrap();
        assert!(ok, "{err}");

        let lens = Some(Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: off() });
        let clip = |s: f64, d: f64| Seg { path: walk.clone(), kind: "video".into(), start: s, dur: d, has_audio: true, fit: "fit".into(), ..Default::default() };
        let vk = |t: f64, yaw: f64, pitch: f64, hfov: f64| ViewKey { t, view: View { yaw, pitch, roll: 0.0, hfov } };
        let segs = vec![
            Seg {
                transform: Some(Transform { x: 0.2, y: -0.1, scale: 0.5, rotation: 8.0, crop_l: 0.05, crop_b: 0.1, ..Default::default() }),
                color: Some(ColorAdj { exposure: 0.7, saturation: 1.4, contrast: 1.1, temperature: 5200.0, lut: lut.to_string_lossy().into_owned() }),
                denoise: true,
                fade_in: 0.3,
                ..clip(0.0, 3.0)
            },
            Seg { kind: "gap".into(), path: String::new(), dur: 1.0, ..Default::default() },
            Seg { fit: "fill".into(), xin: 0.8, ..clip(3.0, 3.0) },
            Seg { path: osv_path.clone(), lens: lens.clone(), view: Some(View { yaw: 0.0, pitch: 0.0, roll: 0.0, hfov: 100.0 }), view_keys: vec![vk(0.5, -60.0, -10.0, 100.0), vk(3.5, 60.0, 10.0, 70.0)], xin: 0.5, ..clip(0.0, 4.0) },
        ];
        let overlays = vec![
            Overlay { path: still.to_string_lossy().into_owned(), kind: "image".into(), dur: 30.0, at: 2.0, track: 3, transform: Some(Transform { x: -0.3, y: 0.3, scale: 0.3, opacity: 0.5, ..Default::default() }), fade_in: 0.3, ..Default::default() },
            Overlay { path: walk.clone(), kind: "video".into(), start: 4.0, dur: 3.0, at: 1.5, track: 2, volume: 0.6, has_audio: true, transform: Some(Transform { x: 0.3, y: -0.3, scale: 0.35, ..Default::default() }), color: Some(ColorAdj { saturation: 0.0, ..Default::default() }), ..Default::default() },
        ];
        let music = vec![Music { path: song.clone(), start: 0.0, dur: 20.0, at: 0.0, volume: 0.8, fade_out: 1.0, ..Default::default() }];
        let full = Plan { segs: segs.clone(), music, overlays, width: 1280, height: 720, fps: 30.0, duck: true, loudnorm: true, abr: 192, ..Default::default() };
        let audio = Plan { mode: "audio".into(), ..full.clone() };
        let pip = Plan { segs: vec![clip(0.0, 4.0)], music: vec![], loudnorm: false, duck: false, ..full.clone() };
        let gf = work.join("graph.txt");
        let hw = Hw { threads: 4, ..Default::default() };
        for (name, p) in [("features.mp4", &full), ("features.wav", &audio), ("pip.mp4", &pip)] {
            let out = work.join(name);
            let b = build(p, &hw, &gf.to_string_lossy(), true, false, &out.to_string_lossy()).unwrap();
            std::fs::write(&gf, &b.graph).unwrap();
            std::fs::write(work.join(format!("{name}.graph.txt")), &b.graph).unwrap();
            let t0 = std::time::Instant::now();
            ff::run_ffmpeg_in(&jobs, "e", jobs.generation("e"), &ffmpeg, &b.args, Some(&work), |_| {}).unwrap_or_else(|e| panic!("{name}: {e}\n{}", b.graph));
            let d = dur(&out);
            println!("{name}: expected {:.2}s got {:.2}s, {} bytes, {:.1}s to make", b.duration, d, std::fs::metadata(&out).unwrap().len(), t0.elapsed().as_secs_f64());
            assert!((d - b.duration).abs() < 0.25, "{name} duration");
        }
        // frames to look at: both overlays over the transformed clip, the dissolve, the moving view
        for (t, jpg) in [(2.6, "pip_2_6.jpg"), (6.25, "dissolve_6_25.jpg"), (7.0, "view_7_0.jpg"), (9.4, "view_9_4.jpg")] {
            shot("features.mp4", t, jpg);
        }
        shot("pip.mp4", 2.5, "pip_only_2_5.jpg");
    }
}
