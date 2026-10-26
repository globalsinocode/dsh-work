# Local PostgreSQL maintenance instance for integration tests.
# Run in a normal PowerShell (PATH must include System32 so initdb can call chcp).
# Suites CREATE/DROP throwaway databases from this maintenance URL; never point at dsh_work.

$ErrorActionPreference = 'Stop'

$PgBin = 'C:\Program Files\PostgreSQL\17\bin'
$InitDb = Join-Path $PgBin 'initdb.exe'
if (-not (Test-Path $InitDb)) {
  throw ('PostgreSQL 17 initdb not found: ' + $InitDb)
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DataDir = Join-Path $RepoRoot '.local\pg17-test-data'
$Port = 5434
$LogFile = Join-Path $DataDir 'server.log'

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

# HKLM cmd AutoRun is `chcp 936`; that prints a code-page line before postgres -V.
# initdb reads the first popen line as the version, so it falsely reports a mismatch.
# A stub chcp earlier in PATH swallows AutoRun without changing the machine registry.
$StubDir = Join-Path $RepoRoot '.local\pg-stub'
New-Item -ItemType Directory -Path $StubDir -Force | Out-Null
$ChcpStub = Join-Path $StubDir 'chcp.cmd'
if (-not (Test-Path $ChcpStub)) {
  Set-Content -Path $ChcpStub -Value "@echo off`r`nexit /b 0`r`n" -Encoding ascii
}
$env:PATH = $StubDir + ';' + $PgBin + ';C:\Windows\System32;C:\Windows'
$env:ComSpec = 'C:\Windows\System32\cmd.exe'

$PgVersionFile = Join-Path $DataDir 'PG_VERSION'
if (-not (Test-Path $PgVersionFile)) {
  Write-Host ('Initializing cluster: ' + $DataDir)
  & $InitDb -D $DataDir -U postgres -E UTF8 --locale=C -A trust
  if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
  $conf = Join-Path $DataDir 'postgresql.conf'
  Add-Content -Path $conf -Value ("`nport = " + $Port + "`nlisten_addresses = '127.0.0.1'`n")
}

$PgCtl = Join-Path $PgBin 'pg_ctl.exe'
& $PgCtl -D $DataDir status
if ($LASTEXITCODE -ne 0) {
  Write-Host ('Starting Postgres on port ' + $Port)
  & $PgCtl -D $DataDir -l $LogFile start
  if ($LASTEXITCODE -ne 0) { throw 'pg_ctl start failed' }
}

$PgIsReady = Join-Path $PgBin 'pg_isready.exe'
& $PgIsReady -h 127.0.0.1 -p $Port -U postgres
if ($LASTEXITCODE -ne 0) { throw 'pg_isready failed' }

Write-Host ''
Write-Host ('DSH_WORK_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:' + $Port + '/postgres')
Write-Host 'Then: npx --yes pnpm@11.7.0 test:agent-release:integration'
