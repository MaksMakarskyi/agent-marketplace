import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { ActorContext } from "../../../src/contracts.js";
import type { Database } from "../../../src/platform/database.js";
import { Marketplace } from "../../../src/platform/marketplace.js";
import { createPlatformHttp } from "../../../src/platform/http.js";
import { handleRequest, type Dependencies } from "../../../src/index.js";
import { ApiEvidenceCollector } from "../../../src/sourcing/discovery.js";
import { TedClient } from "../../../src/sourcing/ted.js";
import { TavilySearch } from "../../../src/sourcing/search.js";
import { TavilyExtract } from "../../../src/sourcing/extract.js";

// Disposable PGlite with both real migrations and fixture-only provider responses. Not hosted evidence.
export const now = () => new Date("2026-10-30T12:00:00Z");
export const buyer: ActorContext = { participantId: "buyer", role: "buyer", demo: true };
export const supplier: ActorContext = { participantId: "supplier", role: "supplier", demo: true };
export const requestInput = { category: "components", description: "Steel components", quantity: 10, unit: "box", destination: "EU",
  maximumDeliveredTotal: { amountMinor: 20000, currency: "EUR" }, deliverBy: "2099-01-01T00:00:00Z",
  requirements: [{ key: "quality", description: "ISO 9001:2015", mandatory: true }], buyerNoticeNumber: "123456-2026", demo: true };
/** Supplier fixture limits: floor 1000 minor, capacity 10, earliest delivery 2026-01-01. */
export const SUPPLIER_FLOOR_MINOR = 1000;

export function offerTerms(requestId: string, amountMinor: number, extra: Record<string, unknown> = {}) {
  return { requestId, quantity: 10, unit: "box", destination: "EU", deliveredTotal: { amountMinor, currency: "EUR" }, taxMinor: 0, deliveryMinor: 0,
    deliveryAt: "2098-01-01T00:00:00Z", expiresAt: "2098-01-01T00:00:00Z", confirmedRequirementKeys: ["quality"],
    termsOrigin: "demo-supplier-declaration", demo: true, ...extra };
}

export async function fixture(options: { sourceText?: string } = {}) {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated;");
  for (const name of ["20261030120000_initial_schema.sql", "20261030133000_live_marketplace_api.sql"]) {
    await db.exec(readFileSync(new URL(`../../../../supabase/migrations/${name}`, import.meta.url), "utf8"));
  }
  await db.exec(`insert into marketplace.operator_grants(id,role,currency,expires_at,allowed_categories,max_order_total_minor,max_run_total_minor,created_by)
    values('gb','buyer','EUR','2099-01-02Z','{components}',20000,40000,'fixture');
    insert into marketplace.operator_grants(id,role,currency,expires_at,min_delivered_total_minor,max_available_quantity,created_by)
    values('gs','supplier','EUR','2099-01-02Z',${SUPPLIER_FLOOR_MINOR},10,'fixture');
    insert into marketplace.participants(id,grant_id,role,company_name,official_domain,registered_at)
    values('buyer','gb','buyer','Example Buyer','buyer.example.com',now()),('supplier','gs','supplier','Alpha Components','alpha.example.com',now());
    insert into marketplace.mandates(participant_id,role,currency,expires_at,max_order_total_minor,max_run_total_minor,allowed_categories,destination)
    values('buyer','buyer','EUR','2099-01-02Z',20000,40000,'{components}','EU');
    insert into marketplace.mandates(participant_id,role,currency,expires_at,min_delivered_total_minor,available_quantity,unit,earliest_delivery_at)
    values('supplier','supplier','EUR','2099-01-02Z',${SUPPLIER_FLOOR_MINOR},10,'box','2026-01-01Z');`);
  for (const participant of [buyer, supplier]) await db.query("insert into marketplace.api_credentials(token_hash,participant_id) values($1,$2)",
    [createHash("sha256").update(`fixture-${participant.participantId}-token`).digest("hex"), participant.participantId]);
  await db.exec("set role marketplace_app");
  const database: Database = { query: (sql, params) => db.query(sql, params), transaction: (action) => db.transaction((tx) => action(tx)) };
  const fetcher = async (request: Request) => {
    if (request.url.includes("ted.europa.eu")) return Response.json({ notices: [{ "publication-number": "123456-2026", "publication-date": "2026-10-30Z",
      "notice-type": "cn-standard", "notice-title": { eng: "Steel components" }, "description-proc": { eng: "Steel components ISO 9001:2015" } }], totalNoticeCount: 1, timedOut: false });
    if (request.url.endsWith("/search")) return Response.json({ results: [{ url: "https://alpha.example.com/products", title: "Alpha", content: "Lead only" }] });
    return Response.json({ results: [{ url: "https://alpha.example.com/products", raw_content: options.sourceText ?? "Alpha Components manufactures steel components. ISO 9001:2015 certified." }], failed_results: [] });
  };
  const collector = new ApiEvidenceCollector({ now, ted: new TedClient({ now, fetch: fetcher }),
    search: new TavilySearch({ now, fetch: fetcher, access: { mode: "keyless" } }), extract: new TavilyExtract({ now, fetch: fetcher, access: { mode: "keyless" } }) });
  const market = new Marketplace(database, { collector, now, ted: new TedClient({ now, fetch: fetcher }) });
  const platform = createPlatformHttp(database, market, { now });
  let keys = 0;
  /** Authenticated call through the real HTTP entry point. */
  const call = (path: string, body?: unknown, token = "fixture-buyer-token", key = `http-fixture-key-${++keys}`) =>
    handleRequest(new Request(`https://marketplace.example.com${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { platform } as unknown as Dependencies);
  return { db, market, platform, call };
}

/** Request → discovery → client assessment → ranking → connected account → quote. */
export async function quotedRequest(market: Marketplace) {
  const request = await market.createRequest(buyer, requestInput, "create-request-1");
  const { discoveryId } = await market.startDiscovery(buyer, request.id, "discover-request-1");
  await market.submitAssessment(buyer, discoveryId, { discoveryId, buyerNoticeNumber: requestInput.buyerNoticeNumber,
    candidates: [{ company: { name: "Alpha Components", officialDomain: "alpha.example.com" },
      identity: { sourceId: `${discoveryId}:source-1`, quotation: "Alpha Components manufactures steel components." },
      claims: [{ requirementKey: "quality", outcome: "match", sourceId: `${discoveryId}:source-1`, quotation: "ISO 9001:2015 certified." }] }] }, "assessment-request-1");
  await market.resolve(buyer, discoveryId);
  await market.requestQuote(buyer, request.id, supplier.participantId, "quote-request-1");
  return request;
}
