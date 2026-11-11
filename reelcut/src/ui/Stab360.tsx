// 360 levelling and stabilisation in the inspector's 렌즈 group (DJI Studio's 흔들림 보정 / 수평 유지 /
// 방향 고정): the mode, how smoothly a stabilised picture follows the camera's turns, the rolling-shutter
// fix, and what the analysis used (the camera's gyro or the picture). The work is in
// src-tauri/src/motion.rs and shows in the exported file; the analysis runs at the first export,
// or ahead of it with the 흔들림 분석 button.
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { analyzeMotion, patchAsset, useStore } from "../store";
import type { Asset, Lens, MotionInfo, Stab } from "../types";

export const DEFAULT_STAB: Stab = { mode: "horizon", strength: 1, rs: true };

const MODES: [Stab["mode"], string, string][] = [
  ["horizon", "수평만 맞추기", "수평선을 천천히 맞춥니다. 카메라 움직임은 찍힌 그대로 둡니다"],
  ["tilt", "기울기 복원", "프레임마다 기울기를 없앱니다. 도는 움직임은 그대로 둡니다"],
  ["forward", "진행 방향 보기", "수평을 맞추고, 카메라가 향하는 쪽을 0.5초쯤 늦게 부드럽게 따라갑니다 (DJI 전진 뷰와 같게 맞춤)"],
  ["eis", "수평 + 흔들림 보정", "수평을 맞추고 화면을 공간에 고정합니다. 카메라가 돌아도 보던 방향 그대로 보고, 방향은 시점 키로 돌립니다 (DJI 흔들림 보정 + 수평과 같게 맞춤)"],
  ["lock", "방향 고정", "수평을 맞추고, 카메라가 돌아도 처음 바라본 방향을 계속 봅니다 (수평 + 흔들림 보정과 같은 움직임)"],
  ["smooth", "흔들림만 보정", "기울기는 그대로 두고 손떨림만 없앱니다 (DJI 흔들림 보정, 수평 끔)"],
  ["off", "끄기", "찍힌 그대로 둡니다"],
];

function lensOf(a: Asset): Lens {
  return a.lens ?? { layout: a.info.layout360, swap: false, fov: 190 };
}

function setStab(a: Asset, s: Stab) {
  patchAsset(a.id, { lens: { ...lensOf(a), stab: s } }, "흔들림 설정");
}

export function Stab360({ a }: { a: Asset }) {
  const s0 = useStore();
  const busy = a.id in s0.motion;
  const [found, setFound] = useState<MotionInfo | null>(null);
  useEffect(() => {
    let live = true;
    api.motionInfo(a.info.path).then((m) => live && setFound(m)).catch(() => {});
    return () => { live = false; };
  }, [a.info.path, busy]);
  const s = lensOf(a).stab ?? DEFAULT_STAB;
  const [strength, setStrength] = useState(s.strength);
  useEffect(() => setStrength(s.strength), [s.strength]);
  if (a.info.layout360 !== "dual" && a.info.layout360 !== "dfisheye") return null;
  const mode = MODES.find((m) => m[0] === s.mode) ?? MODES[0];
  return (
    <div class="stab360">
      <label>수평·흔들림
        <select value={s.mode} title={mode[2]} onChange={(e) => setStab(a, { ...s, mode: (e.target as HTMLSelectElement).value as Stab["mode"] })}>
          {MODES.map(([v, label, tip]) => <option value={v} title={tip}>{label}</option>)}
        </select>
      </label>
      {s.mode !== "off" && (
        <>
          {s.mode === "smooth" && (
            <label title="클수록 카메라가 돌 때 화면이 더 천천히, 부드럽게 따라갑니다">부드러움 {strength.toFixed(1)}초
              <input type="range" min={0.2} max={5} step={0.1} value={strength}
                onInput={(e) => setStrength(Number((e.target as HTMLInputElement).value))}
                onChange={(e) => setStab(a, { ...s, strength: Number((e.target as HTMLInputElement).value) })} />
            </label>
          )}
          <label class="check" title="빠르게 돌 때 화면이 젤리처럼 휘는 것(롤링 셔터)을 바로잡습니다. 카메라의 자이로 기록이 있을 때 쓰입니다.">
            <input type="checkbox" checked={false} disabled title="검증 중 (2.18에서는 꺼짐)" />
            젤리 현상(롤링 셔터) 보정
          </label>
          <p class="muted tip">
            {busy ? `카메라 움직임을 분석하는 중… ${Math.round(s0.motion[a.id])}%`
              : found ? `${found.source === "gyro" ? "카메라 자이로 기록 사용" : "화면 움직임으로 분석"} · ${found.note}`
              : `분석 전 · ${a.info.djmd ? "카메라 자이로 기록으로 보정합니다" : "자이로 기록이 없어 화면 움직임으로 분석합니다"}`}
          </p>
          {!found && !busy && (
            <button class="small" onClick={() => analyzeMotion(a.id)} title="처음 내보낼 때 할 분석을 미리 해 둡니다 (진행은 아래 상태 표시줄에)">움직임 분석</button>
          )}
          <p class="muted tip">분석이 끝나면 미리보기도 내보낼 파일과 같은 방향으로 수평이 맞춰집니다.</p>
        </>
      )}
    </div>
  );
}
