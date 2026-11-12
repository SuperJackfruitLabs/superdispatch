/**
 * Placement: for one ready card at one stage, which agent should take it, and why. Four steps,
 * each a pure function over its inputs: **filter** every candidate (a candidate that fails a
 * filter is rejected, with that filter's reason), **score** the ones left, **decide** on the best,
 * and **record** the decision with every candidate, its filter results and its score.
 *
 * No I/O here: no fetch, no clock, no store. The sources layer reads SuperPipeline, AgentPod and
 * Accounts, the loop adds what the store remembers, and placement gets plain values, the time
 * among them; whoever calls `place` records what it returns. `test/architecture.test.ts` refuses
 * an import or a global that would break that.
 *
 * The policy (`POLICY`):
 *
 * - **Filters.** On AgentPod's roster for the board (an enabled bridge row); SuperPipeline's own
 *   verdict for this card (capability, grant, the board's concurrency for the agent, and any other
 *   reason it gives); the station ready to claim; **idle**, no work in hand on any board (the
 *   workspace-wide cap, and the reason a reservation is only ever made for an idle agent); and not
 *   **recently a no-show**: an agent whose last `NO_SHOW_LIMIT` reservations within
 *   `NO_SHOW_WINDOW_MS` lapsed unclaimed is shut out until the older of them ages out; not
 *   **holding another card** (one live hold per agent: an agent claims one card at a time, so a
 *   second hold could only lapse and count against it as a no-show); and not **passed over** for
 *   this card (its hold on this card already lapsed in the card's current ladder of tiers). An
 *   agent off the roster is recorded with its roster rejection only: it is outside the candidate
 *   set and keeps working by pull.
 * - **Score**, in order, each term breaking the previous one's ties: the agent's **success rate on
 *   this board** (holds it claimed, of holds that were settled, smoothed: `(claimed + 1) /
 *   (settled + 2)`), then **least recently used** (longest since its station last took work;
 *   never first). The agent id breaks a tie that is left, so the same inputs always give the same
 *   choice.
 * - **Tiers.** A card's holds form a ladder, one step per hold (SuperPipeline holds a card for one
 *   agent at a time). Step 1 is the **winner** tier, held for `winnerSeconds`; steps 2 to `topK`
 *   are the **runner-up** tier, each held for the best candidate not yet passed over, for
 *   `runnerUpSeconds`; after that the card is open to **any match**: nothing is held and pull
 *   decides. A runner-up step with nobody left to hold for opens the card at once. See `tierFor`.
 * - **Decide.** A card with fewer than `MIN_CANDIDATES` rostered candidates is not placed: with
 *   one agent there is no choice to make, and pull already gives it the card. Otherwise the best
 *   eligible candidate is chosen. When none is eligible only because the free ones are holding
 *   other cards, the card waits for a later pass (`waiting-on-holds`) rather than give up its
 *   tier; otherwise it is `none-eligible` in the winner tier and `any-match` after it.
 * - **Fairness across boards** (`fairOrder`): one sweep places the ready cards of every opted-in
 *   board in rounds, one card from each board a round, the longest-waiting first within a round,
 *   so a busy board cannot take every free agent before a quiet board's card is looked at.
 */

/** The name of the fixed policy below, recorded with every decision. */
export const POLICY = "idle-success-lru@2";

/** The fewest rostered candidates a card needs before it is placed. */
export const MIN_CANDIDATES = 2;

/** How many lapsed reservations within the window shut an agent out. */
export const NO_SHOW_LIMIT = 2;

/** The window lapsed reservations are counted in, and so the longest an agent is shut out. */
export const NO_SHOW_WINDOW_MS = 30 * 60 * 1000;

/**
 * The seconds-since-last-dispatch recorded for a station that never took work: about 31 years,
 * longer than any real gap, so it ranks first among the least recently used. A finite number,
 * because a score is.
 */
export const NEVER_DISPATCHED_SECONDS = 1_000_000_000;

/** Each filter a candidate passes through, and the reason code it rejects with. */
export const FILTERS = {
  /** The agent is on AgentPod's roster for the board. Others keep working by pull. */
  roster: "not-on-roster",
  /** The agent has the capability the stage asks for (SuperPipeline's `capability_mismatch`). */
  capability: "capability-missing",
  /** The card's dispatch grant covers the agent (SuperPipeline's `grant_denied`). */
  grant: "grant-denied",
  /**
   * SuperPipeline would let the agent claim the card, for every reason it gives that no other
   * filter here names (a reason added in a later SuperPipeline release among them).
   */
  claimable: "not-claimable",
  /** The agent's station is ready to claim, by the bridge's own readiness answer. */
  health: "unhealthy",
  /** The agent is under its board's concurrency (SuperPipeline's `concurrency_reached`). */
  capacity: "at-capacity",
  /** The agent has no work in hand anywhere in the workspace: the workspace-wide cap. */
  idle: "not-idle",
  /** The agent holds no other card now: one live hold per agent. */
  held: "holding-another",
  /** The agent has not let its recent reservations lapse unclaimed. */
  noShow: "recently-no-show",
  /** The agent's hold on this card has not already lapsed in the card's current ladder. */
  passedOver: "passed-over",
} as const;

/** SuperPipeline's per-agent claim reasons that a filter here names, by that filter. */
export const PIPELINE_REASONS: Readonly<Record<string, FilterName>> = {
  capability_mismatch: "capability",
  grant_denied: "grant",
  concurrency_reached: "capacity",
};

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
  /** The agent's id, as SuperPipeline names it (`agt_…`). */
  readonly agentId: string;
  /** The agent's principal, which joins SuperPipeline's agent to AgentPod's station. */
  readonly principalId?: string | null;
  /** The station it claims on, when it is on the roster. */
  readonly stationId?: string | null;
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
  /** Fewer than `MIN_CANDIDATES` candidates are on the roster: there is no choice to make. */
  | "one-candidate"
  /**
   * Nobody is eligible, but an agent not yet passed over fails only because it holds another
   * card: the card waits for a later pass, and the loop records nothing.
   */
  | "waiting-on-holds"
  /** The tiers are spent, or a runner-up step has nobody left: nothing is held, pull decides. */
  | "any-match";

/** The tiers of a card's ladder of holds. */
export const TIERS = ["winner", "runner-up", "any-match"] as const;
export type TierName = (typeof TIERS)[number];

/** How the ladder relaxes: how long each tier holds, and how many holds before any match. */
export interface TierSettings {
  /** Seconds the winner tier holds the card (step 1). */
  readonly winnerSeconds: number;
  /** Seconds each runner-up step holds the card (steps 2 to `topK`). */
  readonly runnerUpSeconds: number;
  /** The most holds a ladder makes, the winner's among them; then any match. At least 1. */
  readonly topK: number;
}

export const DEFAULT_TIERS: TierSettings = {
  winnerSeconds: 60,
  runnerUpSeconds: 30,
  topK: 3,
};

/** One step of a card's ladder: its tier, its number, and how long it holds (null: no hold). */
export interface Tier {
  readonly name: TierName;
  readonly step: number;
  readonly holdSeconds: number | null;
}

/**
 * The tier of ladder step `step` (1 first): the winner, then runner-ups up to `topK` holds, then
 * any match. A step below 1 is read as 1.
 */
export function tierFor(step: number, settings: TierSettings): Tier {
  const n = Math.max(1, Math.floor(step));
  if (n === 1 && settings.topK >= 1)
    return { name: "winner", step: n, holdSeconds: settings.winnerSeconds };
  if (n <= settings.topK)
    return {
      name: "runner-up",
      step: n,
      holdSeconds: settings.runnerUpSeconds,
    };
  return { name: "any-match", step: n, holdSeconds: null };
}

/**
 * Where a card is on its ladder: the agents whose holds on it lapsed (passed over, oldest first)
 * and so the step it is at. A new ladder starts when the card reaches a stage, or comes back
 * after a claim.
 */
export interface Ladder {
  readonly passedOver: readonly string[];
}

export const NEW_LADDER: Ladder = { passedOver: [] };

/**
 * What placement concluded for one card: an agent chosen, or none and why. Either way it carries
 * every candidate considered, so the decision explains itself.
 */
export type Decision =
  | {
      readonly kind: "placed";
      readonly card: CardRef;
      readonly chosen: string;
      readonly tier: Tier;
      readonly candidates: readonly CandidateRecord[];
    }
  | {
      readonly kind: "none";
      readonly card: CardRef;
      readonly reason: NoDecisionReason;
      readonly tier: Tier;
      readonly candidates: readonly CandidateRecord[];
    };

/** What is known of one agent for one card, already read. */
export interface CandidateFacts {
  readonly agentId: string;
  readonly principalId: string | null;
  /** SuperPipeline's eligibility read for this agent and this card. */
  readonly pipeline: {
    readonly eligible: boolean;
    readonly reasons: readonly string[];
  };
  /** The agent's bridge row on this board in AgentPod, or null when it has none. */
  readonly roster: {
    readonly stationId: string;
    readonly enabled: boolean;
    /** The bridge would claim on the station now. */
    readonly ready: boolean;
    /** The station has work in hand on some board. */
    readonly busy: boolean;
    /** When the station last took work, in ms since the epoch; null when it never has. */
    readonly lastDispatchedAtMs: number | null;
  } | null;
  /** What this service remembers of the agent on this board. */
  readonly history: {
    /** Holds for it that were settled: claimed by it, or lapsed unclaimed. */
    readonly settled: number;
    /** Of those, the ones it claimed. */
    readonly claimed: number;
    /** When each of its holds lapsed unclaimed, in ms since the epoch, newest first or not. */
    readonly noShowsAtMs: readonly number[];
  };
  /** Cards this service holds for the agent right now, on any board. */
  readonly holds: number;
}

/** Everything placement needs for one card, already read, with the time it is placed at. */
export interface PlacementInput {
  readonly card: CardRef;
  readonly nowMs: number;
  readonly candidates: readonly CandidateFacts[];
  /** The card's ladder so far; a new one when unset. */
  readonly ladder?: Ladder;
  /** How the ladder relaxes; `DEFAULT_TIERS` when unset. */
  readonly tiers?: TierSettings;
}

/** Every filter's result for one candidate. An agent off the roster goes through that one only. */
export function filter(
  facts: CandidateFacts,
  nowMs: number,
  passedOver = false,
): readonly FilterResult[] {
  const roster = facts.roster;
  if (roster === null || !roster.enabled) return [rejected("roster")];
  const named = new Set<FilterName>();
  let unnamed = false;
  for (const reason of facts.pipeline.reasons) {
    const filterName = PIPELINE_REASONS[reason];
    if (filterName === undefined) unnamed = true;
    else named.add(filterName);
  }
  // An agent SuperPipeline calls ineligible for no reason it lists is still not claimable.
  if (!facts.pipeline.eligible && facts.pipeline.reasons.length === 0)
    unnamed = true;
  const check = (name: FilterName, ok: boolean) =>
    ok ? passed(name) : rejected(name);
  return [
    passed("roster"),
    check("capability", !named.has("capability")),
    check("grant", !named.has("grant")),
    check("claimable", !unnamed),
    check("health", roster.ready),
    check("capacity", !named.has("capacity")),
    check("idle", !roster.busy),
    check("held", facts.holds === 0),
    check("noShow", !recentlyNoShow(facts.history.noShowsAtMs, nowMs)),
    check("passedOver", !passedOver),
  ];
}

/** Have `NO_SHOW_LIMIT` of these lapses happened within the window before `nowMs`? */
export function recentlyNoShow(
  noShowsAtMs: readonly number[],
  nowMs: number,
): boolean {
  const recent = noShowsAtMs.filter(
    (at) => at <= nowMs && nowMs - at < NO_SHOW_WINDOW_MS,
  );
  return recent.length >= NO_SHOW_LIMIT;
}

/** The terms an eligible candidate is ranked by, before its rank is known. */
export function scoreTerms(
  facts: CandidateFacts,
  nowMs: number,
): { successRate: number; sinceLastDispatchS: number } {
  const { settled, claimed } = facts.history;
  const last = facts.roster?.lastDispatchedAtMs ?? null;
  return {
    successRate: (claimed + 1) / (settled + 2),
    sinceLastDispatchS:
      last === null
        ? NEVER_DISPATCHED_SECONDS
        : Math.max(0, Math.floor((nowMs - last) / 1000)),
  };
}

type Terms = ReturnType<typeof scoreTerms>;

/** Which of two eligible candidates ranks first: negative when `a` does. */
export function compareTerms(
  a: { agentId: string; terms: Terms },
  b: { agentId: string; terms: Terms },
): number {
  return (
    b.terms.successRate - a.terms.successRate ||
    b.terms.sinceLastDispatchS - a.terms.sinceLastDispatchS ||
    (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)
  );
}

/**
 * Place one card at its ladder's step: filter every candidate, score the eligible ones and choose,
 * or open the card to any match once the tiers are spent. Each eligible
 * candidate's `total` is how many eligible candidates it outranks plus one, so the best has the
 * highest total and the record reads as a ranking; its terms say why.
 */
export function place(input: PlacementInput): Decision {
  const seen = new Set<string>();
  const candidates = input.candidates.filter((c) => {
    if (seen.has(c.agentId)) return false;
    seen.add(c.agentId);
    return true;
  });
  const ladder = input.ladder ?? NEW_LADDER;
  const passedOver = new Set(ladder.passedOver);
  const tier = tierFor(passedOver.size + 1, input.tiers ?? DEFAULT_TIERS);
  const none = (
    reason: NoDecisionReason,
    records: readonly CandidateRecord[],
    at: Tier = tier,
  ): Decision => ({
    kind: "none",
    card: input.card,
    reason,
    tier: at,
    candidates: records,
  });
  if (candidates.length === 0) return none("no-candidates", []);

  const filtered = candidates.map((facts) => ({
    facts,
    filters: filter(facts, input.nowMs, passedOver.has(facts.agentId)),
  }));
  const eligible = filtered
    .filter(({ filters }) => filters.every((r) => r.passed))
    .map(({ facts }) => ({
      agentId: facts.agentId,
      terms: scoreTerms(facts, input.nowMs),
    }))
    .sort(compareTerms);
  const scores = new Map<string, Score>(
    eligible.map((e, rank) => [
      e.agentId,
      { total: eligible.length - rank, terms: { ...e.terms } },
    ]),
  );

  const records: CandidateRecord[] = filtered.map(({ facts, filters }) => ({
    candidate: {
      agentId: facts.agentId,
      principalId: facts.principalId,
      stationId: facts.roster?.stationId ?? null,
    },
    filters,
    score: scores.get(facts.agentId) ?? null,
  }));

  const rostered = filtered.filter(({ filters }) =>
    filters.some((r) => r.filter === "roster" && r.passed),
  ).length;
  if (rostered > 0 && rostered < MIN_CANDIDATES)
    return none("one-candidate", records);
  if (tier.name === "any-match") return none("any-match", records);
  const best = eligible[0];
  if (best === undefined) {
    // Free agents exist but hold other cards for now: wait, keeping the tier, rather than give up.
    if (filtered.some(({ filters }) => onlyHeld(filters)))
      return none("waiting-on-holds", records);
    if (tier.name === "runner-up")
      return none("any-match", records, {
        ...tier,
        name: "any-match",
        holdSeconds: null,
      });
    return none("none-eligible", records);
  }
  return {
    kind: "placed",
    card: input.card,
    chosen: best.agentId,
    tier,
    candidates: records,
  };
}

/** Did a candidate fail the one-hold filter and nothing else? */
function onlyHeld(filters: readonly FilterResult[]): boolean {
  const failed = filters.filter((r) => !r.passed);
  return failed.length === 1 && failed[0]?.filter === "held";
}

/** A card waiting in a board's queue, with when it has waited since. */
export interface Queued<T> {
  readonly boardId: string;
  readonly item: T;
}

/**
 * Fairness across boards: the order one sweep places every board's ready cards in. Each board's
 * queue keeps its own order (best first); the sweep takes them in rounds, one card from each
 * board that has one left, and within a round the card that has waited longest goes first (then
 * the lower board id). A busy board and a quiet one so get a card each in the first round, and the
 * busy board takes the free agents left after that.
 */
export function fairOrder<T>(
  queues: readonly {
    readonly boardId: string;
    readonly items: readonly T[];
  }[],
  waitingSinceMs: (item: T) => number,
): Queued<T>[] {
  const out: Queued<T>[] = [];
  const longest = Math.max(0, ...queues.map((q) => q.items.length));
  for (let round = 0; round < longest; round++) {
    const heads: Queued<T>[] = [];
    for (const q of queues) {
      const item = q.items[round];
      if (item !== undefined) heads.push({ boardId: q.boardId, item });
    }
    heads.sort(
      (a, b) =>
        waitingSinceMs(a.item) - waitingSinceMs(b.item) ||
        (a.boardId < b.boardId ? -1 : a.boardId > b.boardId ? 1 : 0),
    );
    out.push(...heads);
  }
  return out;
}

/** Each board's queue in turn, every card of one board before the next: no fairness. */
export function boardOrder<T>(
  queues: readonly {
    readonly boardId: string;
    readonly items: readonly T[];
  }[],
): Queued<T>[] {
  return queues.flatMap((q) =>
    q.items.map((item) => ({ boardId: q.boardId, item })),
  );
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
 * - "none-eligible" has candidates and none of them eligible, "no-candidates" has none;
 * - "one-candidate" has candidates, and fewer than `MIN_CANDIDATES` of them on the roster.
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

  const tier = decision.tier;
  if (decision.kind === "placed" && tier.name === "any-match")
    problems.push("placed in the any-match tier, which holds nothing");
  if (decision.kind === "placed" && tier.holdSeconds === null)
    problems.push("placed with no hold");
  if (
    decision.kind === "none" &&
    decision.reason === "any-match" &&
    tier.name !== "any-match"
  )
    problems.push(`any-match, in the ${tier.name} tier`);

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
  } else if (decision.reason === "one-candidate") {
    const rostered = decision.candidates.filter((record) =>
      record.filters.some((r) => r.filter === "roster" && r.passed),
    ).length;
    if (rostered === 0 || rostered >= MIN_CANDIDATES)
      problems.push(`one-candidate, with ${rostered} on the roster`);
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
