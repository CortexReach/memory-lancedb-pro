# Silra.cn Provider Configuration

## Overview

Silra.cn provides OpenAI-compatible APIs for users in China mainland. This configuration guide shows how to integrate Silra.cn with memory-lancedb-pro.

## Prerequisites

1. **Get API Key**: Sign up at https://silra.cn/console/api-key
2. **Install memory-lancedb-pro**: Follow the main installation guide
3. **Verify Connectivity**: Test API access from your network

## Configuration Plans

### Plan A — Full Power (Recommended)

All services through Silra.cn:

```json
{
  "embedding": {
    "provider": "silra",
    "apiKey": "${SILRA_API_KEY}",
    "model": "text-embedding-v4",
    "baseUrl": "https://api.silra.cn/v1"
  },
  "llm": {
    "provider": "silra",
    "apiKey": "${SILRA_API_KEY}",
    "model": "qwen3-8b",
    "baseUrl": "https://api.silra.cn/v1"
  },
  "rerank": {
    "provider": "silra",
    "apiKey": "${SILRA_API_KEY}",
    "model": "bge-reranker-v2-m3",
    "baseUrl": "https://api.silra.cn/v1"
  }
}
```

**Features:**
- ✅ Hybrid retrieval (Vector + BM25)
- ✅ Cross-encoder reranking
- ✅ Smart Extraction with LLM
- ✅ Low latency in China (~50ms)

**Cost:** All paid (competitive China domestic pricing)

---

### Plan B — Budget (Free Reranker)

Silra for embedding + LLM, SiliconFlow for reranker:

```json
{
  "embedding": {
    "provider": "silra",
    "apiKey": "${SILRA_API_KEY}",
    "model": "text-embedding-v4",
    "baseUrl": "https://api.silra.cn/v1"
  },
  "llm": {
    "provider": "silra",
    "apiKey": "${SILRA_API_KEY}",
    "model": "qwen3-8b",
    "baseUrl": "https://api.silra.cn/v1"
  },
  "rerank": {
    "provider": "siliconflow",
    "apiKey": "${SILICONFLOW_API_KEY}",
    "model": "BAAI/bge-reranker-v2-m3",
    "baseUrl": "https://api.siliconflow.cn/v1"
  }
}
```

**Features:**
- ✅ Hybrid retrieval
- ✅ Cross-encoder reranking (free tier)
- ✅ Smart Extraction
- ✅ Lower cost

**Cost:** Embedding + LLM paid, Reranker free tier available

**Get Keys:**
- Silra: https://silra.cn/console/api-key
- SiliconFlow: https://cloud.siliconflow.cn/account/ak

---

### Plan C — Simple (Embedding + LLM Only)

No reranking, minimal configuration:

```json
{
  "embedding": {
    "provider": "silra",
    "apiKey": "${SILRA_API_KEY}",
    "model": "text-embedding-v4",
    "baseUrl": "https://api.silra.cn/v1"
  },
  "llm": {
    "provider": "silra",
    "apiKey": "${SILRA_API_KEY}",
    "model": "qwen3-8b",
    "baseUrl": "https://api.silra.cn/v1"
  },
  "rerank": null
}
```

**Features:**
- ✅ Vector + BM25 fusion
- ❌ No cross-encoder reranking
- ✅ Smart Extraction
- ✅ Simplest setup

**Cost:** Embedding + LLM paid

---

## Environment Variables

Set these in your environment or `.env` file:

```bash
# Required
export SILRA_API_KEY="sk-xxxxxxxxxxxxxxxx"

# Optional (defaults shown)
export SILRA_BASE_URL="https://api.silra.cn/v1"
export SILRA_EMBEDDING_MODEL="text-embedding-v4"
export SILRA_LLM_MODEL="qwen3-8b"
export SILRA_RERANK_MODEL="bge-reranker-v2-m3"
```

## Testing

### Test API Key

```bash
curl https://api.silra.cn/v1/models \
  -H "Authorization: Bearer $SILRA_API_KEY" \
  | jq
```

### Test Embedding

```bash
curl https://api.silra.cn/v1/embeddings \
  -H "Authorization: Bearer $SILRA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-v4","input":["Hello, world!"]}' \
  | jq '.data[0].embedding | length'
```

Expected output: `1024` (embedding dimensions)

### Test LLM

```bash
curl https://api.silra.cn/v1/chat/completions \
  -H "Authorization: Bearer $SILRA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-8b","messages":[{"role":"user","content":"Hello!"}]}' \
  | jq '.choices[0].message.content'
```

### Test Reranker

```bash
curl https://api.silra.cn/v1/rerank \
  -H "Authorization: Bearer $SILRA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"bge-reranker-v2-m3",
    "query":"AI memory",
    "documents":["Machine learning","Vector database","Chatbot"]
  }' \
  | jq '.results'
```

## Troubleshooting

### Connection Timeout

**Symptom:** Request timeout after 30s

**Solution:**
```bash
# Check network connectivity
curl -v https://api.silra.cn/v1/models

# Check firewall settings
# Ensure outbound HTTPS (port 443) is allowed
```

### API Key Invalid

**Symptom:** HTTP 401 Unauthorized

**Solution:**
```bash
# Verify API key format
echo $SILRA_API_KEY | wc -c  # Should be ~32 characters

# Test with curl
curl https://api.silra.cn/v1/models \
  -H "Authorization: Bearer $SILRA_API_KEY"
```

### Rate Limiting

**Symptom:** HTTP 429 Too Many Requests

**Solution:**
- Implement exponential backoff (already built into provider)
- Contact Silra support for quota increase
- Reduce request frequency

### Model Not Found

**Symptom:** HTTP 404 Model not found

**Solution:**
```bash
# List available models
curl https://api.silra.cn/v1/models \
  -H "Authorization: Bearer $SILRA_API_KEY" \
  | jq '.data[].id'

# Update config to use available model
```

## Performance Benchmarks

| Operation | Latency (China) | Latency (Global) |
|-----------|-----------------|------------------|
| Embedding (100 docs) | ~800ms | ~3000ms |
| LLM Generation | ~1500ms | ~4000ms |
| Rerank (50 docs) | ~500ms | ~2000ms |

*Tested from Shanghai, China. Global latency varies by region.*

## Cost Comparison

| Service | Silra.cn | OpenAI | Jina |
|---------|----------|--------|------|
| Embedding (1M tokens) | ~$0.50 | ~$0.10 | ~$0.20 |
| LLM (1M tokens) | ~$2.00 | ~$0.50 | N/A |
| Rerank (1K queries) | ~$0.50 | N/A | ~$0.50 |

*Prices approximate, check official pricing for latest rates.*

## Support

- **Documentation**: https://docs.silra.cn
- **Console**: https://silra.cn/console
- **Support Email**: support@silra.cn
- **Discord**: OpenClaw Community

## Migration from Other Providers

### From OpenAI

```json
// Before (OpenAI)
{
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small"
  }
}

// After (Silra)
{
  "embedding": {
    "provider": "silra",
    "model": "text-embedding-v4"
  }
}
```

### From Jina

```json
// Before (Jina)
{
  "embedding": {
    "provider": "jina",
    "model": "jina-embeddings-v3"
  }
}

// After (Silra)
{
  "embedding": {
    "provider": "silra",
    "model": "text-embedding-v4"
  }
}
```

## Security Best Practices

1. **Never commit API keys** to version control
2. **Use environment variables** or secret management
3. **Rotate keys regularly** (every 90 days recommended)
4. **Monitor usage** in Silra console
5. **Set usage alerts** to prevent unexpected charges

---

**Last Updated**: 2026-04-14  
**Version**: 1.0.0
