/**
 * One agent's load and health in one shape, whichever product reported it. Placement's health
 * and idle filters read this shape alone, so an agent on AgentPod's roster and an agent that
 * claims with its own token are judged by the same rule:
 *
 * - **healthy**: the agent can be expected to take a card held for it now;
 * - **idle**: `inFlight < capacity`, the work it has in hand against the most it may hold.
 *
 * Two adapters produce it, each a pure function of what its source answered:
 *
 * - `rosterLoad`, from the agent's bridge row on AgentPod's roster (`source: "roster"`): healthy
 *   when the row is enabled and the bridge would claim on the station now (`ready`); one card in
 *   hand when the station is `busy` on any board, else none; capacity 1, because AgentPod reports
 *   busy or not and nothing more; last seen when the station last took work.
 * - `directLoad`, from SuperPipeline's `GET /v1/agents/load` for an agent that claims with its own
 *   token (`source: "direct"`): the cards it holds over every board, its `capacity` (1 when none
 *   is reported, or it is not a whole number above 0), and healthy when it was last heard from on
 *   a run within `DIRECT_SEEN_WITHIN_MS`. An agent never heard from is not healthy: nothing says
 *   it is there. It keeps working by pull, and becomes a candidate once it has run.
 */
import type { RosterEntry } from "./agentpod.ts";
import type { DirectLoadEntry } from "./superpipeline.ts";

/** Where a load came from: AgentPod's roster, or SuperPipeline for an agent with its own token. */
export const LOAD_SOURCES = ["roster", "direct"] as const;
export type LoadSource = (typeof LOAD_SOURCES)[number];

/** One agent's load and health: the shape placement judges every candidate by. */
export interface AgentLoad {
  readonly agentId: string;
  /** Cards the agent has in hand now, anywhere in the workspace. */
  readonly inFlight: number;
  /** The most it may have in hand at once; at least 1. */
  readonly capacity: number;
  /** It can be expected to take a card held for it now. */
  readonly healthy: boolean;
  /** When it was last seen at work (ISO), or null when never. */
  readonly lastSeenAt: string | null;
  readonly source: LoadSource;
}

/**
 * How recently an agent with its own token must have been heard from on a run (its latest
 * heartbeat, on any board) to count as healthy.
 */
export const DIRECT_SEEN_WITHIN_MS = 60 * 60 * 1000;

/** How far ahead of this service's clock SuperPipeline's may run before a heartbeat reads as bogus. */
export const CLOCK_SKEW_MS = 60 * 1000;

/** The shape, from an agent's bridge row on a board's roster. */
export function rosterLoad(
  agentId: string,
  entry: Pick<RosterEntry, "enabled" | "ready" | "busy" | "lastDispatchedAt">,
): AgentLoad {
  return {
    agentId,
    inFlight: entry.busy ? 1 : 0,
    capacity: 1,
    healthy: entry.enabled && entry.ready,
    lastSeenAt: entry.lastDispatchedAt,
    source: "roster",
  };
}

/** The shape, from SuperPipeline's load read, for an agent that claims with its own token. */
export function directLoad(entry: DirectLoadEntry, nowMs: number): AgentLoad {
  const seenMs =
    entry.lastHeartbeatAt === null ? NaN : Date.parse(entry.lastHeartbeatAt);
  const { capacity, inFlight } = entry;
  return {
    agentId: entry.agentId,
    // An unknown load is not an idle agent: anything but a whole number reads as no room.
    inFlight:
      inFlight !== null && Number.isInteger(inFlight) && inFlight >= 0
        ? inFlight
        : Number.MAX_SAFE_INTEGER,
    capacity:
      capacity !== null && Number.isInteger(capacity) && capacity > 0
        ? capacity
        : 1,
    healthy:
      Number.isFinite(seenMs) &&
      seenMs - nowMs <= CLOCK_SKEW_MS &&
      nowMs - seenMs <= DIRECT_SEEN_WITHIN_MS,
    lastSeenAt: entry.lastHeartbeatAt,
    source: "direct",
  };
}

/** Has the agent room for another card: less in hand than it may hold? */
export function isIdle(load: AgentLoad): boolean {
  return load.inFlight < load.capacity;
}
