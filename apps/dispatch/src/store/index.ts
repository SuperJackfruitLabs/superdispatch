/**
 * The service's own store: one SQLite database (`bun:sqlite`, WAL) in the data directory. It
 * holds what SuperDispatch alone knows: its placement decisions, each with every candidate it
 * considered, what each filter said about it and the score that ranked the rest, the reservation
 * it asked for and what became of the card; and its roster suggestions, advice for a person. It holds nothing another product owns: cards stay in
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
  // The boards the operator opted in, and what a decision needs to explain itself and to become a
  // labelled example: the policy that made it; why none was chosen; the card's attempt count when
  // it was made (a higher count later means somebody claimed it); the code SuperPipeline refused a
  // reservation with; and who settled the outcome, and when. `outcome` is one of `claimed`,
  // `claimed-by-other`, `expired`, `superseded` and `not-reserved`.
  `CREATE TABLE boards (
     board_id TEXT PRIMARY KEY,
     enabled INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   ALTER TABLE decisions ADD COLUMN policy TEXT;
   ALTER TABLE decisions ADD COLUMN no_decision_reason TEXT;
   ALTER TABLE decisions ADD COLUMN attempts_before INTEGER;
   ALTER TABLE decisions ADD COLUMN reservation_refused TEXT;
   ALTER TABLE decisions ADD COLUMN outcome_by TEXT;
   ALTER TABLE decisions ADD COLUMN outcome_at TEXT;
   CREATE INDEX decisions_open ON decisions (board_id)
     WHERE outcome IS NULL AND reserved_until IS NOT NULL;
   CREATE INDEX decisions_chosen ON decisions (chosen_agent, outcome, outcome_at);
   CREATE INDEX decisions_created ON decisions (created_at);`,
  // Tiers: the tier a decision was made in (`winner`, `runner-up` or `any-match`) and its step on
  // the card's ladder of holds, 1 first. A decision in the any-match tier holds nothing but stays
  // open until the card is claimed or moved, so it is settled like a hold. Older rows have neither.
  `ALTER TABLE decisions ADD COLUMN tier TEXT;
   ALTER TABLE decisions ADD COLUMN tier_step INTEGER;
   DROP INDEX decisions_open;
   CREATE INDEX decisions_open ON decisions (board_id)
     WHERE outcome IS NULL AND (reserved_until IS NOT NULL OR tier = 'any-match');
   CREATE INDEX decisions_ladder ON decisions (board_id, card_id, stage_key, attempts_before);`,
  // Roster suggestions (advice for a person; SuperDispatch never edits a roster). A decision
  // records the capability its stage asked for (`requires`, JSON `{all, any}`), so a suggestion can
  // name it. One suggestion per kind, board and stage: `body` is JSON (capability, rostered agents,
  // candidates, reasons, reason), `evidence` the JSON list of decision ids that bear it out and
  // `evidence_count` how many there were. `resolved_at` is set when a computation no longer finds
  // it, `dismissed_at` when the operator dismissed it; seen again after it resolved, it opens anew.
  `ALTER TABLE decisions ADD COLUMN requires TEXT;
   CREATE TABLE suggestions (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     board_id TEXT NOT NULL,
     stage_key TEXT NOT NULL,
     body TEXT NOT NULL,
     evidence TEXT NOT NULL,
     evidence_count INTEGER NOT NULL,
     first_seen_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     resolved_at TEXT,
     dismissed_at TEXT,
     UNIQUE (kind, board_id, stage_key)
   );`,
];

/** Which suggestions a listing reads: open (not resolved, not dismissed) when unset. */
export const SUGGESTION_STATES = [
  "open",
  "dismissed",
  "resolved",
  "all",
] as const;
export type SuggestionState = (typeof SUGGESTION_STATES)[number];

/** A suggestion as a computation found it. `body` is placement's record, kept as JSON. */
export interface FoundSuggestion {
  kind: string;
  boardId: string;
  stageKey: string;
  body: unknown;
  evidence: string[];
  evidenceCount: number;
}

/** A suggestion as it is read back. */
export interface SuggestionRow extends FoundSuggestion {
  id: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  dismissedAt: string | null;
}

/** What one sync changed. */
export interface SuggestionSync {
  opened: number;
  updated: number;
  resolved: number;
}

/** What became of a card a decision was about. */
export const OUTCOMES = [
  /** The chosen agent claimed it. */
  "claimed",
  /** Somebody else claimed it: another agent, after the hold lapsed, or one off the roster. */
  "claimed-by-other",
  /** The hold lapsed and the card still waits: the chosen agent did not come for it. */
  "expired",
  /** The card left the stage, or the board, without a claim: a person moved or archived it. */
  "superseded",
  /** SuperPipeline refused the reservation, so nothing was held (`reservation_refused` says why). */
  "not-reserved",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** A board the operator opted in. */
export interface Board {
  boardId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A decision as it is written. `candidates` is placement's record, kept as JSON. */
export interface NewDecision {
  id: string;
  boardId: string;
  cardId: string;
  stageKey: string;
  policy: string;
  chosenAgent: string | null;
  noDecisionReason: string | null;
  candidates: unknown;
  attemptsBefore: number;
  /** The tier it was made in, and its step on the card's ladder; null on rows older than tiers. */
  tier: string | null;
  tierStep: number | null;
  /** The capability the stage asked for (`{all, any}`); null when unknown. */
  requires?: unknown;
  createdAt: string;
}

/** A decision as it is read back. */
export interface DecisionRow extends NewDecision {
  reservedUntil: string | null;
  reservationRefused: string | null;
  outcome: Outcome | null;
  outcomeBy: string | null;
  outcomeAt: string | null;
}

/** What the store remembers of one agent's holds on one board. */
export interface AgentHistory {
  /** Holds settled as claimed by it or lapsed. */
  settled: number;
  claimed: number;
}

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

  /** Opt a board in, or enable it again. */
  enableBoard(boardId: string, at: string): Board;
  /** Opt a board out; the row stays. Null when it was never opted in. */
  disableBoard(boardId: string, at: string): Board | null;
  getBoard(boardId: string): Board | null;
  listBoards(): Board[];

  recordDecision(decision: NewDecision): void;
  /** What SuperPipeline answered the reservation: held until, or refused with a code. */
  setReservation(
    id: string,
    answer: { reservedUntil: string } | { refused: string },
    at: string,
  ): void;
  /** Settle a decision's outcome, once: a settled one is left as it is. */
  settle(id: string, outcome: Outcome, by: string | null, at: string): boolean;
  /**
   * The decisions on a board whose outcome is not known yet and that wait on one: a granted hold,
   * or a card opened to any match.
   */
  openDecisions(boardId: string): DecisionRow[];
  /**
   * The ladder decisions on a card at a stage and attempt count, newest first: the ones whose hold
   * lapsed (`expired`), that were `superseded`, or that opened the card to any match.
   */
  ladderDecisions(
    boardId: string,
    cardId: string,
    stageKey: string,
    attemptsBefore: number,
  ): DecisionRow[];
  /** The latest decision on a card, or null. */
  latestDecision(boardId: string, cardId: string): DecisionRow | null;
  /** Newest first, at most `limit`, optionally for one board and one card, before a time. */
  listDecisions(query: {
    boardId?: string;
    cardId?: string;
    before?: string;
    limit: number;
  }): DecisionRow[];
  getDecision(id: string): DecisionRow | null;

  /** Per agent: its settled holds on this board, and how many it claimed. */
  boardHistory(boardId: string): Map<string, AgentHistory>;
  /** Per agent: when its holds lapsed unclaimed since `since`, on any board. */
  noShowsSince(since: string): Map<string, string[]>;
  /** Per agent: the holds still live at `at` (granted, unsettled, not lapsed), on any board. */
  liveHolds(at: string): Map<string, number>;
  /**
   * How many holds SuperPipeline granted for the agent in decisions made at or after `since`, on
   * any board, whatever became of them: what a dispatch policy's limit counts.
   */
  holdsMadeSince(agentId: string, since: string): number;
  /** The decisions made at or after `since`, newest first, at most `limit`. */
  decisionsSince(since: string, limit: number): DecisionRow[];

  /**
   * Bring the suggestions in line with one computation, in one transaction: each found one is
   * opened (new, or seen again after it resolved: a dismissal does not carry over) or updated (its
   * body, evidence and last seen; a dismissal stays), and each open one not found is resolved.
   * `newId` names a new row.
   */
  syncSuggestions(
    found: readonly FoundSuggestion[],
    at: string,
    newId: () => string,
  ): SuggestionSync;
  /** Newest seen first, optionally for one board, in one state (`open` when unset). */
  listSuggestions(query: {
    boardId?: string;
    state?: SuggestionState;
  }): SuggestionRow[];
  getSuggestion(id: string): SuggestionRow | null;
  /** Dismiss it, once: a dismissed one keeps its first dismissal. Null when there is none. */
  dismissSuggestion(id: string, at: string): SuggestionRow | null;
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

  return storeOver(db);
}

interface BoardSql {
  board_id: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface DecisionSql {
  id: string;
  board_id: string;
  card_id: string;
  stage_key: string;
  policy: string | null;
  chosen_agent: string | null;
  no_decision_reason: string | null;
  candidates: string;
  attempts_before: number | null;
  tier: string | null;
  tier_step: number | null;
  requires: string | null;
  reserved_until: string | null;
  reservation_refused: string | null;
  outcome: string | null;
  outcome_by: string | null;
  outcome_at: string | null;
  created_at: string;
}

const boardOf = (r: BoardSql): Board => ({
  boardId: r.board_id,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const decisionOf = (r: DecisionSql): DecisionRow => ({
  id: r.id,
  boardId: r.board_id,
  cardId: r.card_id,
  stageKey: r.stage_key,
  policy: r.policy ?? "",
  chosenAgent: r.chosen_agent,
  noDecisionReason: r.no_decision_reason,
  candidates: JSON.parse(r.candidates) as unknown,
  attemptsBefore: r.attempts_before ?? 0,
  tier: r.tier,
  tierStep: r.tier_step,
  requires: r.requires === null ? null : (JSON.parse(r.requires) as unknown),
  createdAt: r.created_at,
  reservedUntil: r.reserved_until,
  reservationRefused: r.reservation_refused,
  outcome: (OUTCOMES as readonly string[]).includes(r.outcome ?? "")
    ? (r.outcome as Outcome)
    : null,
  outcomeBy: r.outcome_by,
  outcomeAt: r.outcome_at,
});

interface SuggestionSql {
  id: string;
  kind: string;
  board_id: string;
  stage_key: string;
  body: string;
  evidence: string;
  evidence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  dismissed_at: string | null;
}

const suggestionOf = (r: SuggestionSql): SuggestionRow => ({
  id: r.id,
  kind: r.kind,
  boardId: r.board_id,
  stageKey: r.stage_key,
  body: JSON.parse(r.body) as unknown,
  evidence: JSON.parse(r.evidence) as string[],
  evidenceCount: r.evidence_count,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  resolvedAt: r.resolved_at,
  dismissedAt: r.dismissed_at,
});

const SUGGESTION_WHERE: Record<SuggestionState, string> = {
  open: "resolved_at IS NULL AND dismissed_at IS NULL",
  dismissed: "resolved_at IS NULL AND dismissed_at IS NOT NULL",
  resolved: "resolved_at IS NOT NULL",
  all: "1 = 1",
};

function storeOver(db: Database): Store {
  const getSuggestion = (id: string): SuggestionRow | null => {
    const row = db
      .query<SuggestionSql, [string]>("SELECT * FROM suggestions WHERE id = ?")
      .get(id);
    return row ? suggestionOf(row) : null;
  };
  const getBoard = (boardId: string): Board | null => {
    const row = db
      .query<BoardSql, [string]>("SELECT * FROM boards WHERE board_id = ?")
      .get(boardId);
    return row ? boardOf(row) : null;
  };
  const getDecision = (id: string): DecisionRow | null => {
    const row = db
      .query<DecisionSql, [string]>("SELECT * FROM decisions WHERE id = ?")
      .get(id);
    return row ? decisionOf(row) : null;
  };

  return {
    schemaVersion: () => userVersion(db),
    close: () => db.close(),

    enableBoard(boardId, at) {
      db.query(
        `INSERT INTO boards (board_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT (board_id) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at`,
      ).run(boardId, at, at);
      return getBoard(boardId) as Board;
    },
    disableBoard(boardId, at) {
      db.query(
        "UPDATE boards SET enabled = 0, updated_at = ? WHERE board_id = ?",
      ).run(at, boardId);
      return getBoard(boardId);
    },
    getBoard,
    listBoards: () =>
      db
        .query<BoardSql, []>("SELECT * FROM boards ORDER BY board_id")
        .all()
        .map(boardOf),

    recordDecision(d) {
      db.query(
        `INSERT INTO decisions (id, board_id, card_id, stage_key, policy, chosen_agent,
           no_decision_reason, candidates, attempts_before, tier, tier_step, requires, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        d.id,
        d.boardId,
        d.cardId,
        d.stageKey,
        d.policy,
        d.chosenAgent,
        d.noDecisionReason,
        JSON.stringify(d.candidates),
        d.attemptsBefore,
        d.tier,
        d.tierStep,
        d.requires === undefined || d.requires === null
          ? null
          : JSON.stringify(d.requires),
        d.createdAt,
      );
    },
    setReservation(id, answer, at) {
      if ("reservedUntil" in answer) {
        db.query(
          "UPDATE decisions SET reserved_until = ? WHERE id = ? AND outcome IS NULL",
        ).run(answer.reservedUntil, id);
      } else {
        db.query(
          `UPDATE decisions SET reservation_refused = ?, outcome = 'not-reserved', outcome_at = ?
           WHERE id = ? AND outcome IS NULL`,
        ).run(answer.refused, at, id);
      }
    },
    settle(id, outcome, by, at) {
      const changed = db
        .query(
          "UPDATE decisions SET outcome = ?, outcome_by = ?, outcome_at = ? WHERE id = ? AND outcome IS NULL",
        )
        .run(outcome, by, at, id).changes;
      return changed > 0;
    },
    openDecisions: (boardId) =>
      db
        .query<DecisionSql, [string]>(
          `SELECT * FROM decisions
           WHERE board_id = ? AND outcome IS NULL
             AND (reserved_until IS NOT NULL OR tier = 'any-match')
           ORDER BY created_at, id`,
        )
        .all(boardId)
        .map(decisionOf),
    ladderDecisions: (boardId, cardId, stageKey, attemptsBefore) =>
      db
        .query<DecisionSql, [string, string, string, number]>(
          `SELECT * FROM decisions
           WHERE board_id = ? AND card_id = ? AND stage_key = ? AND attempts_before = ?
             AND (outcome IN ('expired', 'superseded') OR tier = 'any-match')
           ORDER BY created_at DESC, rowid DESC`,
        )
        .all(boardId, cardId, stageKey, attemptsBefore)
        .map(decisionOf),
    latestDecision(boardId, cardId) {
      const row = db
        .query<DecisionSql, [string, string]>(
          `SELECT * FROM decisions WHERE board_id = ? AND card_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(boardId, cardId);
      return row ? decisionOf(row) : null;
    },
    listDecisions({ boardId, cardId, before, limit }) {
      const where: string[] = [];
      const args: string[] = [];
      if (boardId !== undefined) {
        where.push("board_id = ?");
        args.push(boardId);
      }
      if (cardId !== undefined) {
        where.push("card_id = ?");
        args.push(cardId);
      }
      if (before !== undefined) {
        where.push("created_at < ?");
        args.push(before);
      }
      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      return db
        .query<DecisionSql, string[]>(
          `SELECT * FROM decisions ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
        )
        .all(...args)
        .map(decisionOf);
    },
    getDecision,

    boardHistory(boardId) {
      const rows = db
        .query<{ agent: string; settled: number; claimed: number }, [string]>(
          `SELECT chosen_agent AS agent, count(*) AS settled,
             sum(CASE WHEN outcome = 'claimed' THEN 1 ELSE 0 END) AS claimed
           FROM decisions
           WHERE board_id = ? AND chosen_agent IS NOT NULL AND outcome IN ('claimed', 'expired')
           GROUP BY chosen_agent`,
        )
        .all(boardId);
      return new Map(
        rows.map((r) => [r.agent, { settled: r.settled, claimed: r.claimed }]),
      );
    },
    noShowsSince(since) {
      const rows = db
        .query<{ agent: string; at: string }, [string]>(
          `SELECT chosen_agent AS agent, outcome_at AS at FROM decisions
           WHERE outcome = 'expired' AND chosen_agent IS NOT NULL AND outcome_at >= ?
           ORDER BY outcome_at`,
        )
        .all(since);
      const out = new Map<string, string[]>();
      for (const r of rows)
        out.set(r.agent, [...(out.get(r.agent) ?? []), r.at]);
      return out;
    },
    liveHolds(at) {
      const rows = db
        .query<{ agent: string; n: number }, [string]>(
          `SELECT chosen_agent AS agent, count(*) AS n FROM decisions
           WHERE outcome IS NULL AND reserved_until IS NOT NULL AND reserved_until > ?
             AND chosen_agent IS NOT NULL
           GROUP BY chosen_agent`,
        )
        .all(at);
      return new Map(rows.map((r) => [r.agent, r.n]));
    },
    holdsMadeSince(agentId, since) {
      const row = db
        .query<{ n: number }, [string, string]>(
          `SELECT count(*) AS n FROM decisions
           WHERE chosen_agent = ? AND reserved_until IS NOT NULL AND created_at >= ?`,
        )
        .get(agentId, since);
      return row?.n ?? 0;
    },
    decisionsSince: (since, limit) =>
      db
        .query<DecisionSql, [string]>(
          `SELECT * FROM decisions WHERE created_at >= ?
           ORDER BY created_at DESC, rowid DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
        )
        .all(since)
        .map(decisionOf),

    syncSuggestions(found, at, newId) {
      const sync: SuggestionSync = { opened: 0, updated: 0, resolved: 0 };
      db.transaction(() => {
        const seen = new Set<string>();
        for (const f of found) {
          const key = `${f.kind}\u0000${f.boardId}\u0000${f.stageKey}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const body = JSON.stringify(f.body);
          const evidence = JSON.stringify(f.evidence);
          const row = db
            .query<
              SuggestionSql,
              [string, string, string]
            >("SELECT * FROM suggestions WHERE kind = ? AND board_id = ? AND stage_key = ?")
            .get(f.kind, f.boardId, f.stageKey);
          if (row === null) {
            db.query(
              `INSERT INTO suggestions (id, kind, board_id, stage_key, body, evidence,
                 evidence_count, first_seen_at, last_seen_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              newId(),
              f.kind,
              f.boardId,
              f.stageKey,
              body,
              evidence,
              f.evidenceCount,
              at,
              at,
            );
            sync.opened++;
          } else if (row.resolved_at !== null) {
            db.query(
              `UPDATE suggestions SET body = ?, evidence = ?, evidence_count = ?,
                 first_seen_at = ?, last_seen_at = ?, resolved_at = NULL, dismissed_at = NULL
               WHERE id = ?`,
            ).run(body, evidence, f.evidenceCount, at, at, row.id);
            sync.opened++;
          } else {
            db.query(
              `UPDATE suggestions SET body = ?, evidence = ?, evidence_count = ?, last_seen_at = ?
               WHERE id = ?`,
            ).run(body, evidence, f.evidenceCount, at, row.id);
            sync.updated++;
          }
        }
        const open = db
          .query<
            SuggestionSql,
            []
          >("SELECT * FROM suggestions WHERE resolved_at IS NULL")
          .all();
        for (const row of open) {
          if (
            seen.has(`${row.kind}\u0000${row.board_id}\u0000${row.stage_key}`)
          )
            continue;
          db.query("UPDATE suggestions SET resolved_at = ? WHERE id = ?").run(
            at,
            row.id,
          );
          sync.resolved++;
        }
      })();
      return sync;
    },
    listSuggestions({ boardId, state }) {
      const where = [SUGGESTION_WHERE[state ?? "open"]];
      const args: string[] = [];
      if (boardId !== undefined) {
        where.push("board_id = ?");
        args.push(boardId);
      }
      return db
        .query<SuggestionSql, string[]>(
          `SELECT * FROM suggestions WHERE ${where.join(" AND ")}
           ORDER BY last_seen_at DESC, board_id, stage_key, kind`,
        )
        .all(...args)
        .map(suggestionOf);
    },
    getSuggestion,
    dismissSuggestion(id, at) {
      db.query(
        "UPDATE suggestions SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL",
      ).run(at, id);
      return getSuggestion(id);
    },
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
