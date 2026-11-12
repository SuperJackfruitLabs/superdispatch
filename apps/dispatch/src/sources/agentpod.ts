/**
 * AgentPod, as placement needs it: a board's roster, with this service's own token (audience: the
 * hub's `ORG_PLANE_AUDIENCE`; `createServiceTokens`), on
 * `GET /api/bridge/boards/:boardId/roster`. Every bridge row on the board: the station it claims
 * on and that station's agent principal, whether the row is enabled, whether the bridge would
 * claim on the station now (`ready`), whether the station has work in hand on any board (`busy`),
 * and when it last took work. The hub admits the read for a service listed in its
 * `ROSTER_READERS`.
 *
 * Reads only: a roster is AgentPod's, and a change to it is a person's. A refusal throws
 * `SourceError`; a 401 drops the held token. A row the hub sends malformed is left out.
 */
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
  };
}
