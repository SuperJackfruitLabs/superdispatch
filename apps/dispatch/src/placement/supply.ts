/**
 * Supply proposals: advice for a person about the agents and stations a lane lacks, never an
 * action (charter decision 8; the scheduler idea's later slice "supply-side moves"). Where a roster
 * suggestion (`suggest.ts`) says who already in the workspace could be added to a board, a supply
 * proposal says what the workspace would need to change: a station's model, which station the
 * work runs on, a new station, or a board's capacity. SuperDispatch changes none of it. A proposal
 * names the verb a person would use (`howToApply`), and nothing here, or anywhere in this service,
 * calls it.
 *
 * Pure, like the rest of placement: the recorded decisions, and the capability registry the loop
 * last read from AgentPod, in; proposals out. A decision's candidate records hold every filter's
 * result, and a station filter's rejection says what the station lacked (`missing`, in the stage's
 * words), so the decisions alone say why a lane went unplaced.
 *
 * A lane (a board's stage) gets proposals only while its latest decision chose nobody. Each kind
 * needs at least `minEvidence` decisions in the window that bear it out. "Blocked" below is a
 * decision in which nobody was eligible: `none-eligible`, or `one-candidate` (a lane with one
 * agent on the roster is left to pull, but its filters still ran and say what turned it away).
 *
 *
 * - **`change-model`**: in a blocked decision, an agent on the board's roster failed only
 *   the model filter. Running one of the models the stage asks for would make it eligible.
 * - **`move-to-host`**: in a blocked decision, an agent on the roster failed only station
 *   filters (and not only the model), and the registry lists another station that has all of what
 *   the lane's stations lacked. Moving the work there (staffing the agent onto that station, or
 *   rostering that station's agent) would give the lane a candidate.
 * - **`add-station`**: in a blocked decision, either the same station shortfall with no
 *   station in the registry that has it (or no registry read), or no agent on the roster has the
 *   capability and no agent in the workspace does either. Nobody has it, so a person would set a
 *   station up.
 * - **`raise-capacity`**: in a decision that chose nobody, every agent on the roster with the
 *   capability failed for its load alone, and at least one at its board's concurrency
 *   (`at-capacity`). More concurrency on the board would let them take more.
 *
 * The registry does not name a host, so `move-to-host` names the station that has what is needed,
 * and the runtime its node was provisioned on when AgentPod knows it.
 */
import type { Proof } from "../config.ts";
import {
  ISOLATION_ORDER,
  type IsolationLevel,
  type StageNeeds,
  type StationCaps,
} from "../sources/index.ts";
import type { CandidateRecord, FilterName, FilterResult } from "./index.ts";
import { checkNeeds } from "./requirements.ts";
import type { Capability, LaneDecision } from "./suggest.ts";

/** What a supply proposal proposes. */
export const SUPPLY_KINDS = [
  /** Set up a new station with what `target` names: nobody in the workspace has it. */
  "add-station",
  /** Run one of the stage's models on `target.station`, an agent on the roster. */
  "change-model",
  /** Run the lane's work on `target.station`, which has what the lane's stations lack. */
  "move-to-host",
  /** Raise the board's concurrency: the lane's agents are busy at their board's limit. */
  "raise-capacity",
] as const;
export type SupplyKind = (typeof SUPPLY_KINDS)[number];

/** How many decisions must bear a proposal out, by default. */
export const DEFAULT_SUPPLY_MIN_EVIDENCE = 2;

/** The most decision ids a proposal lists as its evidence; `evidenceCount` counts them all. */
export const MAX_SUPPLY_EVIDENCE = 20;

/** The verb a person would use for each kind. A proposal names it; nothing here calls it. */
export const HOW_TO_APPLY: Readonly<Record<SupplyKind, string>> = {
  "add-station":
    "A person sets up a station in AgentPod (a runtime, then station setup) with what the target names, and adds its agent to the board's roster.",
  "change-model":
    "A person declares the model for the station in AgentPod's declared harness configuration.",
  "move-to-host":
    "A person puts the lane's agent in the target station in AgentPod, or adds the target station's agent to the board's roster.",
  "raise-capacity":
    "A person raises the board's agent concurrency in SuperPipeline.",
};

/** What a proposal would change. Every field is optional: a kind sets the ones it needs. */
export interface SupplyTarget {
  /** The station to change (`change-model`) or to move the work to (`move-to-host`). */
  readonly station?: string;
  /** The agent occupying it, when the registry says; null for an empty station. */
  readonly stationAgent?: string | null;
  /** The runtime its node was provisioned on, when AgentPod knows it; the registry names no host. */
  readonly runtime?: string | null;
  /** The agent on the roster the proposal is about. */
  readonly agent?: string;
  /** The model to run: the first the stage asks for. */
  readonly model?: string;
  /** Every model the stage would accept. */
  readonly models?: readonly string[];
  readonly harness?: string;
  readonly isolation?: IsolationLevel;
  readonly tools?: readonly string[];
  readonly credentials?: readonly string[];
  /** The work capability a new station's agent would need. */
  readonly capability?: Capability;
}

/** What a proposal would do, as far as the decisions say. */
export interface SupplyEffect {
  /** Distinct cards among its evidence: the cards that waited for want of it. */
  readonly cards: number;
  /** Agents it would make eligible in the lane. */
  readonly agents: number;
  readonly summary: string;
}

/** A proposal for a person. Never an action: nothing reads it to change a station or a roster. */
export interface SupplyProposal {
  readonly kind: SupplyKind;
  readonly boardId: string;
  readonly stageKey: string;
  readonly rationale: string;
  readonly target: SupplyTarget;
  readonly estimatedEffect: SupplyEffect;
  readonly howToApply: string;
  /** Whether a registry read went into it; `move-to-host` needs one. */
  readonly registry: "read" | "unread";
  /** The decisions that bear it out, oldest first, at most `MAX_SUPPLY_EVIDENCE`. */
  readonly evidence: readonly string[];
  readonly evidenceCount: number;
}

export interface SupplySettings {
  readonly minEvidence: number;
  /** The weakest registry proof a target station's fact counts with. */
  readonly minProof: Proof;
}

const STATION_FILTERS: ReadonlySet<FilterName> = new Set<FilterName>([
  "isolation",
  "model",
  "tools",
  "credentials",
]);
const LOAD_FILTERS: ReadonlySet<FilterName> = new Set<FilterName>([
  "capacity",
  "idle",
  "held",
  "health",
]);

type Failure = Extract<FilterResult, { passed: false }>;
const failures = (r: CandidateRecord): Failure[] =>
  r.filters.filter((f): f is Failure => !f.passed);
const passes = (r: CandidateRecord, filter: FilterName) =>
  r.filters.some((f) => f.filter === filter && f.passed);
const missingOf = (fs: readonly Failure[], filter: FilterName): string[] => [
  ...(fs.find((f) => f.filter === filter)?.missing ?? []),
];
const rostered = (d: LaneDecision) =>
  d.candidates.filter((r) => passes(r, "roster"));

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isIsolation = (level: string): level is IsolationLevel =>
  ISOLATION_ORDER.some((l) => l === level);

/** What the lane's stations lacked, gathered over its decisions, as one stage's needs. */
interface Shortfall {
  isolation: IsolationLevel | undefined;
  models: string[];
  tools: Set<string>;
  credentials: Set<string>;
}

function addShortfall(into: Shortfall, fs: readonly Failure[]): void {
  for (const level of missingOf(fs, "isolation")) {
    if (!isIsolation(level)) continue;
    if (
      into.isolation === undefined ||
      ISOLATION_ORDER.indexOf(level) > ISOLATION_ORDER.indexOf(into.isolation)
    )
      into.isolation = level;
  }
  const models = missingOf(fs, "model");
  if (models.length > 0) into.models = models;
  for (const t of missingOf(fs, "tools")) into.tools.add(t);
  for (const c of missingOf(fs, "credentials")) into.credentials.add(c);
}

const needsOf = (s: Shortfall): StageNeeds => ({
  ...(s.isolation !== undefined ? { isolation: s.isolation } : {}),
  ...(s.models.length > 0 ? { models: s.models } : {}),
  ...(s.tools.size > 0 ? { tools: [...s.tools].toSorted(byString) } : {}),
  ...(s.credentials.size > 0
    ? { credentials: [...s.credentials].toSorted(byString) }
    : {}),
});

/** The supply proposals the decisions bear out, by board, then stage, then kind. */
export function proposeSupply(input: {
  readonly decisions: readonly LaneDecision[];
  /** AgentPod's capability registry as last read, by station; null when it was not. */
  readonly stations: ReadonlyMap<string, StationCaps> | null;
  readonly settings: SupplySettings;
}): SupplyProposal[] {
  const lanes = new Map<string, LaneDecision[]>();
  for (const d of input.decisions) {
    const key = `${d.boardId}\u0000${d.stageKey}`;
    lanes.set(key, [...(lanes.get(key) ?? []), d]);
  }
  const out: SupplyProposal[] = [];
  for (const decisions of lanes.values()) {
    out.push(
      ...lane(
        decisions.toSorted(
          (a, b) => a.createdAtMs - b.createdAtMs || byString(a.id, b.id),
        ),
        input.stations,
        input.settings,
      ),
    );
  }
  return out.toSorted(
    (a, b) =>
      byString(a.boardId, b.boardId) ||
      byString(a.stageKey, b.stageKey) ||
      byString(a.kind, b.kind),
  );
}

/** One lane's proposals, from its decisions oldest first. */
function lane(
  decisions: readonly LaneDecision[],
  stations: ReadonlyMap<string, StationCaps> | null,
  settings: SupplySettings,
): SupplyProposal[] {
  const latest = decisions[decisions.length - 1];
  // A lane whose latest decision placed a card has supply enough for now.
  if (latest === undefined || latest.noDecisionReason === null) return [];
  const registry = stations === null ? "unread" : "read";
  const base = { boardId: latest.boardId, stageKey: latest.stageKey };
  const out: SupplyProposal[] = [];
  // Nobody was eligible: `none-eligible`, or `one-candidate` (a lane with one agent on the roster
  // is not placed, but its filters ran, so the record still says what turned the agent away).
  const blocked = decisions.filter(
    (d) =>
      d.noDecisionReason === "none-eligible" ||
      d.noDecisionReason === "one-candidate",
  );

  // change-model: an agent on the roster blocked by its model alone.
  const modelOnly = new Map<string, { station: string | null }>();
  let models: string[] = [];
  const modelEvidence: LaneDecision[] = [];
  // Station shortfalls: agents blocked by station filters alone, not by the model alone.
  const shortfall: Shortfall = {
    isolation: undefined,
    models: [],
    tools: new Set(),
    credentials: new Set(),
  };
  const shortStations = new Set<string>();
  const shortAgents = new Set<string>();
  const harnesses = new Set<string>();
  const stationEvidence: LaneDecision[] = [];
  // Nobody in the workspace has the capability.
  const capabilityEvidence: LaneDecision[] = [];

  for (const d of blocked) {
    let model = false;
    let station = false;
    for (const r of rostered(d)) {
      const fs = failures(r);
      if (fs.length === 0) continue;
      if (fs.length === 1 && fs[0]?.filter === "model") {
        model = true;
        modelOnly.set(r.candidate.agentId, {
          station: r.candidate.stationId ?? null,
        });
        const asked = missingOf(fs, "model");
        if (asked.length > 0) models = asked;
        continue;
      }
      if (fs.every((f) => STATION_FILTERS.has(f.filter))) {
        station = true;
        addShortfall(shortfall, fs);
        shortAgents.add(r.candidate.agentId);
        const sid = r.candidate.stationId ?? null;
        if (sid !== null) {
          shortStations.add(sid);
          const harness = stations?.get(sid)?.harness;
          if (harness) harnesses.add(harness);
        }
      }
    }
    if (model) modelEvidence.push(d);
    if (station) stationEvidence.push(d);
    const rc = rostered(d);
    if (
      rc.every((r) => !passes(r, "capability")) &&
      !d.candidates.some((r) => r.capable === true)
    )
      capabilityEvidence.push(d);
  }

  if (modelEvidence.length >= settings.minEvidence && modelOnly.size > 0) {
    const agent = [...modelOnly.keys()].toSorted(byString)[0] ?? "";
    const station = modelOnly.get(agent)?.station ?? null;
    out.push(
      proposal({
        ...base,
        kind: "change-model",
        registry,
        evidence: modelEvidence,
        target: {
          agent,
          ...(station !== null ? { station } : {}),
          ...(models[0] !== undefined ? { model: models[0] } : {}),
          models,
        },
        agents: modelOnly.size,
        rationale: `${[...modelOnly.keys()].toSorted(byString).join(", ")} on the board's roster ${modelOnly.size === 1 ? "was" : "were"} turned away only for the model it runs; the stage asks for ${models.join(" or ") || "another model"}`,
      }),
    );
  }

  let addStationEvidence: LaneDecision[] = [];
  let addTarget: SupplyTarget = {};
  let stationShort = false;
  const needs = needsOf(shortfall);
  const fits = (caps: StationCaps | undefined) =>
    caps !== undefined &&
    checkNeeds(needs, caps, settings.minProof).every((r) => r.ok);
  // The registry, read since, says one of the lane's own stations has it now: the next decision
  // will say whether the shortfall is gone, so nothing is proposed meanwhile.
  const ownFits =
    stations !== null &&
    [...shortStations].some((id) => fits(stations.get(id)));
  if (stationEvidence.length >= settings.minEvidence && !ownFits) {
    const elsewhere =
      stations === null
        ? null
        : ([...stations.values()]
            .filter((s) => fits(s))
            .toSorted(
              (a, b) =>
                Number(a.principalId != null) - Number(b.principalId != null) ||
                byString(a.stationId, b.stationId),
            )[0] ?? null);
    if (elsewhere !== null) {
      out.push(
        proposal({
          ...base,
          kind: "move-to-host",
          registry,
          evidence: stationEvidence,
          target: {
            station: elsewhere.stationId,
            stationAgent: elsewhere.principalId ?? null,
            runtime: elsewhere.isolation?.runtime ?? null,
            ...(elsewhere.harness ? { harness: elsewhere.harness } : {}),
            ...(elsewhere.isolation && isIsolation(elsewhere.isolation.level)
              ? { isolation: elsewhere.isolation.level }
              : {}),
            ...(elsewhere.model ? { model: elsewhere.model.id } : {}),
            ...stationNeeds(needs),
          },
          agents: 1,
          rationale: `${[...shortAgents].toSorted(byString).join(", ")} on the board's roster ${shortAgents.size === 1 ? "lacks" : "lack"} ${describeNeeds(needs)}; station ${elsewhere.stationId} has all of it`,
        }),
      );
    } else {
      stationShort = true;
      addStationEvidence = stationEvidence;
      addTarget = {
        ...stationNeeds(needs),
        ...(needs.models?.[0] !== undefined ? { model: needs.models[0] } : {}),
        ...(harnesses.size === 1 ? { harness: [...harnesses].join("") } : {}),
      };
    }
  }
  if (capabilityEvidence.length >= settings.minEvidence) {
    const capability =
      capabilityEvidence.toReversed().find((d) => d.requires !== null)
        ?.requires ?? null;
    addStationEvidence = [...addStationEvidence, ...capabilityEvidence];
    addTarget = {
      ...addTarget,
      ...(capability !== null ? { capability } : {}),
    };
  }
  if (addStationEvidence.length > 0) {
    const said: string[] = [];
    if (addTarget.capability !== undefined)
      said.push(
        "no agent in the workspace has the capability the stage asks for",
      );
    if (stationShort)
      said.push(
        `${[...shortAgents].toSorted(byString).join(", ")} on the board's roster ${shortAgents.size === 1 ? "lacks" : "lack"} ${describeNeeds(needs)}, and ${stations === null ? "the capability registry was not read" : "no station in the registry has all of it"}`,
      );
    out.push(
      proposal({
        ...base,
        kind: "add-station",
        registry,
        evidence: addStationEvidence,
        target: addTarget,
        agents: 1,
        rationale: said.join("; "),
      }),
    );
  }

  // raise-capacity: every capable agent on the roster busy at its board's limit.
  const capacityEvidence: LaneDecision[] = [];
  const busy = new Set<string>();
  for (const d of decisions) {
    if (d.noDecisionReason === null) continue;
    const rc = rostered(d).filter((r) => passes(r, "capability"));
    if (rc.length === 0) continue;
    const atLimit = rc.every((r) => {
      const fs = failures(r);
      return (
        fs.length > 0 &&
        fs.every((f) => LOAD_FILTERS.has(f.filter)) &&
        fs.some((f) => f.filter === "capacity")
      );
    });
    if (!atLimit) continue;
    capacityEvidence.push(d);
    for (const r of rc) busy.add(r.candidate.agentId);
  }
  if (capacityEvidence.length >= settings.minEvidence)
    out.push(
      proposal({
        ...base,
        kind: "raise-capacity",
        registry,
        evidence: capacityEvidence,
        target: {},
        agents: busy.size,
        rationale: `every agent on the board's roster with the capability (${[...busy].toSorted(byString).join(", ")}) was at the board's concurrency limit in ${capacityEvidence.length} decisions`,
      }),
    );

  return out;
}

/** The station needs a target names, without the model (a kind names the one it means). */
const stationNeeds = (needs: StageNeeds): SupplyTarget => ({
  ...(needs.isolation !== undefined ? { isolation: needs.isolation } : {}),
  ...(needs.models !== undefined ? { models: needs.models } : {}),
  ...(needs.tools !== undefined ? { tools: needs.tools } : {}),
  ...(needs.credentials !== undefined
    ? { credentials: needs.credentials }
    : {}),
});

function describeNeeds(needs: StageNeeds): string {
  const parts: string[] = [];
  if (needs.isolation !== undefined) parts.push(`${needs.isolation} isolation`);
  if (needs.models !== undefined)
    parts.push(`a model of ${needs.models.join(" or ")}`);
  if (needs.tools !== undefined) parts.push(`tools ${needs.tools.join(", ")}`);
  if (needs.credentials !== undefined)
    parts.push(`credentials ${needs.credentials.join(", ")}`);
  return parts.join(", ") || "what the stage asks for";
}

function proposal(p: {
  kind: SupplyKind;
  boardId: string;
  stageKey: string;
  registry: "read" | "unread";
  evidence: readonly LaneDecision[];
  target: SupplyTarget;
  agents: number;
  rationale: string;
}): SupplyProposal {
  const seen = new Set<string>();
  const ordered = p.evidence
    .toSorted((a, b) => a.createdAtMs - b.createdAtMs || byString(a.id, b.id))
    .filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
  const cards = new Set(ordered.map((d) => d.cardId)).size;
  const rationale = `${p.rationale.charAt(0).toUpperCase()}${p.rationale.slice(1)}.`;
  return {
    kind: p.kind,
    boardId: p.boardId,
    stageKey: p.stageKey,
    rationale,
    target: p.target,
    estimatedEffect: {
      cards,
      agents: p.agents,
      summary: `${cards} card${cards === 1 ? "" : "s"} waited for want of it; it would give the lane ${p.agents} more eligible agent${p.agents === 1 ? "" : "s"}.`,
    },
    howToApply: HOW_TO_APPLY[p.kind],
    registry: p.registry,
    evidence: ordered.slice(-MAX_SUPPLY_EVIDENCE).map((d) => d.id),
    evidenceCount: ordered.length,
  };
}
