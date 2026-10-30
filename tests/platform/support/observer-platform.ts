import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { PlatformClient } from "../../../src/agents/client.js";
import type { Database } from "../../../src/platform/database.js";
import type { ObserverBus } from "../../../src/platform/observer.js";
import type { OnboardingOptions } from "../../../src/platform/onboarding.js";
import { attachObserverSocket } from "../../../src/platform/observer-socket.js";
import { createPlatformHttp } from "../../../src/platform/http.js";
import { Marketplace } from "../../../src/platform/marketplace.js";
import { PostgresPaymentStore } from "../../../src/payments/postgres-store.js";
import { SettlementService } from "../../../src/payments/settlement.js";
import type { PaymentOutcome, PaymentProvider } from "../../../src/payments/types.js";
import { ApiEvidenceCollector } from "../../../src/sourcing/discovery.js";
import { TavilyExtract } from "../../../src/sourcing/extract.js";
import { TavilySearch } from "../../../src/sourcing/search.js";
import { TedClient } from "../../../src/sourcing/ted.js";

/**
 * Disposable observer fixture: the real authenticated handler, Marketplace, settlement rules and
 * observer projection on in-process PGlite. TED/Tavily responses and the payment provider are
 * stubbed. Everything it produces is protocol-fixture evidence, never hosted or named-client.
 */

export const NOTICE_NUMBER = "123456-2026";
export const MIGRATIONS = [
  "20261030120000_initial_schema.sql",
  "20261030133000_live_marketplace_api.sql",
  "20261030170000_observer.sql", "20261030190000_demo_onboarding.sql",
];
/** Distinctive private limits, so a test can prove none of them reaches the observer. */
export const PRIVATE = { buyerMaxOrder: 20_017, buyerMaxRun: 40_019, supplierFloor: 1_013, requestMax: 19_997 };

export type PaymentScenario = "succeeded" | "failed" | "pending";

export interface ObserverPlatformOptions {
  environment?: string;
  allowedOrigins?: string[];
  payment?: PaymentScenario;
  sourceText?: string;
  /** Second buyer whose runs the observer session must never see. */
  otherBuyer?: boolean;
  /** Delay the stubbed provider calls, so a rehearsal shows real waiting rather than instant steps. */
  providerDelayMs?: number;
  /** Wrap the database, e.g. to slow down or count trace writes. */
  wrapDb?: (db: Database) => Database;
  /** Attach the /observer/ws log stream bus. */
  observer?: ObserverBus;
  /** Enable automatic MCP-session onboarding. */
  onboarding?: OnboardingOptions;
  /** With `observer`, also serve /observer/ws on the fixture server, requiring this token. */
  streamToken?: string;
}

export interface ObserverPlatform {
  url: string;
  db: PGlite;
  tokens: { buyer: string; supplier: string; otherBuyer: string; observer: string };
  observerSessionId: string;
  setPayment(scenario: PaymentScenario): void;
  close(): Promise<void>;
}

class StubProvider implements PaymentProvider {
  readonly sandboxOnly = true as const;
  constructor(public scenario: PaymentScenario, private readonly delayMs: number) {}
  async createPayment(input: { orderId: string }): Promise<PaymentOutcome> {
    await sleep(this.delayMs);
    if (this.scenario === "failed") return { status: "failed", code: "card_declined" };
    if (this.scenario === "pending") return { status: "pending", providerPaymentId: `pi_fixture_pending_${input.orderId.slice(0, 8)}` };
    return { status: "succeeded", providerPaymentId: `pi_fixture_${input.orderId.slice(0, 8)}` };
  }
}

export async function createObserverPlatform(options: ObserverPlatformOptions = {}): Promise<ObserverPlatform> {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated;");
  for (const name of MIGRATIONS) {
    await db.exec(readFileSync(new URL(`../../../../supabase/migrations/${name}`, import.meta.url), "utf8"));
  }
  await db.exec(`insert into marketplace.operator_grants(id,role,currency,expires_at,allowed_categories,max_order_total_minor,max_run_total_minor,created_by)
      values('gb','buyer','EUR','2099-01-02Z','{components}',${PRIVATE.buyerMaxOrder},${PRIVATE.buyerMaxRun},'fixture'),
            ('gb2','buyer','EUR','2099-01-02Z','{components}',${PRIVATE.buyerMaxOrder},${PRIVATE.buyerMaxRun},'fixture');
    insert into marketplace.operator_grants(id,role,currency,expires_at,min_delivered_total_minor,max_available_quantity,created_by)
      values('gs','supplier','EUR','2099-01-02Z',${PRIVATE.supplierFloor},1000,'fixture');
    insert into marketplace.participants(id,grant_id,role,company_name,official_domain,registered_at)
      values('buyer','gb','buyer','Example Buyer','buyer.example.com',now()),
            ('buyer2','gb2','buyer','Other Buyer','other-buyer.example.com',now()),
            ('supplier','gs','supplier','Alpha Components','alpha.example.com',now());
    insert into marketplace.mandates(participant_id,role,currency,expires_at,max_order_total_minor,max_run_total_minor,allowed_categories,destination)
      values('buyer','buyer','EUR','2099-01-02Z',${PRIVATE.buyerMaxOrder},${PRIVATE.buyerMaxRun},'{components}','EU'),
            ('buyer2','buyer','EUR','2099-01-02Z',${PRIVATE.buyerMaxOrder},${PRIVATE.buyerMaxRun},'{components}','EU');
    insert into marketplace.mandates(participant_id,role,currency,expires_at,min_delivered_total_minor,available_quantity,unit,earliest_delivery_at)
      values('supplier','supplier','EUR','2099-01-02Z',${PRIVATE.supplierFloor},1000,'box','2026-01-01Z');
    insert into marketplace.payment_credentials(participant_id,stripe_customer_id,stripe_payment_method_id)
      values('buyer','cus_fixturebuyer','pm_fixturebuyer'),('buyer2','cus_fixtureother','pm_fixtureother');`);
  const tokens = {
    buyer: `fixture-buyer-${randomHex()}`,
    supplier: `fixture-supplier-${randomHex()}`,
    otherBuyer: `fixture-buyer2-${randomHex()}`,
    observer: `obs_${randomHex()}${randomHex()}`,
  };
  for (const [participantId, token] of [["buyer", tokens.buyer], ["supplier", tokens.supplier], ["buyer2", tokens.otherBuyer]] as const) {
    await db.query("insert into marketplace.api_credentials(token_hash,participant_id) values($1,$2)", [sha256(token), participantId]);
  }
  const session = (await db.query<{ id: string }>(
    `insert into marketplace.observer_sessions(token_hash,buyer_participant_id,label,created_by,expires_at)
     values($1,'buyer','Fixture rehearsal','fixture',now() + interval '8 hours') returning id`, [sha256(tokens.observer)])).rows[0]!;
  await db.exec("set role marketplace_app");

  const base: Database = { query: (sql, params) => db.query(sql, params), transaction: (action) => db.transaction((tx) => action(tx)) };
  const database = options.wrapDb ? options.wrapDb(base) : base;
  const delay = options.providerDelayMs ?? 0;
  const sourceText = options.sourceText ?? "Alpha Components manufactures steel components. ISO 9001:2015 certified. Delivery across the EU.";
  const fetcher: typeof fetch = async (input) => {
    await sleep(delay);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("ted.europa.eu")) return Response.json({ notices: [{ "publication-number": NOTICE_NUMBER, "publication-date": "2026-10-30Z",
      "notice-type": "cn-standard", "notice-title": { eng: "Steel components for maintenance depot" },
      "description-proc": { eng: "Steel components ISO 9001:2015" }, "buyer-name": { eng: ["Example Municipal Depot"] } }], totalNoticeCount: 1, timedOut: false });
    if (url.endsWith("/search")) return Response.json({ results: [{ url: "https://alpha.example.com/products", title: "Alpha Components", content: "Lead only" }] });
    return Response.json({ results: [{ url: "https://alpha.example.com/products", raw_content: sourceText }], failed_results: [] });
  };
  const collector = new ApiEvidenceCollector({ ted: new TedClient({ fetch: fetcher }),
    search: new TavilySearch({ fetch: fetcher, access: { mode: "keyless" } }), extract: new TavilyExtract({ fetch: fetcher, access: { mode: "keyless" } }) });
  const provider = new StubProvider(options.payment ?? "succeeded", delay);
  const paymentStore = new PostgresPaymentStore(database);
  const market = new Marketplace(database, { collector, ted: new TedClient({ fetch: fetcher }), paymentStore,
    settlement: new SettlementService(paymentStore, provider) });
  const platform = createPlatformHttp(database, market, { paymentConfigured: true, ...(options.observer ? { observer: options.observer } : {}), ...(options.onboarding ? { onboarding: options.onboarding } : {}),
    observerApi: { environment: options.environment ?? "local-fixture", allowedOrigins: options.allowedOrigins ?? [] } });

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8");
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
    const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, { method: req.method ?? "GET", headers, ...(body === undefined ? {} : { body }) });
    const response = await platform.handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  const stream = options.observer && options.streamToken ? attachObserverSocket(server, options.observer, { token: options.streamToken }) : undefined;
  await new Promise<void>((resolve) => server.listen(Number(process.env.OBSERVER_FIXTURE_PORT ?? 0), "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    db,
    tokens,
    observerSessionId: session.id,
    setPayment: (scenario) => { provider.scenario = scenario; },
    close: async () => { await stream?.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await db.close(); },
  };
}

export interface DriveOptions {
  /** Pause between steps (ms), so an observer can watch a rehearsal progress. */
  stepDelayMs?: number;
  /** Supplier opening ask, minor units. */
  askMinor?: number;
  /** Request a second revision from the buyer before accepting. */
  counter?: boolean;
  /** Make the only mandatory requirement unknown: the candidate ranks conditional and is never quoted. */
  unknownRequirement?: boolean;
  userAgent?: string;
  log?: (line: string) => void;
}

/**
 * Drive one run through the real API with both participants' tokens. This is a protocol-fixture
 * driver standing in for the two bots; it is labelled as such by its user agent and environment.
 */
export async function driveRun(platform: ObserverPlatform, options: DriveOptions = {}): Promise<{ requestId: string; orderId?: string }> {
  const agent = options.userAgent ?? "observer-fixture-driver/1.0";
  const fetchAs: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("user-agent", agent);
    return fetch(input, { ...init, headers });
  };
  const buyer = new PlatformClient({ baseUrl: platform.url, token: platform.tokens.buyer, fetchImpl: fetchAs, retry: { attempts: 1, baseDelayMs: 0 } });
  const supplier = new PlatformClient({ baseUrl: platform.url, token: platform.tokens.supplier, fetchImpl: fetchAs, retry: { attempts: 1, baseDelayMs: 0 } });
  const pause = () => sleep(options.stepDelayMs ?? 0);
  const log = options.log ?? (() => undefined);
  const run = randomHex();

  await buyer.getMyParticipant();
  const request = await buyer.createRequest({ category: "components", description: "Steel components for a maintenance depot", quantity: 10, unit: "box",
    destination: "EU", maximumDeliveredTotal: { amountMinor: PRIVATE.requestMax, currency: "EUR" }, deliverBy: "2099-01-01T00:00:00Z",
    requirements: [{ key: "quality", description: "ISO 9001:2015", mandatory: true }], buyerNoticeNumber: NOTICE_NUMBER, demo: true } as never,
  { idempotencyKey: `observer-request-${run}` });
  log(`request ${request.id}`);
  await pause();
  const { discoveryId } = await buyer.startDiscovery(request.id, { idempotencyKey: `observer-discover-${run}` });
  await buyer.getDiscoveryEvidence(discoveryId);
  await buyer.readDiscoverySource(discoveryId, `${discoveryId}:source-1`, { offset: 0, limit: 8000 });
  await pause();
  const claims = options.unknownRequirement === true
    ? [{ requirementKey: "quality", outcome: "unknown" as const }]
    : [{ requirementKey: "quality", outcome: "match" as const, sourceId: `${discoveryId}:source-1`, quotation: "ISO 9001:2015 certified." }];
  await buyer.submitDiscoveryAssessment(discoveryId, { discoveryId, buyerNoticeNumber: NOTICE_NUMBER, candidates: [{
    company: { name: "Alpha Components", officialDomain: "alpha.example.com" },
    identity: { sourceId: `${discoveryId}:source-1`, quotation: "Alpha Components manufactures steel components." }, claims }] } as never);
  log("assessment submitted");
  await pause();
  const resolved = await buyer.resolveDiscoveryParticipants(discoveryId) as { resolutions: { participantId?: string; eligible: string }[] };
  const target = resolved.resolutions.find((entry) => entry.participantId !== undefined && entry.eligible === "yes");
  if (!target?.participantId) { log("no eligible connected supplier: no quote"); return { requestId: request.id }; }
  await pause();
  await buyer.requestQuote(request.id, target.participantId, { idempotencyKey: `observer-quote-${run}` });
  await pause();
  await supplier.listEvents();
  await supplier.getRequest(request.id);
  const terms = { requestId: request.id, quantity: 10, unit: "box", destination: "EU", taxMinor: 0, deliveryMinor: 0,
    deliveryAt: "2098-01-01T00:00:00Z", expiresAt: "2098-01-01T00:00:00Z", confirmedRequirementKeys: ["quality"],
    termsOrigin: "demo-supplier-declaration", demo: true };
  const strip = (body: Record<string, unknown>) => body as never;
  let offer = await supplier.submitOffer(strip({ ...terms, deliveredTotal: { amountMinor: options.askMinor ?? 15_000, currency: "EUR" } }),
    { idempotencyKey: `observer-offer-1-${run}` });
  log(`supplier offer revision 1: ${offer.deliveredTotal.amountMinor}`);
  await pause();
  if (options.counter === true) {
    await buyer.getOffer(offer.id);
    offer = await buyer.submitOffer(strip({ ...terms, previousOfferId: offer.id, deliveredTotal: { amountMinor: Math.floor((options.askMinor ?? 15_000) * 0.9), currency: "EUR" } }),
      { idempotencyKey: `observer-offer-2-${run}` });
    log(`buyer counter revision 2: ${offer.deliveredTotal.amountMinor}`);
    await pause();
    await supplier.getOffer(offer.id);
    const accepted = await supplier.acceptOffer(offer.id, { idempotencyKey: `observer-accept-${run}` });
    if (accepted.state !== "agreed") return { requestId: request.id };
    log(`agreed: order ${accepted.order.id}`);
    await pause();
    await buyer.settleOrder(accepted.order.id);
    await buyer.getOrder(accepted.order.id);
    await supplier.getOrder(accepted.order.id);
    return { requestId: request.id, orderId: accepted.order.id };
  }
  await buyer.getOffer(offer.id);
  const accepted = await buyer.acceptOffer(offer.id, { idempotencyKey: `observer-accept-${run}` });
  if (accepted.state !== "agreed") return { requestId: request.id };
  log(`agreed: order ${accepted.order.id}`);
  await pause();
  await buyer.settleOrder(accepted.order.id);
  await buyer.getOrder(accepted.order.id);
  await supplier.getOrder(accepted.order.id);
  return { requestId: request.id, orderId: accepted.order.id };
}

/** An MCP client announcing itself, as a named bot does when it attaches the plugin. */
export async function announceMcpClient(platform: ObserverPlatform, token: string, name: string, version: string): Promise<void> {
  const response = await fetch(`${platform.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`,
    "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version } } }) });
  await response.arrayBuffer();
}

export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function randomHex(): string { return createHash("sha256").update(`${Math.random()}${process.hrtime.bigint()}`).digest("hex").slice(0, 24); }
function sleep(ms: number): Promise<void> { return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)); }
