# Agent workstream

Human owner: teammate 2. Agent runtime: OpenCode workers, orchestrated and reviewed by Hermes.
Agent must read root `AGENTS.md` first.

## Owns

`src/agents/`, `src/mcp/`, demo scripts, and `tests/agents/`. This owner makes the existing buyer and
supplier bots use the platform and report results in their normal conversations.

## What this means in plain language

1. Prove the actual Grokbot/Instinct clients can connect, authenticate separately, and call the
   platform's tools. It is implementation work as well as a compatibility test.
2. Make each bot register its demo company and permitted terms using the backend built by teammate 1.
3. Keep the supplier bot active so it receives a quote request and automatically responds.
   "Listener" means a running event-checking loop, not a supplier-listing page.
4. Make the bots exchange offers/counteroffers and accept or refuse without their humans stepping in.
   Backend rules still enforce each mandate.
5. After the platform reports the actual result, make each bot tell its own human in the existing
   chat: agreed and sandbox-paid, no match, refused, expired, or payment failed. Include the demo
   order/invoice reference where applicable.

Email, a separate notification service, and a notification UI are outside the MVP. Do not write
another live-data connector or implement Stripe here.

## Current state (2026-10-30)

Integration checkpoint on `feat/live-marketplace-integration`: six evidence/identity tools are added and the live server mounts an authenticated 18-tool low-level MCP surface. It excludes the five unavailable fixture-host runtime tools. Client agents must read sources and submit their own assessment; the older BuyerRunner polling-only path is not the live semantic workflow. The Sheets timeout fixture cancellation is fixed. Parent full check: 303 passed, 4 TODO, no failures/cancellations; actual Grok/Instinct accounts remain unverified. Continue the [agent owner prompt](../handoffs/2026-10-30-integration-owners.md), not the canned sandbox as a production backend.

Implemented on branch `feat/agent-connectors` (PR pending):

- `config.ts` — environment-only identity, mandate and limits. Every missing/invalid variable is
  reported by name; values are never echoed. `sandboxOnly` is always true and a bot cannot raise a
  ceiling at runtime.
- `client.ts` — typed client for registration, requests, discovery, quote requests, offers,
  acceptances, settlement, order reads, events, and the two scoped reads. Bearer auth, deterministic
  `Idempotency-Key`, bounded timeout, retry only on 408/429/5xx with the same key.
- `store.ts` — atomic file-backed cursor, seen-event set and report ledger, plus a memory variant.
- `policy.ts` — deterministic buyer/supplier limit checks and offer arithmetic in integer minor
  units. Buyer counters only price failures; any non-price mismatch refuses instead of burning a
  revision.
- `negotiation.ts` / `buyer.ts` — buyer registers, creates the request, polls discovery, requests a
  quote from the top connected ranked candidate (up to five fallbacks), negotiates within three
  revisions or five minutes, settles, reads the order and reports.
- `listener.ts` — supplier event loop with backoff, persisted cursor, event dedupe, quote/offer
  handling, a settlement attempt with a graceful 403 fallback, and continued polling through payment.
- `reporter.ts` — exactly three literals (`agreed and sandbox-paid`, `no match`, `payment failed`)
  from authoritative status, deduplicated by order and event, with a pending queue for offline bots.
- `cli/` — `buyer`, `supplier`, `demo` entrypoints; `tests/agents/support/dev-platform.ts` starts the
  disposable test double for local runs.
- `src/mcp/gateway.ts`, `tools.ts`, `backend.ts` — zero-dependency Streamable HTTP MCP server with 14
  tools, strict schemas, token-scoped identity, sanitized errors, and `supplier_listener_tick` /
  `report_pending` for scheduled bot turns. Delivered as its own PR.

Checks observed locally:

```
npm run typecheck
npm run test:agents     # 100+ agent tests, 0 failures
npm run check           # full repository suite green
```

A real `@modelcontextprotocol/sdk` 1.28.0 client completed `initialize`, `tools/list` (14 tools) and
`tools/call` against the gateway over HTTP, including token propagation and a completion report.

## Review fixes (2026-10-30)

Found in review and fixed with regression tests (`tests/agents/rerun-and-payment.test.ts`, listener
and policy tests):

- **Reruns.** Each buyer run has its own id, so the sourcing request is new every run. Registration
  keys cover the registration body, and `ALREADY_REGISTERED` reuses the platform-returned or stored
  participant id. Before: a changed budget crashed with `IDEMPOTENCY_KEY_REUSED`, and an identical
  rerun replayed the previous order as a new "agreed and sandbox-paid".
- **Slow payments.** The buyer re-reads a pending order for up to `PAYMENT_WAIT_MS` (default 120s)
  and reports `payment failed` only after that window. Before: about 2s.
- **Supplier never settles.** The listener no longer calls `settle`. It re-reads agreed orders
  until payment is terminal. Before: it retried the buyer's declined charge.
- **Negotiation.** The buyer opens 10% below the lower of ask and budget, and makes a final counter
  at its ceiling only when one revision is left. The supplier splits the difference, never below
  its floor and never above a feasible stated budget. Before: the buyer's only counter was exactly
  its budget.
- **Tax/delivery.** Demo offers carry `taxMinor` and `deliveryMinor` = 0 (`MVP_LIMIT`). Before: the
  buyer invented a 1/6 tax and 5/6 "delivery" split.
- **Buyer reports.** The buyer reports through the persisted ledger: deduplicated, and queued on
  chat failure. The listener re-sends queued messages on its next tick.
  `requires_action` is reported at once as `payment failed — payment requires further action`.
- **Stuck events.** An event the platform rejects (4xx) is skipped after 3 attempts, and any event
  after 10, so it cannot hold the cursor.
- **Evidence-derived routing removed.** `publicOrganizationId` from evidence is no longer used as a
  quote recipient.

## Bot sandbox (branch `feat/agent-sandbox`)

Real bots can now be tested before the platform exists: `node dist/tests/agents/support/sandbox.js`
(see `docs/bot-sandbox.md`). Bots use three high-level MCP tools, `start_purchase`,
`purchase_status` and `supplier_status`, served by `src/agents/host.ts`. Instinct uses a Google
Sheet bridge (`src/agents/bridge.ts`, `src/agents/sheets.ts`) because it documents no custom MCP or
API. Checked locally: `tests/agents/host.test.ts` covers the host, MCP over HTTP, both bridges, the
grant cap and refusal. A JSON-RPC client drove both bots over HTTP through to paid and refused
outcomes. Not yet run with a live Grok Bot or Instinct account.

## Live integration (branch `feat/grokbot-actual-integration`, from PR #12 / `9698789`)

The live handler mounts an authenticated 18-tool low-level MCP surface and deliberately excludes the
five fixture-host tools (`start_purchase`, `purchase_status`, `supplier_status`,
`supplier_listener_tick`, `report_pending`). Discovery now stops for a **client-written assessment**;
the buyer runtime was extended accordingly rather than replaced by a backend model.

- `buyer.ts` gained a `live` mode: bind the selected `buyerNoticeNumber`, start discovery, read
  `get_discovery_evidence`, page each source with `read_discovery_source` (5 sources × 3 pages of
  8,000 characters, hard caps), call the injected `assess` callback (the client model's work), submit
  the assessment unchanged, then read the frozen ranking and `resolve_discovery_participants` before
  quoting. No backend LLM, no seeded supplier, no `publicOrganizationId` fallback.
- `client.ts` can talk to the live contract (`omitActorIdsFromOffers`): offer participants come from
  the bearer token, and sending `buyerId`/`supplierId` is rejected by the live handler.
- Buyer counters that fall below the supplier's private floor are refused by the platform
  (`POLICY_REFUSAL`). The runner now accepts the standing offer instead of losing the deal, without
  learning the floor.
- `tests/agents/support/live-platform.ts` boots the real authenticated handler, Marketplace and
  sourcing pipeline on PGlite with stubbed TED/Tavily and a stubbed settlement provider. Its
  `unregistered` option leaves both participants for the agents to register.
- `tests/agents/live-buyer.test.ts` (11 tests): notice-bound happy path, polling-only path fails,
  rejected quotation, unconnected lead, budget below floor, prompt-injection source text, page caps,
  conditional top candidate, first-time registration of both agents, registration above the grant,
  and an operator domain map ignored in live mode.

Review fixes on this branch:

- **Conditional candidates.** The platform quotes only `eligible: "yes"`. A `conditional` top
  candidate (a mandatory requirement left `unknown`) used to reach `request_quote`, get
  `QUALIFYING_CANDIDATE_REQUIRED` and crash the run with no message in either chat. Live mode now
  quotes only fully eligible candidates, skips that refusal to the next candidate, and otherwise
  reports `no match`.
- **No operator map in live mode.** Only `resolve_discovery_participants` chooses a quote recipient.
- **`POLICY_REFUSAL` only.** The accept-standing-offer fallback no longer triggers on every `403`.
- **Bot prompts.** The Grok buyer prompt and supplier routine now register on first use within the
  operator grant, and the buyer quotes only connected `eligible: "yes"` candidates.
- `tests/agents/live-mcp.test.ts` (4 tests): 18 tools advertised and fixture tools absent; the full
  seven-step sequence through tools only with a hand-written assessment; refusal with no order; the
  supplier token cannot read or assess the buyer's discovery.

Checks observed on this branch (2026-10-30):

```
npm run typecheck
npm run test:agents  # 180 passed, 0 failed
npm run check        # 323 tests, 319 passed, 0 failed, 4 pre-existing TODO
```

Evidence class: local protocol with fixture data and a stubbed payment provider. No hosted revision,
no Stripe sandbox charge, no actual Grok or Instinct account.

## Gaps

- No live Grok Bot account was available, so the vendor-documented custom-MCP path is documented and
  protocol-tested, not account-tested. Someone must repeat it and record the transcript.
- Instinct has no public developer API and no documented custom MCP or credential storage. The
  named-client integration is **not achieved**; the disclosed fallback is the terminal harness with
  two independent tool-calling agents.
- Resolved by the live branch: the scoped read routes exist and `/mcp` is mounted; offer submission
  records the author's acceptance, so one counterparty acceptance creates the order (PR #12
  checkpoint); candidate→participant resolution exists (`resolve_discovery_participants`), and the
  injected map is fixture-only; `ALREADY_REGISTERED` returns the existing `participantId`.
- Interface request (platform owner): the 5-minute `request_quote` window counts from evidence
  collection (`discovery_runs.completed_at`), not from the assessment. A real client model reading up
  to 15 pages can exceed it and then gets `QUALIFYING_CANDIDATE_REQUIRED` for a valid candidate.
  Through MCP, repeating `start_discovery` for the same request replays the first discovery (stable
  idempotency key), so the bot cannot retry in-chat. Proposed: start the window at assessment
  submission.
- Interface request (platform owner): a buyer counter below the supplier's private floor is refused
  with `POLICY_REFUSAL`, which tells the buyer the floor lies above that amount. Repeated counters
  could narrow it down. The runner and prompts never probe, but nothing enforces that. Proposed:
  accept any counter within the author's own mandate and enforce the counterparty's limits only at
  acceptance (`accept_offer` already re-checks both).
- The live CLI `buyer` still polls `get_discovery` and has no assessment step, so it cannot run against
  the live handler (discovery is refused without a bound notice). The live path is the tool sequence
  driven by the client; a two-phase CLI harness (dump evidence → submit assessment file) is not built.
- Payment-status timing depends on the platform's `payment_updated` event; a stuck `pending` order is
  reported as failed only after the reporting window, never as paid.
- No refusal endpoint exists in the contract, so a supplier refusal is recorded locally and expressed
  as non-acceptance; the buyer reports `no match` only at its negotiation deadline. Interface request:
  a scoped decline (`POST /v1/requests/{id}/declines`) that emits an event to the buyer.

## Next task

1. Platform owner: confirm the hosted revision and issue two scoped tokens; `/mcp` must be public
   HTTPS with the new migration applied.
2. Teammate 2: attach a real Grok Bot to the hosted `/mcp`, run the buyer prompt and the supplier
   routine from `docs/agent-setup.md`, and capture the two-chat transcript plus the tool calls.
3. Teammate 2: add the two-phase CLI harness (evidence dump → assessment file) if the host wants a
   terminal fallback for the live flow.
4. Jenya: rehearse the changed-constraint refusal from the host computer using the same sequence.

## Verification

`npm run test:agents` and `npm run check`. The agent tests use a disposable platform test double and
mocked payment outcomes; they are not a hosted run and not proof of a live Stripe payment. Record
hosted and client evidence separately in the PR that produces it.

## Dependencies and context upkeep

Consume the platform API rather than creating another marketplace backend. Coordinate event payloads,
read routes and MCP mounting with the platform owner. Keep the supplier listener active through final
payment status. Update this file with implemented behaviour, exact test outcomes, blockers and the
next step in each PR. No real company outreach; no email service.
