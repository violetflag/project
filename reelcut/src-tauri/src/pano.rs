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
    let threads = crate::hw::threads().max(1) as usize;
    let per = rows.div_ceil(threads).max(1);
    std::thread::scope(|sc| {
        for (k, chunk) in buf[..rows * row_len].chunks_mut(per * row_len).enumerate() {
            let f = &f;
            sc.spawn(move || f(k * per, chunk));
        }
    });
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
}

impl Geo {
    pub fn new(s: &Stitch, n: f64) -> Geo {
        Geo { fov: s.fov.clamp(181.0, 260.0), back: matrix(ypr(180.0 + s.yaw, s.pitch, s.roll)), n }
    }
    /// Pixel of a front-frame direction in lens 0 (back) or 1 (front), v360's fisheye mapping;
    /// and whether it is inside that lens's field of view.
    #[inline]
    pub fn px(&self, lens: usize, d: [f64; 3]) -> (f64, f64, bool) {
        let v = if lens == 0 { mv(&mt(&self.back), d) } else { d };
        self.px_local(v)
    }
    #[inline]
    fn px_local(&self, v: [f64; 3]) -> (f64, f64, bool) {
        let h = v[0].hypot(v[1]);
        let ang = h.atan2(v[2]);
        let lh = if h > 1e-12 { h } else { 1.0 };
        let k = ang / std::f64::consts::PI / (self.fov / 360.0);
        let (u, w) = (v[0] / lh * k, v[1] / lh * k);
        let n1 = self.n - 1.0;
        ((0.5 * u + 0.5) * n1, (0.5 * w + 0.5) * n1, ang.to_degrees() <= self.fov / 2.0 + 1e-9)
    }
}

// ------------------------------------------------------------------ the seam strip

/// Settings of the band: half-width of the cross-fade band (degrees), margin rows each side
/// for the flow search (as a share of the band).
const BAND_SHARE: f64 = 0.7;
const MARGIN: f64 = 0.5;

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
}

impl Strip {
    fn rows(&self) -> usize {
        self.nr + 2 * self.mr
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
        let mut s = Strip { nc, nr, mr, b, lut: Default::default() };
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

fn downscale(src: &[f32], w: usize, h: usize, q: usize) -> Vec<f32> {
    let (lw, lh) = (w / q, h / q);
    let mut out = vec![0f32; lw * lh];
    let k = 1.0 / (q * q) as f32;
    for y in 0..lh {
        for x in 0..lw {
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
    let mut fx = vec![0f32; nb];
    let mut fy = vec![0f32; nb];
    let mut wt = vec![0f32; nb];
    let w = lo.w as isize;
    let at = |img: &[f32], x: isize, y: usize| img[y * lo.w + x.rem_euclid(w) as usize];
    let okat = |x: isize, y: usize| lo.ok[y * lo.w + x.rem_euclid(w) as usize];
    for k in 0..nb {
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
            continue;
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
            continue;
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
        fx[k] = bx as f32 + sx;
        fy[k] = by as f32 + sy;
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
        wt[k] = wk;
    }
    (fx, fy, wt)
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
    pub hfov: Option<f64>,
    pub omega: Option<[f64; 3]>,
}

/// Rolling shutter: time from the first to the last sensor row, seconds, and whether rows are
/// read from the top (true) or the bottom.
#[derive(Clone, Copy, Debug)]
pub struct Rs {
    pub readout: f64,
    pub top_first: bool,
}

pub struct Stitcher {
    pub geo: Geo,
    strip: Strip,
    pub flow: bool,
    gains: [[f64; 3]; 2],
    state: SeamState,
    pub out_w: usize,
    pub out_h: usize,
    step: usize,
    rs: Option<Rs>,
    mesh_key: Option<(M3, Option<f64>, Option<[f64; 3]>)>,
    mesh: Vec<[f32; 6]>,
    gw: usize,
    gh: usize,
}

impl Stitcher {
    pub fn new(s: &Stitch, n: f64, out_w: usize, out_h: usize, flow: bool, rs: Option<Rs>) -> Stitcher {
        let geo = Geo::new(s, n);
        // The strip at the sphere's resolution: an equirect output sets it directly; a flat view
        // at its own pixels per degree, but never more than the lenses have.
        let lens_w = (n * 360.0 / geo.fov) as usize;
        let strip = Strip::new(&geo, out_w.clamp(256, lens_w.max(256)));
        let nc = strip.nc;
        let step = if out_w * out_h > 4_000_000 { 8 } else { 4 };
        Stitcher { geo, strip, flow, gains: [s.gain_a, s.gain_b], state: SeamState::new(nc), out_w, out_h, step, rs, mesh_key: None, mesh: vec![], gw: 0, gh: 0 }
    }

    /// The lenses' strips (luma and chroma, gains applied) from a side-by-side frame.
    fn strips<T: Px>(&self, src: &Frame<T>) -> [[Vec<f32>; 3]; 2] {
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
                        let (x, y, _) = lut[r0 * w + i];
                        *o = g.apply(pl, bil(plane, fw, lens * ln, ln, fh, x, y));
                    }
                });
                out[lens][pl] = v;
            }
        }
        out
    }

    /// Measures the flow, seam line and colour match for this frame (updates `state`).
    fn update_seam<T: Px>(&mut self, s: &[[Vec<f32>; 3]; 2]) {
        let st = &self.strip;
        let rows = st.rows();
        let q = ((st.nr as f32 / 24.0).round() as usize).max(2);
        let q = q + q % 2;
        let k8 = 255.0 / T::MAX;
        let to8 = |v: Vec<f32>| v.into_iter().map(|x| x * k8).collect::<Vec<f32>>();
        let (lw, lh) = (st.nc / q, rows / q);
        let ok_full: Vec<bool> = (0..st.nc * rows).map(|i| st.lut[0][0][i].2 && st.lut[0][1][i].2).collect();
        let mut ok = vec![true; lw * lh];
        for y in 0..lh {
            for x in 0..lw {
                ok[y * lw + x] = (0..q).all(|yy| (0..q).all(|xx| ok_full[(y * q + yy) * st.nc + x * q + xx]));
            }
        }
        let cq = q / 2;
        let lo = Low {
            w: lw,
            h: lh,
            a: to8(downscale(&s[0][0], st.nc, rows, q)),
            b: to8(downscale(&s[1][0], st.nc, rows, q)),
            ok,
            ua: to8(downscale(&s[0][1], st.nc / 2, rows / 2, cq)),
            ub: to8(downscale(&s[1][1], st.nc / 2, rows / 2, cq)),
            va: to8(downscale(&s[0][2], st.nc / 2, rows / 2, cq)),
            vb: to8(downscale(&s[1][2], st.nc / 2, rows / 2, cq)),
        };
        let (nrl, mrl) = (st.nr / q, st.mr / q);
        let started = self.state.started;
        // Flow, smoothed along the seam and over time.
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
        // To full-resolution columns, then over time (DJI: EMA flow filter).
        let full_fx = expand_circ(&lfx, st.nc).into_iter().map(|v| v * q as f32).collect::<Vec<_>>();
        let full_fy = expand_circ(&lfy, st.nc).into_iter().map(|v| v * q as f32).collect::<Vec<_>>();
        let full_ts = expand_circ(&ts_low, st.nc);
        let (af, at, ac) = if started { (0.45f32, 0.5f32, 0.25f32) } else { (1.0, 1.0, 1.0) };
        let mix = |old: &mut Vec<f32>, new: &[f32], a: f32| {
            for (o, n) in old.iter_mut().zip(new) {
                *o += (n - *o) * a;
            }
        };
        let s = &mut self.state;
        mix(&mut s.fx, &full_fx, af);
        mix(&mut s.fy, &full_fy, af);
        mix(&mut s.ts, &full_ts, at);
        mix(&mut s.gy, &gy, ac);
        mix(&mut s.du, &du, ac);
        mix(&mut s.dv, &dv, ac);
        s.started = true;
    }

    /// The cross-faded band (core rows only) for each plane.
    fn blend_band<T: Px>(&self, s: &[[Vec<f32>; 3]; 2]) -> [Vec<f32>; 3] {
        let st = &self.strip;
        let k = T::MAX / 255.0;
        let mut out: [Vec<f32>; 3] = Default::default();
        for pl in 0..3 {
            let ci = if pl == 0 { 0 } else { 1 };
            let (w, rows, nr, mr) = if ci == 0 { (st.nc, st.rows(), st.nr, st.mr) } else { (st.nc / 2, st.rows() / 2, st.nr / 2, st.mr / 2) };
            let sc = if ci == 0 { 1.0 } else { 0.5 };
            let (a, b) = (&s[0][pl], &s[1][pl]);
            let lut = &st.lut[ci];
            let state = &self.state;
            let mut v = vec![0f32; w * nr];
            par_rows(&mut v, w, nr, |r0, chunk| {
                for (i, o) in chunk.iter_mut().enumerate() {
                    let (r, c) = (r0 + i / w, i % w);
                    let lc = if ci == 0 { c } else { (2 * c).min(st.nc - 1) };
                    let t = (r as f32 + 0.5) / nr as f32;
                    let (fx, fy) = (state.fx[lc] * sc, state.fy[lc] * sc);
                    let y = (mr + r) as f32;
                    let (xa, ya) = (c as f32 - t * fx, y - t * fy);
                    let (xb, yb) = (c as f32 + (1.0 - t) * fx, y + (1.0 - t) * fy);
                    let va = bil_strip(a, w, rows, xa, ya);
                    let vb = bil_strip(b, w, rows, xb, yb);
                    let ok = |lens: usize, x: f32, yy: f32| {
                        let xi = (x.round() as isize).rem_euclid(w as isize) as usize;
                        let yi = (yy.round() as isize).clamp(0, rows as isize - 1) as usize;
                        lut[lens][yi * w + xi].2
                    };
                    let ts = state.ts[lc];
                    let mut wb = ((t - ts) / 0.5 + 0.5).clamp(0.0, 1.0);
                    let (oka, okb) = (ok(0, xa, ya), ok(1, xb, yb));
                    if !oka && okb {
                        wb = 1.0;
                    } else if oka && !okb {
                        wb = 0.0;
                    }
                    let phi = if t < ts { t / ts } else { (1.0 - t) / (1.0 - ts) };
                    let (ca, cb) = match pl {
                        0 => {
                            let g = state.gy[lc].powf(phi);
                            (va * g, vb / g)
                        }
                        1 => (va + state.du[lc] * k * phi, vb - state.du[lc] * k * phi),
                        _ => (va + state.dv[lc] * k * phi, vb - state.dv[lc] * k * phi),
                    };
                    *o = ca + (cb - ca) * wb;
                }
            });
            out[pl] = v;
        }
        out
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
        let tan = fs.hfov.map(|hf| {
            let th = (hf.clamp(20.0, 160.0).to_radians() / 2.0).tan();
            (th, th * h as f64 / w as f64)
        });
        let rot = fs.rot;
        let omega = fs.omega;
        par_rows(&mut mesh, gw, gh, |r0, chunk| {
            for (i, o) in chunk.iter_mut().enumerate() {
                let (gy, gx) = (r0 + i / gw, i % gw);
                let (x, y) = ((gx * step) as f64, (gy * step) as f64);
                let d = match tan {
                    Some((tx, ty)) => {
                        let v = [(2.0 * (x + 0.5) / w as f64 - 1.0) * tx, (2.0 * (y + 0.5) / h as f64 - 1.0) * ty, 1.0];
                        let l = (v[0] * v[0] + v[1] * v[1] + 1.0).sqrt();
                        [v[0] / l, v[1] / l, v[2] / l]
                    }
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

    /// One output frame from one side-by-side input frame.
    pub fn frame<T: Px>(&mut self, src: &Frame<T>, fs: &FrameSetup) -> Frame<T> {
        let strips = self.strips(src);
        self.update_seam::<T>(&strips);
        let band = self.blend_band::<T>(&strips);
        self.build_mesh(fs);
        let mut out = Frame::<T>::new(self.out_w, self.out_h);
        let st = &self.strip;
        let n = self.geo.n as usize;
        let ga = [Gain::of::<T>(&self.gains[0]), Gain::of::<T>(&self.gains[1])];
        let (mesh, gw, gh, step) = (&self.mesh, self.gw, self.gh, self.step as f32);
        let b = st.b as f32;
        let ncf = st.nc as f32;
        for pl in 0..3 {
            let (ow, oh) = out.dims(pl);
            let ci = if pl == 0 { 0 } else { 1 };
            let (sw, snr) = if ci == 0 { (st.nc, st.nr) } else { (st.nc / 2, st.nr / 2) };
            let ln = if pl == 0 { n } else { n / 2 };
            let (fw, fh) = src.dims(pl);
            let plane = &src.p[pl];
            let bandp = &band[pl];
            par_rows(&mut out.p[pl], ow, oh, |r0, chunk| {
                for (i, o) in chunk.iter_mut().enumerate() {
                    let (y, x) = (r0 + i / ow, i % ow);
                    // Luma pixel position of this sample.
                    let (lx, ly) = if ci == 0 { (x as f32, y as f32) } else { (2.0 * x as f32 + 0.5, 2.0 * y as f32 + 0.5) };
                    let (fx, fy) = (lx / step, ly / step);
                    let (gx0, gy0) = ((fx as usize).min(gw - 2), (fy as usize).min(gh - 2));
                    let (tx, ty) = (fx - gx0 as f32, fy - gy0 as f32);
                    let v00 = &mesh[gy0 * gw + gx0];
                    let v10 = &mesh[gy0 * gw + gx0 + 1];
                    let v01 = &mesh[(gy0 + 1) * gw + gx0];
                    let v11 = &mesh[(gy0 + 1) * gw + gx0 + 1];
                    let lerp = |k: usize| {
                        let a = v00[k] + (v10[k] - v00[k]) * tx;
                        let bb = v01[k] + (v11[k] - v01[k]) * tx;
                        a + (bb - a) * ty
                    };
                    let s = lerp(5);
                    let val = if s <= -b || s >= b {
                        let lens = if s >= b { 1 } else { 0 };
                        let (mut px, mut py) = (lerp(lens * 2), lerp(lens * 2 + 1));
                        if ci == 1 {
                            px = (px + 0.5) * 0.5 - 0.5;
                            py = (py + 0.5) * 0.5 - 0.5;
                        }
                        ga[lens].apply(pl, bil(plane, fw, lens * ln, ln, fh, px, py))
                    } else {
                        // Column, unwrapped round the circle relative to the first corner.
                        let unwrap = |v: f32| {
                            let d = v - v00[4];
                            if d > ncf / 2.0 { v - ncf } else if d < -ncf / 2.0 { v + ncf } else { v }
                        };
                        let a = v00[4] + (unwrap(v10[4]) - v00[4]) * tx;
                        let bb = unwrap(v01[4]) + (unwrap(v11[4]) - unwrap(v01[4])) * tx;
                        let c = a + (bb - a) * ty;
                        let r = (s + b) / (2.0 * b) * st.nr as f32 - 0.5;
                        let (c, r) = if ci == 0 { (c, r) } else { ((c + 0.5) * 0.5 - 0.5, (r + 0.5) * 0.5 - 0.5) };
                        bil_strip(bandp, sw, snr, c, r)
                    };
                    *o = T::put(val);
                }
            });
        }
        out
    }
}

// ------------------------------------------------------------------ running it on a file

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
}

impl Source {
    pub fn n(&self) -> u32 {
        let n = self.scale_to.unwrap_or(self.lens_px).max(16);
        n - n % 2
    }
    fn decode_args(&self, fmt: &str) -> Vec<String> {
        let n = self.n();
        let sc = |l: &str| format!("[{l}]scale={n}:{n}:flags=area[{l}s]");
        let pick = if self.every > 1 { format!("select='not(mod(n\\,{}))',", self.every) } else { String::new() };
        let g = match self.layout.as_str() {
            "dual" => {
                let (ia, ib) = if self.swap { (1, 0) } else { (0, 1) };
                format!("[0:v:{ia}]null[a];[0:v:{ib}]null[b];{};{};[as][bs]hstack,{pick}format={fmt}[o]", sc("a"), sc("b"))
            }
            _ if self.swap => format!("[0:v:0]scale={}:{n}:flags=area,split[l][r];[l]crop=iw/2:ih:0:0[b];[r]crop=iw/2:ih:iw/2:0[a];[a][b]hstack,{pick}format={fmt}[o]", 2 * n),
            _ => format!("[0:v:0]scale={}:{n}:flags=area,{pick}format={fmt}[o]", 2 * n),
        };
        let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error"].iter().map(|x| x.to_string()).collect();
        if self.start > 0.0 {
            a.extend(["-ss".to_string(), format!("{:.3}", self.start)]);
        }
        if self.dur > 0.0 {
            a.extend(["-t".to_string(), format!("{:.3}", self.dur)]);
        }
        a.extend(["-i".to_string(), self.path.clone(), "-filter_complex".into(), g, "-map".into(), "[o]".into()]);
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
    let (iw, ih) = (2 * n, n);
    let in_len = Frame::<T>::byte_len(iw, ih);
    let dec = spawn_tracked(jobs, tag, ffmpeg, &src.decode_args(T::FMT), false)?;
    let dec_err = stderr_text(&dec);
    let mut stdout = dec.lock().stdout.take().ok_or("ffmpeg 출력 없음")?;
    let (tx_in, rx_in) = sync_channel::<Vec<u8>>(2);
    let reader = std::thread::spawn(move || {
        loop {
            let mut buf = vec![0u8; in_len];
            let mut got = 0;
            while got < in_len {
                match stdout.read(&mut buf[got..]) {
                    Ok(0) | Err(_) => break,
                    Ok(k) => got += k,
                }
            }
            if got < in_len || tx_in.send(buf).is_err() {
                break;
            }
        }
    });
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
    for buf in rx_in {
        if jobs.generation(tag) != gen {
            failed = Some(CANCELLED.into());
            break;
        }
        let f = Frame::<T>::from_bytes(iw, ih, &buf);
        drop(buf);
        let fs = setup(k, k as f64 / src.fps.max(1.0));
        let out = st.frame(&f, &fs);
        if let Some((_, _, tx, _)) = &enc {
            if tx.send(out.to_bytes()).is_err() {
                failed = Some("인코더가 멈췄습니다".into());
                break;
            }
        } else if let Some(cb) = call.as_mut() {
            cb(k, &out);
        }
        k += 1;
        on(k);
    }
    if failed.is_some() {
        let _ = dec.lock().kill();
    }
    let _ = reader.join();
    let dstat = dec.lock().wait();
    jobs.remove(tag, &dec);
    let derr = dec_err.join().unwrap_or_default();
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
    if k == 0 {
        let ok = matches!(&dstat, Ok(s) if s.success());
        return Err(format!("360 영상을 읽지 못했습니다{}", if ok { String::new() } else { format!(": {}", derr.lines().next().unwrap_or("")) }));
    }
    Ok(k)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let flat = st2.frame(&f, &FrameSetup { rot, hfov: Some(90.0), omega: None });
        assert_eq!(flat.p[0].len(), 320 * 240);
    }

    #[test]
    fn flow_pulls_a_shifted_lens_into_line() {
        let s = Stitch { fov: 196.0, calibrated: true, ..Default::default() };
        let geo = Geo::new(&s, 480.0);
        let f = render_pair(&geo, 1.2);
        // How much the two warped lenses still disagree inside the band (a double picture).
        let mismatch = |st: &Stitcher| {
            let strips = st.strips(&f);
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
