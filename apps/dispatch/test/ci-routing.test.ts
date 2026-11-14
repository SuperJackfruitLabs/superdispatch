import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROUTER = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "scripts",
  "ci-route.sh",
);
let repo = "";
let base = "";

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

function commit(paths: string[]): string {
  git("reset", "--hard", base);
  git("clean", "-fd");
  for (const path of paths) {
    const absolute = join(repo, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${path}\n`);
  }
  git("add", "--all");
  git("commit", "-m", "fixture");
  return git("rev-parse", "HEAD");
}

async function docsOnly(
  head: string,
  event = "pull_request",
  from = base,
): Promise<boolean> {
  const output = join(repo, "route-output");
  writeFileSync(output, "");
  const result = Bun.spawnSync([ROUTER, event, from, head], {
    cwd: repo,
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return (await Bun.file(output).text()).trim() === "docs_only=true";
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "superdispatch-ci-route-"));
  git("init", "--quiet");
  git("config", "user.name", "CI routing test");
  git("config", "user.email", "ci-routing@example.invalid");
  writeFileSync(join(repo, ".seed"), "seed\n");
  git("add", ".seed");
  git("commit", "-m", "base");
  base = git("rev-parse", "HEAD");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("Forge CI routing", () => {
  test("routes only root READMEs and documentation trees to docs CI", async () => {
    const head = commit([
      "README",
      "README.md",
      "README.markdown",
      "README.txt",
      "README.rst",
      "docs/guide.md",
      "docs-site/src/content/docs/guide.md",
    ]);

    expect(await docsOnly(head)).toBe(true);
  });

  test("routes mixed, application, workflow, config, package, lock, and generated changes to full CI", async () => {
    const fullCiChanges = [
      ["docs/guide.md", "apps/dispatch/src/main.ts"],
      ["landing/README.md"],
      [".forgejo/workflows/ci.yml"],
      ["config/settings.yml"],
      ["package.json"],
      ["bun.lock"],
      ["generated/client.ts"],
    ];

    for (const paths of fullCiChanges) {
      expect(await docsOnly(commit(paths))).toBe(false);
    }
  });

  test("routes unknown and non-PR events to full CI", async () => {
    const head = commit(["docs/guide.md"]);

    expect(await docsOnly(head, "workflow_dispatch")).toBe(false);
    expect(await docsOnly(head, "pull_request", "missing-base")).toBe(false);
    expect(await docsOnly(base, "pull_request", base)).toBe(false);
  });
});
