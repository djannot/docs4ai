#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "This installer is for Linux only."
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
    echo "Node.js 18+ is required. Install from https://nodejs.org/ or your package manager."
    exit 1
fi

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$node_major" -lt 18 ]]; then
    echo "Node.js 18+ is required. Current: $(node -v)"
    exit 1
fi

missing_build_tools=false
for tool in python3 make g++; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        missing_build_tools=true
    fi
done

if [[ "$missing_build_tools" == "true" ]]; then
    if command -v apt-get >/dev/null 2>&1; then
        echo "Installing build tools (via apt-get)..."
        sudo apt-get update
        sudo apt-get install -y build-essential python3 make g++
    else
        echo "Build tools are required (python3, make, g++). Install via your package manager."
        exit 1
    fi
fi

echo "Installing npm dependencies..."
npm install

echo "Building the app..."
npm run build

echo "Done. Launch with: npm start"
