# eights-session-status.ps1 — SessionStart hook (advisory, never blocking)
# Surfaces pending proposals and audit chain health from TheEights daemon.
param()

# Resolve the CLI entrypoint portably:
#   1. EIGHTS_CLI_JS env override, if set.
#   2. Anchor-relative: this hook lives at <repo>/.claude/hooks, so the CLI is
#      at <repo>/cli/dist/index.js (two levels up, then cli/dist).
# Never hardcode a machine-specific absolute path here.
if ($env:EIGHTS_CLI_JS) {
    $eightsCli = $env:EIGHTS_CLI_JS
} else {
    $repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..") -ErrorAction SilentlyContinue
    if (-not $repoRoot) { exit 0 }
    $eightsCli = Join-Path $repoRoot.Path "cli\dist\index.js"
}
if (-not (Test-Path $eightsCli)) { exit 0 }

try {
    $raw = & node $eightsCli status 2>$null | Out-String
    if (-not $raw -or $raw.Trim().Length -eq 0) { exit 0 }

    $status = $raw | ConvertFrom-Json -ErrorAction Stop

    $pending = $status.pending_proposals
    $drift   = $status.drift_summary.sources
    $chain   = if ($status.audit_chain.ok) { "audit chain clean" } else { "AUDIT CHAIN BROKEN at row $($status.audit_chain.broken_at)" }

    $parts = @()
    if ($pending -gt 0) { $parts += "$pending proposals pending" }
    if ($drift -gt 0) { $parts += "$drift source drifts" }
    $parts += $chain

    Write-Host ("[eights] " + ($parts -join " | "))

    if ($pending -gt 0) {
        Write-Host "[eights] run 'eights review' or /smith:evolve to review pending proposals"
    }
}
catch {
    # Silent degradation — never block session startup
}

exit 0
