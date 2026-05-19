# ADR-0005 — SSGM gate set on memory writes

**Status:** Accepted (2026-05-18)
**Reference:** arxiv 2603.11768 (Governing Evolving Memory in LLM Agents).

## Decision

Every `eights.memory.add` and `eights.memory.consolidate` call passes through **three SSGM gates** before committing to durable storage. None has an open-source reference impl as of May 2026, so we build them.

### Gate 1 — Consistency verification
For each candidate memory, look up existing memories in the same `(type, scopes)` slice that share entity overlap. Reject (or require HITL) if the candidate contradicts a memory marked `confidence > 0.8` without an explicit `supersedes` reference.

### Gate 2 — Temporal decay sanity
Apply a per-type half-life. Decayed memories don't disappear; they drop confidence. The gate refuses to commit a candidate that resurrects a previously-superseded memory unless `evidence_memory_ids` is supplied and verified.

### Gate 3 — Dynamic access control
Verify that the write does not broaden the access scope of any referenced memory. Verify that the actor's scope set is a superset of every read on which the candidate depends.

A 4th implicit gate ("safety filter immutability") lives in the Evolution Engine: any resource with `risk_class=critical` is `frozen` and cannot be modified, period.

## Rationale

Memory corruption is the highest-blast-radius failure mode in self-evolving agentic systems. The SSGM gate set is the most cited mitigation pattern; this ADR fixes the concrete shape we implement.

## Consequences

- All three gates produce structured rejection reasons that flow into the audit graph.
- Cost: a write incurs a vector search + a graph lookup before commit. Mitigated by batching and a small bloom filter over entity hashes.
- Failed gates are auditable events, not silent drops.
