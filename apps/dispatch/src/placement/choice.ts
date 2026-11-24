/**
 * Is there a choice to make for a card? `MIN_CANDIDATES` counts only the candidates that could take
 * it, whatever their source (the roster, or SuperPipeline's `agents/load` for `direct`).
 *
 * A candidate that could never take the card counts for nothing:
 *
 * - SuperPipeline would refuse its claim for good: without the capability (`capability`) or the
 *   grant (`grant`). A reason SuperPipeline does not name (`claimable`) may pass, as
 *   `card_reserved` does once another agent's hold lapses, so it is not counted out;
 * - it is not there: `unhealthy` while it has room (no heartbeat, a stale one, a bridge not ready
 *   with nothing in hand). Unhealthy with no room is its load speaking, as in `onlyLoad`;
 * - it takes nothing: a capacity of 0.
 *
 * A candidate turned away by anything else still counts. Its load and the ladder (busy, holding
 * another card, a recent no-show, passed over) pass on their own. A station need and the dispatch
 * policy are this service's own judgment, which SuperPipeline does not apply to a pull, so the hold
 * for another agent is what keeps the card from it: a choice.
 */
import { isIdle } from "../sources/index.ts";
import type { CandidateFacts, FilterName, FilterResult } from "./index.ts";

/** The fewest candidates that could take a card before it is placed. */
export const MIN_CANDIDATES = 2;

/** The filters that say SuperPipeline would refuse the agent's claim on this card for good. */
const REFUSED_BY_PIPELINE: ReadonlySet<FilterName> = new Set<FilterName>([
  "capability",
  "grant",
]);

/** Did the candidate pass the `roster` filter: is it in the candidate set? */
export function inTheSet(filters: readonly FilterResult[]): boolean {
  return filters.some((r) => r.filter === "roster" && r.passed);
}

/** Could the candidate take the card, now or once its load or the ladder lets it? */
export function couldTake(
  facts: CandidateFacts,
  filters: readonly FilterResult[],
): boolean {
  const load = facts.load;
  if (load === null || load.capacity <= 0 || !inTheSet(filters)) return false;
  const failed = (name: FilterName) =>
    filters.some((r) => r.filter === name && !r.passed);
  const noRoom = !isIdle(load) || failed("capacity");
  if (failed("health") && !noRoom) return false;
  return !filters.some((r) => !r.passed && REFUSED_BY_PIPELINE.has(r.filter));
}

/**
 * No choice to make: some candidate is in the set, and fewer than `MIN_CANDIDATES` are; or one is
 * eligible and fewer than `MIN_CANDIDATES` could take the card. When nobody is eligible, the card
 * goes on to wait or to `none-eligible` instead.
 */
export function noChoice(
  filtered: readonly {
    readonly facts: CandidateFacts;
    readonly filters: readonly FilterResult[];
  }[],
): boolean {
  const inSet = filtered.filter(({ filters }) => inTheSet(filters)).length;
  const able = filtered.filter(({ facts, filters }) =>
    couldTake(facts, filters),
  ).length;
  const eligible = filtered.some(({ filters }) =>
    filters.every((r) => r.passed),
  );
  return (
    inSet > 0 && (inSet < MIN_CANDIDATES || (eligible && able < MIN_CANDIDATES))
  );
}
