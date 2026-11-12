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
 * Reads only: a roster is AgentPod's, and a change to it is a person's. A refusal throws
 * `SourceError`; a 401 drops the held token. A row the hub sends malformed is left out.
 */
import { PROOF_ORDER, type Proof } from "../config.ts";
import type { StationCaps } from "./capabilities.ts";
import type { ServiceTokens } from "./accounts.ts";
import {
  SourceError,
  call,
  enc,
  field,
  isoTime,
  okBody,
  type CallDeps,
} from "./http.ts";

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

/** A proof as the hub spelled it; anything else is the weakest. */
const proofOf = (value: unknown): Proof =>
  PROOF_ORDER.find((p) => p === value) ?? "declared";
const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** One registry row, or null when it names no station. Malformed facts are left out, never guessed. */
export function stationCapsOf(raw: unknown): StationCaps | null {
  const stationId = str(field(raw, "stationId"));
  if (stationId === null) return null;
  const iso = field(raw, "isolation");
  const level = str(field(iso, "level"));
  const model = field(raw, "model");
  const modelId = str(field(model, "id"));
  const list = (value: unknown, key: string) =>
    (Array.isArray(value) ? value : []).flatMap((e: unknown) => {
      const id = str(field(e, key));
      return id === null ? [] : [{ id, proof: proofOf(field(e, "proof")) }];
    });
  return {
    stationId,
    isolation:
      level === null ? null : { level, proof: proofOf(field(iso, "proof")) },
    model:
      modelId === null
        ? null
        : { id: modelId, proof: proofOf(field(model, "proof")) },
    tools: list(field(raw, "tools"), "id"),
    credentials: list(field(raw, "credentials"), "name").map((c) => ({
      name: c.id,
      proof: c.proof,
    })),
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
      const agents = field(okBody("agentpod", answer), "agents");
      if (!Array.isArray(agents)) {
        throw new SourceError("agentpod", 200, "malformed_response");
      }
      return agents.flatMap((a): RosterEntry[] => {
        const key = field(a, "key");
        const stationId = field(a, "stationId");
        const principalId = field(a, "principalId");
        if (typeof key !== "string" || typeof stationId !== "string") return [];
        return [
          {
            key,
            stationId,
            principalId:
              typeof principalId === "string" && principalId !== ""
                ? principalId
                : null,
            // Anything but an explicit yes is a no: an unknown station is not a ready one.
            enabled: field(a, "enabled") === true,
            ready: field(a, "ready") === true,
            // Anything but an explicit no is busy: an unknown load is not an idle agent.
            busy: field(a, "busy") !== false,
            lastDispatchedAt: isoTime(field(a, "lastDispatchedAt")),
          },
        ];
      });
    },

    async stationCapabilities() {
      const token = await deps.tokens.get();
      const answer = await call(http, `${base}/api/catalog/stations`, {
        method: "GET",
        authorization: `Bearer ${token}`,
      });
      if (answer.status === 401) deps.tokens.invalidate();
      if (answer.status === 404) return null;
      const rows = field(okBody("agentpod", answer), "stations");
      if (!Array.isArray(rows)) {
        throw new SourceError("agentpod", 200, "malformed_response");
      }
      const out = new Map<string, StationCaps>();
      for (const row of rows) {
        const caps = stationCapsOf(row);
        if (caps !== null) out.set(caps.stationId, caps);
      }
      return out;
    },
  };
}
