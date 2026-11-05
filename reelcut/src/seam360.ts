// Lines the two lenses up along the seam on every frame of the preview: the same steps as the export's
// engine (src-tauri/src/pano.rs `update_seam`; DJI's AI seam, done here by matching blocks): flow along
// the seam, a seam line that stays near last frame's, the brightness match, all eased over time. The
// strip comes from the graphics chip (gl360.ts): R = back lens, G = front lens, B = both see it.

export const STRIP_W = 512;
/** Core rows across the band, and margin rows each side for the search. */
export const STRIP_NR = 12;
export const STRIP_MR = 3;
export const STRIP_H = STRIP_NR + 2 * STRIP_MR;
/** Nodes the shader reads (a 64×1 texture, one RGBA8 texel each). */
export const SEAM_NODES = 64;
/** Range of the flow in that texture, radians, and of the brightness match. */
export const SEAM_RANGE = 0.08;
const GY_LO = 0.85, GY_HI = 1.18;

function gaussCirc(vals: Float32Array, wts: Float32Array, sigma: number, prior: number, priorW: number): Float32Array {
  const n = vals.length, r = Math.ceil(sigma * 3), out = new Float32Array(n);
  const g: number[] = [];
  for (let d = -r; d <= r; d++) g.push(Math.exp(-(d * d) / (2 * sigma * sigma)));
  for (let i = 0; i < n; i++) {
    let s = prior * priorW, w = priorW;
    for (let d = -r; d <= r; d++) {
      const j = ((i + d) % n + n) % n, k = g[d + r] * wts[j];
      s += vals[j] * k;
      w += k;
    }
    out[i] = w > 0 ? s / w : prior;
  }
  return out;
}

function expandCirc(blocks: Float32Array, n: number): Float32Array {
  const nb = blocks.length, out = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    const pos = ((c + 0.5) * nb) / n - 0.5, k0 = Math.floor(pos), f = pos - k0;
    const a = blocks[((k0 % nb) + nb) % nb], b = blocks[(((k0 + 1) % nb) + nb) % nb];
    out[c] = a + (b - a) * f;
  }
  return out;
}

export class SeamTrack {
  fx = new Float32Array(STRIP_W);
  fy = new Float32Array(STRIP_W);
  ts = new Float32Array(STRIP_W).fill(0.5);
  gy = new Float32Array(STRIP_W).fill(1);
  started = false;
  /** The last measure, which the state eases towards. */
  private tfx = new Float32Array(STRIP_W);
  private tfy = new Float32Array(STRIP_W);
  private tts = new Float32Array(STRIP_W).fill(0.5);
  private tgy = new Float32Array(STRIP_W).fill(1);
  /** The last measure: the two lenses' difference on the seam line without and with the alignment. How much the flow moved a frame. */
  last = { plain: 0, aligned: 0, moved: 0 };
  private a = new Float32Array(STRIP_W * STRIP_H);
  private b = new Float32Array(STRIP_W * STRIP_H);
  private ok = new Uint8Array(STRIP_W * STRIP_H);

  reset() {
    this.fx.fill(0); this.fy.fill(0); this.ts.fill(0.5); this.gy.fill(1);
    this.started = false;
  }

  private bil(img: Float32Array, x: number, y: number): number {
    const w = STRIP_W, h = STRIP_H;
    const yy = Math.max(0, Math.min(h - 1.001, y));
    const x0 = Math.floor(x), y0 = Math.floor(yy), fx = x - x0, fy = yy - y0;
    const c0 = ((x0 % w) + w) % w, c1 = (c0 + 1) % w;
    const top = img[y0 * w + c0] * (1 - fx) + img[y0 * w + c1] * fx;
    const bot = img[(y0 + 1) * w + c0] * (1 - fx) + img[(y0 + 1) * w + c1] * fx;
    return top + (bot - top) * fy;
  }

  /** Block matching along the seam; per block the flow and how far to trust it. */
  private flow(): [Float32Array, Float32Array, Float32Array] {
    const w = STRIP_W, a = this.a, b = this.b, ok = this.ok;
    const nb = w / 8, half = 8, ry = STRIP_MR, rx = 2;
    const fx = new Float32Array(nb), fy = new Float32Array(nb), wt = new Float32Array(nb);
    const costs = new Float32Array((2 * ry + 1) * (2 * rx + 1));
    const wrap = (x: number) => ((x % w) + w) % w;
    for (let k = 0; k < nb; k++) {
      const cb = Math.floor(((k + 0.5) * w) / nb);
      let sa = 0, sa2 = 0, na = 0;
      for (let r = STRIP_MR; r < STRIP_MR + STRIP_NR; r++) {
        for (let x = cb - half; x < cb + half; x++) {
          const i = r * w + wrap(x);
          if (ok[i]) { const v = a[i]; sa += v; sa2 += v * v; na++; }
        }
      }
      if (na < 16) continue;
      const ma = sa / na, vr = Math.max(0, sa2 / na - ma * ma);
      let best = Infinity, bx = 0, by = 0;
      costs.fill(Infinity);
      for (let dy = -ry; dy <= ry; dy++) {
        for (let dx = -rx; dx <= rx; dx++) {
          let sb = 0, nn = 0;
          for (let r = STRIP_MR; r < STRIP_MR + STRIP_NR; r++) {
            const rb = r + dy;
            if (rb < 0 || rb >= STRIP_H) continue;
            for (let x = cb - half; x < cb + half; x++) {
              const i = r * w + wrap(x), j = rb * w + wrap(x + dx);
              if (ok[i] && ok[j]) { sb += b[j]; nn++; }
            }
          }
          if (nn < na * 0.6) continue;
          const mb = sb / nn;
          let c = 0;
          for (let r = STRIP_MR; r < STRIP_MR + STRIP_NR; r++) {
            const rb = r + dy;
            if (rb < 0 || rb >= STRIP_H) continue;
            for (let x = cb - half; x < cb + half; x++) {
              const i = r * w + wrap(x), j = rb * w + wrap(x + dx);
              if (ok[i] && ok[j]) c += Math.abs(a[i] - ma - (b[j] - mb));
            }
          }
          c = c / nn + 0.02 * (Math.abs(dy) + Math.abs(dx));
          costs[(dy + ry) * (2 * rx + 1) + dx + rx] = c;
          if (c < best) { best = c; bx = dx; by = dy; }
        }
      }
      if (!isFinite(best)) continue;
      const cost = (dx: number, dy: number) => (Math.abs(dx) > rx || Math.abs(dy) > ry ? Infinity : costs[(dy + ry) * (2 * rx + 1) + dx + rx]);
      const sub = (m: number, p: number) => {
        if (!isFinite(m) || !isFinite(p)) return 0;
        const den = m - 2 * best + p;
        return den > 1e-6 ? Math.max(-0.5, Math.min(0.5, (0.5 * (m - p)) / den)) : 0;
      };
      fx[k] = bx + sub(cost(bx - 1, by), cost(bx + 1, by));
      fy[k] = by + sub(cost(bx, by - 1), cost(bx, by + 1));
      let wk = vr / (vr + 25);
      if (Math.abs(by) === ry || Math.abs(bx) === rx) wk *= 0.2;
      const z = cost(0, 0);
      if (isFinite(z) && z - best < 0.3) wk *= 0.5;
      wt[k] = wk;
    }
    return [fx, fy, wt];
  }

  /** The cut through the band: where the lenses agree, near the middle and near last frame's. */
  private seamLine(fx: Float32Array, fy: Float32Array): Float32Array {
    const w = STRIP_W, nrl = STRIP_NR;
    const loR = Math.ceil(nrl * 0.25), hiR = Math.min(nrl - 1, Math.max(loR + 1, Math.floor(nrl * 0.75)));
    const nrow = hiR - loR + 1, mid = (nrl - 1) / 2;
    const acc = new Float32Array(w * nrow), from = new Uint8Array(w * nrow);
    for (let c = 0; c < w; c++) {
      for (let k = 0; k < nrow; k++) {
        const r = loR + k, t = (r + 0.5) / nrl, y = STRIP_MR + r;
        const d = Math.abs(this.bil(this.a, c - t * fx[c], y - t * fy[c]) - this.bil(this.b, c + (1 - t) * fx[c], y + (1 - t) * fy[c]));
        let cost = d + 16 * ((r - mid) / nrl) ** 2;
        if (this.started) cost += Math.abs(r - (this.ts[c] * nrl - 0.5));
        if (c === 0) { acc[k] = cost; continue; }
        let best = Infinity, bj = 1;
        for (let j = 0; j < 3; j++) {
          const kk = k + j - 1;
          if (kk < 0 || kk >= nrow) continue;
          const v = acc[(c - 1) * nrow + kk] + (j === 1 ? 0 : 0.3);
          if (v < best) { best = v; bj = j; }
        }
        acc[c * nrow + k] = cost + best;
        from[c * nrow + k] = bj;
      }
    }
    let k = 0;
    for (let i = 1; i < nrow; i++) if (acc[(w - 1) * nrow + i] < acc[(w - 1) * nrow + k]) k = i;
    const path = new Float32Array(w);
    for (let c = w - 1; c >= 0; c--) {
      path[c] = (loR + k + 0.5) / nrl;
      if (c > 0) k = k + from[c * nrow + k] - 1;
    }
    return gaussCirc(path, new Float32Array(w).fill(1), 2, 0.5, 0);
  }

  /** One frame's strip (RGBA, STRIP_W × STRIP_H). */
  update(rgba: Uint8Array) {
    const n = STRIP_W * STRIP_H, w = STRIP_W;
    for (let i = 0; i < n; i++) {
      this.a[i] = rgba[i * 4];
      this.b[i] = rgba[i * 4 + 1];
      this.ok[i] = rgba[i * 4 + 2] > 127 ? 1 : 0;
    }
    const [bx, by, wt] = this.flow();
    const lfx = expandCirc(gaussCirc(bx, wt, 1.5, 0, 0.05), w);
    const lfy = expandCirc(gaussCirc(by, wt, 1.5, 0, 0.05), w).map((v) => Math.max(-STRIP_MR * 0.9, Math.min(STRIP_MR * 0.9, v)));
    const ts = this.seamLine(lfx, lfy);
    // Brightness at the cut, 64 groups round the circle.
    const groups = SEAM_NODES, sa = new Float64Array(groups), sb = new Float64Array(groups), cnt = new Float64Array(groups);
    const band = Math.max(1, Math.floor(STRIP_NR / 8));
    for (let c = 0; c < w; c++) {
      const g = Math.floor((c * groups) / w), rr = Math.floor(ts[c] * STRIP_NR);
      for (let r = Math.max(0, rr - band); r < Math.min(STRIP_NR, rr + band); r++) {
        if (!this.ok[(STRIP_MR + r) * w + c]) continue;
        const t = (r + 0.5) / STRIP_NR, y = STRIP_MR + r;
        sa[g] += this.bil(this.a, c - t * lfx[c], y - t * lfy[c]);
        sb[g] += this.bil(this.b, c + (1 - t) * lfx[c], y + (1 - t) * lfy[c]);
        cnt[g]++;
      }
    }
    const gv = new Float32Array(groups).fill(1), gw = new Float32Array(groups);
    for (let g = 0; g < groups; g++) {
      if (cnt[g] < 4 || sa[g] / cnt[g] < 12 || sb[g] / cnt[g] < 12) continue;
      gv[g] = Math.max(GY_LO, Math.min(GY_HI, Math.sqrt(sb[g] / sa[g])));
      gw[g] = 1;
    }
    const gy = expandCirc(gaussCirc(gv, gw, 1, 1, 0.1), w);
    this.tfx.set(lfx); this.tfy.set(lfy); this.tts.set(ts); this.tgy.set(gy);
    if (!this.started) {
      this.fx.set(lfx); this.fy.set(lfy); this.ts.set(ts); this.gy.set(gy);
    }
    let plain = 0, aligned = 0, m = 0;
    for (let c = 0; c < w; c += 2) {
      const mid = STRIP_MR + Math.floor(STRIP_NR / 2);
      if (!this.ok[mid * w + c]) continue;
      plain += Math.abs(this.a[mid * w + c] - this.b[mid * w + c]);
      const t = this.ts[c], y = STRIP_MR + t * STRIP_NR - 0.5;
      aligned += Math.abs(this.bil(this.a, c - t * this.fx[c], y - t * this.fy[c]) - this.bil(this.b, c + (1 - t) * this.fx[c], y + (1 - t) * this.fy[c]));
      m++;
    }
    this.last = { plain: plain / Math.max(1, m), aligned: aligned / Math.max(1, m), moved: this.last.moved };
    this.started = true;
  }

  /** One frame nearer the last measure, as the export does (pano.rs `ease_seam`). */
  ease() {
    let moved = 0;
    for (let c = 0; c < STRIP_W; c++) {
      const dx = (this.tfx[c] - this.fx[c]) * 0.3, dy = (this.tfy[c] - this.fy[c]) * 0.3;
      moved += Math.abs(dx) + Math.abs(dy);
      this.fx[c] += dx;
      this.fy[c] += dy;
      this.ts[c] += (this.tts[c] - this.ts[c]) * 0.3;
      this.gy[c] += (this.tgy[c] - this.gy[c]) * 0.12;
    }
    this.last.moved = moved / STRIP_W;
  }

  /**
   * The state as the shader reads it, into `out` (SEAM_NODES RGBA texels): flow round the seam and
   * across it (radians), where the cut is, the brightness match. `band` is the band's half width, radians.
   */
  nodes(band: number, out: Uint8Array) {
    const across = (2 * band) / STRIP_NR, along = (2 * Math.PI) / STRIP_W;
    const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
    for (let k = 0; k < SEAM_NODES; k++) {
      const c = Math.min(STRIP_W - 1, Math.floor(((k + 0.5) * STRIP_W) / SEAM_NODES));
      out[k * 4] = q((this.fx[c] * along) / (2 * SEAM_RANGE) + 0.5);
      out[k * 4 + 1] = q((this.fy[c] * across) / (2 * SEAM_RANGE) + 0.5);
      out[k * 4 + 2] = q(this.ts[c]);
      out[k * 4 + 3] = q((this.gy[c] - GY_LO) / (GY_HI - GY_LO));
    }
  }
}
