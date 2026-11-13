// "How it places a card": a board at the front left, five agents' stations in a row at the back. Boxes and low
// cylinders, flat-shaded, made in code. Scroll runs it in five beats, one per step of the section;
// only one part moves in a beat:
//   0. A card is ready: it slides from the stage column into the ready column of the board.
//   1. Filter: two stations sink into the table and grey (one not idle, one without the capability); the
//      reasons are the HTML beside the scene.
//   2. Score: a bar rises beside each station left, the tallest in the accent.
//   3. Hold: a ring closes round the best station: the card is held for it, for a short window.
//   4. Claim: the card crosses to that station and settles on it.
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshLambertMaterial, TorusGeometry } from 'three';

const mat = (c) => new MeshLambertMaterial({ color: c, flatShading: true });
const READY = 1, FILTER = 1, SCORE = 1.2, HOLD = 0.8, CLAIM = 1.2;
const T1 = READY, T2 = T1 + FILTER, T3 = T2 + SCORE, T4 = T3 + HOLD, T5 = T4 + CLAIM;

export const placement = {
  duration: T5,
  beats: [[0, T1], [T1, T2], [T2, T3], [T3, T4], [T4, T5]],
  fit: { w: 4.2, h: 2.4 },
  look: [0, 0.3, 0.1],
  yaw: 12,
  el: 38,
  fov: 26,
  shadow: 2.8,
  lampAt: [0.6, 1.6, 0.6],
  build(accent) {
    const M = {
      stone: mat('#d6cdc1'), stoneTop: mat('#e4ddd3'), board: mat('#5d6673'), boardTop: mat('#4a525d'),
      lane: mat('#6d7684'), card: mat('#e0a43a'), pad: mat('#8a96a8'), station: mat('#5f80d0'),
      bar: mat('#c9c2b6'), accent: mat(accent), sunk: mat('#a39e97'),
    };
    const root = new Group();
    function box(w, h, d, m, x = 0, y = 0, z = 0, parent = root) {
      const b = new Mesh(new BoxGeometry(w, h, d), m);
      b.position.set(x, y, z);
      b.castShadow = b.receiveShadow = true;
      parent.add(b);
      return b;
    }
    function cyl(r, h, m, x = 0, y = 0, z = 0, parent = root, seg = 14) {
      const c = new Mesh(new CylinderGeometry(r, r, h, seg), m);
      c.position.set(x, y, z);
      c.castShadow = c.receiveShadow = true;
      parent.add(c);
      return c;
    }
    box(4.4, 0.2, 3.0, M.stone, 0, 0.1, 0);
    box(4.1, 0.05, 2.7, M.stoneTop, 0, 0.225, 0);
    const floor = 0.25;

    // The board, front left: two columns (a stage, then ready), and the card.
    box(1.4, 0.08, 1.0, M.board, -1.0, floor + 0.04, 0.78);
    for (const x of [-1.32, -0.68]) box(0.52, 0.012, 0.86, M.lane, x, floor + 0.086, 0.78).castShadow = false;
    const card = box(0.38, 0.04, 0.26, M.card, -1.32, floor + 0.11, 0.62);

    // Five stations in a row at the back: a pad each, a body on it. Two will be filtered out; one is
    // the best. Each one left gets a score bar at its right.
    const xs = [-1.6, -0.8, 0, 0.8, 1.6];
    const z0 = -0.55;
    const out = new Set([1, 4]);
    const scores = [0.42, 0, 0.28, 0.78, 0];
    const best = 3;
    const bodies = [];
    const stations = xs.map((x) => {
      const g = new Group();
      g.position.set(x, floor, z0);
      cyl(0.19, 0.05, M.pad, 0, 0.025, 0, g);
      bodies.push(box(0.26, 0.3, 0.26, M.station, 0, 0.2, 0, g));
      root.add(g);
      return g;
    });
    const bars = xs.map((x, i) => {
      if (out.has(i)) return null;
      const g = new Group();
      g.position.set(x + 0.3, floor, z0);
      box(0.1, 1, 0.1, i === best ? M.accent : M.bar, 0, 0.5, 0, g);
      g.scale.y = 0.001;
      root.add(g);
      return g;
    });
    const ring = new Mesh(new TorusGeometry(0.29, 0.028, 8, 40), M.accent);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(xs[best], floor + 0.04, z0);
    ring.castShadow = true;
    root.add(ring);

    const ease = (t) => t * t * (3 - 2 * t);
    const clamp = (v) => Math.min(1, Math.max(0, v));
    return {
      root,
      pose(t) {
        // 0. ready: from the stage column into the ready column.
        const r = ease(clamp(t / READY));
        // 4. claim: from the ready column over to the best station, in an arc, onto its top.
        const c = ease(clamp((t - T4) / CLAIM));
        const sx = -1.32 + 0.64 * r, sz = 0.62 + 0.16 * r;
        const tx = xs[best], tz = z0, ty = floor + 0.37;
        card.position.set(sx + (tx - sx) * c, floor + 0.11 + (ty - floor - 0.11) * c + Math.sin(c * Math.PI) * 0.5, sz + (tz - sz) * c);
        // 1. filter: the two sink into the table.
        const f = ease(clamp((t - T1) / FILTER));
        stations.forEach((s, i) => {
          if (!out.has(i)) return;
          s.position.y = floor - 0.22 * f;
          bodies[i].material = f > 0.5 ? M.sunk : M.station;
        });
        // 2. score: the bars rise, one after another.
        bars.forEach((b, i) => {
          if (!b) return;
          const k = scores[i] * ease(clamp((t - T2 - i * 0.12) / (SCORE - 0.3)));
          b.visible = k > 0.005;
          b.scale.y = Math.max(0.001, k);
        });
        // 3. hold: the ring closes in round the best station.
        const h = ease(clamp((t - T3) / HOLD));
        ring.visible = h > 0;
        ring.scale.setScalar(2.2 - 1.2 * h);
      },
    };
  },
};
