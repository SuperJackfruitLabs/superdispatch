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
 *
 * `POST /api/policy/decide` (scope `policy:decide`) with `{ subject, action: "take", resource:
 * { board, stage, labels, capabilities, card } }`, carrying the same credential, answers whether
 * the workspace's dispatch policy lets that agent take that work: `{ allow, reasons,
 * policyVersion, limits }`. `policyVersion` is null when the workspace has no policy, and then
 * the answer is always allow. A read: it decides nothing here, and changes nothing there.
 */
import type { ServiceCredential } from "../config.ts";
import { SourceError, call, field, okBody, type CallDeps } from "./http.ts";

/** What the policy is asked about: one agent taking work at one board stage. */
export interface PolicyRequest {
  /** The agent's principal (`prn_…`). */
  subject: string;
  board: string;
  stage: string;
  labels: readonly string[];
  capabilities: readonly string[];
  /** The card, for the decision record at Accounts only. */
  card: string;
}

/** A per-agent ceiling from the policy: at most `maxRuns` cards in any `windowHours`. */
export interface PolicyLimit {
  id: string;
  maxRuns: number;
  windowHours: number;
}

/** Accounts' answer for one agent and one piece of work. */
export interface PolicyAnswer {
  allow: boolean;
  reasons: string[];
  /** The policy version decided under; null when the workspace has no policy. */
  policyVersion: number | null;
  limits: PolicyLimit[];
}

export interface Accounts {
  /** This service's own token for `audience`. Throws `SourceError` when it cannot be had. */
  serviceToken(
    audience: string,
  ): Promise<{ accessToken: string; expiresIn: number }>;
  /** The dispatch policy's answer for one request. Throws `SourceError` when there is none. */
  decide(request: PolicyRequest): Promise<PolicyAnswer>;
}

const isWhole = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;

/** A limit as Accounts sends it, or null when it is not one. */
function limitOf(v: unknown): PolicyLimit | null {
  const id = field(v, "id");
  const maxRuns = field(v, "maxRuns");
  const windowHours = field(v, "windowHours");
  return typeof id === "string" && isWhole(maxRuns) && isWhole(windowHours)
    ? { id, maxRuns, windowHours }
    : null;
}

/** The policy's answer, or a `malformed_response` error: an answer that cannot be read allows nothing. */
function policyAnswerOf(json: unknown): PolicyAnswer {
  const allow = field(json, "allow");
  const reasons = field(json, "reasons");
  const version = field(json, "policyVersion");
  const limits = field(json, "limits");
  if (
    typeof allow !== "boolean" ||
    !Array.isArray(reasons) ||
    !reasons.every((r) => typeof r === "string") ||
    !(version === null || isWhole(version)) ||
    !Array.isArray(limits)
  ) {
    throw new SourceError("accounts", 200, "malformed_response");
  }
  const read = limits.map(limitOf);
  if (read.some((l) => l === null))
    throw new SourceError("accounts", 200, "malformed_response");
  return {
    allow,
    reasons: reasons.slice(0, 20).map((r) => r.slice(0, 64)),
    policyVersion: version,
    limits: read.filter((l) => l !== null),
  };
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
    async decide(request) {
      return policyAnswerOf(
        okBody(
          "accounts",
          await call(http, `${base}/api/policy/decide`, {
            method: "POST",
            authorization,
            body: {
              subject: request.subject,
              action: "take",
              resource: {
                board: request.board,
                stage: request.stage,
                labels: request.labels,
                capabilities: request.capabilities,
                card: request.card,
              },
            },
          }),
        ),
      );
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
  accounts: Pick<Accounts, "serviceToken">;
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
