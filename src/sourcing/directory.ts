import type { Evidence } from "../contracts.js";
import { FixedJsonApi, SourceApiError, type JsonApiOptions, type JsonApiResult } from "./json-api.js";

export const TED_DIRECTORY_URL = "https://api.ted.europa.eu/v3/notices/search";
export const BZP_DIRECTORY_URL = "https://ezamowienia.gov.pl/mo-board/api/v1/notice";

export interface DirectoryQuery {
  cpvCode?: string;
  keywords?: string;
  /** Restrict TED winner searches by the source-native country field. Poland-only MVP path. */
  supplierCountry?: "POL";
  publishedFrom: string;
  publishedTo: string;
  limit?: number;
}

export interface DirectoryParty {
  name: string;
  /** Source-reported identifier, not a participant ID or automatically verified national ID. */
  publicOrganizationId: string | null;
  country: string | null;
}

export interface DirectoryEntry {
  id: string;
  role: "supplier" | "buyer";
  company: DirectoryParty;
  cpvCodes: string[];
  categoryScope: "notice-level";
  basis: "reported-contract-winner" | "published-buyer-need";
  notice: { provider: "ted" | "bzp"; reference: string; url: string; publishedOn: string };
  description: string | null;
  submissionDeadline: string | null;
  deadlineStatus: "future" | "past" | "unknown";
}

export interface DirectoryResult {
  entries: DirectoryEntry[];
  source: Omit<Evidence, "quotation">;
  sourceErrors: { url: string; message: string }[];
  coverage: { noticesReturned: number; noticeLimit: number; moreMayExist: boolean };
  /** These directory results contain no verified stock, price, certification or trading authority. */
  commercialTerms: "unknown";
}

export type DirectoryOptions = Pick<JsonApiOptions, "fetch" | "now" | "timeoutMs" | "maxResponseBytes">;

/** Bounded live public API directory. No website search, vector index, model or account directory. */
export class ProcurementDirectory {
  private readonly ted: FixedJsonApi;
  private readonly bzp: FixedJsonApi;
  constructor(options: DirectoryOptions = {}) {
    // Copy only supported transport options. No caller-selected endpoint or outbound credentials.
    const transport = { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}), timeoutMs: options.timeoutMs ?? 15_000,
      maxResponseBytes: options.maxResponseBytes ?? 1024 * 1024 };
    this.ted = new FixedJsonApi({ ...transport, endpoint: TED_DIRECTORY_URL });
    this.bzp = new FixedJsonApi({ ...transport, endpoint: BZP_DIRECTORY_URL });
  }

  async findSuppliers(query: DirectoryQuery, options: { signal?: AbortSignal } = {}): Promise<DirectoryResult> {
    const search = validateQuery(query, TED_DIRECTORY_URL);
    const clauses = ["notice-type = can-standard", `publication-date >= ${search.publishedFrom.replaceAll("-", "")}`,
      `publication-date <= ${search.publishedTo.replaceAll("-", "")}`];
    if (search.supplierCountry) clauses.push(`winner-country = ${search.supplierCountry}`);
    if (search.cpvCode) clauses.push(`classification-cpv = ${search.cpvCode}`);
    if (search.keywords) clauses.push(`FT ~ "${search.keywords}"`);
    const result = await this.ted.post({ query: `${clauses.join(" AND ")} SORT BY publication-date DESC`, fields: ["publication-number", "publication-date", "notice-type",
      "classification-cpv", "winner-name", "winner-identifier", "winner-country"], page: 1, limit: search.limit,
      scope: "ALL", onlyLatestVersions: true, checkQuerySyntax: false }, options.signal);
    const payload = result.payload;
    if (!record(payload) || !Array.isArray(payload.notices) || typeof payload.timedOut !== "boolean" ||
        !Number.isSafeInteger(payload.totalNoticeCount) || (payload.totalNoticeCount as number) < payload.notices.length || payload.notices.length > search.limit) {
      throw new SourceApiError("INVALID_RESPONSE", TED_DIRECTORY_URL, "Invalid TED directory envelope");
    }
    if (payload.timedOut) throw new SourceApiError("INVALID_RESPONSE", TED_DIRECTORY_URL, "TED reported an incomplete timed-out search");
    return normalize(result, payload.notices, search, "ted", (payload.totalNoticeCount as number) > payload.notices.length);
  }

  async findBuyers(query: DirectoryQuery, options: { signal?: AbortSignal } = {}): Promise<DirectoryResult> {
    const search = validateQuery(query, BZP_DIRECTORY_URL);
    const parameters = new URLSearchParams({ NoticeType: "ContractNotice", PublicationDateFrom: `${search.publishedFrom}T00:00:00Z`,
      PublicationDateTo: `${search.publishedTo}T23:59:59.999Z`, PageSize: String(search.limit) });
    if (search.cpvCode) parameters.set("CpvCode", search.cpvCode);
    if (search.keywords) parameters.set("OrderObject", search.keywords);
    const result = await this.bzp.get(parameters, options.signal);
    if (!Array.isArray(result.payload) || result.payload.length > search.limit) {
      throw new SourceApiError("INVALID_RESPONSE", BZP_DIRECTORY_URL, "Invalid BZP directory envelope");
    }
    return normalize(result, result.payload, search, "bzp", result.payload.length === search.limit);
  }
}

type Search = { cpvCode: string | undefined; keywords: string | undefined; supplierCountry: "POL" | undefined;
  publishedFrom: string; publishedTo: string; limit: number };
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function dateOnly(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function validateQuery(query: DirectoryQuery, url: string): Search {
  const fail = (): never => { throw new SourceApiError("INVALID_INPUT", url, "Invalid directory filters: use CPV and/or plain keywords, ordered calendar dates and limit 1..10"); };
  if (!record(query) || Object.keys(query).some((key) => !["cpvCode", "keywords", "supplierCountry", "publishedFrom", "publishedTo", "limit"].includes(key)) ||
      !dateOnly(query.publishedFrom) || !dateOnly(query.publishedTo) || query.publishedFrom > query.publishedTo ||
      (query.supplierCountry !== undefined && (url !== TED_DIRECTORY_URL || query.supplierCountry !== "POL")) ||
      (query.cpvCode !== undefined && (typeof query.cpvCode !== "string" || !/^\d{8}(-\d)?$/.test(query.cpvCode))) ||
      (query.keywords !== undefined && (typeof query.keywords !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N} ,.'-]{0,119}$/u.test(query.keywords)))) fail();
  const cpvCode = query.cpvCode?.slice(0, 8), keywords = query.keywords?.trim(), limit = query.limit ?? 5;
  // MVP_LIMIT: one page, at most ten notices and 100 named suppliers per notice. No bulk catalogue ingestion.
  if ((!cpvCode && !keywords) || !Number.isInteger(limit) || limit < 1 || limit > 10) fail();
  return { publishedFrom: query.publishedFrom, publishedTo: query.publishedTo, cpvCode, keywords,
    supplierCountry: query.supplierCountry, limit };
}
function text(value: unknown, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Invalid text");
  return value.trim();
}
function optionalText(value: unknown, max = 500): string | null { return value == null || value === "" ? null : text(value, max); }
function strings(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid list");
  return value.map((item) => text(item));
}
function cpvs(value: unknown): string[] {
  let values: string[];
  if (typeof value === "string") {
    if (value.length > 20_000) throw new Error("Oversized CPV text");
    values = [];
    // BZP returns comma-separated codes with optional Polish labels, not a bare code array.
    const rest = value.replace(/(?:^|,)\s*(\d{8}(?:-\d)?)(?:\s*\([^)]*\))?\s*(?=,|$)/gu, (_match, code: string) => { values.push(code); return ""; });
    if (rest.replaceAll(",", "").trim()) throw new Error("Invalid CPV list");
  } else values = strings(value);
  if (!values.length || values.some((item) => !/^\d{8}(-\d)?$/.test(item))) throw new Error("Invalid CPV");
  return [...new Set(values.map((item) => item.slice(0, 8)))].sort();
}
function matchesCpv(codes: string[], filter?: string): boolean {
  // CPV parents conventionally end in zeros. Category matching is not a capability certification.
  return !filter || codes.some((code) => code.startsWith(filter.replace(/0+$/, "")));
}
function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)?$/.test(value) && dateOnly(value.slice(0, 10));
}
function publication(value: unknown, search: Search, provider: "ted" | "bzp"): string {
  const published = text(value, 40), day = published.slice(0, 10);
  const valid = provider === "ted" ? /^\d{4}-\d{2}-\d{2}(Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)?$/.test(published) : validTimestamp(published);
  if (!valid || !dateOnly(day) || day < search.publishedFrom || day > search.publishedTo) throw new Error("Invalid publication date");
  return published;
}
function deadline(value: unknown, retrievedAt: string): Pick<DirectoryEntry, "submissionDeadline" | "deadlineStatus"> {
  const raw = optionalText(value, 40);
  if (raw !== null && !validTimestamp(raw)) throw new Error("Invalid deadline timestamp");
  // Keep provider-local times as text. Never silently apply the runtime's local timezone.
  const explicit = raw !== null && /(?:Z|[+-]\d{2}:\d{2})$/.test(raw);
  const instant = explicit ? Date.parse(raw) : NaN;
  return { submissionDeadline: raw, deadlineStatus: !Number.isFinite(instant) ? "unknown" : instant > Date.parse(retrievedAt) ? "future" : "past" };
}
function supplierEntries(raw: Record<string, unknown>, search: Search): { entries: DirectoryEntry[]; ambiguous: boolean } {
  const reference = text(raw["publication-number"], 20);
  if (!/^\d{1,7}-(19|20)\d{2}$/.test(reference) || raw["notice-type"] !== "can-standard") throw new Error("Invalid award metadata");
  const publishedOn = publication(raw["publication-date"], search, "ted"), cpvCodes = cpvs(raw["classification-cpv"]);
  if (!matchesCpv(cpvCodes, search.cpvCode) || !record(raw["winner-name"])) throw new Error("Irrelevant or invalid award");
  const localized = raw["winner-name"];
  if (!Object.keys(localized).length || Object.keys(localized).some((key) => !/^[a-z]{3}$/.test(key))) throw new Error("Invalid localized winners");
  const namesByLanguage = Object.fromEntries(Object.entries(localized).map(([key, value]) => [key, strings(value)]));
  const language = namesByLanguage.eng?.length ? "eng" : Object.keys(namesByLanguage).sort().find((key) => namesByLanguage[key]!.length);
  if (!language) throw new Error("Missing winners");
  const names = namesByLanguage[language]!, identifiers = strings(raw["winner-identifier"]), countries = strings(raw["winner-country"]);
  const single = Object.values(namesByLanguage).every((values) => values.length === 1);
  const ambiguous = !single || identifiers.length > 1 || countries.length > 1;
  return { ambiguous, entries: names.map((name, index) => ({ id: `ted:${reference}:${index}`, role: "supplier",
    company: { name, publicOrganizationId: !ambiguous ? identifiers[0] ?? null : null, country: !ambiguous ? countries[0] ?? null : null },
    cpvCodes, categoryScope: "notice-level", basis: "reported-contract-winner",
    notice: { provider: "ted", reference, url: `https://ted.europa.eu/en/notice/${reference}/html`, publishedOn },
    description: null, submissionDeadline: null, deadlineStatus: "unknown" })) };
}
function buyerEntries(raw: Record<string, unknown>, search: Search, retrievedAt: string): DirectoryEntry[] {
  const objectId = text(raw.objectId, 36), reference = text(raw.noticeNumber, 100);
  if (!/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(objectId) || raw.noticeType !== "ContractNotice") throw new Error("Invalid buyer metadata");
  const cpvCodes = cpvs(raw.cpvCode), publishedOn = publication(raw.publicationDate, search, "bzp");
  if (!matchesCpv(cpvCodes, search.cpvCode)) throw new Error("Irrelevant notice");
  return [{ id: `bzp:${objectId.toLowerCase()}`, role: "buyer", company: { name: text(raw.organizationName),
    publicOrganizationId: optionalText(raw.organizationNationalId), country: optionalText(raw.organizationCountry) }, cpvCodes,
    categoryScope: "notice-level", basis: "published-buyer-need", notice: { provider: "bzp", reference,
      url: `https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/${objectId}`, publishedOn },
    description: optionalText(raw.orderObject, 20_000), ...deadline(raw.submittingOffersDate, retrievedAt) }];
}
function normalize(result: JsonApiResult, rows: unknown[], search: Search, provider: "ted" | "bzp", moreMayExist: boolean): DirectoryResult {
  const { payload: _, ...source } = result;
  const sourceErrors: DirectoryResult["sourceErrors"] = [], groups = new Map<string, DirectoryEntry[]>(), conflicts = new Set<string>();
  rows.forEach((raw, index) => {
    try {
      if (!record(raw)) throw new Error("Invalid record");
      const parsed = provider === "ted" ? supplierEntries(raw, search) : { entries: buyerEntries(raw, search, source.retrievedAt), ambiguous: false };
      // Keep uncertain identities visible, but never pass an explicitly foreign winner into the Poland-only path.
      if (provider === "ted" && search.supplierCountry && parsed.entries.some((entry) =>
        entry.company.country !== null && entry.company.country !== search.supplierCountry)) throw new Error("Foreign supplier omitted");
      const key = provider === "ted" ? parsed.entries[0]!.notice.reference : parsed.entries[0]!.id;
      if (parsed.ambiguous) sourceErrors.push({ url: source.url, message: `Notice at index ${index}: ambiguous winner fields remain unbound` });
      const previous = groups.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(parsed.entries)) {
        conflicts.add(key); sourceErrors.push({ url: source.url, message: `Conflicting duplicate notice at index ${index}: omitted` });
      } else groups.set(key, parsed.entries);
    } catch {
      sourceErrors.push({ url: source.url, message: `Invalid or irrelevant ${provider.toUpperCase()} notice at index ${index}: omitted` });
    }
  });
  return { entries: [...groups].filter(([key]) => !conflicts.has(key)).flatMap(([, entries]) => entries), source, sourceErrors,
    coverage: { noticesReturned: rows.length, noticeLimit: search.limit, moreMayExist }, commercialTerms: "unknown" };
}
