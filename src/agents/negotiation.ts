import type { Offer, ParticipantId, SourcingRequest } from "../contracts.js";
import type { BuyerMandateConfig } from "./config.js";
import {
  decideBuyerOffer,
  mandatoryRequirementKeys,
  negotiationStatus,
  resolveNegotiationLimits,
  type BuyerOfferDecision,
  type BuyerPolicy,
  type NegotiationLimits,
  type NegotiationLimitsInput,
  type NegotiationState,
  type NegotiationStatus,
  type PolicyRefusalReason,
} from "./policy.js";

/** Buyer-side reasons that end a run without any commercial effect. */
export type NegotiationNoMatchReason =
  | "discovery_failed"
  | "discovery_timeout"
  | "assessment_rejected"
  | "no_candidates"
  | "no_connected_supplier"
  | "refused"
  | "expired"
  | "deadline_exceeded"
  | "revision_limit"
  | "platform_error";

export interface BuyerNegotiationOptions {
  request: SourcingRequest;
  mandate: BuyerMandateConfig;
  buyerId: ParticipantId;
  currency: string;
  startedAtMs: number;
  limits?: NegotiationLimitsInput;
}

export interface BuyerCounterOfferInput {
  request: SourcingRequest;
  mandate: BuyerMandateConfig;
  buyerId: ParticipantId;
  supplierId: ParticipantId;
  currency: string;
  amountMinor: number;
  previousOfferId: string;
  deliveryAt: string;
  expiresAt: string;
  confirmedRequirementKeys?: readonly string[];
}

/**
 * Derive the buyer policy from the operator-provided mandate and the request
 * that was actually created. Neither value can be raised by a bot at runtime.
 */
export function buyerPolicyFromMandate(
  request: SourcingRequest,
  mandate: BuyerMandateConfig,
  currency: string,
): BuyerPolicy {
  return {
    maximumOrderTotalMinor: Math.min(
      mandate.maxOrderMinor,
      request.maximumDeliveredTotal.amountMinor,
    ),
    remainingRunTotalMinor: mandate.maxRunMinor,
    currency,
    destination: mandate.destination,
    quantity: mandate.quantity,
    unit: mandate.unit,
    deliverBy: mandate.deliverBy,
    mandatoryRequirementKeys: mandatoryRequirementKeys(mandate.requirements),
    ...(mandate.expiresAt === "" ? {} : { expiresAt: mandate.expiresAt }),
  };
}

function uniqueKeys(
  keys: readonly string[],
  known: ReadonlySet<string>,
): string[] {
  const result: string[] = [];
  for (const key of keys) {
    if (known.has(key) && !result.includes(key)) {
      result.push(key);
    }
  }
  return result;
}

/**
 * Build a buyer counteroffer from the request, the buyer mandate and the
 * supplier offer being countered. Buyer counters keep the supplier's delivery
 * and expiry terms; only the price changes.
 */
export function buildBuyerCounterOffer(
  input: BuyerCounterOfferInput,
): Omit<Offer, "id"> {
  const knownKeys = new Set(input.request.requirements.map((entry) => entry.key));
  const confirmedRequirementKeys = uniqueKeys(
    [
      ...mandatoryRequirementKeys(input.mandate.requirements),
      ...(input.confirmedRequirementKeys ?? []),
    ],
    knownKeys,
  );

  return {
    requestId: input.request.id,
    buyerId: input.buyerId,
    supplierId: input.supplierId,
    previousOfferId: input.previousOfferId,
    quantity: input.request.quantity,
    unit: input.request.unit,
    destination: input.request.destination,
    deliveredTotal: {
      amountMinor: input.amountMinor,
      currency: input.currency,
    },
    // MVP_LIMIT: demo terms carry no separate tax or delivery component, matching the
    // supplier's offers. Upgrade: carry real components once the platform defines them.
    taxMinor: 0,
    deliveryMinor: 0,
    deliveryAt: input.deliveryAt,
    expiresAt: input.expiresAt,
    confirmedRequirementKeys,
    // The contract only permits this origin on an Offer. Buyer counters carry it
    // because the exchanged terms still originate in the demo supplier declaration.
    termsOrigin: "demo-supplier-declaration",
    demo: true,
  };
}

/** Map the policy reasons that stopped a negotiation onto a report reason. */
export function noMatchReasonFor(
  reasons: readonly PolicyRefusalReason[],
): NegotiationNoMatchReason {
  if (reasons.includes("deadline_exceeded")) {
    return "deadline_exceeded";
  }
  if (reasons.includes("revision_limit")) {
    return "revision_limit";
  }
  if (
    reasons.includes("offer_expired") ||
    reasons.includes("mandate_expired")
  ) {
    return "expired";
  }
  return "refused";
}

/**
 * One buyer negotiation. Counts every offer revision observed or submitted so
 * the configured revision ceiling is applied to the whole chain, not just to
 * the buyer's own counters.
 */
export class BuyerNegotiation {
  private readonly request: SourcingRequest;
  private readonly mandate: BuyerMandateConfig;
  private readonly buyerId: ParticipantId;
  private readonly currency: string;
  private readonly limits: NegotiationLimits;
  private readonly policy: BuyerPolicy;
  private readonly startedAtMs: number;
  private observedOffers = 0;
  private submittedCounters = 0;

  constructor(options: BuyerNegotiationOptions) {
    this.request = options.request;
    this.mandate = options.mandate;
    this.buyerId = options.buyerId;
    this.currency = options.currency;
    this.startedAtMs = options.startedAtMs;
    this.limits = resolveNegotiationLimits(options.limits);
    this.policy = buyerPolicyFromMandate(
      options.request,
      options.mandate,
      options.currency,
    );
  }

  get deadlineAtMs(): number {
    return this.startedAtMs + this.limits.deadlineMs;
  }

  get revisions(): number {
    return this.observedOffers + this.submittedCounters;
  }

  status(nowMs: number): NegotiationStatus {
    return negotiationStatus(this.state(), this.limits, nowMs);
  }

  /**
   * Evaluate one supplier offer. The incoming offer counts as an observed
   * revision before the policy runs, so a counter produced here cannot exceed
   * the configured chain length.
   */
  evaluate(offer: Offer, nowMs: number): BuyerOfferDecision {
    this.observedOffers += 1;
    return decideBuyerOffer({
      offer,
      policy: this.policy,
      state: this.state(),
      nowMs,
      limits: this.limits,
    });
  }

  /** Record a counteroffer successfully submitted to the platform. */
  recordSubmittedCounter(): void {
    this.submittedCounters += 1;
  }

  /** Construct the counteroffer that follows the supplied supplier offer. */
  buildCounterOffer(offer: Offer, amountMinor: number): Omit<Offer, "id"> {
    return buildBuyerCounterOffer({
      request: this.request,
      mandate: this.mandate,
      buyerId: this.buyerId,
      supplierId: offer.supplierId,
      currency: this.currency,
      amountMinor,
      previousOfferId: offer.id,
      deliveryAt: offer.deliveryAt,
      expiresAt: earliestIso(offer.expiresAt, this.mandate.expiresAt),
      confirmedRequirementKeys: offer.confirmedRequirementKeys,
    });
  }

  private state(): NegotiationState {
    return { revisions: this.revisions, startedAtMs: this.startedAtMs };
  }
}

function earliestIso(left: string, right: string): string {
  if (right === "") {
    return left;
  }
  return Date.parse(right) < Date.parse(left) ? right : left;
}
