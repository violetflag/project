// The 360 seam-stitching control in the inspector's 렌즈 group: on/off, what the automatic
// calibration found, and a button to run it again. The work is in src-tauri/src/stitch.rs; the
// live preview of an .osv uses it too.
import { patchAsset, prepare360 } from "../store";
import type { Asset, Lens, Stitch } from "../types";

const defaults: Stitch = { on: true, fov: 0, yaw: 0, pitch: 0, roll: 0, gain_a: [1, 0, 0], gain_b: [1, 0, 0], calibrated: false, before: 0, after: 0, flow: true };

function lensOf(a: Asset): Lens {
  return a.lens ?? { layout: a.info.layout360, swap: false, fov: 190 };
}

function setStitch(a: Asset, s: Stitch) {
  patchAsset(a.id, { lens: { ...lensOf(a), stitch: s } });
  prepare360(a.id);
}

const pct = (g: number) => `${g >= 1 ? "+" : ""}${Math.round((g - 1) * 1000) / 10}%`;
const deg = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}°`;

export function Stitch360({ a }: { a: Asset }) {
  if (a.info.layout360 !== "dual" && a.info.layout360 !== "dfisheye") return null;
  const s = lensOf(a).stitch ?? defaults;
  return (
    <div class="stitch360">
      <label class="check">
        <input type="checkbox" checked={s.on} onChange={(e) => setStitch(a, { ...s, on: (e.target as HTMLInputElement).checked })} />
        이음새 자동 스티칭
      </label>
      {s.on && (
        a.stitching ? <p class="muted tip">두 렌즈가 겹치는 부분을 보고 맞추는 중…</p>
        : s.calibrated ? (
          <p class="muted tip">
            자동 보정됨 · 화각 {s.fov.toFixed(1)}° · 뒤 렌즈 {deg(s.yaw)} / {deg(s.pitch)} / {deg(s.roll)} · 밝기 {pct(s.gain_b[0])}
            {s.before > 0 && <> · 이음새 차이 {s.before.toFixed(1)} → {s.after.toFixed(1)}</>}
          </p>
        ) : <p class="muted tip">불러올 때 자동으로 맞춥니다. 겹치는 띠 가운데를 부드럽게 섞어 이어 붙입니다.</p>
      )}
      {s.on && (
        <label class="check" title="두 렌즈가 겹치는 띠를 프레임마다 다시 비교해, 가까운 물체나 움직이는 사람이 이음새에서 어긋나지 않게 맞춥니다 (DJI의 AI 이음새와 같은 역할)">
          <input type="checkbox" checked={s.flow !== false} onChange={(e) => setStitch(a, { ...s, flow: (e.target as HTMLInputElement).checked })} />
          프레임마다 이음새 다시 맞추기 (AI 이음새)
        </label>
      )}
      {s.on && !a.stitching && (
        <button class="small" onClick={() => setStitch(a, { ...defaults, on: true, flow: s.flow !== false })} title="두 렌즈의 각도·화각·밝기를 다시 찾습니다">다시 맞추기</button>
      )}
    </div>
  );
}
