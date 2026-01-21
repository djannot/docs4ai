#!/bin/bash

# Download llama-server binaries for all platforms
# Run this script from the project root directory

set -e

LLAMA_CPP_VERSION="b7789"
BASE_URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}"

# Create bin directories
mkdir -p bin/darwin/arm64 bin/darwin/x64 bin/linux/x64 bin/win32/x64

echo "Downloading llama-server binaries (version ${LLAMA_CPP_VERSION})..."

# macOS ARM64 (Apple Silicon)
echo "Downloading macOS ARM64..."
curl -L "${BASE_URL}/llama-${LLAMA_CPP_VERSION}-bin-macos-arm64.tar.gz" -o /tmp/llama-macos-arm64.tar.gz
mkdir -p /tmp/llama-macos-arm64
tar -xzf /tmp/llama-macos-arm64.tar.gz -C /tmp/llama-macos-arm64
cp /tmp/llama-macos-arm64/build/bin/llama-server bin/darwin/arm64/ 2>/dev/null || cp /tmp/llama-macos-arm64/bin/llama-server bin/darwin/arm64/ 2>/dev/null || find /tmp/llama-macos-arm64 -name "llama-server" -exec cp {} bin/darwin/arm64/ \;
chmod +x bin/darwin/arm64/llama-server
rm -rf /tmp/llama-macos-arm64 /tmp/llama-macos-arm64.tar.gz

# macOS x64 (Intel)
echo "Downloading macOS x64..."
curl -L "${BASE_URL}/llama-${LLAMA_CPP_VERSION}-bin-macos-x64.tar.gz" -o /tmp/llama-macos-x64.tar.gz
mkdir -p /tmp/llama-macos-x64
tar -xzf /tmp/llama-macos-x64.tar.gz -C /tmp/llama-macos-x64
cp /tmp/llama-macos-x64/build/bin/llama-server bin/darwin/x64/ 2>/dev/null || cp /tmp/llama-macos-x64/bin/llama-server bin/darwin/x64/ 2>/dev/null || find /tmp/llama-macos-x64 -name "llama-server" -exec cp {} bin/darwin/x64/ \;
chmod +x bin/darwin/x64/llama-server
rm -rf /tmp/llama-macos-x64 /tmp/llama-macos-x64.tar.gz

# Linux x64
echo "Downloading Linux x64..."
curl -L "${BASE_URL}/llama-${LLAMA_CPP_VERSION}-bin-ubuntu-x64.tar.gz" -o /tmp/llama-linux-x64.tar.gz
mkdir -p /tmp/llama-linux-x64
tar -xzf /tmp/llama-linux-x64.tar.gz -C /tmp/llama-linux-x64
cp /tmp/llama-linux-x64/build/bin/llama-server bin/linux/x64/ 2>/dev/null || cp /tmp/llama-linux-x64/bin/llama-server bin/linux/x64/ 2>/dev/null || find /tmp/llama-linux-x64 -name "llama-server" -exec cp {} bin/linux/x64/ \;
chmod +x bin/linux/x64/llama-server
rm -rf /tmp/llama-linux-x64 /tmp/llama-linux-x64.tar.gz

# Windows x64
echo "Downloading Windows x64..."
curl -L "${BASE_URL}/llama-${LLAMA_CPP_VERSION}-bin-win-cpu-x64.zip" -o /tmp/llama-win-x64.zip
mkdir -p /tmp/llama-win-x64
unzip -o /tmp/llama-win-x64.zip -d /tmp/llama-win-x64
cp /tmp/llama-win-x64/build/bin/llama-server.exe bin/win32/x64/ 2>/dev/null || cp /tmp/llama-win-x64/bin/llama-server.exe bin/win32/x64/ 2>/dev/null || find /tmp/llama-win-x64 -name "llama-server.exe" -exec cp {} bin/win32/x64/ \;
rm -rf /tmp/llama-win-x64 /tmp/llama-win-x64.zip

echo ""
echo "Done! llama-server binaries downloaded to bin/"
echo ""
echo "Directory structure:"
find bin -name "llama-server*" -type f 2>/dev/null || echo "Check bin/ directory manually"
