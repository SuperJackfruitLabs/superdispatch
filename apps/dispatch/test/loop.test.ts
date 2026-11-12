import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_CARDS_PER_PASS,
  NUDGE_DELAY_MS,
  REDECIDE_AFTER_MS,
  SWEEP_MAX_BACKOFF,
  DEFAULT_SUGGESTIONS,
  createLoop,
  ladderOf,
  refreshSuggestions,
  type SuggestionSettings,
  outcomeOf,
  shouldDecide,
  startRunner,
  type Loop,
} from "../src/loop/index.ts";
import {
  SourceError,
  type Agentpod,
  type BoardView,
  type CardView,
  type DirectLoadEntry,
  type EligibilityView,
  type ReserveAnswer,
  type RosterEntry,
  type Superpipeline,
  type Superwitness,
} from "../src/sources/index.ts";
import type { CandidateRecord, TierSettings } from "../src/placement/index.ts";
import type { CandidateSet, Fairness } from "../src/config.ts";
import { tempStore } from "./helpers.ts";

const BOARD = "brd_00000000000000b1";
const QUIET = "brd_00000000000000b2";
const CARD = "card_00000000000000c1";
const T0 = Date.parse("2026-11-12T12:00:00.000Z");
const S = 1000;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/**
 * Boards in SuperPipeline (`BOARD`, and `QUIET` beside it) and their roster in AgentPod (the same
 * agents on both), in memory, that hold reservations the way SuperPipeline's step 1 does: until a
 * time, and only for an agent the eligibility read allows.
 */
function world(
  options: {
    tiers?: Partial<TierSettings>;
    fairness?: Fairness;
    suggestions?: SuggestionSettings;
    superwitness?: Superwitness;
    candidateSet?: CandidateSet;
  } = {},
) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  let syncs = 0;
  const sync = t.store.syncSuggestions;
  t.store.syncSuggestions = (...args) => {
    syncs++;
    return sync(...args);
  };
  let now = T0;
  let ids = 0;
  const calls: string[] = [];
  const log: string[] = [];

  const stages: BoardView["stages"] = [
    {
      key: "build",
      ownerKind: "capability",
      hasRequires: false,
      requires: { all: ["code"], any: [] },
    },
    {
      key: "approve",
      ownerKind: "human",
      hasRequires: false,
      requires: { all: [], any: [] },
    },
    {
      key: "pinned",
      ownerKind: "agent",
      hasRequires: false,
      requires: { all: [], any: [] },
    },
  ];
  const boards = new Map<string, Map<string, CardView>>([
    [BOARD, new Map()],
    [QUIET, new Map()],
  ]);
  const cards = boards.get(BOARD)!;
  const boardOf = (cardId: string) =>
    [...boards.values()].find((b) => b.has(cardId))!;
  const addCard = (
    id: string,
    over: Partial<CardView> = {},
    boardId: string = BOARD,
  ) =>
    boards.get(boardId)!.set(id, {
      id,
      stageKey: "build",
      state: "submitted",
      currentRunId: null,
      lastAgentId: null,
      attemptCount: 0,
      priority: 0,
      createdAt: new Date(T0 - 60 * S).toISOString(),
      archived: false,
      reservation: null,
      ...over,
    });
  /** SuperPipeline's agents: id → principal and per-agent reasons. */
  const agents = new Map<string, { principalId: string; reasons: string[] }>();
  const roster = new Map<string, RosterEntry>();
  /** SuperPipeline's load read: agent → what it reports. */
  const load = new Map<string, DirectLoadEntry>();
  let loadFails = false;
  const addAgent = (
    agentId: string,
    over: { reasons?: string[]; roster?: Partial<RosterEntry> | null } = {},
  ) => {
    const principalId = `prn_${agentId}`;
    agents.set(agentId, { principalId, reasons: over.reasons ?? [] });
    if (over.roster !== null)
      roster.set(principalId, {
        key: agentId,
        stationId: `stn_${agentId}`,
        principalId,
        enabled: true,
        ready: true,
        busy: false,
        lastDispatchedAt: new Date(T0 - 3600 * S).toISOString(),
        ...over.roster,
      });
  };
  const holds = new Map<
    string,
    { agentId: string; until: number; decisionId: string }
  >();
  let reserveAnswer: ((cardId: string) => ReserveAnswer | "throw") | null =
    null;
  let rosterFails = false;
  let cardReasons: string[] = [];

  const superpipeline: Superpipeline = {
    async board(boardId) {
      calls.push(`board ${boardId}`);
      const board = boards.get(boardId);
      if (board === undefined)
        throw new SourceError("superpipeline", 404, "not found");
      return {
        boardId,
        stages,
        cards: [...board.values()].map((c) => ({ ...c })),
      };
    },
    async eligibility(boardId, cardId): Promise<EligibilityView> {
      calls.push(`eligibility ${cardId}`);
      const card = boards.get(boardId)!.get(cardId)!;
      const hold = holds.get(cardId);
      return {
        stageKey: card.stageKey,
        reasons: cardReasons,
        agents: [...agents].map(([agentId, a]) => {
          const reasons = [...a.reasons];
          if (hold && hold.until > now && hold.agentId !== agentId)
            reasons.push("card_reserved");
          return {
            agentId,
            principalId: a.principalId,
            eligible: reasons.length === 0,
            reasons,
          };
        }),
      };
    },
    async reserve(boardId, cardId, hold) {
      calls.push(`reserve ${cardId} ${hold.agentId} ${hold.ttlSeconds}`);
      const scripted = reserveAnswer?.(cardId);
      if (scripted === "throw")
        throw new SourceError("superpipeline", 0, "unreachable");
      if (scripted) return scripted;
      const until = now + hold.ttlSeconds * S;
      holds.set(cardId, {
        agentId: hold.agentId,
        until,
        decisionId: hold.decisionId,
      });
      return { ok: true, reservedUntil: new Date(until).toISOString() };
    },
    async clearReservation(_b, cardId) {
      calls.push(`clear ${cardId}`);
    },
    async agentLoad() {
      calls.push("agent-load");
      if (loadFails) throw new SourceError("superpipeline", 404, "not found");
      return [...load.values()];
    },
  };
  const agentpod: Agentpod = {
    async roster(boardId) {
      calls.push(`roster ${boardId}`);
      if (rosterFails) throw new SourceError("agentpod", 404, "Not Found");
      return [...roster.values()];
    },
  };
  const loop = createLoop({
    store: t.store,
    superpipeline,
    agentpod,
    tiers: {
      winnerSeconds: 60,
      runnerUpSeconds: 30,
      topK: 3,
      ...options.tiers,
    },
    fairness: options.fairness ?? "round-robin",
    ...(options.candidateSet ? { candidateSet: options.candidateSet } : {}),
    ...(options.suggestions ? { suggestions: options.suggestions } : {}),
    ...(options.superwitness ? { superwitness: options.superwitness } : {}),
    now: () => now,
    newId: () => `pld_${String(++ids).padStart(24, "0")}`,
    newSuggestionId: () => `sug_${String(++ids).padStart(24, "0")}`,
    log: (line) => log.push(line),
  });
  /** An agent claims a card, as SuperPipeline's claim would record it. */
  const claim = (cardId: string, agentId: string) => {
    const board = boardOf(cardId);
    const c = board.get(cardId)!;
    board.set(cardId, {
      ...c,
      state: "working",
      currentRunId: `run_${c.attemptCount + 1}`,
      lastAgentId: agentId,
      attemptCount: c.attemptCount + 1,
      reservation: null,
    });
    holds.delete(cardId);
  };
  /** The claimed card comes back to the lane, waiting again: a returned or reclaimed attempt. */
  const giveBack = (cardId: string) => {
    const board = boardOf(cardId);
    const c = board.get(cardId)!;
    board.set(cardId, { ...c, state: "submitted", currentRunId: null });
  };
  return {
    store: t.store,
    loop,
    superpipeline,
    agentpod,
    get syncs() {
      return syncs;
    },
    calls,
    log,
    cards,
    holds,
    roster,
    load,
    addCard,
    addAgent,
    claim,
    giveBack,
    advance: (ms: number) => {
      now += ms;
    },
    set reserveAnswer(f: ((cardId: string) => ReserveAnswer | "throw") | null) {
      reserveAnswer = f;
    },
    set loadFails(v: boolean) {
      loadFails = v;
    },
    set rosterFails(v: boolean) {
      rosterFails = v;
    },
    set cardReasons(v: string[]) {
      cardReasons = v;
    },
  };
}

/** The verdict on each candidate of a recorded decision. */
function verdicts(candidates: unknown): Record<string, string> {
  return Object.fromEntries(
    (candidates as CandidateRecord[]).map((r) => [
      r.candidate.agentId,
      r.filters
        .filter((f) => !f.passed)
        .map((f) => (f.passed ? "" : f.reason))
        .join(",") || "ok",
    ]),
  );
}

function opted(w: ReturnType<typeof world>) {
  w.store.enableBoard(BOARD, new Date(T0).toISOString());
}

describe("one pass: placing a ready card", () => {
  test("two idle rostered agents: the least recently used is chosen, held for 60 s, and the record says why", async () => {
    const w = world();
    w.addCard(CARD);
    w.addAgent("agt_a", {
      roster: { lastDispatchedAt: new Date(T0 - 60 * S).toISOString() },
    });
    w.addAgent("agt_b");
    w.addAgent("agt_x", { roster: null });
    const pass = await w.loop.passBoard(BOARD);
    expect(pass).toEqual({
      boardId: BOARD,
      settled: 0,
      decided: 1,
      reserved: 1,
      deferred: 0,
    });
    expect(w.calls).toEqual([
      `board ${BOARD}`,
      `roster ${BOARD}`,
      `eligibility ${CARD}`,
      `reserve ${CARD} agt_b 60`,
    ]);
    const [d] = w.store.listDecisions({ limit: 10 });
    expect(d).toMatchObject({
      boardId: BOARD,
      cardId: CARD,
      stageKey: "build",
      policy: "idle-stage-success-lru@3",
      chosenAgent: "agt_b",
      noDecisionReason: null,
      attemptsBefore: 0,
      tier: "winner",
      tierStep: 1,
      reservedUntil: new Date(T0 + 60 * S).toISOString(),
      outcome: null,
    });
    expect(verdicts(d?.candidates)).toEqual({
      agt_a: "ok",
      agt_b: "ok",
      agt_x: "not-on-roster",
    });
    expect(w.holds.get(CARD)?.decisionId).toBe(d?.id ?? "");
  });

  test("a busy agent is not held for; the idle one is", async () => {
    const w = world();
    w.addCard(CARD);
    w.addAgent("agt_a", { roster: { busy: true, lastDispatchedAt: null } });
    w.addAgent("agt_b");
    await w.loop.passBoard(BOARD);
    const [d] = w.store.listDecisions({ limit: 1 });
    expect(d?.chosenAgent).toBe("agt_b");
    expect(verdicts(d?.candidates).agt_a).toBe("not-idle");
  });

  test("two ready cards and two idle agents: one card each, one live hold per agent", async () => {
    const w = world();
    w.addCard("card_00000000000000c1", { priority: 1 });
    w.addCard("card_00000000000000c2");
    w.addAgent("agt_a");
    w.addAgent("agt_b");
    await w.loop.passBoard(BOARD);
    expect(w.holds.get("card_00000000000000c1")?.agentId).toBe("agt_a");
    expect(w.holds.get("card_00000000000000c2")?.agentId).toBe("agt_b");
  });

  test("one agent on the roster: recorded as one-candidate, nothing held, not decided again for five minutes", async () => {
    const w = world();
    w.addCard(CARD);
    w.addAgent("agt_a");
    w.addAgent("agt_x", { roster: null });
    await w.loop.passBoard(BOARD);
    expect(
      w.store.listDecisions({ limit: 10 }).map((d) => d.noDecisionReason),
    ).toEqual(["one-candidate"]);
    expect(w.holds.size).toBe(0);
    w.advance(REDECIDE_AFTER_MS - S);
    await w.loop.passBoard(BOARD);
    expect(w.store.listDecisions({ limit: 10 })).toHaveLength(1);
    w.advance(S);
    await w.loop.passBoard(BOARD);
    expect(w.store.listDecisions({ limit: 10 })).toHaveLength(2);
  });

  test("a card nobody may claim now, a person's stage, a pinned stage, a card at work and one already held are not placed", async () => {
    const w = world();
    w.addAgent("agt_a");
    w.addAgent("agt_b");
    w.addCard("card_00000000000000c1", { stageKey: "approve" });
    w.addCard("card_00000000000000c2", { stageKey: "pinned" });
    w.addCard("card_00000000000000c3", {
      state: "working",
      currentRunId: "run_1",
    });
    w.addCard("card_00000000000000c4", {
      reservation: {
        agentId: "agt_z",
        reservedUntil: new Date(T0 + 30 * S).toISOString(),
      },
    });
    w.addCard("card_00000000000000c5", { archived: true });
    await w.loop.passBoard(BOARD);
    expect(w.calls).toEqual([`board ${BOARD}`]);
    // And a card whose own eligibility reasons say nobody may claim it now.
    w.addCard(CARD);
    w.cardReasons = ["board_over_budget"];
    await w.loop.passBoard(BOARD);
    expect(w.calls.filter((c) => c.startsWith("reserve"))).toEqual([]);
    expect(w.store.listDecisions({ limit: 10 })).toEqual([]);
  });

  test(`at most ${MAX_CARDS_PER_PASS} cards a pass are looked at; those only waiting on held agents are not recorded`, async () => {
    const w = world();
    w.addAgent("agt_a");
    w.addAgent("agt_b");
    for (let i = 0; i < MAX_CARDS_PER_PASS + 3; i++)
      w.addCard(`card_${i.toString(16).padStart(16, "0")}`);
    const pass = await w.loop.passBoard(BOARD);
    expect(w.calls.filter((c) => c.startsWith("eligibility"))).toHaveLength(
      MAX_CARDS_PER_PASS,
    );
    expect(pass).toMatchObject({
      decided: 2,
      reserved: 2,
      deferred: MAX_CARDS_PER_PASS - 2,
    });
    expect(w.store.listDecisions({ limit: 100 })).toHaveLength(2);
  });
});

describe("the next pass: what became of the card", () => {
  async function held() {
    const w = world();
    w.addCard(CARD);
    w.addAgent("agt_a");
    w.addAgent("agt_b", {
      roster: { lastDispatchedAt: new Date(T0 - 60 * S).toISOString() },
    });
    await w.loop.passBoard(BOARD);
    const id = w.store.listDecisions({ limit: 1 })[0]!.id;
    expect(w.store.getDecision(id)?.chosenAgent).toBe("agt_a");
    return { w, id };
  }

  test("claimed by the chosen agent", async () => {
    const { w, id } = await held();
    w.claim(CARD, "agt_a");
    w.advance(10 * S);
    expect((await w.loop.passBoard(BOARD)).settled).toBe(1);
    expect(w.store.getDecision(id)).toMatchObject({
      outcome: "claimed",
      outcomeBy: "agt_a",
      outcomeAt: new Date(T0 + 10 * S).toISOString(),
    });
  });

  test("claimed by somebody else", async () => {
    const { w, id } = await held();
    w.claim(CARD, "agt_z");
    await w.loop.passBoard(BOARD);
    expect(w.store.getDecision(id)).toMatchObject({
      outcome: "claimed-by-other",
      outcomeBy: "agt_z",
    });
  });

  test("still waiting while the hold lasts; expired once it lapses, then placed again", async () => {
    const { w, id } = await held();
    w.advance(59 * S);
    // While its hold lasts the card is neither settled nor decided again: the hold is the decision.
    expect(await w.loop.passBoard(BOARD)).toMatchObject({
      settled: 0,
      decided: 0,
    });
    expect(w.store.getDecision(id)?.outcome).toBeNull();
    w.advance(S);
    const pass = await w.loop.passBoard(BOARD);
    expect(pass).toMatchObject({ settled: 1, decided: 1 });
    expect(w.store.getDecision(id)?.outcome).toBe("expired");
    // The winner is passed over: the runner-up is held for, for the runner-up window.
    expect(w.store.listDecisions({ limit: 1 })[0]).toMatchObject({
      chosenAgent: "agt_b",
      tier: "runner-up",
      tierStep: 2,
    });
    expect(w.calls.at(-1)).toBe(`reserve ${CARD} agt_b 30`);
  });

  test("an agent whose holds lapse twice, on any cards, is shut out as a no-show, and comes back once they age out", async () => {
    const w = world();
    w.addCard(CARD);
    w.addAgent("agt_a");
    w.addAgent("agt_b", { roster: { ready: false } });
    // agt_a is the only healthy agent: held for it as the winner, lapsed. With nobody else free, the
    // runner-up step opens the card to any match.
    await w.loop.passBoard(BOARD);
    w.advance(61 * S);
    await w.loop.passBoard(BOARD);
    // A second card: agt_a wins again (one lapse is not enough), and lapses again.
    w.addCard("card_00000000000000c2");
    w.advance(S);
    await w.loop.passBoard(BOARD);
    w.advance(61 * S);
    await w.loop.passBoard(BOARD);
    // A third card: agt_a is shut out.
    w.addCard("card_00000000000000c3");
    await w.loop.passBoard(BOARD);
    const all = w.store.listDecisions({ limit: 10 }).reverse();
    expect(
      all.map((d) => [d.cardId.slice(-2), d.chosenAgent, d.tier, d.outcome]),
    ).toEqual([
      ["c1", "agt_a", "winner", "expired"],
      ["c1", null, "any-match", null],
      ["c2", "agt_a", "winner", "expired"],
      ["c2", null, "any-match", null],
      ["c3", null, "winner", null],
    ]);
    expect(all[4]?.noDecisionReason).toBe("none-eligible");
    expect(verdicts(all[4]?.candidates)).toEqual({
      agt_a: "recently-no-show",
      agt_b: "unhealthy",
    });
    // On the open cards it is passed over and a no-show, but pull still lets it claim them.
    expect(verdicts(all[3]?.candidates).agt_a).toBe(
      "recently-no-show,passed-over",
    );
    // Half an hour after the first lapse it has aged out of the window, and agt_a is a candidate again.
    w.advance(30 * 60 * S);
    await w.loop.passBoard(BOARD);
    const latest = w.store.latestDecision(BOARD, "card_00000000000000c3")!;
    expect(verdicts(latest.candidates).agt_a).toBe("ok");
    expect(latest.chosenAgent).toBe("agt_a");
  });

  test("moved or archived by a person without a claim: superseded", async () => {
    const moved = await held();
    moved.w.cards.set(CARD, {
      ...moved.w.cards.get(CARD)!,
      stageKey: "approve",
    });
    await moved.w.loop.passBoard(BOARD);
    expect(moved.w.store.getDecision(moved.id)?.outcome).toBe("superseded");
    const gone = await held();
    gone.w.cards.delete(CARD);
    await gone.w.loop.passBoard(BOARD);
    expect(gone.w.store.getDecision(gone.id)?.outcome).toBe("superseded");
  });
});

describe("tiers: a ladder of holds per card", () => {
  /** Three idle agents; agt_a, agt_b, agt_c rank in that order (by id, all else equal). */
  function three(options: Parameters<typeof world>[0] = {}) {
    const w = world(options);
    w.addCard(CARD);
    w.addAgent("agt_a");
    w.addAgent("agt_b");
    w.addAgent("agt_c");
    return w;
  }
  const steps = (w: ReturnType<typeof world>) =>
    w.store
      .listDecisions({ cardId: CARD, limit: 20 })
      .reverse()
      .map((d) => [d.tier, d.tierStep, d.chosenAgent, d.outcome]);
  const reserves = (w: ReturnType<typeof world>) =>
    w.calls.filter((c) => c.startsWith("reserve"));

  test("winner for 60 s, then each runner-up for 30 s, then open to any match: every step labelled", async () => {
    const w = three();
    await w.loop.passBoard(BOARD);
    w.advance(60 * S);
    await w.loop.passBoard(BOARD);
    w.advance(30 * S);
    await w.loop.passBoard(BOARD);
    w.advance(30 * S);
    await w.loop.passBoard(BOARD);
    expect(reserves(w)).toEqual([
      `reserve ${CARD} agt_a 60`,
      `reserve ${CARD} agt_b 30`,
      `reserve ${CARD} agt_c 30`,
    ]);
    expect(steps(w)).toEqual([
      ["winner", 1, "agt_a", "expired"],
      ["runner-up", 2, "agt_b", "expired"],
      ["runner-up", 3, "agt_c", "expired"],
      ["any-match", 4, null, null],
    ]);
    const open = w.store.latestDecision(BOARD, CARD)!;
    expect(open.noDecisionReason).toBe("any-match");
    expect(verdicts(open.candidates)).toEqual({
      agt_a: "passed-over",
      agt_b: "passed-over",
      agt_c: "passed-over",
    });
    // Open to any match: nothing more is held, however long it waits.
    w.advance(REDECIDE_AFTER_MS * 3);
    await w.loop.passBoard(BOARD);
    expect(reserves(w)).toHaveLength(3);
    expect(steps(w)).toHaveLength(4);
    // Pull decides; the open decision is settled with whoever claimed.
    w.claim(CARD, "agt_b");
    await w.loop.passBoard(BOARD);
    expect(w.store.getDecision(open.id)).toMatchObject({
      outcome: "claimed-by-other",
      outcomeBy: "agt_b",
    });
  });

  test("a claim in the winner's hold settles the winner tier as claimed", async () => {
    const w = three();
    await w.loop.passBoard(BOARD);
    w.claim(CARD, "agt_a");
    await w.loop.passBoard(BOARD);
    expect(steps(w)).toEqual([["winner", 1, "agt_a", "claimed"]]);
  });

  test("a claim in a runner-up's hold settles that step as claimed, and counts for it on the board", async () => {
    const w = three();
    await w.loop.passBoard(BOARD);
    w.advance(60 * S);
    await w.loop.passBoard(BOARD);
    w.claim(CARD, "agt_b");
    w.advance(5 * S);
    await w.loop.passBoard(BOARD);
    expect(steps(w)).toEqual([
      ["winner", 1, "agt_a", "expired"],
      ["runner-up", 2, "agt_b", "claimed"],
    ]);
    expect(w.store.boardHistory(BOARD).get("agt_b")).toEqual({
      settled: 1,
      claimed: 1,
    });
  });

  test("the winner claiming late, after its hold lapsed but before the next pass, is a claim, not a no-show", async () => {
    const w = three();
    await w.loop.passBoard(BOARD);
    w.advance(70 * S);
    w.claim(CARD, "agt_a");
    await w.loop.passBoard(BOARD);
    expect(steps(w)).toEqual([["winner", 1, "agt_a", "claimed"]]);
    expect(w.store.noShowsSince(new Date(T0).toISOString()).size).toBe(0);
  });

  test("a card back after a claim starts a new ladder: the winner tier, and nobody passed over", async () => {
    const w = three();
    await w.loop.passBoard(BOARD);
    w.advance(60 * S);
    await w.loop.passBoard(BOARD);
    w.claim(CARD, "agt_b");
    await w.loop.passBoard(BOARD);
    w.giveBack(CARD);
    w.advance(S);
    await w.loop.passBoard(BOARD);
    const latest = w.store.latestDecision(BOARD, CARD)!;
    expect(latest).toMatchObject({
      tier: "winner",
      tierStep: 1,
      attemptsBefore: 1,
    });
    // agt_a's lapse counts against its success rate, not as a pass-over on the new ladder; agt_b's
    // claim counts for it.
    expect(verdicts(latest.candidates)).toEqual({
      agt_a: "ok",
      agt_b: "ok",
      agt_c: "ok",
    });
    expect(latest.chosenAgent).toBe("agt_b");
  });

  test("a card a person moved away and back mid-ladder starts again at the winner", async () => {
    const w = three();
    await w.loop.passBoard(BOARD);
    w.advance(60 * S);
    await w.loop.passBoard(BOARD);
    const card = w.cards.get(CARD)!;
    w.cards.set(CARD, { ...card, stageKey: "approve" });
    await w.loop.passBoard(BOARD);
    w.cards.set(CARD, { ...card, stageKey: "build" });
    w.advance(S);
    await w.loop.passBoard(BOARD);
    expect(steps(w)).toEqual([
      ["winner", 1, "agt_a", "expired"],
      ["runner-up", 2, "agt_b", "superseded"],
      // A new ladder: agt_b, whose step was cut short by the move, is not passed over; agt_a's
      // lapse still counts against it.
      ["winner", 1, "agt_b", null],
    ]);
  });

  test("the settings: k = 1 opens the card after the winner; the runner-up window is the setting's", async () => {
    const one = three({ tiers: { topK: 1 } });
    await one.loop.passBoard(BOARD);
    one.advance(60 * S);
    await one.loop.passBoard(BOARD);
    expect(steps(one)).toEqual([
      ["winner", 1, "agt_a", "expired"],
      ["any-match", 2, null, null],
    ]);
    const slow = three({ tiers: { winnerSeconds: 90, runnerUpSeconds: 45 } });
    await slow.loop.passBoard(BOARD);
    slow.advance(90 * S);
    await slow.loop.passBoard(BOARD);
    expect(reserves(slow)).toEqual([
      `reserve ${CARD} agt_a 90`,
      `reserve ${CARD} agt_b 45`,
    ]);
  });

  test("a runner-up step whose candidates all hold other cards waits, unrecorded, and is held once one is free", async () => {
    const w = world();
    w.addCard(CARD, { priority: 1 });
    w.addCard("card_00000000000000c2");
    w.addAgent("agt_a");
    w.addAgent("agt_b");
    // c1 → agt_a, c2 → agt_b.
    await w.loop.passBoard(BOARD);
    w.advance(60 * S);
    // Both lapse. c1's runner-up is agt_b, c2's is agt_a: each is free again.
    await w.loop.passBoard(BOARD);
    expect(
      w.store
        .listDecisions({ limit: 10 })
        .reverse()
        .map((d) => [d.cardId.slice(-2), d.tier, d.chosenAgent]),
    ).toEqual([
      ["c1", "winner", "agt_a"],
      ["c2", "winner", "agt_b"],
      ["c1", "runner-up", "agt_b"],
      ["c2", "runner-up", "agt_a"],
    ]);
    // A third card while both hold one: it waits, and nothing is recorded for it.
    w.addCard("card_00000000000000c3");
    const pass = await w.loop.passBoard(BOARD);
    expect(pass).toMatchObject({ decided: 0, deferred: 1 });
    expect(w.store.latestDecision(BOARD, "card_00000000000000c3")).toBeNull();
    // agt_a claims c2, so it holds nothing (and its station has not reported the work yet): c3 is
    // held for it on the next pass, while agt_b still holds c1.
    w.claim("card_00000000000000c2", "agt_a");
    w.advance(5 * S);
    await w.loop.passBoard(BOARD);
    expect(
      w.store.latestDecision(BOARD, "card_00000000000000c3"),
    ).toMatchObject({ tier: "winner", tierStep: 1, chosenAgent: "agt_a" });
  });

  test("a card whose candidates are all busy waits, unrecorded, and is held for the first to free up", async () => {
    const w = world();
    w.addCard(CARD);
    // Both have work in hand, so the bridge answers not ready for each.
    w.addAgent("agt_a", { roster: { busy: true, ready: false } });
    w.addAgent("agt_b", { roster: { busy: true, ready: false } });
    const first = await w.loop.passBoard(BOARD);
    expect(first).toMatchObject({ decided: 0, deferred: 1 });
    expect(w.store.latestDecision(BOARD, CARD)).toBeNull();
    // agt_b finishes its work: the very next pass holds the card for it, with no redecide wait.
    w.advance(5 * S);
    w.roster.set("prn_agt_b", {
      ...w.roster.get("prn_agt_b")!,
      busy: false,
      ready: true,
    });
    await w.loop.passBoard(BOARD);
    const placed = w.store.latestDecision(BOARD, CARD)!;
    expect(placed).toMatchObject({ tier: "winner", chosenAgent: "agt_b" });
    expect(verdicts(placed.candidates)).toEqual({
      agt_a: "unhealthy,not-idle",
      agt_b: "ok",
    });
  });
});

describe("fairness across boards", () => {
  /** A busy board with three cards ready before the quiet board's one, and two free agents. */
  function contested(fairness: Fairness = "round-robin") {
    const w = world({ fairness });
    w.store.enableBoard(BOARD, new Date(T0).toISOString());
    w.store.enableBoard(QUIET, new Date(T0).toISOString());
    for (const n of [1, 2, 3])
      w.addCard(`card_00000000000000b${n}`, {
        createdAt: new Date(T0 - 60 * S + n).toISOString(),
      });
    w.addCard(
      "card_00000000000000q1",
      { createdAt: new Date(T0 - 10 * S).toISOString() },
      QUIET,
    );
    w.addAgent("agt_a");
    w.addAgent("agt_b");
    return w;
  }
  const holdsByBoard = (w: ReturnType<typeof world>) =>
    w.store
      .listDecisions({ limit: 20 })
      .reverse()
      .filter((d) => d.reservedUntil !== null)
      .map((d) => `${d.boardId === QUIET ? "quiet" : "busy"} ${d.chosenAgent}`);

  test("a sweep takes one card from each board a round: the busy board and the quiet board both get a hold", async () => {
    const w = contested();
    expect(await w.loop.passAll()).toEqual({ boards: 2, failedBoards: 0 });
    expect(holdsByBoard(w)).toEqual(["busy agt_a", "quiet agt_b"]);
  });

  test("without fairness (board order) the busy board takes every free agent, and the quiet board gets none", async () => {
    const w = contested("board-order");
    await w.loop.passAll();
    expect(holdsByBoard(w)).toEqual(["busy agt_a", "busy agt_b"]);
  });

  test("the quiet board's card is held on the next sweep too, while the busy board's rest wait", async () => {
    const w = contested();
    await w.loop.passAll();
    w.advance(10 * S);
    await w.loop.passAll();
    expect(holdsByBoard(w)).toEqual(["busy agt_a", "quiet agt_b"]);
    expect(
      w.store.listDecisions({ limit: 20 }).filter((d) => d.boardId === BOARD),
    ).toHaveLength(1);
  });

  test("a nudge passes its own board only", async () => {
    const w = contested();
    await w.loop.passBoard(QUIET);
    expect(holdsByBoard(w)).toEqual(["quiet agt_a"]);
    expect(w.calls.filter((c) => c.startsWith("board"))).toEqual([
      `board ${QUIET}`,
    ]);
  });
});

describe("nothing requires it", () => {
  test("a SuperPipeline with no reservation verb: recorded as not-reserved, nothing held, not asked again for five minutes", async () => {
    const w = world();
    w.addCard(CARD);
    w.addAgent("agt_a");
    w.addAgent("agt_b");
    w.reserveAnswer = () => ({ ok: false, status: 404, code: "HTTP_404" });
    await w.loop.passBoard(BOARD);
    expect(w.store.listDecisions({ limit: 1 })[0]).toMatchObject({
      chosenAgent: "agt_a",
      outcome: "not-reserved",
      reservationRefused: "HTTP_404",
      reservedUntil: null,
    });
    w.advance(60 * S);
    await w.loop.passBoard(BOARD);
    expect(w.calls.filter((c) => c.startsWith("reserve"))).toHaveLength(1);
  });

  test("an unreachable SuperPipeline at reservation time is recorded, not thrown", async () => {
    const w = world();
    w.addCard(CARD);
    w.addAgent("agt_a");
    w.addAgent("agt_b");
    w.reserveAnswer = () => "throw";
    expect((await w.loop.passBoard(BOARD)).reserved).toBe(0);
    expect(w.store.listDecisions({ limit: 1 })[0]?.reservationRefused).toBe(
      "unreachable",
    );
  });

  test("an unreadable roster places nothing and records nothing, and still settles what it held", async () => {
    const w = world();
    w.addCard(CARD);
    w.addAgent("agt_a");
    w.addAgent("agt_b");
    await w.loop.passBoard(BOARD);
    const id = w.store.listDecisions({ limit: 1 })[0]!.id;
    w.claim(CARD, "agt_a");
    w.addCard("card_00000000000000c2");
    w.rosterFails = true;
    const pass = await w.loop.passBoard(BOARD);
    expect(pass).toMatchObject({ settled: 1, decided: 0, reserved: 0 });
    expect(w.store.getDecision(id)?.outcome).toBe("claimed");
    expect(
      w.log.some((l) => l.includes("roster unread (agentpod 404 Not Found)")),
    ).toBe(true);
  });

  test("the loop only reads, and asks for holds that lapse: it never claims, never clears, never asks without a window", async () => {
    const w = world();
    w.addCard(CARD);
    w.addCard("card_00000000000000c2");
    w.addAgent("agt_a");
    w.addAgent("agt_b");
    await w.loop.passBoard(BOARD);
    w.advance(61 * S);
    await w.loop.passBoard(BOARD);
    for (const call of w.calls)
      expect(call).toMatch(
        /^(board|roster|eligibility) |^reserve \S+ \S+ (60|30)$/,
      );
  });
});

describe("deciding again", () => {
  const row = (over: Record<string, unknown>) =>
    ({
      id: "pld_1",
      boardId: BOARD,
      cardId: CARD,
      stageKey: "build",
      policy: "p",
      chosenAgent: "agt_a",
      noDecisionReason: null,
      candidates: [],
      attemptsBefore: 0,
      createdAt: new Date(T0).toISOString(),
      reservedUntil: null,
      reservationRefused: null,
      outcome: null,
      outcomeBy: null,
      outcomeAt: null,
      ...over,
    }) as NonNullable<Parameters<typeof shouldDecide>[0]>;
  const card = { stageKey: "build", attemptCount: 0 } as CardView;
  const late = T0 + REDECIDE_AFTER_MS + 60 * S;

  test("a held, unsettled decision is never made again, however old", () => {
    expect(
      shouldDecide(
        row({ reservedUntil: new Date(T0 + 60 * S).toISOString() }),
        card,
        late,
      ),
    ).toBe(false);
  });

  test("a settled hold is made again at once; a card at another stage too", () => {
    expect(shouldDecide(row({ outcome: "expired" }), card, T0)).toBe(true);
    expect(shouldDecide(row({ outcome: "claimed" }), card, T0)).toBe(true);
    expect(
      shouldDecide(
        row({ chosenAgent: null }),
        { stageKey: "review" } as CardView,
        T0,
      ),
    ).toBe(true);
    expect(shouldDecide(null, card, T0)).toBe(true);
  });

  test("a card open to any match is never decided again on that ladder; a card back after a claim is, at once", () => {
    const open = row({
      chosenAgent: null,
      noDecisionReason: "any-match",
      tier: "any-match",
    });
    expect(shouldDecide(open, card, late)).toBe(false);
    expect(
      shouldDecide(open, { ...card, attemptCount: 1 } as CardView, T0),
    ).toBe(true);
    const nobody = row({
      chosenAgent: null,
      noDecisionReason: "none-eligible",
    });
    expect(
      shouldDecide(nobody, { ...card, attemptCount: 1 } as CardView, T0),
    ).toBe(true);
  });

  test("an open card claimed by somebody this service cannot name is claimed-by-other, never claimed", () => {
    const open = row({ chosenAgent: null, tier: "any-match" });
    const claimed = {
      ...card,
      state: "working",
      archived: false,
      attemptCount: 1,
      lastAgentId: null,
    } as CardView;
    expect(outcomeOf(open, claimed, new Date(T0).toISOString())).toEqual({
      outcome: "claimed-by-other",
      by: null,
    });
  });

  test("a ladder: the agents whose holds lapsed, oldest first, back to a person's move", () => {
    const r = (chosenAgent: string | null, outcome: string | null) =>
      row({ chosenAgent, outcome });
    expect(
      ladderOf([
        r("agt_c", "expired"),
        r(null, null),
        r("agt_b", "expired"),
        r("agt_x", "superseded"),
        r("agt_a", "expired"),
      ]),
    ).toEqual({ passedOver: ["agt_b", "agt_c"] });
    expect(ladderOf([])).toEqual({ passedOver: [] });
  });

  test("no choice, or a refused hold, waits five minutes", () => {
    for (const r of [
      row({ chosenAgent: null, noDecisionReason: "none-eligible" }),
      row({ outcome: "not-reserved" }),
    ]) {
      expect(shouldDecide(r, card, T0 + REDECIDE_AFTER_MS - 1)).toBe(false);
      expect(shouldDecide(r, card, T0 + REDECIDE_AFTER_MS)).toBe(true);
    }
  });
});

describe("every board", () => {
  test("passes the enabled boards only, and counts one that cannot be read", async () => {
    const w = world();
    w.store.enableBoard(BOARD, new Date(T0).toISOString());
    w.store.enableBoard("brd_00000000000000ff", new Date(T0).toISOString());
    w.store.enableBoard("brd_00000000000000ee", new Date(T0).toISOString());
    w.store.disableBoard("brd_00000000000000ee", new Date(T0).toISOString());
    expect(await w.loop.passAll()).toEqual({ boards: 2, failedBoards: 1 });
    expect(w.calls).toEqual([`board ${BOARD}`, "board brd_00000000000000ff"]);
  });

  test("no board opted in: nothing is read", async () => {
    const w = world();
    expect(await w.loop.passAll()).toEqual({ boards: 0, failedBoards: 0 });
    expect(w.calls).toEqual([]);
    opted(w);
  });
});

describe("the runner", () => {
  function scheduler() {
    const queue: Array<{ run: () => void; ms: number; handle: number }> = [];
    let next = 0;
    return {
      queue,
      schedule: (run: () => void, ms: number) => {
        const handle = ++next;
        queue.push({ run, ms, handle });
        return handle;
      },
      cancel: (handle: unknown) => {
        const i = queue.findIndex((q) => q.handle === handle);
        if (i >= 0) queue.splice(i, 1);
      },
      fire: async () => {
        const item = queue.shift();
        item?.run();
        await Bun.sleep(0);
        return item?.ms;
      },
    };
  }
  const settle = () => Bun.sleep(0);

  test("sweeps at once, then every interval; backs off while every board fails, up to the cap", async () => {
    const results = [
      { boards: 1, failedBoards: 1 },
      { boards: 1, failedBoards: 1 },
      { boards: 1, failedBoards: 1 },
      { boards: 1, failedBoards: 1 },
      { boards: 1, failedBoards: 0 },
    ];
    let passes = 0;
    const loop: Loop = {
      suggest: () => ({ opened: 0, updated: 0, resolved: 0 }),
      passAll: async () => results[passes++] ?? { boards: 0, failedBoards: 0 },
      passBoard: async () => ({
        boardId: "",
        settled: 0,
        decided: 0,
        reserved: 0,
        deferred: 0,
      }),
    };
    const s = scheduler();
    const runner = startRunner(loop, {
      intervalMs: 1000,
      schedule: s.schedule,
      cancel: s.cancel,
      log: () => {},
    });
    await settle();
    const waits: Array<number | undefined> = [];
    for (let i = 0; i < 5; i++) waits.push(await s.fire());
    expect(waits).toEqual([
      2000,
      4000,
      SWEEP_MAX_BACKOFF * 1000,
      SWEEP_MAX_BACKOFF * 1000,
      1000,
    ]);
    runner.stop();
    expect(s.queue).toEqual([]);
  });

  test("nudges coalesce into one pass per board after the delay, never during another pass", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const loop: Loop = {
      suggest: () => ({ opened: 0, updated: 0, resolved: 0 }),
      passAll: () =>
        new Promise((resolve) => {
          order.push("sweep start");
          release = () => {
            order.push("sweep end");
            resolve({ boards: 0, failedBoards: 0 });
          };
        }),
      passBoard: async (boardId) => {
        order.push(`board ${boardId}`);
        return { boardId, settled: 0, decided: 0, reserved: 0, deferred: 0 };
      },
    };
    const s = scheduler();
    const runner = startRunner(loop, {
      intervalMs: 30_000,
      schedule: s.schedule,
      cancel: s.cancel,
      log: () => {},
    });
    await settle();
    runner.nudge(BOARD);
    runner.nudge(BOARD);
    runner.nudge("brd_00000000000000b2");
    expect(s.queue.map((q) => q.ms)).toEqual([NUDGE_DELAY_MS]);
    await s.fire();
    // The sweep is still running: the nudged passes wait for it.
    expect(order).toEqual(["sweep start"]);
    release();
    await settle();
    await settle();
    expect(order).toEqual([
      "sweep start",
      "sweep end",
      `board ${BOARD}`,
      "board brd_00000000000000b2",
    ]);
    runner.stop();
  });
});

describe("roster suggestions", () => {
  test("a lane with one rostered candidate and a capable agent off the roster: a suggestion to add it, resolved once the lane has two", async () => {
    const w = world();
    opted(w);
    w.addCard(CARD);
    w.addAgent("agt_a");
    w.addAgent("agt_x", { roster: null });
    w.addAgent("agt_y", { roster: null, reasons: ["capability_mismatch"] });
    await w.loop.passAll();
    const [d] = w.store.listDecisions({ limit: 1 });
    expect(d?.noDecisionReason).toBe("one-candidate");
    expect(d?.requires).toEqual({ all: ["code"], any: [] });
    const [s] = w.store.listSuggestions({});
    expect(s).toMatchObject({
      kind: "add-agent-to-board",
      boardId: BOARD,
      stageKey: "build",
      body: {
        capability: { all: ["code"], any: [] },
        rostered: ["agt_a"],
        candidates: [
          { agentId: "agt_x", principalId: "prn_agt_x", stationId: null },
        ],
        reasons: ["one-candidate"],
      },
      evidence: [d!.id],
      evidenceCount: 1,
    });
    // Nothing was written to a roster: the roster is as it was, and the only writes made were the
    // placement's (none here: one candidate holds nothing).
    expect(
      w.calls.filter((c) => !/^(board|roster|eligibility) /.test(c)),
    ).toEqual([]);

    // A person adds agt_x to the board; the next decision sees two, and the suggestion resolves.
    w.addAgent("agt_x");
    w.advance(REDECIDE_AFTER_MS);
    await w.loop.passAll();
    expect(w.store.listSuggestions({})).toEqual([]);
    expect(w.store.listSuggestions({ state: "resolved" })).toHaveLength(1);
  });

  test("computing them reads the store alone: no source is called, and no write reaches another product", async () => {
    const w = world();
    opted(w);
    w.addCard(CARD);
    w.addAgent("agt_a");
    w.addAgent("agt_x", { roster: null });
    await w.loop.passAll();
    const before = [...w.calls];
    const touched: string[] = [];
    const tripwire = <T extends object>(name: string, target: T): T =>
      new Proxy(target, {
        get(obj, key, receiver) {
          touched.push(`${name}.${String(key)}`);
          return Reflect.get(obj, key, receiver);
        },
      });
    const sp = tripwire("superpipeline", w.superpipeline);
    const ap = tripwire("agentpod", w.agentpod);
    expect(
      refreshSuggestions({
        store: w.store,
        nowMs: T0 + 10 * S,
        newId: () => "sug_00000000000000000000000f",
      }).updated,
    ).toBe(1);
    // A loop whose sources record every touch computes them without one.
    const watched = createLoop({
      store: w.store,
      superpipeline: sp,
      agentpod: ap,
      now: () => T0 + 20 * S,
      newId: () => "pld_00000000000000000000000f",
      log: () => {},
    });
    expect(watched.suggest().updated).toBe(1);
    expect(w.calls).toEqual(before);
    expect(touched).toEqual([]);
  });

  test("computed on each sweep by default; with a setting, at most once in that time", async () => {
    const every = world();
    opted(every);
    await every.loop.passAll();
    await every.loop.passAll();
    expect(every.syncs).toBe(2);

    const w = world({
      suggestions: { ...DEFAULT_SUGGESTIONS, everyMs: 10 * 60 * S },
    });
    opted(w);
    await w.loop.passAll();
    w.advance(10 * 60 * S - S);
    await w.loop.passAll();
    expect(w.syncs).toBe(1);
    w.advance(S);
    await w.loop.passAll();
    expect(w.syncs).toBe(2);
    // A nudge is one board, not a sweep: it computes nothing.
    await w.loop.passBoard(BOARD);
    expect(w.syncs).toBe(2);
  });

  test("a board opted out is not suggested for; its open suggestions resolve", async () => {
    const w = world();
    opted(w);
    w.addCard(CARD);
    w.addAgent("agt_a");
    await w.loop.passAll();
    expect(w.store.listSuggestions({})).toMatchObject([
      { kind: "lane-single-point" },
    ]);
    w.store.disableBoard(BOARD, new Date(T0).toISOString());
    w.loop.suggest();
    expect(w.store.listSuggestions({})).toEqual([]);
  });

  test("decisions older than the window are not read", async () => {
    const w = world({
      suggestions: { ...DEFAULT_SUGGESTIONS, windowMs: 3600 * S },
    });
    opted(w);
    w.addCard(CARD);
    w.addAgent("agt_a");
    await w.loop.passAll();
    expect(w.store.listSuggestions({})).toHaveLength(1);
    w.cards.delete(CARD);
    w.advance(3600 * S + S);
    await w.loop.passAll();
    expect(w.store.listSuggestions({})).toEqual([]);
  });
});

describe("stage history from SuperWitness", () => {
  /** A SuperWitness that answers these runs for every stage, or fails, and logs what it was asked. */
  function witness(
    runs:
      | Array<{ executor: string; succeeded: boolean; verdict: number | null }>
      | "fail",
  ) {
    const asked: string[] = [];
    const sw: Superwitness = {
      async stageRuns(q) {
        asked.push(`${q.boardId} ${q.stageKey} ${q.since}`);
        if (runs === "fail")
          throw new SourceError("superwitness", 503, "store_unavailable");
        return runs.map((r) => ({
          ...r,
          at: new Date(T0 - 3600 * S).toISOString(),
        }));
      },
    };
    return { sw, asked };
  }
  /** Five runs each: agt_a always failed and was judged fail, agt_b always passed. */
  const RECORD = [
    ...Array.from({ length: 5 }, () => ({
      executor: "prn_agt_a",
      succeeded: false,
      verdict: 0,
    })),
    ...Array.from({ length: 5 }, () => ({
      executor: "prn_agt_b",
      succeeded: true,
      verdict: 1,
    })),
  ];
  /** Two idle agents: agt_a the least recently used, so the board's own order picks it. */
  function twoAgents(w: ReturnType<typeof world>) {
    w.addAgent("agt_a", {
      roster: { lastDispatchedAt: new Date(T0 - 7200 * S).toISOString() },
    });
    w.addAgent("agt_b", {
      roster: { lastDispatchedAt: new Date(T0 - 60 * S).toISOString() },
    });
  }

  test("a candidate's record at the stage outranks the least recently used, and the record says what was read", async () => {
    const { sw, asked } = witness(RECORD);
    const w = world({ superwitness: sw });
    w.addCard(CARD);
    w.addCard("card_00000000000000c2");
    twoAgents(w);
    w.addAgent("agt_c", { roster: { busy: true } });
    await w.loop.passBoard(BOARD);
    // Read once for the board stage, however many cards are placed, back 30 days.
    expect(asked).toEqual([
      `${BOARD} build ${new Date(T0 - 30 * 24 * 3600 * S).toISOString()}`,
    ]);
    const first = w.store
      .listDecisions({ limit: 10 })
      .find((d) => d.cardId === CARD);
    expect(first?.chosenAgent).toBe("agt_b");
    expect(first?.policy).toBe("idle-stage-success-lru@3");
    const records = first?.candidates as CandidateRecord[];
    const of = (id: string) => records.find((r) => r.candidate.agentId === id);
    expect(of("agt_b")?.stageHistory).toMatchObject({
      runs: 5,
      succeeded: 5,
      verdicts: 5,
      passes: 5,
    });
    expect(of("agt_a")?.stageHistory?.succeeded).toBe(0);
    // Nobody's runs: an empty history, recorded, and neutral.
    expect(of("agt_c")?.stageHistory).toMatchObject({
      runs: 0,
      stageRecord: 0.5,
    });
    expect(of("agt_b")?.score?.terms.stageRecord).toBeGreaterThan(
      of("agt_a")?.score?.terms.stageRecord ?? 1,
    );
  });

  test("SuperWitness failing never blocks a placement: the board's own order, nothing recorded of the stage, and a log line", async () => {
    const { sw, asked } = witness("fail");
    const w = world({ superwitness: sw });
    w.addCard(CARD);
    w.addCard("card_00000000000000c2");
    twoAgents(w);
    const pass = await w.loop.passBoard(BOARD);
    expect(pass.reserved).toBe(2);
    // One failed read a pass for the board stage, not one per card.
    expect(asked.length).toBe(1);
    const first = w.store
      .listDecisions({ limit: 10 })
      .find((d) => d.cardId === CARD);
    expect(first?.chosenAgent).toBe("agt_a");
    for (const r of (first?.candidates ?? []) as CandidateRecord[]) {
      expect(r.stageHistory).toBeNull();
      expect(r.score?.terms).not.toHaveProperty("stageRecord");
    }
    expect(
      w.log.some((l) =>
        l.includes("stage history unread (superwitness 503 store_unavailable)"),
      ),
    ).toBe(true);
  });

  test("without SuperWitness: the same choice, and SuperWitness is never asked", async () => {
    const w = world();
    w.addCard(CARD);
    twoAgents(w);
    await w.loop.passBoard(BOARD);
    const [d] = w.store.listDecisions({ limit: 10 });
    expect(d?.chosenAgent).toBe("agt_a");
    for (const r of (d?.candidates ?? []) as CandidateRecord[])
      expect(r.stageHistory).toBeNull();
  });
});

describe("the wider candidate set", () => {
  const report = (
    w: ReturnType<typeof world>,
    agentId: string,
    over: Partial<DirectLoadEntry> = {},
  ) =>
    w.load.set(agentId, {
      agentId,
      principalId: `prn_${agentId}`,
      inFlight: 0,
      capacity: null,
      lastHeartbeatAt: new Date(T0 - 120 * S).toISOString(),
      ...over,
    });

  test("roster, the default: SuperPipeline's load is never read and an agent with its own token stays out", async () => {
    const w = world();
    w.addCard(CARD);
    w.addAgent("agt_a");
    w.addAgent("agt_d", { roster: null });
    report(w, "agt_d");
    await w.loop.passBoard(BOARD);
    expect(w.calls).not.toContain("agent-load");
    const [d] = w.store.listDecisions({ limit: 10 });
    expect(d?.noDecisionReason).toBe("one-candidate");
    expect(verdicts(d?.candidates)).toEqual({
      agt_a: "ok",
      agt_d: "not-on-roster",
    });
  });

  test("all: the load is read once a pass, and an agent with its own token is held for, recorded as direct", async () => {
    const w = world({ candidateSet: "all" });
    w.addCard(CARD);
    w.addCard("card_00000000000000c2");
    w.addAgent("agt_a", { roster: { busy: true } });
    w.addAgent("agt_d", { roster: null });
    w.addAgent("agt_e", { roster: null });
    report(w, "agt_d");
    report(w, "agt_e", { inFlight: 1 });
    await w.loop.passBoard(BOARD);
    expect(w.calls.filter((c) => c === "agent-load")).toEqual(["agent-load"]);
    expect(w.holds.get(CARD)?.agentId).toBe("agt_d");
    const decision = w.store
      .listDecisions({ limit: 10 })
      .find((x) => x.cardId === CARD);
    expect(verdicts(decision?.candidates)).toEqual({
      agt_a: "not-idle",
      agt_d: "ok",
      agt_e: "not-idle",
    });
    const sources = Object.fromEntries(
      ((decision?.candidates ?? []) as CandidateRecord[]).map((r) => [
        r.candidate.agentId,
        r.candidate.source,
      ]),
    );
    expect(sources).toEqual({
      agt_a: "roster",
      agt_d: "direct",
      agt_e: "direct",
    });
  });

  test("all: a bridge row speaks for the agent over SuperPipeline's load", async () => {
    const w = world({ candidateSet: "all" });
    w.addCard(CARD);
    w.addAgent("agt_a");
    w.addAgent("agt_b", { roster: { busy: true } });
    report(w, "agt_b", { inFlight: 0 });
    await w.loop.passBoard(BOARD);
    const [d] = w.store.listDecisions({ limit: 10 });
    expect(verdicts(d?.candidates)).toEqual({
      agt_a: "ok",
      agt_b: "not-idle",
    });
  });

  test("all: when the load cannot be read, only the roster is placed, and the log says so", async () => {
    const w = world({ candidateSet: "all" });
    w.loadFails = true;
    w.addCard(CARD);
    w.addAgent("agt_a");
    w.addAgent("agt_b");
    w.addAgent("agt_d", { roster: null });
    report(w, "agt_d");
    await w.loop.passBoard(BOARD);
    const [d] = w.store.listDecisions({ limit: 10 });
    expect(verdicts(d?.candidates)).toEqual({
      agt_a: "ok",
      agt_b: "ok",
      agt_d: "not-on-roster",
    });
    expect(w.log.some((l) => l.includes("agent load unread"))).toBe(true);
  });
});
