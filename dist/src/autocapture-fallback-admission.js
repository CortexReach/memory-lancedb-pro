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
import { resolveToolMemoryCategory } from "./memory-categories.js";
/**
 * Gate one regex-fallback capture through admission control.
 *
 * - No controller (admission disabled, or smart extraction off so no
 *   controller instance exists to borrow): passthrough, identical to the
 *   historical behavior.
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
export async function gateRegexFallbackCapture(params) {
    if (!params.admissionController) {
        return { admit: true };
    }
    const { memoryCategory } = resolveToolMemoryCategory(params.storeCategory);
    let evaluation;
    try {
        evaluation = await params.admissionController.evaluate({
            candidate: {
                category: memoryCategory,
                abstract: params.text,
                overview: `- ${params.text}`,
                content: params.text,
            },
            candidateVector: params.vector,
            conversationText: params.conversationText,
            scopeFilter: params.scopeFilter,
        });
    }
    catch (err) {
        const reason = "admission evaluation failed open";
        params.warnLog?.(`memory-lancedb-pro: regex-fallback admission evaluation failed, admitting without audit: ${String(err)}`);
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
        return { admit: false, reason: evaluation.audit.reason };
    }
    return {
        admit: true,
        auditJson: params.attachAudit
            ? JSON.stringify({ ...evaluation.audit, provenance: "auto-capture-regex-fallback" })
            : undefined,
    };
}
