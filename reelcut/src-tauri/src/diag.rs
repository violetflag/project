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

/// Luma of the two lenses side by side, as the live preview's stream carries them.
fn preview_lenses(ffmpeg: &Path, info: &MediaInfo, lens: &Lens, t: f64, dir: &Path) -> Result<Vec<u8>, String> {
    let raw = dir.join("preview.yuv");
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", &format!("{t:.3}"), "-i", &info.path].iter().map(|x| x.to_string()).collect();
    a.extend(live::picture_lenses(info, Some(lens), false, false).ok_or("이어 붙이는 영상이 아닙니다")?);
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

/// A flat view of the two lenses: the shader's directions, lens lookup and seam (gl360.ts).
fn preview_view(pic: &[u8], geo: &crate::pano::Geo, blend: f64, rot: &crate::pano::M3, hfov: f64) -> Vec<f32> {
    let tx = (hfov.to_radians() / 2.0).tan();
    let ty = tx * H as f64 / W as f64;
    let n = SH as i64;
    let at = |lens: i64, x: f64, y: f64| -> f32 {
        let (x0, y0) = (x.floor(), y.floor());
        let (fx, fy) = ((x - x0) as f32, (y - y0) as f32);
        let p = |c: i64, r: i64| pic[r.clamp(0, n - 1) as usize * SW + (c.clamp(0, n - 1) + lens * n) as usize] as f32;
        let (c, r) = (x0 as i64, y0 as i64);
        (p(c, r) * (1.0 - fx) + p(c + 1, r) * fx) * (1.0 - fy) + (p(c, r + 1) * (1.0 - fx) + p(c + 1, r + 1) * fx) * fy
    };
    let mut out = vec![0f32; W * H];
    for y in 0..H {
        for x in 0..W {
            let v = [(2.0 * (x as f64 + 0.5) / W as f64 - 1.0) * tx, (2.0 * (y as f64 + 0.5) / H as f64 - 1.0) * ty, 1.0];
            let l = (v[0] * v[0] + v[1] * v[1] + 1.0).sqrt();
            let d = crate::pano::mv(rot, [v[0] / l, v[1] / l, v[2] / l]);
            let f = stitch::front_weight(d[2].clamp(-1.0, 1.0).asin().to_degrees(), blend) as f32;
            let (ax, ay, _) = geo.px(0, d);
            let (bx, by, _) = geo.px(1, d);
            out[y * W + x] = at(0, ax, ay) * (1.0 - f) + at(1, bx, by) * f;
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
    let geo = crate::pano::Geo::new(&stitch::params(lens), SH as f64);
    let mut rows = Vec::new();
    let gen = jobs.generation("diag");
    for &t in times {
        let pic = preview_lenses(ffmpeg, info, &flat, t, dir)?;
        for &yaw in yaws {
            let rot = stitch::matrix(stitch::ypr(yaw, -10.0, 0.0));
            let live = preview_view(&pic, &geo, band, &rot, hfov);
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
        // A white column down the middle of the front lens (the right half): straight ahead.
        let mut s = vec![0u8; SW * SH];
        let col = SW * 3 / 4;
        for r in 0..SH {
            s[r * SW + col] = 255;
            s[r * SW + col - 1] = 255;
        }
        let st = stitch::Stitch { fov: 195.0, ..Default::default() };
        let geo = crate::pano::Geo::new(&st, SH as f64);
        let v = preview_view(&s, &geo, stitch::blend_width(195.0), &crate::pano::I3, 100.0);
        let mid = H / 2 * W + W / 2;
        assert!(v[mid] > 100.0 && v[mid - 40] < 5.0 && v[mid + 40] < 5.0, "{} {} {}", v[mid - 40], v[mid], v[mid + 40]);
    }

    /// Reading back part of the lenses must not change a pixel (a real recording, Quick Sync).
    #[test]
    fn real_crop_changes_nothing() {
        let Ok(path) = std::env::var("REELCUT_REAL_OSV") else { return };
        let bin = |n: &str| std::path::PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join(n);
        let info = crate::media::inspect(&bin("ffprobe"), &path).unwrap();
        let st: stitch::Stitch = serde_json::from_value(json!({ "on": true, "fov": 193.4, "yaw": 0.85, "pitch": 0.15, "roll": -0.45, "gain_a": [0.976, 0.431, -0.267], "gain_b": [1.025, -0.431, 0.267], "calibrated": true, "before": 21.17, "after": 8.58, "flow": false })).unwrap();
        let lens = Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: Some(st), stab: None };
        let s = stitch::params(&lens);
        for (start, dur, yaw0, turn, hfov) in [(270.0, 2.0, 70.0, 0.3, 91.0), (600.0, 2.0, 180.0, 0.3, 91.0), (290.0, 2.0, 0.0, 0.3, 118.0), (400.0, 21.0, 0.0, 0.6, 91.0)] {
            let run = |crop: bool| {
                let mut src = motion::source_for(&info, &lens, start, dur, None, false);
                src.gpu = true;
                src.crop = crop;
                let mut pics: Vec<Vec<f32>> = vec![];
                let mut count = 0usize;
                let mut stitcher = crate::pano::Stitcher::new(&s, src.n() as f64, 1920, 1080, false, None);
                let setup = move |k: usize, _t: f64| crate::pano::FrameSetup { rot: stitch::matrix(stitch::ypr(yaw0 + k as f64 * turn, -15.0, 0.0)), hfov: Some((hfov, 0.3)), omega: None };
                let t = std::time::Instant::now();
                let mut cb = |k: usize, f: &crate::pano::Frame<u8>| {
                    count += 1;
                    // Around the joins too (240, 480).
                    if k % 20 == 0 || (235..245).contains(&k) || (475..485).contains(&k) {
                        pics.push(f.p[0].iter().map(|v| *v as f32).collect());
                    }
                };
                crate::pano::run::<u8>(&bin("ffmpeg"), &ff::Jobs::default(), "t", 0, &src, &mut stitcher, &setup, crate::pano::Sink::Call(&mut cb), |_| {}).unwrap();
                (pics, count, t.elapsed().as_secs_f64())
            };
            let (a, na, ta) = run(false);
            let (b, nb, tb) = run(true);
            // The final pass cuts to length: a spare frame is harmless, a missing one is not.
            assert!(nb == na || nb == na + 1, "{na} {nb}");
            assert!(b.len() >= a.len());
            let worst = a.iter().zip(&b).map(|(x, y)| psnr(x, y, 1920, 0, 1920)).fold(99.0, f64::min);
            println!("CROP start {start} yaw {yaw0} hfov {hfov}: {na} frames, full {ta:.1}s, cropped {tb:.1}s, worst {worst:.1} dB");
            assert!(worst >= 50.0, "{worst}");
        }
    }

    /// A real recording (REELCUT_REAL_OSV, read only; REELCUT_DIAG_DIR for the working file).
    #[test]
    fn real_parity() {
        let (Ok(path), Ok(dir)) = (std::env::var("REELCUT_REAL_OSV"), std::env::var("REELCUT_DIAG_DIR")) else { return };
        let bin = |n: &str| std::path::PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join(n);
        let info = crate::media::inspect(&bin("ffprobe"), &path).unwrap();
        let stitch = serde_json::from_value(json!({ "on": true, "fov": 193.4, "yaw": 0.85, "pitch": 0.15, "roll": -0.45, "gain_a": [0.976, 0.431, -0.267], "gain_b": [1.025, -0.431, 0.267], "calibrated": true, "before": 21.17, "after": 8.58, "flow": true })).unwrap();
        let mut lens = Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: Some(stitch), stab: None };
        if std::env::var("REELCUT_FACTORY").is_ok() {
            lens.stitch = Some(crate::stitch::calibrate(&bin("ffmpeg"), &bin("ffprobe"), &info, &lens).unwrap());
            println!("calibrated with factory values: {}", lens.stitch.as_ref().unwrap().factory.is_some());
        }
        let rows = parity(&bin("ffmpeg"), &ff::Jobs::default(), &info, &lens, &[270.0, 290.0, 600.0], &[90.0, -90.0], Path::new(&dir)).unwrap();
        println!("{}", serde_json::to_string(&rows).unwrap());
    }
}
