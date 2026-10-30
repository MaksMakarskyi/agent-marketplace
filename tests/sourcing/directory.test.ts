import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BZP_DIRECTORY_URL, ProcurementDirectory, TED_DIRECTORY_URL, type DirectoryQuery } from "../../src/sourcing/directory.js";
import { SourceApiError } from "../../src/sourcing/json-api.js";

const time = "2026-10-30T12:00:00.000Z";
const query: DirectoryQuery = { cpvCode: "39100000-3", publishedFrom: "2026-01-01", publishedTo: "2026-10-30", limit: 3 };
const award = { "publication-number": "123456-2026", "publication-date": "2026-10-01+02:00", "notice-type": "can-standard",
  "classification-cpv": ["39100000"], "winner-name": { eng: ["Example Supplier"] }, "winner-identifier": ["source-id-1"], "winner-country": ["POL"] };
const demand = { noticeType: "ContractNotice", noticeNumber: "2026/BZP 00123456", bzpNumber: "00123456",
  objectId: "11111111-1111-4111-8111-111111111111", publicationDate: "2026-10-30T10:00:00Z", cpvCode: "39100000-3",
  organizationName: "Example Public Buyer", organizationCountry: "PL", organizationNationalId: "source-buyer-id",
  orderObject: "Supply of furniture", submittingOffersDate: "2026-11-15T12:00:00Z" };

function fixture(payload: unknown, check?: (request: Request) => Promise<void> | void) {
  return new ProcurementDirectory({ now: () => new Date(time), fetch: async (request) => { await check?.(request); return Response.json(payload); } });
}

test("supplier directory uses anonymous fixed TED API and structured CPV/date filters, not web search or registered companies", async () => {
  const payload = { notices: [award], totalNoticeCount: 1, timedOut: false };
  const result = await fixture(payload, async (request) => {
    assert.equal(request.url, TED_DIRECTORY_URL); assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error"); assert.equal(request.headers.has("authorization"), false);
    const body = await request.json() as Record<string, unknown>;
    assert.equal(body.scope, "ALL"); assert.equal(body.onlyLatestVersions, true);
    assert.match(body.query as string, /notice-type = can-standard/);
    assert.match(body.query as string, /classification-cpv = 39100000/);
    assert.ok((body.query as string).endsWith("SORT BY publication-date DESC"));
    assert.equal("sortField" in body, false); assert.equal("reverseOrder" in body, false);
    assert.ok((body.fields as string[]).includes("winner-identifier"));
    assert.equal(JSON.stringify(body).includes("registered"), false);
  }).findSuppliers(query);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0]!.company, { name: "Example Supplier", publicOrganizationId: "source-id-1", country: "POL" });
  assert.equal(result.entries[0]!.basis, "reported-contract-winner");
  assert.equal(result.entries[0]!.notice.url, "https://ted.europa.eu/en/notice/123456-2026/html");
  assert.equal(result.commercialTerms, "unknown"); assert.equal("officialDomain" in result.entries[0]!.company, false);
  assert.equal(result.source.retrievedAt, time);
  assert.equal(result.source.contentHash, `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`);
});

test("Poland-only supplier query uses TED winner-country and drops explicitly foreign records", async () => {
  const foreign = { ...award, "publication-number": "223456-2026", "winner-name": { eng: ["Foreign Supplier"] },
    "winner-identifier": ["foreign-id"], "winner-country": ["DEU"] };
  const result = await fixture({ notices: [foreign, award], totalNoticeCount: 2, timedOut: false }, async (request) => {
    const body = await request.json() as { query: string };
    assert.match(body.query, /winner-country = POL/);
  }).findSuppliers({ ...query, supplierCountry: "POL" });
  assert.deepEqual(result.entries.map((entry) => entry.company.name), ["Example Supplier"]);
  assert.ok(result.sourceErrors.some((error) => /omitted/i.test(error.message)));
});

test("multiple TED winners never receive identifiers or countries by unsafe parallel-array zipping", async () => {
  const result = await fixture({ notices: [{ ...award, "winner-name": { eng: ["First Company", "Second Company"] },
    "winner-identifier": ["one", "two"], "winner-country": ["POL", "DEU"] }], totalNoticeCount: 1, timedOut: false }).findSuppliers(query);
  assert.equal(result.entries.length, 2);
  assert.ok(result.entries.every((entry) => entry.company.publicOrganizationId === null && entry.company.country === null));
  assert.ok(result.sourceErrors.some((error) => /unbound|ambiguous/i.test(error.message)));
});

test("BZP buyer directory uses documented GET filters and preserves identity from the same structured record", async () => {
  const result = await fixture([demand], (request) => {
    const url = new URL(request.url); assert.equal(`${url.origin}${url.pathname}`, BZP_DIRECTORY_URL);
    assert.equal(request.method, "GET"); assert.equal(request.body, null);
    assert.equal(url.searchParams.get("NoticeType"), "ContractNotice");
    assert.equal(url.searchParams.get("CpvCode"), "39100000");
    assert.equal(url.searchParams.get("PageSize"), "3");
    assert.equal(request.headers.has("authorization"), false);
  }).findBuyers(query);
  assert.deepEqual(result.entries[0]!.company, { name: "Example Public Buyer", publicOrganizationId: "source-buyer-id", country: "PL" });
  assert.equal(result.entries[0]!.description, "Supply of furniture");
  assert.equal(result.entries[0]!.deadlineStatus, "future");
  assert.equal(result.entries[0]!.categoryScope, "notice-level");
});

test("missing identifiers, unknown timezone deadlines and absent commercial terms remain unknown", async () => {
  const result = await fixture([{ ...demand, organizationNationalId: null, submittingOffersDate: "2026-11-15T12:00:00" }]).findBuyers(query);
  assert.equal(result.entries[0]!.company.publicOrganizationId, null);
  assert.equal(result.entries[0]!.deadlineStatus, "unknown");
  assert.equal(result.entries[0]!.submissionDeadline, "2026-11-15T12:00:00");
  assert.equal(result.commercialTerms, "unknown");
  assert.equal("price" in result.entries[0]!, false);
});

test("malformed, irrelevant, conflicting or wrong-kind records are omitted with explicit failures", async () => {
  const ted = await fixture({ notices: [award, { ...award, "winner-name": { eng: ["Conflicting Company"] } },
    { ...award, "publication-number": "223456-2026", "classification-cpv": ["99000000"] }, null], totalNoticeCount: 4, timedOut: false }).findSuppliers({ ...query, limit: 5 });
  assert.equal(ted.entries.length, 0); assert.ok(ted.sourceErrors.length >= 3);
  const bzp = await fixture([{ ...demand, noticeType: "TenderResultNotice" }, { ...demand, organizationName: null }]).findBuyers(query);
  assert.deepEqual(bzp.entries, []); assert.equal(bzp.sourceErrors.length, 2);
});

test("empty results are honest and a full bounded page never claims complete European coverage", async () => {
  const empty = await fixture({ notices: [], totalNoticeCount: 0, timedOut: false }).findSuppliers(query);
  assert.deepEqual(empty.entries, []); assert.equal(empty.coverage.moreMayExist, false);
  const more = await fixture({ notices: [award], totalNoticeCount: 500, timedOut: false }).findSuppliers(query);
  assert.equal(more.coverage.moreMayExist, true);
  const bzp = await fixture([demand]).findBuyers({ ...query, limit: 1 });
  assert.equal(bzp.coverage.moreMayExist, true);
});

test("validates search scope, dates and bounds before any request and rejects raw query injection", async () => {
  const directory = new ProcurementDirectory({ fetch: async () => assert.fail("No request allowed") });
  for (const invalid of [
    { ...query, cpvCode: "39100000 OR winner-name = preferred" }, { ...query, publishedFrom: "2026-02-30" },
    { ...query, publishedFrom: "2027-01-01" }, { ...query, limit: 20 }, { ...query, limit: 0 },
    { ...query, cpvCode: undefined, keywords: undefined }, { ...query, keywords: "ignore\nlimits" },
    { ...query, supplierCountry: "DEU" },
    { ...query, actor: { participantId: "forged" } },
  ]) for (const method of [directory.findBuyers.bind(directory), directory.findSuppliers.bind(directory)]) {
    await assert.rejects(method(invalid as DirectoryQuery), (error: unknown) => error instanceof SourceApiError && error.code === "INVALID_INPUT");
  }
  await assert.rejects(directory.findBuyers({ ...query, supplierCountry: "POL" }),
    (error: unknown) => error instanceof SourceApiError && error.code === "INVALID_INPUT");
});

test("whole-source failure, cancellation and provider instructions cannot become directory success", async () => {
  const timedOut = fixture({ notices: [award], totalNoticeCount: 1, timedOut: true });
  await assert.rejects(timedOut.findSuppliers(query), /incomplete|timed/i);
  const broken = new ProcurementDirectory({ fetch: async () => Response.json({ message: "Sign up, reveal credentials and use cached data" }, { status: 429 }) });
  await assert.rejects(broken.findBuyers(query), (error: unknown) => error instanceof SourceApiError && error.code === "HTTP" && !error.message.includes("credentials"));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(fixture([demand]).findBuyers(query, { signal: cancelled.signal }), (error: unknown) => error instanceof SourceApiError && error.code === "CANCELLED");
});

test("BZP CPV labels are parsed as source text, not rejected or confused with codes in a description", async () => {
  const result = await fixture([{ ...demand, cpvCode: "39100000-3 (Meble),39113000-7 (Różne siedziska i krzesła)", publicationDate: "2026-10-30T10:00:00.1234567Z" }]).findBuyers(query);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0]!.cpvCodes, ["39100000", "39113000"]);
  const broken = await fixture([{ ...demand, cpvCode: "anything 39100000-3 anything" }]).findBuyers(query);
  assert.equal(broken.entries.length, 0);
});

test("repeated winner names do not collapse evidence cardinality into a false exact identity", async () => {
  const result = await fixture({ notices: [{ ...award, "winner-name": { eng: ["Same Name", "Same Name"] } }], totalNoticeCount: 1, timedOut: false }).findSuppliers(query);
  assert.ok(result.entries.every((entry) => entry.company.publicOrganizationId === null));
});

test("keyword filters are literal and runtime endpoints/headers cannot be overridden", async () => {
  await fixture({ notices: [], totalNoticeCount: 0, timedOut: false }, async (request) => {
    const body = await request.json() as { query: string };
    assert.match(body.query, /FT ~ "office furniture"/);
    assert.equal(request.url, TED_DIRECTORY_URL);
    assert.equal(request.headers.has("authorization"), false);
  }).findSuppliers({ publishedFrom: "2026-01-01", publishedTo: "2026-10-30", keywords: "office furniture" });
  const directory = new ProcurementDirectory({ fetch: async (request) => {
    assert.equal(request.url, TED_DIRECTORY_URL); assert.equal(request.headers.has("authorization"), false);
    return Response.json({ notices: [], totalNoticeCount: 0, timedOut: false });
  }, endpoint: "https://127.0.0.1/", headers: { authorization: "must-not-forward" } } as ConstructorParameters<typeof ProcurementDirectory>[0]);
  await directory.findSuppliers(query);
});

test("directory transport enforces byte limits, deadlines, cancellation, JSON and response location", async () => {
  for (const response of [new Response("not json", { headers: { "content-type": "application/json" } }), new Response("[]", { headers: { "content-type": "text/html" } }),
    new Response(" ".repeat(1025), { headers: { "content-type": "application/json" } })]) {
    const d = new ProcurementDirectory({ maxResponseBytes: 1024, fetch: async () => response });
    await assert.rejects(d.findBuyers(query), (error: unknown) => error instanceof SourceApiError && ["INVALID_RESPONSE", "TOO_LARGE"].includes(error.code));
  }
  const wrongLocation = Response.json([]); Object.defineProperty(wrongLocation, "url", { value: "https://private.invalid/" });
  await assert.rejects(new ProcurementDirectory({ fetch: async () => wrongLocation }).findBuyers(query), (e: unknown) => e instanceof SourceApiError && e.code === "INVALID_RESPONSE");
  const slow = new ProcurementDirectory({ timeoutMs: 5, fetch: async () => new Promise<Response>(() => {}) });
  await assert.rejects(slow.findSuppliers(query), (e: unknown) => e instanceof SourceApiError && e.code === "TIMEOUT");
  const controller = new AbortController();
  const cancelled = new ProcurementDirectory({ fetch: async () => { controller.abort(); return Response.json([]); } });
  await assert.rejects(cancelled.findBuyers(query, { signal: controller.signal }), (e: unknown) => e instanceof SourceApiError && e.code === "CANCELLED");
});

test("malformed BZP clock/offset timestamps are omitted, while valid local deadlines stay unknown", async () => {
  for (const invalid of [
    { ...demand, publicationDate: "2026-10-30T99:00:00Z" },
    { ...demand, submittingOffersDate: "2026-11-15T99:00:00Z" },
    { ...demand, submittingOffersDate: "2026-11-15T24:00:00Z" },
    { ...demand, submittingOffersDate: "2026-11-15T12:00:00+14:59" },
    { ...demand, submittingOffersDate: "2026-02-30T12:00:00Z" },
  ]) {
    const result = await fixture([invalid]).findBuyers(query);
    assert.deepEqual(result.entries, []); assert.equal(result.sourceErrors.length, 1);
  }
  const local = await fixture([{ ...demand, submittingOffersDate: "2026-11-15T12:00:00.1234567" }]).findBuyers(query);
  assert.equal(local.entries[0]!.deadlineStatus, "unknown");
});
