import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  REQUIRED,
  loadConfig,
  secretMatches,
  tokenMatchesSha256,
} from "../src/config.ts";
import { OPERATOR_TOKEN, OPERATOR_TOKEN_SHA256 } from "./helpers.ts";

const FULL = {
  SUPERPIPELINE_URL: "https://pipeline.example",
  ORG_PLANE_URL: "https://accounts.example",
  ORG_PLANE_SERVICE_CREDENTIAL: "svc_0123456789abcdef0123:credential-secret",
  AGENTPOD_URL: "https://hub.example",
  TREATY_RELAY_DELIVERY_SECRET: "relay-secret-for-tests",
  SUPERDISPATCH_OPERATOR_TOKEN_SHA256: OPERATOR_TOKEN_SHA256,
};

function problems(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe("loadConfig", () => {
  test("reads a complete set, with the default port and data directory", () => {
    expect(loadConfig(FULL)).toEqual({
      port: 8796,
      superpipelineUrl: "https://pipeline.example",
      orgPlaneUrl: "https://accounts.example",
      orgPlaneCredential: {
        id: "svc_0123456789abcdef0123",
        secret: "credential-secret",
      },
      agentpodUrl: "https://hub.example",
      agentpodAudience: "https://hub.example",
      relayDeliverySecret: "relay-secret-for-tests",
      sweepSeconds: 30,
      reservationSeconds: 60,
      runnerUpSeconds: 30,
      topK: 3,
      fairness: "round-robin",
      suggestEverySeconds: 0,
      suggestWindowHours: 24,
      stallMinutes: 30,
      dataDir: "/data",
      operatorTokenSha256: OPERATOR_TOKEN_SHA256,
    });
  });

  test("names every missing setting at once", () => {
    expect(problems({})).toEqual(REQUIRED.map((name) => `${name} is not set`));
  });

  test("a blank setting is a missing one", () => {
    expect(problems({ ...FULL, AGENTPOD_URL: "  " })).toEqual([
      "AGENTPOD_URL is not set",
    ]);
  });

  test("refuses a URL that is not http(s)", () => {
    expect(
      problems({
        ...FULL,
        SUPERPIPELINE_URL: "pipeline.example",
        ORG_PLANE_URL: "ftp://accounts.example",
        AGENTPOD_URL: "hub",
      }),
    ).toEqual([
      "SUPERPIPELINE_URL is not an http(s) URL",
      "ORG_PLANE_URL is not an http(s) URL",
      "AGENTPOD_URL is not an http(s) URL",
    ]);
  });

  test("refuses a service credential not shaped svc_<20 hex>:<secret>", () => {
    for (const bad of [
      "svc_0123:secret",
      "svc_0123456789abcdef0123",
      "svc_0123456789ABCDEF0123:secret",
      "prn_0123456789abcdef0123:secret",
    ]) {
      expect(problems({ ...FULL, ORG_PLANE_SERVICE_CREDENTIAL: bad })).toEqual([
        "ORG_PLANE_SERVICE_CREDENTIAL is not svc_<20 hex digits>:<secret>",
      ]);
    }
  });

  test("takes the operator token's hash in either case, and refuses one that is not a SHA-256", () => {
    expect(
      loadConfig({
        ...FULL,
        SUPERDISPATCH_OPERATOR_TOKEN_SHA256:
          OPERATOR_TOKEN_SHA256.toUpperCase(),
      }).operatorTokenSha256,
    ).toBe(OPERATOR_TOKEN_SHA256);
    expect(
      problems({ ...FULL, SUPERDISPATCH_OPERATOR_TOKEN_SHA256: "abc123" }),
    ).toEqual([
      "SUPERDISPATCH_OPERATOR_TOKEN_SHA256 is not 64 hex digits (a SHA-256)",
    ]);
  });

  test("takes a data directory, and refuses a relative one", () => {
    expect(
      loadConfig({ ...FULL, SUPERDISPATCH_DATA_DIR: "/var/lib/dispatch" })
        .dataDir,
    ).toBe("/var/lib/dispatch");
    expect(problems({ ...FULL, SUPERDISPATCH_DATA_DIR: "data" })).toEqual([
      "SUPERDISPATCH_DATA_DIR is not an absolute path",
    ]);
  });

  test("takes AgentPod's audience apart from its URL, and refuses one that is not a URL", () => {
    expect(
      loadConfig({ ...FULL, AGENTPOD_AUDIENCE: "https://hub.public.example" })
        .agentpodAudience,
    ).toBe("https://hub.public.example");
    expect(problems({ ...FULL, AGENTPOD_AUDIENCE: "hub" })).toEqual([
      "AGENTPOD_AUDIENCE is not an http(s) URL",
    ]);
  });

  test("takes the sweep and the reservation in seconds, within their ranges", () => {
    const c = loadConfig({
      ...FULL,
      SUPERDISPATCH_SWEEP_SECONDS: "15",
      SUPERDISPATCH_RESERVATION_SECONDS: "45",
    });
    expect([c.sweepSeconds, c.reservationSeconds]).toEqual([15, 45]);
    expect(
      problems({
        ...FULL,
        SUPERDISPATCH_SWEEP_SECONDS: "2",
        SUPERDISPATCH_RESERVATION_SECONDS: "301",
      }),
    ).toEqual([
      "SUPERDISPATCH_SWEEP_SECONDS is not a whole number from 5 to 3600",
      "SUPERDISPATCH_RESERVATION_SECONDS is not a whole number from 10 to 300",
    ]);
    expect(problems({ ...FULL, SUPERDISPATCH_SWEEP_SECONDS: "1e3" })).toEqual([
      "SUPERDISPATCH_SWEEP_SECONDS is not a whole number from 5 to 3600",
    ]);
  });

  test("takes the tiers and the fairness rule, within their ranges, and names the setting it refuses", () => {
    const c = loadConfig({
      ...FULL,
      SUPERDISPATCH_RUNNER_UP_SECONDS: "20",
      SUPERDISPATCH_TOP_K: "1",
      SUPERDISPATCH_FAIRNESS: "board-order",
    });
    expect([c.runnerUpSeconds, c.topK, c.fairness]).toEqual([
      20,
      1,
      "board-order",
    ]);
    expect(
      problems({
        ...FULL,
        SUPERDISPATCH_RUNNER_UP_SECONDS: "9",
        SUPERDISPATCH_TOP_K: "0",
        SUPERDISPATCH_FAIRNESS: "secret-fairness-value",
      }),
    ).toEqual([
      "SUPERDISPATCH_RUNNER_UP_SECONDS is not a whole number from 10 to 300",
      "SUPERDISPATCH_TOP_K is not a whole number from 1 to 10",
      "SUPERDISPATCH_FAIRNESS is not one of round-robin, board-order",
    ]);
    expect(problems({ ...FULL, SUPERDISPATCH_TOP_K: "11" })).toEqual([
      "SUPERDISPATCH_TOP_K is not a whole number from 1 to 10",
    ]);
    expect(
      problems({ ...FULL, SUPERDISPATCH_RUNNER_UP_SECONDS: "301" }),
    ).toEqual([
      "SUPERDISPATCH_RUNNER_UP_SECONDS is not a whole number from 10 to 300",
    ]);
  });

  test("takes the roster suggestion settings, within their ranges, and names the setting it refuses", () => {
    const c = loadConfig({
      ...FULL,
      SUPERDISPATCH_SUGGEST_EVERY_SECONDS: "300",
      SUPERDISPATCH_SUGGEST_WINDOW_HOURS: "72",
      SUPERDISPATCH_STALL_MINUTES: "10",
    });
    expect([
      c.suggestEverySeconds,
      c.suggestWindowHours,
      c.stallMinutes,
    ]).toEqual([300, 72, 10]);
    expect(
      loadConfig({ ...FULL, SUPERDISPATCH_SUGGEST_EVERY_SECONDS: "0" })
        .suggestEverySeconds,
    ).toBe(0);
    expect(
      problems({
        ...FULL,
        SUPERDISPATCH_SUGGEST_EVERY_SECONDS: "86401",
        SUPERDISPATCH_SUGGEST_WINDOW_HOURS: "0",
        SUPERDISPATCH_STALL_MINUTES: "1441",
      }),
    ).toEqual([
      "SUPERDISPATCH_SUGGEST_EVERY_SECONDS is not a whole number from 0 to 86400",
      "SUPERDISPATCH_SUGGEST_WINDOW_HOURS is not a whole number from 1 to 720",
      "SUPERDISPATCH_STALL_MINUTES is not a whole number from 1 to 1440",
    ]);
  });

  test("takes a port, and refuses one that is not a port", () => {
    expect(loadConfig({ ...FULL, PORT: "9123" }).port).toBe(9123);
    for (const bad of ["70000", "80a", "0", "-1", "8.5"]) {
      expect(problems({ ...FULL, PORT: bad })).toEqual([
        "PORT is not a port number",
      ]);
    }
  });

  test("an error never carries a setting's value", () => {
    const env = {
      ...FULL,
      SUPERPIPELINE_URL: "not a url",
      ORG_PLANE_SERVICE_CREDENTIAL: "svc_short:leaky-credential-secret",
      SUPERDISPATCH_OPERATOR_TOKEN_SHA256: "not-a-hash-value",
      SUPERDISPATCH_DATA_DIR: "relative/secret-path",
      SUPERDISPATCH_FAIRNESS: "leaky-fairness",
      SUPERDISPATCH_TOP_K: "77",
    };
    let message = "";
    try {
      loadConfig(env);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    for (const value of Object.values(env))
      expect(message).not.toContain(value);
  });
});

describe("secret checks", () => {
  test("a secret matches only itself, and an empty one matches nothing", () => {
    expect(secretMatches("s3cret", "s3cret")).toBe(true);
    expect(secretMatches("s3cret", "s3cret ")).toBe(false);
    expect(secretMatches("s3cret", "")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });

  test("a token matches its SHA-256 only, and a malformed hash matches nothing", () => {
    expect(tokenMatchesSha256(OPERATOR_TOKEN_SHA256, OPERATOR_TOKEN)).toBe(
      true,
    );
    expect(
      tokenMatchesSha256(OPERATOR_TOKEN_SHA256.toUpperCase(), OPERATOR_TOKEN),
    ).toBe(true);
    expect(tokenMatchesSha256(OPERATOR_TOKEN_SHA256, "another-token")).toBe(
      false,
    );
    expect(tokenMatchesSha256("abc", OPERATOR_TOKEN)).toBe(false);
  });
});
