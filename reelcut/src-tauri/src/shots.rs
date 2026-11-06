//! Finding weak stretches of a recording without looking at every frame: blurry (little fine detail
//! compared with the rest of this recording), shaky (the picture jitters from frame to frame) and
//! too dark. Measured on small grey frames, five a second, relative to the recording itself.

use crate::ff;
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::Stdio;

const W: usize = 160;
const H: usize = 90;
pub const HZ: f64 = 5.0;

/// A weak stretch, in seconds of the file.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Bad {
    pub from: f64,
    pub to: f64,
    /// blurry | shaky | dark
    pub kind: String,
}

/// What one small frame measured.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sample {
    pub sharp: f32,
    pub bright: f32,
    pub dx: f32,
    pub dy: f32,
}

fn laplacian_var(g: &[u8]) -> f32 {
    let (mut s, mut s2, mut n) = (0f64, 0f64, 0f64);
    for y in 1..H - 1 {
        for x in 1..W - 1 {
            let i = y * W + x;
            let l = 4.0 * g[i] as f64 - g[i - 1] as f64 - g[i + 1] as f64 - g[i - W] as f64 - g[i + W] as f64;
            s += l;
            s2 += l * l;
            n += 1.0;
        }
    }
    (s2 / n - (s / n).powi(2)) as f32
}

/// How far the picture moved between two frames (best whole-picture shift within ±6 pixels).
fn shift(a: &[u8], b: &[u8]) -> (f32, f32) {
    const R: isize = 6;
    let (mut best, mut bx, mut by) = (f64::MAX, 0isize, 0isize);
    for dy in -R..=R {
        for dx in -R..=R {
            let mut sad = 0f64;
            let mut y = 8isize;
            while y < H as isize - 8 {
                let mut x = 8isize;
                while x < W as isize - 8 {
                    let p = a[y as usize * W + x as usize] as f64;
                    let q = b[(y + dy) as usize * W + (x + dx) as usize] as f64;
                    sad += (p - q).abs();
                    x += 2;
                }
                y += 2;
            }
            // Ties go to "no movement".
            let sad = sad + (dx.abs() + dy.abs()) as f64 * 0.5;
            if sad < best {
                (best, bx, by) = (sad, dx, dy);
            }
        }
    }
    (bx as f32, by as f32)
}

/// Measures a stretch of a file (`track` = which video track, for two-lens recordings).
#[allow(clippy::too_many_arguments)]
pub fn measure(ffmpeg: &Path, path: &str, track: u32, from: f64, dur: f64, each: impl Fn(f64), cancelled: impl Fn() -> bool) -> Result<Vec<Sample>, String> {
    let vf = format!("fps={HZ},scale={W}:{H}:flags=area,format=gray");
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error"].iter().map(|x| x.to_string()).collect();
    if from > 0.0 {
        args.extend(["-ss".into(), format!("{from:.3}")]);
    }
    if dur > 0.0 {
        args.extend(["-t".into(), format!("{dur:.3}")]);
    }
    args.extend(["-i".into(), path.to_string(), "-map".into(), format!("0:v:{track}"), "-vf".into(), vf, "-an".into(), "-f".into(), "rawvideo".into(), "-".into()]);
    let mut c = ff::command(ffmpeg).args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let mut out = c.stdout.take().ok_or("ffmpeg 출력 없음")?;
    let mut buf = vec![0u8; W * H];
    let mut prev: Option<Vec<u8>> = None;
    let mut samples = Vec::new();
    while out.read_exact(&mut buf).is_ok() {
        if cancelled() {
            let _ = c.kill();
            let _ = c.wait();
            return Err(ff::CANCELLED.to_string());
        }
        let (dx, dy) = prev.as_ref().map(|p| shift(p, &buf)).unwrap_or((0.0, 0.0));
        samples.push(Sample { sharp: laplacian_var(&buf), bright: buf.iter().map(|v| *v as f32).sum::<f32>() / buf.len() as f32, dx, dy });
        prev = Some(buf.clone());
        if dur > 0.0 {
            each((samples.len() as f64 / HZ / dur).min(1.0));
        }
    }
    let _ = c.wait();
    Ok(samples)
}

fn median(v: &mut [f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

/// Turns runs of true into stretches of at least `min` samples, joining gaps up to `gap` samples.
fn runs(flags: &[bool], min: usize, gap: usize) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < flags.len() {
        if !flags[i] {
            i += 1;
            continue;
        }
        let s = i;
        while i < flags.len() && flags[i] {
            i += 1;
        }
        match out.last_mut() {
            Some(l) if s - l.1 <= gap => l.1 = i,
            _ => out.push((s, i)),
        }
    }
    out.retain(|(a, b)| b - a >= min);
    out
}

/// The weak stretches among the samples (`from` = time of the first sample), judged against the
/// recording itself so a soft lens or a dim room does not mark everything.
pub fn judge(s: &[Sample], from: f64) -> Vec<Bad> {
    if s.len() < 5 {
        return Vec::new();
    }
    let mut sharp: Vec<f32> = s.iter().map(|x| x.sharp).collect();
    let m_sharp = median(&mut sharp);
    // Shake: movement that does not follow the smooth trend of the last and next second.
    let r = HZ as isize;
    let trend = |get: &dyn Fn(&Sample) -> f32, i: usize| -> f32 {
        let (a, b) = ((i as isize - r).max(0) as usize, ((i as isize + r) as usize).min(s.len() - 1));
        s[a..=b].iter().map(get).sum::<f32>() / (b - a + 1) as f32
    };
    let jitter: Vec<f32> = (0..s.len()).map(|i| (s[i].dx - trend(&|x| x.dx, i)).hypot(s[i].dy - trend(&|x| x.dy, i))).collect();
    // Averaged over a second: one bump is not a shaky shot.
    let shake: Vec<f32> = (0..s.len()).map(|i| {
        let (a, b) = ((i as isize - r / 2).max(0) as usize, ((i as isize + r / 2) as usize).min(s.len() - 1));
        jitter[a..=b].iter().sum::<f32>() / (b - a + 1) as f32
    }).collect();
    let mut sorted = shake.clone();
    let m_shake = median(&mut sorted);
    let t = |i: usize| ((from + i as f64 / HZ) * 100.0).round() / 100.0;
    let mut out = Vec::new();
    let mut push = |flags: Vec<bool>, kind: &str, min: usize| {
        for (a, b) in runs(&flags, min, 2) {
            out.push(Bad { from: t(a), to: t(b), kind: kind.to_string() });
        }
    };
    push(s.iter().map(|x| x.sharp < m_sharp * 0.35).collect(), "blurry", 5);
    push(shake.iter().map(|x| *x > (m_shake * 2.5).max(1.5)).collect(), "shaky", 5);
    push(s.iter().map(|x| x.bright < 22.0).collect(), "dark", 5);
    out.sort_by(|a, b| a.from.total_cmp(&b.from));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(sharp: f32, dx: f32) -> Sample {
        Sample { sharp, bright: 120.0, dx, dy: 0.0 }
    }

    #[test]
    fn finds_blur_shake_and_dark_relative_to_the_recording() {
        let mut s: Vec<Sample> = (0..100).map(|_| sample(500.0, 0.0)).collect();
        for x in &mut s[20..30] {
            x.sharp = 50.0;
        }
        for (i, x) in s[50..70].iter_mut().enumerate() {
            x.dx = if i % 2 == 0 { 5.0 } else { -5.0 };
        }
        for x in &mut s[85..95] {
            x.bright = 10.0;
        }
        let b = judge(&s, 100.0);
        assert_eq!(b.iter().filter(|x| x.kind == "blurry").count(), 1, "{b:?}");
        let blur = b.iter().find(|x| x.kind == "blurry").unwrap();
        assert_eq!((blur.from, blur.to), (104.0, 106.0));
        let shaky = b.iter().find(|x| x.kind == "shaky").unwrap();
        assert!(shaky.from <= 110.2 && shaky.to >= 113.8, "{shaky:?}");
        assert!(b.iter().any(|x| x.kind == "dark" && x.from == 117.0));
    }

    #[test]
    fn steady_panning_and_one_bump_are_not_shaky_and_a_soft_recording_is_not_blurry() {
        // A steady pan, one bump, and low detail throughout.
        let mut s: Vec<Sample> = (0..100).map(|_| sample(20.0, 3.0)).collect();
        s[40].dx = 6.0;
        assert_eq!(judge(&s, 0.0), vec![]);
    }

    #[test]
    fn measures_a_real_file() {
        let Ok(fx) = std::env::var("REELCUT_FX") else { return };
        let ffmpeg = std::path::PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join("ffmpeg");
        let walk = std::path::PathBuf::from(fx).join("walk.mp4");
        let s = measure(&ffmpeg, &walk.to_string_lossy(), 0, 0.0, 4.0, |_| {}, || false).unwrap();
        assert!((18..=22).contains(&s.len()), "{}", s.len());
        assert!(s.iter().all(|x| x.bright > 0.0));
    }
}
