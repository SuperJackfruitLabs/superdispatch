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
 * - **The candidate set** (`CANDIDATE_SETS`, the `candidates` setting). `roster`, the default: the
 *   agents on AgentPod's roster for the board (an enabled bridge row). `all`: those, and every
 *   agent that claims with its own token and has no bridge row on the board, once SuperPipeline
 *   reports its load and health (`directLoad`). An agent with a disabled bridge row stays out
 *   either way: a person turned it off on this board. Every candidate record says which it was
 *   (`source`: `roster` or `direct`).
 * - **Filters.** In the candidate set (the `roster` filter); SuperPipeline's own verdict for this
 *   card (capability, grant, the board's concurrency for the agent, and any other reason it gives);
 *   the **station filters**, only when the card's stage states a `placement` and AgentPod's
 *   capability registry was read (isolation, model, tools, credentials; `requirements.ts`);
 *   the workspace's **dispatch policy** in Accounts, when it is asked (`policy`, from the loop: the
 *   answer for the agent at this board stage, with its per-agent limits already applied; unasked,
 *   the filter passes, as before policy existed);
 *   **healthy** and **idle** by the agent's load in the shared shape (`AgentLoad`, whichever source
 *   reported it): healthy, and less work in hand than its capacity (for a rostered agent, no work
 *   in hand on any board: the workspace-wide cap, and the reason a reservation is only ever made
 *   for an idle agent); and not
 *   **recently a no-show**: an agent whose last `NO_SHOW_LIMIT` reservations within
 *   `NO_SHOW_WINDOW_MS` lapsed unclaimed is shut out until the older of them ages out; not
 *   **holding another card** (one live hold per agent: an agent claims one card at a time, so a
 *   second hold could only lapse and count against it as a no-show); and not **passed over** for
 *   this card (its hold on this card already lapsed in the card's current ladder of tiers). An
 *   agent off the roster is recorded with its roster rejection only: it is outside the candidate
 *   set and keeps working by pull.
 * - **Score**, in order, each term breaking the previous one's ties: the agent's **record at this
 *   stage** (`stageRecord`, from SuperWitness: how its finished runs at this board stage turned
 *   out and how they were judged; see `stageHistory`), then its **success rate on this board**
 *   (holds it claimed, of holds that were settled, smoothed: `(claimed + 1) / (settled + 2)`),
 *   then **least recently used** (longest since its station last took work; never first). The
 *   agent id breaks a tie that is left, so the same inputs always give the same choice. When the
 *   stage's history could not be read for every eligible candidate, the record term is left out
 *   for all of them and the order is the board's own, as before SuperWitness was read.
 * - **Tiers.** A card's holds form a ladder, one step per hold (SuperPipeline holds a card for one
 *   agent at a time). Step 1 is the **winner** tier, held for `winnerSeconds`; steps 2 to `topK`
 *   are the **runner-up** tier, each held for the best candidate not yet passed over, for
 *   `runnerUpSeconds`; after that the card is open to **any match**: nothing is held and pull
 *   decides. A runner-up step with nobody left to hold for opens the card at once. See `tierFor`.
 * - **Decide.** A card with fewer than `MIN_CANDIDATES` rostered candidates is not placed: with
 *   one agent there is no choice to make, and pull already gives it the card. Otherwise the best
 *   eligible candidate is chosen. When none is eligible only because the free ones are holding
 *   other cards, the card waits for a later pass (`waiting-on-holds`) rather than give up its
 *   tier, and likewise when a candidate fails only for its load: work in hand, its concurrency,
 *   its station busy (`waiting-on-load`); otherwise it is `none-eligible` in the winner tier and `any-match` after it.
 * - **Fairness across boards** (`fairOrder`): one sweep places the ready cards of every opted-in
 *   board in rounds, one card from each board a round, the longest-waiting first within a round,
 *   so a busy board cannot take every free agent before a quiet board's card is looked at.
 */

import {
  CANDIDATE_SETS,
  DEFAULT_CANDIDATE_SET,
  type CandidateSet,
} from "../config.ts";
import {
  isIdle,
  type AgentLoad,
  type LoadSource,
  type StageNeeds,
  type StationCaps,
} from "../sources/index.ts";
import { DEFAULT_MIN_PROOF, type Proof } from "../config.ts";
import { checkNeeds, type NeedName } from "./requirements.ts";

export { CANDIDATE_SETS, DEFAULT_CANDIDATE_SET, type CandidateSet };

/** The name of the fixed policy below, recorded with every decision. */
export const POLICY = "idle-stage-success-lru@3";

/** The fewest candidates in the set a card needs before it is placed. */
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

/**
 * How a stage's history weighs: each run counts for less the older it is, halving every
 * `halfLifeMs`, and a rate is read from at least `minSample` runs, or is the neutral one half.
 */
export interface HistorySettings {
  readonly halfLifeMs: number;
  readonly minSample: number;
}

export const DEFAULT_HISTORY: HistorySettings = {
  halfLifeMs: 7 * 24 * 60 * 60 * 1000,
  minSample: 3,
};

/** One finished run of the candidate's at this board stage, as SuperWitness reported it. */
export interface StageRun {
  /** When it ended, in ms since the epoch. */
  readonly atMs: number;
  readonly succeeded: boolean;
  /** The newest verdict's pass mark from 0 to 1; null with none. */
  readonly verdict: number | null;
}

/**
 * A candidate's history at this stage, as the decision records it: what was read and what it
 * came to. `outcomeRate` and `verdictRate` are one half below `minSample`; `stageRecord`, the
 * term the candidate is ranked by, is their mean.
 */
export interface StageHistory {
  /** Finished runs read. */
  readonly runs: number;
  /** Of those, the ones that succeeded. */
  readonly succeeded: number;
  /** Runs carrying a verdict pass mark. */
  readonly verdicts: number;
  /** The sum of those marks. */
  readonly passes: number;
  /** The runs' summed recency weight. */
  readonly weight: number;
  readonly outcomeRate: number;
  readonly verdictRate: number;
  readonly stageRecord: number;
}

/**
 * A candidate's record at this stage. Each run weighs `0.5 ^ (age / halfLife)` (a run from the
 * future weighs 1). The outcome rate is the weighted share that succeeded and the verdict rate
 * the weighted mean pass mark, each smoothed toward one half as `(Σ w·x + 1) / (Σ w + 2)`, and
 * each exactly one half when fewer than `minSample` runs feed it, so a new agent is neither
 * starved nor favoured. The record is the mean of the two.
 */
export function stageHistory(
  runs: readonly StageRun[],
  nowMs: number,
  settings: HistorySettings = DEFAULT_HISTORY,
): StageHistory {
  let weight = 0;
  let won = 0;
  let succeeded = 0;
  let verdicts = 0;
  let passes = 0;
  let verdictWeight = 0;
  let verdictWon = 0;
  for (const run of runs) {
    const age = Math.max(0, nowMs - run.atMs);
    const w = Math.pow(0.5, age / settings.halfLifeMs);
    weight += w;
    if (run.succeeded) {
      won += w;
      succeeded++;
    }
    if (run.verdict !== null) {
      verdicts++;
      passes += run.verdict;
      verdictWeight += w;
      verdictWon += w * run.verdict;
    }
  }
  const outcomeRate =
    runs.length < settings.minSample ? 0.5 : (won + 1) / (weight + 2);
  const verdictRate =
    verdicts < settings.minSample
      ? 0.5
      : (verdictWon + 1) / (verdictWeight + 2);
  return {
    runs: runs.length,
    succeeded,
    verdicts,
    passes,
    weight,
    outcomeRate,
    verdictRate,
    stageRecord: (outcomeRate + verdictRate) / 2,
  };
}

/** Each filter a candidate passes through, and the reason code it rejects with. */
export const FILTERS = {
  /**
   * The agent is in the candidate set: on AgentPod's roster for the board, or (when the set is
   * `all`) claiming with its own token and reporting its load. Others keep working by pull.
   */
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
  /**
   * The station filters, each only when the card's stage states it in its `placement`
   * (`requirements.ts`), against AgentPod's capability registry: isolated at least as strongly as
   * asked, running one of the models asked for, holding every tool and reaching every credential
   * name asked for.
   */
  isolation: "isolation-too-weak",
  model: "model-mismatch",
  tools: "tool-missing",
  credentials: "credential-missing",
  /**
   * The workspace's dispatch policy lets the agent take this work (Accounts' decision, or the
   * loop's when Accounts could not be asked, or one of the policy's limits holds the agent). It
   * only narrows: the grant is SuperPipeline's filter above, and policy never widens it.
   */
  policy: "policy-denied",
  /** The agent is healthy by its load (`AgentLoad.healthy`): ready to take a card held for it. */
  health: "unhealthy",
  /** The agent is under its board's concurrency (SuperPipeline's `concurrency_reached`). */
  capacity: "at-capacity",
  /** The agent has less in hand than its capacity anywhere in the workspace (`isIdle`). */
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
      /** A station filter's rejection: what the station lacks, in the stage's words. */
      readonly missing?: readonly string[];
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
  /** Where its load came from: a bridge row on the roster, or its own token (`direct`). */
  readonly source?: LoadSource;
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
  /**
   * Set only for an agent off the roster: whether it has the capability the lane asks for, by
   * SuperPipeline's verdict (no `capability_mismatch`). It is not a filter: it says whether adding
   * the agent to the board's roster would give the lane another candidate, which is what a roster
   * suggestion (`suggest`) proposes.
   */
  readonly capable?: boolean;
  /** The candidate's history at this stage; null when SuperWitness's was not read. */
  readonly stageHistory?: StageHistory | null;
  /** The dispatch policy's verdict, when it was asked. */
  readonly policy?: PolicyVerdict;
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
  /**
   * Nobody is eligible, but an agent not yet passed over fails only for its load: it has work in
   * hand (not idle, at its board's concurrency, or not ready because its station is busy) or
   * holds another card. Load passes on its own, so the card waits for a later pass and the loop
   * records nothing, rather than record `none-eligible` and look away for the redecide window
   * while the agent frees up and pulls the card unplaced.
   */
  | "waiting-on-load"
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

/**
 * The dispatch policy's verdict for one candidate at this card's stage: Accounts' answer, with the
 * loop's own reasons added (`policy-unread`, `limit:<id>`, `no-principal`).
 */
export interface PolicyVerdict {
  readonly allow: boolean;
  readonly reasons: readonly string[];
  /** The policy version decided under; null with no policy, or when none was read. */
  readonly policyVersion: number | null;
}

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
  } | null;
  /**
   * Its load and health in the shared shape: from its bridge row (`rosterLoad`) when it has one,
   * else from SuperPipeline (`directLoad`) when that reported it; null when nobody did.
   */
  readonly load: AgentLoad | null;
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
  /**
   * Its finished runs at this board stage, from SuperWitness; unset when they were not read, and
   * then the stage record does not weigh for anyone.
   */
  readonly stageRuns?: readonly StageRun[];
  /**
   * Its station's row in AgentPod's capability registry: null when the registry has none for it (or
   * it has no station); unset when the registry was not read, and then no station filter runs.
   */
  readonly station?: StationCaps | null;
  /**
   * The dispatch policy's verdict; unset when policy was not asked (it is off, or another filter
   * already refuses the agent), and then the policy filter passes.
   */
  readonly policy?: PolicyVerdict;
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
  /** How a stage's history weighs; `DEFAULT_HISTORY` when unset. */
  readonly history?: HistorySettings;
  /** Who is considered; `DEFAULT_CANDIDATE_SET` (`roster`) when unset. */
  readonly candidateSet?: CandidateSet;
  /** What the card's stage says a station needs; none when unset or null. */
  readonly needs?: StageNeeds | null;
  /** The weakest registry proof that satisfies a need; `DEFAULT_MIN_PROOF` when unset. */
  readonly minProof?: Proof;
}

/**
 * Is the agent in the candidate set? On the roster (an enabled bridge row, with its load from
 * it); or, when the set is `all`, with no bridge row on the board and a load SuperPipeline
 * reported (`direct`). Its load when it is in the set; null when it is outside it.
 */
export function inCandidateSet(
  facts: CandidateFacts,
  set: CandidateSet,
): AgentLoad | null {
  const load = facts.load;
  if (load === null) return null;
  if (facts.roster !== null)
    return facts.roster.enabled && load.source === "roster" ? load : null;
  return set === "all" && load.source === "direct" ? load : null;
}

/** Every filter's result for one candidate. An agent outside the set goes through that one only. */
export function filter(
  facts: CandidateFacts,
  nowMs: number,
  passedOver = false,
  set: CandidateSet = DEFAULT_CANDIDATE_SET,
  needs: StageNeeds | null = null,
  minProof: Proof = DEFAULT_MIN_PROOF,
): readonly FilterResult[] {
  const load = inCandidateSet(facts, set);
  if (load === null) return [rejected("roster")];
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
    ...stationFilters(facts, needs, minProof),
    check("policy", facts.policy === undefined || facts.policy.allow),
    check("health", load.healthy),
    check("capacity", !named.has("capacity")),
    check("idle", isIdle(load)),
    check("held", facts.holds === 0),
    check("noShow", !recentlyNoShow(facts.history.noShowsAtMs, nowMs)),
    check("passedOver", !passedOver),
  ];
}

const NEED_FILTERS: Readonly<Record<NeedName, FilterName>> = {
  isolation: "isolation",
  model: "model",
  tools: "tools",
  credentials: "credentials",
};

/** The station filters: they run only when the card's stage states a need. */
export const STATION_FILTERS: readonly FilterName[] =
  Object.values(NEED_FILTERS);

/**
 * The station filters the stage states, with what the station lacks on a rejection. None when the
 * stage states nothing, or when the registry was not read (`station` unset): unchecked, not failed.
 */
function stationFilters(
  facts: CandidateFacts,
  needs: StageNeeds | null,
  minProof: Proof,
): FilterResult[] {
  if (facts.station === undefined) return [];
  return checkNeeds(needs, facts.station, minProof).map((r) =>
    r.ok
      ? passed(NEED_FILTERS[r.need])
      : { ...rejected(NEED_FILTERS[r.need]), missing: r.missing },
  );
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

/**
 * The terms an eligible candidate is ranked by, before its rank is known. `stageRecord` is there
 * only when its stage history is given.
 */
export function scoreTerms(
  facts: CandidateFacts,
  nowMs: number,
  stage: StageHistory | null = null,
): { stageRecord?: number; successRate: number; sinceLastDispatchS: number } {
  const { settled, claimed } = facts.history;
  const seen = facts.load?.lastSeenAt ?? null;
  const last = seen === null ? NaN : Date.parse(seen);
  return {
    ...(stage !== null ? { stageRecord: stage.stageRecord } : {}),
    successRate: (claimed + 1) / (settled + 2),
    sinceLastDispatchS: Number.isFinite(last)
      ? Math.max(0, Math.floor((nowMs - last) / 1000))
      : NEVER_DISPATCHED_SECONDS,
  };
}

type Terms = ReturnType<typeof scoreTerms>;

/** Which of two eligible candidates ranks first: negative when `a` does. */
export function compareTerms(
  a: { agentId: string; terms: Terms },
  b: { agentId: string; terms: Terms },
): number {
  return (
    (b.terms.stageRecord ?? 0) - (a.terms.stageRecord ?? 0) ||
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

  const set = input.candidateSet ?? DEFAULT_CANDIDATE_SET;
  const filtered = candidates.map((facts) => ({
    facts,
    filters: filter(
      facts,
      input.nowMs,
      passedOver.has(facts.agentId),
      set,
      input.needs ?? null,
      input.minProof,
    ),
  }));
  const settings = input.history ?? DEFAULT_HISTORY;
  const histories = new Map<string, StageHistory>();
  for (const { facts } of filtered)
    if (facts.stageRuns !== undefined)
      histories.set(
        facts.agentId,
        stageHistory(facts.stageRuns, input.nowMs, settings),
      );
  const passing = filtered.filter(({ filters }) =>
    filters.every((r) => r.passed),
  );
  // The stage record weighs only when every eligible candidate has one: else none is compared on it.
  const weighHistory = passing.every(({ facts }) =>
    histories.has(facts.agentId),
  );
  const eligible = passing
    .map(({ facts }) => ({
      agentId: facts.agentId,
      terms: scoreTerms(
        facts,
        input.nowMs,
        weighHistory ? (histories.get(facts.agentId) ?? null) : null,
      ),
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
      source: facts.roster === null ? "direct" : "roster",
    },
    filters,
    score: scores.get(facts.agentId) ?? null,
    ...(filters.some((r) => r.filter === "roster" && !r.passed)
      ? { capable: !facts.pipeline.reasons.includes("capability_mismatch") }
      : {}),
    stageHistory: histories.get(facts.agentId) ?? null,
    ...(facts.policy !== undefined ? { policy: facts.policy } : {}),
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
    if (filtered.some(({ facts, filters }) => onlyLoad(facts, filters)))
      return none("waiting-on-load", records);
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

/** The filters a candidate fails for its load alone: what passes once its work in hand is done. */
const LOAD_FILTERS: ReadonlySet<FilterName> = new Set<FilterName>([
  "capacity",
  "idle",
  "held",
]);

/**
 * Did a candidate fail only for its load? `health` counts as load only while the agent has no room
 * (`isIdle` false, by its load in the shared shape): a bridge at its concurrency answers not ready,
 * and that passes with the work; an agent unhealthy while idle is not waited for.
 */
function onlyLoad(
  facts: CandidateFacts,
  filters: readonly FilterResult[],
): boolean {
  const failed = filters.filter((r) => !r.passed);
  return (
    failed.length > 0 &&
    failed.every(
      (r) =>
        LOAD_FILTERS.has(r.filter) ||
        (r.filter === "health" && facts.load !== null && !isIdle(facts.load)),
    )
  );
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

export * from "./suggest.ts";
export * from "./supply.ts";
