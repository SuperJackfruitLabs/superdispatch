---
title: The dispatch policy
description: How SuperDispatch asks Accounts' dispatch policy who may take a card, how it fails closed, and why it is still advice.
---

A workspace can keep a **dispatch policy** in Accounts: rules about which agents may take which
work. With `SUPERDISPATCH_POLICY=on`, SuperDispatch asks it about each candidate and records the
answer. `off`, the default, asks nothing, and the `policy` filter passes everyone. The key boundary
is easy to miss: today this changes whom SuperDispatch recommends, not whom SuperPipeline lets pull.

## It only narrows

An agent SuperPipeline already refuses on the card's grant is never asked about, and a policy never
adds an agent the grant leaves out. The policy can only take candidates away.

## How it is asked

- **`POST /api/policy/decide`** on Accounts, which needs the scope `policy:decide` on this
  service's credential.
- **One question per agent, board stage, labels and capabilities a pass**, at most. SuperPipeline
  cards carry no labels yet, so none are sent; the capabilities are the stage's `requires`.
- **The answer is the verdict.** It is recorded on the candidate as
  `policy: { allow, reasons, policyVersion }`. A workspace with no policy answers `no-policy`, which
  allows.

## Limits

A policy may set a limit: an agent that already had `maxRuns` holds from SuperDispatch within the
last `windowHours` is rejected, with the reason `limit:<id>`. It counts holds SuperDispatch made,
so it limits what is steered to an agent, not what the agent pulls.

## When Accounts cannot answer

Accounts unreachable, a refusal, or an answer that cannot be read:

- if the last answer said the workspace has **no policy**, the candidate passes;
- otherwise, including a cold start, it is rejected with the reason `policy-unread`.

That fails closed, and costs only the advice: a card nobody is held for is still claimed by pull.
An agent with no principal cannot be asked about, so it is treated the same way (`no-principal`).

You therefore get a conservative recommendation without turning an Accounts outage into a stuck
board.

## It is advice until SuperPipeline enforces it

A pull ignores the policy: SuperPipeline does not check it on claim yet. With the policy on,
SuperDispatch will not hold a card for an agent the policy refuses, but that agent can still pull
the card. Until SuperPipeline enforces it, the policy here is advice like the rest of
SuperDispatch.

Treat a denied placement as a steering decision, not an authorization guarantee.
