# Observer workstream

Owner: dashboard contributor with platform support. The observer is a read-only display of the
backend's current run state; it never starts or changes a transaction.

## Existing authenticated observer

The page in `dashboard/` is deployed at https://agentmarketplace.pages.dev. It shows a selected
buyer's run, public-source receipts, comparison, account lookup, offers, acceptance, order and
authoritative sandbox-payment status. It polls the authenticated API using an operator-issued
observer key; the live endpoint log uses the separate `OBSERVER_TOKEN`. The two credentials must
stay private and are never sent to the bots.

The authenticated projection, one-buyer scope, redaction, expiry, read-only behavior and exact-origin
CORS have local fixture coverage in `tests/platform/observer-projection.test.ts` and
`tests/platform/observer.test.ts`. Migrations and several backend operations were exercised locally
against disposable Postgres/PGlite. That does not verify this observer against the hosted live run.

## Public demo view

`src/platform/public-demo-observer.ts` serves a read-only demo view at
`/v1/demo-observer/runs`, `/v1/demo-observer/runs/{runId}`, and `/v1/demo-observer/activity`.
The run list shows the latest 20 requests from all registered demo buyers. A detail request resolves
its buyer from the stored request on the server; the URL cannot select an account. Activity contains
only recent authenticated buyer/supplier API or MCP actions, projected through an allowlist. It
omits participant IDs, messages, request bodies, polling, observer/system traffic and Stripe
webhooks. This route never grants trade or payment access.

Public view is enabled by default on this demo platform and accepts GET only. It can be disabled with
`PUBLIC_DEMO_OBSERVER=false`. If no browser origins are configured, CORS permits the Pages dashboard
origin only. The existing keyed observer and separate global WebSocket token are unchanged.

Four isolated local tests pass for visibility across two buyers, server-side run scope, sensitive
field exclusion, read-only methods, the redacted activity view, Pages CORS and explicit disablement.
They use the real projection on disposable PGlite and do not establish hosted deployment readiness.
The owner must still verify the actual frontend against the service and rehearse real bot runs.

The dashboard contributor merged keyless startup through PR #24 (`5077649`) and reports it deployed.
Its matching backend routes still need deployment; local tests do not prove the hosted connection.

## Remaining acceptance

- Verify that newly created registered demo buyers appear automatically, without operator selection.
- Review the dashboard and check desktop/mobile, connection loss/retry, and that it shows no
  credentials or private mandates.
- Verify exact deployed revisions, environment configuration, and required migrations with the
  operator. Do not call the demo ready until two real bot clients produce a live run.
- During rehearsal verify the page reflects agreement, refusal and Stripe's provider-confirmed
  sandbox result from backend records.

Public directory discovery and the selected case are separate workstreams. The observer must show
what the backend actually records and must not manufacture sources, candidates, agreement or payment.
