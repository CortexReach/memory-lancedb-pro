# OpenClaw 集成与迭代手册

这份文档把 `memory-lancedb-pro` 在真实 OpenClaw 环境中的集成、联调和回归测试经验整理成一套可复用说明，面向两类读者：

- 初次接入 OpenClaw 的新用户
- 后续继续迭代检索、Hook、生命周期逻辑的维护者

目标不是记录某一台机器的细节，而是沉淀可验证的行为、常见故障特征和维护规则。

## 0. 先选对自己的使用路径

在继续看后面的章节前，先判断你目前属于哪一类：

- 新 OpenClaw 用户，或第一次接入记忆能力
- 已经用了 OpenClaw 一段时间，现在再接入本插件
- 已经在用旧版 `memory-lancedb-pro`，准备从 v1.1.0 之前升级

必须先分清三条命令的用途：

- `upgrade`：针对旧版 `memory-lancedb-pro` 数据
- `migrate`：针对内置 `memory-lancedb` 数据
- `reembed`：针对向量重建，不是常规升级步骤

如果把这三条路径混在一起，后续很容易把“数据格式问题”和“检索质量问题”混为一谈。

## 1. 推荐部署模式

建议先明确采用哪一种模式，再开始调参。

### 模式 A：以检索为主

适用场景：

- 使用 `memory_store` / `memory_recall`
- 需要混合检索（`vector + BM25`）
- 开启 auto-capture / auto-recall
- 使用 smart extraction 和 lifecycle ranking

这类场景下，除非你确实需要“把旧 session 摘要也作为可检索记忆”，否则不建议默认开启插件侧 session summary。

### 模式 B：检索 + session summary 可检索

适用场景：

- 除常规长期记忆外，还希望 `/new` 时把上一个 session 摘要写入 LanceDB，参与后续检索

这时需要：

- 设置插件 `sessionStrategy: "memoryReflection"`（LLM 结构化反思：去重、错误追踪、lifecycle 评分）
- 明确决定是否保留 OpenClaw 内置 `session-memory`

> **注意：** 旧版 `sessionMemory.enabled = true` 实际映射为 `systemSessionMemory`（简单摘要直存 LanceDB），而非 `memoryReflection`。如需完整反思管线，请显式使用 `sessionStrategy`。

如果两者同时开启，`/new` 可能产生两类结果：

- OpenClaw 内置的 workspace/session 摘要文件
- `memory-lancedb-pro` 写入 LanceDB 的 session-summary 记忆

这不是错误，但属于双写设计。若不希望排障时出现“看起来重复”的现象，应只保留一种路径。

## 2. Session Memory 选型建议

大部分场景推荐三选一，而不是默认双开。

### 方案 1：禁用（不启用插件 session hook）

适合：

- 主要想保留会话摘要文件
- 不要求 session summary 参与 LanceDB 检索

建议配置：

- 插件 `sessionStrategy: "none"`（或不设置 `sessionStrategy`）
- OpenClaw `hooks.internal.entries.session-memory.enabled = true`

### 方案 2：只用插件（LLM 反思模式）

适合：

- 希望 session summary 进入 LanceDB
- 需要 LLM 结构化提取、去重、lifecycle 评分

建议配置：

- 插件 `sessionStrategy: "memoryReflection"`
- OpenClaw `hooks.internal.entries.session-memory.enabled = false`

### 方案 3：只用插件（简单摘要模式）

适合：

- 希望 session summary 存入 LanceDB
- 不需要 LLM 反思管线

建议配置：

- 插件 `sessionStrategy: "systemSessionMemory"`
- OpenClaw `hooks.internal.entries.session-memory.enabled = false`

此模式将会话摘要直接写入 LanceDB，存为 `fact` / `peripheral` 层级条目，不经过 LLM 去重或 lifecycle 评分。

### 方案 4：双写

只在你明确需要以下两类产物时使用：

- workspace 中的摘要文件（通过内置 session-memory）
- LanceDB 中可检索的 session 记忆（通过插件 `sessionStrategy`）

若采用双写，建议在团队文档中写清楚，否则后续维护者容易把它误判成重复存储问题。

### 策略对照表

| 配置方式 | 策略 | 行为 |
|---|---|---|
| `sessionStrategy: "memoryReflection"` | memoryReflection | LLM 结构化反思：提取、去重、lifecycle 评分 |
| `sessionStrategy: "systemSessionMemory"` | systemSessionMemory | 简单会话摘要直存 LanceDB（fact/peripheral 层级） |
| `sessionMemory: { enabled: true }` | systemSessionMemory | 旧版简写，等同于上面的 `systemSessionMemory` |
| `sessionStrategy: "none"` 或不设置 | none | 插件 session hook 不启用 |

## 3. 基线检查清单

在开始调检索质量之前，先确认基础集成是通的。

```bash
openclaw config validate
openclaw status
openclaw gateway status
openclaw plugins info memory-lancedb-pro
openclaw hooks list --json
```

至少确认：

- 插件从预期路径加载
- `plugins.slots.memory` 指向 `memory-lancedb-pro`
- 预期 Hook 处于启用状态
- 改完配置后 Gateway 已重启

如果启用了插件侧 session memory，`openclaw hooks list --json` 里应能看到：

- `memory-lancedb-pro-session-memory`

如果目标是插件单写模式，还应同时确认：

- 内置 `session-memory` 已禁用

## 4. 新 Agent 引导检查

新 Agent 首轮真实对话失败时，不要先怀疑检索。先检查 Agent 启动链路。

典型症状：

- `Unknown model: openai-codex/gpt-5.4`

常见根因：

- 新 Agent 没有初始化本地模型/认证索引

建议检查以下文件是否存在：

- `~/.openclaw/agents/<agentId>/agent/models.json`
- `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

并确认该 Agent 至少能先跑通一次普通文本对话，再做记忆相关测试。

工程上可以直接采用这条规则：

- 如果新 Agent 连普通 turn 都跑不通，那么该 Agent 上的 memory 测试结论没有意义

## 5. 检索质量规则

### 短中文关键词必须单独验证

短中文词是混合检索里最常见的假阴性场景之一。

实测经验通常是：

- 唯一代号、完整句子更容易召回
- 短中文词更依赖 BM25 / 词法匹配质量
- 直接降低 `minScore` 能提召回，但常常同时带来明显噪声

推荐调优顺序：

1. 先确认 BM25 / 词法兜底是否有效
2. 再确认 hybrid fusion 是否把强词法命中保留下来
3. 最后再调 `minScore` / `hardMinScore`

不要把“先大幅降阈值”当成默认修复方案。那通常只是把“召回问题”换成了“精度问题”。

### 生命周期排序不能误杀高相关新记忆

如果启用了 lifecycle decay 和 tiering，需要保证：

- 先按相关性裁剪，再施加 lifecycle/time decay
- 新写入的 `working` 记忆不会因为衰减顺序不当，被压到 `hardMinScore` 以下

建议把下面这条作为回归目标：

- 新鲜且高相关的 `working` 记忆必须可召回

## 6. 功能烟测清单

以下检查能覆盖主要闭环。

### CLI 与存储

```bash
openclaw memory-pro stats
openclaw memory-pro list --scope global --limit 5
openclaw memory-pro search "your test keyword" --scope global --limit 5
```

至少验证：

- `stats` 能返回统计信息
- `list` 能看到预期 scope 下的数据
- `search` 对“唯一标识符”和“自然语言查询”都至少有一个稳定命中

### 工具闭环

至少完整测一轮：

- `memory_store`
- `memory_recall`
- `memory_update`
- `memory_forget`
- `memory_list`
- `memory_stats`

### Scope 隔离

至少验证以下方向：

- `main -> main` 命中
- `main -> work` 不命中
- `work -> global` 若设计允许，应命中
- `life -> work` 除非显式授权，否则不命中

### Smart Extraction 稳定性

至少验证三种语义分支：

- `create`
- `merge`
- `skip`

然后再做一组多轮序列：

- `create -> skip -> merge -> skip`

预期结果：

- 库里仍只有一条稳定记忆
- 重复内容被抑制
- 新信息被合并，而不是无限新增重复条目

## 7. 真实 `/new` 会话测试

如果启用了插件侧 session memory，基础烟测后应再做一次真实 `/new` 验证。

重点确认三件事：

1. 活跃 session 确实切换
2. 预期 Hook 确实触发
3. 摘要写到了你期望的存储路径

插件侧的有效证据应表现为：

- 日志里出现“已为上一会话保存 session summary”的记录

如果同时保留内置 session-memory，还应看到内置 workspace/session 摘要产物。

如果内置 session-memory 已禁用，那么“没有看到 workspace session-summary markdown”不能直接判定为插件失败。

## 8. 推荐回归矩阵

每次准备发布、或修改检索 / Hook / 生命周期逻辑后，建议至少跑下面这组回归。

### 集成

- 插件可正常加载
- Gateway 重启后 Hook 注册状态不丢失
- `hooks list` 与预期一致

### 检索

- 唯一标识符召回
- 短中文关键词召回
- 完整句子语义召回
- rerank 服务不可用时的降级路径

### 生命周期

- fresh `working` 记忆仍能召回
- tier 升降不会导致有用记忆被过早过滤

### 提取

- `create`
- `merge`
- `skip`
- 多轮重复抑制

### Session 流程

- `/new` 触发到预期 Hook
- plugin-only 模式不依赖内置 session 文件
- dual-write 模式是显式设计，而不是误配

### Agent 引导

- 新增 Agent 首轮真实对话可成功
- 新 Agent 模型/认证索引完整

## 9. 常见排障模式

### search 返回空，但库里明明有数据

按这个顺序排查：

1. scope 是否错了
2. `minScore` / `hardMinScore` 是否过高
3. BM25 / 词法兜底是否有效
4. rerank endpoint 是否可用
5. lifecycle decay 排序顺序是否合理

### `/new` 看起来没生效

优先检查：

- 插件 `sessionStrategy` 是否设为 `"memoryReflection"` 或 `"systemSessionMemory"`（而非 `"none"`）
- 插件 Hook 是否真的注册成功且有名字
- 改完配置后 Gateway 是否已重启
- 内置 Hook 状态是否符合当前设计

### 调参后召回上去了，但噪声变多

这通常意味着：

- 你用降阈值解决了召回，但牺牲了精度

优先修复顺序建议是：

1. 词法 / BM25 能力
2. hybrid fusion 规则
3. rerank 策略
4. 阈值调整

## 10. 升级与维护说明

如果你对 OpenClaw 安装本体做过本地补丁，请把它视为运行时修复，而不是插件自身的长期保证。

每次执行 `openclaw update` 之后，至少重新检查：

- 新 Agent 引导是否正常
- 新 Agent 的模型 provider 是否能解析
- Hook 注册状态是否仍正确
- `/new` 行为是否符合预期

如果团队依赖这些安装侧补丁，建议把补丁过程整理成独立 patch 或脚本，不要只依赖手工修改。

## 11. 后续文档维护建议

以后凡是修改以下行为之一：

- 检索逻辑
- Hook 注册方式
- 生命周期排序
- session summary 路径

建议同步更新三处内容：

- README 中的用户级摘要
- 本文档
- 对应回归测试

这样可以避免“实现已变，但文档和测试还停留在旧行为”的漂移问题。
