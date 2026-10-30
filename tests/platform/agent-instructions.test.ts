import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { handleRequest } from "../../src/index.js";
import { createPlatformHttp } from "../../src/platform/http.js";
import type { Database } from "../../src/platform/database.js";
import type { Marketplace } from "../../src/platform/marketplace.js";

const TOKEN = "agent-instructions-fixture-bearer";

function platformFixture() {
  const tokenHash = createHash("sha256").update(TOKEN, "utf8").digest("hex");
  const db: Database = {
    async query<R>(sql: string, params?: unknown[]) {
      assert.match(sql, /marketplace\.api_credentials/, "only the authentication fixture query is expected");
      const rows = params?.[0] === tokenHash
        ? [{ participant_id: "buyer-fixture", role: "buyer", demo: true }]
        : [];
      return { rows: rows as R[] };
    },
    async transaction<T>() {
      throw new Error("instructions fixture must not open a transaction");
    },
  };
  const platform = createPlatformHttp(db, {} as Marketplace);
  const request = (path: string, method = "GET", body?: unknown) => handleRequest(
    new Request(`https://marketplace.example.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { platform },
  );
  return { request };
}

test("agent guide aliases serve the same conservative scaffold copy and reject mutations", async () => {
  const paths = ["/agent.txt", "/llms.txt"];
  const responses = await Promise.all(paths.map((path) => handleRequest(new Request(`https://example.test${path}`))));
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const [agentText, llmsText] = await Promise.all(responses.map((response) => response.text())) as [string, string];
  assert.equal(agentText, llmsText);
  assert.match(agentText, /status:\s*scaffold/i);
  assert.match(agentText, /not implemented/i);
  assert.doesNotMatch(agentText, /Use get_my_participant/);

  for (const path of paths) {
    const response = await handleRequest(new Request(`https://example.test${path}`, { method: "POST" }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  }
});

test("configured aliases and authenticated MCP initialize share the low-level live guide", async () => {
  const { request } = platformFixture();
  const [agentResponse, llmsResponse] = await Promise.all([
    request("/agent.txt"),
    request("/llms.txt"),
  ]);
  assert.equal(agentResponse.status, 200);
  assert.equal(llmsResponse.status, 200);
  const [liveGuide, llmsGuide] = await Promise.all([agentResponse.text(), llmsResponse.text()]);
  assert.equal(liveGuide, llmsGuide);
  assert.ok(liveGuide.includes("Mcp-Session-Id"), "automatic onboarding must explain the server-issued session");
  assert.ok(liveGuide.includes("without an Authorization header"), "a new demo must not require a pre-issued token");
  assert.doesNotMatch(liveGuide, /Connect to POST \/mcp with your own operator-provisioned bearer token/);

  for (const phrase of [
    "tools/list",
    "get_my_participant",
    "register_participant",
    "search_buyer_notices",
    "buyerNoticeNumber",
    "start_discovery",
    "get_discovery_evidence",
    "read_discovery_source",
    "submit_discovery_assessment",
    "resolve_discovery_participants",
    "request_quote",
    "list_events",
    "get_request",
    "submit_offer",
    "get_offer",
    "accept_offer",
    "get_order",
    "settle_order",
    "operator-provisioned",
    "immutable",
    "untrusted",
    "not mounted",
    "not been verified",
  ]) assert.ok(liveGuide.includes(phrase), `live guide should cover ${phrase}`);
  assert.doesNotMatch(liveGuide, /start_purchase|supplier_listener_tick/);

  for (const path of ["/agent.txt", "/llms.txt"]) {
    const response = await request(path, "POST");
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  }

  const initialize = await request("/mcp", "POST", {
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(initialize.status, 200);
  const initializeBody = await initialize.json() as { result: { instructions: string } };
  assert.equal(initializeBody.result.instructions, liveGuide);

  const listed = await request("/mcp", "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(listed.status, 200);
  const listBody = await listed.json() as { result: { tools: { name: string }[] } };
  const names = listBody.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("search_buyer_notices"));
  assert.ok(names.includes("submit_discovery_assessment"));
  assert.equal(names.includes("start_purchase"), false);
  assert.equal(names.includes("supplier_listener_tick"), false);
  assert.equal(names.some((name) => /ted|bzp|award|supplier_search/i.test(name)), false);
});
