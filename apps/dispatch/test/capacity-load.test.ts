/**
 * An agent SuperPipeline reports at its board's concurrency is waited for, as load, even while its
 * station reads idle: the bridge answers not ready at its concurrency, and that passes with the work.
 */
import { describe, expect, test } from "bun:test";
import { place, type CandidateFacts } from "../src/placement/index.ts";
import { rosterLoad } from "../src/sources/index.ts";

const BOARD = "brd_00000000000000b1";
const CARD = "card_00000000000000c1";
const T0 = Date.parse("2026-11-13T09:00:00.000Z");

describe("an agent at its concurrency whose station reads idle", () => {
  /** A rostered candidate SuperPipeline judged, with its bridge row. */
  const candidate = (
    agentId: string,
    reasons: string[],
    row: { ready: boolean; busy: boolean },
  ): CandidateFacts => ({
    agentId,
    principalId: `prn_${agentId}`,
    pipeline: { eligible: reasons.length === 0, reasons },
    roster: { stationId: `stn_${agentId}`, enabled: true },
    load: rosterLoad(agentId, {
      enabled: true,
      ...row,
      lastDispatchedAt: null,
    }),
    history: { settled: 0, claimed: 0, noShowsAtMs: [] },
    holds: 0,
  });

  test("is waited for: unhealthy and at capacity, while busy is false, is load", () => {
    // The staging proof's B: the bridge answered not ready because the agent held its board's
    // concurrency, and its station read not busy. A may not take the card at all.
    const decision = place({
      card: { boardId: BOARD, cardId: CARD, stageKey: "build" },
      nowMs: T0,
      candidates: [
        candidate("agt_a", ["grant_denied"], { ready: true, busy: false }),
        candidate("agt_b", ["concurrency_reached"], {
          ready: false,
          busy: false,
        }),
      ],
    });
    expect(decision).toMatchObject({ kind: "none", reason: "waiting-on-load" });
  });

  test("unhealthy with room to spare is still not waited for", () => {
    const decision = place({
      card: { boardId: BOARD, cardId: CARD, stageKey: "build" },
      nowMs: T0,
      candidates: [
        candidate("agt_a", [], { ready: false, busy: false }),
        candidate("agt_b", [], { ready: false, busy: false }),
      ],
    });
    expect(decision).toMatchObject({ kind: "none", reason: "none-eligible" });
  });
});
