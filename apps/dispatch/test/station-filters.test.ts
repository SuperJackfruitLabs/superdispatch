/**
 * The station filters (later slice 5): a stage's `placement` against AgentPod's capability
 * registry (charter 2026-11-13). Off when the stage states nothing; unchecked when the registry
 * cannot be read; every rejection recorded on its candidate with what the station lacks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import { createLoop } from "../src/loop/index.ts";
import {
  decisionProblems,
  place,
  STATION_FILTERS,
  type CandidateFacts,
  type Decision,
} from "../src/placement/index.ts";
import { checkNeeds, proofMeets } from "../src/placement/requirements.ts";
import {
  createAgentpod,
  createSuperpipeline,
  placementOf,
  rosterLoad,
  SourceError,
  stationCapsOf,
  type Agentpod,
  type CardView,
  type ServiceTokens,
  type StageNeeds,
  type StationCaps,
  type Superpipeline,
} from "../src/sources/index.ts";
import { fakeFetch, tempStore } from "./helpers.ts";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const CARD = {
  boardId: "brd_00000000000000b1",
  cardId: "card_1",
  stageKey: "build",
};

const caps = (
  stationId: string,
  over: Partial<StationCaps> = {},
): StationCaps => ({
  stationId,
  isolation: { level: "sandbox", proof: "installed" },
  model: { id: "gpt-5", proof: "probed" },
  tools: [
    { id: "cli:stk", proof: "probed" },
    { id: "mcp:superpipeline", proof: "declared" },
  ],
  credentials: [{ name: "forge:github", proof: "probed" }],
  ...over,
});

const NEEDS: StageNeeds = {
  isolation: "container",
  models: ["gpt-5", "kimi-k2"],
  tools: ["cli:stk"],
  credentials: ["forge:github"],
};

describe("checkNeeds", () => {
  test("a stage that states nothing gives no checks, whatever the station", () => {
    expect(checkNeeds(null, null, "declared")).toEqual([]);
    expect(checkNeeds({}, null, "declared")).toEqual([]);
    expect(
      checkNeeds({ tools: [], models: [] }, caps("s"), "declared"),
    ).toEqual([]);
  });

  test("a station with everything passes each stated check", () => {
    expect(
      checkNeeds(NEEDS, caps("s"), "declared").map((r) => [r.need, r.ok]),
    ).toEqual([
      ["isolation", true],
      ["model", true],
      ["tools", true],
      ["credentials", true],
    ]);
  });

  test("each check names what the station lacks", () => {
    const weak = caps("s", {
      isolation: { level: "host", proof: "declared" },
      model: { id: "llama", proof: "probed" },
      tools: [],
      credentials: [{ name: "forge:forgejo", proof: "probed" }],
    });
    expect(
      checkNeeds({ ...NEEDS, tools: ["cli:stk", "mcp:x"] }, weak, "declared"),
    ).toEqual([
      { need: "isolation", ok: false, missing: ["container"] },
      { need: "model", ok: false, missing: ["gpt-5", "kimi-k2"] },
      { need: "tools", ok: false, missing: ["cli:stk", "mcp:x"] },
      { need: "credentials", ok: false, missing: ["forge:github"] },
    ]);
  });

  test("stronger isolation satisfies weaker; an unknown level satisfies nothing", () => {
    expect(
      checkNeeds({ isolation: "host" }, caps("s"), "declared")[0]?.ok,
    ).toBe(true);
    expect(
      checkNeeds(
        { isolation: "sandbox" },
        caps("s", { isolation: { level: "container", proof: "installed" } }),
        "declared",
      )[0]?.ok,
    ).toBe(false);
    expect(
      checkNeeds(
        { isolation: "host" },
        caps("s", { isolation: { level: "vm", proof: "installed" } }),
        "declared",
      )[0]?.ok,
    ).toBe(false);
  });

  test("a station the registry does not list fails every stated need", () => {
    expect(checkNeeds(NEEDS, null, "declared").every((r) => !r.ok)).toBe(true);
  });

  test("a fact weaker than the minimum proof does not count", () => {
    expect(proofMeets("probed", "installed")).toBe(true);
    expect(proofMeets("declared", "installed")).toBe(false);
    const r = checkNeeds(
      { tools: ["mcp:superpipeline", "cli:stk"] },
      caps("s"),
      "installed",
    );
    expect(r).toEqual([
      { need: "tools", ok: false, missing: ["mcp:superpipeline"] },
    ]);
    expect(
      checkNeeds({ isolation: "container" }, caps("s"), "probed")[0]?.ok,
    ).toBe(false);
  });
});

function agent(
  agentId: string,
  station: StationCaps | null | undefined,
): CandidateFacts {
  return {
    agentId,
    principalId: `prn_${agentId}`,
    pipeline: { eligible: true, reasons: [] },
    roster: { stationId: `stn_${agentId}`, enabled: true },
    load: rosterLoad(agentId, {
      enabled: true,
      ready: true,
      busy: false,
      lastDispatchedAt: new Date(NOW - 3_600_000).toISOString(),
    }),
    history: { settled: 0, claimed: 0, noShowsAtMs: [] },
    holds: 0,
    ...(station !== undefined ? { station } : {}),
  };
}

function decide(
  needs: StageNeeds | null,
  ...candidates: CandidateFacts[]
): Decision {
  const d = place({ card: CARD, nowMs: NOW, candidates, needs });
  expect(decisionProblems(d)).toEqual([]);
  return d;
}

const rejections = (d: Decision, agentId: string) =>
  d.candidates
    .find((r) => r.candidate.agentId === agentId)
    ?.filters.flatMap((f) =>
      f.passed ? [] : [{ reason: f.reason, missing: f.missing }],
    );

describe("place: the station filters", () => {
  test("the station that has what the stage needs is chosen; the other is rejected with what it lacks", () => {
    const d = decide(
      NEEDS,
      agent("agt_a", caps("stn_agt_a", { tools: [], credentials: [] })),
      agent("agt_b", caps("stn_agt_b")),
    );
    expect(d.kind === "placed" && d.chosen).toBe("agt_b");
    expect(rejections(d, "agt_a")).toEqual([
      { reason: "tool-missing", missing: ["cli:stk"] },
      { reason: "credential-missing", missing: ["forge:github"] },
    ]);
  });

  test("every reason code: isolation, model, tool, credential", () => {
    const d = decide(
      NEEDS,
      agent(
        "agt_a",
        caps("stn_agt_a", { isolation: { level: "host", proof: "declared" } }),
      ),
      agent("agt_b", caps("stn_agt_b", { model: null })),
    );
    expect(rejections(d, "agt_a")?.map((r) => r.reason)).toEqual([
      "isolation-too-weak",
    ]);
    expect(rejections(d, "agt_b")?.map((r) => r.reason)).toEqual([
      "model-mismatch",
    ]);
    expect(d.kind === "none" && d.reason).toBe("none-eligible");
  });

  test("off when the stage states nothing: no station filter is recorded", () => {
    const d = decide(null, agent("agt_a", null), agent("agt_b", null));
    expect(d.kind).toBe("placed");
    for (const r of d.candidates)
      expect(r.filters.some((f) => STATION_FILTERS.includes(f.filter))).toBe(
        false,
      );
  });

  test("unchecked when the registry was not read: placed as if nothing were stated", () => {
    const d = decide(
      NEEDS,
      agent("agt_a", undefined),
      agent("agt_b", undefined),
    );
    expect(d.kind).toBe("placed");
    for (const r of d.candidates)
      expect(r.filters.some((f) => STATION_FILTERS.includes(f.filter))).toBe(
        false,
      );
  });

  test("a candidate whose station the registry lacks is rejected for each stated need", () => {
    const d = decide(
      { tools: ["cli:stk"] },
      agent("agt_a", null),
      agent("agt_b", caps("stn_agt_b")),
    );
    expect(rejections(d, "agt_a")).toEqual([
      { reason: "tool-missing", missing: ["cli:stk"] },
    ]);
    expect(d.kind === "placed" && d.chosen).toBe("agt_b");
  });

  test("the minimum proof weighs in placement", () => {
    const d = place({
      card: CARD,
      nowMs: NOW,
      needs: { tools: ["mcp:superpipeline"] },
      minProof: "installed",
      candidates: [
        agent("agt_a", caps("stn_agt_a")),
        agent("agt_b", caps("stn_agt_b")),
      ],
    });
    expect(d.kind === "none" && d.reason).toBe("none-eligible");
  });
});

describe("sources: what each product says", () => {
  test("a stage's placement is read, and one that states nothing is null", () => {
    expect(
      placementOf({
        isolation: "container",
        tools: ["cli:stk"],
        models: [],
        credentials: ["forge:github", 3],
      }),
    ).toEqual({
      isolation: "container",
      tools: ["cli:stk"],
      credentials: ["forge:github"],
    });
    expect(placementOf(undefined)).toBeNull();
    expect(placementOf({})).toBeNull();
    expect(placementOf({ tools: [] })).toBeNull();
    // An isolation level this service does not know is never read as no need.
    expect(placementOf({ isolation: "vm" })).toEqual({ isolation: "sandbox" });
  });

  test("a registry row is read; a malformed fact is left out and an unknown proof is the weakest", () => {
    expect(
      stationCapsOf({
        stationId: "stn_1",
        principalId: "prn_1",
        harness: "salaam",
        isolation: { level: "sandbox", runtime: "runsc", proof: "installed" },
        model: { id: "gpt-5", proof: "probed" },
        tools: [
          { id: "cli:stk", proof: "probed" },
          { id: 7 },
          { id: "mcp:x", proof: "certain" },
        ],
        credentials: [
          {
            name: "forge:github",
            instance: "https://github.com",
            proof: "probed",
          },
        ],
      }),
    ).toEqual({
      stationId: "stn_1",
      principalId: "prn_1",
      harness: "salaam",
      isolation: { level: "sandbox", proof: "installed", runtime: "runsc" },
      model: { id: "gpt-5", proof: "probed" },
      tools: [
        { id: "cli:stk", proof: "probed" },
        { id: "mcp:x", proof: "declared" },
      ],
      credentials: [{ name: "forge:github", proof: "probed" }],
    });
    expect(stationCapsOf({ isolation: null })).toBeNull();
    expect(
      stationCapsOf({ stationId: "s", isolation: null, model: null }),
    ).toEqual({
      stationId: "s",
      principalId: null,
      harness: null,
      isolation: null,
      model: null,
      tools: [],
      credentials: [],
    });
  });

  const tokens: ServiceTokens = {
    get: async () => "tok",
    invalidate: () => {},
  };

  test("SuperPipeline's board read carries each stage's placement", async () => {
    const f = fakeFetch({
      [`GET /v1/boards/${CARD.boardId}`]: {
        json: {
          stages: [
            {
              key: "build",
              ownerKind: "capability",
              owner: "code",
              placement: { tools: ["cli:stk"] },
            },
            { key: "ship", ownerKind: "capability", owner: "code" },
          ],
          cards: [],
        },
      },
    });
    const board = await createSuperpipeline({
      baseUrl: "http://sp",
      tokens,
      fetch: f.fetch,
    }).board(CARD.boardId);
    expect(board.stages.map((st) => st.placement)).toEqual([
      { tools: ["cli:stk"] },
      null,
    ]);
  });

  test("AgentPod's registry read: by station; null from a hub without it; a refusal throws", async () => {
    const ok = fakeFetch({
      "GET /api/catalog/stations": {
        json: { stations: [{ stationId: "stn_1" }, { nope: 1 }] },
      },
    });
    const read = await createAgentpod({
      baseUrl: "http://hub",
      tokens,
      fetch: ok.fetch,
    }).stationCapabilities();
    expect([...(read?.keys() ?? [])]).toEqual(["stn_1"]);
    expect(ok.seen[0]?.authorization).toBe("Bearer tok");

    const old = fakeFetch({
      "GET /api/catalog/stations": {
        status: 404,
        json: { error: "Not Found" },
      },
    });
    expect(
      await createAgentpod({
        baseUrl: "http://hub",
        tokens,
        fetch: old.fetch,
      }).stationCapabilities(),
    ).toBeNull();

    const refused = fakeFetch({
      "GET /api/catalog/stations": {
        status: 403,
        json: { error: "forbidden" },
      },
    });
    expect(
      createAgentpod({
        baseUrl: "http://hub",
        tokens,
        fetch: refused.fetch,
      }).stationCapabilities(),
    ).rejects.toBeInstanceOf(SourceError);
  });
});

describe("config", () => {
  const FULL = {
    SUPERPIPELINE_URL: "https://pipeline.example",
    ORG_PLANE_URL: "https://accounts.example",
    ORG_PLANE_SERVICE_CREDENTIAL: "svc_0123456789abcdef0123:credential-secret",
    AGENTPOD_URL: "https://hub.example",
    TREATY_RELAY_DELIVERY_SECRET: "relay-secret",
    SUPERDISPATCH_OPERATOR_TOKEN_SHA256: "a".repeat(64),
  };
  test("station filters on and every proof by default; both settable; a bad value is named", () => {
    expect(loadConfig(FULL)).toMatchObject({
      stationFilters: "on",
      minProof: "declared",
    });
    expect(
      loadConfig({
        ...FULL,
        SUPERDISPATCH_STATION_FILTERS: "off",
        SUPERDISPATCH_MIN_PROOF: "probed",
      }),
    ).toMatchObject({
      stationFilters: "off",
      minProof: "probed",
    });
    let problems: string[] = [];
    try {
      loadConfig({
        ...FULL,
        SUPERDISPATCH_STATION_FILTERS: "maybe",
        SUPERDISPATCH_MIN_PROOF: "sure",
      });
    } catch (error) {
      if (error instanceof ConfigError) problems = error.problems;
    }
    expect(problems).toContain(
      "SUPERDISPATCH_STATION_FILTERS is not one of on, off",
    );
    expect(problems).toContain(
      "SUPERDISPATCH_MIN_PROOF is not one of probed, installed, declared",
    );
  });
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** One board with one ready card at `build`, two rostered agents, and a registry. */
function world(opts: {
  placement: StageNeeds | null;
  registry: Map<string, StationCaps> | null | "throw";
  filters?: "on" | "off";
}) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const calls: string[] = [];
  const card: CardView = {
    id: CARD.cardId,
    stageKey: "build",
    state: "submitted",
    currentRunId: null,
    lastAgentId: null,
    attemptCount: 0,
    priority: 0,
    createdAt: new Date(NOW - 60_000).toISOString(),
    archived: false,
    reservation: null,
  };
  const ids = ["agt_a", "agt_b"];
  const superpipeline: Superpipeline = {
    async board(boardId) {
      return {
        boardId,
        stages: [
          {
            key: "build",
            ownerKind: "capability",
            hasRequires: false,
            requires: { all: ["code"], any: [] },
            placement: opts.placement,
          },
        ],
        cards: [card],
      };
    },
    async eligibility() {
      return {
        stageKey: "build",
        reasons: [],
        agents: ids.map((agentId) => ({
          agentId,
          principalId: `prn_${agentId}`,
          eligible: true,
          reasons: [],
        })),
      };
    },
    async reserve(_b, _c, hold) {
      calls.push(`reserve ${hold.agentId}`);
      return { ok: true, reservedUntil: new Date(NOW + 60_000).toISOString() };
    },
    async clearReservation() {},
    async agentLoad() {
      return [];
    },
  };
  const agentpod: Agentpod = {
    async roster() {
      return ids.map((agentId) => ({
        key: agentId,
        stationId: `stn_${agentId}`,
        principalId: `prn_${agentId}`,
        enabled: true,
        ready: true,
        busy: false,
        lastDispatchedAt: new Date(
          NOW - (agentId === "agt_a" ? 7_200_000 : 3_600_000),
        ).toISOString(),
      }));
    },
    async stationCapabilities() {
      calls.push("registry");
      if (opts.registry === "throw")
        throw new SourceError("agentpod", 403, "forbidden");
      return opts.registry;
    },
  };
  const log: string[] = [];
  let n = 0;
  const loop = createLoop({
    store: t.store,
    superpipeline,
    agentpod,
    ...(opts.filters ? { stationFilters: opts.filters } : {}),
    now: () => NOW,
    newId: () => `pld_${String(++n).padStart(24, "0")}`,
    log: (line) => log.push(line),
  });
  return { loop, calls, log, store: t.store };
}

describe("loop: the registry is read when a stage needs it", () => {
  // agt_a is least recently used, so it wins when nothing filters it out.
  const registry = new Map([
    ["stn_agt_a", caps("stn_agt_a", { tools: [] })],
    ["stn_agt_b", caps("stn_agt_b")],
  ]);

  test("a stage that states a placement reads the registry once and places on it", async () => {
    const w = world({ placement: { tools: ["cli:stk"] }, registry });
    await w.loop.passBoard(CARD.boardId);
    expect(w.calls).toEqual(["registry", "reserve agt_b"]);
    const recorded = w.store.latestDecision(CARD.boardId, CARD.cardId);
    expect(JSON.stringify(recorded)).toContain("tool-missing");
  });

  test("a stage that states nothing never reads the registry", async () => {
    const w = world({ placement: null, registry });
    await w.loop.passBoard(CARD.boardId);
    expect(w.calls).toEqual(["reserve agt_a"]);
  });

  test("with the filters off the registry is not read and placement is unchanged", async () => {
    const w = world({
      placement: { tools: ["cli:stk"] },
      registry,
      filters: "off",
    });
    await w.loop.passBoard(CARD.boardId);
    expect(w.calls).toEqual(["reserve agt_a"]);
  });

  test("an unread registry, or a hub without one, leaves the needs unchecked and says so", async () => {
    for (const read of ["throw", null] as const) {
      const w = world({ placement: { tools: ["cli:stk"] }, registry: read });
      await w.loop.passBoard(CARD.boardId);
      expect(w.calls).toEqual(["registry", "reserve agt_a"]);
      expect(w.log.some((l) => l.includes("stage placements unchecked"))).toBe(
        true,
      );
    }
  });
});
