/**
 * The labelled dataset: every settled decision, one row per candidate, with what placement knew
 * of it (its filter results, its score terms, its stage history, the tier, the board, the stage,
 * the capability asked for, the hour and how busy the pool was) and what became of the card. The
 * formula placement ranks by is one way to read these rows; the rows are the asset, and a learned
 * scorer (`learned.ts`) is fitted on them.
 *
 * Pure, like the rest of placement: decisions come in as plain rows, rows go out.
 *
 * **Labels** (`LABELS`), from the candidate's side of the decision's outcome:
 *
 * - `won-claimed`: it was chosen and it claimed the card;
 * - `won-expired`: it was chosen and its hold lapsed unclaimed (a no-show);
 * - `won-claimed-by-other`: it was chosen and somebody else claimed the card;
 * - `lost-claimed`: it was not chosen (or nobody was, in the any-match tier) and it claimed the card;
 * - `lost`: it was not chosen and did not claim the card;
 * - `void`: the outcome says nothing about any agent: a person moved the card (`superseded`), or
 *   SuperPipeline refused the hold (`not-reserved`).
 *
 * **The target** (`target`), what the learned scorer predicts: 1 when the candidate claimed the
 * card, 0 when it was offered the card and did not claim it, null when the row is not trained on.
 * A `lost` row is null: a candidate that was never offered the card says nothing about whether it
 * would have taken it, and training it as a 0 would only teach the model to copy the formula. An
 * ineligible candidate is null too: the scorer only ever ranks eligible ones.
 *
 * Whether the claimed run then succeeded is SuperWitness's to say, and is not joined here yet: the
 * target is the claim.
 */
import { NEVER_DISPATCHED_SECONDS } from "./index.ts";

/** The shape of a dataset row. A change to a row's fields or their meaning raises it. */
export const DATASET_SCHEMA = 1;

export const LABELS = [
  "won-claimed",
  "won-expired",
  "won-claimed-by-other",
  "lost-claimed",
  "lost",
  "void",
] as const;
export type Label = (typeof LABELS)[number];

/** The model's inputs, in order. A change here is a new feature set: older models stop applying. */
export const FEATURES = [
  /** The candidate's record at this stage (SuperWitness), or one half when it was not weighed. */
  "stageRecord",
  /** 1 when the stage record weighed in the decision. */
  "hasStageRecord",
  /** How many of its runs at this stage were read, as log(1 + runs). */
  "stageRuns",
  /** Its smoothed success rate on this board, as the formula weighs it. */
  "successRate",
  /** Seconds since its station last took work, as log(1 + s). */
  "recency",
  /** 1 when its station never took work. */
  "neverDispatched",
  /** 1 when it claims with its own token rather than from the board's roster. */
  "direct",
  /** The step on the card's ladder of holds, 1 first. */
  "tierStep",
  /** The hour of day the decision was made (UTC), as a point on a circle. */
  "hourSin",
  "hourCos",
  /** How many candidates were eligible, as log(1 + n): how contested the card was. */
  "eligibleCandidates",
  /** The share of candidates in the set that failed only for their load: how busy the pool was. */
  "poolBusy",
] as const;
export type FeatureName = (typeof FEATURES)[number];

/** A recorded candidate, read back loosely: the fields the dataset needs. */
export interface RecordedCandidate {
  readonly agentId: string;
  readonly source: "roster" | "direct" | null;
  readonly filters: readonly {
    readonly filter: string;
    readonly passed: boolean;
    readonly reason?: string;
  }[];
  readonly score: {
    readonly total: number;
    readonly terms: Readonly<Record<string, number>>;
  } | null;
  readonly stageHistory: Readonly<Record<string, number>> | null;
}

/** A settled decision as the dataset reads it: the store's row, in plain fields. */
export interface SettledDecision {
  readonly id: string;
  readonly boardId: string;
  readonly cardId: string;
  readonly stageKey: string;
  readonly policy: string;
  readonly chosenAgent: string | null;
  readonly candidates: unknown;
  readonly tier: string | null;
  readonly tierStep: number | null;
  readonly requires?: unknown;
  readonly outcome: string | null;
  readonly outcomeBy: string | null;
  readonly outcomeAt: string | null;
  readonly createdAt: string;
}

/** How busy the candidate pool was when the decision was made. */
export interface Pool {
  /** Candidates considered. */
  readonly candidates: number;
  /** Of those, the ones in the candidate set (the roster filter passed). */
  readonly inSet: number;
  /** Of those, the ones that passed every filter. */
  readonly eligible: number;
  /** Of those in the set, the ones that failed only for their load. */
  readonly busy: number;
}

export interface DatasetRow {
  readonly schema: typeof DATASET_SCHEMA;
  readonly decisionId: string;
  readonly boardId: string;
  readonly cardId: string;
  readonly stageKey: string;
  readonly capability: { all: string[]; any: string[] } | null;
  /** The placement policy that made the decision. */
  readonly policy: string;
  readonly tier: string | null;
  readonly tierStep: number | null;
  readonly createdAt: string;
  /** The hour of day it was made, UTC, 0 to 23. */
  readonly hour: number;
  readonly outcome: string;
  readonly outcomeBy: string | null;
  readonly outcomeAt: string | null;
  readonly agentId: string;
  readonly source: "roster" | "direct" | null;
  readonly chosen: boolean;
  readonly eligible: boolean;
  /** Each filter it went through: `true` when it passed, the reason code when it rejected. */
  readonly filters: Readonly<Record<string, true | string>>;
  readonly score: RecordedCandidate["score"];
  readonly stageHistory: RecordedCandidate["stageHistory"];
  readonly pool: Pool;
  readonly label: Label;
  readonly target: 0 | 1 | null;
  /** The model's inputs (`FEATURES`); null for a candidate that was not eligible. */
  readonly features: Readonly<Record<FeatureName, number>> | null;
}

/** A JSON object, read as one. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Recorded candidates, read loosely: an entry without an agent id or filters is skipped. */
export function recordedCandidates(json: unknown): RecordedCandidate[] {
  if (!Array.isArray(json)) return [];
  const list: unknown[] = json;
  return list.flatMap((r): RecordedCandidate[] => {
    if (!isRecord(r)) return [];
    const c = r.candidate;
    if (!isRecord(c) || typeof c.agentId !== "string") return [];
    const rawFilters: unknown = r.filters;
    if (!Array.isArray(rawFilters)) return [];
    const filterList: unknown[] = rawFilters;
    const filters = filterList.flatMap((f) => {
      if (!isRecord(f)) return [];
      const { filter, passed, reason } = f;
      if (typeof filter !== "string" || typeof passed !== "boolean") return [];
      return [
        {
          filter,
          passed,
          ...(typeof reason === "string" ? { reason } : {}),
        },
      ];
    });
    return [
      {
        agentId: c.agentId,
        source:
          c.source === "roster" || c.source === "direct" ? c.source : null,
        filters,
        score: scoreOf(r.score),
        stageHistory: numbersOf(r.stageHistory),
      },
    ];
  });
}

function scoreOf(json: unknown): RecordedCandidate["score"] {
  if (!isRecord(json)) return null;
  const { total, terms } = json;
  if (typeof total !== "number") return null;
  return { total, terms: numbersOf(terms) ?? {} };
}

function numbersOf(json: unknown): Record<string, number> | null {
  if (!isRecord(json)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(json))
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}

const LOAD_FILTERS = new Set(["capacity", "idle", "held", "health"]);

const inSet = (c: RecordedCandidate) =>
  c.filters.some((f) => f.filter === "roster" && f.passed);

/** Did a recorded candidate pass every filter it went through, and get a score? */
export const eligibleRecord = (c: RecordedCandidate) =>
  c.filters.length > 0 && c.filters.every((f) => f.passed) && c.score !== null;

/** How busy the pool was, from the candidates' records. */
export function poolOf(candidates: readonly RecordedCandidate[]): Pool {
  const set = candidates.filter(inSet);
  return {
    candidates: candidates.length,
    inSet: set.length,
    eligible: candidates.filter(eligibleRecord).length,
    busy: set.filter((c) => {
      const failed = c.filters.filter((f) => !f.passed);
      return (
        failed.length > 0 && failed.every((f) => LOAD_FILTERS.has(f.filter))
      );
    }).length,
  };
}

/** The UTC hour of a time in ms since the epoch. */
export const hourOf = (atMs: number) =>
  ((Math.floor(atMs / 3_600_000) % 24) + 24) % 24;

/**
 * One candidate's inputs to the model, from its record and its decision's context. Null when it
 * was not eligible: the model only ranks the eligible.
 */
export function featuresOf(
  candidate: RecordedCandidate,
  context: { tierStep: number | null; atMs: number; pool: Pool },
): Record<FeatureName, number> | null {
  if (!eligibleRecord(candidate) || candidate.score === null) return null;
  const terms = candidate.score.terms;
  const since = terms.sinceLastDispatchS ?? NEVER_DISPATCHED_SECONDS;
  const hour = hourOf(context.atMs);
  const angle = (2 * Math.PI * hour) / 24;
  const { pool } = context;
  return {
    stageRecord: terms.stageRecord ?? 0.5,
    hasStageRecord: terms.stageRecord === undefined ? 0 : 1,
    stageRuns: Math.log1p(Math.max(0, candidate.stageHistory?.runs ?? 0)),
    successRate: terms.successRate ?? 0.5,
    recency: Math.log1p(Math.max(0, since)),
    neverDispatched: since >= NEVER_DISPATCHED_SECONDS ? 1 : 0,
    direct: candidate.source === "direct" ? 1 : 0,
    tierStep: context.tierStep ?? 1,
    hourSin: Math.sin(angle),
    hourCos: Math.cos(angle),
    eligibleCandidates: Math.log1p(pool.eligible),
    poolBusy: pool.inSet === 0 ? 0 : pool.busy / pool.inSet,
  };
}

/** The features in `FEATURES` order. */
export const vectorOf = (f: Readonly<Record<FeatureName, number>>): number[] =>
  FEATURES.map((name) => f[name]);

/** A candidate's label, from whether it was chosen and what became of the card. */
export function labelOf(
  outcome: string,
  outcomeBy: string | null,
  agentId: string,
  chosen: boolean,
): Label {
  const claimedIt =
    (outcome === "claimed" || outcome === "claimed-by-other") &&
    outcomeBy === agentId;
  if (outcome !== "claimed" && outcome !== "claimed-by-other") {
    if (outcome === "expired") return chosen ? "won-expired" : "lost";
    return "void";
  }
  if (chosen) return claimedIt ? "won-claimed" : "won-claimed-by-other";
  return claimedIt ? "lost-claimed" : "lost";
}

/** What a label trains as: 1 claimed, 0 offered and not claimed, null not trained on. */
export function targetOf(label: Label, eligible: boolean): 0 | 1 | null {
  if (!eligible) return null;
  if (label === "won-claimed" || label === "lost-claimed") return 1;
  if (label === "won-expired" || label === "won-claimed-by-other") return 0;
  return null;
}

function capabilityOf(json: unknown): DatasetRow["capability"] {
  if (!isRecord(json)) return null;
  const { all, any } = json;
  return { all: strings(all), any: strings(any) };
}

/** Every candidate of every settled decision, as dataset rows, in the decisions' order. */
export function datasetRows(
  decisions: readonly SettledDecision[],
): DatasetRow[] {
  const rows: DatasetRow[] = [];
  for (const d of decisions) {
    if (d.outcome === null) continue;
    const atMs = Date.parse(d.createdAt);
    if (!Number.isFinite(atMs)) continue;
    const candidates = recordedCandidates(d.candidates);
    const pool = poolOf(candidates);
    const capability = capabilityOf(d.requires);
    for (const c of candidates) {
      const chosen = d.chosenAgent !== null && c.agentId === d.chosenAgent;
      const eligible = eligibleRecord(c);
      const label = labelOf(d.outcome, d.outcomeBy, c.agentId, chosen);
      rows.push({
        schema: DATASET_SCHEMA,
        decisionId: d.id,
        boardId: d.boardId,
        cardId: d.cardId,
        stageKey: d.stageKey,
        capability,
        policy: d.policy,
        tier: d.tier,
        tierStep: d.tierStep,
        createdAt: d.createdAt,
        hour: hourOf(atMs),
        outcome: d.outcome,
        outcomeBy: d.outcomeBy,
        outcomeAt: d.outcomeAt,
        agentId: c.agentId,
        source: c.source,
        chosen,
        eligible,
        filters: Object.fromEntries(
          c.filters.map((f) => [f.filter, f.passed ? true : (f.reason ?? "")]),
        ),
        score: c.score,
        stageHistory: c.stageHistory,
        pool,
        label,
        target: targetOf(label, eligible),
        features: featuresOf(c, { tierStep: d.tierStep, atMs, pool }),
      });
    }
  }
  return rows;
}
