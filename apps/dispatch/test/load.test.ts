import { describe, expect, test } from "bun:test";
import {
  CLOCK_SKEW_MS,
  DIRECT_SEEN_WITHIN_MS,
  SourceError,
  createSuperpipeline,
  directLoad,
  isIdle,
  rosterLoad,
  type DirectLoadEntry,
} from "../src/sources/index.ts";
import { fakeFetch } from "./helpers.ts";

/**
 * The shared shape of an agent's load and health, `{agentId, inFlight, capacity, healthy,
 * lastSeenAt, source}`, and the two adapters that produce it: AgentPod's roster row for a rostered
 * agent, SuperPipeline's load read for an agent that claims with its own token.
 */

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const row = (
  over: Partial<{
    enabled: boolean;
    ready: boolean;
    busy: boolean;
    lastDispatchedAt: string | null;
  }> = {},
) => ({
  enabled: true,
  ready: true,
  busy: false,
  lastDispatchedAt: iso(NOW - 5 * MIN),
  ...over,
});

const reported = (over: Partial<DirectLoadEntry> = {}): DirectLoadEntry => ({
  agentId: "agt_d",
  principalId: "prn_d",
  inFlight: 0,
  capacity: 1,
  lastHeartbeatAt: iso(NOW - 5 * MIN),
  ...over,
});

describe("the roster adapter", () => {
  test("an enabled, ready, free station: healthy, nothing in hand, capacity 1, last seen when it last took work", () => {
    expect(rosterLoad("agt_a", row())).toEqual({
      agentId: "agt_a",
      inFlight: 0,
      capacity: 1,
      healthy: true,
      lastSeenAt: iso(NOW - 5 * MIN),
      source: "roster",
    });
  });

  test("busy is one card in hand, so not idle; not ready or disabled is unhealthy", () => {
    const busy = rosterLoad("agt_a", row({ busy: true }));
    expect([busy.inFlight, busy.capacity, isIdle(busy)]).toEqual([1, 1, false]);
    expect(rosterLoad("agt_a", row({ ready: false })).healthy).toBe(false);
    expect(rosterLoad("agt_a", row({ enabled: false })).healthy).toBe(false);
    expect(
      rosterLoad("agt_a", row({ lastDispatchedAt: null })).lastSeenAt,
    ).toBeNull();
  });
});

describe("the direct adapter", () => {
  test("a recent heartbeat, nothing in hand: healthy and idle, with SuperPipeline's capacity", () => {
    expect(directLoad(reported({ capacity: 3, inFlight: 2 }), NOW)).toEqual({
      agentId: "agt_d",
      inFlight: 2,
      capacity: 3,
      healthy: true,
      lastSeenAt: iso(NOW - 5 * MIN),
      source: "direct",
    });
    expect(
      isIdle(directLoad(reported({ capacity: 3, inFlight: 2 }), NOW)),
    ).toBe(true);
    expect(
      isIdle(directLoad(reported({ capacity: 3, inFlight: 3 }), NOW)),
    ).toBe(false);
  });

  test("capacity is 1 unless reported as a whole number above 0", () => {
    for (const capacity of [null, 0]) {
      const load = directLoad(reported({ capacity, inFlight: 1 }), NOW);
      expect({ capacity, got: load.capacity, idle: isIdle(load) }).toEqual({
        capacity,
        got: 1,
        idle: false,
      });
    }
  });

  test("an unknown load is no room, not an idle agent", () => {
    expect(isIdle(directLoad(reported({ inFlight: null }), NOW))).toBe(false);
  });

  test("healthy only when heard from within the window: never, too long ago, or from the future is not", () => {
    const healthy = (lastHeartbeatAt: string | null) =>
      directLoad(reported({ lastHeartbeatAt }), NOW).healthy;
    expect(healthy(null)).toBe(false);
    expect(healthy(iso(NOW - DIRECT_SEEN_WITHIN_MS))).toBe(true);
    expect(healthy(iso(NOW - DIRECT_SEEN_WITHIN_MS - 1))).toBe(false);
    expect(healthy(iso(NOW + CLOCK_SKEW_MS))).toBe(true);
    expect(healthy(iso(NOW + CLOCK_SKEW_MS + 1))).toBe(false);
  });
});

describe("SuperPipeline's load read", () => {
  const client = (routes: Parameters<typeof fakeFetch>[0]) => {
    const f = fakeFetch(routes);
    return {
      ...f,
      sp: createSuperpipeline({
        baseUrl: "https://pipeline.example/",
        tokens: { get: async () => "tok", invalidate: () => {} },
        fetch: f.fetch,
      }),
    };
  };

  test("reads every agent, leaving out a row with no id and anything that is not a whole number", async () => {
    const { sp, seen } = client({
      "GET /v1/agents/load": {
        json: {
          agents: [
            {
              agentId: "agt_a",
              principalId: "prn_a",
              inFlight: 2,
              capacity: 3,
              lastHeartbeatAt: "2026-11-13T11:55:00Z",
            },
            {
              agentId: "agt_b",
              principalId: null,
              inFlight: "many",
              capacity: 1.5,
              lastHeartbeatAt: "yesterday",
            },
            { inFlight: 0 },
          ],
        },
      },
    });
    expect(await sp.agentLoad()).toEqual([
      {
        agentId: "agt_a",
        principalId: "prn_a",
        inFlight: 2,
        capacity: 3,
        lastHeartbeatAt: "2026-11-13T11:55:00.000Z",
      },
      {
        agentId: "agt_b",
        principalId: null,
        inFlight: null,
        capacity: null,
        lastHeartbeatAt: null,
      },
    ]);
    expect(seen.map((s) => [s.method, s.authorization])).toEqual([
      ["GET", "Bearer tok"],
    ]);
  });

  test("a SuperPipeline without the read, or a malformed answer, throws", async () => {
    for (const answer of [{ status: 404 }, { json: { agents: "none" } }]) {
      const { sp } = client({ "GET /v1/agents/load": answer });
      let error: unknown = null;
      try {
        await sp.agentLoad();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SourceError);
    }
  });
});
