/**
 * The loop: what SuperDispatch does with each opted-in board, on every sweep and whenever the
 * event relay says something happened on the board.
 *
 * One pass, over every opted-in board (a sweep) or one board (a nudge):
 *
 * 1. **Read each board** from SuperPipeline: its stages and cards.
 * 2. **Settle what became of each card it holds** (`settle`): a card whose attempt count rose
 *    was claimed, by the chosen agent (`claimed`) or by somebody else (`claimed-by-other`); one
 *    that left its stage, its board or its waiting state without a claim was `superseded`; one
 *    still waiting after its hold lapsed is `expired`, the chosen agent's no-show. A card opened
 *    to any match is settled the same way, and never expires. Each settled decision is a labelled
 *    example: the candidates, their facts and scores, the tier, the choice, the outcome.
 * 3. **Queue each board's ready cards** (`readyCards`: waiting to be claimed, in a capability
 *    lane, no live hold), best first by priority then age, and read the board's roster from
 *    AgentPod once.
 * 4. **Place the cards, fairly across boards** (placement's `fairOrder`: one card from each board
 *    a round, the longest-waiting first), so a busy board does not take every free agent before a
 *    quiet board's card is looked at. For each: read its eligibility from SuperPipeline, add what
 *    the store remembers (history on this board, recent no-shows, live holds, the card's ladder)
 *    and, when SuperWitness is configured, each candidate's finished runs at the card's stage (read
 *    once a pass for each board stage), and let placement choose at the card's tier. SuperWitness
 *    absent or failing never stops a placement: the stage history is then left out and placement
 *    ranks on the board's own history, as it did before. Record the decision, then ask SuperPipeline to
 *    hold the card for the winner for the tier's window.
 *
 * **Tiers.** SuperPipeline's hold names one agent, so the relaxation is a sequence of holds the
 * loop makes, a ladder per card: the winner for the reservation window; when that lapses, on the
 * next pass, the best candidate not yet passed over for the runner-up window, and so on up to
 * `topK` holds; then the card is opened to any match, holds nothing, and pull decides. Each step
 * is its own decision, labelled with its tier and step. A ladder starts again when the card
 * reaches another stage, comes back after a claim, or was moved by a person.
 *
 * A card whose last decision chose nobody, or whose hold was refused, is not decided again for
 * `REDECIDE_AFTER_MS`, so a card nobody can take is not re-recorded every sweep. A card waiting
 * only on agents that hold other cards, or only on agents whose work in hand keeps them busy, is
 * not recorded at all: it is looked at again next pass, so it is placed as soon as one frees up.
 *
 * Nothing requires this loop. It never claims and never hands a card to anybody; it asks
 * SuperPipeline for holds that lapse on their own, each at most 300 s. If SuperDispatch stops,
 * every hold it made lapses and every card is claimed by pull as before; if SuperPipeline has no
 * reservation verb, the decision is recorded as `not-reserved` and nothing else changes.
 *
 * Publishing each decision as an event through treaty's relay (charter decision 6) is a later
 * slice: it needs a decision event in treaty's catalogue first. Until then the record is read on
 * the operator API (`GET /v1/decisions`).
 *
 * **Roster suggestions** (`refreshSuggestions`): after a sweep, when due, the decisions of the
 * window on the enabled boards go through placement's `suggest`, and the store's suggestions are
 * brought in line. Advice only (charter decision 8): it reads the store and writes the store, and
 * its deps hold no source, so it cannot reach another product. A person makes any roster change.
 * Publishing suggestions to chat is a later slice; until then they are read on the operator API
 * (`GET /v1/suggestions`).
 */
import type { Fairness } from "../config.ts";
import type {
  Outcome,
  Store,
  DecisionRow,
  SuggestionSync,
} from "../store/index.ts";
import {
  SourceError,
  type Superwitness,
  type Agentpod,
  type BoardView,
  type CardView,
  type RosterEntry,
  type Superpipeline,
} from "../sources/index.ts";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_STALL_AFTER_MS,
  DEFAULT_HISTORY,
  DEFAULT_TIERS,
  NO_SHOW_WINDOW_MS,
  POLICY,
  boardOrder,
  candidateRecords,
  fairOrder,
  place,
  suggest,
  type Capability,
  type CandidateFacts,
  type Decision,
  type HistorySettings,
  type Ladder,
  type StageRun,
  type TierSettings,
} from "../placement/index.ts";

/** How much of a stage's history is read when the loop is given none: 30 days. */
export const DEFAULT_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a card whose last decision chose nobody, or was refused a hold, waits to be decided again. */
export const REDECIDE_AFTER_MS = 5 * 60 * 1000;

/** The most cards one pass looks at on one board: the rest wait for the next pass. */
export const MAX_CARDS_PER_PASS = 20;

/** The most decisions one computation of the roster suggestions reads, newest first. */
export const MAX_SUGGESTION_DECISIONS = 5000;

/** When and over what the roster suggestions are computed. */
export interface SuggestionSettings {
  /** The least time between two computations; 0 computes after every sweep. */
  everyMs: number;
  /** How far back the decisions they read go. */
  windowMs: number;
  /** How long a card waits with nobody eligible before its lane is flagged. */
  stallAfterMs: number;
}

export const DEFAULT_SUGGESTIONS: SuggestionSettings = {
  everyMs: 0,
  windowMs: 24 * 3600 * 1000,
  stallAfterMs: DEFAULT_STALL_AFTER_MS,
};

/** A new suggestion id: `sug_` and 24 hex digits. */
export const newSuggestionId = () => `sug_${randomBytes(12).toString("hex")}`;

/**
 * Compute the roster suggestions from the store's decisions and bring the store's suggestions in
 * line. Its deps are the store alone: it reads no product and writes none, so it can propose a
 * roster change and never make one.
 */
export function refreshSuggestions(deps: {
  store: Pick<Store, "listBoards" | "decisionsSince" | "syncSuggestions">;
  nowMs: number;
  settings?: SuggestionSettings;
  newId?: () => string;
}): SuggestionSync {
  const settings = deps.settings ?? DEFAULT_SUGGESTIONS;
  const enabled = new Set(
    deps.store
      .listBoards()
      .filter((b) => b.enabled)
      .map((b) => b.boardId),
  );
  const rows = deps.store
    .decisionsSince(
      new Date(deps.nowMs - settings.windowMs).toISOString(),
      MAX_SUGGESTION_DECISIONS,
    )
    .filter((d) => enabled.has(d.boardId));
  const found = suggest({
    decisions: rows.map((d) => ({
      id: d.id,
      boardId: d.boardId,
      cardId: d.cardId,
      stageKey: d.stageKey,
      attemptsBefore: d.attemptsBefore,
      requires: capabilityOf(d.requires),
      noDecisionReason: d.noDecisionReason,
      candidates: candidateRecords(d.candidates),
      createdAtMs: Date.parse(d.createdAt),
    })),
    settings: { stallAfterMs: settings.stallAfterMs },
  });
  return deps.store.syncSuggestions(
    found.map(
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

export interface LoopDeps {
  store: Store;
  superpipeline: Superpipeline;
  agentpod: Agentpod;
  /** SuperWitness, for each stage's history; null or unset when it is not configured. */
  superwitness?: Superwitness | null;
  /** How far back a stage's history is read, and how it weighs. */
  history?: HistorySettings & { windowMs: number };
  /** How a card's ladder of holds relaxes; `DEFAULT_TIERS` when unset. */
  tiers?: TierSettings;
  /** How a sweep orders cards across boards; `round-robin` when unset. */
  fairness?: Fairness;
  /** When the roster suggestions are computed; `DEFAULT_SUGGESTIONS` when unset. */
  suggestions?: SuggestionSettings;
  /** A new suggestion id; `sug_` and random hex when unset. */
  newSuggestionId?: () => string;
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
  /** Cards left for a later pass because every free candidate holds another card. */
  deferred: number;
}

export interface PassResult {
  boards: number;
  failedBoards: number;
}

export interface Loop {
  /** One pass over one board. Throws when the board cannot be read. */
  passBoard(boardId: string): Promise<BoardPass>;
  /**
   * One pass over every enabled board; a board that fails is counted, not thrown. Then, when due,
   * the roster suggestions are computed.
   */
  passAll(): Promise<PassResult>;
  /** Compute the roster suggestions now, from the store alone. */
  suggest(): SuggestionSync;
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
 * What became of the card an open decision held, or opened to any match, as the board reads now;
 * null while it is still open (held and the hold not lapsed, or open to any match and unclaimed).
 */
export function outcomeOf(
  decision: DecisionRow,
  card: CardView | undefined,
  nowIso: string,
): { outcome: Outcome; by: string | null } | null {
  if (card === undefined || card.archived)
    return { outcome: "superseded", by: null };
  if (card.attemptCount > decision.attemptsBefore) {
    return decision.chosenAgent !== null &&
      card.lastAgentId === decision.chosenAgent
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
  // A card at another stage, or back after a claim, starts a new ladder.
  if (
    latest === null ||
    latest.stageKey !== card.stageKey ||
    latest.attemptsBefore !== card.attemptCount
  )
    return true;
  // Held and not settled, or open to any match: the hold, or pull, is the decision.
  if (
    latest.outcome === null &&
    (latest.reservedUntil !== null || latest.tier === "any-match")
  )
    return false;
  // A lapsed hold or a settled claim: the card is waiting again, so it is placed again.
  if (latest.outcome !== null && latest.outcome !== "not-reserved") return true;
  // Chose nobody, or was refused a hold: wait before asking again.
  return nowMs - Date.parse(latest.createdAt) >= REDECIDE_AFTER_MS;
}

/**
 * A card's ladder from its ladder decisions at this stage and attempt count, newest first: the
 * agents whose holds lapsed, back to the last time a person moved it (`superseded`).
 */
export function ladderOf(rows: readonly DecisionRow[]): Ladder {
  const passedOver: string[] = [];
  for (const row of rows) {
    if (row.outcome === "superseded") break;
    if (row.outcome === "expired" && row.chosenAgent !== null)
      passedOver.unshift(row.chosenAgent);
  }
  return { passedOver };
}

/** One board, read and settled, with its ready cards queued. */
interface Gathered {
  pass: BoardPass;
  cards: CardView[];
  rosterByPrincipal: Map<string, RosterEntry>;
  history: ReturnType<Store["boardHistory"]>;
  /** What each stage of the board asks for, by key. */
  requires: Map<string, Capability>;
}

export function createLoop(deps: LoopDeps): Loop {
  const log = deps.log ?? console.log;
  const { store, superpipeline, agentpod } = deps;
  const tiers = deps.tiers ?? DEFAULT_TIERS;
  const fairness = deps.fairness ?? "round-robin";
  const history = {
    windowMs: DEFAULT_HISTORY_WINDOW_MS,
    ...DEFAULT_HISTORY,
    ...deps.history,
  };

  /**
   * Each candidate's finished runs at one board stage, by principal; null when SuperWitness is not
   * configured or did not answer. Read once a pass for each board stage (`seen`).
   */
  function stageRunsOf(
    boardId: string,
    stageKey: string,
    nowMs: number,
    seen: Map<string, Promise<Map<string, StageRun[]> | null>>,
  ): Promise<Map<string, StageRun[]> | null> {
    const sw = deps.superwitness;
    if (sw === undefined || sw === null) return Promise.resolve(null);
    const key = `${boardId} ${stageKey}`;
    let read = seen.get(key);
    if (read === undefined) {
      read = sw
        .stageRuns({
          boardId,
          stageKey,
          since: new Date(nowMs - history.windowMs).toISOString(),
        })
        .then(
          (runs) => {
            const by = new Map<string, StageRun[]>();
            for (const run of runs) {
              const list = by.get(run.executor) ?? [];
              list.push({
                atMs: Date.parse(run.at),
                succeeded: run.succeeded,
                verdict: run.verdict,
              });
              by.set(run.executor, list);
            }
            return by;
          },
          (error: unknown) => {
            log(
              `loop: ${boardId} ${stageKey} stage history unread (${describe(error)}); placing on the board's own`,
            );
            return null;
          },
        );
      seen.set(key, read);
    }
    return read;
  }

  /** Read a board, settle what it held, queue its ready cards. Throws when the board is unread. */
  async function gather(boardId: string, nowMs: number): Promise<Gathered> {
    const pass: BoardPass = {
      boardId,
      settled: 0,
      decided: 0,
      reserved: 0,
      deferred: 0,
    };
    const board = await superpipeline.board(boardId);
    const nowIso = new Date(nowMs).toISOString();
    const gathered: Gathered = {
      pass,
      cards: [],
      rosterByPrincipal: new Map(),
      history: new Map(),
      requires: new Map(board.stages.map((st) => [st.key, st.requires])),
    };

    const cards = new Map(board.cards.map((c) => [c.id, c]));
    for (const open of store.openDecisions(boardId)) {
      const settled = outcomeOf(open, cards.get(open.cardId), nowIso);
      if (settled === null) continue;
      if (store.settle(open.id, settled.outcome, settled.by, nowIso)) {
        pass.settled++;
        log(
          `loop: ${boardId} ${open.cardId} ${open.id} settled ${settled.outcome}${settled.by ? ` by ${settled.by}` : ""}`,
        );
      }
    }

    const ready = readyCards(board, nowIso).filter((card) =>
      shouldDecide(store.latestDecision(boardId, card.id), card, nowMs),
    );
    if (ready.length === 0) return gathered;

    let roster: RosterEntry[];
    try {
      roster = await agentpod.roster(boardId);
    } catch (error) {
      log(
        `loop: ${boardId} roster unread (${describe(error)}); nothing placed`,
      );
      return gathered;
    }
    for (const entry of roster) {
      if (entry.principalId === null) continue;
      const known = gathered.rosterByPrincipal.get(entry.principalId);
      // An enabled row speaks for the agent over a disabled one.
      if (known === undefined || (!known.enabled && entry.enabled))
        gathered.rosterByPrincipal.set(entry.principalId, entry);
    }
    gathered.history = store.boardHistory(boardId);
    gathered.cards = ready.slice(0, MAX_CARDS_PER_PASS);
    return gathered;
  }

  /**
   * One pass over these boards: gather each, then place their cards in the fairness order, with
   * one view of the live holds shared by every board. A board that cannot be read goes to
   * `failed`, which may throw.
   */
  async function passBoards(
    boardIds: readonly string[],
    failed: (boardId: string, error: unknown) => void,
  ): Promise<BoardPass[]> {
    const nowMs = deps.now();
    const nowIso = new Date(nowMs).toISOString();
    const gathered: Gathered[] = [];
    for (const boardId of boardIds) {
      try {
        gathered.push(await gather(boardId, nowMs));
      } catch (error) {
        failed(boardId, error);
      }
    }
    const queues = gathered
      .filter((g) => g.cards.length > 0)
      .map((g) => ({ boardId: g.pass.boardId, items: g.cards, g }));
    if (queues.length === 0) return gathered.map((g) => g.pass);

    const noShows = store.noShowsSince(
      new Date(nowMs - NO_SHOW_WINDOW_MS).toISOString(),
    );
    const holds = store.liveHolds(nowIso);
    const byBoard = new Map(queues.map((q) => [q.boardId, q.g]));
    const order =
      fairness === "round-robin"
        ? fairOrder(queues, (card) => Date.parse(card.createdAt))
        : boardOrder(queues);
    const stages = new Map<string, Promise<Map<string, StageRun[]> | null>>();
    for (const { boardId, item: card } of order) {
      const g = byBoard.get(boardId) as Gathered;
      await placeCard(g, card, { nowMs, nowIso, noShows, holds, stages });
    }
    return gathered.map((g) => g.pass);
  }

  async function placeCard(
    g: Gathered,
    card: CardView,
    at: {
      nowMs: number;
      nowIso: string;
      noShows: Map<string, string[]>;
      holds: Map<string, number>;
      stages: Map<string, Promise<Map<string, StageRun[]> | null>>;
    },
  ): Promise<void> {
    const { boardId } = g.pass;
    let eligibility;
    try {
      eligibility = await superpipeline.eligibility(boardId, card.id);
    } catch (error) {
      log(
        `loop: ${boardId} ${card.id} eligibility unread (${describe(error)})`,
      );
      return;
    }
    // The card itself cannot be claimed now, or it moved since the board was read.
    if (
      eligibility.reasons.length > 0 ||
      eligibility.stageKey !== card.stageKey
    )
      return;

    const stageRuns = await stageRunsOf(
      boardId,
      card.stageKey,
      at.nowMs,
      at.stages,
    );
    const candidates: CandidateFacts[] = eligibility.agents.map((a) => {
      const entry =
        a.principalId === null
          ? undefined
          : g.rosterByPrincipal.get(a.principalId);
      const h = g.history.get(a.agentId);
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
          noShowsAtMs: (at.noShows.get(a.agentId) ?? []).map((t) =>
            Date.parse(t),
          ),
        },
        holds: at.holds.get(a.agentId) ?? 0,
        ...(stageRuns === null
          ? {}
          : {
              stageRuns:
                a.principalId === null
                  ? []
                  : (stageRuns.get(a.principalId) ?? []),
            }),
      };
    });

    const ladder = ladderOf(
      store.ladderDecisions(boardId, card.id, card.stageKey, card.attemptCount),
    );
    const decision = place({
      card: { boardId, cardId: card.id, stageKey: card.stageKey },
      nowMs: at.nowMs,
      candidates,
      ladder,
      tiers,
      history,
    });
    if (
      decision.kind === "none" &&
      (decision.reason === "waiting-on-holds" ||
        decision.reason === "waiting-on-load")
    ) {
      g.pass.deferred++;
      return;
    }
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
      tier: decision.tier.name,
      tierStep: decision.tier.step,
      requires: g.requires.get(card.stageKey) ?? null,
      createdAt: at.nowIso,
    });
    g.pass.decided++;
    if (decision.kind !== "placed") {
      log(
        `loop: ${boardId} ${card.id} ${id} none (${decision.reason}) of ${decision.candidates.length}, ${decision.tier.name} step ${decision.tier.step}`,
      );
      return;
    }
    if (await reserve(boardId, card.id, id, decision, at.nowIso)) {
      g.pass.reserved++;
      at.holds.set(decision.chosen, (at.holds.get(decision.chosen) ?? 0) + 1);
    }
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
        ttlSeconds: decision.tier.holdSeconds ?? tiers.winnerSeconds,
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
        `loop: ${boardId} ${cardId} ${id} held for ${decision.chosen} (${decision.tier.name} step ${decision.tier.step}) until ${answer.reservedUntil}`,
      );
      return true;
    }
    store.setReservation(id, { refused: answer.code }, nowIso);
    log(
      `loop: ${boardId} ${cardId} ${id} chose ${decision.chosen}, hold refused (${answer.code})`,
    );
    return false;
  }

  const suggestions = deps.suggestions ?? DEFAULT_SUGGESTIONS;
  let suggestedAtMs: number | null = null;
  function computeSuggestions(): SuggestionSync {
    const nowMs = deps.now();
    suggestedAtMs = nowMs;
    const sync = refreshSuggestions({
      store,
      nowMs,
      settings: suggestions,
      ...(deps.newSuggestionId ? { newId: deps.newSuggestionId } : {}),
    });
    if (sync.opened + sync.resolved > 0)
      log(
        `loop: suggestions ${sync.opened} opened, ${sync.updated} updated, ${sync.resolved} resolved`,
      );
    return sync;
  }

  return {
    suggest: computeSuggestions,
    async passBoard(boardId) {
      const [pass] = await passBoards([boardId], (_id, error) => {
        throw error;
      });
      return pass as BoardPass;
    },
    async passAll() {
      const boards = store.listBoards().filter((b) => b.enabled);
      let failedBoards = 0;
      await passBoards(
        boards.map((b) => b.boardId),
        (boardId, error) => {
          failedBoards++;
          log(`loop: ${boardId} unread (${describe(error)})`);
        },
      );
      if (
        suggestedAtMs === null ||
        deps.now() - suggestedAtMs >= suggestions.everyMs
      ) {
        try {
          computeSuggestions();
        } catch (error) {
          log(
            `loop: suggestions failed (${error instanceof Error ? error.name : "error"})`,
          );
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
