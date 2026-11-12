import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CANDIDATE_SET,
  decisionProblems,
  place,
  type CandidateFacts,
  type CandidateSet,
  type Decision,
} from "../src/placement/index.ts";
import {
  directLoad,
  rosterLoad,
  type DirectLoadEntry,
} from "../src/sources/index.ts";

/**
 * The wider candidate set: with `all`, an agent that claims with its own token (no bridge row on
 * the board) is a candidate once SuperPipeline reports its load and health, judged by the same
 * filters as a rostered agent; with `roster`, the default, it stays outside, as in the first slice.
 */

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const CARD = { boardId: "brd_a", cardId: "card_a", stageKey: "build" };

function rostered(
  agentId: string,
  over: { busy?: boolean; ready?: boolean; lastAt?: number } = {},
): CandidateFacts {
  return {
    agentId,
    principalId: `prn_${agentId}`,
    pipeline: { eligible: true, reasons: [] },
    roster: { stationId: `stn_${agentId}`, enabled: true },
    load: rosterLoad(agentId, {
      enabled: true,
      ready: over.ready ?? true,
      busy: over.busy ?? false,
      lastDispatchedAt: iso(over.lastAt ?? NOW - 10 * MIN),
    }),
    history: { settled: 0, claimed: 0, noShowsAtMs: [] },
    holds: 0,
  };
}

function direct(
  agentId: string,
  over: Partial<DirectLoadEntry> & {
    reasons?: string[];
    roster?: CandidateFacts["roster"];
  } = {},
): CandidateFacts {
  const { reasons = [], roster = null, ...entry } = over;
  return {
    agentId,
    principalId: `prn_${agentId}`,
    pipeline: { eligible: reasons.length === 0, reasons },
    roster,
    load: directLoad(
      {
        agentId,
        principalId: `prn_${agentId}`,
        inFlight: 0,
        capacity: null,
        lastHeartbeatAt: iso(NOW - 2 * MIN),
        ...entry,
      },
      NOW,
    ),
    history: { settled: 0, claimed: 0, noShowsAtMs: [] },
    holds: 0,
  };
}

function decide(
  set: CandidateSet | undefined,
  ...candidates: CandidateFacts[]
): Decision {
  const d = place({
    card: CARD,
    nowMs: NOW,
    candidates,
    ...(set ? { candidateSet: set } : {}),
  });
  expect(decisionProblems(d)).toEqual([]);
  return d;
}

const verdicts = (d: Decision) =>
  Object.fromEntries(
    d.candidates.map((r) => [
      r.candidate.agentId,
      r.filters
        .filter((f) => !f.passed)
        .map((f) => (f.passed ? "" : f.reason))
        .join(",") || "ok",
    ]),
  );
const sources = (d: Decision) =>
  Object.fromEntries(
    d.candidates.map((r) => [r.candidate.agentId, r.candidate.source]),
  );
const chosen = (d: Decision) => (d.kind === "placed" ? d.chosen : d.reason);

describe("the candidate set", () => {
  test("defaults to the roster: the first slice's behaviour", () => {
    expect(DEFAULT_CANDIDATE_SET).toBe("roster");
  });

  test("roster: an agent with its own token stays outside, even when it reports a healthy idle load", () => {
    for (const set of [undefined, "roster"] as const) {
      const d = decide(
        set,
        rostered("agt_a"),
        rostered("agt_b"),
        direct("agt_d"),
      );
      expect(verdicts(d)).toEqual({
        agt_a: "ok",
        agt_b: "ok",
        agt_d: "not-on-roster",
      });
      expect(sources(d)).toEqual({
        agt_a: "roster",
        agt_b: "roster",
        agt_d: "direct",
      });
    }
  });

  test("all: the direct agent goes through every filter, and the best of the mixed set is chosen", () => {
    // The direct agent has gone longest without work, so it ranks first.
    const d = decide(
      "all",
      rostered("agt_a", { lastAt: NOW - 5 * MIN }),
      direct("agt_d", { lastHeartbeatAt: iso(NOW - 30 * MIN) }),
    );
    expect(verdicts(d)).toEqual({ agt_a: "ok", agt_d: "ok" });
    expect(chosen(d)).toBe("agt_d");
    const record = d.candidates.find((r) => r.candidate.agentId === "agt_d");
    expect(record?.candidate).toEqual({
      agentId: "agt_d",
      principalId: "prn_agt_d",
      stationId: null,
      source: "direct",
    });
    expect(record?.score?.terms.sinceLastDispatchS).toBe(30 * 60);
  });

  test("all: a direct agent beside one rostered agent gives the card a choice", () => {
    expect(chosen(decide("roster", rostered("agt_a"), direct("agt_d")))).toBe(
      "one-candidate",
    );
    expect(chosen(decide("all", rostered("agt_a"), direct("agt_d")))).not.toBe(
      "one-candidate",
    );
  });

  test("all: health and idle come from the shape, for direct agents too", () => {
    const d = decide(
      "all",
      rostered("agt_a"),
      rostered("agt_b", { busy: true }),
      rostered("agt_c", { ready: false }),
      direct("agt_never", { lastHeartbeatAt: null }),
      direct("agt_stale", { lastHeartbeatAt: iso(NOW - 2 * 60 * MIN) }),
      direct("agt_full", { inFlight: 1 }),
      direct("agt_wide", { inFlight: 1, capacity: 2 }),
    );
    expect(verdicts(d)).toEqual({
      agt_a: "ok",
      agt_b: "not-idle",
      agt_c: "unhealthy",
      agt_never: "unhealthy",
      agt_stale: "unhealthy",
      agt_full: "not-idle",
      agt_wide: "ok",
    });
  });

  test("all: SuperPipeline's verdict filters a direct agent as it does a rostered one", () => {
    const d = decide(
      "all",
      rostered("agt_a"),
      rostered("agt_b"),
      direct("agt_cap", { reasons: ["capability_mismatch"] }),
      direct("agt_grant", { reasons: ["grant_denied"] }),
    );
    expect(verdicts(d)).toEqual({
      agt_a: "ok",
      agt_b: "ok",
      agt_cap: "capability-missing",
      agt_grant: "grant-denied",
    });
  });

  test("all: a disabled bridge row keeps the agent out, whatever SuperPipeline reports", () => {
    const d = decide(
      "all",
      rostered("agt_a"),
      rostered("agt_b"),
      direct("agt_off", { roster: { stationId: "stn_off", enabled: false } }),
    );
    expect(verdicts(d).agt_off).toBe("not-on-roster");
    expect(sources(d).agt_off).toBe("roster");
  });

  test("all: an agent with no row and no reported load is outside the set", () => {
    const unreported: CandidateFacts = { ...direct("agt_u"), load: null };
    const d = decide("all", rostered("agt_a"), rostered("agt_b"), unreported);
    expect(verdicts(d).agt_u).toBe("not-on-roster");
  });
});
