/**
 * Node HTTP entry point (Cloud Run, or local). Configuration comes only from the environment:
 *   PORT                    listen port (default 8080, as Cloud Run sets it)
 *   STRIPE_SECRET_KEY       sandbox key; live keys are refused
 *   STRIPE_WEBHOOK_SECRET   enables POST /webhooks/stripe; without it the route returns 501
 *   DB_CONNECTION           Postgres URL for a login role in marketplace_app
 *   DB_CA_FILE              CA certificate for TLS verification (Supabase: prod-ca-2021.crt)
 *   DB_SSL=disable          only accepted for a database on localhost
 *   OBSERVER_TOKEN          read-only token for the /observer/ws log stream; without it, loopback only
 *   OBSERVER_ALLOWED_ORIGINS comma-separated https origins of the read-only observer page (CORS)
 *   DEMO_ONBOARDING=off     disables automatic MCP-session onboarding (on by default for this demo)
 *   DEPLOYMENT_ENVIRONMENT  label shown on the observer page (default "hosted")
 *   PUBLIC_DEMO_OBSERVER=false disables the public read-only demo dashboard API (enabled by default)
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import pg from "pg";
import { handleRequest, type Dependencies } from "./index.js";
import { readStripeConfig } from "./payments/config.js";
import { PostgresPaymentStore } from "./payments/postgres-store.js";
import { SettlementService } from "./payments/settlement.js";
import { StripeClient, StripeSandboxProvider } from "./payments/stripe.js";
import { toNodeListener } from "./server-adapter.js";
import { postgresDatabase } from "./platform/database.js";
import { Marketplace } from "./platform/marketplace.js";
import { createPlatformHttp } from "./platform/http.js";
import { ObserverBus } from "./platform/observer.js";
import { attachObserverSocket, OBSERVER_PATH } from "./platform/observer-socket.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function databaseSsl(env: NodeJS.ProcessEnv, connectionString: string): pg.ClientConfig["ssl"] {
  const host = new URL(connectionString).hostname;
  if (env.DB_SSL === "disable") {
    if (!LOCAL_HOSTS.has(host)) throw new Error("DB_SSL=disable is only allowed for a database on localhost");
    return false;
  }
  if (new URL(connectionString).searchParams.has("sslmode")) {
    // pg lets a URL sslmode override the CA settings below, which would silently weaken verification.
    throw new Error("remove sslmode from DB_CONNECTION; TLS is configured with DB_CA_FILE");
  }
  return env.DB_CA_FILE ? { ca: readFileSync(env.DB_CA_FILE, "utf8") } : true;
}

/** Exact https origins (or localhost for rehearsal) allowed to call the observer API from a browser. */
export function observerOrigins(env: NodeJS.ProcessEnv): string[] {
  const origins = (env.OBSERVER_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter((value) => value !== "");
  for (const origin of origins) {
    const url = new URL(origin);
    const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
    if ((url.protocol !== "https:" && !local) || url.origin !== origin) throw new Error(`OBSERVER_ALLOWED_ORIGINS entry is not an exact https origin: ${origin}`);
  }
  return origins;
}

export function buildDependencies(env: NodeJS.ProcessEnv, observer = new ObserverBus()): { deps: Dependencies; pool?: pg.Pool; notes: string[] } {
  const notes: string[] = [];
  const connectionString = env.DB_CONNECTION;
  if (!connectionString) {
    if (env.STRIPE_WEBHOOK_SECRET) throw new Error("DB_CONNECTION is required when STRIPE_WEBHOOK_SECRET is set");
    notes.push("DB_CONNECTION not set: authenticated marketplace API is unavailable");
    return { deps: { observer }, notes };
  }
  const pool = new pg.Pool({ connectionString, ssl: databaseSsl(env, connectionString), max: 5, connectionTimeoutMillis: 10_000 });
  const paymentStore = new PostgresPaymentStore(pool);
  let settlement: SettlementService | undefined;
  let webhookSecret: string | undefined;
  let stripeClient: StripeClient | undefined;
  if (env.STRIPE_SECRET_KEY || env.STRIPE_WEBHOOK_SECRET) {
    const stripe = readStripeConfig(env, { requireWebhookSecret: !!env.STRIPE_WEBHOOK_SECRET });
    stripeClient = new StripeClient(stripe);
    settlement = new SettlementService(paymentStore, new StripeSandboxProvider(stripeClient));
    webhookSecret = stripe.webhookSecret;
  }
  const market = new Marketplace(postgresDatabase(pool), { paymentStore, ...(settlement ? { settlement } : {}) });
  const deps: Dependencies = { observer, platform: createPlatformHttp(postgresDatabase(pool), market, {
    paymentConfigured: !!settlement && !!webhookSecret,
    observer,
    publicDemoObserver: { enabled: env.PUBLIC_DEMO_OBSERVER !== "false" },
    // Demo-only: bots onboard themselves over MCP sessions unless DEMO_ONBOARDING=off.
    ...(env.DEMO_ONBOARDING === "off" ? {} : { onboarding: { stripe: stripeClient } }),
    observerApi: { allowedOrigins: observerOrigins(env), environment: env.DEPLOYMENT_ENVIRONMENT ?? "hosted" },
  }) };
  if (settlement && webhookSecret) deps.stripeWebhook = { settlement, secret: webhookSecret };
  notes.push("Authenticated marketplace API and /mcp configured; database migrations and scoped bot credentials required");
  notes.push(deps.stripeWebhook ? "POST /webhooks/stripe enabled" : "Stripe webhook not configured; hosted payment acceptance remains unverified");
  return { deps, pool, notes };
}

const isEntryPoint = import.meta.url === new URL(process.argv[1] ?? "", "file://").href;
if (isEntryPoint) {
  const observer = new ObserverBus();
  const { deps, pool, notes } = buildDependencies(process.env, observer);
  const port = Number(process.env.PORT ?? 8080);
  const server = createServer(toNodeListener((request) => handleRequest(request, deps)));
  const observerToken = process.env.OBSERVER_TOKEN?.trim() || undefined;
  const stream = attachObserverSocket(server, observer, { token: observerToken });
  notes.push(`observer stream at ${OBSERVER_PATH} (${observerToken ? "OBSERVER_TOKEN required" : "loopback only; set OBSERVER_TOKEN for remote clients"})`);
  server.listen(port, () => console.error(`listening on :${port}; ${notes.join("; ")}`));
  const shutdown = () => void stream.close().then(() => server.close(() => void pool?.end().finally(() => process.exit(0))));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
