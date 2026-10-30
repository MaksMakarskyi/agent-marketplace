import type { ActorContext, BuyerMandate, DiscoveryResult, Offer, Order, SourcingRequest } from "../contracts.js";
import type { Queryable } from "../payments/postgres-store.js";
import { withPayment, type PaymentStore, type SettlementService } from "../payments/settlement.js";
import { OfferRanker } from "../matching/offers.js";
import { findTool, validateJsonSchema } from "../mcp/tools.js";
import { finalizeAgentAssessment } from "../sourcing/assessment.js";
import { ApiEvidenceCollector, canonicalJson, evidenceForAgent, hashText, isoTimestamp, normalizePolishNip, readEvidenceSource, requestFingerprint, type DiscoveryEvidenceBundle } from "../sourcing/discovery.js";
import { ProcurementDirectory, type DirectoryQuery, type DirectoryResult } from "../sourcing/directory.js";
import { SourceApiError } from "../sourcing/json-api.js";
import { isRecord } from "../sourcing/search.js";
import { TedClient } from "../sourcing/ted.js";
import { PlatformError, type Database } from "./database.js";

export interface MarketplaceOptions { collector?: ApiEvidenceCollector; settlement?: SettlementService; paymentStore?: PaymentStore; now?: () => Date; ted?: TedClient; directory?: ProcurementDirectory }
type Row = Record<string, unknown>;
type Acceptance = { state: "agreed"; order: Order } | { state: "awaiting_counterparty" };

/** The database is authoritative. No account map, source catalog or commercial state lives in memory. */
export class Marketplace {
  private readonly now: () => Date;
  private readonly collector: ApiEvidenceCollector;
  private readonly directory: ProcurementDirectory;
  constructor(private readonly db: Database, private readonly options: MarketplaceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.directory = options.directory ?? new ProcurementDirectory({ now: this.now });
    this.collector = options.collector ?? new ApiEvidenceCollector({ now: this.now, directory: this.directory });
  }

  async mutate<T>(actor: ActorContext, key: string, route: string, input: unknown, action: (db: Queryable) => Promise<T>): Promise<T> {
    if (!/^[\x21-\x7e]{8,255}$/.test(key)) throw new PlatformError(400, "IDEMPOTENCY_KEY_REQUIRED");
    const fingerprint = await hashText(canonicalJson(input));
    return this.db.transaction(async (db) => {
      // A transaction-scoped key lock serializes retries without racing a partially stored response.
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`mutation:${actor.participantId}:${key}`]);
      const prior = (await db.query("select * from marketplace.idempotency_keys where participant_id=$1 and key=$2", [actor.participantId, key])).rows[0];
      if (prior) {
        if (prior.route !== route || prior.request_hash !== fingerprint) throw new PlatformError(409, "IDEMPOTENCY_KEY_REUSED");
        return prior.response_body as T;
      }
      const result = await action(db);
      await db.query("insert into marketplace.idempotency_keys(participant_id,key,route,request_hash,response_status,response_body) values($1,$2,$3,$4,200,$5)",
        [actor.participantId, key, route, fingerprint, JSON.stringify(result)]);
      return result;
    });
  }

  async me(actor: ActorContext) {
    const row = (await this.db.query("select id,role,company_name,official_domain,public_org_id,registered_at from marketplace.participants where id=$1", [actor.participantId])).rows[0];
    if (!row) throw new PlatformError(404, "NOT_FOUND");
    return { participantId: row.id, role: row.role, demo: true, registered: row.registered_at !== null,
      ...(row.registered_at ? { company: { name: row.company_name, officialDomain: row.official_domain,
        ...(row.public_org_id ? { publicOrganizationId: row.public_org_id } : {}) } } : {}) };
  }

  async createRequest(actor: ActorContext, input: unknown, key: string): Promise<SourcingRequest> {
    buyerOnly(actor);
    if (!isRecord(input)) throw new PlatformError(400, "INVALID_INPUT");
    const { buyerNoticeNumber, ...rest } = input;
    toolInput("create_request", rest);
    if (buyerNoticeNumber !== undefined && (typeof buyerNoticeNumber !== "string" || !/^\d{1,7}-(19|20)\d{2}$/.test(buyerNoticeNumber) &&
        !/^bzp:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(buyerNoticeNumber))) throw new PlatformError(400, "INVALID_BUYER_NOTICE");
    const request = { ...rest, id: crypto.randomUUID(), buyerId: actor.participantId,
      ...(buyerNoticeNumber !== undefined ? { buyerNoticeNumber } : {}) } as unknown as SourcingRequest;
    await requestFingerprint(request);
    if (!Number.isInteger(request.quantity) || request.quantity > 2_147_483_647 || isoTimestamp(request.deliverBy) <= this.now().getTime()) throw new PlatformError(400, "INVALID_REQUEST_TERMS");
    // Requirement evidence is backend-owned. Caller descriptions are assessed against fresh sources.
    if (request.requirements.some((r) => r.evidence !== undefined)) throw new PlatformError(400, "CALLER_EVIDENCE_NOT_ALLOWED");
    return this.mutate(actor, key, "create_request", input, async (db) => {
      const mandate = await this.mandate(db, actor.participantId, true);
      if (request.maximumDeliveredTotal.currency !== mandate.currency || request.maximumDeliveredTotal.amountMinor > minor(mandate.max_order_total_minor) ||
          request.maximumDeliveredTotal.amountMinor > minor(mandate.max_run_total_minor) || request.destination !== mandate.destination ||
          !(mandate.allowed_categories as string[]).includes(request.category)) throw new PlatformError(403, "POLICY_REFUSAL", "Request exceeds buyer mandate");
      await db.query(`insert into marketplace.sourcing_requests(id,buyer_id,category,description,quantity,unit,destination,max_delivered_total_minor,currency,deliver_by,buyer_notice_number)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [request.id, request.buyerId, request.category, request.description, request.quantity, request.unit,
        request.destination, request.maximumDeliveredTotal.amountMinor, request.maximumDeliveredTotal.currency, request.deliverBy, buyerNoticeNumber ?? null]);
      for (const r of request.requirements) await db.query("insert into marketplace.request_requirements(request_id,key,description,mandatory) values($1,$2,$3,$4)", [request.id, r.key, r.description, r.mandatory]);
      return request;
    });
  }

  async getRequest(actor: ActorContext, id: string): Promise<SourcingRequest> { return this.readRequest(this.db, actor, id); }

  private async readRequest(db: Queryable, actor: ActorContext, id: string, lock = false): Promise<SourcingRequest> {
    const row = (await db.query(`select r.* from marketplace.sourcing_requests r where r.id=$1 and
      (r.buyer_id=$2 or exists(select 1 from marketplace.quote_requests q where q.request_id=r.id and q.supplier_id=$2))${lock ? " for update of r" : ""}`, [id, actor.participantId])).rows[0];
    if (!row) throw new PlatformError(404, "NOT_FOUND");
    const requirements = (await db.query<{ key: string; description: string; mandatory: boolean }>("select key,description,mandatory from marketplace.request_requirements where request_id=$1 order by key", [id])).rows;
    return { id: row.id as string, buyerId: row.buyer_id as string, category: row.category as string, description: row.description as string,
      quantity: minor(row.quantity), unit: row.unit as string, destination: row.destination as string,
      maximumDeliveredTotal: { amountMinor: minor(row.max_delivered_total_minor), currency: row.currency as string }, deliverBy: date(row.deliver_by), requirements,
      ...(row.buyer_notice_number ? { buyerNoticeNumber: row.buyer_notice_number as string } : {}), demo: true };
  }

  async searchBuyerNotices(query: string, limit = 5) {
    // The agent can inspect real opportunities in either role; this is not a registered-account search.
    return (this.options.ted ?? new TedClient()).search({ query, limit, scope: "ACTIVE" });
  }

  async searchPublicBuyerNotices(actor: ActorContext, input: { cpvCode?: string; keywords?: string; publishedFrom?: string; publishedTo?: string; limit?: number }): Promise<DirectoryResult & { searchId: string }> {
    if (actor.role !== "buyer") throw new PlatformError(403, "FORBIDDEN");
    if (!isRecord(input) || Object.keys(input).some((key) => !["cpvCode", "keywords", "publishedFrom", "publishedTo", "limit"].includes(key)) ||
        (input.cpvCode === undefined && input.keywords === undefined)) throw new PlatformError(400, "INVALID_DIRECTORY_QUERY");
    const today = this.now();
    const to = input.publishedTo ?? today.toISOString().slice(0, 10);
    const from = input.publishedFrom ?? new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fromTime = validDirectoryDate(from) ? Date.parse(`${from}T00:00:00Z`) : NaN;
    const toTime = validDirectoryDate(to) ? Date.parse(`${to}T00:00:00Z`) : NaN;
    if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || fromTime > toTime || toTime - fromTime > 365 * 24 * 60 * 60 * 1000 ||
        (input.publishedFrom !== undefined && !validDirectoryDate(input.publishedFrom)) || (input.publishedTo !== undefined && !validDirectoryDate(input.publishedTo))) {
      throw new PlatformError(400, "INVALID_DIRECTORY_QUERY");
    }
    const query: DirectoryQuery = { ...(typeof input.cpvCode === "string" ? { cpvCode: input.cpvCode } : {}),
      ...(typeof input.keywords === "string" ? { keywords: input.keywords } : {}), publishedFrom: from, publishedTo: to,
      ...(input.limit === undefined ? {} : { limit: input.limit }) };
    let result: DirectoryResult;
    try { result = await this.directory.findBuyers(query); }
    catch (error) {
      if (error instanceof SourceApiError && error.code === "INVALID_INPUT") throw new PlatformError(400, "INVALID_DIRECTORY_QUERY");
      throw new PlatformError(503, "PUBLIC_SOURCE_UNAVAILABLE");
    }
    const searchId = crypto.randomUUID();
    const createdAt = this.now();
    await this.db.transaction(async (tx) => {
      await tx.query("delete from marketplace.public_directory_searches where expires_at <= $1", [createdAt.toISOString()]);
      await tx.query(`insert into marketplace.public_directory_searches(id,participant_id,participant_role,filters,result,created_at,expires_at)
        values($1,$2,$3,$4,$5,$6,$7)`, [searchId, actor.participantId, actor.role, JSON.stringify(query), JSON.stringify(result), createdAt.toISOString(),
        new Date(createdAt.getTime() + 10 * 60_000).toISOString()]);
    });
    return { ...result, searchId };
  }

  async startDiscovery(actor: ActorContext, requestId: string, key: string): Promise<{ discoveryId: string }> {
    buyerOnly(actor);
    const request = await this.readRequest(this.db, actor, requestId);
    if (!request.buyerNoticeNumber) throw new PlatformError(400, "BUYER_NOTICE_REQUIRED", "Select a real buyer notice before discovery");
    let buyerDirectoryQuery: DirectoryQuery | undefined;
    if (request.buyerNoticeNumber.startsWith("bzp:")) {
      const recentSearches = await this.db.query(`select filters,result from marketplace.public_directory_searches
        where participant_id=$1 and participant_role='buyer' and expires_at>$2 order by created_at desc,id desc limit 10`,
      [actor.participantId, this.now().toISOString()]);
      const search = recentSearches.rows.find((row) => isRecord(row.result) && Array.isArray(row.result.entries) &&
        row.result.entries.some((entry: unknown) => isRecord(entry) && entry.id === request.buyerNoticeNumber));
      if (!search || !isRecord(search.filters)) throw new PlatformError(409, "BUYER_NOTICE_SOURCE_REQUIRED", "Select a notice from your recent live BZP search");
      buyerDirectoryQuery = search.filters as unknown as DirectoryQuery;
    }
    const job = await this.mutate(actor, key, "start_discovery", { requestId }, async (db) => {
      await this.readRequest(db, actor, requestId, true);
      const id = crypto.randomUUID();
      await db.query("insert into marketplace.discovery_runs(id,request_id) values($1,$2)", [id, requestId]);
      return { discoveryId: id };
    });
    const claimed = (await this.db.query("update marketplace.discovery_runs set status='running',started_at=$2 where id=$1 and status='pending' returning id", [job.discoveryId, this.now().toISOString()])).rows.length;
    if (!claimed) return job;
    // MVP_LIMIT: one bounded collection step is awaited in this request, with durable state before I/O.
    // No detached process/in-memory scheduler. A crashed step expires visibly and requires a new run.
    try {
      const bundle = await this.collector.collect(actor, request, { discoveryId: job.discoveryId, buyerNoticeNumber: request.buyerNoticeNumber,
        ...(buyerDirectoryQuery ? { buyerDirectoryQuery } : {}) });
      if (bundle.directoryContext) {
        const registeredBuyer = (await this.db.query("select public_org_id from marketplace.participants where id=$1 and role='buyer'", [actor.participantId])).rows[0];
        const registeredId = typeof registeredBuyer?.public_org_id === "string" ? normalizePolishNip(registeredBuyer.public_org_id) : null;
        const noticeId = bundle.directoryContext.buyer.company.publicOrganizationId;
        if (!registeredId || !noticeId || registeredId !== normalizePolishNip(noticeId) ||
            bundle.directoryContext.buyer.company.country !== "PL") throw new Error("Selected BZP notice does not match the registered buyer's Polish public identifier");
      }
      await this.db.query("update marketplace.discovery_runs set evidence_bundle=$2,status=$3,completed_at=$4 where id=$1 and status='running' and evidence_bundle is null", [job.discoveryId, JSON.stringify(bundle), bundle.phase === "failed" ? "failed" : "running", bundle.completedAt]);
    } catch {
      await this.db.query("update marketplace.discovery_runs set status='failed',error='Bounded source collection failed',completed_at=$2 where id=$1 and evidence_bundle is null", [job.discoveryId, this.now().toISOString()]);
    }
    return job;
  }

  private async job(db: Queryable, actor: ActorContext, id: string, lock = false) {
    buyerOnly(actor);
    const row = (await db.query(`select d.* from marketplace.discovery_runs d join marketplace.sourcing_requests r on r.id=d.request_id
      where d.id=$1 and r.buyer_id=$2${lock ? " for update of d" : ""}`, [id, actor.participantId])).rows[0];
    if (!row) throw new PlatformError(404, "NOT_FOUND");
    return row;
  }

  async getDiscovery(actor: ActorContext, id: string): Promise<DiscoveryResult> {
    const row = await this.job(this.db, actor, id);
    if (row.result) return row.result as DiscoveryResult;
    const bundle = row.evidence_bundle as DiscoveryEvidenceBundle | null;
    const stale = row.status === "running" && this.now().getTime() - Date.parse(date(row.started_at)) > 600_000;
    return { id, requestId: row.request_id as string, status: stale ? "failed" : row.status as DiscoveryResult["status"], candidates: [],
      sourceErrors: bundle?.sourceErrors ?? (row.error || stale ? [{ url: "https://api.ted.europa.eu/v3/notices/search", message: "Collection failed or expired; start a new run" }] : []) };
  }

  async evidence(actor: ActorContext, id: string) {
    const row = await this.job(this.db, actor, id);
    if (!row.evidence_bundle) throw new PlatformError(409, "EVIDENCE_NOT_READY");
    return evidenceForAgent(actor, await this.readRequest(this.db, actor, row.request_id as string), row.evidence_bundle as DiscoveryEvidenceBundle, this.now());
  }

  async source(actor: ActorContext, id: string, sourceId: string, offset = 0, limit = 8000) {
    const row = await this.job(this.db, actor, id);
    if (!row.evidence_bundle) throw new PlatformError(409, "EVIDENCE_NOT_READY");
    return readEvidenceSource(actor, await this.readRequest(this.db, actor, row.request_id as string), row.evidence_bundle as DiscoveryEvidenceBundle, sourceId, { offset, limit, now: this.now() });
  }

  async submitAssessment(actor: ActorContext, id: string, input: unknown, key: string): Promise<DiscoveryResult> {
    return this.mutate(actor, key, `assessment:${id}`, input, async (db) => {
      const row = await this.job(db, actor, id, true);
      if (row.result || row.status !== "running") throw new PlatformError(409, "DISCOVERY_FINALIZED", "Discovery already finalized or failed");
      if (!row.evidence_bundle) throw new PlatformError(409, "EVIDENCE_NOT_READY");
      const request = await this.readRequest(db, actor, row.request_id as string);
      const { result } = await finalizeAgentAssessment(actor, request, row.evidence_bundle as DiscoveryEvidenceBundle, input, { now: this.now });
      for (const candidate of result.candidates) {
        const candidateId = crypto.randomUUID();
        await db.query("insert into marketplace.candidates(id,discovery_id,company_name,official_domain,public_org_id,eligible,rank,explanation) values($1,$2,$3,$4,$5,$6,$7,$8)",
          [candidateId, id, candidate.candidate.company.name, candidate.candidate.company.officialDomain, candidate.candidate.company.publicOrganizationId ?? null, candidate.eligible, candidate.rank, candidate.explanation]);
      }
      await db.query("update marketplace.discovery_runs set result=$2,status='complete' where id=$1", [id, JSON.stringify(result)]);
      return result;
    });
  }

  async resolve(actor: ActorContext, id: string) {
    return this.db.transaction(async (db) => {
      const job = await this.job(db, actor, id, true);
      if (job.status !== "complete" || !job.result) throw new PlatformError(409, "RANKING_REQUIRED");
      const request = await this.readRequest(db, actor, job.request_id as string);
      const polishDirectory = request.buyerNoticeNumber?.startsWith("bzp:") === true;
      const candidates = (await db.query("select * from marketplace.candidates where discovery_id=$1 order by rank", [id])).rows;
      const resolutions = [];
      for (const candidate of candidates) {
        const prior = (await db.query("select participant_id from marketplace.candidate_accounts where candidate_id=$1", [candidate.id])).rows[0];
        let participantId = prior?.participant_id as string | null | undefined;
        if (!prior) {
          const matches = (await db.query(`select p.id,p.public_org_id from marketplace.participants p join marketplace.operator_grants g on g.id=p.grant_id
            join marketplace.mandates m on m.participant_id=p.id where p.role='supplier' and p.registered_at is not null
            and p.official_domain=$1 and ($2::text is null or p.public_org_id=$2 or $4::boolean) and g.expires_at>$3 and m.expires_at>$3`,
          [candidate.official_domain, candidate.public_org_id, this.now().toISOString(), polishDirectory])).rows.filter((row) => {
            if (!polishDirectory) return true;
            if (candidate.public_org_id === null) return false;
            const candidateNip = normalizePolishNip(String(candidate.public_org_id));
            const participantNip = typeof row.public_org_id === "string" ? normalizePolishNip(row.public_org_id) : null;
            return candidateNip !== null && participantNip === candidateNip;
          });
          // Ambiguous identities are external leads, not an arbitrary connected account.
          participantId = matches.length === 1 ? matches[0]!.id as string : null;
          await db.query("insert into marketplace.candidate_accounts(candidate_id,participant_id) values($1,$2)", [candidate.id, participantId]);
        }
        resolutions.push({ rank: candidate.rank, company: { name: candidate.company_name, officialDomain: candidate.official_domain }, eligible: candidate.eligible,
          ...(participantId ? { participantId } : {}), connected: !!participantId });
      }
      return { discoveryId: id, resolutions };
    });
  }

  async requestQuote(actor: ActorContext, requestId: string, supplierId: string, key: string): Promise<{ eventId: string }> {
    buyerOnly(actor);
    return this.mutate(actor, key, "request_quote", { requestId, supplierId }, async (db) => {
      await this.readRequest(db, actor, requestId, true);
      const candidate = (await db.query(`select c.id from marketplace.candidates c join marketplace.discovery_runs d on d.id=c.discovery_id
        join marketplace.candidate_accounts a on a.candidate_id=c.id where d.request_id=$1 and d.status='complete' and a.participant_id=$2
        and c.eligible='yes' and d.completed_at >= $3 order by d.created_at desc limit 1`, [requestId, supplierId, new Date(this.now().getTime() - 300_000).toISOString()])).rows[0];
      if (!candidate) throw new PlatformError(409, "QUALIFYING_CANDIDATE_REQUIRED", "A freshly ranked qualifying connected candidate is required");
      await this.mandate(db, supplierId);
      const quoteId = crypto.randomUUID();
      await db.query("insert into marketplace.quote_requests(id,request_id,supplier_id,candidate_id) values($1,$2,$3,$4) on conflict(request_id,supplier_id) do nothing", [quoteId, requestId, supplierId, candidate.id]);
      const quote = (await db.query("select id from marketplace.quote_requests where request_id=$1 and supplier_id=$2", [requestId, supplierId])).rows[0];
      await emit(db, [supplierId], "quote_requested", requestId, requestId, `quote:${quote!.id}`);
      const event = (await db.query("select cursor from marketplace.participant_events where participant_id=$1 and dedup_key=$2", [supplierId, `quote:${quote!.id}:${supplierId}`])).rows[0];
      return { eventId: String(event!.cursor) };
    });
  }

  async submitOffer(actor: ActorContext, input: unknown, key: string): Promise<Offer> {
    // Legacy HTTP clients send Omit<Offer, "id">, including both participant ids. They are compared with the
    // server-derived parties below and never used as authority; every other unknown field is still refused.
    const { buyerId: claimedBuyer, supplierId: claimedSupplier, ...terms } = isRecord(input) ? input : {};
    if (!isRecord(input)) throw new PlatformError(400, "INVALID_INPUT");
    for (const claimed of [claimedBuyer, claimedSupplier]) if (claimed !== undefined && (typeof claimed !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(claimed))) throw new PlatformError(400, "INVALID_INPUT");
    toolInput("submit_offer", terms);
    const body = terms as Omit<Offer, "id" | "buyerId" | "supplierId">;
    return this.mutate(actor, key, "submit_offer", input, async (db) => {
      const request = await this.readRequest(db, actor, body.requestId, true);
      await requireOpen(db, request.id);
      let supplierId = actor.participantId;
      let revision = 1;
      if (body.previousOfferId) {
        const previous = (await db.query("select * from marketplace.offers where id=$1 and request_id=$2 and status='current' for update", [body.previousOfferId, request.id])).rows[0];
        if (!previous || ![previous.buyer_id, previous.supplier_id].includes(actor.participantId)) throw new PlatformError(409, "STALE_OFFER");
        if (previous.created_by === actor.participantId) throw new PlatformError(409, "COUNTERPARTY_TURN_REQUIRED");
        supplierId = previous.supplier_id as string;
        revision = minor(previous.revision) + 1;
      } else if (actor.role !== "supplier") throw new PlatformError(403, "FORBIDDEN");
      const invited = (await db.query("select 1 from marketplace.quote_requests where request_id=$1 and supplier_id=$2", [request.id, supplierId])).rows.length;
      if (!invited) throw new PlatformError(403, "QUOTE_REQUEST_REQUIRED");
      if ((claimedBuyer !== undefined && claimedBuyer !== request.buyerId) || (claimedSupplier !== undefined && claimedSupplier !== supplierId)) {
        throw new PlatformError(403, "PARTICIPANT_MISMATCH");
      }
      const offer: Offer = { ...body, id: crypto.randomUUID(), buyerId: request.buyerId, supplierId };
      const parties = [request.buyerId, supplierId].sort();
      const mandates = new Map<string, Row>();
      for (const id of parties) mandates.set(id, await this.mandate(db, id, true));
      // A buyer-authored revision is not checked against the supplier's private limits here: refusing it would let
      // the buyer binary-search the floor. The supplier's own acceptance below still enforces every limit.
      this.assertOffer(request, offer, mandates.get(request.buyerId)!, mandates.get(supplierId)!, actor.participantId === supplierId);
      if (revision > 3) throw new PlatformError(409, "REVISION_LIMIT");
      const first = (await db.query("select created_at from marketplace.offers where request_id=$1 and supplier_id=$2 order by revision limit 1", [request.id, supplierId])).rows[0];
      if (first && this.now().getTime() - Date.parse(date(first.created_at)) >= 300_000) throw new PlatformError(409, "NEGOTIATION_EXPIRED");
      await db.query(`insert into marketplace.offers(id,request_id,buyer_id,supplier_id,previous_offer_id,revision,created_by,quantity,unit,destination,delivered_total_minor,currency,tax_minor,delivery_minor,delivery_at,expires_at,confirmed_requirement_keys)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [offer.id, request.id, request.buyerId, supplierId, offer.previousOfferId ?? null, revision, actor.participantId,
        offer.quantity, offer.unit, offer.destination, offer.deliveredTotal.amountMinor, offer.deliveredTotal.currency, offer.taxMinor, offer.deliveryMinor, offer.deliveryAt, offer.expiresAt, offer.confirmedRequirementKeys]);
      // Submission is an explicit signed-by-token acceptance of these exact immutable terms.
      await db.query("insert into marketplace.offer_acceptances(offer_id,participant_id) values($1,$2)", [offer.id, actor.participantId]);
      await emit(db, [actor.participantId === supplierId ? request.buyerId : supplierId], "offer_received", request.id, offer.id, `offer:${offer.id}`);
      return offer;
    });
  }

  async acceptOffer(actor: ActorContext, id: string, key: string): Promise<Acceptance> {
    return this.mutate(actor, key, `accept:${id}`, {}, async (db) => {
      const existing = (await db.query("select * from marketplace.orders where offer_id=$1 and (buyer_id=$2 or supplier_id=$2)", [id, actor.participantId])).rows[0];
      if (existing) return { state: "agreed", order: await this.readOrder(db, actor, existing.id as string) };
      const preliminary = await this.readOffer(db, actor, id);
      const request = await this.readRequest(db, actor, preliminary.requestId, true);
      // Re-check under the request lock: a concurrent acceptance may have just created this order.
      const agreed = (await db.query("select id from marketplace.orders where offer_id=$1", [id])).rows[0];
      if (agreed) return { state: "agreed", order: await this.readOrder(db, actor, agreed.id as string) };
      await requireOpen(db, request.id);
      const row = (await db.query("select * from marketplace.offers where id=$1 for update", [id])).rows[0]!;
      if (row.status !== "current") throw new PlatformError(409, "STALE_OFFER");
      const mandates = new Map<string, Row>();
      for (const pid of [preliminary.buyerId, preliminary.supplierId].sort()) mandates.set(pid, await this.mandate(db, pid, true));
      this.assertOffer(request, preliminary, mandates.get(preliminary.buyerId)!, mandates.get(preliminary.supplierId)!, true);
      const accepted = (await db.query("select 1 from marketplace.offer_acceptances where offer_id=$1 and participant_id=$2", [id, actor.participantId])).rows.length;
      if (!accepted) await db.query("insert into marketplace.offer_acceptances(offer_id,participant_id) values($1,$2)", [id, actor.participantId]);
      const all = (await db.query("select participant_id from marketplace.offer_acceptances where offer_id=$1", [id])).rows;
      if (all.length !== 2) return { state: "awaiting_counterparty" };
      const orderId = crypto.randomUUID();
      await db.query("insert into marketplace.orders(id,offer_id,request_id,buyer_id,supplier_id) values($1,$2,$3,$4,$5)", [orderId, id, preliminary.requestId, preliminary.buyerId, preliminary.supplierId]);
      await db.query("insert into marketplace.demo_documents(id,order_id,body) values($1,$2,$3)", [`demo-${orderId}`, orderId,
        `DEMO ORDER DOCUMENT. No real payment, tax invoice, shipment or company representation. Order ${orderId}; ${preliminary.quantity} ${preliminary.unit}; delivered total ${preliminary.deliveredTotal.amountMinor} minor ${preliminary.deliveredTotal.currency}, including tax ${preliminary.taxMinor} and delivery ${preliminary.deliveryMinor}.`]);
      await emit(db, [preliminary.buyerId, preliminary.supplierId], "agreement_created", preliminary.requestId, orderId, `agreement:${orderId}`);
      return { state: "agreed", order: await this.readOrder(db, actor, orderId) };
    });
  }

  /** `supplierLimits` is false only for a buyer-authored revision; acceptance always checks both parties. */
  private assertOffer(request: SourcingRequest, offer: Offer, buyer: Row, supplier: Row, supplierLimits: boolean) {
    const requestAndBuyer = !new OfferRanker({ now: this.now }).rankOffers(request, [offer]).length || offer.deliveredTotal.currency !== buyer.currency ||
        offer.deliveredTotal.amountMinor > minor(buyer.max_order_total_minor) || request.destination !== buyer.destination ||
        !(buyer.allowed_categories as string[]).includes(request.category);
    const supplierPrivate = supplierLimits && (offer.deliveredTotal.currency !== supplier.currency ||
        offer.deliveredTotal.amountMinor < minor(supplier.min_delivered_total_minor) || offer.quantity > minor(supplier.available_quantity) - minor(supplier.allocated_quantity) ||
        offer.unit !== supplier.unit || isoTimestamp(offer.deliveryAt) < Date.parse(date(supplier.earliest_delivery_at)));
    if (requestAndBuyer || supplierPrivate) throw new PlatformError(403, "POLICY_REFUSAL", "Offer is outside authoritative request or mandate limits");
  }

  private async mandate(db: Queryable, participantId: string, lock = false): Promise<Row> {
    const row = (await db.query(`select m.*,g.expires_at as grant_expires_at,p.registered_at from marketplace.mandates m join marketplace.participants p on p.id=m.participant_id
      join marketplace.operator_grants g on g.id=p.grant_id where m.participant_id=$1${lock ? " for update of m" : ""}`, [participantId])).rows[0];
    if (!row || !row.registered_at || Date.parse(date(row.expires_at)) <= this.now().getTime() || Date.parse(date(row.grant_expires_at)) <= this.now().getTime()) throw new PlatformError(403, "MANDATE_UNAVAILABLE");
    return row;
  }

  async getOffer(actor: ActorContext, id: string) { return this.readOffer(this.db, actor, id); }
  private async readOffer(db: Queryable, actor: ActorContext, id: string): Promise<Offer> {
    const row = (await db.query("select * from marketplace.offers where id=$1 and (buyer_id=$2 or supplier_id=$2)", [id, actor.participantId])).rows[0];
    if (!row) throw new PlatformError(404, "NOT_FOUND");
    return offerFromRow(row);
  }

  async getOrder(actor: ActorContext, id: string) {
    const order = await this.readOrder(this.db, actor, id);
    return this.options.paymentStore ? withPayment(order, await this.options.paymentStore.getAttempt(id)) : order;
  }

  private async readOrder(db: Queryable, actor: ActorContext, id: string): Promise<Order> {
    const row = (await db.query("select o.*,d.id as document_id,d.body as document_body from marketplace.orders o left join marketplace.demo_documents d on d.order_id=o.id where o.id=$1 and (o.buyer_id=$2 or o.supplier_id=$2)", [id, actor.participantId])).rows[0];
    if (!row) throw new PlatformError(404, "NOT_FOUND");
    return { id, acceptedOffer: await this.readOffer(db, actor, row.offer_id as string), agreementStatus: "agreed", paymentStatus: "not_started", demo: true,
      ...(row.document_id ? { demoInvoice: { id: row.document_id as string, text: row.document_body as string, demo: true as const } } : {}) };
  }

  async settle(actor: ActorContext, id: string) {
    if (!this.options.settlement) throw new PlatformError(503, "SANDBOX_PAYMENT_UNAVAILABLE");
    const order = await this.getOrder(actor, id);
    buyerOnly(actor);
    const m = await this.mandate(this.db, actor.participantId);
    const mandate: BuyerMandate = { maximumOrderTotal: { amountMinor: minor(m.max_order_total_minor), currency: m.currency as string },
      maximumRunTotal: { amountMinor: minor(m.max_run_total_minor), currency: m.currency as string }, allowedCategories: m.allowed_categories as string[],
      destination: m.destination as string, expiresAt: date(m.expires_at), sandboxOnly: true };
    return withPayment(order, await this.options.settlement.settle(actor, order, mandate));
  }

  async events(actor: ActorContext, after = "0") {
    if (!/^\d{1,20}$/.test(after)) throw new PlatformError(400, "INVALID_CURSOR");
    const rows = (await this.db.query("select * from marketplace.participant_events where participant_id=$1 and cursor>$2::bigint order by cursor limit 100", [actor.participantId, after])).rows;
    return { events: rows.map((r) => ({ id: String(r.cursor), cursor: String(r.cursor), type: r.type, requestId: r.request_id, resourceId: r.resource_id })), nextCursor: rows.length ? String(rows.at(-1)!.cursor) : after };
  }
}

/** Call with the request row already locked. A closed request is a final answer, not a retryable outage. */
async function requireOpen(db: Queryable, requestId: string) {
  const row = (await db.query("select status from marketplace.sourcing_requests where id=$1", [requestId])).rows[0];
  if (row?.status !== "open") throw new PlatformError(409, "REQUEST_CLOSED");
}
function buyerOnly(actor: ActorContext) { if (actor.role !== "buyer") throw new PlatformError(403, "FORBIDDEN"); }
function minor(value: unknown): number { const n = Number(value); if (!Number.isSafeInteger(n)) throw new PlatformError(500, "INVALID_STORED_AMOUNT"); return n; }
function date(value: unknown): string { return new Date(value as string | Date).toISOString(); }
function validDirectoryDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function toolInput(name: string, input: unknown): void {
  const schema = findTool(name)?.inputSchema;
  if (!schema || !validateJsonSchema(schema, input, "input").ok) throw new PlatformError(400, "INVALID_INPUT");
}
function offerFromRow(r: Row): Offer {
  return { id: r.id as string, requestId: r.request_id as string, buyerId: r.buyer_id as string, supplierId: r.supplier_id as string,
    ...(r.previous_offer_id ? { previousOfferId: r.previous_offer_id as string } : {}), quantity: minor(r.quantity), unit: r.unit as string, destination: r.destination as string,
    deliveredTotal: { amountMinor: minor(r.delivered_total_minor), currency: r.currency as string }, taxMinor: minor(r.tax_minor), deliveryMinor: minor(r.delivery_minor),
    deliveryAt: date(r.delivery_at), expiresAt: date(r.expires_at), confirmedRequirementKeys: r.confirmed_requirement_keys as string[], termsOrigin: "demo-supplier-declaration", demo: true };
}
async function emit(db: Queryable, participants: string[], type: string, requestId: string, resourceId: string, dedup: string) {
  await db.query("select marketplace.emit_participant_events($1::text[],$2,$3,$4,$5)", [participants, type, requestId, resourceId, dedup]);
}
