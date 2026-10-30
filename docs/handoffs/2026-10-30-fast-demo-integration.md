# Backend deployment and automatic demo onboarding

Jenya's latest requirement: two bots open the backend link and create their own simulated company profiles. No person should issue or paste connection keys. The public dashboard automatically observes the platform's demo runs, without selecting a buyer.

## Completed integration to deploy

- Public `GET /v1/demo-observer/runs`, `/v1/demo-observer/runs/{runId}` and `/v1/demo-observer/activity`. No key, configured buyer or expiry is needed. The first two use the existing observer JSON format. Activity returns `{ activities: [...] }`; it is a bounded in-memory feed, not authoritative transaction state. CORS allows `https://agentmarketplace.pages.dev` by default. `PUBLIC_DEMO_OBSERVER=false` disables the public view.
- Live BZP search through MCP `search_public_buyer_notices` and authenticated `POST /v1/sources/public-buyer-notices/search`. It accepts CPV and/or keywords, optional dates, and a bounded limit. Recent searches produce actor-bound receipts; the exact returned `bzp:<UUID>` is the request's `buyerNoticeNumber`.
- Discovery re-fetches the buyer source, checks its Polish organization identifier, collects historical TED supplier leads and winner-specific official-site evidence, then waits for the client agent's source-bound assessment. Registered accounts are checked only after ranking. Existing quote, counteroffer, acceptance, order and sandbox-payment operations follow.
- Additive migration: `supabase/migrations/20261030180000_directory_workflow.sql`. Keep the previous observer migration applied too.

## Backend owner: parallel work

1. Implement public demo enrollment and automatic session identity for the actual Grok/Instinct transport. The bots create their own profiles; a person must not provision participant keys or company records. Preserve separate buyer/supplier identities and sandbox-only transactions. Existing participant endpoints still require credentials until this separate change lands.
2. Own new enrollment files, a separate additive migration and its tests. Coordinate shared HTTP/MCP changes with the integration owner instead of replacing its routes. No duplicate source connector or observer implementation is needed.
3. Automate required saved Stripe test-payment setup. Never ask users for real card details or give bots provider/cloud secrets. Use the existing settlement service and webhook flow.
4. After integration review, apply the reviewed migrations and deploy the exact verified revision to the existing Cloud Run backend. Preserve existing secrets, database settings and webhook configuration. The current Codex account cannot access the backend project, so the existing owner must perform deployment.

Backend: https://agent-marketplace-282760894344.europe-west1.run.app

Dashboard: https://agentmarketplace.pages.dev

## Verify on the host

- Public run list returns 200 and the exact Pages CORS header, with an empty list before the first request.
- Two separate bot clients connect and create their profiles without manual keys. Neither can act as the other.
- A fresh source-backed request appears on the page; sources, frozen comparison and subsequent account lookup are visible.
- Supplier responds, agents can counter or refuse, both accept the same revision before an order, and payment status comes from the existing sandbox settlement records.
- Repeat with incompatible terms: no false success and no payment.

Report the deployed commit and actual observed outcomes. Local fixture checks, a healthy endpoint and the static dashboard do not establish hosted end-to-end readiness.
