import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATABASE_FILE,
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

  test("migration 1 makes the decisions table", () => {
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
