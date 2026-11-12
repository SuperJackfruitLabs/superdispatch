/**
 * The service's HTTP surface, one dispatcher over:
 *
 * - `GET /healthz`: the health check;
 * - `POST /v1/relay/events`: the event relay's signed deliveries (`relay.ts`);
 * - `/v1/boards…` and `/v1/decisions…`: the operator's API (`operator.ts`).
 *
 * Anything else is 404.
 */
import type { Config } from "../config.ts";
import type { Store } from "../store/index.ts";
import { notFound } from "./body.ts";
import {
  BOARDS_PATH,
  DECISIONS_PATH,
  createOperatorHandler,
} from "./operator.ts";
import { RELAY_EVENTS_PATH, createRelayHandler } from "./relay.ts";

export const SERVICE = "superdispatch";

export interface HandlerDeps {
  config: Pick<Config, "relayDeliverySecret" | "operatorTokenSha256">;
  store: Store;
  /** Told of each board the relay accepted an event about, or the operator just opted in. */
  onBoard?: (boardId: string) => void;
  now?: () => number;
  log?: (line: string) => void;
  /** Test seam for the relay signature's clock. */
  nowMs?: () => number;
}

export function createHandler(deps: HandlerDeps) {
  const log = deps.log ?? console.log;
  const relay = createRelayHandler({
    secret: deps.config.relayDeliverySecret,
    store: deps.store,
    log,
    ...(deps.onBoard ? { onBoardEvent: deps.onBoard } : {}),
    ...(deps.nowMs ? { nowMs: deps.nowMs } : {}),
  });
  const operator = createOperatorHandler({
    operatorTokenSha256: deps.config.operatorTokenSha256,
    store: deps.store,
    now: deps.now ?? Date.now,
    log,
    ...(deps.onBoard ? { onBoardEnabled: deps.onBoard } : {}),
  });

  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      if (request.method === "GET" || request.method === "HEAD") {
        return Response.json({ ok: true, service: SERVICE });
      }
      return notFound();
    }
    if (pathname === RELAY_EVENTS_PATH) {
      return request.method === "POST" ? relay(request) : notFound();
    }
    for (const prefix of [BOARDS_PATH, DECISIONS_PATH]) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`))
        return operator(request);
    }
    return notFound();
  };
}
