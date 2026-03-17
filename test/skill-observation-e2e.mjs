/**
 * Skill Observation End-to-End Test
 *
 * Tests the full chain:
 *   1. storeSkillObservation() — write observations
 *   2. inspectSkill() / getSkillHealth() — aggregate and query
 *   3. checkSkillAlert() — trigger alerts from accumulated failures
 *   4. suggestion write + getPendingSuggestions() — pending alert lifecycle
 *   5. getSkillHistory() — chronological listing
 *   6. generateSkillEvidence() — evidence pack generation
 *
 * Uses real LanceDB + deterministic mock embedder (no external API calls).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

// Deterministic 4-dim embedder: encodes skill/outcome keywords into vector positions
function makeMockEmbedder() {
  const toVector = (text) => {
    const s = String(text || "").toLowerCase();
    return [
      s.includes("tdd") ? 1 : 0,
      s.includes("failure") || s.includes("error") ? 1 : 0,
      s.includes("success") ? 1 : 0,
      s.includes("review") ? 1 : 0,
    ];
  };
  return {
    async embed(text) { return toVector(text); },
    async embedQuery(text) { return toVector(text); },
    async embedPassage(text) { return toVector(text); },
    async embedBatchPassage(texts) { return texts.map(toVector); },
    async test() { return { success: true, dimensions: 4 }; },
  };
}

async function runTests() {
  const workDir = mkdtempSync(path.join(tmpdir(), "skill-obs-e2e-"));

  try {
    const { MemoryStore } = jiti("../src/store.ts");
    const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");
    const { storeSkillObservation, buildObservationText } = jiti("../src/skill-observe.ts");
    const { inspectSkill, getSkillHealth, getSkillHistory } = jiti("../src/skill-inspect.ts");
    const { checkSkillAlert, getPendingSuggestions } = jiti("../src/skill-alert.ts");
    const { generateSkillEvidence } = jiti("../src/skill-evidence.ts");
    const { stringifySmartMetadata } = jiti("../src/smart-metadata.ts");

    const embedder = makeMockEmbedder();
    const store = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: 4 });
    const retriever = createRetriever(store, embedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      rerank: "none",
      mode: "vector",
    });

    // =====================================================================
    // Test 1: Store skill observations
    // =====================================================================
    console.log("Test 1: storeSkillObservation — write observations...");

    // 3 successes for tdd-workflow
    for (let i = 0; i < 3; i++) {
      await storeSkillObservation(store, embedder, {
        skill_id: "tdd-workflow",
        outcome: "success",
        text: `skill 'tdd-workflow' execution: success. Tests generated correctly (#${i + 1}).`,
        scope: "global",
      });
    }

    // 4 failures for tdd-workflow
    for (let i = 0; i < 4; i++) {
      await storeSkillObservation(store, embedder, {
        skill_id: "tdd-workflow",
        outcome: "failure",
        outcome_signal: "error",
        text: `skill 'tdd-workflow' execution: failure. Test structure mismatch (#${i + 1}).`,
        error_chain: ["jest: test structure mismatch", "fixture setup failed"],
        user_corrections: ["use project's existing test conventions"],
        scope: "global",
      });
    }

    // 2 successes for code-review
    for (let i = 0; i < 2; i++) {
      await storeSkillObservation(store, embedder, {
        skill_id: "code-review",
        outcome: "success",
        text: `skill 'code-review' execution: success. Review completed (#${i + 1}).`,
        scope: "global",
      });
    }

    // 1 failure for code-review with similar error to tdd-workflow
    await storeSkillObservation(store, embedder, {
      skill_id: "code-review",
      outcome: "failure",
      outcome_signal: "error",
      text: `skill 'code-review' execution: failure. Test structure mismatch in review.`,
      error_chain: ["jest: test structure mismatch"],
      scope: "global",
    });

    // Verify: should have 10 total entries
    const allEntries = await store.list(["global"], "other", 100, 0);
    assert.ok(allEntries.length >= 10, `Expected >= 10 observations, got ${allEntries.length}`);
    console.log("  ✅ Stored 10 observations (7 tdd-workflow + 3 code-review)");

    // =====================================================================
    // Test 2: inspectSkill — single skill report
    // =====================================================================
    console.log("Test 2: inspectSkill — single skill report...");

    const tddReport = await inspectSkill(store, retriever, "tdd-workflow", {
      days: 365,
      scopeFilter: ["global"],
    });

    assert.equal(tddReport.skill_id, "tdd-workflow");
    assert.equal(tddReport.total_observations, 7);
    // 3 success out of 7 = ~43%
    assert.ok(tddReport.success_rate < 0.5, `Expected < 50% rate, got ${tddReport.success_rate}`);
    assert.ok(tddReport.top_failures.length > 0, "Expected at least one failure pattern");
    assert.ok(
      tddReport.time_windows.all_time.observations === 7,
      `Expected 7 all_time obs, got ${tddReport.time_windows.all_time.observations}`,
    );
    console.log(`  ✅ tdd-workflow: ${tddReport.total_observations} obs, ${(tddReport.success_rate * 100).toFixed(0)}% rate, ${tddReport.top_failures.length} failure pattern(s)`);

    // =====================================================================
    // Test 3: getSkillHealth — global dashboard
    // =====================================================================
    console.log("Test 3: getSkillHealth — global dashboard...");

    const dashboard = await getSkillHealth(store, retriever, { scopeFilter: ["global"] });

    assert.equal(dashboard.summary.total_skills, 2);
    assert.ok(dashboard.skills.length === 2);

    const tddSkill = dashboard.skills.find((s) => s.id === "tdd-workflow");
    assert.ok(tddSkill, "tdd-workflow should appear in dashboard");
    assert.ok(
      tddSkill.status === "critical" || tddSkill.status === "degraded",
      `Expected critical or degraded, got ${tddSkill.status}`,
    );

    const reviewSkill = dashboard.skills.find((s) => s.id === "code-review");
    assert.ok(reviewSkill, "code-review should appear in dashboard");

    // Systemic issues: "test structure mismatch" appears in both skills
    // (depends on error_chain matching, may or may not fire with mock embedder)
    console.log(`  ✅ Dashboard: ${dashboard.summary.total_skills} skills, ${dashboard.summary.healthy} healthy, ${dashboard.summary.degraded} degraded, ${dashboard.summary.critical} critical`);
    if (dashboard.systemic_issues.length > 0) {
      console.log(`  ✅ Systemic issues detected: ${dashboard.systemic_issues.map((i) => i.pattern).join(", ")}`);
    }

    // =====================================================================
    // Test 4: checkSkillAlert — trigger alert for tdd-workflow
    // =====================================================================
    console.log("Test 4: checkSkillAlert — trigger alert...");

    const alert = await checkSkillAlert(store, "tdd-workflow", ["global"], {
      minObservations: 5,
      successRateWarn: 0.7,
      successRateCritical: 0.5,
      cooldownDays: 7,
      alertThreshold: "warn",
    });

    assert.ok(alert !== null, "Expected alert to trigger for tdd-workflow (43% rate < 50% critical)");
    assert.equal(alert.priority, "critical");
    assert.ok(alert.message.includes("tdd-workflow"), "Alert message should mention skill name");
    assert.ok(alert.evidenceSummary.length > 0, "Evidence summary should be non-empty");
    console.log(`  ✅ Alert triggered: ${alert.priority} — ${alert.message.slice(0, 80)}...`);

    // No alert for code-review (only 3 observations, below minObservations=5)
    const noAlert = await checkSkillAlert(store, "code-review", ["global"], {
      minObservations: 5,
    });
    assert.equal(noAlert, null, "code-review should not trigger alert (< 5 observations)");
    console.log("  ✅ No alert for code-review (below minObservations threshold)");

    // =====================================================================
    // Test 5: Suggestion write + getPendingSuggestions
    // =====================================================================
    console.log("Test 5: suggestion lifecycle — write + read + acknowledge...");

    // Write a suggestion (simulating what agent_end hook does)
    const suggestionVector = await embedder.embed("tdd-workflow needs attention");
    await store.store({
      text: "tdd-workflow success rate is only 43%. Main failure: test structure mismatch.",
      vector: suggestionVector,
      category: "other",
      importance: 0.9,
      scope: "global",
      metadata: stringifySmartMetadata({
        skill_obs_type: "suggestion",
        skill_id: "tdd-workflow",
        priority: "critical",
        evidence_summary: "7 observations, 43% success rate",
        suggested_actions: ["Fix test structure mismatch"],
        acknowledged: false,
      }),
    });

    // Read pending suggestions
    const pending = await getPendingSuggestions(store, ["global"]);
    assert.ok(pending.length >= 1, `Expected >= 1 pending suggestion, got ${pending.length}`);
    const tddSuggestion = pending.find((p) => p.meta.skill_id === "tdd-workflow");
    assert.ok(tddSuggestion, "Should find tdd-workflow suggestion");
    assert.equal(tddSuggestion.meta.acknowledged, false);
    console.log(`  ✅ Found ${pending.length} pending suggestion(s)`);

    // Acknowledge it
    await store.patchMetadata(tddSuggestion.id, { acknowledged: true }, ["global"]);
    const afterAck = await getPendingSuggestions(store, ["global"]);
    const stillPending = afterAck.filter((p) => p.meta.skill_id === "tdd-workflow");
    assert.equal(stillPending.length, 0, "Acknowledged suggestion should not appear as pending");
    console.log("  ✅ Acknowledged suggestion no longer appears as pending");

    // =====================================================================
    // Test 6: Cooldown — alert should not re-trigger after suggestion exists
    // =====================================================================
    console.log("Test 6: cooldown — no re-alert within cooldown window...");

    const alertAfterSuggestion = await checkSkillAlert(store, "tdd-workflow", ["global"], {
      minObservations: 5,
      successRateCritical: 0.5,
      cooldownDays: 7,
    });
    assert.equal(alertAfterSuggestion, null, "Should not re-alert within cooldown period");
    console.log("  ✅ Cooldown prevents re-alerting (suggestion timestamp within 7 days)");

    // =====================================================================
    // Test 7: getSkillHistory — chronological listing
    // =====================================================================
    console.log("Test 7: getSkillHistory — chronological listing...");

    const history = await getSkillHistory(store, "tdd-workflow", { limit: 5 });
    assert.ok(history.length > 0, "History should have entries");
    assert.ok(history.length <= 5, "Should respect limit");
    assert.equal(history[0].skill_id, "tdd-workflow");
    assert.ok(
      ["success", "partial", "failure"].includes(history[0].outcome),
      `Unexpected outcome: ${history[0].outcome}`,
    );
    // Verify descending order (most recent first)
    for (let i = 1; i < history.length; i++) {
      assert.ok(
        history[i - 1].timestamp >= history[i].timestamp,
        "History should be sorted by timestamp descending",
      );
    }
    console.log(`  ✅ History: ${history.length} entries, most recent: ${history[0].date} ${history[0].outcome}`);

    // =====================================================================
    // Test 8: generateSkillEvidence — evidence pack
    // =====================================================================
    console.log("Test 8: generateSkillEvidence — evidence pack...");

    const evidence = await generateSkillEvidence(store, retriever, "tdd-workflow", ["global"]);

    assert.equal(evidence.skill_id, "tdd-workflow");
    assert.ok(evidence.evidence.time_windows.all_time.observations >= 7);
    assert.ok(evidence.evidence.failure_clusters.length > 0, "Should have failure clusters");
    assert.ok(evidence.suggested_actions.length > 0, "Should have suggested actions");

    const topCluster = evidence.evidence.failure_clusters[0];
    assert.ok(topCluster.frequency >= 1, "Top cluster should have frequency >= 1");
    console.log(`  ✅ Evidence pack: ${evidence.evidence.failure_clusters.length} cluster(s), ${evidence.suggested_actions.length} suggestion(s)`);
    console.log(`     Top cluster: "${topCluster.pattern}" (${topCluster.frequency}x)`);

    // =====================================================================
    // Test 9: buildObservationText — text generation
    // =====================================================================
    console.log("Test 9: buildObservationText — text formatting...");

    const obsText = buildObservationText(
      "tdd-workflow",
      "failure",
      ["user said: use existing test structure"],
      [{ toolName: "jest", error: "structure mismatch" }],
    );
    assert.ok(obsText.includes("tdd-workflow"), "Should mention skill name");
    assert.ok(obsText.includes("failure"), "Should mention outcome");
    assert.ok(obsText.includes("jest"), "Should include tool error");
    assert.ok(obsText.includes("user said"), "Should include user correction");
    console.log(`  ✅ Observation text: "${obsText.slice(0, 80)}..."`);

    // =====================================================================
    // Test 10: Scope isolation — different scope should not see observations
    // =====================================================================
    console.log("Test 10: scope isolation...");

    await storeSkillObservation(store, embedder, {
      skill_id: "isolated-skill",
      outcome: "failure",
      text: "skill 'isolated-skill' failure in project-a scope",
      scope: "project:a",
    });

    const globalHealth = await getSkillHealth(store, retriever, { scopeFilter: ["global"] });
    const hasIsolated = globalHealth.skills.some((s) => s.id === "isolated-skill");
    assert.ok(!hasIsolated, "project:a skill should not appear in global scope dashboard");
    console.log("  ✅ Scope isolation: project:a observation not visible in global scope");

    console.log("\n=== All Skill Observation E2E tests passed! ===");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error("Skill Observation E2E test failed:", err);
  process.exit(1);
});
