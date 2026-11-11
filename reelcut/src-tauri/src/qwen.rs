//! Qwen3-ASR (1.7B, with the Qwen3 forced aligner for word times) as a second speech engine.
//! It runs in a Python environment the app makes for itself under its data folder:
//! venv → torch (CUDA build when an NVIDIA GPU is present) → qwen-asr → model files.

use crate::ff::{self, Jobs};
use crate::transcribe::Word;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

const RUNNER: &str = include_str!("qwen_runner.py");
pub const QWEN_ASR_VERSION: &str = "0.0.6";

pub fn root(data: &Path) -> PathBuf {
    data.join("qwen")
}
fn env_dir(data: &Path) -> PathBuf {
    root(data).join("env")
}
pub fn models_dir(data: &Path) -> PathBuf {
    root(data).join("models")
}
pub fn python(data: &Path) -> PathBuf {
    if cfg!(windows) {
        env_dir(data).join("Scripts").join("python.exe")
    } else {
        env_dir(data).join("bin").join("python")
    }
}

fn runner(data: &Path) -> Result<PathBuf, String> {
    let p = root(data).join("qwen_runner.py");
    if std::fs::read_to_string(&p).ok().as_deref() != Some(RUNNER) {
        std::fs::create_dir_all(root(data)).map_err(|e| e.to_string())?;
        std::fs::write(&p, RUNNER).map_err(|e| e.to_string())?;
    }
    Ok(p)
}

fn envs(data: &Path) -> Vec<(String, String)> {
    vec![
        ("PYTHONUTF8".into(), "1".into()),
        ("PYTHONIOENCODING".into(), "utf-8".into()),
        ("HF_HOME".into(), root(data).join("hf").to_string_lossy().into_owned()),
        ("HF_HUB_DISABLE_SYMLINKS_WARNING".into(), "1".into()),
        ("PIP_DISABLE_PIP_VERSION_CHECK".into(), "1".into()),
    ]
}

fn models_ready(data: &Path) -> bool {
    let m = models_dir(data);
    let asr = m.join("Qwen3-ASR-1.7B");
    let al = m.join("Qwen3-ForcedAligner-0.6B");
    asr.join("model-00001-of-00002.safetensors").is_file() && asr.join("model-00002-of-00002.safetensors").is_file() && al.join("model.safetensors").is_file()
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Status {
    /// The app's Python environment exists.
    pub env: bool,
    /// qwen-asr imports.
    pub package: bool,
    pub models: bool,
    pub ready: bool,
    pub cuda: bool,
    pub gpu: String,
    pub vram_gb: f64,
    pub torch: String,
    pub error: String,
}

pub fn status(data: &Path, deep: bool) -> Status {
    let mut s = Status { env: python(data).is_file(), models: models_ready(data), ..Default::default() };
    if s.env && deep {
        match runner(data).and_then(|r| ff::output(&python(data), &[r.to_string_lossy().into_owned(), "check".into()])) {
            Ok((_, out, err)) => match serde_json::from_str::<Value>(out.trim()) {
                Ok(j) => {
                    s.package = j["qwen_asr"].as_bool().unwrap_or(false);
                    s.cuda = j["cuda"].as_bool().unwrap_or(false);
                    s.gpu = j["gpu"].as_str().unwrap_or("").into();
                    s.vram_gb = j["vram_gb"].as_f64().unwrap_or(0.0);
                    s.torch = j["torch"].as_str().unwrap_or("").into();
                    s.error = j["qwen_asr_error"].as_str().or(j["torch_error"].as_str()).unwrap_or("").into();
                }
                Err(_) => s.error = err.lines().last().unwrap_or("").to_string(),
            },
            Err(e) => s.error = e,
        }
    } else if s.env {
        s.package = env_dir(data).join(if cfg!(windows) { "Lib" } else { "lib" }).is_dir();
    }
    s.ready = s.env && s.package && s.models;
    s
}

/// A Python 3.9+ to make the environment with: the `py` launcher first (Windows), then python.
fn find_python() -> Result<(PathBuf, Vec<String>), String> {
    let cands: Vec<(&str, Vec<&str>)> = vec![("py", vec!["-3.12"]), ("py", vec!["-3.11"]), ("py", vec!["-3.10"]), ("py", vec!["-3"]), ("python", vec![]), ("python3", vec![])];
    for (bin, pre) in cands {
        let mut a: Vec<String> = pre.iter().map(|x| x.to_string()).collect();
        a.extend(["-c".into(), "import sys;print('%d.%d'%sys.version_info[:2])".into()]);
        if let Ok((true, out, _)) = ff::output(Path::new(bin), &a) {
            let v: Vec<u32> = out.trim().split('.').filter_map(|x| x.parse().ok()).collect();
            if v.len() == 2 && v[0] == 3 && (9..=13).contains(&v[1]) {
                return Ok((PathBuf::from(bin), pre.iter().map(|x| x.to_string()).collect()));
            }
        }
    }
    Err("Python 3.9~3.13을 찾지 못했습니다. python.org에서 Python 3.12를 설치한 뒤 다시 눌러 주세요.".into())
}

fn has_nvidia() -> bool {
    matches!(ff::output(Path::new("nvidia-smi"), &["-L".into()]), Ok((true, out, _)) if out.contains("GPU"))
}

/// Installs everything. `on(pct, message)`.
pub fn setup(data: &Path, gpus: &[String], jobs: &Jobs, tag: &str, gen: u64, mut on: impl FnMut(f64, &str)) -> Result<(), String> {
    let e = envs(data);
    let py = python(data);
    if !py.is_file() {
        on(1.0, "Python 환경 만드는 중");
        let (bin, pre) = find_python()?;
        let mut a = pre.clone();
        a.extend(["-m".into(), "venv".into(), env_dir(data).to_string_lossy().into_owned()]);
        std::fs::create_dir_all(root(data)).map_err(|e| e.to_string())?;
        ff::run_tracked_env(jobs, tag, gen, &bin, &a, &e, |_| {}).map_err(|x| format!("Python 환경을 만들지 못했습니다: {x}"))?;
    }
    let pip = |args: &[&str], what: &str, pct: f64, on: &mut dyn FnMut(f64, &str)| -> Result<(), String> {
        on(pct, what);
        let mut a: Vec<String> = vec!["-m".into(), "pip".into(), "install".into(), "--no-input".into()];
        a.extend(args.iter().map(|x| x.to_string()));
        ff::run_tracked_env(jobs, tag, gen, &py, &a, &e, |_| {}).map(|_| ()).map_err(|x| if x == ff::CANCELLED { x } else { format!("{what} 실패: {x}") })
    };
    pip(&["--upgrade", "pip"], "pip 업데이트", 4.0, &mut on)?;
    let intel = gpus.iter().any(|g| { let g = g.to_lowercase(); g.contains("intel") && g.contains("arc") });
    if has_nvidia() {
        pip(&["torch", "--index-url", "https://download.pytorch.org/whl/cu128"], "PyTorch(NVIDIA GPU용) 설치 중 · 약 3GB", 8.0, &mut on)?;
    } else if intel {
        // Intel Arc (XPU) build; if it can't be installed, the CPU build still works.
        if pip(&["torch", "--index-url", "https://download.pytorch.org/whl/xpu"], "PyTorch(Intel Arc GPU용) 설치 중", 8.0, &mut on).is_err() {
            pip(&["torch"], "PyTorch(CPU용) 설치 중", 8.0, &mut on)?;
        }
    } else {
        pip(&["torch"], "PyTorch(CPU용) 설치 중", 8.0, &mut on)?;
    }
    pip(&[&format!("qwen-asr=={QWEN_ASR_VERSION}")], "qwen-asr 설치 중", 30.0, &mut on)?;
    on(40.0, "Qwen3-ASR-1.7B 모델 내려받는 중 · 약 6.5GB");
    let r = runner(data)?;
    let a = vec![r.to_string_lossy().into_owned(), "download".into(), "--models".into(), models_dir(data).to_string_lossy().into_owned()];
    ff::run_tracked_env(jobs, tag, gen, &py, &a, &e, |line| {
        if let Some(p) = parse_progress(line) {
            on(40.0 + p * 0.6, "Qwen3-ASR-1.7B 모델 내려받는 중 · 약 6.5GB");
        }
    })
    .map_err(|x| if x == ff::CANCELLED { x } else { format!("모델 내려받기 실패: {x}") })?;
    Ok(())
}

pub fn parse_progress(line: &str) -> Option<f64> {
    let i = line.find("progress =")?;
    line[i + 10..].trim().trim_end_matches('%').trim().parse().ok()
}

/// Transcribes a 16 kHz wav; returns (language, words). `on` gets 0–100.
pub fn run(data: &Path, wav: &Path, lang: &str, work: &Path, jobs: &Jobs, tag: &str, gen: u64, mut on: impl FnMut(f64)) -> Result<(String, Vec<Word>), String> {
    let st = status(data, false);
    if !st.env || !st.models {
        return Err("Qwen 받아쓰기가 아직 설치되지 않았습니다. 설정 > 받아쓰기에서 설치해 주세요.".into());
    }
    let out = work.join("qwen.json");
    let r = runner(data)?;
    let a = vec![
        r.to_string_lossy().into_owned(), "transcribe".into(), "--models".into(), models_dir(data).to_string_lossy().into_owned(),
        "--wav".into(), wav.to_string_lossy().into_owned(), "--lang".into(), if lang.is_empty() { "auto".into() } else { lang.to_string() },
        "--out".into(), out.to_string_lossy().into_owned(),
    ];
    ff::run_tracked_env(jobs, tag, gen, &python(data), &a, &envs(data), |line| {
        if let Some(p) = parse_progress(line) {
            on(p);
        }
    })
    .map_err(|x| if x == ff::CANCELLED { x } else { format!("Qwen 받아쓰기 실패: {}", x.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or(&x)) })?;
    parse(&std::fs::read_to_string(&out).map_err(|e| format!("받아쓰기 결과 파일이 없습니다: {e}"))?)
}

pub fn parse(json: &str) -> Result<(String, Vec<Word>), String> {
    let j: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let lang = j["language"].as_str().unwrap_or("").to_lowercase();
    let lang = match lang.as_str() { "korean" => "ko".into(), "english" => "en".into(), "japanese" => "ja".into(), "chinese" => "zh".into(), _ => lang };
    let words = serde_json::from_value::<Vec<Word>>(j["words"].clone()).map_err(|e| e.to_string())?;
    Ok((lang, words))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_runner_output() {
        let (l, w) = parse(r#"{"language":"Korean","words":[{"s":0.1,"e":0.7,"t":"안녕하세요."}]}"#).unwrap();
        assert_eq!(l, "ko");
        assert_eq!(w[0].t, "안녕하세요.");
        assert_eq!(parse_progress("progress = 42.5"), Some(42.5));
    }
}
