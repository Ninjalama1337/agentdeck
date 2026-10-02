#!/usr/bin/env bash
# AgentDeck — ZCode CLI installieren ODER aktualisieren (ohne Neustart von etwas).
#
# Beides in einem: klont das Repo falls fehlend, baut die CLI-Distribution und
# installiert sie nach ~/.zcode/runtime (+ Wrapper in ~/.local/bin/zcode).
# Idempotent: bei jedem Lauf auf den neuesten Stand bringen.
set -euo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
if [ ! -t 1 ] || [ -n "${NO_COLOR:-}" ]; then BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""; fi
say()  { printf '%s\n' "${GREEN}==>${RESET} $*"; }
warn() { printf '%s\n' "${YELLOW}WARN:${RESET} $*"; }
die()  { printf '%s\n' "${RED}FEHLER:${RESET} $*" >&2; exit 1; }

SRC="${ZCODE_SRC_DIR:-$HOME/.local/opt/zcode-src}"
NODE_DIR="${ZCODE_NODE_DIR:-$HOME/.local/opt/node-24}"
NODE_VER="24.14.0"
RUNTIME="$HOME/.zcode/runtime"
BIN_LINK="$HOME/.local/bin/zcode"

say "1/7 Node $NODE_VER sicherstellen (portable, ohne Root)"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  mkdir -p "$NODE_DIR"
  curl -fsSL --retry 3 -o /tmp/node24.tar.xz "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-x64.tar.xz" \
    || die "Node-Download fehlgeschlagen"
  tar -xJf /tmp/node24.tar.xz -C "$NODE_DIR" --strip-components=1 && rm /tmp/node24.tar.xz
fi
export PATH="$NODE_DIR/bin:$PATH"
"$(command -v node)" -v || die "node läuft nicht"

say "2/7 pnpm bereitstellen"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
command -v pnpm >/dev/null 2>&1 || corepack enable --install-directory "$NODE_DIR/bin" >/dev/null 2>&1 || true
command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@10.33.2
pnpm --version

say "3/7 Repo ($SRC)"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch --quiet origin main || warn "git fetch fehlgeschlagen — baue aktuellen Stand"
  git -C "$SRC" reset --quiet --hard origin/main 2>/dev/null || true
else
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 https://github.com/zai-org/ZCode.git "$SRC"
fi

cd "$SRC"

say "4/7 Abhängigkeiten installieren"
# Der Filter muss in Anführungszeichen stehen: sonst löst die Shell ihn zu
# Pfaden auf, und pnpm trägt die als neue Abhängigkeiten ein, statt zu installieren.
# Die CLI-Pakete unter apps/zcode-cli hängen nicht am Paket "zcode-cli" selbst
# und müssen eigens genannt werden, sonst fehlen ihnen die node_modules.
pnpm install --filter "zcode-cli..." --filter "./packages/*" \
  --filter "./apps/zcode-cli/packages/*" --filter "./apps/zcode-cli/tools/*"

say "5/7 Pakete bauen (root + apps/zcode-cli)"
# Ohne die Desktop-App: die CLI braucht sie nicht, und ihr Build lädt Node für
# alle Plattformen herunter (mehrere hundert MB).
pnpm -r --filter "./packages/*" --filter "!@zcode/desktop" build
( cd apps/zcode-cli && pnpm -r --filter "./packages/*" build )
# @zcode/shared ist source-only, der Packager will aber dist/index.ts …
if [ ! -f packages/shared/dist/index.js ]; then
  ( cd packages/shared && npx tsc --ignoreConfig src/index.ts --outDir dist \
      --module esnext --target es2022 --moduleResolution bundler --skipLibCheck \
      --declaration false ) || warn "@zcode/shared dist konnte nicht erzeugt werden"
fi

say "6/7 Distribution bauen"
export ZCODE_DIST_BASE_URL="${ZCODE_DIST_BASE_URL:-https://dist.invalid/}"
pnpm build:zcode
TARBALL=$(ls -1 "$SRC"/dist/zcode/releases/*/zcode-*.tar.gz | sort | tail -1)
[ -n "$TARBALL" ] || die "Kein Tarball im Build gefunden"

say "7/7 Runtime installieren ($RUNTIME)"
mkdir -p "$RUNTIME"
rm -rf "$RUNTIME.tmp" && mkdir -p "$RUNTIME.tmp"
tar -xzf "$TARBALL" -C "$RUNTIME.tmp" --strip-components=1
[ -d "$RUNTIME" ] && rm -rf "$RUNTIME.old" && mv "$RUNTIME" "$RUNTIME.old" || true
mv "$RUNTIME.tmp" "$RUNTIME"
rm -rf "$RUNTIME.old"
chmod +x "$RUNTIME/bin/zcode.mjs" 2>/dev/null || true
mkdir -p "$(dirname "$BIN_LINK")"
printf '#!/bin/sh\nexec %s/bin/node %s/bin/zcode.mjs "$@"\n' "$NODE_DIR" "$RUNTIME" > "$BIN_LINK"
chmod +x "$BIN_LINK"

VERSION="$("$BIN_LINK" --version 2>/dev/null | head -1 || echo '?')"
printf '%s\n' "${GREEN}${BOLD}ZCode CLI aktualisiert: $VERSION${RESET} (${TARBALL##*/})"
