# install.ps1 - Canonical installer for AntiGravity AutoAccept in the Antigravity IDE
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1
#
# This script:
# 1. Builds the VSIX with vsce
# 2. Extracts it to the Antigravity extensions directory with the correct directory name
# 3. Adds proper __metadata to package.json (targetPlatform: "universal")
# 4. Registers the extension in extensions.json with complete metadata
#
# Why manual? The Antigravity IDE's `--install-extension` CLI has an internal error
# with locally-built VSIXs. The pesosz extension that works was installed through
# the marketplace which handles metadata automatically. We replicate that here.

param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
Add-Type -Assembly System.IO.Compression.FileSystem

$sourceDir = $PSScriptRoot
$extensionsDir = Join-Path $env:USERPROFILE ".antigravity\extensions"
$extJsonPath = Join-Path $extensionsDir "extensions.json"

# Read version from package.json
$pkgJson = Get-Content (Join-Path $sourceDir "package.json") -Raw | ConvertFrom-Json
$version = $pkgJson.version
$extId = "$($pkgJson.publisher.ToLower()).$($pkgJson.name)"
$vsixName = "$($pkgJson.name)-$version.vsix"
$vsixPath = Join-Path $sourceDir $vsixName
$targetDirName = "$extId-$version-universal"
$targetDir = Join-Path $extensionsDir $targetDirName

Write-Host "=== AntiGravity AutoAccept Installer ===" -ForegroundColor Cyan
Write-Host "Version: $version"
Write-Host "Extension ID: $extId"
Write-Host "Target: $targetDir"
Write-Host ""

# Step 1: Build VSIX
if (-not $SkipBuild) {
    Write-Host "[1/4] Building VSIX..." -ForegroundColor Yellow
    Push-Location $sourceDir
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    npm install --production 2>&1 | Out-Null
    npx @vscode/vsce package -o $vsixName 2>&1 | Out-Null
    $ErrorActionPreference = $prevEAP
    Pop-Location
    
    if (-not (Test-Path $vsixPath)) {
        Write-Error "VSIX build failed - $vsixPath not found"
        exit 1
    }
    $vsixSize = (Get-Item $vsixPath).Length
    Write-Host "  Built: $vsixName ($vsixSize bytes)"
    if ($vsixSize -lt 70000) {
        Write-Warning "VSIX is suspiciously small ($vsixSize bytes). Expected ~80KB+. node_modules might be missing!"
    }
} else {
    Write-Host "[1/4] Skipping build (using existing VSIX)" -ForegroundColor DarkGray
}

# Step 2: Remove old versions and extract
Write-Host "[2/4] Installing extension files..." -ForegroundColor Yellow
Get-ChildItem $extensionsDir -Filter "$extId-*" -Directory | ForEach-Object {
    Write-Host "  Removing old: $($_.Name)"
    Remove-Item $_.FullName -Recurse -Force
}

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

$zip = [System.IO.Compression.ZipFile]::OpenRead($vsixPath)
$fileCount = 0
foreach ($entry in $zip.Entries) {
    if ($entry.FullName.StartsWith("extension/")) {
        $relativePath = $entry.FullName.Substring("extension/".Length)
        if ([string]::IsNullOrEmpty($relativePath) -or $entry.FullName.EndsWith("/")) { continue }
        
        $targetPath = Join-Path $targetDir $relativePath
        $parentDir = Split-Path -Parent $targetPath
        if (-not (Test-Path $parentDir)) {
            New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
        }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $targetPath, $true)
        $fileCount++
    }
}
$zip.Dispose()
Write-Host "  Extracted $fileCount files"

# Step 3: Patch package.json with __metadata
Write-Host "[3/4] Adding __metadata to package.json..." -ForegroundColor Yellow
$installedPkgPath = Join-Path $targetDir "package.json"
$installedPkg = Get-Content $installedPkgPath -Raw | ConvertFrom-Json

$metadata = @{
    installedTimestamp = [long]([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
    targetPlatform = "universal"
    size = (Get-Item $vsixPath).Length
    isApplicationScoped = $false
    isMachineScoped = $false
    isBuiltin = $false
    pinned = $false
    source = "vsix"
    updated = $false
    private = $false
    isPreReleaseVersion = $false
    hasPreReleaseVersion = $false
}
$installedPkg | Add-Member -NotePropertyName "__metadata" -NotePropertyValue $metadata -Force
$pkgJsonText = $installedPkg | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($installedPkgPath, $pkgJsonText, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "  targetPlatform: universal"

# Step 4: Register in extensions.json
Write-Host "[4/4] Updating extensions.json..." -ForegroundColor Yellow
$extensions = Get-Content $extJsonPath -Raw | ConvertFrom-Json

# Remove old entries for our extension
$extensions = @($extensions | Where-Object { $_.identifier.id -ne $extId })

# Add new entry
$newEntry = [PSCustomObject]@{
    identifier = [PSCustomObject]@{ id = $extId }
    version = $version
    location = [PSCustomObject]@{
        '$mid' = 1
        path = "/c:/Users/galaxywin/.antigravity/extensions/$targetDirName"
        scheme = "file"
    }
    relativeLocation = $targetDirName
    metadata = [PSCustomObject]@{
        installedTimestamp = [long]([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
        pinned = $false
        source = "vsix"
        targetPlatform = "universal"
        updated = $false
        private = $false
        isPreReleaseVersion = $false
        hasPreReleaseVersion = $false
        isApplicationScoped = $false
        isMachineScoped = $false
        isBuiltin = $false
    }
}
$extensions += $newEntry

$json = $extensions | ConvertTo-Json -Depth 10 -Compress
[System.IO.File]::WriteAllText($extJsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "  Registered in extensions.json"

Write-Host ""
Write-Host "=== Installation Complete ===" -ForegroundColor Green
Write-Host "Restart the Antigravity IDE to load the extension."
Write-Host ""
Write-Host "Verification checklist:" -ForegroundColor DarkGray
Write-Host "  [x] Directory: $targetDirName"
Write-Host "  [x] targetPlatform: universal"
Write-Host "  [x] engines.vscode: $($installedPkg.engines.vscode)"
Write-Host "  [x] node_modules/ws: $(Test-Path (Join-Path $targetDir 'node_modules\ws\index.js'))"
Write-Host "  [x] extensions.json: updated"
