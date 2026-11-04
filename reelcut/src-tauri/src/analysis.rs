//! Measuring a stretch of a file: how loud it is, where the beat falls, where the picture changes and
//! where the sound stands out. Sound events go by level only; nothing here recognises what a sound is.

use crate::ff;
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::process::Stdio;

const RATE: usize = 11025;
const HOP: usize = 256;

/// Mono samples of the stretch, at `RATE`.
fn pcm(ffmpeg: &Path, path: &str, from: f64, to: f64) -> Result<Vec<f32>, String> {
    let mut c = ff::command(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", &format!("{:.3}", from.max(0.0)), "-t", &format!("{:.3}", (to - from).max(0.0)), "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", &RATE.to_string(), "-f", "f32le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    c.stdout.take().ok_or("ffmpeg 출력 없음")?.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let _ = c.wait();
    if bytes.is_empty() {
        return Err("이 구간에서 소리를 읽지 못했습니다. 소리 트랙이 없을 수 있습니다.".into());
    }
    Ok(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

fn db_of(s: &[f32]) -> f32 {
    let e = s.iter().map(|v| v * v).sum::<f32>() / s.len().max(1) as f32;
    10.0 * (e + 1e-10).log10()
}

fn median(v: &[f32]) -> f32 {
    let mut m = v.to_vec();
    m.sort_by(|a, b| a.total_cmp(b));
    m.get(m.len() / 2).copied().unwrap_or(0.0)
}

fn field(text: &str, name: &str) -> Option<f64> {
    let line = text.lines().rev().find(|l| l.trim_start().starts_with(name))?;
    line.split(':').nth(1)?.split_whitespace().next()?.parse().ok()
}

/// Loudness by the broadcast measure (LUFS), the true peak, and a level for each second.
pub fn loudness(ffmpeg: &Path, path: &str, from: f64, to: f64) -> Result<Value, String> {
    let o = ff::command(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-nostats", "-ss", &format!("{:.3}", from.max(0.0)), "-t", &format!("{:.3}", (to - from).max(0.0)), "-i", path, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    let log = String::from_utf8_lossy(&o.stderr);
    let summary = log.rsplit("Summary:").next().unwrap_or("");
    let lufs = field(summary, "I:").ok_or("소리 크기를 재지 못했습니다. 소리 트랙이 없을 수 있습니다.")?;
    let s = pcm(ffmpeg, path, from, to)?;
    let series: Vec<Value> = s.chunks(RATE).enumerate().map(|(i, c)| json!({ "t": from + i as f64, "db": (db_of(c) as f64 * 10.0).round() / 10.0 })).collect();
    Ok(json!({ "lufs": lufs, "range": field(summary, "LRA:"), "peak": field(summary, "Peak:"), "series": series }))
}

/// How much new energy each hop brings, in a low and a high band, with the local average taken off.
fn onsets(s: &[f32]) -> Vec<f32> {
    let (mut low, mut prev_l, mut prev_h) = (0f32, 0f32, 0f32);
    let a = 1.0 - (-2.0 * std::f32::consts::PI * 200.0 / RATE as f32).exp();
    let mut env = Vec::with_capacity(s.len() / HOP + 1);
    for c in s.chunks(HOP) {
        let (mut el, mut eh) = (0f32, 0f32);
        for &v in c {
            low += a * (v - low);
            el += low * low;
            eh += (v - low) * (v - low);
        }
        let (l, h) = ((1.0 + 1000.0 * el).ln(), (1.0 + 1000.0 * eh).ln());
        env.push((l - prev_l).max(0.0) + (h - prev_h).max(0.0));
        prev_l = l;
        prev_h = h;
    }
    let reach = (RATE / HOP).max(1);
    let total: Vec<f32> = env.iter().scan(0f32, |acc, v| { *acc += v; Some(*acc) }).collect();
    env.iter().enumerate().map(|(i, v)| {
        let (a, b) = (i.saturating_sub(reach), (i + reach).min(env.len() - 1));
        let mean = (total[b] - if a > 0 { total[a - 1] } else { 0.0 }) / (b - a + 1) as f32;
        (v - mean).max(0.0)
    }).collect()
}

/// A steady beat: the repeat time that best fits the onsets, laid over them and nudged to each one.
/// `confidence` runs 0–1; below about 0.2 there is no steady beat to speak of.
pub fn find_beats(s: &[f32], from: f64) -> Value {
    let fps = RATE as f64 / HOP as f64;
    let env = onsets(s);
    let none = json!({ "bpm": 0, "confidence": 0, "beats": [] });
    if env.len() < (fps * 4.0) as usize {
        return none;
    }
    // A beat rarely falls exactly on a hop, so comparisons use a slightly spread envelope.
    let soft: Vec<f32> = (0..env.len()).map(|i| (env[i.saturating_sub(1)] + 2.0 * env[i] + env[(i + 1).min(env.len() - 1)]) / 4.0).collect();
    let lag_of = |bpm: f64| (fps * 60.0 / bpm).round() as usize;
    let (lo, hi) = (lag_of(180.0), lag_of(60.0).min(env.len() / 2));
    let ac = |lag: usize| -> f32 { soft.iter().zip(soft.iter().skip(lag)).map(|(a, b)| a * b).sum::<f32>() / (soft.len() - lag) as f32 };
    let zero = ac(0).max(1e-9);
    let (mut best, mut score) = (lo, f32::MIN);
    for lag in lo..=hi {
        // A slight preference for moderate tempos settles half- and double-time ties.
        let bpm = fps * 60.0 / lag as f64;
        let w = (-(bpm / 120.0).log2().powi(2) / 2.0).exp() as f32;
        let v = ac(lag) * (0.8 + 0.2 * w);
        if v > score {
            score = v;
            best = lag;
        }
    }
    // Every multiple of the beat repeats as well; take the fastest one that still fits well.
    while best / 2 >= lo {
        let half = (best as f64 / 2.0).round() as usize;
        let top = (half - 1..=half + 1).max_by(|a, b| ac(*a).total_cmp(&ac(*b))).unwrap_or(half);
        if ac(top) < 0.6 * ac(best) {
            break;
        }
        best = top;
    }
    let confidence = (ac(best) / zero).clamp(0.0, 1.0);
    // Average the repeat time over many beats for an exact tempo.
    let mut period = best as f64;
    for k in [4usize, 8, 16] {
        let centre = (period * k as f64).round() as usize;
        if centre + 3 >= env.len() {
            break;
        }
        let top = (centre.saturating_sub(3)..=centre + 3).max_by(|a, b| ac(*a).total_cmp(&ac(*b))).unwrap_or(centre);
        period = top as f64 / k as f64;
    }
    let (mut phase, mut top) = (0usize, f32::MIN);
    for off in 0..best {
        let v: f32 = (0..).map(|k| off as f64 + k as f64 * period).take_while(|p| (*p as usize) < soft.len()).map(|p| soft[p as usize]).sum();
        if v > top {
            top = v;
            phase = off;
        }
    }
    let reach = (period * 0.12).ceil() as isize;
    let mut beats = Vec::new();
    let mut p = phase as f64;
    while (p as usize) < env.len() {
        let c = p as isize;
        let at = (c - reach..=c + reach).filter(|i| *i >= 0 && (*i as usize) < env.len()).max_by(|a, b| env[*a as usize].total_cmp(&env[*b as usize])).unwrap_or(c);
        beats.push(((from + at as f64 / fps) * 1000.0).round() / 1000.0);
        p += period;
    }
    json!({ "bpm": (fps * 60.0 / period * 10.0).round() / 10.0, "confidence": (confidence as f64 * 100.0).round() / 100.0, "beats": beats })
}

/// Stretches that stand out by level: silence, a short loud burst, or a long loud passage.
pub fn audio_events(s: &[f32], from: f64) -> Vec<Value> {
    let win = RATE / 10;
    let db: Vec<f32> = s.chunks(win).map(db_of).collect();
    let mid = median(&db);
    let mut out: Vec<Value> = Vec::new();
    let mut spans = |test: &dyn Fn(f32) -> bool, min_len: usize, bridge: usize, name: &dyn Fn(usize) -> &'static str| {
        let mut i = 0;
        while i < db.len() {
            if !test(db[i]) {
                i += 1;
                continue;
            }
            let (start, mut end, mut gap) = (i, i, 0);
            let mut j = i + 1;
            while j < db.len() && gap <= bridge {
                if test(db[j]) {
                    end = j;
                    gap = 0;
                } else {
                    gap += 1;
                }
                j += 1;
            }
            let n = end - start + 1;
            if n >= min_len {
                let top = db[start..=end].iter().copied().fold(f32::MIN, f32::max);
                out.push(json!({ "from": from + start as f64 / 10.0, "to": from + (end + 1) as f64 / 10.0, "kind": name(n), "db": (top as f64 * 10.0).round() / 10.0 }));
            }
            i = end + 1;
        }
    };
    spans(&|v| v < -50.0 || v < mid - 25.0, 7, 0, &|_| "silence");
    spans(&|v| v > mid + 10.0 && v > -40.0, 1, 3, &|n| if n > 40 { "loud_long" } else { "loud" });
    out.sort_by(|a, b| a["from"].as_f64().unwrap_or(0.0).total_cmp(&b["from"].as_f64().unwrap_or(0.0)));
    out
}

pub fn beats(ffmpeg: &Path, path: &str, from: f64, to: f64) -> Result<Value, String> {
    Ok(find_beats(&pcm(ffmpeg, path, from, to)?, from))
}

pub fn events(ffmpeg: &Path, path: &str, from: f64, to: f64) -> Result<Vec<Value>, String> {
    Ok(audio_events(&pcm(ffmpeg, path, from, to)?, from))
}

/// Where the picture changes abruptly, looked at five times a second on small pictures.
pub fn scene_cuts(ffmpeg: &Path, path: &str, from: f64, to: f64, threshold: f64) -> Result<Vec<Value>, String> {
    let vf = format!("fps=5,scale=160:-2,select='gte(scene,{threshold:.3})',metadata=print:file=-");
    let o = ff::command(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", &format!("{:.3}", from.max(0.0)), "-t", &format!("{:.3}", (to - from).max(0.0)), "-i", path, "-map", "0:v:0", "-an", "-vf", &vf, "-f", "null", "-"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&o.stdout);
    let mut out = Vec::new();
    let mut t = None;
    for l in text.lines() {
        if let Some(p) = l.split("pts_time:").nth(1) {
            t = p.trim().parse::<f64>().ok();
        } else if let (Some(s), Some(at)) = (l.strip_prefix("lavfi.scene_score="), t) {
            out.push(json!({ "t": ((from + at) * 100.0).round() / 100.0, "score": (s.trim().parse::<f64>().unwrap_or(0.0) * 100.0).round() / 100.0 }));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Short clicks every `every` seconds over faint noise.
    fn clicks(every: f64, secs: f64) -> Vec<f32> {
        let n = (secs * RATE as f64) as usize;
        let mut seed = 12345u32;
        let mut s: Vec<f32> = (0..n).map(|_| { seed = seed.wrapping_mul(1103515245).wrapping_add(12345); ((seed >> 16) as f32 / 65536.0 - 0.5) * 0.002 }).collect();
        let mut t = 0.25;
        while t < secs {
            let at = (t * RATE as f64) as usize;
            for (k, v) in s.iter_mut().skip(at).take(220).enumerate() {
                *v += 0.6 * (k as f32 * 0.9).sin() * (-(k as f32) / 60.0).exp();
            }
            t += every;
        }
        s
    }

    #[test]
    fn finds_a_steady_beat() {
        let r = find_beats(&clicks(0.5, 30.0), 100.0);
        let bpm = r["bpm"].as_f64().unwrap();
        assert!((bpm - 120.0).abs() < 1.5, "bpm {bpm}");
        assert!(r["confidence"].as_f64().unwrap() > 0.3, "{}", r["confidence"]);
        let b: Vec<f64> = r["beats"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        assert!(b.len() >= 55 && b.len() <= 61, "{}", b.len());
        // Each beat sits on a click (100.25, 100.75, ...).
        for t in &b {
            let off = (t - 100.25).rem_euclid(0.5);
            assert!(off.min(0.5 - off) < 0.04, "beat at {t}");
        }
    }

    #[test]
    fn a_steady_tone_has_no_beat() {
        let s: Vec<f32> = (0..RATE * 20).map(|i| (i as f32 * 0.1).sin() * 0.3).collect();
        assert!(find_beats(&s, 0.0)["confidence"].as_f64().unwrap() < 0.2);
    }

    #[test]
    fn marks_silence_and_bursts() {
        let mut s: Vec<f32> = (0..RATE * 10).map(|i| (i as f32 * 0.2).sin() * 0.05).collect();
        for v in s.iter_mut().take(RATE * 4).skip(RATE * 2) { *v = 0.0; }
        for (i, v) in s.iter_mut().enumerate().take(RATE * 7).skip(RATE * 6) { *v = (i as f32 * 0.2).sin() * 0.8; }
        let e = audio_events(&s, 50.0);
        let kinds: Vec<&str> = e.iter().map(|x| x["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["silence", "loud"]);
        assert!((e[0]["from"].as_f64().unwrap() - 52.0).abs() < 0.2);
        assert!((e[1]["to"].as_f64().unwrap() - 57.0).abs() < 0.2);
    }
}
