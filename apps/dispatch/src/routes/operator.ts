/**
 * The operator's API. Every request carries `Authorization: Bearer <token>`, whose SHA-256 must
 * equal `SUPERDISPATCH_OPERATOR_TOKEN_SHA256`; the check is constant-time and comes before
 * anything is read, and a refusal is 401 and says nothing else.
 *
 * Boards (which boards SuperDispatch places cards on; none until one is opted in):
 *
 * - `GET /v1/boards`: every board opted in, enabled or not.
 * - `PUT /v1/boards/:boardId`: opt a board in, or enable it again. No body.
 * - `DELETE /v1/boards/:boardId`: opt it out. The row stays, so it can be listed and enabled
 *   again; decisions already made stay readable, and holds already made lapse on their own.
 * - `GET /v1/boards/:boardId`: one board.
 *
 * Decisions (the record of every placement, newest first):
 *
 * - `GET /v1/decisions?board=&card=&before=&limit=`: optionally one board, one card (with its
 *   board), those made before a time; `limit` 1 to 200, 50 when unset.
 * - `GET /v1/decisions/:id`: one decision.
 *
 * Roster suggestions (advice for a person: SuperDispatch never edits a roster, and nothing here
 * writes to another product):
 *
 * - `GET /v1/suggestions?board=&state=`: newest seen first, optionally one board; `state` is
 *   `open` (the default: not resolved, not dismissed), `dismissed`, `resolved` or `all`.
 * - `GET /v1/suggestions/:id`: one suggestion.
 * - `POST /v1/suggestions/:id/dismiss`: dismiss it. It stays dismissed while it is found again; if
 *   it resolves and comes back later, it opens anew.
 */
import { tokenMatchesSha256 } from "../config.ts";
import {
  SUGGESTION_STATES,
  type Board,
  type DecisionRow,
  type Store,
  type SuggestionRow,
  type SuggestionState,
} from "../store/index.ts";
import { BOARD_ID, CARD_ID, notAllowed, notFound } from "./body.ts";

export const BOARDS_PATH = "/v1/boards";
export const DECISIONS_PATH = "/v1/decisions";
export const SUGGESTIONS_PATH = "/v1/suggestions";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DECISION_ID = /^pld_[0-9a-f]{24}$/;
const SUGGESTION_ID = /^sug_[0-9a-f]{24}$/;

export interface OperatorDeps {
  /** The SHA-256 of the operator's token, 64 hex digits. */
  operatorTokenSha256: string;
  store: Pick<
    Store,
    | "enableBoard"
    | "disableBoard"
    | "getBoard"
    | "listBoards"
    | "listDecisions"
    | "getDecision"
    | "listSuggestions"
    | "getSuggestion"
    | "dismissSuggestion"
  >;
  /** Told of a board just opted in, so it is looked at without waiting for the sweep. */
  onBoardEnabled?: (boardId: string) => void;
  now: () => number;
  log?: (line: string) => void;
}

export function createOperatorHandler(deps: OperatorDeps) {
  const log = deps.log ?? console.log;
  return async (request: Request): Promise<Response> => {
    const header = request.headers.get("authorization") ?? "";
    const presented = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] ?? "";
    if (
      presented === "" ||
      !tokenMatchesSha256(deps.operatorTokenSha256, presented)
    ) {
      return Response.json(
        { error: "unauthorized" },
        { status: 401, headers: { "www-authenticate": "Bearer" } },
      );
    }
    const url = new URL(request.url);
    if (
      url.pathname === DECISIONS_PATH ||
      url.pathname.startsWith(`${DECISIONS_PATH}/`)
    ) {
      return request.method === "GET" ? decisions(url) : notAllowed();
    }
    if (
      url.pathname === SUGGESTIONS_PATH ||
      url.pathname.startsWith(`${SUGGESTIONS_PATH}/`)
    ) {
      return suggestions(request, url);
    }
    return boards(request, url.pathname);
  };

  function boards(request: Request, pathname: string): Response {
    if (pathname === BOARDS_PATH) {
      if (request.method !== "GET") return notAllowed();
      return Response.json({ boards: deps.store.listBoards().map(boardView) });
    }
    const boardId = pathname.slice(BOARDS_PATH.length + 1);
    if (boardId.includes("/")) return notFound();
    if (!BOARD_ID.test(boardId)) {
      return Response.json({ error: "not a board id" }, { status: 400 });
    }
    const at = new Date(deps.now()).toISOString();
    if (request.method === "PUT") {
      const board = deps.store.enableBoard(boardId, at);
      log(`boards: ${boardId} enabled`);
      deps.onBoardEnabled?.(boardId);
      return Response.json({ board: boardView(board) });
    }
    if (request.method === "DELETE") {
      const board = deps.store.disableBoard(boardId, at);
      if (board === null) return notFound();
      log(`boards: ${boardId} disabled`);
      return Response.json({ board: boardView(board) });
    }
    if (request.method === "GET") {
      const board = deps.store.getBoard(boardId);
      return board ? Response.json({ board: boardView(board) }) : notFound();
    }
    return notAllowed();
  }

  function decisions(url: URL): Response {
    const rest = url.pathname.slice(DECISIONS_PATH.length + 1);
    if (rest !== "") {
      if (!DECISION_ID.test(rest)) return notFound();
      const found = deps.store.getDecision(rest);
      return found
        ? Response.json({ decision: decisionView(found) })
        : notFound();
    }
    const q = url.searchParams;
    const board = q.get("board") ?? undefined;
    const card = q.get("card") ?? undefined;
    const before = q.get("before") ?? undefined;
    const rawLimit = q.get("limit");
    if (board !== undefined && !BOARD_ID.test(board))
      return bad("board is not a board id");
    if (card !== undefined && !CARD_ID.test(card))
      return bad("card is not a card id");
    if (card !== undefined && board === undefined)
      return bad("card needs its board");
    let beforeIso: string | undefined;
    if (before !== undefined) {
      const ms = Date.parse(before);
      if (!Number.isFinite(ms)) return bad("before is not a time");
      beforeIso = new Date(ms).toISOString();
    }
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== null) {
      limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
        return bad(`limit is not a whole number from 1 to ${MAX_LIMIT}`);
    }
    const rows = deps.store.listDecisions({
      ...(board !== undefined ? { boardId: board } : {}),
      ...(card !== undefined ? { cardId: card } : {}),
      ...(beforeIso !== undefined ? { before: beforeIso } : {}),
      limit,
    });
    return Response.json({ decisions: rows.map(decisionView) });
  }

  function suggestions(request: Request, url: URL): Response {
    const rest = url.pathname.slice(SUGGESTIONS_PATH.length + 1);
    if (rest === "") {
      if (request.method !== "GET") return notAllowed();
      const board = url.searchParams.get("board") ?? undefined;
      const state = url.searchParams.get("state") ?? "open";
      if (board !== undefined && !BOARD_ID.test(board))
        return bad("board is not a board id");
      if (!(SUGGESTION_STATES as readonly string[]).includes(state))
        return bad(`state is not one of ${SUGGESTION_STATES.join(", ")}`);
      const rows = deps.store.listSuggestions({
        ...(board !== undefined ? { boardId: board } : {}),
        state: state as SuggestionState,
      });
      return Response.json({ suggestions: rows.map(suggestionView) });
    }
    const [id, verb, ...more] = rest.split("/");
    if (id === undefined || !SUGGESTION_ID.test(id) || more.length > 0)
      return notFound();
    if (verb === undefined) {
      if (request.method !== "GET") return notAllowed();
      const found = deps.store.getSuggestion(id);
      return found
        ? Response.json({ suggestion: suggestionView(found) })
        : notFound();
    }
    if (verb !== "dismiss") return notFound();
    if (request.method !== "POST") return notAllowed();
    const dismissed = deps.store.dismissSuggestion(
      id,
      new Date(deps.now()).toISOString(),
    );
    if (dismissed === null) return notFound();
    log(`suggestions: ${id} dismissed`);
    return Response.json({ suggestion: suggestionView(dismissed) });
  }
}

const bad = (error: string) => Response.json({ error }, { status: 400 });

function boardView(board: Board) {
  return {
    boardId: board.boardId,
    enabled: board.enabled,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
  };
}

/** A decision as the operator reads it: the record alone answers "why did this go there?". */
export function decisionView(d: DecisionRow) {
  return {
    id: d.id,
    boardId: d.boardId,
    cardId: d.cardId,
    stageKey: d.stageKey,
    policy: d.policy,
    chosen: d.chosenAgent,
    reason: d.noDecisionReason,
    tier: d.tier !== null ? { name: d.tier, step: d.tierStep } : null,
    requires: d.requires ?? null,
    candidates: d.candidates,
    reservation:
      d.reservedUntil !== null ? { reservedUntil: d.reservedUntil } : null,
    reservationRefused: d.reservationRefused,
    outcome:
      d.outcome !== null
        ? { status: d.outcome, by: d.outcomeBy, at: d.outcomeAt }
        : null,
    createdAt: d.createdAt,
  };
}

/** A suggestion as the operator reads it: advice, with the decisions that bear it out. */
export function suggestionView(s: SuggestionRow) {
  const body =
    typeof s.body === "object" && s.body !== null
      ? (s.body as Record<string, unknown>)
      : {};
  return {
    id: s.id,
    kind: s.kind,
    boardId: s.boardId,
    stageKey: s.stageKey,
    capability: body.capability ?? null,
    rostered: body.rostered ?? [],
    candidates: body.candidates ?? [],
    reasons: body.reasons ?? [],
    reason: body.reason ?? null,
    evidence: s.evidence,
    evidenceCount: s.evidenceCount,
    firstSeenAt: s.firstSeenAt,
    lastSeenAt: s.lastSeenAt,
    resolvedAt: s.resolvedAt,
    dismissedAt: s.dismissedAt,
  };
}
