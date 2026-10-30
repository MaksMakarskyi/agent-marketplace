import { findTool } from "./mcp/tools.js";

const plannedRoutes = [
  ["/v1/participants", "post", "registerParticipant"],
  ["/v1/requests", "post", "createRequest"],
  ["/v1/requests/{requestId}/discover", "post", "startDiscovery"],
  ["/v1/discoveries/{discoveryId}", "get", "getDiscovery"],
  ["/v1/events", "get", "listEvents"],
  ["/v1/requests/{requestId}/quote-requests", "post", "requestQuote"],
  ["/v1/requests/{requestId}/offers", "post", "submitOffer"],
  ["/v1/offers/{offerId}/acceptances", "post", "acceptOffer"],
  ["/v1/orders/{orderId}/settle", "post", "settleOrder"],
  ["/v1/orders/{orderId}", "get", "getOrder"],
] as const;

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Agent Marketplace",
    version: "0.1.0",
    description: "Scaffold only. Planned business routes are not callable integrations yet; typed draft contracts are in src/contracts.ts.",
  },
  components: {
    securitySchemes: { participantToken: { type: "http", scheme: "bearer" } },
  },
  paths: {
    "/health": { get: { operationId: "health", "x-implemented": true, responses: { "200": { description: "Scaffold status, not marketplace readiness" } } } },
    "/agent.txt": { get: { operationId: "agentInstructions", "x-implemented": true, responses: { "200": { description: "Plain-text integration status" } } } },
    "/openapi.json": { get: { operationId: "openapi", "x-implemented": true, responses: { "200": { description: "Draft API description" } } } },
    ...Object.fromEntries(plannedRoutes.map(([path, method, operationId]) => [path, {
      [method]: {
        operationId,
        "x-implemented": false,
        description: "Planned. Returns 501 until implemented; schemas must be completed by the owner before client integration.",
        security: [{ participantToken: [] }],
        parameters: Array.from(path.matchAll(/\{([^}]+)\}/g), (match) => ({ name: match[1], in: "path", required: true, schema: { type: "string" } })),
        responses: { "501": { description: "Not implemented" } },
      },
    }])),
    "/webhooks/stripe": { post: { operationId: "stripeWebhook", "x-implemented": true, description: "Stripe-only. Authenticated by Stripe signature, not participant authentication. Returns 501 when the server has no webhook secret configured.", responses: { "200": { description: "Verified event recorded (applied, duplicate, or ignored)" }, "400": { description: "Invalid signature" }, "501": { description: "Webhook not configured" } } } },
  },
};

/** Enabled deployments describe actual routes. MCP remains the canonical agent tool schema. */
export function liveOpenapi() {
  const paths: Record<string, unknown> = { ...openapi.paths };
  const routes = [
    ...plannedRoutes,
    ["/v1/me", "get", "getMyParticipant"],
    ["/v1/requests/{requestId}", "get", "getRequest"],
    ["/v1/offers/{offerId}", "get", "getOffer"],
    ["/v1/sources/buyer-notices/search", "post", "searchBuyerNotices"],
    ["/v1/sources/public-buyer-notices/search", "post", "searchPublicBuyerNotices"],
    ["/v1/discoveries/{discoveryId}/evidence", "get", "getDiscoveryEvidence"],
    ["/v1/discoveries/{discoveryId}/sources/{sourceId}", "get", "readDiscoverySource"],
    ["/v1/discoveries/{discoveryId}/assessments", "post", "submitDiscoveryAssessment"],
    ["/v1/discoveries/{discoveryId}/resolve", "post", "resolveDiscoveryParticipants"],
    ["/mcp", "post", "mcp"],
  ] as const;
  const toolForOperation: Record<string, string> = { registerParticipant: "register_participant", createRequest: "create_request", submitOffer: "submit_offer", searchBuyerNotices: "search_buyer_notices", searchPublicBuyerNotices: "search_public_buyer_notices" };
  for (const [path, method, operationId] of routes) {
    const schema = operationId === "submitDiscoveryAssessment" ? findTool("submit_discovery_assessment")?.inputSchema.properties?.assessment
      : toolForOperation[operationId] ? findTool(toolForOperation[operationId]!)?.inputSchema
        : operationId === "requestQuote" ? { type: "object", additionalProperties: false, required: ["supplierId"], properties: { supplierId: { type: "string" } } }
          : { type: "object", additionalProperties: false, properties: {} };
    const parameters = Array.from(path.matchAll(/\{([^}]+)\}/g), (match) => ({ name: match[1], in: "path", required: true, schema: { type: "string" } }));
    if (["registerParticipant", "createRequest", "startDiscovery", "requestQuote", "submitOffer", "acceptOffer", "submitDiscoveryAssessment"].includes(operationId)) {
      parameters.push({ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } });
    }
    paths[path] = { [method]: { operationId, "x-implemented": true, security: [{ participantToken: [] }], parameters,
      description: operationId === "mcp" ? "Authenticated MCP Streamable HTTP. Use tools/list for exact tool schemas."
        : "Sandbox demo API. Requires operator-provisioned scoped participant credentials and applied database migrations. Availability is not end-to-end acceptance proof.",
      ...(method === "post" && operationId !== "mcp" ? { requestBody: { required: true, content: { "application/json": { schema } } } } : {}),
      responses: { "200": { description: "Scoped operation result; see shared TypeScript contracts and MCP tools for result fields" },
        "400": { description: "Invalid or unbound input" }, "401": { description: "Missing, revoked or expired credential" }, "403": { description: "Role, ownership or mandate refusal" },
        "404": { description: "Resource unavailable to this participant" }, "409": { description: "Stale/conflicting operation" }, "503": { description: "Database, provider or required configuration unavailable" } } } };
  }
  for (const [path, operationId] of [["/v1/demo-observer/runs", "listPublicDemoRuns"],
    ["/v1/demo-observer/runs/{runId}", "getPublicDemoRun"], ["/v1/demo-observer/activity", "getPublicDemoActivity"]]) {
    paths[path!] = { get: { operationId, security: [], "x-implemented": true,
      description: "Public read-only demo observation. No credentials required; private mandates and payment methods are excluded.",
      parameters: path!.includes("{runId}") ? [{ name: "runId", in: "path", required: true, schema: { type: "string" } }] : [],
      responses: { "200": { description: "Current demo projection" }, "404": { description: "Disabled or unknown run" }, "503": { description: "Required database migration or service unavailable" } } } };
  }
  return { ...openapi, info: { ...openapi.info, version: "0.2.0", description: "Authenticated sandbox demo API with live API-backed evidence and client-agent assessments. No real-money trading or verified legal representation. Actual named-client and hosted payment acceptance must be recorded separately." }, paths };
}
