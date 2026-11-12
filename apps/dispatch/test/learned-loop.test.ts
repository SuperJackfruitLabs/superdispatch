import { afterEach, describe, expect, test } from "bun:test";
import { createLoop } from "../src/loop/index.ts";
import {
  createLearnedRouter,
  type LearnedSettings,
} from "../src/loop/learned.ts";
import { POLICY, place } from "../src/placement/index.ts";
import { MODEL_KIND } from "../src/placement/learned.ts";
import { learnedPolicy } from "../src/placement/shadow.ts";
import { createHandler } from "../src/routes/index.ts";
import type {
  Agentpod,
  CardView,
  RosterEntry,
  Superpipeline,
} from "../src/sources/index.ts";
import type { Store } from "../src/store/index.ts";
import { T0, facts, recentFirst } from "./candidates.ts";
import { OPERATOR_TOKEN, OPERATOR_TOKEN_SHA256, tempStore } from "./helpers.ts";

const BOARD = "brd_00000000000000b1";
const CARD = "card_00000000000000c1";
const S = 1000;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/**
 * One board with one ready card and two idle agents: `agt_a` last took work 900 s ago, `agt_b`
 * 300 s ago. The formula (least recently used) chooses `agt_a`; the model `recentFirst` prefers
 * `agt_b`.
 */
function world(learned?: LearnedSettings) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  t.store.enableBoard(BOARD, new Date(T0).toISOString());
  const reserved: string[] = [];
  const log: string[] = [];
  let modelReads = 0;
  const latest = t.store.latestModel.bind(t.store);
  t.store.latestModel = () => {
    modelReads++;
    return latest();
  };
  const card: CardView = {
    id: CARD,
    stageKey: "build",
    state: "submitted",
    currentRunId: null,
    lastAgentId: null,
    attemptCount: 0,
    priority: 0,
    createdAt: new Date(T0 - 60 * S).toISOString(),
    archived: false,
    reservation: null,
  };
  const entry = (agent: string, idleS: number): RosterEntry => ({
    key: agent,
    stationId: `stn_${agent}`,
    principalId: `prn_${agent}`,
    enabled: true,
    ready: true,
    busy: false,
    lastDispatchedAt: new Date(T0 - idleS * S).toISOString(),
  });
  const superpipeline: Superpipeline = {
    board: async (boardId) => ({
      boardId,
      stages: [
        {
          key: "build",
          ownerKind: "capability",
          hasRequires: true,
          requires: { all: ["code"], any: [] },
          placement: null,
        },
      ],
      cards: [card],
    }),
    eligibility: async () => ({
      stageKey: "build",
      reasons: [],
      agents: ["agt_a", "agt_b"].map((agentId) => ({
        agentId,
        principalId: `prn_${agentId}`,
        eligible: true,
        reasons: [],
      })),
    }),
    reserve: async (_b, _c, hold) => {
      reserved.push(hold.agentId);
      return {
        ok: true,
        reservedUntil: new Date(T0 + hold.ttlSeconds * S).toISOString(),
      };
    },
    clearReservation: async () => {},
    agentLoad: async () => [],
  };
  const agentpod: Agentpod = {
    roster: async () => [entry("agt_a", 900), entry("agt_b", 300)],
    stationCapabilities: async () => null,
  };
  let ids = 0;
  const loop = createLoop({
    store: t.store,
    superpipeline,
    agentpod,
    ...(learned ? { learned } : {}),
    now: () => T0,
    newId: () => `pld_${String(++ids).padStart(24, "0")}`,
    log: (line) => log.push(line),
  });
  return {
    store: t.store,
    loop,
    reserved,
    log,
    get modelReads() {
      return modelReads;
    },
  };
}

function saveModel(store: Store, rows: number) {
  return store.saveModel({
    id: "mdl_000000000000000000000001",
    kind: MODEL_KIND,
    datasetSchema: 1,
    body: recentFirst(),
    metrics: {},
    rows,
    since: null,
    createdAt: new Date(T0 - 3600 * S).toISOString(),
  });
}

/** A settled shadow decision in which the model's choice claimed the card after the formula's lapsed. */
function shadowWin(store: Store, n: number) {
  const id = `pld_${String(900 + n).padStart(24, "0")}`;
  store.recordDecision({
    id,
    boardId: BOARD,
    cardId: "card_00000000000000c9",
    stageKey: "build",
    policy: POLICY,
    chosenAgent: "agt_a",
    noDecisionReason: null,
    candidates: [],
    attemptsBefore: 0,
    tier: "winner",
    tierStep: 1,
    createdAt: new Date(T0 - 7200 * S + n).toISOString(),
  });
  store.settle(
    id,
    "claimed-by-other",
    "agt_b",
    new Date(T0 - 3600 * S).toISOString(),
  );
  store.recordShadow({
    decisionId: id,
    modelId: "mdl_000000000000000000000001",
    formulaAgent: "agt_a",
    learnedAgent: "agt_b",
    learnedScore: 0.9,
    scores: { agt_a: 0.1, agt_b: 0.9 },
    acted: false,
    createdAt: new Date(T0 - 7200 * S).toISOString(),
  });
}

const gate = { minRows: 500, minShadow: 2, marginPct: 5 };
const MODEL = "mdl_000000000000000000000007";

describe("learned routing in the loop", () => {
  test("off: no model is read, no shadow is recorded, the formula places", async () => {
    const w = world();
    saveModel(w.store, 1000);
    await w.loop.passBoard(BOARD);
    const [d] = w.store.listDecisions({ limit: 5 });
    expect(d?.chosenAgent).toBe("agt_a");
    expect(d?.policy).toBe(POLICY);
    expect(w.reserved).toEqual(["agt_a"]);
    expect(w.store.getShadow(d?.id ?? "")).toBeNull();
    expect(w.modelReads).toBe(0);
  });

  // Revert-proof: hold the model's choice in shadow and this fails on the decision and the hold.
  test("shadow never changes the chosen agent: it records what the model would have chosen", async () => {
    const w = world({ mode: "shadow", ...gate });
    saveModel(w.store, 1000);
    shadowWin(w.store, 1);
    shadowWin(w.store, 2);
    await w.loop.passBoard(BOARD);
    const [d] = w.store.listDecisions({
      boardId: BOARD,
      cardId: CARD,
      limit: 5,
    });
    expect(d?.chosenAgent).toBe("agt_a");
    expect(d?.policy).toBe(POLICY);
    expect(w.reserved).toEqual(["agt_a"]);
    const shadow = w.store.getShadow(d?.id ?? "");
    expect(shadow?.formulaAgent).toBe("agt_a");
    expect(shadow?.learnedAgent).toBe("agt_b");
    expect(shadow?.acted).toBe(false);
    expect(Object.keys(shadow?.scores ?? {}).toSorted()).toEqual([
      "agt_a",
      "agt_b",
    ]);
  });

  test("shadow with no model places by the formula and records nothing", async () => {
    const w = world({ mode: "shadow", ...gate });
    await w.loop.passBoard(BOARD);
    const [d] = w.store.listDecisions({ limit: 5 });
    expect(d?.chosenAgent).toBe("agt_a");
    expect(w.store.getShadow(d?.id ?? "")).toBeNull();
  });

  test("on, past the gate: the model's choice is held, under the learned policy", async () => {
    const w = world({ mode: "on", ...gate });
    const model = saveModel(w.store, 500);
    shadowWin(w.store, 1);
    shadowWin(w.store, 2);
    await w.loop.passBoard(BOARD);
    const [d] = w.store.listDecisions({
      boardId: BOARD,
      cardId: CARD,
      limit: 5,
    });
    expect(d?.chosenAgent).toBe("agt_b");
    expect(d?.policy).toBe(learnedPolicy(model.version));
    expect(w.reserved).toEqual(["agt_b"]);
    expect(w.store.getShadow(d?.id ?? "")?.acted).toBe(true);
    expect(w.log).toContain("learned: on, model v1 places");
  });

  test("on, short of the gate: the formula places, and the log says why", async () => {
    for (const [rows, wins, reason] of [
      [499, 2, "too-few-rows"],
      [500, 1, "too-few-shadow"],
    ] as const) {
      const w = world({ mode: "on", ...gate });
      saveModel(w.store, rows);
      for (let i = 0; i < wins; i++) shadowWin(w.store, i);
      await w.loop.passBoard(BOARD);
      const [d] = w.store.listDecisions({
        boardId: BOARD,
        cardId: CARD,
        limit: 5,
      });
      expect(d?.chosenAgent).toBe("agt_a");
      expect(d?.policy).toBe(POLICY);
      expect(w.reserved).toEqual(["agt_a"]);
      expect(w.store.getShadow(d?.id ?? "")?.acted).toBe(false);
      expect(w.log).toContain(`learned: on, formula places (${reason})`);
    }
  });

  test("on with no lift falls back to the formula", () => {
    const t = tempStore();
    cleanups.push(t.cleanup);
    saveModel(t.store, 1000);
    const log: string[] = [];
    const router = createLearnedRouter({
      store: t.store,
      settings: { mode: "on", minRows: 1, minShadow: 0, marginPct: 5 },
      log: (l) => log.push(l),
    });
    const d = place({
      card: { boardId: BOARD, cardId: CARD, stageKey: "build" },
      nowMs: T0,
      candidates: [
        facts("agt_a", { idleS: 900 }),
        facts("agt_b", { idleS: 300 }),
      ],
    });
    const routed = router.route(d, T0);
    expect(routed.decision).toBe(d);
    expect(routed.shadow?.learnedAgent).toBe("agt_b");
    expect(log).toEqual(["learned: on, formula places (no-lift)"]);
    // The verdict is reused, and not logged again.
    router.route(d, T0 + 1000);
    expect(log).toHaveLength(1);
  });
});

function api(store: Store) {
  return createHandler({
    config: {
      relayDeliverySecret: "s",
      operatorTokenSha256: OPERATOR_TOKEN_SHA256,
    },
    store,
    now: () => T0,
    learned: { mode: "shadow", ...gate },
    newModelId: () => MODEL,
    log: () => {},
  });
}
const op = (
  path: string,
  method = "GET",
  body?: unknown,
  token = OPERATOR_TOKEN,
) =>
  new Request(`http://dispatch${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

/** Settled decisions where the idler agent claims: something to learn. */
function history(store: Store, n: number) {
  for (let i = 0; i < n; i++) {
    const d = place({
      card: { boardId: BOARD, cardId: CARD, stageKey: "build" },
      nowMs: T0,
      candidates: [
        facts("agt_a", { idleS: 100 + i }),
        facts("agt_b", { idleS: 5000 + i }),
      ],
    });
    const id = `pld_${String(i).padStart(24, "0")}`;
    store.recordDecision({
      id,
      boardId: BOARD,
      cardId: CARD,
      stageKey: "build",
      policy: POLICY,
      chosenAgent: d.kind === "placed" ? d.chosen : null,
      noDecisionReason: null,
      candidates: d.candidates,
      attemptsBefore: i,
      tier: d.tier.name,
      tierStep: d.tier.step,
      createdAt: new Date(T0 + i * S).toISOString(),
    });
    // The formula chose agt_b (idle longest): half the time it claims, half agt_a does instead.
    if (i % 2 === 0) store.settle(id, "claimed", "agt_b", "x");
    else store.settle(id, "claimed-by-other", "agt_a", "x");
  }
}

describe("the learned-routing API", () => {
  test("refuses a missing or wrong token", async () => {
    const t = tempStore();
    cleanups.push(t.cleanup);
    const handle = api(t.store);
    for (const path of ["/v1/dataset", "/v1/models", "/v1/models/train"]) {
      expect((await handle(op(path, "GET", undefined, ""))).status).toBe(401);
      expect((await handle(op(path, "GET", undefined, "wrong"))).status).toBe(
        401,
      );
    }
  });

  test("exports the dataset as JSON lines, from a time, or as JSON", async () => {
    const t = tempStore();
    cleanups.push(t.cleanup);
    history(t.store, 3);
    const handle = api(t.store);
    const r = await handle(op("/v1/dataset"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/x-ndjson");
    expect(r.headers.get("x-dataset-schema")).toBe("1");
    const lines = (await r.text())
      .trim()
      .split("\n")
      .map((l): unknown => JSON.parse(l));
    expect(lines).toHaveLength(6);
    expect(lines).toMatchObject([
      { agentId: "agt_a", chosen: false, label: "lost", target: null },
      { agentId: "agt_b", chosen: true, label: "won-claimed", target: 1 },
      { agentId: "agt_a", chosen: false, label: "lost-claimed", target: 1 },
      {
        agentId: "agt_b",
        chosen: true,
        label: "won-claimed-by-other",
        target: 0,
      },
      { agentId: "agt_a", chosen: false, label: "lost", target: null },
      { agentId: "agt_b", chosen: true, label: "won-claimed", target: 1 },
    ]);
    const since = await handle(
      op(
        `/v1/dataset?since=${encodeURIComponent(new Date(T0 + 2 * S).toISOString())}&format=json`,
      ),
    );
    const body: unknown = await since.json();
    expect(body).toMatchObject({ schema: 1, rows: [{}, {}] });
    expect((await handle(op("/v1/dataset?since=soon"))).status).toBe(400);
    expect((await handle(op("/v1/dataset?format=csv"))).status).toBe(400);
    expect((await handle(op("/v1/dataset", "POST"))).status).toBe(405);
  });

  test("trains a model, lists it, and reports on it in shadow", async () => {
    const t = tempStore();
    cleanups.push(t.cleanup);
    const handle = api(t.store);
    const empty = await handle(op("/v1/models/train", "POST"));
    expect(empty.status).toBe(422);
    expect(await empty.json()).toEqual({ error: "no-training-rows", count: 0 });
    history(t.store, 40);
    const r = await handle(op("/v1/models/train", "POST", { seed: 3 }));
    expect(r.status).toBe(201);
    const created: unknown = await r.json();
    expect(created).toMatchObject({
      model: {
        id: MODEL,
        version: 1,
        rows: 60,
        metrics: { seed: 3, count: 60, auc: expect.any(Number) },
      },
    });
    const list: unknown = await (await handle(op("/v1/models"))).json();
    expect(list).toMatchObject({ models: [{ id: MODEL }] });
    expect((await handle(op(`/v1/models/${MODEL}`))).status).toBe(200);
    const report: unknown = await (
      await handle(op(`/v1/models/${MODEL}/shadow-report`))
    ).json();
    expect(report).toMatchObject({
      mode: "shadow",
      report: { recorded: 0 },
      gate: {
        use: false,
        reason: "too-few-rows",
        minRows: 500,
        minShadow: 2,
        marginPct: 5,
      },
    });
    expect(
      (await handle(op("/v1/models/mdl_000000000000000000000009"))).status,
    ).toBe(404);
    expect(
      (await handle(op("/v1/models/train", "POST", { seed: -1 }))).status,
    ).toBe(400);
    expect(
      (await handle(op("/v1/models/train", "POST", { since: 5 }))).status,
    ).toBe(400);
    expect((await handle(op("/v1/models/train"))).status).toBe(405);
  });
});
