"""End-to-end smoke test of the Hydra <-> TheEights MCP wiring."""
from __future__ import annotations

import asyncio
from eights_memory import EightsMemoryService


async def main() -> None:
    mem = await EightsMemoryService.connect()
    try:
        ref = await mem.remember(
            "episodic",
            content="prior board decision: deferred capex on Project Atlas pending Q3 liquidity review",
            actor="hydra.smoke",
            project_id="ExecutiveSuite",
            domain="exec",
            scopes=["project:ExecutiveSuite", "domain:exec", "workflow:capital-decision"],
            summary="deferred capex on Project Atlas (Q3 review)",
            confidence=0.9,
            run_id="smoke_run_1",
        )
        print(f"[remember] wrote memory: {ref}")

        hits = await mem.recall(
            query="capex on Project Atlas",
            actor="hydra.smoke",
            project_id="ExecutiveSuite",
            domain="exec",
            scopes=None,
            k=5,
        )
        print(f"[recall] got {len(hits)} hits (type={type(hits).__name__})")
        items = hits if isinstance(hits, list) else hits.get("hits", []) if isinstance(hits, dict) else []
        for h in items[:3]:
            print(f"  - score={h.get('score'):.4f} path={h.get('path')} id={h.get('id')}")
            print(f"    {h.get('content')[:120]}")
        if not items and isinstance(hits, dict):
            print(f"  (raw response keys: {list(hits.keys())})")
    finally:
        await mem.close()


if __name__ == "__main__":
    asyncio.run(main())
