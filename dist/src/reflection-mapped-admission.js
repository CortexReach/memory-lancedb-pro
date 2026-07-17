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
 *
 * A reflection burst (all mapped rows parsed from one distillate) is gated as
 * one unit via gateMappedReflectionEntries: when the controller exposes
 * evaluateBatch (the batched admission judge), the whole burst costs one
 * batched call per controller-side chunk instead of one standalone LLM call
 * per row; when it does not (a controller predating batch support), the gate
 * takes the historical per-row evaluate path unchanged. Per-row decisions,
 * reasons, and audit records are identical either way — only the LLM call
 * topology differs.
 */
/**
 * Admission typePriors are keyed by the six smart registers, but mapped rows
 * carry legacy store categories. Score them under the smart register that
 * matches their shape: user-model/agent-model deltas are preference-shaped
 * statements about the human or the assistant ("preference"), lessons are
 * symptom/cause/fix/prevention pairs ("fact" here, cases-shaped), and
 * decisions are episodic records of something decided ("events").
 */
export function mapReflectionMappedCategoryToSmartRegister(category) {
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
function buildGateItem(row, conversationText, scopeFilter) {
    return {
        candidate: {
            category: mapReflectionMappedCategoryToSmartRegister(row.category),
            abstract: row.text,
            overview: `## ${row.heading}`,
            content: row.text,
        },
        candidateVector: row.vector,
        conversationText,
        scopeFilter,
    };
}
// Fail-open admits still need durable, queryable provenance on the row itself
// (not just an ephemeral log line): otherwise this row is indistinguishable
// from a normally-scored admit once persisted.
function buildFailOpenResult(attachAudit, err) {
    const reason = "admission evaluation failed open";
    return {
        admit: true,
        reason,
        auditJson: attachAudit
            ? JSON.stringify({
                provenance: "memory-reflection-mapped",
                failedOpen: true,
                reason,
                error: String(err),
            })
            : undefined,
    };
}
function buildGateResult(evaluation, attachAudit) {
    if (evaluation.decision === "reject") {
        return { admit: false, reason: evaluation.audit.reason };
    }
    return {
        admit: true,
        auditJson: attachAudit
            ? JSON.stringify({ ...evaluation.audit, provenance: "memory-reflection-mapped" })
            : undefined,
    };
}
/**
 * Gate one reflection burst (every mapped row from one distillate) through
 * admission control, returning one result per row in input order.
 *
 * - No controller (admission disabled or smart extraction off): passthrough,
 *   identical to the historical behavior.
 * - Controller with evaluateBatch: the entire burst is judged in one
 *   evaluateBatch call (the controller chunks internally and honors
 *   utilityMode, so a non-batch mode still scores per candidate). A failure
 *   of the batch call itself — or a malformed (wrong-length) result — fails
 *   open for every row in the burst, mirroring the per-row fail-open path.
 * - Controller without evaluateBatch: one evaluate() call per row with the
 *   original per-row fail-open semantics, byte-identical to the historical
 *   single-row gate.
 * - Controller reject: that row is dropped; the caller logs the reason.
 * - Controller pass: the row proceeds; when `attachAudit` is set the audit
 *   record (tagged with provenance "memory-reflection-mapped") is returned
 *   for persistence alongside the row.
 */
export async function gateMappedReflectionEntries(params) {
    const { admissionController, rows } = params;
    if (rows.length === 0) {
        return [];
    }
    if (!admissionController) {
        return rows.map(() => ({ admit: true }));
    }
    const items = rows.map((row) => buildGateItem(row, params.conversationText, params.scopeFilter));
    if (typeof admissionController.evaluateBatch === "function") {
        let evaluations;
        try {
            evaluations = await admissionController.evaluateBatch(items);
            if (!Array.isArray(evaluations) || evaluations.length !== rows.length) {
                throw new Error(`evaluateBatch returned ${Array.isArray(evaluations) ? evaluations.length : typeof evaluations} evaluations for ${rows.length} rows`);
            }
        }
        catch (err) {
            params.warnLog?.(`memory-reflection: mapped-row batch admission evaluation failed, admitting burst without scores: ${String(err)}`);
            return rows.map(() => buildFailOpenResult(params.attachAudit, err));
        }
        return evaluations.map((evaluation) => buildGateResult(evaluation, params.attachAudit));
    }
    const results = [];
    for (const item of items) {
        let evaluation;
        try {
            evaluation = await admissionController.evaluate(item);
        }
        catch (err) {
            params.warnLog?.(`memory-reflection: mapped-row admission evaluation failed, admitting without audit: ${String(err)}`);
            results.push(buildFailOpenResult(params.attachAudit, err));
            continue;
        }
        results.push(buildGateResult(evaluation, params.attachAudit));
    }
    return results;
}
/**
 * Gate one mapped reflection row through admission control. Single-row
 * convenience wrapper over gateMappedReflectionEntries — same decisions,
 * reasons, and audit records; a burst caller should prefer the plural form so
 * the whole burst shares one batched admission call.
 */
export async function gateMappedReflectionEntry(params) {
    const [result] = await gateMappedReflectionEntries({
        admissionController: params.admissionController,
        attachAudit: params.attachAudit,
        rows: [
            {
                text: params.text,
                category: params.category,
                heading: params.heading,
                vector: params.vector,
            },
        ],
        conversationText: params.conversationText,
        scopeFilter: params.scopeFilter,
        warnLog: params.warnLog,
    });
    return result;
}
