---
title: What SuperDispatch is
description: The suite's scheduler. It reads cards from SuperPipeline and agents from AgentPod, decides which agent should take each ready card, and records why.
---

SuperDispatch is the suite's scheduler. When a SuperPipeline card is ready, it decides which agent
should take it, and records why.

Before it, placement happened anyway, scattered and mostly by hand: a person added an agent to a
board's roster in AgentPod, and the agent pulled any card whose capability matched. Whoever asked
first got the card. Nothing compared candidates, nothing knew that one agent was busy and another
idle, and nothing recorded why a card went where it went. On a board with one agent per
capability, one stuck agent stalled the lane.

## What it does

On each board the operator [opts in](/run/opting-a-board-in/), every 30 seconds and as soon as the
event relay delivers one of the board's events, SuperDispatch:

1. **reads the board** from SuperPipeline and settles what became of each card it held;
2. **queues the ready cards** and takes them fairly across boards, longest-waiting first;
3. **places each card**: it [filters](/placement/filters/) every agent of the workspace, each
   rejection carrying a reason code, [scores](/placement/scoring/) the ones left, and asks
   SuperPipeline to [hold the card](/placement/holds-and-tiers/) for the best for a short window;
4. **records the decision**, with every candidate and the reason for each
   ([Decision records](/records/decisions/)).

After each sweep it reads its own decisions back and flags lanes that rest on one agent or go
unplaced for want of supply: [roster suggestions](/records/roster-suggestions/) and
[supply proposals](/records/supply-proposals/), advice for a person.

## Its rules

These come from the charter decision
[SuperDispatch owns the Scheduler plane](https://github.com/SuperJackfruitLabs/charter/blob/main/decisions/2026-11-12-superdispatch-owns-the-scheduler.md)
(2026-11-12), and the code holds each one.

- **It advises; SuperPipeline holds.** For each ready card SuperDispatch names a preferred agent.
  SuperPipeline holds the card for that agent for a short reservation that expires on its own,
  checked when a claim is made. When the reservation lapses, or SuperDispatch is absent, any
  matching agent may claim the card as before.
- **A reservation outranks priority.** The reserved agent gets its reserved card even when a
  higher-priority card with no reservation is waiting. SuperDispatch already weighed priority when
  it chose.
- **AgentPod-rostered agents only, at first.** Agents that claim with a token of their own are
  recorded as outside the candidate set (`not-on-roster`) and keep working by pull. Widening the
  set is a setting, `SUPERDISPATCH_CANDIDATES=all`, and `roster` stays the default.
- **The idle filter is the workspace-wide cap.** It holds a card only for an agent with no work in
  hand anywhere, and at most one card for an agent at a time. SuperPipeline's per-board
  concurrency stays as it is.
- **A hold relaxes in tiers**: the winner, then the runner-ups one at a time, then any match. Each
  step is its own decision, labelled with its tier.
- **A busy board does not starve a quiet one.** One sweep places a card from each board in turn
  before any board takes a second free agent.
- **Every decision is a record**: the card, the chosen agent, every rejected candidate with its
  reason, and the score that ranked the rest.
- **It reads, and never edits a roster or a station.** It may propose a roster change or a supply
  move; a person makes it. No client it holds of another product has a roster write, and a test
  calls every method of every client and fails on any write but the reservation.
- **Nothing requires it.** SuperPipeline without SuperDispatch is the same board it is now, and
  AgentPod's roster works without it.

## What it is not

- **Not a dispatcher.** It never claims a card and never hands one to an agent. Direct dispatch
  was ruled out: it would replace the pull that works today and make the scheduler a dependency.
- **Not inside SuperPipeline or AgentPod.** A board would otherwise need to know about stations,
  load and health, and the fleet console would decide work it does not own. It runs as its own
  service and reads both through their public APIs.
- **Not an owner of anyone's data.** It keeps its own store: the boards opted in, its decisions,
  and its suggestions. Everything else it reads.

## What it is made of

A Bun service in TypeScript, Apache-2.0 licensed, with a SQLite store. Placement is pure
functions over plain inputs and does no I/O; the loop reads the other products and hands placement
the facts. The source is at
[github.com/SuperJackfruitLabs/superdispatch](https://github.com/SuperJackfruitLabs/superdispatch).
