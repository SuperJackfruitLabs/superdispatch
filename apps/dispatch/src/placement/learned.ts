/**
 * The learned scorer: logistic regression over the dataset's features (`dataset.ts`), fitted by
 * full-batch gradient descent from zero weights, in plain TypeScript with no dependency. The same
 * rows and settings always give the same model: there is no random start, and the holdout split
 * is a hash of each decision's id with the seed, so every candidate of one decision falls on the
 * same side of it.
 *
 * Pure, like the rest of placement. The model is data: the loop reads it from the store and hands
 * it in, and `learnedChoice` ranks a decision's eligible candidates by it without changing the
 * decision; `withLearnedChoice` is the one place a learned choice replaces the formula's, and the
 * loop calls it only when the gate (`shadow.ts`) says the model has earned it.
 */
import type { Decision } from "./index.ts";
import {
  DATASET_SCHEMA,
  FEATURES,
  featuresOf,
  poolOf,
  recordedCandidates,
  vectorOf,
  type DatasetRow,
} from "./dataset.ts";

/** The kind of model, recorded with it. */
export const MODEL_KIND = "logistic@1";

/** A fitted model's parameters: inputs are standardised by `means` and `scales` first. */
export interface ModelBody {
  readonly features: readonly string[];
  readonly weights: readonly number[];
  readonly bias: number;
  readonly means: readonly number[];
  readonly scales: readonly number[];
}

/** A model as placement uses it. */
export interface LearnedModel {
  readonly id: string;
  readonly version: number;
  readonly body: ModelBody;
  /** The training rows it was fitted on. */
  readonly rows: number;
}

export interface TrainSettings {
  /** Seeds the holdout split. */
  readonly seed: number;
  /** The share of decisions held out, 0 to 50. */
  readonly holdoutPct: number;
  readonly epochs: number;
  readonly learningRate: number;
  /** L2 penalty on the weights (not the bias). */
  readonly l2: number;
}

export const DEFAULT_TRAIN: TrainSettings = {
  seed: 1,
  holdoutPct: 20,
  epochs: 400,
  learningRate: 0.5,
  l2: 0.001,
};

/** One bin of a calibration table: predictions in [lo, hi), how many, their mean, what happened. */
export interface CalibrationBin {
  readonly lo: number;
  readonly hi: number;
  readonly count: number;
  readonly meanPredicted: number | null;
  readonly observed: number | null;
}

/** How a model did on the rows it was not fitted on (the holdout), and on those it was. */
export interface ModelMetrics {
  readonly datasetSchema: number;
  readonly seed: number;
  /** Rows in the dataset, rows trained on (a target set), and how those split. */
  readonly datasetRows: number;
  readonly count: number;
  readonly trainCount: number;
  readonly holdoutCount: number;
  readonly positives: number;
  /** On the holdout; null when it is empty or holds one label only (AUC). */
  readonly auc: number | null;
  readonly accuracy: number | null;
  readonly logLoss: number | null;
  readonly calibration: readonly CalibrationBin[];
  /** AUC on the rows it was fitted on, beside the holdout's, to show overfitting. */
  readonly trainAuc: number | null;
}

export interface Example {
  /** The decision it came from: the unit of the holdout split. */
  readonly group: string;
  readonly x: readonly number[];
  readonly y: 0 | 1;
}

/** The rows a model is trained on: eligible, with a target. */
export function examplesOf(rows: readonly DatasetRow[]): Example[] {
  return rows.flatMap((r) =>
    r.target === null || r.features === null
      ? []
      : [{ group: r.decisionId, x: vectorOf(r.features), y: r.target }],
  );
}

/** FNV-1a, 32 bits: a stable hash for the holdout split. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Is this decision in the holdout? The same for the same seed, whatever else is in the set. */
export const inHoldout = (group: string, seed: number, pct: number) =>
  fnv1a(`${seed}:${group}`) % 100 < pct;

const sigmoid = (z: number) =>
  z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));

/** The probability a model gives one input vector, in `FEATURES` order. */
export function predict(body: ModelBody, x: readonly number[]): number {
  let z = body.bias;
  for (let i = 0; i < body.weights.length; i++)
    z +=
      (body.weights[i] ?? 0) *
      (((x[i] ?? 0) - (body.means[i] ?? 0)) / (body.scales[i] ?? 1));
  return sigmoid(z);
}

/** Fit a model to these examples: standardise, then gradient descent from zero. */
export function fit(
  examples: readonly Example[],
  settings: TrainSettings = DEFAULT_TRAIN,
): ModelBody {
  const d = FEATURES.length;
  const n = Math.max(1, examples.length);
  const means = Array.from(
    { length: d },
    (_, i) => examples.reduce((s, e) => s + (e.x[i] ?? 0), 0) / n,
  );
  const scales = means.map((m, i) => {
    const v = examples.reduce((s, e) => s + ((e.x[i] ?? 0) - m) ** 2, 0) / n;
    const sd = Math.sqrt(v);
    return sd > 1e-9 ? sd : 1;
  });
  const data = examples.map((e) => ({
    y: e.y,
    x: e.x.map((v, i) => (v - (means[i] ?? 0)) / (scales[i] ?? 1)),
  }));
  let w = Array.from({ length: d }, () => 0);
  let b = 0;
  for (let epoch = 0; epoch < settings.epochs; epoch++) {
    const gw = w.map(() => 0);
    let gb = 0;
    for (const { x, y } of data) {
      const z = x.reduce((s, v, i) => s + (w[i] ?? 0) * v, b);
      const err = sigmoid(z) - y;
      x.forEach((v, i) => {
        gw[i] = (gw[i] ?? 0) + err * v;
      });
      gb += err;
    }
    w = w.map(
      (wi, i) =>
        wi - settings.learningRate * ((gw[i] ?? 0) / n + settings.l2 * wi),
    );
    b -= (settings.learningRate * gb) / n;
  }
  return { features: [...FEATURES], weights: w, bias: b, means, scales };
}

/**
 * The area under the ROC curve: the chance a random positive is ranked over a random negative, a
 * tie counting one half. Null with one label only.
 */
export function auc(scored: readonly { p: number; y: 0 | 1 }[]): number | null {
  const sorted = scored.toSorted((a, b) => a.p - b.p);
  const pos = sorted.filter((s) => s.y === 1).length;
  const neg = sorted.length - pos;
  if (pos === 0 || neg === 0) return null;
  let rankSum = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j]?.p === sorted[i]?.p) j++;
    const midRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (sorted[k]?.y === 1) rankSum += midRank;
    i = j;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Predictions in `bins` equal bins of [0, 1]: how many, their mean, the share that were 1. */
export function calibration(
  scored: readonly { p: number; y: 0 | 1 }[],
  bins = 5,
): CalibrationBin[] {
  return Array.from({ length: bins }, (_, b) => {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = scored.filter(
      (s) => s.p >= lo && (s.p < hi || (b === bins - 1 && s.p <= 1)),
    );
    const count = inBin.length;
    return {
      lo,
      hi,
      count,
      meanPredicted:
        count === 0 ? null : inBin.reduce((s, x) => s + x.p, 0) / count,
      observed:
        count === 0 ? null : inBin.filter((x) => x.y === 1).length / count,
    };
  });
}

/** Why a model was not trained. */
export type TrainRefusal = "no-training-rows" | "one-label";

/** Fit a model on the dataset's training rows, and measure it on the holdout. */
export function train(
  rows: readonly DatasetRow[],
  settings: TrainSettings = DEFAULT_TRAIN,
):
  | { ok: true; body: ModelBody; metrics: ModelMetrics }
  | { ok: false; reason: TrainRefusal; count: number } {
  const examples = examplesOf(rows);
  if (examples.length === 0)
    return { ok: false, reason: "no-training-rows", count: 0 };
  const positives = examples.filter((e) => e.y === 1).length;
  if (positives === 0 || positives === examples.length)
    return { ok: false, reason: "one-label", count: examples.length };
  const pct = Math.min(50, Math.max(0, settings.holdoutPct));
  const holdout = examples.filter((e) =>
    inHoldout(e.group, settings.seed, pct),
  );
  const trainSet = examples.filter(
    (e) => !inHoldout(e.group, settings.seed, pct),
  );
  const body = fit(trainSet.length > 0 ? trainSet : examples, settings);
  const score = (set: readonly Example[]) =>
    set.map((e) => ({ p: predict(body, e.x), y: e.y }));
  const held = score(holdout);
  const eps = 1e-12;
  return {
    ok: true,
    body,
    metrics: {
      datasetSchema: DATASET_SCHEMA,
      seed: settings.seed,
      datasetRows: rows.length,
      count: examples.length,
      trainCount: trainSet.length,
      holdoutCount: holdout.length,
      positives,
      auc: auc(held),
      accuracy:
        held.length === 0
          ? null
          : held.filter((s) => (s.p >= 0.5 ? 1 : 0) === s.y).length /
            held.length,
      logLoss:
        held.length === 0
          ? null
          : -held.reduce(
              (s, x) =>
                s +
                (x.y === 1
                  ? Math.log(Math.max(eps, x.p))
                  : Math.log(Math.max(eps, 1 - x.p))),
              0,
            ) / held.length,
      calibration: calibration(held),
      trainAuc: auc(score(trainSet)),
    },
  };
}

/** Does a model take the inputs this build computes? A model of another feature set does not. */
export const modelApplies = (body: ModelBody) =>
  body.features.length === FEATURES.length &&
  body.features.every((f, i) => f === FEATURES[i]) &&
  body.weights.length === FEATURES.length;

/** What the model would choose for a decision, and the probability it gives each eligible one. */
export interface LearnedChoice {
  readonly agentId: string;
  readonly score: number;
  readonly scores: Readonly<Record<string, number>>;
}

/**
 * The eligible candidate the model ranks first for a placed decision; null when the decision
 * placed nobody or the model does not apply. A tie goes to the formula's choice, then the lower
 * agent id. It never names a candidate that failed a filter.
 */
export function learnedChoice(
  decision: Decision,
  model: LearnedModel,
  atMs: number,
): LearnedChoice | null {
  if (decision.kind !== "placed" || !modelApplies(model.body)) return null;
  const records = recordedCandidates(decision.candidates);
  const pool = poolOf(records);
  const scores: Record<string, number> = {};
  let best: { agentId: string; score: number } | null = null;
  for (const record of records) {
    const f = featuresOf(record, {
      tierStep: decision.tier.step,
      atMs,
      pool,
    });
    if (f === null) continue;
    const p = predict(model.body, vectorOf(f));
    scores[record.agentId] = p;
    const better =
      best === null ||
      p > best.score ||
      (p === best.score &&
        best.agentId !== decision.chosen &&
        (record.agentId === decision.chosen || record.agentId < best.agentId));
    if (better) best = { agentId: record.agentId, score: p };
  }
  return best === null ? null : { ...best, scores };
}

/** The decision with the learned choice in place of the formula's; the rest is unchanged. */
export function withLearnedChoice(
  decision: Decision,
  choice: LearnedChoice,
): Decision {
  return decision.kind === "placed"
    ? { ...decision, chosen: choice.agentId }
    : decision;
}
