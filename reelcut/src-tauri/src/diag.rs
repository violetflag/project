//! Does the export's seam match the live preview's on a real file? Renders the same moment and view
//! both ways and reports numbers only. The pictures stay in memory.
//!
//! The preview's view is drawn here the way its shader draws it (gl360.ts), not with ffmpeg's v360:
//! v360 reads an equirect picture a quarter pixel off at the sides, which looks like a seam shift.

use crate::media::{Lens, MediaInfo};
use crate::{ff, live, motion, stitch};
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;

const W: usize = 960;
const H: usize = 540;
const SW: usize = 2048;
const SH: usize = 1024;

/// Luma of the sphere the live preview plays.
fn preview_sphere(ffmpeg: &Path, info: &MediaInfo, lens: &Lens, t: f64, dir: &Path) -> Result<Vec<u8>, String> {
    let raw = dir.join("preview.yuv");
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", &format!("{t:.3}"), "-i", &info.path].iter().map(|x| x.to_string()).collect();
    a.extend(live::picture(info, Some(lens)));
    a.extend(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p"].iter().map(|x| x.to_string()));
    a.push(raw.to_string_lossy().into_owned());
    let o = ff::command(ffmpeg).args(&a).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(crate::logs::tail_lines(&String::from_utf8_lossy(&o.stderr), 3));
    }
    let mut y = std::fs::read(&raw).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&raw);
    if y.len() < SW * SH {
        return Err("미리보기 그림이 없습니다".into());
    }
    y.truncate(SW * SH);
    Ok(y)
}

/// A flat view of the sphere: the shader's directions and its bilinear lookup.
fn preview_view(sphere: &[u8], rot: &crate::pano::M3, hfov: f64) -> Vec<f32> {
    let tx = (hfov.to_radians() / 2.0).tan();
    let ty = tx * H as f64 / W as f64;
    let mut out = vec![0f32; W * H];
    for y in 0..H {
        for x in 0..W {
            let v = [(2.0 * (x as f64 + 0.5) / W as f64 - 1.0) * tx, (2.0 * (y as f64 + 0.5) / H as f64 - 1.0) * ty, 1.0];
            let l = (v[0] * v[0] + v[1] * v[1] + 1.0).sqrt();
            let d = crate::pano::mv(rot, [v[0] / l, v[1] / l, v[2] / l]);
            let u = (d[0].atan2(d[2]) / std::f64::consts::PI + 1.0) / 2.0 * SW as f64 - 0.5;
            let w = (d[1].clamp(-1.0, 1.0).asin() / std::f64::consts::FRAC_PI_2 + 1.0) / 2.0 * SH as f64 - 0.5;
            let (x0, y0) = (u.floor(), w.floor());
            let (fx, fy) = ((u - x0) as f32, (w - y0) as f32);
            let at = |c: i64, r: i64| sphere[r.clamp(0, SH as i64 - 1) as usize * SW + c.rem_euclid(SW as i64) as usize] as f32;
            let (c, r) = (x0 as i64, y0 as i64);
            out[y * W + x] = (at(c, r) * (1.0 - fx) + at(c + 1, r) * fx) * (1.0 - fy) + (at(c, r + 1) * (1.0 - fx) + at(c + 1, r + 1) * fx) * fy;
        }
    }
    out
}

/// A picture at half the size (2×2 averages).
fn halve(p: &[f32], w: usize, h: usize) -> Vec<f32> {
    let (w2, h2) = (w / 2, h / 2);
    let mut out = vec![0f32; w2 * h2];
    for y in 0..h2 {
        for x in 0..w2 {
            let i = 2 * y * w + 2 * x;
            out[y * w2 + x] = (p[i] + p[i + 1] + p[i + w] + p[i + w + 1]) / 4.0;
        }
    }
    out
}

/// PSNR between columns `x0..x1`; 99 for identical pictures.
fn psnr(a: &[f32], b: &[f32], w: usize, x0: usize, x1: usize) -> f64 {
    let (mut e, mut n) = (0f64, 0f64);
    for (ra, rb) in a.chunks(w).zip(b.chunks(w)) {
        for (p, q) in ra[x0..x1].iter().zip(&rb[x0..x1]) {
            let d = (*p - *q) as f64;
            e += d * d;
            n += 1.0;
        }
    }
    if e <= 0.0 { 99.0 } else { 10.0 * (255.0f64 * 255.0 / (e / n)).log10() }
}

/// PSNR of the whole picture and of the band around the seam, at each time and view: as they are,
/// then with both at half size (`soft_*`, the export's extra sharpness is intended and is not a
/// seam difference). `bright` is how much brighter the export is, in 8-bit steps. Both paths run
/// without stabilisation so that the views line up.
pub fn parity(ffmpeg: &Path, jobs: &ff::Jobs, info: &MediaInfo, lens: &Lens, times: &[f64], yaws: &[f64], dir: &Path) -> Result<Vec<Value>, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut flat = lens.clone();
    flat.stab = Some(motion::Stab { mode: "off".into(), ..Default::default() });
    let band = stitch::blend_width(stitch::params(lens).fov.clamp(181.0, 260.0));
    let hfov = 100.0;
    let mut rows = Vec::new();
    let gen = jobs.generation("diag");
    for &t in times {
        let sphere = preview_sphere(ffmpeg, info, &flat, t, dir)?;
        for &yaw in yaws {
            let rot = stitch::matrix(stitch::ypr(yaw, -10.0, 0.0));
            let live = preview_view(&sphere, &rot, hfov);
            let mut eng: Vec<f32> = vec![];
            motion::look_at(ffmpeg, jobs, "diag", gen, info, &flat, None, &[(t, rot, Some((hfov, 0.0)))], W as u32 * 2, H as u32 * 2, &mut |_, _, f| {
                if eng.is_empty() {
                    eng = f.p[0].iter().map(|v| *v as f32).collect();
                }
            })?;
            if eng.is_empty() {
                return Err("엔진 그림이 없습니다".into());
            }
            // The export's picture at the preview's size: that is what the numbers compare.
            let eng = halve(&eng, W * 2, H * 2);
            // Middle of the frame, as wide as the blend plus a margin.
            let px = ((band * 1.5 / hfov * W as f64) as usize).clamp(32, W) & !1;
            let (x0, x1) = ((W - px) / 2, (W + px) / 2);
            let (sa, sb) = (halve(&live, W, H), halve(&eng, W, H));
            let bright = eng.iter().zip(&live).map(|(a, b)| (a - b) as f64).sum::<f64>() / (W * H) as f64;
            rows.push(json!({
                "t": t, "yaw": yaw,
                "psnr": psnr(&live, &eng, W, 0, W), "band_psnr": psnr(&live, &eng, W, x0, x1),
                "soft_psnr": psnr(&sa, &sb, W / 2, 0, W / 2), "soft_band_psnr": psnr(&sa, &sb, W / 2, x0 / 2, x1 / 2),
                "bright": bright,
            }));
        }
    }
    let _ = std::fs::remove_dir_all(dir);
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn psnr_of_a_known_difference() {
        let a = vec![100f32; 16];
        assert_eq!(psnr(&a, &a, 4, 0, 4), 99.0);
        let b = vec![101f32; 16];
        assert!((psnr(&a, &b, 4, 0, 4) - 48.13).abs() < 0.01);
        assert_eq!(halve(&b, 4, 4), vec![101f32; 4]);
    }

    #[test]
    fn the_preview_view_looks_where_the_engine_looks() {
        // A sphere with one bright column at longitude 90: straight ahead of a view turned that way.
        let mut s = vec![0u8; SW * SH];
        let col = SW * 3 / 4;
        for r in 0..SH {
            s[r * SW + col] = 255;
            s[r * SW + col - 1] = 255;
        }
        let rot = stitch::matrix(stitch::ypr(90.0, 0.0, 0.0));
        let v = preview_view(&s, &rot, 100.0);
        let row = &v[(H / 2) * W..(H / 2 + 1) * W];
        let best = row.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0 as i64;
        assert!((best - W as i64 / 2).abs() <= 2, "{best}");
    }

    /// A real recording (REELCUT_REAL_OSV, read only; REELCUT_DIAG_DIR for the working file).
    #[test]
    fn real_parity() {
        let (Ok(path), Ok(dir)) = (std::env::var("REELCUT_REAL_OSV"), std::env::var("REELCUT_DIAG_DIR")) else { return };
        let bin = |n: &str| std::path::PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join(n);
        let info = crate::media::inspect(&bin("ffprobe"), &path).unwrap();
        let stitch = serde_json::from_value(json!({ "on": true, "fov": 193.4, "yaw": 0.85, "pitch": 0.15, "roll": -0.45, "gain_a": [0.976, 0.431, -0.267], "gain_b": [1.025, -0.431, 0.267], "calibrated": true, "before": 21.17, "after": 8.58, "flow": true })).unwrap();
        let lens = Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: Some(stitch), stab: None };
        let rows = parity(&bin("ffmpeg"), &ff::Jobs::default(), &info, &lens, &[270.0, 290.0, 600.0], &[90.0, -90.0], Path::new(&dir)).unwrap();
        println!("{}", serde_json::to_string(&rows).unwrap());
    }
}
