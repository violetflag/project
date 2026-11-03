//! Seam stitching for dual-fisheye 360 recordings (DJI Osmo 360 `.osv` / `.lrf`).
//!
//! Modelled on what DJI Studio's stitcher does (`stitch_with_sym.dll`, `pano_selfcali.dll`; see
//! docs/dji-stitch-analysis.md): the two lenses are self-calibrated from the picture where they
//! overlap, the brightness and colour of the two halves are matched (its `Compensator`), and the
//! seam is cross-faded over the middle half of the overlap band (its `SeamLinearBlendShader`,
//! `len_ratio = 0.5`), instead of switching lenses hard at 90°.
//!
//! In the picture: the left half of the side-by-side pair (track 0 of an .osv) is the lens that
//! looks back (yaw 180), the right half the one that looks forward, the same as ffmpeg's
//! `v360=input=dfisheye`. Each lens is turned into the wanted picture by its own `v360`
//! (`input=fisheye`), and `maskedmerge` mixes them with a weight that depends only on how far a
//! direction is from the seam, made by a third `v360` from a tiny weight strip. So it costs about
//! three times a plain view, whatever the source size.

use crate::ff;
use crate::media::{Lens, MediaInfo, View};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// How the two lenses are put together. Stored on the asset's lens; `None` there means the
/// defaults (stitching on, nothing calibrated yet).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Stitch {
    /// Blend the seam (on unless turned off in the inspector).
    #[serde(default = "yes")]
    pub on: bool,
    /// Lens field of view found by calibration, degrees (0 = use the lens setting).
    #[serde(default)]
    pub fov: f64,
    /// Back lens rotation relative to the front one, degrees.
    #[serde(default)]
    pub yaw: f64,
    #[serde(default)]
    pub pitch: f64,
    #[serde(default)]
    pub roll: f64,
    /// Brightness/colour match per lens: [Y gain, U shift, V shift] (8-bit steps); a = back
    /// (left half), b = front (right half).
    #[serde(default = "neutral")]
    pub gain_a: [f64; 3],
    #[serde(default = "neutral")]
    pub gain_b: [f64; 3],
    /// Calibration ran on this file.
    #[serde(default)]
    pub calibrated: bool,
    /// Seam mismatch before and after calibration (mean luma difference in the overlap).
    #[serde(default)]
    pub before: f64,
    #[serde(default)]
    pub after: f64,
}

fn yes() -> bool {
    true
}
fn neutral() -> [f64; 3] {
    [1.0, 0.0, 0.0]
}

impl Default for Stitch {
    fn default() -> Self {
        Stitch { on: true, fov: 0.0, yaw: 0.0, pitch: 0.0, roll: 0.0, gain_a: neutral(), gain_b: neutral(), calibrated: false, before: 0.0, after: 0.0 }
    }
}

/// The lens is two fisheyes and the seam blend is on.
pub fn active(lens: &Lens) -> bool {
    matches!(lens.layout.as_str(), "dual" | "dfisheye") && lens.stitch.as_ref().map(|s| s.on).unwrap_or(true)
}

/// The stitch settings with the field of view filled in.
pub fn params(lens: &Lens) -> Stitch {
    let mut s = lens.stitch.clone().unwrap_or_default();
    if s.fov < 90.0 {
        s.fov = lens.fov;
    }
    s
}

/// Width of the cross-fade around the seam, degrees: the middle half of the overlap.
pub fn blend_width(fov: f64) -> f64 {
    ((fov - 180.0) * 0.5).clamp(0.5, 20.0)
}

// ------------------------------------------------------------------ rotations (v360's own)

type Q = [f64; 4];

fn qmul(a: Q, b: Q) -> Q {
    [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ]
}

/// v360's rotation for yaw/pitch/roll in "ypr" order (degrees).
fn ypr(y: f64, p: f64, r: f64) -> Q {
    let h = |d: f64| d.to_radians() / 2.0;
    let qy = [h(y).cos(), 0.0, h(y).sin(), 0.0];
    let qp = [h(p).cos(), h(p).sin(), 0.0, 0.0];
    let qr = [h(r).cos(), 0.0, 0.0, h(r).sin()];
    qmul(qmul(qy, qp), qr)
}

fn conj(q: Q) -> Q {
    [q[0], -q[1], -q[2], -q[3]]
}

fn matrix(q: Q) -> [[f64; 3]; 3] {
    let [w, x, y, z] = q;
    [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - w * z), 2.0 * (x * z + w * y)],
        [2.0 * (x * y + w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - w * x)],
        [2.0 * (x * z - w * y), 2.0 * (y * z + w * x), 1.0 - 2.0 * (x * x + y * y)],
    ]
}

/// The yaw/pitch/roll (ypr order) of a rotation.
fn euler(q: Q) -> (f64, f64, f64) {
    let m = matrix(q);
    let p = (-m[1][2]).clamp(-1.0, 1.0).asin().to_degrees();
    let r = m[1][0].atan2(m[1][1]).to_degrees();
    let y = m[0][2].atan2(m[2][2]).to_degrees();
    (y, p, r)
}

/// The angles to give the back lens's v360 so it shows `view`: the view turned into the back
/// lens's own frame (yaw 180 plus its calibrated offset).
pub fn back_angles(view: &View, s: &Stitch) -> (f64, f64, f64) {
    let qb = ypr(180.0 + s.yaw, s.pitch, s.roll);
    euler(qmul(conj(qb), ypr(view.yaw, view.pitch, view.roll)))
}

// ------------------------------------------------------------------ the filter graph

/// What the stitched picture is.
pub enum Out<'a> {
    /// A flat view, w×h.
    Flat { view: &'a View, w: u32, h: u32 },
    /// The whole sphere, equirectangular w×h (the playback proxy).
    Equi { w: u32, h: u32 },
}

/// A moving flat view: the start view and (output second, view) steps.
pub struct Moves {
    pub v0: View,
    pub steps: Vec<(f64, View)>,
}

fn vfov(hf: f64, w: u32, h: u32) -> f64 {
    2.0 * ((hf.to_radians() / 2.0).tan() * h as f64 / w as f64).atan().to_degrees()
}

fn dfov(hf: f64, w: u32, h: u32) -> f64 {
    2.0 * ((hf.clamp(20.0, 160.0).to_radians() / 2.0).tan() * (w as f64).hypot(h as f64) / w as f64).atan().to_degrees()
}

fn wrap180(d: f64) -> f64 {
    let x = (d + 180.0).rem_euclid(360.0) - 180.0;
    if x <= -180.0 { 180.0 } else { x }
}

fn flat_opts(y: f64, p: f64, r: f64, hfov: f64, w: u32, h: u32) -> String {
    let hf = hfov.clamp(20.0, 160.0);
    format!("output=flat:h_fov={hf:.3}:v_fov={:.3}:yaw={:.3}:pitch={:.3}:roll={:.3}:w={w}:h={h}", vfov(hf, w, h), wrap180(y), p.clamp(-180.0, 180.0), r.clamp(-180.0, 180.0))
}

fn gain_lut(g: &[f64; 3]) -> Option<String> {
    let neutral = (g[0] - 1.0).abs() < 1e-3 && g[1].abs() < 0.05 && g[2].abs() < 0.05;
    (!neutral).then(|| format!("lutyuv=y='clip(val*{:.4},0,255)':u='clip(val+{:.2},0,255)':v='clip(val+{:.2},0,255)'", g[0], g[1], g[2]))
}

/// sendcmd text for the named v360s, one entry per step where something changed. `angles` turns
/// a view into that v360's yaw/pitch/roll.
fn commands(m: &Moves, w: u32, h: u32, targets: &[(&str, &dyn Fn(&View) -> (f64, f64, f64))]) -> String {
    let fmt = |vw: &View, f: &dyn Fn(&View) -> (f64, f64, f64)| {
        let (y, p, r) = f(vw);
        [wrap180(y), p.clamp(-180.0, 180.0), r.clamp(-180.0, 180.0), dfov(vw.hfov, w, h)].map(|x| format!("{x:.3}"))
    };
    let mut prev: Vec<[String; 4]> = targets.iter().map(|(_, f)| fmt(&m.v0, *f)).collect();
    let mut cmds = Vec::new();
    for (t, vw) in &m.steps {
        let mut set = Vec::new();
        for (k, (name, f)) in targets.iter().enumerate() {
            let cur = fmt(vw, *f);
            for (j, o) in ["yaw", "pitch", "roll", "d_fov"].iter().enumerate() {
                if cur[j] != prev[k][j] {
                    set.push(format!("v360@{name} {o} {}", cur[j]));
                }
            }
            prev[k] = cur;
        }
        if !set.is_empty() {
            cmds.push(format!("{t:.3} {}", set.join(", ")));
        }
    }
    if cmds.is_empty() { String::new() } else { format!("sendcmd=c='{}',", cmds.join(";")) }
}

/// Graph text that makes the stitched picture `[name]` from input `i`. `pre` runs first on each
/// lens stream (the clip's speed), `scale_each` shrinks each fisheye first (the proxy).
pub fn graph(i: usize, lens: &Lens, scale_each: Option<u32>, pre: &str, out: &Out, moves: Option<&Moves>, name: &str) -> String {
    let s = params(lens);
    let f = s.fov.clamp(181.0, 260.0);
    let b = blend_width(f);
    let n = name;
    let pre = if pre.is_empty() { String::new() } else { format!("{pre},") };
    let sc = scale_each.map(|w| format!("scale={w}:{w}:flags=area,")).unwrap_or_default();
    let ident = |v: &View| (v.yaw, v.pitch, v.roll);
    let back = |v: &View| back_angles(v, &s);
    let (na, nb, nm) = (format!("{n}a"), format!("{n}b"), format!("{n}m"));
    let (cmd_a, cmd_bm, cmd_all) = match moves {
        Some(m) => (
            commands(m, out_w(out), out_h(out), &[(&na, &back)]),
            commands(m, out_w(out), out_h(out), &[(&nb, &ident), (&nm, &ident)]),
            commands(m, out_w(out), out_h(out), &[(&na, &back), (&nb, &ident), (&nm, &ident)]),
        ),
        None => (String::new(), String::new(), String::new()),
    };
    let mut g = String::new();
    // The two fisheyes as [n_fa] (back) and [n_fb] (front), plus [n_ft], a tap for the weight's timing.
    match lens.layout.as_str() {
        "dual" => {
            let (ia, ib) = if lens.swap { (1, 0) } else { (0, 1) };
            g += &format!("[{i}:v:{ia}]{pre}{cmd_a}{sc}null[{n}_fa];");
            g += &format!("[{i}:v:{ib}]{pre}{cmd_bm}{sc}split=2[{n}_fb][{n}_ft];");
        }
        _ => {
            let (la, lb) = if lens.swap { ("iw/2", "0") } else { ("0", "iw/2") };
            g += &format!("[{i}:v:0]{pre}{cmd_all}split=3[{n}_l][{n}_r][{n}_ft];");
            g += &format!("[{n}_l]crop=iw/2:ih:{la}:0,{sc}null[{n}_fa];[{n}_r]crop=iw/2:ih:{lb}:0,{sc}null[{n}_fb];");
        }
    }
    let (opts_a, opts_b, opts_m, tail_m) = match out {
        Out::Flat { view, w, h } => {
            let v0 = moves.map(|m| &m.v0).unwrap_or(view);
            let (y, p, r) = back_angles(v0, &s);
            let rr = if moves.is_some() { ":reset_rot=1" } else { "" };
            (
                format!("{}{rr}", flat_opts(y, p, r, v0.hfov, *w, *h)),
                format!("{}{rr}", flat_opts(v0.yaw, v0.pitch, v0.roll, v0.hfov, *w, *h)),
                Some(format!("{}{rr}", flat_opts(v0.yaw, v0.pitch, v0.roll, v0.hfov, *w, *h))),
                String::new(),
            )
        }
        Out::Equi { w, h } => {
            let (y, p, r) = back_angles(&View { yaw: 0.0, pitch: 0.0, roll: 0.0, hfov: 90.0 }, &s);
            (format!("output=equirect:w={w}:h={h}:yaw={:.3}:pitch={:.3}:roll={:.3}", wrap180(y), p, r), format!("output=equirect:w={w}:h={h}"), None, format!(",scale={w}:{h}:flags=neighbor"))
        }
    };
    let lut = |gn: &[f64; 3]| gain_lut(gn).map(|l| format!(",{l}")).unwrap_or_default();
    g += &format!("[{n}_fa]v360@{na}=input=fisheye:ih_fov={f:.3}:iv_fov={f:.3}:{opts_a}:interp=lanczos,format=yuv420p{}[{n}_A];", lut(&s.gain_a));
    g += &format!("[{n}_fb]v360@{nb}=input=fisheye:ih_fov={f:.3}:iv_fov={f:.3}:{opts_b}:interp=lanczos,format=yuv420p{}[{n}_B];", lut(&s.gain_b));
    // The weight of the front lens: 1 up to the band, falling straight to 0 across it (by longitude
    // only, so a 2-pixel-high strip is enough; v360 spreads it over the view).
    let e = format!("255*clip(({:.4}-abs((X+0.5)/W*360-180))/{b:.4},0,1)", 90.0 + b / 2.0);
    g += &format!("[{n}_ft]crop=2:2:0:0,scale=4096:2:flags=neighbor,format=yuv420p,geq=lum='{e}':cb='{e}':cr='{e}'");
    match opts_m {
        Some(o) => g += &format!(",v360@{nm}=input=equirect:{o}:interp=linear[{n}_M];"),
        None => g += &format!("{tail_m}[{n}_M];"),
    }
    g += &format!("[{n}_A][{n}_B][{n}_M]maskedmerge[{name}]");
    g
}

fn out_w(o: &Out) -> u32 {
    match o {
        Out::Flat { w, .. } | Out::Equi { w, .. } => *w,
    }
}
fn out_h(o: &Out) -> u32 {
    match o {
        Out::Flat { h, .. } | Out::Equi { h, .. } => *h,
    }
}

// ------------------------------------------------------------------ self-calibration

/// One frame of both lenses at s×s, Y/U/V planes (u8), back first.
struct Pair {
    s: usize,
    planes: [[Vec<f32>; 3]; 2],
}

impl Pair {
    fn from_yuv444(raw: &[u8], s: usize) -> Option<Pair> {
        let w = 2 * s;
        if raw.len() < 3 * w * s {
            return None;
        }
        let mut planes: [[Vec<f32>; 3]; 2] = Default::default();
        for c in 0..3 {
            let pl = &raw[c * w * s..(c + 1) * w * s];
            for (k, lens) in planes.iter_mut().enumerate() {
                lens[c] = (0..s).flat_map(|y| pl[y * w + k * s..y * w + k * s + s].iter().map(|&v| v as f32)).collect();
            }
        }
        Some(Pair { s, planes })
    }
}

fn box_blur(img: &[f32], s: usize, r: usize) -> Vec<f32> {
    if r == 0 {
        return img.to_vec();
    }
    let k = (2 * r + 1) as f32;
    let at = |i: isize| i.clamp(0, s as isize - 1) as usize;
    let mut cur = img.to_vec();
    for _ in 0..2 {
        let mut tmp = vec![0f32; s * s];
        for y in 0..s {
            for x in 0..s {
                let mut acc = 0.0;
                for d in -(r as isize)..=r as isize {
                    acc += cur[y * s + at(x as isize + d)];
                }
                tmp[y * s + x] = acc / k;
            }
        }
        for y in 0..s {
            for x in 0..s {
                let mut acc = 0.0;
                for d in -(r as isize)..=r as isize {
                    acc += tmp[at(y as isize + d) * s + x];
                }
                cur[y * s + x] = acc / k;
            }
        }
    }
    cur
}

fn bilinear(img: &[f32], s: usize, x: f64, y: f64) -> Option<f32> {
    if !(x >= 0.0 && y >= 0.0 && x <= s as f64 - 1.001 && y <= s as f64 - 1.001) {
        return None;
    }
    let (x0, y0) = (x as usize, y as usize);
    let (fx, fy) = ((x - x0 as f64) as f32, (y - y0 as f64) as f32);
    let p = |xx: usize, yy: usize| img[yy * s + xx];
    Some((p(x0, y0) * (1.0 - fx) + p(x0 + 1, y0) * fx) * (1.0 - fy) + (p(x0, y0 + 1) * (1.0 - fx) + p(x0 + 1, y0 + 1) * fx) * fy)
}

/// Where a direction lands in a fisheye picture, as v360 `input=fisheye` reads it, in the s×s
/// copy of an n×n original. None outside the lens.
fn fisheye_px(v: [f64; 3], fov: f64, n: f64, s: f64) -> Option<(f64, f64)> {
    let h = v[0].hypot(v[1]);
    let lh = if h > 0.0 { h } else { 1.0 };
    let ang = h.atan2(v[2]);
    if ang.to_degrees() > fov / 2.0 {
        return None;
    }
    let phi = ang / std::f64::consts::PI;
    let rng = fov / 360.0;
    let u = v[0] / lh * phi / rng;
    let w = v[1] / lh * phi / rng;
    let k = s / n;
    Some((((0.5 * u + 0.5) * (n - 1.0) + 0.5) * k - 0.5, ((0.5 * w + 0.5) * (n - 1.0) + 0.5) * k - 0.5))
}

fn rotate_t(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    // mᵀ·v: world → back lens frame.
    [m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2], m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2], m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2]]
}

/// Points in the overlap band around both seams, grouped into blocks along the seam (DJI's
/// `Compensator` uses 64 blocks per seam).
struct Band {
    pts: Vec<[f64; 3]>,
    blk: Vec<usize>,
    nblk: usize,
}

fn band(half: f64) -> Band {
    const PER_SEAM: usize = 48;
    const ROWS: usize = 4;
    const ACROSS: usize = 9;
    let mut pts = Vec::new();
    let mut blk = Vec::new();
    for (si, seam) in [90.0f64, -90.0].iter().enumerate() {
        for li in 0..PER_SEAM * ROWS {
            let lat = (-70.0 + 140.0 * li as f64 / (PER_SEAM * ROWS - 1) as f64).to_radians();
            for k in 0..ACROSS {
                let lon = (seam + half * (2.0 * k as f64 / (ACROSS - 1) as f64 - 1.0)).to_radians();
                pts.push([lat.cos() * lon.sin(), lat.sin(), lat.cos() * lon.cos()]);
                blk.push(si * PER_SEAM + li / ROWS);
            }
        }
    }
    Band { pts, blk, nblk: 2 * PER_SEAM }
}

/// Geometry being searched: fov, back yaw, pitch, roll.
type Geo = [f64; 4];

/// The two lenses' samples (luma or a chroma plane) of every band point; NaN where a lens misses.
fn sample(pairs: &[(&Pair, [&[f32]; 2])], band: &Band, g: &Geo, n: f64) -> Vec<(Vec<f32>, Vec<f32>)> {
    let m = matrix(ypr(180.0 + g[1], g[2], g[3]));
    pairs
        .iter()
        .map(|(p, img)| {
            let s = p.s as f64;
            let mut a = Vec::with_capacity(band.pts.len());
            let mut b = Vec::with_capacity(band.pts.len());
            for v in &band.pts {
                let fb = fisheye_px(*v, g[0], n, s).and_then(|(x, y)| bilinear(img[1], p.s, x, y));
                let fa = fisheye_px(rotate_t(&m, *v), g[0], n, s).and_then(|(x, y)| bilinear(img[0], p.s, x, y));
                match (fa, fb) {
                    (Some(x), Some(y)) => {
                        a.push(x);
                        b.push(y);
                    }
                    _ => {
                        a.push(f32::NAN);
                        b.push(f32::NAN);
                    }
                }
            }
            (a, b)
        })
        .collect()
}

/// Mean absolute difference of the two lenses in the band after removing each block's mean (so a
/// brightness difference does not count, only misplaced detail).
fn cost(pairs: &[(&Pair, [&[f32]; 2])], band: &Band, g: &Geo, n: f64) -> f64 {
    let mut total = 0.0;
    let mut cnt = 0usize;
    for (a, b) in sample(pairs, band, g, n) {
        let mut sa = vec![0f64; band.nblk];
        let mut sb = vec![0f64; band.nblk];
        let mut nn = vec![0usize; band.nblk];
        for k in 0..a.len() {
            if a[k].is_nan() {
                continue;
            }
            sa[band.blk[k]] += a[k] as f64;
            sb[band.blk[k]] += b[k] as f64;
            nn[band.blk[k]] += 1;
        }
        let mut d = vec![0f64; band.nblk];
        for k in 0..a.len() {
            let bk = band.blk[k];
            if a[k].is_nan() || nn[bk] < 8 {
                continue;
            }
            d[bk] += ((a[k] as f64 - sa[bk] / nn[bk] as f64) - (b[k] as f64 - sb[bk] / nn[bk] as f64)).abs();
        }
        for bk in 0..band.nblk {
            if nn[bk] >= 8 {
                total += d[bk] / nn[bk] as f64;
                cnt += 1;
            }
        }
    }
    if cnt == 0 { f64::INFINITY } else { total / cnt as f64 }
}

/// Coordinate descent, coarse to fine, on blurred then sharp pictures (DJI's `pano_selfcali`
/// matches features between the lenses and solves the rotation; this searches the same
/// quantities directly).
fn search(pairs: &[Pair], fov0: f64, n: f64) -> (Geo, f64, f64) {
    let lo = [(fov0 - 8.0).max(181.0), -4.0, -4.0, -4.0];
    let hi = [(fov0 + 8.0).min(240.0), 4.0, 4.0, 4.0];
    let half = ((fov0 - 180.0) * 0.4).clamp(0.6, 2.5);
    let band = band(half);
    let mut g: Geo = [fov0, 0.0, 0.0, 0.0];
    let mut before = f64::NAN;
    let mut best = f64::INFINITY;
    for (r, steps) in [(6usize, [2.0, 1.0]), (2, [0.5, 0.25]), (0, [0.1, 0.05])] {
        let blurred: Vec<[Vec<f32>; 2]> = pairs.iter().map(|p| [box_blur(&p.planes[0][0], p.s, r), box_blur(&p.planes[1][0], p.s, r)]).collect();
        let set: Vec<(&Pair, [&[f32]; 2])> = pairs.iter().zip(&blurred).map(|(p, b)| (p, [b[0].as_slice(), b[1].as_slice()])).collect();
        best = cost(&set, &band, &g, n);
        if r == 0 {
            before = cost(&set, &band, &[fov0, 0.0, 0.0, 0.0], n);
        }
        for step in steps {
            let mut improved = true;
            let mut rounds = 0;
            while improved && rounds < 40 {
                improved = false;
                rounds += 1;
                for i in 0..4 {
                    for d in [-1.0, 1.0] {
                        let mut t = g;
                        t[i] = (t[i] + d * if i == 0 { step * 2.0 } else { step }).clamp(lo[i], hi[i]);
                        let c = cost(&set, &band, &t, n);
                        if c < best - 1e-4 {
                            best = c;
                            g = t;
                            improved = true;
                        }
                    }
                }
            }
        }
    }
    (g, before, best)
}

/// Brightness/colour match from the band: each lens moves half way to the other.
fn gains(pairs: &[Pair], g: &Geo, n: f64) -> ([f64; 3], [f64; 3]) {
    let band = band(((g[0] - 180.0) * 0.4).clamp(0.6, 2.5));
    let mut mean = [[0f64; 3]; 2];
    let mut cnt = 0f64;
    for c in 0..3 {
        let set: Vec<(&Pair, [&[f32]; 2])> = pairs.iter().map(|p| (p, [p.planes[0][c].as_slice(), p.planes[1][c].as_slice()])).collect();
        let mut k = 0f64;
        for (a, b) in sample(&set, &band, g, n) {
            for (x, y) in a.iter().zip(&b) {
                if !x.is_nan() {
                    mean[0][c] += *x as f64;
                    mean[1][c] += *y as f64;
                    k += 1.0;
                }
            }
        }
        if k > 0.0 {
            mean[0][c] /= k;
            mean[1][c] /= k;
        }
        cnt = k;
    }
    if cnt < 100.0 || mean[0][0] < 8.0 || mean[1][0] < 8.0 {
        return (neutral(), neutral());
    }
    let ratio = (mean[1][0] / mean[0][0]).clamp(0.6, 1.6).sqrt();
    let du = ((mean[1][1] - mean[0][1]) / 2.0).clamp(-12.0, 12.0);
    let dv = ((mean[1][2] - mean[0][2]) / 2.0).clamp(-12.0, 12.0);
    ([ratio, du, dv], [1.0 / ratio, -du, -dv])
}

/// Self-calibration from the frames (each a side-by-side YUV 4:4:4 pair at s×s per lens, back
/// first) of lenses that are `n` pixels wide in the file.
pub fn calibrate_frames(frames: &[Vec<u8>], s: usize, n: f64, lens: &Lens) -> Stitch {
    let pairs: Vec<Pair> = frames.iter().filter_map(|f| Pair::from_yuv444(f, s)).collect();
    let mut st = Stitch { on: lens.stitch.as_ref().map(|x| x.on).unwrap_or(true), calibrated: true, ..Default::default() };
    if pairs.is_empty() {
        st.fov = lens.fov;
        return st;
    }
    let (g, before, after) = search(&pairs, lens.fov.clamp(181.0, 240.0), n);
    // Keep the found geometry only when it clearly lines the seam up better (flat sky or a dark
    // room gives nothing to match).
    let g = if after.is_finite() && before.is_finite() && after < before * 0.92 && before > 0.5 { g } else { [lens.fov, 0.0, 0.0, 0.0] };
    let (ga, gb) = gains(&pairs, &g, n);
    st.fov = (g[0] * 100.0).round() / 100.0;
    st.yaw = (g[1] * 100.0).round() / 100.0;
    st.pitch = (g[2] * 100.0).round() / 100.0;
    st.roll = (g[3] * 100.0).round() / 100.0;
    st.gain_a = ga.map(|x| (x * 1000.0).round() / 1000.0);
    st.gain_b = gb.map(|x| (x * 1000.0).round() / 1000.0);
    st.before = (before * 100.0).round() / 100.0;
    st.after = (after.min(before) * 100.0).round() / 100.0;
    st
}

/// Calibrate a recording: a few frames of both lenses through ffmpeg, then the search. Uses the
/// .lrf companion when there is one (same lenses, much quicker to decode).
pub fn calibrate(ffmpeg: &Path, ffprobe: &Path, info: &MediaInfo, lens: &Lens) -> Result<Stitch, String> {
    let layout = if lens.layout.is_empty() || lens.layout == "none" { info.layout360.as_str() } else { lens.layout.as_str() };
    let (src, layout, n) = match (&info.lrf, layout) {
        (Some(l), "dual") => (l.clone(), "dfisheye", 0.0),
        (_, "dual") => (info.path.clone(), "dual", info.videos.first().map(|v| v.width).unwrap_or(info.width) as f64),
        (_, "dfisheye") => (info.path.clone(), "dfisheye", info.width as f64 / 2.0),
        _ => return Err("두 렌즈 360 영상이 아닙니다.".into()),
    };
    let n = if n > 0.0 { n } else { crate::media::inspect(ffprobe, &src).map(|m| m.width as f64 / 2.0).unwrap_or(960.0) };
    let s = (n as usize).clamp(64, 640);
    let pair = match layout {
        "dual" => {
            let (ia, ib) = if lens.swap { (1, 0) } else { (0, 1) };
            format!("[0:v:{ia}]scale={s}:{s}:flags=area[a];[0:v:{ib}]scale={s}:{s}:flags=area[b];[a][b]hstack,format=yuv444p[o]")
        }
        _ if lens.swap => format!("[0:v:0]scale={}:{s}:flags=area,split[l][r];[l]crop=iw/2:ih:0:0[b];[r]crop=iw/2:ih:iw/2:0[a];[a][b]hstack,format=yuv444p[o]", 2 * s),
        _ => format!("[0:v:0]scale={}:{s}:flags=area,format=yuv444p[o]", 2 * s),
    };
    let d = info.duration.max(0.0);
    let times: Vec<f64> = if d < 2.0 { vec![0.0] } else { [0.15, 0.4, 0.65, 0.9].iter().map(|f| d * f).collect() };
    let mut frames = Vec::new();
    for t in times {
        let a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", &format!("{t:.3}"), "-i", &src, "-filter_complex", &pair, "-map", "[o]", "-frames:v", "1", "-f", "rawvideo", "-"].iter().map(|x| x.to_string()).collect();
        let o = ff::command(ffmpeg).args(&a).stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
        if o.stdout.len() >= 3 * 2 * s * s {
            frames.push(o.stdout);
        }
    }
    if frames.is_empty() {
        return Err("이음새 맞추기용 장면을 읽지 못했습니다.".into());
    }
    Ok(calibrate_frames(&frames, s, n, lens))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lens(layout: &str) -> Lens {
        Lens { layout: layout.into(), swap: false, fov: 190.0, stitch: None }
    }

    #[test]
    fn euler_round_trip() {
        for (y, p, r) in [(10.0, 20.0, 30.0), (-170.0, -60.0, 100.0), (90.0, 0.0, 0.0), (0.0, 89.0, -45.0)] {
            let q = ypr(y, p, r);
            let (a, b, c) = euler(q);
            let q2 = ypr(a, b, c);
            let dot: f64 = q.iter().zip(&q2).map(|(x, y)| x * y).sum();
            assert!((dot.abs() - 1.0).abs() < 1e-9, "{y} {p} {r} -> {a} {b} {c}");
        }
    }

    #[test]
    fn back_lens_looks_the_other_way() {
        let s = Stitch::default();
        let (y, p, r) = back_angles(&View { yaw: 30.0, pitch: 10.0, roll: 0.0, hfov: 90.0 }, &s);
        assert!((wrap180(y) - -150.0).abs() < 1e-6 && (p - 10.0).abs() < 1e-6 && r.abs() < 1e-6, "{y} {p} {r}");
    }

    #[test]
    fn default_lens_is_stitched() {
        assert!(active(&lens("dual")));
        assert!(active(&lens("dfisheye")));
        assert!(!active(&lens("equirect")));
        let mut off = lens("dual");
        off.stitch = Some(Stitch { on: false, ..Default::default() });
        assert!(!active(&off));
    }

    #[test]
    fn flat_graph_blends_two_lenses() {
        let v = View { yaw: 90.0, pitch: 0.0, roll: 0.0, hfov: 100.0 };
        let g = graph(0, &lens("dual"), None, "", &Out::Flat { view: &v, w: 1280, h: 720 }, None, "x");
        assert!(g.starts_with("[0:v:0]null[x_fa];[0:v:1]split=2[x_fb][x_ft];"), "{g}");
        assert!(g.contains("v360@xa=input=fisheye:ih_fov=190.000:iv_fov=190.000:output=flat:h_fov=100.000:v_fov=67.673:yaw=-90.000"), "{g}");
        assert!(g.contains("v360@xb=input=fisheye:ih_fov=190.000:iv_fov=190.000:output=flat:h_fov=100.000:v_fov=67.673:yaw=90.000"), "{g}");
        assert!(g.contains("geq=lum='255*clip((92.5000-abs((X+0.5)/W*360-180))/5.0000,0,1)'"), "{g}");
        assert!(g.ends_with("[x_A][x_B][x_M]maskedmerge[x]"), "{g}");
    }

    #[test]
    fn swapped_side_by_side_and_proxy() {
        let mut l = lens("dfisheye");
        l.swap = true;
        l.stitch = Some(Stitch { gain_a: [1.05, 1.0, -2.0], ..Default::default() });
        let g = graph(0, &l, Some(1024), "", &Out::Equi { w: 2048, h: 1024 }, None, "sb");
        assert!(g.contains("[sb_l]crop=iw/2:ih:iw/2:0,scale=1024:1024:flags=area,null[sb_fa];[sb_r]crop=iw/2:ih:0:0"), "{g}");
        assert!(g.contains("output=equirect:w=2048:h=1024:yaw=180.000"), "{g}");
        assert!(g.contains("lutyuv=y='clip(val*1.0500,0,255)':u='clip(val+1.00,0,255)':v='clip(val+-2.00,0,255)'"), "{g}");
        assert!(g.contains(",scale=2048:1024:flags=neighbor[sb_M]"), "{g}");
    }

    #[test]
    fn moving_view_drives_all_three() {
        let v0 = View { yaw: 0.0, pitch: 0.0, roll: 0.0, hfov: 90.0 };
        let m = Moves { v0: v0.clone(), steps: vec![(0.5, View { yaw: 10.0, ..v0.clone() })] };
        let g = graph(0, &lens("dual"), None, "setpts=PTS-STARTPTS", &Out::Flat { view: &v0, w: 1280, h: 720 }, Some(&m), "k");
        assert!(g.contains("[0:v:0]setpts=PTS-STARTPTS,sendcmd=c='0.500 v360@ka yaw -170.000',null[k_fa]"), "{g}");
        assert!(g.contains("sendcmd=c='0.500 v360@kb yaw 10.000, v360@km yaw 10.000',split=2"), "{g}");
        assert_eq!(g.matches(":reset_rot=1").count(), 3, "{g}");
    }

    /// A made-up pair of fisheyes from a textured sphere, with the back lens turned and brighter,
    /// is put back the way it was.
    #[test]
    fn calibration_finds_the_back_lens() {
        let s = 320usize;
        let n = 1920.0;
        let tex = |v: [f64; 3]| -> f64 {
            let mut t = 0.0;
            let mut a = 1.0;
            for k in 1..7 {
                let f = 2f64.powi(k);
                t += a * ((v[0] * f * 3.1 + 1.3).sin() * (v[1] * f * 2.7 + 0.7).sin() + (v[2] * f * 2.3 + 2.1).sin() * (v[0] * f * 1.9).cos());
                a *= 0.6;
            }
            120.0 + 40.0 * t
        };
        let (fov, cal) = (193.0, (1.0, -0.7, 0.4));
        let qb = matrix(ypr(180.0 + cal.0, cal.1, cal.2));
        let mut raw = vec![0u8; 3 * 2 * s * s];
        for y in 0..s {
            for x in 0..s {
                // inverse of fisheye_px for this pixel
                let k = s as f64 / n;
                let u = (((x as f64 + 0.5) / k - 0.5) / (n - 1.0) - 0.5) * 2.0;
                let w = (((y as f64 + 0.5) / k - 0.5) / (n - 1.0) - 0.5) * 2.0;
                let rr = u.hypot(w);
                let ang = rr * (fov / 360.0) * std::f64::consts::PI;
                let local = if rr > 0.0 { [u / rr * ang.sin(), w / rr * ang.sin(), ang.cos()] } else { [0.0, 0.0, 1.0] };
                // front: world = local; back: world = qb·local
                let front = tex(local);
                let wb = [qb[0][0] * local[0] + qb[0][1] * local[1] + qb[0][2] * local[2], qb[1][0] * local[0] + qb[1][1] * local[1] + qb[1][2] * local[2], qb[2][0] * local[0] + qb[2][1] * local[1] + qb[2][2] * local[2]];
                let back = tex(wb) * 1.1;
                raw[y * 2 * s + x] = back.clamp(0.0, 255.0) as u8;
                raw[y * 2 * s + s + x] = front.clamp(0.0, 255.0) as u8;
                raw[2 * s * s + y * 2 * s + x] = 128;
                raw[2 * s * s + y * 2 * s + s + x] = 128;
                raw[4 * s * s + y * 2 * s + x] = 128;
                raw[4 * s * s + y * 2 * s + s + x] = 128;
            }
        }
        let st = calibrate_frames(&[raw], s, n, &lens("dual"));
        println!("{st:?}");
        assert!((st.fov - fov).abs() < 0.4, "{st:?}");
        assert!((st.yaw - cal.0).abs() < 0.3 && (st.pitch - cal.1).abs() < 0.3 && (st.roll - cal.2).abs() < 0.3, "{st:?}");
        assert!(st.after < st.before * 0.5, "{st:?}");
        assert!(st.gain_a[0] < 0.97 && st.gain_b[0] > 1.03, "{st:?}");
    }
}

/// With a real ffmpeg and the fixtures (REELCUT_FX=<dir> FFDIR=<dir> cargo test itest_stitch --
/// --nocapture): calibrate CAM_0001.OSV through its .LRF, then draw the same view across the
/// seam with the old hard switch and with stitching, next to the true picture
/// (ref_equirect.png, the sphere the fixture was made from).
#[cfg(test)]
mod itest {
    use super::*;
    use std::path::PathBuf;

    fn bin(name: &str) -> PathBuf {
        PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join(name)
    }

    fn run(args: &[&str]) -> String {
        let o = ff::command(&bin("ffmpeg")).args(args).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stderr).into_owned()
    }

    fn psnr(a: &Path, b: &Path) -> f64 {
        let log = run(&["-hide_banner", "-i", &a.to_string_lossy(), "-i", &b.to_string_lossy(), "-lavfi", "[0][1]psnr", "-f", "null", "-"]);
        let t = log.split("average:").nth(1).unwrap();
        t.split_whitespace().next().unwrap().parse().unwrap_or(99.0)
    }

    #[test]
    fn itest_stitch() {
        let Ok(fx) = std::env::var("REELCUT_FX") else { return };
        let fx = PathBuf::from(fx);
        let work = fx.join("work-stitch");
        let _ = std::fs::create_dir_all(&work);
        let info = crate::media::inspect(&bin("ffprobe"), &fx.join("CAM_0001.OSV").to_string_lossy()).unwrap();
        let mut lens = Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: None };
        let t = std::time::Instant::now();
        let cal = calibrate(&bin("ffmpeg"), &bin("ffprobe"), &info, &lens).unwrap();
        println!("calibration {:.1}s: {cal:?}", t.elapsed().as_secs_f64());
        lens.stitch = Some(cal.clone());
        let view = View { yaw: 90.0, pitch: 15.0, roll: 0.0, hfov: 100.0 };
        let (w, h) = (1280, 720);
        let osv = fx.join("CAM_0001.OSV").to_string_lossy().into_owned();
        let out = |n: &str| work.join(n);
        // the truth
        run(&["-y", "-loglevel", "error", "-i", &fx.join("ref_equirect.png").to_string_lossy(), "-vf", &crate::media::v360_flat(&Lens { layout: "equirect".into(), swap: false, fov: 360.0, stitch: None }, &view, w, h), "-frames:v", "1", &out("ref.png").to_string_lossy()]);
        // 2.1: one lens up to 90°, then the other
        let old = format!("{};[ls]{}[o]", crate::media::lens_source(0, &lens, None, "ls"), crate::media::v360_flat(&Lens { stitch: Some(Stitch { on: false, ..Default::default() }), ..lens.clone() }, &view, w, h));
        run(&["-y", "-loglevel", "error", "-ss", "1", "-i", &osv, "-filter_complex", &old, "-map", "[o]", "-frames:v", "1", &out("old.png").to_string_lossy()]);
        // stitched, defaults only (no calibration yet) and calibrated
        for (name, l) in [("blend.png", Lens { stitch: None, ..lens.clone() }), ("stitched.png", lens.clone())] {
            let g = graph(0, &l, None, "", &Out::Flat { view: &view, w, h }, None, "st") + ";[st]null[o]";
            run(&["-y", "-loglevel", "error", "-ss", "1", "-i", &osv, "-filter_complex", &g, "-map", "[o]", "-frames:v", "1", &out(name).to_string_lossy()]);
        }
        let (po, pb, ps) = (psnr(&out("old.png"), &out("ref.png")), psnr(&out("blend.png"), &out("ref.png")), psnr(&out("stitched.png"), &out("ref.png")));
        println!("PSNR vs truth: hard seam {po:.2} dB, blend only {pb:.2} dB, calibrated stitch {ps:.2} dB");
        run(&["-y", "-loglevel", "error", "-i", &out("ref.png").to_string_lossy(), "-i", &out("old.png").to_string_lossy(), "-i", &out("blend.png").to_string_lossy(), "-i", &out("stitched.png").to_string_lossy(), "-filter_complex", "[0][1]hstack[a];[2][3]hstack[b];[a][b]vstack", &out("compare.png").to_string_lossy()]);
        assert!((cal.fov - 193.0).abs() < 0.6 && (cal.yaw - 1.0).abs() < 0.4 && (cal.pitch + 0.7).abs() < 0.4 && (cal.roll - 0.4).abs() < 0.4, "{cal:?}");
        assert!(ps > po + 1.0, "stitched {ps} vs hard seam {po}");
        // the proxy (LRF, whole sphere) and a moving export view run too
        let plan = crate::media::proxy_plan(&info, &lens, "libx264", &work, "osv_proxy").unwrap();
        let mut a: Vec<&str> = vec!["-y", "-loglevel", "error"];
        a.extend(plan.args.iter().map(|s| s.as_str()));
        run(&a);
        run(&["-y", "-loglevel", "error", "-ss", "2", "-i", &plan.out.to_string_lossy(), "-frames:v", "1", &out("proxy.png").to_string_lossy()]);
        let m = Moves { v0: View { yaw: 60.0, ..view.clone() }, steps: (1..30).map(|k| (k as f64 / 15.0, View { yaw: 60.0 + k as f64 * 2.0, ..view.clone() })).collect() };
        let g = graph(0, &lens, None, "setpts=PTS-STARTPTS", &Out::Flat { view: &view, w: 640, h: 360 }, Some(&m), "mv") + ";[mv]null[o]";
        run(&["-y", "-loglevel", "error", "-i", &osv, "-t", "2", "-filter_complex", &g, "-map", "[o]", "-c:v", "libx264", "-preset", "ultrafast", &out("moving.mp4").to_string_lossy()]);
    }
}
