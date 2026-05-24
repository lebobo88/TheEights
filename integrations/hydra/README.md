# Hydra ↔ TheEights integration

This directory ships **`eights_memory.py`** — a drop-in replacement for Hydra's declared-but-unimplemented 3-tier memory fabric.

It is the **first live consumer** of `eights-daemon` and validates the MCP surface against a real-world adapter.

## Install (one-time)

```bash
# Build the daemon (Node 20+ required)
cd <TheEights-repo>/daemon
npm install
npm run build
```

## Wire it into Hydra

Copy or symlink into Hydra's source tree:

```bash
cp <TheEights-repo>/integrations/hydra/eights_memory.py \
   <Hydra-repo>/hydra_core/eights_memory.py
```

Then in a LangGraph node:

```python
from hydra_core.eights_memory import EightsMemoryService, MemoryRef

async def planner_node(state):
    mem = await EightsMemoryService.connect()
    try:
        # Recall prior wisdom relevant to this task.
        hits = await mem.recall(
            query=state["task"]["description"],
            actor="hydra.planner",
            project_id=state["workflow"]["project_id"],
            domain="exec",
            tiers=["episodic", "semantic"],
            k=8,
        )
        state["prior_wisdom"] = hits

        # After planning, write the decision back.
        ref = await mem.remember(
            "episodic",
            content=json.dumps(state["plan"]),
            actor="hydra.planner",
            project_id=state["workflow"]["project_id"],
            domain="exec",
            scopes=[f"workflow:{state['workflow']['id']}"],
            summary=state["plan"]["summary"],
        )
        state["plan_memory_ref"] = ref
    finally:
        await mem.close()
    return state
```

## What you get

- **Cross-workflow recall**: a decision in workflow A informs workflow B
- **Cross-squad recall**: an executive-squad memory is visible to the engineering squad (subject to scopes)
- **Audit graph**: every read/write lands in the hash-chained event log
- **Hybrid retrieval**: vector (Ollama local embeddings) + episodic fallback when Ollama is down
- **`MemoryRef` parity**: same dataclass shape Hydra already uses

## Daemon lifecycle

`EightsMemoryService.connect()` spawns the daemon as a subprocess on stdio. For long-lived workflows, keep a single service instance per process. The daemon itself is single-writer; concurrency inside one Hydra process is fine, multiple Hydra processes against the same daemon need queue serialization (governance plane enforces this via budget/ceiling gates).

## Smoke-testing the wire

```bash
cd <TheEights-repo>/integrations/hydra
python -m smoke
```

That runs `smoke.py` which round-trips a memory through `remember → recall` and prints the result.
