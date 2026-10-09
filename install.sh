#!/data/data/com.termux/files/usr/bin/bash
# Build a natively-runnable Claude Code for Termux from an upstream Bun standalone binary.
#
# 2.1.113+ ship only as Bun --compile executables with no linux-arm64-android target, but the
# embedded module graph carries full source text for every module (bytecode is an optimization
# Bun skips when absent). So: unpack the graph, repoint its absolute /$bunfs/root/ paths at the
# install dir, and run it with Termux's native `bun`.
set -euo pipefail

VERSION="${1:-}"
PREFIX="$HOME/.local/share/claude-code-bun"
BIN="${TERMUX_PREFIX:-/data/data/com.termux/files/usr}/bin/claude-bun"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -n "$VERSION" ] || VERSION="$(npm view @anthropic-ai/claude-code-linux-x64 version)"
DEST="$PREFIX/$VERSION"
echo "==> version $VERSION -> $DEST"

# BINARY=<path> reuses an already-downloaded `package/claude` (the tarball is ~250 MB).
if [ -n "${BINARY:-}" ]; then
  mkdir -p "$WORK/package" && cp "$BINARY" "$WORK/package/claude"
else
  curl -fsSL "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${VERSION}.tgz" \
    -o "$WORK/native.tgz"
  tar xzf "$WORK/native.tgz" -C "$WORK"
fi

rm -rf "$DEST"
mkdir -p "$DEST"
node "$HERE/bunx.js" "$WORK/package/claude" "$DEST"
node "$HERE/rewrite.js" "$DEST"
cp "$DEST/cli" "$DEST/cli.mjs"

mkdir -p "$(dirname "$BIN")"
cat > "$BIN" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
exec bun "$DEST/cli.mjs" "\$@"
EOF
chmod +x "$BIN"

echo "==> installed: $BIN"
"$BIN" --version
