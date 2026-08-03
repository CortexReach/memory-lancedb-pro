import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { resolveAdmissionModel, normalizeAdmissionControlConfig } = jiti("../src/admission-control.ts");

describe("resolveAdmissionModel", () => {
  it("defaults to the global model for both lanes when modelAffinity is absent", () => {
    const admissionControl = normalizeAdmissionControlConfig({ enabled: true });

    const other = resolveAdmissionModel({
      admissionControl,
      lane: "other",
      globalModel: "global-model",
      reflectionModel: "reflection-model",
    });
    const reflection = resolveAdmissionModel({
      admissionControl,
      lane: "reflection",
      globalModel: "global-model",
      reflectionModel: "reflection-model",
    });

    assert.equal(other, "global-model");
    assert.equal(reflection, "global-model");
  });

  it("routes the reflection lane to the memoryReflection model when modelAffinity is 'lane'", () => {
    const admissionControl = normalizeAdmissionControlConfig({ enabled: true, modelAffinity: "lane" });

    const other = resolveAdmissionModel({
      admissionControl,
      lane: "other",
      globalModel: "global-model",
      reflectionModel: "reflection-model",
    });
    const reflection = resolveAdmissionModel({
      admissionControl,
      lane: "reflection",
      globalModel: "global-model",
      reflectionModel: "reflection-model",
    });

    assert.equal(other, "global-model", "extraction/fallback lane stays on the global model");
    assert.equal(reflection, "reflection-model", "reflection lane resolves to the memoryReflection model");
  });

  it("falls back to the global model on the reflection lane when no memoryReflection model is configured", () => {
    const admissionControl = normalizeAdmissionControlConfig({ enabled: true, modelAffinity: "lane" });

    const reflection = resolveAdmissionModel({
      admissionControl,
      lane: "reflection",
      globalModel: "global-model",
      reflectionModel: undefined,
    });

    assert.equal(reflection, "global-model");
  });

  it("lets an explicit admissionControl.model override beat lane affinity on both lanes", () => {
    const admissionControl = normalizeAdmissionControlConfig({
      enabled: true,
      modelAffinity: "lane",
      model: "explicit-override-model",
    });

    const other = resolveAdmissionModel({
      admissionControl,
      lane: "other",
      globalModel: "global-model",
      reflectionModel: "reflection-model",
    });
    const reflection = resolveAdmissionModel({
      admissionControl,
      lane: "reflection",
      globalModel: "global-model",
      reflectionModel: "reflection-model",
    });

    assert.equal(other, "explicit-override-model");
    assert.equal(reflection, "explicit-override-model");
  });

  // Live-fleet bug: memoryReflection.model is core-style provider-prefixed
  // ("openrouter/anthropic/claude-opus-4-8", understood by the reflection
  // distiller's embedded runner) but the admission-control LLM client talks
  // directly to OpenRouter, which needs the bare "anthropic/claude-opus-4-8"
  // form. Every reflection-lane admission call 400'd against the real fleet.
  it("normalizes a core-style openrouter/<vendor>/<model> reflection model to the bare <vendor>/<model> form the OpenRouter-direct client needs", () => {
    const admissionControl = normalizeAdmissionControlConfig({ enabled: true, modelAffinity: "lane" });

    const reflection = resolveAdmissionModel({
      admissionControl,
      lane: "reflection",
      globalModel: "global-model",
      reflectionModel: "openrouter/anthropic/claude-opus-4-8",
    });

    assert.equal(reflection, "anthropic/claude-opus-4-8");
  });

  it("passes a bare <vendor>/<model> reflection model through unchanged", () => {
    const admissionControl = normalizeAdmissionControlConfig({ enabled: true, modelAffinity: "lane" });

    const reflection = resolveAdmissionModel({
      admissionControl,
      lane: "reflection",
      globalModel: "global-model",
      reflectionModel: "anthropic/claude-opus-4-8",
    });

    assert.equal(reflection, "anthropic/claude-opus-4-8");
  });

  it("passes an @preset/<name> reflection model through unchanged", () => {
    const admissionControl = normalizeAdmissionControlConfig({ enabled: true, modelAffinity: "lane" });

    const reflection = resolveAdmissionModel({
      admissionControl,
      lane: "reflection",
      globalModel: "global-model",
      reflectionModel: "@preset/gpt-oss-120b-gold",
    });

    assert.equal(reflection, "@preset/gpt-oss-120b-gold");
  });

  it("normalizes an explicit admissionControl.model override the same way as lane-resolved models", () => {
    const admissionControl = normalizeAdmissionControlConfig({
      enabled: true,
      modelAffinity: "lane",
      model: "openrouter/anthropic/claude-opus-4-8",
    });

    const other = resolveAdmissionModel({
      admissionControl,
      lane: "other",
      globalModel: "global-model",
      reflectionModel: "reflection-model",
    });
    const reflection = resolveAdmissionModel({
      admissionControl,
      lane: "reflection",
      globalModel: "global-model",
      reflectionModel: "reflection-model",
    });

    assert.equal(other, "anthropic/claude-opus-4-8");
    assert.equal(reflection, "anthropic/claude-opus-4-8");
  });
});
