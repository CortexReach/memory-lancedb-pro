# Lock Management

`memory-lancedb-pro` protects LanceDB writes with a cross-process file lock based on
`proper-lockfile`. The lock target is `.memory-write.lock` inside the configured
database directory, and the transient lock artifact is `.memory-write.lock.lock`.

## When The Built-In File Lock Is Enough

Use the default file lock for:

- a single OpenClaw gateway process
- multiple agents writing through the same gateway process
- multiple local processes that share the same local filesystem path

The store also batches concurrent `bulkStore()` calls before taking the write
lock, so high-throughput auto-capture paths avoid one lock acquisition per
memory item.

## Multi-Machine Or Container Deployments

The file lock only coordinates processes that can see the same lock target on a
filesystem with reliable lock-directory semantics. For multi-machine,
multi-container, or network-filesystem deployments, verify this before relying on
the default lock:

```bash
openclaw memory-pro stats --json
ls -la "$(dirname "$MEMORY_LANCEDB_PRO_DB_PATH")"
```

If each process has its own local database directory, no lock can protect writes
across those processes because they are not writing to the same LanceDB store.

## Redis Status

Redis is not required for single-gateway or same-filesystem deployments. The
plugin enables Redis locking when `locking.redis.enabled` is true, when
`redisUrl`/`locking.redis.url` is set, or when `MEMORY_LANCEDB_REDIS_URL` is
present in that process environment. Every writer that shares a LanceDB store
must use the same Redis lock configuration; mixing Redis-locked writers with
writers that only use the local file lock creates separate lock domains.

When Redis locking is enabled, every LanceDB write and index-maintenance
mutation uses the Redis lock domain. Redis connection or lock-client
availability failures fail writes closed instead of falling back to a local file
lock.

If you operate multiple independent writers, prefer one of these approaches:

- route writes through one OpenClaw gateway
- place the LanceDB directory on a filesystem whose lock-directory behavior is
  known to work with `proper-lockfile`
- add an explicit external write coordinator before enabling multiple writers

Do not use a no-op lock fallback for write paths. If an external coordinator is
required but unavailable, fail the write and retry after the coordinator is
healthy rather than switching that writer into a separate local lock domain.

## Troubleshooting Lock Contention

Symptoms of lock contention include slow memory writes, delayed auto-capture, or
warnings about stale `.memory-write.lock.lock` artifacts.

Checklist:

1. Confirm all writers use the same `dbPath`.
2. Confirm old `.memory-write.lock.lock` artifacts are cleaned up by the store.
3. Prefer `bulkStore()` for batch writes instead of repeated `store()` calls.
4. Avoid multiple independent gateway processes writing to separate copies of the
   same intended memory corpus.
