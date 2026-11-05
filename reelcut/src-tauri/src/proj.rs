//! The flat view's projection, shared with the preview (src/proj.ts, src/gl360.ts): a general
//! perspective with `d` from 0 (rectilinear, straight lines stay straight) to 1 (stereographic,
//! shapes stay natural at wide angles). Radius of a ray `a` radians from the view axis:
//! r(a, d) = (1 + d)·sin a / (d + cos a).

pub fn r_of(a: f64, d: f64) -> f64 {
    (1.0 + d) * a.sin() / (d + a.cos())
}

/// The angle whose radius is `rho`.
pub fn a_of(rho: f64, d: f64) -> f64 {
    let k = rho / (1.0 + d);
    k.atan() + (k * d / (1.0 + k * k).sqrt()).clamp(-1.0, 1.0).asin()
}

/// The widest view that still makes sense at this `d`, degrees (160 at d = 0).
pub fn fov_max(d: f64) -> f64 {
    (2.0 * (-d.clamp(0.0, 1.0)).acos().to_degrees() - 20.0).min(330.0)
}

/// Half-width of the picture in projection units.
pub fn r_edge(hfov: f64, d: f64) -> f64 {
    r_of((hfov.clamp(1.0, fov_max(d)) / 2.0).to_radians(), d)
}

/// The direction a picture point looks along: u, v in −1..1 (right, down), z forward.
pub fn view_dir(u: f64, v: f64, r_e: f64, d: f64, h_over_w: f64) -> [f64; 3] {
    let (px, py) = (u * r_e, v * r_e * h_over_w);
    let rho = px.hypot(py);
    if rho < 1e-9 {
        return [0.0, 0.0, 1.0];
    }
    let a = a_of(rho, d);
    let (s, c) = a.sin_cos();
    [px / rho * s, py / rho * s, c]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn radius_and_angle_are_inverse() {
        for d in [0.0, 0.3, 0.6, 1.0] {
            for a in [0.1f64, 0.5, 1.0, 1.4] {
                assert!((a_of(r_of(a, d), d) - a).abs() < 1e-9, "{a} {d}");
            }
        }
    }

    #[test]
    fn zero_is_the_ordinary_flat_view() {
        let re = r_edge(90.0, 0.0);
        assert!((re - 1.0).abs() < 1e-12);
        let v = view_dir(1.0, 0.0, re, 0.0, 9.0 / 16.0);
        assert!((v[0] - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-9 && v[1].abs() < 1e-12);
    }

    #[test]
    fn the_limit_widens_with_d() {
        assert!((fov_max(0.0) - 160.0).abs() < 1e-9);
        assert_eq!(fov_max(1.0), 330.0);
    }

    /// Same answers as src/proj.ts on the shared fixture.
    #[test]
    fn matches_the_typescript_fixture() {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/proj.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let n = |r: &serde_json::Value, k: &str| r[k].as_f64().unwrap_or(0.0);
        for r in v["dir"].as_array().unwrap() {
            let got = view_dir(n(r, "u"), n(r, "v"), r_edge(n(r, "hfov"), n(r, "d")), n(r, "d"), n(r, "hw"));
            let want = r["dir"].as_array().unwrap();
            for i in 0..3 {
                assert!((got[i] - want[i].as_f64().unwrap()).abs() < 1e-6, "{r}");
            }
        }
        for r in v["fov_max"].as_array().unwrap() {
            assert!((fov_max(n(r, "d")) - n(r, "max")).abs() < 1e-6, "{r}");
        }
    }
}
