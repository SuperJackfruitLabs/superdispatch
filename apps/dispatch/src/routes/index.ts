/**
 * The service's HTTP surface, one dispatcher over:
 *
 * - `GET /healthz`: the health check;
 * - `POST /v1/relay/events`: the event relay's signed deliveries (`relay.ts`);
 * - `/v1/boards…`, `/v1/decisions…` and `/v1/suggestions…`: the operator's API (`operator.ts`);
 * - `/v1/dataset` and `/v1/models…`: the operator's learned-routing API (`learned.ts`).
 *
 * Anything else is 404.
 */
import type { Config } from "../config.ts";
import type { Store } from "../store/index.ts";
import { notFound } from "./body.ts";
import {
  BOARDS_PATH,
  DECISIONS_PATH,
  SUGGESTIONS_PATH,
  createOperatorHandler,
} from "./operator.ts";
import { RELAY_EVENTS_PATH, createRelayHandler } from "./relay.ts";
import { randomBytes } from "node:crypto";
import { LEARNED_OFF, type LearnedSettings } from "../loop/learned.ts";
import { DATASET_PATH, MODELS_PATH, createLearnedHandler } from "./learned.ts";

export const SERVICE = "superdispatch";

export interface HandlerDeps {
  config: Pick<Config, "relayDeliverySecret" | "operatorTokenSha256">;
  store: Store;
  /** Told of each board the relay accepted an event about, or the operator just opted in. */
  onBoard?: (boardId: string) => void;
  /** Told of each card the relay said became ready. */
  onCardReady?: (boardId: string, cardId: string) => void;
  /** Told of each board the operator just opted in or out. */
  onBoardChanged?: (boardId: string) => void;
  now?: () => number;
  log?: (line: string) => void;
  /** Test seam for the relay signature's clock. */
  nowMs?: () => number;
  /** The learned-routing settings in force; off when unset. */
  learned?: LearnedSettings;
  /** A new model id: `mdl_` and 24 hex digits. */
  newModelId?: () => string;
}

export function createHandler(deps: HandlerDeps) {
  const log = deps.log ?? console.log;
  const relay = createRelayHandler({
    secret: deps.config.relayDeliverySecret,
    store: deps.store,
    log,
    ...(deps.onBoard ? { onBoardEvent: deps.onBoard } : {}),
    ...(deps.onCardReady ? { onCardReady: deps.onCardReady } : {}),
    ...(deps.nowMs ? { nowMs: deps.nowMs } : {}),
  });
  const operator = createOperatorHandler({
    operatorTokenSha256: deps.config.operatorTokenSha256,
    store: deps.store,
    now: deps.now ?? Date.now,
    log,
    ...(deps.onBoard ? { onBoardEnabled: deps.onBoard } : {}),
    ...(deps.onBoardChanged ? { onBoardChanged: deps.onBoardChanged } : {}),
  });

  const learned = createLearnedHandler({
    operatorTokenSha256: deps.config.operatorTokenSha256,
    store: deps.store,
    settings: deps.learned ?? LEARNED_OFF,
    now: deps.now ?? Date.now,
    newModelId:
      deps.newModelId ?? (() => `mdl_${randomBytes(12).toString("hex")}`),
    log,
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
    if (
      pathname === DATASET_PATH ||
      pathname === MODELS_PATH ||
      pathname.startsWith(`${MODELS_PATH}/`)
    )
      return learned(request);
    for (const prefix of [BOARDS_PATH, DECISIONS_PATH, SUGGESTIONS_PATH]) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`))
        return operator(request);
    }
    return notFound();
  };
}
