param(
    [ValidateSet('none', 'patch', 'minor', 'major')]
    [string]$Bump = 'patch'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

Write-Host "[release] Working directory: $repoRoot"

if ($Bump -ne 'none') {
    Write-Host "[release] Bumping version: $Bump"
    npm version $Bump --no-git-tag-version
}

Write-Host "[release] Compiling extension"
npm run compile

Write-Host "[release] Packaging VSIX"
npx @vscode/vsce package --allow-missing-repository --skip-license

$vsix = Get-ChildItem -Path $repoRoot -Filter *.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) {
    throw "No VSIX file found after packaging."
}

Write-Host "[release] Done"
Write-Host "[release] VSIX: $($vsix.FullName)"
