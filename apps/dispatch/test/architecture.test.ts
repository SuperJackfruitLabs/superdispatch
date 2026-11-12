import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

/**
 * The service's layers, lowest first. A file belongs to the layer named by its first path
 * segment under `src/` (a folder, or a file without its extension). An import may stay inside
 * its own layer or point down this list, never up: the sources know no placement, placement
 * knows no loop, the loop (which reads the sources, places and records) knows no route, and only
 * `main` wires them together.
 *
 * `store` sits beside config at the bottom: it knows tables, and nothing above it may be reached
 * from it. A new top-level folder must be placed in this list before anything can live in it.
 */
export const LAYERS = [
  "config",
  "store",
  "sources",
  "placement",
  "loop",
  "routes",
  "main",
] as const;

/**
 * Placement is pure: it may import only from below it, never a package or a runtime module, and
 * it reaches no global that does I/O or reads the clock. The time it needs comes in its input.
 */
export const PURE_LAYER = "placement";
const IMPURE_GLOBALS = [
  /\bfetch\s*\(/,
  /\bBun\./,
  /\bprocess\./,
  /\bDate\.now\s*\(/,
  /\bnew\s+Date\s*\(/,
  /\bMath\.random\s*\(/,
  /\bsetTimeout\s*\(/,
  /\bsetInterval\s*\(/,
  /\bcrypto\./,
];

const SRC = join(import.meta.dir, "..", "src");

/** Import specifiers in a TypeScript source (static, dynamic and re-exports). */
export function imports(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
  for (const m of source.matchAll(pattern)) {
    if (m[1] !== undefined) found.push(m[1]);
  }
  return found;
}

/** The layer of a path relative to `src/` (posix separators), or null when it is in none. */
export function layerOf(path: string): string | null {
  const [first] = path.split("/");
  if (first === undefined) return null;
  const name = first.replace(/\.ts$/, "");
  return (LAYERS as readonly string[]).includes(name) ? name : null;
}

/** Every rule a set of files breaks, as one line each. `files` maps a path under src/ to its source. */
export function violations(files: Record<string, string>): string[] {
  const out: string[] = [];
  const rank = (layer: string) => (LAYERS as readonly string[]).indexOf(layer);
  for (const [path, source] of Object.entries(files)) {
    const from = layerOf(path);
    if (from === null) {
      out.push(`${path} is in no layer`);
      continue;
    }
    for (const spec of imports(source)) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        if (from === PURE_LAYER)
          out.push(`${path} (${from}) imports ${spec}, and placement is pure`);
        continue;
      }
      const target = posix.normalize(posix.join(posix.dirname(path), spec));
      if (target.startsWith("..")) {
        out.push(`${path} imports ${spec}, outside src/`);
        continue;
      }
      const to = layerOf(target);
      if (to === null)
        out.push(`${path} imports ${spec}, which is in no layer`);
      else if (rank(to) > rank(from))
        out.push(`${path} (${from}) imports ${spec} (${to}), a higher layer`);
    }
    if (from === PURE_LAYER) {
      for (const pattern of IMPURE_GLOBALS) {
        if (pattern.test(source))
          out.push(
            `${path} (${from}) uses ${pattern.source}, and placement is pure`,
          );
      }
    }
  }
  return out;
}

function sources(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(files, sources(full));
    else if (name.endsWith(".ts"))
      files[relative(SRC, full).split(sep).join("/")] = readFileSync(
        full,
        "utf8",
      );
  }
  return files;
}

describe("architecture", () => {
  test("every source file is in a layer, and imports only down", () => {
    const files = sources(SRC);
    expect(Object.keys(files).length).toBeGreaterThan(0);
    expect(violations(files)).toEqual([]);
  });

  test("every layer is a folder or file that exists", () => {
    const present = new Set(Object.keys(sources(SRC)).map(layerOf));
    for (const layer of LAYERS) expect(present.has(layer)).toBe(true);
  });

  // The rule itself, against files it must refuse: so the test above cannot pass by checking nothing.
  test("an import up the layers is refused", () => {
    expect(
      violations({
        "sources/index.ts": 'import { place } from "../placement/index.ts";',
        "placement/index.ts": 'export { x } from "../routes/index.ts";',
        "routes/index.ts": 'const m = await import("../main.ts");',
        "store/index.ts": 'import { x } from "../sources/index.ts";',
        "loop/index.ts": 'import { handle } from "../routes/index.ts";',
        "placement/a.ts": 'import { createLoop } from "../loop/index.ts";',
      }),
    ).toEqual([
      "sources/index.ts (sources) imports ../placement/index.ts (placement), a higher layer",
      "placement/index.ts (placement) imports ../routes/index.ts (routes), a higher layer",
      "routes/index.ts (routes) imports ../main.ts (main), a higher layer",
      "store/index.ts (store) imports ../sources/index.ts (sources), a higher layer",
      "loop/index.ts (loop) imports ../routes/index.ts (routes), a higher layer",
      "placement/a.ts (placement) imports ../loop/index.ts (loop), a higher layer",
    ]);
  });

  test("a file outside the layers, or an import out of src/, is refused", () => {
    expect(
      violations({
        "scheduler/index.ts": "",
        "routes/index.ts": 'import x from "../../test/helpers.ts";',
      }),
    ).toEqual([
      "scheduler/index.ts is in no layer",
      "routes/index.ts imports ../../test/helpers.ts, outside src/",
    ]);
  });

  test("placement importing a module or doing I/O is refused", () => {
    expect(
      violations({
        "placement/a.ts": 'import { readFileSync } from "node:fs";',
        "placement/b.ts": "const r = await fetch(url);",
        "placement/c.ts": "const at = new Date();",
        "placement/d.ts": "const t = Date.now();",
      }),
    ).toEqual([
      "placement/a.ts (placement) imports node:fs, and placement is pure",
      "placement/b.ts (placement) uses \\bfetch\\s*\\(, and placement is pure",
      "placement/c.ts (placement) uses \\bnew\\s+Date\\s*\\(, and placement is pure",
      "placement/d.ts (placement) uses \\bDate\\.now\\s*\\(, and placement is pure",
    ]);
  });

  test("an import down, or within a layer, is allowed; packages are allowed outside placement", () => {
    expect(
      violations({
        "main.ts":
          'import { handle } from "./routes/index.ts";\nimport { loadConfig } from "./config.ts";',
        "routes/index.ts":
          'import "../placement/index.ts";\nimport { a } from "./a.ts";\nimport { verifyDelivery } from "@superjackfruitlabs/treaty-cloudevents";',
        "placement/index.ts": 'import type { Store } from "../store/index.ts";',
        "sources/superpipeline.ts":
          'import { loadConfig } from "../config.ts";',
      }),
    ).toEqual([]);
  });
});
