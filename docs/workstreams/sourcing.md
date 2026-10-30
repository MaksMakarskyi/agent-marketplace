# Live sourcing and acceptance workstream

Owner: Jenya with Codex. Jenya chooses and judges demo cases; Codex implements retrieval, evidence handling and matching. The platform owner maintains integrated project status in `docs/STATUS.md`.

## Current implementation

The BZP-to-TED source path is now connected to the existing authenticated request, discovery, client-assessment, frozen-ranking, account-resolution and quote workflow.

1. An authenticated buyer calls `POST /v1/sources/public-buyer-notices/search` or MCP `search_public_buyer_notices`. BZP searches default to the last seven calendar days; the client may request an older range up to 365 days. The backend saves the filters and returned references in a ten-minute receipt bound to that buyer.
2. The buyer creates a request using an exact returned `bzp:<UUID>`. Discovery requires an unexpired receipt owned by that buyer, re-runs its saved filters and selects that same notice. It stops if its deadline has passed or the buyer identity cannot be matched.
3. The backend uses the selected notice's broad CPV division to query one TED historical-award page for the last 365 days, independently of the BZP notice date range. For example, CPV `39121100` is broadened to `39100000`. The TED query also uses its `winner-country = POL` search field; the adapter drops records that explicitly report another country. It skips Polish leads without a supported 10-digit NIP, then searches at most three public TED winner names and IDs, retrieving up to three results for each. Known third-party company-profile hosts are excluded from website extraction, the remaining hits are round-robined, and no more than five pages are extracted in one batch. Exact search queries, search API receipts and returned URLs are recorded. The registered-account directory is not an input to retrieval or ranking.
4. The buyer bot assesses only backend-issued website source IDs and exact quotations. In this Poland-only path, a supplier needs a TED award record with country `POL` and a source-reported ten-digit NIP (optional `PL`, spaces and hyphens are normalized); the candidate must quote that identifier on its official-domain source. If TED reports different company names for the same identifier, the identity remains ambiguous and assessment refuses it. Unsupported capability claims remain unknown.
5. The existing ranker freezes evidence results before participant lookup. The platform resolves using the exact official domain and the normalized Polish NIP against an active registered supplier. Ambiguous or unregistered candidates remain external leads. A connected candidate can then receive a quote request.

No fuzzy company-name routing, account enumeration, forced match, invented domain, or backend LLM is added. Historical awards are category leads only. They do not prove current stock, product conformity, price or delivery. Directory source timestamps describe the retrieval API response, not the original notice publisher's own update time. Tavily extraction continues to report `originRetrievedAt: null`.

## Files and interface hooks

- `src/sourcing/directory.ts`: bounded anonymous BZP buyer-notice and TED historical-winner adapters, including the source-native Polish winner-country filter.
- `src/sourcing/discovery.ts` and `assessment.ts`: source-bound BZP/TED collection and client assessment validation.
- `src/platform/marketplace.ts`: persisted actor-bound search receipts, discovery re-fetch and buyer/supplier identity checks, then existing ranking and quote flow.
- `src/mcp/tools.ts`, `backend.ts`, `src/agents/client.ts`, and `instructions.ts`: buyer search tool, HTTP client call, and shared instructions for the live workflow.
- `supabase/migrations/20261030180000_directory_workflow.sql`: allows BZP references and adds the short-lived search-receipt table. The operator must apply this reviewed migration to a hosted database before the hosted tool can work.
- HTTP hook owned by platform integration: `POST /v1/sources/public-buyer-notices/search`; the authenticated MCP tool is `search_public_buyer_notices`. Continue with `create_request`, `start_discovery`, `get_discovery_evidence`, `read_evidence_source`, `submit_discovery_assessment`, `resolve_discovery_participants`, then `request_quote`.

Polish identity normalization is deliberately narrow: the BZP path accepts only a ten-digit identifier after optional `PL` prefix and space/hyphen removal. It does not verify a checksum, validate a government registry, or infer REGON/other national identifiers. A nonmatching or unsupported identifier fails closed. Other countries need explicit identifier schemes before support.

## Local verification

- `npm run build`: passed after the current changes.
- `npm run build && node --test dist/tests/sourcing/directory.test.js dist/tests/sourcing/discovery-directory.test.js dist/tests/integration/agent-assessed-sourcing.test.js`: **27 passed, 0 failed**. Fixtures cover the TED country filter and foreign-record omission; skip unsupported Polish IDs; exclude observed registry/profile hosts; fetch a later supplier-site result after an unrelated top hit; preserve source-query receipts; and enforce the five-page extraction ceiling.
- `npm run build && node --test dist/tests/platform/directory-workflow.test.js dist/tests/integration/agent-assessed-sourcing.test.js`: **24 passed, 0 failed** after the platform-owned fixture was updated to allow three bounded search results per TED lead.
- Sourcing tests use disposable provider fixtures. Separate anonymous, read-only TED requests confirmed the native Poland winner filter and `SORT BY publication-date DESC` ordering, but did not validate a live buyer case or supplier website. No shared database access, hosted migration, credential change, real company contact, payment or deployment occurred. The parent integration owner will run the repository-wide suite and fresh review after integration.

## Remaining work

Coordination checkpoint: this branch is based on `3f9d2de`; Stanisław subsequently added Cloudflare hosting/deployment in `294bca1`. Do not overwrite or independently redeploy that work. The current branch's combined Node fixture checks passed 382 tests, with no failures/cancellations, 5 skips and 7 TODOs. This is not a Cloudflare runtime verification.

Live verification still found an unresolved provider-quality blocker: the patched TED query returned current Polish identities including IDURO, but the automatic website searches/extraction returned unrelated profile pages. Independently fetched IDURO pages show identity/product evidence in the browser, while the provider's extracted text omitted its NIP. No live supplier match, quote invitation, agreement or payment was verified. Treat the retrieval changes as partial investigation, not a completed relevance fix. A follow-up should let the client discover public URLs while the backend fetches them and issues bound source IDs; never accept client-provided trusted source bodies or fabricated provenance.

- Review the integration and apply the additive migration through the authorized operator process; verify the deployed revision exposes the authenticated HTTP/MCP search tools.
- Rehearse with two actual, separately scoped clients. Search live data independently, confirm a plausible supplier appears without exposing registered accounts, have the supplier declare simulated terms, and confirm both bots report the authoritative result. Repeat with incompatible limits and ensure the agents refuse.
- Select primary and backup cases from fresh source evidence. Do not put their identities into agent prompts or public research notes before an independent discovery run. On 2026-10-30, an anonymous read-only TED check using `notice-type = can-standard`, publication dates `2025-10-30` through `2026-10-30`, CPV `39100000`, and `winner-country = POL` returned 10 sampled notices, all reporting `POL`, from 972 matches. This was a filter check only, not retained case evidence. Tavily website retrieval remains bounded and search-index results are leads, not proof of official ownership or capability.
- Hosted bot compatibility, provider-confirmed Stripe sandbox settlement, and full success/refusal rehearsal remain unverified. The source fixture path is not proof of a completed deal.
