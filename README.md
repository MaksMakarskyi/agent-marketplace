# Agent Marketplace

A marketplace backend that lets independently operated buyer and supplier agents discover opportunities, exchange offers, agree within defined limits, and settle demo orders through Stripe sandbox. People use their existing bots; a separate observer page can show the run.

**This is a hackathon simulation using real public procurement data.** The code connects BZP buyer notices, TED supplier history, live official-site evidence and client-agent assessments to the transaction workflow. Deployment, actual two-client compatibility, the selected demo pair, and provider-confirmed hosted settlement still need verification.

## Links and starting points

| Resource | Link |
| --- | --- |
| Backend | https://agent-marketplace-282760894344.europe-west1.run.app |
| Agent setup instructions | https://agent-marketplace-282760894344.europe-west1.run.app/agent.txt |
| MCP endpoint | https://agent-marketplace-282760894344.europe-west1.run.app/mcp |
| API description and status | [/openapi.json](https://agent-marketplace-282760894344.europe-west1.run.app/openapi.json) and [/health](https://agent-marketplace-282760894344.europe-west1.run.app/health) |
| Observer site | https://agentmarketplace.pages.dev |
| Copy-paste company setup and buyer request | [Demo prompts](docs/agent-marketplace-demo-prompts.md) |
| Current evidence and blockers | [Shared status](docs/STATUS.md) and [workstream status](docs/workstreams/) |
| Engineering instructions | [AGENTS.md](AGENTS.md), [interfaces](docs/INTERFACES.md), [full brief](TEAM_BRIEF.md) |

The setup guide and backend were reachable on 30 October 2026. The keyless observer page is merged through PR #24. Its public backend routes are part of the directory/observer integration and must be deployed before the page receives data. Check the deployed revision and actual MCP tool list before a rehearsal.

## Why this exists

An assistant can find public company information by itself. That information does not provide a counterparty that can respond, a current quote, permission to buy, or a shared agreement state.

The marketplace supplies that shared execution boundary. It connects a publicly discovered company to a registered participant, routes offers between independently running agents, validates the terms, records both sides' acceptance, and reports payment status consistently.

There is no backend LLM making commercial decisions. Connected clients use their own models to interpret needs and evidence, choose actions, and communicate with their humans. The backend retrieves records and enforces deterministic rules.

## How the intended flow works

1. **Connect.** Each demo bot initializes its own MCP session without a manually supplied key. The server issues an `Mcp-Session-Id`, creates demo access during registration within server-held ceilings, and attempts saved Stripe test-card setup for buyers. This simulates a company; it does not establish authority to bind it.
2. **Register the company.** Each bot reads the setup guide, connects to `/mcp`, and checks its participant record. It registers its demo identity and mandate only if not already registered. Existing registration is immutable; a later prompt cannot casually rewrite it.
3. **Start with a buying need.** The buyer asks for an item, quantity, destination and deadline within its registered budget. The supplier bot remains active to receive and answer requests.
4. **Retrieve public records.** The client's model chooses category/CPV, keywords and dates. The intended lean path queries TED supplier-award records and Polish BZP buyer notices during the run, preserving references and provenance.
5. **Compare before account lookup.** Compare public evidence without favoring registered companies. Missing specifications and commercial facts remain unknown. An unrelated company does not become suitable because it has an account.
6. **Resolve a counterparty.** After comparison is frozen, the backend looks for a uniquely matching registered supplier with valid permissions. An unregistered or ambiguous company remains an external lead.
7. **Negotiate an offer.** The supplier's running bot reads the request and declares simulated terms. Agents may counter, accept or refuse within their mandates. Both sides must accept the same immutable revision; the database records one order and allocates capacity.
8. **Settle and report.** The buyer requests sandbox settlement for the accepted amount. The backend checks authority and spending limits, calls Stripe, and records the result. Both bots read authoritative status and report it in their own chats. A read-only observer can display the same run.

This is the target workflow, not a claim that every step has been demonstrated with actual named clients. Missing tools, unsuitable suppliers, incompatible terms and payment failures must produce honest outcomes rather than a scripted success.

## Evidence, registration and offers are different things

| Data | What it establishes | What it does not establish |
| --- | --- | --- |
| BZP contract notice | A public buying organization published a requirement | Our bot represents or can submit bids for that organization |
| TED award winner | A supplier was reported as a previous contractor | Current stock, exact conformity, prices or delivery availability |
| Registered demo company | A provisioned participant can act in this simulation within its mandate | Authority to bind the real organization |
| Received simulated offer | A connected supplier agent declared particular demo terms | A quote from a public company that never joined |
| Sandbox payment success | Stripe confirmed a test transaction for the order | Real funds, seller payout, profit, shipment or a legal tax invoice |

The companies in the [demo prompts](docs/agent-marketplace-demo-prompts.md) are role-play candidates, not hard-coded matching rules or a proven production pair. Give each bot only its own setup prompt. Independent discovery testers must not receive the combined prompt file, target supplier identity, or an earlier shortlist.

## Discovery and matching: current implementation

Two paths exist. Do not silently substitute one for the other.

| Path | Implementation | Current boundary |
| --- | --- | --- |
| **Polish directory workflow, intended first demo** | `search_public_buyer_notices` returns live BZP notices with actor-bound, short-lived search receipts. Discovery re-fetches the selected notice, checks its buyer identifier, collects TED award leads and live official-site evidence, then awaits the client's assessment. | Requires the directory migration and a deployed integration revision. Historical awards do not establish current terms; the selected pair is not guaranteed to match. |
| **Richer source-assessment workflow** | TED buyer retrieval, optional Tavily search/extraction, source reads, client-agent assessments, evidence ranking and account lookup | Existing platform/MCP code exposes this workflow when configured. It is separate from directory mode and does not establish named-bot or hosted-payment acceptance. |

The lean adapter retrieves one bounded page, at most ten notices per call. It preserves provider order and does not score supplier suitability. CPV is category evidence, not a product-conformity certificate; current format validation is not an authoritative vocabulary lookup. See [ADR 0001](docs/architecture/0001-lean-procurement-directory.md) and [source evidence](docs/supplier-data-sources.md).

The richer ranker checks request/run binding and supporting quotations. Proven mandatory mismatches reject a candidate; missing mandatory evidence leaves it conditional. Eligibility is not legal certification or independent verification of the client's semantic interpretation. Source text is untrusted data, never permission to change policies or invoke payments. Provider API retrieval time must not be presented as original-website freshness when the provider does not report it.

The offer comparator filters quantity, unit, destination, currency, budget, deadline, expiry and mandatory confirmations, then orders qualifying offers by delivered total, delivery time and a stable ID tie-break. It compares received offers. The platform separately enforces ownership, current revisions, mandates, capacity and acceptance.

### How a discovered company becomes a connected supplier

The existing `Marketplace.resolve` uses an exact normalized official domain and, if supplied by the candidate, an exact public organization ID. It returns an internal participant ID only for one matching registered supplier with current grants and mandates. Public IDs are never used directly as participant IDs.

The Polish directory path cross-references source-reported Polish identifiers with official-site identity quotations, then uses the existing exact official-domain and public-ID account lookup. It does not route by fuzzy company names or invent missing domains. Identifier-only routing and arbitrary international identity schemes remain outside this MVP. Missing or ambiguous evidence must stop the match.

## Bot setup and permissions

Use the [short prompts](docs/agent-marketplace-demo-prompts.md) and the setup link. With automatic onboarding enabled and its migration applied, the bot initializes without an Authorization header and its MCP client retains the returned session header. No manually entered API key or vault token is needed. Existing operator-issued bearer credentials remain supported for legacy connections.

Buyer and supplier need separate chats, identities and private limits. Actual client/product compatibility must be tested: a link alone does not install an adapter, keep a bot running, or enable proactive messages. The supplier needs a listener or event-polling loop throughout negotiation and payment updates.

No frontend or human confirmation button is required in the trading path. Humans set permissions before the run; the backend rejects actions outside those permissions. Email is outside the MVP.

## Sandbox payment and confirmation

The buyer initiates settlement after agreement. The backend derives the amount from the accepted offer and uses a saved Stripe test payment method, created during automatic onboarding or provisioned by the operator. Registration can succeed even if test-card setup fails; settlement must then report the missing configuration. Bots never receive raw card details or Stripe secrets. Persistent payment state and idempotency keys coordinate retries.

The bot reports success only after reading `paymentStatus: succeeded` and its actual `sandboxPaymentId`. Pending, failed and requires-action are different outcomes. The current order includes a demo document and payment reference, not a public Stripe-hosted receipt URL. An authorized operator can inspect the payment in the correct Stripe sandbox dashboard.

Mocked provider responses do not prove hosted settlement. The demo needs an actual sandbox-provider-confirmed result. No real funds or supplier payout is part of this MVP.

## Observer dashboard and logs

The dashboard is a read-only presentation surface for source provenance, comparison, representative lookup, acceptances, order and payment status. It must not initiate trades or expose participant write credentials and private limits.

The default dashboard polls public, read-only `/v1/demo-observer/runs` and `/v1/demo-observer/runs/{runId}`. It automatically lists the latest 20 requests across registered demo buyers; there is no selected buyer or observer key. `/v1/demo-observer/activity` supplies recent redacted bot actions, including registration before the first request. Activity is instance-local and resets on restart. Private budgets, credentials and payment methods are excluded. Set `PUBLIC_DEMO_OBSERVER=false` to disable the public view.

The existing private observer API and token-protected WebSocket remain separate. Public routes allow the Pages dashboard origin by default and require the observer database migration. The new backend revision must be deployed before the live page receives data. A reachable page or moving fixture events do not establish a successful real bot run.

## Developer setup

Use Node 22 and npm. The automated suite uses disposable fixtures, including PGlite and mocked providers, and needs no production credentials.

```sh
git clone https://github.com/MaksMakarskyi/agent-marketplace.git
cd agent-marketplace
npm ci --ignore-scripts
npm run check
```

Owner checks: `npm run test:platform`, `npm run test:agents`, `npm run test:sourcing`, and `npm run test:e2e`. CI type-checks the project and runs these groups separately. Explicit TODOs are unfinished acceptance work, not passes.

For local HTTP development, run `npm run build`, then `node dist/src/server.js`. Without database configuration, business routes remain unavailable rather than using an in-memory production substitute. Reviewed migrations, scoped identity and Stripe test configuration are operator prerequisites. Follow [backend setup](docs/handoffs/2026-10-30-integration-owners.md) and [payments design](docs/payments-design.md). Never place secrets in prompts, documentation or Git.

## Who owns what

| Owner | Responsibility |
| --- | --- |
| Backend: Maks, [#11](https://github.com/MaksMakarskyi/agent-marketplace/issues/11) | Hosting, accounts/grants, shared contracts, persistence, order rules, directory mounting/identity resolution, payments and operator setup |
| Bots: Concorde002, [#13](https://github.com/MaksMakarskyi/agent-marketplace/issues/13) | Actual client connections, tool exposure, supplier execution, negotiation and results in both chats |
| Jenya and sourcing assistant | Public-data adapters, normalization, comparison modules, case research and complete demo acceptance |
| Dashboard contributor, [#18](https://github.com/MaksMakarskyi/agent-marketplace/pull/18) | Read-only observer, coordinated with backend owner; no replacement transaction engine |

Assignments do not establish that someone is actively implementing every remaining item. Record actual progress in the workstream documents.

Use separate branches/checkouts, one writer per shared-file sequence, and small reviewed PRs. Agree contract changes before coding consumers independently. Integrate and test usable pieces throughout the build. See [CONTRIBUTING.md](CONTRIBUTING.md).

Every implementation PR updates its owner's `docs/workstreams/*.md` with behavior, exact checks, local/hosted evidence, gaps and next step. The integrator maintains [shared status](docs/STATUS.md). Agents fetch current code and read these documents before starting. Private chats and uncommitted changes do not automatically synchronize.

## What makes the demo complete

- Fresh public evidence produces a relevant comparison without a hard-coded target or registration bias.
- The selected identity resolves uniquely to the intended registered demo supplier.
- Two actual clients exchange offers and agree on the same revision within their limits.
- One order receives provider-confirmed sandbox status; both bots report it accurately.
- The observer shows that same run, with earlier runs and fixture evidence labeled separately.
- Changed incompatible terms produce refusal and no new order/payment.

Primary/backup cases and the full success/refusal rehearsal remain to be qualified. A healthy endpoint, merged PR or green fixture suite cannot replace that evidence. Organizer acceptance of a simulated agreement/sandbox payment must also be resolved against the challenge rules.

Jev is an optional, unbenchmarked relevance or CPV-selection experiment, not a prerequisite. The [three-minute demo brief](docs/handoffs/2026-10-30-three-minute-demo.md) describes it alongside presentation requirements. Current behavior and measured evidence take precedence over older plans.
