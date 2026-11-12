/**
 * Shadow mode, and the gate a learned model must pass before it places anything.
 *
 * In shadow, every placed decision also records what the latest model would have chosen and its
 * score, and the formula's choice is what is held. Once those decisions settle, `shadowReport`
 * compares the two choices against what happened:
 *
 * - where they **agree**, both had the outcome the card had;
 * - where they **disagree**, the formula's choice had its hold; the model's choice is credited only
 *   when it claimed the card anyway (after the hold lapsed, or in the any-match tier). Otherwise
 *   what it would have done is unknown, and is counted as a miss.
 *
 * The model's rate is so a lower bound, and the formula's is what it did. Only decisions where the
 * formula's choice had its chance are counted (`claimed`, `claimed-by-other`, `expired`); one a
 * person moved, or whose hold was refused, says nothing about either.
 *
 * The gate (`learnedGate`) lets a model place only when it was trained on at least `minRows` rows,
 * has at least `minShadow` such decisions in shadow, and its lower bound beats the formula's rate
 * by at least `marginPct` points. Decisions it placed itself (`acted`) are never its evidence.
 */
import { POLICY } from "./index.ts";

/** A shadow row with the outcome of its decision, as the store reads it. */
export interface ShadowOutcome {
  readonly formulaAgent: string;
  readonly learnedAgent: string;
  readonly acted: boolean;
  readonly outcome: string | null;
  readonly outcomeBy: string | null;
}

export interface ShadowReport {
  /** Shadow rows recorded (acted ones among them). */
  readonly recorded: number;
  /** Rows where the model placed the card itself: not evidence. */
  readonly acted: number;
  /** Shadow-only rows whose decision is settled. */
  readonly settled: number;
  /** Of those, the ones where the formula's choice had its chance. */
  readonly informative: number;
  readonly agree: number;
  readonly disagree: number;
  readonly formula: { readonly claimed: number; readonly rate: number | null };
  /** The model's claims: on agreement, and where it disagreed and its choice claimed anyway. */
  readonly learned: {
    readonly claimed: number;
    readonly rate: number | null;
  };
  /** Where they disagreed: who turned out right, or neither as far as is known. */
  readonly disagreements: {
    readonly formulaRight: number;
    readonly learnedRight: number;
    readonly unknown: number;
  };
  /** The model's rate less the formula's, in points; null with nothing informative. */
  readonly liftPct: number | null;
}

const INFORMATIVE = new Set(["claimed", "claimed-by-other", "expired"]);

export function shadowReport(rows: readonly ShadowOutcome[]): ShadowReport {
  let acted = 0;
  let settled = 0;
  let informative = 0;
  let agree = 0;
  let formulaClaimed = 0;
  let learnedClaimed = 0;
  let formulaRight = 0;
  let learnedRight = 0;
  let unknown = 0;
  for (const r of rows) {
    if (r.acted) {
      acted++;
      continue;
    }
    if (r.outcome === null) continue;
    settled++;
    if (!INFORMATIVE.has(r.outcome)) continue;
    informative++;
    const formulaWon = r.outcome === "claimed";
    if (formulaWon) formulaClaimed++;
    if (r.learnedAgent === r.formulaAgent) {
      agree++;
      if (formulaWon) learnedClaimed++;
      continue;
    }
    if (formulaWon) formulaRight++;
    else if (
      r.outcome === "claimed-by-other" &&
      r.outcomeBy === r.learnedAgent
    ) {
      learnedRight++;
      learnedClaimed++;
    } else unknown++;
  }
  const rate = (n: number) => (informative === 0 ? null : n / informative);
  const f = rate(formulaClaimed);
  const l = rate(learnedClaimed);
  return {
    recorded: rows.length,
    acted,
    settled,
    informative,
    agree,
    disagree: informative - agree,
    formula: { claimed: formulaClaimed, rate: f },
    learned: { claimed: learnedClaimed, rate: l },
    disagreements: { formulaRight, learnedRight, unknown },
    liftPct: f === null || l === null ? null : (l - f) * 100,
  };
}

export interface GateSettings {
  /** The fewest training rows a model needs. */
  readonly minRows: number;
  /** The fewest informative shadow decisions it needs. */
  readonly minShadow: number;
  /** How many points its lower bound must beat the formula's rate by. */
  readonly marginPct: number;
}

export type GateRefusal =
  | "no-model"
  | "features-changed"
  | "too-few-rows"
  | "too-few-shadow"
  | "no-lift";

/** May this model place cards? The first reason it may not, or yes. */
export function learnedGate(
  model: { rows: number; applies: boolean } | null,
  report: ShadowReport | null,
  settings: GateSettings,
): { use: true } | { use: false; reason: GateRefusal } {
  if (model === null) return { use: false, reason: "no-model" };
  if (!model.applies) return { use: false, reason: "features-changed" };
  if (model.rows < settings.minRows)
    return { use: false, reason: "too-few-rows" };
  if (report === null || report.informative < settings.minShadow)
    return { use: false, reason: "too-few-shadow" };
  if (report.liftPct === null || report.liftPct < settings.marginPct)
    return { use: false, reason: "no-lift" };
  return { use: true };
}

/** The policy a decision the model placed is recorded under. */
export const learnedPolicy = (version: number) =>
  `${POLICY}+learned:v${version}`;
