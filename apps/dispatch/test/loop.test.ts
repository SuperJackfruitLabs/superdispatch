import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_CARDS_PER_PASS,
  NUDGE_DELAY_MS,
  REDECIDE_AFTER_MS,
  SWEEP_MAX_BACKOFF,
  createLoop,
  shouldDecide,
  startRunner,
  type Loop,
} from "../src/loop/index.ts";
import {
  SourceError,
  type Agentpod,
  type BoardView,
  type CardView,
  type EligibilityView,
  type ReserveAnswer,
  type RosterEntry,
  type Superpipeline,
} from "../src/sources/index.ts";
import type { CandidateRecord } from "../src/placement/index.ts";
import { tempStore } from "./helpers.ts";

const BOARD = "brd_00000000000000b1";
const CARD = "card_00000000000000c1";
const T0 = Date.parse("2026-11-12T12:00:00.000Z");
const S = 1000;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/**
 * A board in SuperPipeline and its roster in AgentPod, in memory, that hold reservations the way
 * SuperPipeline's step 1 does: until a time, and only for an agent the eligibility read allows.
 */
function world() {
  const t = tempStore();
  cleanups.push(t.cleanup);
  let now = T0;
  let ids = 0;
  const calls: string[] = [];
  const log: string[] = [];

  const stages: BoardView["stages"] = [
    { key: "build", ownerKind: "capability", hasRequires: false },
    { key: "approve", ownerKind: "human", hasRequires: false },
    { key: "pinned", ownerKind: "agent", hasRequires: false },
  ];
  const cards = new Map<string, CardView>();
  const addCard = (id: string, over: Partial<CardView> = {}) =>
    cards.set(id, {
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
      if (boardId !== BOARD)
        throw new SourceError("superpipeline", 404, "not found");
      return {
        boardId,
        stages,
        cards: [...cards.values()].map((c) => ({ ...c })),
      };
    },
    async eligibility(boardId, cardId): Promise<EligibilityView> {
      calls.push(`eligibility ${cardId}`);
      const card = cards.get(cardId)!;
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
    reservationSeconds: 60,
    now: () => now,
    newId: () => `pld_${String(++ids).padStart(24, "0")}`,
    log: (line) => log.push(line),
  });
  /** An agent claims a card, as SuperPipeline's claim would record it. */
  const claim = (cardId: string, agentId: string) => {
    const c = cards.get(cardId)!;
    cards.set(cardId, {
      ...c,
      state: "working",
      currentRunId: `run_${c.attemptCount + 1}`,
      lastAgentId: agentId,
      attemptCount: c.attemptCount + 1,
      reservation: null,
    });
    holds.delete(cardId);
  };
  return {
    store: t.store,
    loop,
    calls,
    log,
    cards,
    holds,
    roster,
    addCard,
    addAgent,
    claim,
    advance: (ms: number) => {
      now += ms;
    },
    set reserveAnswer(f: ((cardId: string) => ReserveAnswer | "throw") | null) {
      reserveAnswer = f;
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
      policy: "idle-load-success-lru@1",
      chosenAgent: "agt_b",
      noDecisionReason: null,
      attemptsBefore: 0,
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

  test("two ready cards and two idle agents: one card each, by load", async () => {
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

  test(`at most ${MAX_CARDS_PER_PASS} cards a pass`, async () => {
    const w = world();
    w.addAgent("agt_a");
    w.addAgent("agt_b");
    for (let i = 0; i < MAX_CARDS_PER_PASS + 3; i++)
      w.addCard(`card_${i.toString(16).padStart(16, "0")}`);
    expect((await w.loop.passBoard(BOARD)).decided).toBe(MAX_CARDS_PER_PASS);
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
    // Its success rate on the board fell below the other's, so the other is chosen this time.
    expect(w.store.listDecisions({ limit: 1 })[0]?.chosenAgent).toBe("agt_b");
  });

  test("an agent whose holds lapse twice is shut out as a no-show, and comes back once they age out", async () => {
    const w = world();
    w.addCard(CARD);
    w.addAgent("agt_a");
    w.addAgent("agt_b", { roster: { busy: true } });
    // agt_a is the only idle agent: held for it, lapsed, held for it again, lapsed again.
    await w.loop.passBoard(BOARD);
    w.advance(61 * S);
    await w.loop.passBoard(BOARD);
    w.advance(61 * S);
    await w.loop.passBoard(BOARD);
    const all = w.store.listDecisions({ limit: 10 }).reverse();
    expect(all.map((d) => [d.chosenAgent, d.outcome])).toEqual([
      ["agt_a", "expired"],
      ["agt_a", "expired"],
      [null, null],
    ]);
    expect(all[2]?.noDecisionReason).toBe("none-eligible");
    expect(verdicts(all[2]?.candidates)).toEqual({
      agt_a: "recently-no-show",
      agt_b: "not-idle",
    });
    // Half an hour after the first lapse it has aged out of the window, and agt_a is a candidate again.
    w.advance(30 * 60 * S);
    await w.loop.passBoard(BOARD);
    const latest = w.store.latestDecision(BOARD, CARD)!;
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
      expect(call).toMatch(/^(board|roster|eligibility) |^reserve \S+ \S+ 60$/);
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
    }) as Parameters<typeof shouldDecide>[0];
  const card = { stageKey: "build" } as CardView;
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
      passAll: async () => results[passes++] ?? { boards: 0, failedBoards: 0 },
      passBoard: async () => ({
        boardId: "",
        settled: 0,
        decided: 0,
        reserved: 0,
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
        return { boardId, settled: 0, decided: 0, reserved: 0 };
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
