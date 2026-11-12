import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STALL_AFTER_MS,
  FILTERS,
  MAX_EVIDENCE,
  UNRELIABLE_MIN,
  candidateRecords,
  passed,
  place,
  rejected,
  suggest,
  type CandidateFacts,
  type CandidateRecord,
  type FilterName,
  type LaneDecision,
} from "../src/placement/index.ts";

const ALL = Object.keys(FILTERS) as FilterName[];
const MIN = 60_000;
const T0 = Date.parse("2026-11-13T12:00:00.000Z");

/** A rostered agent that passes every filter but `fail`. */
function onRoster(agentId: string, ...fail: FilterName[]): CandidateRecord {
  return {
    candidate: { agentId, principalId: `prn_${agentId}`, stationId: null },
    filters: ALL.map((f) => (fail.includes(f) ? rejected(f) : passed(f))),
    score: null,
  };
}

/** An agent off the board's roster, with or without the lane's capability. */
function offRoster(agentId: string, capable: boolean | undefined) {
  return {
    candidate: { agentId, principalId: `prn_${agentId}`, stationId: null },
    filters: [rejected("roster")],
    score: null,
    ...(capable === undefined ? {} : { capable }),
  } satisfies CandidateRecord;
}

let n = 0;
function d(
  candidates: CandidateRecord[],
  over: Partial<LaneDecision> = {},
): LaneDecision {
  n++;
  return {
    id: `pld_${String(n).padStart(24, "0")}`,
    boardId: "brd_a",
    cardId: `card_${n}`,
    stageKey: "build",
    attemptsBefore: 0,
    requires: { all: ["code"], any: [] },
    noDecisionReason: null,
    candidates,
    createdAtMs: T0 + n * MIN,
    ...over,
  };
}

describe("suggest: one candidate in the lane", () => {
  test("one rostered agent with the capability, and a capable agent off the roster: add it to the board", () => {
    const a = d([onRoster("agt_a"), offRoster("agt_x", true)], {
      noDecisionReason: "one-candidate",
    });
    expect(suggest({ decisions: [a] })).toEqual([
      {
        kind: "add-agent-to-board",
        boardId: "brd_a",
        stageKey: "build",
        capability: { all: ["code"], any: [] },
        rostered: ["agt_a"],
        candidates: [
          { agentId: "agt_x", principalId: "prn_agt_x", stationId: null },
        ],
        reasons: ["one-candidate"],
        reason:
          "Only agt_a on the board's roster can take this lane; a person could add agt_x to the board's roster.",
        evidence: [a.id],
        evidenceCount: 1,
      },
    ]);
  });

  test("nobody else in the workspace has the capability: the lane is a single point", () => {
    const [s] = suggest({
      decisions: [d([onRoster("agt_a"), offRoster("agt_y", false)])],
    });
    expect(s?.kind).toBe("lane-single-point");
    expect(s?.candidates).toEqual([]);
    expect(s?.reason).toContain(
      "no other agent in the workspace has the capability",
    );
  });

  test("a rostered agent without the capability does not count; one off the roster without it is no candidate", () => {
    const [s] = suggest({
      decisions: [
        d([
          onRoster("agt_a"),
          onRoster("agt_b", "capability"),
          offRoster("agt_x", true),
          offRoster("agt_y", false),
          offRoster("agt_z", undefined),
        ]),
      ],
    });
    expect(s?.rostered).toEqual(["agt_a"]);
    expect(s?.candidates.map((c) => c.agentId)).toEqual(["agt_x"]);
  });

  test("two rostered agents with the capability: nothing to suggest", () => {
    expect(
      suggest({
        decisions: [
          d([onRoster("agt_a"), onRoster("agt_b"), offRoster("agt_x", true)]),
        ],
      }),
    ).toEqual([]);
  });

  test("the latest decision says what the lane is now: one candidate earlier, two now, is nothing", () => {
    expect(
      suggest({
        decisions: [
          d([onRoster("agt_a")]),
          d([onRoster("agt_a"), onRoster("agt_b")]),
        ],
      }),
    ).toEqual([]);
    const [s] = suggest({
      decisions: [
        d([onRoster("agt_a"), onRoster("agt_b")]),
        d([onRoster("agt_a")]),
      ],
    });
    expect(s?.reasons).toEqual(["one-candidate"]);
  });
});

describe("suggest: candidates that keep failing", () => {
  const shaky = () =>
    d([
      onRoster("agt_a", "health"),
      onRoster("agt_b", "noShow"),
      offRoster("agt_x", true),
    ]);

  test(`every rostered agent unhealthy or a no-show in ${UNRELIABLE_MIN} decisions flags the lane`, () => {
    const decisions = Array.from({ length: UNRELIABLE_MIN }, shaky);
    const [s] = suggest({ decisions });
    expect(s?.kind).toBe("add-agent-to-board");
    expect(s?.reasons).toEqual(["unreliable"]);
    expect(s?.evidence).toEqual(decisions.map((x) => x.id));
    expect(s?.evidenceCount).toBe(UNRELIABLE_MIN);
  });

  test("one fewer is not enough, nor are decisions where one agent was fine", () => {
    expect(
      suggest({
        decisions: Array.from({ length: UNRELIABLE_MIN - 1 }, shaky),
      }),
    ).toEqual([]);
    expect(
      suggest({
        decisions: Array.from({ length: UNRELIABLE_MIN + 2 }, () =>
          d([onRoster("agt_a", "health"), onRoster("agt_b", "idle")]),
        ),
      }),
    ).toEqual([]);
  });
});

describe("suggest: a lane with nobody on the roster for it", () => {
  test("is not one candidate, nor unreliable: only a card that waits flags it", () => {
    expect(
      suggest({
        decisions: Array.from({ length: UNRELIABLE_MIN + 1 }, () =>
          d([onRoster("agt_b", "capability"), offRoster("agt_x", true)]),
        ),
      }),
    ).toEqual([]);
  });
});

describe("suggest: a card that waits with nobody eligible", () => {
  const none = (minute: number, over: Partial<LaneDecision> = {}) =>
    d([onRoster("agt_a", "idle"), onRoster("agt_b", "idle")], {
      cardId: "card_stuck",
      noDecisionReason: "none-eligible",
      createdAtMs: T0 + minute * MIN,
      ...over,
    });

  test("waiting at least the threshold, first to last decision, flags the lane", () => {
    const decisions = [none(0), none(10), none(30)];
    const [s] = suggest({ decisions });
    expect(s?.reasons).toEqual(["stalled"]);
    expect(s?.kind).toBe("lane-single-point");
    expect(s?.reason).toContain(
      "A card waited 30 minutes with nobody eligible",
    );
    expect(s?.evidence).toEqual(decisions.map((x) => x.id));
  });

  test("a minute short is not; nor two cards that waited a short while each; nor two attempts", () => {
    expect(suggest({ decisions: [none(0), none(29)] })).toEqual([]);
    expect(
      suggest({
        decisions: [
          none(0, { cardId: "card_1" }),
          none(20, { cardId: "card_1" }),
          none(25, { cardId: "card_2" }),
          none(45, { cardId: "card_2" }),
        ],
      }),
    ).toEqual([]);
    expect(
      suggest({
        decisions: [none(0), none(20), none(40, { attemptsBefore: 1 })],
      }),
    ).toEqual([]);
  });

  test("the threshold is a setting", () => {
    expect(
      suggest({
        decisions: [none(0), none(10)],
        settings: { stallAfterMs: 10 * MIN },
      }),
    ).toHaveLength(1);
    expect(DEFAULT_STALL_AFTER_MS).toBe(30 * MIN);
  });
});

describe("suggest: the record", () => {
  test("lanes are kept apart by board and stage, ordered, and every rule that matched is named", () => {
    const one = (boardId: string, stageKey: string) =>
      d([onRoster("agt_a", "health")], { boardId, stageKey });
    const out = suggest({
      decisions: [
        one("brd_b", "build"),
        one("brd_a", "review"),
        one("brd_a", "build"),
        one("brd_a", "build"),
        one("brd_a", "build"),
      ],
    });
    expect(out.map((s) => [s.boardId, s.stageKey, s.reasons])).toEqual([
      ["brd_a", "build", ["one-candidate", "unreliable"]],
      ["brd_a", "review", ["one-candidate"]],
      ["brd_b", "build", ["one-candidate"]],
    ]);
  });

  test(`evidence lists at most the ${MAX_EVIDENCE} newest decisions, and counts them all`, () => {
    const decisions = Array.from({ length: MAX_EVIDENCE + 5 }, () =>
      d([onRoster("agt_a")]),
    );
    const [s] = suggest({ decisions });
    expect(s?.evidenceCount).toBe(MAX_EVIDENCE + 5);
    expect(s?.evidence).toEqual(
      decisions.slice(-MAX_EVIDENCE).map((x) => x.id),
    );
  });

  test("the capability is the latest one recorded; null when no decision recorded one", () => {
    const [s] = suggest({
      decisions: [
        d([onRoster("agt_a")], { requires: { all: ["old"], any: [] } }),
        d([onRoster("agt_a")], { requires: null }),
      ],
    });
    expect(s?.capability).toEqual({ all: ["old"], any: [] });
    const [t] = suggest({
      decisions: [d([onRoster("agt_a")], { requires: null })],
    });
    expect(t?.capability).toBeNull();
  });

  test("it is a record and nothing else: plain data, no function to act with, the same every time", () => {
    const decisions = [d([onRoster("agt_a"), offRoster("agt_x", true)])];
    const a = suggest({ decisions });
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(suggest({ decisions })).toEqual(a);
    expect(Object.keys(a[0] ?? {}).sort()).toEqual([
      "boardId",
      "candidates",
      "capability",
      "evidence",
      "evidenceCount",
      "kind",
      "reason",
      "reasons",
      "rostered",
      "stageKey",
    ]);
  });

  test("no decisions, nothing to suggest", () => {
    expect(suggest({ decisions: [] })).toEqual([]);
  });
});

describe("place records whether an agent off the roster has the capability", () => {
  const facts = (
    agentId: string,
    rostered: boolean,
    reasons: string[] = [],
  ): CandidateFacts => ({
    agentId,
    principalId: `prn_${agentId}`,
    pipeline: { eligible: reasons.length === 0, reasons },
    roster: rostered
      ? {
          stationId: `stn_${agentId}`,
          enabled: true,
          ready: true,
          busy: false,
          lastDispatchedAtMs: null,
        }
      : null,
    history: { settled: 0, claimed: 0, noShowsAtMs: [] },
    holds: 0,
  });

  test("by SuperPipeline's verdict, off the roster only; and the record reads back from JSON", () => {
    const decision = place({
      card: { boardId: "brd_a", cardId: "card_a", stageKey: "build" },
      nowMs: T0,
      candidates: [
        facts("agt_a", true),
        facts("agt_x", false),
        facts("agt_y", false, ["capability_mismatch"]),
      ],
    });
    expect(
      decision.candidates.map((r) => [r.candidate.agentId, r.capable]),
    ).toEqual([
      ["agt_a", undefined],
      ["agt_x", true],
      ["agt_y", false],
    ]);
    const back = candidateRecords(
      JSON.parse(JSON.stringify(decision.candidates)),
    );
    expect(
      back.map((r) => [r.candidate.agentId, r.filters, r.capable]),
    ).toEqual(
      decision.candidates.map((r) => [
        r.candidate.agentId,
        r.filters,
        r.capable,
      ]),
    );
    const [s] = suggest({
      decisions: [
        {
          id: "pld_x",
          boardId: "brd_a",
          cardId: "card_a",
          stageKey: "build",
          attemptsBefore: 0,
          requires: null,
          noDecisionReason: decision.kind === "none" ? decision.reason : null,
          candidates: back,
          createdAtMs: T0,
        },
      ],
    });
    expect(s?.candidates.map((c) => c.agentId)).toEqual(["agt_x"]);
  });

  test("a record that is not one is left out when read back", () => {
    expect(
      candidateRecords([
        null,
        { candidate: {} },
        { candidate: { agentId: "agt_a" } },
        { candidate: { agentId: "agt_b" }, filters: [{ filter: "roster" }] },
        { candidate: { agentId: "agt_c" }, filters: [], capable: "yes" },
      ]),
    ).toEqual([
      {
        candidate: { agentId: "agt_c", principalId: null, stationId: null },
        filters: [],
        score: null,
      },
    ]);
    expect(candidateRecords("nope")).toEqual([]);
  });
});
