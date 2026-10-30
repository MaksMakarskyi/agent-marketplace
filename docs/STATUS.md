# Shared project state

Updated 30 October 2026 for the BZP/TED workflow and public observer integration. This describes the verified source tree, not a claim of deployed readiness. Dashboard main is through PR #24 (`5077649`); the new backend revision still needs publication/deployment.

## Implemented in code

- Persistent participant-scoped HTTP and 18-tool MCP workflow backed by Postgres, hashed operator-provisioned credentials and bounded mandates.
- Live public TED buyer retrieval and optional Tavily source reads, discovery-bound client assessments, immutable evidence/ranking, post-ranking domain-based connected-account lookup.
- Simulated quote/offer exchange, exact-revision acceptances, one order and existing Stripe sandbox settlement/webhook library. Hosted provider confirmation remains unverified.
- BZP/TED directories are connected through authenticated HTTP/MCP: recent buyer search, actor-bound ten-minute receipts, source-native buyer selection, live re-fetch, Polish identifier checks, TED award leads, bounded winner-specific official-site searches, source-bound client assessments, frozen ranking, exact domain/ID account resolution and existing quote/offer flow. Additive migration `20261030180000_directory_workflow.sql` is required. No registered-account availability enters retrieval or ranking.
- Shared live agent instructions at `/agent.txt`, `/llms.txt` and live MCP initialization; conservative text when platform wiring is absent.
- Existing bot runtimes/protocol fixtures and separate-client setup documentation. Their presence does not establish actual Grok/Instinct account compatibility.
- Observer: the keyless page polls public `GET /v1/demo-observer/runs[/{id}]` for all recent demo runs, without buyer selection. `GET /v1/demo-observer/activity` exposes a bounded redacted projection of authenticated bot actions. Pages CORS is allowed by default; private mandates, credentials and payment methods are excluded. Existing keyed observer API and WebSocket remain separate. Backend deployment remains pending.

## Evidence and limits

Latest integrated local check (30 October, based on main `5077649`): `npm run check` passed typecheck and **371 tests**, with **0 failures, 5 opt-in Postgres skips and 7 existing TODOs**. The new directory workflow passed 12 focused tests. Fresh scoped reviews accepted the public observer and directory integration after fixes for conflicting supplier identities, combined filters and legacy TED compatibility. Native BZP/TED API reads also succeeded, but no hosted bot registration, migration application, matched deal or settlement was performed by this integration run.

After combining main's automatic onboarding (PR #25, `b70d3dc`), typecheck passed and the full suite with `--test-concurrency=2` passed **376 tests**, **0 failures/cancellations**, **5 skips and 7 TODOs**. The default parallel run had one existing observer fixture exceed its ten-second timeout; the bounded rerun exercised every test successfully. A fresh scoped review accepted the additive HTTP/server merge. Direct Cloud Run access for this session returned `403 run.services.list`; deployment remains with the existing project owner.

The source-adapter revision passed typecheck and 316 fixture tests, with 4 explicit TODOs and no failures/cancellations. Four PR CI groups passed. The final main-compatible instruction revision passed typecheck and 318 tests, with 4 explicit TODOs and no failures/cancellations. Fresh scoped source/integration/instruction reviews returned ship; the documented ingress and hosted acceptance limitations remain. Fresh anonymous adapter reads returned current buyer notices and historical supplier leads; source receipts are in the supplier-data notes. An independent scoped adapter review found no blocker.

Local PGlite/mocked-provider tests do not prove hosted migrations, real concurrent Postgres behavior, two actual bot sessions, or provider-confirmed sandbox settlement. Do not advertise `marketplaceReady: true` from these checks. There is no automatic startup migration or in-memory production fallback.

## Remaining owner tasks

1. Backend operator: review/apply `20261030180000_directory_workflow.sql` and deploy the verified backend integration. The current Codex Google Cloud account cannot access project number `282760894344`; deployment needs the existing project owner.
2. Bot developer: verify actual products/versions and two scoped connections; keep supplier execution active, submit source-bound assessments, read authoritative outcomes and report accurately in each client chat. No email or real-company outreach.
3. Dashboard developer: the read-only page is implemented ([observer workstream](workstreams/observer.md)). Verify it against the hosted service once task 4 is done, then rehearse the three minutes with both bot clients. Request to the source owner: record the query's `cpvCodes` in the evidence bundle when the structured directory is mounted.
4. Backend owner: automatic public demo onboarding is merged in PR #25 and combined with this integration. Apply `20261030190000_demo_onboarding.sql` too. MCP initialization creates a session; a bot then registers its own company profile, and subsequent calls use that session automatically. Buyer Stripe test-card setup is attempted by the backend. Actual client compatibility and hosted payment success remain unverified. The public observer needs no observer token, configured buyer or issued read key. Keep one instance if relying on the in-memory activity feed.
5. Jenya/team: qualify primary/backup scenarios and complete success/refusal rehearsals. The challenge deck requires an autonomous closed deal; a discovery-only visualization does not meet that requirement. Organizer acceptance of sandbox settlement and prior-run receipts remains unconfirmed.

Jev is assessed as an optional relevance/CPV-choice experiment only, not integrated or required. No model call, key access or billing operation was performed by that assessment. See [ADR 0001](architecture/0001-lean-procurement-directory.md), [source evidence](supplier-data-sources.md) and [owner handoffs](handoffs/2026-10-30-integration-owners.md).
