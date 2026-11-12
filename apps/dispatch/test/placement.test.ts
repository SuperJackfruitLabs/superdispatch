import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HISTORY,
  DEFAULT_TIERS,
  FILTERS,
  STATION_FILTERS,
  MIN_CANDIDATES,
  NEVER_DISPATCHED_SECONDS,
  NO_SHOW_LIMIT,
  NO_SHOW_WINDOW_MS,
  POLICY,
  type CandidateFacts,
  REJECTION_REASONS,
  decisionProblems,
  isEligible,
  passed,
  place,
  rejected,
  type CandidateRecord,
  type CardRef,
  type Decision,
  type FilterName,
  type TierSettings,
  boardOrder,
  fairOrder,
  tierFor,
  stageHistory,
  type StageRun,
} from "../src/placement/index.ts";
import { rosterLoad } from "../src/sources/index.ts";

const CARD: CardRef = { boardId: "brd_a", cardId: "crd_a", stageKey: "build" };
const ALL = Object.keys(FILTERS) as FilterName[];
const WINNER = tierFor(1, DEFAULT_TIERS);

function eligible(agentId: string, total = 1): CandidateRecord {
  return {
    candidate: { agentId },
    filters: ALL.map(passed),
    score: { total, terms: { load: total } },
  };
}

function rejectedBy(agentId: string, filter: FilterName): CandidateRecord {
  return {
    candidate: { agentId },
    filters: ALL.map((f) => (f === filter ? rejected(f) : passed(f))),
    score: null,
  };
}

describe("the reason codes", () => {
  test("are the six the charter names, the no-show refinement's, the one-hold rule's, the ladder's, SuperPipeline's other verdict and the four station filters', one per filter", () => {
    expect([...REJECTION_REASONS].sort()).toEqual([
      "at-capacity",
      "capability-missing",
      "credential-missing",
      "grant-denied",
      "holding-another",
      "isolation-too-weak",
      "model-mismatch",
      "not-claimable",
      "not-idle",
      "not-on-roster",
      "passed-over",
      "recently-no-show",
      "tool-missing",
      "unhealthy",
    ]);
    expect(new Set(REJECTION_REASONS).size).toBe(ALL.length);
  });

  test("a rejection carries its own filter's reason", () => {
    for (const filter of ALL) {
      expect(rejected(filter)).toEqual({
        filter,
        passed: false,
        reason: FILTERS[filter],
      });
      expect(passed(filter)).toEqual({ filter, passed: true });
    }
  });
});

describe("eligibility", () => {
  test("a candidate is eligible only when it went through filters and passed them all", () => {
    expect(isEligible(eligible("agt_a"))).toBe(true);
    expect(isEligible(rejectedBy("agt_a", "idle"))).toBe(false);
    expect(
      isEligible({ candidate: { agentId: "agt_a" }, filters: [], score: null }),
    ).toBe(false);
  });
});

describe("a decision's invariants", () => {
  test("a well-formed placement and each well-formed no-decision hold", () => {
    const placed: Decision = {
      kind: "placed",
      card: CARD,
      tier: WINNER,
      chosen: "agt_a",
      candidates: [
        eligible("agt_a", 2),
        eligible("agt_b"),
        rejectedBy("agt_c", "grant"),
      ],
    };
    expect(decisionProblems(placed)).toEqual([]);
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
        tier: WINNER,
        reason: "none-eligible",
        candidates: [rejectedBy("agt_a", "health")],
      }),
    ).toEqual([]);
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
        tier: WINNER,
        reason: "no-candidates",
        candidates: [],
      }),
    ).toEqual([]);
  });

  test("the chosen agent must be an eligible candidate", () => {
    expect(
      decisionProblems({
        kind: "placed",
        card: CARD,
        tier: WINNER,
        chosen: "agt_z",
        candidates: [eligible("agt_a")],
      }),
    ).toEqual(["the chosen agt_z is not a candidate"]);
    expect(
      decisionProblems({
        kind: "placed",
        card: CARD,
        tier: WINNER,
        chosen: "agt_a",
        candidates: [rejectedBy("agt_a", "roster")],
      }),
    ).toEqual(["the chosen agt_a did not pass every filter"]);
  });

  test("scored when, and only when, every filter passed; and finitely", () => {
    const unscored: CandidateRecord = { ...eligible("agt_a"), score: null };
    const scoredReject: CandidateRecord = {
      ...rejectedBy("agt_b", "capacity"),
      score: { total: 1, terms: {} },
    };
    const infinite: CandidateRecord = {
      ...eligible("agt_c"),
      score: { total: 1, terms: { load: Number.NaN } },
    };
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
        tier: WINNER,
        reason: "none-eligible",
        candidates: [unscored, scoredReject, infinite],
      }),
    ).toEqual([
      "agt_a passed every filter and has no score",
      "agt_b is scored without passing every filter",
      "agt_c has a score that is not a finite number",
      "none-eligible, with an eligible candidate",
    ]);
  });

  test("a candidate appears once and goes through a filter once, rejected with that filter's reason", () => {
    const twice: CandidateRecord = {
      candidate: { agentId: "agt_b" },
      filters: [passed("roster"), passed("roster")],
      score: { total: 0, terms: {} },
    };
    const mislabelled: CandidateRecord = {
      candidate: { agentId: "agt_c" },
      filters: [{ filter: "idle", passed: false, reason: "unhealthy" }],
      score: null,
    };
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
        tier: WINNER,
        reason: "none-eligible",
        candidates: [eligible("agt_a"), eligible("agt_a"), twice, mislabelled],
      }),
    ).toEqual([
      "agt_a is a candidate twice",
      "agt_b went through roster twice",
      "agt_c was rejected by idle as unhealthy, not not-idle",
      "none-eligible, with an eligible candidate",
    ]);
  });

  test("the no-decision reasons agree with the candidates", () => {
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
        tier: WINNER,
        reason: "no-candidates",
        candidates: [rejectedBy("agt_a", "idle")],
      }),
    ).toEqual(["no-candidates, with candidates"]);
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
        tier: WINNER,
        reason: "none-eligible",
        candidates: [],
      }),
    ).toEqual(["none-eligible, with no candidates"]);
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
        tier: WINNER,
        reason: "none-eligible",
        candidates: [eligible("agt_a")],
      }),
    ).toEqual(["none-eligible, with an eligible candidate"]);
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
        tier: WINNER,
        reason: "one-candidate",
        candidates: [eligible("agt_a"), eligible("agt_b")],
      }),
    ).toEqual(["one-candidate, with 2 on the roster"]);
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
        tier: WINNER,
        reason: "one-candidate",
        candidates: [eligible("agt_a"), rejectedBy("agt_b", "roster")],
      }),
    ).toEqual([]);
  });
});

// Placement, as a table: each row is the facts for a card's candidates and what must come of them.
const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const MIN = 60_000;

/** A bridge row on the roster, as a row of the table states it. */
interface RosterOver {
  stationId: string;
  enabled: boolean;
  ready: boolean;
  busy: boolean;
  lastDispatchedAtMs: number | null;
}

/** An agent with every fact in its favour, unless a row says otherwise. */
function agent(
  agentId: string,
  over: {
    eligible?: boolean;
    reasons?: string[];
    roster?: Partial<RosterOver> | null;
    history?: Partial<CandidateFacts["history"]>;
    holds?: number;
    stageRuns?: StageRun[];
  } = {},
): CandidateFacts {
  const reasons = over.reasons ?? [];
  const row: RosterOver | null =
    over.roster === null
      ? null
      : {
          stationId: `stn_${agentId}`,
          enabled: true,
          ready: true,
          busy: false,
          lastDispatchedAtMs: NOW - 10 * MIN,
          ...over.roster,
        };
  return {
    agentId,
    principalId: `prn_${agentId}`,
    pipeline: { eligible: over.eligible ?? reasons.length === 0, reasons },
    roster:
      row === null ? null : { stationId: row.stationId, enabled: row.enabled },
    load:
      row === null
        ? null
        : rosterLoad(agentId, {
            ...row,
            lastDispatchedAt:
              row.lastDispatchedAtMs === null
                ? null
                : new Date(row.lastDispatchedAtMs).toISOString(),
          }),
    history: { settled: 0, claimed: 0, noShowsAtMs: [], ...over.history },
    holds: over.holds ?? 0,
    ...(over.stageRuns !== undefined ? { stageRuns: over.stageRuns } : {}),
  };
}

function decide(...candidates: CandidateFacts[]): Decision {
  const decision = place({ card: CARD, nowMs: NOW, candidates });
  // Every decision placement makes holds every invariant: the table checks that on each row.
  expect(decisionProblems(decision)).toEqual([]);
  return decision;
}

/** What one candidate was rejected for, or "ok" when it passed every filter. */
function verdicts(decision: Decision): Record<string, string> {
  return Object.fromEntries(
    decision.candidates.map((r) => [
      r.candidate.agentId,
      r.filters
        .filter((f) => !f.passed)
        .map((f) => (f.passed ? "" : f.reason))
        .join(",") || "ok",
    ]),
  );
}

const chosen = (d: Decision) => (d.kind === "placed" ? d.chosen : d.reason);

describe("place: the filters", () => {
  const rejections: Array<[string, CandidateFacts, string]> = [
    ["not on the roster", agent("agt_x", { roster: null }), "not-on-roster"],
    [
      "on the roster, disabled",
      agent("agt_x", { roster: { enabled: false } }),
      "not-on-roster",
    ],
    [
      "lacking the capability",
      agent("agt_x", { reasons: ["capability_mismatch"] }),
      "capability-missing",
    ],
    [
      "outside the card's grant",
      agent("agt_x", { reasons: ["grant_denied"] }),
      "grant-denied",
    ],
    [
      "at the board's concurrency",
      agent("agt_x", { reasons: ["concurrency_reached"] }),
      "at-capacity",
    ],
    [
      "refused by SuperPipeline for a reason not named here",
      agent("agt_x", { reasons: ["card_reserved"] }),
      "not-claimable",
    ],
    [
      "refused by SuperPipeline with no reason at all",
      agent("agt_x", { eligible: false, reasons: [] }),
      "not-claimable",
    ],
    [
      "on a station that is not ready",
      agent("agt_x", { roster: { ready: false } }),
      "unhealthy",
    ],
    [
      "with work in hand on some board",
      agent("agt_x", { roster: { busy: true } }),
      "not-idle",
    ],
    ["holding another card", agent("agt_x", { holds: 1 }), "holding-another"],
    [
      "with two holds lapsed in the window",
      agent("agt_x", {
        history: { noShowsAtMs: [NOW - 5 * MIN, NOW - 20 * MIN] },
      }),
      "recently-no-show",
    ],
  ];
  for (const [what, candidate, reason] of rejections) {
    test(`an agent ${what} is rejected as ${reason}, and another is chosen`, () => {
      // Two eligible agents beside it, so the card has a choice even when it is off the roster.
      const d = decide(agent("agt_b"), candidate, agent("agt_a"));
      expect(verdicts(d)).toEqual({ agt_a: "ok", agt_b: "ok", agt_x: reason });
      expect(chosen(d)).toBe("agt_a");
    });
  }

  test("an agent off the roster goes through the roster filter only: it is outside the candidate set", () => {
    const d = decide(
      agent("agt_a"),
      agent("agt_b"),
      agent("agt_x", { roster: null, reasons: ["grant_denied"] }),
    );
    expect(
      d.candidates.find((r) => r.candidate.agentId === "agt_x")?.filters,
    ).toEqual([rejected("roster")]);
  });

  test("every filter runs for a rostered agent, so a candidate rejected twice says so", () => {
    const d = decide(
      agent("agt_a"),
      agent("agt_x", {
        reasons: ["capability_mismatch", "grant_denied"],
        roster: { busy: true },
      }),
    );
    expect(verdicts(d).agt_x).toBe("capability-missing,grant-denied,not-idle");
    expect(
      d.candidates.find((r) => r.candidate.agentId === "agt_x")?.filters.length,
    ).toBe(Object.keys(FILTERS).length - STATION_FILTERS.length);
  });

  test(`no-shows count only inside the window, and only from ${NO_SHOW_LIMIT}`, () => {
    const justOne = agent("agt_x", { history: { noShowsAtMs: [NOW - MIN] } });
    const aged = agent("agt_y", {
      history: {
        noShowsAtMs: [NOW - MIN, NOW - NO_SHOW_WINDOW_MS],
      },
    });
    const d = decide(justOne, aged);
    expect(verdicts(d)).toEqual({ agt_x: "ok", agt_y: "ok" });
  });
});

describe("place: the score", () => {
  test("an agent holding a card is never held for a second, whatever its record: one live hold each", () => {
    const d = decide(
      agent("agt_a", { holds: 1, history: { settled: 10, claimed: 10 } }),
      agent("agt_b", { roster: { lastDispatchedAtMs: NOW } }),
    );
    expect(chosen(d)).toBe("agt_b");
    expect(verdicts(d).agt_a).toBe("holding-another");
  });

  test("the success rate on this board, smoothed", () => {
    const d = decide(
      agent("agt_a", { history: { settled: 4, claimed: 1 } }),
      agent("agt_b", { history: { settled: 4, claimed: 3 } }),
      // Never settled reads as one half: above one of four, below three of four.
      agent("agt_c"),
    );
    expect(chosen(d)).toBe("agt_b");
    const terms = Object.fromEntries(
      d.candidates.map((r) => [r.candidate.agentId, r.score?.terms]),
    );
    expect(terms.agt_a?.successRate).toBeCloseTo(2 / 6);
    expect(terms.agt_b?.successRate).toBeCloseTo(4 / 6);
    expect(terms.agt_c?.successRate).toBe(0.5);
  });

  test("then the least recently used; a station that never took work first", () => {
    expect(
      chosen(
        decide(
          agent("agt_a", { roster: { lastDispatchedAtMs: NOW - MIN } }),
          agent("agt_b", { roster: { lastDispatchedAtMs: NOW - 60 * MIN } }),
        ),
      ),
    ).toBe("agt_b");
    const d = decide(
      agent("agt_a", { roster: { lastDispatchedAtMs: NOW - 60 * MIN } }),
      agent("agt_b", { roster: { lastDispatchedAtMs: null } }),
    );
    expect(chosen(d)).toBe("agt_b");
    expect(
      d.candidates.find((r) => r.candidate.agentId === "agt_b")?.score?.terms
        .sinceLastDispatchS,
    ).toBe(NEVER_DISPATCHED_SECONDS);
  });

  test("a tie that is left goes to the lower agent id, whatever order they came in", () => {
    expect(chosen(decide(agent("agt_b"), agent("agt_a")))).toBe("agt_a");
    expect(chosen(decide(agent("agt_a"), agent("agt_b")))).toBe("agt_a");
  });

  test("totals rank the eligible, best highest; a rejected candidate has no score", () => {
    const d = decide(
      agent("agt_a", { history: { settled: 4, claimed: 0 } }),
      agent("agt_b", { history: { settled: 4, claimed: 4 } }),
      agent("agt_c"),
      agent("agt_x", { roster: { ready: false } }),
    );
    expect(
      Object.fromEntries(
        d.candidates.map((r) => [r.candidate.agentId, r.score?.total ?? null]),
      ),
    ).toEqual({ agt_a: 1, agt_b: 3, agt_c: 2, agt_x: null });
  });
});

describe("place: the decision", () => {
  test("nobody to consider is no-candidates", () => {
    expect(chosen(decide())).toBe("no-candidates");
  });

  test(`fewer than ${MIN_CANDIDATES} on the roster is one-candidate: no choice, so no hold`, () => {
    const d = decide(agent("agt_a"), agent("agt_x", { roster: null }));
    expect(chosen(d)).toBe("one-candidate");
    // The lone candidate is still filtered and scored, so the record shows the lane is thin.
    expect(verdicts(d)).toEqual({ agt_a: "ok", agt_x: "not-on-roster" });
  });

  test("nobody on the roster at all is none-eligible", () => {
    expect(
      chosen(
        decide(
          agent("agt_x", { roster: null }),
          agent("agt_y", { roster: null }),
        ),
      ),
    ).toBe("none-eligible");
  });

  test("two on the roster, both rejected, is none-eligible", () => {
    expect(
      chosen(
        decide(
          agent("agt_a", { roster: { ready: false } }),
          agent("agt_b", { reasons: ["grant_denied"] }),
        ),
      ),
    ).toBe("none-eligible");
  });

  test("two on the roster, one eligible, places that one", () => {
    expect(
      chosen(
        decide(agent("agt_a", { roster: { busy: true } }), agent("agt_b")),
      ),
    ).toBe("agt_b");
  });

  test("a candidate listed twice is considered once", () => {
    const d = decide(agent("agt_a"), agent("agt_a"), agent("agt_b"));
    expect(d.candidates.map((r) => r.candidate.agentId)).toEqual([
      "agt_a",
      "agt_b",
    ]);
  });

  test("the record carries each candidate's principal, station and source", () => {
    const d = decide(agent("agt_a"), agent("agt_x", { roster: null }));
    expect(d.candidates.map((r) => r.candidate)).toEqual([
      {
        agentId: "agt_a",
        principalId: "prn_agt_a",
        stationId: "stn_agt_a",
        source: "roster",
      },
      {
        agentId: "agt_x",
        principalId: "prn_agt_x",
        stationId: null,
        source: "direct",
      },
    ]);
  });

  test("the policy has a name to record", () => {
    expect(POLICY).toBe("idle-stage-success-lru@3");
  });
});

/** A card at a ladder step: these agents' holds on it already lapsed. */
function decideAt(
  passedOver: string[],
  tiers: TierSettings,
  ...candidates: CandidateFacts[]
): Decision {
  const decision = place({
    card: CARD,
    nowMs: NOW,
    candidates,
    ladder: { passedOver },
    tiers,
  });
  expect(decisionProblems(decision)).toEqual([]);
  return decision;
}

describe("tiers", () => {
  const tiers: TierSettings = {
    winnerSeconds: 60,
    runnerUpSeconds: 30,
    topK: 3,
  };

  test("the defaults: the winner for 60 s, runner-ups for 30 s, three holds", () => {
    expect(DEFAULT_TIERS).toEqual(tiers);
  });

  test("step 1 is the winner, steps 2 to k the runner-up, then any match", () => {
    expect([1, 2, 3, 4, 9].map((step) => tierFor(step, tiers))).toEqual([
      { name: "winner", step: 1, holdSeconds: 60 },
      { name: "runner-up", step: 2, holdSeconds: 30 },
      { name: "runner-up", step: 3, holdSeconds: 30 },
      { name: "any-match", step: 4, holdSeconds: null },
      { name: "any-match", step: 9, holdSeconds: null },
    ]);
    // k = 1: the winner, then any match.
    expect(tierFor(2, { ...tiers, topK: 1 }).name).toBe("any-match");
    expect(tierFor(1, { ...tiers, topK: 1 }).name).toBe("winner");
    // A step below 1 is step 1.
    expect(tierFor(0, tiers).step).toBe(1);
  });

  test("a new ladder holds for the winner, in the winner tier", () => {
    const d = decideAt([], tiers, agent("agt_a"), agent("agt_b"));
    expect(d).toMatchObject({
      kind: "placed",
      chosen: "agt_a",
      tier: { name: "winner", step: 1, holdSeconds: 60 },
    });
  });

  test("after the winner's hold lapsed: the runner-up is held for, and the winner is recorded as passed over", () => {
    const d = decideAt(
      ["agt_a"],
      tiers,
      agent("agt_a"),
      agent("agt_b"),
      agent("agt_c"),
    );
    expect(d).toMatchObject({
      kind: "placed",
      chosen: "agt_b",
      tier: { name: "runner-up", step: 2, holdSeconds: 30 },
    });
    expect(verdicts(d)).toEqual({
      agt_a: "passed-over",
      agt_b: "ok",
      agt_c: "ok",
    });
  });

  test("the third hold goes to the next not passed over; then the card is open to any match", () => {
    const third = decideAt(
      ["agt_a", "agt_b"],
      tiers,
      agent("agt_a"),
      agent("agt_b"),
      agent("agt_c"),
    );
    expect(third).toMatchObject({
      chosen: "agt_c",
      tier: { name: "runner-up", step: 3 },
    });
    const open = decideAt(
      ["agt_a", "agt_b", "agt_c"],
      tiers,
      agent("agt_a"),
      agent("agt_b"),
      agent("agt_c"),
      agent("agt_d"),
    );
    // agt_d is eligible, but the tiers are spent: nothing is held, and pull decides.
    expect(open).toMatchObject({
      kind: "none",
      reason: "any-match",
      tier: { name: "any-match", step: 4, holdSeconds: null },
    });
    expect(verdicts(open).agt_d).toBe("ok");
  });

  test("a runner-up step with nobody left to hold for opens the card at once", () => {
    const d = decideAt(
      ["agt_a"],
      tiers,
      agent("agt_a"),
      // Unhealthy while idle: not a busy agent the card could wait for.
      agent("agt_b", { roster: { ready: false } }),
    );
    expect(d).toMatchObject({
      kind: "none",
      reason: "any-match",
      tier: { name: "any-match", step: 2, holdSeconds: null },
    });
  });

  test("the winner tier with nobody eligible is none-eligible, not any-match: there was no hold to relax", () => {
    const d = decideAt(
      [],
      tiers,
      agent("agt_a", { reasons: ["grant_denied"] }),
      agent("agt_b", { roster: { ready: false } }),
    );
    expect(d).toMatchObject({ reason: "none-eligible", tier: WINNER });
  });

  test("nobody eligible only because the agents are busy: the card waits, at its tier, unrecorded", () => {
    // Busy with work in hand, and so not ready: the bridge answers not ready at its concurrency.
    const busy = { roster: { busy: true, ready: false } };
    expect(
      decideAt([], tiers, agent("agt_a", busy), agent("agt_b", busy)),
    ).toMatchObject({ kind: "none", reason: "waiting-on-load", tier: WINNER });
    // At its board's concurrency in SuperPipeline.
    expect(
      chosen(
        decideAt(
          [],
          tiers,
          agent("agt_a", {
            reasons: ["concurrency_reached"],
          }),
          agent("agt_b", { roster: { ready: false } }),
        ),
      ),
    ).toBe("waiting-on-load");
    // In a runner-up step too, for an agent not yet passed over.
    expect(
      decideAt(["agt_a"], tiers, agent("agt_a"), agent("agt_b", busy)),
    ).toMatchObject({
      reason: "waiting-on-load",
      tier: { name: "runner-up", step: 2 },
    });
    // Not ready while idle is unhealthy, not load: nobody to wait for.
    expect(
      chosen(
        decideAt(
          [],
          tiers,
          agent("agt_a", { roster: { ready: false } }),
          agent("agt_b", {
            roster: { busy: true },
            history: { noShowsAtMs: [NOW - 1, NOW - 2] },
          }),
        ),
      ),
    ).toBe("none-eligible");
  });

  test("nobody eligible only because a free agent holds another card: the card waits, at its tier", () => {
    // In the winner tier too.
    expect(
      chosen(
        decideAt(
          [],
          tiers,
          agent("agt_a", { holds: 1 }),
          agent("agt_b", { roster: { busy: true } }),
        ),
      ),
    ).toBe("waiting-on-holds");
    const waiting = decideAt(
      ["agt_a"],
      tiers,
      agent("agt_a"),
      agent("agt_b", { holds: 1 }),
    );
    expect(waiting).toMatchObject({
      kind: "none",
      reason: "waiting-on-holds",
      tier: { name: "runner-up", step: 2 },
    });
    // A passed-over agent that also holds a card is not one to wait for.
    const spent = decideAt(
      ["agt_a"],
      tiers,
      agent("agt_a", { holds: 1 }),
      agent("agt_b", { roster: { ready: false } }),
    );
    expect(chosen(spent)).toBe("any-match");
  });

  test("k = 1: the winner, then any match", () => {
    const d = decideAt(
      ["agt_a"],
      { ...tiers, topK: 1 },
      agent("agt_a"),
      agent("agt_b"),
    );
    expect(chosen(d)).toBe("any-match");
  });

  test("a decision's tier agrees with its kind", () => {
    const anyMatch = tierFor(4, tiers);
    expect(
      decisionProblems({
        kind: "placed",
        card: CARD,
        chosen: "agt_a",
        tier: anyMatch,
        candidates: [eligible("agt_a")],
      }),
    ).toEqual([
      "placed in the any-match tier, which holds nothing",
      "placed with no hold",
    ]);
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
        reason: "any-match",
        tier: WINNER,
        candidates: [eligible("agt_a")],
      }),
    ).toEqual(["any-match, in the winner tier"]);
  });
});

describe("fairness across boards", () => {
  const card = (id: string, waitedMin: number) => ({
    id,
    since: NOW - waitedMin * MIN,
  });
  const ids = (q: { boardId: string; item: { id: string } }[]) =>
    q.map((e) => `${e.boardId}/${e.item.id}`);

  test("one card from each board a round, the longest-waiting first within a round", () => {
    const busy = {
      boardId: "brd_busy",
      items: [card("b1", 5), card("b2", 50), card("b3", 1), card("b4", 1)],
    };
    const quiet = { boardId: "brd_quiet", items: [card("q1", 2)] };
    const other = {
      boardId: "brd_other",
      items: [card("o1", 9), card("o2", 9)],
    };
    expect(ids(fairOrder([busy, quiet, other], (c) => c.since))).toEqual([
      // Round 1: o1 waited 9 minutes, b1 5, q1 2.
      "brd_other/o1",
      "brd_busy/b1",
      "brd_quiet/q1",
      // Round 2.
      "brd_busy/b2",
      "brd_other/o2",
      // The busy board's rest.
      "brd_busy/b3",
      "brd_busy/b4",
    ]);
  });

  test("a board keeps its own order inside its queue, and a tie goes to the lower board id", () => {
    const a = { boardId: "brd_b", items: [card("x", 1), card("y", 99)] };
    const b = { boardId: "brd_a", items: [card("z", 1)] };
    expect(ids(fairOrder([a, b], (c) => c.since))).toEqual([
      "brd_a/z",
      "brd_b/x",
      "brd_b/y",
    ]);
    expect(fairOrder([], (c: { since: number }) => c.since)).toEqual([]);
  });

  test("board order, without fairness: every card of one board before the next", () => {
    const busy = { boardId: "brd_busy", items: [card("b1", 1), card("b2", 1)] };
    const quiet = { boardId: "brd_quiet", items: [card("q1", 99)] };
    expect(ids(boardOrder([busy, quiet]))).toEqual([
      "brd_busy/b1",
      "brd_busy/b2",
      "brd_quiet/q1",
    ]);
  });
});

const DAY = 24 * 60 * MIN;

/** `n` runs ending `ageMs` ago, the first `won` succeeded, each with `verdict`. */
function runs(
  n: number,
  won: number,
  verdict: number | null = null,
  ageMs = 0,
): StageRun[] {
  return Array.from({ length: n }, (_, i) => ({
    atMs: NOW - ageMs,
    succeeded: i < won,
    verdict,
  }));
}

describe("stage history: the record", () => {
  const S = { halfLifeMs: 7 * DAY, minSample: 3 };
  // Each row: the runs, and the outcome rate, verdict rate and record they come to.
  const table: Array<[string, StageRun[], number, number]> = [
    ["no runs: neutral", [], 0.5, 0.5],
    [
      "below the minimum sample: neutral, however good",
      runs(2, 2, 1),
      0.5,
      0.5,
    ],
    ["three of three, fresh, no verdicts", runs(3, 3), 4 / 5, 0.5],
    ["none of three, fresh, all judged fail", runs(3, 0, 0), 1 / 5, 1 / 5],
    ["three of four succeeded, all judged pass", runs(4, 3, 1), 4 / 6, 5 / 6],
    ["score verdicts are averaged", runs(4, 4, 0.5), 5 / 6, 3 / 6],
  ];
  for (const [what, rs, outcome, verdict] of table) {
    test(what, () => {
      const h = stageHistory(rs, NOW, S);
      expect(h.outcomeRate).toBeCloseTo(outcome);
      expect(h.verdictRate).toBeCloseTo(verdict);
      expect(h.stageRecord).toBeCloseTo((outcome + verdict) / 2);
      expect(h.runs).toBe(rs.length);
    });
  }

  test("a run weighs half as much each half-life older, and a run from the future weighs 1", () => {
    const old = stageHistory(runs(3, 0, null, 7 * DAY), NOW, S);
    expect(old.weight).toBeCloseTo(1.5);
    // Three failures a half-life old weigh 1.5: (0 + 1) / (1.5 + 2).
    expect(old.outcomeRate).toBeCloseTo(1 / 3.5);
    expect(stageHistory(runs(3, 0, null, -DAY), NOW, S).weight).toBe(3);
    // Fresh failures pull harder than old ones.
    expect(stageHistory(runs(3, 0), NOW, S).outcomeRate).toBeLessThan(
      old.outcomeRate,
    );
  });

  test("the minimum sample counts verdicts apart from runs", () => {
    const rs = [...runs(3, 3), ...runs(2, 2, 1)];
    const h = stageHistory(rs, NOW, S);
    expect([h.runs, h.verdicts, h.passes]).toEqual([5, 2, 2]);
    expect(h.verdictRate).toBe(0.5);
    expect(stageHistory(rs, NOW, { ...S, minSample: 2 }).verdictRate).toBe(
      3 / 4,
    );
  });

  test("the defaults: a week's half-life, three runs", () => {
    expect(DEFAULT_HISTORY).toEqual({ halfLifeMs: 7 * DAY, minSample: 3 });
  });
});

describe("place: the stage record", () => {
  test("ranks first: a strong record at this stage beats a better board success rate and a longer idle", () => {
    const d = decide(
      agent("agt_a", {
        history: { settled: 10, claimed: 10 },
        roster: { lastDispatchedAtMs: null },
        stageRuns: runs(5, 0, 0),
      }),
      agent("agt_b", { stageRuns: runs(5, 5, 1) }),
    );
    expect(chosen(d)).toBe("agt_b");
  });

  test("a new agent sits at one half: above a poor record, below a good one", () => {
    const d = decide(
      agent("agt_a", { stageRuns: runs(4, 0, 0) }),
      agent("agt_n", { stageRuns: [] }),
      agent("agt_z", { stageRuns: runs(4, 4, 1) }),
    );
    expect(chosen(d)).toBe("agt_z");
    const totals = Object.fromEntries(
      d.candidates.map((r) => [r.candidate.agentId, r.score?.total]),
    );
    expect(totals).toEqual({ agt_a: 1, agt_n: 2, agt_z: 3 });
  });

  test("the record is recorded on every candidate it was read for, with its inputs, and weighs as a term", () => {
    const d = decide(
      agent("agt_a", { stageRuns: runs(4, 3, 1) }),
      agent("agt_b", { stageRuns: [] }),
      agent("agt_x", { roster: { ready: false }, stageRuns: runs(3, 3) }),
    );
    const byId = Object.fromEntries(
      d.candidates.map((r) => [r.candidate.agentId, r]),
    );
    expect(byId.agt_a?.stageHistory).toMatchObject({
      runs: 4,
      succeeded: 3,
      verdicts: 4,
      passes: 4,
    });
    expect(byId.agt_a?.score?.terms.stageRecord).toBeCloseTo(
      (4 / 6 + 5 / 6) / 2,
    );
    expect(byId.agt_b?.score?.terms.stageRecord).toBe(0.5);
    // A rejected candidate is not scored, but what was read of it is still recorded.
    expect(byId.agt_x?.score).toBeNull();
    expect(byId.agt_x?.stageHistory?.runs).toBe(3);
  });

  test("not read: no stage record, nothing recorded, and the order is the board's own", () => {
    const without = decide(
      agent("agt_a", { history: { settled: 4, claimed: 1 } }),
      agent("agt_b", { history: { settled: 4, claimed: 3 } }),
    );
    expect(chosen(without)).toBe("agt_b");
    for (const r of without.candidates) {
      expect(r.stageHistory).toBeNull();
      expect(r.score?.terms).not.toHaveProperty("stageRecord");
    }
  });

  test("read for some eligible candidates and not others: it weighs for nobody", () => {
    const d = decide(
      agent("agt_a", {
        history: { settled: 4, claimed: 3 },
        stageRuns: runs(5, 0, 0),
      }),
      agent("agt_b", {
        history: { settled: 4, claimed: 1 },
      }),
    );
    expect(chosen(d)).toBe("agt_a");
    for (const r of d.candidates)
      expect(r.score?.terms).not.toHaveProperty("stageRecord");
  });

  test("history settings from the input: a minimum sample above the runs leaves both neutral", () => {
    const d = place({
      card: CARD,
      nowMs: NOW,
      history: { halfLifeMs: DAY, minSample: 10 },
      candidates: [
        agent("agt_a", { stageRuns: runs(5, 0, 0) }),
        agent("agt_b", { stageRuns: runs(5, 5, 1) }),
      ],
    });
    // Both neutral: the tie falls to the agent id.
    expect(chosen(d)).toBe("agt_a");
    expect(decisionProblems(d)).toEqual([]);
  });
});
