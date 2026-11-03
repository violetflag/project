// 360 stabilisation in the inspector's 렌즈 group (DJI Studio's 흔들림 보정 / 수평 유지 /
// 방향 고정): the mode, how smoothly the picture follows the camera's turns, the rolling-shutter
// fix, and what the analysis used (the camera's gyro or the picture). The work is in
// src-tauri/src/motion.rs; changing anything makes the preview file again.
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { patchAsset, startProxy } from "../store";
import type { Asset, Lens, MotionInfo, Stab } from "../types";

export const DEFAULT_STAB: Stab = { mode: "horizon", strength: 1, rs: true };

const MODES: [Stab["mode"], string, string][] = [
  ["horizon", "수평 유지", "흔들림을 없애고 수평선을 늘 반듯하게, 방향은 카메라를 천천히 따라갑니다"],
  ["lock", "방향 고정", "카메라가 돌아도 처음 바라본 방향을 계속 봅니다"],
  ["smooth", "흔들림만 줄이기", "기울기는 그대로 두고 떨림만 없앱니다"],
  ["off", "끄기", "찍힌 그대로 둡니다"],
];

function lensOf(a: Asset): Lens {
  return a.lens ?? { layout: a.info.layout360, swap: false, fov: 190 };
}

function setStab(a: Asset, s: Stab) {
  patchAsset(a.id, { lens: { ...lensOf(a), stab: s }, proxy: null, strip: undefined });
  startProxy(a.id);
}

export function Stab360({ a }: { a: Asset }) {
  const [found, setFound] = useState<MotionInfo | null>(null);
  useEffect(() => {
    let live = true;
    api.motionInfo(a.info.path).then((m) => live && setFound(m)).catch(() => {});
    return () => { live = false; };
  }, [a.info.path, a.proxy]);
  const s = lensOf(a).stab ?? DEFAULT_STAB;
  const [strength, setStrength] = useState(s.strength);
  useEffect(() => setStrength(s.strength), [s.strength]);
  if (a.info.layout360 !== "dual" && a.info.layout360 !== "dfisheye") return null;
  const mode = MODES.find((m) => m[0] === s.mode) ?? MODES[0];
  return (
    <div class="stab360">
      <label>흔들림 보정
        <select value={s.mode} title={mode[2]} onChange={(e) => setStab(a, { ...s, mode: (e.target as HTMLSelectElement).value as Stab["mode"] })}>
          {MODES.map(([v, label, tip]) => <option value={v} title={tip}>{label}</option>)}
        </select>
      </label>
      {s.mode !== "off" && (
        <>
          <label title="클수록 카메라가 돌 때 화면이 더 천천히, 부드럽게 따라갑니다">부드러움 {strength.toFixed(1)}초
            <input type="range" min={0.2} max={5} step={0.1} value={strength}
              onInput={(e) => setStrength(Number((e.target as HTMLInputElement).value))}
              onChange={(e) => setStab(a, { ...s, strength: Number((e.target as HTMLInputElement).value) })} />
          </label>
          <label class="check" title="빠르게 돌 때 화면이 젤리처럼 휘는 것(롤링 셔터)을 바로잡습니다. 카메라의 자이로 기록이 있을 때 쓰입니다.">
            <input type="checkbox" checked={s.rs} onChange={(e) => setStab(a, { ...s, rs: (e.target as HTMLInputElement).checked })} />
            젤리 현상(롤링 셔터) 보정
          </label>
          <p class="muted tip">
            {a.proxyState === "running" && a.proxyStage ? "카메라 움직임을 분석하는 중…"
              : found ? `${found.source === "gyro" ? "카메라 자이로 기록 사용" : "화면 움직임으로 분석"} · ${found.note}`
              : a.info.djmd ? "카메라 자이로 기록으로 보정합니다 (미리보기 파일을 만들 때 분석)"
              : "자이로 기록이 없어 화면 움직임으로 분석합니다"}
          </p>
        </>
      )}
    </div>
  );
}
