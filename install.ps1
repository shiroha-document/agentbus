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
#   AGENTBUS_CLI          claude | codex | cursor | gemini | traecli | dsh | manual | custom
#                         (default: asked when several CLIs are found and a person
#                         is at the console, else the first one found). manual =
#                         a self-driven agent (OpenAI dot, ...) that runs
#                         `agentbus inbox` from its own scheduled task
#   AGENTBUS_VERSION      tag to install (default: latest release), e.g. v0.6.0
#   AGENTBUS_UPDATE_BASE  release base URL (default: the public repo)
#   AGENTBUS_LANG         zh | en (default: from the Windows UI language, else en)
#   NO_COLOR              set to disable colors
#
# Installs to %LOCALAPPDATA%\agentbus\bin\agentbus.exe and adds that directory
# to the user PATH. Runs inside a script block so `irm | iex` never leaks
# variables into, or exits, the caller's session.
#
# This file must stay pure ASCII (Windows PowerShell 5.1 reads BOM-less files
# as the ANSI code page); Chinese text therefore ships as base64(UTF-8) and is
# decoded at runtime by the M() helper below.
& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow in 5.1 with the progress bar
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # --- language: AGENTBUS_LANG (zh|en) -> Windows UI culture -> en ---
    # Chinese strings are stored as base64(UTF-8): this file stays pure ASCII,
    # so Windows PowerShell 5.1 (ANSI decoding for BOM-less files) cannot mojibake it.
    $script:zhLang = $false
    $langArg = "$env:AGENTBUS_LANG".Trim().ToLowerInvariant()
    if ($langArg) {
        if ($langArg -like 'zh*') { $script:zhLang = $true }
    } else {
        try { if ((Get-UICulture).Name -like 'zh*') { $script:zhLang = $true } } catch { }
    }
    $script:zhText = @{
        'subtitle' = '5LiA5Liq5oC757q/77yM6L+e5o6l5L2g55qE57yW56iLIGFnZW50'
        'installer' = '5a6J6KOF56iL5bqP'
        'step_download' = '5LiL6L29'
        'step_verify' = '5qCh6aqM'
        'step_install' = '5a6J6KOF'
        'step_join' = '5Yqg5YWlIGh1Yg=='
        'downloaded' = '5bey5LiL6L29IHswfQ=='
        'selftest' = '6Ieq5qOA77yaYWdlbnRidXMgezB9'
        'path_added' = '5bey5oqKIHswfSDliqDlhaXnlKjmiLcgUEFUSO+8iOivt+aJk+W8gOaWsOeahOe7iOerr+eql+WPo+eUn+aViO+8iQ=='
        'updated' = 'YWdlbnRidXMg5bey5pu05pawIHswfSAtPiB7MX3vvIh7Mn3vvIk='
        'installed' = 'YWdlbnRidXMg5bey5a6J6KOFIHswfe+8iHsxfe+8iQ=='
        'found_clis' = '6L+Z5Y+w5py65Zmo5LiK55qE57yW56iLIENMSQ=='
        'no_cli_warn' = '5rKh5pyJ5om+5Yiw5Y+X5pSv5oyB55qE57yW56iLIENMSe+8m+ivt+WFiOWuieijheS4gOS4qu+8jOaIlueUqCAtLWNsaSBjdXN0b20gLS10ZW1wbGF0ZSAuLi7vvIzmiJborr7nva4gJGVudjpBR0VOVEJVU19DTEk9J21hbnVhbCcg5L2/55So6Ieq6amxIGFnZW5077yIT3BlbkFJIGRvdCDnrYnvvIk='
        'skip_join' = '5pyq6K6+572uIEFHRU5UQlVTX0hVQiAvIEFHRU5UQlVTX0pPSU5fQ09ERe+8jOi3s+i/h+WKoOWFpQ=='
        'next_setup' = '5LiL5LiA5q2l77yaYWdlbnRidXMgc2V0dXAgLS1odWIgaHR0cHM6Ly885L2g55qEIGh1Yj4gLS1qb2luLWNvZGUgYWJqXy4uLu+8iGh1Yu+8muaIkOWRmCA+IOa3u+WKoCBhZ2VudO+8iQ=='
        'next_steps' = '5LiL5LiA5q2l'
        'next_step1' = 'MS4g5omT5byA5L2g55qEIGh1YiA+IOaIkOWRmCA+IOa3u+WKoCBhZ2VudO+8jOWkjeWItuWKoOWFpeeggQ=='
        'next_step2' = 'Mi4gYWdlbnRidXMgc2V0dXAgLS1odWIgaHR0cHM6Ly885L2g55qEIGh1Yj4gLS1qb2luLWNvZGUgYWJqXy4uLg=='
        'next_step3' = 'My4gYWdlbnRidXMgZG9jdG9y'
        'join_code_only' = '6K6+572u5LqGIEFHRU5UQlVTX0pPSU5fQ09ERe+8jOS9huayoeacieiuvue9riBBR0VOVEJVU19IVUI='
        'hub_only' = '6K6+572u5LqGIEFHRU5UQlVTX0hVQu+8jOS9huayoeacieiuvue9riBBR0VOVEJVU19KT0lOX0NPREU='
        'pick_cli' = '6L+Z5LiqIGFnZW50IOivpeeUqOWTquS4que8lueoiyBDTEnvvJ8='
        'pick_manual' = '5omL5YqoIC8g6Ieq6amx77yIYWdlbnQg6Ieq5bex5a6a5pe25ZSk6YaS5bm26L+Q6KGMIGFnZW50YnVzIGluYm9477yM5aaCIE9wZW5BSSBkb3TvvIk='
        'pick_number' = '5bqP5Y+3IFsxXQ=='
        'joining' = '5q2j5Zyo5Yqg5YWlIHswfSAuLi4='
        'setup_problem' = 'c2V0dXAg5Zyo5LiK6Z2i5oql5ZGK5LqG6Zeu6aKY'
        'fix_diagnose' = '6K+K5pat77yaYWdlbnRidXMgZG9jdG9y'
        'fix_bad_code' = 'YmFkX2pvaW5fY29kZSAvIDQwM++8muWKoOWFpeeggei/h+acn+aIluiiq+aSpOmUgO+8m+WcqCBodWLvvJrmiJDlkZggPiDmt7vliqAgYWdlbnQg6YeN5paw6I635Y+W'
        'fix_name' = '5ZCN5a2X6KKr5Y2g55SoIC8gNDA577ya5o2i5LiA5LiqICRlbnY6QUdFTlRCVVNfTkFNRQ=='
        'fix_rerun' = '5Y+q6YeN6LeR5Yqg5YWl77yaYWdlbnRidXMgc2V0dXAgLS1odWIgezB9IC0tam9pbi1jb2RlIC4uLg=='
        'done' = '5a6M5oiQ'
        'done_step1' = 'MS4g5Zui6Zif566h55CG5ZGY5ZyoIGh1Yu+8iOaIkOWRmO+8ieS4iuaJueWHhui/meS4qiBhZ2VudA=='
        'done_step2' = 'Mi4g5qOA5p+l77yaYWdlbnRidXMgc3RhdHVzICAgIOiviuaWre+8mmFnZW50YnVzIGRvY3Rvcg=='
        'done_step3' = 'My4g54S25ZCO5ZyoIGh1YiDnmoTku7vmhI/orqjorrrkuLLph4wgQCDlroM='
        'how_to_fix' = '6Kej5Yaz5Yqe5rOV77ya'
        'faq' = '5paH5qGj77yaaHR0cHM6Ly9kb2NzLmh1Yi5zaGlyb2hhLnRlY2gvZ3VpZGUvZmFx'
        'unsupported_cpu' = '5LiN5pSv5oyB55qEIENQVe+8mid7MH0n'
        'fix_build' = '55SoIEdvIOS7jua6kOeggeWuieijhe+8mnswfQ=='
        'no_tag' = '5peg5rOV6Kej5p6Q5pyA5paw54mI5pys5Y+377yb5pS555SoIHJlbGVhc2VzL2xhdGVzdC9kb3dubG9hZA=='
        'no_release' = '5ZyoIHswfSDmib7kuI3liLDlj5HluIPljIXvvIh7MX3vvIk='
        'fix_network' = '5qOA5p+l572R57ucIC8g5Luj55CG77yaSW52b2tlLVdlYlJlcXVlc3QgaHR0cHM6Ly9naXRodWIuY29tIC1Vc2VCYXNpY1BhcnNpbmc='
        'fix_tag' = '5qOA5p+l54mI5pys5Y+377yaQUdFTlRCVVNfVkVSU0lPTj17MH3vvIjlpoIgdjAuNi4w77yM55WZ56m6ID0g5pyA5paw54mI77yJ'
        'no_asset' = '5Y+R5biD5YyF6YeM5rKh5pyJIHswfe+8iHsxfe+8iQ=='
        'fix_platform' = '6K+l54mI5pys5Y+v6IO95rKh5pyJ5p6E5bu66L+Z5Liq5bmz5Y+w77yb6K+V6K+V5pyA5paw5Y+R5biD54mI'
        'no_sum' = 'U0hBMjU2U1VNUyDph4zmsqHmnIkgezB9'
        'fix_uploading' = '5Y+R5biD5YyF5Y+v6IO96L+Y5Zyo5LiK5Lyg77yb562J5LiA5YiG6ZKf5YaN6K+V'
        'bad_sum' = 'ezB9IOeahOagoemqjOWSjOS4jeWMuemFjQ=='
        'fix_mitm' = '5LiL6L295o2f5Z2P5oiW6KKr5Yqr5oyB77yb6K+36YeN6K+V77yM5pyA5aW95LiN6KaB57uP6L+H5Lit6Ze05Lq65Luj55CG'
        'binary_dead' = '5LiL6L2955qE5LqM6L+b5Yi25paH5Lu25peg5rOV5Zyo6L+Z5Y+w5py65Zmo5LiK6L+Q6KGM'
        'fix_av' = '5p2A5q+S6L2v5Lu2IC8gU21hcnRTY3JlZW4g5Y+v6IO95oum5oiq5LqG5a6D77yb5YWB6K64IGFnZW50YnVzLmV4ZSDlkI7ph43or5U='
        'hub_label' = 'aHViICA='
        'code_label' = '5Yqg5YWl56CBIA=='
        'name_label' = '5ZCN56ewIA=='
        'cli_label' = 'Y2xpICA='
    }
    $script:utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    function M([string]$id, [string]$en) {
        if (-not $script:zhLang) { return $en }
        $b64 = $script:zhText[$id]
        if (-not $b64) { return $en }
        return $script:utf8NoBom.GetString([Convert]::FromBase64String($b64))
    }

    # --- output helpers (colors only on an interactive console, never with NO_COLOR) ---
    $color = $true
    if ($env:NO_COLOR) { $color = $false }
    try { if ([Console]::IsOutputRedirected) { $color = $false } } catch { }
    function W([string]$text, [string]$fg) {
        if ($color -and $fg) { Write-Host $text -ForegroundColor $fg } else { Write-Host $text }
    }
    function Say([string]$msg) { [Console]::Error.WriteLine("install.ps1: $msg") }
    function Step([int]$n, [string]$id, [string]$enTitle) { Write-Host ''; W ("[$n/4] " + (M $id $enTitle)) 'Cyan' }
    function Ok([string]$msg) { W ("  [ok] " + $msg) 'Green' }
    function Info([string]$msg) { W ("  " + $msg) 'DarkGray' }
    function Warn([string]$msg) { W ("  [!] " + $msg) 'Yellow' }
    # Fail with a message plus "how to fix" lines. Throwing keeps the old behaviour
    # (non-zero exit for `powershell -File`, red error for `irm | iex`).
    function Fail([string]$msg, [string[]]$fixes) {
        Write-Host ''
        W ("  [x] " + $msg) 'Red'
        if ($fixes) {
            Write-Host ('  ' + (M 'how_to_fix' 'How to fix:'))
            foreach ($f in $fixes) { Write-Host "    -> $f" }
        }
        W (M 'faq' 'Docs: https://docs.hub.shiroha.tech/guide/faq') 'DarkGray'
        throw "install.ps1: $msg"
    }
    $goInstall = 'go install github.com/shiroha-document/agentbus/cmd/agentbus@latest'

    $base = $env:AGENTBUS_UPDATE_BASE
    if (-not $base) { $base = 'https://github.com/shiroha-document/agentbus' }
    $base = $base.TrimEnd('/')

    Write-Host ''
    W ('  agentbus  - ' + (M 'subtitle' 'one bus for your coding agents')) 'Cyan'
    $verLabel = $env:AGENTBUS_VERSION
    if (-not $verLabel) { $verLabel = 'latest' }
    Info ((M 'installer' 'installer') + " - $verLabel - $base")

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
        default { Fail ((M 'unsupported_cpu' "unsupported CPU '{0}'") -f $cpu) @(((M 'fix_build' 'build from source: {0}') -f $goInstall)) }
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
        if (-not $tag) { Say (M 'no_tag' 'could not resolve the latest tag; using releases/latest/download') }
    }
    if ($tag) { $url = "$base/releases/download/$tag" } else { $url = "$base/releases/latest/download" }

    # --- 1/4 download, 2/4 verify, 3/4 install ---
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("agentbus-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $bin = Join-Path $env:LOCALAPPDATA 'agentbus\bin'
    $dest = Join-Path $bin 'agentbus.exe'
    $prev = $null
    try {
        Step 1 'step_download' 'Download'
        $tagLabel = $tag
        if (-not $tagLabel) { $tagLabel = 'latest' }
        Info "windows/$arch - $asset - $tagLabel"
        $sums = Join-Path $tmp 'SHA256SUMS'
        $file = Join-Path $tmp $asset
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$url/SHA256SUMS" -OutFile $sums -UserAgent 'agentbus-install.ps1'
        } catch {
            Fail ((M 'no_release' 'no release found at {0} ({1})') -f $url, $_.Exception.Message) @(
                (M 'fix_network' 'check your network / proxy: Invoke-WebRequest https://github.com -UseBasicParsing'),
                ((M 'fix_tag' 'check the tag: AGENTBUS_VERSION={0} (e.g. v0.6.0, or unset for latest)') -f $env:AGENTBUS_VERSION))
        }
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$url/$asset" -OutFile $file -UserAgent 'agentbus-install.ps1'
        } catch {
            Fail ((M 'no_asset' 'release has no {0} ({1})') -f $asset, $_.Exception.Message) @(
                (M 'fix_platform' 'this platform may not be built for that tag; try the latest release'),
                ((M 'fix_build' 'build from source: {0}') -f $goInstall))
        }
        Ok ((M 'downloaded' 'downloaded {0}') -f $asset)

        Step 2 'step_verify' 'Verify'
        $want = $null
        foreach ($line in Get-Content -LiteralPath $sums) {
            $f = $line.Trim() -split '\s+', 2
            if ($f.Count -eq 2 -and ($f[1] -eq $asset -or $f[1] -eq "*$asset")) { $want = $f[0]; break }
        }
        if (-not $want) { Fail ((M 'no_sum' 'SHA256SUMS does not list {0}') -f $asset) @((M 'fix_uploading' 'the release may still be uploading; wait a minute and retry')) }
        $got = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        if ($got -ine $want) {
            Fail ((M 'bad_sum' 'checksum mismatch for {0}') -f $asset) @((M 'fix_mitm' 'the download was corrupted or intercepted; retry, ideally without a MITM proxy'))
        }
        Ok ("SHA-256 " + $got.Substring(0, 12).ToLower() + "...")

        $newver = & $file --version 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $newver) {
            Fail (M 'binary_dead' 'downloaded binary does not run on this machine') @(
                (M 'fix_av' 'antivirus / SmartScreen may have blocked it; allow agentbus.exe and retry'),
                ((M 'fix_build' 'build from source: {0}') -f $goInstall))
        }
        $newver = "$newver".Trim()
        Ok ((M 'selftest' 'self-test: agentbus {0}') -f $newver)

        Step 3 'step_install' 'Install'
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
        Warn ((M 'path_added' 'added {0} to the user PATH (open a new terminal to pick it up)') -f $bin)
    }
    if (-not (($env:Path -split ';') | Where-Object { $_ -and ((& $norm $_) -ieq (& $norm $bin)) })) {
        $env:Path = "$bin;$env:Path"
    }

    if ($prev -and $prev -ne $newver) {
        Ok ((M 'updated' 'updated agentbus {0} -> {1}  ({2})') -f $prev, $newver, $dest)
    } else {
        Ok ((M 'installed' 'installed agentbus {0}  ({1})') -f $newver, $dest)
    }
    & $dest --version

    # --- coding CLIs agentbus can drive (see `agentbus setup --cli ...`) ---
    Write-Host ''
    Write-Host ('  ' + (M 'found_clis' 'Coding CLIs on this machine'))
    $found = $null
    $foundIds = @()
    $foundLabels = @()
    $clis = @(
        @('Claude Code', @('claude'), 'claude'),
        @('Codex', @('codex'), 'codex'),
        @('Cursor', @('cursor-agent', 'agent'), 'cursor'),
        @('Gemini CLI', @('gemini'), 'gemini'),
        @('TRAE CLI', @('traecli', 'trae-cli'), 'traecli'),
        @('DeepSeek Harness', @('dsh'), 'dsh')
    )
    foreach ($c in $clis) {
        $hit = $null
        foreach ($b in $c[1]) {
            if (Get-Command $b -ErrorAction SilentlyContinue) { $hit = $b; break }
        }
        if ($hit) {
            W "    [ok] $($c[0]) ($hit)" 'Green'
            if (-not $found) { $found = $hit }
            $foundIds += $c[2]
            $foundLabels += $c[0]
        } else {
            W "    [--] $($c[0])" 'DarkGray'
        }
    }
    $cli = "$env:AGENTBUS_CLI".Trim()
    if (-not $found -and $cli -ne 'manual' -and $cli -ne 'custom') {
        Warn (M 'no_cli_warn' "no supported coding CLI found; install one first, use --cli custom --template ..., or set `$env:AGENTBUS_CLI='manual' for a self-driven agent (OpenAI dot, ...)")
        Info 'https://docs.hub.shiroha.tech/guide/clis'
    }

    # --- 4/4 join the hub team (one-line onboarding) ---
    Step 4 'step_join' 'Join a hub'
    $hubUrl = "$env:AGENTBUS_HUB".Trim()
    $joinCode = "$env:AGENTBUS_JOIN_CODE".Trim()
    if (-not $hubUrl -and -not $joinCode) {
        Info (M 'skip_join' 'AGENTBUS_HUB / AGENTBUS_JOIN_CODE not set, skipping')
        Say (M 'next_setup' 'next: agentbus setup --hub https://<your hub> --join-code abj_...  (hub: Members > Add agent)')
        Write-Host ''
        Write-Host ('  ' + (M 'next_steps' 'Next steps'))
        Write-Host ('    ' + (M 'next_step1' '1. open your hub > Members > Add agent, copy the join code'))
        Write-Host ('    ' + (M 'next_step2' '2. agentbus setup --hub https://<your hub> --join-code abj_...'))
        Write-Host ('    ' + (M 'next_step3' '3. agentbus doctor'))
        return
    }
    if (-not $hubUrl) {
        Fail (M 'join_code_only' 'AGENTBUS_JOIN_CODE is set but AGENTBUS_HUB is not') @("set it: `$env:AGENTBUS_HUB='https://<your hub>'")
    }
    if (-not $joinCode) {
        Fail (M 'hub_only' 'AGENTBUS_HUB is set but AGENTBUS_JOIN_CODE is not') @('hub: Members > Add agent gives you a join code')
    }
    # several CLIs and none chosen: ask, but only when a person is at the console
    # (an AI agent running this script never gets a question)
    $canAsk = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected
    if (-not $cli -and $foundIds.Count -gt 1 -and $canAsk) {
        Write-Host ''
        Write-Host ('  ' + (M 'pick_cli' 'Which coding CLI should this agent use?'))
        $opts = @($foundIds) + @('manual')
        for ($i = 0; $i -lt $opts.Count; $i++) {
            if ($opts[$i] -eq 'manual') {
                Write-Host ("    $($i + 1)) " + (M 'pick_manual' 'Manual / self-driven (the agent wakes itself and runs agentbus inbox, e.g. OpenAI dot)'))
            } else {
                Write-Host "    $($i + 1)) $($foundLabels[$i])"
            }
        }
        $ans = Read-Host ('  ' + (M 'pick_number' 'number [1]'))
        $n = 0
        if (-not [int]::TryParse("$ans".Trim(), [ref]$n) -or $n -lt 1 -or $n -gt $opts.Count) { $n = 1 }
        $cli = $opts[$n - 1]
    }
    $setupArgs = @('setup', '--hub', $hubUrl, '--join-code', $joinCode, '--yes')
    if ("$env:AGENTBUS_NAME".Trim()) { $setupArgs += @('--name', "$env:AGENTBUS_NAME".Trim()) }
    if ($cli) { $setupArgs += @('--cli', $cli) }
    Info ((M 'hub_label' 'hub  ') + $hubUrl)
    $codeShown = $joinCode
    if ($codeShown.Length -gt 8) { $codeShown = $codeShown.Substring(0, 8) }
    Info ((M 'code_label' 'code ') + "$codeShown...")
    if ("$env:AGENTBUS_NAME".Trim()) { Info ((M 'name_label' 'name ') + "$env:AGENTBUS_NAME".Trim()) }
    if ($cli) { Info ((M 'cli_label' 'cli  ') + $cli) }
    Say ((M 'joining' 'joining {0} ...') -f $hubUrl)
    & $dest @setupArgs
    if ($LASTEXITCODE -ne 0) {
        Fail (M 'setup_problem' 'setup reported a problem above') @(
            (M 'fix_diagnose' 'diagnose: agentbus doctor'),
            (M 'fix_bad_code' 'bad_join_code / 403: the code expired or was revoked; get a new one in hub: Members > Add agent'),
            (M 'fix_name' 'name taken / 409: set another $env:AGENTBUS_NAME'),
            ((M 'fix_rerun' 're-run just the join: agentbus setup --hub {0} --join-code ...') -f $hubUrl))
    }
    Write-Host ''
    Ok (M 'done' 'done')
    Write-Host ''
    Write-Host ('  ' + (M 'next_steps' 'Next steps'))
    Write-Host ('    ' + (M 'done_step1' '1. a team admin approves this agent on the hub (Members)'))
    Write-Host ('    ' + (M 'done_step2' '2. check: agentbus status    diagnose: agentbus doctor'))
    Write-Host ('    ' + (M 'done_step3' '3. then @ it in any thread on the hub'))
}
