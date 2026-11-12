import { afterEach, describe, expect, test } from "bun:test";
import {
  eventType,
  signDelivery,
  toBinary,
} from "@superjackfruitlabs/treaty-cloudevents";
import { createHandler } from "../src/routes/index.ts";
import { OPERATOR_TOKEN, OPERATOR_TOKEN_SHA256, tempStore } from "./helpers.ts";

const SECRET = "relay-secret-for-tests";
const BOARD = "brd_00000000000000b1";
const NOW = Date.parse("2026-11-12T12:00:00.000Z");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function setup() {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const seen: string[] = [];
  const handle = createHandler({
    config: {
      relayDeliverySecret: SECRET,
      operatorTokenSha256: OPERATOR_TOKEN_SHA256,
    },
    store: t.store,
    onBoard: (b) => seen.push(b),
    now: () => NOW,
    nowMs: () => NOW,
    log: () => {},
  });
  return { handle, store: t.store, seen };
}

const op = (path: string, method = "GET", token = OPERATOR_TOKEN) =>
  new Request(`http://dispatch${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe("the health check", () => {
  test("answers, and nothing else does", async () => {
    const { handle } = setup();
    const r = await handle(new Request("http://dispatch/healthz"));
    expect(await r.json()).toEqual({ ok: true, service: "superdispatch" });
    expect((await handle(new Request("http://dispatch/"))).status).toBe(404);
    expect(
      (await handle(new Request("http://dispatch/healthz", { method: "POST" })))
        .status,
    ).toBe(404);
  });
});

describe("the operator API", () => {
  test("refuses a missing or wrong token before anything", async () => {
    const { handle, store } = setup();
    for (const r of [
      op("/v1/boards", "GET", ""),
      op("/v1/boards", "GET", "not-the-token"),
      op(`/v1/boards/${BOARD}`, "PUT", "not-the-token"),
      op("/v1/decisions", "GET", "not-the-token"),
    ]) {
      const answer = await handle(r);
      expect(answer.status).toBe(401);
      expect(await answer.json()).toEqual({ error: "unauthorized" });
    }
    expect(store.listBoards()).toEqual([]);
  });

  test("opts a board in, lists it, opts it out, and nudges it when opted in", async () => {
    const { handle, store, seen } = setup();
    const put = await handle(op(`/v1/boards/${BOARD}`, "PUT"));
    expect(put.status).toBe(200);
    expect((await put.json()).board).toMatchObject({
      boardId: BOARD,
      enabled: true,
    });
    expect(seen).toEqual([BOARD]);
    expect(
      (await (await handle(op("/v1/boards"))).json()).boards.map(
        (b: { boardId: string }) => b.boardId,
      ),
    ).toEqual([BOARD]);
    const del = await handle(op(`/v1/boards/${BOARD}`, "DELETE"));
    expect((await del.json()).board.enabled).toBe(false);
    expect(store.getBoard(BOARD)?.enabled).toBe(false);
    expect(
      (await handle(op("/v1/boards/brd_00000000000000ff", "DELETE"))).status,
    ).toBe(404);
    expect((await handle(op("/v1/boards/brd_00000000000000ff"))).status).toBe(
      404,
    );
  });

  test("refuses a malformed board id, a sub-path and another method", async () => {
    const { handle } = setup();
    expect((await handle(op("/v1/boards/not-a-board", "PUT"))).status).toBe(
      400,
    );
    expect((await handle(op(`/v1/boards/${BOARD}/x`, "PUT"))).status).toBe(404);
    expect((await handle(op("/v1/boards", "POST"))).status).toBe(405);
    expect((await handle(op(`/v1/boards/${BOARD}`, "POST"))).status).toBe(405);
    expect((await handle(op("/v1/decisions", "POST"))).status).toBe(405);
  });

  test("lists decisions by board and card, and reads one", async () => {
    const { handle, store } = setup();
    const base = {
      boardId: BOARD,
      stageKey: "build",
      policy: "idle-load-success-lru@1",
      noDecisionReason: null,
      candidates: [],
      attemptsBefore: 0,
      tier: "winner",
      tierStep: 1,
    };
    store.recordDecision({
      ...base,
      id: "pld_000000000000000000000001",
      cardId: "card_00000000000000c1",
      chosenAgent: "agt_a",
      createdAt: "2026-11-12T11:00:00.000Z",
    });
    store.setReservation(
      "pld_000000000000000000000001",
      { reservedUntil: "2026-11-12T11:01:00.000Z" },
      "2026-11-12T11:00:00.000Z",
    );
    store.recordDecision({
      ...base,
      id: "pld_000000000000000000000002",
      cardId: "card_00000000000000c2",
      chosenAgent: null,
      noDecisionReason: "one-candidate",
      createdAt: "2026-11-12T11:05:00.000Z",
    });
    const all = await (await handle(op("/v1/decisions"))).json();
    expect(all.decisions.map((d: { id: string }) => d.id)).toEqual([
      "pld_000000000000000000000002",
      "pld_000000000000000000000001",
    ]);
    const one = await (
      await handle(
        op(`/v1/decisions?board=${BOARD}&card=card_00000000000000c1`),
      )
    ).json();
    expect(one.decisions).toEqual([
      {
        id: "pld_000000000000000000000001",
        boardId: BOARD,
        cardId: "card_00000000000000c1",
        stageKey: "build",
        policy: "idle-load-success-lru@1",
        chosen: "agt_a",
        reason: null,
        tier: { name: "winner", step: 1 },
        candidates: [],
        reservation: { reservedUntil: "2026-11-12T11:01:00.000Z" },
        reservationRefused: null,
        outcome: null,
        createdAt: "2026-11-12T11:00:00.000Z",
      },
    ]);
    const read = await handle(op("/v1/decisions/pld_000000000000000000000002"));
    expect((await read.json()).decision.reason).toBe("one-candidate");
    expect(
      (await handle(op("/v1/decisions/pld_00000000000000000000ffff"))).status,
    ).toBe(404);
    expect(
      (
        await (
          await handle(op("/v1/decisions?before=2026-11-12T11:05:00Z&limit=1"))
        ).json()
      ).decisions.map((d: { id: string }) => d.id),
    ).toEqual(["pld_000000000000000000000001"]);
  });

  test("refuses a malformed decisions query", async () => {
    const { handle } = setup();
    for (const q of [
      "board=nope",
      "card=card_00000000000000c1",
      `board=${BOARD}&card=nope`,
      "before=yesterday",
      "limit=0",
      "limit=201",
      "limit=5x",
    ]) {
      expect((await handle(op(`/v1/decisions?${q}`))).status).toBe(400);
    }
  });
});

async function delivery(
  attributes: Record<string, string>,
  { secret = SECRET, sign = true } = {},
): Promise<Request> {
  const body = new TextEncoder().encode(JSON.stringify({ event: "x" }));
  const message = toBinary({ attributes, data: body }, "http");
  const headers: Record<string, string> = { ...message.headers };
  if (sign)
    headers["x-treaty-signature"] = await signDelivery(
      secret,
      attributes.id ?? "",
      body,
      NOW,
    );
  return new Request("http://dispatch/v1/relay/events", {
    method: "POST",
    headers,
    body,
  });
}

const EVENT = {
  specversion: "1.0",
  id: `${BOARD}:1`,
  source: `/superpipeline/boards/${BOARD}`,
  type: eventType(
    { product: "superpipeline", entity: "gate", verb: "approval_recorded" },
    1,
  ),
  datacontenttype: "application/json",
};

describe("the relay route", () => {
  test("an event for an opted-in board is accepted and nudges it", async () => {
    const { handle, store, seen } = setup();
    store.enableBoard(BOARD, "2026-11-12T11:00:00.000Z");
    const r = await handle(await delivery(EVENT));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "accepted" });
    expect(seen).toEqual([BOARD]);
  });

  test("a board not opted in, or opted out, or another producer, is ignored", async () => {
    const { handle, store, seen } = setup();
    expect(await (await handle(await delivery(EVENT))).json()).toEqual({
      status: "ignored",
    });
    store.enableBoard(BOARD, "2026-11-12T11:00:00.000Z");
    store.disableBoard(BOARD, "2026-11-12T11:01:00.000Z");
    expect(await (await handle(await delivery(EVENT))).json()).toEqual({
      status: "ignored",
    });
    store.enableBoard(BOARD, "2026-11-12T11:02:00.000Z");
    const other = {
      ...EVENT,
      type: eventType(
        { product: "agentpod", entity: "station", verb: "ready" },
        1,
      ),
    };
    expect(await (await handle(await delivery(other))).json()).toEqual({
      status: "ignored",
    });
    const elsewhere = { ...EVENT, source: "/superpipeline/workspaces/x" };
    expect(await (await handle(await delivery(elsewhere))).json()).toEqual({
      status: "ignored",
    });
    expect(seen).toEqual([]);
  });

  test("a bad or missing signature is 401, and nudges nothing", async () => {
    const { handle, store, seen } = setup();
    store.enableBoard(BOARD, "2026-11-12T11:00:00.000Z");
    expect(
      (await handle(await delivery(EVENT, { secret: "another-secret" })))
        .status,
    ).toBe(401);
    expect((await handle(await delivery(EVENT, { sign: false }))).status).toBe(
      401,
    );
    expect(seen).toEqual([]);
  });

  test("a body that is not a CloudEvent is 400; only POST reaches it", async () => {
    const { handle } = setup();
    const r = await handle(
      new Request("http://dispatch/v1/relay/events", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(r.status).toBe(400);
    expect(
      (await handle(new Request("http://dispatch/v1/relay/events"))).status,
    ).toBe(404);
  });
});
