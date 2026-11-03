//! End-to-end check with a real ffmpeg (run with REELCUT_FX=<fixture dir> cargo test itest -- --nocapture).
//! Fixtures: CAM_0001.OSV (two square video streams + audio), CAM_0001.LRF, walk.mp4, song.mp3.

use crate::args::Settings;
use crate::ff::{self, Jobs};
use crate::hw::Hw;
use crate::media::{self, Lens, View};
use crate::render::{self, Music, Plan, Seg};
use std::path::{Path, PathBuf};

fn bin(name: &str) -> PathBuf {
    PathBuf::from(std::env::var("FFDIR").unwrap_or_else(|_| "/usr/bin".into())).join(name)
}

fn dur(p: &Path) -> f64 {
    let (_, out, _) = ff::output(&bin("ffprobe"), &["-v".into(), "error".into(), "-show_entries".into(), "format=duration".into(), "-of".into(), "csv=p=0".into(), p.to_string_lossy().into_owned()]).unwrap();
    out.trim().parse().unwrap_or(0.0)
}

fn ffmpeg_major() -> u32 {
    let (_, out, _) = ff::output(&bin("ffmpeg"), &["-version".into()]).unwrap();
    out.split_whitespace().nth(2).and_then(|v| v.trim_start_matches(|c: char| !c.is_ascii_digit()).split('.').next()?.parse().ok()).unwrap_or(6)
}

#[test]
fn itest_real_ffmpeg() {
    let Ok(fx) = std::env::var("REELCUT_FX") else { return };
    let fx = PathBuf::from(fx);
    let work = fx.join("work");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    let ffprobe = bin("ffprobe");
    let ffmpeg = bin("ffmpeg");
    let jobs = Jobs::default();

    let osv = media::inspect(&ffprobe, &fx.join("CAM_0001.OSV").to_string_lossy()).unwrap();
    println!("osv: layout={} {}x{} streams={} lrf={:?}", osv.layout360, osv.width, osv.height, osv.videos.len(), osv.lrf);
    assert_eq!(osv.layout360, "dual");
    assert!(osv.lrf.is_some(), "LRF companion found");
    let walk = media::inspect(&ffprobe, &fx.join("walk.mp4").to_string_lossy()).unwrap();
    assert_eq!(walk.layout360, "none");
    let song = media::inspect(&ffprobe, &fx.join("song.mp3").to_string_lossy()).unwrap();
    assert_eq!(song.kind, "audio");

    // proxies
    for (info, lens) in [(&osv, Lens { layout: "dual".into(), swap: false, fov: 190.0, stitch: None }), (&walk, Lens { layout: "none".into(), swap: false, fov: 190.0, stitch: None }), (&song, Lens::default())] {
        let plan = media::proxy_plan(info, &lens, "libx264", &work, &info.name.replace('.', "_")).unwrap();
        ff::run_ffmpeg(&jobs, "p", jobs.generation("p"), &ffmpeg, &plan.args, |_| {}).unwrap_or_else(|e| panic!("proxy {}: {e}", info.name));
        println!("proxy {} -> {} ({:.2}s)", info.name, plan.out.display(), dur(&plan.out));
        assert!(dur(&plan.out) > 1.0);
    }
    let lrf = media::inspect(&ffprobe, &fx.join("CAM_0001.LRF").to_string_lossy()).unwrap();
    assert_eq!(lrf.layout360, "dfisheye", "LRF alone is side-by-side fisheye");

    // frames + contact sheet on the equirect proxy
    let eq = work.join("CAM_0001_OSV.mp4");
    let shots = media::frames(&ffmpeg, &media::FrameReq { path: eq.to_string_lossy().into_owned(), times: vec![1.0, 2.0], width: Some(320), view: Some(View { yaw: 30.0, pitch: 0.0, roll: 0.0, hfov: 90.0 }) }).unwrap();
    assert_eq!(shots.len(), 2);
    let sheet = media::contact_sheet(&ffmpeg, &walk.path, 0.0, 1.0, 3, 2, 160).unwrap();
    assert!(sheet.len() > 1000);

    let seg = |info: &media::MediaInfo, start: f64, d: f64, speed: f64, r360: bool| Seg {
        path: info.path.clone(), kind: info.kind.clone(), start, dur: d, speed, volume: 1.0, has_audio: info.has_audio,
        lens: if r360 { Some(Lens { layout: info.layout360.clone(), swap: false, fov: 190.0, stitch: None }) } else { None },
        view: if r360 { Some(View { yaw: 45.0, pitch: -10.0, roll: 0.0, hfov: 100.0 }) } else { None },
        fit: "fit".into(), fade_in: 0.3, fade_out: 0.3, ..Default::default()
    };
    let ass = "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,80,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,1,2,60,60,120,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,안녕하세요 자막\n";
    let hw = Hw { threads: 4, ..Default::default() };
    let shrink = Settings { codec: "hevc".into(), crf: 28, speed: 8, fps: "src".into(), res: "src".into(), denoise: 0, acodec: "opus".into(), abr: 96, container: "mkv".into(), screen: false, vfr: true };
    let cases: Vec<(&str, Plan)> = vec![
        ("standard.mp4", Plan { segs: vec![seg(&walk, 1.0, 3.0, 1.0, false), seg(&osv, 0.5, 4.0, 2.0, true)], music: vec![Music { path: song.path.clone(), start: 0.0, dur: 30.0, at: 0.5, volume: 0.3, fade_in: 1.0, fade_out: 1.0, ..Default::default() }], width: 1080, height: 1920, fps: 30.0, ass: ass.into(), mode: "standard".into(), vbitrate: 8000, settings: None, out: String::new(), ..Default::default() }),
        ("shrink.mkv", Plan { segs: vec![seg(&osv, 0.0, 3.0, 1.0, true), seg(&walk, 2.0, 2.0, 0.5, false)], music: vec![], width: 1280, height: 720, fps: 30.0, ass: String::new(), mode: "shrink".into(), vbitrate: 8000, settings: Some(shrink.clone()), out: String::new(), ..Default::default() }),
        ("shrink.mp4", Plan { segs: vec![seg(&walk, 0.0, 3.0, 1.0, false)], music: vec![], width: 854, height: 480, fps: 30.0, ass: String::new(), mode: "shrink".into(), vbitrate: 8000, settings: Some(Settings { codec: "h264".into(), acodec: "aac".into(), abr: 144, container: "mp4".into(), ..shrink.clone() }), out: String::new(), ..Default::default() }),
        ("audio.wav", Plan { segs: vec![seg(&walk, 0.0, 2.0, 1.0, false), seg(&osv, 0.0, 2.0, 1.0, true)], music: vec![], width: 854, height: 480, fps: 30.0, ass: String::new(), mode: "audio".into(), vbitrate: 8000, settings: None, out: String::new(), ..Default::default() }),
    ];
    for (name, p) in cases {
        let out = work.join(name);
        let has_ass = !p.ass.is_empty();
        if has_ass {
            std::fs::write(work.join("captions.ass"), &p.ass).unwrap();
        }
        let gf = work.join("graph.txt");
        let b = render::build(&p, &hw, &gf.to_string_lossy(), ffmpeg_major() >= 7, has_ass, &out.to_string_lossy()).unwrap();
        std::fs::write(&gf, &b.graph).unwrap();
        ff::run_ffmpeg_in(&jobs, "e", jobs.generation("e"), &ffmpeg, &b.args, Some(&work), |_| {}).unwrap_or_else(|e| panic!("{name}: {e}\n{}", b.graph));
        let d = dur(&out);
        println!("{name}: expected {:.2}s got {:.2}s, {} bytes", b.duration, d, std::fs::metadata(&out).unwrap().len());
        assert!((d - b.duration).abs() < 0.25, "{name} duration");
    }
}
