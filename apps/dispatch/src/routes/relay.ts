/**
 * `POST /v1/relay/events`: the suite's event relay delivering a SuperPipeline event.
 *
 * - `card.ready` v1 (a card became ready to claim on a board with a placement window): its data is
 *   read through treaty's `card.ready.v1` schema, and the card it names is placed at once, alone,
 *   inside the window SuperPipeline holds it back from pull for. It is a hint, not a fact: the
 *   loop reads the board before it places anything.
 * - Any other event is a nudge: something happened on that board, so the loop looks at the board
 *   soon rather than at the next sweep. Nothing is read from its data. The relay's subscriber for
 *   this service takes card events only (`evt.*.superpipeline.card.>`), so other events reach it
 *   only from a relay configured wider.
 *
 * The sweep stays the guarantee.
 *
 * Each delivery is a CloudEvent in HTTP binary mode, signed in `x-treaty-signature` over the
 * timestamp, the event id and the exact body, and checked with treaty's `verifyDelivery` before
 * anything else is believed:
 *
 * - not a CloudEvent: 400, before the signature is checked (there is no id to check it over);
 * - a bad, stale or missing signature: 401;
 * - a `card.ready` v1 that is not treaty's `card.ready.v1`, names another board, or a card id
 *   SuperPipeline never writes: 400;
 * - a board that could not be read just now (the store failed): 503, so the relay sends it again;
 * - a SuperPipeline event for an opted-in, enabled board: 200 `{status:"accepted"}`, and the board
 *   is nudged;
 * - anything else (another producer, a board not opted in or disabled): 200 `{status:"ignored"}`,
 *   so the relay does not retry what this service will never act on.
 *
 * The answers are the suite's receiver status contract (treaty `schemas/README.md`): 2xx handled or
 * permanently ignored, 503 transient and sent again, any other 4xx refused for good.
 */
import {
  SIGNATURE_HEADER,
  eventType,
  fromBinary,
  parseType,
  verifyDelivery,
} from "@superjackfruitlabs/treaty-cloudevents";
import {
  createBundle,
  validatorFor,
} from "@superjackfruitlabs/treaty-contracts";
import cardReadySchema from "@superjackfruitlabs/treaty-event-schemas/superpipeline/card.ready.v1.json" with { type: "json" };
import type { Store } from "../store/index.ts";
import { readBody, tooLarge } from "./body.ts";

export const RELAY_EVENTS_PATH = "/v1/relay/events";

/** The largest delivery accepted. A board event is a few kilobytes. */
export const MAX_RELAY_BODY = 256 * 1024;

/** The source SuperPipeline gives a board's events. */
const BOARD_SOURCE = /^\/superpipeline\/boards\/(brd_[0-9a-f]{16})$/;

/** A SuperPipeline card id. */
const CARD_ID = /^card_[0-9a-f]{16}$/;

/** Treaty's schema for a `card.ready` body, and the one CloudEvents type it is read under. */
const CARD_READY_SCHEMA = "schemas/superpipeline/card.ready.v1.json";
export const CARD_READY_V1 = eventType(
  { product: "superpipeline", entity: "card", verb: "ready" },
  1,
);
const isCardReady = validatorFor(
  createBundle({ [CARD_READY_SCHEMA]: cardReadySchema }),
  CARD_READY_SCHEMA,
);

/**
 * The card a `card.ready` v1 names: null when the event is not one, `"invalid"` when its body is
 * not treaty's `card.ready.v1`, is another board's, or names a card id SuperPipeline never writes.
 */
export function readyCardOf(
  type: string,
  body: Uint8Array,
  boardId: string,
): { cardId: string } | "invalid" | null {
  if (type !== CARD_READY_V1) return null;
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return "invalid";
  }
  if (!isCardReady(data).valid || typeof data !== "object" || data === null)
    return "invalid";
  // The schema holds both as strings.
  const readyBoard: unknown = Reflect.get(data, "boardId");
  const cardId: unknown = Reflect.get(data, "cardId");
  if (
    readyBoard !== boardId ||
    typeof cardId !== "string" ||
    !CARD_ID.test(cardId)
  )
    return "invalid";
  return { cardId };
}

export interface RelayDeps {
  /** The secret the relay signs this service's deliveries with. */
  secret: string;
  store: Pick<Store, "getBoard">;
  /** Told of each board an accepted event was about, but a `card.ready`. Must not throw or wait. */
  onBoardEvent?: (boardId: string) => void;
  /**
   * Told of each card an accepted `card.ready` named. Must not throw or wait. Unset, a `card.ready`
   * is a nudge like any other event.
   */
  onCardReady?: (boardId: string, cardId: string) => void;
  log?: (line: string) => void;
  /** Test seam for the signature's clock. */
  nowMs?: () => number;
}

export function createRelayHandler(deps: RelayDeps) {
  const log = deps.log ?? console.log;
  return async (request: Request): Promise<Response> => {
    const bytes = await readBody(request, MAX_RELAY_BODY);
    if (bytes === null) return tooLarge();

    let attributes: Record<string, string>;
    try {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      attributes = fromBinary({ headers, body: bytes }, "http").attributes;
    } catch {
      return Response.json({ error: "not a CloudEvent" }, { status: 400 });
    }
    const id = attributes.id ?? "";

    try {
      await verifyDelivery(
        deps.secret,
        request.headers.get(SIGNATURE_HEADER),
        id,
        bytes,
        deps.nowMs ? { nowMs: deps.nowMs() } : {},
      );
    } catch {
      log(`relay: event ${JSON.stringify(id)} refused: bad signature`);
      return Response.json({ error: "bad signature" }, { status: 401 });
    }

    let product = "";
    try {
      product = parseType(attributes.type ?? "").product;
    } catch {
      product = "";
    }
    const boardId = BOARD_SOURCE.exec(attributes.source ?? "")?.[1];
    if (product !== "superpipeline" || boardId === undefined) {
      return Response.json({ status: "ignored" });
    }
    const ready = readyCardOf(attributes.type ?? "", bytes, boardId);
    if (ready === "invalid") {
      log(`relay: event ${JSON.stringify(id)} refused: not a card.ready`);
      return Response.json({ error: "not a card.ready" }, { status: 400 });
    }
    let enabled: boolean;
    try {
      enabled = deps.store.getBoard(boardId)?.enabled === true;
    } catch {
      // The error may name a path: it is not logged, only that it happened.
      log(
        `relay: event ${JSON.stringify(id)} answered 503: its board could not be read just now; the relay sends it again`,
      );
      return Response.json({ error: "try again" }, { status: 503 });
    }
    if (!enabled) return Response.json({ status: "ignored" });
    if (ready !== null && deps.onCardReady !== undefined)
      deps.onCardReady(boardId, ready.cardId);
    else deps.onBoardEvent?.(boardId);
    return Response.json({ status: "accepted" });
  };
}
