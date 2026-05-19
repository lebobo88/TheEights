# ADR-0002 — LadybugDB as the default graph driver, Kuzu 0.11.x as fallback

**Status:** Accepted (2026-05-18)

## Context

The architecture requires an embedded, single-file property graph DB with a Cypher subset so we don't run Neo4j or Memgraph as a service. The natural pick was Kuzu — but **Kuzu was acquired by Apple in Feb 2026 and the upstream repo was archived in October 2025**, leaving 0.11.x as the last public release.

## Decision

Default to **LadybugDB** (active fork by Arun Sharma, drop-in compatible). Ship a fallback driver for upstream Kuzu 0.11.x for users who already have it installed. Abstract both behind a single `GraphStore` interface.

## Rationale

- LadybugDB keeps the Cypher subset, single-file storage, vector + FTS extensions, and the Node bindings we need.
- Single-writer constraint is fine for a single-process daemon (which we are).
- Forward maintenance signal: active development is on the fork, not the archive.

## Alternatives considered

- **Vela-Engineering/kuzu fork** — adds multi-writer concurrency. Overkill for v1's single-daemon model; revisit if we move to multi-process.
- **Neo4j / Memgraph** — violates "no service process" constraint.
- **RDF / Oxigraph** — wrong shape for the property-graph audit model.

## Consequences

- `daemon/src/stores/graph.ts` targets the LadybugDB binding by default; env flag `EIGHTS_GRAPH_DRIVER=kuzu` selects the fallback.
- Cypher dialect is pinned to the intersection of LadybugDB + Kuzu 0.11.x.
- Single-writer enforced by a write queue in the engine layer.
