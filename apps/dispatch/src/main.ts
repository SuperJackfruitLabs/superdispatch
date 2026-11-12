/**
 * SuperDispatch: the suite's scheduler. Reads its settings, opens its store, wires the sources to
 * the loop, starts the sweep, then listens.
 */
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config.ts";
import { createLoop, startRunner } from "./loop/index.ts";
import { SERVICE, createHandler } from "./routes/index.ts";
import {
  createAccounts,
  createAgentpod,
  createServiceTokens,
  createSuperpipeline,
  createSuperwitness,
} from "./sources/index.ts";
import { openStore } from "./store/index.ts";

const config = loadConfig(process.env);
const store = openStore(config.dataDir);
console.log(`${SERVICE}: store at schema version ${store.schemaVersion()}`);

const accounts = createAccounts({
  url: config.orgPlaneUrl,
  credential: config.orgPlaneCredential,
});
const superpipeline = createSuperpipeline({
  baseUrl: config.superpipelineUrl,
  tokens: createServiceTokens({
    accounts,
    audience: config.superpipelineUrl,
  }),
});
const agentpod = createAgentpod({
  baseUrl: config.agentpodUrl,
  tokens: createServiceTokens({
    accounts,
    audience: config.agentpodAudience,
  }),
});
const superwitness =
  config.superwitnessUrl === null || config.superwitnessAudience === null
    ? null
    : createSuperwitness({
        baseUrl: config.superwitnessUrl,
        tokens: createServiceTokens({
          accounts,
          audience: config.superwitnessAudience,
        }),
      });
const loop = createLoop({
  store,
  superpipeline,
  agentpod,
  superwitness,
  history: {
    windowMs: config.historyDays * 24 * 60 * 60 * 1000,
    halfLifeMs: config.historyHalfLifeDays * 24 * 60 * 60 * 1000,
    minSample: config.historyMinSample,
  },
  tiers: {
    winnerSeconds: config.reservationSeconds,
    runnerUpSeconds: config.runnerUpSeconds,
    topK: config.topK,
  },
  fairness: config.fairness,
  candidateSet: config.candidates,
  suggestions: {
    everyMs: config.suggestEverySeconds * 1000,
    windowMs: config.suggestWindowHours * 3600 * 1000,
    stallAfterMs: config.stallMinutes * 60 * 1000,
  },
  now: Date.now,
  newId: () => `pld_${randomBytes(12).toString("hex")}`,
});
const runner = startRunner(loop, { intervalMs: config.sweepSeconds * 1000 });

const server = Bun.serve({
  port: config.port,
  fetch: createHandler({ config, store, onBoard: runner.nudge }),
});
console.log(
  `${SERVICE}: listening on :${server.port}, sweeping every ${config.sweepSeconds}s`,
);

async function shutdown() {
  runner.stop();
  await server.stop();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
