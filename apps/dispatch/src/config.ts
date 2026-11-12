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
 * How long SuperPipeline holds a card for the winner (the first tier) when
 * `SUPERDISPATCH_RESERVATION_SECONDS` is unset. SuperPipeline takes 10 to 300.
 */
export const DEFAULT_RESERVATION_SECONDS = 60;

/** How long each runner-up hold lasts when `SUPERDISPATCH_RUNNER_UP_SECONDS` is unset. */
export const DEFAULT_RUNNER_UP_SECONDS = 30;

/**
 * The most holds a card's ladder makes (the winner's, then runner-ups) before it is open to any
 * match, when `SUPERDISPATCH_TOP_K` is unset. 1 is winner, then any match.
 */
export const DEFAULT_TOP_K = 3;

/**
 * How a sweep orders cards across boards: `round-robin` (one card from each board a round, the
 * longest-waiting first) or `board-order` (every card of one board before the next).
 */
export const FAIRNESS = ["round-robin", "board-order"] as const;
export type Fairness = (typeof FAIRNESS)[number];
export const DEFAULT_FAIRNESS: Fairness = "round-robin";

/**
 * How often roster suggestions are computed, in seconds, when `SUPERDISPATCH_SUGGEST_EVERY_SECONDS`
 * is unset: 0 is on every sweep. They are read from the store alone, so a sweep's cost is one query.
 */
export const DEFAULT_SUGGEST_EVERY_SECONDS = 0;

/** How far back roster suggestions read decisions when `SUPERDISPATCH_SUGGEST_WINDOW_HOURS` is unset. */
export const DEFAULT_SUGGEST_WINDOW_HOURS = 24;

/**
 * How long a card waits with nobody eligible before its lane is suggested for (`stalled`), when
 * `SUPERDISPATCH_STALL_MINUTES` is unset.
 */
export const DEFAULT_STALL_MINUTES = 30;
/** How many days of a stage's runs are read from SuperWitness when `SUPERDISPATCH_HISTORY_DAYS` is unset. */
export const DEFAULT_HISTORY_DAYS = 30;

/** The fewest runs a stage rate is read from when `SUPERDISPATCH_HISTORY_MIN_SAMPLE` is unset. */
export const DEFAULT_HISTORY_MIN_SAMPLE = 3;

/** Days in which a run's weight halves when `SUPERDISPATCH_HISTORY_HALF_LIFE_DAYS` is unset. */
export const DEFAULT_HISTORY_HALF_LIFE_DAYS = 7;

/**
 * Who placement considers (`SUPERDISPATCH_CANDIDATES`): `roster`, the agents on AgentPod's roster
 * for the board (charter ruling 4, the first slice), or `all`, those and every agent that claims
 * with its own token once SuperPipeline reports its load and health. `roster` until the operator
 * says otherwise.
 */
export const CANDIDATE_SETS = ["roster", "all"] as const;
export type CandidateSet = (typeof CANDIDATE_SETS)[number];
export const DEFAULT_CANDIDATE_SET: CandidateSet = "roster";

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
  /**
   * SuperWitness's API URL, for each stage's history; null when unset, and then placement weighs
   * the board's own history only.
   */
  superwitnessUrl: string | null;
  /** The audience of this service's tokens for SuperWitness: its public URL. */
  superwitnessAudience: string | null;
  /** Days of a stage's runs read. */
  historyDays: number;
  /** The fewest runs a stage rate is read from; below it the rate is neutral. */
  historyMinSample: number;
  /** Days in which a run's weight halves. */
  historyHalfLifeDays: number;
  /** Seconds between two sweeps of every opted-in board. */
  sweepSeconds: number;
  /** Seconds SuperPipeline holds a card for the winner: the first tier. */
  reservationSeconds: number;
  /** Seconds each runner-up hold lasts. */
  runnerUpSeconds: number;
  /** The most holds a card's ladder makes before it is open to any match. */
  topK: number;
  /** How a sweep orders cards across boards. */
  fairness: Fairness;
  /** Who placement considers: the roster alone, or every agent that reports its load. */
  candidates: CandidateSet;
  /** Seconds between two computations of the roster suggestions; 0 is every sweep. */
  suggestEverySeconds: number;
  /** Hours of decisions the roster suggestions read. */
  suggestWindowHours: number;
  /** Minutes a card waits with nobody eligible before its lane is suggested for. */
  stallMinutes: number;
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
  const superwitnessUrl = env.SUPERWITNESS_URL?.trim() ?? "";
  const superwitnessAudience = env.SUPERWITNESS_AUDIENCE?.trim() ?? "";
  if (superwitnessAudience !== "" && superwitnessUrl === "")
    problems.push("SUPERWITNESS_AUDIENCE is set without SUPERWITNESS_URL");

  for (const [name, value] of [
    ["SUPERPIPELINE_URL", superpipelineUrl],
    ["ORG_PLANE_URL", orgPlaneUrl],
    ["AGENTPOD_URL", agentpodUrl],
    ["AGENTPOD_AUDIENCE", explicitAudience],
    ["SUPERWITNESS_URL", superwitnessUrl],
    ["SUPERWITNESS_AUDIENCE", superwitnessAudience],
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

  const runnerUpSeconds = wholeNumber(
    env,
    "SUPERDISPATCH_RUNNER_UP_SECONDS",
    DEFAULT_RUNNER_UP_SECONDS,
    10,
    300,
    problems,
  );
  const topK = wholeNumber(
    env,
    "SUPERDISPATCH_TOP_K",
    DEFAULT_TOP_K,
    1,
    10,
    problems,
  );
  const historyDays = wholeNumber(
    env,
    "SUPERDISPATCH_HISTORY_DAYS",
    DEFAULT_HISTORY_DAYS,
    1,
    365,
    problems,
  );
  const historyMinSample = wholeNumber(
    env,
    "SUPERDISPATCH_HISTORY_MIN_SAMPLE",
    DEFAULT_HISTORY_MIN_SAMPLE,
    1,
    100,
    problems,
  );
  const historyHalfLifeDays = wholeNumber(
    env,
    "SUPERDISPATCH_HISTORY_HALF_LIFE_DAYS",
    DEFAULT_HISTORY_HALF_LIFE_DAYS,
    1,
    365,
    problems,
  );
  let fairness = DEFAULT_FAIRNESS;
  const rawFairness = env.SUPERDISPATCH_FAIRNESS?.trim();
  if (rawFairness) {
    if ((FAIRNESS as readonly string[]).includes(rawFairness))
      fairness = rawFairness as Fairness;
    else
      problems.push(
        `SUPERDISPATCH_FAIRNESS is not one of ${FAIRNESS.join(", ")}`,
      );
  }

  let candidates = DEFAULT_CANDIDATE_SET;
  const rawCandidates = env.SUPERDISPATCH_CANDIDATES?.trim();
  if (rawCandidates) {
    if ((CANDIDATE_SETS as readonly string[]).includes(rawCandidates))
      candidates = rawCandidates as CandidateSet;
    else
      problems.push(
        `SUPERDISPATCH_CANDIDATES is not one of ${CANDIDATE_SETS.join(", ")}`,
      );
  }

  const suggestEverySeconds = wholeNumber(
    env,
    "SUPERDISPATCH_SUGGEST_EVERY_SECONDS",
    DEFAULT_SUGGEST_EVERY_SECONDS,
    0,
    86400,
    problems,
  );
  const suggestWindowHours = wholeNumber(
    env,
    "SUPERDISPATCH_SUGGEST_WINDOW_HOURS",
    DEFAULT_SUGGEST_WINDOW_HOURS,
    1,
    720,
    problems,
  );
  const stallMinutes = wholeNumber(
    env,
    "SUPERDISPATCH_STALL_MINUTES",
    DEFAULT_STALL_MINUTES,
    1,
    1440,
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
    superwitnessUrl: superwitnessUrl || null,
    superwitnessAudience: superwitnessUrl
      ? superwitnessAudience || superwitnessUrl
      : null,
    historyDays,
    historyMinSample,
    historyHalfLifeDays,
    sweepSeconds,
    reservationSeconds,
    runnerUpSeconds,
    topK,
    fairness,
    candidates,
    suggestEverySeconds,
    suggestWindowHours,
    stallMinutes,
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
