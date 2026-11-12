import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_TOKEN_SHA256 } from "./helpers.ts";

// The composition root, run as the container runs it: it starts, listens, and stops cleanly on
// SIGTERM or SIGINT. The other products' URLs point at a closed port, so every read fails fast.

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  void probe.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

async function started(signal: "SIGTERM" | "SIGINT") {
  const dataDir = mkdtempSync(join(tmpdir(), "superdispatch-main-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const port = freePort();
  const closed = "http://127.0.0.1:9";
  const child = Bun.spawn([process.execPath, MAIN], {
    env: {
      PATH: process.env.PATH ?? "",
      SUPERPIPELINE_URL: closed,
      ORG_PLANE_URL: closed,
      ORG_PLANE_SERVICE_CREDENTIAL:
        "svc_0123456789abcdef0123:credential-secret",
      AGENTPOD_URL: closed,
      TREATY_RELAY_DELIVERY_SECRET: "relay-secret-for-tests",
      SUPERDISPATCH_OPERATOR_TOKEN_SHA256: OPERATOR_TOKEN_SHA256,
      SUPERDISPATCH_DATA_DIR: dataDir,
      PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanups.push(() => child.kill("SIGKILL"));

  // Wait until it answers, then signal it.
  let health = 0;
  for (let i = 0; i < 100 && health !== 200; i++) {
    health = await fetch(`http://127.0.0.1:${port}/healthz`)
      .then((r) => r.status)
      .catch(() => 0);
    if (health !== 200) await Bun.sleep(50);
  }
  child.kill(signal);
  const code = await child.exited;
  const stdout = await new Response(child.stdout).text();
  return { health, code, stdout, port };
}

describe("main", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`listens, then exits 0 on ${signal}`, async () => {
      const { health, code, stdout, port } = await started(signal);
      expect(health).toBe(200);
      expect(code).toBe(0);
      expect(stdout).toContain(`listening on :${port}`);
    }, 15_000);
  }
});
