import { afterEach, describe, expect, test } from "bun:test";
import {
  DATASET_SCHEMA,
  FEATURES,
  type DatasetRow,
  type FeatureName,
} from "../src/placement/dataset.ts";
import {
  DEFAULT_TRAIN,
  auc,
  calibration,
  examplesOf,
  inHoldout,
  learnedChoice,
  modelApplies,
  predict,
  train,
  withLearnedChoice,
} from "../src/placement/learned.ts";
import {
  learnedGate,
  learnedPolicy,
  shadowReport,
  type ShadowOutcome,
} from "../src/placement/shadow.ts";
import { POLICY, place } from "../src/placement/index.ts";
import { T0, facts, recentFirst } from "./candidates.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const zeros = (): Record<FeatureName, number> => ({
  stageRecord: 0,
  hasStageRecord: 0,
  stageRuns: 0,
  successRate: 0,
  recency: 0,
  neverDispatched: 0,
  direct: 0,
  tierStep: 0,
  hourSin: 0,
  hourCos: 0,
  eligibleCandidates: 0,
  poolBusy: 0,
});

/** A training row: only what training reads is real. */
const row = (
  decisionId: string,
  features: Partial<Record<FeatureName, number>>,
  target: 0 | 1 | null,
) =>
  ({
    schema: DATASET_SCHEMA,
    decisionId,
    boardId: "brd_00000000000000b1",
    cardId: "card_00000000000000c1",
    stageKey: "build",
    capability: null,
    policy: POLICY,
    tier: "winner",
    tierStep: 1,
    createdAt: "2026-11-12T13:00:00.000Z",
    hour: 13,
    outcome: "claimed",
    outcomeBy: null,
    outcomeAt: null,
    agentId: "agt_a",
    source: "roster",
    chosen: true,
    eligible: true,
    filters: {},
    score: null,
    stageHistory: null,
    pool: { candidates: 1, inSet: 1, eligible: 1, busy: 0 },
    label: "won-claimed",
    target,
    features: { ...zeros(), ...features },
  }) satisfies DatasetRow;

/** Separable on successRate: 1 above one half, 0 below; the rest noise that does not matter. */
function toySet(n = 200): DatasetRow[] {
  return Array.from({ length: n }, (_, i) => {
    const high = i % 2 === 0;
    return row(
      `pld_${String(i).padStart(24, "0")}`,
      {
        successRate: high ? 0.6 + (i % 7) / 50 : 0.4 - (i % 7) / 50,
        recency: (i * 37) % 11,
        hourSin: Math.sin(i),
      },
      high ? 1 : 0,
    );
  });
}

describe("training", () => {
  test("learns a separable toy set: holdout AUC and accuracy 1", () => {
    const fitted = train(toySet());
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;
    const m = fitted.metrics;
    expect(m.count).toBe(200);
    expect(m.trainCount + m.holdoutCount).toBe(200);
    expect(m.holdoutCount).toBeGreaterThan(20);
    expect(m.positives).toBe(100);
    expect(m.auc).toBe(1);
    expect(m.accuracy).toBe(1);
    expect(m.trainAuc).toBe(1);
    expect(m.calibration).toHaveLength(5);
    expect(m.calibration.reduce((s, b) => s + b.count, 0)).toBe(m.holdoutCount);
    const i = FEATURES.indexOf("successRate");
    expect(fitted.body.weights[i]).toBeGreaterThan(0);
  });

  test("is deterministic: the same rows and seed give the same model, another seed another split", () => {
    const a = train(toySet());
    const b = train(toySet());
    expect(a).toEqual(b);
    const c = train(toySet(), { ...DEFAULT_TRAIN, seed: 2 });
    if (!a.ok || !c.ok) throw new Error("expected models");
    expect(c.metrics.holdoutCount).not.toBe(a.metrics.holdoutCount);
    // A decision's rows fall on one side of the split, whatever else is in the set.
    expect(inHoldout("pld_x", 1, 20)).toBe(inHoldout("pld_x", 1, 20));
  });

  test("trains only on rows with a target, and refuses with none or one label", () => {
    expect(
      examplesOf([row("d1", {}, null), row("d2", {}, 1)]).map((e) => e.group),
    ).toEqual(["d2"]);
    expect(train([row("d1", {}, null)])).toEqual({
      ok: false,
      reason: "no-training-rows",
      count: 0,
    });
    expect(train([row("d1", {}, 1), row("d2", {}, 1)])).toEqual({
      ok: false,
      reason: "one-label",
      count: 2,
    });
  });

  test("AUC counts ties as one half, and is null with one label; calibration bins", () => {
    expect(
      auc([
        { p: 0.9, y: 1 },
        { p: 0.1, y: 0 },
      ]),
    ).toBe(1);
    expect(
      auc([
        { p: 0.5, y: 1 },
        { p: 0.5, y: 0 },
      ]),
    ).toBe(0.5);
    expect(
      auc([
        { p: 0.2, y: 1 },
        { p: 0.8, y: 0 },
        { p: 0.6, y: 1 },
      ]),
    ).toBe(0);
    expect(auc([{ p: 0.3, y: 1 }])).toBeNull();
    const bins = calibration(
      [
        { p: 0.1, y: 0 },
        { p: 0.15, y: 1 },
        { p: 1, y: 1 },
      ],
      2,
    );
    expect(bins).toEqual([
      { lo: 0, hi: 0.5, count: 2, meanPredicted: 0.125, observed: 0.5 },
      { lo: 0.5, hi: 1, count: 1, meanPredicted: 1, observed: 1 },
    ]);
  });
});

const decision = () =>
  place({
    card: {
      boardId: "brd_00000000000000b1",
      cardId: "card_00000000000000c1",
      stageKey: "build",
    },
    nowMs: T0,
    candidates: [
      facts("agt_a", { idleS: 900 }),
      facts("agt_b", { idleS: 300 }),
      facts("agt_c", { idleS: 10, busy: true }),
    ],
  });
const model = (body = recentFirst()) => ({
  id: "mdl_1",
  version: 1,
  rows: 1000,
  body,
});

describe("a learned choice", () => {
  test("ranks the eligible only, and replaces nothing until applied", () => {
    const d = decision();
    if (d.kind !== "placed") throw new Error("expected a placement");
    expect(d.chosen).toBe("agt_a");
    const choice = learnedChoice(d, model(), T0);
    // agt_c took work most recently, but is busy: never named.
    expect(choice?.agentId).toBe("agt_b");
    expect(Object.keys(choice?.scores ?? {})).toEqual(["agt_a", "agt_b"]);
    expect(choice?.score).toBeCloseTo(
      predict(
        recentFirst(),
        FEATURES.map((f) => (f === "recency" ? Math.log1p(300) : 0)),
      ),
      1,
    );
    expect(d.chosen).toBe("agt_a");
    const applied = withLearnedChoice(
      d,
      choice ?? { agentId: "", score: 0, scores: {} },
    );
    expect(applied.kind === "placed" && applied.chosen).toBe("agt_b");
    expect(applied.candidates).toBe(d.candidates);
  });

  test("a tie goes to the formula's choice; a model of other features does not apply", () => {
    const d = decision();
    const flat = { ...recentFirst(), weights: FEATURES.map(() => 0) };
    expect(learnedChoice(d, model(flat), T0)?.agentId).toBe("agt_a");
    const other = { ...recentFirst(), features: ["x", ...FEATURES.slice(1)] };
    expect(modelApplies(other)).toBe(false);
    expect(learnedChoice(d, model(other), T0)).toBeNull();
  });
});

const s = (
  formulaAgent: string,
  learnedAgent: string,
  outcome: string | null,
  outcomeBy: string | null = null,
  acted = false,
): ShadowOutcome => ({
  formulaAgent,
  learnedAgent,
  outcome,
  outcomeBy,
  acted,
});

describe("the shadow report and the gate", () => {
  test("credits each side with what happened, and the model only with what is known", () => {
    const r = shadowReport([
      s("a", "a", "claimed", "a"), // agree, both right
      s("a", "a", "expired"), // agree, both wrong
      s("a", "b", "claimed", "a"), // formula right
      s("a", "b", "claimed-by-other", "b"), // model right
      s("a", "b", "expired"), // formula wrong, model unknown
      s("a", "b", "claimed-by-other", "c"), // neither
      s("a", "b", "superseded"), // no signal
      s("a", "b", null), // unsettled
      s("b", "b", "claimed", "b", true), // the model acted: not evidence
    ]);
    expect(r).toEqual({
      recorded: 9,
      acted: 1,
      settled: 7,
      informative: 6,
      agree: 2,
      disagree: 4,
      formula: { claimed: 2, rate: 2 / 6 },
      learned: { claimed: 2, rate: 2 / 6 },
      disagreements: { formulaRight: 1, learnedRight: 1, unknown: 2 },
      liftPct: 0,
    });
    expect(shadowReport([]).liftPct).toBeNull();
  });

  test("the gate: rows, shadow decisions, then the margin, each at its threshold", () => {
    const settings = { minRows: 500, minShadow: 4, marginPct: 25 };
    const lift = (n: number) =>
      shadowReport([
        ...Array.from({ length: n }, () =>
          s("a", "b", "claimed-by-other", "b"),
        ),
        ...Array.from({ length: 4 - n }, () => s("a", "a", "expired")),
      ]);
    const ok = { rows: 500, applies: true };
    expect(learnedGate(null, null, settings)).toEqual({
      use: false,
      reason: "no-model",
    });
    expect(
      learnedGate({ rows: 500, applies: false }, lift(4), settings),
    ).toEqual({
      use: false,
      reason: "features-changed",
    });
    expect(
      learnedGate({ rows: 499, applies: true }, lift(4), settings),
    ).toEqual({
      use: false,
      reason: "too-few-rows",
    });
    expect(
      learnedGate(
        ok,
        shadowReport([s("a", "b", "claimed-by-other", "b")]),
        settings,
      ),
    ).toEqual({ use: false, reason: "too-few-shadow" });
    // One of four is 25 points over the formula's 0: exactly the margin passes.
    expect(lift(1).liftPct).toBe(25);
    expect(learnedGate(ok, lift(1), settings)).toEqual({ use: true });
    expect(learnedGate(ok, lift(0), settings)).toEqual({
      use: false,
      reason: "no-lift",
    });
    expect(learnedGate(ok, lift(1), { ...settings, marginPct: 26 })).toEqual({
      use: false,
      reason: "no-lift",
    });
    expect(learnedPolicy(3)).toBe(`${POLICY}+learned:v3`);
  });
});
