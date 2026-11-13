/**
 * SuperPipeline, as placement needs it, with this service's own token (audience: SuperPipeline's
 * URL; `createServiceTokens`):
 *
 * - `GET /v1/boards/:boardId` (scope `cards:read`): the board's stages and cards. The loop reads
 *   the ready cards from it, and what became of a card it reserved: its stage, its state, its
 *   attempt count and the agent of its latest run.
 * - `GET /v1/boards/:boardId/cards/:cardId/eligibility` (scope `dispatch:read`): every agent of
 *   the workspace judged against the card's current stage by the claim's own filter, with the
 *   `ClaimReason` codes for each one that may not claim it, and the card's own reasons.
 * - `PUT /v1/boards/:boardId/cards/:cardId/reservation` `{agentId, ttlSeconds, decisionId}` (scope
 *   `dispatch:reserve`): hold the card for the chosen agent; it lapses on its own.
 *   `DELETE …/reservation` clears a hold.
 *
 * - `PUT /v1/boards/:boardId/scheduling` `{placementWindowSeconds}` (scope `dispatch:reserve`): the
 *   board's placement window, set when it is opted in and 0 when it is opted out. Inside it,
 *   SuperPipeline holds a card that just became ready back from pull so it can be placed first. A
 *   SuperPipeline without it answers 404, and cards are claimed by pull as before.
 *
 * - `GET /v1/agents/load` (scope `dispatch:read`): every agent of the workspace with the cards it
 *   holds over every board (`inFlight`), its `capacity` and its latest run heartbeat
 *   (`lastHeartbeatAt`): the load and health of an agent that claims with its own token, read
 *   once a pass when the candidate set is `all`. A SuperPipeline without it answers 404, and no
 *   agent off the roster becomes a candidate.
 *
 * The reservation verb is SuperPipeline's step 1 of the scheduler plan. Until a SuperPipeline
 * deployment has it, `PUT` answers 404 or 405, the loop records the decision as `not-reserved`,
 * and cards are claimed by pull exactly as before.
 *
 * A refusal throws `SourceError`, because "no cards" and "this token is refused" must never read
 * alike; a 401 also drops the held token, so the next call asks the plane for a new one. The
 * reservation answers its refusal instead of throwing: it is an outcome to record.
 */
import type { ServiceTokens } from "./accounts.ts";
import { ISOLATION_ORDER, type StageNeeds } from "./capabilities.ts";
import {
  SourceError,
  call,
  enc,
  errorCode,
  field,
  isoTime,
  okBody,
  type Answer,
  type CallDeps,
} from "./http.ts";

/** A board stage, as far as placement reads it. */
export interface StageView {
  key: string;
  /** `capability`, `agent` or `human`; null when the board did not say. */
  ownerKind: string | null;
  /** The stage's `requires` is set: a capability lane even with no `ownerKind`. */
  hasRequires: boolean;
  /**
   * The capabilities the lane asks for, as SuperPipeline's claim matches them: every one of `all`
   * and, when `any` is set, one of `any`. A stage without `requires` asks for its `owner`
   * capability. Both empty when the stage asks for none.
   */
  requires: { all: string[]; any: string[] };
  /**
   * What a station needs to work the stage (the stage's `placement`), for the station filters;
   * null when the stage states none, or this SuperPipeline has no such field.
   */
  placement: StageNeeds | null;
}

/** A card, as far as placement reads it. */
export interface CardView {
  id: string;
  stageKey: string;
  /** The card's task state: `submitted` is waiting to be claimed. */
  state: string;
  currentRunId: string | null;
  /** The agent of the card's latest run, whatever its status; null with no runs. */
  lastAgentId: string | null;
  attemptCount: number;
  priority: number;
  createdAt: string;
  archived: boolean;
  /** A live hold, when this SuperPipeline shows one (`card.reservation`). */
  reservation: { agentId: string; reservedUntil: string } | null;
}

export interface BoardView {
  boardId: string;
  stages: StageView[];
  cards: CardView[];
}

export interface EligibilityView {
  stageKey: string;
  /** The card's own reasons: when any is set, no agent may claim it now. */
  reasons: string[];
  agents: Array<{
    agentId: string;
    principalId: string | null;
    eligible: boolean;
    reasons: string[];
  }>;
}

/** One agent's load as SuperPipeline reports it; `directLoad` turns it into the shared shape. */
export interface DirectLoadEntry {
  agentId: string;
  principalId: string | null;
  /** Cards it holds over every board; null when the answer had no whole number for it. */
  inFlight: number | null;
  /** The most cards it may hold at once; null when not reported. */
  capacity: number | null;
  /** Its latest run heartbeat on any board, ISO; null when it never ran. */
  lastHeartbeatAt: string | null;
}

export type ReserveAnswer =
  | { ok: true; reservedUntil: string }
  | { ok: false; status: number; code: string };

export interface Superpipeline {
  board(boardId: string): Promise<BoardView>;
  eligibility(boardId: string, cardId: string): Promise<EligibilityView>;
  reserve(
    boardId: string,
    cardId: string,
    hold: { agentId: string; ttlSeconds: number; decisionId: string },
  ): Promise<ReserveAnswer>;
  clearReservation(boardId: string, cardId: string): Promise<void>;
  /** Set the board's placement window, 0 to 30 seconds; 0 is none. Throws `SourceError`. */
  setPlacementWindow(boardId: string, seconds: number): Promise<void>;
  /** Every agent's load over the workspace (`GET /v1/agents/load`). Throws `SourceError`. */
  agentLoad(): Promise<DirectLoadEntry[]>;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function stageOf(raw: unknown): StageView | null {
  const key = str(field(raw, "key"));
  if (key === null) return null;
  const requires = field(raw, "requires");
  const all = strings(field(requires, "all"));
  const any = strings(field(requires, "any"));
  const ownerKind = str(field(raw, "ownerKind"));
  const hasRequires = all.length > 0 || any.length > 0;
  const owner = str(field(raw, "owner"));
  return {
    key,
    ownerKind,
    hasRequires,
    placement: placementOf(field(raw, "placement")),
    requires:
      !hasRequires && ownerKind === "capability" && owner !== null
        ? { all: [owner], any: [] }
        : { all, any },
  };
}

/**
 * A stage's placement, or null when it states nothing. An isolation level this service does not
 * know is kept as the strongest, so an unknown need is never read as no need.
 */
export function placementOf(raw: unknown): StageNeeds | null {
  if (typeof raw !== "object" || raw === null) return null;
  const iso = str(field(raw, "isolation"));
  const lists = {
    models: strings(field(raw, "models")),
    tools: strings(field(raw, "tools")),
    credentials: strings(field(raw, "credentials")),
  };
  const needs: StageNeeds = {
    ...(iso !== null
      ? { isolation: ISOLATION_ORDER.find((l) => l === iso) ?? "sandbox" }
      : {}),
    ...(lists.models.length > 0 ? { models: lists.models } : {}),
    ...(lists.tools.length > 0 ? { tools: lists.tools } : {}),
    ...(lists.credentials.length > 0 ? { credentials: lists.credentials } : {}),
  };
  return Object.keys(needs).length > 0 ? needs : null;
}

function cardOf(raw: unknown): CardView | null {
  const id = str(field(raw, "id"));
  const stageKey = str(field(raw, "currentStageKey"));
  const state = str(field(raw, "state"));
  if (id === null || stageKey === null || state === null) return null;
  const hold = field(raw, "reservation");
  const holdAgent = str(field(hold, "agentId"));
  const holdUntil = isoTime(field(hold, "reservedUntil"));
  return {
    id,
    stageKey,
    state,
    currentRunId: str(field(raw, "currentRunId")),
    lastAgentId: str(field(raw, "lastAgentId")),
    attemptCount: num(field(raw, "attemptCount")),
    priority: num(field(raw, "priority")),
    createdAt: isoTime(field(raw, "createdAt")) ?? "",
    archived: str(field(raw, "archivedAt")) !== null,
    reservation:
      holdAgent !== null && holdUntil !== null
        ? { agentId: holdAgent, reservedUntil: holdUntil }
        : null,
  };
}

export function createSuperpipeline(
  deps: { baseUrl: string; tokens: ServiceTokens } & Omit<CallDeps, "product">,
): Superpipeline {
  const base = deps.baseUrl.replace(/\/+$/, "");
  const http: CallDeps = { ...deps, product: "superpipeline" };

  async function authed(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Answer> {
    const token = await deps.tokens.get();
    const answer = await call(http, `${base}${path}`, {
      method,
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { body } : {}),
    });
    if (answer.status === 401) deps.tokens.invalidate();
    return answer;
  }

  return {
    async board(boardId) {
      const json = okBody(
        "superpipeline",
        await authed("GET", `/v1/boards/${enc(boardId)}`),
      );
      const stages = field(json, "stages");
      const cards = field(json, "cards");
      if (!Array.isArray(stages) || !Array.isArray(cards)) {
        throw new SourceError("superpipeline", 200, "malformed_response");
      }
      return {
        boardId,
        stages: stages.map(stageOf).filter((s) => s !== null),
        cards: cards.map(cardOf).filter((c) => c !== null),
      };
    },

    async eligibility(boardId, cardId) {
      const json = okBody(
        "superpipeline",
        await authed(
          "GET",
          `/v1/boards/${enc(boardId)}/cards/${enc(cardId)}/eligibility`,
        ),
      );
      const agents = field(json, "agents");
      const stageKey = str(field(json, "stageKey"));
      if (!Array.isArray(agents) || stageKey === null) {
        throw new SourceError("superpipeline", 200, "malformed_response");
      }
      return {
        stageKey,
        reasons: strings(field(json, "reasons")),
        agents: agents.flatMap((a) => {
          const agentId = str(field(a, "agentId"));
          if (agentId === null) return [];
          return [
            {
              agentId,
              principalId: str(field(a, "principalId")),
              eligible: field(a, "eligible") === true,
              reasons: strings(field(a, "reasons")),
            },
          ];
        }),
      };
    },

    async reserve(boardId, cardId, hold) {
      const answer = await authed(
        "PUT",
        `/v1/boards/${enc(boardId)}/cards/${enc(cardId)}/reservation`,
        hold,
      );
      if (answer.status >= 200 && answer.status < 300) {
        const until = isoTime(
          field(field(answer.json, "reservation"), "reservedUntil"),
        );
        if (until === null)
          return {
            ok: false,
            status: answer.status,
            code: "malformed_response",
          };
        return { ok: true, reservedUntil: until };
      }
      return {
        ok: false,
        status: answer.status,
        code: errorCode(answer.json) ?? `HTTP_${answer.status}`,
      };
    },

    async agentLoad() {
      const agents = field(
        okBody("superpipeline", await authed("GET", "/v1/agents/load")),
        "agents",
      );
      if (!Array.isArray(agents)) {
        throw new SourceError("superpipeline", 200, "malformed_response");
      }
      const whole = (value: unknown): number | null =>
        typeof value === "number" && Number.isInteger(value) && value >= 0
          ? value
          : null;
      return agents.flatMap((a): DirectLoadEntry[] => {
        const agentId = str(field(a, "agentId"));
        if (agentId === null) return [];
        return [
          {
            agentId,
            principalId: str(field(a, "principalId")),
            inFlight: whole(field(a, "inFlight")),
            capacity: whole(field(a, "capacity")),
            lastHeartbeatAt: isoTime(field(a, "lastHeartbeatAt")),
          },
        ];
      });
    },

    async setPlacementWindow(boardId, seconds) {
      okBody(
        "superpipeline",
        await authed("PUT", `/v1/boards/${enc(boardId)}/scheduling`, {
          placementWindowSeconds: seconds,
        }),
      );
    },

    async clearReservation(boardId, cardId) {
      const answer = await authed(
        "DELETE",
        `/v1/boards/${enc(boardId)}/cards/${enc(cardId)}/reservation`,
      );
      if (answer.status !== 204 && answer.status !== 404) {
        okBody("superpipeline", answer);
      }
    },
  };
}
