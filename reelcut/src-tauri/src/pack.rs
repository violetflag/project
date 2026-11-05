//! A project folder as one file to hand on (`.reelcutpack`, a zip), and a bundle of logs for telling
//! what went wrong. Neither holds footage. A pack leaves out `대화\비공개` (pictures of the family)
//! unless asked; the diagnostic bundle holds no pictures and no conversations at all.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

/// Zip entries and sizes here fit the plain format (no zip64); a pack this large is not a project.
const MAX_BYTES: u64 = 3_500_000_000;

fn rd16(b: &[u8], i: usize) -> Option<usize> {
    Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?) as usize)
}
fn rd32(b: &[u8], i: usize) -> Option<usize> {
    Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?) as usize)
}

/// Writes a zip of (name inside, file on disk). Returns its size.
pub fn write_zip(out: &Path, files: &[(String, PathBuf)]) -> Result<u64, String> {
    let tmp = out.with_extension("tmp");
    let mut f = std::io::BufWriter::new(std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?);
    let mut central = Vec::new();
    let mut at = 0u64;
    let err = |e: std::io::Error| e.to_string();
    for (name, path) in files {
        let data = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut crc = crc32fast::Hasher::new();
        crc.update(&data);
        let crc = crc.finalize();
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(&data).map_err(err)?;
        let packed = enc.finish().map_err(err)?;
        // Flag 0x800: names are UTF-8 (Korean folder names survive every unzip tool).
        let head = |sig: u32, central: bool| {
            let mut h = sig.to_le_bytes().to_vec();
            if central {
                h.extend(20u16.to_le_bytes());
            }
            h.extend(20u16.to_le_bytes());
            h.extend(0x800u16.to_le_bytes());
            h.extend(8u16.to_le_bytes());
            h.extend([0u8; 4]); // time and date: not kept
            h.extend(crc.to_le_bytes());
            h.extend((packed.len() as u32).to_le_bytes());
            h.extend((data.len() as u32).to_le_bytes());
            h.extend((name.len() as u16).to_le_bytes());
            h.extend(0u16.to_le_bytes());
            h
        };
        if at + packed.len() as u64 > MAX_BYTES {
            let _ = std::fs::remove_file(&tmp);
            return Err("묶을 내용이 너무 큽니다".into());
        }
        let local = head(0x0403_4b50, false);
        f.write_all(&local).and_then(|_| f.write_all(name.as_bytes())).and_then(|_| f.write_all(&packed)).map_err(err)?;
        central.extend(head(0x0201_4b50, true));
        central.extend([0u8; 10]); // comment, disk, attributes
        central.extend((at as u32).to_le_bytes());
        central.extend(name.as_bytes());
        at += (local.len() + name.len() + packed.len()) as u64;
    }
    f.write_all(&central).map_err(err)?;
    let mut end = 0x0605_4b50u32.to_le_bytes().to_vec();
    end.extend([0u8; 4]);
    end.extend((files.len() as u16).to_le_bytes());
    end.extend((files.len() as u16).to_le_bytes());
    end.extend((central.len() as u32).to_le_bytes());
    end.extend((at as u32).to_le_bytes());
    end.extend(0u16.to_le_bytes());
    f.write_all(&end).map_err(err)?;
    f.flush().map_err(err)?;
    drop(f);
    std::fs::rename(&tmp, out).map_err(|e| format!("{}: {e}", out.display()))?;
    std::fs::metadata(out).map(|m| m.len()).map_err(err)
}

/// A name from inside a zip as a path under `dest`; None if it would leave `dest`.
fn inside(dest: &Path, name: &str) -> Option<PathBuf> {
    let rel = Path::new(name);
    if name.contains('\\') || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(dest.join(rel))
}

/// Unpacks a zip this module wrote (or any plain one) into `dest`. Returns the files written.
pub fn read_zip(zip: &Path, dest: &Path) -> Result<Vec<PathBuf>, String> {
    let bad = || format!("{}: 묶음 파일이 아니거나 손상되었습니다", zip.display());
    let b = std::fs::read(zip).map_err(|e| format!("{}: {e}", zip.display()))?;
    let end = (0..=b.len().saturating_sub(22)).rev().find(|&i| b[i..].starts_with(&0x0605_4b50u32.to_le_bytes())).ok_or_else(bad)?;
    let count = rd16(&b, end + 10).ok_or_else(bad)?;
    let mut p = rd32(&b, end + 16).ok_or_else(bad)?;
    let mut out = Vec::new();
    let mut total = 0u64;
    for _ in 0..count {
        if !b.get(p..).is_some_and(|s| s.starts_with(&0x0201_4b50u32.to_le_bytes())) {
            return Err(bad());
        }
        let method = rd16(&b, p + 10).ok_or_else(bad)?;
        let (packed, size) = (rd32(&b, p + 20).ok_or_else(bad)?, rd32(&b, p + 24).ok_or_else(bad)?);
        let (nl, xl, cl) = (rd16(&b, p + 28).ok_or_else(bad)?, rd16(&b, p + 30).ok_or_else(bad)?, rd16(&b, p + 32).ok_or_else(bad)?);
        let local = rd32(&b, p + 42).ok_or_else(bad)?;
        let name = String::from_utf8_lossy(b.get(p + 46..p + 46 + nl).ok_or_else(bad)?).into_owned();
        p += 46 + nl + xl + cl;
        if name.ends_with('/') {
            continue;
        }
        let to = inside(dest, &name).ok_or_else(|| format!("{}: 폴더 밖을 가리키는 이름이 있어 열지 않았습니다", zip.display()))?;
        let start = local + 30 + rd16(&b, local + 26).ok_or_else(bad)? + rd16(&b, local + 28).ok_or_else(bad)?;
        let body = b.get(start..start + packed).ok_or_else(bad)?;
        total += size as u64;
        if total > MAX_BYTES * 3 {
            return Err(bad());
        }
        let mut data = Vec::with_capacity(size.min(1 << 28));
        match method {
            0 => data.extend_from_slice(body),
            8 => {
                flate2::read::DeflateDecoder::new(body).take(size as u64 + 1).read_to_end(&mut data).map_err(|_| bad())?;
            }
            _ => return Err(bad()),
        }
        if data.len() != size {
            return Err(bad());
        }
        if let Some(d) = to.parent() {
            std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
        }
        std::fs::write(&to, &data).map_err(|e| format!("{}: {e}", to.display()))?;
        out.push(to);
    }
    Ok(out)
}

/// Every file under `dir` as (name with `/`, path), in a steady order. `skip` is by folder name.
fn walk(dir: &Path, prefix: &str, skip: &dyn Fn(&str) -> bool, out: &mut Vec<(String, PathBuf)>) {
    let mut es: Vec<_> = std::fs::read_dir(dir).into_iter().flatten().flatten().collect();
    es.sort_by_key(|e| e.file_name());
    for e in es {
        let n = e.file_name().to_string_lossy().into_owned();
        let p = e.path();
        if p.is_dir() {
            if !skip(&n) {
                walk(&p, &format!("{prefix}{n}/"), skip, out);
            }
        } else if p.is_file() {
            out.push((format!("{prefix}{n}"), p));
        }
    }
}

/// What a pack of this project folder holds. Inside the zip everything sits under the folder's name.
pub fn pack_files(dir: &Path, private: bool) -> Vec<(String, PathBuf)> {
    let base = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "프로젝트".into());
    let mut v = Vec::new();
    walk(dir, &format!("{base}/"), &|n| !private && n == crate::project::PRIVATE, &mut v);
    v
}

/// What a diagnostic bundle holds: the app's logs, nothing else from the data folder.
pub fn diag_files(data: &Path) -> Vec<(String, PathBuf)> {
    let logs = data.join("logs");
    let mut v = Vec::new();
    for n in ["reelcut.log", "reelcut.old.log", "deletions.jsonl"] {
        let p = logs.join(n);
        if p.is_file() {
            v.push((format!("logs/{n}"), p));
        }
    }
    // The last exports: timings and errors. Their names are times, their lines hold no pictures.
    let mut ex: Vec<(String, PathBuf)> = Vec::new();
    walk(&logs.join("exports"), "logs/exports/", &|_| true, &mut ex);
    let keep = ex.len().saturating_sub(20);
    v.extend(ex.into_iter().skip(keep));
    v
}

/// A folder that does not exist yet: `base`, else `base (2)`, `base (3)`...
pub fn free_folder(root: &Path, base: &str) -> PathBuf {
    let first = root.join(base);
    if !first.exists() {
        return first;
    }
    (2..).map(|k| root.join(format!("{base} ({k})"))).find(|p| !p.exists()).unwrap()
}

/// `.reelcutpack` → a new folder under `root`, and the project file in it.
pub fn unpack(zip: &Path, root: &Path) -> Result<Value, String> {
    std::fs::create_dir_all(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let work = free_folder(root, &format!(".풀어놓는 중 {}", std::process::id()));
    let files = read_zip(zip, &work).inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&work);
    })?;
    // A pack holds one top folder; it becomes a folder of its own beside the others.
    let tops: std::collections::BTreeSet<_> = files.iter().filter_map(|f| f.strip_prefix(&work).ok()?.components().next().map(|c| c.as_os_str().to_owned())).collect();
    let fail = |m: String| {
        let _ = std::fs::remove_dir_all(&work);
        m
    };
    let [top] = tops.iter().collect::<Vec<_>>()[..] else { return Err(fail(format!("{}: 프로젝트 폴더가 하나가 아닙니다", zip.display()))) };
    let to = free_folder(root, &top.to_string_lossy());
    std::fs::rename(work.join(top), &to).map_err(|e| fail(e.to_string()))?;
    let _ = std::fs::remove_dir_all(&work);
    let file = std::fs::read_dir(&to).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|e| e == crate::project::EXT)).ok_or(format!("{}: 묶음에 프로젝트 파일이 없습니다", zip.display()))?;
    Ok(json!({ "folder": to.to_string_lossy(), "file": file.to_string_lossy() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(n: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("reelcut-pack-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn put(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }

    #[test]
    fn a_pack_leaves_out_the_private_folder_unless_asked() {
        let root = tmp("pack");
        let d = root.join("제주 여행");
        put(&d.join("제주 여행.reelcut"), "{}");
        put(&d.join("대화").join("a.jsonl"), "대화");
        put(&d.join("대화").join("비공개").join("img").join("x.png"), "picture");
        put(&d.join("기록").join("작업.jsonl"), "log");
        let names = |v: &[(String, PathBuf)]| v.iter().map(|x| x.0.clone()).collect::<Vec<_>>();
        let plain = pack_files(&d, false);
        assert_eq!(names(&plain), vec!["제주 여행/기록/작업.jsonl", "제주 여행/대화/a.jsonl", "제주 여행/제주 여행.reelcut"]);
        assert!(names(&pack_files(&d, true)).iter().any(|n| n.ends_with("x.png")));
        // Round trip, twice: the second lands in a folder of its own.
        let z = root.join("p.reelcutpack");
        write_zip(&z, &plain).unwrap();
        let to = root.join("새곳");
        let a = unpack(&z, &to).unwrap();
        assert_eq!(a["folder"], to.join("제주 여행").to_string_lossy().as_ref());
        assert_eq!(std::fs::read_to_string(to.join("제주 여행").join("대화").join("a.jsonl")).unwrap(), "대화");
        assert!(!to.join("제주 여행").join("대화").join("비공개").exists());
        let b = unpack(&z, &to).unwrap();
        assert_eq!(b["folder"], to.join("제주 여행 (2)").to_string_lossy().as_ref());
        assert_eq!(std::fs::read_dir(&to).unwrap().count(), 2, "no working folder left behind");
    }

    #[test]
    fn a_name_cannot_leave_the_folder() {
        let d = Path::new("x");
        assert!(inside(d, "a/b.txt").is_some());
        for bad in ["../a", "a/../../b", "/a", "a\\b", "C:/a"] {
            assert!(inside(d, bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn a_damaged_pack_is_refused_and_leaves_nothing() {
        let root = tmp("bad");
        let z = root.join("p.reelcutpack");
        std::fs::write(&z, b"not a zip at all, sorry, not at all").unwrap();
        let to = root.join("새곳");
        assert!(unpack(&z, &to).is_err());
        assert_eq!(std::fs::read_dir(&to).unwrap().count(), 0);
    }

    #[test]
    fn the_diagnostic_bundle_has_logs_only() {
        let data = tmp("diag");
        put(&data.join("logs").join("reelcut.log"), "x");
        put(&data.join("logs").join("exports").join("1.jsonl"), "x");
        put(&data.join("store").join("project-a.json"), "chat");
        put(&data.join("logs").join("actions").join("a.jsonl"), "x");
        put(&data.join("chat-images").join("a.png"), "picture");
        put(&data.join("claude").join("config").join("projects").join("s.jsonl"), "chat");
        let v = diag_files(&data);
        assert_eq!(v.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), vec!["logs/reelcut.log", "logs/exports/1.jsonl"]);
        let z = data.join("d.zip");
        write_zip(&z, &v).unwrap();
        let bytes = std::fs::read(&z).unwrap();
        for word in ["picture", "chat"] {
            assert!(!bytes.windows(word.len()).any(|w| w == word.as_bytes()), "{word}");
        }
    }
}
