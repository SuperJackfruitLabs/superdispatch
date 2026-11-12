/**
 * The two shapes station filtering reads, from two products: what a SuperPipeline stage says a
 * station needs (its `placement`), and what AgentPod's capability registry says a station has
 * (charter 2026-11-13). Types only; `placement/requirements.ts` compares them.
 */
import type { Proof } from "../config.ts";

/** Isolation levels, weakest first, as AgentPod's catalog names them. */
export const ISOLATION_ORDER = ["host", "container", "sandbox"] as const;
export type IsolationLevel = (typeof ISOLATION_ORDER)[number];

/** What a stage says a station needs (SuperPipeline's stage `placement`). */
export interface StageNeeds {
  readonly isolation?: IsolationLevel;
  /** Any one will do. */
  readonly models?: readonly string[];
  /** Every one. */
  readonly tools?: readonly string[];
  /** Every one. */
  readonly credentials?: readonly string[];
}

/** One station's row in AgentPod's registry, as far as station filtering reads it. */
export interface StationCaps {
  readonly stationId: string;
  /** The agent occupying the station; null for an empty one, unset when the registry did not say. */
  readonly principalId?: string | null;
  /** The harness the station runs; unset when the registry did not say. */
  readonly harness?: string | null;
  readonly isolation: {
    readonly level: string;
    readonly proof: Proof;
    /** The runtime (or provider) AgentPod provisioned the station's node on; null for a host. */
    readonly runtime?: string | null;
  } | null;
  readonly model: { readonly id: string; readonly proof: Proof } | null;
  readonly tools: readonly { readonly id: string; readonly proof: Proof }[];
  readonly credentials: readonly {
    readonly name: string;
    readonly proof: Proof;
  }[];
}
