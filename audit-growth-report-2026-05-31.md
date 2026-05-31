# Audit Ledger Growth Report — 2026-05-31

Investigation accompanying the connectivity fix (Hydra gateway timing out on the
eights backend). The slow boot was caused by `verifyChain()` scaling with ledger
size; this report covers **why the ledger got so large** (Part C of the plan).

## Headline numbers

- `~/.eights/state.db`: **2.2 GB**
- `events` table: **658,280 rows**
- `~/.eights/events/*.jsonl`: **418 MB**

## What's in the ledger

| Event kind          | Count   | Share |
|---------------------|---------|-------|
| `memory.add`        | 650,317 | 98.8% |
| `memory.add.rejected` | 5,074 |  0.8% |
| `evolution.register`  | 1,597 |  0.2% |
| `constitution.get`    |   864 |       |
| `miner.run`           |   263 |       |
| everything else       |  ~165 |       |

By actor / project:

| actor_id              | count   | project        |
|-----------------------|---------|----------------|
| `pp-watcher`          | 631,591 | pair-programmer (96%) |
| `eights.memory-steward` | 18,102 | TheEights     |
| `miner`               |   5,939 | TheEights      |
| all others            |  ~2,600 | mixed          |

> Note: read operations (`memory.get`/`resolve`/`search`) record **0** audit
> events in this ledger — the volume is entirely **writes** (`memory.add`).

## Root cause of the growth

**The pair-programmer adapter (`pp-watcher`) bulk-ingested pp activity into eights
memory as `memory.add` events, ~631k of them — 96% of the entire ledger.**

It is **bursty and tied to pair-programmer activity**, not a constant leak.
Events by day:

| Day        | Events  |
|------------|---------|
| 2026-05-19 |   1,352 |
| 2026-05-20 |      24 |
| 2026-05-21 |  73,380 |
| 2026-05-22 | 123,815 |
| 2026-05-23 | 186,626 |
| 2026-05-24 |  72,749 |
| 2026-05-25 |  30,435 |
| 2026-05-26 | 107,536 |
| 2026-05-27 |   3,745 |
| 2026-05-28 |       8 |
| 2026-05-29 |  29,225 |
| 2026-05-30 |  29,341 |
| 2026-05-31 |     134 |

Volume tracks pp usage: heavy on active build days (70k–187k/day), near-zero when
pp is idle (8 events on 05-28; 134 so far on 05-31). The driver is `PpWatcher`
polling `~/.pair-programmer/state.db` every 5s and mirroring each pp
attempt/artifact into eights memory as a `memory.add`. So this WILL recur on the
next heavy pp day unless the source-side ingest volume is reduced (recommendation
#1) — it is not a one-time historical event.

## Impact — and why it's no longer urgent

The growth's *only* operational symptom was the slow boot-time `verifyChain()`,
which the **checkpoint fix already neutralizes**: boot now verifies only the tail
past the persisted high-water mark, so boot time no longer scales with ledger
size. Remaining concerns: **disk usage** (2.2 GB and still climbing on heavy pp
days) and the **daily background full re-verify** cost, which DOES still scan the
whole chain — acceptable today but a reason to pursue archival (recommendation #2)
before the ledger grows another order of magnitude.

## Recommendations (NOT auto-applied — touch hard rules #1/#3)

1. **Source fix — pp-watcher ingest volume.** Review whether every pp attempt
   warrants a distinct `memory.add`. Options: coalesce per-run, summarize, or
   sample. `daemon/src/engines/pp-watcher.ts` + `daemon/src/adapters/pp-bridge.ts`.
   This caps future growth at the source without touching the audit engine.

2. **Archival + compaction (needs architecture review).** Seal `events` older than
   the verified checkpoint into compressed archive segments, prune them from the
   live table and the `*.jsonl` mirror, then one-time `VACUUM` to reclaim ~2 GB.
   The new `audit_checkpoint` is the anchor that makes this safe (the prefix is
   provably verified). This rewrites/relocates the audit ledger, so per AGENTS.md
   hard rule #1 it MUST go through a reviewed change — do not run ad hoc.

3. **Do NOT** `VACUUM`/delete/truncate the ledger unilaterally — it is the
   tamper-evident chain. Any reclamation goes through recommendation #2.

## What was already shipped (connectivity fix)

- Transport-first boot + fail-closed readiness gate (`index.ts`, `mcp/server.ts`).
- Checkpointed, streaming, async `verifyChain()` (`engines/audit.ts`) + `audit_checkpoint`
  table (`stores/sqlite.ts`).
- Daily background full re-verification job (`cognitive/audit-verifier.ts`).
- Verified end-to-end: `gateway.health` → `connected: ["eights"]`; boot→transport
  active ~0.8s (was 6–26s).
