/**
 * Treaty's contracts for what the sources read: every 2xx body SuperPipeline and AgentPod answer
 * is checked against the crossing's OpenAPI document before it is read, so this service reads the
 * shape both products agreed on in treaty, not a copy typed by hand here.
 *
 * - `superpipeline.board-read` (`board-read.v1`): the board snapshot;
 * - `superpipeline.placement` (`placement.v1`): eligibility, the reservation, the placement window
 *   and every agent's load;
 * - `agentpod.capability-catalog` (`capability-catalog.v1`): the registry and a board's roster.
 *
 * A body the contract refuses is `SourceError(product, status, "contract_refused")`, never read
 * in part: the loop logs it and treats the source as unavailable for that pass, as it does any
 * refusal. The error names where the body broke the contract (a JSON pointer into the body),
 * never a value from it.
 *
 * The documents come from the installed `@superjackfruitlabs/treaty-contracts`, the release
 * `treaty.json` pins, read once on first use.
 */
import {
  openApi,
  validateResponse,
  type Api,
} from "@superjackfruitlabs/treaty-contracts";
import { loadInstalledBundle } from "@superjackfruitlabs/treaty-contracts/node";
import type { Proof } from "../config.ts";
import { SourceError, okBody, type Answer } from "./http.ts";

/** The treaty documents the sources read, by crossing. */
export const CONTRACTS = {
  "superpipeline.board-read":
    "schemas/http/superpipeline/board-read.v1.openapi.json",
  "superpipeline.placement":
    "schemas/http/superpipeline/placement.v1.openapi.json",
  "agentpod.capability-catalog":
    "schemas/http/agentpod/capability-catalog.v1.openapi.json",
} as const;
export type Crossing = keyof typeof CONTRACTS;

type Bundle = ReturnType<typeof loadInstalledBundle>;
let bundle: Bundle | null = null;
const apis = new Map<Crossing, Api>();

/** A crossing's API, its document read from the installed release on first use. */
function contract(crossing: Crossing): { bundle: Bundle; api: Api } {
  bundle ??= loadInstalledBundle();
  let api = apis.get(crossing);
  if (api === undefined) {
    api = openApi(bundle, CONTRACTS[crossing]);
    apis.set(crossing, api);
  }
  return { bundle, api };
}

/** Where a body broke the contract: the first error's JSON pointer, without its message. */
function where(errors: readonly string[]): string {
  const first = errors[0] ?? "";
  const pointer = first.split(" ")[0] ?? "";
  return /^#(\/\S*)?$/.test(pointer) ? pointer : "#";
}

/**
 * Whether a body is what the contract says the operation answers with that status. Returns the
 * pointer of the first place it is not, or null when it holds.
 */
export function contractBreak(
  crossing: Crossing,
  operationId: string,
  status: number,
  body: unknown,
): string | null {
  const { bundle: b, api } = contract(crossing);
  const result = validateResponse(b, api, operationId, status, body);
  return result.valid ? null : where(result.errors);
}

/**
 * The parts of treaty's `board-read.v1` and `placement.v1` bodies this service reads, as the
 * contract holds them. A body is read through one of these only after `contractBody` held it to
 * the contract, so a required field is there with its type; only an optional one is checked.
 */
export interface WireStage {
  key: string;
  ownerKind?: "capability" | "agent" | "human";
  owner?: string;
  requires?: { all?: string[]; any?: string[] };
  placement?: unknown;
}
export interface WireCard {
  id: string;
  currentStageKey: string;
  state: string;
  currentRunId: string | null;
  lastAgentId: string | null;
  attemptCount: number;
  priority: number;
  createdAt: string;
  archivedAt: string | null;
  reservation?: { agentId: string; reservedUntil: string };
}
export interface WireBoard {
  stages: WireStage[];
  cards: WireCard[];
}
export interface WireEligibility {
  stageKey: string;
  reasons: string[];
  agents: Array<{
    agentId: string;
    principalId: string | null;
    eligible: boolean;
    reasons: string[];
  }>;
}
export interface WireAgentLoad {
  agents: Array<{
    agentId: string;
    principalId: string | null;
    inFlight: number;
    capacity: number;
    lastHeartbeatAt: string | null;
  }>;
}

/**
 * The parts of treaty's `capability-catalog.v1` bodies this service reads, as the contract holds
 * them. A body is read through these only after `contractBody` held it to the contract.
 */
export interface WireRoster {
  agents: Array<{
    key: string;
    stationId: string;
    principalId: string | null;
    enabled: boolean;
    ready: boolean;
    busy: boolean;
    lastDispatchedAt: string | null;
  }>;
}
/** One station's row in the registry (`StationCapabilities`). */
export interface WireStation {
  stationId: string;
  principalId: string | null;
  harness: string;
  isolation: { level: string; runtime: string | null; proof: Proof };
  model: { id: string; proof: Proof } | null;
  tools: Array<{ id: string; proof: Proof }>;
  credentials: Array<{ name: string; instance: string; proof: Proof }>;
}
export interface WireStations {
  stations: WireStation[];
}

/** The shape each operation's 2xx body is read as, once the contract has held it. */
export interface Wire {
  readBoard: WireBoard;
  readCardEligibility: WireEligibility;
  readAgentLoad: WireAgentLoad;
  reserveCard: unknown;
  setScheduling: unknown;
  clearCardReservation: unknown;
  readBoardRoster: WireRoster;
  listStationCapabilities: WireStations;
}

/** A body the contract held (`broke` is null) is the shape its operation is read as. */
function heldTo<K extends keyof Wire>(
  _body: unknown,
  _operationId: K,
  broke: string | null,
): _body is Wire[K] {
  return broke === null;
}

/**
 * The body of a 2xx answer, held to the contract: a refusal throws as `okBody` does, and a body
 * the contract does not allow throws `contract_refused`. The contract, not this function, is
 * what vouches for the shape it is read as.
 */
export function contractBody<K extends keyof Wire>(
  product: string,
  crossing: Crossing,
  operationId: K,
  answer: Answer,
): Wire[K] {
  const body = okBody(product, answer);
  const broke = contractBreak(crossing, operationId, answer.status, body);
  if (heldTo(body, operationId, broke)) return body;
  throw new SourceError(
    product,
    answer.status,
    "contract_refused",
    broke ?? "#",
  );
}
