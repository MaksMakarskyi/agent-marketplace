import assert from "node:assert/strict";
import { test } from "node:test";

import { createLivePlatform, NOTICE_NUMBER, type LivePlatform } from "./support/live-platform.js";

/**
 * Scripted stand-in for an actual Grok client: every step is a tool call over /mcp, and the
 * assessment is written by hand from the evidence text, exactly as the client model would.
 */

interface RpcResult {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content?: { type: string; text?: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

let nextId = 1;

async function rpc(token: string, method: string, params: Record<string, unknown> = {}): Promise<RpcResult> {
  const response = await fetch(`${liveUrl()}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return (await response.json()) as RpcResult;
}

let current: LivePlatform | undefined;

function liveUrl(): string {
  if (current === undefined) throw new Error("live platform is not running");
  return current.url;
}

function payload(result: RpcResult): unknown {
  const body = result.result;
  if (body === undefined) throw new Error(`missing result: ${JSON.stringify(result.error)}`);
  if (body.structuredContent !== undefined) return body.structuredContent;
  const text = body.content?.[0]?.text;
  if (text === undefined) throw new Error("missing tool content");
  return JSON.parse(text);
}

async function tool(token: string, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await rpc(token, "tools/call", { name, arguments: args });
  if (result.result?.isError === true) {
    throw new Error(`tool ${name} failed: ${JSON.stringify(result.result)}`);
  }
  return payload(result);
}

async function failingTool(token: string, name: string, args: Record<string, unknown> = {}): Promise<RpcResult> {
  const result = await rpc(token, "tools/call", { name, arguments: args });
  assert.equal(result.result?.isError, true, `${name} should fail`);
  return result;
}

async function withLive(options: Parameters<typeof createLivePlatform>[0], run: (live: LivePlatform) => Promise<void>): Promise<void> {
  const live = await createLivePlatform(options);
  current = live;
  try {
    await run(live);
  } finally {
    current = undefined;
    await live.close();
  }
}

async function buyerUpToRanking(live: LivePlatform, maxMinor = 20_000): Promise<{ discoveryId: string; sourceId: string; requestId: string }> {
  const request = (await tool(live.tokens.buyer, "create_request", {
    category: "components",
    description: "Steel components",
    quantity: 10,
    unit: "box",
    destination: "EU",
    maximumDeliveredTotal: { amountMinor: maxMinor, currency: "EUR" },
    deliverBy: "2099-01-01T00:00:00Z",
    requirements: [{ key: "quality", description: "ISO 9001:2015", mandatory: true }],
    buyerNoticeNumber: NOTICE_NUMBER,
    demo: true,
  })) as { id: string };
  assert.equal(typeof request.id, "string");

  const started = (await tool(live.tokens.buyer, "start_discovery", { requestId: request.id })) as { discoveryId: string };
  const paused = (await tool(live.tokens.buyer, "get_discovery", { discoveryId: started.discoveryId })) as {
    status: string;
    candidates: unknown[];
  };
  assert.equal(paused.status, "running");
  assert.equal(paused.candidates.length, 0, "ranking must wait for the client assessment");

  const evidence = (await tool(live.tokens.buyer, "get_discovery_evidence", {
    discoveryId: started.discoveryId,
  })) as { phase: string; sources: { id: string; url: string }[]; selectedBuyerNoticeNumber: string };
  assert.equal(evidence.phase, "awaiting_agent_assessment");
  assert.equal(evidence.selectedBuyerNoticeNumber, NOTICE_NUMBER);
  assert.equal(evidence.sources.length, 1);

  const sourceId = evidence.sources[0]?.id ?? "";
  const page = (await tool(live.tokens.buyer, "read_discovery_source", {
    discoveryId: started.discoveryId,
    sourceId,
  })) as { text: string; untrusted: boolean; nextOffset: number | null };
  assert.equal(page.untrusted, true);
  assert.match(page.text, /Alpha Components manufactures steel components/);
  assert.equal(page.nextOffset, null);
  return { discoveryId: started.discoveryId, sourceId, requestId: request.id };
}

function assessment(discoveryId: string, sourceId: string): Record<string, unknown> {
  return {
    discoveryId,
    buyerNoticeNumber: NOTICE_NUMBER,
    candidates: [
      {
        company: { name: "Alpha Components", officialDomain: "alpha.example.com" },
        identity: {
          sourceId,
          quotation: "Alpha Components manufactures steel components.",
        },
        claims: [
          { requirementKey: "quality", outcome: "match", sourceId, quotation: "ISO 9001:2015 certified." },
        ],
      },
    ],
  };
}

test("live MCP advertises the 18 low-level tools and hides the fixture runtime", async () => {
  await withLive({}, async (live) => {
    const init = await rpc(live.tokens.buyer, "initialize", { protocolVersion: "2025-06-18" });
    assert.deepEqual((init.result as unknown as { serverInfo: { name: string } }).serverInfo.name, "agent-marketplace-mcp");

    const list = (await rpc(live.tokens.buyer, "tools/list")) as unknown as {
      result: { tools: { name: string; inputSchema: { type?: string; additionalProperties?: boolean } }[] };
    };
    const names = list.result.tools.map((tool) => tool.name);
    assert.equal(names.length, 18);
    for (const hidden of ["start_purchase", "purchase_status", "supplier_status", "supplier_listener_tick", "report_pending"]) {
      assert.equal(names.includes(hidden), false, `${hidden} must not be advertised on the live handler`);
    }
    for (const liveTool of [
      "get_my_participant",
      "search_buyer_notices",
      "get_discovery_evidence",
      "read_discovery_source",
      "submit_discovery_assessment",
      "resolve_discovery_participants",
    ]) {
      const found = list.result.tools.find((tool) => tool.name === liveTool);
      assert.ok(found !== undefined, `${liveTool} must be advertised`);
      assert.equal(found.inputSchema.type, "object");
      assert.equal(found.inputSchema.additionalProperties, false);
    }
  });
});

test("the seven-step buyer sequence works through tools only, with a client-written assessment", async () => {
  await withLive({}, async (live) => {
    const me = (await tool(live.tokens.buyer, "get_my_participant")) as { participantId: string; role: string; registered: boolean };
    assert.equal(me.participantId, "buyer");
    assert.equal(me.role, "buyer");
    assert.equal(me.registered, true);

    const notices = (await tool(live.tokens.buyer, "search_buyer_notices", { query: "steel components", limit: 3 })) as {
      notices: { publicationNumber: string }[];
    };
    assert.equal(notices.notices[0]?.publicationNumber, NOTICE_NUMBER);

    const { discoveryId, sourceId, requestId } = await buyerUpToRanking(live);

    const ranked = (await tool(live.tokens.buyer, "submit_discovery_assessment", {
      discoveryId,
      assessment: assessment(discoveryId, sourceId),
    })) as { status: string; candidates: { eligible: string; rank: number }[] };
    assert.equal(ranked.status, "complete");
    assert.equal(ranked.candidates[0]?.eligible, "yes");
    assert.equal(ranked.candidates[0]?.rank, 1);
    // A different body gets a new idempotency key; the frozen result must reject it.
    await failingTool(live.tokens.buyer, "submit_discovery_assessment", {
      discoveryId,
      assessment: {
        ...assessment(discoveryId, sourceId),
        candidates: [
          {
            ...(assessment(discoveryId, sourceId).candidates as Record<string, unknown>[])[0],
            identity: {
              sourceId,
              quotation: "Alpha Components manufactures steel components. ISO 9001:2015 certified.",
            },
          },
        ],
      },
    });

    const resolved = (await tool(live.tokens.buyer, "resolve_discovery_participants", { discoveryId })) as {
      resolutions: { connected: boolean; participantId?: string }[];
    };
    assert.equal(resolved.resolutions[0]?.connected, true);
    assert.equal(resolved.resolutions[0]?.participantId, "supplier");

    await tool(live.tokens.buyer, "request_quote", { requestId, supplierId: "supplier" });

    const events = (await tool(live.tokens.supplier, "list_events", {})) as {
      events: { type: string; requestId: string }[];
    };
    assert.ok(events.events.some((event) => event.type === "quote_requested"));

    const request = (await tool(live.tokens.supplier, "get_request", { requestId })) as {
      buyerId: string;
      quantity: number;
      unit: string;
      destination: string;
    };
    assert.equal(request.quantity, 10);

    const offer = (await tool(live.tokens.supplier, "submit_offer", {
      requestId,
      quantity: 10,
      unit: "box",
      destination: "EU",
      deliveredTotal: { amountMinor: 1_100, currency: "EUR" },
      taxMinor: 0,
      deliveryMinor: 0,
      deliveryAt: "2026-11-15T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
      confirmedRequirementKeys: ["quality"],
      termsOrigin: "demo-supplier-declaration",
      demo: true,
    })) as { id: string; buyerId: string; supplierId: string };
    assert.equal(offer.buyerId, "buyer");
    assert.equal(offer.supplierId, "supplier");

    const accepted = (await tool(live.tokens.buyer, "accept_offer", { offerId: offer.id })) as {
      state: string;
      order?: { id: string };
    };
    assert.equal(accepted.state, "agreed");
    const orderId = accepted.order?.id ?? "";
    assert.notEqual(orderId, "");

    await tool(live.tokens.buyer, "settle_order", { orderId });
    const order = (await tool(live.tokens.buyer, "get_order", { orderId })) as {
      id: string;
      agreementStatus: string;
      paymentStatus: string;
      sandboxPaymentId?: string;
    };
    assert.equal(order.agreementStatus, "agreed");
    assert.equal(order.paymentStatus, "succeeded");
    assert.equal(order.sandboxPaymentId, "pi_sandbox_agent_fixture");

    // Settlement is idempotent and cannot create a second order.
    await tool(live.tokens.buyer, "settle_order", { orderId });
    const again = (await tool(live.tokens.buyer, "get_order", { orderId })) as { id: string };
    assert.equal(again.id, orderId);
    assert.equal(await live.counts.orders(), 1);
    assert.equal(await live.counts.settlements(), 1);
  });
});

test("a supplier offer outside the buyer mandate is refused and creates no order", async () => {
  await withLive({ buyerMaxOrderMinor: 500, buyerMaxRunMinor: 500, supplierMinMinor: 1_000 }, async (live) => {
    const { discoveryId, sourceId, requestId } = await buyerUpToRanking(live, 500);
    await tool(live.tokens.buyer, "submit_discovery_assessment", {
      discoveryId,
      assessment: assessment(discoveryId, sourceId),
    });
    await tool(live.tokens.buyer, "resolve_discovery_participants", { discoveryId });
    await tool(live.tokens.buyer, "request_quote", { requestId, supplierId: "supplier" });

    await failingTool(live.tokens.supplier, "submit_offer", {
      requestId,
      quantity: 10,
      unit: "box",
      destination: "EU",
      deliveredTotal: { amountMinor: 1_500, currency: "EUR" },
      taxMinor: 0,
      deliveryMinor: 0,
      deliveryAt: "2026-11-15T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
      confirmedRequirementKeys: ["quality"],
      termsOrigin: "demo-supplier-declaration",
      demo: true,
    });

    assert.equal(await live.counts.orders(), 0);
    assert.equal(await live.counts.settlements(), 0);
    await failingTool(live.tokens.buyer, "settle_order", { orderId: "no-such-order" });
  });
});

test("the supplier token cannot read or assess the buyer's discovery", async () => {
  await withLive({}, async (live) => {
    const { discoveryId } = await buyerUpToRanking(live);
    await failingTool(live.tokens.supplier, "get_discovery_evidence", { discoveryId });
    await failingTool(live.tokens.supplier, "submit_discovery_assessment", {
      discoveryId,
      assessment: assessment(discoveryId, `${discoveryId}:source-1`),
    });
  });
});
