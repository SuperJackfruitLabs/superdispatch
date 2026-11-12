import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATABASE_FILE,
  type FoundSuggestion,
  type NewDecision,
  MIGRATIONS,
  StoreError,
  migrate,
  openStore,
} from "../src/store/index.ts";
import { tempStore } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});
function fresh() {
  const t = tempStore();
  cleanups.push(t.cleanup);
  return t;
}

function version(db: Database): number | undefined {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()
    ?.user_version;
}

describe("the store", () => {
  test("opens in WAL mode at the latest schema version", () => {
    const { dir, store } = fresh();
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    const db = new Database(join(dir, DATABASE_FILE), { readonly: true });
    const mode = db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get();
    db.close();
    expect(mode?.journal_mode).toBe("wal");
  });

  test("migrations 1 to 4 make the decisions table", () => {
    const { dir } = fresh();
    const db = new Database(join(dir, DATABASE_FILE), { readonly: true });
    const columns = db
      .query<
        { name: string; notnull: number },
        []
      >("PRAGMA table_info(decisions)")
      .all();
    db.close();
    expect(columns.map((c) => [c.name, c.notnull === 1])).toEqual([
      ["id", false],
      ["board_id", true],
      ["card_id", true],
      ["stage_key", true],
      ["chosen_agent", false],
      ["candidates", true],
      ["reserved_until", false],
      ["outcome", false],
      ["created_at", true],
      ["policy", false],
      ["no_decision_reason", false],
      ["attempts_before", false],
      ["reservation_refused", false],
      ["outcome_by", false],
      ["outcome_at", false],
      ["tier", false],
      ["tier_step", false],
      ["requires", false],
    ]);
  });

  test("reopening applies nothing twice and keeps the rows", () => {
    const { dir, store } = fresh();
    store.close();
    const db = new Database(join(dir, DATABASE_FILE));
    db.run(
      "INSERT INTO decisions (id, board_id, card_id, stage_key, candidates, created_at) VALUES ('d1', 'brd_a', 'crd_a', 'build', '[]', '2026-11-12T10:00:00.000Z')",
    );
    db.close();
    const again = openStore(dir);
    cleanups.push(() => again.close());
    expect(again.schemaVersion()).toBe(MIGRATIONS.length);
    const check = new Database(join(dir, DATABASE_FILE), { readonly: true });
    expect(
      check
        .query<{ n: number }, []>("SELECT count(*) AS n FROM decisions")
        .get()?.n,
    ).toBe(1);
    check.close();
  });

  test("migrations run in order and record their version", () => {
    const db = new Database(":memory:");
    migrate(db, ["CREATE TABLE a (x)", "CREATE TABLE b (y)"]);
    expect(version(db)).toBe(2);
    // A third migration added later is applied on its own.
    migrate(db, [
      "CREATE TABLE a (x)",
      "CREATE TABLE b (y)",
      "CREATE TABLE c (z)",
    ]);
    expect(version(db)).toBe(3);
    expect(
      db
        .query<
          { n: number },
          []
        >("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
        .get()?.n,
    ).toBe(3);
    db.close();
  });

  test("a failed migration leaves the version where it was", () => {
    const db = new Database(":memory:");
    expect(() => migrate(db, ["CREATE TABLE a (x)", "NOT SQL"])).toThrow();
    expect(version(db)).toBe(1);
    db.close();
  });

  test("refuses a database written by a newer build", () => {
    const db = new Database(":memory:");
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(StoreError);
    db.close();
  });

  test("an error opening it names the setting, never the path", () => {
    // A directory under a plain file cannot be made, even by root.
    const parent = mkdtempSync(join(tmpdir(), "superdispatch-test-"));
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    const file = join(parent, "a-file");
    writeFileSync(file, "");
    const dir = join(file, "data");
    let message = "";
    try {
      openStore(dir);
    } catch (error) {
      expect(error).toBeInstanceOf(StoreError);
      message = (error as Error).message;
    }
    expect(message).toContain("SUPERDISPATCH_DATA_DIR");
    expect(message).not.toContain(parent);
  });
});

const T = (minute: number) =>
  new Date(Date.UTC(2026, 10, 12, 12, minute)).toISOString();

function decision(over: Partial<NewDecision> & { id: string }): NewDecision {
  return {
    boardId: "brd_a",
    cardId: "card_a",
    stageKey: "build",
    policy: "p@1",
    chosenAgent: "agt_a",
    noDecisionReason: null,
    candidates: [{ candidate: { agentId: "agt_a" } }],
    attemptsBefore: 0,
    tier: "winner",
    tierStep: 1,
    requires: { all: ["code"], any: [] },
    createdAt: T(0),
    ...over,
  };
}

describe("boards", () => {
  test("opting in, out and in again keeps one row and its first time", () => {
    const { store } = fresh();
    expect(store.getBoard("brd_a")).toBeNull();
    expect(store.disableBoard("brd_a", T(0))).toBeNull();
    expect(store.enableBoard("brd_a", T(1))).toEqual({
      boardId: "brd_a",
      enabled: true,
      createdAt: T(1),
      updatedAt: T(1),
    });
    expect(store.disableBoard("brd_a", T(2))?.enabled).toBe(false);
    expect(store.enableBoard("brd_a", T(3))).toEqual({
      boardId: "brd_a",
      enabled: true,
      createdAt: T(1),
      updatedAt: T(3),
    });
    store.enableBoard("brd_0", T(4));
    expect(store.listBoards().map((b) => b.boardId)).toEqual([
      "brd_0",
      "brd_a",
    ]);
  });
});

describe("decisions", () => {
  test("a decision reads back as written, with its candidates", () => {
    const { store } = fresh();
    store.recordDecision(decision({ id: "pld_1", attemptsBefore: 2 }));
    expect(store.getDecision("pld_1")).toEqual({
      ...decision({ id: "pld_1", attemptsBefore: 2 }),
      reservedUntil: null,
      reservationRefused: null,
      outcome: null,
      outcomeBy: null,
      outcomeAt: null,
    });
  });

  test("only a granted, unsettled hold is open; a refused one is settled as not-reserved", () => {
    const { store } = fresh();
    store.recordDecision(decision({ id: "pld_1" }));
    store.recordDecision(decision({ id: "pld_2" }));
    store.recordDecision(
      decision({
        id: "pld_3",
        chosenAgent: null,
        noDecisionReason: "none-eligible",
      }),
    );
    expect(store.openDecisions("brd_a")).toEqual([]);
    store.setReservation("pld_1", { reservedUntil: T(1) }, T(0));
    store.setReservation("pld_2", { refused: "AGENT_NOT_ELIGIBLE" }, T(0));
    expect(store.openDecisions("brd_a").map((d) => d.id)).toEqual(["pld_1"]);
    expect(store.getDecision("pld_2")).toMatchObject({
      outcome: "not-reserved",
      reservationRefused: "AGENT_NOT_ELIGIBLE",
      outcomeAt: T(0),
    });
    expect(store.openDecisions("brd_b")).toEqual([]);
  });

  test("a card opened to any match is open until settled, though it holds nothing", () => {
    const { store } = fresh();
    store.recordDecision(
      decision({
        id: "pld_1",
        chosenAgent: null,
        noDecisionReason: "any-match",
        tier: "any-match",
        tierStep: 4,
      }),
    );
    expect(store.openDecisions("brd_a").map((d) => d.id)).toEqual(["pld_1"]);
    expect(store.getDecision("pld_1")).toMatchObject({
      tier: "any-match",
      tierStep: 4,
      reservedUntil: null,
    });
    // It holds nothing, so it is no agent's live hold.
    expect(store.liveHolds(T(0))).toEqual(new Map());
    store.settle("pld_1", "claimed-by-other", "agt_z", T(1));
    expect(store.openDecisions("brd_a")).toEqual([]);
  });

  test("a card's ladder: its lapsed, superseded and any-match decisions at that stage and attempt count, newest first", () => {
    const { store } = fresh();
    const held = (id: string, at: number, over: Partial<NewDecision> = {}) => {
      store.recordDecision(decision({ id, createdAt: T(at), ...over }));
      store.setReservation(id, { reservedUntil: T(at + 1) }, T(at));
    };
    held("pld_1", 0);
    store.settle("pld_1", "expired", null, T(1));
    held("pld_2", 1, { chosenAgent: "agt_b", tier: "runner-up", tierStep: 2 });
    store.settle("pld_2", "superseded", null, T(2));
    // A refused hold, a no-choice and a claim are not steps of the ladder.
    store.recordDecision(decision({ id: "pld_3", createdAt: T(3) }));
    store.setReservation("pld_3", { refused: "HTTP_404" }, T(3));
    store.recordDecision(
      decision({
        id: "pld_4",
        createdAt: T(4),
        chosenAgent: null,
        noDecisionReason: "none-eligible",
      }),
    );
    held("pld_5", 5, { chosenAgent: "agt_c" });
    store.settle("pld_5", "claimed", "agt_c", T(5));
    store.recordDecision(
      decision({
        id: "pld_6",
        createdAt: T(6),
        chosenAgent: null,
        tier: "any-match",
        tierStep: 3,
      }),
    );
    // Another stage, another attempt count, another card: other ladders.
    held("pld_7", 7, { stageKey: "review" });
    store.settle("pld_7", "expired", null, T(8));
    held("pld_8", 7, { attemptsBefore: 1 });
    store.settle("pld_8", "expired", null, T(8));
    held("pld_9", 7, { cardId: "card_b" });
    store.settle("pld_9", "expired", null, T(8));
    expect(
      store.ladderDecisions("brd_a", "card_a", "build", 0).map((d) => d.id),
    ).toEqual(["pld_6", "pld_2", "pld_1"]);
  });

  test("an outcome is settled once", () => {
    const { store } = fresh();
    store.recordDecision(decision({ id: "pld_1" }));
    store.setReservation("pld_1", { reservedUntil: T(1) }, T(0));
    expect(store.settle("pld_1", "claimed", "agt_a", T(1))).toBe(true);
    expect(store.settle("pld_1", "expired", null, T(2))).toBe(false);
    expect(store.getDecision("pld_1")).toMatchObject({
      outcome: "claimed",
      outcomeBy: "agt_a",
      outcomeAt: T(1),
    });
    expect(store.openDecisions("brd_a")).toEqual([]);
  });

  test("decisions list newest first, by board and card, before a time, up to a limit", () => {
    const { store } = fresh();
    store.recordDecision(decision({ id: "pld_1", createdAt: T(1) }));
    store.recordDecision(
      decision({ id: "pld_2", createdAt: T(2), cardId: "card_b" }),
    );
    store.recordDecision(
      decision({ id: "pld_3", createdAt: T(3), boardId: "brd_b" }),
    );
    const ids = (q: Parameters<typeof store.listDecisions>[0]) =>
      store.listDecisions(q).map((d) => d.id);
    expect(ids({ limit: 10 })).toEqual(["pld_3", "pld_2", "pld_1"]);
    expect(ids({ boardId: "brd_a", limit: 10 })).toEqual(["pld_2", "pld_1"]);
    expect(ids({ boardId: "brd_a", cardId: "card_a", limit: 10 })).toEqual([
      "pld_1",
    ]);
    expect(ids({ before: T(3), limit: 1 })).toEqual(["pld_2"]);
    expect(store.latestDecision("brd_a", "card_a")?.id).toBe("pld_1");
    expect(store.latestDecision("brd_a", "card_z")).toBeNull();
  });

  test("history: claimed and lapsed holds per agent on a board; lapses on any board; live holds", () => {
    const { store } = fresh();
    const held = (
      id: string,
      agent: string,
      until: number,
      over: Partial<NewDecision> = {},
    ) => {
      store.recordDecision(decision({ id, chosenAgent: agent, ...over }));
      store.setReservation(id, { reservedUntil: T(until) }, T(0));
    };
    held("pld_1", "agt_a", 1);
    held("pld_2", "agt_a", 1);
    held("pld_3", "agt_a", 1, { boardId: "brd_b" });
    held("pld_4", "agt_b", 1);
    held("pld_5", "agt_b", 9);
    held("pld_6", "agt_c", 9);
    store.settle("pld_1", "claimed", "agt_a", T(2));
    store.settle("pld_2", "expired", null, T(3));
    store.settle("pld_3", "expired", null, T(4));
    // Neither another agent's claim nor a person's move counts for or against the chosen agent.
    store.settle("pld_4", "claimed-by-other", "agt_z", T(2));
    store.settle("pld_6", "superseded", null, T(2));
    expect(store.boardHistory("brd_a")).toEqual(
      new Map([["agt_a", { settled: 2, claimed: 1 }]]),
    );
    expect(store.noShowsSince(T(3))).toEqual(
      new Map([["agt_a", [T(3), T(4)]]]),
    );
    expect(store.noShowsSince(T(4))).toEqual(new Map([["agt_a", [T(4)]]]));
    expect(store.liveHolds(T(5))).toEqual(new Map([["agt_b", 1]]));
    expect(store.liveHolds(T(9))).toEqual(new Map());
  });
});

describe("decisions since", () => {
  test("the decisions at or after a time, newest first, up to a limit; requires reads back, or null", () => {
    const { store } = fresh();
    store.recordDecision(decision({ id: "pld_1", createdAt: T(0) }));
    store.recordDecision(
      decision({ id: "pld_2", createdAt: T(5), requires: null }),
    );
    store.recordDecision(decision({ id: "pld_3", createdAt: T(9) }));
    expect(store.decisionsSince(T(5), 10).map((d) => d.id)).toEqual([
      "pld_3",
      "pld_2",
    ]);
    expect(store.decisionsSince(T(0), 1).map((d) => d.id)).toEqual(["pld_3"]);
    expect(store.getDecision("pld_2")?.requires).toBeNull();
    expect(store.getDecision("pld_3")?.requires).toEqual({
      all: ["code"],
      any: [],
    });
  });
});

describe("suggestions", () => {
  const found = (over: Partial<FoundSuggestion> = {}): FoundSuggestion => ({
    kind: "add-agent-to-board",
    boardId: "brd_a",
    stageKey: "build",
    body: { reasons: ["one-candidate"], candidates: [{ agentId: "agt_x" }] },
    evidence: ["pld_1"],
    evidenceCount: 1,
    ...over,
  });
  const ids = () => {
    let n = 0;
    return () => `sug_${String(++n).padStart(24, "0")}`;
  };

  test("one row per kind, board and stage: opened, then updated with first seen kept", () => {
    const { store } = fresh();
    const newId = ids();
    expect(store.syncSuggestions([found(), found()], T(0), newId)).toEqual({
      opened: 1,
      updated: 0,
      resolved: 0,
    });
    expect(
      store.syncSuggestions(
        [found({ evidence: ["pld_1", "pld_2"], evidenceCount: 2 })],
        T(5),
        newId,
      ),
    ).toEqual({ opened: 0, updated: 1, resolved: 0 });
    expect(store.listSuggestions({})).toEqual([
      {
        id: "sug_000000000000000000000001",
        kind: "add-agent-to-board",
        boardId: "brd_a",
        stageKey: "build",
        body: found().body,
        evidence: ["pld_1", "pld_2"],
        evidenceCount: 2,
        firstSeenAt: T(0),
        lastSeenAt: T(5),
        resolvedAt: null,
        dismissedAt: null,
      },
    ]);
    // Another kind on the same lane, or another stage, is its own row.
    store.syncSuggestions(
      [found(), found({ kind: "lane-single-point" }), found({ stageKey: "x" })],
      T(6),
      newId,
    );
    expect(store.listSuggestions({ state: "all" })).toHaveLength(3);
  });

  test("one not found again is resolved; found after that, it opens anew without its dismissal", () => {
    const { store } = fresh();
    const newId = ids();
    store.syncSuggestions([found()], T(0), newId);
    const [row] = store.listSuggestions({});
    expect(store.dismissSuggestion(row!.id, T(1))?.dismissedAt).toBe(T(1));
    // Seen again while dismissed: updated, and still dismissed.
    store.syncSuggestions([found()], T(2), newId);
    expect(store.listSuggestions({})).toEqual([]);
    expect(store.listSuggestions({ state: "dismissed" })).toHaveLength(1);
    expect(store.syncSuggestions([], T(3), newId)).toEqual({
      opened: 0,
      updated: 0,
      resolved: 1,
    });
    expect(store.listSuggestions({ state: "resolved" })[0]?.resolvedAt).toBe(
      T(3),
    );
    expect(store.syncSuggestions([found()], T(4), newId)).toEqual({
      opened: 1,
      updated: 0,
      resolved: 0,
    });
    expect(store.listSuggestions({})).toMatchObject([
      {
        id: row!.id,
        firstSeenAt: T(4),
        resolvedAt: null,
        dismissedAt: null,
      },
    ]);
  });

  test("every open one not found is resolved, and only those", () => {
    const { store } = fresh();
    const newId = ids();
    store.syncSuggestions(
      [found(), found({ stageKey: "x" }), found({ stageKey: "y" })],
      T(0),
      newId,
    );
    expect(
      store.syncSuggestions([found({ stageKey: "y" })], T(1), newId),
    ).toEqual({ opened: 0, updated: 1, resolved: 2 });
    expect(store.listSuggestions({}).map((s) => s.stageKey)).toEqual(["y"]);
  });

  test("a dismissal is kept once made; an unknown id is null; listings filter by board", () => {
    const { store } = fresh();
    const newId = ids();
    store.syncSuggestions([found(), found({ boardId: "brd_b" })], T(0), newId);
    const id = store.listSuggestions({ boardId: "brd_b" })[0]!.id;
    expect(store.listSuggestions({ boardId: "brd_b" })).toHaveLength(1);
    store.dismissSuggestion(id, T(1));
    expect(store.dismissSuggestion(id, T(2))?.dismissedAt).toBe(T(1));
    expect(store.dismissSuggestion("sug_nope", T(2))).toBeNull();
    expect(store.listSuggestions({}).map((s) => s.boardId)).toEqual(["brd_a"]);
  });
});
