/**
 * Read-only clients of the products placement reads, each through its public API:
 *
 * - SuperPipeline: the ready cards, and the eligibility read for each (which agents may take it,
 *   and why the others may not);
 * - AgentPod: the roster, and each rostered agent's load and health;
 * - Accounts (the organization plane): this service's own token, from its service credential.
 *
 * They read, and never write: SuperDispatch owns none of this data. They turn what they read into
 * placement's inputs, and placement does no I/O of its own. Empty: the clients land with the
 * first placement.
 */
export {};
