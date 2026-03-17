# Skill Observation & Self-Improvement Plan

> 让 skill 的运行历史变成可查询、可检索、可聚合的记忆，使 agent 从 stateless skill consumer 变成 stateful skill operator。

### Review Changelog

**Round 4 (2026-03-17)**

| # | 级别 | 问题 | 修正 |
|---|------|------|------|
| R4-F1 | Medium | Phase 0 的 `importLearnings`/`importInstincts` 签名缺少 `embedder` 参数，无法生成 vector | §4.0.1 改为接收 `SkillBridgeContext { store, embedder }` |
| R4-F2 | Medium | 能力清单仍写"版本回归检测"，但版本追踪已推迟到 Phase 2+ | §6 改为"时间窗口趋势检测" |
| R4-F3 | Low | §4.2.5 CLI 子命令列表残留 `skill-compare`，应为 `skill-trend` | §4.2.5 统一 |

**Round 3 (2026-03-17)**

| # | 级别 | 问题 | 修正 |
|---|------|------|------|
| R3-F1 | High | Phase 3 遍历 `capturedSkillIds` 但该变量在 Phase 1 的 agent_end hook 中未定义 | §4.1.2 / §4.3.4 统一变量流，Phase 1 末尾暴露 `capturedSkillIds` 给 Phase 3 分支 |
| R3-F2 | Med-High | Phase 0 导入要保留原始时间戳，但 `store.store()` 强制 `Date.now()`；应用 `importEntry()` | §4.0.1 明确使用 `store.importEntry()` |
| R3-F3 | Medium | `getLastAlert(store, skillId)` 缺少 scope 参数，跨 scope 冷却期互相抑制 | §4.3.2 补全 `getLastAlert(store, skillId, scopeFilter)` |
| R3-F4 | Medium | 配置残留无效字段：`alertThreshold` 未消费、`mergeThreshold`/`maxConfidence` 合并已取消、`patternConfidence` 未消费 | §4.3.1 / §5.5 清理无效字段，`alertThreshold` 接入过滤逻辑 |
| R3-F5 | Medium | 残留表述不一致：架构图写"观测合并"、skill_observe 说明写"去重/合并"、兼容性分析引用 `memory_category` | §2 / §4.1.1 / §9.2 逐项清理 |

**Round 2 (2026-03-17)**

| # | 级别 | 问题 | 修正 |
|---|------|------|------|
| R2-F1 | High | `extractTextContent()` 接收 `content` 字段而非整个 message 对象，方案传了 `msgObj` | §4.1.2 改为 `extractTextContent(msgObj.content)` |
| R2-F2 | High | `!event.success` early return 导致失败会话不记录；tool error 缓存仅在成功路径清除，会泄漏到后续会话 | §4.1.2 移除 early return，改为条件处理；缓存在 finally 块中清除 |
| R2-F3 | High | `store.store()` 签名要求 `vector` 字段（`Omit<MemoryEntry, "id" \| "timestamp">`），方案两处调用都没传 | §4.1.3 / §4.3.4 所有 store.store() 前先 `embedder.embed()` 生成向量 |
| R2-F4 | High | 合并观测（折叠为单条）与后续 7d/30d 时间窗口统计冲突——丢失时间分布 | §4.1.3 **取消合并设计**，每次独立存储，聚合在查询时做 |
| R2-F5 | Medium | `SmartMemoryMetadata.memory_category` 是 6 值联合类型，写入 `"skill_observation"` 会类型错误 | §3.1 / §3.2 改用独立字段 `skill_obs_type` 规避类型边界 |
| R2-F6 | Medium | 残留接口不一致：`retriever.retrieve` 签名错、`checkSkillAlert` scope 参数错、`config.skillObservation` 不存在、版本引用未清理 | §4.2.2 / §4.3.2 / §4.3.4 / §4.4.1 逐项修正 |

**Round 1 (2026-03-16)**

| # | 级别 | 问题 | 修正 |
|---|------|------|------|
| R1-F1 | High | 合并路径的 `vectorSearch` 签名错误（scopeFilter 应为 `string[]`，`entry.metadata` 是 JSON string 需 `parseSmartMetadata()` 解析，`patchMetadata` 不能更新顶层 timestamp） | §4.1.3 重写合并逻辑，使用正确的 API 签名 |
| R1-F2 | High | Hook 设计使用不存在的 `context.injectSystemMessage()` 和 `context.scope`；hook 注册依赖 autoRecall/autoCapture 开关 | §4.1.2 / §4.3.4 / §5.3 改为独立 hook 注册 + `{ prependContext }` 返回值 + `scopeManager` 解析 scope |
| R1-F3 | High | 从 `agent_end.messages` 检测 tool 错误——该位置只有 role/content 消息，tool 错误在 `after_tool_call` hook | §4.1.2 新增独立 `after_tool_call` hook 缓存 tool 错误，`agent_end` 只检测用户信号 |
| R1-F4 | Medium | `skill_hash` 版本追踪依赖不存在的 skill 注册表/路径解析器 | §3.2 / §3.4 Phase 1 移除 skill_hash，用时间窗口替代版本分组 |
| R1-F5 | Medium | `skill-enable`/`skill-disable` CLI 命令需要配置文件写入能力，CLIContext 不支持 | §5.4 移除 toggle 命令，用户直接编辑配置文件 |
| R1-OQ1 | - | 新增 category 值影响 `MemoryEntry` 联合类型和 import 路径 | §3.1 使用 `category: "other"` + `metadata.memory_category` 区分 |
| R1-OQ2 | - | 无测试计划 | 新增 §10 测试策略 |

## 1. 定位

memory-lancedb-pro 不做"又一个 skill 管理框架"，而是做 **skill 观测的记忆后端**。

```
角色定位：Prometheus for Skills
- 不管你怎么产生 skill（手写 / Skill Creator / GEPA）
- 不管你怎么优化 skill（人工 / DSPy / TextGrad）
- 我只管：记住 skill 发生了什么，并让这些记忆可查询
```

与现有生态的关系：

| 项目 | 关系 |
|------|------|
| hiveminderbot/self-improving-agent | 兼容其 `.learnings/` 数据格式，作为升级替代 |
| continuous-learning-v2 (instincts) | 接入其 JSONL 数据，提供语义检索能力 |
| GEPA / DSPy | 互补——我们提供证据数据，它们做优化引擎 |
| cognee | 差异化——我们用 LanceDB + 混合检索替代图数据库 |

核心优势（其他方案做不到的）：

1. **语义跨 skill 模式发现**：通过向量检索找到不同 skill 的相似失败模式
2. **零新依赖**：复用现有 LanceDB + 混合检索 pipeline
3. **Scope 隔离**：不同项目/agent 的 skill 健康状况互不污染
4. **时间窗口分析**：基于时间窗口追踪 skill 表现趋势变化

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│  数据源层                                                │
│                                                         │
│  ┌───────────┐  ┌───────────┐  ┌────────────────────┐   │
│  │ 显式调用   │  │ agent_end │  │ 外部导入            │   │
│  │ skill_    │  │ 隐式捕获   │  │ .learnings/        │   │
│  │ observe   │  │           │  │ instincts.jsonl    │   │
│  └─────┬─────┘  └─────┬─────┘  └──────────┬─────────┘   │
│        └───────────────┼───────────────────┘             │
│                        ▼                                 │
│  ┌─────────────────────────────────────────────────┐     │
│  │  memory-lancedb-pro 统一记忆层                    │     │
│  │  category: "other" + metadata.skill_obs_type       │     │
│  │  向量嵌入 + BM25 + metadata 结构化字段             │     │
│  │  每次独立存储，查询时聚合                          │     │
│  └─────────────────────────────────────────────────┘     │
│                        │                                 │
│        ┌───────────────┼───────────────┐                 │
│        ▼               ▼               ▼                 │
│  ┌──────────┐  ┌────────────┐  ┌─────────────────┐      │
│  │ inspect  │  │  health    │  │ proactive alert │      │
│  │ 单 skill  │  │ 全局仪表盘  │  │ 主动优化建议     │      │
│  └──────────┘  └────────────┘  └─────────────────┘      │
│        │               │               │                 │
│        └───────────────┼───────────────┘                 │
│                        ▼                                 │
│  ┌─────────────────────────────────────────────────┐     │
│  │  evidence 证据包导出                              │     │
│  │  → 人工审查 / GEPA / TextGrad                    │     │
│  └─────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

---

## 3. 数据模型

### 3.1 存储策略：复用 `"other"` category + 独立 metadata 字段

> **设计决策 1**：不新增 `MemoryEntry.category` 联合类型值。
>
> 现有 `MemoryEntry.category` 是 `"preference" | "fact" | "decision" | "entity" | "other" | "reflection"` 硬编码联合类型（store.ts:26），
> 且 `cli.ts:419` 的 import 路径对未知 category 做 fallback 到 `"other"`。
> 新增 category 值会影响类型定义和 import/update 路径。
>
> 因此 skill 观测使用 **`category: "other"`**。

> **设计决策 2**：不复用 `SmartMemoryMetadata.memory_category` 字段。
>
> `SmartMemoryMetadata.memory_category` 的类型是 `MemoryCategory`（smart-metadata.ts:33），
> 而 `MemoryCategory` 是 `"profile" | "preferences" | "entities" | "events" | "cases" | "patterns"` 的 6 值联合（memory-categories.ts:17）。
> 写入 `"skill_observation"` 会导致 TypeScript 类型错误。
>
> 因此使用**独立字段 `skill_obs_type`**（利用 `SmartMemoryMetadata` 的 `[key: string]: unknown` 索引签名）来标记记录类型。

### 3.2 观测数据 (skill_observation)

存为 memory entry，`category: "other"`, 通过 `metadata.skill_obs_type` 区分：

```typescript
// text 字段：自然语言摘要（会被嵌入，支持语义检索）
// 例："skill 'tdd-workflow' 用于实现登录模块。结果：部分成功。
//      用户修改了 3/5 个生成的测试，原因是 test structure 不匹配项目惯例。"

interface SkillObservationMeta {
  // ── 类型标记 ──
  skill_obs_type: 'observation';  // 独立字段，不复用 memory_category（避开 MemoryCategory 联合类型）

  // ── 身份 ──
  skill_id: string;              // skill 标识符（agent 显式传入的字符串）
  // 注意：Phase 1 不做 skill_hash 版本追踪。
  // 原因：项目当前没有 skill 注册表或路径解析器，无法可靠地从 skill_id 定位文件。
  // 版本追踪推迟到 Phase 2+，届时需要定义 skill_path 解析规则。

  // ── 结果 ──
  outcome: 'success' | 'partial' | 'failure';
  outcome_signal:
    | 'completion'       // 正常完成，用户无纠正
    | 'user_override'    // 用户纠正了 agent 输出
    | 'error'            // tool call 或执行错误
    | 'timeout';         // 超时未完成

  // ── 执行 trace（借鉴 GEPA：记过程，不只记结果）──
  trace_summary: string;         // LLM 生成的 1-3 句执行摘要
  error_chain?: string[];        // 错误传播链 ["tool X failed", "因为 Y", "根因 Z"]
  user_corrections?: string[];   // 用户纠正内容（原文摘录）

  // ── 上下文 ──
  task_type?: string;            // feature / bugfix / refactor / docs / test
  project_scope?: string;        // 来自哪个项目 scope
}
```

> **设计决策**：**不合并观测，每次独立存储。**
>
> 原因：合并（折叠为单条 + observation_count++）会丢失时间分布，
> 导致后续 Phase 2/3 的 7d/30d 窗口统计无法准确计算。
> 每次观测独立存储，聚合/归类在查询时（`skill_inspect`）通过应用层完成。

### 3.3 待处理建议 (skill_suggestion)

当系统检测到 skill 需要优化但当前对话已结束时，存一条待处理建议：

```typescript
// 同样使用 category: "other" + metadata.skill_obs_type 区分
interface SkillSuggestionMeta {
  skill_obs_type: 'suggestion';  // 区分于 'observation'
  skill_id: string;
  priority: 'critical' | 'warn' | 'trend';
  evidence_summary: string;      // 触发建议的证据摘要
  suggested_actions: string[];   // 具体建议列表
  acknowledged: boolean;         // 用户是否已看过
  created_at: number;            // 创建时间
}
```

### 3.4 版本记录（Phase 2+ 才实现）

Phase 1 不做版本追踪，使用**时间窗口分组**替代版本分组（例如按 7 天 / 30 天窗口对比趋势）。

版本追踪的前置条件（Phase 2+ 解决）：
- 定义 `skill_path` 解析规则，或让用户在配置中声明 `skillPaths: Record<string, string>`
- 有了路径才能计算 `skill_hash = SHA256(file_content).slice(0,12)`
- 有了 hash 才能按版本分组统计

---

## 4. 实施阶段

### Phase 0: 数据桥接（1 周）

**目标**：让现有生态数据流入记忆层，不要求用户换工具。

#### 4.0.1 新增 `src/skill-bridge.ts`

```typescript
interface SkillBridgeContext {
  store: MemoryStore;
  embedder: Embedder;          // 导入时需要 embed() 生成 vector
}

// 从 .learnings/ 目录导入（hiveminderbot 兼容）
export async function importLearnings(
  ctx: SkillBridgeContext,
  dir: string,                // 默认 .learnings/
  scope: string               // 写入 scope
): Promise<{ imported: number; skipped: number }>

// 从 instincts JSONL 导入（continuous-learning-v2 兼容）
export async function importInstincts(
  ctx: SkillBridgeContext,
  file: string,               // instincts.jsonl 路径
  scope: string
): Promise<{ imported: number; skipped: number }>
```

导入逻辑：
- 解析源格式 → 转为 skill observation entry → 去重检查 → 存入 LanceDB
- 去重：对每条待导入内容做向量搜索，cosine > 0.95 视为重复，跳过
- **必须使用 `store.importEntry()` 而非 `store.store()`**：
  `store.store()` 强制 `timestamp: Date.now()`（store.ts:328），
  只有 `importEntry()` 保留传入的 timestamp（store.ts:344-370）。
  如果用 `store.store()` 导入历史数据，所有时间戳会被重置为当前时间，
  后续 7d/30d 窗口统计将完全失真。
- 导入时需要通过 `embedder.embed()` 生成 vector（`importEntry` 同样要求 vector 字段）

#### 4.0.2 CLI 命令

```bash
memory-pro import-learnings [--dir .learnings/] [--scope project:xxx]
memory-pro import-instincts [--file instincts.jsonl] [--scope project:xxx]
```

#### 4.0.3 涉及文件

| 文件 | 变更 |
|------|------|
| `src/skill-bridge.ts` | 新建 |
| `cli.ts` | 增加 `import-learnings` 和 `import-instincts` 子命令 |

---

### Phase 1: Observe — 给 skill 建运行日志（1-2 周）

**目标**：三种机制捕获 skill 执行数据，存入统一记忆层。

#### 4.1.1 新增 `skill_observe` tool

```typescript
// src/tools.ts 新增工具定义
{
  name: "skill_observe",
  description: "记录 skill 执行结果，用于积累运行历史和改进依据",
  parameters: {
    skill_id:     { type: "string", required: true,  description: "skill 标识符" },
    outcome:      { type: "string", required: true,  enum: ["success", "partial", "failure"] },
    summary:      { type: "string", required: true,  description: "1-3 句执行摘要" },
    error_detail: { type: "string", required: false, description: "失败时的错误信息或错误链" },
    corrections:  { type: "string", required: false, description: "用户纠正了什么" }
  }
}
```

实现：
- 接收参数 → 构建 observation entry → 调用 `storeSkillObservation()` 独立存入 LanceDB
- Phase 1 不做 `skill_hash`，`skill_id` 由 agent 传入的字符串标识即可
- 每次调用都新建一条独立记录（不合并），保留完整时间分布供后续窗口统计

#### 4.1.2 隐式捕获：两个独立 hook

> **设计决策**：skill 观测注册**独立的 hook**，不依赖 autoRecall / autoCapture 的 hook 存在。
>
> 原因：`before_agent_start` 只在 `autoRecall === true` 时注册（index.ts:1992），
> `agent_end` 只在 `autoCapture !== false` 时注册（index.ts:2092）。
> 如果 skill 观测挂在这些 hook 内部，用户关闭 autoRecall 后 proactive alert 也会消失。
> 因此 skill 观测需要自己的 `api.on(...)` 调用。

**Hook A：`after_tool_call` — 捕获 tool 错误信号**

这是捕获失败信号的**正确位置**。`agent_end.messages` 只包含 role/content 消息，
tool call 错误是在 `after_tool_call` hook 中通过 `event.error` 字段暴露的（index.ts:2490）。

```typescript
// index.ts — skill 观测独立注册

// 会话级 tool 错误缓存，按 sessionKey 隔离
const skillToolErrors = new Map<string, Array<{
  toolName: string;
  error: string;
  at: number;
}>>();

if (config.skillObservation?.enabled) {
  api.on("after_tool_call", (event, ctx) => {
    const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
    if (!sessionKey) return;

    if (typeof event.error === "string" && event.error.trim().length > 0) {
      const errors = skillToolErrors.get(sessionKey) || [];
      errors.push({
        toolName: event.toolName || "unknown",
        error: event.error.slice(0, 500),  // 截断防止过大
        at: Date.now(),
      });
      skillToolErrors.set(sessionKey, errors);
    }
  });
}
```

**Hook B：`agent_end` — 汇总信号并存储观测**

`agent_end` 只负责检测 **用户纠正信号** 和 **完成确认信号**，
tool 错误从 `skillToolErrors` 缓存中获取（由 Hook A 填充）。

```typescript
if (config.skillObservation?.enabled &&
    config.skillObservation?.implicitCapture !== false) {

  api.on("agent_end", async (event, ctx) => {
    // 不对 !event.success 做 early return —— 失败会话更需要记录
    if (!event.messages || event.messages.length === 0) return;

    const sessionKey = ctx?.sessionKey || (event as any).sessionKey || "";
    const agentId = resolveHookAgentId(ctx?.agentId, (event as any).sessionKey);
    const accessibleScopes = scopeManager.getAccessibleScopes(agentId);

    try {
      // 1. 从 messages 中检测 skill 引用和用户信号
      //    （messages 只有 user/assistant role+content）
      const skillRefs: string[] = [];
      const corrections: string[] = [];
      const completions: string[] = [];

      for (const msg of event.messages) {
        const msgObj = msg as Record<string, unknown>;
        // extractTextContent 接收的是 content 字段，不是整个 message 对象
        const text = extractTextContent(msgObj.content);
        if (!text) continue;

        // 检测 skill 文件引用
        const refs = extractSkillReferences(text);
        skillRefs.push(...refs);

        // 检测用户纠正（仅 user 消息）
        if (msgObj.role === "user") {
          corrections.push(...detectUserCorrections(text));
        }

        // 检测完成确认（仅 user 消息）
        if (msgObj.role === "user") {
          completions.push(...detectCompletionSignals(text));
        }
      }

      if (skillRefs.length === 0) return; // 本次会话未使用 skill

      // 2. 从 after_tool_call 缓存获取 tool 错误
      const toolErrors = skillToolErrors.get(sessionKey) || [];

      // 3. 综合判断 outcome
      //    event.success === false 也是 failure 信号
      const outcome = !event.success ? 'failure'
                    : corrections.length > 0 ? 'partial'
                    : toolErrors.length > 0 ? 'failure'
                    : completions.length > 0 ? 'success'
                    : null;

      if (outcome === null) return; // 无法判断时不记录

      // 4. 存储观测（每次独立存储，不合并）
      const defaultScope = scopeManager.getDefaultScope(agentId);
      // 去重后的 skill id 列表
      const capturedSkillIds = [...new Set(skillRefs)];

      for (const sid of capturedSkillIds) {
        await storeSkillObservation(store, embedder, {
          skill_id: sid,
          outcome,
          text: buildObservationText(sid, outcome, corrections, toolErrors),
          error_chain: toolErrors.map(e => `${e.toolName}: ${e.error}`),
          user_corrections: corrections,
          scope: defaultScope,
        });
      }

      // ── Phase 3 分支：检查是否需要生成待处理建议 ──
      // capturedSkillIds 在上面定义，Phase 3 直接使用
      if (config.skillObservation?.proactiveAlerts) {
        for (const skillId of capturedSkillIds) {
          const alert = await checkSkillAlert(store, skillId, accessibleScopes, config.skillObservation);
          if (alert) {
            const suggestionVector = await embedder.embed(alert.message);
            await store.store({
              text: alert.message,
              vector: suggestionVector,
              category: 'other',
              importance: alert.priority === 'critical' ? 0.9 : 0.6,
              scope: defaultScope,
              metadata: stringifySmartMetadata({
                skill_obs_type: 'suggestion',
                skill_id: skillId,
                priority: alert.priority,
                evidence_summary: alert.evidenceSummary,
                suggested_actions: alert.suggestedActions,
                acknowledged: false,
              }),
            });
          }
        }
      }
    } finally {
      // 无论成功/失败/异常，都清除 tool error 缓存，防止泄漏到后续会话
      skillToolErrors.delete(sessionKey);
    }
  });
}
```

关键原则：
- **宁可漏记，不可误记**：只在有明确信号时记录，无法判断时跳过
- **独立 hook 注册**：不依赖 autoRecall/autoCapture 开关，skill 观测有自己的 `api.on(...)` 调用
- **tool 错误从 `after_tool_call` 获取**：而非从 `agent_end.messages` 中猜测
- **trace_summary 用 LLM 生成**：如果 `smartExtraction` 开启，用 LLM 生成 1-3 句执行摘要；否则拼接关键片段

#### 4.1.3 观测存储（每次独立，不合并）

> **设计决策**：不合并观测，每次独立存储一条新记录。
>
> 原因：合并（折叠为单条 + observation_count++）会丢失每次发生的时间分布，
> 导致 Phase 2/3 的 7d/30d 窗口统计无法准确计算成功率。
> 去重/归类在查询时（`skill_inspect`）通过应用层聚合完成。

```typescript
// src/skill-observe.ts

import { stringifySmartMetadata } from "./smart-metadata.js";

interface SkillObservationInput {
  skill_id: string;
  outcome: 'success' | 'partial' | 'failure';
  outcome_signal?: string;
  text: string;              // 自然语言摘要
  trace_summary?: string;
  error_chain?: string[];
  user_corrections?: string[];
  scope: string;             // 写入 scope（来自 scopeManager.getDefaultScope()）
}

async function storeSkillObservation(
  store: MemoryStore,
  embedder: Embedder,
  obs: SkillObservationInput
): Promise<{ id: string }> {

  // store.store() 签名是 Omit<MemoryEntry, "id" | "timestamp">
  // MemoryEntry 包含 vector: number[]，必须提供
  const vector = await embedder.embed(obs.text);

  const entry = await store.store({
    text: obs.text,
    vector,                   // 必需字段
    category: 'other',        // 不新增 category 联合类型值
    importance: obs.outcome === 'failure' ? 0.8 : 0.5,
    scope: obs.scope,
    metadata: stringifySmartMetadata({
      // 使用独立字段 skill_obs_type，不复用 memory_category（避开 MemoryCategory 联合类型）
      skill_obs_type: 'observation',
      skill_id: obs.skill_id,
      outcome: obs.outcome,
      outcome_signal: obs.outcome_signal,
      trace_summary: obs.trace_summary,
      error_chain: obs.error_chain,
      user_corrections: obs.user_corrections,
    }),
  });
  return { id: entry.id };
}
```

#### 4.1.4 涉及文件

| 文件 | 变更 |
|------|------|
| `src/skill-observe.ts` | 新建：观测存储/合并逻辑 |
| `src/tools.ts` | 增加 `skill_observe` tool 定义 |
| `index.ts` | **独立注册** `after_tool_call` + `agent_end` hook（不依赖 autoRecall/autoCapture） |

---

### Phase 2: Inspect — 查询与模式发现（1-2 周）

**目标**：agent 和用户能看到 skill 健康状况，发现失败模式。

#### 4.2.1 新增 `src/skill-inspect.ts`

```typescript
// 核心查询函数

interface SkillReport {
  skill_id: string;
  total_observations: number;
  success_rate: number;
  trend: 'improving' | 'stable' | 'declining';

  // 按时间窗口分组（Phase 1 不做版本分组）
  time_windows: {
    recent_7d:  { observations: number; success_rate: number };
    recent_30d: { observations: number; success_rate: number };
    all_time:   { observations: number; success_rate: number };
  };

  // 趋势检测：近期 vs 历史
  trend_alert?: string;  // 例："近 7 天成功率 (55%) 低于 30 天均值 (78%)"

  top_failures: Array<{ pattern: string; count: number; confidence: number }>;

  // 跨 skill 关联（核心差异化能力）
  related_failures: Array<{
    skill_id: string;
    similarity: number;
    shared_pattern: string;
  }>;
}

export async function inspectSkill(
  store: MemoryStore,
  retriever: Retriever,
  skillId: string,
  opts: { days?: number; scope?: string }
): Promise<SkillReport>

interface HealthDashboard {
  summary: { total_skills: number; healthy: number; degraded: number; critical: number };
  skills: Array<{
    id: string;
    status: 'healthy' | 'degraded' | 'critical';
    success_rate: number;
    trend: string;
    observations: number;
    last_used: string;
  }>;
  // 跨 skill 系统性问题
  systemic_issues: Array<{
    pattern: string;
    affected_skills: string[];
    confidence: number;
  }>;
}

export async function getSkillHealth(
  store: MemoryStore,
  retriever: Retriever,
  opts: { scope?: string }
): Promise<HealthDashboard>
```

#### 4.2.2 跨 skill 模式发现（关键差异化）

```typescript
// 在 inspectSkill 内部

async function findRelatedFailures(
  store: MemoryStore,
  retriever: Retriever,
  skillId: string,
  failures: MemoryEntry[],
  scopeFilter: string[]
): Promise<RelatedFailure[]> {

  const related: RelatedFailure[] = [];

  for (const failure of failures.slice(0, 5)) { // 取 top 5 失败
    // retriever.retrieve 签名：retrieve(context: RetrievalContext)
    // RetrievalContext = { query, limit, scopeFilter?, category?, source? }
    const results = await retriever.retrieve({
      query: failure.text,
      limit: 10,
      scopeFilter,
    });

    // 应用层过滤：只保留 skill_observation 中其他 skill 的失败记录
    // 注意：entry.metadata 是 JSON string，需要 parseSmartMetadata() 解析
    const crossSkill = results.filter(r => {
      const meta = parseSmartMetadata(r.entry.metadata, r.entry);
      return meta.skill_obs_type === 'observation' &&
             meta.skill_id !== skillId &&
             meta.outcome === 'failure';
    });

    for (const match of crossSkill) {
      const matchMeta = parseSmartMetadata(match.entry.metadata, match.entry);
      related.push({
        skill_id: matchMeta.skill_id as string,
        similarity: match.score,
        shared_pattern: extractSharedPattern(failure.text, match.entry.text)
      });
    }
  }

  return dedup(related, r => r.skill_id);
}
```

#### 4.2.3 新增 agent tool

```typescript
// skill_inspect tool
{
  name: "skill_inspect",
  description: "查看单个 skill 的健康状况、失败模式、版本对比",
  parameters: {
    skill_id: { type: "string", required: true },
    days:     { type: "number", required: false, default: 30 }
  }
}

// skill_health tool
{
  name: "skill_health",
  description: "查看所有 skill 的健康概览和系统性问题",
  parameters: {
    scope: { type: "string", required: false }
  }
}
```

#### 4.2.4 CLI 命令

```bash
memory-pro skill-health                            # 全局仪表盘
memory-pro skill-inspect <skill-id> [--days 30]    # 单 skill 报告
memory-pro skill-history <skill-id>                # 按时间排列的观测
memory-pro skill-trend   <skill-id>                # 时间窗口对比（7d vs 30d vs all）
```

#### 4.2.5 涉及文件

| 文件 | 变更 |
|------|------|
| `src/skill-inspect.ts` | 新建：inspect / health / 跨 skill 模式发现 |
| `src/tools.ts` | 增加 `skill_inspect`、`skill_health` tool |
| `cli.ts` | 增加 `skill-health`、`skill-inspect`、`skill-history`、`skill-trend` 子命令 |

---

### Phase 3: Proactive Alert — 主动优化建议（1-2 周）

**目标**：agent 在合适的时机主动告诉用户 "这个 skill 需要优化"，带证据。

#### 4.3.1 告警阈值配置

```typescript
// AlertThresholds 不单独定义为 interface，直接从 config.skillObservation 平铺字段中读取。
// 以下列出 checkSkillAlert 内部使用的字段（全部来自 config.skillObservation.*）：
//
//   minObservations:    number  // 默认 5，最少使用次数才触发
//   successRateWarn:    number  // 默认 0.70，成功率低于此值 → warn
//   successRateCritical:number  // 默认 0.50，成功率低于此值 → critical
//   trendDeclineRate:   number  // 默认 0.15，近 7 天比历史下降超过此值 → trend alert
//   cooldownDays:       number  // 默认 7，同一 skill 最多 N 天提醒一次
//   alertThreshold:     string  // 默认 "warn"，最低告警级别过滤（"critical" | "warn" | "trend"）
//
// 已移除的字段：
//   - patternConfidence：声明了但从未被消费，删除
//   - mergeThreshold / maxConfidence：合并设计已取消，删除
```

#### 4.3.2 告警检查逻辑

```typescript
// src/skill-alert.ts

export async function checkSkillAlert(
  store: MemoryStore,
  skillId: string,
  scopeFilter: string[],           // string[]，来自 scopeManager.getAccessibleScopes()
  skillObsConfig: PluginConfig['skillObservation']  // 直接传 config.skillObservation，不是 config.skillObservation
): Promise<SkillAlert | null> {

  const thresholds = {
    minObservations: skillObsConfig?.minObservations ?? 5,
    successRateWarn: skillObsConfig?.successRateWarn ?? 0.70,
    successRateCritical: skillObsConfig?.successRateCritical ?? 0.50,
    trendDeclineRate: skillObsConfig?.trendDeclineRate ?? 0.15,
    cooldownDays: skillObsConfig?.cooldownDays ?? 7,
  };

  const obs = await aggregateObservations(store, skillId, scopeFilter);

  // 样本不够，不提
  if (obs.total < thresholds.minObservations) return null;

  // 冷却期内，不重复提（传 scopeFilter 保证 scope 隔离）
  const lastAlert = await getLastAlert(store, skillId, scopeFilter);
  if (lastAlert && daysSince(lastAlert.timestamp) < thresholds.cooldownDays) return null;

  // 判断级别
  let priority: 'critical' | 'warn' | 'trend' | null = null;

  if (obs.successRate < thresholds.successRateCritical) {
    priority = 'critical';
  } else if (obs.successRate < thresholds.successRateWarn) {
    priority = 'warn';
  } else if (obs.recentRate < obs.historicalRate - thresholds.trendDeclineRate) {
    priority = 'trend';
  }

  if (!priority) return null;

  // alertThreshold 过滤：只输出达到最低级别的告警
  // 级别顺序：critical > warn > trend
  const levelOrder = { critical: 3, warn: 2, trend: 1 };
  const minLevel = skillObsConfig?.alertThreshold ?? 'warn';
  if (levelOrder[priority] < levelOrder[minLevel]) return null;

  return buildAlert(priority, skillId, obs);
}
```

#### 4.3.3 告警三级内容模板

```typescript
function buildAlert(
  priority: string,
  skillId: string,
  obs: AggregatedObservations
): SkillAlert {

  const topFailure = obs.topFailures[0];
  const topCorrection = obs.topCorrections[0];

  switch (priority) {
    case 'critical':
      return {
        priority,
        message:
          `⚠ skill "${skillId}" 近 ${obs.total} 次使用中成功率仅 ${pct(obs.successRate)}。\n` +
          `主要失败原因：${topFailure.pattern}（${topFailure.count} 次，置信度 ${pct(topFailure.confidence)}）。\n` +
          (topCorrection ? `用户曾纠正："${topCorrection}"。\n` : '') +
          `建议在使用前先优化此 skill。可用 skill_evidence 查看完整证据。`
      };

    case 'warn':
      return {
        priority,
        message:
          `💡 skill "${skillId}" 近期成功率 ${pct(obs.successRate)}，` +
          `已知问题：${topFailure.pattern}。注意避开此问题。`
      };

    case 'trend':
      return {
        priority,
        message:
          `📉 skill "${skillId}" 近 7 天成功率 (${pct(obs.recentRate)}) ` +
          `低于历史水平 (${pct(obs.historicalRate)})。`
          // 注意：版本追踪推迟到 Phase 2+，此处不引用 versionChanged / currentHash
      };
  }
}
```

#### 4.3.4 两个触发时机

> **设计决策**：proactive alert 注册**独立的 hook**，不依赖 autoRecall 的 `before_agent_start`。
>
> 原因：`before_agent_start` 只在 `autoRecall === true` 时注册（index.ts:1992）。
> 如果告警挂在 autoRecall 的 hook 内部，`autoRecall: false` 的用户永远收不到告警。
> 告警 hook 的注册条件是 `skillObservation.enabled && skillObservation.proactiveAlerts`，独立于 autoRecall。

**时机 A：`before_agent_start` — 即将使用时提醒**

```typescript
// index.ts — 独立注册的 proactive alert hook
// 注意：与 autoRecall 的 before_agent_start 是两个独立的 handler

if (config.skillObservation?.enabled &&
    config.skillObservation?.proactiveAlerts) {

  api.on("before_agent_start", async (event, ctx) => {
    if (!event.prompt) return;

    try {
      // 使用 scopeManager 解析 scope（不是 ctx.scope，该字段不存在）
      const agentId = resolveHookAgentId(ctx?.agentId, (event as any).sessionKey);
      const accessibleScopes = scopeManager.getAccessibleScopes(agentId);

      // 1. 检测 prompt 中的 skill 引用
      const detectedSkills = detectSkillIntent(event.prompt);

      // 2. 检查每个 skill 的告警
      const alerts: string[] = [];
      for (const skillId of detectedSkills) {
        const alert = await checkSkillAlert(store, skillId, accessibleScopes, config.skillObservation);
        if (alert) {
          alerts.push(alert.message);
        }
      }

      // 3. 弹出上次 agent_end 存入的待处理建议
      const pendingSuggestions = await getPendingSuggestions(store, accessibleScopes);
      for (const suggestion of pendingSuggestions) {
        alerts.push(suggestion.text);
        await store.patchMetadata(suggestion.id, { acknowledged: true }, accessibleScopes);
      }

      if (alerts.length === 0) return;

      // 4. 返回 { prependContext } — 这是 before_agent_start handler 的正确返回格式
      return {
        prependContext:
          `<skill-alerts>\n` +
          alerts.join("\n") +
          `\n</skill-alerts>`,
      };
    } catch (err) {
      api.logger.warn(`skill-observation: alert check failed: ${String(err)}`);
    }
  });
}
```

**时机 B：`agent_end` — 积累到阈值时存待处理建议**

Phase 3 的 agent_end 逻辑已内联到 Phase 1 的 agent_end hook 中（见 §4.1.2），
在存储观测之后、`finally` 清缓存之前执行。`capturedSkillIds` 在同一个 hook 内定义和使用，
不存在跨作用域引用。

#### 4.3.5 涉及文件

| 文件 | 变更 |
|------|------|
| `src/skill-alert.ts` | 新建：告警检查、阈值判断、模板生成 |
| `index.ts` | **独立注册** `before_agent_start` hook（不依赖 autoRecall） |

---

### Phase 4: Evidence — 证据包导出（1 周）

**目标**：为人工审查或外部优化引擎提供结构化证据。

#### 4.4.1 新增 `skill_evidence` tool

```typescript
{
  name: "skill_evidence",
  description: "生成 skill 改进的完整证据包，包含失败聚类、用户纠正、时间趋势",
  parameters: {
    skill_id: { type: "string", required: true }
  }
}

// 返回
{
  skill_id: string;
  // 注意：不包含 skill_content（Phase 1 没有 skill 路径解析器，无法读取 SKILL.md 文件）

  evidence: {
    failure_clusters: Array<{
      pattern: string;
      frequency: number;
      representative_traces: string[];
      user_corrections: string[];
    }>;

    // 时间窗口对比（替代版本对比，版本追踪推迟到 Phase 2+）
    time_windows: {
      recent_7d:  { observations: number; success_rate: number };
      recent_30d: { observations: number; success_rate: number };
      all_time:   { observations: number; success_rate: number };
    };

    related_skills: Array<{
      id: string;
      shared_failure: string;
    }>;
  };

  // LLM 生成的建议（标注为建议，非指令）
  suggested_actions: string[];
}
```

#### 4.4.2 CLI 证据导出

```bash
# 人类阅读格式
memory-pro skill-evidence <skill-id>

# GEPA 兼容格式（可选）
memory-pro skill-evidence <skill-id> --format gepa

# JSON 导出
memory-pro skill-evidence <skill-id> --json
```

#### 4.4.3 涉及文件

| 文件 | 变更 |
|------|------|
| `src/skill-evidence.ts` | 新建：证据聚合、建议生成 |
| `src/tools.ts` | 增加 `skill_evidence` tool |
| `cli.ts` | 增加 `skill-evidence` 子命令 |

---

## 5. 开关机制与配置

### 5.1 设计原则

**默认关闭，逐级启用**。理由：

1. **有成本** — 每次观测需要 embedding 调用 + 存储空间，trace 摘要需要 LLM 调用
2. **不是所有人都用 skill** — 很多用户只用基础记忆功能，skill 观测对他们是噪音
3. **改变 agent 行为** — 主动告警会插入系统消息，用户没预期时会困惑
4. **注册 tool 占上下文** — 4 个新 tool 定义会占用 agent 上下文窗口

### 5.2 三层开关

```jsonc
// openclaw.plugin.json
{
  "skillObservation": {
    "enabled": false,              // 第一层：总开关，默认关
    "implicitCapture": true,       // 第二层：总开关开启后，隐式捕获默认开
    "proactiveAlerts": false       // 第三层：主动告警默认关，需用户二次确认
  }
}
```

| 层级 | 默认值 | 关闭时 | 开启时 |
|------|--------|--------|--------|
| `enabled` | **false** | 不注册 skill_* tools，不捕获观测，不告警。零开销 | 注册 4 个 tool + 隐式捕获 + CLI 命令可用 |
| `implicitCapture` | true（跟随 enabled） | 只能通过 `skill_observe` tool 显式记录 | `agent_end` 自动检测 skill 使用并记录 |
| `proactiveAlerts` | **false** | 用户需主动调用 `skill_inspect` / `skill_health` 查看 | `before_agent_start` 自动注入告警 + 待处理建议弹出 |

### 5.3 启动逻辑

> **关键**：skill 观测的 hook 注册**独立于** autoRecall / autoCapture。
>
> `before_agent_start` 只在 `autoRecall === true` 时注册（index.ts:1992），
> `agent_end` 只在 `autoCapture !== false` 时注册（index.ts:2092）。
> 如果 skill 观测复用这些 hook，用户关闭 autoRecall 后告警也消失。
> 因此 skill 观测需要自己独立的 `api.on(...)` 调用。

```typescript
// index.ts — 插件初始化

// 基础记忆功能：始终注册（现有代码不变）
registerAllMemoryTools(api, context, {
  enableManagementTools: config.enableManagementTools,
  enableSelfImprovementTools: config.selfImprovement?.enabled !== false,
  // 新增：skill 观测 tools 的开关
  enableSkillObservation: config.skillObservation?.enabled === true,
});

// 现有 hook 注册（不变）
if (config.autoRecall === true) {
  api.on("before_agent_start", async (event, ctx) => { /* ... 现有 auto-recall ... */ });
}
if (config.autoCapture !== false) {
  api.on("agent_end", async (event, ctx) => { /* ... 现有 auto-capture ... */ });
}

// skill 观测 hook 注册（独立，不依赖上面两个开关）
if (config.skillObservation?.enabled) {
  // Hook 1: tool 错误缓存（始终注册）
  api.on("after_tool_call", (event, ctx) => { /* ... 缓存 tool 错误 ... */ });

  // Hook 2: 隐式观测捕获（可单独关闭）
  if (config.skillObservation?.implicitCapture !== false) {
    api.on("agent_end", async (event, ctx) => { /* ... 隐式捕获 + 存观测 ... */ });
  }

  // Hook 3: 主动告警（需二次启用）
  if (config.skillObservation?.proactiveAlerts) {
    api.on("before_agent_start", async (event, ctx) => { /* ... 告警注入 ... */ });
  }
}

// enabled = false 时：
// - 不注册任何 skill_* tool（不占上下文）
// - 不注册任何额外 hook（不增加延迟）
// - CLI skill-* 子命令仍可用（查看历史数据），但会提示功能未启用
```

### 5.4 CLI 行为

> **设计决策**：不提供 `skill-enable` / `skill-disable` CLI 命令。
>
> 原因：当前 `CLIContext` 只有 store/retriever/scopeManager/embedder 等运行时对象（cli.ts:18），
> 没有配置文件的发现/读写能力。toggle 命令需要定位并修改 `openclaw.plugin.json`，
> 这需要额外的 config mutation 设计，超出 CLI 层的职责。
> 用户直接编辑配置文件即可，与 OpenClaw 现有的配置方式一致。

```bash
# CLI 命令不受 enabled 开关限制（CLI 是用户主动调用）
memory-pro skill-health              # 如果无观测数据，提示 "无观测记录，
                                     #   请在配置中设置 skillObservation.enabled: true"
memory-pro import-learnings          # 始终可用
memory-pro import-instincts          # 始终可用

# 启用方式：用户编辑配置文件
# openclaw.plugin.json → "skillObservation": { "enabled": true }
```

### 5.5 完整配置项

```jsonc
{
  "skillObservation": {
    // ── 开关 ──
    "enabled": false,                 // 总开关，默认关
    "implicitCapture": true,          // agent_end 隐式捕获（跟随 enabled）
    "proactiveAlerts": false,         // 主动告警，需二次启用

    // ── 告警阈值（仅 proactiveAlerts: true 时生效）──
    "alertThreshold": "warn",         // 最低告警级别过滤："critical" | "warn" | "trend"
                                      // checkSkillAlert 产出的级别低于此值时不输出
    "minObservations": 5,             // 最少使用次数才触发告警
    "cooldownDays": 7,                // 同 skill 同 scope 提醒间隔（天）
    "successRateWarn": 0.70,          // 成功率低于此值 → warn
    "successRateCritical": 0.50,      // 成功率低于此值 → critical
    "trendDeclineRate": 0.15          // 近 7 天比历史下降超过此值 → trend

    // 已移除的字段（Round 3 清理）：
    // - mergeThreshold / maxConfidence：合并设计已取消
    // - patternConfidence：声明了但从未被消费
  }
}
```

---

## 6. Agent 获得的完整能力清单

> 所有 skill 观测能力默认关闭（`enabled: false`），用户启用后才生效。
> 基础记忆功能（memory_recall/store/forget/update/list/stats）不受影响。

### 被动能力（自动生效，需启用对应开关）

| 能力 | 所需开关 | 机制 | 效果 |
|------|----------|------|------|
| skill 执行历史自动积累 | `enabled` + `implicitCapture` | `agent_end` 隐式捕获 | 每次对话结束后自动记录 skill 使用情况 |
| 使用 skill 前注入历史教训 | `enabled` + `proactiveAlerts` | `before_agent_start` 增强 | agent 还没犯错就已经收到前人教训 |
| skill 退化主动告警 | `enabled` + `proactiveAlerts` | `before_agent_start` 弹出 | 成功率下降时主动提醒用户 |
| 时间窗口趋势检测 | `enabled` | 观测聚合时对比 7d vs 30d | 近期成功率下滑时自动发现（版本级回归检测推迟到 Phase 2+） |

### 主动工具（需 `enabled: true`）

| Tool | 用途 | 调用时机 |
|------|------|----------|
| `skill_observe` | 记录 skill 执行结果 | 用完 skill 后 |
| `skill_inspect` | 查看单个 skill 健康报告 | 准备用某 skill 前，或被问到时 |
| `skill_health` | 全局 skill 仪表盘 | 被问到系统状况时 |
| `skill_evidence` | 生成改进证据包 | 被要求改进某 skill 时 |

### CLI 命令（始终可用，不受 `enabled` 限制）

| 命令 | 用途 |
|------|------|
| `memory-pro import-learnings` | 导入 .learnings/ 数据 |
| `memory-pro import-instincts` | 导入 instincts JSONL |
| `memory-pro skill-health` | 全局仪表盘 |
| `memory-pro skill-inspect <id>` | 单 skill 报告 |
| `memory-pro skill-history <id>` | 时间线 |
| `memory-pro skill-trend <id>` | 时间窗口对比 |
| `memory-pro skill-evidence <id>` | 证据包 |

---

## 7. 实施优先级与时间线

```
Phase 0 (数据桥接)    ████░░░░░░  1 周
  └ 可独立发布，立刻让现有 learnings/instincts 可检索

Phase 1 (Observe)     ████████░░  1-2 周
  └ 核心价值，开始积累数据

Phase 2 (Inspect)     ████████░░  1-2 周
  └ 让积累的数据可查询、可诊断

Phase 3 (Alert)       ████████░░  1-2 周
  └ 主动推送，让 agent 变主动

Phase 4 (Evidence)    ████░░░░░░  1 周
  └ 数据导出，对接外部优化引擎
                      ──────────
                      总计 5-8 周
```

**可分批发布**：
- `v1.2.0-beta` → Phase 0 + Phase 1（数据桥接 + 观测）
- `v1.3.0-beta` → Phase 2 + Phase 3（查询 + 告警）
- `v1.4.0-beta` → Phase 4（证据导出）

---

## 8. 新增文件清单

```
src/
  skill-bridge.ts       # Phase 0: 数据桥接（导入 .learnings / instincts）
  skill-observe.ts      # Phase 1: 观测存储/合并
  skill-inspect.ts      # Phase 2: 查询/聚合/跨 skill 模式发现
  skill-alert.ts        # Phase 3: 告警检查/阈值/模板
  skill-evidence.ts     # Phase 4: 证据包生成
```

**修改文件**：
- `src/tools.ts` — 增加 4 个 tool（在 `registerAllMemoryTools` 中按 `enableSkillObservation` 开关控制）
- `index.ts` — 独立注册 3 个 hook（`after_tool_call` + `agent_end` + `before_agent_start`，不依赖 autoRecall/autoCapture）
- `cli.ts` — 增加 7 个子命令
- `openclaw.plugin.json` — 增加 `skillObservation` 配置 schema + uiHints

---

## 9. 插件接口兼容性分析

### 9.1 结论：向后兼容，有注意事项

所有改动都是**加法**，不修改任何现有接口签名或默认行为。
但需要注意：新增 `skill_obs_type` metadata 字段会扩大内部数据面，query 路径需要感知。

### 9.2 逐项分析

#### Tool 注册（`api.registerTool()`）

现有模式已支持按开关条件注册：

```typescript
// 现有代码 src/tools.ts:1356
export function registerAllMemoryTools(api, context, options) {
  // 核心 tools（始终注册）
  registerMemoryRecallTool(api, context);
  // ...

  // 管理 tools（按 enableManagementTools 开关）
  if (options.enableManagementTools) { ... }

  // self-improvement tools（按 enableSelfImprovementTools 开关）
  if (options.enableSelfImprovementTools !== false) { ... }
}
```

新增 skill 观测 tools 用完全相同的模式：

```typescript
// 新增，不修改已有代码路径
if (options.enableSkillObservation) {
  registerSkillObserveTool(api, context);
  registerSkillInspectTool(api, context);
  registerSkillHealthTool(api, context);
  registerSkillEvidenceTool(api, context);
}
```

- 接口签名 `api.registerTool()` 不变
- `options` 增加一个可选字段 `enableSkillObservation?: boolean`
- `enabled: false`（默认）时不调用任何新的 `registerTool`

#### Hook 注册（`api.on()`）

现有 hook 注册和条件：

```
before_agent_start → 仅 autoRecall === true 时注册（index.ts:1992）
agent_end          → 仅 autoCapture !== false 时注册（index.ts:2092）
after_tool_call    → 仅 memoryReflection 启用时注册（index.ts:2490）
command:new/reset  → self-improvement / memory reflection
```

skill 观测的 hook 注册策略：

- **注册独立的 hook handler**，不挂在 autoRecall/autoCapture 的 handler 内部
- OpenClaw 支持同一事件注册多个 handler，因此不冲突
- 注册条件是 `skillObservation.enabled`，独立于 autoRecall/autoCapture
- 新增 3 个 handler：`after_tool_call`（错误缓存）、`agent_end`（隐式捕获）、`before_agent_start`（告警注入）

#### CLI 注册（`api.registerCli()`）

现有模式：

```typescript
// index.ts:1959 — 单次调用，传入 commander 实例
api.registerCli(createMemoryCLI({ store, retriever, ... }));
```

新增子命令只是在 `createMemoryCLI()` 返回的 commander 实例上多调几次 `.command()`。
`api.registerCli()` 仍然只调用一次，传入的实例类型不变。

CLI 子命令不受 `enabled` 开关限制（CLI 是用户主动行为），所以即使 `enabled: false`，
`skill-health` 等命令仍可用（查看历史数据或提示用户启用功能）。

#### 配置 Schema（`openclaw.plugin.json`）

现有 schema 设置了 `"additionalProperties": false`，因此需要显式添加 `skillObservation` 字段。

变更方式：在 `configSchema.properties` 中新增：

```jsonc
"skillObservation": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "enabled":            { "type": "boolean", "default": false },
    "implicitCapture":    { "type": "boolean", "default": true },
    "proactiveAlerts":    { "type": "boolean", "default": false },
    "alertThreshold":     { "type": "string",  "enum": ["critical", "warn", "trend"], "default": "warn" },
    "minObservations":    { "type": "integer", "minimum": 1, "maximum": 100, "default": 5 },
    "cooldownDays":       { "type": "integer", "minimum": 1, "maximum": 90, "default": 7 },
    "successRateWarn":    { "type": "number",  "minimum": 0, "maximum": 1, "default": 0.70 },
    "successRateCritical":{ "type": "number",  "minimum": 0, "maximum": 1, "default": 0.50 },
    "trendDeclineRate":   { "type": "number",  "minimum": 0, "maximum": 1, "default": 0.15 }
  }
}
```

同时在 `uiHints` 中新增对应的 UI 提示：

```jsonc
"skillObservation.enabled": {
  "label": "Skill Observation",
  "help": "Enable skill execution tracking, health monitoring, and proactive improvement suggestions"
},
"skillObservation.proactiveAlerts": {
  "label": "Proactive Skill Alerts",
  "help": "Automatically notify when a skill's success rate drops or regresses after updates",
  "advanced": true
}
```

**向后兼容性**：
- 旧配置文件中没有 `skillObservation` 字段 → 默认值 `{ enabled: false }` 生效
- 所有新字段都是可选的，有合理默认值
- 不需要用户修改任何现有配置

#### 数据层（LanceDB `memories` 表）

- skill 观测存为普通 memory entry（`category: "other"`），写入同一张 `memories` 表
- **不新增 `MemoryEntry.category` 联合类型值**，通过 `metadata.skill_obs_type` 区分
- `metadata` 字段是 JSON string，可扩展，不改表结构
- 不需要 migration，不需要新建表
- **注意事项**：`cli.ts:419` 的 import 路径对未知 category 做 fallback 到 `"other"`，
  使用 `category: "other"` 不触发这个 fallback 逻辑，是安全的

#### TypeScript 类型（`PluginConfig`）

在 `index.ts` 的 `PluginConfig` interface 中增加一个可选字段：

```typescript
skillObservation?: {
  enabled?: boolean;
  implicitCapture?: boolean;
  proactiveAlerts?: boolean;
  alertThreshold?: 'critical' | 'warn' | 'trend';
  minObservations?: number;
  cooldownDays?: number;
  successRateWarn?: number;
  successRateCritical?: number;
  trendDeclineRate?: number;
};
```

所有字段可选 + 有默认值，不影响现有类型使用。

### 9.3 兼容性矩阵

| 变更项 | 类型 | 是否破坏现有接口 | 现有用户是否需要改配置 | 注意事项 |
|--------|------|------------------|------------------------|----------|
| `PluginConfig` 增加 `skillObservation?` | 加可选字段 | 否 | 否 | |
| `configSchema` 增加 `skillObservation` | 加可选属性 | 否 | 否 | |
| `registerAllMemoryTools` 增加 `enableSkillObservation` option | 加可选参数 | 否 | 否 | |
| 独立注册 3 个 hook handler | 新增 handler | 否 | 否 | 不修改现有 handler |
| `memories` 表增加 `skill_obs_type` metadata 字段 | metadata 扩展 | 否 | 否 | 使用独立字段名，不冲突 `SmartMemoryMetadata.memory_category` 类型 |
| CLI 增加 7 个子命令 | 加法 | 否 | 否 | |
| 新增 5 个 `src/skill-*.ts` 文件 | 纯新增 | 否 | 否 | |

---

## 10. 测试策略

### 10.1 配置矩阵测试

skill 观测有 3 个独立开关（`enabled`, `implicitCapture`, `proactiveAlerts`），组合出 5 种有效配置状态。
每种状态需要验证 tool 注册、hook 注册、运行时行为是否符合预期。

| 状态 | enabled | implicitCapture | proactiveAlerts | 预期行为 |
|------|---------|-----------------|-----------------|----------|
| S0 (默认) | false | - | - | 不注册 tool，不注册 hook，零开销 |
| S1 | true | true | false | 注册 4 个 tool + `after_tool_call` + `agent_end` hook |
| S2 | true | false | false | 注册 4 个 tool + `after_tool_call` hook（无隐式捕获） |
| S3 | true | true | true | S1 + `before_agent_start` hook（告警注入） |
| S4 | true | false | true | S2 + `before_agent_start` hook |

每种状态的测试点：
- `api.registerTool()` 调用次数是否正确
- `api.on()` 调用的事件类型和数量是否正确
- 现有 autoRecall/autoCapture 的 hook 是否不受影响

### 10.2 Hook 注册独立性测试

验证 skill 观测的 hook 不依赖 autoRecall/autoCapture：

```
Test: autoRecall=false + skillObservation.proactiveAlerts=true
  → before_agent_start hook 仍然注册（skill 告警）
  → 但 auto-recall 的 before_agent_start 未注册

Test: autoCapture=false + skillObservation.implicitCapture=true
  → agent_end hook 仍然注册（隐式捕获）
  → 但 auto-capture 的 agent_end 未注册
```

### 10.3 数据层测试

#### 观测存储

```
Test: 存储 skill_observation entry
  → category 为 "other"
  → metadata JSON 包含 skill_obs_type: "observation"（不是 memory_category）
  → parseSmartMetadata() 能正确解析
  → vector 字段已填充（通过 embedder.embed() 生成）

Test: 存储 skill_suggestion entry
  → category 为 "other"
  → metadata JSON 包含 skill_obs_type: "suggestion"
  → vector 字段已填充

Test: store.store() 调用格式
  → 传入 Omit<MemoryEntry, "id" | "timestamp"> 包含 text, vector, category, importance, scope, metadata
  → 不遗漏 vector 字段
```

#### 独立存储（无合并）

```
Test: 同一 skill 的两次相似失败
  → 存为两条独立记录（不合并）
  → 各自有独立的 timestamp
  → skill_inspect 能按时间窗口分别统计

Test: 同一 skill 的成功和失败
  → 各自独立存储
  → skill_inspect 能正确计算成功率
```

### 10.4 隐式捕获测试

```
Test: extractTextContent 正确调用
  → 传入 msgObj.content（不是 msgObj 本身）
  → 能处理 string content 和 array content 两种格式

Test: agent_end messages 中包含 SKILL.md 引用 + 用户纠正
  → 检测到 skill_id
  → outcome = "partial"
  → user_corrections 包含纠正内容

Test: agent_end messages 中包含 SKILL.md 引用，无纠正信号
  → after_tool_call 缓存中有 tool 错误
  → outcome = "failure"
  → error_chain 包含 tool 错误信息

Test: event.success === false 的会话
  → 不被 early return 跳过
  → outcome = "failure"
  → 观测正常存储

Test: agent_end messages 中无 skill 引用
  → 不存储任何观测

Test: after_tool_call 缓存在 agent_end 完成后清除（finally 块）
  → 成功路径：消费后清除
  → 失败路径（无 skill 引用 early return）：也清除
  → 异常路径：也清除
  → 不跨会话泄漏
```

### 10.5 告警逻辑测试

```
Test: checkSkillAlert 参数类型
  → scopeFilter 是 string[]（不是 string）
  → 第四个参数是 config.skillObservation（不是 config.alertThresholds）

Test: 观测不足 minObservations
  → checkSkillAlert 返回 null

Test: 成功率 < successRateCritical
  → 返回 priority = "critical"

Test: 冷却期内
  → 返回 null（不重复告警）

Test: trend 模板不引用版本信息
  → 不引用 versionChanged / currentHash（版本追踪推迟到 Phase 2+）

Test: before_agent_start handler 返回格式
  → 返回 { prependContext: "<skill-alerts>...</skill-alerts>" }
  → 不调用 context.injectSystemMessage()（该方法不存在）

Test: skill_suggestion store.store() 调用
  → 包含 vector 字段（通过 embedder.embed() 生成）
  → metadata 使用 skill_obs_type: "suggestion"（不是 memory_category）
```

### 10.6 CLI 测试

```
Test: enabled=false 时运行 memory-pro skill-health
  → 不报错，输出提示信息

Test: memory-pro import-learnings 解析 LEARNINGS.md 格式
  → 正确导入，去重跳过已有条目

Test: memory-pro skill-inspect 输出包含时间窗口对比
  → 7d / 30d / all_time 三个窗口都有数据
```

### 10.7 集成测试

```
Test: 完整流程 — 显式 skill_observe → skill_inspect → skill_evidence
  → 存入观测（每次独立记录）→ 能被 inspect 查询到 → evidence 包含正确的失败聚类
  → 时间窗口统计正确（多条独立记录能按 7d/30d/all 分组）

Test: 完整流程 — 隐式捕获 → 告警触发
  → 模拟 5 次失败的 agent_end（含 after_tool_call 错误缓存）
  → 产生 5 条独立观测记录
  → checkSkillAlert 触发 → before_agent_start 返回 { prependContext } 告警

Test: 跨 skill 模式发现
  → skill A 和 skill B 各有因相似原因失败的观测
  → findRelatedFailures 使用 retriever.retrieve({ query, limit, scopeFilter }) 找到关联
  → 返回结果中 metadata 通过 parseSmartMetadata() 解析，用 skill_obs_type 过滤
```
