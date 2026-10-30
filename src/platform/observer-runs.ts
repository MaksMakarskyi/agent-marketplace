import { createHash } from "node:crypto";
import type { Queryable } from "../payments/postgres-store.js";
import { PlatformError } from "./database.js";
import type { ObserverLog, ObserverBus } from "./observer.js";

/**
 * Read-only observer for the live demo.
 *
 * Traces record which authenticated participant performed which operation and when, with ids only:
 * no request/response bodies, limits, tokens or headers. The projection exposes one demo buyer's
 * runs to an operator-issued observer session. It never reads mandates, grants, credentials,
 * payment methods or a request's private maximum total.
 */

export const OBSERVER_TOKEN_PREFIX = "obs_";
const MAX_TRACES = 300;
const MAX_RUNS = 20;

export interface ObserverSession {
  id: string;
  buyerParticipantId: string;
  label: string;
  expiresAt: string | null;
}

export type TraceChannel = "mcp" | "http";

export interface TraceIds {
  requestId?: string;
  discoveryId?: string;
  offerId?: string;
  orderId?: string;
}

export interface OperationMatch {
  operation: string;
  ids: TraceIds;
  /** Polling reads refresh the participant's last-seen time instead of adding a trace row. */
  polling: boolean;
}

/** Map an authenticated API route to the MCP tool name that performs it. */
export function operationFor(method: string, parts: readonly string[]): OperationMatch | undefined {
  if (parts[0] !== "v1") return undefined;
  const [, resource, id, sub, subId] = parts;
  const n = parts.length;
  if (method === "GET") {
    if (resource === "me" && n === 2) return { operation: "get_my_participant", ids: {}, polling: true };
    if (resource === "events" && n === 2) return { operation: "list_events", ids: {}, polling: true };
    if (resource === "requests" && n === 3) return { operation: "get_request", ids: { requestId: id! }, polling: false };
    if (resource === "offers" && n === 3) return { operation: "get_offer", ids: { offerId: id! }, polling: false };
    if (resource === "orders" && n === 3) return { operation: "get_order", ids: { orderId: id! }, polling: false };
    if (resource === "discoveries" && n === 3) return { operation: "get_discovery", ids: { discoveryId: id! }, polling: false };
    if (resource === "discoveries" && n === 4 && sub === "evidence") return { operation: "get_discovery_evidence", ids: { discoveryId: id! }, polling: false };
    if (resource === "discoveries" && n === 5 && sub === "sources" && subId) return { operation: "read_discovery_source", ids: { discoveryId: id! }, polling: false };
    return undefined;
  }
  if (method !== "POST") return undefined;
  if (resource === "participants" && n === 2) return { operation: "register_participant", ids: {}, polling: false };
  if (resource === "requests" && n === 2) return { operation: "create_request", ids: {}, polling: false };
  if (resource === "sources" && n === 4 && id === "buyer-notices" && sub === "search") return { operation: "search_buyer_notices", ids: {}, polling: false };
  if (resource === "requests" && n === 4 && sub === "discover") return { operation: "start_discovery", ids: { requestId: id! }, polling: false };
  if (resource === "requests" && n === 4 && sub === "quote-requests") return { operation: "request_quote", ids: { requestId: id! }, polling: false };
  if (resource === "requests" && n === 4 && sub === "offers") return { operation: "submit_offer", ids: { requestId: id! }, polling: false };
  if (resource === "discoveries" && n === 4 && sub === "assessments") return { operation: "submit_discovery_assessment", ids: { discoveryId: id! }, polling: false };
  if (resource === "discoveries" && n === 4 && sub === "resolve") return { operation: "resolve_discovery_participants", ids: { discoveryId: id! }, polling: false };
  if (resource === "offers" && n === 4 && sub === "acceptances") return { operation: "accept_offer", ids: { offerId: id! }, polling: false };
  if (resource === "orders" && n === 4 && sub === "settle") return { operation: "settle_order", ids: { orderId: id! }, polling: false };
  return undefined;
}

/** Ids created by a successful operation, read from its JSON response. */
export function idsFromResponse(operation: string, body: unknown): TraceIds {
  if (!isRecord(body)) return {};
  const id = boundedId(body.id);
  switch (operation) {
    case "create_request": return id ? { requestId: id } : {};
    case "start_discovery": { const discoveryId = boundedId(body.discoveryId); return discoveryId ? { discoveryId } : {}; }
    case "submit_offer": return id ? { offerId: id } : {};
    case "accept_offer": { const orderId = isRecord(body.order) ? boundedId(body.order.id) : undefined; return orderId ? { orderId } : {}; }
    default: return {};
  }
}

export function errorCodeFrom(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const code = typeof body.code === "string" ? body.code : typeof body.error === "string" ? body.error : undefined;
  return code !== undefined && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
}

export interface TraceRecord extends TraceIds {
  participantId: string;
  channel: TraceChannel;
  operation: string;
  status: number;
  errorCode?: string;
  startedAt: Date;
  finishedAt: Date;
}

/** Append one trace. The run (request id) is resolved from whichever id the operation carries. */
export async function recordTrace(db: Queryable, trace: TraceRecord): Promise<void> {
  await db.query(
    `insert into marketplace.agent_traces
       (participant_id, channel, operation, status, error_code, request_id, discovery_id, offer_id, order_id, started_at, finished_at)
     values ($1, $2, $3, $4, $5,
       coalesce($6::text,
         (select request_id from marketplace.discovery_runs where id = $7::text),
         (select request_id from marketplace.offers where id = $8::text),
         (select request_id from marketplace.orders where id = $9::text)),
       $7, $8, $9, $10, $11)`,
    [trace.participantId, trace.channel, trace.operation, trace.status, trace.errorCode ?? null,
      trace.requestId ?? null, trace.discoveryId ?? null, trace.offerId ?? null, trace.orderId ?? null,
      trace.startedAt.toISOString(), trace.finishedAt.toISOString()],
  );
}

export interface Sighting {
  participantId: string;
  channel: TraceChannel;
  clientName: string;
  clientVersion?: string;
  protocolVersion?: string;
  at: Date;
}

/** Record a client name/version the client itself reported. Never a configured display name. */
export async function recordSighting(db: Queryable, sighting: Sighting): Promise<void> {
  const name = printable(sighting.clientName, 100);
  if (name === undefined) return;
  await db.query(
    `insert into marketplace.client_sightings
       (participant_id, channel, client_name, client_version, protocol_version, first_seen_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, $6)
     on conflict (participant_id, channel) do update
       set client_name = excluded.client_name, client_version = excluded.client_version,
           protocol_version = excluded.protocol_version, last_seen_at = excluded.last_seen_at`,
    [sighting.participantId, sighting.channel, name, printable(sighting.clientVersion, 50) ?? null,
      printable(sighting.protocolVersion, 20) ?? null, sighting.at.toISOString()],
  );
}

/** Refresh last-seen for a client that was already sighted on this channel. */
export async function touchSighting(db: Queryable, participantId: string, channel: TraceChannel, at: Date): Promise<void> {
  await db.query("update marketplace.client_sightings set last_seen_at = $3 where participant_id = $1 and channel = $2 and last_seen_at < $3",
    [participantId, channel, at.toISOString()]);
}

/** MCP `initialize` carries the client's own name/version. Batches are allowed by JSON-RPC. */
export function mcpClientInfo(raw: string): { name: string; version?: string; protocolVersion?: string } | undefined {
  let message: unknown;
  try { message = JSON.parse(raw); } catch { return undefined; }
  for (const entry of Array.isArray(message) ? message : [message]) {
    if (!isRecord(entry) || entry.method !== "initialize" || !isRecord(entry.params)) continue;
    const info = entry.params.clientInfo;
    if (!isRecord(info) || typeof info.name !== "string") return undefined;
    return {
      name: info.name,
      ...(typeof info.version === "string" ? { version: info.version } : {}),
      ...(typeof entry.params.protocolVersion === "string" ? { protocolVersion: entry.params.protocolVersion } : {}),
    };
  }
  return undefined;
}

export async function authenticateObserver(db: Queryable, token: string, now: Date): Promise<ObserverSession> {
  if (!token.startsWith(OBSERVER_TOKEN_PREFIX) || token.length < 24 || token.length > 200) {
    throw new PlatformError(401, "INVALID_OBSERVER_SESSION");
  }
  const hash = createHash("sha256").update(token).digest("hex");
  const row = (await db.query(
    "select id, buyer_participant_id, label, expires_at, revoked_at from marketplace.observer_sessions where token_hash = $1",
    [hash])).rows[0];
  if (!row || row.revoked_at !== null) throw new PlatformError(401, "INVALID_OBSERVER_SESSION");
  const expiresAt = iso(row.expires_at)!;
  if (Date.parse(expiresAt) <= now.getTime()) throw new PlatformError(401, "OBSERVER_SESSION_EXPIRED");
  return { id: String(row.id), buyerParticipantId: String(row.buyer_participant_id), label: String(row.label), expiresAt };
}

export type RunPhase =
  | "request_created" | "retrieving_sources" | "awaiting_assessment" | "discovery_failed" | "ranked"
  | "resolved" | "quote_requested" | "negotiating" | "agreed" | "payment_pending"
  | "payment_requires_action" | "paid" | "payment_failed" | "closed_without_agreement";

export interface PhaseFacts {
  requestStatus: string;
  discoveryStatus?: string;
  hasEvidence: boolean;
  hasRanking: boolean;
  hasResolution: boolean;
  quoteCount: number;
  offerCount: number;
  hasOrder: boolean;
  paymentStatus?: string;
}

/** The furthest authoritative state reached. Never advanced by time or by a client's claim. */
export function derivePhase(facts: PhaseFacts): RunPhase {
  if (facts.hasOrder) {
    switch (facts.paymentStatus) {
      case "succeeded": return "paid";
      case "failed": return "payment_failed";
      case "requires_action": return "payment_requires_action";
      case "creating": case "pending": return "payment_pending";
      default: return "agreed";
    }
  }
  if (facts.requestStatus !== "open") return "closed_without_agreement";
  if (facts.offerCount > 0) return "negotiating";
  if (facts.quoteCount > 0) return "quote_requested";
  if (facts.hasResolution) return "resolved";
  if (facts.hasRanking) return "ranked";
  if (facts.discoveryStatus === "failed") return "discovery_failed";
  if (facts.hasEvidence) return "awaiting_assessment";
  if (facts.discoveryStatus === "running" || facts.discoveryStatus === "pending") return "retrieving_sources";
  return "request_created";
}

const TERMINAL: ReadonlySet<RunPhase> = new Set(["paid", "payment_failed", "discovery_failed", "closed_without_agreement"]);

export async function listRuns(db: Queryable, session: ObserverSession): Promise<unknown> {
  const rows = (await db.query(
    `select r.id, r.created_at, r.status, r.description, r.buyer_notice_number,
            (select max(t.finished_at) from marketplace.agent_traces t where t.request_id = r.id) as last_activity_at
       from marketplace.sourcing_requests r
      where r.buyer_id = $1
      order by r.created_at desc, r.id desc
      limit ${MAX_RUNS}`, [session.buyerParticipantId])).rows;
  return runSummaries(db, rows, publicSession(session));
}

/** Public rehearsal view: show recent requests from every registered demo buyer. */
export async function listDemoRuns(db: Queryable): Promise<unknown> {
  const rows = (await db.query(
    `select r.id, r.created_at, r.status, r.description, r.buyer_notice_number,
            (select max(t.finished_at) from marketplace.agent_traces t where t.request_id = r.id) as last_activity_at
       from marketplace.sourcing_requests r
       join marketplace.participants p on p.id = r.buyer_id and p.role = 'buyer' and p.demo = true and p.registered_at is not null
       join marketplace.operator_grants g on g.id = p.grant_id and g.role = 'buyer' and g.demo = true
      where r.demo = true
      order by r.created_at desc, r.id desc
      limit ${MAX_RUNS}`)).rows;
  return runSummaries(db, rows, { label: "Public demo", expiresAt: null });
}

async function runSummaries(db: Queryable, rows: Record<string, unknown>[], session: { label: string; expiresAt: string | null }) {
  const runs = [];
  for (const row of rows) {
    const facts = await phaseFacts(db, String(row.id), String(row.status));
    const phase = derivePhase(facts);
    runs.push({ id: row.id, createdAt: iso(row.created_at), lastActivityAt: iso(row.last_activity_at) ?? null,
      description: clip(String(row.description), 140), buyerNoticeNumber: row.buyer_notice_number ?? null,
      phase, terminal: TERMINAL.has(phase) });
  }
  return { session, runs };
}

/** Public activity is an explicit allowlist projection of authenticated bot calls only. */
export function publicActivity(bus?: ObserverBus): { activities: PublicActivity[] } {
  const activities = (bus?.recent() ?? []).filter(isPublicActorLog)
    .filter((entry) => !["get_my_participant", "list_events"].includes(entry.operation))
    .slice(-200).map((entry) => ({
      id: entry.id,
      at: entry.at,
      source: entry.source,
      role: entry.actor!.role,
      operation: entry.operation,
      status: entry.status,
      outcome: entry.outcome,
      ...(entry.code ? { code: entry.code } : {}),
      durationMs: entry.durationMs,
      ...(safeActivityId(entry.subject?.requestId) ? { requestId: entry.subject!.requestId } : {}),
      ...(safeActivityId(entry.subject?.offerId) ? { offerId: entry.subject!.offerId } : {}),
      ...(safeActivityId(entry.subject?.orderId) ? { orderId: entry.subject!.orderId } : {}),
      ...(safeActivityId(entry.subject?.discoveryId) ? { discoveryId: entry.subject!.discoveryId } : {}),
    }));
  return { activities };
}

function isPublicActorLog(entry: ObserverLog): entry is ObserverLog & { source: "http" | "mcp"; actor: NonNullable<ObserverLog["actor"]> } {
  return entry.actor !== undefined && (entry.source === "http" || entry.source === "mcp");
}

export interface PublicActivity {
  id: string;
  at: string;
  source: "http" | "mcp";
  role: "buyer" | "supplier";
  operation: string;
  status: number;
  outcome: "ok" | "refused" | "error";
  code?: string;
  durationMs: number;
  requestId?: string;
  offerId?: string;
  orderId?: string;
  discoveryId?: string;
}

function safeActivityId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

async function phaseFacts(db: Queryable, requestId: string, requestStatus: string): Promise<PhaseFacts> {
  const row = (await db.query(
    `select
       (select status from marketplace.discovery_runs where request_id = $1 order by created_at desc, id desc limit 1) as discovery_status,
       (select evidence_bundle is not null from marketplace.discovery_runs where request_id = $1 order by created_at desc, id desc limit 1) as has_evidence,
       (select result is not null from marketplace.discovery_runs where request_id = $1 order by created_at desc, id desc limit 1) as has_ranking,
       exists (select 1 from marketplace.candidate_accounts a join marketplace.candidates c on c.id = a.candidate_id
                 join marketplace.discovery_runs d on d.id = c.discovery_id where d.request_id = $1) as has_resolution,
       (select count(*)::int from marketplace.quote_requests where request_id = $1) as quotes,
       (select count(*)::int from marketplace.offers where request_id = $1) as offers,
       (select id from marketplace.orders where request_id = $1) as order_id,
       (select p.status from marketplace.payment_attempts p join marketplace.orders o on o.id = p.order_id where o.request_id = $1) as payment_status`,
    [requestId])).rows[0]!;
  return {
    requestStatus,
    ...(row.discovery_status ? { discoveryStatus: String(row.discovery_status) } : {}),
    hasEvidence: row.has_evidence === true,
    hasRanking: row.has_ranking === true,
    hasResolution: row.has_resolution === true,
    quoteCount: Number(row.quotes),
    offerCount: Number(row.offers),
    hasOrder: row.order_id !== null && row.order_id !== undefined,
    ...(row.payment_status ? { paymentStatus: String(row.payment_status) } : {}),
  };
}

export async function runView(db: Queryable, session: ObserverSession, runId: string, now: Date, environment: string): Promise<unknown> {
  const request = (await db.query(
    `select r.id, r.buyer_id, r.category, r.description, r.quantity, r.unit, r.destination, r.currency, r.deliver_by,
            r.status, r.closed_at, r.created_at, r.buyer_notice_number, p.company_name, p.official_domain
       from marketplace.sourcing_requests r join marketplace.participants p on p.id = r.buyer_id
      where r.id = $1 and r.buyer_id = $2`, [runId, session.buyerParticipantId])).rows[0];
  // Another buyer's run and a missing run are indistinguishable to an observer.
  if (!request) throw new PlatformError(404, "NOT_FOUND");

  const requirements = (await db.query(
    "select key, description, mandatory from marketplace.request_requirements where request_id = $1 order by key", [runId])).rows
    .map((row) => ({ key: row.key, description: clip(String(row.description), 300), mandatory: row.mandatory === true }));

  const discoveryRow = (await db.query(
    `select id, status, started_at, completed_at, error, created_at, evidence_bundle, result
       from marketplace.discovery_runs where request_id = $1 order by created_at desc, id desc limit 1`, [runId])).rows[0];
  const discovery = discoveryRow ? discoveryView(discoveryRow) : null;

  const resolution = discoveryRow ? (await db.query(
    `select c.rank, c.company_name, c.official_domain, c.eligible, a.resolved_at, a.participant_id, p.company_name as account_company
       from marketplace.candidate_accounts a
       join marketplace.candidates c on c.id = a.candidate_id
       left join marketplace.participants p on p.id = a.participant_id
      where c.discovery_id = $1 order by c.rank`, [discoveryRow.id])).rows.map((row) => ({
      rank: Number(row.rank), company: row.company_name, officialDomain: row.official_domain, eligible: row.eligible,
      connected: row.participant_id !== null, representative: row.participant_id !== null ? row.account_company : null,
      resolvedAt: iso(row.resolved_at),
    })) : [];

  const quotes = (await db.query(
    `select q.id, q.created_at, q.supplier_id, p.company_name from marketplace.quote_requests q
       join marketplace.participants p on p.id = q.supplier_id where q.request_id = $1 order by q.created_at, q.id`, [runId])).rows
    .map((row) => ({ id: row.id, supplierCompany: row.company_name, requestedAt: iso(row.created_at) }));

  const offerRows = (await db.query(
    `select o.*, p.company_name as supplier_company from marketplace.offers o
       join marketplace.participants p on p.id = o.supplier_id where o.request_id = $1 order by o.created_at, o.revision`, [runId])).rows;
  const acceptances = (await db.query(
    `select a.offer_id, a.accepted_at, p.role from marketplace.offer_acceptances a
       join marketplace.offers o on o.id = a.offer_id join marketplace.participants p on p.id = a.participant_id
      where o.request_id = $1 order by a.accepted_at`, [runId])).rows;
  const offers = offerRows.map((row) => ({
    id: row.id, revision: Number(row.revision), previousOfferId: row.previous_offer_id ?? null,
    author: row.created_by === row.buyer_id ? "buyer" : "supplier", supplierCompany: row.supplier_company,
    quantity: Number(row.quantity), unit: row.unit, destination: row.destination,
    deliveredTotal: { amountMinor: Number(row.delivered_total_minor), currency: row.currency },
    taxMinor: Number(row.tax_minor), deliveryMinor: Number(row.delivery_minor),
    deliveryAt: iso(row.delivery_at), expiresAt: iso(row.expires_at), status: row.status, createdAt: iso(row.created_at),
    termsOrigin: row.terms_origin, confirmedRequirementKeys: row.confirmed_requirement_keys ?? [],
    acceptances: acceptances.filter((a) => a.offer_id === row.id).map((a) => ({ by: a.role, at: iso(a.accepted_at) })),
  }));

  const orderRow = (await db.query(
    `select o.id, o.offer_id, o.agreed_at, d.id as document_id, pa.status as payment_status, pa.provider_payment_id,
            pa.failure_code, pa.amount_minor, pa.currency, pa.created_at as payment_created_at, pa.updated_at as payment_updated_at
       from marketplace.orders o
       left join marketplace.demo_documents d on d.order_id = o.id
       left join marketplace.payment_attempts pa on pa.order_id = o.id
      where o.request_id = $1`, [runId])).rows[0];
  const order = orderRow ? {
    id: orderRow.id, offerId: orderRow.offer_id, agreedAt: iso(orderRow.agreed_at), demoDocumentId: orderRow.document_id ?? null,
    payment: orderRow.payment_status ? {
      status: orderRow.payment_status,
      // Only a succeeded attempt carries a receipt reference; a pending id is not a receipt.
      receiptReference: orderRow.payment_status === "succeeded" ? orderRow.provider_payment_id ?? null : null,
      providerPaymentId: orderRow.provider_payment_id ?? null,
      failureCode: orderRow.failure_code ?? null,
      amount: { amountMinor: Number(orderRow.amount_minor), currency: orderRow.currency },
      createdAt: iso(orderRow.payment_created_at), updatedAt: iso(orderRow.payment_updated_at),
    } : { status: "not_started" },
  } : null;

  const traceRows = (await db.query(
    `select t.id, t.participant_id, p.role, p.company_name, t.channel, t.operation, t.status, t.error_code, t.started_at, t.finished_at
       from marketplace.agent_traces t join marketplace.participants p on p.id = t.participant_id
      where t.request_id = $1 order by t.id desc limit ${MAX_TRACES}`, [runId])).rows.reverse();
  const traces = traceRows.map((row) => ({
    id: String(row.id), lane: row.role, company: row.company_name, channel: row.channel, operation: row.operation,
    status: Number(row.status), ok: Number(row.status) < 400, errorCode: row.error_code ?? null,
    startedAt: iso(row.started_at), finishedAt: iso(row.finished_at),
  }));

  const supplierIds = new Set<string>([
    ...(await db.query("select supplier_id from marketplace.quote_requests where request_id = $1", [runId])).rows.map((r) => String(r.supplier_id)),
    ...offerRows.map((r) => String(r.supplier_id)),
  ]);
  const participants = [{ id: String(request.buyer_id), role: "buyer" as const }, ...[...supplierIds].map((id) => ({ id, role: "supplier" as const }))];
  const clients = [];
  for (const participant of participants) {
    const profile = (await db.query("select company_name, official_domain from marketplace.participants where id = $1", [participant.id])).rows[0];
    const sightings = (await db.query(
      "select channel, client_name, client_version, protocol_version, first_seen_at, last_seen_at from marketplace.client_sightings where participant_id = $1 order by last_seen_at desc",
      [participant.id])).rows;
    clients.push({
      role: participant.role,
      configuredName: profile?.company_name ?? null,
      officialDomain: profile?.official_domain ?? null,
      observed: sightings.map((s) => ({ channel: s.channel, clientName: s.client_name, clientVersion: s.client_version ?? null,
        protocolVersion: s.protocol_version ?? null, firstSeenAt: iso(s.first_seen_at), lastSeenAt: iso(s.last_seen_at) })),
    });
  }

  const paymentStatus = order ? String(order.payment.status) : undefined;
  const phase = derivePhase({
    requestStatus: String(request.status),
    ...(discoveryRow ? { discoveryStatus: String(discoveryRow.status) } : {}),
    hasEvidence: discoveryRow?.evidence_bundle != null,
    hasRanking: discoveryRow?.result != null,
    hasResolution: resolution.length > 0,
    quoteCount: quotes.length,
    offerCount: offers.length,
    hasOrder: order !== null,
    ...(paymentStatus && paymentStatus !== "not_started" ? { paymentStatus } : {}),
  });
  const lastActivityAt = traces.at(-1)?.finishedAt ?? null;
  const endedAt = TERMINAL.has(phase)
    ? latest([order?.payment.status !== "not_started" && order ? (order.payment as { updatedAt?: string }).updatedAt : undefined,
      order?.agreedAt, discovery?.completedAt, iso(request.closed_at), lastActivityAt])
    : null;

  return {
    environment,
    generatedAt: now.toISOString(),
    session: publicSession(session),
    run: {
      id: request.id, phase, terminal: TERMINAL.has(phase), createdAt: iso(request.created_at), endedAt,
      lastActivityAt, requestStatus: request.status,
      need: { category: request.category, description: clip(String(request.description), 600), quantity: Number(request.quantity),
        unit: request.unit, destination: request.destination, currency: request.currency, deliverBy: iso(request.deliver_by),
        buyerNoticeNumber: request.buyer_notice_number ?? null, requirements },
      buyer: { company: request.company_name, officialDomain: request.official_domain },
    },
    clients,
    traces,
    discovery,
    resolution,
    quotes,
    offers,
    order,
  };
}

function discoveryView(row: Record<string, unknown>) {
  const bundle = isRecord(row.evidence_bundle) ? row.evidence_bundle : undefined;
  const result = isRecord(row.result) ? row.result : undefined;
  const sources = Array.isArray(bundle?.sources) ? bundle.sources.filter(isRecord).map((source) => {
    const api = isRecord(source.api) ? source.api : {};
    return {
      id: str(source.id), url: str(source.url), retrievedAt: str(source.retrievedAt), contentHash: str(source.contentHash),
      characters: typeof source.text === "string" ? source.text.length : 0,
      provider: hostname(str(api.url)), providerResponseHash: str(api.contentHash), providerRetrievedAt: str(api.retrievedAt),
    };
  }) : [];
  const directory = isRecord(bundle?.directoryContext) ? bundle.directoryContext : undefined;
  // API receipts are distinct from extracted websites. Never invent a website-fetch timestamp.
  for (const [kind, receipt] of [["buyer", directory?.buyerSource], ["supplier", directory?.supplierSource]] as const) {
    if (!isRecord(receipt)) continue;
    sources.push({ id: `${str(row.id)}:${kind}-directory`, url: str(receipt.url), retrievedAt: str(receipt.retrievedAt),
      contentHash: str(receipt.contentHash), characters: 0, provider: hostname(str(receipt.url)),
      providerResponseHash: str(receipt.contentHash), providerRetrievedAt: str(receipt.retrievedAt) });
  }
  const notices = Array.isArray(bundle?.buyerNotices) ? bundle.buyerNotices.filter(isRecord).map((notice) => ({
    publicationNumber: str(notice.publicationNumber), noticeUrl: str(notice.noticeUrl), publishedOn: str(notice.publishedOn),
    noticeType: notice.noticeType ?? null, title: clip(firstText(notice.titles), 240), buyerName: firstName(notice.buyerNames),
    ...(isRecord(notice.evidence) ? { retrievedAt: str(notice.evidence.retrievedAt), responseHash: str(notice.evidence.contentHash),
      provider: hostname(str(notice.evidence.url)) } : {}),
  })) : [];
  if (directory && isRecord(directory.buyer)) {
    const buyer = directory.buyer, notice = isRecord(buyer.notice) ? buyer.notice : {}, company = isRecord(buyer.company) ? buyer.company : {};
    const receipt = isRecord(directory.buyerSource) ? directory.buyerSource : {};
    notices.push({ publicationNumber: str(notice.reference), noticeUrl: str(notice.url), publishedOn: str(notice.publishedOn),
      noticeType: "published-buyer-need", title: clip(str(buyer.description), 240), buyerName: str(company.name),
      retrievedAt: str(receipt.retrievedAt), responseHash: str(receipt.contentHash), provider: hostname(str(receipt.url)) });
  }
  const sourceErrors = [
    ...(Array.isArray(bundle?.sourceErrors) ? bundle.sourceErrors : []),
    ...(Array.isArray(result?.sourceErrors) ? result.sourceErrors : []),
  ].filter(isRecord).map((error) => ({ url: str(error.url), message: clip(str(error.message), 300) }));
  const candidates = Array.isArray(result?.candidates) ? result.candidates.filter(isRecord).map((ranked) => {
    const candidate = isRecord(ranked.candidate) ? ranked.candidate : {};
    const company = isRecord(candidate.company) ? candidate.company : {};
    const claims = Array.isArray(candidate.claims) ? candidate.claims.filter(isRecord) : [];
    return {
      rank: Number(ranked.rank), eligible: str(ranked.eligible), explanation: clip(str(ranked.explanation), 600),
      company: str(company.name), officialDomain: str(company.officialDomain),
      claims: claims.map((claim) => {
        const evidence = isRecord(claim.evidence) ? claim.evidence : undefined;
        return { requirementKey: str(claim.requirementKey), outcome: str(claim.outcome),
          ...(evidence ? { evidence: { url: str(evidence.url), retrievedAt: str(evidence.retrievedAt), quotation: clip(str(evidence.quotation), 400) } } : {}) };
      }),
    };
  }).sort((a, b) => a.rank - b.rank) : [];
  return {
    id: row.id, status: row.status, startedAt: iso(row.started_at), completedAt: iso(row.completed_at),
    error: row.error ? clip(String(row.error), 300) : null,
    collection: bundle ? {
      phase: str(bundle.phase), startedAt: str(bundle.startedAt), completedAt: str(bundle.completedAt),
      selectedBuyerNoticeNumber: str(bundle.selectedBuyerNoticeNumber), supplierQuery: clip(str(bundle.supplierQuery), 400),
      cpvCodes: Array.isArray(bundle.cpvCodes) ? bundle.cpvCodes.filter((code): code is string => typeof code === "string").slice(0, 20)
        : directory && isRecord(directory.buyer) && Array.isArray(directory.buyer.cpvCodes)
          ? directory.buyer.cpvCodes.filter((code): code is string => typeof code === "string").slice(0, 20) : null,
      notices, sources, sourceErrors, returnedCount: sources.length, failedCount: sourceErrors.length,
    } : null,
    ranking: result ? { status: str(result.status), candidates } : null,
  };
}

function publicSession(session: ObserverSession) {
  return { label: session.label, expiresAt: session.expiresAt };
}

function latest(values: (string | null | undefined)[]): string | null {
  const times = values.filter((v): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)));
  return times.length === 0 ? null : times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function clip(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function hostname(url: string): string { try { return new URL(url).hostname; } catch { return ""; } }
function firstText(value: unknown): string {
  if (!isRecord(value)) return "";
  const preferred = typeof value.eng === "string" ? value.eng : Object.values(value).find((v) => typeof v === "string");
  return typeof preferred === "string" ? preferred : "";
}
function firstName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const names of [value.eng, ...Object.values(value)]) if (Array.isArray(names) && typeof names[0] === "string") return clip(names[0], 200);
  return null;
}
function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value) ? value : undefined;
}
function printable(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/[^\x20-\x7E]/g, "").trim().slice(0, max);
  return cleaned === "" ? undefined : cleaned;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
