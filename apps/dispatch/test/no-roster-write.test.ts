import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAccounts,
  createAgentpod,
  createSuperpipeline,
  type ServiceTokens,
} from "../src/sources/index.ts";

/**
 * Charter decision 8: SuperDispatch may propose a roster change, and a person makes it. These
 * tests hold that no client of another product can edit a roster: each client's methods are the
 * known reads (and SuperPipeline's reservation), every one of them is called, and every request
 * it makes is looked at. A new method, or a write to a roster path, fails them.
 */

const tokens: ServiceTokens = {
  get: async () => "token",
  invalidate: () => {},
};

/** Call every method a client has, with plausible arguments, and record what it asked for. */
async function everyRequest(
  make: (fetch: typeof globalThis.fetch) => object,
): Promise<{ methods: string[]; requests: string[] }> {
  const requests: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(
      `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`,
    );
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const client = make(fetch) as Record<string, unknown>;
  const methods = Object.keys(client).sort();
  for (const name of methods) {
    const method = client[name];
    if (typeof method !== "function") continue;
    try {
      await method.call(
        client,
        "brd_00000000000000b1",
        "card_00000000000000c1",
        {
          agentId: "agt_a",
          ttlSeconds: 10,
          decisionId: "pld_000000000000000000000001",
        },
      );
    } catch {
      // A read of `{}` is malformed and throws; what it asked for is recorded all the same.
    }
  }
  return { methods, requests };
}

const ROSTER_PATH = /roster|bridge|member|agents|stations/i;

describe("no client can edit a roster", () => {
  test("AgentPod's client reads the roster and the capability registry, and does nothing else", async () => {
    const { methods, requests } = await everyRequest((fetch) =>
      createAgentpod({ baseUrl: "https://hub.example", tokens, fetch }),
    );
    expect(methods).toEqual(["roster", "stationCapabilities"]);
    expect(requests).toEqual([
      "GET /api/bridge/boards/brd_00000000000000b1/roster",
      "GET /api/catalog/stations",
    ]);
  });

  test("SuperPipeline's client reads, and writes only the reservation it holds and lets lapse", async () => {
    const { methods, requests } = await everyRequest((fetch) =>
      createSuperpipeline({
        baseUrl: "https://pipeline.example",
        tokens,
        fetch,
      }),
    );
    expect(methods).toEqual([
      "agentLoad",
      "board",
      "clearReservation",
      "eligibility",
      "reserve",
    ]);
    const writes = requests.filter((r) => !r.startsWith("GET "));
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w).toMatch(/\/reservation$/);
  });

  test("Accounts' client asks for this service's token, and nothing else", async () => {
    const { methods, requests } = await everyRequest((fetch) =>
      createAccounts({
        url: "https://accounts.example",
        credential: { id: "svc_0123456789abcdef0123", secret: "s" },
        fetch,
      }),
    );
    expect(methods).toEqual(["serviceToken"]);
    expect(requests).toEqual(["POST /api/token/service"]);
  });

  test("no request any client makes writes to a roster path", async () => {
    const all = [
      ...(
        await everyRequest((fetch) =>
          createAgentpod({ baseUrl: "https://hub.example", tokens, fetch }),
        )
      ).requests,
      ...(
        await everyRequest((fetch) =>
          createSuperpipeline({
            baseUrl: "https://pipeline.example",
            tokens,
            fetch,
          }),
        )
      ).requests,
    ];
    expect(
      all.filter((r) => !r.startsWith("GET ") && ROSTER_PATH.test(r)),
    ).toEqual([]);
  });

  test("AgentPod's client names no method but GET", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "src", "sources", "agentpod.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/["'](POST|PUT|PATCH|DELETE)["']/);
  });
});
