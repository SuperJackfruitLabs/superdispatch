/**
 * Read-only clients of the products placement reads, each through its public API:
 *
 * - SuperPipeline (`superpipeline.ts`): a board's stages and cards, the eligibility read for a
 *   card (which agents may take it, and why the others may not), and the reservation it holds for
 *   the chosen agent;
 * - AgentPod (`agentpod.ts`): a board's roster, with each station's readiness, its work in hand
 *   and when it last took work;
 * - SuperWitness (`superwitness.ts`), when it is configured: how the finished runs at a board stage
 *   turned out and were judged, for each stage's history in the score;
 * - the shared shape of an agent's load and health (`load.ts`), which both the roster and
 *   SuperPipeline's load read produce, so placement judges every candidate by one rule;
 * - Accounts, the organization plane (`accounts.ts`): this service's own token for each of them,
 *   from its one service credential.
 *
 * They read, and own nothing: SuperDispatch owns none of this data. The one write is the
 * reservation, which SuperPipeline holds and lets lapse on its own. They hand the loop plain
 * values; placement does no I/O of its own.
 */
export * from "./accounts.ts";
export * from "./agentpod.ts";
export * from "./capabilities.ts";
export * from "./http.ts";
export * from "./load.ts";
export * from "./superpipeline.ts";
export * from "./superwitness.ts";
