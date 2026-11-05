//! Reelcut's own frame-by-frame 360 stitcher, modelled on DJI Studio's Osmo 360 pipeline
//! (`AiStitchOpenglImpl101` in `stitch_with_sym.dll`, see docs/dji-stitch-analysis.md):
//!
//! 1. The overlap band around the seam is unrolled into a strip for each lens (columns run
//!    along the seam, all the way round; rows cross it).
//! 2. How far the two lenses disagree there (optical flow) is measured on every frame. DJI runs
//!    a neural network for this step (`calc_flow` → `run_inference`); Reelcut matches blocks of
//!    the strip instead (DJI's own non-AI path, `DISPruneImplOptB2`, does the same job). The
//!    flow is cleaned up along the seam and over time (DJI: `KalmanFlowFilter`, EMA).
//! 3. A seam line is picked through the band where the two pictures agree best, held steady
//!    over time (DJI: `run_dp_seam_on_raw_flow`, dynamic programming).
//! 4. Both lenses are bent half way towards each other across the band, so a near object meets
//!    itself at the seam instead of showing twice (DJI: `WarpImgShader` / "novel view").
//! 5. Brightness and colour are matched along the seam, strongest at the seam and fading out
//!    across the band (DJI: `Compensator`, 64 blocks, `ver_alpha`), then the band is cross-faded
//!    around the seam line (DJI: `seam_linear_blend`).
//! 6. Every output picture (the whole sphere, or a flat view) is drawn through a mesh that also
//!    carries the stabilisation rotation of that frame and, when the camera's readout time is
//!    known, the rolling-shutter correction (DJI: `EisGetCpuMesh…`, `PanoEisRenderer`).
//!
//! Frames come from ffmpeg as raw YUV 4:2:0 (8 or 10 bit) and go back to ffmpeg to be encoded.

use crate::ff::{self, Jobs, CANCELLED};
use crate::stitch::{matrix, ypr, Stitch};
use parking_lot::Mutex;
use std::io::{Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::mpsc::sync_channel;
use std::sync::Arc;

pub type M3 = [[f64; 3]; 3];
pub const I3: M3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

pub fn mmul(a: &M3, b: &M3) -> M3 {
    let mut m = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            m[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    m
}
pub fn mt(a: &M3) -> M3 {
    [[a[0][0], a[1][0], a[2][0]], [a[0][1], a[1][1], a[2][1]], [a[0][2], a[1][2], a[2][2]]]
}
#[inline]
pub fn mv(a: &M3, v: [f64; 3]) -> [f64; 3] {
    [a[0][0] * v[0] + a[0][1] * v[1] + a[0][2] * v[2], a[1][0] * v[0] + a[1][1] * v[1] + a[1][2] * v[2], a[2][0] * v[0] + a[2][1] * v[1] + a[2][2] * v[2]]
}
/// Rotation by the vector `w` (axis × angle in radians), Rodrigues.
pub fn expmap(w: [f64; 3]) -> M3 {
    let th = (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt();
    if th < 1e-12 {
        return I3;
    }
    let k = [w[0] / th, w[1] / th, w[2] / th];
    let (s, c) = th.sin_cos();
    let v = 1.0 - c;
    [
        [c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s],
        [k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s],
        [k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v],
    ]
}

// ------------------------------------------------------------------ pixels

/// One sample of a YUV plane: 8-bit (`u8`) or 10-bit in 16 (`u16`, little endian).
pub trait Px: Copy + Default + Send + Sync + 'static {
    const BYTES: usize;
    const MAX: f32;
    const FMT: &'static str;
    fn get(self) -> f32;
    fn put(v: f32) -> Self;
    fn read(b: &[u8], out: &mut [Self]);
    fn write(s: &[Self], out: &mut Vec<u8>);
}
impl Px for u8 {
    const BYTES: usize = 1;
    const MAX: f32 = 255.0;
    const FMT: &'static str = "yuv420p";
    #[inline]
    fn get(self) -> f32 {
        self as f32
    }
    #[inline]
    fn put(v: f32) -> Self {
        (v + 0.5).clamp(0.0, 255.0) as u8
    }
    fn read(b: &[u8], out: &mut [Self]) {
        out.copy_from_slice(&b[..out.len()]);
    }
    fn write(s: &[Self], out: &mut Vec<u8>) {
        out.extend_from_slice(s);
    }
}
impl Px for u16 {
    const BYTES: usize = 2;
    const MAX: f32 = 1023.0;
    const FMT: &'static str = "yuv420p10le";
    #[inline]
    fn get(self) -> f32 {
        self as f32
    }
    #[inline]
    fn put(v: f32) -> Self {
        (v + 0.5).clamp(0.0, 1023.0) as u16
    }
    fn read(b: &[u8], out: &mut [Self]) {
        for (o, c) in out.iter_mut().zip(b.chunks_exact(2)) {
            *o = u16::from_le_bytes([c[0], c[1]]);
        }
    }
    fn write(s: &[Self], out: &mut Vec<u8>) {
        out.reserve(s.len() * 2);
        for v in s {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
}

/// A YUV 4:2:0 picture.
#[derive(Clone)]
pub struct Frame<T: Px> {
    pub w: usize,
    pub h: usize,
    pub p: [Vec<T>; 3],
}

impl<T: Px> Frame<T> {
    pub fn new(w: usize, h: usize) -> Self {
        let c = (w / 2) * (h / 2);
        Frame { w, h, p: [vec![T::default(); w * h], vec![T::default(); c], vec![T::default(); c]] }
    }
    pub fn dims(&self, i: usize) -> (usize, usize) {
        if i == 0 { (self.w, self.h) } else { (self.w / 2, self.h / 2) }
    }
    pub fn byte_len(w: usize, h: usize) -> usize {
        (w * h + 2 * (w / 2) * (h / 2)) * T::BYTES
    }
    /// Fills an existing frame, so a long run does not make a new one for every picture.
    pub fn fill(&mut self, b: &[u8]) {
        let mut off = 0;
        for i in 0..3 {
            let n = self.p[i].len();
            T::read(&b[off..off + n * T::BYTES], &mut self.p[i]);
            off += n * T::BYTES;
        }
    }
    /// Like `fill`, from a picture holding only the `rects` of the two lenses side by side. The rest
    /// of this frame is not looked at (`Stitcher::lens_rects`).
    pub fn fill_rects(&mut self, b: &[u8], rects: &[LensRect; 2]) {
        let n = self.w / 2;
        let mut off = 0;
        for i in 0..3 {
            let d = if i == 0 { 1 } else { 2 };
            let (fw, rows) = (self.w / d, rects[0].h as usize / d);
            for r in 0..rows {
                for (lens, q) in rects.iter().enumerate() {
                    let (w, x, y) = (q.w as usize / d, q.x as usize / d, q.y as usize / d);
                    let at = (y + r) * fw + lens * (n / d) + x;
                    T::read(&b[off..off + w * T::BYTES], &mut self.p[i][at..at + w]);
                    off += w * T::BYTES;
                }
            }
        }
    }
    pub fn from_bytes(w: usize, h: usize, b: &[u8]) -> Self {
        let mut f = Frame::new(w, h);
        let mut off = 0;
        for i in 0..3 {
            let n = f.p[i].len();
            T::read(&b[off..off + n * T::BYTES], &mut f.p[i]);
            off += n * T::BYTES;
        }
        f
    }
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(Self::byte_len(self.w, self.h));
        for i in 0..3 {
            T::write(&self.p[i], &mut out);
        }
        out
    }
}

/// Bilinear sample of a plane region (`x0..x0+w` of a `stride`-wide plane), clamped to the edge.
#[inline]
fn bil<T: Px>(p: &[T], stride: usize, x0: usize, w: usize, h: usize, x: f32, y: f32) -> f32 {
    let x = x.clamp(0.0, (w - 1) as f32);
    let y = y.clamp(0.0, (h - 1) as f32);
    let (ix, iy) = (x as usize, y as usize);
    let (ix1, iy1) = ((ix + 1).min(w - 1), (iy + 1).min(h - 1));
    let (fx, fy) = (x - ix as f32, y - iy as f32);
    let at = |xx: usize, yy: usize| p[yy * stride + x0 + xx].get();
    let a = at(ix, iy) + (at(ix1, iy) - at(ix, iy)) * fx;
    let b = at(ix, iy1) + (at(ix1, iy1) - at(ix, iy1)) * fx;
    a + (b - a) * fy
}

/// Bilinear sample of a strip: columns wrap round (the seam is a closed circle), rows clamp.
#[inline]
fn bil_strip(p: &[f32], w: usize, h: usize, x: f32, y: f32) -> f32 {
    let wf = w as f32;
    let x = x.rem_euclid(wf);
    let y = y.clamp(0.0, (h - 1) as f32);
    let (ix, iy) = (x as usize % w, y as usize);
    let (ix1, iy1) = ((ix + 1) % w, (iy + 1).min(h - 1));
    let (fx, fy) = (x - x.floor(), y - iy as f32);
    let a = p[iy * w + ix] + (p[iy * w + ix1] - p[iy * w + ix]) * fx;
    let b = p[iy1 * w + ix] + (p[iy1 * w + ix1] - p[iy1 * w + ix]) * fx;
    a + (b - a) * fy
}

/// Runs `f(row_range, chunk)` over `rows` rows of `buf` (each row `row_len` items) on all cores.
fn par_rows<V: Send>(buf: &mut [V], row_len: usize, rows: usize, f: impl Fn(usize, &mut [V]) + Sync) {
    use rayon::prelude::*;
    let threads = crate::hw::threads().max(1) as usize;
    // Twice the threads' number of pieces: a free thread takes the next, across all clips running.
    let per = rows.div_ceil(threads * 2).max(1);
    buf[..rows * row_len].par_chunks_mut(per * row_len).enumerate().for_each(|(k, chunk)| f(k * per, chunk));
}

// ------------------------------------------------------------------ lens geometry

/// The two fisheyes: field of view and where the back lens points (from the calibration).
#[derive(Clone, Debug)]
pub struct Geo {
    pub fov: f64,
    /// Back lens frame → front frame.
    pub back: M3,
    /// Each fisheye is `n`×`n` pixels in the decoded frame.
    pub n: f64,
    /// The camera's factory calibration of the back and the front lens, when in use.
    pub cal: Option<[crate::stitch::LensCal; 2]>,
}

impl Geo {
    pub fn new(s: &Stitch, n: f64) -> Geo {
        Geo { fov: s.fov.clamp(181.0, 260.0), back: matrix(ypr(180.0 + s.yaw, s.pitch, s.roll)), n, cal: s.factory.clone() }
    }
    /// Pixel of a front-frame direction in lens 0 (back) or 1 (front), v360's fisheye mapping;
    /// and whether it is inside that lens's field of view.
    #[inline]
    pub fn px(&self, lens: usize, d: [f64; 3]) -> (f64, f64, bool) {
        let v = if lens == 0 { mv(&mt(&self.back), d) } else { d };
        self.px_local(lens, v)
    }
    #[inline]
    fn px_local(&self, lens: usize, v: [f64; 3]) -> (f64, f64, bool) {
        let h = v[0].hypot(v[1]);
        let ang = h.atan2(v[2]);
        if let Some(c) = &self.cal {
            let (x, y) = c[lens].px(v, self.n);
            return (x, y, ang.to_degrees() <= self.fov / 2.0 + 1e-9);
        }
        let lh = if h > 1e-12 { h } else { 1.0 };
        let k = ang / std::f64::consts::PI / (self.fov / 360.0);
        let (u, w) = (v[0] / lh * k, v[1] / lh * k);
        let n1 = self.n - 1.0;
        ((0.5 * u + 0.5) * n1, (0.5 * w + 0.5) * n1, ang.to_degrees() <= self.fov / 2.0 + 1e-9)
    }
}

// ------------------------------------------------------------------ the seam strip

/// Stretches round the seam, for working only on the part in view.
const SEAM_GROUPS: usize = 64;
/// How far past the band the mesh keeps the seam's values, as a share of the band.
const SEAM_REACH: f32 = 1.4;
/// How often the seam is measured, seconds; between measures it eases towards the last one, which
/// also keeps it from flickering.
const SEAM_EVERY: f64 = 0.1;

/// Settings of the band: half-width of the cross-fade band (degrees), margin rows each side
/// for the flow search (as a share of the band).
const BAND_SHARE: f64 = 0.7;
const MARGIN: f64 = 0.25;

struct Strip {
    /// Columns (along the seam) and rows: `nr` core rows (the band) plus `mr` margin rows each
    /// side, luma resolution. Chroma strips are half of each.
    nc: usize,
    nr: usize,
    mr: usize,
    /// Band half-width, radians.
    b: f64,
    /// Per luma/chroma strip pixel: (x, y) in each lens and whether the lens sees it.
    lut: [[Vec<(f32, f32, bool)>; 2]; 2],
    seen: std::sync::OnceLock<Vec<bool>>,
}

impl Strip {
    fn rows(&self) -> usize {
        self.nr + 2 * self.mr
    }
    /// Which low-resolution places both lenses see (made once).
    fn low_seen(&self, q: usize) -> &[bool] {
        self.seen.get_or_init(|| {
            let (rows, nc) = (self.rows(), self.nc);
            let (lw, lh) = (nc / q, rows / q);
            let full = |i: usize| self.lut[0][0][i].2 && self.lut[0][1][i].2;
            let mut ok = vec![true; lw * lh];
            for y in 0..lh {
                for x in 0..lw {
                    ok[y * lw + x] = (0..q).all(|yy| (0..q).all(|xx| full((y * q + yy) * nc + x * q + xx)));
                }
            }
            ok
        })
    }
    fn new(geo: &Geo, out_w: usize) -> Strip {
        let b = ((geo.fov - 180.0) / 2.0 * BAND_SHARE).max(0.5).to_radians();
        // Same angular resolution as an equirect picture `out_w` wide.
        let per_rad = out_w as f64 / (2.0 * std::f64::consts::PI);
        let nc = (out_w.max(64) / 2) * 2;
        let mut nr = ((2.0 * b * per_rad).round() as usize).max(8);
        nr += nr % 2;
        let mut mr = ((nr as f64 * MARGIN).round() as usize).max(2);
        mr += mr % 2;
        let mut s = Strip { nc, nr, mr, b, lut: Default::default(), seen: Default::default() };
        let rows = s.rows();
        let s2 = b * rows as f64 / nr as f64;
        for (ci, (w, h)) in [(nc, rows), (nc / 2, rows / 2)].into_iter().enumerate() {
            for lens in 0..2 {
                let nscale = if ci == 0 { 1.0 } else { 0.5 };
                let mut v = Vec::with_capacity(w * h);
                for r in 0..h {
                    let sang = -s2 + (r as f64 + 0.5) * (2.0 * s2 / h as f64);
                    for c in 0..w {
                        let u = -std::f64::consts::PI + (c as f64 + 0.5) * (2.0 * std::f64::consts::PI / w as f64);
                        let d = [sang.cos() * u.cos(), sang.cos() * u.sin(), sang.sin()];
                        let (x, y, ok) = geo.px(lens, d);
                        // Chroma: same place in a half-size plane (centre siting).
                        let (x, y) = if ci == 0 { (x, y) } else { ((x + 0.5) * nscale - 0.5, (y + 0.5) * nscale - 0.5) };
                        v.push((x as f32, y as f32, ok));
                    }
                }
                s.lut[ci][lens] = v;
            }
        }
        s
    }
}

/// Global per-lens colour match: Y gain, U and V shift (in this pixel format's units).
#[derive(Clone, Copy)]
struct Gain {
    y: f32,
    u: f32,
    v: f32,
}
impl Gain {
    fn of<T: Px>(g: &[f64; 3]) -> Gain {
        let k = T::MAX / 255.0;
        Gain { y: g[0] as f32, u: g[1] as f32 * k, v: g[2] as f32 * k }
    }
    #[inline]
    fn apply(&self, plane: usize, x: f32) -> f32 {
        match plane {
            0 => x * self.y,
            1 => x + self.u,
            _ => x + self.v,
        }
    }
}

// ------------------------------------------------------------------ per-frame seam state

/// What the seam looks like this frame, per luma strip column.
struct SeamState {
    /// Flow in luma strip pixels: lens A content at p shows in lens B at p + (fx, fy).
    fx: Vec<f32>,
    fy: Vec<f32>,
    /// Where the cut is across the band (0 = back edge, 1 = front edge).
    ts: Vec<f32>,
    /// Colour match at the seam, relative (Y gain, U and V shift, 8-bit units).
    gy: Vec<f32>,
    du: Vec<f32>,
    dv: Vec<f32>,
    started: bool,
}

impl SeamState {
    fn new(nc: usize) -> Self {
        SeamState { fx: vec![0.0; nc], fy: vec![0.0; nc], ts: vec![0.5; nc], gy: vec![1.0; nc], du: vec![0.0; nc], dv: vec![0.0; nc], started: false }
    }
}

fn gauss_circ(vals: &[f32], wts: &[f32], sigma: f32, prior: f32, prior_w: f32) -> Vec<f32> {
    let n = vals.len();
    let r = (sigma * 3.0).ceil() as isize;
    (0..n)
        .map(|i| {
            let (mut s, mut w) = (prior * prior_w, prior_w);
            for d in -r..=r {
                let j = (i as isize + d).rem_euclid(n as isize) as usize;
                let g = (-(d * d) as f32 / (2.0 * sigma * sigma)).exp() * wts[j];
                s += vals[j] * g;
                w += g;
            }
            if w > 0.0 { s / w } else { prior }
        })
        .collect()
}

/// Linear interpolation of block values (block k centred at column (k + 0.5)·n/nb) to every
/// column, round the circle.
fn expand_circ(blocks: &[f32], n: usize) -> Vec<f32> {
    let nb = blocks.len();
    (0..n)
        .map(|c| {
            let pos = (c as f32 + 0.5) * nb as f32 / n as f32 - 0.5;
            let k0 = pos.floor();
            let f = pos - k0;
            let a = blocks[(k0 as isize).rem_euclid(nb as isize) as usize];
            let b = blocks[((k0 as isize) + 1).rem_euclid(nb as isize) as usize];
            a + (b - a) * f
        })
        .collect()
}

/// Low-resolution luma strips for the flow (box average by `q`), values on an 8-bit scale, and
/// validity.
struct Low {
    w: usize,
    h: usize,
    a: Vec<f32>,
    b: Vec<f32>,
    ok: Vec<bool>,
    ua: Vec<f32>,
    ub: Vec<f32>,
    va: Vec<f32>,
    vb: Vec<f32>,
}

fn downscale(src: &[f32], w: usize, h: usize, q: usize, cols: &[bool; SEAM_GROUPS]) -> Vec<f32> {
    let (lw, lh) = (w / q, h / q);
    let mut out = vec![0f32; lw * lh];
    let k = 1.0 / (q * q) as f32;
    for y in 0..lh {
        for x in 0..lw {
            if !cols[x * SEAM_GROUPS / lw] {
                continue;
            }
            let mut s = 0.0;
            for yy in 0..q {
                let row = &src[(y * q + yy) * w + x * q..(y * q + yy) * w + x * q + q];
                s += row.iter().sum::<f32>();
            }
            out[y * lw + x] = s * k;
        }
    }
    out
}

/// The flow along the seam (DJI's `calc_flow`), by matching blocks of the low strips.
fn measure_flow(lo: &Low, nrl: usize, mrl: usize) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let nb = (lo.w / 8).max(8);
    let half = 8isize;
    let ry = mrl as isize;
    let rx = 2isize;
    let w = lo.w as isize;
    let at = |img: &[f32], x: isize, y: usize| img[y * lo.w + x.rem_euclid(w) as usize];
    let okat = |x: isize, y: usize| lo.ok[y * lo.w + x.rem_euclid(w) as usize];
    let one = |k: usize| -> (f32, f32, f32) {
        let cb = ((k as f32 + 0.5) * lo.w as f32 / nb as f32) as isize;
        // The lens-A patch, its mean and spread.
        let (mut sa, mut sa2, mut na) = (0f32, 0f32, 0f32);
        for r in mrl..mrl + nrl {
            for x in cb - half..cb + half {
                if okat(x, r) {
                    let v = at(&lo.a, x, r);
                    sa += v;
                    sa2 += v * v;
                    na += 1.0;
                }
            }
        }
        if na < 16.0 {
            return (0.0, 0.0, 0.0);
        }
        let ma = sa / na;
        let var = (sa2 / na - ma * ma).max(0.0);
        let mut best = (f32::INFINITY, 0isize, 0isize);
        let mut costs = vec![f32::INFINITY; ((2 * ry + 1) * (2 * rx + 1)) as usize];
        for dy in -ry..=ry {
            for dx in -rx..=rx {
                let (mut sb, mut nn) = (0f32, 0f32);
                for r in mrl..mrl + nrl {
                    let rb = r as isize + dy;
                    if rb < 0 || rb >= lo.h as isize {
                        continue;
                    }
                    for x in cb - half..cb + half {
                        if okat(x, r) && okat(x + dx, rb as usize) {
                            sb += at(&lo.b, x + dx, rb as usize);
                            nn += 1.0;
                        }
                    }
                }
                if nn < na * 0.6 {
                    continue;
                }
                let mb = sb / nn;
                let mut c = 0f32;
                for r in mrl..mrl + nrl {
                    let rb = r as isize + dy;
                    if rb < 0 || rb >= lo.h as isize {
                        continue;
                    }
                    for x in cb - half..cb + half {
                        if okat(x, r) && okat(x + dx, rb as usize) {
                            c += ((at(&lo.a, x, r) - ma) - (at(&lo.b, x + dx, rb as usize) - mb)).abs();
                        }
                    }
                }
                c /= nn;
                // A slight pull towards no movement, so flat areas stay put.
                c += 0.02 * (dy.abs() + dx.abs()) as f32;
                costs[((dy + ry) * (2 * rx + 1) + dx + rx) as usize] = c;
                if c < best.0 {
                    best = (c, dx, dy);
                }
            }
        }
        if !best.0.is_finite() {
            return (0.0, 0.0, 0.0);
        }
        let cost = |dx: isize, dy: isize| -> Option<f32> {
            if dx.abs() > rx || dy.abs() > ry {
                return None;
            }
            let c = costs[((dy + ry) * (2 * rx + 1) + dx + rx) as usize];
            c.is_finite().then_some(c)
        };
        let sub = |m: Option<f32>, c0: f32, p: Option<f32>| -> f32 {
            match (m, p) {
                (Some(m), Some(p)) => {
                    let den = m - 2.0 * c0 + p;
                    if den > 1e-6 { (0.5 * (m - p) / den).clamp(-0.5, 0.5) } else { 0.0 }
                }
                _ => 0.0,
            }
        };
        let (c0, bx, by) = best;
        let sx = sub(cost(bx - 1, by), c0, cost(bx + 1, by));
        let sy = sub(cost(bx, by - 1), c0, cost(bx, by + 1));
        // Trust textured blocks whose best match is not at the edge of the search.
        let mut wk = var / (var + 25.0);
        if by.abs() == ry || bx.abs() == rx {
            wk *= 0.2;
        }
        // How much better the best is than no movement at all.
        if let Some(z) = cost(0, 0) {
            if z - c0 < 0.3 {
                wk *= 0.5;
            }
        }
        (bx as f32 + sx, by as f32 + sy, wk)
    };
    use rayon::prelude::*;
    let found: Vec<(f32, f32, f32)> = (0..nb).into_par_iter().map(one).collect();
    (found.iter().map(|f| f.0).collect(), found.iter().map(|f| f.1).collect(), found.iter().map(|f| f.2).collect())
}

/// Seam line through the band (DJI's DP seam): per low column the core row where the warped
/// lenses agree best, moving at most one row per column, near the middle and near last frame's.
fn dp_seam(lo: &Low, nrl: usize, mrl: usize, fx: &[f32], fy: &[f32], prev: &[f32], started: bool) -> Vec<f32> {
    let lo_r = (nrl as f32 * 0.25).ceil() as usize;
    let hi_r = ((nrl as f32 * 0.75).floor() as usize).max(lo_r + 1).min(nrl - 1);
    let nrow = hi_r - lo_r + 1;
    let w = lo.w;
    let mid = (nrl as f32 - 1.0) / 2.0;
    let mut acc = vec![0f32; w * nrow];
    let mut from = vec![0u8; w * nrow];
    let d_at = |c: usize, r: usize| -> f32 {
        let t = (r as f32 + 0.5) / nrl as f32;
        let (x, y) = (c as f32, (mrl + r) as f32);
        let a = bil_strip(&lo.a, w, lo.h, x - t * fx[c], y - t * fy[c]);
        let b = bil_strip(&lo.b, w, lo.h, x + (1.0 - t) * fx[c], y + (1.0 - t) * fy[c]);
        (a - b).abs()
    };
    for c in 0..w {
        for k in 0..nrow {
            let r = lo_r + k;
            let mut cost = d_at(c, r) + 2.0 * ((r as f32 - mid) / nrl as f32).powi(2) * 8.0;
            if started {
                cost += 1.0 * (r as f32 - (prev[c] * nrl as f32 - 0.5)).abs();
            }
            if c == 0 {
                acc[k] = cost;
                continue;
            }
            let mut best = (f32::INFINITY, 0u8);
            for (j, d) in [-1isize, 0, 1].iter().enumerate() {
                let kk = k as isize + d;
                if kk < 0 || kk >= nrow as isize {
                    continue;
                }
                let v = acc[(c - 1) * nrow + kk as usize] + if *d == 0 { 0.0 } else { 0.3 };
                if v < best.0 {
                    best = (v, j as u8);
                }
            }
            acc[c * nrow + k] = cost + best.0;
            from[c * nrow + k] = best.1;
        }
    }
    let mut k = (0..nrow).min_by(|a, b| acc[(w - 1) * nrow + a].total_cmp(&acc[(w - 1) * nrow + b])).unwrap_or(nrow / 2);
    let mut path = vec![0f32; w];
    for c in (0..w).rev() {
        path[c] = ((lo_r + k) as f32 + 0.5) / nrl as f32;
        if c > 0 {
            k = (k as isize + from[c * nrow + k] as isize - 1) as usize;
        }
    }
    // Soften the steps.
    let ones = vec![1f32; w];
    gauss_circ(&path, &ones, 2.0, 0.5, 0.0)
}

// ------------------------------------------------------------------ the stitcher

/// What to draw for each frame: the rotation from output directions to the front lens's frame
/// (stabilisation × view), the flat view's horizontal field of view (None = whole sphere), and
/// the camera's turn rate for the rolling-shutter correction.
#[derive(Clone, Debug)]
pub struct FrameSetup {
    pub rot: M3,
    /// Flat view: field of view and projection (`proj`); None = the whole sphere.
    pub hfov: Option<(f64, f64)>,
    pub omega: Option<[f64; 3]>,
}

/// Rolling shutter: time from the first to the last sensor row, seconds, and whether rows are
/// read from the top (true) or the bottom.
#[derive(Clone, Copy, Debug)]
pub struct Rs {
    pub readout: f64,
    pub top_first: bool,
}

/// A part of one lens picture, in its pixels; all even, so chroma lines up.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LensRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Frames one decoder reads when a clip is split (8 s; starting a decoder takes about a second, and
/// it starts ahead of its turn).
const PART_FRAMES: usize = 240;
/// How many frames before its turn the next decoder starts.
const PART_LEAD: usize = 45;
/// Decoders running at once across clips: each holds the chip's memory for a whole lens picture, and
/// too many make it refuse new ones. A start ahead of its turn waits below this; a turn does not.
const MAX_DECODERS: usize = 4;
static LIVE_DECODERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// One decoder's stretch of a run: from frame `first`, `frames` of them (None: to the end).
struct Part {
    first: usize,
    frames: Option<usize>,
    rects: Option<[LensRect; 2]>,
}

pub struct Stitcher {
    pub geo: Geo,
    strip: Strip,
    pub flow: bool,
    /// Width of the plain blend, radians (`stitch::blend_width`).
    blend: f32,
    gains: [[f64; 3]; 2],
    state: SeamState,
    pub out_w: usize,
    pub out_h: usize,
    step: usize,
    rs: Option<Rs>,
    mesh_key: Option<(M3, Option<(f64, f64)>, Option<[f64; 3]>)>,
    mesh: Vec<[f32; 6]>,
    gw: usize,
    gh: usize,
    /// When measuring: per frame the lenses' difference on the seam without and with the alignment,
    /// how far the flow moved (strip pixels), how far the cut moved (share of the band).
    pub stats: Option<Vec<[f32; 4]>>,
    /// When measuring: seconds spent reading the strips, measuring, blending the band, drawing.
    pub times: [f64; 4],
    /// Measure the seam every this many frames.
    pub seam_every: usize,
    tick: usize,
    /// The last measure, which `state` eases towards.
    target: SeamState,
    /// How far the seam has eased since that measure.
    eased: (f32, f32),
    /// See `build_seam_mesh`.
    seam_mesh: Vec<[f32; 8]>,
}

impl Stitcher {
    pub fn new(s: &Stitch, n: f64, out_w: usize, out_h: usize, flow: bool, rs: Option<Rs>) -> Stitcher {
        let geo = Geo::new(s, n);
        // The strip at the sphere's resolution: an equirect output sets it directly; a flat view
        // at its own pixels per degree, but never more than the lenses have.
        let lens_w = (n * 360.0 / geo.fov) as usize;
        let strip = Strip::new(&geo, out_w.clamp(256, lens_w.max(256)));
        let nc = strip.nc;
        let step = if out_w * out_h > 600_000 { 8 } else { 4 };
        let blend = crate::stitch::blend_width(geo.fov).to_radians() as f32;
        Stitcher { geo, strip, flow, blend, gains: [s.gain_a, s.gain_b], state: SeamState::new(nc), out_w, out_h, step, rs, mesh_key: None, mesh: vec![], gw: 0, gh: 0, stats: None, times: [0.0; 4], seam_every: 3, tick: 0, target: SeamState::new(nc), eased: (0.0, 0.0), seam_mesh: vec![] }
    }

    /// Which of `SEAM_GROUPS` stretches round the seam this frame's mesh shows; None when it shows
    /// none of them (no need to measure, or to read those parts of the lenses).
    fn seam_in_view(&self) -> Option<[bool; SEAM_GROUPS]> {
        let (nc, reach) = (self.strip.nc as f32, self.strip.b as f32 * 1.2);
        let mut on = [false; SEAM_GROUPS];
        let mut any = false;
        for m in &self.mesh {
            if m[5].abs() < reach {
                let g = (((m[4] + 0.5) / nc * SEAM_GROUPS as f32) as isize).rem_euclid(SEAM_GROUPS as isize) as usize;
                on[g] = true;
                any = true;
            }
        }
        if !any {
            return None;
        }
        // The neighbours too: the search looks to the sides, the smoothing reaches over.
        let mut out = [false; SEAM_GROUPS];
        for (g, v) in on.iter().enumerate() {
            if *v {
                for d in 0..=4 {
                    out[(g + SEAM_GROUPS - 2 + d) % SEAM_GROUPS] = true;
                }
            }
        }
        Some(out)
    }

    /// The lenses' strips (luma and chroma, gains applied) from a side-by-side frame, in the stretches `cols`.
    fn strips<T: Px>(&self, src: &Frame<T>, cols: &[bool; SEAM_GROUPS]) -> [[Vec<f32>; 3]; 2] {
        let st = &self.strip;
        let n = self.geo.n as usize;
        let ga = [Gain::of::<T>(&self.gains[0]), Gain::of::<T>(&self.gains[1])];
        let mut out: [[Vec<f32>; 3]; 2] = Default::default();
        for lens in 0..2 {
            for pl in 0..3 {
                let ci = if pl == 0 { 0 } else { 1 };
                let (fw, fh) = src.dims(pl);
                let ln = if pl == 0 { n } else { n / 2 };
                let lut = &st.lut[ci][lens];
                let plane = &src.p[pl];
                let g = ga[lens];
                let mut v = vec![0f32; lut.len()];
                let w = if ci == 0 { st.nc } else { st.nc / 2 };
                par_rows(&mut v, w, lut.len() / w, |r0, chunk| {
                    for (i, o) in chunk.iter_mut().enumerate() {
                        if cols[(i % w) * SEAM_GROUPS / w] {
                            let (x, y, _) = lut[r0 * w + i];
                            *o = g.apply(pl, bil(plane, fw, lens * ln, ln, fh, x, y));
                        }
                    }
                });
                out[lens][pl] = v;
            }
        }
        out
    }

    /// Measures the flow, seam line and colour match for this frame (updates `state`), in the stretches `cols`.
    fn update_seam<T: Px>(&mut self, s: &[[Vec<f32>; 3]; 2], cols: &[bool; SEAM_GROUPS]) {
        let st = &self.strip;
        let rows = st.rows();
        let q = ((st.nr as f32 / 24.0).round() as usize).max(2);
        let q = q + q % 2;
        let k8 = 255.0 / T::MAX;
        let to8 = |v: Vec<f32>| v.into_iter().map(|x| x * k8).collect::<Vec<f32>>();
        let (lw, lh) = (st.nc / q, rows / q);
        let seen = st.low_seen(q);
        let mut ok = vec![true; lw * lh];
        for y in 0..lh {
            for x in 0..lw {
                ok[y * lw + x] = cols[x * SEAM_GROUPS / lw] && seen[y * lw + x];
            }
        }
        let cq = q / 2;
        let lo = Low {
            w: lw,
            h: lh,
            a: to8(downscale(&s[0][0], st.nc, rows, q, cols)),
            b: to8(downscale(&s[1][0], st.nc, rows, q, cols)),
            ok,
            ua: to8(downscale(&s[0][1], st.nc / 2, rows / 2, cq, cols)),
            ub: to8(downscale(&s[1][1], st.nc / 2, rows / 2, cq, cols)),
            va: to8(downscale(&s[0][2], st.nc / 2, rows / 2, cq, cols)),
            vb: to8(downscale(&s[1][2], st.nc / 2, rows / 2, cq, cols)),
        };
        let (nrl, mrl) = (st.nr / q, st.mr / q);
        let started = self.state.started;
        // Flow, smoothed along the seam.
        let (bfx, bfy) = if self.flow {
            let (fx, fy, wt) = measure_flow(&lo, nrl, mrl);
            (gauss_circ(&fx, &wt, 1.5, 0.0, 0.05), gauss_circ(&fy, &wt, 1.5, 0.0, 0.05))
        } else {
            (vec![0.0; 8], vec![0.0; 8])
        };
        let lfx: Vec<f32> = expand_circ(&bfx, lw);
        let lfy: Vec<f32> = expand_circ(&bfy, lw).into_iter().map(|v| v.clamp(-(mrl as f32) * 0.9, mrl as f32 * 0.9)).collect();
        // Seam line on the low strip.
        let prev_low: Vec<f32> = (0..lw).map(|c| self.state.ts[(c * q + q / 2).min(st.nc - 1)]).collect();
        let ts_low = if self.flow { dp_seam(&lo, nrl, mrl, &lfx, &lfy, &prev_low, started) } else { vec![0.5; lw] };
        // Colour at the seam, 64 groups round the circle (DJI's Compensator).
        let groups = 64.min(lw);
        let mut m = vec![[0f64; 7]; groups];
        for c in 0..lw {
            let g = c * groups / lw;
            let rr = (ts_low[c] * nrl as f32) as isize;
            let band = (nrl as isize / 8).max(1);
            for r in (rr - band).max(0)..(rr + band).min(nrl as isize) {
                let t = (r as f32 + 0.5) / nrl as f32;
                let y = (mrl as isize + r) as f32;
                let (xa, ya) = (c as f32 - t * lfx[c], y - t * lfy[c]);
                let (xb, yb) = (c as f32 + (1.0 - t) * lfx[c], y + (1.0 - t) * lfy[c]);
                if !lo.ok[(mrl + r as usize) * lw + c] {
                    continue;
                }
                let e = &mut m[g];
                e[0] += bil_strip(&lo.a, lw, lh, xa, ya) as f64;
                e[1] += bil_strip(&lo.b, lw, lh, xb, yb) as f64;
                e[2] += bil_strip(&lo.ua, lw, lh, xa, ya) as f64;
                e[3] += bil_strip(&lo.ub, lw, lh, xb, yb) as f64;
                e[4] += bil_strip(&lo.va, lw, lh, xa, ya) as f64;
                e[5] += bil_strip(&lo.vb, lw, lh, xb, yb) as f64;
                e[6] += 1.0;
            }
        }
        let mut gy = vec![1f32; groups];
        let mut du = vec![0f32; groups];
        let mut dv = vec![0f32; groups];
        let mut gw = vec![0f32; groups];
        for (g, e) in m.iter().enumerate() {
            if e[6] < 4.0 || e[0] / e[6] < 12.0 || e[1] / e[6] < 12.0 {
                continue;
            }
            gy[g] = ((e[1] / e[0]).sqrt() as f32).clamp(0.85, 1.18);
            du[g] = (((e[3] - e[2]) / e[6] / 2.0) as f32).clamp(-8.0, 8.0);
            dv[g] = (((e[5] - e[4]) / e[6] / 2.0) as f32).clamp(-8.0, 8.0);
            gw[g] = 1.0;
        }
        let gy = expand_circ(&gauss_circ(&gy, &gw, 1.0, 1.0, 0.1), st.nc);
        let du = expand_circ(&gauss_circ(&du, &gw, 1.0, 0.0, 0.1), st.nc);
        let dv = expand_circ(&gauss_circ(&dv, &gw, 1.0, 0.0, 0.1), st.nc);
        // To full-resolution columns; `ease_seam` carries it over time (DJI: EMA flow filter).
        let full_fx = expand_circ(&lfx, st.nc).into_iter().map(|v| v * q as f32).collect::<Vec<_>>();
        let full_fy = expand_circ(&lfy, st.nc).into_iter().map(|v| v * q as f32).collect::<Vec<_>>();
        let full_ts = expand_circ(&ts_low, st.nc);
        self.target = SeamState { fx: full_fx, fy: full_fy, ts: full_ts, gy, du, dv, started: true };
        if !started {
            self.state.fx.clone_from(&self.target.fx);
            self.state.fy.clone_from(&self.target.fy);
            self.state.ts.clone_from(&self.target.ts);
            self.state.gy.clone_from(&self.target.gy);
            self.state.du.clone_from(&self.target.du);
            self.state.dv.clone_from(&self.target.dv);
            self.state.started = true;
        }
        let s = &self.state;
        if let Some(rec) = self.stats.as_mut() {
            let (moved, cut) = (self.eased.0 / self.seam_every.max(1) as f32, self.eased.1 / self.seam_every.max(1) as f32);
            self.eased = (0.0, 0.0);
            let (mut plain, mut lined, mut cnt) = (0f32, 0f32, 0f32);
            let mid = mrl + nrl / 2;
            for c in 0..lw {
                if !lo.ok[mid * lw + c] {
                    continue;
                }
                plain += (lo.a[mid * lw + c] - lo.b[mid * lw + c]).abs();
                let fc = (c * q + q / 2).min(st.nc - 1);
                let t = s.ts[fc];
                let y = mrl as f32 + t * nrl as f32 - 0.5;
                let (fx, fy) = (s.fx[fc] / q as f32, s.fy[fc] / q as f32);
                lined += (bil_strip(&lo.a, lw, lh, c as f32 - t * fx, y - t * fy) - bil_strip(&lo.b, lw, lh, c as f32 + (1.0 - t) * fx, y + (1.0 - t) * fy)).abs();
                cnt += 1.0;
            }
            rec.push([plain / cnt.max(1.0), lined / cnt.max(1.0), moved, cut]);
        }
    }

    /// One frame nearer the last measure (DJI: EMA flow filter).
    fn ease_seam(&mut self) {
        let (s, t) = (&mut self.state, &self.target);
        let n = s.fx.len() as f32;
        let (mut moved, mut cut) = (0f32, 0f32);
        for i in 0..s.fx.len() {
            let (dx, dy, dt) = ((t.fx[i] - s.fx[i]) * 0.3, (t.fy[i] - s.fy[i]) * 0.3, (t.ts[i] - s.ts[i]) * 0.3);
            s.fx[i] += dx;
            s.fy[i] += dy;
            s.ts[i] += dt;
            s.gy[i] += (t.gy[i] - s.gy[i]) * 0.12;
            s.du[i] += (t.du[i] - s.du[i]) * 0.12;
            s.dv[i] += (t.dv[i] - s.dv[i]) * 0.12;
            moved += dx.abs() + dy.abs();
            cut += dt.abs();
        }
        self.eased.0 += moved / n;
        self.eased.1 += cut / n;
    }

    /// Where each mesh point near the seam reads from this frame: both lenses moved by part of the flow,
    /// the front lens's share, and the colour match (Y gain, U and V shift). The lenses are read directly,
    /// so the seam stays as sharp as the picture round it.
    fn build_seam_mesh(&mut self) {
        let geo = &self.geo;
        let (nc, b) = (self.strip.nc, self.strip.b);
        let (along, across) = (2.0 * std::f64::consts::PI / nc as f64, 2.0 * b / self.strip.nr as f64);
        let state = &self.state;
        let mesh = &self.mesh;
        let gw = self.gw;
        let mut out = std::mem::take(&mut self.seam_mesh);
        out.resize(mesh.len(), [0.0; 8]);
        par_rows(&mut out, gw, mesh.len() / gw.max(1), |r0, chunk| {
            for (i, o) in chunk.iter_mut().enumerate() {
                let m = &mesh[r0 * gw + i];
                let sn = m[5] as f64;
                if sn.abs() >= b * SEAM_REACH as f64 {
                    *o = [m[0], m[1], m[2], m[3], if sn >= 0.0 { 1.0 } else { 0.0 }, 1.0, 0.0, 0.0];
                    continue;
                }
                let col = (m[4].round() as isize).rem_euclid(nc as isize) as usize;
                let u = -std::f64::consts::PI + (col as f64 + 0.5) * along;
                let t = ((sn + b) / (2.0 * b)).clamp(0.0, 1.0);
                let (fu, fs) = (state.fx[col] as f64 * along, state.fy[col] as f64 * across);
                let dir = |u: f64, s: f64| [s.cos() * u.cos(), s.cos() * u.sin(), s.sin()];
                // The mesh point's own place, plus the turn the flow asks for.
                let (au, as_) = (m[4] as f64 - col as f64, sn);
                let uu = u + au * along;
                let (xa, ya, oka) = geo.px(0, dir(uu - t * fu, as_ - t * fs));
                let (xb, yb, okb) = geo.px(1, dir(uu + (1.0 - t) * fu, as_ + (1.0 - t) * fs));
                let ts = state.ts[col];
                let tf = t as f32;
                let mut wb = ((tf - ts) / 0.5 + 0.5).clamp(0.0, 1.0);
                if !oka && okb {
                    wb = 1.0;
                } else if oka && !okb {
                    wb = 0.0;
                }
                let phi = if tf < ts { tf / ts.max(1e-3) } else { (1.0 - tf) / (1.0 - ts).max(1e-3) };
                *o = [xa as f32, ya as f32, xb as f32, yb as f32, wb, state.gy[col].powf(phi), state.du[col] * phi, state.dv[col] * phi];
            }
        });
        self.seam_mesh = out;
    }

    /// Mesh of where each output pixel comes from: (xa, ya, xb, yb) in the lenses, strip
    /// column, and angle across the seam (radians).
    fn build_mesh(&mut self, fs: &FrameSetup) {
        let key = (fs.rot, fs.hfov, fs.omega);
        if self.mesh_key.as_ref() == Some(&key) {
            return;
        }
        let (w, h, step) = (self.out_w, self.out_h, self.step);
        let (gw, gh) = (w / step + 2, h / step + 2);
        let mut mesh = vec![[0f32; 6]; gw * gh];
        let geo = &self.geo;
        let nc = self.strip.nc;
        let rs = self.rs;
        let flat = fs.hfov.map(|(hf, d)| (crate::proj::r_edge(hf.max(20.0), d), d));
        let rot = fs.rot;
        let omega = fs.omega;
        par_rows(&mut mesh, gw, gh, |r0, chunk| {
            for (i, o) in chunk.iter_mut().enumerate() {
                let (gy, gx) = (r0 + i / gw, i % gw);
                let (x, y) = ((gx * step) as f64, (gy * step) as f64);
                let d = match flat {
                    Some((tx, 0.0)) => {
                        let ty = tx * h as f64 / w as f64;
                        let v = [(2.0 * (x + 0.5) / w as f64 - 1.0) * tx, (2.0 * (y + 0.5) / h as f64 - 1.0) * ty, 1.0];
                        let l = (v[0] * v[0] + v[1] * v[1] + 1.0).sqrt();
                        [v[0] / l, v[1] / l, v[2] / l]
                    }
                    Some((re, dd)) => crate::proj::view_dir(2.0 * (x + 0.5) / w as f64 - 1.0, 2.0 * (y + 0.5) / h as f64 - 1.0, re, dd, h as f64 / w as f64),
                    None => {
                        let phi = (2.0 * (x + 0.5) / w as f64 - 1.0) * std::f64::consts::PI;
                        let th = (2.0 * (y + 0.5) / h as f64 - 1.0) * std::f64::consts::FRAC_PI_2;
                        [th.cos() * phi.sin(), th.sin(), th.cos() * phi.cos()]
                    }
                };
                let dc = mv(&rot, d);
                let mut lens_px = [(0f64, 0f64); 2];
                for (lens, lp) in lens_px.iter_mut().enumerate() {
                    let (mut px, mut py, _) = geo.px(lens, dc);
                    if let (Some(rs), Some(om)) = (rs, omega) {
                        // The row was read a little earlier or later than the middle of the frame:
                        // turn the direction back by the camera's turn over that time.
                        let frac = py / (geo.n - 1.0) - 0.5;
                        let dt = if rs.top_first { frac } else { -frac } * rs.readout;
                        let d2 = mv(&expmap([-om[0] * dt, -om[1] * dt, -om[2] * dt]), dc);
                        let (qx, qy, _) = geo.px(lens, d2);
                        px = qx;
                        py = qy;
                    }
                    *lp = (px, py);
                }
                let u = dc[1].atan2(dc[0]);
                let c = (u + std::f64::consts::PI) / (2.0 * std::f64::consts::PI) * nc as f64 - 0.5;
                let s = dc[2].clamp(-1.0, 1.0).asin();
                *o = [lens_px[0].0 as f32, lens_px[0].1 as f32, lens_px[1].0 as f32, lens_px[1].1 as f32, c as f32, s as f32];
            }
        });
        self.mesh = mesh;
        self.gw = gw;
        self.gh = gh;
        self.mesh_key = Some(key);
    }

    /// Which part of each lens this run looks at, so only that comes off the graphics chip: a view
    /// sees a small part of the sphere, and reading the pictures back is the slowest step of an
    /// export. Both rects have one height (they go side by side). None: most of the lenses anyway.
    pub fn lens_rects(&mut self, setup: &dyn Fn(usize, f64) -> FrameSetup, first: usize, frames: usize, fps: f64) -> Option<[LensRect; 2]> {
        let n = self.geo.n as u32;
        // Lens pixels: what may move between the sampled frames, and more than the sampling reads.
        let pad = (self.geo.n * 0.02) as f32 + 16.0;
        // A lens counts a little before its blend starts, or before the strip that lines the seam up.
        let reach = if self.flow { self.strip.b as f32 * (1.0 + 2.0 * MARGIN as f32) + 1.5f32.to_radians() } else { self.blend / 2.0 + 2f32.to_radians() };
        let mut lo = [[f32::MAX; 2]; 2];
        let mut hi = [[f32::MIN; 2]; 2];
        let last = first + frames.max(1) - 1;
        let mut k = first;
        loop {
            self.build_mesh(&setup(k, k as f64 / fps.max(1.0)));
            for m in &self.mesh {
                for lens in 0..2 {
                    let used = if lens == 0 { m[5] < reach } else { m[5] > -reach };
                    if used {
                        for a in 0..2 {
                            lo[lens][a] = lo[lens][a].min(m[lens * 2 + a]);
                            hi[lens][a] = hi[lens][a].max(m[lens * 2 + a]);
                        }
                    }
                }
            }
            if k >= last {
                break;
            }
            k = (k + 5).min(last);
        }
        let span = |lens: usize, a: usize| -> (u32, u32) {
            if lo[lens][a] > hi[lens][a] {
                return (0, 64.min(n)); // this lens is never seen
            }
            let from = ((lo[lens][a] - pad).max(0.0) as u32) & !1;
            let to = (((hi[lens][a] + pad).ceil() as u32).min(n) + 1).min(n) & !1;
            (from, to.max(from + 2).min(n))
        };
        let ((x0, x0e), (x1, x1e)) = (span(0, 0), span(1, 0));
        let ((y0, y0e), (y1, y1e)) = (span(0, 1), span(1, 1));
        let h = (y0e - y0).max(y1e - y1);
        let rects = [
            LensRect { x: x0, y: y0.min(n - h), w: x0e - x0, h },
            LensRect { x: x1, y: y1.min(n - h), w: x1e - x1, h },
        ];
        let kept = (rects[0].w + rects[1].w) as f64 * h as f64 / (2.0 * n as f64 * n as f64);
        (kept < 0.85).then_some(rects)
    }

    /// The decoders of a run. A view that wanders over a clip needs most of the lenses in all but
    /// needs little at any moment, so a long clip is read in stretches, each with its own rects.
    fn parts(&mut self, setup: &dyn Fn(usize, f64) -> FrameSetup, total: usize, fps: f64) -> Vec<Part> {
        let whole = self.lens_rects(setup, 0, total, fps);
        let n = self.geo.n;
        let share = |r: &[LensRect; 2]| (r[0].w + r[1].w) as f64 * r[0].h as f64 / (2.0 * n * n);
        if total < 2 * PART_FRAMES || whole.as_ref().is_some_and(|r| share(r) < 0.3) {
            return vec![Part { first: 0, frames: None, rects: whole }];
        }
        let mut v = Vec::new();
        let mut first = 0;
        while first < total {
            // The tail joins the stretch before it rather than start a decoder for a moment.
            let frames = if total - first < PART_FRAMES * 3 / 2 { None } else { Some(PART_FRAMES) };
            v.push(Part { first, frames, rects: self.lens_rects(setup, first, frames.unwrap_or(total - first), fps) });
            first += frames.unwrap_or(total - first);
        }
        v
    }

    /// One output frame from one side-by-side input frame.
    pub fn frame<T: Px>(&mut self, src: &Frame<T>, fs: &FrameSetup) -> Frame<T> {
        self.build_mesh(fs);
        // The seam is lined up where this frame shows it. Out of sight it starts over when it comes back.
        let seen = if self.flow { self.seam_in_view() } else { None };
        match &seen {
            Some(cols) => {
                let t0 = std::time::Instant::now();
                // The strips are for measuring only.
                if !self.state.started || self.tick % self.seam_every.max(1) == 0 {
                    let strips = self.strips(src, cols);
                    self.times[0] += t0.elapsed().as_secs_f64();
                    let t1 = std::time::Instant::now();
                    self.update_seam::<T>(&strips, cols);
                    self.times[1] += t1.elapsed().as_secs_f64();
                }
                self.tick += 1;
                self.ease_seam();
                let t2 = std::time::Instant::now();
                self.build_seam_mesh();
                self.times[2] += t2.elapsed().as_secs_f64();
            }
            None => {
                self.state.started = false;
                self.target.started = false;
            }
        }
        let (flow, bw) = (seen.is_some(), self.blend);
        let mut out = Frame::<T>::new(self.out_w, self.out_h);
        let st = &self.strip;
        let n = self.geo.n as usize;
        let ga = [Gain::of::<T>(&self.gains[0]), Gain::of::<T>(&self.gains[1])];
        let (mesh, gw, gh, step) = (&self.mesh, self.gw, self.gh, self.step as f32);
        let near = st.b as f32 * SEAM_REACH;
        let seam_mesh = &self.seam_mesh;
        let k8 = T::MAX / 255.0;
        for pl in 0..3 {
            let (ow, oh) = out.dims(pl);
            let ci = if pl == 0 { 0 } else { 1 };
            let ln = if pl == 0 { n } else { n / 2 };
            let (fw, fh) = src.dims(pl);
            let plane = &src.p[pl];
            // Front lens weight by the angle past the boundary; where the seam is lined up, by that.
                par_rows(&mut out.p[pl], ow, oh, |r0, chunk| {
                    let (dx, x0) = if ci == 0 { (1.0f32, 0.0f32) } else { (2.0, 0.5) };
                    let half = if ci == 0 { 0.0 } else { 1.0 };
                    for (ri, row) in chunk.chunks_exact_mut(ow).enumerate() {
                        let fy = ((r0 + ri) as f32 * dx + x0) / step;
                        let gy0 = (fy as usize).min(gh - 2);
                        let ty = fy - gy0 as f32;
                        let (top, bot) = (&mesh[gy0 * gw..(gy0 + 1) * gw], &mesh[(gy0 + 1) * gw..(gy0 + 2) * gw]);
                        let mut x = 0usize;
                        while x < ow {
                            let at = (x as f32 * dx + x0) / step;
                            let gx0 = (at as usize).min(gw - 2);
                            let end = if gx0 == gw - 2 { ow } else { ((((gx0 + 1) as f32 * step - x0) / dx).ceil() as usize).clamp(x + 1, ow) };
                            let tx = at - gx0 as f32;
                            let dt = dx / step;
                            let touches = flow && [top[gx0][5], top[gx0 + 1][5], bot[gx0][5], bot[gx0 + 1][5]].iter().any(|s| s.abs() < near);
                            if touches {
                                let (st0, st1) = (&seam_mesh[gy0 * gw..(gy0 + 1) * gw], &seam_mesh[(gy0 + 1) * gw..(gy0 + 2) * gw]);
                                let (mut cur, mut inc) = ([0f32; 8], [0f32; 8]);
                                for j in 0..8 {
                                    let l = st0[gx0][j] + (st1[gx0][j] - st0[gx0][j]) * ty;
                                    let r = st0[gx0 + 1][j] + (st1[gx0 + 1][j] - st0[gx0 + 1][j]) * ty;
                                    cur[j] = l + (r - l) * tx;
                                    inc[j] = (r - l) * dt;
                                }
                                for o in row[x..end].iter_mut() {
                                    let read = |lens: usize| {
                                        let (mut px, mut py) = (cur[lens * 2], cur[lens * 2 + 1]);
                                        if half > 0.0 {
                                            px = (px + 0.5) * 0.5 - 0.5;
                                            py = (py + 0.5) * 0.5 - 0.5;
                                        }
                                        ga[lens].apply(pl, bil(plane, fw, lens * ln, ln, fh, px, py))
                                    };
                                    let wb = cur[4].clamp(0.0, 1.0);
                                    let back = |v: f32| match pl {
                                        0 => v * cur[5],
                                        1 => v + cur[6] * k8,
                                        _ => v + cur[7] * k8,
                                    };
                                    let front = |v: f32| match pl {
                                        0 => v / cur[5],
                                        1 => v - cur[6] * k8,
                                        _ => v - cur[7] * k8,
                                    };
                                    let val = if wb <= 0.0 {
                                        back(read(0))
                                    } else if wb >= 1.0 {
                                        front(read(1))
                                    } else {
                                        let (ca, cb) = (back(read(0)), front(read(1)));
                                        ca + (cb - ca) * wb
                                    };
                                    *o = T::put(val);
                                    for j in 0..8 {
                                        cur[j] += inc[j];
                                    }
                                }
                                x = end;
                                continue;
                            }
                            let (mut cur, mut inc) = ([0f32; 5], [0f32; 5]);
                            for (j, k) in [0usize, 1, 2, 3, 5].into_iter().enumerate() {
                                let l = top[gx0][k] + (bot[gx0][k] - top[gx0][k]) * ty;
                                let r = top[gx0 + 1][k] + (bot[gx0 + 1][k] - top[gx0 + 1][k]) * ty;
                                cur[j] = l + (r - l) * tx;
                                inc[j] = (r - l) * dt;
                            }
                            for o in row[x..end].iter_mut() {
                                let w = if flow { if cur[4] >= 0.0 { 1.0 } else { 0.0 } } else { ((cur[4] + bw / 2.0) / bw).clamp(0.0, 1.0) };
                                let sample = |lens: usize| {
                                    let (mut px, mut py) = (cur[lens * 2], cur[lens * 2 + 1]);
                                    if half > 0.0 {
                                        px = (px + 0.5) * 0.5 - 0.5;
                                        py = (py + 0.5) * 0.5 - 0.5;
                                    }
                                    ga[lens].apply(pl, bil(plane, fw, lens * ln, ln, fh, px, py))
                                };
                                let val = if w <= 0.0 {
                                    sample(0)
                                } else if w >= 1.0 {
                                    sample(1)
                                } else {
                                    w * sample(1) + (1.0 - w) * sample(0)
                                };
                                *o = T::put(val);
                                for j in 0..5 {
                                    cur[j] += inc[j];
                                }
                            }
                            x = end;
                        }
                    }
                });
        }
        out
    }
}

// ------------------------------------------------------------------ running it on a file

/// Raw lens pictures are tens of MB each. An ordinary pipe holds 64 KB, so ffmpeg and the reader take
/// turns for every 64 KB and that is what limits an export (44 pictures a second measured on John's
/// PC against 73 with this): on Windows the pictures come through a named pipe with a larger buffer.
#[cfg(windows)]
mod big_pipe {
    use parking_lot::Mutex;
    use std::ffi::c_void;
    use std::io::Read;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    const BUFFER: u32 = 4 << 20;
    const PIPE_ACCESS_INBOUND: u32 = 1;
    extern "system" {
        fn CreateNamedPipeW(name: *const u16, open: u32, mode: u32, max: u32, out: u32, inb: u32, timeout: u32, sa: *mut c_void) -> *mut c_void;
        fn ConnectNamedPipe(h: *mut c_void, o: *mut c_void) -> i32;
    }
    static NEXT: AtomicU64 = AtomicU64::new(0);

    /// Waits for ffmpeg to open its end on the first read.
    struct Pipe {
        file: std::fs::File,
        connected: bool,
    }
    impl Read for Pipe {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            if !self.connected {
                self.connected = true;
                // Fails harmlessly when ffmpeg got there first.
                unsafe { ConnectNamedPipe(self.file.as_raw_handle() as *mut c_void, std::ptr::null_mut()) };
            }
            self.file.read(b)
        }
    }

    /// The pipe's name for ffmpeg and our end of it; None if it cannot be made (stdout then).
    pub fn create() -> Option<(String, Box<dyn Read + Send>)> {
        let name = format!(r"\\.\pipe\reelcut-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
        let wide: Vec<u16> = std::ffi::OsStr::new(&name).encode_wide().chain([0]).collect();
        let h = unsafe { CreateNamedPipeW(wide.as_ptr(), PIPE_ACCESS_INBOUND, 0, 1, BUFFER, BUFFER, 0, std::ptr::null_mut()) };
        if h as isize == -1 || h.is_null() {
            return None;
        }
        Some((name, Box::new(Pipe { file: unsafe { std::fs::File::from_raw_handle(h) }, connected: false })))
    }

    /// If ffmpeg ends before it ever opened the pipe, nobody would wake the reader: this does.
    pub fn unblock_when_gone(child: Arc<Mutex<std::process::Child>>, name: String) {
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if !matches!(child.lock().try_wait(), Ok(None)) {
                let _ = std::fs::File::open(&name);
                return;
            }
        });
    }
}

#[cfg(not(windows))]
mod big_pipe {
    use parking_lot::Mutex;
    use std::io::Read;
    use std::sync::Arc;
    pub fn create() -> Option<(String, Box<dyn Read + Send>)> {
        None
    }
    pub fn unblock_when_gone(_: Arc<Mutex<std::process::Child>>, _: String) {}
}

/// The recording to stitch.
#[derive(Clone, Debug)]
pub struct Source {
    pub path: String,
    /// dual (two tracks) | dfisheye (side by side)
    pub layout: String,
    pub swap: bool,
    pub start: f64,
    /// Seconds to read (0 = to the end).
    pub dur: f64,
    /// Each fisheye's size in the file.
    pub lens_px: u32,
    /// Shrink each fisheye to this size first (None = as is).
    pub scale_to: Option<u32>,
    pub fps: f64,
    /// Keep one frame in this many (1 = all); frame k of the run is frame k·every of the source.
    pub every: u32,
    /// Decode and shrink on the GPU (Intel Quick Sync), as the live preview does.
    pub gpu: bool,
    /// With `gpu`: bring back only the parts of the lenses this run looks at.
    pub crop: bool,
}

impl Source {
    pub fn n(&self) -> u32 {
        let n = self.scale_to.unwrap_or(self.lens_px).max(16);
        n - n % 2
    }
    fn decode_args(&self, fmt: &str, rects: Option<&[LensRect; 2]>, first: usize, frames: Option<usize>) -> Vec<String> {
        let n = self.n();
        let sc = |l: &str| format!("[{l}]scale={n}:{n}:flags=area[{l}s]");
        let pick = if self.every > 1 { format!("select='not(mod(n\\,{}))',", self.every) } else { String::new() };
        let g = match self.layout.as_str() {
            "dual" => {
                let (ia, ib) = if self.swap { (1, 0) } else { (0, 1) };
                if let (true, Some([ra, rb])) = (self.gpu, rects) {
                    let q = |r: &LensRect| format!("vpp_qsv=cx={}:cy={}:cw={}:ch={}:format=nv12,hwdownload,format=nv12", r.x, r.y, r.w, r.h);
                    format!("[0:v:{ia}]{}[as];[0:v:{ib}]{}[bs];[as][bs]hstack,{pick}format={fmt}[o]", q(ra), q(rb))
                } else if self.gpu {
                    let q = format!("vpp_qsv=w={n}:h={n}:format=nv12,hwdownload,format=nv12");
                    format!("[0:v:{ia}]{q}[as];[0:v:{ib}]{q}[bs];[as][bs]hstack,{pick}format={fmt}[o]")
                } else {
                    format!("[0:v:{ia}]null[a];[0:v:{ib}]null[b];{};{};[as][bs]hstack,{pick}format={fmt}[o]", sc("a"), sc("b"))
                }
            }
            _ if self.swap => format!("[0:v:0]scale={}:{n}:flags=area,split[l][r];[l]crop=iw/2:ih:0:0[b];[r]crop=iw/2:ih:iw/2:0[a];[a][b]hstack,{pick}format={fmt}[o]", 2 * n),
            _ => format!("[0:v:0]scale={}:{n}:flags=area,{pick}format={fmt}[o]", 2 * n),
        };
        let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error"].iter().map(|x| x.to_string()).collect();
        if self.gpu {
            // Depth 1: at the default depth the decoder hands out each picture with the time of one about
            // 3 frames later, so the view and the gyro (and the sound) would run ahead of the picture.
            a.extend(["-hwaccel", "qsv", "-hwaccel_output_format", "qsv", "-async_depth", "1"].iter().map(|x| x.to_string()));
        }
        if first == 0 {
            if self.start > 0.0 {
                a.extend(["-ss".to_string(), format!("{:.3}", self.start)]);
            }
            if self.dur > 0.0 && frames.is_none() {
                a.extend(["-t".to_string(), format!("{:.3}", self.dur)]);
            }
        } else {
            // A seek lands on the frame nearest its time (measured on real files, as `k0` of the run).
            let fps = self.fps.max(1.0);
            let at = ((self.start * fps).round().max(0.0) + first as f64) / fps;
            a.extend(["-ss".to_string(), format!("{at:.6}")]);
            if frames.is_none() {
                a.extend(["-t".to_string(), format!("{:.6}", self.start + self.dur + 1.5 / fps - at)]);
            }
        }
        a.extend(["-i".to_string(), self.path.clone(), "-filter_complex".into(), g, "-map".into(), "[o]".into()]);
        if let Some(k) = frames {
            a.extend(["-frames:v".to_string(), k.to_string()]);
        }
        if self.every > 1 {
            a.extend(["-fps_mode".to_string(), "passthrough".to_string()]);
        }
        a.extend(["-f".to_string(), "rawvideo".to_string(), "-".to_string()]);
        a
    }
}

/// Where the stitched frames go.
pub enum Sink<'a, T: Px> {
    /// To ffmpeg reading raw video on stdin; these arguments follow `-i pipe:0`.
    Encode { args: Vec<String> },
    /// To a function (motion analysis).
    Call(&'a mut dyn FnMut(usize, &Frame<T>)),
}

fn spawn_tracked(jobs: &Jobs, tag: &str, bin: &Path, args: &[String], stdin: bool) -> Result<Arc<Mutex<std::process::Child>>, String> {
    let child = ff::command(bin)
        .args(args)
        .stdin(if stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(if stdin { Stdio::null() } else { Stdio::piped() })
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg 실행 실패: {e}"))?;
    let c = Arc::new(Mutex::new(child));
    jobs.add(tag, c.clone());
    Ok(c)
}

fn stderr_text(c: &Arc<Mutex<std::process::Child>>) -> std::thread::JoinHandle<String> {
    let err = c.lock().stderr.take();
    std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut e) = err {
            let _ = e.read_to_string(&mut s);
        }
        s
    })
}

/// Stitches `src` frame by frame. `setup(k, t)` gives frame k's rotation and view (t = seconds
/// from the start of the source range); `on(k)` reports progress. Cancelled through `jobs`.
#[allow(clippy::too_many_arguments)]
pub fn run<T: Px>(
    ffmpeg: &Path,
    jobs: &Jobs,
    tag: &str,
    gen: u64,
    src: &Source,
    st: &mut Stitcher,
    setup: &dyn Fn(usize, f64) -> FrameSetup,
    sink: Sink<T>,
    mut on: impl FnMut(usize),
) -> Result<usize, String> {
    if jobs.generation(tag) != gen {
        return Err(CANCELLED.into());
    }
    let n = src.n() as usize;
    st.seam_every = (src.fps * SEAM_EVERY).round().max(1.0) as usize;
    let (iw, ih) = (2 * n, n);
    // Only at the file's own size: shrinking and cropping as two passes loses the last frame.
    let parts = if src.crop && src.gpu && src.layout == "dual" && src.n() == src.lens_px && src.every == 1 && src.dur > 0.0 && st.rs.is_none() {
        st.parts(setup, ((src.dur * src.fps).ceil() as usize + 1).max(1), src.fps)
    } else {
        vec![Part { first: 0, frames: None, rects: None }]
    };
    let part_len = |p: &Part| match &p.rects {
        Some(r) => Frame::<T>::byte_len((r[0].w + r[1].w) as usize, r[0].h as usize),
        None => Frame::<T>::byte_len(iw, ih),
    };
    // Starts a part's decoder; the reader takes its pipe when its turn comes.
    let start_part = |i: usize| -> Result<(Arc<Mutex<std::process::Child>>, std::thread::JoinHandle<String>, Box<dyn Read + Send>), String> {
        let p = &parts[i];
        let mut args = src.decode_args(T::FMT, p.rects.as_ref(), p.first, p.frames);
        let big = big_pipe::create();
        if let (Some((name, _)), Some(last)) = (&big, args.last_mut()) {
            *last = "-y".to_string();
            args.push(name.clone());
        }
        let dec = spawn_tracked(jobs, tag, ffmpeg, &args, false)?;
        LIVE_DECODERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let err = stderr_text(&dec);
        let pipe: Box<dyn Read + Send> = match big {
            Some((name, pipe)) => {
                big_pipe::unblock_when_gone(dec.clone(), name);
                pipe
            }
            None => Box::new(dec.lock().stdout.take().ok_or("ffmpeg 출력 없음")?),
        };
        Ok((dec, err, pipe))
    };
    enum In {
        Picture(Vec<u8>, usize),
        PartDone(usize),
    }
    let (tx_in, rx_in) = sync_channel::<In>(2);
    // Used buffers come back: one input frame is tens of MB, too much to allocate for every picture.
    let (tx_back, rx_back) = std::sync::mpsc::channel::<Vec<u8>>();
    let (tx_part, rx_part) = std::sync::mpsc::channel::<(usize, usize, Option<usize>, Box<dyn Read + Send>)>();
    let reader = std::thread::spawn(move || {
        for (i, in_len, frames, mut pipe) in rx_part {
            let mut done = 0usize;
            while frames.is_none_or(|n| done < n) {
                let mut buf = rx_back.try_recv().unwrap_or_default();
                buf.resize(in_len, 0);
                let mut got = 0;
                while got < in_len {
                    match pipe.read(&mut buf[got..]) {
                        Ok(0) | Err(_) => break,
                        Ok(k) => got += k,
                    }
                }
                if got < in_len {
                    break;
                }
                if tx_in.send(In::Picture(buf, i)).is_err() {
                    return;
                }
                done += 1;
            }
            drop(pipe);
            if tx_in.send(In::PartDone(i)).is_err() {
                return;
            }
        }
    });
    let mut decs = Vec::with_capacity(parts.len());
    let mut ended = 0usize;
    let mut tx_part = Some(tx_part);
    let first = start_part(0)?;
    decs.push((first.0, first.1));
    if let Some(t) = &tx_part {
        let _ = t.send((0, part_len(&parts[0]), parts[0].frames, first.2));
    }
    if parts.len() == 1 {
        tx_part = None;
    }
    let (ow, oh) = (st.out_w, st.out_h);
    let mut enc: Option<(Arc<Mutex<std::process::Child>>, std::thread::JoinHandle<String>, std::sync::mpsc::SyncSender<Vec<u8>>, std::thread::JoinHandle<Result<(), String>>)> = None;
    let mut call = None;
    match sink {
        Sink::Encode { args } => {
            let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", T::FMT, "-s", &format!("{ow}x{oh}"), "-r", &format!("{:.5}", src.fps.max(1.0)), "-i", "pipe:0"]
                .iter()
                .map(|x| x.to_string())
                .collect();
            a.extend(args);
            let e = spawn_tracked(jobs, tag, ffmpeg, &a, true)?;
            let e_err = stderr_text(&e);
            let mut stdin = e.lock().stdin.take().ok_or("ffmpeg 입력 없음")?;
            let (tx, rx) = sync_channel::<Vec<u8>>(2);
            let writer = std::thread::spawn(move || -> Result<(), String> {
                for b in rx {
                    stdin.write_all(&b).map_err(|e| e.to_string())?;
                }
                Ok(())
            });
            enc = Some((e, e_err, tx, writer));
        }
        Sink::Call(f) => call = Some(f),
    }
    let mut k = 0usize;
    let mut failed: Option<String> = None;
    let mut input = Frame::<T>::new(iw, ih);
    let (mut waited, mut stitched, mut written) = (0f64, 0f64, 0f64);
    loop {
        let t0 = std::time::Instant::now();
        let Ok(got) = rx_in.recv() else { break };
        let (buf, part) = match got {
            In::Picture(b, i) => (b, i),
            In::PartDone(_) => {
                LIVE_DECODERS.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                ended += 1;
                // Started already, unless the part just ended came up short or the chip was full.
                if decs.len() < parts.len() {
                    match start_part(decs.len()) {
                        Ok((d, e, pipe)) => {
                            let i = decs.len();
                            decs.push((d, e));
                            if let Some(t) = &tx_part {
                                let _ = t.send((i, part_len(&parts[i]), parts[i].frames, pipe));
                            }
                            if decs.len() == parts.len() {
                                tx_part = None;
                            }
                        }
                        Err(e) => {
                            failed = Some(e);
                            break;
                        }
                    }
                }
                continue;
            }
        };
        waited += t0.elapsed().as_secs_f64();
        if jobs.generation(tag) != gen {
            failed = Some(CANCELLED.into());
            break;
        }
        let t1 = std::time::Instant::now();
        match &parts[part].rects {
            Some(r) => input.fill_rects(&buf, r),
            None => input.fill(&buf),
        }
        let _ = tx_back.send(buf);
        // The next decoder starts ahead of its turn, so its start-up is not waited for.
        if decs.len() < parts.len() && k + PART_LEAD >= parts[decs.len()].first && LIVE_DECODERS.load(std::sync::atomic::Ordering::Relaxed) < MAX_DECODERS {
            match start_part(decs.len()) {
                Ok((d, e, pipe)) => {
                    let i = decs.len();
                    decs.push((d, e));
                    if let Some(t) = &tx_part {
                        let _ = t.send((i, part_len(&parts[i]), parts[i].frames, pipe));
                    }
                    if decs.len() == parts.len() {
                        tx_part = None;
                    }
                }
                Err(e) => {
                    failed = Some(e);
                    break;
                }
            }
        }
        let fs = setup(k, k as f64 / src.fps.max(1.0));
        let out = st.frame(&input, &fs);
        stitched += t1.elapsed().as_secs_f64();
        let t2 = std::time::Instant::now();
        if let Some((_, _, tx, _)) = &enc {
            if tx.send(out.to_bytes()).is_err() {
                failed = Some("인코더가 멈췄습니다".into());
                break;
            }
        } else if let Some(cb) = call.as_mut() {
            cb(k, &out);
        }
        written += t2.elapsed().as_secs_f64();
        k += 1;
        on(k);
    }
    drop(rx_in);
    drop(tx_part);
    if k > 30 {
        let part = if src.crop {
            let total: f64 = parts.iter().map(|p| part_len(p) as f64 * p.frames.unwrap_or(k.saturating_sub(p.first)) as f64).sum();
            format!(", {} part(s), read back {:.0}% of the lenses", parts.len(), total / (Frame::<T>::byte_len(iw, ih) as f64 * k as f64) * 100.0)
        } else {
            String::new()
        };
        crate::logs::log("stage", &format!("{} frames, {}px per lens, gpu {}{part}: waiting for decode {waited:.1}s, stitching {stitched:.1}s, waiting for encoder {written:.1}s", k, n, src.gpu));
    }
    if failed.is_some() {
        for (d, _) in &decs {
            let _ = d.lock().kill();
        }
    }
    let _ = reader.join();
    // In-flight notices of ended parts may never have been read.
    LIVE_DECODERS.fetch_sub(decs.len().saturating_sub(ended), std::sync::atomic::Ordering::Relaxed);
    let mut dec_failed: Option<String> = None;
    for (d, e) in decs.drain(..) {
        let stat = d.lock().wait();
        jobs.remove(tag, &d);
        let text = e.join().unwrap_or_default();
        if !matches!(&stat, Ok(s) if s.success()) && dec_failed.is_none() {
            dec_failed = Some(text);
        }
    }
    if let Some((e, e_err, tx, writer)) = enc {
        drop(tx);
        let wres = writer.join().unwrap_or(Err("쓰기 실패".into()));
        if failed.is_some() {
            let _ = e.lock().kill();
        }
        let estat = e.lock().wait();
        jobs.remove(tag, &e);
        let eerr = e_err.join().unwrap_or_default();
        if failed.is_none() {
            if !matches!(&estat, Ok(s) if s.success()) || wres.is_err() {
                failed = Some(format!("스티칭 인코딩 실패: {}", eerr.lines().filter(|l| !l.trim().is_empty()).take(3).collect::<Vec<_>>().join(" / ")));
            }
        }
    }
    if jobs.generation(tag) != gen {
        return Err(CANCELLED.into());
    }
    if let Some(e) = failed {
        return Err(e);
    }
    // Stretches must add up, or the picture would drift from the sound.
    let short = parts.len() > 1 && parts.last().is_some_and(|p| k < p.first + 2);
    if k == 0 || (parts.len() > 1 && (short || dec_failed.is_some())) {
        return Err(format!("360 영상을 읽지 못했습니다{}", dec_failed.map(|t| format!(": {}", t.lines().next().unwrap_or(""))).unwrap_or_default()));
    }
    Ok(k)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wandering_view_is_read_in_stretches_that_add_up() {
        let st = Stitch { fov: 193.4, ..Default::default() };
        let mut s = Stitcher::new(&st, 1024.0, 1920, 1080, false, None);
        let wander = |k: usize, _t: f64| FrameSetup { rot: crate::stitch::matrix(crate::stitch::ypr(k as f64 * 0.4, -15.0, 0.0)), hfov: Some((91.0, 0.3)), omega: None };
        let parts = s.parts(&wander, 901, 30.0);
        assert!(parts.len() >= 3, "{}", parts.len());
        assert_eq!(parts[0].first, 0);
        for w in parts.windows(2) {
            assert_eq!(w[0].first + w[0].frames.unwrap(), w[1].first);
        }
        let last = parts.last().unwrap();
        assert!(last.frames.is_none() && 901 - last.first >= PART_FRAMES / 2);
        // A steady view stays one decoder.
        let steady = |_: usize, _t: f64| FrameSetup { rot: crate::stitch::matrix(crate::stitch::ypr(30.0, -15.0, 0.0)), hfov: Some((91.0, 0.3)), omega: None };
        assert_eq!(s.parts(&steady, 901, 30.0).len(), 1);
        // Short clips too.
        assert_eq!(s.parts(&wander, 300, 30.0).len(), 1);
    }

    #[test]
    fn a_later_part_seeks_to_its_own_frame() {
        let src = Source { path: "x".into(), layout: "dual".into(), swap: false, start: 10.0, dur: 20.0, lens_px: 3840, scale_to: None, fps: 30.0, every: 1, gpu: true, crop: true };
        let a = src.decode_args("yuv420p", None, 0, Some(240));
        let at = |v: &Vec<String>, f: &str| v.iter().position(|x| x == f).map(|i| v[i + 1].clone());
        assert_eq!(at(&a, "-ss").as_deref(), Some("10.000"));
        assert_eq!(at(&a, "-t"), None);
        assert_eq!(at(&a, "-frames:v").as_deref(), Some("240"));
        let b = src.decode_args("yuv420p", None, 240, None);
        let ss: f64 = at(&b, "-ss").unwrap().parse().unwrap();
        assert!((ss - 540.0 / 30.0).abs() < 1e-5, "{ss}");
        let t: f64 = at(&b, "-t").unwrap().parse().unwrap();
        assert!((ss + t - 30.0 - 1.5 / 30.0).abs() < 1e-5, "{t}");
        assert_eq!(at(&b, "-frames:v"), None);
    }

    #[test]
    fn a_cropped_picture_lands_where_the_full_one_was() {
        let (n, rects) = (8usize, [LensRect { x: 2, y: 4, w: 4, h: 2 }, LensRect { x: 0, y: 2, w: 2, h: 2 }]);
        let mut f = Frame::<u8>::new(2 * n, n);
        // Luma: 4+2 wide, 2 rows. Chroma: 2+1 wide, 1 row.
        let b: Vec<u8> = (1..=12).chain(13..=15).chain(16..=18).collect();
        f.fill_rects(&b, &rects);
        assert_eq!(&f.p[0][4 * 16 + 2..4 * 16 + 6], &[1, 2, 3, 4]);
        assert_eq!(&f.p[0][2 * 16 + 8..2 * 16 + 10], &[5, 6]);
        assert_eq!(&f.p[0][5 * 16 + 2..5 * 16 + 6], &[7, 8, 9, 10]);
        assert_eq!(&f.p[0][3 * 16 + 8..3 * 16 + 10], &[11, 12]);
        assert_eq!(&f.p[1][2 * 8 + 1..2 * 8 + 3], &[13, 14]);
        assert_eq!(f.p[1][8 + 4], 15);
        assert_eq!(&f.p[2][2 * 8 + 1..2 * 8 + 3], &[16, 17]);
        assert_eq!(f.p[2][8 + 4], 18);
    }

    #[test]
    fn the_rects_hold_every_pixel_of_a_moving_view() {
        let st = Stitch { fov: 193.4, ..Default::default() };
        let n = 1024usize;
        let mut s = Stitcher::new(&st, n as f64, 1920, 1080, false, None);
        let setup = |k: usize, _t: f64| FrameSetup { rot: crate::stitch::matrix(crate::stitch::ypr(20.0 + k as f64 * 0.2, -15.0, 0.0)), hfov: Some((91.0, 0.3)), omega: None };
        let r = s.lens_rects(&setup, 0, 150, 30.0).expect("a view needs part of the lenses");
        assert_eq!(r[0].h, r[1].h);
        for q in &r {
            assert!(q.x % 2 == 0 && q.y % 2 == 0 && q.w % 2 == 0 && q.h % 2 == 0, "{q:?}");
            assert!(q.x + q.w <= n as u32 && q.y + q.h <= n as u32, "{q:?}");
        }
        // Every frame, also those it did not sample, at every mesh point a lens is used.
        let bw = crate::stitch::blend_width(193.4).to_radians() as f32;
        for k in 0..150 {
            s.build_mesh(&setup(k, 0.0));
            for m in &s.mesh {
                for lens in 0..2 {
                    if (lens == 0 && m[5] < bw / 2.0) || (lens == 1 && m[5] > -bw / 2.0) {
                        let q = &r[lens];
                        let (px, py) = (m[lens * 2], m[lens * 2 + 1]);
                        assert!(px >= q.x as f32 - 0.5 && px + 1.0 <= (q.x + q.w) as f32 + 0.5, "lens {lens} frame {k} x {px} {q:?}");
                        assert!(py >= q.y as f32 - 0.5 && py + 1.0 <= (q.y + q.h) as f32 + 0.5, "lens {lens} frame {k} y {py} {q:?}");
                    }
                }
            }
        }
        // A whole-sphere picture needs everything.
        let mut all = Stitcher::new(&st, n as f64, 2048, 1024, false, None);
        assert!(all.lens_rects(&|_, _| FrameSetup { rot: I3, hfov: None, omega: None }, 0, 10, 30.0).is_none());
    }

    /// How long a moving 1080p view takes (REELCUT_BENCH=1 cargo test --release --lib bench_frame -- --nocapture).
    #[test]
    fn bench_frame() {
        if std::env::var_os("REELCUT_BENCH").is_none() {
            return;
        }
        let st = Stitch { fov: 193.4, gain_a: [0.976, 0.4, -0.3], gain_b: [1.025, -0.4, 0.3], ..Default::default() };
        let n: usize = std::env::var("REELCUT_BENCH").ok().and_then(|v| v.parse().ok()).unwrap_or(3564) & !1;
        let mut src = Frame::<u8>::new(2 * n, n);
        for pl in 0..3 {
            let (w, _) = src.dims(pl);
            for (i, v) in src.p[pl].iter_mut().enumerate() {
                *v = ((i % w) * 7 + (i / w) * 13) as u8;
            }
        }
        for workers in [1usize, 3] {
            let t = std::time::Instant::now();
            let frames = 60usize;
            std::thread::scope(|sc| {
                for w in 0..workers {
                    let (st, src) = (&st, &src);
                    sc.spawn(move || {
                        let mut s = Stitcher::new(st, n as f64, 1920, 1080, false, None);
                        for k in 0..frames {
                            let rot = crate::stitch::matrix(crate::stitch::ypr(w as f64 * 40.0 + k as f64 * 0.5, -15.0, 0.0));
                            std::hint::black_box(s.frame(src, &FrameSetup { rot, hfov: Some((91.0, 0.3)), omega: None }));
                        }
                    });
                }
            });
            println!("BENCH {workers} worker(s): {:.1} ms per frame per worker, {:.0} fps overall", t.elapsed().as_secs_f64() * 1000.0 / frames as f64, (workers * frames) as f64 / t.elapsed().as_secs_f64());
        }
    }

    /// A synthetic scene: a function of direction (front frame) → luma.
    fn scene(d: [f64; 3]) -> f32 {
        let lon = d[0].atan2(d[2]);
        let lat = d[1].asin();
        (128.0 + 60.0 * (lon * 7.0).sin() * (lat * 5.0).cos() + 40.0 * (lon * 23.0 + lat * 11.0).sin()) as f32
    }

    /// Both lenses of `scene` side by side, back lens turned by `geo`.
    fn render_pair(geo: &Geo, shift_back: f64) -> Frame<u8> {
        let n = geo.n as usize;
        let mut f = Frame::<u8>::new(2 * n, n);
        let half = geo.fov / 2.0;
        for lens in 0..2 {
            for y in 0..n {
                for x in 0..n {
                    // Inverse fisheye: pixel → lens direction.
                    let u = 2.0 * x as f64 / (n - 1) as f64 - 1.0;
                    let w = 2.0 * y as f64 / (n - 1) as f64 - 1.0;
                    let r = u.hypot(w);
                    let ang = r * geo.fov / 360.0 * std::f64::consts::PI;
                    if ang.to_degrees() > half + 2.0 {
                        continue;
                    }
                    let (s, c) = ang.sin_cos();
                    let v = if r > 1e-12 { [u / r * s, w / r * s, c] } else { [0.0, 0.0, 1.0] };
                    let mut d = if lens == 0 { mv(&geo.back, v) } else { v };
                    if lens == 0 && shift_back != 0.0 {
                        // Parallax: the back lens sees things nearer the seam shifted towards +z.
                        d = mv(&expmap([0.0, shift_back.to_radians() * d[0].signum(), 0.0]), d);
                    }
                    f.p[0][y * 2 * n + lens * n + x] = scene(d).clamp(0.0, 255.0) as u8;
                }
            }
        }
        for c in 1..3 {
            for v in f.p[c].iter_mut() {
                *v = 128;
            }
        }
        f
    }

    fn seam_error(out: &Frame<u8>) -> f64 {
        // Compare with the scene along both seams of an equirect picture.
        let (w, h) = (out.w, out.h);
        let mut e = 0.0;
        let mut k = 0.0;
        for y in h / 4..3 * h / 4 {
            for x in 0..w {
                let phi = (2.0 * (x as f64 + 0.5) / w as f64 - 1.0) * std::f64::consts::PI;
                if (phi.abs() - std::f64::consts::FRAC_PI_2).abs() > 0.05 {
                    continue;
                }
                let th = (2.0 * (y as f64 + 0.5) / h as f64 - 1.0) * std::f64::consts::FRAC_PI_2;
                let d = [th.cos() * phi.sin(), th.sin(), th.cos() * phi.cos()];
                e += (out.p[0][y * w + x] as f64 - scene(d) as f64).abs();
                k += 1.0;
            }
        }
        e / k
    }

    #[test]
    fn stitches_a_calibrated_pair() {
        let s = Stitch { fov: 194.0, yaw: 0.8, pitch: -0.5, roll: 0.3, calibrated: true, ..Default::default() };
        let geo = Geo::new(&s, 400.0);
        let f = render_pair(&geo, 0.0);
        let mut st = Stitcher::new(&s, 400.0, 800, 400, true, None);
        let out = st.frame(&f, &FrameSetup { rot: I3, hfov: None, omega: None });
        let e = seam_error(&out);
        assert!(e < 6.0, "seam error {e}");
        // A flat view straight at the seam.
        let mut st2 = Stitcher::new(&s, 400.0, 320, 240, true, None);
        let rot = matrix(ypr(90.0, 0.0, 0.0));
        let flat = st2.frame(&f, &FrameSetup { rot, hfov: Some((90.0, 0.0)), omega: None });
        assert_eq!(flat.p[0].len(), 320 * 240);
    }

    #[test]
    fn flow_pulls_a_shifted_lens_into_line() {
        let s = Stitch { fov: 196.0, calibrated: true, ..Default::default() };
        let geo = Geo::new(&s, 480.0);
        let f = render_pair(&geo, 1.2);
        // How much the two warped lenses still disagree inside the band (a double picture).
        let mismatch = |st: &Stitcher| {
            let strips = st.strips(&f, &[true; SEAM_GROUPS]);
            let sp = &st.strip;
            let (w, rows) = (sp.nc, sp.rows());
            let (mut e, mut k) = (0.0f64, 0.0f64);
            for r in 0..sp.nr {
                let t = (r as f32 + 0.5) / sp.nr as f32;
                for c in 0..w {
                    let i = (sp.mr + r) * w + c;
                    if !(sp.lut[0][0][i].2 && sp.lut[0][1][i].2) {
                        continue;
                    }
                    let (fx, fy) = (st.state.fx[c], st.state.fy[c]);
                    let y = (sp.mr + r) as f32;
                    let a = bil_strip(&strips[0][0], w, rows, c as f32 - t * fx, y - t * fy);
                    let b = bil_strip(&strips[1][0], w, rows, c as f32 + (1.0 - t) * fx, y + (1.0 - t) * fy);
                    e += (a - b).abs() as f64;
                    k += 1.0;
                }
            }
            e / k
        };
        let run = |flow: bool| {
            let mut st = Stitcher::new(&s, 480.0, 960, 480, flow, None);
            let mut out = st.frame(&f, &FrameSetup { rot: I3, hfov: None, omega: None });
            for _ in 0..3 {
                out = st.frame(&f, &FrameSetup { rot: I3, hfov: None, omega: None });
            }
            assert!(seam_error(&out) < 12.0);
            (mismatch(&st), st.state.fy.iter().map(|v| v.abs()).sum::<f32>() / st.state.fy.len() as f32)
        };
        let (plain, _) = run(false);
        let (flowed, fy) = run(true);
        assert!(fy > 0.5, "flow found nothing: {fy}");
        assert!(flowed < plain * 0.6, "double picture with flow {flowed} vs without {plain}");
    }

    #[test]
    fn stabilising_rotation_turns_the_picture() {
        let s = Stitch { fov: 194.0, calibrated: true, ..Default::default() };
        let geo = Geo::new(&s, 200.0);
        let f = render_pair(&geo, 0.0);
        let mut st = Stitcher::new(&s, 200.0, 400, 200, false, None);
        let a = st.frame(&f, &FrameSetup { rot: I3, hfov: None, omega: None });
        let b = st.frame(&f, &FrameSetup { rot: matrix(ypr(90.0, 0.0, 0.0)), hfov: None, omega: None });
        // Turning by 90° yaw moves the picture a quarter of the way round.
        let mut diff = 0.0;
        for y in 50..150 {
            for x in 0..400 {
                diff += (a.p[0][y * 400 + (x + 100) % 400] as f64 - b.p[0][y * 400 + x] as f64).abs();
            }
        }
        assert!(diff / 40000.0 < 4.0, "{}", diff / 40000.0);
    }
}
