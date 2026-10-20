# Install (or update) the agentbus CLI on Windows from GitHub Releases. No token
# and no admin rights needed. Works in Windows PowerShell 5.1 and PowerShell 7.
#
#   irm https://raw.githubusercontent.com/shiroha-document/agentbus/main/install.ps1 | iex
#
# Env:
#   AGENTBUS_VERSION      tag to install (default: latest release), e.g. v0.4.0
#   AGENTBUS_UPDATE_BASE  release base URL (default: the public repo)
#
# Installs to %LOCALAPPDATA%\agentbus\bin\agentbus.exe and adds that directory
# to the user PATH. Runs inside a script block so `irm | iex` never leaks
# variables into, or exits, the caller's session.
& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow in 5.1 with the progress bar
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    function Say([string]$msg) { [Console]::Error.WriteLine("install.ps1: $msg") }
    $goInstall = 'go install github.com/shiroha-document/agentbus/cmd/agentbus@latest'

    $base = $env:AGENTBUS_UPDATE_BASE
    if (-not $base) { $base = 'https://github.com/shiroha-document/agentbus' }
    $base = $base.TrimEnd('/')

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
        default { throw "install.ps1: unsupported CPU '$cpu'; use: $goInstall" }
    }
    $asset = "agentbus-windows-$arch.exe"

    # --- version / download URL ---
    $tag = $env:AGENTBUS_VERSION
    if ($tag -and $tag -ne 'latest') {
        if ($tag -notmatch '^v') { $tag = "v$tag" }
    } else {
        $tag = $null
        # Resolve the tag from the releases/latest redirect (…/releases/tag/vX.Y.Z).
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

    # --- download + verify ---
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("agentbus-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        $sums = Join-Path $tmp 'SHA256SUMS'
        $file = Join-Path $tmp $asset
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$url/SHA256SUMS" -OutFile $sums -UserAgent 'agentbus-install.ps1'
        } catch { throw "install.ps1: no release found at $url ($($_.Exception.Message))" }
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$url/$asset" -OutFile $file -UserAgent 'agentbus-install.ps1'
        } catch { throw "install.ps1: release has no $asset ($($_.Exception.Message))" }

        $want = $null
        foreach ($line in Get-Content -LiteralPath $sums) {
            $f = $line.Trim() -split '\s+', 2
            if ($f.Count -eq 2 -and ($f[1] -eq $asset -or $f[1] -eq "*$asset")) { $want = $f[0]; break }
        }
        if (-not $want) { throw "install.ps1: SHA256SUMS does not list $asset" }
        $got = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        if ($got -ine $want) { throw "install.ps1: checksum mismatch for $asset" }

        $newver = & $file --version 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $newver) { throw 'install.ps1: downloaded binary does not run on this machine' }
        $newver = "$newver".Trim()

        # --- install ---
        $bin = Join-Path $env:LOCALAPPDATA 'agentbus\bin'
        New-Item -ItemType Directory -Path $bin -Force | Out-Null
        $dest = Join-Path $bin 'agentbus.exe'
        if (Test-Path -LiteralPath $dest) {
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
        Say "added $bin to the user PATH (open a new terminal to pick it up)"
    }
    if (-not (($env:Path -split ';') | Where-Object { $_ -and ((& $norm $_) -ieq (& $norm $bin)) })) {
        $env:Path = "$bin;$env:Path"
    }

    Say "installed agentbus $newver to $dest"
    & $dest --version
}
