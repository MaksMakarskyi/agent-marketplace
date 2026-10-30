# Agent workstream

Setup-guide correction (30 October): `/agent.txt`, `/llms.txt` and MCP initialization now explain automatic `Mcp-Session-Id` onboarding rather than requiring a manually issued token. New sessions register first; existing sessions reuse their profile. The guide distinguishes unavailable onboarding from missing simulated commercial terms and explicitly forbids asking for a vault token to find terms that were never supplied. The guide regression check was observed failing before this correction; targeted guide/onboarding tests verify the replacement. This text still needs deployment with the backend; actual client compatibility remains unverified.

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

## Backend-attached instructions, 30 October

Shared live guide: `src/agents/instructions.ts`, served by `/agent.txt` and `/llms.txt` and included in authenticated live MCP initialization. It describes the actual 18-tool client workflow, registration/mandate limits, assessment pause, post-ranking resolution, supplier polling and authoritative sandbox payment reporting. The fixture gateway keeps its default safety instructions; unmounted TED award/BZP adapters are explicitly unavailable. Two new disposable guide tests pass; final full check: typecheck and 318 passed, 4 TODOs. No named-client or hosted payment proof is implied. [Observer developer handoff](../handoffs/2026-10-30-three-minute-demo.md) is instructions only.

## Gaps

- No live Grok Bot account was available, so the vendor-documented custom-MCP path is documented and
  protocol-tested, not account-tested. Someone must repeat it and record the transcript.
- Instinct has no public developer API and no documented custom MCP or credential storage. The
  named-client integration is **not achieved**; the disclosed fallback is the terminal harness with
  two independent tool-calling agents.
- The platform must expose `GET /v1/requests/{id}` and `GET /v1/offers/{id}` (scoped), and mount
  `createMcpHandler(createMcpBackend(...))` at `POST /mcp`. Events must carry request/offer/order ids
  in `resourceId` as documented in `docs/agent-setup.md`.
- Two open contract questions were raised on the PR and block hosted wiring: (a) whether submitting
  an offer counts as its author's acceptance or both parties must call `acceptOffer`; (b) how the
  buyer resolves a ranked candidate to a connected `supplierId`, since ranking must not know about
  membership. Until (b) is answered the runtime takes an injected candidate→participant map.
- Payment-status timing depends on the platform's `payment_updated` event; a stuck `pending` order is
  reported as failed only after the reporting window, never as paid.
- No refusal endpoint exists in the contract, so a supplier refusal is recorded locally and expressed
  as non-acceptance; the buyer reports `no match` only at its negotiation deadline. Interface request:
  a scoped decline (`POST /v1/requests/{id}/declines`) that emits an event to the buyer.
- Interface request: `ALREADY_REGISTERED` should return the existing `participantId` (the local test
  double does) so a lost state directory does not block a bot.

## Next task

1. Platform owner: merge the scoped read routes and mount the MCP handler; confirm event resource ids.
2. Teammate 2: attach a real Grok Bot to the hosted `/mcp`, start the supplier routine, and record
   the two-chat transcript (buyer instruction → offers → paid → both messages).
3. Jenya: rehearse the changed-constraint refusal from the host computer using the same harness.

## Verification

`npm run test:agents` and `npm run check`. The agent tests use a disposable platform test double and
mocked payment outcomes; they are not a hosted run and not proof of a live Stripe payment. Record
hosted and client evidence separately in the PR that produces it.

## Dependencies and context upkeep

Consume the platform API rather than creating another marketplace backend. Coordinate event payloads,
read routes and MCP mounting with the platform owner. Keep the supplier listener active through final
payment status. Update this file with implemented behaviour, exact test outcomes, blockers and the
next step in each PR. No real company outreach; no email service.
