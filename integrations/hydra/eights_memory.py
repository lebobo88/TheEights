"""
eights_memory — Hydra's MemoryRef resolver, backed by TheEights MCP daemon.

Drops into hydra_core/ so LangGraph nodes can call:

    from eights_memory import EightsMemoryService, MemoryRef

    mem = EightsMemoryService.connect()          # spawns/finds eights-daemon
    ref = mem.remember("episodic",
                       content="prior decision: deferred capex on Project X",
                       scopes=["project:ExecutiveSuite", "domain:exec"],
                       actor="CFO")
    hits = mem.recall("capex on Project X", scopes=["domain:exec"], k=5)

Tier mapping (Hydra → TheEights memory.type):
    ephemeral  → working
    episodic   → episodic
    semantic   → semantic

This module shells out to the daemon process over MCP stdio. It uses the
official `mcp` Python package (>=1.0). If you can't install that, the
`subprocess_call` fallback at the bottom is a no-deps stdio JSON-RPC client.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import uuid
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Optional


DAEMON_PATH_DEFAULT = Path(
    os.environ.get(
        "EIGHTS_DAEMON_JS",
        "C:/AiAppDeployments/TheEights/daemon/dist/index.js",
    )
)


# ---------------------------------------------------------------------------
# Public types — mirror Hydra's existing MemoryRef shape so this is a drop-in.
# ---------------------------------------------------------------------------

@dataclass
class MemoryRef:
    tier: str            # "ephemeral" | "episodic" | "semantic"
    key: str             # eights memory id
    summary: str


@dataclass
class Envelope:
    actor_id: str
    project_id: str
    domain: str
    trace_id: str = field(default_factory=lambda: f"trace_{uuid.uuid4().hex[:12]}")
    tenant_id: str = "local"
    scope: list[str] = field(default_factory=list)
    parent_trace_id: Optional[str] = None

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        if d["parent_trace_id"] is None:
            d.pop("parent_trace_id")
        return d


_TIER_TO_TYPE = {
    "ephemeral": "working",
    "episodic":  "episodic",
    "semantic":  "semantic",
}


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class EightsMemoryService:
    """Thin async-friendly wrapper over the eights-daemon MCP stdio surface."""

    def __init__(self, client: "_McpStdioClient") -> None:
        self._client = client

    @classmethod
    async def connect(cls, daemon_path: Path | str = DAEMON_PATH_DEFAULT) -> "EightsMemoryService":
        client = await _McpStdioClient.spawn(Path(daemon_path))
        return cls(client)

    async def remember(
        self,
        tier: str,
        *,
        content: str,
        actor: str,
        project_id: str,
        domain: str,
        scopes: Optional[list[str]] = None,
        summary: Optional[str] = None,
        confidence: float = 0.5,
        run_id: Optional[str] = None,
    ) -> MemoryRef:
        if tier not in _TIER_TO_TYPE:
            raise ValueError(f"unknown tier {tier!r}; expected ephemeral|episodic|semantic")
        env = Envelope(actor_id=actor, project_id=project_id, domain=domain, scope=scopes or [])
        result = await self._client.call(
            "eights.memory.add",
            {
                "envelope": env.to_json(),
                "content": content,
                "type": _TIER_TO_TYPE[tier],
                "summary": summary,
                "scopes": scopes or [],
                "provenance": {"actor": actor, "run_id": run_id},
                "confidence": confidence,
            },
        )
        return MemoryRef(tier=tier, key=result["id"], summary=summary or content[:120])

    async def recall(
        self,
        query: str,
        *,
        actor: str,
        project_id: str,
        domain: str,
        tiers: Optional[list[str]] = None,
        scopes: Optional[list[str]] = None,
        k: int = 10,
    ) -> list[dict[str, Any]]:
        env = Envelope(actor_id=actor, project_id=project_id, domain=domain, scope=scopes or [])
        types = [_TIER_TO_TYPE[t] for t in (tiers or [])] or None
        return await self._client.call(
            "eights.memory.search",
            {
                "envelope": env.to_json(),
                "query": query,
                "types": types,
                "scopes": scopes,
                "top_k": k,
                "fusion": "hybrid",
            },
        )

    async def link(
        self,
        from_ref: MemoryRef,
        to_ref: MemoryRef,
        relation: str,
        *,
        actor: str,
        project_id: str,
        domain: str,
        weight: Optional[float] = None,
    ) -> str:
        env = Envelope(actor_id=actor, project_id=project_id, domain=domain)
        result = await self._client.call(
            "eights.memory.link",
            {
                "envelope": env.to_json(),
                "from_id": from_ref.key,
                "to_id": to_ref.key,
                "relation": relation,
                "weight": weight,
            },
        )
        return result["edge_id"]

    async def close(self) -> None:
        await self._client.close()


# ---------------------------------------------------------------------------
# Minimal MCP stdio JSON-RPC client (no third-party deps).
#
# This is intentionally a *narrow* client. For a richer experience switch to
# the official `mcp` Python package — same wire format, same daemon.
# ---------------------------------------------------------------------------

class _McpStdioClient:
    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self._proc = proc
        self._next_id = 1
        self._lock = asyncio.Lock()
        self._initialized = False

    @classmethod
    async def spawn(cls, daemon_path: Path) -> "_McpStdioClient":
        if not daemon_path.exists():
            raise FileNotFoundError(
                f"eights-daemon dist not found at {daemon_path}. "
                "Run `npm --prefix daemon run build` first."
            )
        proc = await asyncio.create_subprocess_exec(
            "node",
            str(daemon_path),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        client = cls(proc)
        await client._initialize()
        return client

    async def _initialize(self) -> None:
        await self._send(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "hydra-bridge", "version": "0.1.0"},
            },
        )
        await self._notify("notifications/initialized", {})
        self._initialized = True

    async def call(self, tool: str, args: dict[str, Any]) -> Any:
        # Strip None values — Zod tolerates missing optionals but rejects explicit null.
        clean = _strip_none(args)
        result = await self._send("tools/call", {"name": tool, "arguments": clean})
        content = result.get("content") or []
        if not content:
            return None
        text = content[0].get("text", "{}")
        parsed = json.loads(text)
        if result.get("isError"):
            raise RuntimeError(f"eights tool error on {tool}: {parsed.get('error', parsed)}")
        return parsed

    async def _send(self, method: str, params: dict[str, Any]) -> Any:
        async with self._lock:
            rid = self._next_id
            self._next_id += 1
            payload = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
            assert self._proc.stdin is not None
            self._proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
            await self._proc.stdin.drain()
            while True:
                assert self._proc.stdout is not None
                line = await self._proc.stdout.readline()
                if not line:
                    raise RuntimeError("eights-daemon closed stdout")
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if msg.get("id") == rid:
                    if "error" in msg:
                        raise RuntimeError(f"MCP error: {msg['error']}")
                    return msg.get("result")

    async def _notify(self, method: str, params: dict[str, Any]) -> None:
        async with self._lock:
            payload = {"jsonrpc": "2.0", "method": method, "params": params}
            assert self._proc.stdin is not None
            self._proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
            await self._proc.stdin.drain()

    async def close(self) -> None:
        if self._proc.returncode is not None:
            return
        try:
            self._proc.terminate()
            await asyncio.wait_for(self._proc.wait(), timeout=5)
        except (ProcessLookupError, asyncio.TimeoutError):
            self._proc.kill()
            await self._proc.wait()


def _strip_none(value: Any) -> Any:
    """Recursively drop keys whose values are None — MCP tool schemas treat
    'missing' and 'null' differently."""
    if isinstance(value, dict):
        return {k: _strip_none(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_strip_none(v) for v in value]
    return value
