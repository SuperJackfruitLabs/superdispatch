/**
 * One JSON call to another product, as every source makes it: a bearer, a timeout, the body read
 * as JSON when it is JSON. A network failure or a timeout is `SourceError(product, 0,
 * "unreachable")` with the cause dropped, because a fetch error can quote its request, and the
 * request carries a token.
 */

export class SourceError extends Error {
  constructor(
    /** Which product answered: `superpipeline`, `agentpod` or `accounts`. */
    readonly product: string,
    /** The HTTP status; 0 when nothing answered. */
    readonly status: number,
    /** The product's error code when it gave one, else a short code of ours. */
    readonly code: string,
  ) {
    super(`${product} answered ${status === 0 ? "nothing" : status} (${code})`);
    this.name = "SourceError";
  }
}

export interface Answer {
  status: number;
  json: unknown;
}

export interface CallDeps {
  product: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Make one call. Never throws for a status; throws `SourceError(…, 0, "unreachable")` for none. */
export async function call(
  deps: CallDeps,
  url: string,
  init: { method: string; authorization: string; body?: unknown },
): Promise<Answer> {
  const doFetch = deps.fetch ?? fetch;
  let response: Response;
  let text: string;
  try {
    response = await doFetch(url, {
      method: init.method,
      headers: {
        authorization: init.authorization,
        accept: "application/json",
        ...(init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    text = await response.text();
  } catch {
    // Not chained: the cause can quote the request, and the request carries a token.
    throw new SourceError(deps.product, 0, "unreachable");
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/** A field of a JSON value, or undefined when it is not an object or lacks it. */
export function field(json: unknown, key: string): unknown {
  return typeof json === "object" && json !== null && key in json
    ? (json as Record<string, unknown>)[key]
    : undefined;
}

/** The error code a product put in its body: `{error: {code}}`, `{error: "code"}`, or none. */
export function errorCode(json: unknown): string | null {
  const error = field(json, "error");
  if (typeof error === "string") return error.slice(0, 64);
  const code = field(error, "code");
  return typeof code === "string" ? code.slice(0, 64) : null;
}

/** The body of a 2xx answer, or a `SourceError` with the product's code. */
export function okBody(product: string, answer: Answer): unknown {
  if (answer.status >= 200 && answer.status < 300) return answer.json;
  throw new SourceError(
    product,
    answer.status,
    errorCode(answer.json) ?? "error",
  );
}

/** An ISO time in one form (`toISOString`), so stored times compare as strings; null if not one. */
export function isoTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export const enc = encodeURIComponent;
