# OpenCode 插件开发说明（memory-lancedb-pro）

本目录包含当前仓库的 OpenCode 插件实现。
插件提供基于 LanceDB + Embedding 的长期记忆工具。

作为开源仓库，本目录文档与仓库内配置均使用示范值。
与机器环境相关的真实配置应放在本机 OpenCode 安装目录中（不入库）。

## 文件说明

- `OpenCode/memory-lancedb-pro.ts`：插件实现入口。
- `OpenCode/config.example.json`：运行配置模板。
- `OpenCode/config.json`：仓库示范运行配置。
- `.opencode/plugins/memory-lancedb-pro.ts`：项目级插件加载入口。
- `.opencode/package.json`：项目级插件依赖。

## 工具列表

插件注册以下自定义工具：

- `memory_recall`
- `memory_store`
- `memory_forget`
- `memory_update`
- `memory_list`
- `memory_stats`

默认行为：按项目路径隔离记忆。插件会基于当前 worktree 生成稳定的
`project:<path-hash>` scope，在启动时检查该 scope，不存在则自动创建。

仅当用户显式传入 `scope` 参数时，才会切换到其他 scope。

插件还会在 `session.idle` 阶段自动抽取高价值记忆，只写入重点内容：
架构决策、需求约束、关键代码/大类结构；闲聊和低价值文本会被过滤。

存储采用模型门控：候选记忆会交给当前 OpenCode 模型判定“存/不存”，
并在提示词中强偏向“类继承/implements 关系”和“整体架构设计”。

召回策略采用“高频触发 + 精确过滤”：先尽量多取候选，再经过噪声过滤和
精确率过滤后返回，避免无关结果。

若存在文件来源信息，`memory_recall`/`memory_list` 会附带文件与语言元信息
（例如 `files:src/core/retriever.rs;lang:rust`）。

## 安装模式

### 1）项目内模式

在本仓库根目录启动 OpenCode 时，会自动加载 `.opencode/plugins/`。

安装项目级依赖：

```bash
cd .opencode && bun install
```

### 2）全局模式（`~/.config/opencode`）

如果希望任意目录下都可用此插件，可在
`~/.config/opencode/plugins/` 放置加载文件，并在
`~/.config/opencode/opencode.json` 的 `plugin` 中注册。

`opencode.json` 示例：

```json
{
  "plugin": [
    "~/.config/opencode/plugins/memory-lancedb-pro.ts"
  ]
}
```

## 配置说明

1. 先从模板复制配置：

```bash
cp OpenCode/config.example.json OpenCode/config.json
```

2. 编辑 `OpenCode/config.json`。

模板默认使用 Ollama 兼容接口：

- `embedding.apiKey`: `ollama`
- `embedding.baseURL`: `http://localhost:11434/v1`
- `embedding.model`: `nomic-embed-text`
- `embedding.dimensions`: `768`

## 配置加载规则

默认读取：

- `OpenCode/config.json`

可通过环境变量覆盖：

- `OPENCODE_MEMORY_LANCEDB_PRO_CONFIG=/absolute/or/relative/path.json`

若使用相对路径，将以项目 worktree 根目录为基准解析。

## 备注

- `enableManagementTools` 控制 `memory_list` 与 `memory_stats` 是否可用。
- 未配置 `embedding.apiKey` 时，默认回退为 `ollama`。
- 未配置 `embedding.baseURL` 时，默认回退为 `http://localhost:11434/v1`。
- 未配置 `embedding.model` 时，默认回退为 `nomic-embed-text`。
- LanceDB 默认数据目录：`~/.opencode/memory/lancedb-pro`。

## 故障排查

- 如果加载 LanceDB 时出现 `Bus error (core dumped)`，优先检查原生包来源。
  某些镜像源可能提供了不兼容的原生二进制，建议切回官方 npm 源重装：

```bash
npm install @lancedb/lancedb@^0.26.2 --registry=https://registry.npmjs.org
```
