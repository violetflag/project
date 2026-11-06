# Reelcut

자기 PC에서 쓰는 영상 편집 앱입니다 (Tauri 2 + Rust + Preact). 대본으로 편집하고, Claude AI 에이전트가 직접 편집하며,
DJI Osmo 360의 `.osv`·`.lrf` 파일을 360 영상으로 열고, Shrink 앱처럼 크게 줄여서 내보낼 수 있습니다.

## 빌드 (Windows)

1. `src-tauri/bin/`에 `ffmpeg.exe`, `ffprobe.exe`, `whisper/whisper-cli.exe`(whisper.cpp, DLL 포함)를 넣습니다.
2. `npm install`
3. `npx tauri build` → `src-tauri/target/release/bundle/nsis/` 에 설치 파일

## 테스트

- `npm test` (편집 동작, 자막, 360 시점 계산, 내보내기 설정)
- `cd src-tauri && cargo test` (ffmpeg 인자, 필터 그래프)
- 실제 ffmpeg로 끝까지: `REELCUT_FX=<fixture 폴더> FFDIR=<ffmpeg 폴더> cargo test itest -- --nocapture`
