//! Speech to text with whisper.cpp (`whisper-cli`, shipped next to ffmpeg) and a ggml model
//! downloaded on first use. One segment per word (`-ml 1 -sow`) so the editor can cut on words.

use crate::ff::{self, Jobs};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub file: String,
    pub size_mb: u32,
    pub downloaded: bool,
}

pub const MODELS: [(&str, &str, &str, u32); 4] = [
    ("turbo", "large-v3-turbo (권장, 한국어 정확)", "ggml-large-v3-turbo-q5_0.bin", 574),
    ("small", "small (빠름)", "ggml-small.bin", 488),
    ("base", "base (가장 빠름, 부정확)", "ggml-base.bin", 148),
    ("medium", "medium (느림)", "ggml-medium.bin", 1533),
];

pub fn models(dir: &Path) -> Vec<ModelInfo> {
    MODELS
        .iter()
        .map(|(id, label, file, mb)| ModelInfo { id: id.to_string(), label: label.to_string(), file: file.to_string(), size_mb: *mb, downloaded: dir.join(file).is_file() })
        .collect()
}

pub fn model_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    let (_, _, file, _) = MODELS.iter().find(|m| m.0 == id).ok_or_else(|| format!("알 수 없는 모델: {id}"))?;
    Ok(dir.join(file))
}

/// Downloads a model into `dir` (to a .part file first), reporting (done, total) bytes.
pub fn download(dir: &Path, id: &str, jobs: &Jobs, gen: u64, mut on: impl FnMut(u64, u64)) -> Result<PathBuf, String> {
    let dest = model_path(dir, id)?;
    if dest.is_file() {
        return Ok(dest);
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = dest.file_name().unwrap().to_string_lossy().into_owned();
    let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{file}");
    let resp = ureq::get(&url).call().map_err(|e| format!("모델 내려받기 실패: {e}"))?;
    let total: u64 = resp.header("Content-Length").and_then(|x| x.parse().ok()).unwrap_or(0);
    let part = dest.with_extension("part");
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut r = resp.into_reader();
    let mut buf = vec![0u8; 1 << 16];
    let mut done = 0u64;
    let mut last = std::time::Instant::now();
    loop {
        if jobs.generation("download") != gen {
            drop(out);
            let _ = std::fs::remove_file(&part);
            return Err(ff::CANCELLED.into());
        }
        let n = r.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if last.elapsed().as_millis() > 250 {
            on(done, total);
            last = std::time::Instant::now();
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    if total > 0 && done < total {
        let _ = std::fs::remove_file(&part);
        return Err("모델을 끝까지 받지 못했습니다. 다시 시도해 주세요.".into());
    }
    std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    on(done, total.max(done));
    Ok(dest)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Word {
    /// Seconds in the source file.
    pub s: f64,
    pub e: f64,
    pub t: String,
}

/// Parses whisper-cli's `-oj` output (one segment per word with `-ml 1 -sow`).
pub fn parse(json: &str) -> Result<(String, Vec<Word>), String> {
    let j: Value = serde_json::from_str(json).map_err(|e| format!("받아쓰기 결과를 읽지 못했습니다: {e}"))?;
    let lang = j.pointer("/result/language").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mut words: Vec<Word> = Vec::new();
    for seg in j.get("transcription").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
        let text = seg.get("text").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let from = seg.pointer("/offsets/from").and_then(|x| x.as_f64()).unwrap_or(0.0) / 1000.0;
        let to = seg.pointer("/offsets/to").and_then(|x| x.as_f64()).unwrap_or(0.0) / 1000.0;
        let t = text.trim();
        if t.is_empty() {
            continue;
        }
        // A piece without a leading space continues the previous word (whisper splits tokens).
        if !text.starts_with(' ') {
            if let Some(last) = words.last_mut() {
                if (from - last.e).abs() < 0.6 {
                    last.t.push_str(t);
                    last.e = to.max(last.e);
                    continue;
                }
            }
        }
        words.push(Word { s: from, e: to.max(from + 0.01), t: t.to_string() });
    }
    Ok((lang, words))
}

pub struct Run<'a> {
    pub ffmpeg: &'a Path,
    pub whisper: &'a Path,
    pub model: PathBuf,
    pub media: String,
    pub lang: String,
    pub work: PathBuf,
    pub threads: u32,
}

/// Extracts 16 kHz mono audio, runs whisper and returns the language and words. `on` gets 0–100.
pub fn run(r: &Run, jobs: &Jobs, tag: &str, gen: u64, mut on: impl FnMut(f64)) -> Result<(String, Vec<Word>), String> {
    if !r.model.is_file() {
        return Err("받아쓰기 모델이 없습니다. 설정에서 먼저 내려받아 주세요.".into());
    }
    std::fs::create_dir_all(&r.work).map_err(|e| e.to_string())?;
    let wav = r.work.join("audio16k.wav");
    let a: Vec<String> = ["-i", &r.media, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", &wav.to_string_lossy()].iter().map(|x| x.to_string()).collect();
    ff::run_ffmpeg(jobs, tag, gen, r.ffmpeg, &a, |_| {}).map_err(|e| if e == ff::CANCELLED { e } else { format!("소리를 꺼내지 못했습니다: {e}") })?;
    on(3.0);
    let base = r.work.join("words");
    let mut args: Vec<String> = vec![
        "-m".into(),
        r.model.to_string_lossy().into_owned(),
        "-f".into(),
        wav.to_string_lossy().into_owned(),
        "-l".into(),
        if r.lang.is_empty() { "auto".into() } else { r.lang.clone() },
        "-t".into(),
        r.threads.clamp(1, 16).to_string(),
        "-ml".into(),
        "1".into(),
        "-sow".into(),
        "-oj".into(),
        "-of".into(),
        base.to_string_lossy().into_owned(),
        "-pp".into(),
        "-np".into(),
    ];
    if r.lang == "ko" {
        // Keeps whisper writing Korean (not romanised or translated) and with punctuation.
        args.extend(["--prompt".into(), "안녕하세요. 오늘은 영상을 찍었습니다.".into()]);
    }
    ff::run_tracked(jobs, tag, gen, r.whisper, &args, |line| {
        if let Some(i) = line.find("progress =") {
            let rest = line[i + 10..].trim().trim_end_matches('%').trim();
            if let Ok(p) = rest.parse::<f64>() {
                on(3.0 + p * 0.97);
            }
        }
    })
    .map_err(|e| if e == ff::CANCELLED { e } else { format!("받아쓰기 실패: {e}") })?;
    let json = std::fs::read(base.with_extension("json")).map_err(|e| format!("받아쓰기 결과 파일이 없습니다: {e}"))?;
    let _ = std::fs::remove_file(&wav);
    parse(&String::from_utf8_lossy(&json))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_words_and_join_pieces() {
        let j = r#"{"result":{"language":"ko"},"transcription":[
          {"offsets":{"from":0,"to":400},"text":" 안녕"},
          {"offsets":{"from":400,"to":700},"text":"하세요"},
          {"offsets":{"from":900,"to":1300},"text":" 여러분"},
          {"offsets":{"from":1300,"to":1300},"text":" "}]}"#;
        let (lang, w) = parse(j).unwrap();
        assert_eq!(lang, "ko");
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].t, "안녕하세요");
        assert!((w[0].e - 0.7).abs() < 1e-9);
        assert_eq!(w[1].t, "여러분");
    }
}
