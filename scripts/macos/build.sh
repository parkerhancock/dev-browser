#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
out="${1:-$root/dist}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
scratch="$(mktemp -d)"
trap 'node -e '\''require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })'\'' "$scratch"' EXIT

case "$(uname -m)" in
  arm64) arch=arm64; sha=e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d ;;
  x86_64) arch=x64; sha=c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422 ;;
  *) echo "Unsupported Mac architecture" >&2; exit 1 ;;
esac
node_dist="node-v22.23.5-darwin-$arch"
curl -fsSL "https://nodejs.org/dist/v22.23.5/$node_dist.tar.gz" -o "$scratch/node.tar.gz"
(cd "$scratch" && printf '%s  node.tar.gz\n' "$sha" | shasum -a 256 -c)
tar -xzf "$scratch/node.tar.gz" -C "$scratch"
export PATH="$scratch/$node_dist/bin:$PATH"
export npm_config_cache="$scratch/npm"

app="$scratch/Dev Browser Setup.app"
contents="$app/Contents"
resources="$contents/Resources"
mkdir -p "$contents/MacOS" "$resources/runtime" "$resources/macos"
cp "$scratch/$node_dist/bin/node" "$resources/node"
cp "$scratch/$node_dist/LICENSE" "$resources/NODE-LICENSE.txt"
cp "$root/LICENSE" "$resources/LICENSE.txt"
cp "$root/scripts/setup.mjs" "$resources/setup.mjs"
cp "$root/scripts/macos/install.mjs" "$resources/macos/install.mjs"

for package in mcp-server skills/dev-browser extension; do
  dst="$resources/runtime/$package"
  mkdir -p "$dst"
  rsync -a --exclude=node_modules --exclude=.output --exclude=.wxt --exclude=tmp --exclude=profiles --exclude='.browser-data*' "$root/$package/" "$dst/"
  (cd "$dst" && npm ci --no-audit --no-fund)
done
(cd "$resources/runtime/extension" && npm run build)
mv "$resources/runtime/extension/.output/chrome-mv3" "$resources/chrome-mv3"
node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$resources/runtime/extension"

version="$(node -p "require(process.argv[1]).version" "$root/extension/package.json")"
build="$(git -C "$root" rev-parse --short HEAD)"
node -e 'console.log(JSON.stringify({version:process.argv[1],build:process.argv[2]}))' "$version" "$build" > "$resources/package-info.json"
xcrun swiftc -O -module-cache-path "$scratch/swift-cache" -target "$(uname -m)-apple-macos14.0" "$root/scripts/macos/Setup.swift" -o "$contents/MacOS/Dev Browser Setup"
cat > "$contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.dev-browser.setup</string>
<key>CFBundleName</key><string>Dev Browser Setup</string>
<key>CFBundleExecutable</key><string>Dev Browser Setup</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleVersion</key><string>$version</string>
</dict></plist>
PLIST
codesign --force --sign - "$app"
codesign --verify "$app"
ditto -c -k --sequesterRsrc --keepParent "$app" "$out/dev-browser-macos-$version-$arch.zip"
printf '%s\n' "$out/dev-browser-macos-$version-$arch.zip"
