//! Which GPU encoders work on this PC (requirements §3): a 640×360, 5-frame test encode per
//! encoder, MeetingLog's `_works()` way. The result is cached and redone when the graphics driver
//! or ffmpeg changes.

use serde::{Deserialize, Serialize};
use std::path::Path;

pub const AV1: [&str; 3] = ["av1_nvenc", "av1_qsv", "av1_amf"];
pub const HEVC: [&str; 3] = ["hevc_nvenc", "hevc_qsv", "hevc_amf"];
pub const H264: [&str; 3] = ["h264_nvenc", "h264_qsv", "h264_amf"];

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Hw {
    pub key: String,
    pub threads: u32,
    pub gpus: Vec<String>,
    pub ffmpeg_version: String,
    /// Every GPU encoder this ffmpeg has, and whether the test encode passed.
    pub tested: Vec<(String, bool)>,
    pub av1: Option<String>,
    pub hevc: Option<String>,
    pub h264: Option<String>,
    pub has_x265: bool,
    pub has_x264: bool,
    pub has_opus: bool,
}

pub fn threads() -> u32 {
    std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(4)
}

fn gpus() -> Vec<String> {
    let args: Vec<String> = ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + '|' + $_.DriverVersion }"]
        .iter()
        .map(|x| x.to_string())
        .collect();
    crate::ff::output(Path::new("powershell.exe"), &args)
        .map(|(_, out, _)| out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

fn test_args(enc: &str) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=640x360:r=30", "-frames:v", "5", "-c:v", enc, "-pix_fmt", "nv12"]
        .iter()
        .map(|x| x.to_string())
        .collect();
    a.extend(["-f", "null", "-"].iter().map(|x| x.to_string()));
    a
}

pub fn detect(ffmpeg: &Path, cache: &Path, force: bool) -> Hw {
    let gpus = gpus();
    let (_, ver, _) = crate::ff::output(ffmpeg, &["-hide_banner".into(), "-version".into()]).unwrap_or_default();
    let ffmpeg_version = ver.lines().next().unwrap_or("").replace("ffmpeg version ", "").split_whitespace().next().unwrap_or("").to_string();
    let key = format!("{}|{}", gpus.join(";"), ffmpeg_version);
    if !force {
        if let Some(h) = std::fs::read_to_string(cache).ok().and_then(|s| serde_json::from_str::<Hw>(&s).ok()) {
            if h.key == key {
                return Hw { threads: threads(), ..h };
            }
        }
    }
    let (_, list, _) = crate::ff::output(ffmpeg, &["-hide_banner".into(), "-encoders".into()]).unwrap_or_default();
    let has = |e: &str| list.split_whitespace().any(|w| w == e);
    let mut tested = Vec::new();
    let mut pick = |cands: &[&str]| -> Option<String> {
        let mut found = None;
        for e in cands.iter().filter(|e| has(e)) {
            let ok = crate::ff::output(ffmpeg, &test_args(e)).map(|(ok, _, _)| ok).unwrap_or(false);
            tested.push((e.to_string(), ok));
            if ok && found.is_none() {
                found = Some(e.to_string());
            }
        }
        found
    };
    let (av1, hevc, h264) = (pick(&AV1), pick(&HEVC), pick(&H264));
    let hw = Hw {
        key,
        threads: threads(),
        gpus,
        ffmpeg_version,
        tested,
        av1,
        hevc,
        h264,
        has_x265: has("libx265"),
        has_x264: has("libx264"),
        has_opus: has("libopus"),
    };
    if let Some(dir) = cache.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(cache, serde_json::to_string_pretty(&hw).unwrap_or_default());
    hw
}

/// Free memory in MB (Windows; elsewhere a figure that allows one worker).
#[cfg(windows)]
pub fn avail_mb() -> u64 {
    #[repr(C)]
    struct Mem { len: u32, load: u32, total: u64, avail: u64, page_total: u64, page_avail: u64, virt_total: u64, virt_avail: u64, ext: u64 }
    extern "system" {
        fn GlobalMemoryStatusEx(m: *mut Mem) -> i32;
    }
    let mut m = Mem { len: std::mem::size_of::<Mem>() as u32, load: 0, total: 0, avail: 0, page_total: 0, page_avail: 0, virt_total: 0, virt_avail: 0, ext: 0 };
    // Safe: the struct is the documented MEMORYSTATUSEX with its size set.
    if unsafe { GlobalMemoryStatusEx(&mut m) } != 0 { m.avail / (1 << 20) } else { 4000 }
}
#[cfg(not(windows))]
pub fn avail_mb() -> u64 {
    4000
}

/// Free disk space where `path` is, in MB (0 when it cannot be read).
#[cfg(windows)]
pub fn free_mb(path: &std::path::Path) -> u64 {
    use std::os::windows::ffi::OsStrExt;
    extern "system" {
        fn GetDiskFreeSpaceExW(dir: *const u16, free: *mut u64, total: *mut u64, total_free: *mut u64) -> i32;
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free = 0u64;
    // Safe: `wide` is a NUL-terminated path; the null out-pointers are allowed.
    if unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) } != 0 { free / (1 << 20) } else { 0 }
}
#[cfg(not(windows))]
pub fn free_mb(_path: &std::path::Path) -> u64 {
    0
}

/// How many clips the 360 stage runs at once: each needs its own decoder's memory.
pub fn clip_workers(avail_mb: u64, gpu: bool) -> usize {
    if !gpu {
        return 1;
    }
    (avail_mb.saturating_sub(3000) / 1500).clamp(1, 2) as usize
}

#[cfg(test)]
mod worker_tests {
    use super::*;

    #[test]
    fn workers_fit_memory_and_need_the_gpu() {
        assert_eq!(clip_workers(16000, false), 1);
        assert_eq!(clip_workers(16000, true), 2);
        assert_eq!(clip_workers(4000, true), 1);
        assert_eq!(clip_workers(1000, true), 1);
    }
}
