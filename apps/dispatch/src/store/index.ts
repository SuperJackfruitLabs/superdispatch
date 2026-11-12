/**
 * The service's own store: one SQLite database (`bun:sqlite`, WAL) in the data directory. It
 * holds what SuperDispatch alone knows: its placement decisions, each with every candidate it
 * considered, what each filter said about it and the score that ranked the rest, the reservation
 * it asked for and what became of the card. It holds nothing another product owns: cards stay in
 * SuperPipeline, the roster in AgentPod.
 *
 * The lowest layer beside config: it knows tables, not boards and not placement's rules. Its
 * schema is a list of migrations applied in order at boot and recorded in `PRAGMA user_version`;
 * a database written by a newer build is refused rather than guessed at.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** The database's file name inside the data directory. */
export const DATABASE_FILE = "superdispatch.sqlite";

/**
 * The schema, one entry per version. Append only: a shipped entry is never edited, because a
 * database that already applied it would never see the change.
 */
export const MIGRATIONS: readonly string[] = [
  // Placement decisions. One row per decision on a ready card at a stage. `chosen_agent` is null
  // when no agent was chosen. `candidates` is JSON: every candidate considered, with each
  // filter's result (a rejection carries its reason code) and its score when it passed them all,
  // so "why did this go there?" is answered from the row alone. `reserved_until` is the end of
  // the reservation asked of SuperPipeline (null when none was asked), and `outcome` what became
  // of the card (null until it is known).
  `CREATE TABLE decisions (
     id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     stage_key TEXT NOT NULL,
     chosen_agent TEXT,
     candidates TEXT NOT NULL,
     reserved_until TEXT,
     outcome TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX decisions_card ON decisions (board_id, card_id, created_at);`,
];

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export interface Store {
  /** The schema version the database is at: the number of migrations applied. */
  schemaVersion(): number;
  close(): void;
}

/** Open (creating if need be) the store in `dataDir`, and bring its schema up to date. */
export function openStore(dataDir: string): Store {
  let db: Database;
  try {
    mkdirSync(dataDir, { recursive: true });
    db = new Database(join(dataDir, DATABASE_FILE), {
      create: true,
      strict: true,
    });
  } catch (error) {
    // The path is a setting's value, and fs and SQLite errors quote it: only the code is kept.
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "unknown";
    throw new StoreError(
      `the store cannot be opened in SUPERDISPATCH_DATA_DIR (${code})`,
    );
  }
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    schemaVersion: () => userVersion(db),
    close: () => db.close(),
  };
}

function userVersion(db: Database): number {
  const row = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get();
  return row?.user_version ?? 0;
}

/** Apply every migration the database has not seen, each in its own transaction. */
export function migrate(
  db: Database,
  migrations: readonly string[] = MIGRATIONS,
): void {
  const at = userVersion(db);
  if (at > migrations.length) {
    throw new StoreError(
      `the database is at schema version ${at}, newer than this build's ${migrations.length}`,
    );
  }
  for (let version = at + 1; version <= migrations.length; version++) {
    const sql = migrations[version - 1] as string;
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
    })();
  }
}
