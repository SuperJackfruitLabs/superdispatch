import { describe, expect, test } from "bun:test";
import {
  SourceError,
  createAccounts,
  createAgentpod,
  createServiceTokens,
  createSuperpipeline,
  createSuperwitness,
  verdictMark,
  MAX_RUNS,
  PAGE_SIZE,
  type ServiceTokens,
} from "../src/sources/index.ts";
import { fakeFetch } from "./helpers.ts";

const CREDENTIAL = { id: "svc_0123456789abcdef0123", secret: "cred-secret" };
const BOARD = "brd_00000000000000b1";
const CARD = "card_00000000000000c1";

/** Tokens that count what was asked of them. */
function countingTokens(): ServiceTokens & {
  gets: number;
  invalidated: number;
} {
  const t = {
    gets: 0,
    invalidated: 0,
    get: async () => {
      t.gets++;
      return `token-${t.gets}`;
    },
    invalidate: () => {
      t.invalidated++;
    },
  };
  return t;
}

async function thrown(p: Promise<unknown>): Promise<SourceError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(SourceError);
    return error as SourceError;
  }
  throw new Error("did not throw");
}

describe("accounts", () => {
  test("asks for a service token for an audience with the credential, and reads it", async () => {
    const f = fakeFetch({
      "POST /api/token/service": {
        json: { access_token: "tok", expires_in: 300 },
      },
    });
    const accounts = createAccounts({
      url: "https://accounts.example/",
      credential: CREDENTIAL,
      fetch: f.fetch,
    });
    expect(await accounts.serviceToken("https://pipeline.example")).toEqual({
      accessToken: "tok",
      expiresIn: 300,
    });
    expect(f.seen).toEqual([
      {
        method: "POST",
        url: "https://accounts.example/api/token/service",
        authorization: "Bearer svc_0123456789abcdef0123:cred-secret",
        body: { audience: "https://pipeline.example" },
      },
    ]);
  });

  test("a refusal carries the plane's code; a malformed answer or no answer is an error that never quotes the credential", async () => {
    const refused = createAccounts({
      url: "https://accounts.example",
      credential: CREDENTIAL,
      fetch: fakeFetch({
        "POST /api/token/service": {
          status: 403,
          json: { error: "audience_not_allowed" },
        },
      }).fetch,
    });
    const e1 = await thrown(refused.serviceToken("x"));
    expect([e1.status, e1.code]).toEqual([403, "audience_not_allowed"]);
    const malformed = createAccounts({
      url: "https://accounts.example",
      credential: CREDENTIAL,
      fetch: fakeFetch({
        "POST /api/token/service": { json: { access_token: "" } },
      }).fetch,
    });
    expect((await thrown(malformed.serviceToken("x"))).code).toBe(
      "malformed_response",
    );
    const down = createAccounts({
      url: "https://accounts.example",
      credential: CREDENTIAL,
      fetch: fakeFetch({ "POST /api/token/service": "throw" }).fetch,
    });
    const e3 = await thrown(down.serviceToken("x"));
    expect([e3.status, e3.code]).toEqual([0, "unreachable"]);
    expect(e3.message).not.toContain(CREDENTIAL.secret);
    expect(String(e3.cause ?? "")).not.toContain(CREDENTIAL.secret);
  });

  test("a token is held until a minute before it expires, shared by callers at once, and dropped on invalidate", async () => {
    let now = 0;
    let asked = 0;
    const tokens = createServiceTokens({
      accounts: {
        serviceToken: async () => {
          asked++;
          return { accessToken: `t${asked}`, expiresIn: 300 };
        },
      },
      audience: "a",
      now: () => now,
    });
    expect(await Promise.all([tokens.get(), tokens.get()])).toEqual([
      "t1",
      "t1",
    ]);
    now = 239_000;
    expect(await tokens.get()).toBe("t1");
    now = 240_000;
    expect(await tokens.get()).toBe("t2");
    tokens.invalidate();
    expect(await tokens.get()).toBe("t3");
    expect(asked).toBe(3);
  });
});

const BOARD_JSON = {
  boardId: BOARD,
  stages: [
    { key: "build", ownerKind: "capability", owner: "code" },
    { key: "review", requires: { all: ["review"] } },
    { key: "approve", ownerKind: "human" },
    { name: "no key" },
  ],
  cards: [
    {
      id: CARD,
      currentStageKey: "build",
      state: "submitted",
      currentRunId: null,
      lastAgentId: "agt_a",
      attemptCount: 2,
      priority: 3,
      createdAt: "2026-11-12T10:00:00Z",
      archivedAt: null,
      reservation: {
        agentId: "agt_b",
        reservedUntil: "2026-11-12T10:01:00Z",
        decisionId: "pld_x",
      },
    },
    {
      id: "card_00000000000000c2",
      currentStageKey: "approve",
      state: "working",
      currentRunId: "run_1",
      archivedAt: "2026-11-12T09:00:00Z",
    },
    { title: "no id" },
  ],
};

describe("superpipeline", () => {
  const sp = (routes: Parameters<typeof fakeFetch>[0]) => {
    const f = fakeFetch(routes);
    const tokens = countingTokens();
    return {
      ...f,
      tokens,
      client: createSuperpipeline({
        baseUrl: "https://pipeline.example/",
        tokens,
        fetch: f.fetch,
      }),
    };
  };

  test("reads a board's stages and cards with this service's token, leaving out what it cannot read", async () => {
    const { client, seen } = sp({
      [`GET /v1/boards/${BOARD}`]: { json: BOARD_JSON },
    });
    expect(await client.board(BOARD)).toEqual({
      boardId: BOARD,
      stages: [
        {
          key: "build",
          ownerKind: "capability",
          hasRequires: false,
          requires: { all: ["code"], any: [] },
          placement: null,
        },
        {
          key: "review",
          ownerKind: null,
          hasRequires: true,
          requires: { all: ["review"], any: [] },
          placement: null,
        },
        {
          key: "approve",
          ownerKind: "human",
          hasRequires: false,
          requires: { all: [], any: [] },
          placement: null,
        },
      ],
      cards: [
        {
          id: CARD,
          stageKey: "build",
          state: "submitted",
          currentRunId: null,
          lastAgentId: "agt_a",
          attemptCount: 2,
          priority: 3,
          createdAt: "2026-11-12T10:00:00.000Z",
          archived: false,
          reservation: {
            agentId: "agt_b",
            reservedUntil: "2026-11-12T10:01:00.000Z",
          },
        },
        {
          id: "card_00000000000000c2",
          stageKey: "approve",
          state: "working",
          currentRunId: "run_1",
          lastAgentId: null,
          attemptCount: 0,
          priority: 0,
          createdAt: "",
          archived: true,
          reservation: null,
        },
      ],
    });
    expect(seen[0]).toMatchObject({
      method: "GET",
      url: `https://pipeline.example/v1/boards/${BOARD}`,
      authorization: "Bearer token-1",
    });
  });

  test("a 401 drops the held token and throws; a malformed board throws", async () => {
    const refused = sp({
      [`GET /v1/boards/${BOARD}`]: {
        status: 401,
        json: { error: { code: "UNAUTHORIZED" } },
      },
    });
    const e = await thrown(refused.client.board(BOARD));
    expect([e.status, e.code]).toEqual([401, "UNAUTHORIZED"]);
    expect(refused.tokens.invalidated).toBe(1);
    const forbidden = sp({
      [`GET /v1/boards/${BOARD}`]: {
        status: 403,
        json: { error: { code: "FORBIDDEN" } },
      },
    });
    await thrown(forbidden.client.board(BOARD));
    expect(forbidden.tokens.invalidated).toBe(0);
    const malformed = sp({
      [`GET /v1/boards/${BOARD}`]: { json: { cards: [] } },
    });
    expect((await thrown(malformed.client.board(BOARD))).code).toBe(
      "malformed_response",
    );
  });

  test("reads a card's eligibility: the card's reasons and every agent's", async () => {
    const { client } = sp({
      [`GET /v1/boards/${BOARD}/cards/${CARD}/eligibility`]: {
        json: {
          cardId: CARD,
          stageKey: "build",
          reasons: [],
          agents: [
            {
              agentId: "agt_a",
              name: "A",
              principalId: "prn_a",
              eligible: true,
              reasons: [],
            },
            {
              agentId: "agt_b",
              name: "B",
              principalId: null,
              eligible: false,
              reasons: ["grant_denied", 7],
            },
            { name: "no id" },
          ],
        },
      },
    });
    expect(await client.eligibility(BOARD, CARD)).toEqual({
      stageKey: "build",
      reasons: [],
      agents: [
        { agentId: "agt_a", principalId: "prn_a", eligible: true, reasons: [] },
        {
          agentId: "agt_b",
          principalId: null,
          eligible: false,
          reasons: ["grant_denied"],
        },
      ],
    });
  });

  test("reserves with the agent, the window and the decision, and reads the hold's end", async () => {
    const { client, seen } = sp({
      [`PUT /v1/boards/${BOARD}/cards/${CARD}/reservation`]: {
        json: {
          reservation: {
            agentId: "agt_a",
            reservedUntil: "2026-11-12T10:01:00Z",
            decisionId: "pld_1",
            reservedBy: "prn_svc",
          },
        },
      },
    });
    expect(
      await client.reserve(BOARD, CARD, {
        agentId: "agt_a",
        ttlSeconds: 60,
        decisionId: "pld_1",
      }),
    ).toEqual({
      ok: true,
      reservedUntil: "2026-11-12T10:01:00.000Z",
    });
    expect(seen[0]?.body).toEqual({
      agentId: "agt_a",
      ttlSeconds: 60,
      decisionId: "pld_1",
    });
  });

  test("a refused reservation is an answer, with SuperPipeline's code, or the status when it gave none", async () => {
    const hold = { agentId: "agt_a", ttlSeconds: 60, decisionId: "pld_1" };
    const refused = sp({
      [`PUT /v1/boards/${BOARD}/cards/${CARD}/reservation`]: {
        status: 409,
        json: {
          error: {
            code: "AGENT_NOT_ELIGIBLE",
            message: "…",
            detail: { reasons: ["grant_denied"] },
          },
        },
      },
    });
    expect(await refused.client.reserve(BOARD, CARD, hold)).toEqual({
      ok: false,
      status: 409,
      code: "AGENT_NOT_ELIGIBLE",
    });
    // A SuperPipeline with no reservation verb yet.
    const absent = sp({
      [`PUT /v1/boards/${BOARD}/cards/${CARD}/reservation`]: { status: 404 },
    });
    expect(await absent.client.reserve(BOARD, CARD, hold)).toEqual({
      ok: false,
      status: 404,
      code: "HTTP_404",
    });
  });

  test("clearing a hold takes 204, and 404 for a card that is gone", async () => {
    const { client, seen } = sp({
      [`DELETE /v1/boards/${BOARD}/cards/${CARD}/reservation`]: { status: 204 },
      [`DELETE /v1/boards/${BOARD}/cards/card_00000000000000ff/reservation`]: {
        status: 404,
      },
    });
    await client.clearReservation(BOARD, CARD);
    await client.clearReservation(BOARD, "card_00000000000000ff");
    expect(seen.map((s) => s.method)).toEqual(["DELETE", "DELETE"]);
  });
});

describe("agentpod", () => {
  test("reads a board's roster; an unknown readiness is not ready and an unknown load is busy", async () => {
    const f = fakeFetch({
      [`GET /api/bridge/boards/${BOARD}/roster`]: {
        json: {
          boardId: BOARD,
          agents: [
            {
              key: "a",
              stationId: "stn_a",
              principalId: "prn_a",
              enabled: true,
              ready: true,
              busy: false,
              lastDispatchedAt: "2026-11-12T09:00:00Z",
              reason: null,
            },
            {
              key: "b",
              stationId: "stn_b",
              principalId: "",
              enabled: "yes",
              ready: "yes",
            },
            { stationId: "no key" },
          ],
        },
      },
    });
    const tokens = countingTokens();
    const client = createAgentpod({
      baseUrl: "http://hub:3001",
      tokens,
      fetch: f.fetch,
    });
    expect(await client.roster(BOARD)).toEqual([
      {
        key: "a",
        stationId: "stn_a",
        principalId: "prn_a",
        enabled: true,
        ready: true,
        busy: false,
        lastDispatchedAt: "2026-11-12T09:00:00.000Z",
      },
      {
        key: "b",
        stationId: "stn_b",
        principalId: null,
        enabled: false,
        ready: false,
        busy: true,
        lastDispatchedAt: null,
      },
    ]);
    expect(f.seen[0]?.authorization).toBe("Bearer token-1");
  });

  test("a hub without the read, or one that refuses, throws; a 401 drops the token", async () => {
    const tokens = countingTokens();
    const old = createAgentpod({
      baseUrl: "http://hub:3001",
      tokens,
      fetch: fakeFetch({
        [`GET /api/bridge/boards/${BOARD}/roster`]: {
          status: 404,
          json: { error: "Not Found" },
        },
      }).fetch,
    });
    expect((await thrown(old.roster(BOARD))).status).toBe(404);
    const refused = createAgentpod({
      baseUrl: "http://hub:3001",
      tokens,
      fetch: fakeFetch({
        [`GET /api/bridge/boards/${BOARD}/roster`]: {
          status: 401,
          json: { error: "unauthorized" },
        },
      }).fetch,
    });
    expect((await thrown(refused.roster(BOARD))).code).toBe("unauthorized");
    expect(tokens.invalidated).toBe(1);
  });
});

describe("superwitness", () => {
  const SINCE = "2026-10-13T12:00:00.000Z";
  const P1 = "prn_00000000000000000001";
  const P2 = "prn_00000000000000000002";
  /** The path and query the client asks for one page. */
  const page = (cursor?: string) => {
    const q = new URLSearchParams({
      source: "superpipeline",
      scope: BOARD,
      stage_key: "build",
    });
    q.append("status", "succeeded");
    q.append("status", "failed");
    q.set("since", SINCE);
    q.set("limit", String(PAGE_SIZE));
    if (cursor !== undefined) q.set("cursor", cursor);
    return `GET /v1/runs?${q}`;
  };
  const run = (over: Record<string, unknown> = {}) => ({
    source: "superpipeline",
    external_ref: `${BOARD}/run_1`,
    scope: { id: BOARD, name: "B" },
    stage_key: "build",
    card_id: CARD,
    executor: { id: P1, name: "a" },
    status: "succeeded",
    started_at: "2026-11-12T09:00:00Z",
    ended_at: "2026-11-12T09:05:00Z",
    latest_verdict: null,
    ...over,
  });

  test("reads a stage's finished runs with this service's token, every page, keeping what it can join", async () => {
    const f = fakeFetch({
      [page()]: {
        json: {
          runs: [
            run({ latest_verdict: { value: { decision: "pass" } } }),
            run({
              executor: { id: P2, name: "b" },
              status: "failed",
              ended_at: null,
              latest_verdict: { value: { score: 0.25 } },
            }),
            // No executor id, another stage, a cancelled run, another board, no time: left out.
            run({ executor: { name: "anon" } }),
            run({ stage_key: "review" }),
            run({ status: "cancelled" }),
            run({ scope: { id: "brd_other" } }),
            run({ started_at: null, ended_at: null }),
          ],
          next_cursor: "c2",
        },
      },
      [page("c2")]: {
        json: {
          runs: [run({ latest_verdict: { value: { label: "meh" } } })],
          next_cursor: null,
        },
      },
    });
    const tokens = countingTokens();
    const client = createSuperwitness({
      baseUrl: "https://sw.example/",
      tokens,
      fetch: f.fetch,
    });
    expect(
      await client.stageRuns({
        boardId: BOARD,
        stageKey: "build",
        since: SINCE,
      }),
    ).toEqual([
      {
        executor: P1,
        succeeded: true,
        at: "2026-11-12T09:05:00.000Z",
        verdict: 1,
      },
      {
        executor: P2,
        succeeded: false,
        at: "2026-11-12T09:00:00.000Z",
        verdict: 0.25,
      },
      {
        executor: P1,
        succeeded: true,
        at: "2026-11-12T09:05:00.000Z",
        verdict: null,
      },
    ]);
    expect(f.seen.map((s) => s.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);
    expect(f.seen[0]?.url.startsWith("https://sw.example/v1/runs?")).toBe(true);
  });

  test(`stops at ${MAX_RUNS} runs, however many pages are left`, async () => {
    let pages = 0;
    const full = Array.from({ length: PAGE_SIZE }, () => run());
    const impl = (async () => {
      pages++;
      // Ten pages on offer, twice the cap, so a client that ignored the cap would read them all.
      return new Response(
        JSON.stringify({ runs: full, next_cursor: pages < 10 ? "more" : null }),
      );
    }) as unknown as typeof fetch;
    const client = createSuperwitness({
      baseUrl: "https://sw.example",
      tokens: countingTokens(),
      fetch: impl,
    });
    const got = await client.stageRuns({
      boardId: BOARD,
      stageKey: "build",
      since: SINCE,
    });
    expect(got.length).toBe(MAX_RUNS);
    expect(pages).toBe(Math.ceil(MAX_RUNS / PAGE_SIZE));
  });

  test("a refusal throws with SuperWitness's code, a 401 drops the token, a malformed body or no answer throws", async () => {
    const tokens = countingTokens();
    const refused = createSuperwitness({
      baseUrl: "https://sw.example",
      tokens,
      fetch: fakeFetch({
        [page()]: { status: 401, json: { error: { code: "unauthenticated" } } },
      }).fetch,
    });
    const q = { boardId: BOARD, stageKey: "build", since: SINCE };
    const e = await thrown(refused.stageRuns(q));
    expect([e.product, e.status, e.code]).toEqual([
      "superwitness",
      401,
      "unauthenticated",
    ]);
    expect(tokens.invalidated).toBe(1);
    const malformed = createSuperwitness({
      baseUrl: "https://sw.example",
      tokens: countingTokens(),
      fetch: fakeFetch({ [page()]: { json: { runs: "no" } } }).fetch,
    });
    expect((await thrown(malformed.stageRuns(q))).code).toBe(
      "malformed_response",
    );
    const down = createSuperwitness({
      baseUrl: "https://sw.example",
      tokens: countingTokens(),
      fetch: fakeFetch({ [page()]: "throw" }).fetch,
    });
    const d = await thrown(down.stageRuns(q));
    expect([d.status, d.code]).toEqual([0, "unreachable"]);
    expect(d.message).not.toContain("token");
  });

  test("a verdict's pass mark: a score as it stands, a pass or fail decision, nothing else", () => {
    const table: Array<[unknown, number | null]> = [
      [{ score: 0.7 }, 0.7],
      [{ score: 0 }, 0],
      [{ score: 1.5 }, null],
      [{ decision: "pass" }, 1],
      [{ decision: " Approve " }, 1],
      [{ decision: "accepted" }, 1],
      [{ decision: "fail" }, 0],
      [{ decision: "request_changes" }, 0],
      [{ decision: "reject" }, 0],
      [{ decision: "maybe" }, null],
      [{ label: "good" }, null],
      [{ text: "fine" }, null],
      [null, null],
    ];
    for (const [value, mark] of table) expect(verdictMark(value)).toBe(mark);
  });
});
