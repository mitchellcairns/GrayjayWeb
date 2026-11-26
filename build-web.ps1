# [GrayjayWeb] Builds a ready-to-run Grayjay Web bundle for one platform:
#   out/GrayjayWeb-<rid>/grayjay-tray(.exe)        tray app (double-click this)
#   out/GrayjayWeb-<rid>/server/GrayjayWebServer   self-contained .NET server (no .NET install needed)
#   out/GrayjayWeb-<rid>/server/app/               the PWA
# Usage:  ./build-web.ps1 [-Rid win-x64|linux-x64|linux-arm64|osx-arm64|osx-x64]
param(
    [string]$Rid = "win-x64"
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$out = Join-Path $root "out/GrayjayWeb-$Rid"

Write-Host "==> Building PWA" -ForegroundColor Cyan
Push-Location (Join-Path $root "Grayjay.Web.App")
npm ci
npm run build
Pop-Location

Write-Host "==> Publishing server ($Rid)" -ForegroundColor Cyan
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
dotnet publish (Join-Path $root "Grayjay.Web.Host/Grayjay.Web.Host.csproj") -c Release -r $Rid --self-contained true -o (Join-Path $out "server")
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }
Copy-Item (Join-Path $root "LICENSE.md") (Join-Path $out "LICENSE.md")

Write-Host "==> Building tray app" -ForegroundColor Cyan
Push-Location (Join-Path $root "Grayjay.Web.Tray")
$target = switch ($Rid) {
    "win-x64"     { "x86_64-pc-windows-msvc" }
    "win-arm64"   { "aarch64-pc-windows-msvc" }
    "linux-x64"   { "x86_64-unknown-linux-gnu" }
    "linux-arm64" { "aarch64-unknown-linux-gnu" }
    "osx-x64"     { "x86_64-apple-darwin" }
    "osx-arm64"   { "aarch64-apple-darwin" }
}
cargo build --release --target $target
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
$exe = if ($Rid.StartsWith("win")) { "grayjay-tray.exe" } else { "grayjay-tray" }
Copy-Item (Join-Path "target/$target/release" $exe) (Join-Path $out $exe)
Pop-Location

Write-Host "==> Done: $out" -ForegroundColor Green
