import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../payments/postgres-store.js";
import type { StripeClient } from "../payments/stripe.js";

/**
 * Automatic demo onboarding over MCP Streamable HTTP: the URL alone is enough to start.
 * `initialize` without credentials issues an `Mcp-Session-Id`; the client echoes it on every request.
 * Registering binds that session to a new demo participant, and from then on the session id is the
 * participant's bearer credential. Sessions live in the database, so they survive reconnects and restarts.
 */
export const SESSION_HEADER = "mcp-session-id";
const SESSION_PREFIX = "mcps_";

/** Server-held demo ceilings. A bot's mandate must fit inside them; it never sets them. */
export interface OnboardingPolicy {
  currency: string;
  buyerMaxOrderMinor: number;
  buyerMaxRunMinor: number;
  supplierMinDeliveredMinor: number;
  supplierMaxQuantity: number;
  sessionHours: number;
}

export const DEFAULT_POLICY: OnboardingPolicy = {
  currency: "EUR", buyerMaxOrderMinor: 1_000_000, buyerMaxRunMinor: 2_000_000,
  supplierMinDeliveredMinor: 0, supplierMaxQuantity: 1_000_000, sessionHours: 24,
};

export interface OnboardingOptions {
  policy?: OnboardingPolicy;
  /** Sandbox Stripe client: buyers get a saved test card automatically. */
  stripe?: StripeClient | undefined;
}

export const hashSession = (id: string) => createHash("sha256").update(id, "utf8").digest("hex");
export const isSessionId = (id: string) => /^mcps_[A-Za-z0-9_-]{43}$/.test(id);

export async function openSession(db: Queryable, policy: OnboardingPolicy): Promise<string> {
  const id = `${SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
  await db.query("select marketplace.open_onboarding_session($1, $2)", [hashSession(id), policy.sessionHours]);
  return id;
}

export type SessionState = { state: "unknown" } | { state: "pending" } | { state: "registered"; participantId: string };

export async function sessionState(db: Queryable, id: string): Promise<SessionState> {
  if (!isSessionId(id)) return { state: "unknown" };
  const row = (await db.query<{ participant_id: string | null; expired: boolean }>(
    "select participant_id, expires_at <= now() as expired from marketplace.onboarding_sessions where session_hash = $1", [hashSession(id)])).rows[0];
  if (!row || row.expired) return { state: "unknown" };
  return row.participant_id ? { state: "registered", participantId: row.participant_id } : { state: "pending" };
}

/** Sandbox-only test card, saved through a SetupIntent exactly as the operator CLI does. Nobody enters card details. */
async function sandboxTestCard(stripe: StripeClient): Promise<{ customer: string; paymentMethod: string } | undefined> {
  try {
    const customer = await stripe.postOk<{ id: string }>("/customers", { name: "Demo buyer (auto-onboarded)", "metadata[demo]": "true" });
    const setup = await stripe.postOk<{ status: string; payment_method: string | null }>("/setup_intents", {
      customer: customer.id, payment_method: "pm_card_visa", "automatic_payment_methods[enabled]": true,
      "automatic_payment_methods[allow_redirects]": "never", usage: "off_session", confirm: true, "metadata[demo]": "true",
    });
    return setup.status === "succeeded" && setup.payment_method ? { customer: customer.id, paymentMethod: setup.payment_method } : undefined;
  } catch {
    return undefined; // Registration still succeeds; settlement then reports the missing payment credential.
  }
}

export async function onboard(db: Queryable, id: string, role: "buyer" | "supplier", options: OnboardingOptions): Promise<string> {
  const policy = options.policy ?? DEFAULT_POLICY;
  const card = role === "buyer" && options.stripe ? await sandboxTestCard(options.stripe) : undefined;
  const row = (await db.query<{ participant: string }>(
    "select marketplace.onboard_demo_participant($1, $2, $3, $4, $5, $6, $7, $8, $9) as participant",
    [hashSession(id), role, policy.currency, policy.buyerMaxOrderMinor, policy.buyerMaxRunMinor,
      policy.supplierMinDeliveredMinor, policy.supplierMaxQuantity, card?.customer ?? null, card?.paymentMethod ?? null])).rows[0];
  return row!.participant;
}
