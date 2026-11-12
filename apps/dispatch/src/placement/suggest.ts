/**
 * Roster suggestions: advice for a person, never an action (charter decision 8). From the recent
 * decisions, find the lanes (a board's stage, with the capability it asks for) that rest on too
 * few working agents, and say who in the workspace could be added to the board's roster. A
 * suggestion is a record a person reads; SuperDispatch edits no roster, and nothing here can.
 *
 * Pure, like the rest of placement: decisions in, suggestions out. The roster each decision read
 * from AgentPod is in its candidate records (the `roster` filter), and SuperPipeline's verdict on
 * every other agent of the workspace in their `capable` flag, so the decisions alone say who is on
 * the board and who could be.
 *
 * A lane is flagged by any of three rules, each over the decisions in the window the caller read:
 *
 * - **`one-candidate`**: the lane's latest decision found exactly one agent on the board's roster
 *   with the capability. One stuck agent stalls the lane.
 * - **`unreliable`**: in at least `UNRELIABLE_MIN` decisions, every agent on the roster with the
 *   capability was `unhealthy` or a `recently-no-show`.
 * - **`stalled`**: a card waited at the stage, on one attempt, with nobody eligible
 *   (`none-eligible`) across at least `stallAfterMs`, from its first such decision to its last.
 *
 * A flagged lane is one suggestion: `add-agent-to-board` when the workspace has agents with the
 * capability that are not on the board's roster (they are its `candidates`), and
 * `lane-single-point` when it has none, so a person must set up another agent for the capability.
 */
import type {
  CandidateRecord,
  FilterName,
  FilterResult,
  RejectionReason,
} from "./index.ts";

/** What a suggestion proposes. */
export const SUGGESTION_KINDS = [
  /** Add one of `candidates` to the board's roster: they have the capability and are not on it. */
  "add-agent-to-board",
  /** The lane rests on at most one working agent, and nobody else in the workspace can take it. */
  "lane-single-point",
] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

/** Why a lane is flagged, one code per rule. */
export const LANE_RULES = ["one-candidate", "unreliable", "stalled"] as const;
export type LaneRule = (typeof LANE_RULES)[number];

/** How many decisions with every rostered agent unhealthy or a no-show flag a lane. */
export const UNRELIABLE_MIN = 3;

/** How long a card waits with nobody eligible before its lane is flagged, by default. */
export const DEFAULT_STALL_AFTER_MS = 30 * 60 * 1000;

/** The most decision ids a suggestion lists as its evidence; `evidenceCount` counts them all. */
export const MAX_EVIDENCE = 20;

/** The capabilities a lane asks for: every one of `all`, and one of `any` when it is set. */
export interface Capability {
  readonly all: readonly string[];
  readonly any: readonly string[];
}

/** One recorded decision, as suggestions read it. */
export interface LaneDecision {
  readonly id: string;
  readonly boardId: string;
  readonly cardId: string;
  readonly stageKey: string;
  readonly attemptsBefore: number;
  /** The capability the stage asked for when it was decided; null on rows older than that. */
  readonly requires: Capability | null;
  readonly noDecisionReason: string | null;
  readonly candidates: readonly CandidateRecord[];
  readonly createdAtMs: number;
}

export interface SuggestSettings {
  /** How long a card waits with nobody eligible before its lane is flagged `stalled`. */
  readonly stallAfterMs: number;
}

/** An agent a suggestion proposes adding to the board's roster. */
export interface SuggestedAgent {
  readonly agentId: string;
  readonly principalId: string | null;
  /** Its station, when it has a bridge row on the board that is not enabled. */
  readonly stationId: string | null;
}

/** A proposal for a person. Never an action: nothing reads it to change a roster. */
export interface Suggestion {
  readonly kind: SuggestionKind;
  readonly boardId: string;
  readonly stageKey: string;
  /** What the lane asks for, from its latest decision that said; null when none did. */
  readonly capability: Capability | null;
  /** The agents on the board's roster with the capability, as the latest decision read them. */
  readonly rostered: readonly string[];
  /** Agents in the workspace with the capability and not on the board's roster. */
  readonly candidates: readonly SuggestedAgent[];
  /** The rules that flagged the lane, in `LANE_RULES` order. */
  readonly reasons: readonly LaneRule[];
  /** The same, in a sentence a person reads. */
  readonly reason: string;
  /** The decisions that bear it out, oldest first, at most `MAX_EVIDENCE`. */
  readonly evidence: readonly string[];
  /** How many decisions bear it out. */
  readonly evidenceCount: number;
}

const result = (
  record: CandidateRecord,
  filter: FilterName,
): FilterResult | undefined => record.filters.find((r) => r.filter === filter);
const passes = (record: CandidateRecord, filter: FilterName) =>
  result(record, filter)?.passed === true;
const fails = (record: CandidateRecord, filter: FilterName) =>
  result(record, filter)?.passed === false;

/** The agents of a decision on the board's roster with the lane's capability. */
export function rosteredCapable(
  decision: Pick<LaneDecision, "candidates">,
): CandidateRecord[] {
  return decision.candidates.filter(
    (r) => passes(r, "roster") && passes(r, "capability"),
  );
}

/** Was every agent on the roster with the capability unhealthy or a recent no-show? */
export function unreliable(
  decision: Pick<LaneDecision, "candidates">,
): boolean {
  const rc = rosteredCapable(decision);
  return (
    rc.length > 0 && rc.every((r) => fails(r, "health") || fails(r, "noShow"))
  );
}

/** The roster suggestions the decisions bear out, by board then stage. */
export function suggest(input: {
  readonly decisions: readonly LaneDecision[];
  readonly settings?: SuggestSettings;
}): Suggestion[] {
  const stallAfterMs = input.settings?.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
  const lanes = new Map<string, LaneDecision[]>();
  for (const d of input.decisions) {
    const key = `${d.boardId}\u0000${d.stageKey}`;
    lanes.set(key, [...(lanes.get(key) ?? []), d]);
  }
  const out: Suggestion[] = [];
  for (const decisions of lanes.values()) {
    decisions.sort(
      (a, b) =>
        a.createdAtMs - b.createdAtMs ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const found = lane(decisions, stallAfterMs);
    if (found !== null) out.push(found);
  }
  return out.sort((a, b) =>
    a.boardId !== b.boardId
      ? a.boardId < b.boardId
        ? -1
        : 1
      : a.stageKey < b.stageKey
        ? -1
        : a.stageKey > b.stageKey
          ? 1
          : 0,
  );
}

/** One lane's suggestion, from its decisions oldest first; null when no rule flags it. */
function lane(
  decisions: readonly LaneDecision[],
  stallAfterMs: number,
): Suggestion | null {
  const latest = decisions[decisions.length - 1];
  if (latest === undefined) return null;
  const evidence = new Set<string>();
  const reasons: LaneRule[] = [];
  const said: string[] = [];

  const rostered = rosteredCapable(latest).map((r) => r.candidate.agentId);
  if (rostered.length === 1) {
    reasons.push("one-candidate");
    said.push(`only ${rostered[0]} on the board's roster can take this lane`);
    for (const d of decisions)
      if (rosteredCapable(d).length === 1) evidence.add(d.id);
  }

  const shaky = decisions.filter(unreliable);
  if (shaky.length >= UNRELIABLE_MIN) {
    reasons.push("unreliable");
    said.push(
      `every agent on the roster for this lane was unhealthy or a recent no-show in ${shaky.length} decisions`,
    );
    for (const d of shaky) evidence.add(d.id);
  }

  const waits = new Map<string, LaneDecision[]>();
  for (const d of decisions) {
    if (d.noDecisionReason !== "none-eligible") continue;
    const key = `${d.cardId}\u0000${d.attemptsBefore}`;
    waits.set(key, [...(waits.get(key) ?? []), d]);
  }
  let longestMs = 0;
  for (const run of waits.values()) {
    const first = run[0] as LaneDecision;
    const last = run[run.length - 1] as LaneDecision;
    const waitedMs = last.createdAtMs - first.createdAtMs;
    if (waitedMs < stallAfterMs) continue;
    longestMs = Math.max(longestMs, waitedMs);
    for (const d of run) evidence.add(d.id);
  }
  if (longestMs > 0) {
    reasons.push("stalled");
    said.push(
      `a card waited ${Math.floor(longestMs / 60_000)} minutes with nobody eligible`,
    );
  }
  if (reasons.length === 0) return null;

  const onRoster = new Set(rostered);
  const candidates: SuggestedAgent[] = latest.candidates
    .filter(
      (r) =>
        r.capable === true &&
        fails(r, "roster") &&
        !onRoster.has(r.candidate.agentId),
    )
    .map((r) => ({
      agentId: r.candidate.agentId,
      principalId: r.candidate.principalId ?? null,
      stationId: r.candidate.stationId ?? null,
    }))
    .sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
  const kind: SuggestionKind =
    candidates.length > 0 ? "add-agent-to-board" : "lane-single-point";
  const capability =
    [...decisions].reverse().find((d) => d.requires !== null)?.requires ?? null;
  const ordered = decisions.filter((d) => evidence.has(d.id)).map((d) => d.id);
  const advice =
    kind === "add-agent-to-board"
      ? `a person could add ${candidates.map((c) => c.agentId).join(", ")} to the board's roster`
      : "no other agent in the workspace has the capability";
  return {
    kind,
    boardId: latest.boardId,
    stageKey: latest.stageKey,
    capability,
    rostered,
    candidates,
    reasons,
    reason: `${capitalise(said.join("; "))}; ${advice}.`,
    evidence: ordered.slice(-MAX_EVIDENCE),
    evidenceCount: ordered.length,
  };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Candidate records as a decision row keeps them (JSON), read back defensively: a record that is
 * not one is left out, and an unknown filter name or a malformed result drops the record.
 */
export function candidateRecords(json: unknown): CandidateRecord[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((raw): CandidateRecord[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const r = raw as Record<string, unknown>;
    const c = r.candidate as Record<string, unknown> | undefined;
    if (typeof c !== "object" || c === null || typeof c.agentId !== "string")
      return [];
    if (!Array.isArray(r.filters)) return [];
    const filters: FilterResult[] = [];
    for (const f of r.filters as unknown[]) {
      if (typeof f !== "object" || f === null) return [];
      const { filter, passed, reason } = f as Record<string, unknown>;
      if (typeof filter !== "string") return [];
      if (passed === true)
        filters.push({ filter: filter as FilterName, passed: true });
      else if (passed === false && typeof reason === "string")
        filters.push({
          filter: filter as FilterName,
          passed: false,
          reason: reason as RejectionReason,
        });
      else return [];
    }
    return [
      {
        candidate: {
          agentId: c.agentId,
          principalId: typeof c.principalId === "string" ? c.principalId : null,
          stationId: typeof c.stationId === "string" ? c.stationId : null,
          ...(c.source === "roster" || c.source === "direct"
            ? { source: c.source }
            : {}),
        },
        filters,
        score: null,
        ...(typeof r.capable === "boolean" ? { capable: r.capable } : {}),
      },
    ];
  });
}
