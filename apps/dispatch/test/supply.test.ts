import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SUPPLY_MIN_EVIDENCE,
  FILTERS,
  HOW_TO_APPLY,
  SUPPLY_KINDS,
  passed,
  proposeSupply,
  rejected,
  type CandidateRecord,
  type FilterName,
  type FilterResult,
  type LaneDecision,
  type SupplyProposal,
} from "../src/placement/index.ts";
import { refreshSuggestions } from "../src/loop/index.ts";
import { createHandler } from "../src/routes/index.ts";
import type { StationCaps } from "../src/sources/index.ts";
import { OPERATOR_TOKEN, OPERATOR_TOKEN_SHA256, tempStore } from "./helpers.ts";

const ALL: FilterName[] = Object.keys(FILTERS).filter(
  (k): k is FilterName => k in FILTERS,
);
const MIN = 60_000;
const T0 = Date.parse("2026-11-13T12:00:00.000Z");
const SETTINGS = { minEvidence: 2, minProof: "declared" } as const;

/** A rostered agent on `station` that passes every filter but those in `fail` (with `missing`). */
function onRoster(
  agentId: string,
  stationId: string | null,
  fail: Partial<Record<FilterName, readonly string[]>> = {},
): CandidateRecord {
  return {
    candidate: { agentId, principalId: `prn_${agentId}`, stationId },
    filters: ALL.map((f): FilterResult => {
      const missing = fail[f];
      if (missing === undefined) return passed(f);
      if (missing.length === 0) return rejected(f);
      return { filter: f, passed: false, reason: FILTERS[f], missing };
    }),
    score: null,
  };
}

const offRoster = (agentId: string, capable: boolean): CandidateRecord => ({
  candidate: { agentId, principalId: `prn_${agentId}`, stationId: null },
  filters: [rejected("roster")],
  score: null,
  capable,
});

let n = 0;
function d(
  candidates: CandidateRecord[],
  over: Partial<LaneDecision> = {},
): LaneDecision {
  n++;
  return {
    id: `pld_${String(n).padStart(24, "0")}`,
    boardId: "brd_a",
    cardId: `card_${n}`,
    stageKey: "build",
    attemptsBefore: 0,
    requires: { all: ["code"], any: [] },
    noDecisionReason: "none-eligible",
    candidates,
    createdAtMs: T0 + n * MIN,
    ...over,
  };
}

function station(
  stationId: string,
  over: Partial<StationCaps> = {},
): StationCaps {
  return {
    stationId,
    principalId: null,
    harness: "salaam",
    isolation: { level: "host", proof: "installed", runtime: null },
    model: { id: "gpt-5", proof: "installed" },
    tools: [],
    credentials: [],
    ...over,
  };
}

const stationsOf = (...rows: StationCaps[]) =>
  new Map(rows.map((r) => [r.stationId, r]));

const kinds = (out: readonly SupplyProposal[]) => out.map((p) => p.kind);

describe("supply proposals, one table per kind", () => {
  test("change-model: an agent on the roster turned away only for its model", () => {
    const rec = onRoster("agt_a", "stn_a", { model: ["claude-opus", "gpt-5"] });
    const ds = [d([rec]), d([rec])];
    const [p, ...rest] = proposeSupply({
      decisions: ds,
      stations: stationsOf(station("stn_a")),
      settings: SETTINGS,
    });
    expect(rest).toEqual([]);
    expect(p).toEqual({
      kind: "change-model",
      boardId: "brd_a",
      stageKey: "build",
      rationale:
        "Agt_a on the board's roster was turned away only for the model it runs; the stage asks for claude-opus or gpt-5.",
      target: {
        agent: "agt_a",
        station: "stn_a",
        model: "claude-opus",
        models: ["claude-opus", "gpt-5"],
      },
      estimatedEffect: {
        cards: 2,
        agents: 1,
        summary:
          "2 cards waited for want of it; it would give the lane 1 more eligible agent.",
      },
      howToApply: HOW_TO_APPLY["change-model"],
      registry: "read",
      evidence: ds.map((x) => x.id),
      evidenceCount: 2,
    });
  });

  test("move-to-host: a station elsewhere has every need the lane's stations lack", () => {
    const rec = onRoster("agt_a", "stn_a", {
      isolation: ["sandbox"],
      tools: ["cli:stk"],
    });
    const stations = stationsOf(
      station("stn_a"),
      // Has the tool but too weak.
      station("stn_weak", { tools: [{ id: "cli:stk", proof: "installed" }] }),
      // Occupied, and fits.
      station("stn_busy", {
        principalId: "prn_z",
        isolation: { level: "sandbox", proof: "installed", runtime: "runsc" },
        tools: [{ id: "cli:stk", proof: "installed" }],
      }),
      // Empty, and fits: preferred.
      station("stn_free", {
        isolation: { level: "sandbox", proof: "installed", runtime: "runsc" },
        tools: [{ id: "cli:stk", proof: "probed" }],
      }),
    );
    const out = proposeSupply({
      decisions: [d([rec]), d([rec])],
      stations,
      settings: SETTINGS,
    });
    expect(kinds(out)).toEqual(["move-to-host"]);
    expect(out[0]?.target).toEqual({
      station: "stn_free",
      stationAgent: null,
      runtime: "runsc",
      harness: "salaam",
      isolation: "sandbox",
      model: "gpt-5",
      tools: ["cli:stk"],
    });
    expect(out[0]?.rationale).toContain("station stn_free has all of it");
  });

  test("nothing for a station shortfall the registry says the lane's own station has by now", () => {
    const lacking = onRoster("agt_a", "stn_a", { tools: ["cli:stk"] });
    const stations = stationsOf(
      station("stn_a", { tools: [{ id: "cli:stk", proof: "installed" }] }),
      station("stn_b", { tools: [{ id: "cli:stk", proof: "installed" }] }),
    );
    expect(
      proposeSupply({
        decisions: [d([lacking]), d([lacking])],
        stations,
        settings: SETTINGS,
      }),
    ).toEqual([]);
  });

  test("a declared fact does not count when the minimum proof is installed", () => {
    const lacking = onRoster("agt_a", "stn_a", { tools: ["cli:stk"] });
    const stations = stationsOf(
      station("stn_a"),
      station("stn_b", { tools: [{ id: "cli:stk", proof: "declared" }] }),
    );
    const decisions = [d([lacking]), d([lacking])];
    expect(
      kinds(proposeSupply({ decisions, stations, settings: SETTINGS })),
    ).toEqual(["move-to-host"]);
    expect(
      kinds(
        proposeSupply({
          decisions,
          stations,
          settings: { ...SETTINGS, minProof: "installed" },
        }),
      ),
    ).toEqual(["add-station"]);
  });

  test("add-station: the same shortfall with no station that has it, or no registry read", () => {
    const rec = onRoster("agt_a", "stn_a", { tools: ["mcp:x"] });
    for (const stations of [stationsOf(station("stn_a")), null]) {
      const out = proposeSupply({
        decisions: [d([rec]), d([rec])],
        stations,
        settings: SETTINGS,
      });
      expect(kinds(out)).toEqual(["add-station"]);
      expect(out[0]?.target).toEqual(
        stations === null
          ? { tools: ["mcp:x"] }
          : { tools: ["mcp:x"], harness: "salaam" },
      );
      expect(out[0]?.registry).toBe(stations === null ? "unread" : "read");
    }
  });

  test("add-station: nobody in the workspace has the capability", () => {
    const rec = [
      onRoster("agt_a", "stn_a", { capability: [] }),
      offRoster("agt_x", false),
    ];
    const out = proposeSupply({
      decisions: [d(rec), d(rec, { requires: { all: ["sql"], any: [] } })],
      stations: null,
      settings: SETTINGS,
    });
    expect(kinds(out)).toEqual(["add-station"]);
    expect(out[0]?.target).toEqual({
      capability: { all: ["sql"], any: [] },
    });
    // An agent off the roster that has it is a roster suggestion's, not a new station.
    expect(
      proposeSupply({
        decisions: [
          d([
            onRoster("agt_a", "stn_a", { capability: [] }),
            offRoster("agt_x", true),
          ]),
          d([
            onRoster("agt_a", "stn_a", { capability: [] }),
            offRoster("agt_x", true),
          ]),
        ],
        stations: null,
        settings: SETTINGS,
      }),
    ).toEqual([]);
  });

  test("raise-capacity: every capable agent on the roster at its board's concurrency", () => {
    const busy = [
      onRoster("agt_a", "stn_a", { capacity: [], idle: [] }),
      onRoster("agt_b", "stn_b", { capacity: [] }),
      // Without the capability: not counted either way.
      onRoster("agt_c", "stn_c", { capability: [] }),
    ];
    const out = proposeSupply({
      decisions: [
        d(busy, { noDecisionReason: "one-candidate" }),
        d(busy, { noDecisionReason: "any-match" }),
      ],
      stations: null,
      settings: SETTINGS,
    });
    expect(kinds(out)).toEqual(["raise-capacity"]);
    expect(out[0]?.target).toEqual({});
    expect(out[0]?.estimatedEffect.agents).toBe(2);
    // One agent busy for a reason that is not its board's limit: not a capacity problem.
    const mixed = [
      onRoster("agt_a", "stn_a", { capacity: [] }),
      onRoster("agt_b", "stn_b", { idle: [] }),
    ];
    expect(
      proposeSupply({
        decisions: [d(mixed), d(mixed)],
        stations: null,
        settings: SETTINGS,
      }),
    ).toEqual([]);
  });
});

describe("supply proposals: when there is none", () => {
  test("fewer decisions than the minimum, by default two", () => {
    expect(DEFAULT_SUPPLY_MIN_EVIDENCE).toBe(2);
    expect(
      proposeSupply({
        decisions: [d([onRoster("agt_a", "stn_a", { model: ["m"] })])],
        stations: null,
        settings: SETTINGS,
      }),
    ).toEqual([]);
  });

  test("a lane with one agent on the roster counts too, but not while that agent is eligible", () => {
    const one = (fail = {}) =>
      d([onRoster("agt_a", "stn_a", fail)], {
        noDecisionReason: "one-candidate",
      });
    expect(
      kinds(
        proposeSupply({
          decisions: [one({ model: ["m"] }), one({ model: ["m"] })],
          stations: null,
          settings: SETTINGS,
        }),
      ),
    ).toEqual(["change-model"]);
    expect(
      proposeSupply({
        decisions: [one(), one()],
        stations: null,
        settings: SETTINGS,
      }),
    ).toEqual([]);
    // Waiting on holds or load is never recorded; any-match is pull's, not a shortfall.
    expect(
      proposeSupply({
        decisions: [
          d([onRoster("agt_a", "stn_a", { model: ["m"] })], {
            noDecisionReason: "any-match",
          }),
          d([onRoster("agt_a", "stn_a", { model: ["m"] })], {
            noDecisionReason: "any-match",
          }),
        ],
        stations: null,
        settings: SETTINGS,
      }),
    ).toEqual([]);
  });

  test("a lane whose latest decision placed a card", () => {
    const rec = onRoster("agt_a", "stn_a", { model: ["m"] });
    expect(
      proposeSupply({
        decisions: [
          d([rec]),
          d([rec]),
          d([onRoster("agt_a", "stn_a")], { noDecisionReason: null }),
        ],
        stations: null,
        settings: SETTINGS,
      }),
    ).toEqual([]);
  });

  test("a shortfall a station change would not cure: also unhealthy, or denied by policy", () => {
    for (const fail of [
      { model: ["m"], health: [] },
      { tools: ["t"], policy: [] },
    ]) {
      const rec = onRoster("agt_a", "stn_a", fail);
      expect(
        proposeSupply({
          decisions: [d([rec]), d([rec])],
          stations: null,
          settings: SETTINGS,
        }),
      ).toEqual([]);
    }
  });

  test("every kind is listed, and every proposal is advice: no field names a request to make", () => {
    expect([...SUPPLY_KINDS]).toEqual([
      "add-station",
      "change-model",
      "move-to-host",
      "raise-capacity",
    ]);
    const all = proposeSupply({
      decisions: [
        d([onRoster("agt_a", "stn_a", { model: ["m"] })]),
        d([onRoster("agt_a", "stn_a", { model: ["m"] })]),
      ],
      stations: null,
      settings: SETTINGS,
    });
    for (const p of all)
      expect(Object.keys(p).toSorted()).toEqual([
        "boardId",
        "estimatedEffect",
        "evidence",
        "evidenceCount",
        "howToApply",
        "kind",
        "rationale",
        "registry",
        "stageKey",
        "target",
      ]);
  });
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const BOARD = "brd_00000000000000b1";

/** A store with a board on, and decisions that bear out a roster suggestion and a supply proposal. */
function seeded() {
  const t = tempStore();
  cleanups.push(t.cleanup);
  t.store.enableBoard(BOARD, new Date(T0).toISOString());
  for (let i = 1; i <= 3; i++)
    t.store.recordDecision({
      id: `pld_${String(i).padStart(24, "0")}`,
      boardId: BOARD,
      cardId: `card_${i}`,
      stageKey: "build",
      policy: "p",
      chosenAgent: null,
      noDecisionReason: "one-candidate",
      // One agent on the roster (a roster suggestion: one-candidate) turned away for its model.
      candidates: [onRoster("agt_a", "stn_a", { model: ["claude-opus"] })],
      attemptsBefore: 0,
      tier: "winner",
      tierStep: 1,
      requires: { all: ["code"], any: [] },
      createdAt: new Date(T0 + i * MIN).toISOString(),
    });
  let ids = 0;
  const refresh = () =>
    refreshSuggestions({
      store: t.store,
      nowMs: T0 + 10 * MIN,
      newId: () => `sug_${String(++ids).padStart(24, "0")}`,
    });
  return { ...t, refresh };
}

describe("supply proposals in the store and on the API", () => {
  test("one sync holds roster suggestions and supply proposals; neither resolves the other", () => {
    const { store, refresh } = seeded();
    expect(refresh()).toEqual({ opened: 2, updated: 0, resolved: 0 });
    expect(refresh()).toEqual({ opened: 0, updated: 2, resolved: 0 });
    const open = store.listSuggestions({});
    expect(open.map((s) => s.kind).toSorted()).toEqual([
      "change-model",
      "lane-single-point",
    ]);
    const [supply] = store.listSuggestions({ kind: "change-model" });
    expect(supply?.body).toMatchObject({
      target: { agent: "agt_a", station: "stn_a", model: "claude-opus" },
      howToApply: HOW_TO_APPLY["change-model"],
    });
    expect(supply?.evidenceCount).toBe(3);
  });

  test("the operator API lists by kind and refuses a kind it does not know", async () => {
    const { store, refresh } = seeded();
    refresh();
    const handle = createHandler({
      config: {
        relayDeliverySecret: "relay-secret-for-tests",
        operatorTokenSha256: OPERATOR_TOKEN_SHA256,
      },
      store,
      onBoard: () => {},
      now: () => T0,
      nowMs: () => T0,
      log: () => {},
    });
    const get = (path: string) =>
      handle(
        new Request(`http://dispatch${path}`, {
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
        }),
      );
    const supply = await (
      await get("/v1/suggestions?kind=change-model")
    ).json();
    expect(supply.suggestions.map((s: { kind: string }) => s.kind)).toEqual([
      "change-model",
    ]);
    const roster = await (
      await get("/v1/suggestions?kind=lane-single-point")
    ).json();
    expect(roster.suggestions).toHaveLength(1);
    expect((await get("/v1/suggestions?kind=build-it")).status).toBe(400);
    // A proposal can be dismissed; it cannot be applied.
    const id = String(supply.suggestions[0].id);
    const apply = await handle(
      new Request(`http://dispatch/v1/suggestions/${id}/apply`, {
        method: "POST",
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      }),
    );
    expect(apply.status).toBe(404);
  });
});

const src = (...p: string[]) =>
  readFileSync(join(import.meta.dir, "..", "src", ...p), "utf8");

describe("supply proposals cannot reach another product", () => {
  test("the supply analysis imports no client, only shapes", () => {
    const source = src("placement", "supply.ts");
    for (const line of source.split("\n").filter((l) => l.includes(" from ")))
      if (line.includes("sources")) expect(line).not.toMatch(/create[A-Z]/);
    expect(source).not.toMatch(
      /\bfetch\b|create(Agentpod|Superpipeline|Accounts)/,
    );
  });

  test("the suggestions refresh is handed the registry as a copy, never a client", () => {
    const source = src("loop", "suggestions.ts");
    expect(source).not.toMatch(
      /\bfetch\b|Agentpod|Superpipeline|Accounts|stationCapabilities\(/,
    );
    // Its only value imports from sources are none: types alone.
    expect(source).toMatch(
      /import type \{ StationCaps \} from "\.\.\/sources\/index\.ts";/,
    );
  });
});
