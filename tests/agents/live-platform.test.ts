import assert from "node:assert/strict";
import { test } from "node:test";

import { PlatformClient } from "../../src/agents/client.js";
import { createLivePlatform, fixtureAssessment, NOTICE_NUMBER } from "./support/live-platform.js";

test("live fixture: authenticated buyer collects evidence, assesses and resolves the supplier", async () => {
  const live = await createLivePlatform();
  try {
    const buyer = new PlatformClient({ baseUrl: live.url, token: live.tokens.buyer });

    const me = (await buyer.getMyParticipant()) as { participantId?: string; role?: string };
    assert.equal(me.participantId, "buyer");
    assert.equal(me.role, "buyer");

    const request = await buyer.createRequest({
      category: "components",
      description: "Steel components",
      quantity: 10,
      unit: "box",
      destination: "EU",
      maximumDeliveredTotal: { amountMinor: 20_000, currency: "EUR" },
      deliverBy: "2099-01-01T00:00:00Z",
      requirements: [{ key: "quality", description: "ISO 9001:2015", mandatory: true }],
      buyerNoticeNumber: NOTICE_NUMBER,
      demo: true,
    });
    assert.equal(request.buyerNoticeNumber, NOTICE_NUMBER);

    const { discoveryId } = await buyer.startDiscovery(request.id);
    const paused = await buyer.getDiscovery(discoveryId);
    assert.equal(paused.status, "running");
    assert.deepEqual(paused.candidates, []);

    const evidence = (await buyer.getDiscoveryEvidence(discoveryId)) as {
      phase: string;
      sources: { id: string; url: string }[];
      selectedBuyerNoticeNumber: string;
    };
    assert.equal(evidence.phase, "awaiting_agent_assessment");
    assert.equal(evidence.selectedBuyerNoticeNumber, NOTICE_NUMBER);
    assert.equal(evidence.sources.length, 1);

    const sourceId = evidence.sources[0]?.id ?? "";
    const page = (await buyer.readDiscoverySource(discoveryId, sourceId)) as { text: string; untrusted: boolean };
    assert.match(page.text, /ISO 9001:2015 certified/);
    assert.equal(page.untrusted, true);

    const ranked = await buyer.submitDiscoveryAssessment(discoveryId, fixtureAssessment(discoveryId));
    assert.equal(ranked.status, "complete");
    assert.equal(ranked.candidates[0]?.eligible, "yes");
    assert.equal(ranked.candidates[0]?.candidate.company.officialDomain, "alpha.example.com");

    const resolved = (await buyer.resolveDiscoveryParticipants(discoveryId)) as {
      resolutions: { connected: boolean; participantId?: string }[];
    };
    assert.equal(resolved.resolutions[0]?.connected, true);
    assert.equal(resolved.resolutions[0]?.participantId, "supplier");
  } finally {
    await live.close();
  }
});
