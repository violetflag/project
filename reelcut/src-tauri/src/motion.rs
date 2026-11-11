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
    /// off | horizon (level only, gently; the camera's movement stays) | tilt (level on every frame,
    /// DJI's TiltRecovery) | smooth (only take the shake out) | eis (level and take the shake out) |
    /// lock (level, always look the same way) | forward (level, looking the way the camera has been
    /// heading, DJI's ForwardView)
    #[serde(default = "horizon")]
    pub mode: String,
    /// With the shake taken out: how slowly the picture follows the camera's turns, seconds.
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

/// The camera's factory calibration from the metadata track's first packet (DJI's `PanoDewarpParams`,
/// whose place in the stream message moved between models): the back and the front lens, and the back
/// lens's yaw, pitch and roll against the front one, as `stitch::Stitch` keeps them.
pub fn factory_lenses(ffprobe: &Path, info: &MediaInfo, swap: bool) -> Option<([crate::stitch::LensCal; 2], [f64; 3])> {
    if !info.djmd {
        return None;
    }
    let a: Vec<String> = ["-v", "error", "-print_format", "json", "-show_streams", &info.path].iter().map(|x| x.to_string()).collect();
    let (_, out, _) = ff::output(ffprobe, &a).ok()?;
    let j: Value = serde_json::from_str(&out).ok()?;
    let idx = j["streams"].as_array()?.iter().find(|x| x["codec_tag_string"].as_str() == Some("djmd"))?["index"].as_u64()?;
    let a: Vec<String> = ["-v", "error", "-select_streams", &idx.to_string(), "-read_intervals", "%+0.2", "-show_entries", "packet=pos,size", "-of", "compact=p=0", &info.path].iter().map(|x| x.to_string()).collect();
    let (_, out, _) = ff::output(ffprobe, &a).ok()?;
    let line = out.lines().next()?;
    let field = |k: &str| line.split('|').find_map(|kv| kv.strip_prefix(k).and_then(|v| v.strip_prefix('=')));
    let (pos, size) = (field("pos")?.parse::<u64>().ok()?, field("size")?.parse::<usize>().ok()?);
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(&info.path).ok()?;
    file.seek(SeekFrom::Start(pos)).ok()?;
    let mut buf = vec![0u8; size];
    file.read_exact(&mut buf).ok()?;
    factory_of_packet(&buf, swap)
}

fn factory_of_packet(b: &[u8], swap: bool) -> Option<([crate::stitch::LensCal; 2], [f64; 3])> {
    use crate::stitch::{euler, LensCal};
    let stream = sub(b, &[2])?;
    let lens = |m: &[u8]| -> Option<LensCal> {
        let f = |n: u32| first_f32(m, n).map(|v| v as f64);
        let (fx, cx, cy) = (f(1).filter(|v| *v > 50.0)?, f(3)?, f(4)?);
        Some(LensCal { fx, fy: f(2).unwrap_or(fx), cx, cy, k: [f(5)?, f(6).unwrap_or(0.0), f(7).unwrap_or(0.0), f(8).unwrap_or(0.0), f(15).unwrap_or(0.0)], size: f(10).filter(|v| *v > 100.0)? })
    };
    // native_refine_slave = 1, native_refine_master = 2.
    let (slave, master) = [6u32, 5].iter().find_map(|n| {
        let d = sub(stream, &[*n])?;
        Some((sub(d, &[1]).filter(|m| lens(m).is_some())?, sub(d, &[2]).filter(|m| lens(m).is_some())?))
    })?;
    // cam_extri_q: the rotation between the lenses (w, x, y, z), written on the slave lens.
    let q = sub(slave, &[28])?;
    let c = |n: u32| first_f32(q, n).unwrap_or(0.0) as f64;
    let (w, x, y, z) = (c(1), c(2), c(3), c(4));
    let len = (w * w + x * x + y * y + z * z).sqrt();
    if len < 0.5 {
        return None;
    }
    // It sits near a half turn about y; as yaw (past 180°), pitch and roll.
    let (yaw, pitch, roll) = euler([w / len, x / len, y / len, z / len]);
    let yaw = (yaw - 180.0 + 540.0).rem_euclid(360.0) - 180.0;
    if yaw.abs() > 6.0 || pitch.abs() > 6.0 || roll.abs() > 6.0 {
        return None;
    }
    let (m, s) = (lens(master)?, lens(slave)?);
    Some((if swap { [s, m] } else { [m, s] }, [yaw, pitch, roll]))
}

/// One DJI metadata sample.
#[derive(Default, Debug)]
struct Meta {
    pts: f64,
    /// The attitude's own clock, microseconds.
    stamp: Option<u64>,
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
        m.stamp = first_varint(att, 1);
    }
    // Osmo 360 originals: one fused attitude per frame, FrameMeta(3).camera(2).attitude(22) =
    // w, x, y, z as floats (gravity follows in 23).
    if m.quats.is_empty() {
        if let Some(q) = sub(b, &[3, 2, 22]).and_then(quat) {
            m.quats = vec![q];
        }
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
    // Keyed output: ffprobe prints packet fields in its own order (pts_time, size, pos), not the asked one.
    let a: Vec<String> = ["-v", "error", "-select_streams", &idx.to_string(), "-show_entries", "packet=pts_time,pos,size", "-of", "compact=p=0", &info.path].iter().map(|x| x.to_string()).collect();
    let (_, out, _) = ff::output(ffprobe, &a)?;
    let mut file = std::fs::File::open(&info.path).map_err(|e| e.to_string())?;
    use std::io::{Read, Seek, SeekFrom};
    let mut samples: Vec<(f64, Qt)> = Vec::new();
    let (mut readout, mut dir, mut product) = (None, None, String::new());
    let fps = info.fps.max(1.0);
    let mut clock = Clock::default();
    for line in out.lines() {
        let field = |k: &str| line.split('|').find_map(|kv| kv.strip_prefix(k).and_then(|v| v.strip_prefix('=')));
        let (Some(Ok(pts)), Some(Ok(pos)), Some(Ok(size))) = (field("pts_time").map(str::parse::<f64>), field("pos").map(str::parse::<u64>), field("size").map(str::parse::<usize>)) else { continue };
        if size == 0 || size > 4_000_000 {
            continue;
        }
        let mut buf = vec![0u8; size];
        if file.seek(SeekFrom::Start(pos)).is_err() || file.read_exact(&mut buf).is_err() {
            continue;
        }
        let m = parse_meta(&buf, pts);
        // Now and then a packet carries an attitude from many seconds earlier: not this frame's.
        if !clock.fits(m.stamp) {
            continue;
        }
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

/// Follows the attitude's clock through the packets. A sample that jumps back or far ahead is not
/// the frame's; if every later one disagrees too, the clock itself has moved and is followed.
#[derive(Default)]
struct Clock {
    last: Option<u64>,
    refused: u32,
}

impl Clock {
    fn fits(&mut self, stamp: Option<u64>) -> bool {
        let Some(s) = stamp else { return true };
        let ok = self.last.is_none_or(|l| s > l && s - l < 1_000_000);
        if ok || self.refused >= 30 {
            self.last = Some(s);
            self.refused = 0;
            true
        } else {
            self.refused += 1;
            false
        }
    }
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
    // The clock's offset to a millisecond, for the axes found.
    let best = best.map(|(c, mut err, dt0)| {
        let mut dt = dt0;
        for ms in -9..=9 {
            let t = dt0 + ms as f64 / 1000.0;
            let e: f64 = vis_turns.iter().map(|(t0, dv, span)| {
                let dg = mmul(&mmul(&c, &mmul(&mt(&gyro_at(samples, t0 + span + t)), &gyro_at(samples, t0 + t))), &mt(&c));
                angle_between(dv, &dg)
            }).sum();
            if e < err {
                err = e;
                dt = t;
            }
        }
        (c, err, dt)
    });
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
        (Some(l), "dual", true) => Source { path: l.clone(), layout: "dfisheye".into(), swap: lens.swap, start, dur, lens_px: scale_to.unwrap_or(1024), scale_to, fps, every: 1, gpu: false, crop: false },
        (_, "dual", _) => Source { path: info.path.clone(), layout: "dual".into(), swap: lens.swap, start, dur, lens_px: info.videos.first().map(|v| v.width).unwrap_or(info.width), scale_to, fps, every: 1, gpu: false, crop: false },
        _ => Source { path: info.path.clone(), layout: "dfisheye".into(), swap: lens.swap, start, dur, lens_px: info.width / 2, scale_to, fps, every: 1, gpu: false, crop: false },
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

/// How gently the horizon correction changes, seconds (sigma of the smoothing). Far slower than a
/// hand or a step, so it cannot put any shake into the picture, whatever the attitude's timing.
const LEVEL_SIGMA: f64 = 0.6;
/// How the forward view follows the camera's heading: smoothed over FORWARD_SIGMA seconds and
/// FORWARD_DELAY seconds behind it. Fitted to DJI Studio's 전진 뷰 export of the same recording
/// (docs/dji-parity.md): its heading is the camera's, gaussian-smoothed with sigma 1 s, half a
/// second late (0.8° rms on the steady stretch).
const FORWARD_SIGMA: f64 = 1.0;
const FORWARD_DELAY: f64 = 0.5;
/// Where DJI's still (RockSteady + 수평) picture looks, degrees from the gyro world's x axis about
/// down: measured −4.8° and −5.2° on two clips of its free-view export.
const DJI_HEADING: f64 = -5.0;

/// The shortest turn that takes `a` to `b` (unit vectors).
fn from_to(a: [f64; 3], b: [f64; 3]) -> M3 {
    let c = dot(a, b);
    if c < -0.9999 {
        let side = if a[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 0.0, 1.0] };
        let v = unit(cross(a, side));
        return mat_of([0.0, v[0], v[1], v[2]]);
    }
    let v = cross(a, b);
    mat_of([1.0 + c, v[0], v[1], v[2]])
}

/// Horizon levelling, per source frame: the gentle turn (in the camera's own axes) that brings the
/// picture's down to the world's down. Measured from the frame's attitude, a few odd samples are
/// dropped by a median, then smoothed the same way forward and backward, so it does not lag behind
/// the picture. What the camera did in between stays as it was filmed, and turning does not change
/// it: a tilted camera that spins keeps the same down in its own axes.
fn level_turns(rot: &[M3], down: [f64; 3], fps: f64, sigma: f64) -> Vec<M3> {
    let n = rot.len();
    let raw: Vec<[f64; 3]> = rot.iter().map(|r| mv(&mt(r), down)).collect();
    // Levelling every frame keeps its speed: only single odd samples go.
    let m = if sigma <= 0.0 { 1 } else { ((fps * 0.1).round() as isize).max(1) };
    let med: Vec<[f64; 3]> = (0..n as isize)
        .map(|k| {
            let mut out = [0.0; 3];
            for (i, o) in out.iter_mut().enumerate() {
                let mut w: Vec<f64> = (-m..=m).map(|d| raw[(k + d).clamp(0, n as isize - 1) as usize][i]).collect();
                w.sort_by(f64::total_cmp);
                *o = w[w.len() / 2];
            }
            out
        })
        .collect();
    if sigma <= 0.0 {
        return med.iter().map(|v| from_to([0.0, 1.0, 0.0], unit(*v))).collect();
    }
    let sig = sigma * fps.max(1.0);
    let rad = (sig * 3.0).ceil() as isize;
    let weights: Vec<f64> = (-rad..=rad).map(|d| (-(d * d) as f64 / (2.0 * sig * sig)).exp()).collect();
    (0..n as isize)
        .map(|k| {
            let mut a = [0.0; 3];
            for (d, g) in (-rad..=rad).zip(&weights) {
                let v = med[(k + d).clamp(0, n as isize - 1) as usize];
                for i in 0..3 {
                    a[i] += g * v[i];
                }
            }
            from_to([0.0, 1.0, 0.0], unit(a))
        })
        .collect()
}

/// Per source frame, the stabilised orientation (virtual camera → world). The one place that decides
/// it: the export and the preview both use it.
pub fn targets(m: &Motion, s: &Stab) -> Vec<M3> {
    let rot: Vec<M3> = m.rot.iter().map(from9).collect();
    if rot.is_empty() || s.mode == "off" {
        return rot;
    }
    let fps = m.fps.max(1.0);
    let sig = (s.strength.clamp(0.1, 10.0) * fps) / 2.0;
    let down = unit(m.down);
    let then = |path: Vec<M3>, sigma: f64| -> Vec<M3> {
        let turns = level_turns(&path, down, fps, sigma);
        path.iter().zip(&turns).map(|(r, t)| mmul(r, t)).collect()
    };
    match s.mode.as_str() {
        // Level only: the camera's own movement is left alone.
        "horizon" => then(rot, LEVEL_SIGMA),
        // The tilt out on every frame; turning stays. Only as steady as the attitude is.
        "tilt" => then(rot, 0.0),
        // The shake out of the attitude, horizon left alone: DJI's RockSteady with 수평 off (its export
        // is 1.7-6.2° from this at strength 1, sigma 0.5 s; docs/dji-parity.md).
        "smooth" => (0..rot.len()).map(|k| gauss_avg(&rot, k, sig)).collect(),
        // Level, heading where the camera has been going over the last seconds: its forward, flattened
        // and smoothed. (DJI also has the GPS when a remote gives one; this camera's files do not.)
        "forward" => {
            let n = rot.len();
            let fwd: Vec<[f64; 3]> = rot.iter().map(|r| mv(r, [0.0, 0.0, 1.0])).collect();
            let sg = FORWARD_SIGMA * fps;
            let late = (FORWARD_DELAY * fps).round() as isize;
            let rad = (sg * 3.0).ceil() as isize;
            let weights: Vec<f64> = (-rad..=rad).map(|d| (-(d * d) as f64 / (2.0 * sg * sg)).exp()).collect();
            let mut last = level(down, fwd[0]).or_else(|| level(down, mv(&rot[0], [1.0, 0.0, 0.0]))).unwrap_or(I3);
            (0..n as isize)
                .map(|k| {
                    let mut a = [0.0; 3];
                    for (d, g) in (-rad..=rad).zip(&weights) {
                        let v = fwd[(k - late + d).clamp(0, n as isize - 1) as usize];
                        for i in 0..3 {
                            a[i] += g * v[i];
                        }
                    }
                    if let Some(l) = level(down, a) {
                        last = l;
                    }
                    last
                })
                .collect()
        }
        // DJI's RockSteady with 수평 on (its 360 export and free view alike) holds the picture still in
        // the world: level, and looking one way however the camera turns. Fitted: 0.2-0.3° from DJI's
        // own export (docs/dji-parity.md). With the camera's gyro, DJI looks one fixed way of the
        // gyro's world (the same in clips two minutes apart), DJI_HEADING from its x axis.
        "eis" if m.source == "gyro" => {
            let x = [1.0, 0.0, 0.0];
            let h = [x[0] - dot(x, down) * down[0], x[1] - dot(x, down) * down[1], x[2] - dot(x, down) * down[2]];
            let l = (dot(h, h) > 0.04).then(|| {
                let (e1, a) = (unit(h), DJI_HEADING.to_radians());
                let e2 = cross(down, e1);
                level(down, [0, 1, 2].map(|i| a.cos() * e1[i] + a.sin() * e2[i]))
            });
            match l.flatten() {
                Some(l) => vec![l; rot.len()],
                None => targets(m, &Stab { mode: "lock".into(), ..s.clone() }),
            }
        }
        // 방향 고정: the same stillness, looking the way the camera looked in the first second.
        "eis" | "lock" => {
            let k = (fps as usize).clamp(1, rot.len());
            let mut first = [0.0; 3];
            for r in &rot[..k] {
                let f = mv(r, [0.0, 0.0, 1.0]);
                for i in 0..3 {
                    first[i] += f[i];
                }
            }
            let l = level(down, first).or_else(|| level(down, mv(&rot[0], [1.0, 0.0, 0.0]))).unwrap_or(I3);
            vec![l; rot.len()]
        }
        _ => rot,
    }
}

/// Builds the per-frame setup for the stitcher: stabilisation (frame `k0 + k` of the motion
/// track) and the flat view at that moment (`view(t)` → rotation and hfov; None for the sphere).
pub fn setup_fn<'a>(m: Option<&'a Motion>, tg: &'a [M3], k0: usize, s: &Stab, view: &'a dyn Fn(f64) -> (M3, Option<(f64, f64)>)) -> impl Fn(usize, f64) -> FrameSetup + 'a {
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

/// The turn the export applies on every frame (camera as filmed → stabilised and level), as
/// quaternions w, x, y, z, so the preview can look the same way. Empty when stabilisation is off.
pub fn stab_track(m: &Motion, s: &Stab) -> Vec<[f32; 4]> {
    if s.mode == "off" || m.rot.is_empty() {
        return Vec::new();
    }
    let tg = targets(m, s);
    (0..m.rot.len())
        .map(|i| {
            let q = quat_of(&mmul(&mt(&m.at(i)), &tg[i.min(tg.len() - 1)]));
            [q[0] as f32, q[1] as f32, q[2] as f32, q[3] as f32]
        })
        .collect()
}

pub fn rs_of(m: Option<&Motion>, s: &Stab) -> Option<Rs> {
    if !RS_VERIFIED {
        return None;
    }
    let m = m?;
    (s.rs && s.mode != "off" && m.readout > 0.0).then_some(Rs { readout: m.readout, top_first: m.top_first })
}

// ------------------------------------------------------------------ rendering with the engine

/// Whether this lens goes through Reelcut's own 360 engine (both lenses in the file).
pub fn engine_lens(info: &MediaInfo, lens: &Lens) -> bool {
    let layout = if lens.layout.is_empty() || lens.layout == "none" { info.layout360.as_str() } else { lens.layout.as_str() };
    matches!(layout, "dual" | "dfisheye") && crate::stitch::active(&Lens { layout: layout.into(), ..lens.clone() })
}

/// A motion track covers the whole recording, and a file with a gyro was analysed with it (versions
/// before 2.6 could not read an Osmo 360's gyro and fell back to the picture).
pub fn usable(m: &Motion, info: &MediaInfo) -> bool {
    let fps = if info.fps > 1.0 { info.fps } else { 30.0 };
    let frames = (info.duration * fps).round();
    (m.rot.len() as f64) >= frames * 0.97 && !(info.djmd && m.source == "video" && m.note == "자이로 기록 없음")
}

/// The kept motion track's file ending; a new one when the analysis changes.
pub const TRACK_FILE: &str = "-m2.json";

/// The motion track, from the cache or worked out now (None when stabilisation is off or the
/// analysis fails; the picture is then stitched as filmed).
#[allow(clippy::too_many_arguments)]
pub fn motion_for(dir: &Path, ffmpeg: &Path, ffprobe: &Path, jobs: &Jobs, tag: &str, gen: u64, info: &MediaInfo, lens: &Lens, key: &str, on: impl Fn(f64)) -> Result<Option<Motion>, String> {
    if stab_of(lens).mode == "off" {
        return Ok(None);
    }
    let file = dir.join(format!("{key}{TRACK_FILE}"));
    if let Ok(t) = std::fs::read_to_string(&file) {
        if let Ok(m) = serde_json::from_str::<Motion>(&t) {
            if usable(&m, info) {
                return Ok(Some(m));
            }
        }
    }
    match analyze(ffmpeg, ffprobe, jobs, tag, gen, info, lens, on) {
        Ok(m) => {
            // An analysis cut short (ffmpeg stopped) is not kept, nor trusted.
            if !usable(&m, info) {
                return Ok(None);
            }
            let _ = std::fs::write(&file, serde_json::to_string(&m).unwrap_or_default());
            Ok(Some(m))
        }
        Err(e) if e == ff::CANCELLED => Err(e),
        Err(_) => Ok(None),
    }
}

/// Bump when the engine's picture changes, so kept clips are made again.
pub const ENGINE_VERSION: u32 = 14;

/// How `render_flat` works: the lens size to decode at, the GPU, and the intermediate's quality.
#[derive(Clone, Debug, Default)]
pub struct FlatOptions {
    pub lens_px: Option<u32>,
    pub gpu: bool,
    pub lossless: bool,
}

/// Rolling-shutter correction stays off until it has been measured on a real shaky recording
/// (right sign and size); until then it would only make the picture differ from the preview.
pub const RS_VERIFIED: bool = false;

/// The lens size a flat view needs: enough for its centre at the narrowest view of the clip, never
/// more than the file has. A small or wide output decodes less.
pub fn lens_px_for(fov: f64, w: u32, hfov_min: f64, dist: f64, lens_px: u32) -> u32 {
    let r_e = crate::proj::r_edge(hfov_min.max(20.0), dist);
    let want = fov.to_radians() * (w as f64 / 2.0) / r_e * 1.1;
    // Close to the file's size, shrinking only softens the picture and costs a scaling pass.
    let want = if want >= lens_px as f64 * 0.85 { lens_px as f64 } else { want };
    let n = want.clamp(1024.0_f64.min(lens_px as f64), lens_px as f64) as u32;
    n + n % 2
}

/// One timeline clip of a 360 recording rendered flat at w×h through the engine: source
/// seconds `start`..`start+dur` at the source's frame rate, the view following `view_at(t)` where
/// t is in output seconds (source seconds / speed). Sound copied along as PCM.
#[allow(clippy::too_many_arguments)]
pub fn render_flat(ffmpeg: &Path, jobs: &Jobs, tag: &str, gen: u64, info: &MediaInfo, lens: &Lens, m: Option<&Motion>, start: f64, dur: f64, speed: f64, w: u32, h: u32, how: &FlatOptions, view_at: &dyn Fn(f64) -> crate::media::View, out: &Path, on: impl Fn(f64)) -> Result<(), String> {
    let mut src = source_for(info, lens, start, dur, how.lens_px, false);
    src.gpu = how.gpu && src.layout == "dual";
    src.crop = true;
    let s = crate::stitch::params(lens);
    let stab = stab_of(lens);
    let mut st = Stitcher::new(&s, src.n() as f64, w as usize, h as usize, s.precise(), rs_of(m, &stab));
    let tg = m.map(|m| targets(m, &stab)).unwrap_or_default();
    let fps = src.fps;
    let k0 = (start * fps).round().max(0.0) as usize;
    let speed = speed.clamp(0.0625, 16.0);
    let view = move |t: f64| {
        let v = view_at(t / speed);
        (crate::stitch::matrix(crate::stitch::ypr(v.yaw, v.pitch, v.roll)), Some((v.hfov.clamp(20.0, crate::proj::fov_max(v.dist)), v.dist)))
    };
    let setup = setup_fn(m, &tg, k0, &stab, &view);
    let mut args: Vec<String> = vec!["-ss".into(), format!("{:.3}", start.max(0.0)), "-t".into(), format!("{dur:.3}"), "-i".into(), info.path.clone(), "-map".into(), "0:v".into(), "-map".into(), "1:a:0?".into()];
    // Only a stepping stone to the final encode: fast, and lossless when there is room for it.
    // Ut Video costs a third of lossless x264 to write and to read, at about the same size (measured
    // on John's recordings: 9 and 8 ms of CPU a frame against 25 and 27).
    let encoder: &[&str] = if how.lossless { &["-c:v", "utvideo", "-pred", "left"] } else { &["-c:v", "libx264", "-preset", "ultrafast", "-crf", "10"] };
    args.extend(encoder.iter().map(|x| x.to_string()));
    args.extend(["-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-f", "matroska"].iter().map(|x| x.to_string()));
    args.push(out.to_string_lossy().into_owned());
    let total = (dur * fps).max(1.0);
    pano::run::<u8>(ffmpeg, jobs, tag, gen, &src, &mut st, &setup, Sink::Encode { args }, |k| on(k as f64 / total))?;
    Ok(())
}

#[allow(dead_code)]
/// Single pictures of a recording through the engine, one JPEG per time in `times` (source
/// seconds), stabilised and levelled exactly as the export: `view(t)` gives the look direction
/// and field of view (None = the whole sphere, equirectangular). `vf(t)` is applied before each
/// JPEG is written (grid and labels).
#[allow(clippy::too_many_arguments)]
pub fn stills(ffmpeg: &Path, jobs: &Jobs, tag: &str, gen: u64, info: &MediaInfo, lens: &Lens, m: Option<&Motion>, times: &[f64], w: u32, h: u32, view: &dyn Fn(f64) -> (M3, Option<(f64, f64)>), vf: &dyn Fn(f64) -> String, out_dir: &Path) -> Result<Vec<std::path::PathBuf>, String> {
    let s = crate::stitch::params(lens);
    let stab = stab_of(lens);
    let tg = m.map(|m| targets(m, &stab)).unwrap_or_default();
    let fps = if info.fps > 1.0 { info.fps } else { 30.0 };
    // Each lens decoded at about the output's resolution (a 3840² lens is not needed for 1920 wide).
    let px = (w / 2).clamp(256, 2048) & !1;
    let mut outs = Vec::new();
    for (i, &t) in times.iter().enumerate() {
        let t = t.clamp(0.0, (info.duration - 1.0 / fps).max(0.0));
        let src = source_for(info, lens, t, 0.9 / fps, Some(px), false);
        // The same seam as the export.
        let mut st = Stitcher::new(&s, src.n() as f64, w as usize, h as usize, s.precise(), rs_of(m, &stab));
        let k0 = (t * fps).round().max(0.0) as usize;
        let at = move |_x: f64| view(t);
        let setup = setup_fn(m, &tg, k0, &stab, &at);
        let out = out_dir.join(format!("still-{i}.jpg"));
        let args: Vec<String> = ["-vf", &vf(t), "-q:v", "3", "-update", "1", "-f", "image2", &out.to_string_lossy()].iter().map(|x| x.to_string()).collect();
        pano::run::<u8>(ffmpeg, jobs, tag, gen, &src, &mut st, &setup, Sink::Encode { args }, |_| {})?;
        if !out.is_file() {
            return Err(format!("{t:.1}초 장면을 만들지 못했습니다"));
        }
        outs.push(out);
    }
    Ok(outs)
}

/// Like `stills`, handing each picture to `each` instead of writing it (for looking at the pixels).
#[allow(clippy::too_many_arguments)]
pub fn look_at(ffmpeg: &Path, jobs: &Jobs, tag: &str, gen: u64, info: &MediaInfo, lens: &Lens, m: Option<&Motion>, items: &[(f64, M3, Option<(f64, f64)>)], w: u32, h: u32, each: &mut dyn FnMut(usize, f64, &Frame<u8>)) -> Result<(), String> {
    let s = crate::stitch::params(lens);
    let stab = stab_of(lens);
    let tg = m.map(|m| targets(m, &stab)).unwrap_or_default();
    let fps = if info.fps > 1.0 { info.fps } else { 30.0 };
    let px = (w / 2).clamp(256, 2048) & !1;
    for (i, (t, rot, hfov)) in items.iter().enumerate() {
        let t = t.clamp(0.0, (info.duration - 1.0 / fps).max(0.0));
        let src = source_for(info, lens, t, 0.9 / fps, Some(px), false);
        let mut st = Stitcher::new(&s, src.n() as f64, w as usize, h as usize, false, rs_of(m, &stab));
        let k0 = (t * fps).round().max(0.0) as usize;
        let (rot, hfov) = (*rot, *hfov);
        let at = move |_x: f64| (rot, hfov);
        let setup = setup_fn(m, &tg, k0, &stab, &at);
        let mut cb = |_k: usize, f: &Frame<u8>| each(i, t, f);
        pano::run::<u8>(ffmpeg, jobs, tag, gen, &src, &mut st, &setup, Sink::Call(&mut cb), |_| {})?;
    }
    Ok(())
}

/// The stabilised, level sphere of a stretch of a recording, `hz` pictures a second (w × w/2).
#[allow(clippy::too_many_arguments)]
pub fn sphere_run(ffmpeg: &Path, jobs: &Jobs, tag: &str, gen: u64, info: &MediaInfo, lens: &Lens, m: Option<&Motion>, from: f64, to: f64, hz: f64, w: u32, each: &mut dyn FnMut(usize, f64, &Frame<u8>)) -> Result<(), String> {
    let s = crate::stitch::params(lens);
    let stab = stab_of(lens);
    let tg = m.map(|m| targets(m, &stab)).unwrap_or_default();
    let fps = if info.fps > 1.0 { info.fps } else { 30.0 };
    let every = (fps / hz).round().max(1.0) as usize;
    let mut src = source_for(info, lens, from.max(0.0), (to - from).max(0.1), Some((w / 2).clamp(256, 2048) & !1), false);
    src.every = every as u32;
    let mut st = Stitcher::new(&s, src.n() as f64, w as usize, (w / 2) as usize, false, rs_of(m, &stab));
    let k0 = (from * fps).round().max(0.0) as usize;
    let sphere = |_t: f64| (I3, None);
    let inner = setup_fn(m, &tg, k0, &stab, &sphere);
    let setup = |k: usize, t: f64| inner(k * every, t);
    let step = every as f64 / fps;
    let mut cb = |k: usize, f: &Frame<u8>| each(k, from + k as f64 * step, f);
    pano::run::<u8>(ffmpeg, jobs, tag, gen, &src, &mut st, &setup, Sink::Call(&mut cb), |_| {})?;
    Ok(())
}

pub fn rotate_view(rot: M3, w: [f64; 3]) -> M3 {
    mmul(&rot, &expmap(w))
}

#[cfg(test)]
mod flat_tests {
    use super::*;

    #[test]
    fn lens_size_follows_the_view() {
        // 1080p at 91° needs nearly all of a 3840 lens; a wide view or a small output much less.
        let full = lens_px_for(193.4, 1920, 91.0, 0.0, 3840);
        assert!(full > 3300 && full <= 3840, "{full}");
        assert!(lens_px_for(193.4, 1280, 91.0, 0.0, 3840) < full);
        assert!(lens_px_for(193.4, 1920, 130.0, 0.0, 3840) < full);
        assert_eq!(lens_px_for(193.4, 3840, 60.0, 0.0, 3840), 3840);
        assert_eq!(lens_px_for(193.4, 320, 130.0, 0.0, 3840), 1024);
        assert_eq!(lens_px_for(193.4, 1920, 91.0, 0.0, 800) % 2, 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stitch::{matrix, ypr};

    /// The preview's quaternion turns a direction exactly as the engine's matrix does.
    #[test]
    fn stab_track_quaternions_match_the_matrix() {
        let mut rot = Vec::new();
        for k in 0..40 {
            rot.push(to9(&matrix(ypr(k as f64 * 3.0, 20.0 + k as f64, -10.0))));
        }
        let m = Motion { source: "video".into(), fps: 30.0, rot, readout: 0.0, top_first: true, down: [0.0, 1.0, 0.0], product: String::new(), note: String::new() };
        let s = Stab { mode: "horizon".into(), ..Default::default() };
        let qs = stab_track(&m, &s);
        let tg = targets(&m, &s);
        assert_eq!(qs.len(), 40);
        for (i, q) in qs.iter().enumerate() {
            let want = mv(&mmul(&mt(&m.at(i)), &tg[i]), [0.3, -0.5, 0.81]);
            let (w, x, y, z) = (q[0] as f64, q[1] as f64, q[2] as f64, q[3] as f64);
            let v = [0.3, -0.5, 0.81];
            let t = [2.0 * (y * v[2] - z * v[1]), 2.0 * (z * v[0] - x * v[2]), 2.0 * (x * v[1] - y * v[0])];
            let got = [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
            for a in 0..3 {
                assert!((got[a] - want[a]).abs() < 1e-3, "frame {i}: {got:?} vs {want:?}");
            }
        }
    }

    /// The level panorama and a flat view agree on directions: a view at yaw/pitch shows what sits
    /// at x = (yaw+180)/360·W, y = (90−pitch)/180·H of the panorama (the coordinates the AI reads).
    /// Checked on two synthetic recordings whose brightness encodes the direction (made from an
    /// equirect ramp turned into side-by-side fisheyes; REELCUT_FX/ramp).
    #[test]
    fn panorama_matches_view_directions() {
        let Ok(fx) = std::env::var("REELCUT_FX") else { return };
        let fx = std::path::PathBuf::from(fx);
        if !fx.join("ramp/yawramp.mp4").is_file() {
            return;
        }
        let bin = |n: &str| std::path::PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join(n);
        let (ffmpeg, ffprobe) = (bin("ffmpeg"), bin("ffprobe"));
        let work = fx.join("work-eq");
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let lens = Lens { layout: "dfisheye".into(), swap: false, fov: 190.0, stitch: None, stab: Some(Stab { mode: "off".into(), ..Default::default() }) };
        let jobs = Jobs::default();
        let gray = |p: &Path, w: usize, h: usize| -> Vec<u8> { ff::command(&ffmpeg).args(["-v", "error", "-i", &p.to_string_lossy(), "-vf", &format!("scale={w}:{h},format=gray"), "-f", "rawvideo", "-"]).output().unwrap().stdout };
        let none = |_t: f64| "null".to_string();
        let sphere = |_t: f64| (I3, None);
        for (file, axis) in [("yawramp.mp4", 0), ("pitchramp.mp4", 1)] {
            let mut info = crate::media::inspect(&ffprobe, &fx.join("ramp").join(file).to_string_lossy()).unwrap();
            info.layout360 = "dfisheye".into();
            let dir = work.join(file);
            std::fs::create_dir_all(&dir).unwrap();
            // The panorama: brightness follows x (yaw file) or y (pitch file).
            let e = gray(&stills(&ffmpeg, &jobs, "t", 0, &info, &lens, None, &[1.0], 512, 256, &sphere, &none, &dir).unwrap()[0], 512, 256);
            for (x, y) in [(100usize, 60usize), (300, 128), (420, 200), (256, 30)] {
                let want = if axis == 0 { x as f64 / 512.0 * 255.0 } else { y as f64 / 256.0 * 255.0 };
                let got = e[y * 512 + x] as f64;
                assert!((got - want).abs() < 8.0, "{file} panorama at ({x},{y}): {got} vs {want}");
            }
            // Flat views: the centre shows the direction they look along.
            for (yaw, pitch) in [(60.0, 20.0), (-100.0, -15.0), (150.0, 35.0), (10.0, -40.0)] {
                let flat = move |_t: f64| (matrix(ypr(yaw, pitch, 0.0)), Some((20.0, 0.0)));
                let d2 = dir.join(format!("v{yaw}_{pitch}"));
                std::fs::create_dir_all(&d2).unwrap();
                let g = gray(&stills(&ffmpeg, &jobs, "t", 0, &info, &lens, None, &[1.0], 64, 64, &flat, &none, &d2).unwrap()[0], 64, 64);
                let got = g[32 * 64 + 32] as f64;
                let want = if axis == 0 { (yaw + 180.0) / 360.0 * 255.0 } else { (90.0 - pitch) / 180.0 * 255.0 };
                assert!((got - want).abs() < 8.0, "{file} view yaw {yaw} pitch {pitch}: centre {got} vs {want}");
            }
        }
        let _ = std::fs::remove_dir_all(&work);
    }

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
        // On average the virtual camera's down is the world's down; the sway stays as filmed.
        let mean: f64 = tg.iter().map(|s| mv(s, [0.0, 1.0, 0.0])[1]).sum::<f64>() / tg.len() as f64;
        assert!(mean > 0.97, "{mean}");
        let lock = targets(&m, &Stab { mode: "lock".into(), ..Default::default() });
        assert!(angle_between(&lock[0], &lock[299]) < 1e-9);
        for s in &lock {
            assert!((mv(s, [0.0, 1.0, 0.0])[1] - 1.0).abs() < 1e-9);
        }
    }

    /// A camera held tilted 30°, spinning, with fast shake and noisy samples.
    fn shaky(fps: f64, secs: f64) -> Motion {
        let rot: Vec<[f64; 9]> = (0..(secs * fps) as usize).map(|k| {
            let t = k as f64 / fps;
            let shake = 2.0 * (2.0 * std::f64::consts::PI * 2.0 * t).sin() + 0.5 * (2.0 * std::f64::consts::PI * 11.0 * t).cos();
            to9(&matrix(ypr(25.0 * t, 30.0 + shake, shake)))
        }).collect();
        Motion { source: "gyro".into(), fps, rot, down: [0.0, 1.0, 0.0], ..Default::default() }
    }

    #[test]
    fn eis_holds_still_one_world_way_like_dji() {
        let m = shaky(30.0, 20.0);
        let tg = targets(&m, &Stab { mode: "eis".into(), ..Default::default() });
        let down = unit(m.down);
        for t in &tg {
            // Level, and forward at DJI's heading in the gyro's world, whatever the camera does.
            assert!(dot(mv(t, [0.0, 1.0, 0.0]), down) > 0.9999);
            let f = mv(t, [0.0, 0.0, 1.0]);
            let head = (-f[2]).atan2(f[0]).to_degrees();
            assert!((head - DJI_HEADING).abs() < 0.01, "{head}");
        }
        // Without the gyro there is no such world: the first second's way, as 방향 고정.
        let v = Motion { source: "video".into(), ..m.clone() };
        let (a, b) = (targets(&v, &Stab { mode: "eis".into(), ..Default::default() }), targets(&v, &Stab { mode: "lock".into(), ..Default::default() }));
        assert!(a.iter().zip(&b).all(|(x, y)| angle_between(x, y) < 1e-9));
    }

    #[test]
    fn the_forward_view_follows_half_a_second_late() {
        // A camera turning at a steady 30°/s: the view turns with it, FORWARD_DELAY behind.
        let fps = 30.0;
        let rot: Vec<[f64; 9]> = (0..600).map(|k| to9(&matrix(ypr(30.0 * k as f64 / fps, 0.0, 0.0)))).collect();
        let m = Motion { source: "gyro".into(), fps, rot, down: [0.0, 1.0, 0.0], ..Default::default() };
        let tg = targets(&m, &Stab { mode: "forward".into(), ..Default::default() });
        let k = 300;
        let lag = angle_between(&tg[k], &m.at(k)).to_degrees();
        assert!((lag - 30.0 * FORWARD_DELAY).abs() < 1.0, "{lag}");
    }

    #[test]
    fn levelling_adds_no_shake_of_its_own() {
        let m = shaky(30.0, 20.0);
        let tg = targets(&m, &Stab::default());
        // The correction hardly changes from frame to frame, though the camera shakes by degrees.
        let applied: Vec<M3> = (0..tg.len()).map(|i| mmul(&mt(&m.at(i)), &tg[i])).collect();
        let worst = applied.windows(2).map(|w| angle_between(&w[0], &w[1]).to_degrees()).fold(0.0, f64::max);
        let cam = (1..m.rot.len()).map(|i| angle_between(&m.at(i - 1), &m.at(i)).to_degrees()).fold(0.0, f64::max);
        assert!(worst < 0.1 && cam > 1.0, "correction {worst}, camera {cam}");
        // And it does fix the tilt: 30° on average before, about none after.
        let tilt = |r: &M3| mv(r, [0.0, 1.0, 0.0])[1].clamp(-1.0, 1.0).acos().to_degrees();
        let before: f64 = (0..m.rot.len()).map(|i| tilt(&m.at(i))).sum::<f64>() / m.rot.len() as f64;
        let after: f64 = tg.iter().map(tilt).sum::<f64>() / tg.len() as f64;
        assert!(before > 25.0 && after < 4.0, "{before} -> {after}");
    }

    #[test]
    fn levelling_is_the_same_at_30_and_60_frames() {
        let (a, b) = (shaky(30.0, 10.0), shaky(60.0, 10.0));
        let (ta, tb) = (targets(&a, &Stab::default()), targets(&b, &Stab::default()));
        for k in (30..270).step_by(10) {
            let d = angle_between(&mmul(&mt(&a.at(k)), &ta[k]), &mmul(&mt(&b.at(k * 2)), &tb[k * 2])).to_degrees();
            assert!(d < 0.2, "frame {k}: {d}");
        }
    }

    #[test]
    fn a_stray_attitude_does_not_move_the_correction() {
        let mut m = shaky(30.0, 10.0);
        let clean: Vec<M3> = targets(&m, &Stab::default()).iter().enumerate().map(|(i, t)| mmul(&mt(&m.at(i)), t)).collect();
        m.rot[150] = to9(&matrix(ypr(10.0, -60.0, 40.0)));
        let tg = targets(&m, &Stab::default());
        let got = mmul(&mt(&m.at(151)), &tg[151]);
        assert!(angle_between(&got, &clean[151]).to_degrees() < 0.2);
    }

    #[test]
    fn tilt_recovery_levels_every_frame_and_keeps_the_turning() {
        let m = shaky(30.0, 20.0);
        let tg = targets(&m, &Stab { mode: "tilt".into(), ..Default::default() });
        // Single odd samples go, which takes a little off the fastest shake (2.5° at most here).
        let worst = tg[60..540].iter().map(|r| mv(r, [0.0, 1.0, 0.0])[1].clamp(-1.0, 1.0).acos().to_degrees()).fold(0.0, f64::max);
        assert!(worst < 1.6, "{worst}");
        // It still spins with the camera (25°/s is 500° in 20 s).
        let turn: f64 = tg.windows(2).map(|w| angle_between(&w[0], &w[1]).to_degrees()).sum();
        assert!(turn > 400.0, "{turn}");
    }

    #[test]
    fn the_forward_view_is_level_and_follows_slowly() {
        let m = shaky(30.0, 20.0);
        let tg = targets(&m, &Stab { mode: "forward".into(), ..Default::default() });
        for s in &tg {
            assert!((mv(s, [0.0, 1.0, 0.0])[1] - 1.0).abs() < 1e-9);
        }
        let mid = &tg[120..480];
        let fast = mid.windows(2).map(|w| angle_between(&w[0], &w[1]).to_degrees()).fold(0.0, f64::max);
        // It spins with the camera at 0.83° a frame, without the shake's jumps.
        assert!(fast < 1.1, "{fast}");
        let total: f64 = mid.windows(2).map(|w| angle_between(&w[0], &w[1]).to_degrees()).sum();
        assert!(total > 250.0, "{total}");
    }

    /// DJI Studio's stabilised panorama against the camera's attitude (numbers only; the pictures stay
    /// in memory). REELCUT_DJI_PANO: DJI's 360 export of two stretches; REELCUT_DJI_STARTS: their
    /// source start seconds, comma separated; REELCUT_DJI_SPLIT: DJI frame where the second begins.
    #[test]
    fn real_dji_fit() {
        let (Ok(path), Ok(pano), Ok(md), Ok(key)) = (std::env::var("REELCUT_REAL_OSV"), std::env::var("REELCUT_DJI_PANO"), std::env::var("REELCUT_MOTION_DIR"), std::env::var("REELCUT_MOTION_KEY")) else { return };
        let starts: Vec<f64> = std::env::var("REELCUT_DJI_STARTS").unwrap().split(',').map(|x| x.parse().unwrap()).collect();
        let split: usize = std::env::var("REELCUT_DJI_SPLIT").unwrap().parse().unwrap();
        let bin = |n: &str| std::path::PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join(n);
        let info = crate::media::inspect(&bin("ffprobe"), &path).unwrap();
        let m: Motion = serde_json::from_str(&std::fs::read_to_string(std::path::Path::new(&md).join(format!("{key}{TRACK_FILE}"))).unwrap()).unwrap();
        let fps = m.fps;
        let (w, h) = (512usize, 256usize);
        // DJI's frames.
        let o = ff::command(&bin("ffmpeg")).args(["-v", "error", "-i", &pano, "-vf", &format!("scale={w}:{h}:flags=area,format=gray"), "-f", "rawvideo", "-"]).output().unwrap();
        let dji: Vec<Vec<u8>> = o.stdout.chunks(w * h).filter(|c| c.len() == w * h).map(|c| c.to_vec()).collect();
        println!("DJI frames {}", dji.len());
        // Ours, as filmed (no turn), around each stretch.
        let lens = Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: None, stab: None };
        let st = crate::stitch::calibrate(&bin("ffmpeg"), &bin("ffprobe"), &info, &lens).unwrap();
        let lens = Lens { stitch: Some(st), ..lens };
        let s = crate::stitch::params(&lens);
        let mut raws: Vec<(usize, Vec<Vec<u8>>)> = vec![];
        for &t0 in &starts {
            let from = (t0 - 0.5).max(0.0);
            let k0 = (from * fps).round() as usize;
            let mut src = source_for(&info, &lens, from, 16.5, Some(256), false);
            src.gpu = true;
            let mut sp = Stitcher::new(&s, src.n() as f64, w, h, false, None);
            let setup = |_k: usize, _t: f64| FrameSetup { rot: I3, hfov: None, omega: None };
            let mut v: Vec<Vec<u8>> = vec![];
            let mut cb = |_k: usize, f: &Frame<u8>| v.push(f.p[0].clone());
            pano::run::<u8>(&bin("ffmpeg"), &Jobs::default(), "t", 0, &src, &mut sp, &setup, Sink::Call(&mut cb), |_| {}).unwrap();
            raws.push((k0, v));
        }
        let pts: Vec<[f64; 3]> = VisualTracker::new(w, h).pts.iter().map(|p| p.0).collect();
        // How alike two pictures are under a turn (dir in `b` = turn · dir in `a`): 1 − correlation.
        let resid = |a: &[u8], b: &[u8], turn: &M3| -> f64 {
            let (mut sa, mut sb, mut saa, mut sbb, mut sab, mut n) = (0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
            for p in &pts {
                let va = eq_sample(a, w, h, *p) as f64;
                let vb = eq_sample(b, w, h, mv(turn, *p)) as f64;
                sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; n += 1.0;
            }
            let cov = sab / n - sa / n * sb / n;
            1.0 - cov / ((saa / n - (sa / n).powi(2)).max(1e-9) * (sbb / n - (sb / n).powi(2)).max(1e-9)).sqrt()
        };
        let align = |a: &[u8], b: &[u8], guess: M3| -> M3 {
            let mut tr = VisualTracker::new(w, h);
            tr.prev = Some(a.to_vec());
            tr.last = guess;
            tr.push(b)
        };
        let eis = targets(&m, &Stab { mode: "eis".into(), strength: 1.0, rs: false });
        // Per DJI frame: the camera frame it shows and DJI's virtual camera (output dir → world).
        let mut found: Vec<(usize, usize, M3)> = vec![]; // (stretch, source frame, T_dji)
        let mut found_j: Vec<usize> = vec![];
        for (ci, &t0) in starts.iter().enumerate() {
            let (j0, j1) = if ci == 0 { (0, split) } else { (split, dji.len()) };
            let (k0, raw) = &raws[ci];
            let kof = |j: usize, off: f64| ((t0 + (j - j0) as f64 / 30.0) * fps + off).round() as usize;
            // First frame: DJI's heading against ours (level both), then its time offset.
            let kf = kof(j0, 0.0);
            let base = |k: usize| mmul(&mt(&eis[k]), &m.at(k)); // raw → our level output
            let mut best = (f64::INFINITY, I3);
            for yd in (0..360).step_by(6) {
                let g = mmul(&matrix(ypr(yd as f64, 0.0, 0.0)), &base(kf));
                let r = align(&raw[kf - k0], &dji[j0], g);
                let e = resid(&raw[kf - k0], &dji[j0], &r);
                if e < best.0 { best = (e, r); }
            }
            let mut s_turn = best.1;
            let mut off_best = (f64::INFINITY, 0.0);
            for o in -8..=8 {
                let off = o as f64 * 0.5;
                let mut e = 0.0;
                for jj in [j0, j0 + 60, j0 + 200] {
                    let k = kof(jj, off);
                    let tg = mmul(&s_turn, &mmul(&mt(&base(kf)), &base(k)));
                    let r = align(&raw[k - k0], &dji[jj], tg);
                    e += resid(&raw[k - k0], &dji[jj], &r);
                }
                if e < off_best.0 { off_best = (e, off); }
            }
            println!("DJI stretch {ci}: start residual {:.3}, time offset {:+.1} frames", best.0, off_best.1);
            let mut prev_t: Option<M3> = None;
            let mut res = 0.0;
            for j in j0..j1 {
                let k = kof(j, off_best.1);
                if k < *k0 || k - k0 >= raw.len() { continue; }
                let guess = match prev_t { Some(t) => mmul(&mt(&t), &m.at(k)), None => s_turn };
                let r = align(&raw[k - k0], &dji[j], guess);
                res += resid(&raw[k - k0], &dji[j], &r);
                // world = R·d_raw, d_dji = r·d_raw ⇒ T_dji = R·rᵀ.
                let t = mmul(&m.at(k), &mt(&r));
                prev_t = Some(t);
                s_turn = r;
                found.push((ci, k, t));
                found_j.push(j);
            }
            println!("DJI stretch {ci}: {} frames, mean residual {:.3}", j1 - j0, res / (j1 - j0) as f64);
        }
        let down = unit(m.down);
        let tilt = |t: &M3| mv(t, [0.0, 1.0, 0.0]).iter().zip(down).map(|(a, b)| a * b).sum::<f64>().clamp(-1.0, 1.0).acos().to_degrees();
        let jitter = |ts: &[M3]| -> f64 {
            // Turn per frame minus its local mean (the shake that is left), degrees.
            let w: Vec<[f64; 3]> = ts.windows(2).map(|p| logmap(&mmul(&mt(&p[0]), &p[1]))).collect();
            let mut s = 0.0;
            for i in 2..w.len().saturating_sub(2) {
                let mut mean = [0.0; 3];
                for d in -2i32..=2 { for a in 0..3 { mean[a] += w[(i as i32 + d) as usize][a] / 5.0; } }
                s += (0..3).map(|a| (w[i][a] - mean[a]).powi(2)).sum::<f64>().sqrt();
            }
            (s / (w.len().saturating_sub(4)).max(1) as f64).to_degrees()
        };
        for ci in 0..starts.len() {
            let f: Vec<&(usize, usize, M3)> = found.iter().filter(|x| x.0 == ci).collect();
            let td: Vec<M3> = f.iter().map(|x| x.2).collect();
            let cam: Vec<M3> = f.iter().map(|x| m.at(x.1)).collect();
            let tilts: Vec<f64> = td.iter().map(tilt).collect();
            let mt_ = tilts.iter().sum::<f64>() / tilts.len() as f64;
            println!("DJI stretch {ci}: horizon tilt mean {mt_:.2}° max {:.2}°; jitter left: DJI {:.3}°/frame, camera {:.3}°/frame", tilts.iter().cloned().fold(0.0, f64::max), jitter(&td), jitter(&cam));
        }
        // The seam: how much it shows and flickers in DJI's panorama against ours (2.25.2: plain and
        // lined up), on the same frames at 2048×1024. Across the lens border (the circle half way
        // between the lenses, in the camera's axes) against circles 10° to either side.
        if std::env::var("REELCUT_DJI_SEAM").is_ok() {
            let (sw, sh) = (2048usize, 1024usize);
            let delta = 0.35f64.to_radians();
            let bins = 720usize;
            // Signed steps across a circle at `off` from the border, per bin (None near the poles).
            let steps = |img: &[u8], r: &M3, off: f64| -> Vec<Option<f64>> {
                (0..bins).map(|b| {
                    let ph = b as f64 / bins as f64 * std::f64::consts::TAU;
                    let p = [ph.cos(), ph.sin(), 0.0];
                    let at = |a: f64| { let q = [p[0] * a.cos(), p[1] * a.cos(), a.sin()]; mv(r, q) };
                    let c = at(off);
                    if c[1].abs() > 0.9 { return None; }
                    Some(eq_sample(img, sw, sh, at(off + delta)) as f64 - eq_sample(img, sw, sh, at(off - delta)) as f64)
                }).collect()
            };
            let windows: Vec<(usize, usize)> = vec![(0, 60), (0, 210), (0, 360), (1, 60), (1, 210), (1, 360)]; // (stretch, DJI frame from its start)
            let mut acc: std::collections::BTreeMap<&str, (f64, f64, f64, f64)> = Default::default(); // vis num, den, flick num, den
            for &(ci, off) in &windows {
                let j0 = if ci == 0 { 0 } else { split } + off;
                let idx: Vec<usize> = (0..found.len()).filter(|&i| found_j[i] >= j0 && found_j[i] < j0 + 30).collect();
                if idx.len() < 20 { continue; }
                let (ja, jb) = (found_j[idx[0]], found_j[*idx.last().unwrap()]);
                let o = ff::command(&bin("ffmpeg")).args(["-v", "error", "-i", &pano, "-vf", &format!("select=between(n\\,{ja}\\,{jb}),scale={sw}:{sh}:flags=area,format=gray"), "-fps_mode", "passthrough", "-f", "rawvideo", "-"]).output().unwrap();
                let djb: Vec<Vec<u8>> = o.stdout.chunks(sw * sh).filter(|c| c.len() == sw * sh).map(|c| c.to_vec()).collect();
                let (ka, kb) = (found[idx[0]].1, found[*idx.last().unwrap()].1);
                let mut ours: Vec<(&str, Vec<Vec<u8>>)> = vec![];
                for (label, flow) in [("Reelcut plain", false), ("Reelcut 2.25.2", true)] {
                    let from = ka as f64 / fps;
                    let mut src = source_for(&info, &lens, from, (kb - ka + 1) as f64 / fps - 0.5 / fps, Some(1024), false);
                    src.gpu = true;
                    let mut sp = Stitcher::new(&s, src.n() as f64, sw, sh, flow && s.precise(), None);
                    let setup = |_k: usize, _t: f64| FrameSetup { rot: I3, hfov: None, omega: None };
                    let mut v: Vec<Vec<u8>> = vec![];
                    let mut cb = |_k: usize, f: &Frame<u8>| v.push(f.p[0].clone());
                    pano::run::<u8>(&bin("ffmpeg"), &Jobs::default(), "t", 0, &src, &mut sp, &setup, Sink::Call(&mut cb), |_| {}).unwrap();
                    ours.push((label, v));
                }
                let mut series: Vec<(&str, Vec<[Vec<Option<f64>>; 3]>)> = vec![];
                let dj: Vec<[Vec<Option<f64>>; 3]> = idx.iter().filter_map(|&i| {
                    let img = djb.get(found_j[i] - ja)?;
                    let r = mmul(&mt(&found[i].2), &m.at(found[i].1));
                    Some([steps(img, &r, 0.0), steps(img, &r, 10f64.to_radians()), steps(img, &r, -10f64.to_radians())])
                }).collect();
                series.push(("DJI Studio", dj));
                for (label, v) in &ours {
                    let ss: Vec<[Vec<Option<f64>>; 3]> = idx.iter().filter_map(|&i| {
                        let img = v.get(found[i].1 - ka)?;
                        Some([steps(img, &I3, 0.0), steps(img, &I3, 10f64.to_radians()), steps(img, &I3, -10f64.to_radians())])
                    }).collect();
                    series.push((label, ss));
                }
                for (label, ser) in &series {
                    let e = acc.entry(label).or_default();
                    let (mut vs, mut vc, mut fs, mut fc, mut nv, mut nf) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
                    for (t, fr3) in ser.iter().enumerate() {
                        for b in 0..bins {
                            if let (Some(a), Some(c1), Some(c2)) = (fr3[0][b], fr3[1][b], fr3[2][b]) {
                                vs += a.abs(); vc += (c1.abs() + c2.abs()) / 2.0; nv += 1.0;
                                if t > 0 {
                                    let p = &ser[t - 1];
                                    if let (Some(pa), Some(p1), Some(p2)) = (p[0][b], p[1][b], p[2][b]) {
                                        fs += (a - pa).abs(); fc += ((c1 - p1).abs() + (c2 - p2).abs()) / 2.0; nf += 1.0;
                                    }
                                }
                            }
                        }
                    }
                    println!("SEAMW {label} stretch {ci} +{off}: visibility {:.3} flicker {:.3} (across {:.2} vs beside {:.2}; change {:.2} vs {:.2})", vs / vc, fs / fc, vs / nv, vc / nv, fs / nf, fc / nf);
                    e.0 += vs / nv; e.1 += vc / nv; e.2 += fs / nf; e.3 += fc / nf;
                }
            }
            for (label, e) in &acc {
                println!("SEAM {label}: visibility {:.3} (step across the seam ÷ beside it), flicker {:.3} (its change frame to frame ÷ beside it)", e.0 / e.1, e.2 / e.3);
            }
        }
        // Heading (about down), elevation and roll of a virtual camera, degrees.
        let e1 = { let x = [1.0, 0.0, 0.0]; let d = dot(x, down); unit([x[0] - d * down[0], x[1] - d * down[1], x[2] - d * down[2]]) };
        let e2 = cross(down, e1);
        let hpr = |t: &M3| -> [f64; 3] {
            let f = mv(t, [0.0, 0.0, 1.0]);
            let head = dot(f, e2).atan2(dot(f, e1)).to_degrees();
            let elev = (-dot(f, down)).clamp(-1.0, 1.0).asin().to_degrees();
            let roll = match level(down, f) { Some(l) => { let y = mv(t, [0.0, 1.0, 0.0]); let lx = mv(&l, [1.0, 0.0, 0.0]); let ly = mv(&l, [0.0, 1.0, 0.0]); dot(y, lx).atan2(dot(y, ly)).to_degrees() } None => 0.0 };
            [head, elev, roll]
        };
        let unwrap = |v: Vec<f64>| -> Vec<f64> { let mut o = vec![]; let mut acc = 0.0; let mut last = v[0]; for x in v { let mut d = x - last; while d > 180.0 { d -= 360.0 } while d < -180.0 { d += 360.0 } acc += d; last = x; o.push(acc) } o };
        let gsm = |v: &[f64], sg: f64| -> Vec<f64> { let n = v.len() as isize; let r = (sg * 3.0).ceil() as isize; (0..n).map(|k| { let (mut a, mut w) = (0.0, 0.0); for d in -r..=r { let g = (-(d * d) as f64 / (2.0 * sg * sg).max(1e-9)).exp(); a += g * v[(k + d).clamp(0, n - 1) as usize]; w += g; } a / w }).collect() };
        let ema = |v: &[f64], tau: f64| -> Vec<f64> { let a = 1.0 / (1.0 + tau.max(0.0)); let mut s = v[0]; v.iter().map(|x| { s += a * (x - s); s }).collect() };
        for ci in 0..starts.len() {
            let f: Vec<&(usize, usize, M3)> = found.iter().filter(|x| x.0 == ci).collect();
            let d: Vec<[f64; 3]> = f.iter().map(|x| hpr(&x.2)).collect();
            let c: Vec<[f64; 3]> = f.iter().map(|x| hpr(&m.at(x.1))).collect();
            let dh = unwrap(d.iter().map(|x| x[0]).collect());
            let ch = unwrap(c.iter().map(|x| x[0]).collect());
            println!("START {ci}: DJI heading minus camera heading {:.1}°, DJI elevation {:.1}°", { let mut x = d[0][0] - c[0][0]; while x > 180.0 { x -= 360.0 } while x < -180.0 { x += 360.0 } x }, d[0][1]);
            for j in (0..f.len()).step_by(30) {
                println!("TRACK {ci} {:5.1}s heading DJI {:8.2} cam {:8.2} | elev DJI {:6.2} cam {:6.2} | roll DJI {:6.2} cam {:6.2}", j as f64 / 30.0, dh[j] - dh[0], ch[j] - ch[0], d[j][1], c[j][1], d[j][2], c[j][2]);
            }
            // Heading: DJI's against the camera's, smoothed both ways, over a range of time constants.
            let rms = |a: &[f64], b: &[f64]| -> f64 { let off = a.iter().zip(b).map(|(x, y)| x - y).sum::<f64>() / a.len() as f64; (a.iter().zip(b).map(|(x, y)| (x - y - off).powi(2)).sum::<f64>() / a.len() as f64).sqrt() };
            let mut bg = (f64::INFINITY, 0.0); let mut be = (f64::INFINITY, 0.0);
            for i in 0..=80 { let sg = i as f64 * 0.25; let e = rms(&dh, &gsm(&ch, sg * 30.0)); if e < bg.0 { bg = (e, sg) } let e2 = rms(&dh, &ema(&ch, sg * 30.0)); if e2 < be.0 { be = (e2, sg) } }
            println!("HEADING {ci}: centred gaussian best sigma {:.2} s (rms {:.2}°); one-sided best tau {:.2} s (rms {:.2}°); locked rms {:.2}°; camera rms {:.2}°", bg.1, bg.0, be.1, be.0, rms(&dh, &vec![0.0; dh.len()]), rms(&dh, &ch));
            let de: Vec<f64> = d.iter().map(|x| x[1]).collect(); let dr: Vec<f64> = d.iter().map(|x| x[2]).collect();
            println!("LEVEL {ci}: DJI elevation mean {:.2}° sd {:.2}°, roll mean {:.2}° sd {:.2}°", de.iter().sum::<f64>() / de.len() as f64, rms(&de, &vec![0.0; de.len()]), dr.iter().sum::<f64>() / dr.len() as f64, rms(&dr, &vec![0.0; dr.len()]));
        }
        // Fit: Reelcut's ways with a range of smoothing and lags, after one constant turn per stretch.
        let fit = |mode: &str, strength: f64, lag: isize| -> (f64, f64, f64) {
            let tg = targets(&m, &Stab { mode: mode.into(), strength, rs: false });
            let (mut e, mut et, mut n, mut jt) = (0.0, 0.0, 0.0, 0.0);
            for ci in 0..starts.len() {
                let f: Vec<&(usize, usize, M3)> = found.iter().filter(|x| x.0 == ci).collect();
                let at = |k: usize| tg[((k as isize + lag).max(0) as usize).min(tg.len() - 1)];
                let mut acc = [0.0; 4];
                for x in &f {
                    let q = quat_of(&mmul(&mt(&at(x.1)), &x.2));
                    let q = if acc.iter().zip(&q).map(|(a, b)| a * b).sum::<f64>() < 0.0 { q.map(|v| -v) } else { q };
                    for i in 0..4 { acc[i] += q[i]; }
                }
                let o = mat_of(acc);
                for x in &f {
                    let mm = mmul(&at(x.1), &o);
                    e += angle_between(&mm, &x.2).to_degrees();
                    et += (tilt(&mm) - tilt(&x.2)).abs();
                    n += 1.0;
                }
                let jit: Vec<M3> = f.iter().map(|x| at(x.1)).collect();
                jt += jitter(&jit) / starts.len() as f64;
            }
            (e / n, et / n, jt)
        };
        for mode in ["eis", "smooth", "horizon", "forward", "lock", "off"] {
            let mut best = (f64::INFINITY, 0.0, 0, 0.0, 0.0);
            let strengths: &[f64] = if mode == "eis" || mode == "smooth" { &[0.5, 1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 10.0] } else { &[1.0] };
            for &sg in strengths {
                for lag in (-12isize..=12).step_by(3) {
                    let (e, et, j) = fit(mode, sg, lag);
                    if e < best.0 { best = (e, sg, lag, et, j); }
                }
            }
            println!("FIT {mode}: best strength {} (sigma {:.2} s) lag {} frames: mean difference {:.2}°, horizon difference {:.2}°, jitter {:.3}°/frame", best.1, best.1 / 2.0, best.2, best.0, best.3, best.4);
        }
        for &sg in &[1.0, 2.0, 4.0, 6.0, 10.0] {
            let (e, et, j) = fit("eis", sg, 0);
            println!("CURVE eis strength {sg}: {e:.2}° (horizon {et:.2}°, jitter {j:.3})");
        }
        // DJI's flat (reframed) exports: per frame, the virtual camera and the field of view that make
        // our unturned sphere look like DJI's picture. Coarse to fine, on halved pictures.
        let Ok(flats) = std::env::var("REELCUT_DJI_FLATS") else { return };
        let half = |img: &[u8], iw: usize, ih: usize| -> Vec<u8> {
            let (ow, oh) = (iw / 2, ih / 2);
            let mut o = vec![0u8; ow * oh];
            for y in 0..oh { for x in 0..ow {
                let s = img[2 * y * iw + 2 * x] as u32 + img[2 * y * iw + 2 * x + 1] as u32 + img[(2 * y + 1) * iw + 2 * x] as u32 + img[(2 * y + 1) * iw + 2 * x + 1] as u32;
                o[y * ow + x] = ((s + 2) / 4) as u8;
            } }
            o
        };
        // Levels: (flat w, h, sphere w, h).
        let lv = [(32usize, 18usize, 128usize, 64usize), (64, 36, 256, 128), (128, 72, 512, 256)];
        let pyr_s = |s: &[u8]| -> Vec<Vec<u8>> { let a = half(s, 512, 256); let b = half(&a, 256, 128); vec![b, a, s.to_vec()] };
        for flat in flats.split(',') {
            let (fw, fh) = (128usize, 72usize);
            let o = ff::command(&bin("ffmpeg")).args(["-v", "error", "-i", flat, "-vf", &format!("scale={fw}:{fh}:flags=area,format=gray"), "-f", "rawvideo", "-"]).output().unwrap();
            let fr: Vec<Vec<Vec<u8>>> = o.stdout.chunks(fw * fh).filter(|c| c.len() == fw * fh).map(|c| { let b = half(c, 128, 72); let a = half(&b, 64, 36); vec![a, b, c.to_vec()] }).collect();
            let name = std::path::Path::new(flat).file_stem().unwrap().to_string_lossy().to_string();
            // 1 − correlation of DJI's picture with our sphere seen by camera `t` (virtual → raw) at `hf`°.
            // Lens kinds: 0 rectilinear, 1 stereographic, 2 equidistant, 3 equisolid; `hf` = angle across.
            let theta = |kind: usize, r: f64, f: f64| -> f64 { match kind { 0 => (r / f).atan(), 1 => 2.0 * (r / (2.0 * f)).atan(), 2 => r / f, _ => 2.0 * (r / (2.0 * f)).min(1.0).asin() } };
            let focal = |kind: usize, half_px: f64, hf: f64| -> f64 { let a = (hf / 2.0).to_radians(); match kind { 0 => half_px / a.min(1.5).tan(), 1 => half_px / (2.0 * (a / 2.0).tan()), 2 => half_px / a, _ => half_px / (2.0 * (a / 2.0).sin()) } };
            let fres = |l: usize, img: &[u8], sph: &[u8], t: &M3, hf: f64, mirror: bool, kind: usize| -> f64 {
                let (iw, ih, sw, sh) = lv[l];
                let f = focal(kind, iw as f64 / 2.0, hf);
                let sx = if mirror { -1.0 } else { 1.0 };
                let (mut sa, mut sb, mut saa, mut sbb, mut sab, mut n) = (0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
                for y in 1..ih - 1 {
                    for x in 1..iw - 1 {
                        let (px, py) = (sx * (x as f64 + 0.5 - iw as f64 / 2.0), y as f64 + 0.5 - ih as f64 / 2.0);
                        let r = (px * px + py * py).sqrt();
                        let th = theta(kind, r, f);
                        let k = if r > 1e-9 { th.sin() / r } else { 1.0 / f };
                        let d = [px * k, py * k, th.cos()];
                        let va = img[y * iw + x] as f64;
                        let vb = eq_sample(sph, sw, sh, mv(t, d)) as f64;
                        sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; n += 1.0;
                    }
                }
                let cov = sab / n - sa / n * sb / n;
                1.0 - cov / ((saa / n - (sa / n).powi(2)).max(1e-9) * (sbb / n - (sb / n).powi(2)).max(1e-9)).sqrt()
            };
            let refine = |img: &[Vec<u8>], sph: &[Vec<u8>], t0: M3, hf: f64, mirror: bool, kind: usize, from: usize| -> (M3, f64) {
                let mut t = t0;
                let mut e = 0.0;
                for l in from..3 {
                    e = fres(l, &img[l], &sph[l], &t, hf, mirror, kind);
                    let steps: &[f64] = match l { 0 => &[3.0, 1.0], 1 => &[0.6, 0.25], _ => &[0.12, 0.05] };
                    for &step in steps {
                        let mut moved = true;
                        let mut it = 0;
                        while moved && it < 15 {
                            moved = false;
                            it += 1;
                            for a in 0..3 {
                                for sgn in [-1.0, 1.0] {
                                    let mut wv = [0.0; 3];
                                    wv[a] = sgn * step.to_radians();
                                    let c = mmul(&t, &expmap(wv));
                                    let ec = fres(l, &img[l], &sph[l], &c, hf, mirror, kind);
                                    if ec < e { e = ec; t = c; moved = true; }
                                }
                            }
                        }
                    }
                }
                (t, e)
            };
            let mut fl: Vec<(usize, usize, usize, M3)> = vec![]; // (stretch, DJI frame, source frame, virtual → world)
            let mut hfov = 60.0;
            let mut mirror = false;
            let mut kind = 0usize;
            for (ci, &t0s) in starts.iter().enumerate() {
                let (j0, j1) = if ci == 0 { (0, split) } else { (split, fr.len()) };
                let (k0, raw) = &raws[ci];
                let kof = |j: usize| ((t0s + (j - j0) as f64 / 30.0) * fps - 1.5).round() as usize;
                let k = kof(j0);
                let sph = pyr_s(&raw[k - k0]);
                // Start: look all round from the level world frame, on the coarsest level.
                let mut best = (f64::INFINITY, I3, false, 0usize, hfov);
                let fixed: Option<(usize, f64)> = std::env::var("REELCUT_DJI_LENS").ok().and_then(|v| { let per: Vec<&str> = v.split(';').collect(); let p = per[ci.min(per.len() - 1)]; if p == "search" { return None; } let mut it = p.split(','); Some((it.next().unwrap().parse().unwrap(), it.next().unwrap().parse().unwrap())) });
                if let Some((kd, hf)) = fixed { kind = kd; hfov = hf; }
                let mirrors: &[bool] = if fixed.is_none() { &[false, true] } else if mirror { &[true] } else { &[false] };
                let kinds: Vec<usize> = if fixed.is_none() { vec![0, 1, 2, 3] } else { vec![kind] };
                let hfs: Vec<f64> = if fixed.is_none() { (0..8).map(|i| 60.0 + 20.0 * i as f64).collect() } else { vec![hfov] };
                for &mi in mirrors { for &kd in &kinds { for &hf0 in &hfs {
                    if kd == 0 && hf0 > 150.0 { continue }
                    for hd in (0..360).step_by(4) {
                        for el in (-80..=80).step_by(10) {
                            for rl in (-90..=90).step_by(10) {
                                let (h_, e_) = ((hd as f64).to_radians(), (el as f64).to_radians());
                                let fwd = [0usize, 1, 2].map(|i| e_.cos() * (h_.cos() * e1[i] + h_.sin() * e2[i]) - e_.sin() * down[i]);
                                let Some(lvl) = level(down, fwd) else { continue };
                                let lr = mmul(&lvl, &expmap([0.0, 0.0, (rl as f64).to_radians()]));
                                let t = mmul(&mt(&m.at(k)), &lr);
                                let e = fres(0, &fr[j0][0], &sph[0], &t, hf0, mi, kd);
                                if e < best.0 { best = (e, t, mi, kd, hf0); }
                            }
                        }
                    }
                } } }
                mirror = best.2;
                kind = best.3;
                hfov = best.4;
                let (mut t, mut e) = refine(&fr[j0], &sph, best.1, hfov, mirror, kind, 0);
                if fixed.is_none() || std::env::var("REELCUT_DJI_FOVFIT").is_ok() {
                    for _ in 0..2 {
                        let mut bh = (e, hfov, kind);
                        for kd in 0..4 { for i in 0..=90 { let hf = 30.0 + 2.0 * i as f64; if kd == 0 && hf > 160.0 { continue } let ee = fres(1, &fr[j0][1], &sph[1], &t, hf, mirror, kd); if ee < bh.0 { bh = (ee, hf, kd); } } }
                        hfov = bh.1;
                        kind = bh.2;
                        let r = refine(&fr[j0], &sph, t, hfov, mirror, kind, 1);
                        t = r.0; e = r.1;
                    }
                }
                println!("FLAT {name} stretch {ci}: start residual {e:.3} (coarse {:.3}), lens kind {kind}, hfov {hfov:.1}°, mirror {mirror}", best.0);
                let mut prev = mmul(&m.at(k), &t);
                let mut prev_raw = t;
                let mut res = 0.0;
                let mut worst: f64 = 0.0;
                for j in j0..j1 {
                    let k = kof(j);
                    if k < *k0 || k - k0 >= raw.len() { continue; }
                    let sph = pyr_s(&raw[k - k0]);
                    // Two guesses: held still in the world, or carried along with the camera.
                    let g1 = mmul(&mt(&m.at(k)), &prev);
                    let g2 = prev_raw;
                    let e1g = fres(1, &fr[j][1], &sph[1], &g1, hfov, mirror, kind);
                    let e2g = fres(1, &fr[j][1], &sph[1], &g2, hfov, mirror, kind);
                    let (t, e) = refine(&fr[j], &sph, if e1g <= e2g { g1 } else { g2 }, hfov, mirror, kind, 1);
                    res += e;
                    worst = worst.max(e);
                    prev = mmul(&m.at(k), &t);
                    prev_raw = t;
                    fl.push((ci, j, k, prev));
                }
                println!("FLAT {name} stretch {ci}: mean residual {:.3}, worst {worst:.3}", res / (j1 - j0) as f64);
            }
            // Field of view, finer, over frames of both stretches.
            {
                let pick: Vec<&(usize, usize, usize, M3)> = fl.iter().step_by(60).collect();
                let mut bh = (f64::INFINITY, hfov);
                for i in 0..=40 {
                    let hf = hfov - 4.0 + i as f64 * 0.2;
                    let mut e = 0.0;
                    for x in &pick {
                        let (k0, raw) = &raws[x.0];
                        let sph = pyr_s(&raw[x.2 - k0]);
                        e += refine(&fr[x.1], &sph, mmul(&mt(&m.at(x.2)), &x.3), hf, mirror, kind, 2).1;
                    }
                    if e < bh.0 { bh = (e, hf); }
                }
                println!("FLAT {name}: field of view {:.1}° across (first-frame fit {hfov:.1}°)", bh.1);
            }
            let rms = |a: &[f64], b: &[f64]| -> f64 { let off = a.iter().zip(b).map(|(x, y)| x - y).sum::<f64>() / a.len() as f64; (a.iter().zip(b).map(|(x, y)| (x - y - off).powi(2)).sum::<f64>() / a.len() as f64).sqrt() };
            for ci in 0..starts.len() {
                let f: Vec<&(usize, usize, usize, M3)> = fl.iter().filter(|x| x.0 == ci).collect();
                let d: Vec<[f64; 3]> = f.iter().map(|x| hpr(&x.3)).collect();
                let c: Vec<[f64; 3]> = f.iter().map(|x| hpr(&m.at(x.2))).collect();
                let dh = unwrap(d.iter().map(|x| x[0]).collect());
                let ch = unwrap(c.iter().map(|x| x[0]).collect());
                println!("FSTART {name} {ci}: DJI heading {:.1}° camera {:.1}°", d[0][0], c[0][0]);
                println!("FSTART {name} {ci}: DJI heading minus camera heading {:.1}°, DJI elevation {:.1}°, camera elevation {:.1}°", { let mut x = d[0][0] - c[0][0]; while x > 180.0 { x -= 360.0 } while x < -180.0 { x += 360.0 } x }, d[0][1], c[0][1]);
                for j in (0..f.len()).step_by(45) {
                    println!("FTRACK {name} {ci} {:5.1}s heading DJI {:8.2} cam {:8.2} | elev DJI {:6.2} cam {:6.2} | roll DJI {:6.2} cam {:6.2}", j as f64 / 30.0, dh[j] - dh[0], ch[j] - ch[0], d[j][1], c[j][1], d[j][2], c[j][2]);
                }
                let mut bg = (f64::INFINITY, 0.0, 0isize);
                let mut be = (f64::INFINITY, 0.0);
                for i in 0..=80 {
                    let sg = i as f64 * 0.25;
                    let sm = gsm(&ch, sg * 30.0);
                    for lag in (-30isize..=30).step_by(3) {
                        let sh: Vec<f64> = (0..sm.len() as isize).map(|j| sm[(j - lag).clamp(0, sm.len() as isize - 1) as usize]).collect();
                        let e = rms(&dh, &sh);
                        if e < bg.0 { bg = (e, sg, lag) }
                    }
                    let e2 = rms(&dh, &ema(&ch, sg * 30.0));
                    if e2 < be.0 { be = (e2, sg) }
                }
                let td: Vec<M3> = f.iter().map(|x| x.3).collect();
                let cam: Vec<M3> = f.iter().map(|x| m.at(x.2)).collect();
                println!("FHEADING {name} {ci}: gaussian sigma {:.2} s lag {} frames (rms {:.2}°); one-sided tau {:.2} s (rms {:.2}°); locked rms {:.2}°; camera rms {:.2}°; jitter DJI {:.3} camera {:.3} °/frame", bg.1, bg.2, bg.0, be.1, be.0, rms(&dh, &vec![0.0; dh.len()]), rms(&dh, &ch), jitter(&td), jitter(&cam));
                for (mode, sg) in [("off", 1.0), ("smooth", 0.5), ("smooth", 0.7), ("smooth", 0.85), ("smooth", 1.0), ("smooth", 1.2), ("smooth", 1.5), ("smooth", 2.0), ("eis", 1.0), ("lock", 1.0), ("forward", 1.0), ("horizon", 1.0)] {
                    let tg = targets(&m, &Stab { mode: mode.into(), strength: sg, rs: false });
                    let mut acc = [0.0; 4];
                    for x in &f { let q = quat_of(&mmul(&mt(&tg[x.2]), &x.3)); let q = if acc.iter().zip(&q).map(|(a, b)| a * b).sum::<f64>() < 0.0 { q.map(|v| -v) } else { q }; for i in 0..4 { acc[i] += q[i]; } }
                    let o = mat_of(acc);
                    let errs: Vec<f64> = f.iter().map(|x| angle_between(&mmul(&tg[x.2], &o), &x.3).to_degrees()).collect();
                    let mut srt = errs.clone(); srt.sort_by(f64::total_cmp);
                    println!("FMODE {name} {ci} {mode} {sg}: mean {:.2}° median {:.2}° p95 {:.2}°", errs.iter().sum::<f64>() / errs.len() as f64, srt[srt.len() / 2], srt[srt.len() * 95 / 100]);
                }
                // Per angle: DJI's heading, elevation and roll against the camera's (turned by the one
                // constant turn that best matches), as gain × smoothed (sigma, lag) + offset.
                {
                    let mut acc = [0.0; 4];
                    for x in &f { let q = quat_of(&mmul(&mt(&m.at(x.2)), &x.3)); let q = if acc.iter().zip(&q).map(|(a, b)| a * b).sum::<f64>() < 0.0 { q.map(|v| -v) } else { q }; for i in 0..4 { acc[i] += q[i]; } }
                    let cst = mat_of(acc);
                    let cm: Vec<[f64; 3]> = f.iter().map(|x| hpr(&mmul(&m.at(x.2), &cst))).collect();
                    let names = ["heading", "elevation", "roll"];
                    for a in 0..3 {
                        let dv: Vec<f64> = if a == 0 { unwrap(d.iter().map(|x| x[0]).collect()) } else { d.iter().map(|x| x[a]).collect() };
                        let cv: Vec<f64> = if a == 0 { unwrap(cm.iter().map(|x| x[0]).collect()) } else { cm.iter().map(|x| x[a]).collect() };
                        let n = dv.len();
                        let mut best = (f64::INFINITY, 0.0, 0isize, 0.0, 0.0);
                        for i in 0..=40 {
                            let sg = i as f64 * 0.1;
                            let sm = gsm(&cv, sg * 30.0);
                            for lag in (-15isize..=24).step_by(3) {
                                let sh: Vec<f64> = (0..n as isize).map(|j| sm[(j - lag).clamp(0, n as isize - 1) as usize]).collect();
                                // Least squares: dv ≈ g·sh + c.
                                let (mx, my) = (sh.iter().sum::<f64>() / n as f64, dv.iter().sum::<f64>() / n as f64);
                                let sxy: f64 = sh.iter().zip(&dv).map(|(x, y)| (x - mx) * (y - my)).sum();
                                let sxx: f64 = sh.iter().map(|x| (x - mx).powi(2)).sum();
                                let g = if sxx > 1e-9 { sxy / sxx } else { 0.0 };
                                let c = my - g * mx;
                                let e = (sh.iter().zip(&dv).map(|(x, y)| (y - g * x - c).powi(2)).sum::<f64>() / n as f64).sqrt();
                                if e < best.0 { best = (e, sg, lag, g, c); }
                            }
                        }
                        let spread = { let my = dv.iter().sum::<f64>() / n as f64; (dv.iter().map(|y| (y - my).powi(2)).sum::<f64>() / n as f64).sqrt() };
                        println!("FANGLE {name} {ci} {}: gain {:.2} sigma {:.1} s lag {} frames offset {:.1}° (rms {:.2}°, DJI spread {:.2}°)", names[a], best.3, best.1, best.2, best.4, best.0, spread);
                    }
                }
                // Models for DJI's path: heading smoothed over sa seconds, the tilt (the camera in its own
                // level frame) smoothed over sb seconds (0 = per frame, 99 = held at its mean), lag; also
                // the whole turn smoothed together (Reelcut's 흔들림만 보정). One constant turn each.
                if std::env::var("REELCUT_DJI_MODELS").is_ok() {
                    let ka = f[0].2.saturating_sub(300);
                    let kb = (f.last().unwrap().2 + 300).min(m.rot.len() - 1);
                    let rr: Vec<M3> = (ka..=kb).map(|k| m.at(k)).collect();
                    let hh = unwrap(rr.iter().map(|r| hpr(r)[0]).collect());
                    let lev = |h: f64| { let a = h.to_radians(); level(down, [0, 1, 2].map(|i| a.cos() * e1[i] + a.sin() * e2[i])).unwrap_or(I3) };
                    let tilts: Vec<M3> = rr.iter().zip(&hh).map(|(r, h)| mmul(&mt(&lev(*h)), r)).collect();
                    let score = |model: &dyn Fn(usize) -> M3| -> f64 {
                        let mut acc = [0.0; 4];
                        for x in &f { let q = quat_of(&mmul(&mt(&model(x.2 - ka)), &x.3)); let q = if acc.iter().zip(&q).map(|(a, b)| a * b).sum::<f64>() < 0.0 { q.map(|v| -v) } else { q }; for i in 0..4 { acc[i] += q[i]; } }
                        let o = mat_of(acc);
                        f.iter().map(|x| angle_between(&mmul(&model(x.2 - ka), &o), &x.3).to_degrees()).sum::<f64>() / f.len() as f64
                    };
                    let mut results: Vec<(f64, String)> = vec![];
                    for &sa in &[0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0] {
                        let hs = gsm(&hh, sa * fps);
                        for &sb in &[0.0, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 99.0] {
                            let ts: Vec<M3> = if sb >= 99.0 {
                                let i0 = f[0].2 - ka; let i1 = f.last().unwrap().2 - ka;
                                let mut acc = [0.0; 4];
                                let q0 = quat_of(&tilts[i0]);
                                for t in &tilts[i0..=i1] { let q = quat_of(t); let q = if q.iter().zip(&q0).map(|(a, b)| a * b).sum::<f64>() < 0.0 { q.map(|v| -v) } else { q }; for i in 0..4 { acc[i] += q[i]; } }
                                vec![mat_of(acc); tilts.len()]
                            } else { (0..tilts.len()).map(|k| gauss_avg(&tilts, k, sb * fps)).collect() };
                            for lag in [-6isize, -3, 0, 3, 6] {
                                let at = |i: usize| ((i as isize - lag).clamp(0, rr.len() as isize - 1)) as usize;
                                let e = score(&|i: usize| mmul(&lev(hs[at(i)]), &ts[at(i)]));
                                results.push((e, format!("heading sigma {sa} s, tilt sigma {sb} s, lag {lag}")));
                            }
                        }
                    }
                    for &sg in &[0.25, 0.5, 1.0, 2.0, 4.0] {
                        let sm: Vec<M3> = (0..rr.len()).map(|k| gauss_avg(&rr, k, sg * fps)).collect();
                        results.push((score(&|i: usize| sm[i]), format!("whole turn sigma {sg} s")));
                    }
                    results.sort_by(|a, b| a.0.total_cmp(&b.0));
                    for r in results.iter().take(6) { println!("FMODEL {name} {ci}: {:.2}° {}", r.0, r.1); }
                    for r in results.iter().filter(|r| r.1.starts_with("whole")) { println!("FMODEL {name} {ci}: {:.2}° {}", r.0, r.1); }
                }
                let de: Vec<f64> = d.iter().map(|x| x[1]).collect();
                let dr: Vec<f64> = d.iter().map(|x| x[2]).collect();
                let ce: Vec<f64> = c.iter().map(|x| x[1]).collect();
                let cr: Vec<f64> = c.iter().map(|x| x[2]).collect();
                println!("FLEVEL {name} {ci}: elevation mean {:.2}° sd {:.2}° (vs camera rms {:.2}°), roll mean {:.2}° sd {:.2}° (vs camera rms {:.2}°)", de.iter().sum::<f64>() / de.len() as f64, rms(&de, &vec![0.0; de.len()]), rms(&de, &ce), dr.iter().sum::<f64>() / dr.len() as f64, rms(&dr, &vec![0.0; dr.len()]), rms(&dr, &cr));
            }
        }
    }

    /// The seam with and without lining up, on a real recording (numbers only).
    #[test]
    fn real_seam() {
        let Ok(path) = std::env::var("REELCUT_REAL_OSV") else { return };
        let bin = |n: &str| std::path::PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join(n);
        let info = crate::media::inspect(&bin("ffprobe"), &path).unwrap();
        let lens0 = Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: None, stab: None };
        let st = crate::stitch::calibrate(&bin("ffmpeg"), &bin("ffprobe"), &info, &lens0).unwrap();
        let lens = Lens { stitch: Some(st.clone()), ..lens0 };
        let s = crate::stitch::params(&lens);
        let mut all = [0f64; 4];
        let times = [77.0, 188.0, 333.0, 555.0, 777.0, 888.0, 1111.0, 1234.0];
        for t in times {
            let mut src = source_for(&info, &lens, t, 3.0, Some(1024), false);
            src.gpu = true;
            let mut sp = Stitcher::new(&s, src.n() as f64, 2048, 1024, true, None);
            sp.stats = Some(vec![]);
            let setup = |_k: usize, _t: f64| FrameSetup { rot: I3, hfov: None, omega: None };
            let mut cb = |_k: usize, _f: &Frame<u8>| {};
            pano::run::<u8>(&bin("ffmpeg"), &Jobs::default(), "t", 0, &src, &mut sp, &setup, Sink::Call(&mut cb), |_| {}).unwrap();
            let rec = sp.stats.take().unwrap();
            let n = rec.len().saturating_sub(10).max(1) as f64;
            let mut m = [0f64; 4];
            for r in rec.iter().skip(10) {
                for i in 0..4 {
                    m[i] += r[i] as f64 / n;
                }
            }
            println!("SEAM t {t:>6}: plain {:.2} lined up {:.2}; flow moves {:.3} px/frame, cut {:.4}/frame ({} frames)", m[0], m[1], m[2], m[3], rec.len());
            for i in 0..4 {
                all[i] += m[i] / times.len() as f64;
            }
        }
        println!("SEAM all: plain {:.2} lined up {:.2}; flow moves {:.3}, cut {:.4}", all[0], all[1], all[2], all[3]);
        // Does the seam flicker? The picture's change from frame to frame on the seam against beside it, at
        // a view that looks along the seam, with a nearly still camera where there is one.
        for t in [1000.0, 700.0, 420.0, 1234.0] {
            for flow in [false, true] {
                let mut src = source_for(&info, &lens, t, 4.0, Some(1920), false);
                src.gpu = true;
                let mut sp = Stitcher::new(&s, src.n() as f64, 960, 540, flow, None);
                let rot = matrix(ypr(90.0, -10.0, 0.0));
                let setup = move |_k: usize, _t: f64| FrameSetup { rot, hfov: Some((91.0, 0.0)), omega: None };
                let mut last: Option<Vec<u8>> = None;
                let (mut on, mut off, mut n) = (0f64, 0f64, 0f64);
                let mut cb = |_k: usize, f: &Frame<u8>| {
                    if let Some(l) = &last {
                        for y in 0..540 {
                            for x in (440..520).chain(120..200) {
                                let d = (f.p[0][y * 960 + x] as f64 - l[y * 960 + x] as f64).abs();
                                if x >= 440 { on += d } else { off += d }
                            }
                        }
                        n += 1.0;
                    }
                    last = Some(f.p[0].clone());
                };
                pano::run::<u8>(&bin("ffmpeg"), &Jobs::default(), "t", 0, &src, &mut sp, &setup, Sink::Call(&mut cb), |_| {}).unwrap();
                let k = n * 540.0 * 80.0;
                println!("SEAM flicker t {t}: lined up {flow}: on the seam {:.3}, beside it {:.3}", on / k, off / k);
            }
        }
        // What it costs an export.
        for (flow, ow, oh) in [(false, 1920, 1080), (true, 1920, 1080), (false, 3840, 2160), (true, 3840, 2160)] {
            let mut src = source_for(&info, &lens, 295.0, 8.0, None, false);
            src.gpu = true;
            src.crop = true;
            let mut sp = Stitcher::new(&s, src.n() as f64, ow, oh, flow, None);
            let rot = matrix(ypr(90.0, -10.0, 0.0));
            let setup = move |_k: usize, _t: f64| FrameSetup { rot, hfov: Some((91.0, 0.0)), omega: None };
            let mut frames = 0;
            let t0 = std::time::Instant::now();
            let mut cb = |_k: usize, _f: &Frame<u8>| frames += 1;
            pano::run::<u8>(&bin("ffmpeg"), &Jobs::default(), "t", 0, &src, &mut sp, &setup, Sink::Call(&mut cb), |_| {}).unwrap();
            println!("SEAM speed {ow} lined up {flow}: {:.1} fps; ms a frame: strips {:.1} measure {:.1} band {:.1}", frames as f64 / t0.elapsed().as_secs_f64(), sp.times[0] * 1000.0 / frames as f64, sp.times[1] * 1000.0 / frames as f64, sp.times[2] * 1000.0 / frames as f64);
        }
    }

    #[test]
    fn taking_the_shake_out_is_level_and_smooth() {
        let m = shaky(30.0, 20.0);
        let tg = targets(&m, &Stab { mode: "eis".into(), ..Default::default() });
        let mid = &tg[60..540];
        let out = mid.windows(2).map(|w| angle_between(&w[0], &w[1]).to_degrees()).fold(0.0, f64::max);
        // Held still in the world, as DJI does: neither the shake nor the spin is left.
        assert!(out < 1.2, "{out}");
        let tilt = mid.iter().map(|r| mv(r, [0.0, 1.0, 0.0])[1].clamp(-1.0, 1.0).acos().to_degrees()).fold(0.0, f64::max);
        assert!(tilt < 6.0, "{tilt}");
    }

    /// What the camera's own lens values do on a real recording (numbers only).
    #[test]
    fn real_factory_lenses() {
        let Ok(path) = std::env::var("REELCUT_REAL_OSV") else { return };
        let bin = |n: &str| std::path::PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join(n);
        let info = crate::media::inspect(&bin("ffprobe"), &path).unwrap();
        let f = factory_lenses(&bin("ffprobe"), &info, false).expect("factory values");
        println!("FACTORY angles {:?} back {:?} front {:?} plain {:?} {:?}", f.1, f.0[0], f.0[1], f.0[0].plain(), f.0[1].plain());
        let lens = Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: None, stab: None };
        let st = crate::stitch::calibrate(&bin("ffmpeg"), &bin("ffprobe"), &info, &lens).unwrap();
        println!("FACTORY calibrate used {} fov {} yaw {} pitch {} roll {} before {} after {} gains {:?} {:?}", st.factory.is_some(), st.fov, st.yaw, st.pitch, st.roll, st.before, st.after, st.gain_a, st.gain_b);
    }

    #[test]
    fn factory_lenses_map_like_the_formula() {
        let c = crate::stitch::LensCal { fx: 1000.0, fy: 1000.0, cx: 1925.5, cy: 1919.5, k: [0.0; 5], size: 3840.0 };
        // Straight ahead is the lens centre, at any picture size.
        let (x, y) = c.px([0.0, 0.0, 1.0], 3840.0);
        assert!((x - 1925.5).abs() < 1e-6 && (y - 1919.5).abs() < 1e-6);
        // 90° off the axis: f·π/2 from the centre.
        let (x, _) = c.px([1.0, 0.0, 0.0], 3840.0);
        assert!((x - (1925.5 + 1000.0 * std::f64::consts::FRAC_PI_2)).abs() < 1e-6);
        let (x2, _) = c.px([1.0, 0.0, 0.0], 1920.0);
        assert!(((x2 + 0.5) * 2.0 - (x + 0.5)).abs() < 1e-6);
        // ffmpeg's plain fisheye agrees at the seam.
        let (size, left, top, fov) = c.plain();
        let half = size / 2.0 * 3840.0;
        assert!((left * 3840.0 + half - 1926.0).abs() < 1e-6 && (top * 3840.0 + half - 1920.0).abs() < 1e-6);
        let r90 = half * (90.0 / (fov / 2.0));
        assert!((r90 - 1000.0 * std::f64::consts::FRAC_PI_2).abs() < 1e-6);
    }

    #[test]
    fn an_out_of_place_attitude_clock_is_skipped() {
        let mut c = Clock::default();
        assert!(c.fits(Some(1_000_000)) && c.fits(Some(1_033_000)));
        // Far back: dropped; the next one fits again.
        assert!(!c.fits(Some(400_000)));
        assert!(c.fits(Some(1_066_000)));
        assert!(c.fits(None));
        // A clock that really moved is followed after a while.
        let mut last = true;
        for i in 0..32 { last = c.fits(Some(100_000 + i * 33_000)); }
        assert!(last);
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
    /// A real Osmo 360 original (REELCUT_REAL_OSV, read only): its gyro is found and lined up with
    /// the picture, so stabilisation does not fall back to analysing every frame.
    /// How much a still view moves from frame to frame with each mode, on a real recording. The
    /// pictures go to REELCUT_DIAG_DIR on this PC only (raw luma; delete them afterwards).
    #[test]
    fn real_stab_motion() {
        let (Ok(path), Ok(dir), Ok(md)) = (std::env::var("REELCUT_REAL_OSV"), std::env::var("REELCUT_DIAG_DIR"), std::env::var("REELCUT_MOTION_DIR")) else { return };
        let bin = |n: &str| std::path::PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join(n);
        let info = crate::media::inspect(&bin("ffprobe"), &path).unwrap();
        let st: crate::stitch::Stitch = serde_json::from_value(serde_json::json!({ "on": true, "fov": 193.4, "yaw": 0.85, "pitch": 0.15, "roll": -0.45, "calibrated": true, "flow": false })).unwrap();
        let key = std::env::var("REELCUT_MOTION_KEY").unwrap();
        let t = std::fs::read_to_string(std::path::Path::new(&md).join(format!("{key}{TRACK_FILE}"))).unwrap();
        let m: Motion = serde_json::from_str(&t).unwrap();
        println!("STAB motion source {} note {} fps {} frames {} readout {} down {:?}", m.source, m.note, m.fps, m.rot.len(), m.readout, m.down);
        std::fs::create_dir_all(&dir).unwrap();
        let (w, h) = (640u32, 360u32);
        for (start, tag) in [(30.0, "s030"), (295.0, "f295"), (420.0, "b"), (700.0, "s700"), (1000.0, "s1000")] {
            for mode in ["off", "horizon", "smooth", "eis"] {
                let lens = Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: Some(st.clone()), stab: Some(Stab { mode: mode.into(), strength: 1.0, rs: false }) };
                let s = crate::stitch::params(&lens);
                let stab = stab_of(&lens);
                let tg = targets(&m, &stab);
                let mut src = source_for(&info, &lens, start, 4.0, Some(1024), false);
                src.gpu = true;
                let mut st2 = Stitcher::new(&s, src.n() as f64, w as usize, h as usize, false, None);
                let k0 = (start * src.fps).round() as usize;
                let rot = matrix(ypr(0.0, -10.0, 0.0));
                let view = move |_t: f64| (rot, Some((91.0, 0.3)));
                let setup = setup_fn(Some(&m), &tg, k0, &stab, &view);
                let mut raw: Vec<u8> = vec![];
                let mut cb = |_k: usize, f: &Frame<u8>| raw.extend_from_slice(&f.p[0]);
                pano::run::<u8>(&bin("ffmpeg"), &Jobs::default(), "t", 0, &src, &mut st2, &setup, Sink::Call(&mut cb), |_| {}).unwrap();
                std::fs::write(std::path::Path::new(&dir).join(format!("{tag}-{mode}.y")), &raw).unwrap();
                // Does the preview's turn equal the export's?
                let q = stab_track(&m, &stab);
                if !q.is_empty() {
                    let i = k0 + 30;
                    let e = mmul(&mt(&m.at(i)), &tg[i]);
                    let [qw, qx, qy, qz] = q[i].map(|v| v as f64);
                    let rq = |v: [f64; 3]| { let u = [qx, qy, qz]; let c = |a: [f64; 3], b: [f64; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; let t = c(u, v).map(|x| 2.0 * x); let d = c(u, t); [v[0] + qw * t[0] + d[0], v[1] + qw * t[1] + d[1], v[2] + qw * t[2] + d[2]] };
                    let v = [0.3, 0.5, 0.8];
                    let (a, b) = (mv(&e, v), rq(v));
                    println!("STAB {tag} {mode}: export turn {a:?} preview quaternion {b:?}");
                }
            }
        }
    }

    #[test]
    fn real_osmo_gyro() {
        let Ok(path) = std::env::var("REELCUT_REAL_OSV") else { return };
        let bin = |n: &str| std::path::PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join(n);
        let info = crate::media::inspect(&bin("ffprobe"), &path).unwrap();
        let t0 = std::time::Instant::now();
        let (samples, readout, top, product) = read_gyro(&bin("ffprobe"), &info).unwrap();
        println!("gyro: {} samples, readout {:.2} ms, top {top:?}, product {product:?}, {:.1}s", samples.len(), readout * 1000.0, t0.elapsed().as_secs_f64());
        assert!(samples.len() as f64 > info.duration * info.fps * 0.9);
        let t1 = std::time::Instant::now();
        let lens = Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: None, stab: None };
        let m = analyze(&bin("ffmpeg"), &bin("ffprobe"), &Jobs::default(), "t", 0, &info, &lens, |_| {}).unwrap();
        println!("analysis: {} ({}), {} frames, {:.1}s", m.source, m.note, m.rot.len(), t1.elapsed().as_secs_f64());
        assert_eq!(m.source, "gyro", "{}", m.note);
    }

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
        let view = |_t: f64| crate::media::View { yaw: 30.0, pitch: 0.0, roll: 0.0, hfov: 90.0, dist: 0.0 };
        let jitter = |name: &str, l: &Lens, m: Option<&Motion>| {
            let out = work.join(name);
            render_flat(&ffmpeg, &jobs, "t", 0, &info, l, m, 0.5, 3.0, 1.0, 640, 360, &FlatOptions::default(), &view, &out, |_| {}).unwrap();
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
    }
}
