# eights-session-status.ps1 — SessionStart hook (advisory, never blocking)
# Surfaces pending proposals and audit chain health from TheEights daemon.
param()

$eightsCli = "C:\AiAppDeployments\TheEights\cli\dist\index.js"
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
