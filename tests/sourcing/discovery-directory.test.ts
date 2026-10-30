import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActorContext, SourcingRequest } from "../../src/contracts.js";
import { ApiEvidenceCollector } from "../../src/sourcing/discovery.js";
import { ProcurementDirectory } from "../../src/sourcing/directory.js";
import { TavilyExtract } from "../../src/sourcing/extract.js";
import { TavilySearch } from "../../src/sourcing/search.js";

const now = () => new Date("2026-10-30T12:00:00.000Z");
const buyer: ActorContext = { participantId: "buyer", role: "buyer", demo: true };
const buyerRef = "bzp:11111111-1111-4111-8111-111111111111";
const buyerNeed = { noticeType: "ContractNotice", noticeNumber: "2026/BZP 00123456", objectId: buyerRef.slice(4),
  publicationDate: "2026-10-30T10:00:00Z", cpvCode: "39121100-7", organizationName: "Public Buyer",
  organizationCountry: "PL", organizationNationalId: "1234567890", orderObject: "Office desks", submittingOffersDate: "2026-11-15T12:00:00Z" };
const request: SourcingRequest = { id: "request", buyerId: buyer.participantId, category: "office furniture", description: "Office desks",
  quantity: 5, unit: "set", destination: "Warsaw", maximumDeliveredTotal: { amountMinor: 200_000, currency: "PLN" },
  deliverBy: "2026-11-20T12:00:00Z", demo: true, buyerNoticeNumber: buyerRef, requirements: [] };
const suppliers = [
  { name: "Supplier One", nip: "9876543210", id: "PL 987-654-32-10", ref: "123456-2026" },
  { name: "Supplier Two", nip: "9876543211", id: "PL 987-654-32-11", ref: "223456-2026" },
  { name: "Supplier Three", nip: "9876543212", id: "PL 987-654-32-12", ref: "323456-2026" },
];

test("Polish TED leads search multiple pages and extract the later official-site hit within the five-page cap", async () => {
  const extractUrls: string[] = [];
  const searchQueries: string[] = [];
  const fetcher = async (request: Request) => {
    const url = new URL(request.url);
    if (url.hostname === "ezamowienia.gov.pl") return Response.json([buyerNeed]);
    if (url.hostname === "api.ted.europa.eu") {
      const body = await request.json() as { query: string; limit: number };
      if (body.query.includes("winner-country")) {
        assert.match(body.query, /winner-country = POL/);
        return Response.json({ notices: [{ "publication-number": "423456-2026", "publication-date": "2026-10-01+02:00",
          "notice-type": "can-standard", "classification-cpv": ["39121100"], "winner-name": { eng: ["Unsupported ID Supplier"] },
          "winner-identifier": ["not-a-nip"], "winner-country": ["POL"] }, ...suppliers.map((entry) => ({ "publication-number": entry.ref,
          "publication-date": "2026-10-01+02:00", "notice-type": "can-standard", "classification-cpv": ["39121100"],
          "winner-name": { eng: [entry.name] }, "winner-identifier": [entry.id], "winner-country": ["POL"] }))],
          totalNoticeCount: 4, timedOut: false });
      }
      assert.fail(`Unexpected TED query ${body.query}`);
    }
    if (url.hostname === "api.tavily.com" && url.pathname.endsWith("/search")) {
      const body = await request.json() as { query: string; max_results: number };
      assert.equal(body.max_results, 3);
      searchQueries.push(body.query);
      const supplier = suppliers.find((entry) => body.query.includes(entry.name));
      assert.ok(supplier, `search must target a public TED winner: ${body.query}`);
      const profileUrl = supplier.name === "Supplier Two"
        ? "https://pitchbook.com/profiles/company/555"
        : "https://find-and-update.company-information.service.gov.uk/company/555";
      return Response.json({ results: [
        { url: profileUrl, title: "Business profile", content: "Unrelated company registry/profile listing." },
        { url: `https://${supplier.name.toLowerCase().replaceAll(" ", "-")}.example.com/products`, title: `${supplier.name} official website`, content: `Official ${supplier.name} supplier site.` },
        { url: `https://catalog.example.com/${supplier.nip}`, title: "Product catalogue", content: "A catalogue result." },
      ] });
    }
    if (url.hostname === "api.tavily.com" && url.pathname.endsWith("/extract")) {
      const body = await request.json() as { urls: string[] };
      extractUrls.push(...body.urls);
      return Response.json({ results: body.urls.map((sourceUrl) => ({ url: sourceUrl, raw_content: `Public page at ${sourceUrl}` })), failed_results: [] });
    }
    assert.fail(`Unexpected source URL ${request.url}`);
  };
  const directory = new ProcurementDirectory({ fetch: fetcher, now });
  const collector = new ApiEvidenceCollector({ directory,
    search: new TavilySearch({ fetch: fetcher, now, access: { mode: "keyless" } }),
    extract: new TavilyExtract({ fetch: fetcher, now, access: { mode: "keyless" } }), now });
  const bundle = await collector.collect(buyer, request, { discoveryId: "discovery", buyerNoticeNumber: buyerRef,
    buyerDirectoryQuery: { cpvCode: "39121100", publishedFrom: "2026-10-24", publishedTo: "2026-10-30", limit: 5 } });

  assert.equal(bundle.phase, "awaiting_agent_assessment");
  assert.equal(bundle.directoryContext?.supplierQuery.supplierCountry, "POL");
  assert.equal(bundle.directoryContext?.suppliers.length, 3);
  assert.equal(bundle.directoryContext?.supplierSearches.length, 3);
  assert.ok(bundle.directoryContext?.supplierSearches.every((search) => search.hitUrls.length === 2 && search.source !== null));
  assert.equal(searchQueries.length, 3);
  assert.ok(searchQueries.every((query) => !query.includes("Unsupported ID Supplier") && !query.includes("not-a-nip")));
  assert.equal(extractUrls.length, 5);
  assert.ok(extractUrls.includes("https://supplier-one.example.com/products"), "second search hit should be extracted, not just the unrelated top result");
  assert.ok(bundle.sourceErrors.some((error) => /supported ten-digit NIP/i.test(error.message)));
  assert.ok(bundle.sourceErrors.some((error) => /profile result omitted/i.test(error.message)));
  assert.ok(bundle.sources.some((source) => source.url === "https://supplier-one.example.com/products"));
  assert.ok(bundle.sources.every((source) => !/company-information\.service\.gov\.uk|pitchbook\.com/.test(source.url)));
  assert.ok(bundle.sources.every((source) => bundle.directoryContext!.supplierSearches.some((search) => search.hitUrls.includes(source.url))));
});
