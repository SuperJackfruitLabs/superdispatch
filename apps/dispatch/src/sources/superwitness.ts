/**
 * SuperWitness, as placement needs it: what became of the runs at one board stage, with this
 * service's own token (audience: SuperWitness's public URL; `createServiceTokens`), on
 * `GET /v1/runs?source=superpipeline&scope=<board>&stage_key=<stage>&status=succeeded&status=failed&since=…`.
 * Any principal whose token carries SuperWitness's audience may list runs; no grant scope is
 * asked for.
 *
 * Each run says who executed it (a hub principal, when SuperPipeline knew it), whether it
 * succeeded or failed, when it ended, and the newest verdict on it. A cancelled run judged
 * nothing and is not read; a run with no executor id cannot be joined to a candidate and is left
 * out. A verdict is read as a pass mark from 0 to 1: a `score` as it stands, a `decision` that
 * reads as pass (1) or fail (0); a label, a text, or a decision of neither kind is no mark.
 *
 * Reads only, and nothing requires it: a refusal throws `SourceError` (a 401 drops the held
 * token), and the loop then places on the board's own history, as before SuperWitness was read.
 */
import type { ServiceTokens } from "./accounts.ts";
import {
  SourceError,
  call,
  field,
  isoTime,
  okBody,
  type CallDeps,
} from "./http.ts";

/** One finished run at a stage, as placement weighs it. */
export interface StageRunView {
  /** The executor's hub principal (`prn_…`). */
  executor: string;
  succeeded: boolean;
  /** When the run ended, or started when it has no end; ISO. */
  at: string;
  /** The newest verdict's pass mark from 0 to 1, or null when there is none or it is not one. */
  verdict: number | null;
}

export interface Superwitness {
  /** The finished runs at this board stage since `since` (ISO), newest first, up to `MAX_RUNS`. */
  stageRuns(query: {
    boardId: string;
    stageKey: string;
    since: string;
  }): Promise<StageRunView[]>;
}

/** Runs asked for a page; SuperWitness's own most. */
export const PAGE_SIZE = 200;

/** The most runs one stage's history reads: older ones weigh little, and a pass stays quick. */
export const MAX_RUNS = 1000;

/** Decisions that read as a pass, and as a fail, compared in lower case. */
export const PASS_DECISIONS: ReadonlySet<string> = new Set([
  "pass",
  "passed",
  "approve",
  "approved",
  "accept",
  "accepted",
]);
export const FAIL_DECISIONS: ReadonlySet<string> = new Set([
  "fail",
  "failed",
  "reject",
  "rejected",
  "request_changes",
  "changes_requested",
]);

/** A verdict's value as a pass mark from 0 to 1, or null when it is not one. */
export function verdictMark(value: unknown): number | null {
  const score = field(value, "score");
  if (
    typeof score === "number" &&
    Number.isFinite(score) &&
    score >= 0 &&
    score <= 1
  )
    return score;
  const decision = field(value, "decision");
  if (typeof decision !== "string") return null;
  const d = decision.trim().toLowerCase();
  if (PASS_DECISIONS.has(d)) return 1;
  if (FAIL_DECISIONS.has(d)) return 0;
  return null;
}

const PRINCIPAL = /^prn_[0-9a-f]{20}$/;

export function createSuperwitness(
  deps: { baseUrl: string; tokens: ServiceTokens } & Omit<CallDeps, "product">,
): Superwitness {
  const base = deps.baseUrl.replace(/\/+$/, "");
  const http: CallDeps = { ...deps, product: "superwitness" };
  return {
    async stageRuns({ boardId, stageKey, since }) {
      const out: StageRunView[] = [];
      let cursor: string | null = null;
      do {
        const q = new URLSearchParams({
          source: "superpipeline",
          scope: boardId,
          stage_key: stageKey,
        });
        q.append("status", "succeeded");
        q.append("status", "failed");
        q.set("since", since);
        q.set("limit", String(PAGE_SIZE));
        if (cursor !== null) q.set("cursor", cursor);
        const token = await deps.tokens.get();
        const answer = await call(http, `${base}/v1/runs?${q}`, {
          method: "GET",
          authorization: `Bearer ${token}`,
        });
        if (answer.status === 401) deps.tokens.invalidate();
        const body = okBody("superwitness", answer);
        const runs = field(body, "runs");
        if (!Array.isArray(runs))
          throw new SourceError("superwitness", 200, "malformed_response");
        for (const run of runs) {
          const view = readRun(run, boardId, stageKey);
          if (view !== null) out.push(view);
        }
        const next = field(body, "next_cursor");
        cursor = typeof next === "string" && next !== "" ? next : null;
      } while (cursor !== null && out.length < MAX_RUNS);
      return out.slice(0, MAX_RUNS);
    },
  };
}

/** A run as placement weighs it, or null when it is not one this stage's history can use. */
function readRun(
  run: unknown,
  boardId: string,
  stageKey: string,
): StageRunView | null {
  // The filter is SuperWitness's; a run outside it is not trusted to be this stage's.
  if (field(run, "source") !== "superpipeline") return null;
  if (field(field(run, "scope"), "id") !== boardId) return null;
  if (field(run, "stage_key") !== stageKey) return null;
  const status = field(run, "status");
  if (status !== "succeeded" && status !== "failed") return null;
  const executor = field(field(run, "executor"), "id");
  if (typeof executor !== "string" || !PRINCIPAL.test(executor)) return null;
  const at =
    isoTime(field(run, "ended_at")) ?? isoTime(field(run, "started_at"));
  if (at === null) return null;
  return {
    executor,
    succeeded: status === "succeeded",
    at,
    verdict: verdictMark(field(field(run, "latest_verdict"), "value")),
  };
}
