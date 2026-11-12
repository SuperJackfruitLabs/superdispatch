/**
 * The dispatch policy, as the loop asks it: Accounts' answer for each candidate at a card's stage,
 * cached for one pass, with the policy's per-agent limits applied from what this service's store
 * remembers. Placement gets the verdict (`PolicyVerdict`) and its `policy` filter rejects on it.
 *
 * - **Off** (`SUPERDISPATCH_POLICY=off`, the default): nothing is asked, every verdict is unset,
 *   and the filter passes everyone, as before policy existed.
 * - **On:** one `POST /api/policy/decide` per agent, board stage, labels and capabilities in a
 *   pass, at most. A workspace with no policy answers `no-policy`, which allows.
 * - **Accounts could not answer** (unreachable, refused, malformed): when the last answer this
 *   service had said the workspace has no policy, the candidate passes; otherwise, a cold start
 *   included, it is rejected (`policy-unread`). Failing closed costs only the advice: a card nobody
 *   is held for is still claimed by pull.
 * - **Limits:** an allowed agent that already had `maxRuns` or more holds from this service within
 *   the last `windowHours` is rejected (`limit:<id>`). It counts holds this service made, so it
 *   bounds what is steered to the agent, not what the agent pulls.
 */
import type { PolicyVerdict } from "../placement/index.ts";
import type { Accounts, PolicyAnswer } from "../sources/index.ts";
import type { Store } from "../store/index.ts";

/** What is asked for one candidate at one card. */
export interface PolicyAsk {
  agentId: string;
  principalId: string | null;
  boardId: string;
  stageKey: string;
  cardId: string;
  labels: readonly string[];
  capabilities: readonly string[];
}

/** One pass's view of the policy: the verdict for a candidate, or undefined when it is off. */
export type PolicyPass = (ask: PolicyAsk) => Promise<PolicyVerdict | undefined>;

export interface PolicyGate {
  /** A new pass at `nowMs`, with its own cache of Accounts' answers. */
  pass(nowMs: number): PolicyPass;
}

const HOUR_MS = 60 * 60 * 1000;

/** The policy as the loop asks it; `accounts` null is policy off. */
export function createPolicyGate(deps: {
  accounts: Pick<Accounts, "decide"> | null;
  store: Pick<Store, "holdsMadeSince">;
  log: (line: string) => void;
}): PolicyGate {
  /** What the last answer said: the workspace has no policy, has one, or nothing was heard yet. */
  let lastKnown: "none" | "policy" | null = null;
  const accounts = deps.accounts;

  /** The verdict when Accounts could not be asked: open only when it last said there is no policy. */
  const unread = (): PolicyVerdict => ({
    allow: lastKnown === "none",
    reasons: ["policy-unread"],
    policyVersion: null,
  });

  return {
    pass(nowMs) {
      if (accounts === null) return () => Promise.resolve(undefined);
      const answers = new Map<string, Promise<PolicyAnswer | null>>();
      let logged = false;

      const answerFor = (ask: PolicyAsk & { principalId: string }) => {
        const key = [
          ask.principalId,
          ask.boardId,
          ask.stageKey,
          [...ask.labels].sort().join(","),
          [...ask.capabilities].sort().join(","),
        ].join("\u0000");
        let answer = answers.get(key);
        if (answer === undefined) {
          answer = accounts
            .decide({
              subject: ask.principalId,
              board: ask.boardId,
              stage: ask.stageKey,
              labels: ask.labels,
              capabilities: ask.capabilities,
              card: ask.cardId,
            })
            .then(
              (a) => {
                lastKnown = a.policyVersion === null ? "none" : "policy";
                return a;
              },
              (error: unknown) => {
                if (!logged) {
                  logged = true;
                  deps.log(
                    `loop: policy unread (${error instanceof Error ? error.message : "error"}); ${lastKnown === "none" ? "last known: no policy, passing" : "failing closed"}`,
                  );
                }
                return null;
              },
            );
          answers.set(key, answer);
        }
        return answer;
      };

      return async (ask) => {
        if (ask.principalId === null)
          return {
            allow: lastKnown === "none",
            reasons: ["no-principal"],
            policyVersion: null,
          };
        const answer = await answerFor({
          ...ask,
          principalId: ask.principalId,
        });
        if (answer === null) return unread();
        if (!answer.allow)
          return {
            allow: false,
            reasons: answer.reasons,
            policyVersion: answer.policyVersion,
          };
        const over = answer.limits
          .filter(
            (l) =>
              deps.store.holdsMadeSince(
                ask.agentId,
                new Date(nowMs - l.windowHours * HOUR_MS).toISOString(),
              ) >= l.maxRuns,
          )
          .map((l) => `limit:${l.id}`);
        return over.length > 0
          ? { allow: false, reasons: over, policyVersion: answer.policyVersion }
          : {
              allow: true,
              reasons: answer.reasons,
              policyVersion: answer.policyVersion,
            };
      };
    },
  };
}
