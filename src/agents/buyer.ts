import { randomUUID } from "node:crypto";

import type {
  DiscoveryResult,
  Offer,
  Order,
  ParticipantId,
  RankedCandidate,
  RegistrationInput,
  SourcingRequest,
} from "../contracts.js";
import type { AgentAssessment } from "../sourcing/assessment.js";
import { PlatformClient, PlatformClientError, stableHash } from "./client.js";
import { DEFAULT_PAYMENT_WAIT_MS, type BuyerAgentConfig } from "./config.js";
import {
  BuyerNegotiation,
  noMatchReasonFor,
  type NegotiationNoMatchReason,
} from "./negotiation.js";
import { buildReport, ReportLedger, type ReportOutcome } from "./reporter.js";
import type { AgentStateStore } from "./store.js";
import type { AgentClock, AgentLogger, SleepFn } from "./types.js";

/** Discovery polling is bounded independently from the negotiation deadline. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 60_000;
/** Hard ceiling on discovery polls per request. */
export const MAX_DISCOVERY_POLLS = 20;
/** Hard ceiling on quote-request attempts after discovery. */
export const MAX_QUOTE_CANDIDATES = 5;
/** Safety bound so a static clock can never make the event loop spin forever. */
export const MAX_EVENT_POLLS = 1_000;
/** Hard ceiling on order reads while a sandbox payment is still pending. */
export const MAX_PAYMENT_POLLS = 600;

export interface BuyerOrderOutcome {
  status: "agreed_and_paid" | "payment_failed";
  order: Order;
  message: string;
}

export interface BuyerNoMatchOutcome {
  status: "no_match";
  reason: NegotiationNoMatchReason;
  detail?: string;
  message: string;
}

export type BuyerOutcome = BuyerOrderOutcome | BuyerNoMatchOutcome;

/** In-chat transport injected by the caller; failure never changes order state. */
export type BuyerReportSink = (outcome: BuyerOutcome) => Promise<void> | void;

/** A retrieved source page, fully paged within the configured bound. */
export interface LiveEvidenceSource {
  id: string;
  url: string;
  text: string;
  /** True when the page cap stopped reading before the source ended. */
  truncated: boolean;
}

/** Everything the client model may use to interpret evidence. Never an authority. */
export interface LiveAssessmentContext {
  discoveryId: string;
  buyerNoticeNumber: string;
  evidence: unknown;
  sources: readonly LiveEvidenceSource[];
}

/**
 * The live flow: the platform collects evidence and stops; the caller's model reads it and
 * returns an assessment. There is no backend LLM and no seeded supplier.
 */
export interface LiveAssessmentOptions {
  /** Real notice number the client selected from search_buyer_notices. Never invented here. */
  buyerNoticeNumber: string;
  assess: (context: LiveAssessmentContext) => Promise<AgentAssessment>;
  maxSources?: number;
  maxPagesPerSource?: number;
}

export interface BuyerRunnerOptions {
  config: BuyerAgentConfig;
  client: PlatformClient;
  store?: AgentStateStore;
  clock?: AgentClock;
  sleep?: SleepFn;
  logger?: AgentLogger;
  report?: BuyerReportSink;
  /**
   * Participant id already known from an earlier registration. Used only when
   * the platform answers ALREADY_REGISTERED without returning the id.
   */
  knownParticipantId?: ParticipantId;
  /**
   * The draft contract does not carry a participant id on a ranked candidate.
   * Callers can inject the mapping discovered through their own integration.
   */
  supplierIdForCandidate?: (candidate: RankedCandidate) => ParticipantId | undefined;
  /** Convenience domain-keyed form of the same mapping. */
  supplierIdsByDomain?: Readonly<Record<string, ParticipantId>>;
  /**
   * Identifies one buyer run. Mutations that must be new per run (the sourcing
   * request) derive their idempotency key from it, so a rerun with the same or
   * changed inputs never replays an earlier run. Defaults to a random UUID.
   */
  runId?: string;
  discoveryTimeoutMs?: number;
  discoveryMaxPolls?: number;
  maxCandidates?: number;
  maxEventPolls?: number;
  /** Enables the live, client-assessed discovery flow. Absent keeps the fixture polling path. */
  live?: LiveAssessmentOptions;
}

type DiscoveryPollOutcome =
  | { kind: "complete"; result: DiscoveryResult }
  | { kind: "failed"; result: DiscoveryResult }
  | { kind: "timeout" };

interface NegotiationContext {
  participantId: ParticipantId;
  supplierId: ParticipantId;
  request: SourcingRequest;
  negotiation: BuyerNegotiation;
  handledOfferIds: Set<string>;
  handledOrderIds: Set<string>;
  lastOutcome?: BuyerOutcome;
}

/**
 * Buyer-side runner for one request. It registers, creates the request, runs
 * bounded discovery, requests a quote from ranked candidates and then follows
 * participant-scoped events to a settled order. Evidence text never feeds a
 * policy or a payment destination: only typed platform fields do.
 */
export class BuyerRunner {
  private readonly config: BuyerAgentConfig;
  private readonly client: PlatformClient;
  private readonly store: AgentStateStore | undefined;
  private readonly clock: AgentClock;
  private readonly sleep: SleepFn;
  private readonly logger: AgentLogger | undefined;
  private readonly report: BuyerReportSink | undefined;
  private readonly knownParticipantId: ParticipantId | undefined;
  private readonly supplierIdForCandidate:
    | ((candidate: RankedCandidate) => ParticipantId | undefined)
    | undefined;
  private readonly supplierIdsByDomain:
    | Readonly<Record<string, ParticipantId>>
    | undefined;
  private readonly discoveryTimeoutMs: number;
  private readonly discoveryMaxPolls: number;
  private readonly maxCandidates: number;
  private readonly maxEventPolls: number;
  private readonly runId: string;
  private readonly live: LiveAssessmentOptions | undefined;
  private readonly ledger: ReportLedger | undefined;
  private participantId: ParticipantId | undefined;
  private currentRequestId: string | undefined;
  private cursor: string | undefined;
  private resolvedLiveSupplierIds: Readonly<Record<string, ParticipantId>> | undefined;
  private readonly seenKeys = new Set<string>();
  private reported = false;

  constructor(options: BuyerRunnerOptions) {
    this.config = options.config;
    this.client = options.client;
    this.store = options.store;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger;
    this.report = options.report;
    this.knownParticipantId = options.knownParticipantId;
    this.supplierIdForCandidate = options.supplierIdForCandidate;
    this.supplierIdsByDomain = options.supplierIdsByDomain;
    this.runId = options.runId ?? randomUUID();
    this.live = options.live;
    this.ledger = this.store === undefined ? undefined : new ReportLedger(this.store);
    this.discoveryTimeoutMs = Math.max(
      1,
      options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
    );
    this.discoveryMaxPolls = Math.max(
      1,
      Math.min(options.discoveryMaxPolls ?? MAX_DISCOVERY_POLLS, MAX_DISCOVERY_POLLS),
    );
    this.maxCandidates = Math.max(
      1,
      Math.min(options.maxCandidates ?? MAX_QUOTE_CANDIDATES, MAX_QUOTE_CANDIDATES),
    );
    this.maxEventPolls = Math.max(
      1,
      options.maxEventPolls ?? MAX_EVENT_POLLS,
    );
  }

  async run(): Promise<BuyerOutcome> {
    const startedAtMs = this.clock.now();
    const participantId = await this.ensureRegistered();
    if (this.live !== undefined) {
      return this.runLive(participantId, startedAtMs);
    }
    const request = await this.createRequest();
    this.currentRequestId = request.id;

    const discovery = await this.awaitDiscovery(request.id);
    if (discovery.kind === "failed") {
      return this.finishNoMatch(
        "discovery_failed",
        describeSourceErrors(discovery.result),
      );
    }
    if (discovery.kind === "timeout") {
      return this.finishNoMatch(
        "discovery_timeout",
        "discovery did not complete within the bounded polling window",
      );
    }

    const candidates = rankEligibleCandidates(discovery.result.candidates).slice(
      0,
      this.maxCandidates,
    );
    if (candidates.length === 0) {
      return this.finishNoMatch(
        "no_candidates",
        "discovery returned no eligible candidates",
      );
    }

    const supplierId = await this.selectSupplier(request.id, candidates);
    if (supplierId === undefined) {
      return this.finishNoMatch(
        "no_connected_supplier",
        "no ranked candidate had a connected supplier participant",
      );
    }

    const negotiation = new BuyerNegotiation({
      request,
      mandate: this.config.buyer,
      buyerId: participantId,
      currency: this.config.currency,
      startedAtMs,
      limits: {
        maxRevisions: this.config.negotiationMaxRevisions,
        deadlineMs: this.config.negotiationDeadlineMs,
      },
    });

    const context: NegotiationContext = {
      participantId,
      supplierId,
      request,
      negotiation,
      handledOfferIds: new Set<string>(),
      handledOrderIds: new Set<string>(),
    };

    return this.negotiate(context);
  }

  /**
   * Live flow: bind a real notice, let the platform collect evidence, have the caller's model
   * assess it, then trade on the frozen ranking. The platform never ranks by account availability
   * and this runner never fabricates a candidate.
   */
  private async runLive(
    participantId: ParticipantId,
    startedAtMs: number,
  ): Promise<BuyerOutcome> {
    const live = this.live;
    if (live === undefined) {
      throw new Error("runLive requires a live assessment configuration");
    }

    const request = await this.createRequest(live.buyerNoticeNumber);
    this.currentRequestId = request.id;

    const { discoveryId } = await this.client.startDiscovery(request.id, {
      idempotencyKey: `agent-discover-${request.id}`,
    });

    const evidence = (await this.client.getDiscoveryEvidence(
      discoveryId,
    )) as LiveEvidenceView;

    if (evidence.phase === "failed") {
      return this.finishNoMatch("discovery_failed", describeEvidenceErrors(evidence));
    }
    if (evidence.phase !== "awaiting_agent_assessment") {
      return this.finishNoMatch(
        "discovery_failed",
        `discovery is not awaiting a client assessment (phase ${stringValue(evidence.phase)})`,
      );
    }
    if (evidence.selectedBuyerNoticeNumber !== live.buyerNoticeNumber) {
      return this.finishNoMatch(
        "discovery_failed",
        "the platform bound a different buyer notice than the one selected",
      );
    }

    const sources = await this.readLiveSources(discoveryId, evidence.sources);
    const assessment = await live.assess({
      discoveryId,
      buyerNoticeNumber: evidence.selectedBuyerNoticeNumber,
      evidence,
      sources,
    });

    // The model's output is data. Never repair it to fit; reject it instead.
    if (
      assessment.discoveryId !== discoveryId ||
      assessment.buyerNoticeNumber !== evidence.selectedBuyerNoticeNumber
    ) {
      return this.finishNoMatch(
        "assessment_rejected",
        "assessment did not reference this discovery and notice",
      );
    }

    let ranking: DiscoveryResult;
    try {
      ranking = await this.client.submitDiscoveryAssessment(discoveryId, assessment);
    } catch (error) {
      if (isAssessmentRejection(error)) {
        return this.finishNoMatch(
          "assessment_rejected",
          safeErrorMessage(error),
        );
      }
      throw error;
    }

    this.resolvedLiveSupplierIds = await this.resolveLiveParticipants(discoveryId);

    // The platform quotes only fully eligible candidates (eligible "yes"); a conditional one has
    // an unevidenced requirement and would be refused with QUALIFYING_CANDIDATE_REQUIRED.
    const candidates = rankEligibleCandidates(ranking.candidates)
      .filter((candidate) => candidate.eligible === "yes")
      .slice(0, this.maxCandidates);
    if (candidates.length === 0) {
      return this.finishNoMatch(
        "no_candidates",
        ranking.candidates.some((candidate) => candidate.eligible === "conditional")
          ? "no ranked candidate met every mandatory requirement; conditional candidates cannot be quoted"
          : "the frozen ranking contained no eligible candidate",
      );
    }

    const supplierId = await this.selectSupplier(request.id, candidates);
    if (supplierId === undefined) {
      return this.finishNoMatch(
        "no_connected_supplier",
        "no fully eligible ranked candidate could be quoted: none is connected, or the ranking is older than the platform quote window",
      );
    }

    const negotiation = new BuyerNegotiation({
      request,
      mandate: this.config.buyer,
      buyerId: participantId,
      currency: this.config.currency,
      startedAtMs,
      limits: {
        maxRevisions: this.config.negotiationMaxRevisions,
        deadlineMs: this.config.negotiationDeadlineMs,
      },
    });

    return this.negotiate({
      participantId,
      supplierId,
      request,
      negotiation,
      handledOfferIds: new Set<string>(),
      handledOrderIds: new Set<string>(),
    });
  }

  /** Read each source within hard caps: 5 sources, 3 pages each, 8,000 characters per page. */
  private async readLiveSources(
    discoveryId: string,
    sources: readonly { id: string; url: string }[],
  ): Promise<LiveEvidenceSource[]> {
    const maxSources = Math.min(this.live?.maxSources ?? 5, 5);
    const maxPages = Math.min(this.live?.maxPagesPerSource ?? 3, 3);
    const result: LiveEvidenceSource[] = [];

    for (const source of sources.slice(0, maxSources)) {
      let offset = 0;
      let text = "";
      let nextOffset: number | null = 0;
      let pages = 0;

      while (nextOffset !== null && pages < maxPages) {
        const page = (await this.client.readDiscoverySource(discoveryId, source.id, {
          offset,
          limit: 8_000,
        })) as { text: string; nextOffset: number | null };
        text += page.text;
        nextOffset = page.nextOffset;
        pages += 1;
        if (nextOffset !== null) {
          offset = nextOffset;
        }
      }

      result.push({
        id: source.id,
        url: source.url,
        text,
        truncated: nextOffset !== null,
      });
    }

    return result;
  }

  /** Platform resolution after ranking; unavailable or ambiguous accounts stay external leads. */
  private async resolveLiveParticipants(
    discoveryId: string,
  ): Promise<Readonly<Record<string, ParticipantId>>> {
    const resolved = (await this.client.resolveDiscoveryParticipants(
      discoveryId,
    )) as LiveResolutionView;
    const byDomain: Record<string, ParticipantId> = {};
    for (const entry of resolved.resolutions) {
      if (
        entry.connected !== true ||
        entry.participantId === undefined ||
        entry.eligible !== "yes"
      ) {
        continue;
      }
      byDomain[normalizeDomain(entry.company.officialDomain)] = entry.participantId;
    }
    return byDomain;
  }

  private async ensureRegistered(): Promise<ParticipantId> {
    if (this.participantId !== undefined) {
      return this.participantId;
    }
    const input = buildBuyerRegistration(this.config);
    // The key covers the registration body, so a changed mandate is a new
    // mutation rather than a reused key with a different body.
    const idempotencyKey = `agent-register-buyer-${registrationKey(this.config)}-${stableHash(input)}`;
    try {
      const result = await this.client.registerParticipant(input, {
        idempotencyKey,
      });
      this.participantId = result.participantId;
      return result.participantId;
    } catch (error) {
      if (error instanceof PlatformClientError && error.code === "ALREADY_REGISTERED") {
        const existing = error.participantId ?? this.knownParticipantId;
        if (existing !== undefined) {
          this.participantId = existing;
          return existing;
        }
        throw new Error(
          "buyer token is already registered and neither the platform nor AGENT_STATE_DIR supplied its participant id",
        );
      }
      throw error;
    }
  }

  private async createRequest(buyerNoticeNumber?: string): Promise<SourcingRequest> {
    const mandate = this.config.buyer;
    const input: Omit<SourcingRequest, "id" | "buyerId"> = {
      category: mandate.category,
      description: mandate.item,
      quantity: mandate.quantity,
      unit: mandate.unit,
      destination: mandate.destination,
      maximumDeliveredTotal: {
        amountMinor: mandate.maxOrderMinor,
        currency: this.config.currency,
      },
      deliverBy: mandate.deliverBy,
      requirements: mandate.requirements.map((requirement) => ({
        key: requirement.key,
        description: requirement.description,
        mandatory: requirement.mandatory,
      })),
      ...(buyerNoticeNumber === undefined ? {} : { buyerNoticeNumber }),
      demo: true,
    };
    return this.client.createRequest(input, {
      idempotencyKey: `agent-create-request-${this.runId}`,
    });
  }

  private async awaitDiscovery(
    requestId: string,
  ): Promise<DiscoveryPollOutcome> {
    const { discoveryId } = await this.client.startDiscovery(requestId, {
      idempotencyKey: `agent-discover-${requestId}`,
    });
    const startedAtMs = this.clock.now();

    for (let poll = 0; poll < this.discoveryMaxPolls; poll += 1) {
      const result = await this.client.getDiscovery(discoveryId);
      if (result.status === "complete") {
        return { kind: "complete", result };
      }
      if (result.status === "failed") {
        return { kind: "failed", result };
      }

      const elapsedMs = this.clock.now() - startedAtMs;
      if (elapsedMs >= this.discoveryTimeoutMs) {
        break;
      }
      const delayMs = Math.min(
        this.config.pollIntervalMs,
        this.discoveryTimeoutMs - elapsedMs,
      );
      await this.sleep(delayMs);
    }

    return { kind: "timeout" };
  }

  private async selectSupplier(
    requestId: string,
    candidates: readonly RankedCandidate[],
  ): Promise<ParticipantId | undefined> {
    for (const candidate of candidates) {
      const supplierId = this.resolveSupplierId(candidate);
      if (supplierId === undefined) {
        this.logger?.warn?.("buyer candidate has no mapped supplier participant", {
          domain: candidate.candidate.company.officialDomain,
        });
        continue;
      }

      try {
        await this.client.requestQuote(requestId, supplierId, {
          idempotencyKey: `agent-quote-${requestId}-${supplierId}`,
        });
        return supplierId;
      } catch (error) {
        if (
          error instanceof PlatformClientError &&
          (error.code === "NO_CONNECTED_REPRESENTATIVE" ||
            error.code === "NOT_FOUND" ||
            error.code === "QUALIFYING_CANDIDATE_REQUIRED")
        ) {
          this.logger?.info?.("buyer candidate is not connected; trying next", {
            domain: candidate.candidate.company.officialDomain,
            code: error.code,
          });
          continue;
        }
        throw error;
      }
    }
    return undefined;
  }

  private resolveSupplierId(
    candidate: RankedCandidate,
  ): ParticipantId | undefined {
    const domain = normalizeDomain(candidate.candidate.company.officialDomain);
    if (this.live !== undefined) {
      // Live mode trusts only the platform's resolution; an operator map never picks a supplier.
      return this.resolvedLiveSupplierIds?.[domain];
    }
    if (this.supplierIdForCandidate !== undefined) {
      return this.supplierIdForCandidate(candidate);
    }
    // MVP_LIMIT: the contract has no candidate -> participant resolution yet, so the
    // operator injects the mapping. Evidence fields (including publicOrganizationId)
    // never choose a quote recipient. Upgrade: a platform resolve call after ranking.
    return this.supplierIdsByDomain?.[domain];
  }

  private async negotiate(
    context: NegotiationContext,
  ): Promise<BuyerOutcome> {
    this.cursor = (await this.store?.getCursor()) ?? this.cursor;

    for (let iteration = 0; iteration < this.maxEventPolls; iteration += 1) {
      const nowMs = this.clock.now();
      const status = context.negotiation.status(nowMs);
      if (!status.open && status.reason === "deadline_exceeded") {
        return this.finishNoMatch(
          "deadline_exceeded",
          "negotiation deadline reached",
        );
      }

      const page = await this.client.listEvents(this.cursor);
      for (const event of page.events) {
        if (event.requestId !== context.request.id) {
          await this.markSeen(event.id);
          continue;
        }
        if (await this.isSeen(event.id)) {
          continue;
        }

        let outcome: BuyerOutcome | undefined;
        if (event.type === "offer_received") {
          outcome = await this.handleOffer(context, event.resourceId);
        } else if (event.type === "agreement_created") {
          outcome = await this.handleAgreement(context, event.resourceId);
        } else {
          this.logger?.debug?.("buyer ignored an unrelated event type", {
            type: event.type,
          });
        }

        await this.markSeen(event.id);
        if (outcome !== undefined) {
          return outcome;
        }
      }

      this.cursor = page.nextCursor;
      await this.store?.setCursor(this.cursor);

      const afterPageMs = this.clock.now();
      const afterPage = context.negotiation.status(afterPageMs);
      if (!afterPage.open && afterPage.reason === "deadline_exceeded") {
        return this.finishNoMatch(
          "deadline_exceeded",
          "negotiation deadline reached",
        );
      }

      const remainingMs = context.negotiation.deadlineAtMs - afterPageMs;
      if (remainingMs <= 0) {
        continue;
      }
      await this.sleep(Math.min(this.config.pollIntervalMs, remainingMs));
    }

    return this.finishNoMatch(
      "deadline_exceeded",
      "bounded event polling exhausted without an agreement",
    );
  }

  private async handleOffer(
    context: NegotiationContext,
    offerId: string,
  ): Promise<BuyerOutcome | undefined> {
    const offer = await this.client.getOffer(offerId);
    if (
      offer.requestId !== context.request.id ||
      offer.buyerId !== context.participantId ||
      offer.supplierId !== context.supplierId
    ) {
      return undefined;
    }
    if (context.handledOfferIds.has(offer.id)) {
      return undefined;
    }
    context.handledOfferIds.add(offer.id);

    const decision = context.negotiation.evaluate(offer, this.clock.now());
    if (decision.kind === "accept") {
      try {
        const acceptance = await this.client.acceptOffer(offer.id, {
          idempotencyKey: `agent-accept-${offer.id}`,
        });
        if (acceptance.state === "agreed") {
          return this.finalizeOrder(context, acceptance.order.id);
        }
      } catch (error) {
        const mapped = mapNegotiationError(error);
        if (mapped !== undefined) {
          return this.finishNoMatch(mapped, safeErrorMessage(error));
        }
        throw error;
      }
      return undefined;
    }

    if (decision.kind === "counter") {
      const counter = context.negotiation.buildCounterOffer(
        offer,
        decision.amountMinor,
      );
      try {
        await this.client.submitOffer(counter, {
          idempotencyKey: `agent-counter-${offer.id}`,
        });
        context.negotiation.recordSubmittedCounter();
      } catch (error) {
        // The platform enforces the counterparty's mandate too. A counter below a private
        // supplier floor is refused (POLICY_REFUSAL); if the standing offer was acceptable,
        // accept it instead of losing the deal. No floor information is revealed.
        if (isPolicyRefusal(error) && decision.reasons.length === 0) {
          try {
            const acceptance = await this.client.acceptOffer(offer.id, {
              idempotencyKey: `agent-accept-${offer.id}`,
            });
            if (acceptance.state === "agreed") {
              return this.finalizeOrder(context, acceptance.order.id);
            }
            return undefined;
          } catch (acceptError) {
            const mapped = mapNegotiationError(acceptError);
            if (mapped !== undefined) {
              return this.finishNoMatch(mapped, safeErrorMessage(acceptError));
            }
            throw acceptError;
          }
        }
        const mapped = mapNegotiationError(error);
        if (mapped !== undefined) {
          return this.finishNoMatch(mapped, safeErrorMessage(error));
        }
        throw error;
      }
      return undefined;
    }

    return this.finishNoMatch(
      noMatchReasonFor(decision.reasons),
      decision.reasons.join(", "),
    );
  }

  private async handleAgreement(
    context: NegotiationContext,
    orderId: string,
  ): Promise<BuyerOutcome | undefined> {
    if (context.handledOrderIds.has(orderId)) {
      return undefined;
    }
    return this.finalizeOrder(context, orderId);
  }

  private async finalizeOrder(
    context: NegotiationContext,
    orderId: string,
  ): Promise<BuyerOutcome> {
    if (context.handledOrderIds.has(orderId)) {
      return (
        context.lastOutcome ??
        this.finishNoMatch("platform_error", "duplicate agreement event")
      );
    }
    context.handledOrderIds.add(orderId);

    try {
      await this.client.settleOrder(orderId, {
        idempotencyKey: `agent-settle-${orderId}`,
      });
    } catch (error) {
      this.logger?.warn?.("buyer settlement request failed; reading order state", {
        orderId,
        reason: safeErrorMessage(error),
      });
    }

    const paymentDeadlineAtMs = this.clock.now() + this.paymentWaitMs();
    const order = await this.awaitTerminalPayment(orderId, paymentDeadlineAtMs);
    if (order.acceptedOffer.requestId !== context.request.id) {
      return this.finishNoMatch(
        "platform_error",
        "settled order does not belong to this request",
      );
    }

    const outcome = buildOrderOutcome(order, this.clock.now(), paymentDeadlineAtMs);
    context.lastOutcome = outcome;
    return this.emitOutcome(outcome);
  }

  private paymentWaitMs(): number {
    return Math.max(1, this.config.paymentWaitMs ?? DEFAULT_PAYMENT_WAIT_MS);
  }

  /**
   * Re-read the order until the provider status is terminal or the payment
   * window closes. A pending charge is never reported as failed early.
   */
  private async awaitTerminalPayment(orderId: string, deadlineAtMs: number): Promise<Order> {
    let order = await this.client.getOrder(orderId);
    for (let poll = 0; poll < MAX_PAYMENT_POLLS && !isTerminalPayment(order); poll += 1) {
      const remainingMs = deadlineAtMs - this.clock.now();
      if (remainingMs <= 0) {
        break;
      }
      await this.sleep(Math.min(this.config.pollIntervalMs, remainingMs));
      order = await this.client.getOrder(orderId);
    }
    return order;
  }

  private async finishNoMatch(
    reason: NegotiationNoMatchReason,
    detail?: string,
  ): Promise<BuyerNoMatchOutcome> {
    const outcome = buildNoMatchOutcome(reason, detail);
    return this.emitOutcome(outcome);
  }

  /**
   * Deliver the result once through the injected chat sink. The persisted
   * ledger deduplicates across restarts, and a failed delivery is queued for
   * `report_pending` instead of being dropped. Delivery never changes state.
   */
  private async emitOutcome<T extends BuyerOutcome>(outcome: T): Promise<T> {
    if (this.reported) {
      return outcome;
    }
    this.reported = true;
    const subjectKey =
      outcome.status === "no_match"
        ? `request:${this.currentRequestId ?? `run:${this.runId}`}`
        : outcome.order.id;
    const kind: ReportOutcome =
      outcome.status === "agreed_and_paid"
        ? "paid"
        : outcome.status === "no_match"
          ? "no_match"
          : "payment_failed";
    if (this.ledger !== undefined && (await this.ledger.isReported(subjectKey, kind))) {
      return outcome;
    }
    if (this.report === undefined) {
      return outcome;
    }
    try {
      await this.report(outcome);
      await this.ledger?.recordReport(subjectKey, kind, outcome.message);
    } catch (error) {
      this.logger?.warn?.("buyer result report failed; queued, order state unchanged", {
        reason: safeErrorMessage(error),
      });
      await this.ledger?.enqueuePending(subjectKey, kind, outcome.message, this.clock.now());
    }
    return outcome;
  }

  /** Completion messages whose chat delivery failed earlier. */
  async drainPendingReports(): Promise<string[]> {
    return this.ledger === undefined ? [] : this.ledger.drainPending();
  }

  private async isSeen(key: string): Promise<boolean> {
    if (this.seenKeys.has(key)) {
      return true;
    }
    if (this.store !== undefined && (await this.store.hasSeen(key))) {
      this.seenKeys.add(key);
      return true;
    }
    return false;
  }

  private async markSeen(key: string): Promise<void> {
    this.seenKeys.add(key);
    await this.store?.markSeen(key);
  }
}

function buildBuyerRegistration(config: BuyerAgentConfig): RegistrationInput {
  const company =
    config.companyOrgId === undefined
      ? {
          name: config.companyName,
          officialDomain: config.companyDomain,
        }
      : {
          name: config.companyName,
          officialDomain: config.companyDomain,
          publicOrganizationId: config.companyOrgId,
        };

  return {
    company,
    role: "buyer",
    mandate: {
      maximumOrderTotal: {
        amountMinor: config.buyer.maxOrderMinor,
        currency: config.currency,
      },
      maximumRunTotal: {
        amountMinor: config.buyer.maxRunMinor,
        currency: config.currency,
      },
      allowedCategories: [config.buyer.category],
      destination: config.buyer.destination,
      expiresAt: config.buyer.expiresAt,
      sandboxOnly: true,
    },
    demo: true,
  };
}

/** Map authoritative order state to one of the allowed chat literals. */
function buildOrderOutcome(
  order: Order,
  nowMs: number,
  paymentDeadlineAtMs: number,
): BuyerOrderOutcome {
  const decision = buildReport(order, { nowMs, paymentDeadlineAtMs });
  if (decision.report && decision.outcome === "paid") {
    return { status: "agreed_and_paid", order, message: decision.message };
  }
  if (decision.report) {
    return { status: "payment_failed", order, message: decision.message };
  }
  const reason =
    decision.reason === "missing_payment_reference"
      ? "provider reported success without a payment reference"
      : `payment ${order.paymentStatus} when the run ended`;
  return {
    status: "payment_failed",
    order,
    message: `payment failed — ${reason}; order ${order.id}`,
  };
}

function isTerminalPayment(order: Order): boolean {
  return (
    order.paymentStatus === "succeeded" ||
    order.paymentStatus === "failed" ||
    order.paymentStatus === "requires_action"
  );
}

function buildNoMatchOutcome(
  reason: NegotiationNoMatchReason,
  detail?: string,
): BuyerNoMatchOutcome {
  const sanitized = detail === undefined ? undefined : sanitizeDetail(detail);
  const suffix =
    sanitized === undefined || sanitized === "" ? "" : `: ${sanitized}`;
  return {
    status: "no_match",
    reason,
    message: `no match — ${reason}${suffix}`,
    ...(sanitized === undefined || sanitized === "" ? {} : { detail: sanitized }),
  };
}

function rankEligibleCandidates(
  candidates: readonly RankedCandidate[],
): RankedCandidate[] {
  return candidates
    .filter((candidate) => candidate.eligible !== "no")
    .slice()
    .sort((left, right) => left.rank - right.rank);
}

interface LiveEvidenceView {
  phase: string;
  selectedBuyerNoticeNumber: string;
  sources: { id: string; url: string }[];
  sourceErrors: { url: string; message: string }[];
}

interface LiveResolutionView {
  resolutions: {
    company: { officialDomain: string };
    eligible: "yes" | "conditional" | "no";
    connected: boolean;
    participantId?: string;
  }[];
}

function describeEvidenceErrors(view: LiveEvidenceView): string {
  if (view.sourceErrors.length === 0) {
    return "live collection failed without a source error";
  }
  return view.sourceErrors
    .map((sourceError) => `${sourceError.url}: ${sourceError.message}`)
    .join("; ");
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value : "unknown";
}

/** The platform refused an offer as outside a mandate. Other 403s (scope, expiry) are not this. */
function isPolicyRefusal(error: unknown): boolean {
  return error instanceof PlatformClientError && error.code === "POLICY_REFUSAL";
}

/** Only a platform rejection of this assessment maps to a no-match; transport errors rethrow. */
function isAssessmentRejection(error: unknown): boolean {
  if (!(error instanceof PlatformClientError)) {
    return false;
  }
  return (
    error.code === "INVALID_ASSESSMENT" ||
    error.code === "RANKING_REQUIRED" ||
    error.status === 400 ||
    error.status === 409 ||
    error.status === 422
  );
}

function describeSourceErrors(result: DiscoveryResult): string {
  const messages = result.sourceErrors
    .map((sourceError) => sourceError.message)
    .filter((message) => message.trim() !== "");
  return messages.length === 0
    ? "discovery failed without a source error message"
    : messages.join("; ");
}

function mapNegotiationError(
  error: unknown,
): NegotiationNoMatchReason | undefined {
  if (!(error instanceof PlatformClientError)) {
    return undefined;
  }
  switch (error.code) {
    case "REVISION_LIMIT":
      return "revision_limit";
    case "STALE_OFFER":
    case "CAPACITY_CONFLICT":
    case "INVALID_OFFER":
      return "refused";
    default:
      return undefined;
  }
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

function registrationKey(config: BuyerAgentConfig): string {
  const domain = normalizeDomain(config.companyDomain);
  const company = config.companyName.trim().toLowerCase().replace(/\s+/g, "-");
  return `${domain}-${company}`;
}

function sanitizeDetail(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeDetail(error.message);
  }
  return "unknown error";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
