# ADR-0001 — sqlite-vec over pgvector for v1

**Status:** Accepted (2026-05-18)
**Context:** local-first, single-user daemon on Windows.

## Decision

Use **sqlite-vec** (Alex Garcia, 0.1.9 as of Mar 2026) as the vector store for v1. Defer pgvector to a future cloud profile behind the same `VectorStore` interface.

## Rationale

- pgvector requires a running Postgres server, which violates the "local single-user, no extra processes" constraint locked at /goal time.
- sqlite-vec is embeddable in the same SQLite connection that holds episodic + audit data → one file, one process, one lock.
- Brute-force KNN comfortably handles the laptop-scale memory volumes we expect for v1 (sub-100ms on hundreds of thousands of rows; an HNSW-style index is in dev upstream).
- Loadable from `better-sqlite3` (Node) and `sqlite_vec` (Python) — both adapter paths covered.

## Trade-offs

- No ANN index in core today → revisit at ~500k embeddings or if p95 search >100ms.
- libSQL / Turso's native vector type is cleaner SQL but couples us to a SQLite fork. Not worth the lock-in.
- sqlite-vss is abandoned; not a candidate.

## Consequences

- `daemon/src/stores/vec.ts` wraps the `vec0` virtual table API.
- The `VectorStore` interface is the swap point; a `PgVectorStore` lands in v2 for cloud.
