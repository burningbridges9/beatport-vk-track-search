<#
.SYNOPSIS
    Builds the unpacked extension into dist\beatport-vk-track-search and a ZIP.

.DESCRIPTION
    Copies extension\ to dist\, checks that every file referenced by the manifest
    exists, and packs a ZIP with forward-slash entry names.

.PARAMETER Test
    Also runs the jsdom test suite before packing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\build.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\build.ps1 -Test
#>
[CmdletBinding()]
param(
    [switch]$Test
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'extension'
$dist = Join-Path $root 'dist'
$name = 'beatport-vk-track-search'
$target = Join-Path $dist $name

$manifestPath = Join-Path $source 'manifest.json'
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version

Write-Host ("Version: {0}" -f $version)

# --- sanity: every file the manifest points at must exist -------------------
$referenced = New-Object System.Collections.Generic.List[string]
$referenced.Add('manifest.json')
if ($manifest.background.service_worker) { $referenced.Add($manifest.background.service_worker) }
if ($manifest.options_ui.page) { $referenced.Add($manifest.options_ui.page) }
foreach ($entry in $manifest.content_scripts) {
    foreach ($file in $entry.js) { $referenced.Add($file) }
    foreach ($file in $entry.css) { $referenced.Add($file) }
}
foreach ($prop in $manifest.icons.PSObject.Properties) { $referenced.Add($prop.Value) }

$missing = @()
foreach ($file in ($referenced | Select-Object -Unique)) {
    if (-not (Test-Path (Join-Path $source $file))) { $missing += $file }
}
if ($missing.Count -gt 0) {
    throw ("Manifest references missing files: {0}" -f ($missing -join ', '))
}
Write-Host ("Manifest references checked: {0} files" -f @($referenced | Select-Object -Unique).Count)

# --- optional test run ------------------------------------------------------
if ($Test) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        $bundled = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
        if (Test-Path $bundled) { $node = Get-Item $bundled } else { throw 'node not found; cannot run tests' }
    }
    $nodePath = if ($node.Source) { $node.Source } else { $node.FullName }
    & $nodePath (Join-Path $root 'test\run-tests.mjs')
    if ($LASTEXITCODE -ne 0) { throw ("Tests failed with exit code {0}" -f $LASTEXITCODE) }
}

# --- copy ------------------------------------------------------------------
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force

$zip = Join-Path $dist ('{0}-{1}.zip' -f $name, $version)
if (Test-Path $zip) { Remove-Item $zip -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem -Path $target -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($target.Length + 1).Replace('\', '/')
        $entryName = $name + '/' + $relative
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
}
finally {
    $archive.Dispose()
}

Write-Host ('Extension folder: {0}' -f $target)
Write-Host ('ZIP archive:      {0} ({1:N0} KB)' -f $zip, ((Get-Item $zip).Length / 1KB))
