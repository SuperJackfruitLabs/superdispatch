/**
 * The loop: what SuperDispatch does with each opted-in board, on every sweep and whenever the
 * event relay says something happened on the board.
 *
 * One pass over a board:
 *
 * 1. **Read the board** from SuperPipeline: its stages and cards.
 * 2. **Settle what became of each card it holds** (`settle`): a card whose attempt count rose
 *    was claimed, by the chosen agent (`claimed`) or by somebody else (`claimed-by-other`); one
 *    that left its stage, its board or its waiting state without a claim was `superseded`; one
 *    still waiting after its hold lapsed is `expired`, the chosen agent's no-show. Each settled
 *    decision is a labelled example: the candidates, their facts and scores, the choice, the
 *    outcome.
 * 3. **Place each ready card** (`readyCards`: waiting to be claimed, in a capability lane, no
 *   live hold), best first by priority then age: read the roster from AgentPod (once a pass) and
 *    the card's eligibility from SuperPipeline, add what the store remembers (history on this
 *    board, recent no-shows, live holds), and let placement choose. Record the decision, then ask
 *    SuperPipeline to hold the card for the winner for the reservation window.
 *
 * A card whose last decision chose nobody, or whose hold was refused, is not decided again for
 * `REDECIDE_AFTER_MS`, so a card nobody can take is not re-recorded every sweep. A card whose hold
 * lapsed is placed again on the next pass; the no-show filter and the success rate keep a
 * non-claiming agent from winning it every time.
 *
 * Nothing requires this loop. It never claims and never hands a card to anybody; it asks
 * SuperPipeline for a hold that lapses on its own, at most the reservation window (300 s at the
 * very most). If SuperDispatch stops, every hold it made lapses and every card is claimed by pull
 * as before; if SuperPipeline has no reservation verb, the decision is recorded as `not-reserved`
 * and nothing else changes.
 *
 * Publishing each decision as an event through treaty's relay (charter decision 6) is a later
 * slice: it needs a decision event in treaty's catalogue first. Until then the record is read on
 * the operator API (`GET /v1/decisions`).
 */
import type { Outcome, Store, DecisionRow } from "../store/index.ts";
import {
  SourceError,
  type Agentpod,
  type BoardView,
  type CardView,
  type RosterEntry,
  type Superpipeline,
} from "../sources/index.ts";
import {
  NO_SHOW_WINDOW_MS,
  POLICY,
  place,
  type CandidateFacts,
  type Decision,
} from "../placement/index.ts";

/** How long a card whose last decision chose nobody, or was refused a hold, waits to be decided again. */
export const REDECIDE_AFTER_MS = 5 * 60 * 1000;

/** The most cards one pass places on one board: the rest wait for the next pass. */
export const MAX_CARDS_PER_PASS = 20;

export interface LoopDeps {
  store: Store;
  superpipeline: Superpipeline;
  agentpod: Agentpod;
  /** Seconds SuperPipeline holds a card for the chosen agent. */
  reservationSeconds: number;
  now: () => number;
  /** A new decision id: `pld_` and hex. */
  newId: () => string;
  log?: (line: string) => void;
}

export interface BoardPass {
  boardId: string;
  /** Decisions whose outcome this pass settled. */
  settled: number;
  /** Decisions this pass recorded. */
  decided: number;
  /** Of those, the ones SuperPipeline holds a card for. */
  reserved: number;
}

export interface PassResult {
  boards: number;
  failedBoards: number;
}

export interface Loop {
  /** One pass over one board. Throws when the board cannot be read. */
  passBoard(boardId: string): Promise<BoardPass>;
  /** One pass over every enabled board; a board that fails is counted, not thrown. */
  passAll(): Promise<PassResult>;
}

/** Cards waiting to be claimed in a lane an agent may claim from, with no live hold. Best first. */
export function readyCards(board: BoardView, nowIso: string): CardView[] {
  const stages = new Map(board.stages.map((s) => [s.key, s]));
  return board.cards
    .filter((card) => {
      const stage = stages.get(card.stageKey);
      // A person's stage is never placed; a stage pinned to one agent has no choice to make.
      if (stage === undefined) return false;
      if (stage.ownerKind === "human" || stage.ownerKind === "agent")
        return false;
      if (card.archived || card.state !== "submitted") return false;
      if (card.currentRunId !== null) return false;
      return !(
        card.reservation !== null && card.reservation.reservedUntil > nowIso
      );
    })
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
        (a.id < b.id ? -1 : 1),
    );
}

/**
 * What became of the card an open decision held, as the board reads now; null while it is still
 * open (held, and the hold not lapsed).
 */
export function outcomeOf(
  decision: DecisionRow,
  card: CardView | undefined,
  nowIso: string,
): { outcome: Outcome; by: string | null } | null {
  if (card === undefined || card.archived)
    return { outcome: "superseded", by: null };
  if (card.attemptCount > decision.attemptsBefore) {
    return card.lastAgentId === decision.chosenAgent
      ? { outcome: "claimed", by: card.lastAgentId }
      : { outcome: "claimed-by-other", by: card.lastAgentId };
  }
  if (card.stageKey !== decision.stageKey || card.state !== "submitted")
    return { outcome: "superseded", by: null };
  if (decision.reservedUntil !== null && nowIso >= decision.reservedUntil)
    return { outcome: "expired", by: null };
  return null;
}

/** Should a card with this latest decision be decided again now? */
export function shouldDecide(
  latest: DecisionRow | null,
  card: CardView,
  nowMs: number,
): boolean {
  if (latest === null || latest.stageKey !== card.stageKey) return true;
  // Held, and not settled yet: the hold is the decision.
  if (latest.outcome === null && latest.reservedUntil !== null) return false;
  // A lapsed hold or a settled claim: the card is waiting again, so it is placed again.
  if (latest.outcome !== null && latest.outcome !== "not-reserved") return true;
  // Chose nobody, or was refused a hold: wait before asking again.
  return nowMs - Date.parse(latest.createdAt) >= REDECIDE_AFTER_MS;
}

export function createLoop(deps: LoopDeps): Loop {
  const log = deps.log ?? console.log;
  const { store, superpipeline, agentpod } = deps;

  async function passBoard(boardId: string): Promise<BoardPass> {
    const result: BoardPass = { boardId, settled: 0, decided: 0, reserved: 0 };
    const board = await superpipeline.board(boardId);
    const nowMs = deps.now();
    const nowIso = new Date(nowMs).toISOString();

    const cards = new Map(board.cards.map((c) => [c.id, c]));
    for (const open of store.openDecisions(boardId)) {
      const settled = outcomeOf(open, cards.get(open.cardId), nowIso);
      if (settled === null) continue;
      if (store.settle(open.id, settled.outcome, settled.by, nowIso)) {
        result.settled++;
        log(
          `loop: ${boardId} ${open.cardId} ${open.id} settled ${settled.outcome}${settled.by ? ` by ${settled.by}` : ""}`,
        );
      }
    }

    const ready = readyCards(board, nowIso).filter((card) =>
      shouldDecide(store.latestDecision(boardId, card.id), card, nowMs),
    );
    if (ready.length === 0) return result;

    let roster: RosterEntry[];
    try {
      roster = await agentpod.roster(boardId);
    } catch (error) {
      log(
        `loop: ${boardId} roster unread (${describe(error)}); nothing placed`,
      );
      return result;
    }
    const rosterByPrincipal = new Map<string, RosterEntry>();
    for (const entry of roster) {
      if (entry.principalId === null) continue;
      const known = rosterByPrincipal.get(entry.principalId);
      // An enabled row speaks for the agent over a disabled one.
      if (known === undefined || (!known.enabled && entry.enabled))
        rosterByPrincipal.set(entry.principalId, entry);
    }
    const history = store.boardHistory(boardId);
    const noShows = store.noShowsSince(
      new Date(nowMs - NO_SHOW_WINDOW_MS).toISOString(),
    );
    const holds = store.liveHolds(nowIso);

    for (const card of ready.slice(0, MAX_CARDS_PER_PASS)) {
      let eligibility;
      try {
        eligibility = await superpipeline.eligibility(boardId, card.id);
      } catch (error) {
        log(
          `loop: ${boardId} ${card.id} eligibility unread (${describe(error)})`,
        );
        continue;
      }
      // The card itself cannot be claimed now, or it moved since the board was read.
      if (
        eligibility.reasons.length > 0 ||
        eligibility.stageKey !== card.stageKey
      )
        continue;

      const candidates: CandidateFacts[] = eligibility.agents.map((a) => {
        const entry =
          a.principalId === null
            ? undefined
            : rosterByPrincipal.get(a.principalId);
        const h = history.get(a.agentId);
        return {
          agentId: a.agentId,
          principalId: a.principalId,
          pipeline: { eligible: a.eligible, reasons: a.reasons },
          roster:
            entry === undefined
              ? null
              : {
                  stationId: entry.stationId,
                  enabled: entry.enabled,
                  ready: entry.ready,
                  busy: entry.busy,
                  lastDispatchedAtMs:
                    entry.lastDispatchedAt === null
                      ? null
                      : Date.parse(entry.lastDispatchedAt),
                },
          history: {
            settled: h?.settled ?? 0,
            claimed: h?.claimed ?? 0,
            noShowsAtMs: (noShows.get(a.agentId) ?? []).map((at) =>
              Date.parse(at),
            ),
          },
          holds: holds.get(a.agentId) ?? 0,
        };
      });

      const decision = place({
        card: { boardId, cardId: card.id, stageKey: card.stageKey },
        nowMs,
        candidates,
      });
      const id = deps.newId();
      store.recordDecision({
        id,
        boardId,
        cardId: card.id,
        stageKey: card.stageKey,
        policy: POLICY,
        chosenAgent: decision.kind === "placed" ? decision.chosen : null,
        noDecisionReason: decision.kind === "none" ? decision.reason : null,
        candidates: decision.candidates,
        attemptsBefore: card.attemptCount,
        createdAt: nowIso,
      });
      result.decided++;
      if (decision.kind !== "placed") {
        log(
          `loop: ${boardId} ${card.id} ${id} none (${decision.reason}) of ${decision.candidates.length}`,
        );
        continue;
      }
      if (await reserve(boardId, card.id, id, decision, nowIso)) {
        result.reserved++;
        holds.set(decision.chosen, (holds.get(decision.chosen) ?? 0) + 1);
      }
    }
    return result;
  }

  /** Ask SuperPipeline to hold the card for the winner, and record what it answered. */
  async function reserve(
    boardId: string,
    cardId: string,
    id: string,
    decision: Extract<Decision, { kind: "placed" }>,
    nowIso: string,
  ): Promise<boolean> {
    let answer;
    try {
      answer = await superpipeline.reserve(boardId, cardId, {
        agentId: decision.chosen,
        ttlSeconds: deps.reservationSeconds,
        decisionId: id,
      });
    } catch (error) {
      answer = {
        ok: false as const,
        status: 0,
        code: error instanceof SourceError ? error.code : "error",
      };
    }
    if (answer.ok) {
      store.setReservation(id, { reservedUntil: answer.reservedUntil }, nowIso);
      log(
        `loop: ${boardId} ${cardId} ${id} held for ${decision.chosen} until ${answer.reservedUntil}`,
      );
      return true;
    }
    store.setReservation(id, { refused: answer.code }, nowIso);
    log(
      `loop: ${boardId} ${cardId} ${id} chose ${decision.chosen}, hold refused (${answer.code})`,
    );
    return false;
  }

  return {
    passBoard,
    async passAll() {
      const boards = store.listBoards().filter((b) => b.enabled);
      let failedBoards = 0;
      for (const board of boards) {
        try {
          await passBoard(board.boardId);
        } catch (error) {
          failedBoards++;
          log(`loop: ${board.boardId} unread (${describe(error)})`);
        }
      }
      return { boards: boards.length, failedBoards };
    },
  };
}

/** An error as a log may show it: a source's product, status and code, never a request. */
function describe(error: unknown): string {
  return error instanceof SourceError
    ? `${error.product} ${error.status} ${error.code}`
    : error instanceof Error
      ? error.name
      : "error";
}

/** The most the interval is multiplied by while every board keeps failing. */
export const SWEEP_MAX_BACKOFF = 8;

/** How long a nudged board waits, so a burst of events is one pass. */
export const NUDGE_DELAY_MS = 2_000;

export interface Runner {
  /** Look at this board soon, beside the sweep: the relay said something happened on it. */
  nudge(boardId: string): void;
  stop(): void;
}

/**
 * Run the loop: one sweep of every board now, then one every interval, never two passes at once
 * (a nudge waits for a sweep, and a sweep for a nudge). A sweep in which every board failed waits
 * twice as long before the next, up to `SWEEP_MAX_BACKOFF` times the interval; a sweep that read
 * any board goes back to the interval. A nudge looks at its board after `NUDGE_DELAY_MS`.
 */
export function startRunner(
  loop: Loop,
  options: {
    intervalMs: number;
    log?: (line: string) => void;
    /** Test seams: how a later run is scheduled and cancelled. */
    schedule?: (run: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
  },
): Runner {
  const log = options.log ?? console.log;
  const schedule =
    options.schedule ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const cancel =
    options.cancel ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  let failing = 0;
  let stopped = false;
  let sweepHandle: unknown = null;
  let nudgeHandle: unknown = null;
  const nudged = new Set<string>();

  async function sweep(): Promise<void> {
    try {
      const r = await exclusive(() => loop.passAll());
      failing = r.boards > 0 && r.failedBoards === r.boards ? failing + 1 : 0;
    } catch (error) {
      failing++;
      log(`loop: sweep failed (${describe(error)})`);
    }
    if (stopped) return;
    const factor = Math.min(2 ** failing, SWEEP_MAX_BACKOFF);
    sweepHandle = schedule(() => void sweep(), options.intervalMs * factor);
  }

  async function drainNudges(): Promise<void> {
    nudgeHandle = null;
    const boards = [...nudged];
    nudged.clear();
    for (const boardId of boards) {
      if (stopped) return;
      await exclusive(() => loop.passBoard(boardId)).catch((error: unknown) =>
        log(`loop: ${boardId} unread (${describe(error)})`),
      );
    }
  }

  void sweep();
  return {
    nudge(boardId) {
      if (stopped) return;
      nudged.add(boardId);
      nudgeHandle ??= schedule(() => void drainNudges(), NUDGE_DELAY_MS);
    },
    stop() {
      stopped = true;
      if (sweepHandle !== null) cancel(sweepHandle);
      if (nudgeHandle !== null) cancel(nudgeHandle);
    },
  };
}
