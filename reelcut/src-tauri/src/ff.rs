//! Finding the bundled ffmpeg/ffprobe and running them as tracked child processes that a newer
//! request can cancel (preview chunks and estimates are thrown away whenever a setting changes).

use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Instant;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct Bins {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub whisper: PathBuf,
}

/// The installer puts ffmpeg in `<resources>/bin`; in development it sits in `src-tauri/bin`;
/// otherwise whatever is on PATH.
pub fn locate(resource_dir: Option<&Path>) -> Bins {
    let find = |name: &str| -> PathBuf {
        let exe = format!("{name}{}", std::env::consts::EXE_SUFFIX);
        let exe = exe.as_str();
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(r) = resource_dir {
            dirs.push(r.join("bin"));
        }
        dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin"));
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        if let Some(r) = resource_dir {
            dirs.push(r.join("bin").join("whisper"));
        }
        dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin").join("whisper"));
        dirs.into_iter().map(|d| d.join(exe)).find(|f| f.is_file()).unwrap_or_else(|| PathBuf::from(exe))
    };
    Bins { ffmpeg: find("ffmpeg"), ffprobe: find("ffprobe"), whisper: find("whisper-cli") }
}

pub fn command(bin: &Path) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(bin);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Runs a short command to completion and returns (success, stdout, stderr).
pub fn output(bin: &Path, args: &[String]) -> Result<(bool, String, String), String> {
    let o = command(bin).args(args).stdin(Stdio::null()).output().map_err(|e| format!("{}: {e}", bin.display()))?;
    Ok((o.status.success(), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned()))
}

/// Children grouped by a tag ("preview", "estimate", "compress"). `cancel(tag)` kills every child of
/// that tag and bumps its generation, so the loop that started them knows its result is stale.
#[derive(Default)]
pub struct Jobs {
    inner: Mutex<HashMap<String, (u64, Vec<Arc<Mutex<Child>>>)>>,
}

impl Jobs {
    pub fn generation(&self, tag: &str) -> u64 {
        self.inner.lock().get(tag).map(|e| e.0).unwrap_or(0)
    }

    pub fn cancel(&self, tag: &str) -> u64 {
        let mut m = self.inner.lock();
        let e = m.entry(tag.to_string()).or_default();
        e.0 += 1;
        for c in e.1.drain(..) {
            let _ = c.lock().kill();
        }
        e.0
    }

    fn add(&self, tag: &str, c: Arc<Mutex<Child>>) {
        self.inner.lock().entry(tag.to_string()).or_default().1.push(c);
    }

    fn remove(&self, tag: &str, c: &Arc<Mutex<Child>>) {
        if let Some(e) = self.inner.lock().get_mut(tag) {
            e.1.retain(|x| !Arc::ptr_eq(x, c));
        }
    }
}

pub const CANCELLED: &str = "cancelled";

/// One `-progress pipe:1` report.
#[derive(Default, Clone, Debug)]
pub struct Progress {
    pub out_time: f64,
    pub frame: u64,
    pub total_size: u64,
    pub fps: f64,
    pub speed: f64,
    pub elapsed: f64,
    pub end: bool,
}

pub struct RunResult {
    pub elapsed: f64,
    /// Encoding rate measured from the first report with frames to the last one, so the time the
    /// encoder spends opening (GPU sessions take a moment) does not count against a 2 s sample.
    pub steady: Option<(f64, f64)>,
    pub last: Progress,
}

/// Runs ffmpeg with `-progress pipe:1` added, calling `on` for each report. Fails with
/// [`CANCELLED`] when `jobs.cancel(tag)` was called after generation `gen` started.
pub fn run_ffmpeg(jobs: &Jobs, tag: &str, gen: u64, bin: &Path, args: &[String], on: impl FnMut(&Progress)) -> Result<RunResult, String> {
    run_ffmpeg_in(jobs, tag, gen, bin, args, None, on)
}

/// [`run_ffmpeg`] with a working directory (the subtitles filter reads its file by a relative
/// name, which avoids escaping a Windows path inside the filter graph).
pub fn run_ffmpeg_in(
    jobs: &Jobs,
    tag: &str,
    gen: u64,
    bin: &Path,
    args: &[String],
    cwd: Option<&Path>,
    mut on: impl FnMut(&Progress),
) -> Result<RunResult, String> {
    if jobs.generation(tag) != gen {
        return Err(CANCELLED.into());
    }
    let mut full: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into(), "-loglevel".into(), "error".into(), "-nostats".into(), "-progress".into(), "pipe:1".into(), "-stats_period".into(), "0.25".into()];
    full.extend(args.iter().cloned());
    let t0 = Instant::now();
    let mut cmd = command(bin);
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    let mut child = cmd
        .args(&full)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg 실행 실패: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let child = Arc::new(Mutex::new(child));
    jobs.add(tag, child.clone());
    if jobs.generation(tag) != gen {
        let _ = child.lock().kill();
    }

    let mut cur = Progress::default();
    let mut first: Option<(f64, f64)> = None;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim();
        match k {
            "out_time_us" | "out_time_ms" => {
                if let Ok(us) = v.parse::<i64>() {
                    cur.out_time = us.max(0) as f64 / 1e6;
                }
            }
            "frame" => cur.frame = v.parse().unwrap_or(cur.frame),
            "total_size" => cur.total_size = v.parse().unwrap_or(cur.total_size),
            "fps" => cur.fps = v.parse().unwrap_or(cur.fps),
            "speed" => cur.speed = v.trim_end_matches('x').parse().unwrap_or(cur.speed),
            "progress" => {
                cur.elapsed = t0.elapsed().as_secs_f64();
                cur.end = v == "end";
                if first.is_none() && cur.frame > 0 && !cur.end {
                    first = Some((cur.elapsed, cur.out_time));
                }
                on(&cur);
            }
            _ => {}
        }
    }
    let status = child.lock().wait();
    jobs.remove(tag, &child);
    let err = err_thread.join().unwrap_or_default();
    let elapsed = t0.elapsed().as_secs_f64();
    if jobs.generation(tag) != gen {
        return Err(CANCELLED.into());
    }
    match status {
        Ok(s) if s.success() => {}
        Ok(_) => {
            let useful: Vec<&str> = err.lines().filter(|l| !l.contains("Task finished") && !l.contains("Terminating thread") && !l.contains("Nothing was written") && !l.trim().is_empty()).collect();
            let tail = useful.iter().take(3).copied().collect::<Vec<_>>().join("\n");
            return Err(if tail.is_empty() { "ffmpeg가 오류로 끝났습니다".into() } else { tail });
        }
        Err(e) => return Err(e.to_string()),
    }
    let steady = first.and_then(|(t, o)| {
        let (dt, dout) = (elapsed - t, cur.out_time - o);
        (dt > 0.05 && dout > 0.0).then_some((dout, dt))
    });
    Ok(RunResult { elapsed, steady, last: cur })
}

/// Runs any tracked program (whisper) to completion, feeding each stderr/stdout line to `on`.
/// Cancelled like ffmpeg jobs.
pub fn run_tracked(jobs: &Jobs, tag: &str, gen: u64, bin: &Path, args: &[String], on: impl FnMut(&str)) -> Result<String, String> {
    run_tracked_env(jobs, tag, gen, bin, args, &[], on)
}

/// `run_tracked` with extra environment variables.
pub fn run_tracked_env(jobs: &Jobs, tag: &str, gen: u64, bin: &Path, args: &[String], envs: &[(String, String)], mut on: impl FnMut(&str)) -> Result<String, String> {
    if jobs.generation(tag) != gen {
        return Err(CANCELLED.into());
    }
    let mut child = command(bin)
        .args(args)
        .envs(envs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{} 실행 실패: {e}", bin.display()))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let mut r = BufReader::new(stdout);
        let _ = r.read_to_string(&mut s);
        s
    });
    let child = Arc::new(Mutex::new(child));
    jobs.add(tag, child.clone());
    let mut tail: Vec<String> = Vec::new();
    // whisper prints progress with \r or \n; split on both.
    let mut buf = Vec::new();
    let mut r = BufReader::new(stderr);
    let mut byte = [0u8; 1];
    loop {
        match r.read(&mut byte) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if byte[0] == b'\n' || byte[0] == b'\r' {
                    if !buf.is_empty() {
                        let line = String::from_utf8_lossy(&buf).into_owned();
                        on(&line);
                        tail.push(line);
                        if tail.len() > 6 {
                            tail.remove(0);
                        }
                        buf.clear();
                    }
                } else {
                    buf.push(byte[0]);
                }
            }
        }
    }
    let status = child.lock().wait();
    jobs.remove(tag, &child);
    let out = out_thread.join().unwrap_or_default();
    if jobs.generation(tag) != gen {
        return Err(CANCELLED.into());
    }
    match status {
        Ok(s) if s.success() => Ok(out),
        _ => Err(tail.join("\n")),
    }
}
