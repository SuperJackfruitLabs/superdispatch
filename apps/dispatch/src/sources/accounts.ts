/**
 * The organization plane (Accounts): this service's own token for each product it reads, from
 * its one service credential.
 *
 * `POST /api/token/service` with `{ audience }`, carrying the `svc_` credential as `Authorization:
 * Bearer <id>:<secret>`, answers `{ access_token, expires_in }`. One credential serves every
 * audience: SuperPipeline's URL for the board reads and the reservation, the hub's audience for
 * AgentPod's roster. Each token is held until shortly before it expires (`createServiceTokens`,
 * as SuperExchange holds its own) and never logged. The credential appears nowhere but that one
 * header: not in an error, not in a log.
 */
import type { ServiceCredential } from "../config.ts";
import { SourceError, call, field, okBody, type CallDeps } from "./http.ts";

export interface Accounts {
  /** This service's own token for `audience`. Throws `SourceError` when it cannot be had. */
  serviceToken(
    audience: string,
  ): Promise<{ accessToken: string; expiresIn: number }>;
}

export function createAccounts(
  deps: { url: string; credential: ServiceCredential } & Omit<
    CallDeps,
    "product"
  >,
): Accounts {
  const base = deps.url.replace(/\/+$/, "");
  const authorization = `Bearer ${deps.credential.id}:${deps.credential.secret}`;
  const http: CallDeps = { ...deps, product: "accounts" };
  return {
    async serviceToken(audience) {
      const answer = okBody(
        "accounts",
        await call(http, `${base}/api/token/service`, {
          method: "POST",
          authorization,
          body: { audience },
        }),
      );
      const accessToken = field(answer, "access_token");
      const expiresIn = field(answer, "expires_in");
      if (
        typeof accessToken !== "string" ||
        accessToken === "" ||
        typeof expiresIn !== "number" ||
        !Number.isFinite(expiresIn) ||
        expiresIn <= 0
      ) {
        throw new SourceError("accounts", 200, "malformed_response");
      }
      return { accessToken, expiresIn };
    },
  };
}

/** How long before its expiry a held service token is replaced. */
export const SERVICE_TOKEN_MARGIN_MS = 60_000;

/** This service's token for one audience, held until shortly before it expires. */
export interface ServiceTokens {
  /** The held token, or a new one when none is held or it is about to expire. */
  get(): Promise<string>;
  /** Drop the held token: the audience refused it, so the next `get` asks for a new one. */
  invalidate(): void;
}

/**
 * Hold this service's token for `audience` until `SERVICE_TOKEN_MARGIN_MS` before it expires (or
 * half its life, when that is shorter). Callers at the same moment share one request; a failed
 * request holds nothing, so the next call asks again.
 */
export function createServiceTokens(deps: {
  accounts: Accounts;
  audience: string;
  now?: () => number;
}): ServiceTokens {
  const now = deps.now ?? Date.now;
  let held: { token: string; renewAt: number } | null = null;
  let asking: Promise<string> | null = null;
  return {
    get() {
      if (held !== null && now() < held.renewAt) {
        return Promise.resolve(held.token);
      }
      asking ??= (async () => {
        try {
          const asked = now();
          const { accessToken, expiresIn } = await deps.accounts.serviceToken(
            deps.audience,
          );
          const lifeMs = expiresIn * 1000;
          held = {
            token: accessToken,
            renewAt:
              asked + lifeMs - Math.min(SERVICE_TOKEN_MARGIN_MS, lifeMs / 2),
          };
          return accessToken;
        } finally {
          asking = null;
        }
      })();
      return asking;
    },
    invalidate() {
      held = null;
    },
  };
}
