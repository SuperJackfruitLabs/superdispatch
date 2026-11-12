/**
 * Learned routing in the loop: what the latest model makes of each decision, by the mode the
 * operator set (`SUPERDISPATCH_LEARNED`).
 *
 * - `off`: nothing is read and every decision is the formula's, as before learned routing existed.
 * - `shadow`: each placed decision also records what the latest model would have chosen and its
 *   score; the formula's choice is what is recorded and held. The model never changes a decision.
 * - `on`: the same, and when the model passes the gate (placement's `learnedGate`: enough training
 *   rows, enough settled shadow decisions, a lift over the formula of at least the margin) its
 *   choice is held instead, and the decision is recorded under the learned policy. A model that
 *   does not pass is logged, with the reason, and the formula places, as in shadow.
 *
 * Placement stays pure: the model is read from the store here and handed to placement as data.
 * The gate's shadow report is read again at most every `REFRESH_MS`, or when a newer model lands.
 */
import type { LearnedMode } from "../config.ts";
import type { ModelRow, ShadowEntry, Store } from "../store/index.ts";
import { POLICY, type Decision } from "../placement/index.ts";
import {
  learnedChoice,
  modelApplies,
  withLearnedChoice,
  type LearnedModel,
  type ModelBody,
} from "../placement/learned.ts";
import { isRecord } from "../placement/dataset.ts";
import {
  learnedGate,
  learnedPolicy,
  shadowReport,
  type GateSettings,
} from "../placement/shadow.ts";

/** How long a gate verdict is reused before the shadow report is read again. */
export const REFRESH_MS = 60_000;

export interface LearnedSettings extends GateSettings {
  readonly mode: LearnedMode;
}

export const LEARNED_OFF: LearnedSettings = {
  mode: "off",
  minRows: 500,
  minShadow: 100,
  marginPct: 5,
};

/** What routing made of one decision: the decision to record, its policy, and its shadow entry. */
export interface Routed {
  readonly decision: Decision;
  readonly policy: string;
  /** What the model would have chosen; null when no model applied. */
  readonly shadow: Omit<ShadowEntry, "decisionId" | "createdAt"> | null;
}

export interface LearnedRouter {
  route(decision: Decision, nowMs: number): Routed;
}

/** A stored model as placement takes it; null when its body is not one. */
export function learnedModelOf(row: ModelRow): LearnedModel | null {
  const b = row.body;
  if (!isRecord(b)) return null;
  const { features, weights, bias, means, scales } = b;
  if (
    !strings(features) ||
    !numbers(weights) ||
    !numbers(means) ||
    !numbers(scales) ||
    typeof bias !== "number"
  )
    return null;
  const body: ModelBody = { features, weights, bias, means, scales };
  return { id: row.id, version: row.version, rows: row.rows, body };
}

const numbers = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((x) => typeof x === "number");
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

export function createLearnedRouter(deps: {
  store: Pick<Store, "latestModel" | "shadowOutcomes">;
  settings?: LearnedSettings;
  log: (line: string) => void;
}): LearnedRouter {
  const settings = deps.settings ?? LEARNED_OFF;
  const { log } = deps;
  let cached: {
    atMs: number;
    model: LearnedModel | null;
    use: boolean;
  } | null = null;
  let lastRefusal: string | null = null;

  function current(nowMs: number) {
    const row = deps.store.latestModel();
    if (
      cached !== null &&
      cached.model?.id === row?.id &&
      nowMs - cached.atMs < REFRESH_MS
    )
      return cached;
    const model = row === null ? null : learnedModelOf(row);
    let use = false;
    if (settings.mode === "on") {
      const verdict = learnedGate(
        model === null
          ? null
          : { rows: model.rows, applies: modelApplies(model.body) },
        model === null
          ? null
          : shadowReport(deps.store.shadowOutcomes(model.id)),
        settings,
      );
      use = verdict.use;
      const said = verdict.use
        ? `model v${model?.version} places`
        : `formula places (${verdict.reason})`;
      if (said !== lastRefusal) {
        log(`learned: on, ${said}`);
        lastRefusal = said;
      }
    }
    cached = { atMs: nowMs, model, use };
    return cached;
  }

  return {
    route(decision, nowMs) {
      const formula: Routed = { decision, policy: POLICY, shadow: null };
      if (settings.mode === "off" || decision.kind !== "placed") return formula;
      const { model, use } = current(nowMs);
      if (model === null) return formula;
      const choice = learnedChoice(decision, model, nowMs);
      if (choice === null) return formula;
      const shadow = {
        modelId: model.id,
        formulaAgent: decision.chosen,
        learnedAgent: choice.agentId,
        learnedScore: choice.score,
        scores: { ...choice.scores },
        acted: use,
      };
      if (!use) return { ...formula, shadow };
      return {
        decision: withLearnedChoice(decision, choice),
        policy: learnedPolicy(model.version),
        shadow,
      };
    },
  };
}
