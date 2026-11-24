import { afterEach, describe, expect, test } from "bun:test";
import { createLoop } from "../src/loop/index.ts";
import {
  createAgentpod,
  createSuperpipeline,
  type ServiceTokens,
} from "../src/sources/index.ts";
import { contractBreak } from "../src/sources/contracts.ts";
import {
  at,
  candidateVerdicts,
  contractBoard,
  fakeFetch,
  tempStore,
  type Seen,
} from "./helpers.ts";

/**
 * `GET /v1/agents/load` end to end: the real SuperPipeline and AgentPod clients, over HTTP, against
 * fakes that answer only what treaty's contracts allow (`placement.v1`, `board-read.v1`,
 * `capability-catalog.v1`), driving one pass of the loop with the candidate set `all`. Every
 * body a fake sends is first held to its contract here, so a fake that drifted from treaty fails
 * the test rather than prove the client against a shape no product sends.
 */

const BOARD = "brd_00000000000000b1";
const CARD = "card_00000000000000c1";
const T0 = Date.parse("2026-11-24T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const tokens: ServiceTokens = { get: async () => "tok", invalidate: () => {} };

/** An answer a fake sends, checked against its contract first. */
function contracted(
  crossing: Parameters<typeof contractBreak>[0],
  operationId: string,
  json: unknown,
  status = 200,
): { status: number; json: unknown } {
  expect(contractBreak(crossing, operationId, status, json)).toBeNull();
  return { status, json };
}

interface LoadRow {
  agentId: string;
  principalId: string | null;
  inFlight: number;
  capacity: number;
  lastHeartbeatAt: string | null;
}

/**
 * One board with one ready card, a roster with one rostered agent (busy unless `rosterIdle`),
 * every agent eligible, and `load` as SuperPipeline's `agents/load` answer (or a status for it).
 */
function world(
  load: { agents: LoadRow[] } | { status: number; json?: unknown },
  rosterIdle = false,
) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  t.store.enableBoard(BOARD, iso(T0));
  const log: string[] = [];
  const agents = [
    "agt_a",
    ...("agents" in load ? load.agents.map((a) => a.agentId) : []),
  ];
  const pipeline = fakeFetch({
    [`GET /v1/boards/${BOARD}`]: contracted(
      "superpipeline.board-read",
      "readBoard",
      contractBoard(
        BOARD,
        [{ key: "build", ownerKind: "capability", owner: "code" }],
        [
          {
            id: CARD,
            currentStageKey: "build",
            state: "submitted",
            createdAt: iso(T0 - 10 * MIN),
          },
        ],
      ),
    ),
    [`GET /v1/boards/${BOARD}/cards/${CARD}/eligibility`]: contracted(
      "superpipeline.placement",
      "readCardEligibility",
      {
        cardId: CARD,
        stageKey: "build",
        reasons: [],
        placementWindowUntil: null,
        agents: agents.map((agentId) => ({
          agentId,
          name: agentId,
          principalId: `prn_${agentId}`,
          eligible: true,
          reasons: [],
        })),
      },
    ),
    [`PUT /v1/boards/${BOARD}/cards/${CARD}/reservation`]: (seen: Seen) => {
      return contracted("superpipeline.placement", "reserveCard", {
        reservation: {
          agentId: at(seen.body, "agentId"),
          reservedUntil: iso(T0 + MIN),
          decisionId: at(seen.body, "decisionId"),
          reservedBy: "prn_superdispatch",
        },
      });
    },
    "GET /v1/agents/load":
      "agents" in load
        ? contracted("superpipeline.placement", "readAgentLoad", load)
        : load,
  });
  const hub = fakeFetch({
    [`GET /api/bridge/boards/${BOARD}/roster`]: contracted(
      "agentpod.capability-catalog",
      "readBoardRoster",
      {
        boardId: BOARD,
        agents: [
          {
            key: "a",
            stationId: "stn_a",
            principalId: "prn_agt_a",
            enabled: true,
            ready: true,
            busy: !rosterIdle,
            lastDispatchedAt: iso(T0 - 30 * MIN),
            reason: null,
          },
        ],
      },
    ),
  });
  let ids = 0;
  const loop = createLoop({
    store: t.store,
    superpipeline: createSuperpipeline({
      baseUrl: "https://pipeline.example",
      tokens,
      fetch: pipeline.fetch,
    }),
    agentpod: createAgentpod({
      baseUrl: "https://hub.example",
      tokens,
      fetch: hub.fetch,
    }),
    candidateSet: "all",
    now: () => T0,
    newId: () => `pld_${String(++ids).padStart(24, "0")}`,
    log: (line) => log.push(line),
  });
  const held = () =>
    pipeline.seen
      .filter((s) => s.method === "PUT")
      .map((s) => at(s.body, "agentId"));
  const verdicts = () =>
    candidateVerdicts(t.store.listDecisions({ limit: 10 })[0]?.candidates);
  return { loop, log, held, verdicts, pipeline };
}

const row = (agentId: string, over: Partial<LoadRow> = {}): LoadRow => ({
  agentId,
  principalId: `prn_${agentId}`,
  inFlight: 0,
  capacity: 1,
  lastHeartbeatAt: iso(T0 - 2 * MIN),
  ...over,
});

describe("agents/load, end to end", () => {
  test("an agent with its own token is held for, read through the contract and recorded as direct", async () => {
    const w = world({ agents: [row("agt_d")] });
    await w.loop.passBoard(BOARD);
    expect(
      w.pipeline.seen.filter((s) => s.url.endsWith("/v1/agents/load")).length,
    ).toBe(1);
    expect(w.held()).toEqual(["agt_d"]);
    expect(w.verdicts()).toEqual({ agt_a: "not-idle", agt_d: "ok" });
  });

  test("a capacity of 0, no heartbeat, and an agent full across two boards: none is held for", async () => {
    const w = world({
      agents: [
        row("agt_zero", { capacity: 0, inFlight: 0 }),
        row("agt_never", { lastHeartbeatAt: null }),
        // Two cards in hand, one on each of two boards, against a capacity of 2.
        row("agt_full", { inFlight: 2, capacity: 2 }),
        row("agt_d", { lastHeartbeatAt: iso(T0 - 5 * MIN) }),
      ],
    });
    await w.loop.passBoard(BOARD);
    expect(w.held()).toEqual(["agt_d"]);
    expect(w.verdicts()).toEqual({
      agt_a: "not-idle",
      agt_zero: "not-idle",
      agt_never: "unhealthy",
      agt_full: "not-idle",
      agt_d: "ok",
    });
  });

  test("a body the contract refuses is logged without its values, and only the roster is placed that pass", async () => {
    const leaked = "not-a-count-but-text";
    const w = world(
      {
        status: 200,
        json: {
          agents: [row("agt_d"), { ...row("agt_e"), inFlight: leaked }],
        },
      },
      true,
    );
    const pass = await w.loop.passBoard(BOARD);
    expect(pass.decided).toBe(1);
    // The roster's one agent is the one candidate: recorded, and nothing held.
    expect(w.held()).toEqual([]);
    expect(w.verdicts()).toEqual({ agt_a: "ok" });
    const line = w.log.find((l) => l.includes("agent load unread"));
    expect(line).toContain(
      "superpipeline 200 contract_refused at #/agents/1/inFlight",
    );
    expect(w.log.join("\n")).not.toContain(leaked);
  });

  test("before SuperPipeline serves the route (a 404): the roster agents only, as before", async () => {
    const w = world(
      {
        status: 404,
        json: { error: { code: "NOT_FOUND", message: "Not Found" } },
      },
      true,
    );
    await w.loop.passBoard(BOARD);
    expect(w.held()).toEqual([]);
    expect(w.verdicts()).toEqual({ agt_a: "ok" });
    expect(
      w.log.some((l) => l.includes("agent load unread (superpipeline 404")),
    ).toBe(true);
  });
});
