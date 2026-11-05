//! Does the export's seam match the live preview's on a real file? Renders the same moment and view
//! both ways and reports numbers only. The pictures stay in the data folder's `diag` and are deleted.

use crate::media::{Lens, MediaInfo, View};
use crate::{ff, live, motion, stitch};
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;

const W: u32 = 960;
const H: u32 = 540;

fn psnr(ffmpeg: &Path, a: &Path, b: &Path, crop: Option<(u32, u32)>) -> Result<f64, String> {
    let c = crop.map(|(w, x)| format!("crop={w}:{H}:{x}:0,")).unwrap_or_default();
    let g = format!("[0]{c}format=gray[x];[1]{c}format=gray[y];[x][y]psnr");
    let o = ff::command(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-i"])
        .arg(a)
        .arg("-i")
        .arg(b)
        .args(["-lavfi", &g, "-f", "null", "-"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    let log = String::from_utf8_lossy(&o.stderr);
    parse_psnr(&log).ok_or_else(|| format!("psnr를 읽지 못했습니다: {}", crate::logs::tail_lines(&log, 2)))
}

fn parse_psnr(log: &str) -> Option<f64> {
    let tail = log.rsplit("average:").next()?;
    let v = tail.split_whitespace().next()?;
    if v == "inf" { Some(99.0) } else { v.parse().ok() }
}

/// The picture the live preview makes: the stitched sphere at the preview's size, then a flat view.
fn live_frame(ffmpeg: &Path, info: &MediaInfo, lens: &Lens, t: f64, view: &View, dir: &Path, name: &str) -> Result<std::path::PathBuf, String> {
    let sphere = dir.join(format!("{name}-sphere.png"));
    let out = dir.join(format!("{name}-live.png"));
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", &format!("{t:.3}"), "-i", &info.path].iter().map(|x| x.to_string()).collect();
    a.extend(live::picture(info, Some(lens)));
    a.extend(["-frames:v".to_string(), "1".to_string()]);
    a.push(sphere.to_string_lossy().into_owned());
    let o = ff::command(ffmpeg).args(&a).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(crate::logs::tail_lines(&String::from_utf8_lossy(&o.stderr), 3));
    }
    let vf = 2.0 * ((view.hfov.to_radians() / 2.0).tan() * H as f64 / W as f64).atan().to_degrees();
    let f = format!("v360=input=equirect:output=flat:yaw={}:pitch={}:h_fov={}:v_fov={vf:.3}:w={W}:h={H}:interp=linear", view.yaw, view.pitch, view.hfov);
    let o = ff::command(ffmpeg).args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i"]).arg(&sphere).args(["-vf", &f, "-frames:v", "1"]).arg(&out).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(crate::logs::tail_lines(&String::from_utf8_lossy(&o.stderr), 3));
    }
    Ok(out)
}

/// PSNR of the whole picture and of the band around the seam, at each time and view. Both paths
/// run without stabilisation so that the views line up; the export is scaled down to the preview's
/// sharpness first (its extra detail is intended).
pub fn parity(ffmpeg: &Path, jobs: &ff::Jobs, info: &MediaInfo, lens: &Lens, times: &[f64], yaws: &[f64], dir: &Path) -> Result<Vec<Value>, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut flat = lens.clone();
    flat.stab = Some(motion::Stab { mode: "off".into(), ..Default::default() });
    let band = stitch::blend_width(stitch::params(lens).fov.clamp(181.0, 260.0));
    let mut rows = Vec::new();
    let gen = jobs.generation("diag");
    for &t in times {
        for &yaw in yaws {
            let view = View { yaw, pitch: -10.0, roll: 0.0, hfov: 100.0, dist: 0.0 };
            let name = format!("t{t:.0}y{yaw:.0}");
            let live_png = live_frame(ffmpeg, info, &flat, t, &view, dir, &name)?;
            let rot = stitch::matrix(stitch::ypr(view.yaw, view.pitch, view.roll));
            let look = move |_t: f64| (rot, Some((view.hfov, 0.0)));
            let d2 = dir.join(&name);
            std::fs::create_dir_all(&d2).map_err(|e| e.to_string())?;
            let shots = motion::stills(ffmpeg, jobs, "diag", gen, info, &flat, None, &[t], W, H, &look, &|_| "null".to_string(), &d2)?;
            let eng = shots.first().ok_or("엔진 그림이 없습니다")?;
            // Middle of the frame, as wide as the blend plus a margin.
            let px = ((band * 1.5 / 100.0 * W as f64) as u32).clamp(32, W) & !1;
            rows.push(json!({ "t": t, "yaw": yaw, "psnr": psnr(ffmpeg, &live_png, eng, None)?, "band_psnr": psnr(ffmpeg, &live_png, eng, Some((px, (W - px) / 2)))? }));
        }
    }
    let _ = std::fs::remove_dir_all(dir);
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_filter_summary() {
        assert_eq!(parse_psnr("[Parsed_psnr_2] PSNR y:37.1 average:37.123 min:30 max:40"), Some(37.123));
        assert_eq!(parse_psnr("x average:inf min:inf"), Some(99.0));
        assert_eq!(parse_psnr("nothing"), None);
    }
}
