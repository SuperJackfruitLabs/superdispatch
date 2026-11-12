/**
 * Placement: for one ready card at one stage, which agent should take it, and why. Four steps,
 * each a pure function over its inputs: **filter** every candidate (a candidate that fails one
 * filter is rejected, with that filter's reason), **score** the ones left, **decide** on the best,
 * and **record** the decision with every candidate, its filter results and its score.
 *
 * No I/O here: no fetch, no clock, no store. The sources layer reads SuperPipeline, AgentPod and
 * Accounts and hands placement plain values; whoever calls `place` records and publishes what it
 * returns. `test/architecture.test.ts` refuses an import or a global that would break that.
 *
 * A skeleton: the types and their invariants. The filters and the score land with the first
 * placement; until then `place` decides nothing.
 */

/** Each filter a candidate passes through, and the reason code it rejects with. */
export const FILTERS = {
  /** The agent is on AgentPod's roster for the board. Others keep working by pull. */
  roster: "not-on-roster",
  /** The agent has the capability the stage asks for. */
  capability: "capability-missing",
  /** The agent's dispatch grant lets it take this card. */
  grant: "grant-denied",
  /** The agent's station is healthy. */
  health: "unhealthy",
  /** The agent is under its board's concurrency. */
  capacity: "at-capacity",
  /** The agent has no work in hand anywhere in the workspace: the workspace-wide cap. */
  idle: "not-idle",
} as const;

export type FilterName = keyof typeof FILTERS;

/** Why a candidate was rejected: one code per filter. */
export type RejectionReason = (typeof FILTERS)[FilterName];

/** Every rejection reason, in the order the filters are listed. */
export const REJECTION_REASONS: readonly RejectionReason[] =
  Object.values(FILTERS);

/** What one filter said about one candidate. A rejection always carries its filter's reason. */
export type FilterResult =
  | { readonly filter: FilterName; readonly passed: true }
  | {
      readonly filter: FilterName;
      readonly passed: false;
      readonly reason: RejectionReason;
    };

/** A filter's pass. */
export function passed(filter: FilterName): FilterResult {
  return { filter, passed: true };
}

/** A filter's rejection, with the reason that filter rejects with: the two cannot disagree. */
export function rejected(filter: FilterName): FilterResult {
  return { filter, passed: false, reason: FILTERS[filter] };
}

/** An agent considered for a card. */
export interface Candidate {
  /** The agent's id, as SuperPipeline and AgentPod name it. */
  readonly agentId: string;
}

/**
 * How a candidate that passed every filter ranks: its total (higher is better) and the terms it
 * was summed from, by name, so the record says what weighed.
 */
export interface Score {
  readonly total: number;
  readonly terms: Readonly<Record<string, number>>;
}

/**
 * One candidate as the decision records it. `score` is set only when every filter passed: a
 * rejected candidate is never scored.
 */
export interface CandidateRecord {
  readonly candidate: Candidate;
  readonly filters: readonly FilterResult[];
  readonly score: Score | null;
}

/** The card a decision is about. */
export interface CardRef {
  readonly boardId: string;
  readonly cardId: string;
  readonly stageKey: string;
}

/** Why no agent was chosen. */
export type NoDecisionReason =
  /** Nobody was considered. */
  | "no-candidates"
  /** Every candidate failed a filter. */
  | "none-eligible"
  /** This build does not place yet: the filters and the score are not written. */
  | "not-placing";

/**
 * What placement concluded for one card: an agent chosen, or none and why. Either way it carries
 * every candidate considered, so the decision explains itself.
 */
export type Decision =
  | {
      readonly kind: "placed";
      readonly card: CardRef;
      readonly chosen: string;
      readonly candidates: readonly CandidateRecord[];
    }
  | {
      readonly kind: "none";
      readonly card: CardRef;
      readonly reason: NoDecisionReason;
      readonly candidates: readonly CandidateRecord[];
    };

/** Everything placement needs for one card, already read. */
export interface PlacementInput {
  readonly card: CardRef;
  readonly candidates: readonly Candidate[];
}

/** Place one card. Decides nothing yet. */
export function place(input: PlacementInput): Decision {
  return {
    kind: "none",
    card: input.card,
    reason: "not-placing",
    candidates: [],
  };
}

/** Did a recorded candidate pass every filter it went through? */
export function isEligible(record: CandidateRecord): boolean {
  return (
    record.filters.length > 0 && record.filters.every((result) => result.passed)
  );
}

/**
 * Every invariant a decision breaks, one line each; empty when it holds:
 *
 * - each candidate appears once, and goes through each filter at most once;
 * - a rejection carries the reason its filter rejects with;
 * - a candidate is scored when, and only when, it passed every filter, and a score is finite;
 * - a chosen agent is one of the candidates, and an eligible one;
 * - "none-eligible" has candidates and none of them eligible, "no-candidates" has none.
 */
export function decisionProblems(decision: Decision): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const record of decision.candidates) {
    const id = record.candidate.agentId;
    if (seen.has(id)) problems.push(`${id} is a candidate twice`);
    seen.add(id);

    const filters = new Set<FilterName>();
    for (const result of record.filters) {
      if (filters.has(result.filter))
        problems.push(`${id} went through ${result.filter} twice`);
      filters.add(result.filter);
      if (!result.passed && result.reason !== FILTERS[result.filter])
        problems.push(
          `${id} was rejected by ${result.filter} as ${result.reason}, not ${FILTERS[result.filter]}`,
        );
    }

    const eligible = isEligible(record);
    if (eligible && record.score === null)
      problems.push(`${id} passed every filter and has no score`);
    if (!eligible && record.score !== null)
      problems.push(`${id} is scored without passing every filter`);
    if (record.score !== null && !scoreIsFinite(record.score))
      problems.push(`${id} has a score that is not a finite number`);
  }

  if (decision.kind === "placed") {
    const chosen = decision.candidates.find(
      (record) => record.candidate.agentId === decision.chosen,
    );
    if (chosen === undefined)
      problems.push(`the chosen ${decision.chosen} is not a candidate`);
    else if (!isEligible(chosen))
      problems.push(`the chosen ${decision.chosen} did not pass every filter`);
  } else if (decision.reason === "no-candidates") {
    if (decision.candidates.length > 0)
      problems.push("no-candidates, with candidates");
  } else if (decision.reason === "none-eligible") {
    if (decision.candidates.length === 0)
      problems.push("none-eligible, with no candidates");
    if (decision.candidates.some(isEligible))
      problems.push("none-eligible, with an eligible candidate");
  }
  return problems;
}

function scoreIsFinite(score: Score): boolean {
  return (
    Number.isFinite(score.total) &&
    Object.values(score.terms).every((term) => Number.isFinite(term))
  );
}
