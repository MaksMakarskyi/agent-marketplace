import { readFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";

import type { ActorContext } from "../../../src/contracts.js";
import type { AgentAssessment } from "../../../src/sourcing/assessment.js";
import type { Database } from "../../../src/platform/database.js";
import type { PaymentAttempt, PaymentCredential, PaymentOutcome, PaymentProvider, PaymentStatus } from "../../../src/payments/types.js";
import type { AttemptUpdate, PaymentStore } from "../../../src/payments/settlement.js";
import { Marketplace } from "../../../src/platform/marketplace.js";
import { createPlatformHttp } from "../../../src/platform/http.js";
import { SettlementService } from "../../../src/payments/settlement.js";
import { ApiEvidenceCollector } from "../../../src/sourcing/discovery.js";
import { TedClient } from "../../../src/sourcing/ted.js";
import { TavilySearch } from "../../../src/sourcing/search.js";
import { TavilyExtract } from "../../../src/sourcing/extract.js";

/**
 * Disposable live-platform fixture for agent tests.
 *
 * It runs the real authenticated HTTP + MCP handler, the real Marketplace and the real sourcing
 * assessment pipeline against in-process PGlite. Only the external network (TED, Tavily) and the
 * payment provider are stubbed. Never a production backend and never hosted evidence.
 */
export const FIXED_NOW = new Date("2026-10-30T12:00:00Z");
export const NOTICE_NUMBER = "123456-2026";
export const BUYER_DOMAIN = "buyer.example.com";
export const SUPPLIER_DOMAIN = "alpha.example.com";

const BUYER_COMPANY = "Example Buyer";
const SUPPLIER_COMPANY = "Alpha Components";
const DEFAULT_SOURCE_TEXT =
  "Alpha Components manufactures steel components. ISO 9001:2015 certified. " +
  "Delivery within the European Union from our Warsaw plant.";

export interface LivePlatformOptions {
  buyerMaxOrderMinor?: number;
  buyerMaxRunMinor?: number;
  supplierMinMinor?: number;
  supplierQuantity?: number;
  sourceText?: string;
  /** Domain of the page the assessment may cite; defaults to the registered supplier domain. */
  sourceDomain?: string;
  /** Domain of the registered supplier participant; differs from sourceDomain for an unconnected lead. */
  supplierDomain?: string;
  paymentOutcome?: "succeeded" | "failed" | "requires_action";
  discoveryFailure?: string;
  /** Leave both participants unregistered so the agents must register through the API. */
  unregistered?: boolean;
}

export interface LivePlatform {
  url: string;
  tokens: { buyer: string; supplier: string };
  actors: { buyer: ActorContext; supplier: ActorContext };
  market: Marketplace;
  counts: { orders(): Promise<number>; quoteRequests(): Promise<number>; settlements(): Promise<number> };
  close(): Promise<void>;
}

/** In-memory payment boundary; the provider is stubbed, the settlement rules are real. */
class MemoryPaymentStore implements PaymentStore {
  private readonly attempts = new Map<string, PaymentAttempt>();
  claims = 0;
  outcome: "succeeded" | "failed" | "requires_action";

  constructor(outcome: "succeeded" | "failed" | "requires_action") {
    this.outcome = outcome;
  }

  getCredential(participantId: string): Promise<PaymentCredential | undefined> {
    return Promise.resolve({ participantId, stripeCustomerId: `cus_${participantId}`, stripePaymentMethodId: "pm_sandbox", sandboxOnly: true });
  }

  claimAttempt(
    attempt: PaymentAttempt,
    maxCommittedMinor: number,
  ): Promise<{ claimed: true } | { claimed: false; reason: "exists"; existing: PaymentAttempt } | { claimed: false; reason: "run_total_exceeded" }> {
    const existing = this.attempts.get(attempt.orderId);
    if (existing !== undefined) {
      return Promise.resolve({ claimed: false, reason: "exists", existing });
    }
    const committed = [...this.attempts.values()]
      .filter((entry) => entry.status !== "failed")
      .reduce((sum, entry) => sum + entry.amount.amountMinor, 0);
    if (committed + attempt.amount.amountMinor > maxCommittedMinor) {
      return Promise.resolve({ claimed: false, reason: "run_total_exceeded" });
    }
    this.attempts.set(attempt.orderId, attempt);
    this.claims += 1;
    return Promise.resolve({ claimed: true });
  }

  getAttempt(orderId: string): Promise<PaymentAttempt | undefined> {
    return Promise.resolve(this.attempts.get(orderId));
  }

  updateAttempt(orderId: string, expected: PaymentStatus, next: AttemptUpdate): Promise<boolean> {
    const attempt = this.attempts.get(orderId);
    if (attempt === undefined || attempt.status !== expected) {
      return Promise.resolve(false);
    }
    this.attempts.set(orderId, {
      ...attempt,
      status: next.status,
      ...(next.providerPaymentId === undefined ? {} : { providerPaymentId: next.providerPaymentId }),
      ...(next.failureCode === undefined ? {} : { failureCode: next.failureCode }),
    });
    return Promise.resolve(true);
  }

  hasWebhookEvent(): Promise<boolean> {
    return Promise.resolve(false);
  }

  recordWebhookEvent(): Promise<void> {
    return Promise.resolve();
  }

  emitPaymentUpdated(): Promise<void> {
    return Promise.resolve();
  }
}

class StubProvider implements PaymentProvider {
  readonly sandboxOnly = true as const;

  constructor(private readonly outcome: "succeeded" | "failed" | "requires_action") {}

  createPayment(): Promise<PaymentOutcome> {
    if (this.outcome === "succeeded") {
      return Promise.resolve({ status: "succeeded", providerPaymentId: "pi_sandbox_agent_fixture" });
    }
    if (this.outcome === "requires_action") {
      return Promise.resolve({ status: "requires_action", providerPaymentId: "pi_sandbox_requires_action" });
    }
    return Promise.resolve({ status: "failed", code: "card_declined" });
  }
}

function sourcingFetcher(sourceText: string, sourceDomain: string, failure: string | undefined): typeof fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (failure !== undefined) {
      return new Response(failure, { status: 503 });
    }
    if (url.includes("ted.europa.eu")) {
      return Response.json({
        notices: [
          {
            "publication-number": NOTICE_NUMBER,
            "publication-date": "2026-10-30Z",
            "notice-type": "cn-standard",
            "notice-title": { eng: "Steel components" },
            "description-proc": { eng: "Steel components ISO 9001:2015" },
          },
        ],
        totalNoticeCount: 1,
        timedOut: false,
      });
    }
    if (url.endsWith("/search")) {
      return Response.json({
        results: [{ url: `https://${sourceDomain}/products`, title: SUPPLIER_COMPANY, content: "Lead only" }],
      });
    }
    return Response.json({
      results: [{ url: `https://${sourceDomain}/products`, raw_content: sourceText }],
      failed_results: [],
    });
  };
}

export async function createLivePlatform(options: LivePlatformOptions = {}): Promise<LivePlatform> {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated;");
  for (const name of ["20261030120000_initial_schema.sql", "20261030133000_live_marketplace_api.sql"]) {
    await db.exec(readFileSync(join(process.cwd(), "supabase", "migrations", name), "utf8"));
  }

  const buyerMax = options.buyerMaxOrderMinor ?? 20_000;
  const buyerRun = options.buyerMaxRunMinor ?? 40_000;
  const supplierMin = options.supplierMinMinor ?? 1_000;
  const supplierQuantity = options.supplierQuantity ?? 10;
  const sourceDomain = options.sourceDomain ?? SUPPLIER_DOMAIN;
  const supplierDomain = options.supplierDomain ?? SUPPLIER_DOMAIN;

  await db.exec(`insert into marketplace.operator_grants(id,role,currency,expires_at,allowed_categories,max_order_total_minor,max_run_total_minor,created_by)
    values('gb','buyer','EUR','2099-01-02Z','{components}',${buyerMax},${buyerRun},'fixture');
    insert into marketplace.operator_grants(id,role,currency,expires_at,min_delivered_total_minor,max_available_quantity,created_by)
    values('gs','supplier','EUR','2099-01-02Z',${supplierMin},${supplierQuantity},'fixture');
    insert into marketplace.participants(id,grant_id,role,company_name,official_domain,registered_at)
    values('buyer','gb','buyer','${BUYER_COMPANY}','${BUYER_DOMAIN}',now()),('supplier','gs','supplier','${SUPPLIER_COMPANY}','${supplierDomain}',now());
    insert into marketplace.mandates(participant_id,role,currency,expires_at,max_order_total_minor,max_run_total_minor,allowed_categories,destination)
    values('buyer','buyer','EUR','2099-01-02Z',${buyerMax},${buyerRun},'{components}','EU');
    insert into marketplace.mandates(participant_id,role,currency,expires_at,min_delivered_total_minor,available_quantity,unit,earliest_delivery_at)
    values('supplier','supplier','EUR','2099-01-02Z',${supplierMin},${supplierQuantity},'box','2026-11-15Z');`);

  if (options.unregistered === true) {
    // Grants and tokens exist; registration (company + mandate) is left to the agents.
    await db.exec("delete from marketplace.mandates; update marketplace.participants set registered_at = null, company_name = null, official_domain = null;");
  }
  const tokens = { buyer: "fixture-buyer-token", supplier: "fixture-supplier-token" };
  for (const [participantId, token] of [["buyer", tokens.buyer], ["supplier", tokens.supplier]] as const) {
    await db.query("insert into marketplace.api_credentials(token_hash,participant_id) values($1,$2)", [
      createHash("sha256").update(token).digest("hex"),
      participantId,
    ]);
  }
  await db.exec("set role marketplace_app");

  const database: Database = {
    query: (sql, params) => db.query(sql, params),
    transaction: (action) => db.transaction((tx) => action(tx)),
  };

  const fetcher = sourcingFetcher(options.sourceText ?? DEFAULT_SOURCE_TEXT, sourceDomain, options.discoveryFailure);
  const collector = new ApiEvidenceCollector({
    now: () => FIXED_NOW,
    ted: new TedClient({ now: () => FIXED_NOW, fetch: fetcher }),
    search: new TavilySearch({ now: () => FIXED_NOW, fetch: fetcher, access: { mode: "keyless" } }),
    extract: new TavilyExtract({ now: () => FIXED_NOW, fetch: fetcher, access: { mode: "keyless" } }),
  });
  const paymentStore = new MemoryPaymentStore(options.paymentOutcome ?? "succeeded");
  const market = new Marketplace(database, {
    collector,
    now: () => FIXED_NOW,
    ted: new TedClient({ now: () => FIXED_NOW, fetch: fetcher }),
    settlement: new SettlementService(paymentStore, new StubProvider(options.paymentOutcome ?? "succeeded"), () => FIXED_NOW),
    paymentStore,
  });

  const platform = createPlatformHttp(database, market, { now: () => FIXED_NOW, paymentConfigured: true });
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8");
    const request = new Request(`http://127.0.0.1:${(server.address() as { port: number }).port}${req.url ?? "/"}`, {
      method: req.method ?? "GET",
      headers: req.headers as Record<string, string>,
      ...(body === undefined ? {} : { body }),
    });
    const response = await platform.handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    tokens,
    actors: {
      buyer: { participantId: "buyer", role: "buyer", demo: true },
      supplier: { participantId: "supplier", role: "supplier", demo: true },
    },
    market,
    counts: {
      orders: async () => Number(((await db.query("select count(*)::int as n from marketplace.orders")).rows[0] as { n: number }).n),
      quoteRequests: async () => Number(((await db.query("select count(*)::int as n from marketplace.quote_requests")).rows[0] as { n: number }).n),
      settlements: async () => paymentStore.claims,
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}

/**
 * A valid client assessment for the fixture source. Tests use it as the stand-in for the client
 * model's semantic work; production Grok writes this itself from the evidence it reads.
 */
export function fixtureAssessment(
  discoveryId: string,
  overrides: { noticeNumber?: string; quotation?: string; domain?: string; company?: string; requirementKey?: string } = {},
): AgentAssessment {
  const sourceId = `${discoveryId}:source-1`;
  return {
    discoveryId,
    buyerNoticeNumber: overrides.noticeNumber ?? NOTICE_NUMBER,
    candidates: [
      {
        company: { name: overrides.company ?? SUPPLIER_COMPANY, officialDomain: overrides.domain ?? SUPPLIER_DOMAIN },
        identity: {
          sourceId,
          quotation: overrides.quotation ?? "Alpha Components manufactures steel components.",
        },
        claims: [
          {
            requirementKey: overrides.requirementKey ?? "quality",
            outcome: "match",
            sourceId,
            quotation: "ISO 9001:2015 certified.",
          },
        ],
      },
    ],
  };
}
