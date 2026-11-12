import { describe, expect, test } from "bun:test";
import {
  FILTERS,
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
  test("are exactly the six the charter names, one per filter", () => {
    expect([...REJECTION_REASONS].sort()).toEqual([
      "at-capacity",
      "capability-missing",
      "grant-denied",
      "not-idle",
      "not-on-roster",
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
        reason: "not-placing",
        candidates: [unscored, scoredReject, infinite],
      }),
    ).toEqual([
      "agt_a passed every filter and has no score",
      "agt_b is scored without passing every filter",
      "agt_c has a score that is not a finite number",
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
        reason: "not-placing",
        candidates: [eligible("agt_a"), eligible("agt_a"), twice, mislabelled],
      }),
    ).toEqual([
      "agt_a is a candidate twice",
      "agt_b went through roster twice",
      "agt_c was rejected by idle as unhealthy, not not-idle",
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
  });
});

describe("place", () => {
  test("decides nothing yet, for the card it was given, and the result holds", () => {
    const decision = place({
      card: CARD,
      candidates: [{ agentId: "agt_a" }, { agentId: "agt_b" }],
    });
    expect(decision).toEqual({
      kind: "none",
      card: CARD,
      reason: "not-placing",
      candidates: [],
    });
    expect(decisionProblems(decision)).toEqual([]);
  });
});
