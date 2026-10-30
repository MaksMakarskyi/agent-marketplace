# Workstream boundaries, draft v0.1

Owner: platform. `src/contracts.ts` defines draft TypeScript signatures. They are development contracts, not runtime validation. `GET /openapi.json` currently describes route intent and marks business routes unimplemented; complete request/response schemas before calling it a finished client integration.

## Platform to sourcing

Platform authenticates and authorizes a request, then calls `SourcingService.discover(actor, request)`. Source owner returns a `DiscoveryResult` with status, ranked candidates, evidence, and source failures. Platform owns storing/distributing job state; sourcing must not create a second order database.

The asynchronous transport is `POST /v1/requests/{requestId}/discover` returning a discovery ID, followed by `GET /v1/discoveries/{discoveryId}`. Platform owner must implement a persistent job/step runner; the interface does not create one automatically.

Source owner supplies `MatchingService.rankEvidence(request, candidates)` and `rankOffers(request, offers)`. Candidate inputs contain no platform-membership flag. Identity-to-account lookup occurs after evidence ranking.

## Platform to agent clients

Integration update (30 October): `POST /v1/sources/public-buyer-notices/search` and MCP `search_public_buyer_notices` accept CPV and/or keywords plus optional date bounds. The selected `bzp:<UUID>` goes in `create_request.buyerNoticeNumber`; discovery requires the caller's unexpired search receipt and re-fetches the original query. Existing client assessment, ranking, resolution, quote and order tools follow. Apply `20261030180000_directory_workflow.sql` before using this path. Website source IDs and quotations remain backend-bound; a client never supplies trusted source bodies or provenance.

Public observation: `GET /v1/demo-observer/runs`, `GET /v1/demo-observer/runs/{runId}` and `GET /v1/demo-observer/activity` need no credential. The first two reuse the existing observer JSON projection for all registered demo buyers; activity returns `{ activities: [...] }` with role, operation, timestamp and status, excluding message text and secrets. Exact Pages CORS is enabled by default. These read routes grant no transaction authority. Existing participant HTTP/MCP still requires credentials until the separate automatic-onboarding change lands.

Agent owner exposes tool calls for the HTTP equivalents of `PlatformService`: registration, requests, discovery, quote requests, offers, acceptance, settlement, order status, and authorized events. No business logic is duplicated in an MCP adapter.

Credentials map to trusted `ActorContext` on the server. Ignore/reject client-supplied actor IDs as authority. Operator grants bound registration mandates. Money uses integer minor units; every offer has one currency and an immutable offer ID. Validate quantities, deadlines, ownership, policies, and every required field at runtime.

The agents use separate credentials and contexts. Supplier polls `GET /v1/events?after=cursor` while running. Events include a request ID and a resource ID. Platform must provide a scoped payload/read mechanism for the request or offer behind each event before client integration; adding those read endpoints is a coordinated next contract change. Do not assume the current draft alone contains enough information to negotiate.

MCP/custom-tool support for the named clients is unverified. Implement one demonstrated transport first.

## Orders, payment, and bot result reporting

Both sides accept the same current offer. Counteroffers make previous unagreed revisions stale. Once agreed, terms are immutable and one order exists. Platform atomically enforces one close and supplier capacity.

Offer `deliveredTotal` includes tax and delivery; `taxMinor` and `deliveryMinor` are included components, not additional charges. Reject inconsistent totals. Price, stock, and delivery declarations are demo supplier terms, not inferred facts about the real company.

Platform owns sandbox payment, signature-verified provider updates, demo documents, and persistent participant-scoped events. Agent owner makes each bot consume those events, read the authorized current order, and report the result in its existing conversation. The supplier listener must continue through agreement and payment updates, not stop after submitting a quote. There is no `NotificationService`, email provider, or platform-wide notification status in the MVP.

Bot messages must distinguish agreed-and-sandbox-paid, no match, negotiation refused/expired, payment failed, and payment requiring further action. Failed or delayed chat reporting does not alter an order's agreement/payment state. Persist consumer cursors and deduplicate event reports; only report payment success after reading provider-confirmed platform status. A bot's existing tool-call result may supply the in-chat response when proactive chat APIs are unavailable. Actual client behavior must be verified; a plain HTTP/MCP connection alone does not guarantee proactive messages. No claim of seller payout, tax invoicing, physical fulfillment, or profit follows from a sandbox charge.

### Changes from the PR #12 platform review

- `POST /v1/requests/{id}/offers` accepts optional `buyerId`/`supplierId` for legacy clients. They must equal the server-derived parties, else `403 PARTICIPANT_MISMATCH`; they are never authority. MCP `submit_offer` is unchanged and still omits them.
- A buyer-authored revision is no longer refused for the supplier's private limits (floor, capacity, unit, earliest delivery). The supplier's acceptance enforces them, so supplier bots must expect to receive and decline such revisions.
- An offer or acceptance on a closed request returns `409 REQUEST_CLOSED`. Treat it as final, not retryable.
- Repeated or concurrent acceptance of an agreed offer returns `{ state: "agreed", order }` for the same order.
- Uploads that take longer than 5 s get `408 UPLOAD_TIMEOUT`.

## Independent tests and shared fixtures

Each owner tests its actual module with disposable fixtures in `tests/platform/`, `tests/agents/`, or `tests/sourcing/`. Integration tests live in `tests/integration/`, owned by Jenya + Codex with cooperation from the others. Test doubles are local test utilities and never become production fake providers.

Use `npm run test:platform`, `npm run test:agents`, `npm run test:sourcing`, and `npm run test:e2e`. All compile the full project so type-level interface drift fails early. Initial TODOs must become substantive tests as features arrive; TODOs are not independent verification.

## Observer stream

Platform serves `GET /observer/ws`, a read-only WebSocket for the observer dashboard: one `log` message per endpoint call, plus `hello` and `dropped` ([observer-stream.md](observer-stream.md)). It is an execution trace, not authoritative state: dashboards read order and payment results from the backend. Bots must not connect to it or receive `OBSERVER_TOKEN`. New operations or fields are added by the platform owner as backward-compatible additions to message version `v: 1`.

The observer page reads `GET /v1/observer/runs[/{runId}]` with an operator-issued `obs_` key scoped to one demo buyer ([runbook](observer-runbook.md)). It is read-only, CORS-limited to `OBSERVER_ALLOWED_ORIGINS`, and maps every field explicitly. Participant tokens are refused there, and observer keys are refused on participant routes. Like `OBSERVER_TOKEN`, observer keys are never given to bots.

## Changing a boundary

Propose the required fields/signature/read route in a PR or issue. Platform owner updates contracts and API description; affected owner updates its consumer in the same coordinated increment. Keep main compiling. This draft deliberately does not pretend that persistence, identity verification, JSON schemas, and event delivery have already been implemented.
