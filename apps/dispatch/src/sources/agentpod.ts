/**
 * AgentPod, as placement needs it: a board's roster, with this service's own token (audience: the
 * hub's `ORG_PLANE_AUDIENCE`; `createServiceTokens`), on
 * `GET /api/bridge/boards/:boardId/roster`. Every bridge row on the board: the station it claims
 * on and that station's agent principal, whether the row is enabled, whether the bridge would
 * claim on the station now (`ready`), whether the station has work in hand on any board (`busy`),
 * and when it last took work. The hub admits the read for a service listed in its
 * `ROSTER_READERS`.
 *
 * And its capability registry (charter 2026-11-13), on `GET /api/catalog/stations`: each station's
 * isolation, model, tools and credential names, each with its proof. The hub admits it for a
 * service listed in its `CATALOG_READERS`. A hub without the read answers 404, and then the answer
 * is null: placement leaves every stated need unchecked rather than refuse every candidate.
 *
 * Both bodies are held to treaty's `capability-catalog.v1` first (`./contracts.ts`): a body it
 * refuses is `contract_refused`, never read in part.
 *
 * Reads only: a roster is AgentPod's, and a change to it is a person's. A refusal throws
 * `SourceError`; a 401 drops the held token.
 */
import type { StationCaps } from "./capabilities.ts";
import type { ServiceTokens } from "./accounts.ts";
import { contractBody, type WireStation } from "./contracts.ts";
import { call, enc, isoTime, type CallDeps } from "./http.ts";

export interface RosterEntry {
  key: string;
  stationId: string;
  principalId: string | null;
  enabled: boolean;
  ready: boolean;
  busy: boolean;
  lastDispatchedAt: string | null;
}

export interface Agentpod {
  roster(boardId: string): Promise<RosterEntry[]>;
  /** Every station's registry row, by station; null when this AgentPod has no catalog read. */
  stationCapabilities(): Promise<Map<string, StationCaps> | null>;
}

/** One registry row, as station filtering reads it. */
export function stationCapsOf(raw: WireStation): StationCaps {
  return {
    stationId: raw.stationId,
    principalId: raw.principalId,
    harness: raw.harness,
    isolation: {
      level: raw.isolation.level,
      proof: raw.isolation.proof,
      runtime: raw.isolation.runtime,
    },
    model:
      raw.model === null ? null : { id: raw.model.id, proof: raw.model.proof },
    tools: raw.tools.map((t) => ({ id: t.id, proof: t.proof })),
    credentials: raw.credentials.map((c) => ({ name: c.name, proof: c.proof })),
  };
}

export function createAgentpod(
  deps: { baseUrl: string; tokens: ServiceTokens } & Omit<CallDeps, "product">,
): Agentpod {
  const base = deps.baseUrl.replace(/\/+$/, "");
  const http: CallDeps = { ...deps, product: "agentpod" };
  return {
    async roster(boardId) {
      const token = await deps.tokens.get();
      const answer = await call(
        http,
        `${base}/api/bridge/boards/${enc(boardId)}/roster`,
        { method: "GET", authorization: `Bearer ${token}` },
      );
      if (answer.status === 401) deps.tokens.invalidate();
      const json = contractBody(
        "agentpod",
        "agentpod.capability-catalog",
        "readBoardRoster",
        answer,
      );
      return json.agents.map(
        (a): RosterEntry => ({
          key: a.key,
          stationId: a.stationId,
          principalId: a.principalId === "" ? null : a.principalId,
          enabled: a.enabled,
          ready: a.ready,
          busy: a.busy,
          lastDispatchedAt: isoTime(a.lastDispatchedAt),
        }),
      );
    },

    async stationCapabilities() {
      const token = await deps.tokens.get();
      const answer = await call(http, `${base}/api/catalog/stations`, {
        method: "GET",
        authorization: `Bearer ${token}`,
      });
      if (answer.status === 401) deps.tokens.invalidate();
      // A hub without the read is not a refusal: it has no registry to check against.
      if (answer.status === 404) return null;
      const json = contractBody(
        "agentpod",
        "agentpod.capability-catalog",
        "listStationCapabilities",
        answer,
      );
      const out = new Map<string, StationCaps>();
      for (const row of json.stations)
        out.set(row.stationId, stationCapsOf(row));
      return out;
    },
  };
}
