import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATABASE_FILE,
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

  test("migrations 1 and 2 make the decisions table", () => {
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
