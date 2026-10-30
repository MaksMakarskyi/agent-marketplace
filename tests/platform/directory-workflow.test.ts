import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { ActorContext } from "../../src/contracts.js";
import type { Database } from "../../src/platform/database.js";
import { Marketplace } from "../../src/platform/marketplace.js";
import { createPlatformHttp } from "../../src/platform/http.js";
import { ApiEvidenceCollector } from "../../src/sourcing/discovery.js";
import { ProcurementDirectory } from "../../src/sourcing/directory.js";
import { TavilyExtract } from "../../src/sourcing/extract.js";
import { TavilySearch } from "../../src/sourcing/search.js";
import { TedClient } from "../../src/sourcing/ted.js";

const now = () => new Date("2026-10-30T12:00:00.000Z");
const buyer: ActorContext = { participantId: "buyer", role: "buyer", demo: true };
const supplier: ActorContext = { participantId: "supplier", role: "supplier", demo: true };
const buyerUuid = "11111111-1111-4111-8111-111111111111";
const buyerRef = `bzp:${buyerUuid}`;
const buyerNip = "1234567802";
const supplierNip = "9876543210";
const bzpNotice = { noticeType: "ContractNotice", noticeNumber: "2026/BZP 00123456", bzpNumber: "00123456", objectId: buyerUuid,
  publicationDate: "2026-10-30T10:00:00Z", cpvCode: "39121100-7", organizationName: "Example Buyer", organizationCountry: "PL",
  organizationNationalId: buyerNip, orderObject: "Supply of office furniture", submittingOffersDate: "2026-11-15T12:00:00Z" };
const tedAward = { "publication-number": "123456-2026", "publication-date": "2026-10-01+02:00", "notice-type": "can-standard",
  "classification-cpv": ["39100000"], "winner-name": { eng: ["Example Supplier"] }, "winner-identifier": [`PL ${supplierNip.slice(0, 3)} ${supplierNip.slice(3, 6)} ${supplierNip.slice(6, 8)} ${supplierNip.slice(8)}`], "winner-country": ["POL"] };
const requestTerms = { category: "office furniture", description: "office chairs and desks", quantity: 5, unit: "set", destination: "Warsaw",
  maximumDeliveredTotal: { amountMinor: 200000, currency: "PLN" }, deliverBy: "2026-11-20T12:00:00Z",
  requirements: [{ key: "chairs", description: "Office chairs", mandatory: true }], buyerNoticeNumber: buyerRef, demo: true };

async function fixture(options: { buyerNip?: string | null; noticeNip?: string | null; deadline?: string; awardCountry?: string;
  duplicateAwardName?: string; clock?: () => Date } = {}) {
  const fixtureNow = options.clock ?? now;
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated;");
  for (const name of ["20261030120000_initial_schema.sql", "20261030133000_live_marketplace_api.sql", "20261030180000_directory_workflow.sql"]) {
    await db.exec(readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8"));
  }
  await db.exec(`insert into marketplace.operator_grants(id,role,currency,expires_at,allowed_categories,max_order_total_minor,max_run_total_minor,created_by)
    values('gb','buyer','PLN','2099-01-02Z','{"office furniture"}',200000,400000,'fixture');
    insert into marketplace.operator_grants(id,role,currency,expires_at,min_delivered_total_minor,max_available_quantity,created_by)
    values('gs','supplier','PLN','2099-01-02Z',1000,10,'fixture');
    insert into marketplace.participants(id,grant_id,role,company_name,official_domain,public_org_id,registered_at)
    values('buyer','gb','buyer','Example Buyer','buyer.example.com','PL 123-456-78-02',now()),('supplier','gs','supplier','Example Supplier','supplier.example.com','9876543210',now());
    insert into marketplace.mandates(participant_id,role,currency,expires_at,max_order_total_minor,max_run_total_minor,allowed_categories,destination)
    values('buyer','buyer','PLN','2099-01-02Z',200000,400000,'{"office furniture"}','Warsaw');
    insert into marketplace.mandates(participant_id,role,currency,expires_at,min_delivered_total_minor,available_quantity,unit,earliest_delivery_at)
    values('supplier','supplier','PLN','2099-01-02Z',1000,10,'set','2026-01-01Z');`);
  if (options.buyerNip !== undefined) await db.query("update marketplace.participants set public_org_id=$1 where id='buyer'", [options.buyerNip]);
  for (const participant of [buyer, supplier]) await db.query("insert into marketplace.api_credentials(token_hash,participant_id) values($1,$2)",
    [createHash("sha256").update(`fixture-${participant.participantId}-token`).digest("hex"), participant.participantId]);
  await db.exec("set role marketplace_app");
  const database: Database = { query: (sql, params) => db.query(sql, params), transaction: (action) => db.transaction((tx) => action(tx)) };
  const searchQueries: string[] = [];
  const fetcher = async (request: Request) => {
    const url = new URL(request.url);
    if (url.hostname === "ezamowienia.gov.pl") return Response.json([{ ...bzpNotice,
      organizationNationalId: options.noticeNip === undefined ? bzpNotice.organizationNationalId : options.noticeNip,
      submittingOffersDate: options.deadline ?? bzpNotice.submittingOffersDate }]);
    if (url.hostname === "api.ted.europa.eu") {
      const body = await request.json() as Record<string, unknown>;
      if (Array.isArray(body.fields) && (body.fields as string[]).includes("winner-name")) {
        const awards = [{ ...tedAward, "winner-country": [options.awardCountry ?? "POL"] }];
        if (options.duplicateAwardName) awards.push({ ...tedAward, "publication-number": "223456-2026", "winner-name": { eng: [options.duplicateAwardName] },
          "winner-country": [options.awardCountry ?? "POL"] });
        return Response.json({ notices: awards, totalNoticeCount: awards.length, timedOut: false });
      }
      return Response.json({ notices: [{ "publication-number": "123456-2026", "publication-date": "2026-10-30Z", "notice-type": "cn-standard",
        "notice-title": { eng: "Furniture" }, "description-proc": { eng: "Furniture" } }], totalNoticeCount: 1, timedOut: false });
    }
    if (url.hostname === "api.tavily.com" && url.pathname.endsWith("/search")) {
      const body = await request.json() as { query: string; max_results: number };
      searchQueries.push(body.query);
      assert.equal(body.max_results, 1);
      return Response.json({ results: [{ url: "https://supplier.example.com/catalog", title: "Catalog", content: "Example Supplier" }] });
    }
    if (url.hostname === "api.tavily.com") return Response.json({ results: [{ url: "https://supplier.example.com/catalog",
      raw_content: `Example Supplier, NIP PL ${supplierNip.slice(0, 3)} ${supplierNip.slice(3, 6)} ${supplierNip.slice(6, 8)} ${supplierNip.slice(8)}, supplies office chairs. ISO 9001 certified.` }], failed_results: [] });
    assert.fail(`Unexpected URL ${request.url}`);
  };
  const directory = new ProcurementDirectory({ now: fixtureNow, fetch: fetcher });
  const collector = new ApiEvidenceCollector({ now: fixtureNow, ted: new TedClient({ now: fixtureNow, fetch: fetcher }), directory,
    search: new TavilySearch({ now: fixtureNow, fetch: fetcher, access: { mode: "keyless" } }),
    extract: new TavilyExtract({ now: fixtureNow, fetch: fetcher, access: { mode: "keyless" } }) });
  const market = new Marketplace(database, { collector, directory, now: fixtureNow, ted: new TedClient({ now: fixtureNow, fetch: fetcher }) });
  const platform = createPlatformHttp(database, market, { now: fixtureNow });
  return { db, market, platform, searchQueries };
}

test("fixture BZP need and TED award lead flow to exact registered supplier without exposing account availability to ranking", async () => {
  const { db, market, searchQueries } = await fixture();
  try {
    const buyers = await market.searchPublicBuyerNotices(buyer, { cpvCode: "39100000", limit: 5 }) as { entries: { id: string }[] };
    assert.equal(buyers.entries[0]?.id, buyerRef);
    const request = await market.createRequest(buyer, requestTerms, "create-directory-request-1");
    const { discoveryId } = await market.startDiscovery(buyer, request.id, "discover-directory-request-1");
    const evidence = await market.evidence(buyer, discoveryId) as { directorySuppliers: { id: string; company: { publicOrganizationId: string | null } }[];
      directorySearch: { buyerFilters: { publishedFrom: string; publishedTo: string }; supplierFilters: { cpvCode?: string; keywords?: string; publishedFrom: string; publishedTo: string };
        supplierSearches: { supplierId: string; query: string; source: { url: string; retrievedAt: string; contentHash: string } | null }[] } };
    assert.equal(evidence.directorySuppliers.length, 1);
    assert.equal(evidence.directorySuppliers[0]?.company.publicOrganizationId, `PL ${supplierNip.slice(0, 3)} ${supplierNip.slice(3, 6)} ${supplierNip.slice(6, 8)} ${supplierNip.slice(8)}`);
    assert.equal(evidence.directorySearch.supplierFilters.cpvCode, "39100000");
    assert.deepEqual([evidence.directorySearch.buyerFilters.publishedFrom, evidence.directorySearch.buyerFilters.publishedTo], ["2026-10-24", "2026-10-30"]);
    assert.deepEqual([evidence.directorySearch.supplierFilters.publishedFrom, evidence.directorySearch.supplierFilters.publishedTo], ["2025-10-30", "2026-10-30"]);
    assert.equal(searchQueries.length, 1);
    assert.match(searchQueries[0]!, /Example Supplier.*987 654 32 10.*official supplier website/);
    assert.equal(evidence.directorySearch.supplierSearches[0]?.query, searchQueries[0]);
    assert.equal(evidence.directorySearch.supplierSearches[0]?.source?.url, "https://api.tavily.com/search");
    const supplierIdText = `PL ${supplierNip.slice(0, 3)} ${supplierNip.slice(3, 6)} ${supplierNip.slice(6, 8)} ${supplierNip.slice(8)}`;
    const supplierQuotation = `Example Supplier, NIP ${supplierIdText}, supplies office chairs.`;
    const assessment = { discoveryId, buyerNoticeNumber: buyerRef, candidates: [{ company: { name: "Example Supplier", officialDomain: "supplier.example.com", publicOrganizationId: supplierIdText },
      identity: { sourceId: `${discoveryId}:source-1`, quotation: supplierQuotation,
        organizationIdQuotation: supplierQuotation },
      claims: [{ requirementKey: "chairs", outcome: "match", sourceId: `${discoveryId}:source-1`, quotation: "supplies office chairs." }] }] };
    const ranked = await market.submitAssessment(buyer, discoveryId, assessment, "assess-directory-request-1");
    assert.equal(ranked.candidates[0]?.eligible, "yes");
    assert.deepEqual(await db.query("select participant_id from marketplace.candidate_accounts").then((result) => result.rows), []);
    const resolution = await market.resolve(buyer, discoveryId) as { resolutions: { participantId?: string; connected: boolean }[] };
    assert.equal(resolution.resolutions[0]?.participantId, "supplier");
    assert.equal(resolution.resolutions[0]?.connected, true);
    await assert.rejects(market.requestQuote(buyer, request.id, "unregistered", "quote-directory-unmatched-1"), /QUALIFYING|CANDIDATE/i);
    assert.ok(await market.requestQuote(buyer, request.id, "supplier", "quote-directory-request-1"));
    const offer = await market.submitOffer(supplier, { requestId: request.id, quantity: 5, unit: "set", destination: "Warsaw",
      deliveredTotal: { amountMinor: 180000, currency: "PLN" }, taxMinor: 0, deliveryMinor: 0, deliveryAt: "2026-11-15T12:00:00Z",
      expiresAt: "2026-11-14T12:00:00Z", confirmedRequirementKeys: ["chairs"], termsOrigin: "demo-supplier-declaration", demo: true }, "submit-directory-offer-1");
    const order = await market.acceptOffer(buyer, offer.id, "accept-directory-offer-1");
    assert.equal(order.state, "agreed");
  } finally { await db.close(); }
});

test("BZP notice from a different registered organization cannot be used to source a buyer request", async () => {
  const { db, market } = await fixture({ buyerNip: "different-buyer-nip" });
  try {
    await market.searchPublicBuyerNotices(buyer, { cpvCode: "39100000", limit: 5 });
    const request = await market.createRequest(buyer, requestTerms, "create-directory-request-2");
    const { discoveryId } = await market.startDiscovery(buyer, request.id, "discover-directory-request-2");
    assert.equal((await market.getDiscovery(buyer, discoveryId)).status, "failed");
    assert.deepEqual((await market.getDiscovery(buyer, discoveryId)).candidates, []);
  } finally { await db.close(); }
});

test("a BZP notice without a published organization identifier cannot be bound to a registered buyer", async () => {
  const { db, market } = await fixture({ noticeNip: null });
  try {
    await market.searchPublicBuyerNotices(buyer, { cpvCode: "39100000", limit: 5 });
    const request = await market.createRequest(buyer, requestTerms, "create-directory-request-no-notice-nip");
    const { discoveryId } = await market.startDiscovery(buyer, request.id, "discover-directory-request-no-notice-nip");
    assert.equal((await market.getDiscovery(buyer, discoveryId)).status, "failed");
  } finally { await db.close(); }
});

test("a registered buyer without a public organization identifier cannot bind a BZP notice", async () => {
  const { db, market } = await fixture({ buyerNip: null });
  try {
    await market.searchPublicBuyerNotices(buyer, { cpvCode: "39100000", limit: 5 });
    const request = await market.createRequest(buyer, requestTerms, "create-directory-request-no-account-nip");
    const { discoveryId } = await market.startDiscovery(buyer, request.id, "discover-directory-request-no-account-nip");
    assert.equal((await market.getDiscovery(buyer, discoveryId)).status, "failed");
  } finally { await db.close(); }
});

test("a BZP source with a past submission deadline is refused", async () => {
  const { db, market } = await fixture({ deadline: "2026-10-29T12:00:00Z" });
  try {
    await market.searchPublicBuyerNotices(buyer, { cpvCode: "39100000", limit: 5 });
    const request = await market.createRequest(buyer, requestTerms, "create-directory-request-past-deadline");
    const { discoveryId } = await market.startDiscovery(buyer, request.id, "discover-directory-request-past-deadline");
    assert.equal((await market.getDiscovery(buyer, discoveryId)).status, "failed");
  } finally { await db.close(); }
});

test("a live BZP search receipt cannot be replayed by another buyer", async () => {
  const { db, market } = await fixture();
  const otherBuyer: ActorContext = { participantId: "other-buyer", role: "buyer", demo: true };
  try {
    await db.exec("reset role");
    await db.exec(`insert into marketplace.operator_grants(id,role,currency,expires_at,allowed_categories,max_order_total_minor,max_run_total_minor,created_by)
      values('gb-other','buyer','PLN','2099-01-02Z','{"office furniture"}',200000,400000,'fixture');
      insert into marketplace.participants(id,grant_id,role,company_name,official_domain,public_org_id,registered_at)
      values('other-buyer','gb-other','buyer','Other Buyer','other.example.com','other-buyer-nip',now());
      insert into marketplace.mandates(participant_id,role,currency,expires_at,max_order_total_minor,max_run_total_minor,allowed_categories,destination)
      values('other-buyer','buyer','PLN','2099-01-02Z',200000,400000,'{"office furniture"}','Warsaw');`);
    await db.exec("set role marketplace_app");
    await market.searchPublicBuyerNotices(otherBuyer, { cpvCode: "39100000", limit: 5 });
    const request = await market.createRequest(buyer, requestTerms, "create-directory-request-cross-actor");
    await assert.rejects(market.startDiscovery(buyer, request.id, "discover-directory-request-cross-actor"), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "BUYER_NOTICE_SOURCE_REQUIRED");
  } finally { await db.close(); }
});

test("an expired actor-bound BZP search receipt cannot be used for discovery", async () => {
  let instant = new Date("2026-10-30T12:00:00.000Z");
  const { db, market } = await fixture({ clock: () => new Date(instant) });
  try {
    await market.searchPublicBuyerNotices(buyer, { cpvCode: "39100000", limit: 5 });
    const request = await market.createRequest(buyer, requestTerms, "create-directory-request-expired-receipt");
    instant = new Date(instant.getTime() + 10 * 60_000);
    await assert.rejects(market.startDiscovery(buyer, request.id, "discover-directory-request-expired-receipt"), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "BUYER_NOTICE_SOURCE_REQUIRED");
  } finally { await db.close(); }
});

test("directory assessment cannot attach a company identity absent from fresh TED award records", async () => {
  const { db, market } = await fixture();
  try {
    await market.searchPublicBuyerNotices(buyer, { cpvCode: "39100000", limit: 5 });
    const request = await market.createRequest(buyer, requestTerms, "create-directory-request-3");
    const { discoveryId } = await market.startDiscovery(buyer, request.id, "discover-directory-request-3");
    const supplierIdText = `PL ${supplierNip.slice(0, 3)} ${supplierNip.slice(3, 6)} ${supplierNip.slice(6, 8)} ${supplierNip.slice(8)}`;
    const supplierQuotation = `Example Supplier, NIP ${supplierIdText}, supplies office chairs.`;
    const forged = { discoveryId, buyerNoticeNumber: buyerRef, candidates: [{ company: { name: "Other Supplier", officialDomain: "supplier.example.com", publicOrganizationId: "other-id" },
      identity: { sourceId: `${discoveryId}:source-1`, quotation: supplierQuotation, organizationIdQuotation: supplierQuotation }, claims: [] }] };
    await assert.rejects(market.submitAssessment(buyer, discoveryId, forged, "assess-directory-request-3"), /assessment|directory|identity/i);
  } finally { await db.close(); }
});

test("different TED winner names sharing one Polish identifier stay ambiguous instead of being deduplicated", async () => {
  const { db, market, searchQueries } = await fixture({ duplicateAwardName: "Different Supplier Name" });
  try {
    await market.searchPublicBuyerNotices(buyer, { cpvCode: "39100000", limit: 5 });
    const request = await market.createRequest(buyer, requestTerms, "create-directory-request-ambiguous-identity");
    const { discoveryId } = await market.startDiscovery(buyer, request.id, "discover-directory-request-ambiguous-identity");
    assert.ok(searchQueries.some((query) => query.includes("Example Supplier")));
    assert.ok(searchQueries.some((query) => query.includes("Different Supplier Name")));
    const supplierIdText = `PL ${supplierNip.slice(0, 3)} ${supplierNip.slice(3, 6)} ${supplierNip.slice(6, 8)} ${supplierNip.slice(8)}`;
    const supplierQuotation = `Example Supplier, NIP ${supplierIdText}, supplies office chairs.`;
    const assessment = { discoveryId, buyerNoticeNumber: buyerRef, candidates: [{ company: { name: "Example Supplier", officialDomain: "supplier.example.com", publicOrganizationId: supplierIdText },
      identity: { sourceId: `${discoveryId}:source-1`, quotation: supplierQuotation, organizationIdQuotation: supplierQuotation }, claims: [] }] };
    await assert.rejects(market.submitAssessment(buyer, discoveryId, assessment, "assess-directory-request-ambiguous-identity"), /assessment|directory|identity/i);
  } finally { await db.close(); }
});

test("a TED supplier identifier reported only for another country cannot support a Polish account identity", async () => {
  const { db, market } = await fixture({ awardCountry: "DEU" });
  try {
    await market.searchPublicBuyerNotices(buyer, { cpvCode: "39100000", limit: 5 });
    const request = await market.createRequest(buyer, requestTerms, "create-directory-request-foreign-award");
    const { discoveryId } = await market.startDiscovery(buyer, request.id, "discover-directory-request-foreign-award");
    const supplierIdText = `PL ${supplierNip.slice(0, 3)} ${supplierNip.slice(3, 6)} ${supplierNip.slice(6, 8)} ${supplierNip.slice(8)}`;
    const supplierQuotation = `Example Supplier, NIP ${supplierIdText}, supplies office chairs.`;
    const assessment = { discoveryId, buyerNoticeNumber: buyerRef, candidates: [{ company: { name: "Example Supplier", officialDomain: "supplier.example.com", publicOrganizationId: supplierIdText },
      identity: { sourceId: `${discoveryId}:source-1`, quotation: supplierQuotation, organizationIdQuotation: supplierQuotation }, claims: [] }] };
    await assert.rejects(market.submitAssessment(buyer, discoveryId, assessment, "assess-directory-request-foreign-award"), /assessment|directory|identity/i);
  } finally { await db.close(); }
});

test("a claim citing a non-issued source ID is downgraded to unknown", async () => {
  const { db, market } = await fixture();
  try {
    await market.searchPublicBuyerNotices(buyer, { cpvCode: "39100000", limit: 5 });
    const request = await market.createRequest(buyer, requestTerms, "create-directory-request-source-id");
    const { discoveryId } = await market.startDiscovery(buyer, request.id, "discover-directory-request-source-id");
    const supplierIdText = `PL ${supplierNip.slice(0, 3)} ${supplierNip.slice(3, 6)} ${supplierNip.slice(6, 8)} ${supplierNip.slice(8)}`;
    const supplierQuotation = `Example Supplier, NIP ${supplierIdText}, supplies office chairs.`;
    const assessment = { discoveryId, buyerNoticeNumber: buyerRef, candidates: [{ company: { name: "Example Supplier", officialDomain: "supplier.example.com", publicOrganizationId: supplierIdText },
      identity: { sourceId: `${discoveryId}:source-1`, quotation: supplierQuotation,
        organizationIdQuotation: supplierQuotation },
      claims: [{ requirementKey: "chairs", outcome: "match", sourceId: `${discoveryId}:unissued`, quotation: "supplies office chairs." }] }] };
    const ranked = await market.submitAssessment(buyer, discoveryId, assessment, "assess-directory-request-source-id");
    assert.equal(ranked.candidates[0]?.eligible, "conditional");
    assert.equal(ranked.candidates[0]?.candidate.claims[0]?.outcome, "unknown");
  } finally { await db.close(); }
});

test("authenticated MCP advertises the BZP search tool and invokes its live-source path", async () => {
  const { db, market, platform } = await fixture();
  const call = (path: string, body: unknown) => platform.handle(new Request(`https://market.example${path}`, {
    method: "POST", headers: { authorization: "Bearer fixture-buyer-token", "content-type": "application/json", "idempotency-key": "mcp-directory-key-1" },
    body: JSON.stringify(body),
  }));
  try {
    const listed = await call("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (await listed.json() as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    assert.ok(names.includes("search_public_buyer_notices"));
    const viaMcp = await call("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_public_buyer_notices", arguments: { cpvCode: "39100000" } } });
    const result = await viaMcp.json() as { result: { isError: boolean; structuredContent: { entries: { id: string }[] } } };
    assert.equal(result.result.isError, false);
    assert.equal(result.result.structuredContent.entries[0]?.id, buyerRef);
    const combinedFilters = await call("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_public_buyer_notices", arguments: { cpvCode: "39100000", keywords: "office furniture" } } });
    assert.equal(((await combinedFilters.json() as { result: { isError: boolean } }).result).isError, false);
    const missingFilters = await call("/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_public_buyer_notices", arguments: {} } });
    assert.equal(((await missingFilters.json() as { result: { isError: boolean } }).result).isError, true);
    const viaHttp = await call("/v1/sources/public-buyer-notices/search", { keywords: "office furniture", publishedFrom: "2026-10-01", publishedTo: "2026-10-30" });
    assert.equal(viaHttp.status, 200);
    const explicitSearch = await viaHttp.json() as { entries: { id: string }[]; source: { url: string } };
    assert.equal(explicitSearch.entries[0]?.id, buyerRef);
    assert.equal(new URL(explicitSearch.source.url).searchParams.get("PublicationDateFrom"), "2026-10-01T00:00:00Z");
    assert.equal(new URL(explicitSearch.source.url).searchParams.get("PublicationDateTo"), "2026-10-30T23:59:59.999Z");
    const invalidRange = await call("/v1/sources/public-buyer-notices/search", { keywords: "office furniture", publishedFrom: "2025-10-29", publishedTo: "2026-10-30" });
    assert.equal(invalidRange.status, 400);
    assert.deepEqual(await market.searchPublicBuyerNotices(supplier, { cpvCode: "39100000" }).catch((error) => error.code), "FORBIDDEN");
  } finally { await db.close(); }
});
