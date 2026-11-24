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
import { CASES, fakeFetch, treatyCase } from "./helpers.ts";

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

  test("a capacity of 0 takes nothing: never idle, even with nothing in hand", () => {
    const load = directLoad(reported({ capacity: 0, inFlight: 0 }), NOW);
    expect([load.capacity, isIdle(load)]).toEqual([0, false]);
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

/** The `SourceError` a read throws; a test failure when it throws nothing, or something else. */
async function refusal(read: Promise<unknown>): Promise<SourceError> {
  const error = await read.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof SourceError)) throw new Error("no SourceError");
  return error;
}

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

  test("reads every agent as treaty's contract holds it: treaty's own case, row for row", async () => {
    const json = treatyCase(CASES.placement, "readAgentLoad");
    const { sp, seen } = client({ "GET /v1/agents/load": { json } });
    expect(await sp.agentLoad()).toEqual([
      {
        agentId: "agt_3f9a1c0b7e24d5a6",
        principalId: "prn_0123456789abcdef0a01",
        inFlight: 1,
        capacity: 2,
        lastHeartbeatAt: "2026-11-23T10:04:30.000Z",
      },
      {
        agentId: "agt_7b1e2d3c4a5f6e70",
        principalId: null,
        inFlight: 3,
        capacity: 3,
        lastHeartbeatAt: "2026-11-23T10:04:55.000Z",
      },
      {
        agentId: "agt_0c1d2e3f4a5b6c7d",
        principalId: "prn_0123456789abcdef0a02",
        inFlight: 0,
        capacity: 1,
        lastHeartbeatAt: null,
      },
      {
        agentId: "agt_1d2e3f4a5b6c7d8e",
        principalId: "prn_0123456789abcdef0a03",
        inFlight: 0,
        capacity: 0,
        lastHeartbeatAt: null,
      },
    ]);
    expect(seen.map((s) => [s.method, s.authorization])).toEqual([
      ["GET", "Bearer tok"],
    ]);
  });

  test("an answer off the contract is refused whole, never read in part: a null or fractional count, a missing heartbeat", async () => {
    const agent = {
      agentId: "agt_a",
      principalId: null,
      inFlight: 0,
      capacity: 1,
      lastHeartbeatAt: null,
    };
    const { lastHeartbeatAt: _, ...noHeartbeat } = agent;
    for (const [bad, where] of [
      [{ ...agent, inFlight: null }, "#/agents/1/inFlight"],
      [{ ...agent, capacity: null }, "#/agents/1/capacity"],
      [{ ...agent, capacity: 1.5 }, "#/agents/1/capacity"],
      [{ ...agent, inFlight: -1 }, "#/agents/1/inFlight"],
      [noHeartbeat, "#/agents/1"],
      [
        { ...agent, lastHeartbeatAt: "yesterday" },
        "#/agents/1/lastHeartbeatAt",
      ],
    ] as const) {
      const { sp } = client({
        "GET /v1/agents/load": { json: { agents: [agent, bad] } },
      });
      const error = await refusal(sp.agentLoad());
      expect([error.code, error.at]).toEqual(["contract_refused", where]);
    }
  });

  test("a SuperPipeline without the read throws its 404", async () => {
    const { sp } = client({ "GET /v1/agents/load": { status: 404 } });
    expect((await refusal(sp.agentLoad())).status).toBe(404);
  });
});
