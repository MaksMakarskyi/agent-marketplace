import assert from "node:assert/strict";
import { test } from "node:test";
import { ObserverBus } from "../../src/platform/observer.js";
import { createPublicDemoObserver } from "../../src/platform/public-demo-observer.js";
import { PRIVATE, createObserverPlatform, driveRun, type ObserverPlatform } from "./support/observer-platform.js";

type Json = Record<string, any>;

function create(platform: ObserverPlatform, observer?: ObserverBus) {
  return createPublicDemoObserver(platform.db, { ...(observer ? { observer } : {}) });
}

async function call(handler: ReturnType<typeof create>, path: string, init: RequestInit = {}, origin = "https://agentmarketplace.pages.dev") {
  const headers = new Headers(init.headers);
  if (origin) headers.set("origin", origin);
  const response = await handler(new Request(`https://api.example${path}`, { ...init, headers }));
  const raw = await response.text();
  return { response, body: raw ? JSON.parse(raw) as Json : {} };
}

async function count(platform: ObserverPlatform, table: string): Promise<number> {
  return Number(((await platform.db.query(`select count(*)::int as n from marketplace.${table}`)).rows[0] as { n: number }).n);
}

test("public demo view is enabled without credentials and can be explicitly disabled", async () => {
  const platform = await createObserverPlatform();
  try {
    assert.equal((await call(create(platform), "/v1/demo-observer/runs")).response.status, 200);
    assert.equal((await call(create(platform, undefined), "/v1/demo-observer/activity")).response.status, 200);
    assert.equal((await call(createPublicDemoObserver(platform.db, { enabled: false }), "/v1/demo-observer/runs")).response.status, 404);
  } finally { await platform.close(); }
});

test("public list and detail include demo runs from multiple registered buyer accounts", async () => {
  const platform = await createObserverPlatform();
  try {
    const first = await driveRun(platform);
    const original = platform.tokens.buyer;
    platform.tokens.buyer = platform.tokens.otherBuyer;
    let second: Awaited<ReturnType<typeof driveRun>>;
    try { second = await driveRun(platform); } finally { platform.tokens.buyer = original; }

    const handler = create(platform);
    const before = await Promise.all(["agent_traces", "participant_events", "orders", "payment_attempts"].map((table) => count(platform, table)));
    const list = await call(handler, "/v1/demo-observer/runs");
    assert.equal(list.response.status, 200);
    assert.deepEqual(new Set(list.body.runs.map((run: Json) => run.id)), new Set([first.requestId, second.requestId]));
    assert.equal(list.body.session.label, "Public demo");
    assert.equal(list.body.session.expiresAt, null);

    for (const runId of [first.requestId, second.requestId]) {
      const result = await call(handler, `/v1/demo-observer/runs/${runId}`);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.run.phase, "paid");
      assert.equal(result.body.order.payment.status, "succeeded");
      assert.equal(result.body.session.label, "Public demo");
    }
    const serialized = JSON.stringify(list.body) + JSON.stringify(await (await call(handler, `/v1/demo-observer/runs/${first.requestId}`)).body);
    for (const privateValue of [String(PRIVATE.buyerMaxOrder), String(PRIVATE.buyerMaxRun), String(PRIVATE.supplierFloor),
      String(PRIVATE.requestMax), platform.tokens.buyer, platform.tokens.supplier, platform.tokens.observer, "pm_fixture", "cus_fixture"]) {
      assert.equal(serialized.includes(privateValue), false, `response excludes ${privateValue.slice(0, 8)}`);
    }
    assert.equal((await call(handler, "/v1/demo-observer/runs/does-not-exist")).response.status, 404);
    assert.equal((await call(handler, `/v1/demo-observer/runs/${first.requestId}`, { method: "POST", body: "{}" })).response.status, 405);
    const after = await Promise.all(["agent_traces", "participant_events", "orders", "payment_attempts"].map((table) => count(platform, table)));
    assert.deepEqual(after, before);
  } finally { await platform.close(); }
});

test("public activity includes only a redacted recent authenticated agent action", async () => {
  const platform = await createObserverPlatform();
  const bus = new ObserverBus();
  try {
    bus.emit({ requestId: "outer", at: "2026-10-30T10:00:00.000Z", source: "mcp", level: "info", operation: "submit_offer", method: "POST",
      route: "/v1/requests/{requestId}/offers", status: 200, outcome: "ok", durationMs: 14,
      actor: { participantId: "private-participant-id", role: "supplier" }, subject: { requestId: "safe-run-123" },
      message: "Contains a private amount 80991 and credential canary." });
    bus.emit({ requestId: "poll", at: "2026-10-30T10:00:01.000Z", source: "mcp", level: "debug", operation: "list_events", method: "GET", route: "/v1/events",
      status: 200, outcome: "ok", durationMs: 1, message: "poll-canary", actor: { participantId: "private-participant-id", role: "supplier" } });
    bus.emit({ requestId: "stripe", at: "2026-10-30T10:00:02.000Z", source: "stripe", level: "info", operation: "stripe_webhook", method: "POST",
      route: "/webhooks/stripe", status: 200, outcome: "ok", durationMs: 1, message: "provider-private-canary" });
    bus.emit({ requestId: "unknown", at: "2026-10-30T10:00:03.000Z", source: "system", level: "warn", operation: "unknown_route", method: "GET",
      route: "/unknown", status: 404, outcome: "refused", durationMs: 1, message: "unknown-canary" });

    const response = await call(create(platform, bus), "/v1/demo-observer/activity");
    assert.equal(response.response.status, 200);
    assert.equal(response.response.headers.get("access-control-allow-origin"), "https://agentmarketplace.pages.dev");
    assert.equal(response.body.activities.length, 1);
    assert.deepEqual(response.body.activities[0], { id: bus.recent()[0]?.id, at: bus.recent()[0]?.at,
      source: "mcp", role: "supplier", operation: "submit_offer", status: 200, outcome: "ok", durationMs: 14, requestId: "safe-run-123" });
    const body = JSON.stringify(response.body);
    for (const value of ["private-participant-id", "private amount", "80991", "credential canary", "provider-private-canary", "unknown-canary", "poll-canary"]) {
      assert.equal(body.includes(value), false);
    }
  } finally { await platform.close(); }
});

test("public demo CORS defaults to the Pages origin and rejects other origins", async () => {
  const platform = await createObserverPlatform();
  try {
    const handler = create(platform);
    const allowed = await call(handler, "/v1/demo-observer/runs", { method: "OPTIONS" });
    assert.equal(allowed.response.status, 204);
    assert.equal(allowed.response.headers.get("access-control-allow-origin"), "https://agentmarketplace.pages.dev");
    assert.equal(allowed.response.headers.get("access-control-allow-methods"), "GET");
    const rejected = await call(handler, "/v1/demo-observer/runs", { method: "OPTIONS" }, "https://attacker.example");
    assert.equal(rejected.response.status, 403);
    assert.equal(rejected.response.headers.get("access-control-allow-origin"), null);
  } finally { await platform.close(); }
});
