import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store/index.ts";

/** A store in a fresh temporary directory, removed by `cleanup`. */
export function tempStore(): {
  dir: string;
  store: Store;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "superdispatch-test-"));
  const store = openStore(dir);
  return {
    dir,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const OPERATOR_TOKEN = "operator-token-for-tests";
export const OPERATOR_TOKEN_SHA256 = new Bun.CryptoHasher("sha256")
  .update(OPERATOR_TOKEN)
  .digest("hex");

/** A request a fake fetch saw. */
export interface Seen {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/**
 * A fetch that answers from a table keyed `METHOD path` (path with its query), and records every
 * request. A route it has no answer for is a 599, so a test notices an unexpected call. An answer
 * may be a function of the request, or `"throw"` for a network failure.
 */
export function fakeFetch(
  routes: Record<
    string,
    | { status?: number; json?: unknown }
    | "throw"
    | ((seen: Seen) => { status?: number; json?: unknown })
  >,
): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const request: Seen = {
      method,
      url: String(input),
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    seen.push(request);
    const route = routes[`${method} ${url.pathname}${url.search}`];
    if (route === "throw")
      throw new Error(
        `network down for ${String(input)} ${request.authorization}`,
      );
    const answer =
      typeof route === "function" ? route(request) : (route ?? { status: 599 });
    const status = answer.status ?? 200;
    return new Response(
      status === 204 || answer.json === undefined
        ? null
        : JSON.stringify(answer.json),
      { status },
    );
  };
  return { fetch: impl as unknown as typeof fetch, seen };
}
