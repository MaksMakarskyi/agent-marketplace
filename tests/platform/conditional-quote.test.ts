import assert from "node:assert/strict";
import { test } from "node:test";
import { buyer, supplier, fixture, requestInput, offerTerms } from "./support/live-fixture.js";

test("a verified conditional supplier can clarify commercial terms by quote, without automatic agreement or payment", async () => {
  const f = await fixture();
  try {
    const request = await f.market.createRequest(buyer, { ...requestInput, deliverBy: "2026-11-13T12:00:00Z",
      requirements: [{ key: "lead_time", description: "Delivered within fourteen days", mandatory: true }] }, "conditional-create");
    const { discoveryId } = await f.market.startDiscovery(buyer, request.id, "conditional-discover");
    const result = await f.market.submitAssessment(buyer, discoveryId, { discoveryId, buyerNoticeNumber: requestInput.buyerNoticeNumber,
      candidates: [{ company: { name: "Alpha Components", officialDomain: "alpha.example.com" },
        identity: { sourceId: `${discoveryId}:source-1`, quotation: "Alpha Components manufactures steel components." },
        claims: [{ requirementKey: "lead_time", outcome: "unknown" }] }] }, "conditional-assess");
    assert.equal(result.candidates[0]?.eligible, "conditional");
    await f.market.resolve(buyer, discoveryId);
    await f.market.requestQuote(buyer, request.id, supplier.participantId, "conditional-quote");
    assert.ok((await f.market.events(supplier)).events.some((event) => event.type === "quote_requested"));
    assert.equal((await f.db.query<{ n: number }>("select count(*)::int as n from marketplace.orders")).rows[0]?.n, 0);
    const terms = offerTerms(request.id, 15000, { deliveryAt: "2026-11-06T12:00:00Z", confirmedRequirementKeys: [] });
    await assert.rejects(f.market.submitOffer(supplier, terms, "conditional-unconfirmed"));
    const offer = await f.market.submitOffer(supplier, { ...terms, confirmedRequirementKeys: ["lead_time"] }, "conditional-confirmed");
    assert.equal((await f.db.query<{ n: number }>("select count(*)::int as n from marketplace.orders")).rows[0]?.n, 0);
    const accepted = await f.market.acceptOffer(buyer, offer.id, "conditional-accept");
    assert.equal(accepted.state, "agreed");
    if (accepted.state === "agreed") assert.equal(accepted.order.paymentStatus, "not_started");
  } finally { await f.db.close(); }
});

test("a proven mismatch remains ineligible for a quote even when its supplier account is connected", async () => {
  const f = await fixture({ sourceText: "Alpha Components manufactures steel components. We do not offer delivery within fourteen days." });
  try {
    const request = await f.market.createRequest(buyer, { ...requestInput,
      requirements: [{ key: "lead_time", description: "Delivered within fourteen days", mandatory: true }] }, "mismatch-create");
    const { discoveryId } = await f.market.startDiscovery(buyer, request.id, "mismatch-discover");
    const result = await f.market.submitAssessment(buyer, discoveryId, { discoveryId, buyerNoticeNumber: requestInput.buyerNoticeNumber,
      candidates: [{ company: { name: "Alpha Components", officialDomain: "alpha.example.com" },
        identity: { sourceId: `${discoveryId}:source-1`, quotation: "Alpha Components manufactures steel components." },
        claims: [{ requirementKey: "lead_time", outcome: "mismatch", sourceId: `${discoveryId}:source-1`, quotation: "We do not offer delivery within fourteen days." }] }] }, "mismatch-assess");
    assert.equal(result.candidates[0]?.eligible, "no");
    await f.market.resolve(buyer, discoveryId);
    await assert.rejects(f.market.requestQuote(buyer, request.id, supplier.participantId, "mismatch-quote"));
    assert.equal((await f.db.query<{ n: number }>("select count(*)::int as n from marketplace.quote_requests")).rows[0]?.n, 0);
  } finally { await f.db.close(); }
});

test("a newer mandatory mismatch cannot be bypassed with an older conditional ranking", async () => {
  const f = await fixture({ sourceText: "Alpha Components manufactures steel components. We do not offer delivery within fourteen days." });
  try {
    const request = await f.market.createRequest(buyer, { ...requestInput,
      requirements: [{ key: "lead_time", description: "Delivered within fourteen days", mandatory: true }] }, "newest-create");
    for (const [index, outcome] of ["unknown", "mismatch"].entries()) {
      const { discoveryId } = await f.market.startDiscovery(buyer, request.id, `newest-discover-${index}`);
      await f.market.submitAssessment(buyer, discoveryId, { discoveryId, buyerNoticeNumber: requestInput.buyerNoticeNumber,
        candidates: [{ company: { name: "Alpha Components", officialDomain: "alpha.example.com" },
          identity: { sourceId: `${discoveryId}:source-1`, quotation: "Alpha Components manufactures steel components." },
          claims: [{ requirementKey: "lead_time", outcome, ...(outcome === "mismatch" ? {
            sourceId: `${discoveryId}:source-1`, quotation: "We do not offer delivery within fourteen days." } : {}) }] }] }, `newest-assess-${index}`);
      await f.market.resolve(buyer, discoveryId);
    }
    await assert.rejects(f.market.requestQuote(buyer, request.id, supplier.participantId, "newest-quote"));
    assert.equal((await f.db.query<{ n: number }>("select count(*)::int as n from marketplace.quote_requests")).rows[0]?.n, 0);
  } finally { await f.db.close(); }
});
