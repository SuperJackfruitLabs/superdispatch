// Renders the section scenes' stills, one WebP per scene, beat and sun phase, into public/scenes/
// as <scene>/<beat>-<phase>.webp. They
// are what reduced motion and no-WebGL visitors see, and what shows while the scenes load.
//
// Usage: node scripts/render-stills.mjs [base-url]   (default: http://127.0.0.1:4327/, `npm run dev`)
// Playwright is not a landing dependency: run it where `playwright` resolves (NODE_PATH does not
// reach an ES module, so link or install it next to this file), and with Chrome installed. It opens
// the page with ?scene-still, which exposes a hook (src/scripts/scenes/loader.js) that draws one
// settled scene at one beat, at its figure's size at 1.5x, and returns a WebP.
import fs from 'node:fs';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:4327/';
const b = await chromium.launch({ channel: 'chrome', args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
await p.goto(new URL('?scene-still', base).href, { waitUntil: 'load' });
await p.waitForFunction(() => window.__sceneStill);
const shots = await p.$$eval('figure[data-scene]', (fs) => [...new Set(fs.map((f) => `${f.dataset.scene}/${f.dataset.beat ?? 0}`))]);
// A pinned panel names only its first beat; its steps name the rest.
for (const s of await p.$$eval('[data-steps-for]', (ss) => ss.map((s) => `${document.getElementById(s.dataset.stepsFor).dataset.scene}/${s.dataset.beat}`)))
  if (!shots.includes(s)) shots.push(s);
for (const shot of shots) {
  const [name, beat] = shot.split('/');
  const out = new URL(`../public/scenes/${name}/`, import.meta.url).pathname;
  fs.mkdirSync(out, { recursive: true });
  for (const phase of ['dawn', 'morning', 'noon', 'golden', 'dusk', 'night']) {
    const url = await p.evaluate(([n, ph, b]) => window.__sceneStill(n, ph, b), [name, phase, +beat]);
    const buf = Buffer.from(url.split(',')[1], 'base64');
    fs.writeFileSync(`${out}${beat}-${phase}.webp`, buf);
    console.log(`${name}/${beat}-${phase}.webp ${(buf.length / 1024).toFixed(1)} KB`);
  }
}
await b.close();
