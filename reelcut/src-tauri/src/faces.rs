//! Finding and following people on a recording, offline: a small face detector (YuNet from the
//! OpenCV model zoo, MIT licence, built into the app and run with tract) on the level panorama, and
//! a head tracker that carries the AI's marks through the frames where a face is turned away.
//! Positions use the panorama sheet's scale: x 0–960 (azimuth −180..180), y 0–480 (240 = horizon).

use crate::pano::{Frame, Px};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tract_onnx::prelude::*;

const MODEL: &[u8] = include_bytes!("../models/face_detection_yunet_2023mar.onnx");
/// The model's input size (it takes BGR 0–255, channels first).
const SIZE: usize = 640;
const MIN_SCORE: f32 = 0.6;
const NMS_IOU: f32 = 0.3;

/// A face in pixels of whatever was searched (or on the sheet's scale, for the panorama).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Face {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub score: f32,
    /// How squarely the head points at the camera, 0–1, from the eyes and nose. This is head
    /// direction, not where the eyes look.
    #[serde(default)]
    pub front: f32,
}

/// Frontal when the nose sits between the eyes and the eyes are wide apart for the face's size.
fn frontal(kps: &[f32], fw: f32) -> f32 {
    let (ex0, ey0, ex1, ey1, nose) = (kps[0], kps[1], kps[2], kps[3], kps[4]);
    let d = ((ex1 - ex0).powi(2) + (ey1 - ey0).powi(2)).sqrt().max(1.0);
    let off = (nose - (ex0 + ex1) / 2.0).abs() / d;
    (1.0 - off / 0.45).clamp(0.0, 1.0) * (d / (fw * 0.3)).clamp(0.0, 1.0)
}

impl Face {
    pub fn cx(&self) -> f32 {
        self.x + self.w / 2.0
    }
    pub fn cy(&self) -> f32 {
        self.y + self.h / 2.0
    }
}

type Plan = SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>;

/// The detector, loaded on first use.
#[derive(Default)]
pub struct Detector {
    plan: Mutex<Option<(Plan, Vec<String>)>>,
}

impl Detector {
    fn with<R>(&self, f: impl FnOnce(&Plan, &[String]) -> Result<R, String>) -> Result<R, String> {
        let mut g = self.plan.lock();
        if g.is_none() {
            let e = |x: TractError| x.to_string();
            let mut bytes = MODEL;
            let model = tract_onnx::onnx().model_for_read(&mut bytes).map_err(e)?.with_input_fact(0, f32::fact([1, 3, SIZE, SIZE]).into()).map_err(e)?;
            let names: Vec<String> = model.output_outlets().map_err(e)?.iter().map(|o| model.outlet_label(*o).map(str::to_string).unwrap_or_else(|| model.node(o.node).name.clone())).collect();
            let plan = model.into_optimized().map_err(e)?.into_runnable().map_err(e)?;
            *g = Some((plan, names));
        }
        let (p, n) = g.as_ref().unwrap();
        f(p, n)
    }

    /// Faces in a BGR picture of at most 640×640 pasted at the top left.
    pub fn detect_bgr(&self, bgr: &[u8], w: usize, h: usize) -> Result<Vec<Face>, String> {
        let w2 = w.min(SIZE);
        let h2 = h.min(SIZE);
        let mut input = tract_ndarray::Array4::<f32>::zeros((1, 3, SIZE, SIZE));
        for y in 0..h2 {
            for x in 0..w2 {
                let i = (y * w + x) * 3;
                for c in 0..3 {
                    input[[0, c, y, x]] = bgr[i + c] as f32;
                }
            }
        }
        let tensor: Tensor = input.into();
        let outs = self.with(|p, _| p.run(tvec!(tensor.into())).map_err(|e| e.to_string()))?;
        // Outputs come as score, objectness, box and landmark maps for strides 8, 16, 32 (see the
        // model's output names); each map holds one row per cell.
        let faces = self.with(|_, names| {
            let mut out = Vec::new();
            for stride in [8usize, 16, 32] {
                let get = |prefix: &str| -> Result<&[f32], String> {
                    let name = format!("{prefix}_{stride}");
                    let i = names.iter().position(|n| *n == name || n.starts_with(&format!("{name}"))).ok_or(format!("{name} 없음"))?;
                    outs[i].as_slice::<f32>().map_err(|e| e.to_string())
                };
                let (cls, obj, bbox, kps) = (get("cls")?, get("obj")?, get("bbox")?, get("kps")?);
                let cols = SIZE / stride;
                for r in 0..cols {
                    for c in 0..cols {
                        let idx = r * cols + c;
                        let score = (cls[idx].clamp(0.0, 1.0) * obj[idx].clamp(0.0, 1.0)).sqrt();
                        if score < MIN_SCORE {
                            continue;
                        }
                        let s = stride as f32;
                        let cx = (c as f32 + bbox[idx * 4]) * s;
                        let cy = (r as f32 + bbox[idx * 4 + 1]) * s;
                        let (fw, fh) = (bbox[idx * 4 + 2].exp() * s, bbox[idx * 4 + 3].exp() * s);
                        let k = &kps[idx * 10..idx * 10 + 10];
                        let pts = [(c as f32 + k[0]) * s, (r as f32 + k[1]) * s, (c as f32 + k[2]) * s, (r as f32 + k[3]) * s, (c as f32 + k[4]) * s];
                        out.push(Face { x: cx - fw / 2.0, y: cy - fh / 2.0, w: fw, h: fh, score, front: frontal(&pts, fw) });
                    }
                }
            }
            Ok(out)
        })?;
        Ok(nms(faces))
    }

    /// Faces in a stitched picture, any size up to 640 wide.
    pub fn detect_frame<T: Px>(&self, f: &Frame<T>) -> Result<Vec<Face>, String> {
        let bgr = crop_bgr(f, 0, 0, f.w.min(SIZE), f.h.min(SIZE));
        self.detect_bgr(&bgr, f.w.min(SIZE), f.h.min(SIZE))
    }

    /// Faces on a level panorama (2:1), searched in overlapping tiles across the band where people
    /// are (45° up to 75° down), merged and given on the sheet's 960×480 scale.
    pub fn detect_sphere<T: Px>(&self, f: &Frame<T>) -> Result<Vec<Face>, String> {
        let (w, h) = (f.w, f.h);
        let tile = SIZE.min(w);
        let step = tile * 3 / 4;
        let y0 = (h / 4).min(h.saturating_sub(tile));
        let k = 960.0 / w as f32;
        let mut all = Vec::new();
        let mut x0 = 0;
        while x0 < w {
            let bgr = crop_bgr(f, x0, y0, tile, tile.min(h - y0));
            for m in self.detect_bgr(&bgr, tile, tile.min(h - y0))? {
                all.push(Face { x: (m.x + x0 as f32) * k, y: (m.y + y0 as f32) * k, w: m.w * k, h: m.h * k, score: m.score, front: m.front });
            }
            x0 += step;
        }
        for m in all.iter_mut() {
            m.x = m.x.rem_euclid(960.0);
        }
        Ok(nms(all))
    }
}

/// A region of a planar 4:2:0 picture as BGR bytes; x wraps round (panoramas).
pub fn crop_bgr<T: Px>(f: &Frame<T>, x0: usize, y0: usize, w: usize, h: usize) -> Vec<u8> {
    let mut out = vec![0u8; w * h * 3];
    let k = 255.0 / T::MAX;
    let (cw, _) = f.dims(1);
    for y in 0..h {
        let sy = y + y0;
        if sy >= f.h {
            break;
        }
        for x in 0..w {
            let sx = (x + x0) % f.w;
            let l = f.p[0][sy * f.w + sx].get() * k;
            let ci = (sy / 2) * cw + sx / 2;
            let (u, v) = (f.p[1][ci].get() * k - 128.0, f.p[2][ci].get() * k - 128.0);
            let o = (y * w + x) * 3;
            out[o] = (l + 1.772 * u).clamp(0.0, 255.0) as u8;
            out[o + 1] = (l - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
            out[o + 2] = (l + 1.402 * v).clamp(0.0, 255.0) as u8;
        }
    }
    out
}

fn iou(a: &Face, b: &Face) -> f32 {
    let (x0, y0) = (a.x.max(b.x), a.y.max(b.y));
    let (x1, y1) = ((a.x + a.w).min(b.x + b.w), (a.y + a.h).min(b.y + b.h));
    let i = (x1 - x0).max(0.0) * (y1 - y0).max(0.0);
    i / (a.w * a.h + b.w * b.h - i).max(1e-3)
}

fn nms(mut f: Vec<Face>) -> Vec<Face> {
    f.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut out: Vec<Face> = Vec::new();
    for m in f {
        if out.iter().all(|k| iou(k, &m) < NMS_IOU) {
            out.push(m);
        }
    }
    out
}

/// Which frame edge a face touches (its head may be cut): top, bottom, side.
pub fn edge_of(m: &Face, w: f32, h: f32) -> Option<&'static str> {
    if m.y < 0.04 * h {
        Some("top")
    } else if m.y + m.h > 0.97 * h {
        Some("bottom")
    } else if m.x < 0.02 * w || m.x + m.w > 0.98 * w {
        Some("side")
    } else {
        None
    }
}

// ---------------------------------------------------------------- following heads

/// One sampled moment of the level panorama: brightness at 960×480 and the faces found (if searched).
pub struct Sample {
    pub t: f64,
    pub luma: Vec<u8>,
    pub faces: Vec<Face>,
}

pub const TW: usize = 960;
pub const TH: usize = 480;

/// Brightness of a panorama frame at the tracker's 960×480 (box filter).
pub fn luma_small<T: Px>(f: &Frame<T>) -> Vec<u8> {
    let (fx, fy) = (f.w / TW, f.h / TH);
    let k = 255.0 / T::MAX;
    let mut out = vec![0u8; TW * TH];
    for y in 0..TH {
        for x in 0..TW {
            let mut s = 0.0;
            for j in 0..fy.max(1) {
                for i in 0..fx.max(1) {
                    s += f.p[0][(y * fy + j) * f.w + x * fx + i].get();
                }
            }
            out[y * TW + x] = (s * k / (fx.max(1) * fy.max(1)) as f32) as u8;
        }
    }
    out
}

const PATCH: i32 = 14; // half size of the head template on the 960 scale
const SEARCH: i32 = 18; // pixels a head may move between samples

fn patch_at(l: &[u8], cx: f32, cy: f32) -> Vec<f32> {
    let mut p = Vec::with_capacity(((2 * PATCH + 1) * (2 * PATCH + 1)) as usize);
    for dy in -PATCH..=PATCH {
        for dx in -PATCH..=PATCH {
            let x = (cx.round() as i32 + dx).rem_euclid(TW as i32) as usize;
            let y = (cy.round() as i32 + dy).clamp(0, TH as i32 - 1) as usize;
            p.push(l[y * TW + x] as f32);
        }
    }
    p
}

fn ncc(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len() as f32;
    let (ma, mb) = (a.iter().sum::<f32>() / n, b.iter().sum::<f32>() / n);
    let (mut s, mut sa, mut sb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        let (p, q) = (x - ma, y - mb);
        s += p * q;
        sa += p * p;
        sb += q * q;
    }
    if sa < 1.0 || sb < 1.0 { 0.0 } else { s / (sa * sb).sqrt() }
}

fn dist_x(a: f32, b: f32) -> f32 {
    let d = (a - b).rem_euclid(960.0);
    d.min(960.0 - d)
}

/// The face nearest a position, within `reach` pixels.
fn near_face(faces: &[Face], x: f32, y: f32, reach: f32) -> Option<Face> {
    faces.iter().map(|m| (*m, dist_x(m.cx(), x).hypot(m.cy() - y))).filter(|(_, d)| *d <= reach).min_by(|a, b| a.1.total_cmp(&b.1)).map(|(m, _)| m)
}

/// Follows one head from sample `i0` (position `p0`) towards `end` (exclusive, step ±1), through
/// template matching, snapping to detected faces. Returns (index, x, y) where it was sure.
fn follow(s: &[Sample], i0: usize, p0: (f32, f32), end: isize, dir: isize) -> Vec<(usize, f32, f32)> {
    let mut tpl = patch_at(&s[i0].luma, p0.0, p0.1);
    let (mut x, mut y) = p0;
    let mut out = Vec::new();
    let mut lost = 0;
    let mut i = i0 as isize + dir;
    while i != end {
        let cur = &s[i as usize];
        let reach = SEARCH + (lost * 6).min(60);
        let (mut best, mut bx, mut by) = (-1.0f32, x, y);
        for dy in (-reach..=reach).step_by(2) {
            for dx in (-reach..=reach).step_by(2) {
                let (cx, cy) = ((x + dx as f32).rem_euclid(960.0), (y + dy as f32).clamp(0.0, TH as f32 - 1.0));
                let score = ncc(&tpl, &patch_at(&cur.luma, cx, cy)) - 0.002 * (dx as f32).hypot(dy as f32);
                if score > best {
                    (best, bx, by) = (score, cx, cy);
                }
            }
        }
        let face = near_face(&cur.faces, bx, by, 26.0).or_else(|| if best < 0.45 { near_face(&cur.faces, x, y, (reach + 20) as f32) } else { None });
        if let Some(m) = face {
            (x, y) = (m.cx(), m.cy());
            tpl = patch_at(&cur.luma, x, y);
            lost = 0;
            out.push((i as usize, x, y));
        } else if best >= 0.45 {
            (x, y) = (bx, by);
            if best > 0.65 {
                let new = patch_at(&cur.luma, x, y);
                for (t, n) in tpl.iter_mut().zip(&new) {
                    *t = *t * 0.8 + n * 0.2;
                }
            }
            lost = 0;
            out.push((i as usize, x, y));
        } else {
            lost += 1;
        }
        i += dir;
    }
    out
}

/// A person's head path through the samples, from their seed marks: followed forwards and
/// backwards from each seed and blended between seeds. `(t, x, y)` where known.
pub fn track(s: &[Sample], seeds: &[(f64, f32, f32)]) -> Vec<(f64, f32, f32)> {
    if s.is_empty() || seeds.is_empty() {
        return Vec::new();
    }
    let idx = |t: f64| s.iter().enumerate().min_by(|a, b| (a.1.t - t).abs().total_cmp(&(b.1.t - t).abs())).map(|(i, _)| i).unwrap_or(0);
    let mut anchors: Vec<(usize, f32, f32)> = seeds.iter().map(|(t, x, y)| (idx(*t), *x, *y)).collect();
    anchors.sort_by_key(|a| a.0);
    anchors.dedup_by_key(|a| a.0);
    // A seed near a detected face starts from that face (marks are read by eye).
    for a in anchors.iter_mut() {
        if let Some(m) = near_face(&s[a.0].faces, a.1, a.2, 30.0) {
            (a.1, a.2) = (m.cx(), m.cy());
        }
    }
    let n = s.len();
    let mut fw: Vec<Option<(f32, f32)>> = vec![None; n];
    let mut bw: Vec<Option<(f32, f32)>> = vec![None; n];
    for (k, a) in anchors.iter().enumerate() {
        fw[a.0] = Some((a.1, a.2));
        bw[a.0] = Some((a.1, a.2));
        let next = anchors.get(k + 1).map(|b| b.0 as isize).unwrap_or(n as isize);
        for (i, x, y) in follow(s, a.0, (a.1, a.2), next, 1) {
            fw[i] = Some((x, y));
        }
        let prev = if k == 0 { -1 } else { anchors[k - 1].0 as isize };
        for (i, x, y) in follow(s, a.0, (a.1, a.2), prev, -1) {
            bw[i] = Some((x, y));
        }
    }
    let mut out = Vec::new();
    for i in 0..n {
        // Between two seeds lean on whichever one is nearer in time.
        let w = match anchors.iter().position(|a| a.0 >= i) {
            Some(0) | None => 0.5,
            Some(k) => {
                let (a, b) = (anchors[k - 1].0 as f32, anchors[k].0 as f32);
                ((i as f32 - a) / (b - a).max(1.0)).clamp(0.0, 1.0)
            }
        };
        let p = match (fw[i], bw[i]) {
            (Some(f), Some(b)) => {
                let d = (b.0 - f.0 + 480.0).rem_euclid(960.0) - 480.0;
                Some(((f.0 + d * w).rem_euclid(960.0), f.1 + (b.1 - f.1) * w))
            }
            (Some(f), None) => Some(f),
            (None, Some(b)) => Some(b),
            _ => None,
        };
        if let Some((x, y)) = p {
            out.push((s[i].t, x, y));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob(cx: f32, cy: f32) -> Vec<u8> {
        // Textured background with a dark round "head" at (cx, cy).
        let mut l = vec![0u8; TW * TH];
        for y in 0..TH {
            for x in 0..TW {
                let base = 120.0 + 40.0 * ((x as f32 * 0.31).sin() * (y as f32 * 0.17).cos());
                let d = dist_x(x as f32, cx).hypot(y as f32 - cy);
                let v = if d < 10.0 { 30.0 } else if d < 13.0 { 220.0 } else { base };
                l[y * TW + x] = v as u8;
            }
        }
        l
    }

    #[test]
    fn follows_a_moving_head_across_the_seam() {
        // 40 samples, moving 6 px per sample, wrapping past x = 960.
        let path = |i: usize| ((850.0 + i as f32 * 6.0).rem_euclid(960.0), 300.0 + i as f32);
        let s: Vec<Sample> = (0..40).map(|i| Sample { t: i as f64 * 0.2, luma: blob(path(i).0, path(i).1), faces: vec![] }).collect();
        let tr = track(&s, &[(0.0, path(0).0, path(0).1)]);
        assert!(tr.len() >= 38, "{}", tr.len());
        for (t, x, y) in &tr {
            let i = (t / 0.2).round() as usize;
            assert!(dist_x(*x, path(i).0) < 6.0 && (y - path(i).1).abs() < 6.0, "t {t}: {x},{y} vs {:?}", path(i));
        }
    }

    #[test]
    fn tells_a_frontal_head_from_a_turned_one() {
        // Eyes either side of the nose, wide apart: frontal. Nose out past one eye: turned.
        assert!(frontal(&[40.0, 50.0, 80.0, 50.0, 60.0], 100.0) > 0.9);
        assert!(frontal(&[40.0, 50.0, 60.0, 50.0, 62.0], 100.0) < 0.4);
    }

    #[test]
    fn snaps_to_faces_and_flags_edges() {
        let m = Face { x: 300.0, y: 2.0, w: 40.0, h: 50.0, score: 0.9, front: 1.0 };
        assert_eq!(edge_of(&m, 640.0, 360.0), Some("top"));
        assert_eq!(edge_of(&Face { y: 100.0, ..m }, 640.0, 360.0), None);
        assert_eq!(edge_of(&Face { y: 320.0, ..m }, 640.0, 360.0), Some("bottom"));
        assert_eq!(edge_of(&Face { x: 610.0, y: 100.0, ..m }, 640.0, 360.0), Some("side"));
        let f = near_face(&[m], 330.0, 30.0, 26.0).unwrap();
        assert_eq!(f.x, 300.0);
        assert!(near_face(&[m], 500.0, 30.0, 26.0).is_none());
    }

    /// The real detector on a real face picture from the test folder (REELCUT_FACE=<raw BGR 640x640 file>).
    #[test]
    fn detector_loads_and_runs() {
        let d = Detector::default();
        // A blank picture has no faces, and the model runs.
        let faces = d.detect_bgr(&vec![128u8; 640 * 640 * 3], 640, 640).unwrap();
        assert!(faces.is_empty(), "{faces:?}");
        if let Ok(p) = std::env::var("REELCUT_FACE") {
            let b = std::fs::read(p).unwrap();
            let faces = d.detect_bgr(&b, 640, 640).unwrap();
            println!("faces: {faces:?}");
            assert!(!faces.is_empty());
        }
    }
}
