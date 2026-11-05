//! 360 view maths shared with the TypeScript side (src/framing.ts): views made safe for ffmpeg and
//! the engine (yaw/roll wrapped, pitch and field of view clamped) and smooth key interpolation
//! (shape-preserving cubic, the same formula as scipy's PchipInterpolator, yaw unwrapped so it
//! goes the short way round). Both sides are checked against tests/fixtures/framing.json.

use crate::media::View;
use crate::render::ViewKey;

pub const MAX_KEYS: usize = 20000;
pub const PITCH_LIMIT: f64 = 89.0;
pub const FOV_MIN: f64 = 20.0;
pub const FOV_MAX: f64 = 160.0;

fn r3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// Any angle into [-180, 180] (180 stays 180, as in the TypeScript version).
pub fn wrap180(a: f64) -> f64 {
    if !a.is_finite() {
        return 0.0;
    }
    let w = (a + 180.0).rem_euclid(360.0) - 180.0;
    if w == -180.0 && a > 0.0 { 180.0 } else { w }
}

fn finite(x: f64, d: f64) -> f64 {
    if x.is_finite() { x } else { d }
}

/// A view ffmpeg's v360 and the engine accept: yaw/roll wrapped, pitch within ±89°, hfov 20–160°.
pub fn norm_view(v: &View) -> View {
    View {
        yaw: r3(wrap180(finite(v.yaw, 0.0))),
        pitch: r3(finite(v.pitch, 0.0).clamp(-PITCH_LIMIT, PITCH_LIMIT)),
        roll: r3(wrap180(finite(v.roll, 0.0))),
        hfov: r3(finite(v.hfov, 100.0).clamp(FOV_MIN, crate::proj::fov_max(finite(v.dist, 0.0)))),
        dist: r3(finite(v.dist, 0.0).clamp(0.0, 1.0)),
    }
}

/// Sorted, de-duplicated (within 1 ms), normalised keys, at most MAX_KEYS.
pub fn clean_keys(keys: &[ViewKey]) -> Vec<ViewKey> {
    let mut ks: Vec<ViewKey> = keys.iter().filter(|k| k.t.is_finite()).map(|k| ViewKey { t: r3(k.t.max(0.0)), view: norm_view(&k.view) }).collect();
    ks.sort_by(|a, b| a.t.total_cmp(&b.t));
    let mut out: Vec<ViewKey> = Vec::with_capacity(ks.len());
    for k in ks {
        match out.last_mut() {
            Some(l) if k.t - l.t < 0.001 => *l = k,
            _ => out.push(k),
        }
    }
    out.truncate(MAX_KEYS);
    out
}

/// Slopes of the shape-preserving cubic Hermite interpolant (scipy's PchipInterpolator).
pub fn pchip_slopes(x: &[f64], y: &[f64]) -> Vec<f64> {
    let n = x.len();
    if n < 2 {
        return vec![0.0; n];
    }
    let h: Vec<f64> = (0..n - 1).map(|i| x[i + 1] - x[i]).collect();
    let d: Vec<f64> = (0..n - 1).map(|i| (y[i + 1] - y[i]) / h[i]).collect();
    if n == 2 {
        return vec![d[0], d[0]];
    }
    let mut m = vec![0.0; n];
    for i in 1..n - 1 {
        if d[i - 1] * d[i] > 0.0 {
            let (w1, w2) = (2.0 * h[i] + h[i - 1], h[i] + 2.0 * h[i - 1]);
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
        }
    }
    let sign = |v: f64| if v > 0.0 { 1.0 } else if v < 0.0 { -1.0 } else { 0.0 };
    let edge = |h0: f64, h1: f64, d0: f64, d1: f64| {
        let s = ((2.0 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
        if sign(s) != sign(d0) {
            0.0
        } else if sign(d0) != sign(d1) && s.abs() > 3.0 * d0.abs() {
            3.0 * d0
        } else {
            s
        }
    };
    m[0] = edge(h[0], h[1], d[0], d[1]);
    m[n - 1] = edge(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
    m
}

/// The PCHIP curve at `t`; values are held outside the range.
pub fn pchip_at(x: &[f64], y: &[f64], m: &[f64], t: f64) -> f64 {
    let n = x.len();
    if n == 0 {
        return 0.0;
    }
    if t <= x[0] {
        return y[0];
    }
    if t >= x[n - 1] {
        return y[n - 1];
    }
    let hi = x.partition_point(|v| *v <= t).clamp(1, n - 1);
    let lo = hi - 1;
    let h = x[hi] - x[lo];
    let s = (t - x[lo]) / h;
    let (s2, s3) = (s * s, s * s * s);
    (2.0 * s3 - 3.0 * s2 + 1.0) * y[lo] + (s3 - 2.0 * s2 + s) * h * m[lo] + (-2.0 * s3 + 3.0 * s2) * y[hi] + (s3 - s2) * h * m[hi]
}

/// Yaw made continuous (no 360° jumps) so it can be interpolated.
pub fn unwrap_yaw(yaws: &[f64]) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::with_capacity(yaws.len());
    for &y in yaws {
        match out.last() {
            None => out.push(y),
            Some(&p) => {
                let mut d = y - p;
                d -= 360.0 * (d / 360.0).round();
                out.push(p + d);
            }
        }
    }
    out
}

/// A key list prepared once so it can be sampled many times (every frame of an export).
pub struct Curve {
    x: Vec<f64>,
    ch: [Vec<f64>; 5],
    m: [Vec<f64>; 5],
}

impl Curve {
    pub fn new(keys: &[ViewKey]) -> Curve {
        let ks = clean_keys(keys);
        let x: Vec<f64> = ks.iter().map(|k| k.t).collect();
        let ch = [unwrap_yaw(&ks.iter().map(|k| k.view.yaw).collect::<Vec<_>>()), ks.iter().map(|k| k.view.pitch).collect(), ks.iter().map(|k| k.view.roll).collect(), ks.iter().map(|k| k.view.hfov).collect(), ks.iter().map(|k| k.view.dist).collect()];
        let m = [pchip_slopes(&x, &ch[0]), pchip_slopes(&x, &ch[1]), pchip_slopes(&x, &ch[2]), pchip_slopes(&x, &ch[3]), pchip_slopes(&x, &ch[4])];
        Curve { x, ch, m }
    }
    pub fn is_empty(&self) -> bool {
        self.x.is_empty()
    }
    pub fn at(&self, t: f64) -> View {
        if self.x.is_empty() {
            return norm_view(&View { yaw: 0.0, pitch: 0.0, roll: 0.0, hfov: 100.0, dist: 0.0 });
        }
        let v = |i: usize| pchip_at(&self.x, &self.ch[i], &self.m[i], t);
        norm_view(&View { yaw: v(0), pitch: v(1), roll: v(2), hfov: v(3), dist: v(4) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn view(v: &Value) -> View {
        serde_json::from_value(v.clone()).unwrap()
    }

    /// Same answers as src/framing.ts on the shared fixture.
    #[test]
    fn matches_the_typescript_fixture() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/framing.json");
        let fx: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let keys: Vec<ViewKey> = serde_json::from_value(fx["keys"].clone()).unwrap();
        let c = Curve::new(&keys);
        for case in fx["cases"].as_array().unwrap() {
            let (t, want) = (case["t"].as_f64().unwrap(), view(&case["view"]));
            let got = c.at(t);
            for (a, b, name) in [(got.yaw, want.yaw, "yaw"), (got.pitch, want.pitch, "pitch"), (got.roll, want.roll, "roll"), (got.hfov, want.hfov, "hfov")] {
                let d = if name == "yaw" { wrap180(a - b).abs() } else { (a - b).abs() };
                assert!(d < 0.01, "t={t} {name}: got {a}, want {b}");
            }
        }
        for case in fx["norm"].as_array().unwrap() {
            let (got, want) = (norm_view(&view(&case["in"])), view(&case["out"]));
            assert_eq!((got.yaw, got.pitch, got.roll, got.hfov), (want.yaw, want.pitch, want.roll, want.hfov));
        }
    }

    #[test]
    fn wraps_like_typescript() {
        assert_eq!(wrap180(195.0), -165.0);
        assert_eq!(wrap180(-190.0), 170.0);
        assert_eq!(wrap180(540.0), 180.0);
        assert_eq!(wrap180(-180.0), -180.0);
        assert_eq!(wrap180(f64::NAN), 0.0);
    }

    #[test]
    fn dense_keys_are_cheap() {
        // 20 000 keys at 0.1 s; sampling every frame of the 33 minutes stays well under a second.
        let keys: Vec<ViewKey> = (0..20000).map(|i| ViewKey { t: i as f64 * 0.1, view: View { yaw: (i as f64 * 7.0) % 400.0 - 200.0, pitch: 10.0, roll: 0.0, hfov: 90.0, dist: 0.0 } }).collect();
        let t0 = std::time::Instant::now();
        let c = Curve::new(&keys);
        let mut acc = 0.0;
        for f in 0..(2000.0 * 30.0) as usize {
            acc += c.at(f as f64 / 30.0).yaw;
        }
        assert!(acc.is_finite());
        assert!(t0.elapsed().as_secs_f64() < 2.0, "{:?}", t0.elapsed());
    }
}
