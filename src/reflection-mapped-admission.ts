/**
 * Admission gating for reflection writer-1 (mapped rows).
 *
 * The reflection distiller's mapped sections (User model deltas, Agent model
 * deltas, Lessons & pitfalls, Decisions) become ordinary durable memory rows
 * via bulkStore. Historically they bypassed admission control entirely, so a
 * contaminated or hallucinated distillate line landed as a confirmed memory
 * with no gate and no audit trail. This module routes each mapped row through
 * the same AdmissionController evaluation extraction candidates get, while
 * preserving passthrough behavior when admission control is disabled.
 */

import type { AdmissionEvaluation } from "./admission-control.js";
import type { CandidateMemory, MemoryCategory } from "./memory-categories.js";

/**
 * Admission typePriors are keyed by the six smart registers, but mapped rows
 * carry legacy store categories. Score them under the smart register that
 * matches their shape: user-model/agent-model deltas are preference-shaped
 * statements about the human or the assistant ("preference"), lessons are
 * symptom/cause/fix/prevention pairs ("fact" here, cases-shaped), and
 * decisions are episodic records of something decided ("events").
 */
export function mapReflectionMappedCategoryToSmartRegister(
  category: string,
): MemoryCategory {
  switch (category) {
    case "preference":
      return "preferences";
    case "fact":
      return "cases";
    case "decision":
      return "events";
    default:
      return "events";
  }
}

export interface MappedReflectionAdmissionGate {
  evaluate(params: {
    candidate: CandidateMemory;
    candidateVector: number[];
    conversationText: string;
    scopeFilter: string[];
  }): Promise<AdmissionEvaluation>;
}

export interface MappedReflectionGateResult {
  admit: boolean;
  reason?: string;
  /** Serialized audit (with provenance) to persist in the row's metadata. */
  auditJson?: string;
}

/**
 * Gate one mapped reflection row through admission control.
 *
 * - No controller (admission disabled or smart extraction off): passthrough,
 *   identical to the historical behavior.
 * - Controller reject: the row is dropped; the caller logs the reason.
 * - Controller pass: the row proceeds; when `attachAudit` is set the audit
 *   record (tagged with provenance "memory-reflection-mapped") is returned
 *   for persistence alongside the row.
 * - Infra failure inside evaluation: fail open with a reason, so a transient
 *   store/LLM error cannot silently suppress reflection persistence.
 */
export async function gateMappedReflectionEntry(params: {
  admissionController: MappedReflectionAdmissionGate | null;
  attachAudit: boolean;
  text: string;
  category: string;
  heading: string;
  vector: number[];
  reflectionText: string;
  scopeFilter: string[];
  warnLog?: (msg: string) => void;
}): Promise<MappedReflectionGateResult> {
  if (!params.admissionController) {
    return { admit: true };
  }

  const smartCategory = mapReflectionMappedCategoryToSmartRegister(params.category);
  let evaluation: AdmissionEvaluation;
  try {
    evaluation = await params.admissionController.evaluate({
      candidate: {
        category: smartCategory,
        abstract: params.text,
        overview: `## ${params.heading}`,
        content: params.text,
      },
      candidateVector: params.vector,
      conversationText: params.reflectionText,
      scopeFilter: params.scopeFilter,
    });
  } catch (err) {
    params.warnLog?.(
      `memory-reflection: mapped-row admission evaluation failed, admitting without audit: ${String(err)}`,
    );
    return { admit: true, reason: "admission evaluation failed open" };
  }

  if (evaluation.decision === "reject") {
    return { admit: false, reason: evaluation.audit.reason };
  }

  return {
    admit: true,
    auditJson: params.attachAudit
      ? JSON.stringify({ ...evaluation.audit, provenance: "memory-reflection-mapped" })
      : undefined,
  };
}
