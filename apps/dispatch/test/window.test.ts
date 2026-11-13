/**
 * The placement window and the card placed at once: SuperDispatch sets a window on each board it
 * opts in (and none on one it opts out), places the card a `card.ready` names alone and at once with
 * the board's cached roster, and the sweep keeps that cache fresh.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  eventType,
  signDelivery,
  toBinary,
} from "@superjackfruitlabs/treaty-cloudevents";
import { REDECIDE_AFTER_MS, createLoop } from "../src/loop/index.ts";
import { startRunner } from "../src/loop/runner.ts";
import { createHandler } from "../src/routes/index.ts";
import { readyCardOf } from "../src/routes/relay.ts";
import {
  SourceError,
  type Agentpod,
  type CardView,
  type RosterEntry,
  type Superpipeline,
} from "../src/sources/index.ts";
import { OPERATOR_TOKEN, OPERATOR_TOKEN_SHA256, tempStore } from "./helpers.ts";

const BOARD = "brd_00000000000000b1";
const CARD = "card_00000000000000c1";
const OTHER = "card_00000000000000c2";
const T0 = Date.parse("2026-11-13T09:00:00.000Z");
const S = 1000;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const rosterEntry = (agent: string): RosterEntry => ({
  key: agent,
  stationId: `stn_${agent}`,
  principalId: `prn_${agent}`,
  enabled: true,
  ready: true,
  busy: false,
  lastDispatchedAt: null,
});

const encoded = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const type = (entity: string, verb: string) =>
  eventType({ product: "superpipeline", entity, verb }, 1);

/** One board in SuperPipeline with two ready cards, and two idle agents on its AgentPod roster. */
function world(
  options: { windowSeconds?: number; rosterMaxAgeMs?: number } = {},
) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  let now = T0;
  const calls: string[] = [];
  let windowFails = false;
  const card = (id: string): CardView => ({
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
  });
  const cards = [card(CARD), card(OTHER)];
  const superpipeline: Superpipeline = {
    async board(boardId) {
      calls.push(`board ${boardId}`);
      return {
        boardId,
        stages: [
          {
            key: "build",
            ownerKind: "capability",
            hasRequires: false,
            requires: { all: ["code"], any: [] },
            placement: null,
          },
        ],
        cards: cards.map((c) => ({ ...c })),
      };
    },
    async eligibility(_b, cardId) {
      calls.push(`eligibility ${cardId}`);
      return {
        stageKey: "build",
        reasons: [],
        agents: ["agt_a", "agt_b"].map((agentId) => ({
          agentId,
          principalId: `prn_${agentId}`,
          eligible: true,
          reasons: [],
        })),
      };
    },
    async reserve(_b, cardId, hold) {
      calls.push(`reserve ${cardId} ${hold.agentId}`);
      return {
        ok: true,
        reservedUntil: new Date(now + hold.ttlSeconds * S).toISOString(),
      };
    },
    async clearReservation() {},
    async agentLoad() {
      return [];
    },
    async setPlacementWindow(boardId, seconds) {
      calls.push(`window ${boardId} ${seconds}`);
      if (windowFails) throw new SourceError("superpipeline", 404, "error");
    },
  };
  const agentpod: Agentpod = {
    async roster(boardId) {
      calls.push(`roster ${boardId}`);
      return [rosterEntry("agt_a"), rosterEntry("agt_b")];
    },
    async stationCapabilities() {
      return null;
    },
  };
  let ids = 0;
  const loop = createLoop({
    store: t.store,
    superpipeline,
    agentpod,
    ...(options.windowSeconds !== undefined
      ? { placementWindowSeconds: options.windowSeconds }
      : {}),
    ...(options.rosterMaxAgeMs !== undefined
      ? { rosterMaxAgeMs: options.rosterMaxAgeMs }
      : {}),
    now: () => now,
    newId: () => `pld_${String(++ids).padStart(24, "0")}`,
    log: () => {},
  });
  t.store.enableBoard(BOARD, new Date(T0).toISOString());
  return {
    store: t.store,
    loop,
    calls,
    cards,
    advance: (ms: number) => {
      now += ms;
    },
    set windowFails(v: boolean) {
      windowFails = v;
    },
  };
}

/** Let background reads finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the placement window on SuperPipeline", () => {
  test("is set once on a board opted in, and 0 once it is opted out", async () => {
    const w = world({ windowSeconds: 10 });
    w.cards.length = 0;
    await w.loop.passAll();
    await w.loop.passAll();
    expect(w.calls.filter((c) => c.startsWith("window "))).toEqual([
      `window ${BOARD} 10`,
    ]);
    w.store.disableBoard(BOARD, new Date(T0).toISOString());
    await w.loop.syncWindow(BOARD);
    await w.loop.passAll();
    expect(w.calls.filter((c) => c.startsWith("window "))).toEqual([
      `window ${BOARD} 10`,
      `window ${BOARD} 0`,
    ]);
  });

  test("refused, it is asked again only after a wait, and placement goes on", async () => {
    const w = world({ windowSeconds: 10 });
    w.windowFails = true;
    expect((await w.loop.passBoard(BOARD)).reserved).toBe(2);
    await w.loop.passBoard(BOARD);
    expect(w.calls.filter((c) => c.startsWith("window ")).length).toBe(1);
    w.windowFails = false;
    w.advance(REDECIDE_AFTER_MS);
    await w.loop.passBoard(BOARD);
    expect(w.calls.filter((c) => c.startsWith("window ")).length).toBe(2);
  });

  test("unset, no board's window is touched", async () => {
    const w = world();
    await w.loop.passAll();
    expect(w.calls.some((c) => c.startsWith("window "))).toBe(false);
  });
});

describe("a ready card placed at once", () => {
  test("places that card alone, with the roster the sweep cached", async () => {
    const w = world({ rosterMaxAgeMs: 60 * S });
    // A sweep with nothing to place still caches the roster.
    const ready = [...w.cards];
    w.cards.length = 0;
    await w.loop.passAll();
    await settle();
    expect(w.calls).toEqual([`board ${BOARD}`, `roster ${BOARD}`]);
    w.calls.length = 0;
    w.cards.push(...ready);
    w.advance(20 * S);
    const pass = await w.loop.passCard(BOARD, CARD);
    expect(pass.reserved).toBe(1);
    expect(w.calls).toEqual([
      `board ${BOARD}`,
      `eligibility ${CARD}`,
      `reserve ${CARD} agt_a`,
    ]);
    const [decision] = w.store.listDecisions({ boardId: BOARD, limit: 5 });
    expect(decision?.cardId).toBe(CARD);
    expect(decision?.chosenAgent).toBe("agt_a");
  });

  test("reads the roster itself when the cached one is too old", async () => {
    const w = world({ rosterMaxAgeMs: 5 * S });
    await w.loop.passBoard(BOARD);
    w.calls.length = 0;
    w.advance(6 * S);
    const [first] = w.cards;
    if (first === undefined) throw new Error("no card");
    w.cards.push({ ...first, id: "card_00000000000000c3" });
    await w.loop.passCard(BOARD, "card_00000000000000c3");
    expect(w.calls).toContain(`roster ${BOARD}`);
  });
});

describe("the runner", () => {
  test("places a ready card at once, without the nudge's delay, once however often it is asked", async () => {
    const asked: string[] = [];
    const scheduled: number[] = [];
    let passAll = 0;
    const runner = startRunner(
      {
        suggest: () => ({ opened: 0, updated: 0, resolved: 0 }),
        passAll: async () => {
          passAll++;
          return { boards: 0, failedBoards: 0 };
        },
        passBoard: async (boardId) => {
          asked.push(`board ${boardId}`);
          return { boardId, settled: 0, decided: 0, reserved: 0, deferred: 0 };
        },
        passCard: async (boardId, cardId) => {
          asked.push(`card ${cardId}`);
          return { boardId, settled: 0, decided: 0, reserved: 0, deferred: 0 };
        },
        syncWindow: async (boardId) => {
          asked.push(`window ${boardId}`);
        },
      },
      {
        intervalMs: 30 * S,
        schedule: (_run, ms) => {
          scheduled.push(ms);
          return ms;
        },
        cancel: () => {},
        log: () => {},
      },
    );
    runner.cardReady(BOARD, CARD);
    runner.cardReady(BOARD, CARD);
    runner.boardChanged(BOARD);
    await settle();
    await settle();
    expect(passAll).toBe(1);
    expect(asked).toEqual([`card ${CARD}`, `window ${BOARD}`]);
    // Only the next sweep was scheduled: nothing waited for a timer.
    expect(scheduled).toEqual([30 * S]);
    runner.stop();
  });
});

describe("the relay route", () => {
  const SECRET = "relay-secret-for-tests";
  const NOW = Date.parse("2026-11-13T09:00:00.000Z");
  async function delivery(entity: string, verb: string, data: unknown) {
    const attributes = {
      specversion: "1.0",
      id: `${BOARD}:7`,
      source: `/superpipeline/boards/${BOARD}`,
      type: eventType({ product: "superpipeline", entity, verb }, 1),
      datacontenttype: "application/json",
    };
    const body = new TextEncoder().encode(JSON.stringify(data));
    const message = toBinary({ attributes, data: body }, "http");
    return new Request("http://dispatch/v1/relay/events", {
      method: "POST",
      headers: {
        ...message.headers,
        "x-treaty-signature": await signDelivery(
          SECRET,
          attributes.id,
          body,
          NOW,
        ),
      },
      body,
    });
  }
  function setup() {
    const t = tempStore();
    cleanups.push(t.cleanup);
    t.store.enableBoard(BOARD, "2026-11-13T08:00:00.000Z");
    const nudged: string[] = [];
    const ready: string[] = [];
    const handle = createHandler({
      config: {
        relayDeliverySecret: SECRET,
        operatorTokenSha256: OPERATOR_TOKEN_SHA256,
      },
      store: t.store,
      onBoard: (b) => nudged.push(b),
      onCardReady: (b, c) => ready.push(`${b} ${c}`),
      onBoardChanged: (b) => nudged.push(`changed ${b}`),
      now: () => NOW,
      nowMs: () => NOW,
      log: () => {},
    });
    return { handle, nudged, ready };
  }

  test("a card.ready places its card, and nudges nothing", async () => {
    const { handle, nudged, ready } = setup();
    const r = await handle(
      await delivery("card", "ready", { event: "card.ready", cardId: CARD }),
    );
    expect(await r.json()).toEqual({ status: "accepted" });
    expect(ready).toEqual([`${BOARD} ${CARD}`]);
    expect(nudged).toEqual([]);
  });

  test("a card.ready naming no card it can read is a nudge; so is any other event", async () => {
    const { handle, nudged, ready } = setup();
    await handle(await delivery("card", "ready", { cardId: "nope" }));
    await handle(
      await delivery("gate", "pending", {
        event: "gate.pending",
        cardId: CARD,
      }),
    );
    expect(ready).toEqual([]);
    expect(nudged).toEqual([BOARD, BOARD]);
  });

  test("opting a board in or out tells the runner, so its window follows", async () => {
    const { handle, nudged } = setup();
    const op = (method: string) =>
      new Request(`http://dispatch/v1/boards/${BOARD}`, {
        method,
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      });
    await handle(op("DELETE"));
    await handle(op("PUT"));
    expect(nudged).toEqual([`changed ${BOARD}`, `changed ${BOARD}`, BOARD]);
  });

  test("readyCardOf reads only a card.ready's card id", () => {
    expect(readyCardOf(type("card", "ready"), encoded({ cardId: CARD }))).toBe(
      CARD,
    );
    expect(
      readyCardOf(type("card", "created"), encoded({ cardId: CARD })),
    ).toBeNull();
    expect(readyCardOf("not a type", encoded({ cardId: CARD }))).toBeNull();
    expect(
      readyCardOf(type("card", "ready"), new TextEncoder().encode("{")),
    ).toBeNull();
  });
});
