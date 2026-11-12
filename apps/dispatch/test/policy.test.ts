import { describe, expect, test } from "bun:test";
import { createPolicyGate, type PolicyAsk } from "../src/loop/policy.ts";
import {
  SourceError,
  type PolicyAnswer,
  type PolicyRequest,
} from "../src/sources/index.ts";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const HOUR = 3600_000;

const ask = (over: Partial<PolicyAsk> = {}): PolicyAsk => ({
  agentId: "agt_a",
  principalId: "prn_a",
  boardId: "brd_1",
  stageKey: "build",
  cardId: "card_1",
  labels: [],
  capabilities: ["code"],
  ...over,
});

const answer = (over: Partial<PolicyAnswer> = {}): PolicyAnswer => ({
  allow: true,
  reasons: ["allowed"],
  policyVersion: 1,
  limits: [],
  ...over,
});

/** A gate over a scripted Accounts, counting what it was asked; holds made, per agent, since a time. */
function gate(
  decide: (r: PolicyRequest) => PolicyAnswer | "throw",
  holdsSince: (agentId: string, since: string) => number = () => 0,
) {
  const asked: PolicyRequest[] = [];
  const log: string[] = [];
  const g = createPolicyGate({
    accounts: {
      decide: async (r) => {
        asked.push(r);
        const a = decide(r);
        if (a === "throw") throw new SourceError("accounts", 0, "unreachable");
        return a;
      },
    },
    store: { holdsMadeSince: holdsSince },
    log: (l) => log.push(l),
  });
  return { g, asked, log };
}

describe("the policy gate", () => {
  test("off: nothing is asked and there is no verdict", async () => {
    const off = createPolicyGate({
      accounts: null,
      store: { holdsMadeSince: () => 0 },
      log: () => {},
    });
    expect(await off.pass(NOW)(ask())).toBeUndefined();
  });

  test("one question per agent, board stage, labels and capabilities in a pass; a new pass asks again", async () => {
    const { g, asked } = gate(() => answer());
    const pass = g.pass(NOW);
    await Promise.all([
      pass(ask()),
      pass(ask({ cardId: "card_2", capabilities: ["code"] })),
      pass(ask({ stageKey: "review" })),
      pass(ask({ agentId: "agt_b", principalId: "prn_b" })),
    ]);
    expect(asked.map((r) => `${r.subject} ${r.stage}`).sort()).toEqual([
      "prn_a build",
      "prn_a review",
      "prn_b build",
    ]);
    await g.pass(NOW)(ask());
    expect(asked).toHaveLength(4);
  });

  test("Accounts' allow and deny are the verdict, with its reasons and version", async () => {
    const { g } = gate((r) =>
      r.subject === "prn_b"
        ? answer({
            allow: false,
            reasons: ["reviewers-only"],
            policyVersion: 7,
          })
        : answer({ reasons: ["no-policy"], policyVersion: null }),
    );
    const pass = g.pass(NOW);
    expect(await pass(ask())).toEqual({
      allow: true,
      reasons: ["no-policy"],
      policyVersion: null,
    });
    expect(await pass(ask({ agentId: "agt_b", principalId: "prn_b" }))).toEqual(
      { allow: false, reasons: ["reviewers-only"], policyVersion: 7 },
    );
  });

  test("a limit rejects an agent with maxRuns holds or more in its window, counted from now", async () => {
    const since: string[] = [];
    const { g } = gate(
      () =>
        answer({
          limits: [
            { id: "hourly", maxRuns: 2, windowHours: 1 },
            { id: "daily", maxRuns: 10, windowHours: 24 },
          ],
        }),
      (agentId, s) => {
        since.push(s);
        return agentId === "agt_a" ? 2 : 1;
      },
    );
    const pass = g.pass(NOW);
    expect(await pass(ask())).toEqual({
      allow: false,
      reasons: ["limit:hourly"],
      policyVersion: 1,
    });
    expect(await pass(ask({ agentId: "agt_b", principalId: "prn_b" }))).toEqual(
      { allow: true, reasons: ["allowed"], policyVersion: 1 },
    );
    expect(since).toContain(new Date(NOW - HOUR).toISOString());
    expect(since).toContain(new Date(NOW - 24 * HOUR).toISOString());
  });

  test("unanswered: closed on a cold start and after a policy was seen; open only after Accounts said there is none", async () => {
    let mode: "down" | "none" | "policy" = "down";
    const { g, log } = gate(() =>
      mode === "down"
        ? "throw"
        : mode === "none"
          ? answer({ reasons: ["no-policy"], policyVersion: null })
          : answer({ policyVersion: 2 }),
    );
    const closed = {
      allow: false,
      reasons: ["policy-unread"],
      policyVersion: null,
    };
    expect(await g.pass(NOW)(ask())).toEqual(closed);
    expect(log.some((l) => l.includes("failing closed"))).toBe(true);
    mode = "none";
    await g.pass(NOW)(ask());
    mode = "down";
    expect(await g.pass(NOW)(ask())).toEqual({ ...closed, allow: true });
    mode = "policy";
    await g.pass(NOW)(ask());
    mode = "down";
    expect(await g.pass(NOW)(ask())).toEqual(closed);
    expect(log.every((l) => !l.includes("cred-secret"))).toBe(true);
  });

  test("an agent with no principal cannot be asked about: closed unless there is known to be no policy", async () => {
    const { g, asked } = gate(() =>
      answer({ reasons: ["no-policy"], policyVersion: null }),
    );
    expect(await g.pass(NOW)(ask({ principalId: null }))).toEqual({
      allow: false,
      reasons: ["no-principal"],
      policyVersion: null,
    });
    expect(asked).toEqual([]);
    await g.pass(NOW)(ask());
    expect((await g.pass(NOW)(ask({ principalId: null })))?.allow).toBe(true);
  });
});
