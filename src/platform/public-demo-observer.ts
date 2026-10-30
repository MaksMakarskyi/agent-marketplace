import type { Database } from "./database.js";
import { PlatformError } from "./database.js";
import { listDemoRuns, publicActivity, runView, type ObserverSession } from "./observer-runs.js";
import type { ObserverBus } from "./observer.js";

const PREFIX = "/v1/demo-observer/";
const DEFAULT_ORIGINS = ["https://agentmarketplace.pages.dev"];

export interface PublicDemoObserverOptions {
  /** Set false only to disable the read-only public demo view. It is enabled by default. */
  enabled?: boolean;
  allowedOrigins?: readonly string[];
  environment?: string;
  observer?: ObserverBus;
  now?: () => Date;
}

/** Public, read-only view of the bounded recent history for registered demo buyer accounts. */
export function createPublicDemoObserver(db: Database, options: PublicDemoObserverOptions = {}) {
  const now = options.now ?? (() => new Date());
  const configuredOrigins = options.allowedOrigins?.length ? options.allowedOrigins : DEFAULT_ORIGINS;
  const origins = new Set(configuredOrigins.filter(exactHttpsOrigin));
  const environment = options.environment ?? "hosted";

  return async function handlePublicDemoObserver(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = routeFor(url.pathname);
    const origin = request.headers.get("origin");
    const cors: Record<string, string> = origin !== null && origins.has(origin)
      ? { "access-control-allow-origin": origin, vary: "Origin" } : { vary: "Origin" };
    const headers = { ...cors, "cache-control": "no-store" };
    if (!route) return Response.json({ error: "NOT_FOUND", code: "NOT_FOUND" }, { status: 404, headers });
    if (request.method === "OPTIONS") {
      if (!origin || !origins.has(origin)) return new Response(null, { status: 403, headers });
      return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET",
        "access-control-allow-headers": "content-type", "access-control-max-age": "600" } });
    }
    try {
      if (request.method !== "GET") throw new PlatformError(405, "METHOD_NOT_ALLOWED");
      if (options.enabled === false) throw new PlatformError(404, "NOT_FOUND");
      let projection: unknown;
      if (route.kind === "activity") {
        projection = publicActivity(options.observer);
      } else if (route.runId === undefined) {
        projection = await listDemoRuns(db);
      } else {
        // Resolve the buyer from the run itself, on the server. The URL never chooses an account.
        const row = (await db.query(
          `select r.buyer_id from marketplace.sourcing_requests r
           join marketplace.participants p on p.id=r.buyer_id and p.role='buyer' and p.demo=true and p.registered_at is not null
           join marketplace.operator_grants g on g.id=p.grant_id and g.role='buyer' and g.demo=true
           where r.id=$1 and r.demo=true`, [route.runId])).rows[0];
        if (!row) throw new PlatformError(404, "NOT_FOUND");
        const session: ObserverSession = { id: "public-demo", buyerParticipantId: String(row.buyer_id), label: "Public demo", expiresAt: null };
        projection = await runView(db, session, route.runId, now(), environment);
      }
      return Response.json(projection, { headers });
    } catch (error) {
      if (error instanceof PlatformError) return Response.json({ error: error.code, code: error.code }, { status: error.status, headers });
      return Response.json({ error: "PLATFORM_UNAVAILABLE", code: "PLATFORM_UNAVAILABLE" }, { status: 503, headers });
    }
  };
}

type PublicRoute = { kind: "runs"; runId?: string } | { kind: "activity" };

function routeFor(pathname: string): PublicRoute | undefined {
  if (pathname === `${PREFIX}runs`) return { kind: "runs" };
  if (pathname === `${PREFIX}activity`) return { kind: "activity" };
  if (!pathname.startsWith(`${PREFIX}runs/`)) return undefined;
  const runId = pathname.slice(`${PREFIX}runs/`.length);
  return validId(runId) ? { kind: "runs", runId } : undefined;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

function exactHttpsOrigin(origin: string): boolean {
  try { const url = new URL(origin); return url.protocol === "https:" && url.origin === origin; }
  catch { return false; }
}
