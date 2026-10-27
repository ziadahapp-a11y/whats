#!/usr/bin/env sh
# whatsapp-mcp installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/aliaaldihnayn-lab/whats-mcp/main/scripts/install.sh | sh
#
# Downloads the latest release binary into ~/.whatsapp-mcp/bin and registers a
# background service (launchd on macOS, systemd --user on Linux) so the daemon
# keeps receiving messages after you close the terminal.
#
# Options (pass after `sh -s --`):
#   --no-service      install the binary only; start it yourself with `whatsapp-mcp serve`
#   --version vX.Y.Z  install a specific release instead of the latest
set -eu

REPO="aliaaldihnayn-lab/whats-mcp"
HOME_DIR="${WHATSAPP_MCP_HOME:-$HOME/.whatsapp-mcp}"
BIN_DIR="$HOME_DIR/bin"
STORE_DIR="$HOME_DIR/store"
ADDR="127.0.0.1:8765"
SERVICE=1
VERSION="latest"

while [ $# -gt 0 ]; do
  case "$1" in
    --no-service) SERVICE=0 ;;
    --version) VERSION="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) die "unsupported OS $(uname -s). On Windows use install.ps1." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac

ASSET="whatsapp-mcp_${OS}_${ARCH}.tar.gz"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/$ASSET"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
fi

command -v curl >/dev/null 2>&1 || die "curl is required"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading $ASSET"
curl -fL --progress-bar "$URL" -o "$TMP/$ASSET" || die "download failed: $URL"
tar -xzf "$TMP/$ASSET" -C "$TMP"

mkdir -p "$BIN_DIR" "$STORE_DIR/uploads"
chmod 700 "$HOME_DIR" "$STORE_DIR"

# Stop a running service before replacing the binary.
if [ "$OS" = darwin ]; then
  launchctl unload "$HOME/Library/LaunchAgents/com.whatsapp-mcp.plist" 2>/dev/null || true
else
  systemctl --user stop whatsapp-mcp 2>/dev/null || true
fi

install -m 755 "$TMP/whatsapp-mcp" "$BIN_DIR/whatsapp-mcp"
[ "$OS" = darwin ] && xattr -d com.apple.quarantine "$BIN_DIR/whatsapp-mcp" 2>/dev/null || true
say "Installed $("$BIN_DIR/whatsapp-mcp" -version 2>/dev/null || echo whatsapp-mcp) to $BIN_DIR"

if [ "$SERVICE" = 1 ]; then
  if [ "$OS" = darwin ]; then
    PLIST="$HOME/Library/LaunchAgents/com.whatsapp-mcp.plist"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/whatsapp-mcp"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.whatsapp-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN_DIR/whatsapp-mcp</string>
    <string>-store</string><string>$STORE_DIR</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WHATSAPP_MCP_ADDR</key><string>$ADDR</string>
    <key>WHATSAPP_MCP_MEDIA_ROOT</key><string>$STORE_DIR/uploads</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/whatsapp-mcp/stdout.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/whatsapp-mcp/stderr.log</string>
</dict>
</plist>
EOF
    launchctl load "$PLIST"
    say "Background service started (launchd)"
  elif command -v systemctl >/dev/null 2>&1; then
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/whatsapp-mcp.service" <<EOF
[Unit]
Description=whatsapp-mcp daemon
After=network-online.target

[Service]
Type=exec
ExecStart=$BIN_DIR/whatsapp-mcp -store $STORE_DIR serve
Environment=WHATSAPP_MCP_ADDR=$ADDR
Environment=WHATSAPP_MCP_MEDIA_ROOT=$STORE_DIR/uploads
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now whatsapp-mcp
    say "Background service started (systemd --user)"
  else
    SERVICE=0
    say "systemd not found; start the daemon yourself (see below)"
  fi
fi

echo
say "Next steps"
if [ "$SERVICE" = 0 ]; then
  echo "  1. Start the daemon:  $BIN_DIR/whatsapp-mcp -store $STORE_DIR serve"
else
  echo "  1. The daemon is running in the background."
fi
echo "  2. Open http://$ADDR/pair and scan the QR code"
echo "     (WhatsApp on your phone > Settings > Linked devices > Link a device)."
echo "  3. Connect your MCP client:"
echo "     Claude Code / Cursor:"
echo '       { "mcpServers": { "whatsapp": { "type": "http", "url": "http://'"$ADDR"'/mcp" } } }'
echo "     Claude Desktop (needs Node.js):"
echo '       { "mcpServers": { "whatsapp": { "command": "npx", "args": ["-y", "mcp-remote", "http://'"$ADDR"'/mcp"] } } }'
echo
echo "  Files you want to send must be placed in: $STORE_DIR/uploads"
