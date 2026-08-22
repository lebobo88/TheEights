#!/usr/bin/env pwsh
# register-eights-mcp.ps1 — idempotently register the `eights` daemon as a
# user-scope MCP server in Claude Code, using an ABSOLUTE path derived from this
# script's own location.
#
# Why absolute: a user-scope MCP server is launched from whatever directory the
# Claude Code session started in. A relative path (e.g. ./daemon/dist/index.js)
# only resolves when that cwd happens to be this repo, so the server silently
# fails to connect from every other project. Deriving the path from $PSScriptRoot
# keeps it correct regardless of cwd or where the repo was cloned.
#
# Usage:  pwsh -NoProfile -File scripts/register-eights-mcp.ps1

$ErrorActionPreference = "Stop"

$root   = (Resolve-Path "$PSScriptRoot/..").Path -replace '\\', '/'
$daemon = "$root/daemon/dist/index.js"

if (-not (Test-Path $daemon)) {
    Write-Error "Daemon not built at $daemon. Build it first: cd daemon && npm install && npm run build"
    exit 1
}

# Remove any prior registration (no-op if absent) so re-runs don't error.
try { claude mcp remove eights -s user 2>$null } catch {}

claude mcp add eights -s user -- node $daemon
claude mcp get eights
