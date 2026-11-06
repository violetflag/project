# Reelcut UX plan, 1.1.0 → 2.1.0 (John approved 2026-11-03: "2.1.0 까지 바로 진행해")

Full report: https://claude.ai/artifact/3JBwsrrYh77j6ArcunM5iK
Decisions (recommended options, accepted): Premiere-style panels + DaVinci-style stage tabs
(가져오기 · 편집 · 자막 · 내보내기) + magnetic toggle; multi-track in 2.0.0; plain Korean with
industry terms in tooltips.

## 1.1.0 — bugs, shortcuts, frame
- I/O marks that work; J/K/L shuttle; frame step; `?` shortcut list.
- Scrubber in draft mode; tabular (fixed-width) timecode digits.
- Whisper: first word after a long pause stamped ~1 s early; invented "감사합니다." in trailing silence.
- Visible focus rings; inline SVG icons instead of special characters; text ≥ 12 px.
- Single instance (second launch focuses the window); OSV + LRF shown as one item.
- Empty "새 프로젝트" entries don't pile up; button/menu alternatives to every drag.
- Menu bar, resizable panels (sizes saved), status bar (jobs · 저장됨 n초 전 · shortcuts), AI as a right-panel tab.

## 1.2.0 — inspector + export
- Inspector: transform (scale/position), color + LUT, audio, 360 view keyframes.
- Export: purpose presets (YouTube 4K/FHD, Shorts 9:16, archive high-compression, audio only),
  advanced options folded away, saved user presets, I/O range, queue (keep editing),
  Windows notification with 폴더 열기 · 재생 and size vs source.

## 2.0.0 — timeline
- Multi-track (V1/V2, A1/A2, captions), tools: select, razor, ripple, slip; J/L cuts; transitions; magnetic toggle.
- Old projects migrate.

## 2.1.0 — picking + AI
- Ratings, tags, markers in the bin; transcript selection ↔ timeline; AI result cards (preview, then apply).

Each version: bump package.json / Cargo.toml / tauri.conf.json, CHANGELOG entry, tests green,
install on John's PC (C:\claude-notebook\Reelcut-app). Real-AI check uses Haiku 5.5 in Claude 계정 mode.
