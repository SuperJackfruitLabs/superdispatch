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

/** The most lines a source file under `src/` may have. */
export const SIZE_LIMIT = 1000;
/** Files over SIZE_LIMIT and the most lines each may have. Lower these; never raise them. */
export const OVERSIZE: Record<string, number> = {};
/** Files in the largest run-time import cycle under `src/`. Lower it; never raise it. */
export const LARGEST_CYCLE = 0;

/**
 * The run-time import graph of a set of files (path under src/ to source): each file to the files
 * it loads. `import type` and `export type` are erased and load nothing; every other import,
 * re-export, side-effect import and dynamic import does.
 */
export function runtimeGraph(
  files: Record<string, string>,
): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const statics =
    /^[ \t]*(?:import|export)\b(\s+type\b)?[^;"']*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']/gm;
  const bare = /^[ \t]*import\s*["'](\.{1,2}\/[^"']+)["']/gm;
  const dynamic = /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  for (const [path, source] of Object.entries(files)) {
    const targets = new Set<string>();
    const add = (spec: string | undefined) => {
      if (spec === undefined) return;
      const to = posix.normalize(posix.join(posix.dirname(path), spec));
      if (!to.startsWith("..")) targets.add(to);
    };
    for (const m of source.matchAll(statics)) if (!m[1]) add(m[2]);
    for (const m of source.matchAll(bare)) add(m[1]);
    for (const m of source.matchAll(dynamic)) add(m[1]);
    graph.set(path, [...targets].toSorted());
  }
  return graph;
}

/** Strongly connected components with more than one file (Tarjan), each sorted. */
export function cycles(graph: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w))
        low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
    }
    if (low.get(v) !== index.get(v)) return;
    const component: string[] = [];
    let w: string | undefined;
    do {
      w = stack.pop();
      if (w === undefined) break;
      onStack.delete(w);
      component.push(w);
    } while (w !== v);
    if (component.length > 1) found.push(component.toSorted());
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return found;
}

/** Lines in a source, not counting a final newline. */
export function lineCount(source: string): number {
  return source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
}

/**
 * What the size ratchet refuses, as one line each: a file over its limit, and an OVERSIZE entry
 * that is stale (its file shrank below the entry, or is gone).
 */
export function sizeProblems(
  sizes: Map<string, number>,
  oversize: Record<string, number>,
  limit = SIZE_LIMIT,
): string[] {
  const out: string[] = [];
  for (const [file, n] of sizes) {
    const allowed = oversize[file] ?? limit;
    if (n > allowed)
      out.push(`${file} has ${n} lines; the limit is ${allowed}`);
  }
  for (const [file, allowed] of Object.entries(oversize)) {
    const n = sizes.get(file) ?? 0;
    if (n < allowed)
      out.push(
        `${file} has ${n} lines, under its OVERSIZE entry of ${allowed}: lower or remove the entry`,
      );
  }
  return out;
}

describe("shape", () => {
  test("no run-time import cycle grows past LARGEST_CYCLE", () => {
    const found = cycles(runtimeGraph(sources(SRC)));
    const largest = Math.max(0, ...found.map((c) => c.length));
    expect(found.filter((c) => c.length > LARGEST_CYCLE)).toEqual([]);
    // A stale record would let the next cycle in unnoticed.
    expect(largest).toBe(LARGEST_CYCLE);
  });

  test("no source file grows past the size limit, and OVERSIZE is not stale", () => {
    const sizes = new Map(
      Object.entries(sources(SRC)).map(([f, s]) => [f, lineCount(s)] as const),
    );
    expect(sizeProblems(sizes, OVERSIZE)).toEqual([]);
  });

  // The rules themselves, against inputs they must refuse.
  test("the cycle finder sees a run-time cycle, and not one made of type imports", () => {
    const graph = runtimeGraph({
      "a/index.ts": 'import { b } from "../b/index.ts";',
      "b/index.ts": 'export * from "./c.ts";',
      "b/c.ts": 'import {\n  a,\n  x,\n} from "../a/index.ts";',
      "d.ts": 'import { a } from "./a/index.ts";',
      "e.ts": 'import type { F } from "./f.ts";',
      "f.ts": 'import type { E } from "./e.ts";',
      "g.ts": 'import "./h.ts";',
      "h.ts": 'const g = await import("./g.ts");',
    });
    expect(cycles(graph)).toEqual([
      ["a/index.ts", "b/c.ts", "b/index.ts"],
      ["g.ts", "h.ts"],
    ]);
  });

  test("the size ratchet refuses a file over its limit and a stale entry", () => {
    expect(
      sizeProblems(
        new Map([
          ["big.ts", 11],
          ["held.ts", 12],
          ["shrunk.ts", 13],
          ["small.ts", 10],
        ]),
        { "held.ts": 12, "shrunk.ts": 14, "gone.ts": 20 },
        10,
      ),
    ).toEqual([
      "big.ts has 11 lines; the limit is 10",
      "shrunk.ts has 13 lines, under its OVERSIZE entry of 14: lower or remove the entry",
      "gone.ts has 0 lines, under its OVERSIZE entry of 20: lower or remove the entry",
    ]);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a\nb")).toBe(2);
  });
});
