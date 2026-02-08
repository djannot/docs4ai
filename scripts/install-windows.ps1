$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
    Write-Host 'This installer is for Windows only.'
    exit 1
}

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Host "Missing required command: $Name"
        return $false
    }
    return $true
}

$RootDir = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $RootDir

if (-not (Require-Command git)) {
    Write-Host 'Install Git and re-run: https://git-scm.com/downloads'
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host 'Installing Node.js (via winget)...'
        winget install -e --id OpenJS.NodeJS.LTS
    } else {
        Write-Host 'Node.js 18+ is required. Install from https://nodejs.org/'
        exit 1
    }
}

$NodeMajor = node -p "process.versions.node.split('.')[0]"
if ([int]$NodeMajor -lt 18) {
    Write-Host "Node.js 18+ is required. Current: $(node -v)"
    exit 1
}

Write-Host 'Installing npm dependencies...'
npm install

Write-Host 'Building the app...'
npm run build

Write-Host 'Done. Launch with: npm start'
