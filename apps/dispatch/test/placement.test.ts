import { describe, expect, test } from "bun:test";
import {
  FILTERS,
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
} from "../src/placement/index.ts";

const CARD: CardRef = { boardId: "brd_a", cardId: "crd_a", stageKey: "build" };
const ALL = Object.keys(FILTERS) as FilterName[];

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
  test("are the six the charter names, the no-show refinement's and SuperPipeline's other verdict, one per filter", () => {
    expect([...REJECTION_REASONS].sort()).toEqual([
      "at-capacity",
      "capability-missing",
      "grant-denied",
      "not-claimable",
      "not-idle",
      "not-on-roster",
      "recently-no-show",
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
        reason: "none-eligible",
        candidates: [rejectedBy("agt_a", "health")],
      }),
    ).toEqual([]);
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
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
        chosen: "agt_z",
        candidates: [eligible("agt_a")],
      }),
    ).toEqual(["the chosen agt_z is not a candidate"]);
    expect(
      decisionProblems({
        kind: "placed",
        card: CARD,
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
        reason: "no-candidates",
        candidates: [rejectedBy("agt_a", "idle")],
      }),
    ).toEqual(["no-candidates, with candidates"]);
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
        reason: "none-eligible",
        candidates: [],
      }),
    ).toEqual(["none-eligible, with no candidates"]);
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
        reason: "none-eligible",
        candidates: [eligible("agt_a")],
      }),
    ).toEqual(["none-eligible, with an eligible candidate"]);
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
        reason: "one-candidate",
        candidates: [eligible("agt_a"), eligible("agt_b")],
      }),
    ).toEqual(["one-candidate, with 2 on the roster"]);
    expect(
      decisionProblems({
        kind: "none",
        card: CARD,
        reason: "one-candidate",
        candidates: [eligible("agt_a"), rejectedBy("agt_b", "roster")],
      }),
    ).toEqual([]);
  });
});

// Placement, as a table: each row is the facts for a card's candidates and what must come of them.
const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const MIN = 60_000;

/** An agent with every fact in its favour, unless a row says otherwise. */
function agent(
  agentId: string,
  over: {
    eligible?: boolean;
    reasons?: string[];
    roster?: Partial<NonNullable<CandidateFacts["roster"]>> | null;
    history?: Partial<CandidateFacts["history"]>;
    holds?: number;
  } = {},
): CandidateFacts {
  const reasons = over.reasons ?? [];
  return {
    agentId,
    principalId: `prn_${agentId}`,
    pipeline: { eligible: over.eligible ?? reasons.length === 0, reasons },
    roster:
      over.roster === null
        ? null
        : {
            stationId: `stn_${agentId}`,
            enabled: true,
            ready: true,
            busy: false,
            lastDispatchedAtMs: NOW - 10 * MIN,
            ...over.roster,
          },
    history: { settled: 0, claimed: 0, noShowsAtMs: [], ...over.history },
    holds: over.holds ?? 0,
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
    ).toBe(Object.keys(FILTERS).length);
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
  test("load first: the agent holding fewer cards wins, whatever else", () => {
    const d = decide(
      agent("agt_a", { holds: 1, history: { settled: 10, claimed: 10 } }),
      agent("agt_b", { roster: { lastDispatchedAtMs: NOW } }),
    );
    expect(chosen(d)).toBe("agt_b");
  });

  test("then the success rate on this board, smoothed", () => {
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
      agent("agt_a", { holds: 2 }),
      agent("agt_b"),
      agent("agt_c", { holds: 1 }),
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
          agent("agt_a", { roster: { busy: true } }),
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

  test("the record carries each candidate's principal and station", () => {
    const d = decide(agent("agt_a"), agent("agt_x", { roster: null }));
    expect(d.candidates.map((r) => r.candidate)).toEqual([
      { agentId: "agt_a", principalId: "prn_agt_a", stationId: "stn_agt_a" },
      { agentId: "agt_x", principalId: "prn_agt_x", stationId: null },
    ]);
  });

  test("the policy has a name to record", () => {
    expect(POLICY).toBe("idle-load-success-lru@1");
  });
});
