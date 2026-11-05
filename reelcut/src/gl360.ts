// Flat view of a 360 picture, drawn with WebGL: an equirectangular sphere, or two fisheye lenses
// side by side (an Osmo .lrf, shown unstitched). The math is the same as ffmpeg's v360 filter
// (output=flat, yaw/pitch/roll quaternion in "ypr" order; input=dfisheye puts the front lens on
// the right half and the back lens mirrored on the left), so the preview looks where the export does.
import type { View } from "./types";
import { maxFov } from "./framing";
import { SEAM_NODES, SEAM_RANGE, SeamTrack, STRIP_H, STRIP_NR, STRIP_W } from "./seam360";

type Q = [number, number, number, number]; // w x y z
const qmul = (a: Q, b: Q): Q => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
export function rotation(v: View): Q {
  const h = (d: number) => (d * Math.PI) / 360;
  const qy: Q = [Math.cos(h(v.yaw)), 0, Math.sin(h(v.yaw)), 0];
  const qp: Q = [Math.cos(h(v.pitch)), Math.sin(h(v.pitch)), 0, 0];
  const qr: Q = [Math.cos(h(v.roll)), 0, 0, Math.sin(h(v.roll))];
  return qmul(qmul(qy, qp), qr);
}

/** Output pixel (u, v in 0–1, v down) → equirect texture coordinate (0–1). */
export function flatToEquirect(u: number, v: number, view: View, aspect: number): [number, number] {
  const tx = Math.tan((view.hfov * Math.PI) / 360);
  const ty = tx / aspect;
  let x = tx * (2 * u - 1), y = ty * (2 * v - 1), z = 1;
  const n = Math.hypot(x, y, z);
  x /= n; y /= n; z /= n;
  const q = rotation(view);
  const r = qmul(qmul(q, [0, x, y, z]), [q[0], -q[1], -q[2], -q[3]]);
  const phi = Math.atan2(r[1], r[3]), theta = Math.asin(Math.max(-1, Math.min(1, r[2])));
  return [(phi / Math.PI + 1) / 2, (theta / (Math.PI / 2) + 1) / 2];
}

/**
 * Direction → texture coordinate on two side-by-side fisheyes of `fov` degrees each (v360
 * input=dfisheye). null = outside both lens circles.
 */
export function dirToDfisheye(x: number, y: number, z: number, fov: number, swap = false): [number, number] | null {
  const h = Math.hypot(x, y);
  const r = Math.acos(Math.min(1, Math.abs(z))) / Math.PI / (fov / 360);
  if (r > 1) return null;
  const fx = 0.5 + 0.5 * r * (h > 0 ? x / h : 0), fy = 0.5 + 0.5 * r * (h > 0 ? y / h : 0);
  let u = z >= 0 ? 0.5 + fx * 0.5 : (1 - fx) * 0.5;
  if (swap) u = (u + 0.5) % 1;
  return [u, fy];
}

/** The strip under a live 360 stream's picture (src-tauri/src/live.rs `frame_marks`): 16 px high, blocks 32 px wide. */
export const MARK_H = 16;
const MARK_W = 32, MARK_BITS = 20;
/**
 * The frame number in one row of that strip (RGBA, from the left), or null if it is not one: the
 * block after the number is always white and the next always black.
 */
export function readMark(row: ArrayLike<number>): number | null {
  const on = (i: number) => row[(i * MARK_W + MARK_W / 2) * 4] > 128;
  if (!on(MARK_BITS) || on(MARK_BITS + 1)) return null;
  let k = 0;
  for (let b = 0; b < MARK_BITS; b++) if (on(b)) k += 2 ** b;
  return k;
}

/**
 * A lens as the export reads it (src-tauri/src/stitch.rs `LensCal`, pano.rs `Geo`), as shares of the
 * picture: r = f·θ(1 + k₁θ² + … + k₅θ¹⁰), round the centre (cu, cv).
 */
export type LensShape = { fu: number; fv: number; cu: number; cv: number; k: [number, number, number, number, number] };
/** A plain fisheye of `fov` degrees, centred. */
export const plainLens = (fov: number): LensShape => {
  const f = 1 / ((fov * Math.PI) / 180);
  return { fu: f, fv: f, cu: 0.5, cv: 0.5, k: [0, 0, 0, 0, 0] };
};
/** How the picture on the texture is laid out. "lenses": the back lens on the left half, the front on the right, joined here. */
export type Proj = { kind: "equirect" } | { kind: "dfisheye"; fov: number; swap: boolean }
  | { kind: "lenses"; back: LensShape; front: LensShape; yaw: number; pitch: number; roll: number; blend: number; band: number; fov: number; every: number };

const VS = `attribute vec2 p; varying vec2 uv; void main(){ uv = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.0,1.0); }`;
const LENS_AT = `vec2 lensAt(vec3 v, vec4 s, vec4 k, float k5){
  float h = length(v.xy);
  float a = atan(h, v.z);
  float t2 = a*a;
  float r = a*(1.0 + t2*(k.x + t2*(k.y + t2*(k.z + t2*(k.w + t2*k5)))));
  vec2 dir = h > 1e-9 ? v.xy/h : vec2(0.0);
  return s.zw + s.xy*r*dir;
}
vec4 qm(vec4 a, vec4 b){ return vec4(
  a.x*b.x - a.y*b.y - a.z*b.z - a.w*b.w,
  a.x*b.y + a.y*b.x + a.z*b.w - a.w*b.z,
  a.x*b.z - a.y*b.w + a.z*b.x + a.w*b.y,
  a.x*b.w + a.y*b.z - a.z*b.y + a.w*b.x); }
vec3 toBack(vec3 v, vec4 q){ return qm(qm(vec4(q.x, -q.yzw), vec4(0.0, v)), q).yzw; }
vec2 inA(vec2 a, vec2 vs){ return vec2(clamp(a.x, 0.001, 0.999)*0.5, min(a.y*vs.x, vs.y)); }
vec2 inB(vec2 b, vec2 vs){ return vec2(0.5 + clamp(b.x, 0.001, 0.999)*0.5, min(b.y*vs.x, vs.y)); }
`;
/** The strip for lining up the seam: R = back lens's luma, G = front lens's, B = both see this place. */
const STRIP_VS = `attribute vec2 p; varying vec2 st; void main(){ st = p*0.5+0.5; gl_Position = vec4(p,0.0,1.0); }`;
const STRIP_FS = `precision highp float;
varying vec2 st; uniform sampler2D tex; uniform vec2 vs; uniform vec4 backQ; uniform float reach; uniform float limit;
uniform vec4 shapeA; uniform vec4 kA; uniform float k5A; uniform vec4 shapeB; uniform vec4 kB; uniform float k5B;
${LENS_AT}
void main(){
  float u = -3.14159265 + st.x*6.2831853;
  float s = (st.y*2.0 - 1.0)*reach;
  vec3 v = vec3(cos(s)*cos(u), cos(s)*sin(u), sin(s));
  vec3 vb = toBack(v, backQ);
  vec3 l = vec3(0.299, 0.587, 0.114);
  float ca = dot(texture2D(tex, inA(lensAt(vb, shapeA, kA, k5A), vs)).rgb, l);
  float cb = dot(texture2D(tex, inB(lensAt(v, shapeB, kB, k5B), vs)).rgb, l);
  float seen = (acos(clamp(vb.z, -1.0, 1.0)) < limit && acos(clamp(v.z, -1.0, 1.0)) < limit) ? 1.0 : 0.0;
  gl_FragColor = vec4(ca, cb, seen, 1.0);
}`;
const FS = `precision highp float;
varying vec2 uv; uniform sampler2D tex; uniform vec4 q; uniform vec2 rng;
uniform float fish; uniform float frng; uniform float swp; uniform vec4 stab;
uniform float dist; uniform float rE; uniform float asp; uniform vec2 vs;
uniform float both; uniform vec4 backQ; uniform float bw;
uniform vec4 shapeA; uniform vec4 kA; uniform float k5A; uniform vec4 shapeB; uniform vec4 kB; uniform float k5B;
uniform sampler2D seamTex; uniform float sb; uniform float seamRange;
${LENS_AT}
vec3 dirOf(float u, float s){ return vec3(cos(s)*cos(u), cos(s)*sin(u), sin(s)); }
void main(){
  vec3 d;
  if (dist <= 0.0) d = normalize(vec3(rng.x*(2.0*uv.x-1.0), rng.y*(2.0*uv.y-1.0), 1.0));
  else {
    vec2 pp = vec2(2.0*uv.x-1.0, (2.0*uv.y-1.0)*asp) * rE;
    float rho = length(pp);
    if (rho < 1e-6) d = vec3(0.0, 0.0, 1.0);
    else {
      float kk = rho / (1.0 + dist);
      float aa = atan(kk) + asin(clamp(kk*dist/sqrt(1.0+kk*kk), -1.0, 1.0));
      d = vec3(pp/rho*sin(aa), cos(aa));
    }
  }
  vec4 r = qm(qm(q, vec4(0.0, d)), vec4(q.x, -q.yzw));
  r = qm(qm(stab, r), vec4(stab.x, -stab.yzw));
  vec2 t;
  if (both > 0.5) {
    vec3 v = r.yzw;
    float sn = asin(clamp(v.z, -1.0, 1.0));
    if (sb > 0.0) {
      // The band round the seam: each lens moved part of the way (pano.rs \`blend_band\`).
      if (abs(sn) < sb) {
        float un = atan(v.y, v.x);
        vec4 nd = texture2D(seamTex, vec2((un + 3.14159265)/6.2831853, 0.5));
        float fu = (nd.r - 0.5)*2.0*seamRange, fs = (nd.g - 0.5)*2.0*seamRange, ts = nd.b, gy = 0.85 + nd.a*0.33;
        float t = (sn + sb)/(2.0*sb);
        vec4 ca = texture2D(tex, inA(lensAt(toBack(dirOf(un - t*fu, sn - t*fs), backQ), shapeA, kA, k5A), vs));
        vec4 cb = texture2D(tex, inB(lensAt(dirOf(un + (1.0 - t)*fu, sn + (1.0 - t)*fs), shapeB, kB, k5B), vs));
        float wb = clamp((t - ts)/0.5 + 0.5, 0.0, 1.0);
        float ph = t < ts ? t/max(ts, 0.001) : (1.0 - t)/max(1.0 - ts, 0.001);
        float g = pow(gy, ph);
        gl_FragColor = vec4(mix(ca.rgb*g, cb.rgb/g, wb), 1.0);
      } else if (sn < 0.0) {
        gl_FragColor = texture2D(tex, inA(lensAt(toBack(v, backQ), shapeA, kA, k5A), vs));
      } else {
        gl_FragColor = texture2D(tex, inB(lensAt(v, shapeB, kB, k5B), vs));
      }
      return;
    }
    float f = clamp((sn*57.29578 + bw*0.5)/bw, 0.0, 1.0);
    vec4 ca = texture2D(tex, inA(lensAt(toBack(v, backQ), shapeA, kA, k5A), vs));
    vec4 cb = texture2D(tex, inB(lensAt(v, shapeB, kB, k5B), vs));
    gl_FragColor = mix(ca, cb, f);
    return;
  }
  if (fish > 0.5) {
    vec3 v = r.yzw;
    float h = length(v.xy);
    float k = acos(min(1.0, abs(v.z))) / 3.14159265 / frng;
    if (k > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec2 f = 0.5 + 0.5 * k * (h > 0.0 ? v.xy / h : vec2(0.0));
    t = vec2(v.z >= 0.0 ? 0.5 + f.x * 0.5 : (1.0 - f.x) * 0.5, f.y);
    if (swp > 0.5) t.x = fract(t.x + 0.5);
  } else {
    float phi = atan(r.y, r.w);
    float th = asin(clamp(r.z, -1.0, 1.0));
    t = vec2((phi/3.14159265 + 1.0)*0.5, (th/1.5707963 + 1.0)*0.5);
  }
  t.y = min(t.y * vs.x, vs.y);
  gl_FragColor = texture2D(tex, t);
}`;

export class Flat360 {
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  tex: WebGLTexture;
  private fb: WebGLFramebuffer | null = null;
  /** Lining up the seam: its program, picture and state. */
  private stripProg: WebGLProgram | null = null;
  private stripTex: WebGLTexture | null = null;
  private stripFb: WebGLFramebuffer | null = null;
  private stripPx = new Uint8Array(STRIP_W * STRIP_H * 4);
  private seamTex: WebGLTexture | null = null;
  private nodes = new Uint8Array(SEAM_NODES * 4);
  private seam = new SeamTrack();
  private seamFrame: number | string | null = null;
  private seamTick = 0;
  private row = new Uint8Array((MARK_W * (MARK_BITS + 2)) * 4);
  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("WebGL을 쓸 수 없습니다");
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, "p");
    gl.linkProgram(p);
    const sp = gl.createProgram()!;
    gl.attachShader(sp, sh(gl.VERTEX_SHADER, STRIP_VS));
    gl.attachShader(sp, sh(gl.FRAGMENT_SHADER, STRIP_FS));
    gl.bindAttribLocation(sp, 0, "p");
    gl.linkProgram(sp);
    this.stripProg = sp;
    gl.useProgram(p);
    this.prog = p;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }
  private lensUniforms(prog: WebGLProgram, proj: Extract<Proj, { kind: "lenses" }>) {
    const { gl } = this;
    const u = (n: string, s: LensShape, m: string, k5: string) => {
      gl.uniform4f(gl.getUniformLocation(prog, n), s.fu, s.fv, s.cu, s.cv);
      gl.uniform4f(gl.getUniformLocation(prog, m), s.k[0], s.k[1], s.k[2], s.k[3]);
      gl.uniform1f(gl.getUniformLocation(prog, k5), s.k[4]);
    };
    u("shapeA", proj.back, "kA", "k5A");
    u("shapeB", proj.front, "kB", "k5B");
    const b = rotation({ yaw: 180 + proj.yaw, pitch: proj.pitch, roll: proj.roll, hfov: 90 } as View);
    gl.uniform4f(gl.getUniformLocation(prog, "backQ"), b[0], b[1], b[2], b[3]);
  }
  /** Measures this frame's seam from the picture just uploaded (once per frame; a jump starts over). */
  private updateSeam(proj: Extract<Proj, { kind: "lenses" }>, key: number | string, vsA: number, vsB: number) {
    const { gl } = this;
    if (key === this.seamFrame) return;
    if (typeof key !== "number" || typeof this.seamFrame !== "number" || key < this.seamFrame || key - this.seamFrame > 3) { this.seam.reset(); this.seamTick = 0; }
    this.seamFrame = key;
    const measure = !this.seam.started || this.seamTick % Math.max(1, proj.every) === 0;
    this.seamTick++;
    if (!this.stripTex) {
      this.stripTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.stripTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, STRIP_W, STRIP_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.stripFb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.stripFb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.stripTex, 0);
      this.seamTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.seamTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SEAM_NODES, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
    }
    if (measure) {
    const sp = this.stripProg!;
    gl.useProgram(sp);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stripFb);
    gl.viewport(0, 0, STRIP_W, STRIP_H);
    gl.uniform2f(gl.getUniformLocation(sp, "vs"), vsA, vsB);
    gl.uniform1f(gl.getUniformLocation(sp, "reach"), (proj.band * STRIP_H) / STRIP_NR);
    gl.uniform1f(gl.getUniformLocation(sp, "limit"), (proj.fov * Math.PI) / 360);
    this.lensUniforms(sp, proj);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, STRIP_W, STRIP_H, gl.RGBA, gl.UNSIGNED_BYTE, this.stripPx);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.prog);
    this.seam.update(this.stripPx);
    (window as any).__seamStats?.push({ ...this.seam.last, k: key });
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    this.seam.ease();
    (window as any).__seamMoved?.push(this.seam.last.moved);
    this.seam.nodes(proj.band, this.nodes);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.seamTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SEAM_NODES, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.nodes);
    gl.activeTexture(gl.TEXTURE0);
  }
  /** The frame number under the picture just uploaded. */
  private frameMark(w: number, h: number): number | null {
    const { gl } = this;
    this.fb ??= gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    let k: number | null = null;
    if (w >= MARK_W * (MARK_BITS + 2) && gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      gl.readPixels(0, h - MARK_H / 2, MARK_W * (MARK_BITS + 2), 1, gl.RGBA, gl.UNSIGNED_BYTE, this.row);
      k = readMark(this.row);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return k;
  }
  /**
   * `stab`: the frame's stabilising turn (w, x, y, z), the same one the export applies. As a function
   * it gets the frame number the picture itself carries (null when it has none).
   */
  draw(src: TexImageSource, view: View, proj: Proj = { kind: "equirect" }, stab?: ArrayLike<number> | null | ((frame: number | null) => ArrayLike<number> | null)) {
    const { gl, canvas } = this;
    const w = canvas.clientWidth * devicePixelRatio, h = canvas.clientHeight * devicePixelRatio;
    if (canvas.width !== Math.round(w) || canvas.height !== Math.round(h)) { canvas.width = Math.round(w); canvas.height = Math.round(h); }
    gl.viewport(0, 0, canvas.width, canvas.height);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch { return; }
    // A stream with the strip: the picture is what lies above it.
    const vw = (src as HTMLVideoElement).videoWidth ?? 0, vh = (src as HTMLVideoElement).videoHeight ?? 0;
    const marked = vw > 0 && vh === vw / 2 + MARK_H;
    const vsA = marked ? (vh - MARK_H) / vh : 1, vsB = marked ? (vh - MARK_H - 0.5) / vh : 1;
    gl.uniform2f(gl.getUniformLocation(this.prog, "vs"), vsA, vsB);
    const mark = marked ? this.frameMark(vw, vh) : null;
    if (typeof stab === "function") stab = stab(mark);
    if (proj.kind === "lenses" && proj.band > 0) {
      const key = mark ?? (src instanceof HTMLImageElement ? src.src : (src as HTMLVideoElement).currentTime ?? 0);
      this.updateSeam(proj, typeof key === "number" && mark == null ? `t${key}` : key, vsA, vsB);
    }
    const q = rotation(view);
    const d = Math.max(0, Math.min(1, view.dist ?? 0));
    const tx = Math.tan((Math.max(20, Math.min(160, view.hfov)) * Math.PI) / 360);
    const half = (Math.max(20, Math.min(maxFov(d), view.hfov)) * Math.PI) / 360;
    gl.uniform1f(gl.getUniformLocation(this.prog, "dist"), d);
    gl.uniform1f(gl.getUniformLocation(this.prog, "rE"), ((1 + d) * Math.sin(half)) / (d + Math.cos(half)));
    gl.uniform1f(gl.getUniformLocation(this.prog, "asp"), canvas.height / Math.max(1, canvas.width));
    gl.uniform4f(gl.getUniformLocation(this.prog, "q"), q[0], q[1], q[2], q[3]);
    gl.uniform2f(gl.getUniformLocation(this.prog, "rng"), tx, (tx * canvas.height) / Math.max(1, canvas.width));
    gl.uniform4f(gl.getUniformLocation(this.prog, "stab"), stab ? stab[0] : 1, stab ? stab[1] : 0, stab ? stab[2] : 0, stab ? stab[3] : 0);
    const fish = proj.kind === "dfisheye";
    gl.uniform1f(gl.getUniformLocation(this.prog, "fish"), fish ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.prog, "frng"), fish ? proj.fov / 360 : 1);
    gl.uniform1f(gl.getUniformLocation(this.prog, "swp"), fish && proj.swap ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.prog, "both"), proj.kind === "lenses" ? 1 : 0);
    if (proj.kind === "lenses") {
      this.lensUniforms(this.prog, proj);
      gl.uniform1f(gl.getUniformLocation(this.prog, "bw"), proj.blend);
      gl.uniform1f(gl.getUniformLocation(this.prog, "sb"), proj.band);
      gl.uniform1f(gl.getUniformLocation(this.prog, "seamRange"), SEAM_RANGE);
      gl.uniform1i(gl.getUniformLocation(this.prog, "tex"), 0);
      gl.uniform1i(gl.getUniformLocation(this.prog, "seamTex"), 1);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
