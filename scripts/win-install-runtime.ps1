# Windows runtime evidence for install.ps1 (called from .github/workflows/ci.yml
# on windows-latest). Actually executes the unmodified installer under BOTH
# Windows PowerShell 5.1 (powershell.exe) and PowerShell 7 (pwsh.exe), in both
# zh and en, through both real entry points advertised to users:
#
#   * download then run:  powershell -ExecutionPolicy Bypass -File install.ps1
#   * HTTP pipe:          irm http://127.0.0.1:<port>/install.ps1 | iex
#
# The CLI binary is compiled from the checked-out branch and served by a local
# HTTP fixture together with SHA256SUMS. Nothing talks to a real hub:
# AGENTBUS_HUB / AGENTBUS_JOIN_CODE are removed from the child environment, no
# member is created, and no scheduled task is installed (setup never runs).
# LOCALAPPDATA and the user PATH are redirected into a temp area and restored.
#
# A bad-checksum fixture additionally proves a tampered download fails non-zero
# with the expected diagnostics. This script itself always runs under pwsh 7;
# the engines under test are launched as separate processes.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$workRoot = $env:RUNNER_TEMP
if (-not $workRoot) { $workRoot = [IO.Path]::GetTempPath() }
$work = Join-Path $workRoot ("agentbus-winci-" + [Guid]::NewGuid().ToString('N'))
$goodRoot = Join-Path $work 'fixture-good'
$badRoot = Join-Path $work 'fixture-badsum'
$launcherDir = Join-Path $work 'launchers'
$logDir = Join-Path $work 'logs'
New-Item -ItemType Directory -Force -Path $goodRoot, $launcherDir, $logDir | Out-Null

$tag = 'v-test'
$asset = 'agentbus-windows-amd64.exe'
$relDir = Join-Path $goodRoot ("releases/download/$tag")
New-Item -ItemType Directory -Force -Path $relDir | Out-Null

Write-Host '== build CLI binary from this branch =='
Push-Location $repo
go build -o (Join-Path $relDir $asset) ./cmd/agentbus
if ($LASTEXITCODE -ne 0) { throw 'go build failed' }
Pop-Location
$exe = Join-Path $relDir $asset
$ver = (& $exe --version).Trim()
if (-not $ver) { throw 'built binary reports no --version' }
Write-Host "built $exe -> $ver"

# SHA256SUMS exactly like release.yml emits it (lowercase hash, two spaces, name).
$hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower()
[IO.File]::WriteAllText((Join-Path $relDir 'SHA256SUMS'), "$hash  $asset`n", [System.Text.ASCIIEncoding]::new())

# The HTTP-served installer must be byte-for-byte the file in the repo.
Copy-Item -LiteralPath (Join-Path $repo 'install.ps1') -Destination (Join-Path $goodRoot 'install.ps1') -Force
$repoHash = (Get-FileHash -LiteralPath (Join-Path $repo 'install.ps1') -Algorithm SHA256).Hash
$serveHash = (Get-FileHash -LiteralPath (Join-Path $goodRoot 'install.ps1') -Algorithm SHA256).Hash
if ($repoHash -ne $serveHash) { throw 'served install.ps1 differs from repository bytes' }

# Bad-sum fixture: identical tree, SHA256SUMS claims a different digest.
Copy-Item -LiteralPath $goodRoot -Destination $badRoot -Recurse -Force
[IO.File]::WriteAllText((Join-Path $badRoot "releases/download/$tag/SHA256SUMS"),
    ("0" * 64 + "  $asset`n"), [System.Text.ASCIIEncoding]::new())

# Two fixtures on 127.0.0.1 (each job runs on its own VM, so no port clash).
$goodPort = 8931
$badPort = 8932
$py = $null
foreach ($c in @('python', 'python3', 'py')) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { $py = $cmd.Source; break }
}
if (-not $py) { throw 'no python interpreter available for the HTTP fixture' }
$servers = @()
foreach ($pair in @(@($goodRoot, $goodPort), @($badRoot, $badPort))) {
    $srvLog = Join-Path $logDir ("fixture-$($pair[1]).log")
    $p = Start-Process -FilePath $py -ArgumentList @(
        (Join-Path $repo 'scripts/win-install-fixture.py'), "`"$($pair[0])`"", "$($pair[1])"
    ) -WindowStyle Hidden -PassThru -RedirectStandardOutput $srvLog -RedirectStandardError "$srvLog.err"
    $servers += $p
}

# Redirect the runner environment seen by installer children.
$savedLocalAppData = $env:LOCALAPPDATA
$savedUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
Remove-Item Env:AGENTBUS_HUB -ErrorAction SilentlyContinue
Remove-Item Env:AGENTBUS_JOIN_CODE -ErrorAction SilentlyContinue

# Per-case launcher: force console CP 65001 so a redirected Windows PowerShell
# 5.1 child emits UTF-8, then invoke the engine under test through the required
# real entry point. Pure ASCII; Chinese only ever comes from base64 at runtime.
$launcher = Join-Path $launcherDir 'case.ps1'
[IO.File]::WriteAllText($launcher, @'
param([string]$Engine, [string]$Mode, [string]$Repo, [int]$Port)
chcp 65001 > $null
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'file') {
    & $Engine -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Repo 'install.ps1')
    exit $LASTEXITCODE
}
$cmd = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(`$false); `$ErrorActionPreference='Stop'; irm -UseBasicParsing 'http://127.0.0.1:$Port/install.ps1' | iex"
& $Engine -NoProfile -ExecutionPolicy Bypass -Command $cmd
exit $LASTEXITCODE
'@, [System.Text.ASCIIEncoding]::new())

$engines = @{
    'powershell' = (Get-Command powershell.exe).Source   # Windows PowerShell 5.1
    'pwsh' = (Get-Command pwsh.exe).Source               # PowerShell 7
}
$pwshRunner = (Get-Command pwsh.exe).Source
$results = @()

function Invoke-InstallCase {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Engine,
        [Parameter(Mandatory)][string]$Lang,
        [Parameter(Mandatory)][ValidateSet('file', 'iex')][string]$Mode,
        [Parameter(Mandatory)][int]$Port,
        [int]$ExpectExit = 0
    )
    $home2 = Join-Path $work ("home-$Name")
    New-Item -ItemType Directory -Force -Path $home2 | Out-Null
    $outLog = Join-Path $logDir "$Name.out.log"
    $errLog = Join-Path $logDir "$Name.err.log"

    $env:AGENTBUS_UPDATE_BASE = "http://127.0.0.1:$Port"
    $env:AGENTBUS_VERSION = $tag
    $env:AGENTBUS_LANG = $Lang
    $env:LOCALAPPDATA = $home2
    $env:NO_COLOR = '1'
    # Defense in depth: the join step must never see credentials in CI.
    Remove-Item Env:AGENTBUS_HUB -ErrorAction SilentlyContinue
    Remove-Item Env:AGENTBUS_JOIN_CODE -ErrorAction SilentlyContinue

    Write-Host ""
    Write-Host "== case $Name ($Engine, $Lang, $Mode, port $Port) =="
    $proc = Start-Process -FilePath $pwshRunner -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$launcher`"",
        '-Engine', "`"$Engine`"", '-Mode', $Mode, '-Repo', "`"$repo`"", '-Port', "$Port"
    ) -WorkingDirectory $work -PassThru -Wait -WindowStyle Hidden `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $code = $proc.ExitCode
    # Children write UTF-8 bytes (console CP 65001); decode them as such.
    $text = [IO.File]::ReadAllText($outLog, [System.Text.UTF8Encoding]::new($false))
    if (Test-Path $errLog) { $text += [IO.File]::ReadAllText($errLog, [System.Text.UTF8Encoding]::new($false)) }
    Write-Host $text
    Write-Host "-- exit code: $code (expect $ExpectExit)"
    if ($code -ne $ExpectExit) { throw "case $Name: exit $code, expected $ExpectExit (logs in $logDir)" }
    return [pscustomobject]@{ Name = $Name; Lang = $Lang; Mode = $Mode; Text = $text; Home = $home2 }
}

try {
    # Wait until both fixtures answer.
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 300
        $okGood = $false; $okBad = $false
        try { $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$goodPort/install.ps1"; $okGood = ($r.StatusCode -eq 200 -and $r.RawContentLength -gt 0) } catch { }
        try { $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$badPort/releases/download/$tag/SHA256SUMS"; $okBad = ($r.StatusCode -eq 200) } catch { }
    } while ((-not $okGood -or -not $okBad) -and (Get-Date) -lt $deadline)
    if (-not $okGood -or -not $okBad) { throw 'HTTP fixture did not come up' }

    foreach ($shell in @('powershell', 'pwsh')) {
        $engine = $engines[$shell]
        foreach ($lang in @('zh', 'en')) {
            $results += Invoke-InstallCase -Name "$shell-$lang-file" -Engine $engine -Lang $lang -Mode 'file' -Port $goodPort
        }
        # irm|iex is language-independent: cover it once per engine, in English.
        $results += Invoke-InstallCase -Name "$shell-en-iex" -Engine $engine -Lang 'en' -Mode 'iex' -Port $goodPort
    }
    # Tampered download must fail non-zero with the mismatch diagnostic, on both engines.
    $results += Invoke-InstallCase -Name 'powershell-en-badsum' -Engine $engines['powershell'] -Lang 'en' -Mode 'file' -Port $badPort -ExpectExit 1
    $results += Invoke-InstallCase -Name 'pwsh-en-badsum' -Engine $engines['pwsh'] -Lang 'en' -Mode 'iex' -Port $badPort -ExpectExit 1

    Write-Host ''
    Write-Host '== assertions =='
    $han = [regex]'[一-鿿]'
    $fffd = [char]0xFFFD

    foreach ($c in $results) {
        $installed = Join-Path $c.Home 'agentbus\bin\agentbus.exe'
        if ($c.Name -like '*badsum*') {
            if ($c.Text -notmatch 'checksum mismatch') { throw "$($c.Name): expected English 'checksum mismatch' diagnostic" }
            if ($c.Text.Contains($fffd)) { throw "$($c.Name): replacement characters in output (UTF-8 decode broken)" }
            if (Test-Path -LiteralPath $installed) { throw "$($c.Name): binary must not be installed on checksum failure" }
            Write-Host "[ok] $($c.Name): non-zero exit, 'checksum mismatch' shown, nothing installed"
            continue
        }
        if (-not (Test-Path -LiteralPath $installed)) { throw "$($c.Name): agentbus.exe not installed under redirected LOCALAPPDATA" }
        $iv = (& $installed --version).Trim()
        if ($iv -ne $ver) { throw "$($c.Name): installed --version '$iv' != built '$ver'" }
        if ($c.Text.Contains($fffd)) { throw "$($c.Name): replacement characters in captured output" }
        if ($c.Lang -eq 'zh') {
            # Base64(UTF-8) Chinese must decode correctly (no ANSI mojibake) in both engines.
            foreach ($need in @('下载', '校验', '安装', '加入')) {
                if (-not $c.Text.Contains($need)) { throw "$($c.Name): missing decoded Chinese step '$need'" }
            }
            Write-Host "[ok] $($c.Name): zh steps decoded correctly, installed agentbus $iv runs"
        } else {
            if ($han.IsMatch($c.Text)) { throw "$($c.Name): English run still emits Han characters" }
            foreach ($need in @('Download', 'Verify', 'Install', 'Join a hub')) {
                if (-not $c.Text.Contains($need)) { throw "$($c.Name): missing English step '$need'" }
            }
            Write-Host "[ok] $($c.Name): en system text, no Han characters, installed agentbus $iv runs"
        }
    }

    Write-Host ''
    Write-Host 'ALL WINDOWS INSTALLER RUNTIME CASES PASSED'
} finally {
    foreach ($p in $servers) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
    }
    if ($savedLocalAppData) { $env:LOCALAPPDATA = $savedLocalAppData }
    # Restore the user PATH exactly: installers only appended redirected temp bins.
    $restored = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($restored -ne $savedUserPath) {
        [Environment]::SetEnvironmentVariable('Path', $savedUserPath, 'User')
        Write-Host 'restored modified user PATH'
    }
    Write-Host "logs and fixtures left at: $work"
}
