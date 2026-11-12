import { describe, expect, test } from "bun:test";
import {
  SourceError,
  createAccounts,
  createAgentpod,
  createServiceTokens,
  createSuperpipeline,
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
        },
        {
          key: "review",
          ownerKind: null,
          hasRequires: true,
          requires: { all: ["review"], any: [] },
        },
        {
          key: "approve",
          ownerKind: "human",
          hasRequires: false,
          requires: { all: [], any: [] },
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
