// The one renderer every section scene on the page shares. Loaded by loader.js only when the first
// scene nears the viewport. Its single canvas moves into the scene at the viewport's centre; the
// scene it leaves keeps a 2D snapshot of its last frame. A scene may have beats, one per step of
// its section: the pinned panel shows the beat of the step in focus.
//
// Calm by construction: no post-processing, no auto-orbit, no timers. Native scroll drives each
// scene's timeline (loader.js reports progress through a beat, 0 to 1, and scrolling back reverses
// it); the scene follows with a light damped ease and draws only while it is catching up. Only one
// part moves in a beat, and the camera turns at most 3° across the whole scene.
import {
  Color, DirectionalLight, HemisphereLight, PCFShadowMap, PerspectiveCamera, PointLight, Scene, Vector3, WebGLRenderer,
} from 'three';
import { accentRGB } from './common.js';
import { SCENES } from './scenes.js';

// Sun direction (degrees: elevation, azimuth from the front, + to the right), colour and sky per
// phase, and how bright the accent-tinted lamp over the scene's resting point is.
const PHASE = {
  dawn: { el: 14, az: -58, sun: '#ffc8ae', i: 1.7, sky: '#d4d6f2', ground: '#7d6a60', hemi: 1.0, lamp: 0 },
  morning: { el: 58, az: -34, sun: '#e9f1ff', i: 2.3, sky: '#d2e3ff', ground: '#8a8274', hemi: 1.15, lamp: 0 },
  noon: { el: 70, az: 18, sun: '#fff7ec', i: 2.4, sky: '#ebeef4', ground: '#8f8578', hemi: 1.15, lamp: 0 },
  golden: { el: 11, az: 62, sun: '#ffaa55', i: 2.6, sky: '#ffd8b4', ground: '#6b5240', hemi: 0.75, lamp: 0 },
  dusk: { el: 5, az: 70, sun: '#ff9478', i: 1.1, sky: '#9a8ec0', ground: '#4a3e50', hemi: 1.0, lamp: 0.5 },
  night: { el: 48, az: -30, sun: '#8ea2d8', i: 0.7, sky: '#56608c', ground: '#262230', hemi: 1.45, lamp: 1 },
};
const FOLLOW = 10; // how fast a scene catches up with scroll, per second (exponential)
const DRIFT = (3 * Math.PI) / 180;
const ease = (t) => t * t * (3 - 2 * t);

function makeRenderer(still) {
  let r;
  try {
    r = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power', preserveDrawingBuffer: still });
  } catch { return null; }
  r.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  r.setClearColor(0x000000, 0);
  r.shadowMap.enabled = true;
  r.shadowMap.type = PCFShadowMap;
  r.domElement.setAttribute('aria-hidden', 'true');
  return r;
}

// One scene for one figure: its objects, lights for the phase, and a camera that fits it.
function compose(def, phase, small) {
  const P = PHASE[phase] ?? PHASE.noon;
  const [r, g, b] = accentRGB();
  const accent = new Color().setRGB(r, g, b);
  const scene = new Scene();
  const parts = def.build(accent);
  scene.add(parts.root);
  const sun = new DirectionalLight(P.sun, P.i);
  const el = (P.el * Math.PI) / 180, az = (P.az * Math.PI) / 180, [lx, ly, lz] = def.look;
  sun.position.set(lx + Math.sin(az) * Math.cos(el) * 8, Math.sin(el) * 8 + 0.6, lz + Math.cos(az) * Math.cos(el) * 8);
  sun.target.position.set(lx, 0.3, lz);
  sun.castShadow = true;
  const s = def.shadow, map = small ? 512 : 1024;
  sun.shadow.mapSize.set(map, map);
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.5, far: 20 });
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.02;
  scene.add(new HemisphereLight(P.sky, P.ground, P.hemi), sun, sun.target);
  if (P.lamp > 0) {
    const lamp = new PointLight(new Color('#fff1dc').lerp(accent, 0.5), 4 * P.lamp, 5, 1.2);
    lamp.position.set(...def.lampAt);
    scene.add(lamp);
  }
  const camera = new PerspectiveCamera(def.fov, 1, 0.1, 60);
  const look = new Vector3(lx, def.look[1], lz);
  return {
    scene, parts, camera,
    fit(w, h) {
      camera.aspect = w / h;
      const t = Math.tan(((def.fov / 2) * Math.PI) / 180);
      camera.userData.dist = 1.04 * Math.max(def.fit.h / 2 / t, def.fit.w / 2 / (t * camera.aspect));
      camera.updateProjectionMatrix();
    },
    // p is the scene's progress, 0 to 1: the camera turns 3° across it and settles on def.yaw.
    place(p) {
      const yaw = (((def.yaw ?? 0) * Math.PI) / 180) + (ease(p) - 1) * DRIFT, e = (def.el * Math.PI) / 180, d = camera.userData.dist ?? 8;
      camera.position.set(lx + Math.sin(yaw) * Math.cos(e) * d, look.y + Math.sin(e) * d, lz + Math.cos(yaw) * Math.cos(e) * d);
      camera.lookAt(look);
    },
    dispose() { scene.traverse((o) => o.geometry?.dispose()); },
  };
}

const boxOf = (fig) => fig.querySelector('.scene-box');
const beatsOf = (def) => def.beats ?? [[0, def.duration]];

/** The page's stage. Returns null when WebGL fails. opts.phase: one of vibekit's PHASES. */
export function createStage({ phase, onLost }) {
  const renderer = makeRenderer(false);
  if (!renderer) return null;
  const canvas = renderer.domElement;
  const small = matchMedia('(pointer: coarse)').matches || innerWidth < 640;
  const built = new Map(); // scene name → its composed scene, so each builds once
  const state = new Map(); // figure → { t, target }: where its timeline is and where scroll wants it
  let cur = null, raf = 0, last = 0;
  const figures = () => document.querySelectorAll('figure[data-scene]');
  figures().forEach((f) => f.classList.add('pending'));

  function entry(name) {
    if (!built.has(name)) built.set(name, SCENES[name] ? { def: SCENES[name], c: compose(SCENES[name], phase, small) } : null);
    return built.get(name);
  }
  function size() {
    if (!cur) return;
    const b = boxOf(cur.fig), w = b.clientWidth, h = b.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    cur.e.c.fit(w, h);
    draw();
  }
  function draw() {
    const { def, c } = cur.e, t = state.get(cur.fig).t;
    c.parts.pose(t);
    c.place(t / def.duration);
    renderer.render(c.scene, c.camera);
  }
  function frame(now) {
    raf = 0;
    if (!cur) return;
    const st = state.get(cur.fig), dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    const diff = st.target - st.t;
    st.t = Math.abs(diff) < 1e-3 ? st.target : st.t + diff * (1 - Math.exp(-dt * FOLLOW));
    draw();
    cur.fig.classList.add('live');
    if (st.t !== st.target) raf = requestAnimationFrame(frame); else last = 0;
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  // The figure the canvas leaves keeps its last frame as a 2D snapshot, drawn in the same task as a
  // fresh render, so the WebGL canvas needs no preserveDrawingBuffer.
  function leave() {
    if (!cur) return;
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
    draw();
    const box = boxOf(cur.fig);
    let rest = box.querySelector('canvas.scene-rest');
    if (!rest) {
      rest = document.createElement('canvas');
      rest.className = 'scene-rest';
      rest.setAttribute('aria-hidden', 'true');
      box.appendChild(rest);
    }
    rest.width = canvas.width;
    rest.height = canvas.height;
    rest.getContext('2d')?.drawImage(canvas, 0, 0);
    cur.fig.classList.add('rested');
    cur.fig.classList.remove('live');
    cur = null;
  }

  const ro = new ResizeObserver(size);
  canvas.addEventListener('webglcontextlost', () => onLost?.());

  return {
    /** Scroll's position for a figure: progress p (0 to 1) through one of its scene's beats. */
    seek(fig, beat, p) {
      const e = entry(fig.dataset.scene), span = e && beatsOf(e.def)[beat];
      if (!span) return;
      const target = span[0] + (span[1] - span[0]) * Math.min(1, Math.max(0, p));
      const st = state.get(fig);
      if (!st) { state.set(fig, { t: target, target }); return; }
      st.target = target;
      if (cur?.fig === fig && st.t !== target) kick();
    },
    /** Hands the canvas to a figure; it picks up where that figure's timeline stands. */
    show(fig) {
      if (cur?.fig === fig || !state.has(fig)) return;
      const e = entry(fig.dataset.scene);
      if (!e) return;
      leave();
      ro.disconnect();
      cur = { fig, e };
      boxOf(fig).appendChild(canvas);
      ro.observe(boxOf(fig));
      size();
      fig.classList.add('live');
      kick();
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      for (const f of figures()) {
        f.classList.remove('live', 'pending', 'rested');
        f.querySelector('canvas.scene-rest')?.remove();
      }
      for (const e of built.values()) e?.c.dispose();
      renderer.dispose();
      canvas.remove();
      cur = null;
    },
  };
}

/** Draws a figure's scene settled at a beat, for a phase, at the figure's size; returns a WebP data URL. */
export async function renderStill(fig, phase, beat = 0) {
  const renderer = makeRenderer(true), def = SCENES[fig.dataset.scene], b = boxOf(fig);
  const c = compose(def, phase, false);
  renderer.setSize(b.clientWidth, b.clientHeight, false);
  c.fit(b.clientWidth, b.clientHeight);
  const t = beatsOf(def)[beat][1];
  c.parts.pose(t);
  c.place(t / def.duration);
  renderer.render(c.scene, c.camera);
  const url = renderer.domElement.toDataURL('image/webp', 0.86);
  c.dispose();
  renderer.dispose();
  return url;
}
