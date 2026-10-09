#!/data/data/com.termux/files/usr/bin/bash
# Install current Claude Code on Termux, running under Termux's native bun.
#
# Releases ship only as Bun --compile executables with no linux-arm64-android target, but the
# embedded module graph carries full source text for every module (bytecode is an optimization
# Bun skips when absent). So: unpack the graph, patch it (see patch.js), and run it with `bun`.
#
# Usage: ./install.sh [version]          default: latest
#        BINARY=path/to/claude ./install.sh <version>   reuse a downloaded binary (~250 MB)
set -euo pipefail

PKG="@anthropic-ai/claude-code-linux-x64"
ROOT="$HOME/.local/share/claude-code-bun"
BIN="${TERMUX_PREFIX:-/data/data/com.termux/files/usr}/bin/claude"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

VERSION="${1:-$(curl -fsSL "https://registry.npmjs.org/$PKG/latest" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).version)')}"
DEST="$ROOT/$VERSION"
echo "==> Claude Code $VERSION -> $DEST"

if [ -n "${BINARY:-}" ]; then
  cp "$BINARY" "$WORK/claude"
else
  curl -fsSL "https://registry.npmjs.org/$PKG/-/${PKG#*/}-$VERSION.tgz" | tar xz -C "$WORK" package/claude
  mv "$WORK/package/claude" "$WORK/claude"
fi

# Build beside the target and swap it in only once patching succeeds.
STAGE="$ROOT/.staging"
rm -rf "$STAGE"
bun "$HERE/extract.js" "$WORK/claude" "$STAGE"
bun "$HERE/patch.js" "$STAGE" "$DEST"
rm -rf "$DEST"
mv "$STAGE" "$DEST"

# rm first: an npm-installed `claude` is a symlink into node_modules, and writing through it
# would clobber that package's cli.js.
rm -f "$BIN"
cat > "$BIN" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
exec bun "$DEST/cli.mjs" "\$@"
EOF
chmod +x "$BIN"
"$BIN" --version

# The new version starts, so the wrapper no longer needs any other version.
for old in "$ROOT"/*/; do
  old="${old%/}"
  [ "$old" = "$DEST" ] || { echo "==> removing $old"; rm -rf "$old"; }
done
echo "==> installed $BIN"
