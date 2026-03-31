<div align="center">

# 🧠 memory-lancedb-pro · 🦞OpenClaw Plugin

**[OpenClaw](https://github.com/openclaw/openclaw) エージェント向け AI メモリアシスタント**

*あなたの AI エージェントに本物の記憶力を——セッションを超え、エージェントを超え、時間を超えて。*

LanceDB ベースの OpenClaw 長期メモリプラグイン。好み・意思決定・プロジェクトコンテキストを自動保存し、将来のセッションで自動的に想起します。

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![npm version](https://img.shields.io/npm/v/memory-lancedb-pro)](https://www.npmjs.com/package/memory-lancedb-pro)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

</div>

---

## なぜ memory-lancedb-pro なのか？

ほとんどの AI エージェントは「記憶喪失」です——新しいチャットを始めるたびに、以前の会話内容はすべてリセットされます。

**memory-lancedb-pro** は OpenClaw 向けのプロダクショングレードの長期メモリプラグインです。エージェントを真の **AI メモリアシスタント** に変えます——重要な情報を自動的にキャプチャし、ノイズを自然に減衰させ、適切なタイミングで適切な記憶を呼び出します。手動タグ付けも複雑な設定も不要です。

### AI メモリアシスタントの実際の動作

**メモリなし——毎回ゼロからスタート：**

> **あなた：** 「インデントはタブで、常にエラーハンドリングを追加して。」
> *（次のセッション）*
> **あなた：** 「前に言ったでしょ——タブであってスペースじゃない！」 😤
> *（さらに次のセッション）*
> **あなた：** 「……本当にもう3回目だよ、タブ。あとエラーハンドリングも。」

**memory-lancedb-pro あり——エージェントが学習し記憶する：**

> **あなた：** 「インデントはタブで、常にエラーハンドリングを追加して。」
> *（次のセッション——エージェントが自動的にあなたの好みを想起）*
> **エージェント：** *（黙ってタブインデント＋エラーハンドリングを適用）* ✅
> **あなた：** 「先月なぜ MongoDB ではなく PostgreSQL を選んだんだっけ？」
> **エージェント：** 「2月12日の議論に基づくと、主な理由は……」 ✅

これが **AI メモリアシスタント** の価値です——あなたのスタイルを学び、過去の意思決定を想起し、繰り返し説明することなくパーソナライズされた応答を提供します。

### 他に何ができる？

| | 得られるもの |
|---|---|
| **自動キャプチャ** | エージェントが毎回の会話から学習——手動で `memory_store` を呼ぶ必要なし |
| **スマート抽出** | LLM 駆動の6カテゴリ分類：プロフィール、好み、エンティティ、イベント、ケース、パターン |
| **インテリジェント忘却** | Weibull 減衰モデル——重要な記憶は残り、ノイズは自然に消える |
| **ハイブリッド検索** | ベクトル + BM25 全文検索、クロスエンコーダーリランキングで融合 |
| **コンテキスト注入** | 関連する記憶が各応答前に自動的に浮上 |
| **マルチスコープ分離** | エージェント別、ユーザー別、プロジェクト別のメモリ境界 |
| **任意のプロバイダー** | OpenAI、Jina、Gemini、Ollama、または任意の OpenAI 互換 API |
| **フルツールキット** | CLI、バックアップ、マイグレーション、アップグレード、エクスポート/インポート——本番運用対応 |

---

## クイックスタート

### 方法 A：ワンクリックインストールスクリプト（推奨）

コミュニティが管理する **[セットアップスクリプト](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)** で、インストール・アップグレード・修復を1コマンドで実行：

```bash
curl -fsSL https://raw.githubusercontent.com/CortexReach/toolbox/main/memory-lancedb-pro-setup/setup-memory.sh -o setup-memory.sh
bash setup-memory.sh
```

> スクリプトがカバーするシナリオの完全なリストとその他のコミュニティツールは、以下の [エコシステム](#エコシステム) をご覧ください。

### 方法 B：手動インストール

**OpenClaw CLI 経由（推奨）：**
```bash
openclaw plugins install memory-lancedb-pro@beta
```

**または npm 経由：**
```bash
npm i memory-lancedb-pro@beta
```
> npm を使用する場合、`openclaw.json` の `plugins.load.paths` にプラグインのインストールディレクトリの **絶対パス** を追加する必要があります。これが最も一般的なセットアップの問題です。

`openclaw.json` に以下を追加：

```json
{
  "plugins": {
    "slots": { "memory": "memory-lancedb-pro" },
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "openai-compatible",
            "apiKey": "${OPENAI_API_KEY}",
            "model": "text-embedding-3-small"
          },
          "autoCapture": true,
          "autoRecall": true,
          "smartExtraction": true,
          "extractMinMessages": 2,
          "extractMaxChars": 8000,
          "sessionMemory": { "enabled": false }
        }
      }
    }
  }
}
```

**これらのデフォルト値の理由：**
- `autoCapture` + `smartExtraction` → エージェントが毎回の会話から自動的に学習
- `autoRecall` → 関連する記憶が各応答前に自動注入
- `extractMinMessages: 2` → 通常の2ターン会話で抽出がトリガー
- `sessionMemory.enabled: false` → 初期段階でセッション要約が検索結果を汚染するのを回避

検証と再起動：

```bash
openclaw config validate
openclaw gateway restart
openclaw logs --follow --plain | grep "memory-lancedb-pro"
```

以下が表示されるはずです：
- `memory-lancedb-pro: smart extraction enabled`
- `memory-lancedb-pro@...: plugin registered`

完了！あなたのエージェントは長期メモリを持つようになりました。

<details>
<summary><strong>その他のインストール方法（既存ユーザー、アップグレード）</strong></summary>

**既に OpenClaw を使用中？**

1. `plugins.load.paths` にプラグインの **絶対パス** を追加
2. メモリスロットをバインド：`plugins.slots.memory = "memory-lancedb-pro"`
3. 検証：`openclaw plugins info memory-lancedb-pro && openclaw memory-pro stats`

**v1.1.0 以前からのアップグレード？**

```bash
# 1) バックアップ
openclaw memory-pro export --scope global --output memories-backup.json
# 2) ドライラン
openclaw memory-pro upgrade --dry-run
# 3) アップグレード実行
openclaw memory-pro upgrade
# 4) 検証
openclaw memory-pro stats
```

動作変更とアップグレードの詳細は `CHANGELOG-v1.1.0.md` を参照してください。

</details>

<details>
<summary><strong>Telegram Bot クイックインポート（クリックで展開）</strong></summary>

OpenClaw の Telegram 連携を使用している場合、設定ファイルを手動で編集するより、メイン Bot にインポートコマンドを直接送信するのが最も簡単です。

以下のメッセージを送信してください：

```text
Help me connect this memory plugin with the most user-friendly configuration: https://github.com/CortexReach/memory-lancedb-pro

Requirements:
1. Set it as the only active memory plugin
2. Use Jina for embedding
3. Use Jina for reranker
4. Use gpt-4o-mini for the smart-extraction LLM
5. Enable autoCapture, autoRecall, smartExtraction
6. extractMinMessages=2
7. sessionMemory.enabled=false
8. captureAssistant=false
9. retrieval mode=hybrid, vectorWeight=0.7, bm25Weight=0.3
10. rerank=cross-encoder, candidatePoolSize=12, minScore=0.6, hardMinScore=0.62
11. Generate the final openclaw.json config directly, not just an explanation
```

</details>

---

## エコシステム

memory-lancedb-pro はコアプラグインです。コミュニティがセットアップと日常利用をさらにスムーズにするツールを構築しています：

### セットアップスクリプト——ワンクリックでインストール・アップグレード・修復

> **[CortexReach/toolbox/memory-lancedb-pro-setup](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)**

単なるインストーラーではありません——さまざまな実際のシナリオをインテリジェントに処理します：

| あなたの状況 | スクリプトの動作 |
|---|---|
| 未インストール | 新規ダウンロード → 依存関係インストール → 設定選択 → openclaw.json に書き込み → 再起動 |
| `git clone` でインストール済み、古いコミットで停滞 | 自動で `git fetch` + `checkout` を最新版に → 依存関係再インストール → 検証 |
| 設定に無効なフィールドがある | スキーマフィルターで自動検出し、サポートされていないフィールドを除去 |
| `npm` でインストール済み | git 更新をスキップし、`npm update` の実行を促す |
| 無効な設定で `openclaw` CLI が壊れている | フォールバック：`openclaw.json` ファイルからワークスペースパスを直接読み取り |
| `plugins/` ではなく `extensions/` | 設定またはファイルシステムからプラグインの場所を自動検出 |
| 既に最新版 | ヘルスチェックのみ実行、変更なし |

```bash
bash setup-memory.sh                    # インストールまたはアップグレード
bash setup-memory.sh --dry-run          # プレビューのみ
bash setup-memory.sh --beta             # プレリリース版を含む
bash setup-memory.sh --uninstall        # 設定を元に戻しプラグインを削除
```

内蔵プロバイダープリセット：**Jina / DashScope / SiliconFlow / OpenAI / Ollama**、または任意の OpenAI 互換 API を利用可能。完全な使用方法（`--ref`、`--selfcheck-only` など）は [セットアップスクリプト README](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup) を参照してください。

### Claude Code / OpenClaw Skill——AI ガイド付き設定

> **[CortexReach/memory-lancedb-pro-skill](https://github.com/CortexReach/memory-lancedb-pro-skill)**

この Skill をインストールすると、AI エージェント（Claude Code または OpenClaw）が memory-lancedb-pro のすべての機能を深く理解できるようになります。**「最適な設定を有効にして」** と言うだけで：

- **7ステップのガイド付き設定ワークフロー**、4つのデプロイプランを提供：
  - フルパワー版（Jina + OpenAI）/ コスト削減版（無料の SiliconFlow リランカー）/ シンプル版（OpenAI のみ）/ 完全ローカル版（Ollama、API コストゼロ）
- **全9つの MCP ツール** の正しい使い方：`memory_recall`、`memory_store`、`memory_forget`、`memory_update`、`memory_stats`、`memory_list`、`self_improvement_log`、`self_improvement_extract_skill`、`self_improvement_review` *（フルツールセットには `enableManagementTools: true` が必要——デフォルトのクイックスタート設定では4つのコアツールのみ公開）*
- **よくある落とし穴の回避**：ワークスペースプラグインの有効化、`autoRecall` のデフォルト false、jiti キャッシュ、環境変数、スコープ分離など

**Claude Code へのインストール：**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.claude/skills/memory-lancedb-pro
```

**OpenClaw へのインストール：**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.openclaw/workspace/skills/memory-lancedb-pro-skill
```

---

## 動画チュートリアル

> フルウォークスルー：インストール、設定、ハイブリッド検索の内部構造。

[![YouTube Video](https://img.shields.io/badge/YouTube-Watch%20Now-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
**https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-Watch%20Now-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
**https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│                   index.ts（エントリポイント）              │
│  プラグイン登録 · 設定解析 · ライフサイクルフック              │
└────────┬──────────┬──────────┬──────────┬───────────────┘
         │          │          │          │
    ┌────▼───┐ ┌────▼───┐ ┌───▼────┐ ┌──▼──────────┐
    │ store  │ │embedder│ │retriever│ │   scopes    │
    │ .ts    │ │ .ts    │ │ .ts    │ │    .ts      │
    └────────┘ └────────┘ └────────┘ └─────────────┘
         │                     │
    ┌────▼───┐           ┌─────▼──────────┐
    │migrate │           │noise-filter.ts │
    │ .ts    │           │adaptive-       │
    └────────┘           │retrieval.ts    │
                         └────────────────┘
    ┌─────────────┐   ┌──────────┐
    │  tools.ts   │   │  cli.ts  │
    │(エージェントAPI)│   │ (CLI)    │
    └─────────────┘   └──────────┘
```

> 完全なアーキテクチャの詳細は [docs/memory_architecture_analysis.md](docs/memory_architecture_analysis.md) を参照してください。

<details>
<summary><strong>ファイルリファレンス（クリックで展開）</strong></summary>

| ファイル | 用途 |
| --- | --- |
| `index.ts` | プラグインエントリポイント。OpenClaw Plugin API に登録、設定解析、ライフサイクルフックのマウント |
| `openclaw.plugin.json` | プラグインメタデータ + 完全な JSON Schema 設定宣言 |
| `cli.ts` | CLI コマンド：`memory-pro list/search/stats/delete/delete-bulk/export/import/reembed/upgrade/migrate` |
| `src/store.ts` | LanceDB ストレージレイヤー。テーブル作成 / FTS インデックス / ベクトル検索 / BM25 検索 / CRUD |
| `src/embedder.ts` | Embedding 抽象レイヤー。任意の OpenAI 互換 API プロバイダーに対応 |
| `src/retriever.ts` | ハイブリッド検索エンジン。ベクトル + BM25 → ハイブリッド融合 → リランク → ライフサイクル減衰 → フィルタ |
| `src/scopes.ts` | マルチスコープアクセス制御 |
| `src/tools.ts` | エージェントツール定義：`memory_recall`、`memory_store`、`memory_forget`、`memory_update` + 管理ツール |
| `src/noise-filter.ts` | エージェントの拒否応答、メタ質問、挨拶などの低品質コンテンツをフィルタリング |
| `src/adaptive-retrieval.ts` | クエリがメモリ検索を必要とするかどうかを判定 |
| `src/migrate.ts` | 内蔵 `memory-lancedb` から Pro へのマイグレーション |
| `src/smart-extractor.ts` | LLM 駆動の6カテゴリ抽出、L0/L1/L2 階層ストレージと2段階重複排除対応 |
| `src/decay-engine.ts` | Weibull 伸長指数関数減衰モデル |
| `src/tier-manager.ts` | 3段階昇格/降格：周辺 ↔ ワーキング ↔ コア |

</details>

---

## コア機能

### ハイブリッド検索

```
クエリ → embedQuery() ─┐
                        ├─→ ハイブリッド融合 → リランク → ライフサイクル減衰ブースト → 長さ正規化 → フィルタ
クエリ → BM25 全文 ─────┘
```

- **ベクトル検索** — LanceDB ANN によるセマンティック類似度（コサイン距離）
- **BM25 全文検索** — LanceDB FTS インデックスによる正確なキーワードマッチング
- **ハイブリッド融合** — ベクトルスコアをベースに、BM25 ヒットに重み付きブーストを適用（標準 RRF ではなく、実際の再現率品質に最適化）
- **設定可能な重み** — `vectorWeight`、`bm25Weight`、`minScore`

### クロスエンコーダーリランキング

- **Jina**、**SiliconFlow**、**Voyage AI**、**Pinecone** の組み込みアダプター
- 任意の Jina 互換エンドポイント（例：Hugging Face TEI、DashScope）に対応
- ハイブリッドスコアリング：60% クロスエンコーダー + 40% 元の融合スコア
- グレースフルデグラデーション：API 失敗時にコサイン類似度にフォールバック

### マルチステージスコアリングパイプライン

| ステージ | 効果 |
| --- | --- |
| **ハイブリッド融合** | セマンティック検索と完全一致検索を統合 |
| **クロスエンコーダーリランク** | セマンティックに正確なヒットを上位に昇格 |
| **ライフサイクル減衰ブースト** | Weibull 鮮度 + アクセス頻度 + 重要度 × 信頼度 |
| **長さ正規化** | 長いエントリが結果を支配するのを防止（アンカー：500文字） |
| **ハード最低スコア** | 無関係な結果を除去（デフォルト：0.35） |
| **MMR 多様性** | コサイン類似度 > 0.85 → 降格 |

### スマートメモリ抽出（v1.1.0）

- **LLM 駆動の6カテゴリ抽出**：プロフィール、好み、エンティティ、イベント、ケース、パターン
- **L0/L1/L2 階層ストレージ**：L0（一文の索引）→ L1（構造化サマリー）→ L2（完全な記述）
- **2段階重複排除**：ベクトル類似度プレフィルタ（≥0.7）→ LLM セマンティック判定（CREATE/MERGE/SKIP）
- **カテゴリ対応マージ**：`profile` は常にマージ、`events`/`cases` は追記のみ

### メモリライフサイクル管理（v1.1.0）

- **Weibull 減衰エンジン**：複合スコア = 鮮度 + 頻度 + 内在的価値
- **3段階昇格**：`周辺 ↔ ワーキング ↔ コア`、閾値は設定可能
- **アクセス強化**：頻繁に想起される記憶はより遅く減衰（間隔反復スタイル）
- **重要度変調半減期**：重要な記憶はより遅く減衰

### マルチスコープ分離

- 組み込みスコープ：`global`、`agent:<id>`、`custom:<name>`、`project:<id>`、`user:<id>`
- `scopes.agentAccess` によるエージェントレベルのアクセス制御
- デフォルト：各エージェントが `global` + 自身の `agent:<id>` スコープにアクセス

### 自動キャプチャ＆自動想起

- **自動キャプチャ**（`agent_end`）：会話から好み/事実/決定/エンティティを抽出、重複排除後、1ターンあたり最大3件を保存
- **自動想起**（`before_agent_start`）：`<relevant-memories>` コンテキストを注入（最大3件）

### ノイズフィルタリング＆アダプティブ検索

- 低品質コンテンツをフィルタリング：エージェントの拒否応答、メタ質問、挨拶
- 検索をスキップ：挨拶、スラッシュコマンド、簡単な確認、絵文字
- 強制検索：メモリキーワード（「覚えている」「以前」「前回」）
- CJK 対応の閾値（中国語：6文字、英語：15文字）

---

<details>
<summary><strong>内蔵 <code>memory-lancedb</code> との比較（クリックで展開）</strong></summary>

| 機能 | 内蔵 `memory-lancedb` | **memory-lancedb-pro** |
| --- | :---: | :---: |
| ベクトル検索 | あり | あり |
| BM25 全文検索 | - | あり |
| ハイブリッド融合（ベクトル + BM25） | - | あり |
| クロスエンコーダーリランク（マルチプロバイダー） | - | あり |
| 鮮度ブースト＆時間減衰 | - | あり |
| 長さ正規化 | - | あり |
| MMR 多様性 | - | あり |
| マルチスコープ分離 | - | あり |
| ノイズフィルタリング | - | あり |
| アダプティブ検索 | - | あり |
| 管理 CLI | - | あり |
| セッションメモリ | - | あり |
| タスク対応 Embedding | - | あり |
| **LLM スマート抽出（6カテゴリ）** | - | あり（v1.1.0） |
| **Weibull 減衰 + 階層昇格** | - | あり（v1.1.0） |
| 任意の OpenAI 互換 Embedding | 限定的 | あり |

</details>

---

## 設定

<details>
<summary><strong>完全な設定例</strong></summary>

```json
{
  "embedding": {
    "apiKey": "${JINA_API_KEY}",
    "model": "jina-embeddings-v5-text-small",
    "baseURL": "https://api.jina.ai/v1",
    "dimensions": 1024,
    "taskQuery": "retrieval.query",
    "taskPassage": "retrieval.passage",
    "normalized": true
  },
  "dbPath": "~/.openclaw/memory/lancedb-pro",
  "autoCapture": true,
  "autoRecall": true,
  "retrieval": {
    "mode": "hybrid",
    "vectorWeight": 0.7,
    "bm25Weight": 0.3,
    "minScore": 0.3,
    "rerank": "cross-encoder",
    "rerankApiKey": "${JINA_API_KEY}",
    "rerankModel": "jina-reranker-v3",
    "rerankEndpoint": "https://api.jina.ai/v1/rerank",
    "rerankProvider": "jina",
    "candidatePoolSize": 20,
    "recencyHalfLifeDays": 14,
    "recencyWeight": 0.1,
    "filterNoise": true,
    "lengthNormAnchor": 500,
    "hardMinScore": 0.35,
    "timeDecayHalfLifeDays": 60,
    "reinforcementFactor": 0.5,
    "maxHalfLifeMultiplier": 3
  },
  "enableManagementTools": false,
  "scopes": {
    "default": "global",
    "definitions": {
      "global": { "description": "Shared knowledge" },
      "agent:discord-bot": { "description": "Discord bot private" }
    },
    "agentAccess": {
      "discord-bot": ["global", "agent:discord-bot"]
    }
  },
  "sessionMemory": {
    "enabled": false,
    "messageCount": 15
  },
  "smartExtraction": true,
  "llm": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4o-mini",
    "baseURL": "https://api.openai.com/v1"
  },
  "extractMinMessages": 2,
  "extractMaxChars": 8000
}
```

</details>

<details>
<summary><strong>Embedding プロバイダー</strong></summary>

**任意の OpenAI 互換 Embedding API** で動作：

| プロバイダー | モデル | Base URL | 次元数 |
| --- | --- | --- | --- |
| **Jina**（推奨） | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Voyage** | `voyage-4-lite` / `voyage-4` | `https://api.voyageai.com/v1` | 1024 / 1024 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama**（ローカル） | `nomic-embed-text` | `http://localhost:11434/v1` | プロバイダー依存 |

</details>

<details>
<summary><strong>リランクプロバイダー</strong></summary>

クロスエンコーダーリランキングは `rerankProvider` で複数のプロバイダーをサポート：

| プロバイダー | `rerankProvider` | モデル例 |
| --- | --- | --- |
| **Jina**（デフォルト） | `jina` | `jina-reranker-v3` |
| **SiliconFlow**（無料枠あり） | `siliconflow` | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI** | `voyage` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `bge-reranker-v2-m3` |

任意の Jina 互換リランクエンドポイントも使用可能——`rerankProvider: "jina"` を設定し、`rerankEndpoint` をあなたのサービスに向けてください（例：Hugging Face TEI、DashScope `qwen3-rerank`）。

</details>

<details>
<summary><strong>スマート抽出（LLM）— v1.1.0</strong></summary>

`smartExtraction` が有効（デフォルト：`true`）の場合、プラグインは正規表現ベースのトリガーの代わりに LLM を使用してインテリジェントにメモリを抽出・分類します。

| フィールド | 型 | デフォルト | 説明 |
|-------|------|---------|-------------|
| `smartExtraction` | boolean | `true` | LLM 駆動の6カテゴリ抽出の有効化/無効化 |
| `llm.auth` | string | `api-key` | `api-key` は `llm.apiKey` / `embedding.apiKey` を使用；`oauth` はデフォルトでプラグインスコープの OAuth トークンファイルを使用 |
| `llm.apiKey` | string | *（`embedding.apiKey` にフォールバック）* | LLM プロバイダーの API キー |
| `llm.model` | string | `openai/gpt-oss-120b` | LLM モデル名 |
| `llm.baseURL` | string | *（`embedding.baseURL` にフォールバック）* | LLM API エンドポイント |
| `llm.oauthProvider` | string | `openai-codex` | `llm.auth` が `oauth` の場合に使用する OAuth プロバイダー ID |
| `llm.oauthPath` | string | `~/.openclaw/.memory-lancedb-pro/oauth.json` | `llm.auth` が `oauth` の場合に使用する OAuth トークンファイル |
| `llm.timeoutMs` | number | `30000` | LLM リクエストタイムアウト（ミリ秒） |
| `extractMinMessages` | number | `2` | 抽出がトリガーされる最小メッセージ数 |
| `extractMaxChars` | number | `8000` | LLM に送信される最大文字数 |


OAuth `llm` 設定（既存の Codex / ChatGPT ログインキャッシュを使用して LLM 呼び出しを行う）：
```json
{
  "llm": {
    "auth": "oauth",
    "oauthProvider": "openai-codex",
    "model": "gpt-5.4",
    "oauthPath": "${HOME}/.openclaw/.memory-lancedb-pro/oauth.json",
    "timeoutMs": 30000
  }
}
```

`llm.auth: "oauth"` に関する注意点：

- `llm.oauthProvider` は現在 `openai-codex` です。
- OAuth トークンのデフォルト保存先は `~/.openclaw/.memory-lancedb-pro/oauth.json` です。
- 別の場所に保存したい場合は `llm.oauthPath` を設定してください。
- `auth login` は OAuth ファイルの隣に以前の api-key モードの `llm` 設定のスナップショットを保存し、`auth logout` は利用可能な場合にそのスナップショットを復元します。
- `api-key` から `oauth` への切り替え時、`llm.baseURL` は自動的に引き継がれません。意図的にカスタム ChatGPT/Codex 互換バックエンドを使用する場合のみ、OAuth モードで手動設定してください。

</details>

<details>
<summary><strong>ライフサイクル設定（減衰 + 階層）</strong></summary>

| フィールド | デフォルト | 説明 |
|-------|---------|-------------|
| `decay.recencyHalfLifeDays` | `30` | Weibull 鮮度減衰のベース半減期 |
| `decay.frequencyWeight` | `0.3` | 複合スコアにおけるアクセス頻度の重み |
| `decay.intrinsicWeight` | `0.3` | `重要度 × 信頼度` の重み |
| `decay.betaCore` | `0.8` | `コア` メモリの Weibull ベータ |
| `decay.betaWorking` | `1.0` | `ワーキング` メモリの Weibull ベータ |
| `decay.betaPeripheral` | `1.3` | `周辺` メモリの Weibull ベータ |
| `tier.coreAccessThreshold` | `10` | `コア` に昇格するために必要な最小想起回数 |
| `tier.peripheralAgeDays` | `60` | 古いメモリを降格するための日数閾値 |

</details>

<details>
<summary><strong>アクセス強化</strong></summary>

頻繁に想起されるメモリはより遅く減衰します（間隔反復スタイル）。

設定キー（`retrieval` 内）：
- `reinforcementFactor`（0-2、デフォルト：`0.5`）— `0` に設定すると無効化
- `maxHalfLifeMultiplier`（1-10、デフォルト：`3`）— 実効半減期のハードキャップ

</details>

---

## CLI コマンド

```bash
openclaw memory-pro list [--scope global] [--category fact] [--limit 20] [--json]
openclaw memory-pro search "クエリ" [--scope global] [--limit 10] [--json]
openclaw memory-pro stats [--scope global] [--json]
openclaw memory-pro auth login [--provider openai-codex] [--model gpt-5.4] [--oauth-path /abs/path/oauth.json]
openclaw memory-pro auth status
openclaw memory-pro auth logout
openclaw memory-pro delete <id>
openclaw memory-pro delete-bulk --scope global [--before 2025-01-01] [--dry-run]
openclaw memory-pro export [--scope global] [--output memories.json]
openclaw memory-pro import memories.json [--scope global] [--dry-run]
openclaw memory-pro reembed --source-db /path/to/old-db [--batch-size 32] [--skip-existing]
openclaw memory-pro upgrade [--dry-run] [--batch-size 10] [--no-llm] [--limit N] [--scope SCOPE]
openclaw memory-pro migrate check|run|verify [--source /path]
```

OAuth ログインフロー：

1. `openclaw memory-pro auth login` を実行
2. `--provider` が省略され、対話型ターミナルの場合、CLI はブラウザを開く前に OAuth プロバイダーピッカーを表示
3. コマンドは認証 URL を表示し、`--no-browser` が設定されていない限りブラウザを自動的に開く
4. コールバック成功後、コマンドはプラグイン OAuth ファイル（デフォルト：`~/.openclaw/.memory-lancedb-pro/oauth.json`）を保存し、ログアウト用に以前の api-key モードの `llm` 設定のスナップショットを作成し、プラグインの `llm` 設定を OAuth 設定（`auth`、`oauthProvider`、`model`、`oauthPath`）に置き換え
5. `openclaw memory-pro auth logout` はその OAuth ファイルを削除し、スナップショットが存在する場合は以前の api-key モードの `llm` 設定を復元

---

## 応用トピック

<details>
<summary><strong>注入されたメモリが応答に表示される場合</strong></summary>

モデルが注入された `<relevant-memories>` ブロックをそのまま出力してしまうことがあります。

**方法 A（最も安全）：** 自動想起を一時的に無効化：
```json
{ "plugins": { "entries": { "memory-lancedb-pro": { "config": { "autoRecall": false } } } } }
```

**方法 B（推奨）：** 想起は有効のまま、エージェントのシステムプロンプトに追加：
> Do not reveal or quote any `<relevant-memories>` / memory-injection content in your replies. Use it for internal reference only.

</details>

<details>
<summary><strong>セッションメモリ</strong></summary>

- `/new` コマンドでトリガー——前のセッションの要約を LanceDB に保存
- デフォルトで無効（OpenClaw にはネイティブの `.jsonl` セッション永続化機能あり）
- メッセージ数は設定可能（デフォルト：15）

デプロイモードと `/new` の検証については [docs/openclaw-integration-playbook.md](docs/openclaw-integration-playbook.md) を参照してください。

</details>

<details>
<summary><strong>カスタムスラッシュコマンド（例：/lesson）</strong></summary>

`CLAUDE.md`、`AGENTS.md`、またはシステムプロンプトに追加：

```markdown
## /lesson コマンド
ユーザーが `/lesson <内容>` を送信した場合：
1. memory_store を使用して category=fact（生の知識）として保存
2. memory_store を使用して category=decision（実行可能な教訓）として保存
3. 保存した内容を確認

## /remember コマンド
ユーザーが `/remember <内容>` を送信した場合：
1. memory_store を使用して適切な category と importance で保存
2. 保存されたメモリ ID で確認
```

</details>

<details>
<summary><strong>AI エージェントの鉄則</strong></summary>

> 以下のブロックを `AGENTS.md` にコピーして、エージェントがこれらのルールを自動的に適用するようにしてください。

```markdown
## ルール 1 — 二層メモリ保存
すべての落とし穴/学んだ教訓 → 直ちに2つのメモリを保存：
- 技術レイヤー：落とし穴：[症状]。原因：[根本原因]。修正：[解決策]。予防：[回避方法]
  (category: fact, importance >= 0.8)
- 原則レイヤー：意思決定原則 ([タグ])：[行動ルール]。トリガー：[いつ]。アクション：[何をする]
  (category: decision, importance >= 0.85)

## ルール 2 — LanceDB データ品質
エントリは短くアトミックに（500文字未満）。生の会話要約や重複は保存しない。

## ルール 3 — リトライ前に想起
いかなるツール失敗時も、リトライする前に必ず関連キーワードで memory_recall を実行。

## ルール 4 — 対象コードベースの確認
変更前に、操作対象が memory-lancedb-pro なのか内蔵 memory-lancedb なのかを確認。

## ルール 5 — プラグインコード変更後に jiti キャッシュをクリア
plugins/ 配下の .ts ファイルを変更した後、openclaw gateway restart の前に必ず rm -rf /tmp/jiti/ を実行。
```

</details>

<details>
<summary><strong>データベーススキーマ</strong></summary>

LanceDB テーブル `memories`：

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `id` | string (UUID) | 主キー |
| `text` | string | メモリテキスト（FTS インデックス付き） |
| `vector` | float[] | Embedding ベクトル |
| `category` | string | ストレージカテゴリ：`preference` / `fact` / `decision` / `entity` / `reflection` / `other` |
| `scope` | string | スコープ識別子（例：`global`、`agent:main`） |
| `importance` | float | 重要度スコア 0-1 |
| `timestamp` | int64 | 作成タイムスタンプ（ミリ秒） |
| `metadata` | string (JSON) | 拡張メタデータ |

v1.1.0 の一般的な `metadata` キー：`l0_abstract`、`l1_overview`、`l2_content`、`memory_category`、`tier`、`access_count`、`confidence`、`last_accessed_at`

> **カテゴリに関する注意：** トップレベルの `category` フィールドは6つのストレージカテゴリを使用します。スマート抽出の6カテゴリセマンティックラベル（`profile` / `preferences` / `entities` / `events` / `cases` / `patterns`）は `metadata.memory_category` に保存されます。

</details>

<details>
<summary><strong>トラブルシューティング</strong></summary>

### "Cannot mix BigInt and other types"（LanceDB / Apache Arrow）

LanceDB 0.26+ では、一部の数値カラムが `BigInt` として返されることがあります。**memory-lancedb-pro >= 1.0.14** にアップグレードしてください——プラグインは算術演算の前に `Number(...)` で値を変換するようになっています。

</details>

---

## ドキュメント

| ドキュメント | 説明 |
| --- | --- |
| [OpenClaw 統合プレイブック](docs/openclaw-integration-playbook.md) | デプロイモード、検証、リグレッションマトリックス |
| [メモリアーキテクチャ分析](docs/memory_architecture_analysis.md) | 完全なアーキテクチャ詳細解説 |
| [CHANGELOG v1.1.0](docs/CHANGELOG-v1.1.0.md) | v1.1.0 の動作変更とアップグレード根拠 |
| [ロングコンテキストチャンキング](docs/long-context-chunking.md) | 長文ドキュメントのチャンキング戦略 |

---

## Beta：スマートメモリ v1.1.0

> ステータス：Beta——`npm i memory-lancedb-pro@beta` でインストール可能。`latest` を使用している安定版ユーザーには影響しません。

| 機能 | 説明 |
|---------|-------------|
| **スマート抽出** | LLM 駆動の6カテゴリ抽出、L0/L1/L2 メタデータ対応。無効時は正規表現にフォールバック。 |
| **ライフサイクルスコアリング** | Weibull 減衰を検索に統合——高頻度・高重要度のメモリが上位にランク。 |
| **階層管理** | 3段階システム（コア → ワーキング → 周辺）、自動昇格/降格。 |

フィードバック：[GitHub Issues](https://github.com/CortexReach/memory-lancedb-pro/issues) · 元に戻す：`npm i memory-lancedb-pro@latest`

---

## 依存関係

| パッケージ | 用途 |
| --- | --- |
| `@lancedb/lancedb` ≥0.26.2 | ベクトルデータベース（ANN + FTS） |
| `openai` ≥6.21.0 | OpenAI 互換 Embedding API クライアント |
| `@sinclair/typebox` 0.34.48 | JSON Schema 型定義 |

---

## コントリビューター

<p>
<a href="https://github.com/win4r"><img src="https://avatars.githubusercontent.com/u/42172631?v=4" width="48" height="48" alt="@win4r" /></a>
<a href="https://github.com/kctony"><img src="https://avatars.githubusercontent.com/u/1731141?v=4" width="48" height="48" alt="@kctony" /></a>
<a href="https://github.com/Akatsuki-Ryu"><img src="https://avatars.githubusercontent.com/u/8062209?v=4" width="48" height="48" alt="@Akatsuki-Ryu" /></a>
<a href="https://github.com/JasonSuz"><img src="https://avatars.githubusercontent.com/u/612256?v=4" width="48" height="48" alt="@JasonSuz" /></a>
<a href="https://github.com/Minidoracat"><img src="https://avatars.githubusercontent.com/u/11269639?v=4" width="48" height="48" alt="@Minidoracat" /></a>
<a href="https://github.com/furedericca-lab"><img src="https://avatars.githubusercontent.com/u/263020793?v=4" width="48" height="48" alt="@furedericca-lab" /></a>
<a href="https://github.com/joe2643"><img src="https://avatars.githubusercontent.com/u/19421931?v=4" width="48" height="48" alt="@joe2643" /></a>
<a href="https://github.com/AliceLJY"><img src="https://avatars.githubusercontent.com/u/136287420?v=4" width="48" height="48" alt="@AliceLJY" /></a>
<a href="https://github.com/chenjiyong"><img src="https://avatars.githubusercontent.com/u/8199522?v=4" width="48" height="48" alt="@chenjiyong" /></a>
</p>

全リスト：[Contributors](https://github.com/CortexReach/memory-lancedb-pro/graphs/contributors)

## Star 履歴

<a href="https://star-history.com/#CortexReach/memory-lancedb-pro&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&theme=dark&transparent=true" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&transparent=true" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&transparent=true" />
  </picture>
</a>

## ライセンス

MIT

---

## WeChat QR コード

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
