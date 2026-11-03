//! 360 stabilisation (DJI Studio's `dual_fisheye_video_eis_win.dll` ideas): how the camera
//! turned on every frame, from the gyro the camera wrote into the file or, failing that, from
//! the picture itself; and what the stabilised picture should do with that (keep the horizon
//! level, keep looking one way, or just smooth the shake).
//!
//! The Osmo 360 writes a DJI metadata track (`djmd`, protobuf `dvtm_oqb101.proto`, read out of
//! DJI Studio's VinceEditor.dll): per frame `FrameMetaOfIMU.IMU_attitude_after_fusion`, a list of
//! attitude quaternions spread over the frame, plus the sensor readout time for the rolling
//! shutter. Which way the gyro's axes point relative to the lenses is not written anywhere we can
//! rely on, so it is found by comparing the gyro's turns with the turns seen in the picture.

use crate::ff::{self, Jobs};
use crate::media::{Lens, MediaInfo};
use crate::pano::{self, expmap, mmul, mt, mv, Frame, FrameSetup, Rs, Sink, Source, Stitcher, I3, M3};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

// ------------------------------------------------------------------ settings

/// Stabilisation settings, stored on the asset's lens.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Stab {
    /// off | horizon (level horizon, follow the heading slowly) | lock (level, always look the
    /// same way) | smooth (only take the shake out)
    #[serde(default = "horizon")]
    pub mode: String,
    /// How slowly the picture follows the camera's turns, seconds.
    #[serde(default = "one")]
    pub strength: f64,
    /// Rolling-shutter correction (needs the readout time from the gyro data).
    #[serde(default = "yes")]
    pub rs: bool,
}
fn horizon() -> String {
    "horizon".into()
}
fn one() -> f64 {
    1.0
}
fn yes() -> bool {
    true
}
impl Default for Stab {
    fn default() -> Self {
        Stab { mode: horizon(), strength: 1.0, rs: true }
    }
}

pub fn stab_of(lens: &Lens) -> Stab {
    lens.stab.clone().unwrap_or_default()
}

/// How the camera turned: per source frame, the camera's orientation (camera → world).
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Motion {
    /// gyro | video | none
    pub source: String,
    pub fps: f64,
    /// Row-major 3×3 per frame.
    pub rot: Vec<[f64; 9]>,
    /// Sensor readout (first to last row), seconds; 0 = unknown.
    pub readout: f64,
    pub top_first: bool,
    /// The world's "down" in world coordinates.
    pub down: [f64; 3],
    pub product: String,
    /// What was found, for the inspector.
    pub note: String,
}

fn to9(m: &M3) -> [f64; 9] {
    [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]]
}
fn from9(a: &[f64; 9]) -> M3 {
    [[a[0], a[1], a[2]], [a[3], a[4], a[5]], [a[6], a[7], a[8]]]
}

impl Motion {
    pub fn at(&self, k: usize) -> M3 {
        if self.rot.is_empty() {
            return I3;
        }
        from9(&self.rot[k.min(self.rot.len() - 1)])
    }
}

// ------------------------------------------------------------------ rotation helpers

type Qt = [f64; 4];

fn quat_of(m: &M3) -> Qt {
    let tr = m[0][0] + m[1][1] + m[2][2];
    let q = if tr > 0.0 {
        let s = (tr + 1.0).sqrt() * 2.0;
        [0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s]
    } else if m[0][0] > m[1][1] && m[0][0] > m[2][2] {
        let s = (1.0 + m[0][0] - m[1][1] - m[2][2]).sqrt() * 2.0;
        [(m[2][1] - m[1][2]) / s, 0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s]
    } else if m[1][1] > m[2][2] {
        let s = (1.0 + m[1][1] - m[0][0] - m[2][2]).sqrt() * 2.0;
        [(m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s]
    } else {
        let s = (1.0 + m[2][2] - m[0][0] - m[1][1]).sqrt() * 2.0;
        [(m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s]
    };
    norm4(q)
}

fn norm4(q: Qt) -> Qt {
    let l = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt().max(1e-12);
    [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}

fn mat_of(q: Qt) -> M3 {
    crate::stitch::matrix(norm4(q))
}

/// Axis × angle of a rotation.
fn logmap(m: &M3) -> [f64; 3] {
    let q = quat_of(m);
    let q = if q[0] < 0.0 { [-q[0], -q[1], -q[2], -q[3]] } else { q };
    let s = (q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if s < 1e-12 {
        return [0.0; 3];
    }
    let ang = 2.0 * s.atan2(q[0]);
    [q[1] / s * ang, q[2] / s * ang, q[3] / s * ang]
}

fn angle_between(a: &M3, b: &M3) -> f64 {
    let w = logmap(&mmul(&mt(a), b));
    (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt()
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn unit(a: [f64; 3]) -> [f64; 3] {
    let l = dot(a, a).sqrt().max(1e-12);
    [a[0] / l, a[1] / l, a[2] / l]
}

/// The 24 rotations that map axes onto axes.
fn axis_rotations() -> Vec<M3> {
    let mut out = Vec::new();
    let perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for p in perms {
        for sx in [-1.0, 1.0] {
            for sy in [-1.0, 1.0] {
                for sz in [-1.0, 1.0] {
                    let mut m = [[0.0; 3]; 3];
                    m[0][p[0]] = sx;
                    m[1][p[1]] = sy;
                    m[2][p[2]] = sz;
                    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
                    if det > 0.0 {
                        out.push(m);
                    }
                }
            }
        }
    }
    out
}

/// Largest-eigenvalue eigenvector of a symmetric 4×4 (Jacobi).
fn eig4_max(mut a: [[f64; 4]; 4]) -> Qt {
    let mut v = [[0.0; 4]; 4];
    for (i, row) in v.iter_mut().enumerate() {
        row[i] = 1.0;
    }
    for _ in 0..60 {
        let mut off = 0.0;
        for i in 0..4 {
            for j in i + 1..4 {
                off += a[i][j] * a[i][j];
            }
        }
        if off < 1e-22 {
            break;
        }
        for p in 0..4 {
            for q in p + 1..4 {
                if a[p][q].abs() < 1e-30 {
                    continue;
                }
                let th = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
                let t = th.signum() / (th.abs() + (th * th + 1.0).sqrt());
                let t = if th == 0.0 { 1.0 } else { t };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..4 {
                    let (akp, akq) = (a[k][p], a[k][q]);
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for k in 0..4 {
                    let (apk, aqk) = (a[p][k], a[q][k]);
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
                for k in 0..4 {
                    let (vkp, vkq) = (v[k][p], v[k][q]);
                    v[k][p] = c * vkp - s * vkq;
                    v[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }
    let i = (0..4).max_by(|x, y| a[*x][*x].total_cmp(&a[*y][*y])).unwrap();
    norm4([v[0][i], v[1][i], v[2][i], v[3][i]])
}

/// The rotation R that best takes each `p` to its `q` (weighted; Horn's quaternion method).
fn fit_rotation(p: &[[f64; 3]], q: &[[f64; 3]], w: &[f64]) -> M3 {
    let mut s = [[0.0; 3]; 3];
    for k in 0..p.len() {
        for a in 0..3 {
            for b in 0..3 {
                s[a][b] += w[k] * p[k][a] * q[k][b];
            }
        }
    }
    let (sxx, sxy, sxz, syx, syy, syz, szx, szy, szz) = (s[0][0], s[0][1], s[0][2], s[1][0], s[1][1], s[1][2], s[2][0], s[2][1], s[2][2]);
    let n = [
        [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
        [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
        [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
        [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
    ];
    mat_of(eig4_max(n))
}

// ------------------------------------------------------------------ rotation from the picture

/// Equirect luma (8-bit) of `w`×`h`, bilinear at a direction.
fn eq_sample(img: &[u8], w: usize, h: usize, d: [f64; 3]) -> f32 {
    let lon = d[0].atan2(d[2]);
    let lat = d[1].clamp(-1.0, 1.0).asin();
    let x = (lon / std::f64::consts::PI + 1.0) * 0.5 * w as f64 - 0.5;
    let y = ((lat / std::f64::consts::FRAC_PI_2 + 1.0) * 0.5 * h as f64 - 0.5).clamp(0.0, h as f64 - 1.001);
    let x = x.rem_euclid(w as f64);
    let (ix, iy) = (x as usize % w, y as usize);
    let (ix1, iy1) = ((ix + 1) % w, (iy + 1).min(h - 1));
    let (fx, fy) = ((x - x.floor()) as f32, (y - iy as f64) as f32);
    let p = |xx: usize, yy: usize| img[yy * w + xx] as f32;
    let a = p(ix, iy) + (p(ix1, iy) - p(ix, iy)) * fx;
    let b = p(ix, iy1) + (p(ix1, iy1) - p(ix, iy1)) * fx;
    a + (b - a) * fy
}

/// Turn between consecutive stitched frames, from the picture: blocks round the sphere are
/// matched in their own tangent planes, then the rotation is fitted ignoring what moved by itself.
pub struct VisualTracker {
    w: usize,
    h: usize,
    pts: Vec<([f64; 3], [f64; 3], [f64; 3])>,
    prev: Option<Vec<u8>>,
    last: M3,
}

const PATCH: isize = 5;
const SEARCH: isize = 5;

impl VisualTracker {
    pub fn new(w: usize, h: usize) -> Self {
        let n = 700;
        let golden = std::f64::consts::PI * (3.0 - 5f64.sqrt());
        let mut pts = Vec::new();
        for i in 0..n {
            let y = 1.0 - 2.0 * (i as f64 + 0.5) / n as f64;
            let r = (1.0 - y * y).sqrt();
            let th = golden * i as f64;
            let p = [r * th.cos(), y, r * th.sin()];
            if p[1].abs() > 0.9 {
                continue;
            }
            let e1 = unit(cross([0.0, 1.0, 0.0], p));
            let e2 = cross(p, e1);
            pts.push((p, e1, e2));
        }
        VisualTracker { w, h, pts, prev: None, last: I3 }
    }

    /// The rotation R with (direction in this frame) = R · (direction in the previous frame);
    /// I for the first frame.
    pub fn push(&mut self, luma: &[u8]) -> M3 {
        let Some(prev) = self.prev.take() else {
            self.prev = Some(luma.to_vec());
            return I3;
        };
        let pitch = 2.0 * std::f64::consts::PI / self.w as f64;
        // Two passes: coarse (wide steps) around last frame's turn, then fine around that.
        let mut guess = self.last;
        for (scale, search) in [(3.0, SEARCH), (1.0, 2)] {
            let step = pitch * scale;
            let (w, h, prev_ref) = (self.w, self.h, &prev[..]);
            let one = |(p, e1, e2): &([f64; 3], [f64; 3], [f64; 3])| -> Option<([f64; 3], [f64; 3], f64)> {
                let mut a = Vec::with_capacity(((2 * PATCH + 1) * (2 * PATCH + 1)) as usize);
                for j in -PATCH..=PATCH {
                    for i in -PATCH..=PATCH {
                        let d = unit([p[0] + (i as f64 * e1[0] + j as f64 * e2[0]) * step, p[1] + (i as f64 * e1[1] + j as f64 * e2[1]) * step, p[2] + (i as f64 * e1[2] + j as f64 * e2[2]) * step]);
                        a.push(eq_sample(prev_ref, w, h, d));
                    }
                }
                let ma = a.iter().sum::<f32>() / a.len() as f32;
                let var = a.iter().map(|v| (v - ma) * (v - ma)).sum::<f32>() / a.len() as f32;
                if var < 20.0 {
                    return None;
                }
                let pp = mv(&guess, *p);
                let f1 = mv(&guess, *e1);
                let f2 = mv(&guess, *e2);
                let span = PATCH + search;
                let side = (2 * span + 1) as usize;
                let mut b = vec![0f32; side * side];
                for j in -span..=span {
                    for i in -span..=span {
                        let d = unit([pp[0] + (i as f64 * f1[0] + j as f64 * f2[0]) * step, pp[1] + (i as f64 * f1[1] + j as f64 * f2[1]) * step, pp[2] + (i as f64 * f1[2] + j as f64 * f2[2]) * step]);
                        b[((j + span) as usize) * side + (i + span) as usize] = eq_sample(luma, w, h, d);
                    }
                }
                let mut costs = vec![f32::INFINITY; ((2 * search + 1) * (2 * search + 1)) as usize];
                let mut best = (f32::INFINITY, 0isize, 0isize);
                for dy in -search..=search {
                    for dx in -search..=search {
                        let mut mb = 0f32;
                        for j in -PATCH..=PATCH {
                            for i in -PATCH..=PATCH {
                                mb += b[((j + dy + span) as usize) * side + (i + dx + span) as usize];
                            }
                        }
                        mb /= a.len() as f32;
                        let mut c = 0f32;
                        let mut k = 0;
                        for j in -PATCH..=PATCH {
                            for i in -PATCH..=PATCH {
                                c += ((a[k] - ma) - (b[((j + dy + span) as usize) * side + (i + dx + span) as usize] - mb)).abs();
                                k += 1;
                            }
                        }
                        c /= a.len() as f32;
                        costs[((dy + search) * (2 * search + 1) + dx + search) as usize] = c;
                        if c < best.0 {
                            best = (c, dx, dy);
                        }
                    }
                }
                let (c0, bx, by) = best;
                if bx.abs() == search || by.abs() == search {
                    return None;
                }
                let cst = |dx: isize, dy: isize| costs[((dy + search) * (2 * search + 1) + dx + search) as usize];
                let sub = |m: f32, p: f32| {
                    let den = m - 2.0 * c0 + p;
                    if den > 1e-6 { (0.5 * (m - p) / den).clamp(-0.5, 0.5) } else { 0.0 }
                };
                let sx = bx as f64 + sub(cst(bx - 1, by), cst(bx + 1, by)) as f64;
                let sy = by as f64 + sub(cst(bx, by - 1), cst(bx, by + 1)) as f64;
                let q = unit([pp[0] + (sx * f1[0] + sy * f2[0]) * step, pp[1] + (sx * f1[1] + sy * f2[1]) * step, pp[2] + (sx * f1[2] + sy * f2[2]) * step]);
                Some((*p, q, (var / (var + 100.0)) as f64))
            };
            let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 32);
            let chunk = self.pts.len().div_ceil(threads);
            let found: Vec<([f64; 3], [f64; 3], f64)> = std::thread::scope(|sc| {
                let hs: Vec<_> = self.pts.chunks(chunk.max(1)).map(|c| sc.spawn(move || c.iter().filter_map(one).collect::<Vec<_>>())).collect();
                hs.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
            });
            let ps: Vec<[f64; 3]> = found.iter().map(|x| x.0).collect();
            let qs: Vec<[f64; 3]> = found.iter().map(|x| x.1).collect();
            let ws: Vec<f64> = found.iter().map(|x| x.2).collect();
            if ps.len() < 12 {
                break;
            }
            // Fit, then down-weight points that disagree (things that move by themselves,
            // nearby things that shift with the camera's travel).
            let mut r = fit_rotation(&ps, &qs, &ws);
            for _ in 0..4 {
                let thr = (step * 0.6).max(0.3f64.to_radians());
                let w2: Vec<f64> = ps
                    .iter()
                    .zip(&qs)
                    .zip(&ws)
                    .map(|((p, q), w)| {
                        let e = dot(mv(&r, *p), *q).clamp(-1.0, 1.0).acos();
                        if e <= thr { *w } else { *w * thr / e * if e > 4.0 * thr { 0.0 } else { 1.0 } }
                    })
                    .collect();
                r = fit_rotation(&ps, &qs, &w2);
            }
            guess = r;
        }
        self.prev = Some(luma.to_vec());
        self.last = guess;
        guess
    }
}

/// Orientation track (camera → world, world = first frame) from per-frame turns.
fn integrate(turns: &[M3]) -> Vec<M3> {
    let mut out = Vec::with_capacity(turns.len());
    let mut v = I3;
    for (k, d) in turns.iter().enumerate() {
        if k > 0 {
            // direction_now = d · direction_before  ⇒  V_now = V_before · dᵀ
            v = mmul(&v, &mt(d));
        }
        out.push(v);
    }
    out
}

// ------------------------------------------------------------------ the DJI gyro track

/// Minimal protobuf reading (wire format only).
struct Pb<'a> {
    b: &'a [u8],
    i: usize,
}

enum Field<'a> {
    Varint(u64),
    Fixed32(u32),
    Fixed64(#[allow(dead_code)] u64),
    Bytes(&'a [u8]),
}

impl<'a> Pb<'a> {
    fn new(b: &'a [u8]) -> Self {
        Pb { b, i: 0 }
    }
    fn varint(&mut self) -> Option<u64> {
        let mut r = 0u64;
        let mut s = 0;
        loop {
            let c = *self.b.get(self.i)?;
            self.i += 1;
            r |= ((c & 0x7f) as u64) << s;
            if c < 0x80 {
                return Some(r);
            }
            s += 7;
            if s > 63 {
                return None;
            }
        }
    }
    fn next(&mut self) -> Option<(u32, Field<'a>)> {
        if self.i >= self.b.len() {
            return None;
        }
        let tag = self.varint()?;
        let (num, wt) = ((tag >> 3) as u32, tag & 7);
        let f = match wt {
            0 => Field::Varint(self.varint()?),
            1 => {
                let v = u64::from_le_bytes(self.b.get(self.i..self.i + 8)?.try_into().ok()?);
                self.i += 8;
                Field::Fixed64(v)
            }
            2 => {
                let l = self.varint()? as usize;
                let v = self.b.get(self.i..self.i + l)?;
                self.i += l;
                Field::Bytes(v)
            }
            5 => {
                let v = u32::from_le_bytes(self.b.get(self.i..self.i + 4)?.try_into().ok()?);
                self.i += 4;
                Field::Fixed32(v)
            }
            _ => return None,
        };
        Some((num, f))
    }
}

/// The message at field path `path` (first occurrence at each level).
fn sub<'a>(b: &'a [u8], path: &[u32]) -> Option<&'a [u8]> {
    let mut cur = b;
    for n in path {
        let mut p = Pb::new(cur);
        let mut found = None;
        while let Some((num, f)) = p.next() {
            if num == *n {
                if let Field::Bytes(v) = f {
                    found = Some(v);
                    break;
                }
            }
        }
        cur = found?;
    }
    Some(cur)
}

fn all<'a>(b: &'a [u8], num: u32) -> Vec<Field<'a>> {
    let mut p = Pb::new(b);
    let mut out = Vec::new();
    while let Some((n, f)) = p.next() {
        if n == num {
            out.push(f);
        }
    }
    out
}

fn first_varint(b: &[u8], num: u32) -> Option<u64> {
    all(b, num).into_iter().find_map(|f| if let Field::Varint(v) = f { Some(v) } else { None })
}
fn first_f32(b: &[u8], num: u32) -> Option<f32> {
    all(b, num).into_iter().find_map(|f| if let Field::Fixed32(v) = f { Some(f32::from_bits(v)) } else { None })
}
fn quat(b: &[u8]) -> Option<Qt> {
    let q = [first_f32(b, 1)?, first_f32(b, 2).unwrap_or(0.0), first_f32(b, 3).unwrap_or(0.0), first_f32(b, 4).unwrap_or(0.0)];
    let l = q.iter().map(|v| (*v as f64).powi(2)).sum::<f64>().sqrt();
    (l > 0.5 && l < 1.5).then(|| norm4(q.map(|v| v as f64)))
}

/// One DJI metadata sample.
#[derive(Default, Debug)]
struct Meta {
    pts: f64,
    quats: Vec<Qt>,
    offset: f64,
    readout_ns: Option<u64>,
    read_dir: Option<u64>,
    product: Option<String>,
}

fn parse_meta(b: &[u8], pts: f64) -> Meta {
    let mut m = Meta { pts, ..Default::default() };
    // ProductMeta { clip_meta = 1, stream_meta = 2, frame_meta = 3 }
    if let Some(clip) = sub(b, &[1]) {
        m.readout_ns = sub(clip, &[4]).and_then(|x| first_varint(x, 1));
        m.read_dir = sub(clip, &[5]).and_then(|x| first_varint(x, 1));
        m.product = sub(clip, &[1]).and_then(|h| {
            all(h, 10).into_iter().find_map(|f| if let Field::Bytes(s) = f { String::from_utf8(s.to_vec()).ok() } else { None })
        });
    }
    // FrameMeta.imu_frame_meta(3).IMU_attitude_after_fusion(2).current_frame(1)
    if let Some(att) = sub(b, &[3, 3, 2, 1]) {
        m.quats = all(att, 3).into_iter().filter_map(|f| if let Field::Bytes(q) = f { quat(q) } else { None }).collect();
        m.offset = first_f32(att, 4).unwrap_or(0.0) as f64;
    }
    m
}

/// Reads the djmd track: per frame, the attitude at the middle of the frame (IMU frame → IMU world).
fn read_gyro(ffprobe: &Path, info: &MediaInfo) -> Result<(Vec<(f64, Qt)>, f64, Option<bool>, String), String> {
    let a: Vec<String> = ["-v", "error", "-print_format", "json", "-show_streams", &info.path].iter().map(|x| x.to_string()).collect();
    let (_, out, _) = ff::output(ffprobe, &a)?;
    let j: Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let idx = j["streams"]
        .as_array()
        .and_then(|s| s.iter().find(|x| x["codec_tag_string"].as_str() == Some("djmd") || x["tags"]["handler_name"].as_str().map(|h| h.contains("DJI meta")).unwrap_or(false)))
        .and_then(|x| x["index"].as_u64())
        .ok_or("자이로 데이터(djmd)가 없습니다")?;
    let a: Vec<String> = ["-v", "error", "-select_streams", &idx.to_string(), "-show_entries", "packet=pts_time,pos,size", "-of", "csv=p=0", &info.path].iter().map(|x| x.to_string()).collect();
    let (_, out, _) = ff::output(ffprobe, &a)?;
    let mut file = std::fs::File::open(&info.path).map_err(|e| e.to_string())?;
    use std::io::{Read, Seek, SeekFrom};
    let mut samples: Vec<(f64, Qt)> = Vec::new();
    let (mut readout, mut dir, mut product) = (None, None, String::new());
    let fps = info.fps.max(1.0);
    for line in out.lines() {
        let f: Vec<&str> = line.split(',').collect();
        if f.len() < 3 {
            continue;
        }
        let (Ok(pts), Ok(pos), Ok(size)) = (f[0].parse::<f64>(), f[1].parse::<u64>(), f[2].parse::<usize>()) else { continue };
        if size == 0 || size > 4_000_000 {
            continue;
        }
        let mut buf = vec![0u8; size];
        if file.seek(SeekFrom::Start(pos)).is_err() || file.read_exact(&mut buf).is_err() {
            continue;
        }
        let m = parse_meta(&buf, pts);
        readout = readout.or(m.readout_ns);
        dir = dir.or(m.read_dir);
        if let Some(p) = m.product {
            product = p;
        }
        let len = m.quats.len() as f64;
        for (i, q) in m.quats.iter().enumerate() {
            // Spread over the frame interval, sample `offset` at the frame's start (as Gyroflow).
            let t = m.pts + (i as f64 - m.offset) / len.max(1.0) / fps;
            samples.push((t, *q));
        }
    }
    if samples.len() < 10 {
        return Err("자이로 데이터를 읽지 못했습니다".into());
    }
    samples.sort_by(|a, b| a.0.total_cmp(&b.0));
    // Readout in ns (DJI); sanity check against the frame time.
    let ro = readout.map(|ns| ns as f64 / 1e9).filter(|s| *s > 0.0005 && *s < 1.0 / fps).or_else(|| readout.map(|us| us as f64 / 1e6).filter(|s| *s > 0.0005 && *s < 1.0 / fps)).unwrap_or(0.0);
    // TOP_LEFT=0, TOP_RIGHT=1 read from the top; BOTTOM_* from the bottom.
    let top = dir.map(|d| d <= 1 || d == 4 || d == 5);
    Ok((samples, ro, top, product))
}

fn slerp(a: Qt, b: Qt, f: f64) -> Qt {
    let mut d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let b = if d < 0.0 {
        d = -d;
        [-b[0], -b[1], -b[2], -b[3]]
    } else {
        b
    };
    if d > 0.9995 {
        return norm4([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f]);
    }
    let th = d.acos();
    let (sa, sb) = (((1.0 - f) * th).sin() / th.sin(), (f * th).sin() / th.sin());
    norm4([a[0] * sa + b[0] * sb, a[1] * sa + b[1] * sb, a[2] * sa + b[2] * sb, a[3] * sa + b[3] * sb])
}

fn gyro_at(s: &[(f64, Qt)], t: f64) -> M3 {
    let i = s.partition_point(|x| x.0 < t);
    let q = if i == 0 {
        s[0].1
    } else if i >= s.len() {
        s[s.len() - 1].1
    } else {
        let (a, b) = (&s[i - 1], &s[i]);
        let f = if b.0 > a.0 { (t - a.0) / (b.0 - a.0) } else { 0.0 };
        slerp(a.1, b.1, f)
    };
    mat_of(q)
}

/// Which way the gyro's axes sit in the camera, and how far its clock is off, from the turns
/// seen in the picture: the candidate whose turns match best.
fn match_axes(samples: &[(f64, Qt)], vis_turns: &[(f64, M3, f64)]) -> Option<(M3, f64, f64)> {
    let mut best: Option<(M3, f64, f64)> = None;
    let cands = axis_rotations();
    for dt_ms in (-80..=80).step_by(10) {
        let dt = dt_ms as f64 / 1000.0;
        for c in &cands {
            let mut err = 0.0;
            let mut tot = 0.0;
            for (t0, dv, span) in vis_turns {
                let g0 = gyro_at(samples, t0 + dt);
                let g1 = gyro_at(samples, t0 + span + dt);
                // visual: dir_1 = dv · dir_0, i.e. dv = Vᵀ(t1)·V(t0); gyro: C·G1ᵀ·G0·Cᵀ
                let dg = mmul(&mmul(c, &mmul(&mt(&g1), &g0)), &mt(c));
                err += angle_between(dv, &dg);
                tot += logmap(dv).iter().map(|x| x * x).sum::<f64>().sqrt();
            }
            if best.as_ref().map(|b| err < b.1).unwrap_or(true) {
                best = Some((*c, err, dt));
            }
            let _ = tot;
        }
    }
    let total: f64 = vis_turns.iter().map(|(_, dv, _)| logmap(dv).iter().map(|x| x * x).sum::<f64>().sqrt()).sum();
    best.and_then(|(c, err, dt)| (total > 0.15 && err < 0.35 * total).then_some((c, dt, err / total)))
}

// ------------------------------------------------------------------ analysis

/// The stitched low-resolution sphere frames of a recording, one call per frame.
fn small_frames(ffmpeg: &Path, jobs: &Jobs, tag: &str, gen: u64, info: &MediaInfo, lens: &Lens, secs: f64, mut each: impl FnMut(usize, &[u8])) -> Result<f64, String> {
    let src = source_for(info, lens, 0.0, secs, Some(256), true);
    let s = crate::stitch::params(lens);
    let mut st = Stitcher::new(&s, src.n() as f64, 512, 256, false, None);
    let setup = |_k: usize, _t: f64| FrameSetup { rot: I3, hfov: None, omega: None };
    let mut cb = |k: usize, f: &Frame<u8>| each(k, &f.p[0]);
    pano::run::<u8>(ffmpeg, jobs, tag, gen, &src, &mut st, &setup, Sink::Call(&mut cb), |_| {})?;
    Ok(src.fps)
}

/// The source to stitch for this asset: the .lrf when `small` and there is one.
pub fn source_for(info: &MediaInfo, lens: &Lens, start: f64, dur: f64, scale_to: Option<u32>, small: bool) -> Source {
    let layout = if lens.layout.is_empty() || lens.layout == "none" { info.layout360.clone() } else { lens.layout.clone() };
    let fps = if info.fps > 1.0 { info.fps } else { 30.0 };
    match (&info.lrf, layout.as_str(), small) {
        (Some(l), "dual", true) => Source { path: l.clone(), layout: "dfisheye".into(), swap: lens.swap, start, dur, lens_px: scale_to.unwrap_or(1024), scale_to, fps },
        (_, "dual", _) => Source { path: info.path.clone(), layout: "dual".into(), swap: lens.swap, start, dur, lens_px: info.videos.first().map(|v| v.width).unwrap_or(info.width), scale_to, fps },
        _ => Source { path: info.path.clone(), layout: "dfisheye".into(), swap: lens.swap, start, dur, lens_px: info.width / 2, scale_to, fps },
    }
}

/// Works out how the camera turned through the recording: gyro when the file has it (its axes
/// matched against the picture), else the picture alone.
pub fn analyze(ffmpeg: &Path, ffprobe: &Path, jobs: &Jobs, tag: &str, gen: u64, info: &MediaInfo, lens: &Lens, on: impl Fn(f64)) -> Result<Motion, String> {
    let fps = if info.fps > 1.0 { info.fps } else { 30.0 };
    let nframes = (info.duration * fps).round().max(1.0) as usize;
    let gyro = read_gyro(ffprobe, info);
    // Visual turns: every frame when there is no gyro, else the first 20 s to line the gyro up.
    let secs = if gyro.is_ok() { info.duration.min(20.0) } else { 0.0 };
    let mut tracker = VisualTracker::new(512, 256);
    let mut turns: Vec<M3> = Vec::new();
    let total = if secs > 0.0 { (secs * fps) as usize } else { nframes };
    small_frames(ffmpeg, jobs, tag, gen, info, lens, secs, |k, luma| {
        turns.push(tracker.push(luma));
        on((k as f64 / total.max(1) as f64).min(1.0));
    })?;
    let vis = integrate(&turns);
    match gyro {
        Ok((samples, readout, top, product)) => {
            // Pairs 5 frames apart with a clear turn.
            let span = 5usize;
            let mut pairs = Vec::new();
            let mut k = 0;
            while k + span < vis.len() {
                let dv = mmul(&mt(&vis[k + span]), &vis[k]);
                let ang = logmap(&dv).iter().map(|x| x * x).sum::<f64>().sqrt();
                if ang > 1.0f64.to_radians() {
                    pairs.push((k as f64 / fps, dv, span as f64 / fps));
                }
                k += span;
            }
            if let Some((c, dt, rel)) = match_axes(&samples, &pairs) {
                let rot: Vec<[f64; 9]> = (0..nframes)
                    .map(|k| {
                        // Middle row of frame k.
                        let t = k as f64 / fps + readout / 2.0 + dt;
                        to9(&mmul(&gyro_at(&samples, t), &mt(&c)))
                    })
                    .collect();
                // The fused attitude's world is level: down is the world axis nearest the
                // camera's average down.
                let mean = mean_down(&rot);
                let down = snap_axis(mean);
                let note = format!("축 맞춤 오차 {:.0}% · 시간차 {:+.0}ms{}", rel * 100.0, dt * 1000.0, if readout > 0.0 { format!(" · 롤링셔터 {:.1}ms", readout * 1000.0) } else { String::new() });
                return Ok(Motion { source: "gyro".into(), fps, rot, readout, top_first: top.unwrap_or(true), down, product, note });
            }
            if pairs.len() < 3 {
                // Barely any turning in the first 20 s: nothing to line the gyro up with; trust
                // the picture for what there is (stabilisation hardly matters here).
                return visual_motion(ffmpeg, jobs, tag, gen, info, lens, fps, nframes, "카메라가 거의 돌지 않음", &on);
            }
            visual_motion(ffmpeg, jobs, tag, gen, info, lens, fps, nframes, "자이로와 화면이 맞지 않음", &on)
        }
        Err(_) => {
            let rot: Vec<[f64; 9]> = vis.iter().map(to9).collect();
            let down = unit(mean_down(&rot));
            Ok(Motion { source: "video".into(), fps, rot, readout: 0.0, top_first: true, down, product: String::new(), note: "자이로 기록 없음".into() })
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn visual_motion(ffmpeg: &Path, jobs: &Jobs, tag: &str, gen: u64, info: &MediaInfo, lens: &Lens, fps: f64, nframes: usize, why: &str, on: &dyn Fn(f64)) -> Result<Motion, String> {
    let mut tracker = VisualTracker::new(512, 256);
    let mut turns = Vec::new();
    small_frames(ffmpeg, jobs, tag, gen, info, lens, 0.0, |k, luma| {
        turns.push(tracker.push(luma));
        on((k as f64 / nframes.max(1) as f64).min(1.0));
    })?;
    let rot: Vec<[f64; 9]> = integrate(&turns).iter().map(to9).collect();
    let down = unit(mean_down(&rot));
    Ok(Motion { source: "video".into(), fps, rot, readout: 0.0, top_first: true, down, product: String::new(), note: why.to_string() })
}

fn mean_down(rot: &[[f64; 9]]) -> [f64; 3] {
    let mut s = [0.0; 3];
    for r in rot {
        let m = from9(r);
        let d = mv(&m, [0.0, 1.0, 0.0]);
        for i in 0..3 {
            s[i] += d[i];
        }
    }
    if dot(s, s) < 1e-9 { [0.0, 1.0, 0.0] } else { s }
}

fn snap_axis(v: [f64; 3]) -> [f64; 3] {
    let i = (0..3).max_by(|a, b| v[*a].abs().total_cmp(&v[*b].abs())).unwrap();
    let mut o = [0.0; 3];
    o[i] = v[i].signum();
    o
}

// ------------------------------------------------------------------ the stabilised rotation

fn gauss_avg(rot: &[M3], k: usize, sigma_f: f64) -> M3 {
    if sigma_f < 0.5 {
        return rot[k];
    }
    let r = (sigma_f * 3.0).ceil() as isize;
    let q0 = quat_of(&rot[k]);
    let mut acc = [0.0; 4];
    for d in -r..=r {
        let j = (k as isize + d).clamp(0, rot.len() as isize - 1) as usize;
        let g = (-(d * d) as f64 / (2.0 * sigma_f * sigma_f)).exp();
        let mut q = quat_of(&rot[j]);
        if q[0] * q0[0] + q[1] * q0[1] + q[2] * q0[2] + q[3] * q0[3] < 0.0 {
            q = q.map(|x| -x);
        }
        for i in 0..4 {
            acc[i] += g * q[i];
        }
    }
    mat_of(acc)
}

/// Level frame (camera → world) whose forward is the horizontal part of `fwd`.
fn level(down: [f64; 3], fwd: [f64; 3]) -> Option<M3> {
    let h = [fwd[0] - dot(fwd, down) * down[0], fwd[1] - dot(fwd, down) * down[1], fwd[2] - dot(fwd, down) * down[2]];
    if dot(h, h) < 0.04 {
        return None;
    }
    let z = unit(h);
    let y = down;
    let x = cross(y, z);
    Some([[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]])
}

/// Per source frame, the stabilised orientation (virtual camera → world).
pub fn targets(m: &Motion, s: &Stab) -> Vec<M3> {
    let rot: Vec<M3> = m.rot.iter().map(from9).collect();
    if rot.is_empty() || s.mode == "off" {
        return rot;
    }
    let sig = (s.strength.clamp(0.1, 10.0) * m.fps.max(1.0)) / 2.0;
    let down = unit(m.down);
    match s.mode.as_str() {
        "smooth" => (0..rot.len()).map(|k| gauss_avg(&rot, k, sig)).collect(),
        "lock" | "horizon" => {
            // Heading: the camera's forward, flattened and smoothed (or held for "lock").
            let fwd: Vec<[f64; 3]> = rot.iter().map(|r| mv(r, [0.0, 0.0, 1.0])).collect();
            let n = rot.len();
            let rad = (sig * 3.0).ceil() as isize;
            let first: [f64; 3] = {
                let k = ((m.fps * 1.0) as usize).min(n);
                let mut a = [0.0; 3];
                for f in &fwd[..k.max(1)] {
                    for i in 0..3 {
                        a[i] += f[i];
                    }
                }
                a
            };
            let mut last = level(down, first).or_else(|| level(down, mv(&rot[0], [1.0, 0.0, 0.0]))).unwrap_or(I3);
            (0..n)
                .map(|k| {
                    let h = if s.mode == "lock" {
                        first
                    } else {
                        let mut a = [0.0; 3];
                        for d in -rad..=rad {
                            let j = (k as isize + d).clamp(0, n as isize - 1) as usize;
                            let g = (-(d * d) as f64 / (2.0 * sig * sig)).exp();
                            for i in 0..3 {
                                a[i] += g * fwd[j][i];
                            }
                        }
                        a
                    };
                    if let Some(l) = level(down, h) {
                        last = l;
                    }
                    last
                })
                .collect()
        }
        _ => rot,
    }
}

/// Builds the per-frame setup for the stitcher: stabilisation (frame `k0 + k` of the motion
/// track) and the flat view at that moment (`view(t)` → rotation and hfov; None for the sphere).
pub fn setup_fn<'a>(m: Option<&'a Motion>, tg: &'a [M3], k0: usize, s: &Stab, view: &'a dyn Fn(f64) -> (M3, Option<f64>)) -> impl Fn(usize, f64) -> FrameSetup + 'a {
    let stab_on = s.mode != "off" && m.map(|m| !m.rot.is_empty()).unwrap_or(false);
    let rs_on = s.rs && m.map(|m| m.readout > 0.0).unwrap_or(false);
    move |k: usize, t: f64| {
        let (vr, hfov) = view(t);
        let Some(m) = m.filter(|_| stab_on) else {
            return FrameSetup { rot: vr, hfov, omega: None };
        };
        let i = (k0 + k).min(m.rot.len() - 1);
        let q = m.at(i);
        let stab = mmul(&mt(&q), &tg[i.min(tg.len() - 1)]);
        let omega = rs_on.then(|| {
            let a = m.at(i.saturating_sub(1));
            let b = m.at(i + 1);
            let w = logmap(&mmul(&mt(&a), &b));
            let span = ((i + 1).min(m.rot.len() - 1) - i.saturating_sub(1)).max(1) as f64 / m.fps.max(1.0);
            [w[0] / span, w[1] / span, w[2] / span]
        });
        FrameSetup { rot: mmul(&stab, &vr), hfov, omega }
    }
}

pub fn rs_of(m: Option<&Motion>, s: &Stab) -> Option<Rs> {
    let m = m?;
    (s.rs && s.mode != "off" && m.readout > 0.0).then_some(Rs { readout: m.readout, top_first: m.top_first })
}

// ------------------------------------------------------------------ rendering with the engine

/// Whether this lens goes through Reelcut's own 360 engine (both lenses in the file).
pub fn engine_lens(info: &MediaInfo, lens: &Lens) -> bool {
    let layout = if lens.layout.is_empty() || lens.layout == "none" { info.layout360.as_str() } else { lens.layout.as_str() };
    matches!(layout, "dual" | "dfisheye") && crate::stitch::active(&Lens { layout: layout.into(), ..lens.clone() })
}

/// The motion track, from the cache or worked out now (None when stabilisation is off or the
/// analysis fails; the picture is then stitched as filmed).
#[allow(clippy::too_many_arguments)]
pub fn motion_for(dir: &Path, ffmpeg: &Path, ffprobe: &Path, jobs: &Jobs, tag: &str, gen: u64, info: &MediaInfo, lens: &Lens, key: &str, on: impl Fn(f64)) -> Result<Option<Motion>, String> {
    if stab_of(lens).mode == "off" {
        return Ok(None);
    }
    let file = dir.join(format!("{key}-m1.json"));
    if let Ok(t) = std::fs::read_to_string(&file) {
        if let Ok(m) = serde_json::from_str::<Motion>(&t) {
            return Ok(Some(m));
        }
    }
    match analyze(ffmpeg, ffprobe, jobs, tag, gen, info, lens, on) {
        Ok(m) => {
            let _ = std::fs::write(&file, serde_json::to_string(&m).unwrap_or_default());
            Ok(Some(m))
        }
        Err(e) if e == ff::CANCELLED => Err(e),
        Err(_) => Ok(None),
    }
}

/// The stabilised, seam-aligned 2048×1024 sphere of a whole recording (the editing proxy).
#[allow(clippy::too_many_arguments)]
pub fn render_proxy(ffmpeg: &Path, jobs: &Jobs, tag: &str, gen: u64, info: &MediaInfo, lens: &Lens, m: Option<&Motion>, h264: &str, out: &Path, on: impl Fn(f64)) -> Result<(), String> {
    let src = source_for(info, lens, 0.0, 0.0, Some(1024), true);
    let s = crate::stitch::params(lens);
    let stab = stab_of(lens);
    let flow = s.flow;
    let mut st = Stitcher::new(&s, src.n() as f64, 2048, 1024, flow, rs_of(m, &stab));
    let tg = m.map(|m| targets(m, &stab)).unwrap_or_default();
    let view = |_t: f64| (I3, None);
    let setup = setup_fn(m, &tg, 0, &stab, &view);
    let mut args: Vec<String> = vec!["-i".into(), src.path.clone(), "-map".into(), "0:v".into(), "-map".into(), "1:a:0?".into()];
    args.extend(crate::media::proxy_venc(h264, src.fps));
    args.extend(["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-shortest", "-movflags", "+faststart", "-f", "mp4"].iter().map(|x| x.to_string()));
    args.push(out.to_string_lossy().into_owned());
    let total = (info.duration * src.fps).max(1.0);
    pano::run::<u8>(ffmpeg, jobs, tag, gen, &src, &mut st, &setup, Sink::Encode { args }, |k| on(k as f64 / total))?;
    Ok(())
}

/// One timeline clip of a 360 recording rendered flat at w×h through the engine: source
/// seconds `start`..`start+dur` at the source's frame rate, the view following `view_at(t)` where
/// t is in output seconds (source seconds / speed). Sound copied along as PCM.
#[allow(clippy::too_many_arguments)]
pub fn render_flat(ffmpeg: &Path, jobs: &Jobs, tag: &str, gen: u64, info: &MediaInfo, lens: &Lens, m: Option<&Motion>, start: f64, dur: f64, speed: f64, w: u32, h: u32, view_at: &dyn Fn(f64) -> crate::media::View, out: &Path, on: impl Fn(f64)) -> Result<(), String> {
    let src = source_for(info, lens, start, dur, None, false);
    let s = crate::stitch::params(lens);
    let stab = stab_of(lens);
    let mut st = Stitcher::new(&s, src.n() as f64, w as usize, h as usize, s.flow, rs_of(m, &stab));
    let tg = m.map(|m| targets(m, &stab)).unwrap_or_default();
    let fps = src.fps;
    let k0 = (start * fps).round().max(0.0) as usize;
    let speed = speed.clamp(0.0625, 16.0);
    let view = move |t: f64| {
        let v = view_at(t / speed);
        (crate::stitch::matrix(crate::stitch::ypr(v.yaw, v.pitch, v.roll)), Some(v.hfov.clamp(20.0, 160.0)))
    };
    let setup = setup_fn(m, &tg, k0, &stab, &view);
    let mut args: Vec<String> = vec!["-ss".into(), format!("{:.3}", start.max(0.0)), "-t".into(), format!("{dur:.3}"), "-i".into(), info.path.clone(), "-map".into(), "0:v".into(), "-map".into(), "1:a:0?".into()];
    args.extend(["-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-f", "matroska"].iter().map(|x| x.to_string()));
    args.push(out.to_string_lossy().into_owned());
    let total = (dur * fps).max(1.0);
    pano::run::<u8>(ffmpeg, jobs, tag, gen, &src, &mut st, &setup, Sink::Encode { args }, |k| on(k as f64 / total))?;
    Ok(())
}

#[allow(dead_code)]
pub fn rotate_view(rot: M3, w: [f64; 3]) -> M3 {
    mmul(&rot, &expmap(w))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stitch::{matrix, ypr};

    fn sphere_img(rot: &M3, w: usize, h: usize) -> Vec<u8> {
        // A textured sphere seen through `rot` (direction in the picture → world: rotᵀ).
        let mut img = vec![0u8; w * h];
        for y in 0..h {
            for x in 0..w {
                let phi = (2.0 * (x as f64 + 0.5) / w as f64 - 1.0) * std::f64::consts::PI;
                let th = (2.0 * (y as f64 + 0.5) / h as f64 - 1.0) * std::f64::consts::FRAC_PI_2;
                let d = [th.cos() * phi.sin(), th.sin(), th.cos() * phi.cos()];
                let wv = mv(&mt(rot), d);
                let lon = wv[0].atan2(wv[2]);
                let lat = wv[1].asin();
                let v = 128.0 + 50.0 * (lon * 9.0).sin() * (lat * 7.0).cos() + 40.0 * (lon * 17.0 - lat * 13.0).cos() + 25.0 * (lon * 31.0 + lat * 3.0).sin();
                img[y * w + x] = v.clamp(0.0, 255.0) as u8;
            }
        }
        img
    }

    #[test]
    fn horn_fit_recovers_a_rotation() {
        let r = matrix(ypr(12.0, -7.0, 3.0));
        let ps: Vec<[f64; 3]> = (0..50).map(|i| unit([(i as f64 * 0.7).sin(), (i as f64 * 1.3).cos(), (i as f64 * 0.31).sin() + 0.2])).collect();
        let qs: Vec<[f64; 3]> = ps.iter().map(|p| mv(&r, *p)).collect();
        let f = fit_rotation(&ps, &qs, &vec![1.0; 50]);
        assert!(angle_between(&f, &r) < 1e-6);
    }

    #[test]
    fn picture_tracker_finds_the_turn() {
        let (w, h) = (512, 256);
        let r0 = I3;
        let r1 = matrix(ypr(2.0, 1.0, -0.5));
        let mut t = VisualTracker::new(w, h);
        t.push(&sphere_img(&r0, w, h));
        let d = t.push(&sphere_img(&r1, w, h));
        // picture directions: d_pic = rot · world, so between frames d1 = r1 · r0ᵀ · d0
        let want = mmul(&r1, &mt(&r0));
        let err = angle_between(&d, &want).to_degrees();
        assert!(err < 0.15, "error {err}°");
    }

    #[test]
    fn gyro_axes_are_found() {
        // Gyro in its own axes C·, camera turns seen in the picture.
        let c = axis_rotations()[7];
        let samples: Vec<(f64, Qt)> = (0..300).map(|i| {
            let t = i as f64 / 100.0;
            (t, quat_of(&matrix(ypr(40.0 * t.sin(), 10.0 * (2.0 * t).sin(), 5.0 * t))))
        }).collect();
        let cam = |t: f64| mmul(&gyro_at(&samples, t), &mt(&c));
        let pairs: Vec<(f64, M3, f64)> = (0..20).map(|k| {
            let t0 = k as f64 * 0.12;
            (t0, mmul(&mt(&cam(t0 + 0.1)), &cam(t0)), 0.1)
        }).collect();
        let (found, dt, rel) = match_axes(&samples, &pairs).expect("no match");
        assert!(angle_between(&found, &c) < 1e-6 && dt.abs() < 1e-9 && rel < 0.01, "{dt} {rel}");
    }

    #[test]
    fn horizon_mode_levels_the_camera() {
        // A camera that tilts and rolls while turning slowly.
        let fps = 30.0;
        let rot: Vec<[f64; 9]> = (0..300).map(|k| {
            let t = k as f64 / fps;
            to9(&matrix(ypr(20.0 * t, 8.0 * (3.0 * t).sin(), 6.0 * (5.0 * t).cos())))
        }).collect();
        let m = Motion { source: "gyro".into(), fps, rot, down: [0.0, 1.0, 0.0], ..Default::default() };
        let tg = targets(&m, &Stab::default());
        for s in &tg {
            // The virtual camera's down is the world's down.
            let d = mv(s, [0.0, 1.0, 0.0]);
            assert!((d[1] - 1.0).abs() < 1e-9, "{d:?}");
        }
        let lock = targets(&m, &Stab { mode: "lock".into(), ..Default::default() });
        assert!(angle_between(&lock[0], &lock[299]) < 1e-9);
    }

    #[test]
    fn reads_dji_metadata() {
        // A hand-made ProductMeta with clip readout and one frame of two quaternions.
        fn varint(mut v: u64, out: &mut Vec<u8>) {
            loop {
                let b = (v & 0x7f) as u8;
                v >>= 7;
                if v == 0 {
                    out.push(b);
                    break;
                }
                out.push(b | 0x80);
            }
        }
        fn msg(num: u32, body: &[u8]) -> Vec<u8> {
            let mut o = Vec::new();
            varint(((num as u64) << 3) | 2, &mut o);
            varint(body.len() as u64, &mut o);
            o.extend_from_slice(body);
            o
        }
        fn f32f(num: u32, v: f32) -> Vec<u8> {
            let mut o = Vec::new();
            varint(((num as u64) << 3) | 5, &mut o);
            o.extend_from_slice(&v.to_le_bytes());
            o
        }
        let q = |w: f32, x: f32| [f32f(1, w), f32f(2, x), f32f(3, 0.0), f32f(4, 0.0)].concat();
        let att = [msg(3, &q(1.0, 0.0)), msg(3, &q(0.0, 1.0)), f32f(4, 0.5)].concat();
        let frame = msg(3, &msg(3, &msg(2, &msg(1, &att))));
        let mut ro = Vec::new();
        varint(8, &mut ro);
        varint(12_000_000, &mut ro);
        let clip = msg(1, &msg(4, &ro));
        let pm = [clip, frame].concat();
        let m = parse_meta(&pm, 1.0);
        assert_eq!(m.quats.len(), 2);
        assert_eq!(m.readout_ns, Some(12_000_000));
        assert!((m.offset - 0.5).abs() < 1e-9);
        assert!((m.quats[1][1] - 1.0).abs() < 1e-9);
    }

    /// With a real ffmpeg (REELCUT_FX=<dir with SHAKE.OSV> cargo test --release itest_motion --
    /// --nocapture): a shaken dual-fisheye clip; the turns found in the picture match the shake,
    /// and the stabilised flat view moves far less from frame to frame than the raw one.
    #[test]
    fn itest_motion() {
        let Ok(fx) = std::env::var("REELCUT_FX") else { return };
        let fx = std::path::PathBuf::from(fx);
        let bin = |n: &str| std::path::PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join(n);
        let (ffmpeg, ffprobe) = (bin("ffmpeg"), bin("ffprobe"));
        let work = fx.join("work-motion");
        let _ = std::fs::create_dir_all(&work);
        let info = crate::media::inspect(&ffprobe, &fx.join("SHAKE.OSV").to_string_lossy()).unwrap();
        assert_eq!(info.layout360, "dual");
        let mut lens = Lens { layout: "dual".into(), swap: false, fov: 193.0, stitch: None, stab: None };
        lens.stitch = Some(crate::stitch::calibrate(&ffmpeg, &ffprobe, &info, &lens).unwrap());
        let jobs = Jobs::default();
        let t = std::time::Instant::now();
        let m = analyze(&ffmpeg, &ffprobe, &jobs, "t", 0, &info, &lens, |_| {}).unwrap();
        println!("analysis {:.1}s, {} frames, {}", t.elapsed().as_secs_f64(), m.rot.len(), m.note);
        assert_eq!(m.source, "video");
        // Shake as generated (v360 yaw/pitch/roll of the picture).
        let truth: Vec<M3> = (0..m.rot.len()).map(|k| {
            let t = k as f64 / 30.0;
            let pi2 = 2.0 * std::f64::consts::PI;
            matrix(ypr(6.0 * (pi2 * 1.3 * t).sin() + 3.0 * (pi2 * 3.1 * t).sin(), 4.0 * (pi2 * 1.7 * t + 1.0).sin(), 5.0 * (pi2 * 2.3 * t + 2.0).sin()))
        }).collect();
        let mut worst: f64 = 0.0;
        for k in 1..m.rot.len() {
            let a = angle_between(&m.at(0), &m.at(k)).to_degrees();
            let b = angle_between(&truth[0], &truth[k]).to_degrees();
            worst = worst.max((a - b).abs());
        }
        let mut wstep: f64 = 0.0;
        for k in 1..m.rot.len() {
            let a = angle_between(&m.at(k - 1), &m.at(k)).to_degrees();
            let b = angle_between(&truth[k - 1], &truth[k]).to_degrees();
            if (a - b).abs() > 0.3 { println!("frame {k}: found {a:.2}° true {b:.2}° (from 0: {:.2} vs {:.2})", angle_between(&m.at(0), &m.at(k)).to_degrees(), angle_between(&truth[0], &truth[k]).to_degrees()); }
            wstep = wstep.max((a - b).abs());
        }
        println!("turn from frame 0: worst difference {worst:.2}°, per frame {wstep:.2}°");
        assert!(worst < 0.6, "{worst}");
        // Flat views with and without stabilisation; frame-to-frame change.
        let view = |_t: f64| crate::media::View { yaw: 30.0, pitch: 0.0, roll: 0.0, hfov: 90.0 };
        let jitter = |name: &str, l: &Lens, m: Option<&Motion>| {
            let out = work.join(name);
            render_flat(&ffmpeg, &jobs, "t", 0, &info, l, m, 0.5, 3.0, 1.0, 640, 360, &view, &out, |_| {}).unwrap();
            let o = ff::command(&ffmpeg).args(["-v", "error", "-i", &out.to_string_lossy(), "-vf", "format=gray", "-f", "rawvideo", "-"]).output().unwrap();
            let fr: Vec<&[u8]> = o.stdout.chunks(640 * 360).filter(|c| c.len() == 640 * 360).collect();
            let d: f64 = fr.windows(2).map(|w| w[0].iter().zip(w[1]).map(|(a, b)| (*a as f64 - *b as f64).abs()).sum::<f64>() / (640.0 * 360.0)).sum::<f64>() / (fr.len() - 1) as f64;
            (fr.len(), d)
        };
        let raw = Lens { stab: Some(Stab { mode: "off".into(), ..Default::default() }), ..lens.clone() };
        let (n0, j0) = jitter("raw.mkv", &raw, None);
        let st = Lens { stab: Some(Stab { mode: "lock".into(), ..Default::default() }), ..lens.clone() };
        let (n1, j1) = jitter("stab.mkv", &st, Some(&m));
        println!("frames {n0}/{n1}, mean frame change raw {j0:.2}, stabilised {j1:.2}");
        assert!(n0 >= 89 && n1 >= 89);
        assert!(j1 < j0 * 0.5, "{j1} vs {j0}");
        // The proxy through the engine.
        let p = work.join("proxy.mp4");
        render_proxy(&ffmpeg, &jobs, "t", 0, &info, &st, Some(&m), "libx264", &p, |_| {}).unwrap();
        let c = crate::probe::check(&ffprobe, &p.to_string_lossy()).unwrap();
        assert!((c.duration - 4.0).abs() < 0.2, "{}", c.duration);
    }
}
