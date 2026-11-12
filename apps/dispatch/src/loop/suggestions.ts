/**
 * The advice the loop keeps for a person: roster suggestions (`placement/suggest.ts`) and supply
 * proposals (`placement/supply.ts`), computed together from the store's decisions and brought in
 * line with the store's one suggestions table in one sync, so neither resolves the other.
 *
 * Advice only (charter decision 8). Its deps are the store and plain values: the capability
 * registry it is handed is the copy the loop last read, never a client, so it reads no product and
 * writes none. It can propose a roster or station change and never make one.
 */
import { randomBytes } from "node:crypto";
import { DEFAULT_MIN_PROOF, type Proof } from "../config.ts";
import type { StationCaps } from "../sources/index.ts";
import type { Store, SuggestionSync } from "../store/index.ts";
import {
  DEFAULT_STALL_AFTER_MS,
  DEFAULT_SUPPLY_MIN_EVIDENCE,
  candidateRecords,
  proposeSupply,
  suggest,
  type Capability,
} from "../placement/index.ts";

/** The most decisions one computation of the roster suggestions reads, newest first. */
export const MAX_SUGGESTION_DECISIONS = 5000;

/** When and over what the roster suggestions and supply proposals are computed. */
export interface SuggestionSettings {
  /** The least time between two computations; 0 computes after every sweep. */
  everyMs: number;
  /** How far back the decisions they read go. */
  windowMs: number;
  /** How long a card waits with nobody eligible before its lane is flagged. */
  stallAfterMs: number;
  /** How many decisions must bear a supply proposal out; `DEFAULT_SUPPLY_MIN_EVIDENCE` when unset. */
  supplyMinEvidence?: number;
}

export const DEFAULT_SUGGESTIONS: SuggestionSettings = {
  everyMs: 0,
  windowMs: 24 * 3600 * 1000,
  stallAfterMs: DEFAULT_STALL_AFTER_MS,
};

/** A new suggestion id: `sug_` and 24 hex digits. */
export const newSuggestionId = () => `sug_${randomBytes(12).toString("hex")}`;

/**
 * Compute the roster suggestions and the supply proposals from the store's decisions, and bring
 * the store's suggestions in line with both. Its deps are the store and the registry copy: it
 * reads no product and writes none.
 */
export function refreshSuggestions(deps: {
  store: Pick<Store, "listBoards" | "decisionsSince" | "syncSuggestions">;
  nowMs: number;
  settings?: SuggestionSettings;
  /** AgentPod's capability registry as the loop last read it; null or unset when it was not. */
  stations?: ReadonlyMap<string, StationCaps> | null;
  /** The weakest registry proof a supply target's fact counts with. */
  minProof?: Proof;
  newId?: () => string;
}): SuggestionSync {
  const settings = deps.settings ?? DEFAULT_SUGGESTIONS;
  const enabled = new Set(
    deps.store
      .listBoards()
      .filter((b) => b.enabled)
      .map((b) => b.boardId),
  );
  const decisions = deps.store
    .decisionsSince(
      new Date(deps.nowMs - settings.windowMs).toISOString(),
      MAX_SUGGESTION_DECISIONS,
    )
    .filter((d) => enabled.has(d.boardId))
    .map((d) => ({
      id: d.id,
      boardId: d.boardId,
      cardId: d.cardId,
      stageKey: d.stageKey,
      attemptsBefore: d.attemptsBefore,
      requires: capabilityOf(d.requires),
      noDecisionReason: d.noDecisionReason,
      candidates: candidateRecords(d.candidates),
      createdAtMs: Date.parse(d.createdAt),
    }));
  const roster = suggest({
    decisions,
    settings: { stallAfterMs: settings.stallAfterMs },
  });
  const supply = proposeSupply({
    decisions,
    stations: deps.stations ?? null,
    settings: {
      minEvidence: settings.supplyMinEvidence ?? DEFAULT_SUPPLY_MIN_EVIDENCE,
      minProof: deps.minProof ?? DEFAULT_MIN_PROOF,
    },
  });
  return deps.store.syncSuggestions(
    [...roster, ...supply].map(
      ({ kind, boardId, stageKey, evidence, evidenceCount, ...body }) => ({
        kind,
        boardId,
        stageKey,
        body,
        evidence: [...evidence],
        evidenceCount,
      }),
    ),
    new Date(deps.nowMs).toISOString(),
    deps.newId ?? newSuggestionId,
  );
}

/** A recorded `requires`, or null when it is not one. */
function capabilityOf(json: unknown): Capability | null {
  if (typeof json !== "object" || json === null) return null;
  const { all, any } = json as Record<string, unknown>;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return { all: strings(all), any: strings(any) };
}
