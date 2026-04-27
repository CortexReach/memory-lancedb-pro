/**
 * 單元測試：PR #618 F1 修復 - inferProviderFromBaseURL
 * 測試場景：bare model name + baseURL inference
 * 
 * 執行：node --test test/infer-provider-from-baseurl.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * 復刻 index.ts 的 inferProviderFromBaseURL（從實際 code 複製）
 * 修復：使用 "." + suffix 避免 fake-minimax.io 這類 subdomain 欺騙攻擊
 */
function inferProviderFromBaseURL(baseURL) {
  if (!baseURL) return undefined;

  try {
    const url = new URL(baseURL);
    const hostname = url.hostname.toLowerCase();

    // 用 "." + suffix 避免 subdomain 欺騙
    // 例如 "fake-minimax.io".endsWith("minimax.io") = true（不安全）
    // 但 "fake-minimax.io".endsWith(".minimax.io") = false（正確防護）
    if (hostname.endsWith(".minimax.io")) return "minimax-portal";
    if (hostname.endsWith(".openai.com")) return "openai";
    if (hostname.endsWith(".anthropic.com")) return "anthropic";

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 復刻 splitProviderModel
 */
function splitProviderModel(modelRef) {
  const s = modelRef?.trim();
  if (!s) return {};
  const idx = s.indexOf("/");
  if (idx > 0) {
    return { provider: s.slice(0, idx).trim(), model: s.slice(idx + 1).trim() };
  }
  return { model: s };
}

/**
 * 復刻 generateReflectionText 的 model resolution 邏輯
 */
function resolveModelConfig(cfg) {
  const modelRef = cfg?.llm?.model;
  const baseURL = cfg?.llm?.baseURL;
  const split = modelRef ? splitProviderModel(modelRef) : { provider: undefined, model: undefined };
  const provider = split.provider ?? inferProviderFromBaseURL(baseURL);
  const model = split.model;
  return { provider, model };
}

describe("inferProviderFromBaseURL（PR #618 F1 修復）", () => {

  describe("基本 URL 推斷", () => {
    it("baseURL 含 minimax.io → minimax-portal（完整 URL）", () => {
      assert.strictEqual(inferProviderFromBaseURL("https://api.minimax.io/v1"), "minimax-portal");
    });

    it("baseURL 含 minimax.io → minimax-portal（無路徑）", () => {
      assert.strictEqual(inferProviderFromBaseURL("https://api.minimax.io"), "minimax-portal");
    });

    it("baseURL 含 openai.com → openai", () => {
      assert.strictEqual(inferProviderFromBaseURL("https://api.openai.com/v1"), "openai");
    });

    it("baseURL 含 anthropic.com → anthropic", () => {
      assert.strictEqual(inferProviderFromBaseURL("https://api.anthropic.com"), "anthropic");
    });
  });

  describe("子網域欺騙防護", () => {
    it("fake-minimax.io 不應匹配（endsWith 防護）", () => {
      assert.strictEqual(inferProviderFromBaseURL("https://fake-minimax.io"), undefined);
    });

    it("minimax.io.evil.com 不應匹配", () => {
      assert.strictEqual(inferProviderFromBaseURL("https://minimax.io.evil.com"), undefined);
    });

    it("minimax.io.cn 不應匹配（不同 TLD）", () => {
      assert.strictEqual(inferProviderFromBaseURL("https://minimax.io.cn"), undefined);
    });

    it("api.minimax.io 應該匹配（子網域）", () => {
      assert.strictEqual(inferProviderFromBaseURL("https://api.minimax.io"), "minimax-portal");
    });
  });

  describe("邊界情況", () => {
    it("baseURL 為 undefined → undefined", () => {
      assert.strictEqual(inferProviderFromBaseURL(undefined), undefined);
    });

    it("baseURL 為 null → undefined", () => {
      assert.strictEqual(inferProviderFromBaseURL(null), undefined);
    });

    it("baseURL 為空字串 → undefined", () => {
      assert.strictEqual(inferProviderFromBaseURL(""), undefined);
    });

    it("無效 URL → undefined（不應 throw）", () => {
      assert.strictEqual(inferProviderFromBaseURL("not-a-url"), undefined);
    });

    it("未知 baseURL → undefined", () => {
      assert.strictEqual(inferProviderFromBaseURL("https://api.groq.com/v1"), undefined);
    });
  });

  describe("大小寫不敏感", () => {
    it("大寫 URL → 應該正確推斷", () => {
      assert.strictEqual(inferProviderFromBaseURL("HTTPS://API.MINIMAX.IO/V1"), "minimax-portal");
    });
  });
});

describe("完整 model resolution（Production Config 場景）", () => {

  it("bare model name + minimax baseURL → 正確推斷（James 實際 production config）", () => {
    const config = {
      llm: {
        model: "MiniMax-M2.5",
        baseURL: "https://api.minimax.io/v1"
      }
    };
    const result = resolveModelConfig(config);
    assert.strictEqual(result.provider, "minimax-portal", "baseURL 含 minimax.io 應推斷為 minimax-portal");
    assert.strictEqual(result.model, "MiniMax-M2.5", "model 名稱應保持不變");
  });

  it("qualified model name（有 /）→ baseURL inference 跳過", () => {
    const config = {
      llm: {
        model: "minimax-portal/MiniMax-M2.5",
        baseURL: "https://api.minimax.io/v1"
      }
    };
    const result = resolveModelConfig(config);
    assert.strictEqual(result.provider, "minimax-portal", "有 / 前綴時直接用");
    assert.strictEqual(result.model, "MiniMax-M2.5", "有 / 前綴時直接用");
  });

  it("bare name + openai baseURL → openai", () => {
    const config = {
      llm: {
        model: "gpt-4o-mini",
        baseURL: "https://api.openai.com/v1"
      }
    };
    const result = resolveModelConfig(config);
    assert.strictEqual(result.provider, "openai");
    assert.strictEqual(result.model, "gpt-4o-mini");
  });

  it("bare name + anthropic baseURL → anthropic", () => {
    const config = {
      llm: {
        model: "claude-opus-4-5",
        baseURL: "https://api.anthropic.com"
      }
    };
    const result = resolveModelConfig(config);
    assert.strictEqual(result.provider, "anthropic");
    assert.strictEqual(result.model, "claude-opus-4-5");
  });

  it("bare name + 無 baseURL → provider undefined", () => {
    const config = {
      llm: {
        model: "MiniMax-M2.5"
        // 無 baseURL
      }
    };
    const result = resolveModelConfig(config);
    assert.strictEqual(result.provider, undefined, "無 baseURL 時無法推斷 provider");
    assert.strictEqual(result.model, "MiniMax-M2.5");
  });

  it("all undefined → graceful fallback", () => {
    const result = resolveModelConfig({});
    assert.strictEqual(result.provider, undefined);
    assert.strictEqual(result.model, undefined);
  });
});

describe("resolveAgentPrimaryModelRef returns undefined → fallback to config.llm.model（rwmjhb 要求補測）", () => {
  /**
   * 模擬 resolveAgentPrimaryModelRef 回傳 undefined 的情境。
   * 這是 dc-channel plugin-scoped config 的實際情境：
   * plugin config 無 agents section → resolveAgentPrimaryModelRef 回傳 undefined
   */
  function resolveModelWithAgentFallback(resolveAgentResult, config) {
    // 復刻 index.ts 行 1212-1218 的實際邏輯
    const modelRef =
      (resolveAgentResult)
      ?? (config?.llm?.model);
    const split = modelRef ? splitProviderModel(modelRef) : { provider: undefined, model: undefined };
    const provider = split.provider ?? inferProviderFromBaseURL(config?.llm?.baseURL);
    const model = split.model;
    return { provider, model };
  }

  it("resolveAgentPrimaryModelRef 回傳 undefined → 用 config.llm.model（bare name）→ baseURL inference 補足 provider", () => {
    // dc-channel memory-lancedb-pro plugin 的 actual config
    const pluginConfig = {
      llm: {
        model: "MiniMax-M2.1",
        baseURL: "https://api.minimax.io/v1"
      }
    };

    const result = resolveModelWithAgentFallback(undefined, pluginConfig);

    assert.strictEqual(
      result.provider,
      "minimax-portal",
      "resolveAgentPrimaryModelRef 回傳 undefined 時，baseURL inference 應補足 provider"
    );
    assert.strictEqual(result.model, "MiniMax-M2.1", "model 名稱應保持不變");
  });

  it("resolveAgentPrimaryModelRef 回傳 qualified name（'provider/model'）→ 直接用，baseURL inference 不需要", () => {
    const pluginConfig = {
      llm: {
        model: "MiniMax-M2.5",
        baseURL: "https://api.minimax.io/v1"
      }
    };

    const result = resolveModelWithAgentFallback("openai/gpt-4o-mini", pluginConfig);

    assert.strictEqual(result.provider, "openai", "有 / 前綴時直接用 resolveAgent 的結果");
    assert.strictEqual(result.model, "gpt-4o-mini", "有 / 前綴時直接用 resolveAgent 的結果");
  });

  it("resolveAgentPrimaryModelRef 回傳 undefined + 無 baseURL → provider undefined（底線暴露）", () => {
    const pluginConfig = {
      llm: {
        model: "MiniMax-M2.1"
        // 有 model 但無 baseURL
      }
    };

    const result = resolveModelWithAgentFallback(undefined, pluginConfig);

    assert.strictEqual(result.provider, undefined, "無 baseURL 時無法推斷 provider，預期 undefined");
    assert.strictEqual(result.model, "MiniMax-M2.1", "model 名稱應保持不變");
    // 這是 rwmjhb F1 的原始 concerns：provider=undefined 但 model 有值
    // downstream runEmbeddedPiAgent 能否處理取決於該函式的實作
  });

  it("resolveAgentPrimaryModelRef 回傳 bare name（無 /）+ 有 baseURL → baseURL inference 補足 provider", () => {
    // 情境：resolveAgentPrimaryModelRef 有回傳值但是 bare name（不尋常但可能發生）
    const pluginConfig = {
      llm: {
        model: "claude-haiku-4",
        baseURL: "https://api.anthropic.com"
      }
    };

    const result = resolveModelWithAgentFallback("claude-haiku-4", pluginConfig);

    assert.strictEqual(result.provider, "anthropic", "baseURL inference 補足 provider");
    assert.strictEqual(result.model, "claude-haiku-4");
  });
});

describe("splitProviderModel edge cases（確保不破壞原有行為）", () => {
  it("qualified name 'openai/gpt-4o-mini'", () => {
    const r = splitProviderModel("openai/gpt-4o-mini");
    assert.strictEqual(r.provider, "openai");
    assert.strictEqual(r.model, "gpt-4o-mini");
  });

  it("bare name 'gpt-4o-mini'（無斜線）", () => {
    const r = splitProviderModel("gpt-4o-mini");
    assert.strictEqual(r.provider, undefined);
    assert.strictEqual(r.model, "gpt-4o-mini");
  });

  it("空字串", () => {
    const r = splitProviderModel("");
    assert.strictEqual(r.provider, undefined);
    assert.strictEqual(r.model, undefined);
  });
});