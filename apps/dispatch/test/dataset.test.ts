import { afterEach, describe, expect, test } from "bun:test";
import {
  DATASET_SCHEMA,
  FEATURES,
  LABELS,
  datasetRows,
  featuresOf,
  hourOf,
  labelOf,
  poolOf,
  recordedCandidates,
  targetOf,
  type Label,
} from "../src/placement/dataset.ts";
import { place } from "../src/placement/index.ts";
import { T0, facts } from "./candidates.ts";
import { tempStore } from "./helpers.ts";

const BOARD = "brd_00000000000000b1";
const CARD = "card_00000000000000c1";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** A placed decision on three agents: a (idle longest, chosen), b eligible, c busy. */
function decided() {
  const d = place({
    card: { boardId: BOARD, cardId: CARD, stageKey: "build" },
    nowMs: T0,
    candidates: [
      facts("agt_a", { idleS: 900 }),
      facts("agt_b", { idleS: 300 }),
      facts("agt_c", { busy: true }),
    ],
  });
  if (d.kind !== "placed") throw new Error("expected a placement");
  return d;
}

const settled = (
  outcome: string | null,
  outcomeBy: string | null,
  over: Record<string, unknown> = {},
) => {
  const d = decided();
  return {
    id: "pld_000000000000000000000001",
    boardId: BOARD,
    cardId: CARD,
    stageKey: "build",
    policy: "idle-stage-success-lru@3",
    chosenAgent: d.chosen,
    candidates: JSON.parse(JSON.stringify(d.candidates)) as unknown,
    tier: d.tier.name,
    tierStep: d.tier.step,
    requires: { all: ["code"], any: [] },
    outcome,
    outcomeBy,
    outcomeAt: outcome === null ? null : new Date(T0 + 5000).toISOString(),
    createdAt: new Date(T0).toISOString(),
    ...over,
  };
};

describe("labels", () => {
  // outcome, outcome by, the candidate, chosen? -> label, target when eligible
  const table: [string, string | null, string, boolean, Label, 0 | 1 | null][] =
    [
      ["claimed", "agt_a", "agt_a", true, "won-claimed", 1],
      ["claimed", "agt_a", "agt_b", false, "lost", null],
      ["expired", null, "agt_a", true, "won-expired", 0],
      ["expired", null, "agt_b", false, "lost", null],
      ["claimed-by-other", "agt_b", "agt_a", true, "won-claimed-by-other", 0],
      ["claimed-by-other", "agt_b", "agt_b", false, "lost-claimed", 1],
      ["claimed-by-other", "agt_x", "agt_b", false, "lost", null],
      ["claimed-by-other", "agt_b", "agt_b", false, "lost-claimed", 1],
      ["superseded", null, "agt_a", true, "void", null],
      ["not-reserved", null, "agt_a", true, "void", null],
    ];
  for (const [outcome, by, agent, chosen, label, target] of table)
    test(`${outcome} by ${by ?? "nobody"}, ${agent}${chosen ? " chosen" : ""}: ${label}`, () => {
      expect(labelOf(outcome, by, agent, chosen)).toBe(label);
      expect(targetOf(label, true)).toBe(target);
      expect(targetOf(label, false)).toBeNull();
    });

  test("every label has a target rule", () => {
    for (const label of LABELS)
      expect([0, 1, null]).toContain(targetOf(label, true));
  });
});

describe("the exporter", () => {
  test("one row per candidate of a settled decision, with its features and label", () => {
    const rows = datasetRows([settled("claimed", "agt_a")]);
    expect(
      rows.map((r) => [r.agentId, r.chosen, r.eligible, r.label, r.target]),
    ).toEqual([
      ["agt_a", true, true, "won-claimed", 1],
      ["agt_b", false, true, "lost", null],
      ["agt_c", false, false, "lost", null],
    ]);
    const [a, , c] = rows;
    expect(a?.schema).toBe(DATASET_SCHEMA);
    expect(a?.hour).toBe(13);
    expect(a?.capability).toEqual({ all: ["code"], any: [] });
    expect(a?.tier).toBe("winner");
    expect(a?.pool).toEqual({ candidates: 3, inSet: 3, eligible: 2, busy: 1 });
    expect(a?.filters.idle).toBe(true);
    expect(c?.filters.idle).toBe("not-idle");
    expect(c?.features).toBeNull();
    expect(c?.score).toBeNull();
    expect(Object.keys(a?.features ?? {})).toEqual([...FEATURES]);
    expect(a?.features?.recency).toBeCloseTo(Math.log1p(900), 9);
    expect(a?.features?.poolBusy).toBeCloseTo(1 / 3, 9);
    expect(a?.features?.successRate).toBe(0.5);
    expect(a?.features?.hasStageRecord).toBe(0);
  });

  test("an unsettled decision gives no rows; a claim by somebody else labels both sides", () => {
    expect(datasetRows([settled(null, null)])).toEqual([]);
    const rows = datasetRows([settled("claimed-by-other", "agt_b")]);
    expect(rows.map((r) => r.label)).toEqual([
      "won-claimed-by-other",
      "lost-claimed",
      "lost",
    ]);
  });

  test("reads candidate records loosely, and the pool from their filters", () => {
    const recs = recordedCandidates([
      {
        candidate: { agentId: "agt_a" },
        filters: [{ filter: "roster", passed: true }],
      },
      { candidate: {}, filters: [] },
      "junk",
      { candidate: { agentId: "agt_b" } },
    ]);
    expect(recs.map((r) => r.agentId)).toEqual(["agt_a"]);
    expect(poolOf(recs)).toEqual({
      candidates: 1,
      inSet: 1,
      eligible: 0,
      busy: 0,
    });
    const [first] = recs;
    if (first === undefined) throw new Error("expected a record");
    expect(
      featuresOf(first, {
        tierStep: 1,
        atMs: T0,
        pool: poolOf(recs),
      }),
    ).toBeNull();
    expect(hourOf(Date.parse("2026-11-12T23:59:59Z"))).toBe(23);
  });

  test("the store reads settled decisions oldest first, from a time", () => {
    const t = tempStore();
    cleanups.push(t.cleanup);
    const d = decided();
    for (let i = 0; i < 3; i++)
      t.store.recordDecision({
        id: `pld_${String(i).padStart(24, "0")}`,
        boardId: BOARD,
        cardId: CARD,
        stageKey: "build",
        policy: "p",
        chosenAgent: d.chosen,
        noDecisionReason: null,
        candidates: d.candidates,
        attemptsBefore: 0,
        tier: "winner",
        tierStep: 1,
        createdAt: new Date(T0 + i * 1000).toISOString(),
      });
    t.store.settle("pld_000000000000000000000002", "claimed", "agt_a", "x");
    t.store.settle("pld_000000000000000000000000", "expired", null, "x");
    expect(t.store.settledSince(null, 10).map((r) => r.id)).toEqual([
      "pld_000000000000000000000000",
      "pld_000000000000000000000002",
    ]);
    expect(
      t.store
        .settledSince(new Date(T0 + 1000).toISOString(), 10)
        .map((r) => r.id),
    ).toEqual(["pld_000000000000000000000002"]);
    const rows = datasetRows(t.store.settledSince(null, 10));
    expect(rows.filter((r) => r.chosen).map((r) => r.label)).toEqual([
      "won-expired",
      "won-claimed",
    ]);
  });
});
