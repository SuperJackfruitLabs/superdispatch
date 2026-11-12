/**
 * The service's settings, read once at boot, and how a presented secret is checked against one.
 * A missing or malformed setting stops the service before it listens, and the error names the
 * setting, never its value.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** Settings that have no default. */
export const REQUIRED = [
  /**
   * Where SuperPipeline's API answers: the ready cards, and the eligibility read for each. Also
   * the audience of every assertion asked for it.
   */
  "SUPERPIPELINE_URL",
  /** Where the organization plane (Accounts) answers: this service's own tokens. */
  "ORG_PLANE_URL",
  /**
   * This service's own credential at the organization plane, `svc_<20 hex>:<secret>`. Sent only
   * to the plane, as a bearer; never logged.
   */
  "ORG_PLANE_SERVICE_CREDENTIAL",
  /** Where AgentPod's API answers: the roster, and each agent's load and health. */
  "AGENTPOD_URL",
  /** The secret the event relay signs its deliveries with (treaty's `verifyDelivery`). */
  "TREATY_RELAY_DELIVERY_SECRET",
  /**
   * The SHA-256 of the operator's bearer token for the operator API, as 64 hex digits. The token
   * itself is never given to the service, so a leaked environment does not leak it.
   */
  "SUPERDISPATCH_OPERATOR_TOKEN_SHA256",
] as const;

/** Where the store keeps its database when `SUPERDISPATCH_DATA_DIR` is unset. */
export const DEFAULT_DATA_DIR = "/data";

/** Where the service listens when `PORT` is unset. */
export const DEFAULT_PORT = 8796;

/** How often every opted-in board is looked at when `SUPERDISPATCH_SWEEP_SECONDS` is unset. */
export const DEFAULT_SWEEP_SECONDS = 30;

/**
 * How long SuperPipeline holds a card for the chosen agent when
 * `SUPERDISPATCH_RESERVATION_SECONDS` is unset. SuperPipeline takes 10 to 300.
 */
export const DEFAULT_RESERVATION_SECONDS = 60;

export interface Config {
  port: number;
  /** SuperPipeline's API URL, and the audience of every assertion asked for it. */
  superpipelineUrl: string;
  /** The organization plane's URL. */
  orgPlaneUrl: string;
  /** This service's credential at the organization plane. */
  orgPlaneCredential: ServiceCredential;
  /** AgentPod's API URL. */
  agentpodUrl: string;
  /**
   * The audience of this service's tokens for AgentPod: the hub's own `ORG_PLANE_AUDIENCE`, which
   * is its public URL and can differ from the address this service reaches it at.
   */
  agentpodAudience: string;
  relayDeliverySecret: string;
  /** Seconds between two sweeps of every opted-in board. */
  sweepSeconds: number;
  /** Seconds SuperPipeline holds a card for the chosen agent. */
  reservationSeconds: number;
  /** The directory the store keeps its database in; absolute. */
  dataDir: string;
  /** The SHA-256 of the operator's bearer token, 64 lowercase hex digits. */
  operatorTokenSha256: string;
}

/** A service principal's credential: its id and its secret. */
export interface ServiceCredential {
  id: string;
  secret: string;
}

/** The shape of a service credential: `svc_` and 20 hex digits, a colon, then the secret. */
const SERVICE_CREDENTIAL = /^(svc_[0-9a-f]{20}):(\S+)$/;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`superdispatch cannot start: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

/** Read and check the settings; throws a ConfigError listing every problem at once. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];
  const read = (name: (typeof REQUIRED)[number]): string => {
    const value = env[name]?.trim() ?? "";
    if (value === "") problems.push(`${name} is not set`);
    return value;
  };

  const superpipelineUrl = read("SUPERPIPELINE_URL");
  const orgPlaneUrl = read("ORG_PLANE_URL");
  const rawCredential = read("ORG_PLANE_SERVICE_CREDENTIAL");
  const agentpodUrl = read("AGENTPOD_URL");
  const relayDeliverySecret = read("TREATY_RELAY_DELIVERY_SECRET");
  const operatorTokenSha256 = read(
    "SUPERDISPATCH_OPERATOR_TOKEN_SHA256",
  ).toLowerCase();

  const explicitAudience = env.AGENTPOD_AUDIENCE?.trim() ?? "";
  const agentpodAudience = explicitAudience || agentpodUrl;

  for (const [name, value] of [
    ["SUPERPIPELINE_URL", superpipelineUrl],
    ["ORG_PLANE_URL", orgPlaneUrl],
    ["AGENTPOD_URL", agentpodUrl],
    ["AGENTPOD_AUDIENCE", explicitAudience],
  ] as const) {
    if (value !== "" && !isHttpUrl(value)) {
      problems.push(`${name} is not an http(s) URL`);
    }
  }

  const credential = SERVICE_CREDENTIAL.exec(rawCredential);
  if (rawCredential !== "" && credential === null) {
    problems.push(
      "ORG_PLANE_SERVICE_CREDENTIAL is not svc_<20 hex digits>:<secret>",
    );
  }

  if (
    operatorTokenSha256 !== "" &&
    !/^[0-9a-f]{64}$/.test(operatorTokenSha256)
  ) {
    problems.push(
      "SUPERDISPATCH_OPERATOR_TOKEN_SHA256 is not 64 hex digits (a SHA-256)",
    );
  }

  const dataDir = env.SUPERDISPATCH_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
  if (!dataDir.startsWith("/")) {
    problems.push("SUPERDISPATCH_DATA_DIR is not an absolute path");
  }

  let port = DEFAULT_PORT;
  const rawPort = env.PORT?.trim();
  if (rawPort) {
    port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push("PORT is not a port number");
    }
  }

  const sweepSeconds = wholeNumber(
    env,
    "SUPERDISPATCH_SWEEP_SECONDS",
    DEFAULT_SWEEP_SECONDS,
    5,
    3600,
    problems,
  );
  const reservationSeconds = wholeNumber(
    env,
    "SUPERDISPATCH_RESERVATION_SECONDS",
    DEFAULT_RESERVATION_SECONDS,
    10,
    300,
    problems,
  );

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    port,
    superpipelineUrl,
    orgPlaneUrl,
    orgPlaneCredential: {
      id: credential?.[1] ?? "",
      secret: credential?.[2] ?? "",
    },
    agentpodUrl,
    agentpodAudience,
    relayDeliverySecret,
    sweepSeconds,
    reservationSeconds,
    dataDir,
    operatorTokenSha256,
  };
}

/** An optional whole-number setting within [min, max], or its default when unset. */
function wholeNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} is not a whole number from ${min} to ${max}`);
    return fallback;
  }
  return value;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      (u.protocol === "https:" || u.protocol === "http:") && u.hostname !== ""
    );
  } catch {
    return false;
  }
}

/**
 * Does a presented secret equal the expected one? In constant time: both sides are hashed first,
 * so neither the content nor the length of a wrong guess changes how long the answer takes. An
 * empty expected secret matches nothing.
 */
export function secretMatches(expected: string, presented: string): boolean {
  if (expected === "") return false;
  return timingSafeEqual(sha256(expected), sha256(presented));
}

/**
 * Does a presented token hash to the expected SHA-256 (64 hex digits)? In constant time. A
 * malformed expected hash matches nothing.
 */
export function tokenMatchesSha256(
  expectedHex: string,
  presented: string,
): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(expectedHex)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), sha256(presented));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
