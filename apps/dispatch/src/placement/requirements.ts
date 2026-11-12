/**
 * What a stage says a station needs, against what AgentPod's capability registry says the
 * candidate's station has (charter 2026-11-13: AgentPod owns the catalog and the registry;
 * SuperDispatch reads it). Pure: the loop reads both and hands them in.
 *
 * Four checks, each only when the stage states it, so a stage that states nothing is placed exactly
 * as before:
 *
 * - **isolation**: the station is isolated at least as strongly as asked (`host` < `container` <
 *   `sandbox`);
 * - **model**: the station's model is one of those asked for;
 * - **tools**: the station has every catalog entry asked for;
 * - **credentials**: the station reaches every credential name asked for.
 *
 * A fact counts only when its proof is at least the minimum (`MinProof`): with `installed`, a fact
 * someone merely declared does not satisfy a need. A station the registry does not list (or a
 * candidate with no station) has nothing, so it fails every stated need.
 */
import { PROOF_ORDER, type Proof } from "../config.ts";
import {
  ISOLATION_ORDER,
  type IsolationLevel,
  type StageNeeds,
  type StationCaps,
} from "../sources/index.ts";

export type NeedName = "isolation" | "model" | "tools" | "credentials";

/** One check's answer: what was asked and not found (empty when it passed). */
export interface NeedResult {
  readonly need: NeedName;
  readonly ok: boolean;
  /** What the station lacks, in the stage's words: ids, names, or the isolation asked for. */
  readonly missing: readonly string[];
}

/** Is `proof` at least `min`? `probed` is strongest. */
export function proofMeets(proof: Proof, min: Proof): boolean {
  return PROOF_ORDER.indexOf(proof) <= PROOF_ORDER.indexOf(min);
}

/**
 * The checks the stage states, in the order above, against the station's row (null: the registry
 * has no row for it). A stage that states nothing gives no checks at all.
 */
export function checkNeeds(
  needs: StageNeeds | null | undefined,
  caps: StationCaps | null,
  minProof: Proof,
): NeedResult[] {
  if (needs === null || needs === undefined) return [];
  const ok = (proof: Proof) => proofMeets(proof, minProof);
  const out: NeedResult[] = [];
  if (needs.isolation !== undefined) {
    const have = caps?.isolation;
    const rank = (level: string) =>
      ISOLATION_ORDER.indexOf(level as IsolationLevel);
    const met =
      have !== null &&
      have !== undefined &&
      ok(have.proof) &&
      rank(have.level) >= rank(needs.isolation);
    out.push({
      need: "isolation",
      ok: met,
      missing: met ? [] : [needs.isolation],
    });
  }
  if ((needs.models?.length ?? 0) > 0) {
    const have = caps?.model;
    const met =
      have !== null &&
      have !== undefined &&
      ok(have.proof) &&
      (needs.models ?? []).includes(have.id);
    out.push({
      need: "model",
      ok: met,
      missing: met ? [] : [...(needs.models ?? [])],
    });
  }
  if ((needs.tools?.length ?? 0) > 0) {
    const have = new Set(
      (caps?.tools ?? []).filter((t) => ok(t.proof)).map((t) => t.id),
    );
    const missing = (needs.tools ?? []).filter((id) => !have.has(id));
    out.push({ need: "tools", ok: missing.length === 0, missing });
  }
  if ((needs.credentials?.length ?? 0) > 0) {
    const have = new Set(
      (caps?.credentials ?? []).filter((c) => ok(c.proof)).map((c) => c.name),
    );
    const missing = (needs.credentials ?? []).filter((name) => !have.has(name));
    out.push({ need: "credentials", ok: missing.length === 0, missing });
  }
  return out;
}
