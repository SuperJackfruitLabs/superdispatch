/**
 * The runner: when the loop runs. One sweep of every board now and then every interval, a nudged
 * board after a short delay, a ready card at once, and never two passes at the same time.
 */
import { describe } from "./describe.ts";
import type { Loop } from "./index.ts";

/** The most the interval is multiplied by while every board keeps failing. */
export const SWEEP_MAX_BACKOFF = 8;

/** How long a nudged board waits, so a burst of events is one pass. */
export const NUDGE_DELAY_MS = 2_000;

export interface Runner {
  /** Look at this board soon, beside the sweep: the relay said something happened on it. */
  nudge(boardId: string): void;
  /**
   * Place this card now, alone, beside the sweep: the relay said it became ready. Waits only for a
   * pass already under way; the same card asked for twice before it is placed is placed once.
   */
  cardReady(boardId: string, cardId: string): void;
  /** The board was opted in or out: bring its placement window in line, now. */
  boardChanged(boardId: string): void;
  stop(): void;
}

/**
 * Run the loop: one sweep of every board now, then one every interval, never two passes at once
 * (a nudge waits for a sweep, and a sweep for a nudge). A sweep in which every board failed waits
 * twice as long before the next, up to `SWEEP_MAX_BACKOFF` times the interval; a sweep that read
 * any board goes back to the interval. A nudge looks at its board after `NUDGE_DELAY_MS`; a ready
 * card is placed at once.
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

  const pendingCards = new Set<string>();

  void sweep();
  return {
    nudge(boardId) {
      if (stopped) return;
      nudged.add(boardId);
      nudgeHandle ??= schedule(() => void drainNudges(), NUDGE_DELAY_MS);
    },
    cardReady(boardId, cardId) {
      if (stopped) return;
      const key = `${boardId} ${cardId}`;
      if (pendingCards.has(key)) return;
      pendingCards.add(key);
      void exclusive(() => {
        pendingCards.delete(key);
        return stopped ? Promise.resolve(null) : loop.passCard(boardId, cardId);
      }).catch((error: unknown) =>
        log(`loop: ${boardId} ${cardId} unread (${describe(error)})`),
      );
    },
    boardChanged(boardId) {
      if (stopped) return;
      void exclusive(() => loop.syncWindow(boardId));
    },
    stop() {
      stopped = true;
      if (sweepHandle !== null) cancel(sweepHandle);
      if (nudgeHandle !== null) cancel(nudgeHandle);
    },
  };
}
