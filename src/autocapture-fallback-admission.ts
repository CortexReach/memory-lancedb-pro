/**
 * Admission gating for the auto-capture regex fallback.
 *
 * The agent_end auto-capture hook falls back to legacy regex-triggered
 * capture when the smart extractor does not handle a turn. That path stores
 * matching texts verbatim (l0/l1/l2 all the raw message), bypassing the
 * grounding filter and admission control entirely. This module routes each
 * fallback capture through the same AdmissionController evaluation extraction
 * candidates get, while preserving passthrough behavior when admission
 * control is disabled.
 */

import type { AdmissionAuditRecord, AdmissionEvaluation } from "./admission-control.js";
import { resolveToolMemoryCategory } from "./memory-categories.js";

export interface FallbackAdmissionGate {
  evaluate(params: {
    candidate: import("./memory-categories.js").CandidateMemory;
    candidateVector: number[];
    conversationText: string;
    scopeFilter: string[];
  }): Promise<AdmissionEvaluation>;
}

export interface FallbackGateResult {
  admit: boolean;
  reason?: string;
  /** Serialized audit (with provenance) to persist in the row's metadata. */
  auditJson?: string;
  /** Full audit record for a rejection, so callers can persist rejected audits. */
  rejectedAudit?: AdmissionAuditRecord & { decision: "reject" };
}

/**
 * The candidate shape a regex-fallback capture is scored under: the legacy
 * store category mapped onto its smart register. Shared with callers that
 * persist rejection audits so both sides describe the same candidate.
 */
export function buildFallbackCandidate(
  text: string,
  storeCategory: string,
): import("./memory-categories.js").CandidateMemory {
  const { memoryCategory } = resolveToolMemoryCategory(storeCategory);
  return {
    category: memoryCategory,
    abstract: text,
    overview: `- ${text}`,
    content: text,
  };
}

/**
 * Gate one regex-fallback capture through admission control.
 *
 * - No controller with admission NOT required (admission disabled): passthrough,
 *   identical to the historical behavior.
 * - No controller with admission REQUIRED (enabled in config but construction
 *   failed): fail closed. A standing init failure would otherwise silently
 *   restore the ungated bypass this module exists to close — unlike the
 *   transient per-candidate evaluation error below, which fails open with
 *   durable provenance on the single affected row.
 * - Controller reject: the capture is dropped; the caller logs the reason.
 * - Controller pass: the capture proceeds; when `attachAudit` is set the
 *   audit record (tagged with provenance "auto-capture-regex-fallback") is
 *   returned for persistence alongside the row.
 * - Infra failure inside evaluation: fail open with a reason, so a transient
 *   store/LLM error cannot silently suppress capture.
 *
 * The fallback classifies texts into legacy store categories
 * (preference/fact/decision/entity/other); admission typePriors are keyed by
 * the six smart registers, so the candidate is scored under the smart
 * register the legacy category maps to.
 */
export async function gateRegexFallbackCapture(params: {
  admissionController: FallbackAdmissionGate | null;
  /** True when admissionControl.enabled is set: a missing controller then means init failed, not "disabled". */
  admissionRequired?: boolean;
  attachAudit: boolean;
  text: string;
  storeCategory: string;
  vector: number[];
  conversationText: string;
  scopeFilter: string[];
  warnLog?: (msg: string) => void;
}): Promise<FallbackGateResult> {
  if (!params.admissionController) {
    if (params.admissionRequired) {
      const reason = "admission control is enabled but no controller is available (initialization failed); failing closed";
      params.warnLog?.(`memory-lancedb-pro: regex-fallback capture rejected: ${reason}`);
      return { admit: false, reason };
    }
    return { admit: true };
  }

  let evaluation: AdmissionEvaluation;
  try {
    evaluation = await params.admissionController.evaluate({
      candidate: buildFallbackCandidate(params.text, params.storeCategory),
      candidateVector: params.vector,
      conversationText: params.conversationText,
      scopeFilter: params.scopeFilter,
    });
  } catch (err) {
    const reason = "admission evaluation failed open";
    params.warnLog?.(
      `memory-lancedb-pro: regex-fallback admission evaluation failed, admitting without audit: ${String(err)}`,
    );
    return {
      admit: true,
      reason,
      // Fail-open admits still need durable, queryable provenance on the row itself
      // (not just an ephemeral log line): otherwise this row is indistinguishable
      // from a normally-scored admit once persisted.
      auditJson: params.attachAudit
        ? JSON.stringify({
            provenance: "auto-capture-regex-fallback",
            failedOpen: true,
            reason,
            error: String(err),
          })
        : undefined,
    };
  }

  if (evaluation.decision === "reject") {
    return {
      admit: false,
      reason: evaluation.audit.reason,
      rejectedAudit: evaluation.audit as AdmissionAuditRecord & { decision: "reject" },
    };
  }

  return {
    admit: true,
    auditJson: params.attachAudit
      ? JSON.stringify({ ...evaluation.audit, provenance: "auto-capture-regex-fallback" })
      : undefined,
  };
}
