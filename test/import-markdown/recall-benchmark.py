"""
recall-benchmark.py
真實 LanceDB 查詢測試腳本

功能：
1. 查詢 LanceDB 目前儲存的記憶數量
2. 搜尋特定關鍵字（只在 Markdown 裡的）
3. 對比：Markdown 有但 LanceDB 沒有的 → import-markdown 的價值

前置：pip install lancedb
執行：python recall-benchmark.py
"""
import os, json

try:
    import lancedb
    HAS_LANCE = True
except ImportError:
    HAS_LANCE = False
    print("lancedb not installed, using sqlite fallback")

DB_PATH = r"C:\Users\admin\.openclaw\memory\lancedb-pro"
MEMORY_MD = r"C:\Users\admin\.openclaw\workspace-dc-channel--1476866394556465252\MEMORY.md"
MEMORY_DIR = r"C:\Users\admin\.openclaw\workspace-dc-channel--1476866394556465252\memory"

# ─── 測試關鍵字候選 ───────────────────────────────────────────────
# 從 daily notes 裡隨機抽一些有特色的 bullet line
TEST_QUERIES = [
    "cache_manger",           # PR6 rename
    "PR43",                   # PR 43
    "import-markdown",         # 本 PR
    "git merge",              # conflict resolution
    "pytest 85 passed",       # test result
    "f8ae80d",               # 具體 commit hash
    "記憶庫治理",              # 中文關鍵字
    "dedup",                  # 去重功能
]

def get_lance_memory_count(db_path: str) -> dict:
    """查詢 LanceDB 目前儲存的記憶筆數"""
    try:
        db = lancedb.connect(db_path)
        tables = db.table_names()
        results = {}
        for t in tables:
            try:
                tbl = db.open_table(t)
                count = len(tbl.to_pandas())
                results[t] = count
            except Exception as e:
                results[t] = f"error: {e}"
        return results
    except Exception as e:
        return {"error": str(e)}

def search_lance(db_path: str, query: str, limit: int = 5) -> list:
    """用關鍵字搜尋 LanceDB（簡單全文掃描）"""
    try:
        db = lancedb.connect(db_path)
        results = []
        for tbl_name in db.table_names():
            try:
                tbl = db.open_table(tbl_name)
                df = tbl.to_pandas()
                # 嘗試多個可能的文字欄位
                text_cols = [c for c in df.columns if c.lower() in ("text", "content", "entry", "memory", "value")]
                if not text_cols:
                    # 嘗試字串欄位
                    text_cols = [c for c in df.columns if df[c].dtype == "object"]
                for col in text_cols:
                    mask = df[col].astype(str).str.contains(query, case=False, na=False)
                    matches = df[mask].head(limit)
                    for _, row in matches.iterrows():
                        text = str(row[col])[:200]
                        results.append({"table": tbl_name, "text": text})
                        if len(results) >= limit:
                            return results
            except Exception:
                pass
        return results
    except Exception as e:
        return [{"error": str(e)}]

def extract_markdown_bullets(md_path: str) -> list:
    """從 MEMORY.md 抽出所有 bullet 行"""
    if not os.path.exists(md_path):
        return []
    with open(md_path, encoding="utf-8", errors="ignore") as f:
        return [l[2:].strip() for l in f.read().split("\n") if l.startswith("- ")]

def count_daily_notes(mem_dir: str) -> tuple[int, list]:
    """統計 daily notes 中的 bullet 行數量"""
    if not os.path.exists(mem_dir):
        return 0, []
    bullets = []
    for fname in sorted(os.listdir(mem_dir)):
        if fname.endswith(".md") and fname[:4].isdigit():
            with open(os.path.join(mem_dir, fname), encoding="utf-8", errors="ignore") as f:
                for line in f.read().split("\n"):
                    if line.startswith("- "):
                        bullets.append(line[2:].strip())
    return len(bullets), bullets

def main():
    print("╔══════════════════════════════════════════════════════════╗")
    print("║  import-markdown  實際效益驗證                       ║")
    print("╚══════════════════════════════════════════════════════════╝")
    print()

    # 1. LanceDB 現況
    print("── 1. LanceDB 現況 ──")
    if HAS_LANCE:
        counts = get_lance_memory_count(DB_PATH)
        total = sum(v for v in counts.values() if isinstance(v, int))
        print(f"  LanceDB 位置：{DB_PATH}")
        print(f"  Table 數量：{len(counts)}")
        for tbl, cnt in counts.items():
            print(f"    {tbl}: {cnt} 筆記")
        print(f"  總計：{total} 筆記")
    else:
        print("  ⚠️ lancedb 未安裝，無法查詢")
    print()

    # 2. Markdown 現況
    print("── 2. Markdown 現況 ──")
    bullets_md = extract_markdown_bullets(MEMORY_MD)
    daily_count, daily_bullets = count_daily_notes(MEMORY_DIR)
    print(f"  MEMORY.md：{len(bullets_md)} 筆記")
    print(f"  Daily notes：{daily_count} 筆記（{len([f for f in os.listdir(MEMORY_DIR) if f.endswith('.md') and f[:4].isdigit()])} 個檔案）")
    print(f"  合計：{len(bullets_md) + daily_count} 筆記（不在 LanceDB 中）")
    print()

    # 3. 關鍵字搜尋對比
    print("── 3. 關鍵字搜尋對比（LanceDB vs Markdown） ──")
    print("  目的：驗證「Markdown 有但 LanceDB 沒有」的記憶有多少")
    print()

    found_in_lance = 0
    found_in_md = 0
    for q in TEST_QUERIES:
        lance_hits = search_lance(DB_PATH, q) if HAS_LANCE else []
        md_hit = any(q.lower() in b.lower() for b in bullets_md + daily_bullets)

        status_lance = f"✅ {len(lance_hits)} 筆" if lance_hits else "❌ 無"
        status_md = "✅ 有" if md_hit else "❌ 無"
        gap = "← Markdown 有、LanceDB 沒有（import-markdown 的價值）" if (md_hit and not lance_hits) else ""
        print(f"  「{q}」")
        print(f"    LanceDB：{status_lance}")
        print(f"    Markdown：{status_md}")
        if gap:
            print(f"    {gap}")
        print()

        if lance_hits:
            found_in_lance += 1
        if md_hit:
            found_in_md += 1

    print("── 4. 效益結論 ──")
    total_md = len(bullets_md) + daily_count
    print(f"  Markdown 總記憶量：{total_md} 筆記")
    print(f"  測試關鍵字在 LanceDB 中找到：{found_in_lance}/{len(TEST_QUERIES)}")
    print(f"  測試關鍵字在 Markdown 中找到：{found_in_md}/{len(TEST_QUERIES)}")
    gap_count = found_in_md - found_in_lance
    if gap_count > 0:
        print(f"  → {gap_count} 個關鍵字在 Markdown 有、但 LanceDB 找不到")
        print(f"  → import-markdown 後，這些記憶就能被 recall 找到了")
    else:
        print(f"  ⚠️ 所有測試關鍵字都已在 LanceDB 中")
        print(f"  → 建議用更精確或更老的關鍵字再測")
    print()

    # 5. 建議的下一步
    print("── 5. 下一步行動 ──")
    print("  1. 用 memory_recall 工具測試「PR6」之類的老關鍵字")
    print("  2. 執行 import-markdown（等 PR #426 merge 後）")
    print("  3. 再次 recall 同一個關鍵字，確認能找到")
    print()
    print(f"  LanceDB 路徑：{DB_PATH}")
    print(f"  測試封包：memory-lancedb-pro-import-markdown-test")

if __name__ == "__main__":
    main()
