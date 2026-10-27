$ErrorActionPreference = "Stop"

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if ((Test-Path $cargoBin) -and ($env:PATH -notlike "*$cargoBin*")) {
    $env:PATH = "$cargoBin;$env:PATH"
}

$tauriDir = Join-Path $PSScriptRoot "tauri"
Push-Location $tauriDir
try {
    $pkgJson = Get-Content "package.json" -Raw | ConvertFrom-Json
    $missingPkg = $false
    $allDeps = @()
    if ($pkgJson.dependencies) {
        $allDeps += $pkgJson.dependencies.PSObject.Properties
    }
    if ($pkgJson.devDependencies) {
        $allDeps += $pkgJson.devDependencies.PSObject.Properties
    }
    foreach ($dep in $allDeps) {
        if (-not (Test-Path (Join-Path "node_modules" $dep.Name))) {
            $missingPkg = $true
            break
        }
    }
    if ($missingPkg) {
        npm ci
    }

    npm run tauri:dev -- --features debug-tools @args
} finally {
    Pop-Location
}
