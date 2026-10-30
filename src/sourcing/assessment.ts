import type { ActorContext, Candidate, DiscoveryResult, SourcingRequest } from "../contracts.js";
import { EvidenceRanker } from "../matching/evidence.js";
import { boundedText, DiscoveryInputError, normalizePolishNip, validateBundle, type DiscoveryEvidenceBundle } from "./discovery.js";
import { isRecord, normalizeSourceUrl } from "./search.js";
import type { DirectoryEntry } from "./directory.js";

export interface AgentClaimAssessment {
  requirementKey: string;
  outcome: "match" | "mismatch" | "unknown";
  sourceId?: string;
  quotation?: string;
}

export interface AgentCandidateAssessment {
  company: { name: string; officialDomain: string; publicOrganizationId?: string };
  identity: { sourceId: string; quotation: string; organizationIdQuotation?: string };
  claims: AgentClaimAssessment[];
}

export interface AgentAssessment {
  discoveryId: string;
  buyerNoticeNumber: string;
  candidates: AgentCandidateAssessment[];
}

export interface AssessedDiscovery {
  result: DiscoveryResult;
  selectedBuyerNoticeNumber: string;
  assessmentOrigin: "client-agent";
}

export async function finalizeAgentAssessment(actor: ActorContext, request: SourcingRequest, bundle: DiscoveryEvidenceBundle,
  assessment: unknown, options: { now?: () => Date } = {}): Promise<AssessedDiscovery> {
  // Snapshot before validation yields; later caller mutation must not change authority or claims.
  actor = structuredClone(actor);
  request = structuredClone(request);
  bundle = structuredClone(bundle);
  try { assessment = structuredClone(assessment); } catch { invalidAssessment(); }
  const now = (options.now ?? (() => new Date()))();
  await validateBundle(actor, request, bundle, now);
  if (bundle.phase !== "awaiting_agent_assessment") throw new DiscoveryInputError("INVALID_ASSESSMENT", "Cannot assess a failed collection");
  if (!shape(assessment, ["discoveryId", "buyerNoticeNumber", "candidates"]) || assessment.discoveryId !== bundle.id || assessment.buyerNoticeNumber !== bundle.selectedBuyerNoticeNumber ||
      !Array.isArray(assessment.candidates) || assessment.candidates.length > 5) invalidAssessment();
  const candidates: Candidate[] = [];
  const sourceErrors = structuredClone(bundle.sourceErrors);
  const identities = new Set<string>();
  for (const raw of assessment.candidates) {
    if (!shape(raw, ["company", "identity", "claims"]) || !shape(raw.company, ["name", "officialDomain", "publicOrganizationId"]) ||
        !boundedText(raw.company.name, 300) || !boundedText(raw.company.officialDomain, 253) ||
        !shape(raw.identity, ["sourceId", "quotation", "organizationIdQuotation"]) ||
        !boundedText(raw.identity.sourceId, 100) || !boundedText(raw.identity.quotation, 4000) ||
        !Array.isArray(raw.claims) || raw.claims.length > 100) invalidAssessment();
    let domain: string;
    try {
      if (/[\s/:@?#]/.test(raw.company.officialDomain)) invalidAssessment();
      domain = new URL(normalizeSourceUrl(`https://${raw.company.officialDomain}`)).hostname.replace(/^www\./, "");
    } catch { invalidAssessment(); }
    const identitySourceId = raw.identity.sourceId;
    const identitySource = bundle.sources.find((source) => source.id === identitySourceId);
    const companyName = raw.company.name.trim();
    if (!identitySource || !onDomain(identitySource.url, domain) || !identitySource.text.includes(raw.identity.quotation) ||
        !raw.identity.quotation.normalize("NFC").toLowerCase().includes(companyName.normalize("NFC").toLowerCase())) invalidAssessment();
    const publicId = raw.company.publicOrganizationId;
    if (publicId !== undefined && (!boundedText(publicId, 200) || !boundedText(raw.identity.organizationIdQuotation, 4000) ||
        !identitySource.text.includes(raw.identity.organizationIdQuotation) || !raw.identity.organizationIdQuotation.includes(publicId) ||
        !raw.identity.organizationIdQuotation.toLowerCase().includes(companyName.toLowerCase()))) invalidAssessment();
    let normalizedPublicId = publicId;
    if (bundle.directoryContext) {
      normalizedPublicId = publicId === undefined ? undefined : normalizePolishNip(publicId) ?? undefined;
      if (!normalizedPublicId || !raw.identity.organizationIdQuotation || !hasUniqueAwardIdentity(bundle.directoryContext.suppliers, normalizedPublicId)) invalidAssessment();
    }
    if (identities.has(domain)) invalidAssessment();
    identities.add(domain);
    const candidate: Candidate = { company: { name: companyName, officialDomain: domain,
      ...(normalizedPublicId !== undefined ? { publicOrganizationId: normalizedPublicId } : {}) }, claims: [] };
    for (const claim of raw.claims) {
      if (!shape(claim, ["requirementKey", "outcome", "sourceId", "quotation"]) || !boundedText(claim.requirementKey, 100) ||
          !["match", "mismatch", "unknown"].includes(claim.outcome as string)) invalidAssessment();
      const requirement = request.requirements.find((r) => r.key === claim.requirementKey);
      if (!requirement) invalidAssessment();
      if (claim.outcome === "unknown") {
        if (claim.sourceId !== undefined || claim.quotation !== undefined) invalidAssessment();
        candidate.claims.push({ requirementKey: claim.requirementKey, outcome: "unknown" });
        continue;
      }
      if (!boundedText(claim.sourceId, 100) || !boundedText(claim.quotation, 4000)) invalidAssessment();
      const source = bundle.sources.find((entry) => entry.id === claim.sourceId);
      if (!source || !onDomain(source.url, domain) || !source.text.includes(claim.quotation) ||
          !standardsSupported(requirement.description, claim.quotation, claim.outcome === "match")) {
        candidate.claims.push({ requirementKey: claim.requirementKey, outcome: "unknown" });
        sourceErrors.push({ url: source?.url ?? identitySource.url, message: "Agent claim lacked bound quotation or required standard evidence" });
        continue;
      }
      candidate.claims.push({ requirementKey: claim.requirementKey, outcome: claim.outcome as "match" | "mismatch",
        evidence: { url: source.url, retrievedAt: source.retrievedAt, contentHash: source.contentHash, quotation: claim.quotation } });
    }
    candidates.push(candidate);
  }
  // These identities are client interpretations with literal official-domain source support,
  // not verified legal representation. Semantic truth remains the client agent's responsibility.
  const ranker = new EvidenceRanker({ requestId: request.id, startedAt: bundle.startedAt, completedAt: bundle.completedAt,
    sources: bundle.sources, companies: candidates.map((candidate) => candidate.company) }, { now: () => now });
  return { selectedBuyerNoticeNumber: bundle.selectedBuyerNoticeNumber, assessmentOrigin: "client-agent",
    result: { id: bundle.id, requestId: request.id, status: "complete", candidates: ranker.rankEvidence(request, candidates), sourceErrors } };
}

function hasUniqueAwardIdentity(suppliers: DirectoryEntry[], publicId: string): boolean {
  // TED's country-specific winner identifier is the public cross-reference; candidate sites must
  // independently quote the same identifier on their official domain before ranking/resolution.
  const records = suppliers.filter((entry) => entry.company.publicOrganizationId !== null &&
    entry.company.country === "POL" && normalizePolishNip(entry.company.publicOrganizationId) === publicId);
  const names = new Set(records.map((entry) => entry.company.name.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase()));
  return records.length > 0 && names.size === 1;
}

function invalidAssessment(): never {
  throw new DiscoveryInputError("INVALID_ASSESSMENT", "Invalid agent assessment or unsupported source identity");
}

function shape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
}

function onDomain(url: string, domain: string): boolean {
  const hostname = new URL(url).hostname.replace(/^www\./, "");
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** MVP_LIMIT: literal ISO/EN/DIN standard and edition support, not semantic or certificate validation.
 * An agent must keep alternatives/complex technical equivalence unknown unless explicitly sourced.
 */
function standardsSupported(requirement: string, quotation: string, match: boolean): boolean {
  // MVP_LIMIT: amendment suffixes need a richer standard parser; keep them unknown.
  if (/\b(?:ISO|EN|DIN)(?:[ -]+(?:ISO|EN|DIN))*[ -]+\d+(?:[-:]\d+)*\s*\+/i.test(requirement)) return false;
  if (/\b(?:AMD|AMENDMENT|AMENDED|COR|CORRIGENDUM|CORRIGENDA|REV|REVISION|AC|A\d+)\b/i.test(requirement)) return false;
  const standards = requirement.match(/\b(?:ISO|EN|DIN)(?:[ -]+(?:ISO|EN|DIN))*[ -]+\d+(?:[-:]\d+)*/gi) ?? [];
  const normalize = (value: string) => value.toUpperCase().replace(/[ -]+/g, " ");
  const quoted = normalize(quotation);
  return standards.every((standard) => {
    const expected = normalize(match ? standard : standard.replace(/:\d+$/, ""));
    let index = quoted.indexOf(expected);
    while (index !== -1) {
      if ((index === 0 || !/[A-Z0-9]/.test(quoted[index - 1]!)) && !(match ? /[A-Z0-9:+-]/ : /[A-Z0-9+-]/).test(quoted[index + expected.length] ?? "")) return true;
      index = quoted.indexOf(expected, index + 1);
    }
    return false;
  });
}
