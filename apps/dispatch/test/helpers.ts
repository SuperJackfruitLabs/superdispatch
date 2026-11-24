import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedDataDir } from "@superjackfruitlabs/treaty-contracts/node";
import { openStore, type Store } from "../src/store/index.ts";

/** A store in a fresh temporary directory, removed by `cleanup`. */
export function tempStore(): {
  dir: string;
  store: Store;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "superdispatch-test-"));
  const store = openStore(dir);
  return {
    dir,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const OPERATOR_TOKEN = "operator-token-for-tests";
export const OPERATOR_TOKEN_SHA256 = new Bun.CryptoHasher("sha256")
  .update(OPERATOR_TOKEN)
  .digest("hex");

/** A request a fake fetch saw. */
export interface Seen {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/**
 * A fetch that answers from a table keyed `METHOD path` (path with its query), and records every
 * request. A route it has no answer for is a 599, so a test notices an unexpected call. An answer
 * may be a function of the request, or `"throw"` for a network failure.
 */
export function fakeFetch(
  routes: Record<
    string,
    | { status?: number; json?: unknown }
    | "throw"
    | ((seen: Seen) => { status?: number; json?: unknown })
  >,
): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const request: Seen = {
      method,
      url: String(input),
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    seen.push(request);
    const route = routes[`${method} ${url.pathname}${url.search}`];
    if (route === "throw")
      throw new Error(
        `network down for ${String(input)} ${request.authorization}`,
      );
    const answer =
      typeof route === "function" ? route(request) : (route ?? { status: 599 });
    const status = answer.status ?? 200;
    return new Response(
      status === 204 || answer.json === undefined
        ? null
        : JSON.stringify(answer.json),
      { status },
    );
  };
  return { fetch: impl as unknown as typeof fetch, seen };
}

/** Treaty's cases files for the crossings the sources read, in the installed release. */
export const CASES = {
  boardRead: "fixtures/http/superpipeline/board-read.v1.cases.json",
  placement: "fixtures/http/superpipeline/placement.v1.cases.json",
  catalog: "fixtures/http/agentpod/capability-catalog.v1.cases.json",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON value's field at a path of keys, or undefined. */
export function at(value: unknown, ...keys: string[]): unknown {
  let v = value;
  for (const key of keys) v = isRecord(v) ? v[key] : undefined;
  return v;
}

/** The objects of a JSON array; none when it is not one. */
export function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** A JSON object, or a thrown test failure. */
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("not an object");
  return value;
}

/**
 * A valid body from treaty's cases for an operation's answer: the first, or the one named. A
 * fresh copy each time, so a test may change it.
 */
export function treatyCase(
  cases: string,
  operationId: string,
  status = "200",
  name?: string,
): Record<string, unknown> {
  const file: unknown = JSON.parse(
    readFileSync(join(installedDataDir(), cases), "utf8"),
  );
  const valid = record(
    at(file, "operations", operationId, "responses", status, "valid"),
  );
  const body = name === undefined ? Object.values(valid)[0] : valid[name];
  return structuredClone(record(body));
}

/** Each candidate's verdict in a recorded decision: `ok`, or its failed filters' reasons. */
export function candidateVerdicts(candidates: unknown): Record<string, string> {
  return Object.fromEntries(
    rows(candidates).map((r) => [
      String(at(r, "candidate", "agentId")),
      rows(r.filters)
        .filter((f) => f.passed !== true)
        .map((f) => String(f.reason))
        .join(",") || "ok",
    ]),
  );
}

/** A stage as treaty's `board-read.v1` holds it, from what a test cares about. */
export function contractStage(
  stage: Record<string, unknown> & { key: string },
  order = 0,
): Record<string, unknown> {
  return { name: stage.key, order, ...stage };
}

/**
 * A card as treaty's `board-read.v1` holds it: treaty's first case card, with no hold and no
 * window, and what a test cares about over it.
 */
export function contractCard(
  card: Record<string, unknown> & { id: string },
): Record<string, unknown> {
  const board = treatyCase(CASES.boardRead, "readBoard");
  const base = rows(board.cards)[0] ?? {};
  delete base.reservation;
  delete base.placementWindowUntil;
  return { ...base, ...card };
}

/** A board snapshot as treaty's `board-read.v1` holds it, with these stages and cards. */
export function contractBoard(
  boardId: string,
  stages: Array<Record<string, unknown> & { key: string }>,
  cards: Array<Record<string, unknown> & { id: string }>,
): Record<string, unknown> {
  return {
    ...treatyCase(CASES.boardRead, "readBoard"),
    boardId,
    stages: stages.map((s, i) => contractStage(s, i)),
    cards: cards.map(contractCard),
  };
}
