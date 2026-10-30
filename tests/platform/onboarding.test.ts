import assert from "node:assert/strict";
import { test } from "node:test";
import { StripeClient } from "../../src/payments/stripe.js";
import { DEFAULT_POLICY } from "../../src/platform/onboarding.js";
import { createObserverPlatform } from "./support/observer-platform.js";

// Automatic MCP-session onboarding. Disposable PGlite; Stripe is a recorded fetch, not a network call.
const limit = { timeout: 20_000 };
const company = (name: string, domain: string) => ({ name, officialDomain: domain });
const buyerMandate = (orderMinor = 500_000, runMinor = 1_000_000) => ({ maximumOrderTotal: { amountMinor: orderMinor, currency: "EUR" }, maximumRunTotal: { amountMinor: runMinor, currency: "EUR" },
  allowedCategories: ["components"], destination: "EU", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sandboxOnly: true });
const supplierMandate = { minimumDeliveredTotal: { amountMinor: 1000, currency: "EUR" }, availableQuantity: 50, unit: "box",
  earliestDeliveryAt: new Date(Date.now() + 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sandboxOnly: true };

/** A Streamable HTTP MCP client that holds only the URL and whatever session id the server issues. */
function client(url: string) {
  let session: string | undefined;
  let n = 0;
  return {
    get session() { return session; },
    set session(value) { session = value; },
    async rpc(method: string, params?: unknown) {
      const response = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, ...(params === undefined ? {} : { params }) }) });
      session = response.headers.get("mcp-session-id") ?? session;
      return { status: response.status, body: await response.json().catch(() => ({})) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; tools?: { name: string }[] }; error?: { message: string } } };
    },
    call(name: string, args: unknown) { return this.rpc("tools/call", { name, arguments: args }); },
  };
}

test("the URL alone is enough: initialize issues a session, registration binds it to a demo participant", limit, async () => {
  const platform = await createObserverPlatform({ onboarding: {} });
  try {
    const bot = client(platform.url);
    const init = await bot.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grok-test", version: "1" } });
    assert.equal(init.status, 200);
    assert.match(bot.session ?? "", /^mcps_[A-Za-z0-9_-]{43}$/);
    assert.ok((await bot.rpc("tools/list")).body.result?.tools?.some((t) => t.name === "register_participant"));
    const early = await bot.call("create_request", {});
    assert.match(early.body.error?.message ?? "", /Not registered yet/);
    const registered = await bot.call("register_participant", { role: "buyer", company: company("Demo Buyer", "buyer-demo.example.com"), mandate: buyerMandate(), demo: true });
    assert.equal(registered.body.result?.isError, false, JSON.stringify(registered.body));
    const me = (await bot.call("get_my_participant", {})).body.result?.structuredContent;
    assert.equal(me?.role, "buyer");
    assert.match(String(me?.participantId), /^demo-buyer-/);
    assert.equal(me?.registered, true);
  } finally { await platform.close(); }
});

test("buyer and supplier sessions stay separate, and a session cannot switch role", limit, async () => {
  const platform = await createObserverPlatform({ onboarding: {} });
  try {
    const buyer = client(platform.url), supplier = client(platform.url);
    await buyer.rpc("initialize", {}); await supplier.rpc("initialize", {});
    assert.notEqual(buyer.session, supplier.session);
    await buyer.call("register_participant", { role: "buyer", company: company("Demo Buyer", "buyer-demo.example.com"), mandate: buyerMandate(), demo: true });
    await supplier.call("register_participant", { role: "supplier", company: company("Alpha Components", "alpha-demo.example.com"), mandate: supplierMandate, demo: true });
    const b = (await buyer.call("get_my_participant", {})).body.result?.structuredContent;
    const s = (await supplier.call("get_my_participant", {})).body.result?.structuredContent;
    assert.deepEqual([b?.role, s?.role], ["buyer", "supplier"]);
    assert.notEqual(b?.participantId, s?.participantId);
    const again = await buyer.call("register_participant", { role: "supplier", company: company("X", "x-demo.example.com"), mandate: supplierMandate, demo: true });
    assert.equal(again.body.result?.isError, true, "an onboarded session keeps its role");
    assert.equal((await buyer.call("get_my_participant", {})).body.result?.structuredContent?.role, "buyer");
  } finally { await platform.close(); }
});

test("reconnecting with the same session keeps the identity; an unknown session must re-initialize", limit, async () => {
  const platform = await createObserverPlatform({ onboarding: {} });
  try {
    const bot = client(platform.url);
    await bot.rpc("initialize", {});
    await bot.call("register_participant", { role: "buyer", company: company("Demo Buyer", "buyer-demo.example.com"), mandate: buyerMandate(), demo: true });
    const first = (await bot.call("get_my_participant", {})).body.result?.structuredContent?.participantId;
    // A new connection (and a fresh client object) presenting the saved session id is the same participant.
    const reconnected = client(platform.url);
    reconnected.session = bot.session;
    await reconnected.rpc("initialize", {});
    assert.equal((await reconnected.call("get_my_participant", {})).body.result?.structuredContent?.participantId, first);
    const stranger = client(platform.url);
    stranger.session = `mcps_${"A".repeat(43)}`;
    assert.equal((await stranger.rpc("tools/list")).status, 404);
    assert.equal((await client(platform.url).rpc("tools/list")).status, 400, "no session and not initialize");
  } finally { await platform.close(); }
});

test("ceilings are server-held: a mandate above them is refused", limit, async () => {
  const platform = await createObserverPlatform({ onboarding: {} });
  try {
    const bot = client(platform.url);
    await bot.rpc("initialize", {});
    const over = await bot.call("register_participant", { role: "buyer", company: company("Greedy", "greedy-demo.example.com"),
      mandate: buyerMandate(DEFAULT_POLICY.buyerMaxOrderMinor + 1, DEFAULT_POLICY.buyerMaxRunMinor), demo: true });
    assert.equal(over.body.result?.isError, true);
    assert.match(JSON.stringify(over.body), /MANDATE_EXCEEDS_GRANT/);
  } finally { await platform.close(); }
});

test("a buyer gets a sandbox test card automatically; nobody enters card details", limit, async () => {
  const calls: { path: string; body: string }[] = [];
  const stripe = new StripeClient({ secretKey: "sk_test_onboardingfixture1" }, async (url, init) => {
    calls.push({ path: new URL(url).pathname, body: String(init.body) });
    return Response.json(url.endsWith("/customers") ? { id: "cus_auto1" } : { id: "seti_1", status: "succeeded", payment_method: "pm_auto1" });
  });
  const platform = await createObserverPlatform({ onboarding: { stripe } });
  try {
    const bot = client(platform.url);
    await bot.rpc("initialize", {});
    await bot.call("register_participant", { role: "buyer", company: company("Demo Buyer", "buyer-demo.example.com"), mandate: buyerMandate(), demo: true });
    assert.deepEqual(calls.map((c) => c.path), ["/v1/customers", "/v1/setup_intents"]);
    assert.match(calls[1]!.body, /payment_method=pm_card_visa/);
    await platform.db.exec("reset role");
    const card = (await platform.db.query<{ stripe_customer_id: string }>("select stripe_customer_id from marketplace.payment_credentials where participant_id like 'demo-buyer-%'")).rows;
    assert.deepEqual(card.map((r) => r.stripe_customer_id), ["cus_auto1"]);
  } finally { await platform.close(); }
});
