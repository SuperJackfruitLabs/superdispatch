/**
 * The operator's API for learned routing. Every request carries the operator's bearer token,
 * checked as the rest of the operator API checks it, before anything is read.
 *
 * - `GET /v1/dataset?since=&format=`: the labelled dataset, one row per settled decision and
 *   candidate (placement's `dataset.ts`, schema `DATASET_SCHEMA`), oldest first, at most
 *   `MAX_DATASET_DECISIONS` decisions. `since` is a time (decisions made at or after it);
 *   `format` is `jsonl` (the default, one row a line) or `json` (`{schema, rows}`).
 * - `POST /v1/models/train`: fit a model on the dataset and store it as the next version. Body,
 *   optional: `{"since": time, "seed": whole number}`. The answer is the model with its metrics;
 *   422 when the dataset has no training rows, or only one label.
 * - `GET /v1/models`: every model, newest version first. `GET /v1/models/:id`: one.
 * - `GET /v1/models/:id/shadow-report`: the model's choices in shadow against what happened, and
 *   whether it would pass the gate under the current settings.
 *
 * Training only stores a model. Whether a model places anything is `SUPERDISPATCH_LEARNED`'s.
 */
import { tokenMatchesSha256 } from "../config.ts";
import type { ModelRow, Store } from "../store/index.ts";
import { DATASET_SCHEMA, datasetRows, isRecord } from "../placement/dataset.ts";
import {
  DEFAULT_TRAIN,
  MODEL_KIND,
  modelApplies,
  train,
} from "../placement/learned.ts";
import { learnedGate, shadowReport } from "../placement/shadow.ts";
import { learnedModelOf, type LearnedSettings } from "../loop/learned.ts";
import { notAllowed, notFound, readBody, tooLarge } from "./body.ts";

export const DATASET_PATH = "/v1/dataset";
export const MODELS_PATH = "/v1/models";

/** The most decisions one dataset read or one training run takes, oldest first. */
export const MAX_DATASET_DECISIONS = 100_000;

const MODEL_ID = /^mdl_[0-9a-f]{24}$/;
const MAX_TRAIN_BODY = 4096;

export interface LearnedDeps {
  operatorTokenSha256: string;
  store: Pick<
    Store,
    "settledSince" | "saveModel" | "listModels" | "getModel" | "shadowOutcomes"
  >;
  /** The learned settings in force: the shadow report says how its gate reads. */
  settings: LearnedSettings;
  now: () => number;
  newModelId: () => string;
  log: (line: string) => void;
}

const bad = (error: string) => Response.json({ error }, { status: 400 });

function sinceOf(raw: string | null): string | null | Response {
  if (raw === null) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return bad("since is not a time");
  return new Date(ms).toISOString();
}

export function createLearnedHandler(deps: LearnedDeps) {
  const { log } = deps;
  return async (request: Request): Promise<Response> => {
    const header = request.headers.get("authorization") ?? "";
    const presented = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] ?? "";
    if (
      presented === "" ||
      !tokenMatchesSha256(deps.operatorTokenSha256, presented)
    ) {
      return Response.json(
        { error: "unauthorized" },
        { status: 401, headers: { "www-authenticate": "Bearer" } },
      );
    }
    const url = new URL(request.url);
    if (url.pathname === DATASET_PATH)
      return request.method === "GET" ? dataset(url) : notAllowed();
    const rest = url.pathname.slice(MODELS_PATH.length + 1);
    if (url.pathname === MODELS_PATH) {
      if (request.method !== "GET") return notAllowed();
      return Response.json({ models: deps.store.listModels().map(modelView) });
    }
    if (rest === "train")
      return request.method === "POST" ? trainModel(request) : notAllowed();
    const [id, verb, ...more] = rest.split("/");
    if (id === undefined || !MODEL_ID.test(id) || more.length > 0)
      return notFound();
    if (request.method !== "GET") return notAllowed();
    const model = deps.store.getModel(id);
    if (model === null) return notFound();
    if (verb === undefined) return Response.json({ model: modelView(model) });
    if (verb !== "shadow-report") return notFound();
    const report = shadowReport(deps.store.shadowOutcomes(id));
    const parsed = learnedModelOf(model);
    const gate = learnedGate(
      parsed === null
        ? null
        : { rows: parsed.rows, applies: modelApplies(parsed.body) },
      report,
      deps.settings,
    );
    return Response.json({
      modelId: id,
      version: model.version,
      mode: deps.settings.mode,
      report,
      gate: {
        ...gate,
        minRows: deps.settings.minRows,
        minShadow: deps.settings.minShadow,
        marginPct: deps.settings.marginPct,
      },
    });
  };

  function dataset(url: URL): Response {
    const since = sinceOf(url.searchParams.get("since"));
    if (since instanceof Response) return since;
    const format = url.searchParams.get("format") ?? "jsonl";
    if (format !== "jsonl" && format !== "json")
      return bad("format is not one of jsonl, json");
    const rows = datasetRows(
      deps.store.settledSince(since, MAX_DATASET_DECISIONS),
    );
    const headers = { "x-dataset-schema": String(DATASET_SCHEMA) };
    if (format === "json")
      return Response.json({ schema: DATASET_SCHEMA, rows }, { headers });
    return new Response(
      rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
      {
        headers: { ...headers, "content-type": "application/x-ndjson" },
      },
    );
  }

  async function trainModel(request: Request): Promise<Response> {
    const bytes = await readBody(request, MAX_TRAIN_BODY);
    if (bytes === null) return tooLarge();
    let body: Record<string, unknown> = {};
    if (bytes.length > 0) {
      try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!isRecord(parsed)) return bad("body is not a JSON object");
        body = parsed;
      } catch {
        return bad("body is not JSON");
      }
    }
    const since = sinceOf(typeof body.since === "string" ? body.since : null);
    if (since instanceof Response) return since;
    if (body.since !== undefined && typeof body.since !== "string")
      return bad("since is not a time");
    const seed = body.seed ?? DEFAULT_TRAIN.seed;
    if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0)
      return bad("seed is not a whole number");
    const rows = datasetRows(
      deps.store.settledSince(since, MAX_DATASET_DECISIONS),
    );
    const fitted = train(rows, { ...DEFAULT_TRAIN, seed });
    if (!fitted.ok)
      return Response.json(
        { error: fitted.reason, count: fitted.count },
        { status: 422 },
      );
    const model = deps.store.saveModel({
      id: deps.newModelId(),
      kind: MODEL_KIND,
      datasetSchema: DATASET_SCHEMA,
      body: fitted.body,
      metrics: fitted.metrics,
      rows: fitted.metrics.count,
      since,
      createdAt: new Date(deps.now()).toISOString(),
    });
    log(
      `models: v${model.version} trained on ${fitted.metrics.count} rows (auc ${fitted.metrics.auc?.toFixed(3) ?? "n/a"})`,
    );
    return Response.json({ model: modelView(model) }, { status: 201 });
  }
}

function modelView(m: ModelRow) {
  return {
    id: m.id,
    version: m.version,
    kind: m.kind,
    datasetSchema: m.datasetSchema,
    rows: m.rows,
    since: m.since,
    metrics: m.metrics,
    body: m.body,
    createdAt: m.createdAt,
  };
}
