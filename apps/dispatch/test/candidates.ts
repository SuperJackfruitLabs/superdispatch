import type { CandidateFacts } from "../src/placement/index.ts";

/** The time the learned-routing tests place at: 13:00 UTC. */
export const T0 = Date.parse("2026-11-12T13:00:00.000Z");

/** A rostered, idle, healthy agent, last at work `idleS` seconds ago. */
export function facts(
  agentId: string,
  over: Partial<CandidateFacts> & { idleS?: number; busy?: boolean } = {},
): CandidateFacts {
  const { idleS = 600, busy = false, ...rest } = over;
  return {
    agentId,
    principalId: `prn_${agentId}`,
    pipeline: { eligible: true, reasons: [] },
    roster: { stationId: `stn_${agentId}`, enabled: true },
    load: {
      agentId,
      inFlight: busy ? 1 : 0,
      capacity: 1,
      healthy: true,
      lastSeenAt: new Date(T0 - idleS * 1000).toISOString(),
      source: "roster",
    },
    history: { settled: 0, claimed: 0, noShowsAtMs: [] },
    holds: 0,
    ...rest,
  };
}
