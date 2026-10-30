import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createPlatformHttp } from "../../src/platform/http.js";
import type { Database } from "../../src/platform/database.js";
import { fixture } from "./support/live-fixture.js";

test("public demo routes can be disabled without changing participant or private observer auth", async () => {
  const f = await fixture();
  try {
    const platform = createPlatformHttp({ query: (sql, params) => f.db.query(sql, params), transaction: (action) => f.db.transaction((tx) => action(tx)) }, f.market, { publicDemoObserver: { enabled: false } });
    const response = await platform.handle(new Request("https://marketplace.example.com/v1/demo-observer/runs"));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await platform.handle(new Request("https://marketplace.example.com/v1/me"))).status, 401);
    assert.equal((await platform.handle(new Request("https://marketplace.example.com/v1/observer/runs"))).status, 401);
  } finally { await f.db.close(); }
});

test("configured public demo list is readable through the real HTTP router without a key", async () => {
  const f = await fixture();
  try {
    await f.db.exec("reset role");
    await f.db.exec(readFileSync(new URL("../../../supabase/migrations/20261030170000_observer.sql", import.meta.url), "utf8"));
    await f.db.exec("set role marketplace_app");
    const database: Database = { query: (sql, params) => f.db.query(sql, params), transaction: (action) => f.db.transaction((tx) => action(tx)) };
    const platform = createPlatformHttp(database, f.market, {
      now: () => new Date("2026-10-30T12:00:00Z"),
      observerApi: { allowedOrigins: ["https://agentmarketplace.pages.dev"] },
    });
    const response = await platform.handle(new Request("https://marketplace.example.com/v1/demo-observer/runs", {
      headers: { origin: "https://agentmarketplace.pages.dev" },
    }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://agentmarketplace.pages.dev");
    assert.deepEqual((await response.json() as { runs: unknown[] }).runs, []);
  } finally { await f.db.close(); }
});
