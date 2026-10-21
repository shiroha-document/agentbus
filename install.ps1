# Install (or update) the agentbus CLI on Windows from GitHub Releases. No token
# and no admin rights needed. Works in Windows PowerShell 5.1 and PowerShell 7.
#
#   irm https://raw.githubusercontent.com/shiroha-document/agentbus/main/install.ps1 | iex
#
# One line install + join (what hub: Members > Add agent copies for you):
#
#   $env:AGENTBUS_HUB='https://hub.example.com'; $env:AGENTBUS_JOIN_CODE='abj_...'; irm .../install.ps1 | iex
#
# With both set it runs `agentbus setup --yes` right after the install, and
# the agent waits for a team admin to approve it on the hub.
#
# Env:
#   AGENTBUS_HUB          hub to join after installing
#   AGENTBUS_JOIN_CODE    team join code abj_...
#   AGENTBUS_NAME         agent name (default: <host>-<cli>, suffixed if taken)
#   AGENTBUS_VERSION      tag to install (default: latest release), e.g. v0.6.0
#   AGENTBUS_UPDATE_BASE  release base URL (default: the public repo)
#   NO_COLOR              set to disable colors
#
# Installs to %LOCALAPPDATA%\agentbus\bin\agentbus.exe and adds that directory
# to the user PATH. Runs inside a script block so `irm | iex` never leaks
# variables into, or exits, the caller's session.
#
# This file must stay pure ASCII (Windows PowerShell 5.1 reads BOM-less files
# as the ANSI code page), so all messages are English.
& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow in 5.1 with the progress bar
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # --- output helpers (colors only on an interactive console, never with NO_COLOR) ---
    $color = $true
    if ($env:NO_COLOR) { $color = $false }
    try { if ([Console]::IsOutputRedirected) { $color = $false } } catch { }
    function W([string]$text, [string]$fg) {
        if ($color -and $fg) { Write-Host $text -ForegroundColor $fg } else { Write-Host $text }
    }
    function Say([string]$msg) { [Console]::Error.WriteLine("install.ps1: $msg") }
    function Step([int]$n, [string]$title) { Write-Host ''; W "[$n/4] $title" 'Cyan' }
    function Ok([string]$msg) { W "  [ok] $msg" 'Green' }
    function Info([string]$msg) { W "  $msg" 'DarkGray' }
    function Warn([string]$msg) { W "  [!] $msg" 'Yellow' }
    # Fail with a message plus "how to fix" lines. Throwing keeps the old behaviour
    # (non-zero exit for `powershell -File`, red error for `irm | iex`).
    function Fail([string]$msg, [string[]]$fixes) {
        Write-Host ''
        W "  [x] $msg" 'Red'
        if ($fixes) {
            Write-Host '  How to fix:'
            foreach ($f in $fixes) { Write-Host "    -> $f" }
        }
        W '  Docs: https://docs.hub.shiroha.tech/guide/faq' 'DarkGray'
        throw "install.ps1: $msg"
    }
    $goInstall = 'go install github.com/shiroha-document/agentbus/cmd/agentbus@latest'

    $base = $env:AGENTBUS_UPDATE_BASE
    if (-not $base) { $base = 'https://github.com/shiroha-document/agentbus' }
    $base = $base.TrimEnd('/')

    Write-Host ''
    W '  agentbus  - one bus for your coding agents' 'Cyan'
    $verLabel = $env:AGENTBUS_VERSION
    if (-not $verLabel) { $verLabel = 'latest' }
    Info "installer - $verLabel - $base"

    # --- architecture ---
    $cpu = $env:PROCESSOR_ARCHITEW6432          # set when 32-bit PowerShell runs on a 64-bit OS
    if (-not $cpu) { $cpu = $env:PROCESSOR_ARCHITECTURE }
    try {
        # x64 PowerShell emulated on ARM64 reports AMD64 above; prefer the OS view when available
        if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -eq 'Arm64') { $cpu = 'ARM64' }
    } catch { }
    switch ($cpu) {
        'AMD64' { $arch = 'amd64' }
        'ARM64' { $arch = 'arm64' }
        default { Fail "unsupported CPU '$cpu'" @("build from source: $goInstall") }
    }
    $asset = "agentbus-windows-$arch.exe"

    # --- version / download URL ---
    $tag = $env:AGENTBUS_VERSION
    if ($tag -and $tag -ne 'latest') {
        if ($tag -notmatch '^v') { $tag = "v$tag" }
    } else {
        $tag = $null
        # Resolve the tag from the releases/latest redirect (.../releases/tag/vX.Y.Z).
        try {
            $req = [Net.HttpWebRequest]::Create("$base/releases/latest")
            $req.AllowAutoRedirect = $false
            $req.Method = 'HEAD'
            $req.UserAgent = 'agentbus-install.ps1'
            try { $resp = $req.GetResponse() } catch [Net.WebException] { $resp = $_.Exception.Response }
            if ($resp) {
                $loc = $resp.Headers['Location']
                $resp.Close()
                if ($loc -match '/releases/tag/([^/?#]+)') { $tag = $Matches[1] }
            }
        } catch { }
        if (-not $tag) { Say 'could not resolve the latest tag; using releases/latest/download' }
    }
    if ($tag) { $url = "$base/releases/download/$tag" } else { $url = "$base/releases/latest/download" }

    # --- 1/4 download, 2/4 verify, 3/4 install ---
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("agentbus-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $bin = Join-Path $env:LOCALAPPDATA 'agentbus\bin'
    $dest = Join-Path $bin 'agentbus.exe'
    $prev = $null
    try {
        Step 1 'Download'
        $tagLabel = $tag
        if (-not $tagLabel) { $tagLabel = 'latest' }
        Info "windows/$arch - $asset - $tagLabel"
        $sums = Join-Path $tmp 'SHA256SUMS'
        $file = Join-Path $tmp $asset
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$url/SHA256SUMS" -OutFile $sums -UserAgent 'agentbus-install.ps1'
        } catch {
            Fail "no release found at $url ($($_.Exception.Message))" @(
                'check your network / proxy: Invoke-WebRequest https://github.com -UseBasicParsing',
                "check the tag: AGENTBUS_VERSION=$($env:AGENTBUS_VERSION) (e.g. v0.6.0, or unset for latest)")
        }
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$url/$asset" -OutFile $file -UserAgent 'agentbus-install.ps1'
        } catch {
            Fail "release has no $asset ($($_.Exception.Message))" @(
                'this platform may not be built for that tag; try the latest release',
                "or build from source: $goInstall")
        }
        Ok "downloaded $asset"

        Step 2 'Verify'
        $want = $null
        foreach ($line in Get-Content -LiteralPath $sums) {
            $f = $line.Trim() -split '\s+', 2
            if ($f.Count -eq 2 -and ($f[1] -eq $asset -or $f[1] -eq "*$asset")) { $want = $f[0]; break }
        }
        if (-not $want) { Fail "SHA256SUMS does not list $asset" @('the release may still be uploading; wait a minute and retry') }
        $got = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        if ($got -ine $want) {
            Fail "checksum mismatch for $asset" @('the download was corrupted or intercepted; retry, ideally without a MITM proxy')
        }
        Ok ("SHA-256 " + $got.Substring(0, 12).ToLower() + "...")

        $newver = & $file --version 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $newver) {
            Fail 'downloaded binary does not run on this machine' @(
                'antivirus / SmartScreen may have blocked it; allow agentbus.exe and retry',
                "or build from source: $goInstall")
        }
        $newver = "$newver".Trim()
        Ok "self-test: agentbus $newver"

        Step 3 'Install'
        New-Item -ItemType Directory -Path $bin -Force | Out-Null
        if (Test-Path -LiteralPath $dest) {
            try { $prev = "$(& $dest --version 2>$null)".Trim() } catch { $prev = $null }
            # A running agentbus.exe (e.g. a scheduled tick) cannot be overwritten, but it can be renamed.
            $old = "$dest.old"
            Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
            Move-Item -LiteralPath $dest -Destination $old -Force
        }
        Move-Item -LiteralPath $file -Destination $dest -Force
        Remove-Item -LiteralPath "$dest.old" -Force -ErrorAction SilentlyContinue
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    # --- user PATH (HKCU) ---
    $norm = { param($p) $p.Trim().TrimEnd('\') }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @()
    if ($userPath) { $parts = $userPath -split ';' | Where-Object { $_ -ne '' } }
    if (-not ($parts | Where-Object { (& $norm $_) -ieq (& $norm $bin) })) {
        [Environment]::SetEnvironmentVariable('Path', (($parts + $bin) -join ';'), 'User')
        Warn "added $bin to the user PATH (open a new terminal to pick it up)"
    }
    if (-not (($env:Path -split ';') | Where-Object { $_ -and ((& $norm $_) -ieq (& $norm $bin)) })) {
        $env:Path = "$bin;$env:Path"
    }

    if ($prev -and $prev -ne $newver) {
        Ok "updated agentbus $prev -> $newver  ($dest)"
    } else {
        Ok "installed agentbus $newver  ($dest)"
    }
    & $dest --version

    # --- coding CLIs agentbus can drive (see `agentbus setup --cli ...`) ---
    Write-Host ''
    Write-Host '  Coding CLIs on this machine'
    $found = $null
    $clis = @(
        @('Claude Code', @('claude')),
        @('Codex', @('codex')),
        @('Cursor', @('cursor-agent', 'agent')),
        @('Gemini CLI', @('gemini')),
        @('TRAE CLI', @('traecli', 'trae-cli')),
        @('DeepSeek Harness', @('dsh'))
    )
    foreach ($c in $clis) {
        $hit = $null
        foreach ($b in $c[1]) {
            if (Get-Command $b -ErrorAction SilentlyContinue) { $hit = $b; break }
        }
        if ($hit) {
            W "    [ok] $($c[0]) ($hit)" 'Green'
            if (-not $found) { $found = $hit }
        } else {
            W "    [--] $($c[0])" 'DarkGray'
        }
    }
    if (-not $found) {
        Warn 'no supported coding CLI found; install one first (or use: agentbus setup --cli custom --template ...)'
        Info 'https://docs.hub.shiroha.tech/guide/clis'
    }

    # --- 4/4 join the hub team (one-line onboarding) ---
    Step 4 'Join a hub'
    $hubUrl = "$env:AGENTBUS_HUB".Trim()
    $joinCode = "$env:AGENTBUS_JOIN_CODE".Trim()
    if (-not $hubUrl -and -not $joinCode) {
        Info 'AGENTBUS_HUB / AGENTBUS_JOIN_CODE not set, skipping'
        Say 'next: agentbus setup --hub https://<your hub> --join-code abj_...  (hub: Members > Add agent)'
        Write-Host ''
        Write-Host '  Next steps'
        Write-Host '    1. open your hub > Members > Add agent, copy the join code'
        Write-Host '    2. agentbus setup --hub https://<your hub> --join-code abj_...'
        Write-Host '    3. agentbus doctor'
        return
    }
    if (-not $hubUrl) {
        Fail 'AGENTBUS_JOIN_CODE is set but AGENTBUS_HUB is not' @("set it: `$env:AGENTBUS_HUB='https://<your hub>'")
    }
    if (-not $joinCode) {
        Fail 'AGENTBUS_HUB is set but AGENTBUS_JOIN_CODE is not' @('hub: Members > Add agent gives you a join code')
    }
    $setupArgs = @('setup', '--hub', $hubUrl, '--join-code', $joinCode, '--yes')
    if ("$env:AGENTBUS_NAME".Trim()) { $setupArgs += @('--name', "$env:AGENTBUS_NAME".Trim()) }
    Info "hub  $hubUrl"
    $codeShown = $joinCode
    if ($codeShown.Length -gt 8) { $codeShown = $codeShown.Substring(0, 8) }
    Info "code $codeShown..."
    if ("$env:AGENTBUS_NAME".Trim()) { Info "name $("$env:AGENTBUS_NAME".Trim())" }
    Say "joining $hubUrl ..."
    & $dest @setupArgs
    if ($LASTEXITCODE -ne 0) {
        Fail 'setup reported a problem above' @(
            'diagnose: agentbus doctor',
            'bad_join_code / 403: the code expired or was revoked; get a new one in hub: Members > Add agent',
            'name taken / 409: set another $env:AGENTBUS_NAME',
            "re-run just the join: agentbus setup --hub $hubUrl --join-code ...")
    }
    Write-Host ''
    Ok 'done'
    Write-Host ''
    Write-Host '  Next steps'
    Write-Host '    1. a team admin approves this agent on the hub (Members)'
    Write-Host '    2. check: agentbus status    diagnose: agentbus doctor'
    Write-Host '    3. then @ it in any thread on the hub'
}
