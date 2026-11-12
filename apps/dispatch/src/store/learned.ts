/**
 * The store's learned-routing tables: the models fitted on the labelled dataset, each a numbered
 * version, and the shadow record of what a model would have chosen for each decision. Tables
 * only: what a model is and how it is fitted is placement's.
 */
import type { Database } from "bun:sqlite";
import type { DecisionRow, DecisionSql } from "./index.ts";

/** The migration that adds these tables; appended to the store's list. */
export const LEARNED_MIGRATION = `CREATE TABLE models (
     id TEXT PRIMARY KEY,
     version INTEGER NOT NULL UNIQUE,
     kind TEXT NOT NULL,
     dataset_schema INTEGER NOT NULL,
     body TEXT NOT NULL,
     metrics TEXT NOT NULL,
     rows INTEGER NOT NULL,
     since TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE shadow (
     decision_id TEXT PRIMARY KEY,
     model_id TEXT NOT NULL,
     formula_agent TEXT NOT NULL,
     learned_agent TEXT NOT NULL,
     learned_score REAL NOT NULL,
     scores TEXT NOT NULL,
     acted INTEGER NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX shadow_model ON shadow (model_id, created_at);
   CREATE INDEX decisions_settled ON decisions (created_at) WHERE outcome IS NOT NULL;`;

/** A model as it is written: its version is the next one. */
export interface NewModel {
  id: string;
  kind: string;
  datasetSchema: number;
  body: unknown;
  metrics: unknown;
  /** The training rows it was fitted on. */
  rows: number;
  /** The dataset's `since`, when it was given one. */
  since: string | null;
  createdAt: string;
}

export interface ModelRow extends NewModel {
  version: number;
}

/** What a model would have chosen for one decision; `acted` when it was what was held. */
export interface ShadowEntry {
  decisionId: string;
  modelId: string;
  formulaAgent: string;
  learnedAgent: string;
  learnedScore: number;
  scores: Record<string, number>;
  acted: boolean;
  createdAt: string;
}

/** A shadow entry with its decision's outcome. */
export interface ShadowOutcomeRow extends ShadowEntry {
  outcome: string | null;
  outcomeBy: string | null;
}

export interface LearnedStore {
  /** Settled decisions made at or after `since` (all when null), oldest first, at most `limit`. */
  settledSince(since: string | null, limit: number): DecisionRow[];
  /** Save a model as the next version. */
  saveModel(model: NewModel): ModelRow;
  /** Newest version first. */
  listModels(): ModelRow[];
  getModel(id: string): ModelRow | null;
  latestModel(): ModelRow | null;
  /** Record what a model would have chosen; a decision keeps its first entry. */
  recordShadow(entry: ShadowEntry): void;
  /** The shadow entry of one decision, or null. */
  getShadow(decisionId: string): ShadowEntry | null;
  /** Every shadow entry of a model, oldest first, with its decision's outcome. */
  shadowOutcomes(modelId: string): ShadowOutcomeRow[];
}

interface ModelSql {
  id: string;
  version: number;
  kind: string;
  dataset_schema: number;
  body: string;
  metrics: string;
  rows: number;
  since: string | null;
  created_at: string;
}

interface ShadowSql {
  decision_id: string;
  model_id: string;
  formula_agent: string;
  learned_agent: string;
  learned_score: number;
  scores: string;
  acted: number;
  created_at: string;
  outcome?: string | null;
  outcome_by?: string | null;
}

const modelOf = (r: ModelSql): ModelRow => ({
  id: r.id,
  version: r.version,
  kind: r.kind,
  datasetSchema: r.dataset_schema,
  body: JSON.parse(r.body) as unknown,
  metrics: JSON.parse(r.metrics) as unknown,
  rows: r.rows,
  since: r.since,
  createdAt: r.created_at,
});

const shadowOf = (r: ShadowSql): ShadowEntry => ({
  decisionId: r.decision_id,
  modelId: r.model_id,
  formulaAgent: r.formula_agent,
  learnedAgent: r.learned_agent,
  learnedScore: r.learned_score,
  scores: numbersOf(JSON.parse(r.scores)),
  acted: r.acted === 1,
  createdAt: r.created_at,
});

/** The numbers of a JSON object, by key; anything else is left out. */
function numbersOf(json: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof json === "object" && json !== null)
    for (const [k, v] of Object.entries(json))
      if (typeof v === "number") out[k] = v;
  return out;
}

/** The learned tables over an open database; `decisionOf` reads a decision row. */
export function learnedStore(
  db: Database,
  decisionOf: (row: DecisionSql) => DecisionRow,
): LearnedStore {
  const getModel = (id: string): ModelRow | null => {
    const row = db
      .query<ModelSql, [string]>("SELECT * FROM models WHERE id = ?")
      .get(id);
    return row ? modelOf(row) : null;
  };
  return {
    settledSince(since, limit) {
      const n = Math.max(1, Math.floor(limit));
      return (
        since === null
          ? db
              .query<DecisionSql, []>(
                `SELECT * FROM decisions WHERE outcome IS NOT NULL
                 ORDER BY created_at, rowid LIMIT ${n}`,
              )
              .all()
          : db
              .query<DecisionSql, [string]>(
                `SELECT * FROM decisions WHERE outcome IS NOT NULL AND created_at >= ?
                 ORDER BY created_at, rowid LIMIT ${n}`,
              )
              .all(since)
      ).map(decisionOf);
    },
    saveModel(model) {
      return db.transaction(() => {
        const row = db
          .query<
            { v: number | null },
            []
          >("SELECT max(version) AS v FROM models")
          .get();
        const version = (row?.v ?? 0) + 1;
        db.query(
          `INSERT INTO models (id, version, kind, dataset_schema, body, metrics, rows, since,
             created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          model.id,
          version,
          model.kind,
          model.datasetSchema,
          JSON.stringify(model.body),
          JSON.stringify(model.metrics),
          model.rows,
          model.since,
          model.createdAt,
        );
        const saved = getModel(model.id);
        if (saved === null) throw new Error("the model was not saved");
        return saved;
      })();
    },
    listModels: () =>
      db
        .query<ModelSql, []>("SELECT * FROM models ORDER BY version DESC")
        .all()
        .map(modelOf),
    getModel,
    latestModel() {
      const row = db
        .query<
          ModelSql,
          []
        >("SELECT * FROM models ORDER BY version DESC LIMIT 1")
        .get();
      return row ? modelOf(row) : null;
    },
    recordShadow(e) {
      db.query(
        `INSERT INTO shadow (decision_id, model_id, formula_agent, learned_agent, learned_score,
           scores, acted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (decision_id) DO NOTHING`,
      ).run(
        e.decisionId,
        e.modelId,
        e.formulaAgent,
        e.learnedAgent,
        e.learnedScore,
        JSON.stringify(e.scores),
        e.acted ? 1 : 0,
        e.createdAt,
      );
    },
    getShadow(decisionId) {
      const row = db
        .query<
          ShadowSql,
          [string]
        >("SELECT * FROM shadow WHERE decision_id = ?")
        .get(decisionId);
      return row ? shadowOf(row) : null;
    },
    shadowOutcomes: (modelId) =>
      db
        .query<ShadowSql, [string]>(
          `SELECT s.*, d.outcome AS outcome, d.outcome_by AS outcome_by
           FROM shadow s LEFT JOIN decisions d ON d.id = s.decision_id
           WHERE s.model_id = ? ORDER BY s.created_at, s.rowid`,
        )
        .all(modelId)
        .map((r) => ({
          ...shadowOf(r),
          outcome: r.outcome ?? null,
          outcomeBy: r.outcome_by ?? null,
        })),
  };
}
