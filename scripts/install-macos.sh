#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "This installer is for macOS only."
    exit 1
fi

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Missing required command: $1"
        return 1
    fi
}

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

require_cmd git || {
    echo "Install Git and re-run: https://git-scm.com/downloads"
    exit 1
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
        echo "Installing Node.js (via Homebrew)..."
        brew install node
    else
        echo "Node.js 18+ is required. Install from https://nodejs.org/ or brew install node"
        exit 1
    fi
fi

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$node_major" -lt 18 ]]; then
    echo "Node.js 18+ is required. Current: $(node -v)"
    exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
    echo "Xcode Command Line Tools are required. Running: xcode-select --install"
    xcode-select --install
    echo "Re-run this script after the installation completes."
    exit 1
fi

echo "Installing npm dependencies..."
npm install

echo "Building the app..."
npm run build

echo "Done. Launch with: npm start"
