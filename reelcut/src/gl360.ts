// Flat view of an equirectangular picture, drawn with WebGL. The math is the same as ffmpeg's
// v360 filter (output=flat, yaw/pitch/roll quaternion in "ypr" order), so what the preview shows
// is what the export makes.
import type { View } from "./types";

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

const VS = `attribute vec2 p; varying vec2 uv; void main(){ uv = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.0,1.0); }`;
const FS = `precision highp float;
varying vec2 uv; uniform sampler2D tex; uniform vec4 q; uniform vec2 rng;
vec4 qm(vec4 a, vec4 b){ return vec4(
  a.x*b.x - a.y*b.y - a.z*b.z - a.w*b.w,
  a.x*b.y + a.y*b.x + a.z*b.w - a.w*b.z,
  a.x*b.z - a.y*b.w + a.z*b.x + a.w*b.y,
  a.x*b.w + a.y*b.z - a.z*b.y + a.w*b.x); }
void main(){
  vec3 d = normalize(vec3(rng.x*(2.0*uv.x-1.0), rng.y*(2.0*uv.y-1.0), 1.0));
  vec4 r = qm(qm(q, vec4(0.0, d)), vec4(q.x, -q.yzw));
  float phi = atan(r.y, r.w);
  float th = asin(clamp(r.z, -1.0, 1.0));
  vec2 t = vec2((phi/3.14159265 + 1.0)*0.5, (th/1.5707963 + 1.0)*0.5);
  gl_FragColor = texture2D(tex, t);
}`;

export class Flat360 {
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  tex: WebGLTexture;
  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: false, antialias: false });
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
    gl.linkProgram(p);
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
  draw(src: TexImageSource, view: View) {
    const { gl, canvas } = this;
    const w = canvas.clientWidth * devicePixelRatio, h = canvas.clientHeight * devicePixelRatio;
    if (canvas.width !== Math.round(w) || canvas.height !== Math.round(h)) { canvas.width = Math.round(w); canvas.height = Math.round(h); }
    gl.viewport(0, 0, canvas.width, canvas.height);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch { return; }
    const q = rotation(view);
    const tx = Math.tan((Math.max(20, Math.min(160, view.hfov)) * Math.PI) / 360);
    gl.uniform4f(gl.getUniformLocation(this.prog, "q"), q[0], q[1], q[2], q[3]);
    gl.uniform2f(gl.getUniformLocation(this.prog, "rng"), tx, (tx * canvas.height) / Math.max(1, canvas.width));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
