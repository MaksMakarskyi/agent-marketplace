import type { ActorContext } from "../contracts.js";
import { PlatformClient } from "../agents/client.js";
import { LIVE_AGENT_INSTRUCTIONS } from "../agents/instructions.js";
import { createMcpBackend } from "../mcp/backend.js";
import { createMcpHandler } from "../mcp/gateway.js";
import { MCP_TOOLS, findTool, validateJsonSchema } from "../mcp/tools.js";
import { DiscoveryInputError } from "../sourcing/discovery.js";
import { PaymentRefusedError, PaymentUnavailableError } from "../payments/settlement.js";
import { IdentityError, authenticate, registerIdentity } from "./identity.js";
import { PlatformError, type Database } from "./database.js";
import { Marketplace } from "./marketplace.js";
import { observe, type ObserverBus } from "./observer.js";
import { createPublicDemoObserver } from "./public-demo-observer.js";
import { authenticateObserver, errorCodeFrom, idsFromResponse, listRuns, mcpClientInfo, operationFor, recordSighting, recordTrace,
  runView, touchSighting, type TraceChannel } from "./observer-runs.js";

export interface PlatformHttp {
  handle(request: Request): Promise<Response>;
  readiness(): Promise<{ sourcingReady: boolean; sandboxPaymentConfigured: boolean; endToEndVerified: false }>;
}

export interface PlatformHttpOptions {
  now?: () => Date;
  paymentConfigured?: boolean;
  /** Receives one human-readable log per call for the /observer/ws stream. */
  observer?: ObserverBus;
  /** Public read-only visibility of demo runs. Participant trading credentials remain private. */
  publicDemoObserver?: { enabled?: boolean };
  /** The read-only observer page API under /v1/observer. */
  observerApi?: {
    /** Exact browser origins allowed to read the observer projection (CORS). Empty: same-origin only. */
    allowedOrigins?: readonly string[];
    /** Shown on the observer page, e.g. "hosted" or "local-fixture". Never inferred from data. */
    environment?: string;
  };
}

interface DispatchContext {
  actor?: ActorContext;
  raw?: string;
}

const INTERNAL_HOST = "internal.marketplace";
/** Longest a response waits for its trace write. A slower write finishes in the background. */
export const TRACE_BUDGET_MS = 250;
/** An unchanged client sighting is rewritten at most this often. */
export const SIGHTING_REFRESH_MS = 30_000;

/** HTTP and MCP use the same authenticated route implementation, without a network self-call. */
export function createPlatformHttp(db: Database, market: Marketplace, options: PlatformHttpOptions = {}): PlatformHttp {
  const now = options.now ?? (() => new Date());
  const supported = MCP_TOOLS.filter((tool) => !["start_purchase", "purchase_status", "supplier_status", "supplier_listener_tick", "report_pending"].includes(tool.name));
  const mcp = createMcpHandler(createMcpBackend({ clientForToken: (token) => new PlatformClient({
    baseUrl: `https://${INTERNAL_HOST}`, token, timeoutMs: 60_000, retry: { attempts: 1, baseDelayMs: 0 },
    fetchImpl: (input, init) => handle(new Request(input, init)),
  }) }), { tools: supported, instructions: LIVE_AGENT_INSTRUCTIONS });

  const observerOrigins = new Set(options.observerApi?.allowedOrigins ?? []);
  const environment = options.observerApi?.environment ?? "hosted";
  const publicDemoObserver = createPublicDemoObserver(db, {
    ...options.publicDemoObserver, allowedOrigins: [...observerOrigins], environment, now,
    ...(options.observer ? { observer: options.observer } : {}),
  });
  // MVP_LIMIT: per-instance write throttle. It only skips redundant bookkeeping; the database stays authoritative.
  const recentSightings = new Map<string, { identity: string; at: number }>();
  /** True when the same client was recorded within the refresh window, so this write can be skipped. */
  const seenRecently = (key: string, identity: string | undefined, at: Date) => {
    const last = recentSightings.get(key);
    return last !== undefined && (identity === undefined || last.identity === identity) && at.getTime() - last.at < SIGHTING_REFRESH_MS;
  };
  const remember = (key: string, identity: string, at: Date) => recentSightings.set(key, { identity, at: at.getTime() });

  /**
   * Every call, including the internal ones an MCP tool makes, emits one stream log. Every authenticated
   * operation is also traced after it completes; tracing never changes the response.
   */
  async function handle(request: Request): Promise<Response> {
    return observe(options.observer, request, "http", async (observed) => {
      const url = new URL(observed.url);
      if (url.pathname.startsWith("/v1/demo-observer/")) return { response: await publicDemoObserver(observed) };
      if (url.pathname === "/v1/observer" || url.pathname.startsWith("/v1/observer/")) return { response: await observerApi(observed) };
      const startedAt = now();
      const context: DispatchContext = {};
      const response = await dispatch(observed, context);
      // Bounded: tracing is bookkeeping and must never hold the participant's answer.
      if (context.actor) await Promise.race([trace(observed, url, context, response, startedAt), new Promise((resolve) => setTimeout(resolve, TRACE_BUDGET_MS).unref())]);
      return { response, actor: context.actor };
    });
  }

  async function trace(request: Request, url: URL, context: DispatchContext, response: Response, startedAt: Date): Promise<void> {
    try {
      const participantId = context.actor!.participantId;
      const finishedAt = now();
      if (url.pathname === "/mcp") {
        const info = context.raw === undefined ? undefined : mcpClientInfo(context.raw);
        const key = `${participantId}|mcp`;
        if (info) {
          const identity = `${info.name}|${info.version ?? ""}|${info.protocolVersion ?? ""}`;
          if (seenRecently(key, identity, finishedAt)) return;
          await recordSighting(db, { participantId, channel: "mcp", clientName: info.name, at: finishedAt,
            ...(info.version === undefined ? {} : { clientVersion: info.version }),
            ...(info.protocolVersion === undefined ? {} : { protocolVersion: info.protocolVersion }) });
          remember(key, identity, finishedAt);
        } else if (!seenRecently(key, undefined, finishedAt)) {
          await touchSighting(db, participantId, "mcp", finishedAt);
          remember(key, recentSightings.get(key)?.identity ?? "", finishedAt);
        }
        return;
      }
      // MCP tool calls reach this handler as in-process requests to the internal host.
      const channel: TraceChannel = url.hostname === INTERNAL_HOST ? "mcp" : "http";
      if (channel === "http") {
        const agent = request.headers.get("user-agent");
        const key = `${participantId}|http`;
        if (agent && !seenRecently(key, agent, finishedAt)) {
          await recordSighting(db, { participantId, channel, clientName: agent, at: finishedAt });
          remember(key, agent, finishedAt);
        }
      }
      const match = operationFor(request.method, url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part)));
      if (!match || match.polling) return;
      let body: unknown;
      try { body = await response.clone().json(); } catch { body = undefined; }
      const created = response.status < 400 ? idsFromResponse(match.operation, body) : {};
      const errorCode = response.status >= 400 ? errorCodeFrom(body) : undefined;
      await recordTrace(db, { participantId, channel, operation: match.operation, status: response.status,
        ...(errorCode === undefined ? {} : { errorCode }), ...match.ids, ...created, startedAt, finishedAt });
    } catch {
      // A missing migration or a trace failure must not fail or alter the participant's operation.
    }
  }

  /** Read-only observer projection, authenticated by an operator-issued observer session only. */
  async function observerApi(request: Request): Promise<Response> {
    const origin = request.headers.get("origin");
    const cors: Record<string, string> = origin !== null && observerOrigins.has(origin)
      ? { "access-control-allow-origin": origin, vary: "Origin" } : { vary: "Origin" };
    if (request.method === "OPTIONS") {
      if (!cors["access-control-allow-origin"]) return new Response(null, { status: 403, headers: cors });
      return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET",
        "access-control-allow-headers": "authorization", "access-control-max-age": "600" } });
    }
    const headers = { ...cors, "cache-control": "no-store" };
    try {
      if (request.method !== "GET") throw new PlatformError(405, "METHOD_NOT_ALLOWED");
      const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!bearer) throw new PlatformError(401, "INVALID_OBSERVER_SESSION");
      const session = await authenticateObserver(db, bearer, now());
      const parts = new URL(request.url).pathname.split("/").filter(Boolean).map((value) => decodeURIComponent(value));
      if (parts.some((part) => !/^[A-Za-z0-9:_-]{1,128}$/.test(part))) throw new PlatformError(400, "INVALID_PATH");
      if (parts.length === 3 && parts[2] === "runs") return Response.json(await listRuns(db, session), { headers });
      if (parts.length === 4 && parts[2] === "runs") return Response.json(await runView(db, session, parts[3]!, now(), environment), { headers });
      throw new PlatformError(404, "NOT_FOUND");
    } catch (error) {
      if (error instanceof PlatformError) return Response.json({ error: error.code, code: error.code }, { status: error.status, headers });
      if (error instanceof URIError) return Response.json({ error: "INVALID_PATH", code: "INVALID_PATH" }, { status: 400, headers });
      return Response.json({ error: "PLATFORM_UNAVAILABLE", code: "PLATFORM_UNAVAILABLE" }, { status: 503, headers });
    }
  }

  async function dispatch(request: Request, context: DispatchContext): Promise<Response> {
    let actor: ActorContext | undefined;
    try {
      const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!bearer) throw new IdentityError(401, "INVALID_CREDENTIAL");
      actor = await authenticate(db, bearer, now());
      context.actor = actor;
      const url = new URL(request.url);
      if (url.pathname === "/mcp") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const { raw } = await jsonBody(request);
        context.raw = raw;
        return mcp(new Request(request.url, { method: "POST", headers: request.headers, body: raw, signal: request.signal }));
      }
      const parts = url.pathname.split("/").filter(Boolean).map((value) => decodeURIComponent(value));
      if (parts.some((part) => !/^[A-Za-z0-9:_-]{1,128}$/.test(part))) throw new PlatformError(400, "INVALID_PATH");
      if (request.method === "GET") {
        if (url.pathname === "/v1/me") return json(await market.me(actor));
        if (url.pathname === "/v1/events") return json(await market.events(actor, url.searchParams.get("after") ?? "0"));
        if (parts[0] === "v1" && parts[1] === "requests" && parts.length === 3) return json(await market.getRequest(actor, parts[2]!));
        if (parts[0] === "v1" && parts[1] === "offers" && parts.length === 3) return json(await market.getOffer(actor, parts[2]!));
        if (parts[0] === "v1" && parts[1] === "orders" && parts.length === 3) return json(await market.getOrder(actor, parts[2]!));
        if (parts[0] === "v1" && parts[1] === "discoveries") {
          const id = parts[2]!;
          if (parts.length === 3) return json(await market.getDiscovery(actor, id));
          if (parts.length === 4 && parts[3] === "evidence") return json(await market.evidence(actor, id));
          if (parts.length === 5 && parts[3] === "sources") return json(await market.source(actor, id, parts[4]!,
            url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
            url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 8000));
        }
        throw new PlatformError(404, "NOT_FOUND");
      }
      if (request.method !== "POST") return methodNotAllowed("GET, POST");
      const { body } = await jsonBody(request);
      const key = request.headers.get("idempotency-key") ?? "";
      if (url.pathname === "/v1/participants") {
        return json(await market.mutate(actor, key, "register_participant", body, (tx) => registerIdentity(tx, actor!, body, now())));
      }
      if (url.pathname === "/v1/requests") return json(await market.createRequest(actor, body, key));
      if (url.pathname === "/v1/sources/buyer-notices/search") {
        validateTool("search_buyer_notices", body);
        const args = body as { query: string; limit?: number };
        return json(await market.searchBuyerNotices(args.query, args.limit));
      }
      if (url.pathname === "/v1/sources/public-buyer-notices/search") {
        validateTool("search_public_buyer_notices", body);
        return json(await market.searchPublicBuyerNotices(actor, body as { cpvCode?: string; keywords?: string; publishedFrom?: string; publishedTo?: string; limit?: number }));
      }
      if (parts[0] === "v1" && parts[1] === "requests" && parts.length === 4) {
        const id = parts[2]!;
        if (parts[3] === "discover") { emptyBody(body); return json(await market.startDiscovery(actor, id, key)); }
        if (parts[3] === "quote-requests") {
          if (!record(body) || Object.keys(body).length !== 1 || typeof body.supplierId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.supplierId)) throw new PlatformError(400, "INVALID_INPUT");
          return json(await market.requestQuote(actor, id, body.supplierId, key));
        }
        if (parts[3] === "offers") {
          if (!record(body) || body.requestId !== id) throw new PlatformError(400, "REQUEST_MISMATCH");
          return json(await market.submitOffer(actor, body, key));
        }
      }
      if (parts[0] === "v1" && parts[1] === "discoveries" && parts.length === 4) {
        const id = parts[2]!;
        if (parts[3] === "assessments") return json(await market.submitAssessment(actor, id, body, key));
        if (parts[3] === "resolve") { emptyBody(body); return json(await market.resolve(actor, id)); }
      }
      if (parts[0] === "v1" && parts[1] === "offers" && parts.length === 4 && parts[3] === "acceptances") {
        emptyBody(body); return json(await market.acceptOffer(actor, parts[2]!, key));
      }
      if (parts[0] === "v1" && parts[1] === "orders" && parts.length === 4 && parts[3] === "settle") {
        emptyBody(body); return json(await market.settle(actor, parts[2]!));
      }
      throw new PlatformError(404, "NOT_FOUND");
    } catch (error) {
      if (error instanceof PlatformError || error instanceof IdentityError) return json({ error: error.code, code: error.code,
        ...(error.code === "ALREADY_REGISTERED" && actor ? { participantId: actor.participantId } : {}) }, error.status);
      if (error instanceof DiscoveryInputError) return json({ error: error.code, code: error.code }, error.code === "FORBIDDEN" ? 403 : 400);
      if (error instanceof PaymentRefusedError) return json({ error: error.code, code: error.code }, 403);
      if (error instanceof PaymentUnavailableError) return json({ error: "SANDBOX_PAYMENT_UNAVAILABLE" }, 503);
      if (error instanceof URIError) return json({ error: "INVALID_PATH" }, 400);
      // SQL/provider text, stacks, tokens and private limits never cross the public error boundary.
      return json({ error: "PLATFORM_UNAVAILABLE", code: "PLATFORM_UNAVAILABLE" }, 503);
    }
  }
  return { handle, async readiness() {
    let sourcingReady = false;
    try {
      await db.query("select buyer_notice_number from marketplace.sourcing_requests limit 0");
      await db.query("select evidence_bundle,result from marketplace.discovery_runs limit 0");
      sourcingReady = true;
    } catch { /* Missing migrations/DB remain unavailable, not silently replaced by memory state. */ }
    return { sourcingReady, sandboxPaymentConfigured: options.paymentConfigured === true, endToEndVerified: false };
  } };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function emptyBody(body: unknown): void { if (!record(body) || Object.keys(body).length) throw new PlatformError(400, "INVALID_INPUT"); }
function json(value: unknown, status = 200): Response { return Response.json(value, { status, headers: { "cache-control": "no-store" } }); }
function methodNotAllowed(method: string): Response { return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405, headers: { allow: method } }); }
function validateTool(name: string, value: unknown): void {
  const tool = findTool(name);
  if (!tool || !validateJsonSchema(tool.inputSchema, value, "input").ok) throw new PlatformError(400, "INVALID_INPUT");
}

/** Bound both HTTP and MCP JSON before any schema traversal, hashing or database call. */
async function jsonBody(request: Request): Promise<{ raw: string; body: unknown }> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new PlatformError(415, "JSON_REQUIRED");
  if (!request.body) throw new PlatformError(400, "JSON_REQUIRED");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    let raw = "", bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw new PlatformError(413, "BODY_TOO_LARGE");
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new PlatformError(400, "INVALID_JSON"); }
    const stack: { value: unknown; depth: number }[] = [{ value: body, depth: 0 }];
    while (stack.length) {
      const current = stack.pop()!;
      if (current.depth > 16) throw new PlatformError(400, "JSON_TOO_DEEP");
      if (typeof current.value === "object" && current.value !== null) for (const value of Object.values(current.value)) stack.push({ value, depth: current.depth + 1 });
    }
    return { raw, body };
  };
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PlatformError(408, "BODY_TIMEOUT")), 5000);
    })]);
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
