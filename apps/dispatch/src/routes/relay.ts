/**
 * `POST /v1/relay/events`: the suite's event relay delivering a SuperPipeline event. SuperPipeline
 * relays no "a card is ready" event, so a delivery here is a nudge, not a fact: something happened
 * on that board (a gate approved, a held approval released, a check failed and returned a card), so
 * the loop looks at the board now rather than at the next sweep. The sweep stays the guarantee;
 * nothing is read from the event's data.
 *
 * Each delivery is a CloudEvent in HTTP binary mode, signed in `x-treaty-signature` over the
 * timestamp, the event id and the exact body, and checked with treaty's `verifyDelivery` before
 * anything else is believed:
 *
 * - not a CloudEvent: 400, before the signature is checked (there is no id to check it over);
 * - a bad, stale or missing signature: 401;
 * - a SuperPipeline event for an opted-in, enabled board: 200 `{status:"accepted"}`, and the board
 *   is nudged;
 * - anything else (another producer, a board not opted in or disabled): 200 `{status:"ignored"}`,
 *   so the relay does not retry what this service will never act on.
 */
import {
  SIGNATURE_HEADER,
  fromBinary,
  parseType,
  verifyDelivery,
} from "@superjackfruitlabs/treaty-cloudevents";
import type { Store } from "../store/index.ts";
import { readBody, tooLarge } from "./body.ts";

export const RELAY_EVENTS_PATH = "/v1/relay/events";

/** The largest delivery accepted. A board event is a few kilobytes. */
export const MAX_RELAY_BODY = 256 * 1024;

/** The source SuperPipeline gives a board's events. */
const BOARD_SOURCE = /^\/superpipeline\/boards\/(brd_[0-9a-f]{16})$/;

export interface RelayDeps {
  /** The secret the relay signs this service's deliveries with. */
  secret: string;
  store: Pick<Store, "getBoard">;
  /** Told of each board an accepted event was about. Must not throw or wait. */
  onBoardEvent?: (boardId: string) => void;
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
    if (deps.store.getBoard(boardId)?.enabled !== true) {
      return Response.json({ status: "ignored" });
    }
    deps.onBoardEvent?.(boardId);
    return Response.json({ status: "accepted" });
  };
}
