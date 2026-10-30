import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runView } from "../../src/platform/observer-runs.js";
import { buyer, fixture, now, requestInput } from "./support/live-fixture.js";

test("observer shows native BZP and TED API receipts without inventing website retrieval times", async () => {
  const f = await fixture();
  try {
    await f.db.exec("reset role");
    await f.db.exec(readFileSync(new URL("../../../supabase/migrations/20261030170000_observer.sql", import.meta.url), "utf8"));
    await f.db.exec("set role marketplace_app");
    const request = await f.market.createRequest(buyer, requestInput, "directory-observer-request");
    const buyerUrl = "https://ezamowienia.gov.pl/mo-board/api/v1/notice?CpvCode=39100000";
    const supplierUrl = "https://api.ted.europa.eu/v3/notices/search";
    const receipt = { retrievedAt: now().toISOString(), contentHash: `sha256:${"a".repeat(64)}` };
    await f.db.query("insert into marketplace.discovery_runs(id,request_id,status,evidence_bundle) values($1,$2,'running',$3)", ["directory-observer-discovery", request.id, JSON.stringify({
      phase: "awaiting_agent_assessment", sources: [], buyerNotices: [], sourceErrors: [],
      directoryContext: { buyer: { company: { name: "Example Buyer" }, cpvCodes: ["39100000"], description: "Desks and chairs",
        notice: { reference: "2026/BZP 00123456", url: "https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/example", publishedOn: "2026-10-30" } },
        buyerSource: { url: buyerUrl, ...receipt }, supplierSource: { url: supplierUrl, ...receipt } },
    })]);
    const view = await runView(f.db, { id: "fixture", buyerParticipantId: buyer.participantId, label: "Fixture", expiresAt: "2026-10-31T12:00:00Z" }, request.id, now(), "local-fixture") as {
      discovery: { collection: { cpvCodes: string[]; sources: { url: string; retrievedAt: string; providerRetrievedAt: string }[]; notices: { publicationNumber: string }[] } };
    };
    const collection = view.discovery.collection;
    assert.deepEqual(collection.cpvCodes, ["39100000"]);
    assert.deepEqual(collection.sources.map((source) => source.url), [buyerUrl, supplierUrl]);
    assert.ok(collection.sources.every((source) => source.retrievedAt === receipt.retrievedAt && source.providerRetrievedAt === receipt.retrievedAt));
    assert.equal(collection.notices[0]?.publicationNumber, "2026/BZP 00123456");
  } finally { await f.db.close(); }
});
