import type {
  DiscoveryResult,
  EventPage,
  Offer,
  Order,
  ParticipantId,
  RegistrationInput,
  RequestId,
  SourcingRequest,
} from "../contracts.js";
import type { AgentAssessment } from "../sourcing/assessment.js";

export interface PlatformClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retry?: { attempts: number; baseDelayMs: number };
  /**
   * Live platform contract: offer participants are derived from the bearer token, so sending
   * buyerId/supplierId is rejected. The fixture platform still requires them, hence the flag.
   */
  omitActorIdsFromOffers?: boolean;
}

export interface MutationOptions {
  /** Stable key for one logical mutation. Defaults to a deterministic key derived from the route and body. */
  idempotencyKey?: string;
}

export type AcceptanceResult =
  | { state: "awaiting_counterparty" }
  | { state: "agreed"; order: Order };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 200;
const REDACTED = "[redacted]";

export class PlatformClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly idempotencyKey?: string;
  /** Existing participant id returned with ALREADY_REGISTERED, when the platform supplies it. */
  readonly participantId?: string;

  constructor(
    code: string,
    status: number,
    message: string,
    idempotencyKey?: string,
    participantId?: string,
  ) {
    super(message);
    this.name = "PlatformClientError";
    this.code = code;
    this.status = status;
    if (idempotencyKey !== undefined) {
      this.idempotencyKey = idempotencyKey;
    }
    if (participantId !== undefined) {
      this.participantId = participantId;
    }
  }
}

/** Small platform HTTP client used by both agents. It never logs or embeds the participant token. */
export class PlatformClient {
  /** Number of HTTP attempts (including retries). Useful in tests. */
  requestCount = 0;
  /** Value of the last `x-request-id` response header, when the platform supplies one. */
  lastRequestId: string | undefined;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly omitActorIdsFromOffers: boolean;

  constructor(options: PlatformClientOptions) {
    const token = options.token.trim();
    if (!options.baseUrl.trim()) {
      throw new PlatformClientError("INVALID_CONFIGURATION", 0, "Platform base URL is required");
    }
    if (!token) {
      throw new PlatformClientError("INVALID_CONFIGURATION", 0, "Participant token is required");
    }
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.token = token;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    const retry = options.retry ?? { attempts: DEFAULT_ATTEMPTS, baseDelayMs: DEFAULT_BASE_DELAY_MS };
    this.maxAttempts = positiveInteger(retry.attempts, "retry.attempts");
    this.baseDelayMs = nonNegativeInteger(retry.baseDelayMs, "retry.baseDelayMs");
    this.omitActorIdsFromOffers = options.omitActorIdsFromOffers === true;
  }

  async registerParticipant(
    input: RegistrationInput,
    options: MutationOptions = {},
  ): Promise<{ participantId: ParticipantId }> {
    const path = "/v1/participants";
    return this.send("POST", path, input, options.idempotencyKey ?? stableKey("registerParticipant", path, input));
  }

  async createRequest(
    input: Omit<SourcingRequest, "id" | "buyerId">,
    options: MutationOptions = {},
  ): Promise<SourcingRequest> {
    const path = "/v1/requests";
    return this.send("POST", path, input, options.idempotencyKey ?? stableKey("createRequest", path, input));
  }

  async startDiscovery(requestId: RequestId, options: MutationOptions = {}): Promise<{ discoveryId: string }> {
    const path = `/v1/requests/${encodeURIComponent(requestId)}/discover`;
    return this.send("POST", path, {}, options.idempotencyKey ?? stableKey("startDiscovery", path, {}));
  }

  async getDiscovery(discoveryId: string): Promise<DiscoveryResult> {
    return this.send("GET", `/v1/discoveries/${encodeURIComponent(discoveryId)}`);
  }

  async getMyParticipant(): Promise<unknown> {
    return this.send("GET", "/v1/me");
  }

  async searchBuyerNotices(query: string, limit?: number): Promise<unknown> {
    const path = "/v1/sources/buyer-notices/search";
    const body = { query, ...(limit === undefined ? {} : { limit }) };
    return this.send("POST", path, body, stableKey("searchBuyerNotices", path, body));
  }

  async getDiscoveryEvidence(discoveryId: string): Promise<unknown> {
    return this.send("GET", `/v1/discoveries/${encodeURIComponent(discoveryId)}/evidence`);
  }

  async readDiscoverySource(
    discoveryId: string,
    sourceId: string,
    options: { offset?: number; limit?: number } = {},
  ): Promise<unknown> {
    const query = new URLSearchParams();
    if (options.offset !== undefined) query.set("offset", String(options.offset));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size === 0 ? "" : `?${query}`;
    return this.send("GET", `/v1/discoveries/${encodeURIComponent(discoveryId)}/sources/${encodeURIComponent(sourceId)}${suffix}`);
  }

  async submitDiscoveryAssessment(discoveryId: string, assessment: AgentAssessment): Promise<DiscoveryResult> {
    const path = `/v1/discoveries/${encodeURIComponent(discoveryId)}/assessments`;
    return this.send("POST", path, assessment, stableKey("submitDiscoveryAssessment", path, assessment));
  }

  async resolveDiscoveryParticipants(discoveryId: string): Promise<unknown> {
    const path = `/v1/discoveries/${encodeURIComponent(discoveryId)}/resolve`;
    return this.send("POST", path, {}, stableKey("resolveDiscoveryParticipants", path, {}));
  }

  async listEvents(after?: string): Promise<EventPage> {
    const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
    return this.send("GET", `/v1/events${query}`);
  }

  async requestQuote(
    requestId: RequestId,
    supplierId: ParticipantId,
    options: MutationOptions = {},
  ): Promise<{ eventId: string }> {
    const path = `/v1/requests/${encodeURIComponent(requestId)}/quote-requests`;
    const body = { supplierId };
    return this.send("POST", path, body, options.idempotencyKey ?? stableKey("requestQuote", path, body));
  }

  async submitOffer(input: Omit<Offer, "id">, options: MutationOptions = {}): Promise<Offer> {
    const path = `/v1/requests/${encodeURIComponent(input.requestId)}/offers`;
    let body: Omit<Offer, "id"> | Omit<Offer, "id" | "buyerId" | "supplierId"> = input;
    if (this.omitActorIdsFromOffers) {
      const { buyerId: _buyerId, supplierId: _supplierId, ...terms } = input;
      body = terms;
    }
    return this.send("POST", path, body, options.idempotencyKey ?? stableKey("submitOffer", path, body));
  }

  async acceptOffer(offerId: string, options: MutationOptions = {}): Promise<AcceptanceResult> {
    const path = `/v1/offers/${encodeURIComponent(offerId)}/acceptances`;
    return this.send("POST", path, {}, options.idempotencyKey ?? stableKey("acceptOffer", path, {}));
  }

  async settleOrder(orderId: string, options: MutationOptions = {}): Promise<Order> {
    const path = `/v1/orders/${encodeURIComponent(orderId)}/settle`;
    return this.send("POST", path, {}, options.idempotencyKey ?? stableKey("settleOrder", path, {}));
  }

  async getOrder(orderId: string): Promise<Order> {
    return this.send("GET", `/v1/orders/${encodeURIComponent(orderId)}`);
  }

  /** Proposed scoped read route: allowed only for participants attached to the request. */
  async getRequest(requestId: RequestId): Promise<SourcingRequest> {
    return this.send("GET", `/v1/requests/${encodeURIComponent(requestId)}`);
  }

  /** Proposed scoped read route: allowed only for the two parties of the offer. */
  async getOffer(offerId: string): Promise<Offer> {
    return this.send("GET", `/v1/offers/${encodeURIComponent(offerId)}`);
  }

  private async send<T>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    if (idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    let lastFailure: PlatformClientError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const init: RequestInit = { method, headers, signal: this.timeoutSignal() };
      if (encodedBody !== undefined) {
        init.body = encodedBody;
      }

      this.requestCount += 1;
      let response: Response;
      try {
        response = await this.fetchImpl(this.joinUrl(path), init);
      } catch (error) {
        const failure = this.transportError(error, method, path, idempotencyKey);
        lastFailure = failure;
        if (attempt < this.maxAttempts) {
          await this.sleep(this.retryDelay(attempt));
          continue;
        }
        throw failure;
      }

      const requestId = response.headers.get("x-request-id");
      if (requestId !== null) {
        this.lastRequestId = requestId;
      }

      if (response.status >= 200 && response.status < 300) {
        return await this.decodeSuccess<T>(response, method, path, idempotencyKey);
      }

      const failure = await this.decodeError(response, method, path, idempotencyKey);
      lastFailure = failure;
      if (this.shouldRetry(response.status) && attempt < this.maxAttempts) {
        await this.sleep(this.retryDelay(attempt));
        continue;
      }
      throw failure;
    }

    throw lastFailure ?? new PlatformClientError("NETWORK_ERROR", 0, `${method} ${path} failed`, idempotencyKey);
  }

  private async decodeSuccess<T>(
    response: Response,
    method: string,
    path: string,
    idempotencyKey?: string,
  ): Promise<T> {
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await this.safeRead(response, method, path, idempotencyKey);
    if (text.trim() === "") {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PlatformClientError(
        "INVALID_RESPONSE",
        response.status,
        `${method} ${path} returned a non-JSON response`,
        idempotencyKey,
      );
    }
  }

  private async decodeError(
    response: Response,
    method: string,
    path: string,
    idempotencyKey?: string,
  ): Promise<PlatformClientError> {
    const text = await this.safeRead(response, method, path, idempotencyKey);
    let code = `HTTP_${response.status}`;
    let detail: string | undefined;
    let participantId: string | undefined;
    if (text.trim() !== "") {
      try {
        const payload: unknown = JSON.parse(text);
        if (isRecord(payload)) {
          if (typeof payload.error === "string" && payload.error.length > 0) {
            code = payload.error;
          }
          if (typeof payload.message === "string" && payload.message.length > 0) {
            detail = payload.message;
          }
          if (typeof payload.participantId === "string" && payload.participantId.length > 0) {
            participantId = payload.participantId;
          }
        }
      } catch {
        detail = text.slice(0, 200);
      }
    }
    const suffix = detail === undefined ? "" : `: ${detail}`;
    return new PlatformClientError(
      code,
      response.status,
      this.redact(`${method} ${path} failed with ${response.status}${suffix}`),
      idempotencyKey,
      participantId,
    );
  }

  private async safeRead(
    response: Response,
    method: string,
    path: string,
    idempotencyKey?: string,
  ): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw this.transportError(error, method, path, idempotencyKey);
    }
  }

  private transportError(error: unknown, method: string, path: string, idempotencyKey?: string): PlatformClientError {
    if (isAbortError(error)) {
      return new PlatformClientError(
        "TIMEOUT",
        0,
        this.redact(`${method} ${path} timed out after ${this.timeoutMs}ms`),
        idempotencyKey,
      );
    }
    const reason = error instanceof Error ? this.redact(error.message) : "unknown transport failure";
    return new PlatformClientError(
      "NETWORK_ERROR",
      0,
      `${method} ${path} could not reach the platform: ${reason}`,
      idempotencyKey,
    );
  }

  private timeoutSignal(): AbortSignal {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      return AbortSignal.timeout(this.timeoutMs);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
    return controller.signal;
  }

  private shouldRetry(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }

  private retryDelay(attempt: number): number {
    return this.baseDelayMs * 2 ** (attempt - 1);
  }

  private joinUrl(path: string): string {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}${suffix}`;
  }

  private redact(value: string): string {
    if (!this.token) {
      return value;
    }
    return value.split(this.token).join(REDACTED);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  return name === "TimeoutError" || name === "AbortError";
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new PlatformClientError("INVALID_CONFIGURATION", 0, `${field} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new PlatformClientError("INVALID_CONFIGURATION", 0, `${field} must be a non-negative integer`);
  }
  return value;
}

/** Short stable hash of a JSON-serialisable value, for idempotency keys. */
export function stableHash(value: unknown): string {
  return fnv1a(JSON.stringify(value));
}

/** Deterministic per-logical-mutation key: retries and restarts reuse it. */
function stableKey(operation: string, path: string, body: unknown): string {
  const bodyHash = fnv1a(JSON.stringify(body));
  const operationHash = fnv1a(`${operation}\n${path}\n${bodyHash}`);
  return `pc-${operationHash}-${bodyHash}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
