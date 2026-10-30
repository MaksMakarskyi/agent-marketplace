import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  PurchaseToolInput,
  PurchaseToolStatus,
  SupplierToolStatus,
} from "../../src/mcp/gateway.js";
import type {
  DiscoveryResult,
  EventPage,
  Money,
  Offer,
  Order,
  RegistrationInput,
  SourcingRequest,
} from "../../src/contracts.js";
import { createMcpHandler } from "../../src/mcp/gateway.js";
import type { AgentAssessment } from "../../src/sourcing/assessment.js";
import { createMcpBackend } from "../../src/mcp/backend.js";
import type { PlatformToolClient } from "../../src/mcp/backend.js";
import type {
  AcceptanceResult,
  CreateRequestInput,
  McpToolBackend,
  PendingReportResult,
  SubmitOfferInput,
  SupplierTickResult,
} from "../../src/mcp/gateway.js";

const MCP_URL = "https://marketplace.example/mcp";
const TOKEN = "participant-token-super-secret";

interface RpcEnvelope {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolCallResult {
  content?: readonly { type?: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface ToolSummary {
  name: string;
  description: string;
  inputSchema: { type?: string; additionalProperties?: boolean };
}

interface RecordedCall {
  readonly method: string;
  readonly token: string;
  readonly args: readonly unknown[];
}

class BackendFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BackendFailure";
    this.code = code;
  }
}

class StubBackend implements McpToolBackend {
  readonly calls: RecordedCall[] = [];
  failure: Error | null = null;
  tickResult: SupplierTickResult = { handled: ["evt_1"], reports: ["agreed and sandbox-paid"] };
  pendingResult: PendingReportResult = { messages: ["agreed and sandbox-paid"] };

  async registerParticipant(
    token: string,
    input: RegistrationInput,
  ): Promise<{ participantId: string }> {
    this.record("registerParticipant", token, input);
    return { participantId: "buyer_1" };
  }

  async createRequest(token: string, input: CreateRequestInput): Promise<SourcingRequest> {
    this.record("createRequest", token, input);
    return sampleRequest();
  }

  async startDiscovery(token: string, requestId: string): Promise<{ discoveryId: string }> {
    this.record("startDiscovery", token, requestId);
    return { discoveryId: "disc_1" };
  }

  async getDiscovery(token: string, discoveryId: string): Promise<DiscoveryResult> {
    this.record("getDiscovery", token, discoveryId);
    return sampleDiscovery();
  }

  async getMyParticipant(token: string): Promise<unknown> {
    this.record("getMyParticipant", token);
    return { participantId: "buyer_1" };
  }

  async searchBuyerNotices(token: string, query: string, limit?: number): Promise<unknown> {
    this.record("searchBuyerNotices", token, query, limit);
    return { notices: [] };
  }

  async getDiscoveryEvidence(token: string, discoveryId: string): Promise<unknown> {
    this.record("getDiscoveryEvidence", token, discoveryId);
    return { sources: [] };
  }

  async readDiscoverySource(token: string, discoveryId: string, sourceId: string,
    options?: { offset?: number; limit?: number }): Promise<unknown> {
    this.record("readDiscoverySource", token, discoveryId, sourceId, options);
    return { text: "Supplier fixture evidence" };
  }

  async submitDiscoveryAssessment(token: string, discoveryId: string, assessment: AgentAssessment): Promise<DiscoveryResult> {
    this.record("submitDiscoveryAssessment", token, discoveryId, assessment);
    return sampleDiscovery();
  }

  async resolveDiscoveryParticipants(token: string, discoveryId: string): Promise<unknown> {
    this.record("resolveDiscoveryParticipants", token, discoveryId);
    return { participants: [] };
  }

  async requestQuote(
    token: string,
    requestId: string,
    supplierId: string,
  ): Promise<{ eventId: string }> {
    this.record("requestQuote", token, requestId, supplierId);
    return { eventId: "evt_1" };
  }

  async submitOffer(token: string, input: SubmitOfferInput): Promise<Offer> {
    this.record("submitOffer", token, input);
    return sampleOffer();
  }

  async acceptOffer(token: string, offerId: string): Promise<AcceptanceResult> {
    this.record("acceptOffer", token, offerId);
    return { state: "agreed", order: sampleOrder() };
  }

  async settleOrder(token: string, orderId: string): Promise<Order> {
    this.record("settleOrder", token, orderId);
    return sampleOrder();
  }

  async getOrder(token: string, orderId: string): Promise<Order> {
    this.record("getOrder", token, orderId);
    return sampleOrder();
  }

  async listEvents(token: string, after?: string): Promise<EventPage> {
    this.record("listEvents", token, after);
    return { events: [], nextCursor: "cursor_2" };
  }

  async getRequest(token: string, requestId: string): Promise<SourcingRequest> {
    this.record("getRequest", token, requestId);
    return sampleRequest();
  }

  async getOffer(token: string, offerId: string): Promise<Offer> {
    this.record("getOffer", token, offerId);
    return sampleOffer();
  }

  async supplierListenerTick(token: string): Promise<SupplierTickResult> {
    this.record("supplierListenerTick", token);
    return this.tickResult;
  }

  async reportPending(token: string): Promise<PendingReportResult> {
    this.record("reportPending", token);
    return this.pendingResult;
  }

  async startPurchase(token: string, input: PurchaseToolInput): Promise<PurchaseToolStatus> {
    this.record("startPurchase", token, input);
    return { runId: "run_1", state: "running", progress: [] };
  }

  async purchaseStatus(token: string, runId?: string): Promise<PurchaseToolStatus> {
    this.record("purchaseStatus", token, runId);
    return { runId: runId ?? "run_1", state: "done", progress: [], result: "agreed and sandbox-paid — order ord_1" };
  }

  async supplierStatus(token: string): Promise<SupplierToolStatus> {
    this.record("supplierStatus", token);
    return { listening: true, ticks: 3, messages: [] };
  }

  private record(method: string, token: string, ...args: unknown[]): void {
    this.calls.push({ method, token, args });
    if (this.failure !== null) {
      throw this.failure;
    }
  }
}

function sampleMoney(): Money {
  return { amountMinor: 125000, currency: "EUR" };
}

function sampleRequest(): SourcingRequest {
  return {
    id: "req_1",
    buyerId: "buyer_1",
    category: "packaging",
    description: "Recycled cardboard boxes",
    quantity: 10,
    unit: "kg",
    destination: "Berlin",
    maximumDeliveredTotal: sampleMoney(),
    deliverBy: "2026-11-20T09:00:00.000Z",
    requirements: [{ key: "certificate", description: "FSC certificate", mandatory: true }],
    demo: true,
  };
}

function sampleOffer(): Offer {
  return {
    id: "off_1",
    requestId: "req_1",
    buyerId: "buyer_1",
    supplierId: "supplier_1",
    quantity: 10,
    unit: "kg",
    destination: "Berlin",
    deliveredTotal: sampleMoney(),
    taxMinor: 1000,
    deliveryMinor: 500,
    deliveryAt: "2026-11-10T09:00:00.000Z",
    expiresAt: "2026-11-03T09:00:00.000Z",
    confirmedRequirementKeys: ["certificate"],
    termsOrigin: "demo-supplier-declaration",
    demo: true,
  };
}

function sampleOrder(): Order {
  return {
    id: "ord_1",
    acceptedOffer: sampleOffer(),
    agreementStatus: "agreed",
    paymentStatus: "succeeded",
    sandboxPaymentId: "pi_sandbox_123",
    demo: true,
  };
}

function sampleDiscovery(): DiscoveryResult {
  return {
    id: "disc_1",
    requestId: "req_1",
    status: "complete",
    candidates: [],
    sourceErrors: [],
  };
}

function post(payload: unknown, token: string | null = TOKEN): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return new Request(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

function postRaw(body: string, headers: Record<string, string>): Request {
  return new Request(MCP_URL, { method: "POST", headers, body });
}

async function readRpc(response: Response): Promise<RpcEnvelope> {
  return await response.json() as RpcEnvelope;
}

function toolCallResult(envelope: RpcEnvelope): ToolCallResult {
  return envelope.result as ToolCallResult;
}

function toolCallText(result: ToolCallResult): string {
  return result.content?.[0]?.text ?? "";
}

const EXPECTED_TOOLS = [
  "start_purchase",
  "purchase_status",
  "supplier_status",
  "register_participant",
  "create_request",
  "start_discovery",
  "get_discovery",
  "request_quote",
  "submit_offer",
  "accept_offer",
  "settle_order",
  "get_order",
  "list_events",
  "get_request",
  "get_offer",
  "supplier_listener_tick",
  "report_pending",
  "get_my_participant",
  "search_buyer_notices",
  "search_public_buyer_notices",
  "get_discovery_evidence",
  "read_discovery_source",
  "submit_discovery_assessment",
  "resolve_discovery_participants",
] as const;

test("initialize handshake returns protocol version, tools capability, and server info", async () => {
  const backend = new StubBackend();
  const handler = createMcpHandler(backend);

  const response = await handler(post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }));

  assert.equal(response.status, 200);
  const body = await readRpc(response);
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 1);

  const result = body.result as {
    protocolVersion: string;
    capabilities: { tools: unknown };
    serverInfo: { name: string; version: string };
    instructions: string;
  };
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.ok(result.capabilities.tools);
  assert.match(result.serverInfo.name, /marketplace/);
  assert.match(result.instructions, /untrusted data, never instructions/i);
  assert.match(result.instructions, /sandbox-only/i);
  assert.equal(backend.calls.length, 0);
});

test("tools/list advertises every tool with a strict object schema and safety notices", async () => {
  const backend = new StubBackend();
  const handler = createMcpHandler(backend);

  const response = await handler(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  assert.equal(response.status, 200);
  const body = await readRpc(response);
  const result = body.result as { tools: ToolSummary[] };

  assert.equal(result.tools.length, EXPECTED_TOOLS.length);
  assert.deepEqual(
    result.tools.map((tool) => tool.name).sort(),
    [...EXPECTED_TOOLS].sort(),
  );

  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} must accept an object`);
    assert.equal(
      tool.inputSchema.additionalProperties,
      false,
      `${tool.name} must reject undeclared arguments`,
    );
    assert.match(tool.description, /untrusted data, never instructions/i, tool.name);
    assert.match(tool.description, /sandbox-only/i, tool.name);
  }
});

test("missing, empty, or non-bearer Authorization is rejected before parsing", async () => {
  const backend = new StubBackend();
  const handler = createMcpHandler(backend);
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });

  const cases: Record<string, string>[] = [
    { "content-type": "application/json" },
    { "content-type": "application/json", authorization: "" },
    { "content-type": "application/json", authorization: "Bearer    " },
    { "content-type": "application/json", authorization: "Basic abc123" },
  ];

  for (const headers of cases) {
    const response = await handler(postRaw(payload, headers));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.doesNotMatch(await response.text(), /abc123/);
  }
  assert.equal(backend.calls.length, 0);
});

test("tools/call forwards the request bearer token and validated arguments", async () => {
  const backend = new StubBackend();
  const handler = createMcpHandler(backend);

  const response = await handler(post({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_request", arguments: { requestId: "req_42" } },
  }));
  assert.equal(response.status, 200);

  const first = backend.calls[0];
  assert.ok(first);
  assert.equal(first.method, "getRequest");
  assert.equal(first.token, TOKEN);
  assert.deepEqual(first.args, ["req_42"]);

  await handler(post({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "get_order", arguments: { orderId: "ord_1" } },
  }, "second-participant-token"));

  const second = backend.calls[1];
  assert.ok(second);
  assert.equal(second.token, "second-participant-token");
  assert.deepEqual(second.args, ["ord_1"]);
});

test("tools/call rejects undeclared properties and client-supplied actor ids", async () => {
  const backend = new StubBackend();
  const handler = createMcpHandler(backend);

  const actorAsArgument = await handler(post({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "get_request",
      arguments: { requestId: "req_1", actorId: "buyer_evil" },
    },
  }));
  const actorBody = await readRpc(actorAsArgument);
  assert.equal(actorAsArgument.status, 200);
  assert.equal(actorBody.error?.code, -32602);
  assert.doesNotMatch(JSON.stringify(actorBody), /buyer_evil/);

  const identityAsArgument = await handler(post({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "submit_offer",
      arguments: {
        requestId: "req_1",
        buyerId: "buyer_evil",
        quantity: 10,
        unit: "kg",
        destination: "Berlin",
        deliveredTotal: { amountMinor: 1000, currency: "EUR" },
        taxMinor: 0,
        deliveryMinor: 0,
        deliveryAt: "2026-11-10T09:00:00.000Z",
        expiresAt: "2026-11-03T09:00:00.000Z",
        confirmedRequirementKeys: ["certificate"],
        termsOrigin: "demo-supplier-declaration",
        demo: true,
      },
    },
  }));
  const identityBody = await readRpc(identityAsArgument);
  assert.equal(identityBody.error?.code, -32602);
  assert.doesNotMatch(JSON.stringify(identityBody), /buyer_evil/);
  assert.equal(backend.calls.length, 0);
});

test("tool failures become isError results without leaking the token or a stack", async () => {
  const backend = new StubBackend();
  const handler = createMcpHandler(backend);
  backend.failure = new BackendFailure(
    "STALE_OFFER",
    `backend rejected the offer for token ${TOKEN}\n    at secretFrame (/private/secret.ts:10:5)`,
  );

  const response = await handler(post({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "accept_offer", arguments: { offerId: "off_1" } },
  }));

  assert.equal(response.status, 200);
  const body = await readRpc(response);
  const result = toolCallResult(body);
  assert.equal(result.isError, true);

  const text = toolCallText(result);
  assert.match(text, /STALE_OFFER/);
  assert.match(text, /\[redacted\]/);
  assert.equal(text.includes(TOKEN), false);
  assert.doesNotMatch(text, /secretFrame/);

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(TOKEN), false);
  assert.doesNotMatch(serialized, /secretFrame/);
});

test("create_request and submit_offer forward nested input without actor fields", async () => {
  const backend = new StubBackend();
  const handler = createMcpHandler(backend);

  const requestArguments = {
    category: "packaging",
    description: "Recycled cardboard boxes",
    quantity: 10,
    unit: "kg",
    destination: "Berlin",
    maximumDeliveredTotal: { amountMinor: 125000, currency: "EUR" },
    deliverBy: "2026-11-20T09:00:00.000Z",
    requirements: [{ key: "certificate", description: "FSC certificate", mandatory: true }],
    demo: true,
  };
  await handler(post({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "create_request", arguments: requestArguments },
  }));

  const requestCall = backend.calls[0];
  assert.ok(requestCall);
  assert.equal(requestCall.method, "createRequest");
  assert.deepEqual(requestCall.args, [requestArguments]);

  const offerArguments = {
    requestId: "req_1",
    quantity: 10,
    unit: "kg",
    destination: "Berlin",
    deliveredTotal: { amountMinor: 125000, currency: "EUR" },
    taxMinor: 1000,
    deliveryMinor: 500,
    deliveryAt: "2026-11-10T09:00:00.000Z",
    expiresAt: "2026-11-03T09:00:00.000Z",
    confirmedRequirementKeys: ["certificate"],
    termsOrigin: "demo-supplier-declaration",
    demo: true,
  };
  await handler(post({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "submit_offer", arguments: offerArguments },
  }));

  const offerCall = backend.calls[1];
  assert.ok(offerCall);
  assert.equal(offerCall.method, "submitOffer");
  assert.deepEqual(offerCall.args, [offerArguments]);
});

test("supplier_listener_tick returns handled events and completion reports", async () => {
  const backend = new StubBackend();
  backend.tickResult = {
    handled: ["evt_1", "evt_2"],
    reports: ["agreed and sandbox-paid — order ord_1 (demo document inv_1)"],
  };
  const handler = createMcpHandler(backend);

  const response = await handler(post({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "supplier_listener_tick", arguments: {} },
  }));

  const body = await readRpc(response);
  const result = toolCallResult(body);
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, backend.tickResult);
  assert.deepEqual(JSON.parse(toolCallText(result)), backend.tickResult);

  const call = backend.calls[0];
  assert.ok(call);
  assert.equal(call.method, "supplierListenerTick");
  assert.equal(call.token, TOKEN);
});

test("report_pending returns unread completion messages", async () => {
  const backend = new StubBackend();
  backend.pendingResult = {
    messages: [
      "agreed and sandbox-paid — order ord_1",
      "no match — request req_2",
    ],
  };
  const handler = createMcpHandler(backend);

  const response = await handler(post({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "report_pending" },
  }));

  const body = await readRpc(response);
  const result = toolCallResult(body);
  assert.deepEqual(result.structuredContent, backend.pendingResult);
  assert.deepEqual(JSON.parse(toolCallText(result)), backend.pendingResult);

  const call = backend.calls[0];
  assert.ok(call);
  assert.equal(call.method, "reportPending");
});

test("notifications/initialized is acknowledged without a JSON-RPC body", async () => {
  const backend = new StubBackend();
  const handler = createMcpHandler(backend);

  const response = await handler(post({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }));

  assert.ok(response.status === 202 || response.status === 204);
  assert.equal(await response.text(), "");
  assert.equal(backend.calls.length, 0);
});

test("unknown methods, malformed JSON, and invalid params use JSON-RPC error codes", async () => {
  const backend = new StubBackend();
  const handler = createMcpHandler(backend);

  const unknown = await handler(post({ jsonrpc: "2.0", id: 12, method: "tools/unknown" }));
  const unknownBody = await readRpc(unknown);
  assert.equal(unknownBody.error?.code, -32601);

  const malformed = await handler(postRaw("{not json", {
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
  }));
  assert.equal(malformed.status, 400);
  const malformedBody = await readRpc(malformed);
  assert.equal(malformedBody.error?.code, -32700);

  const missingName = await handler(post({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: { arguments: {} },
  }));
  const missingNameBody = await readRpc(missingName);
  assert.equal(missingNameBody.error?.code, -32602);

  const unknownTool = await handler(post({
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: { name: "delete_everything", arguments: {} },
  }));
  const unknownToolBody = await readRpc(unknownTool);
  assert.equal(unknownToolBody.error?.code, -32602);
  assert.equal(backend.calls.length, 0);
});

test("ping returns an empty result and non-POST requests are rejected", async () => {
  const backend = new StubBackend();
  const handler = createMcpHandler(backend);

  const ping = await handler(post({ jsonrpc: "2.0", id: 15, method: "ping" }));
  const pingBody = await readRpc(ping);
  assert.deepEqual(pingBody.result, {});
  assert.equal(backend.calls.length, 0);

  const getResponse = await handler(new Request(MCP_URL, {
    method: "GET",
    headers: { authorization: `Bearer ${TOKEN}` },
  }));
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.get("allow"), "POST");
});

test("mcp backend selects the client by bearer token and reports missing runtime hooks", async () => {
  const tokens: string[] = [];
  const events: string[] = [];
  const unused = (): never => {
    throw new Error("not used by this test");
  };
  const client: PlatformToolClient = {
    registerParticipant: unused,
    createRequest: unused,
    startDiscovery: unused,
    getDiscovery: unused,
    requestQuote: unused,
    submitOffer: unused,
    acceptOffer: unused,
    settleOrder: unused,
    getOrder: unused,
    getRequest: unused,
    getOffer: unused,
    listEvents: (after) => {
      events.push(after ?? "none");
      return Promise.resolve({ events: [], nextCursor: "cursor-1" });
    },
  };
  const backend = createMcpBackend({
    clientForToken: (token) => {
      tokens.push(token);
      return client;
    },
  });

  const page = await backend.listEvents(TOKEN, "cursor-0");
  assert.equal(page.nextCursor, "cursor-1");
  assert.deepEqual(events, ["cursor-0"]);
  assert.deepEqual(tokens, [TOKEN]);

  await assert.rejects(backend.supplierListenerTick(TOKEN), /no active supplier listener/);
  assert.deepEqual(await backend.reportPending(TOKEN), { messages: [] });

  const ticked: string[] = [];
  const withHooks = createMcpBackend({
    clientForToken: () => client,
    hooks: {
      supplierListenerTick: (token) => {
        ticked.push(token);
        return Promise.resolve({ handled: ["evt-1"], reports: ["agreed and sandbox-paid"] });
      },
    },
  });
  const tick = await withHooks.supplierListenerTick(TOKEN);
  assert.equal(tick.reports.length, 1);
  assert.deepEqual(ticked, [TOKEN]);
});

function sampleAssessment(): AgentAssessment {
  return {
    discoveryId: "disc_1",
    buyerNoticeNumber: "123456-2026",
    candidates: [{
      company: { name: "Supplier Fixture", officialDomain: "supplier.example", publicOrganizationId: "fixture-id" },
      identity: { sourceId: "disc_1:source-1", quotation: "Supplier Fixture", organizationIdQuotation: "Supplier Fixture fixture-id" },
      claims: [
        { requirementKey: "certificate", outcome: "match", sourceId: "disc_1:source-1", quotation: "FSC certificate" },
        { requirementKey: "unknown", outcome: "unknown" },
        { requirementKey: "mismatch", outcome: "mismatch", sourceId: "disc_1:source-1", quotation: "No capacity" },
      ],
    }],
  };
}

async function callTool(handler: ReturnType<typeof createMcpHandler>, name: string, args: unknown, token = TOKEN): Promise<RpcEnvelope> {
  return readRpc(await handler(post({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name, arguments: args } }, token)));
}

test("live evidence tools forward validated arguments and only the authenticated header token", async () => {
  const backend = new StubBackend();
  const handler = createMcpHandler(backend);
  const assessment = sampleAssessment();
  const cases: [string, Record<string, unknown>, string, unknown[]][] = [
    ["get_my_participant", {}, "getMyParticipant", []],
    ["search_buyer_notices", { query: "desks", limit: 5 }, "searchBuyerNotices", ["desks", 5]],
    ["search_buyer_notices", { query: "desks" }, "searchBuyerNotices", ["desks", undefined]],
    ["get_discovery_evidence", { discoveryId: "disc_1" }, "getDiscoveryEvidence", ["disc_1"]],
    ["read_discovery_source", { discoveryId: "disc_1", sourceId: "disc_1:source-1", offset: 0, limit: 8000 },
      "readDiscoverySource", ["disc_1", "disc_1:source-1", { offset: 0, limit: 8000 }]],
    ["read_discovery_source", { discoveryId: "disc_1", sourceId: "disc_1:source-1" },
      "readDiscoverySource", ["disc_1", "disc_1:source-1", undefined]],
    ["read_discovery_source", { discoveryId: "disc_1", sourceId: "disc_1:source-1", limit: 1 },
      "readDiscoverySource", ["disc_1", "disc_1:source-1", { limit: 1 }]],
    ["submit_discovery_assessment", { discoveryId: "disc_1", assessment }, "submitDiscoveryAssessment", ["disc_1", assessment]],
    ["resolve_discovery_participants", { discoveryId: "disc_1" }, "resolveDiscoveryParticipants", ["disc_1"]],
  ];
  for (const [name, args, method, forwarded] of cases) {
    const token = `${TOKEN}-${backend.calls.length}`;
    const body = await callTool(handler, name, args, token);
    assert.equal(body.error, undefined, name);
    assert.equal(toolCallResult(body).isError, false, name);
    assert.deepEqual(backend.calls.at(-1), { method, token, args: forwarded });
  }
  assert.equal(backend.calls.length, cases.length);
});

test("live evidence tools reject out-of-bounds fields and caller authority before dispatch", async () => {
  const backend = new StubBackend();
  const handler = createMcpHandler(backend);
  const cases: [string, Record<string, unknown>][] = [
    ["get_my_participant", { token: "forged" }],
    ["get_my_participant", { actor: { participantId: "forged" } }],
    ["search_buyer_notices", {}],
    ["search_buyer_notices", { query: "" }],
    ["search_buyer_notices", { query: "x".repeat(1501) }],
    ...[0, 6, 1.5, "2"].map((limit): [string, Record<string, unknown>] => ["search_buyer_notices", { query: "desks", limit }]),
    ["get_discovery_evidence", { discoveryId: "disc_1", actorId: "forged" }],
    ["get_discovery_evidence", { discoveryId: "" }],
    ["read_discovery_source", { discoveryId: "disc_1" }],
    ...[-1, 0.5, "0"].map((offset): [string, Record<string, unknown>] => ["read_discovery_source", { discoveryId: "disc_1", sourceId: "disc_1:source-1", offset }]),
    ...[0, 8001, 1.5, "1"].map((limit): [string, Record<string, unknown>] => ["read_discovery_source", { discoveryId: "disc_1", sourceId: "disc_1:source-1", limit }]),
    ["resolve_discovery_participants", { discoveryId: "disc_1", supplierId: "forged" }],
  ];
  for (const [name, args] of cases) {
    const body = await callTool(handler, name, args);
    assert.equal(body.error?.code, -32602, `${name}: ${JSON.stringify(args)}`);
  }
  assert.equal(backend.calls.length, 0);
});

test("assessment schema rejects extra actor, run, source hash and body metadata at every level", async () => {
  const backend = new StubBackend();
  const handler = createMcpHandler(backend);
  const base = sampleAssessment();
  const candidate = base.candidates[0]!;
  const invalid: unknown[] = [
    { ...base, candidates: Array.from({ length: 6 }, () => candidate) },
    { ...base, candidates: [{ ...candidate, claims: Array.from({ length: 101 }, () => candidate.claims[0]) }] },
    { ...base, buyerNoticeNumber: "arbitrary-notice" },
    { ...base, candidates: [{ ...candidate, claims: [{ requirementKey: "key", outcome: "maybe" }] }] },
    { ...base, candidates: [{ ...candidate, identity: { quotation: "missing source" } }] },
    { ...base, candidates: [{ ...candidate, company: { officialDomain: "supplier.example" } }] },
  ];
  for (const key of ["actor", "actorId", "token", "runId", "sourceHash", "contentHash", "body", "metadata"]) {
    invalid.push({ ...base, [key]: "forged" });
    invalid.push({ ...base, candidates: [{ ...candidate, [key]: "forged" }] });
    invalid.push({ ...base, candidates: [{ ...candidate, company: { ...candidate.company, [key]: "forged" } }] });
    invalid.push({ ...base, candidates: [{ ...candidate, identity: { ...candidate.identity, [key]: "forged" } }] });
    invalid.push({ ...base, candidates: [{ ...candidate, claims: [{ ...candidate.claims[0], [key]: "forged" }] }] });
    const topLevel = await callTool(handler, "submit_discovery_assessment", { discoveryId: "disc_1", assessment: base, [key]: "forged" });
    assert.equal(topLevel.error?.code, -32602, key);
  }
  for (const assessment of invalid) {
    const body = await callTool(handler, "submit_discovery_assessment", { discoveryId: "disc_1", assessment });
    assert.equal(body.error?.code, -32602, JSON.stringify(assessment));
  }
  assert.equal(backend.calls.length, 0);
  const boundary = { ...base, candidates: Array.from({ length: 5 }, () => ({ ...candidate,
    claims: Array.from({ length: 100 }, () => ({ requirementKey: "unknown", outcome: "unknown" })),
  })) };
  assert.equal(toolCallResult(await callTool(handler, "submit_discovery_assessment", { discoveryId: "disc_1", assessment: boundary })).isError, false);
});

test("create_request accepts an optional TED publication number and rejects malformed numbers", async () => {
  const backend = new StubBackend();
  const handler = createMcpHandler(backend);
  const { id: _id, buyerId: _buyerId, ...input } = sampleRequest();
  const args = { ...input, buyerNoticeNumber: "123456-2026" };
  assert.equal(toolCallResult(await callTool(handler, "create_request", args)).isError, false);
  assert.deepEqual(backend.calls[0]?.args, [args]);
  for (const buyerNoticeNumber of ["", "123456", "123456-2100", "12345678-2026", "x-2026", 123456]) {
    assert.equal((await callTool(handler, "create_request", { ...input, buyerNoticeNumber })).error?.code, -32602);
  }
  assert.equal(backend.calls.length, 1);
});

function baseToolClient(): PlatformToolClient {
  const unused = (): never => { throw new Error("unexpected capability call"); };
  return {
    registerParticipant: unused, createRequest: unused, startDiscovery: unused, getDiscovery: unused,
    requestQuote: unused, submitOffer: unused, acceptOffer: unused, settleOrder: unused, getOrder: unused,
    listEvents: unused, getRequest: unused, getOffer: unused,
  };
}

const LIVE_TOOL_ARGS: [string, Record<string, unknown>][] = [
  ["get_my_participant", {}],
  ["search_buyer_notices", { query: "desks", limit: 1 }],
  ["get_discovery_evidence", { discoveryId: "disc_1" }],
  ["read_discovery_source", { discoveryId: "disc_1", sourceId: "disc_1:source-1", offset: 0, limit: 1 }],
  ["submit_discovery_assessment", { discoveryId: "disc_1", assessment: sampleAssessment() }],
  ["resolve_discovery_participants", { discoveryId: "disc_1" }],
];

test("absent optional capabilities return TOOL_UNAVAILABLE on both backend surfaces", async () => {
  const selectedTokens: string[] = [];
  const adapted = createMcpBackend({ clientForToken: (token) => { selectedTokens.push(token); return baseToolClient(); } });
  const stub = new StubBackend();
  // Deliberately omit every new capability, as an existing gateway backend would.
  const legacy: McpToolBackend = {
    registerParticipant: stub.registerParticipant.bind(stub), createRequest: stub.createRequest.bind(stub),
    startDiscovery: stub.startDiscovery.bind(stub), getDiscovery: stub.getDiscovery.bind(stub),
    requestQuote: stub.requestQuote.bind(stub), submitOffer: stub.submitOffer.bind(stub),
    acceptOffer: stub.acceptOffer.bind(stub), settleOrder: stub.settleOrder.bind(stub), getOrder: stub.getOrder.bind(stub),
    listEvents: stub.listEvents.bind(stub), getRequest: stub.getRequest.bind(stub), getOffer: stub.getOffer.bind(stub),
    supplierListenerTick: stub.supplierListenerTick.bind(stub), reportPending: stub.reportPending.bind(stub),
    startPurchase: stub.startPurchase.bind(stub), purchaseStatus: stub.purchaseStatus.bind(stub), supplierStatus: stub.supplierStatus.bind(stub),
  };
  for (const backend of [legacy, adapted]) {
    const handler = createMcpHandler(backend);
    for (const [name, args] of LIVE_TOOL_ARGS) {
      const body = await callTool(handler, name, args);
      assert.equal(body.error, undefined, name);
      const result = toolCallResult(body);
      assert.equal(result.isError, true, name);
      assert.deepEqual((result.structuredContent as { error: string }).error, "TOOL_UNAVAILABLE", name);
      assert.match(toolCallText(result), new RegExp(name));
    }
  }
  assert.deepEqual(selectedTokens, Array.from({ length: 6 }, () => TOKEN));
});

test("optional backend adapter preserves client method binding and token-scoped inputs", async () => {
  const calls: unknown[][] = [];
  const tokens: string[] = [];
  const client = Object.assign(baseToolClient(), {
    getMyParticipant: async function () { assert.equal(this, client); calls.push([]); return { participantId: "buyer_1" }; },
    searchBuyerNotices: async function (query: string, limit?: number) { assert.equal(this, client); calls.push([query, limit]); return { notices: [] }; },
    getDiscoveryEvidence: async function (id: string) { assert.equal(this, client); calls.push([id]); return { sources: [] }; },
    readDiscoverySource: async function (id: string, sourceId: string, options?: { offset?: number; limit?: number }) {
      assert.equal(this, client); calls.push([id, sourceId, options]); return { text: "fixture" };
    },
    submitDiscoveryAssessment: async function (id: string, assessment: AgentAssessment) {
      assert.equal(this, client); calls.push([id, assessment]); return sampleDiscovery();
    },
    resolveDiscoveryParticipants: async function (id: string) { assert.equal(this, client); calls.push([id]); return { participants: [] }; },
  });
  const handler = createMcpHandler(createMcpBackend({ clientForToken: (token) => { tokens.push(token); return client; } }));
  for (const [name, args] of LIVE_TOOL_ARGS) {
    const body = await callTool(handler, name, args, `${TOKEN}-${tokens.length}`);
    assert.equal(body.error, undefined, name);
    assert.equal(toolCallResult(body).isError, false, name);
  }
  assert.deepEqual(tokens, Array.from({ length: 6 }, (_, i) => `${TOKEN}-${i}`));
  assert.deepEqual(calls, [[], ["desks", 1], ["disc_1"], ["disc_1", "disc_1:source-1", { offset: 0, limit: 1 }],
    ["disc_1", sampleAssessment()], ["disc_1"]]);
});
