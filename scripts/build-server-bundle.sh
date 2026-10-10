#!/usr/bin/env bash
# AgentDeck: den Server als eigenstaendiges Bundle fuer die Desktop-App bauen.
#
#   scripts/build-server-bundle.sh
#
# Ergebnis: dist-bundle/agentdeck-server/ — alles, was der Server zum Laufen
# braucht, ohne Node/npm auf dem Zielrechner (Linux x86_64 / aarch64):
#
#   agentdeck-server/
#     bin/agentdeck-server   POSIX-sh-Starter (findet sein Verzeichnis, auch ueber Symlinks)
#     bin/tmux               libevent/ncurses statisch gebaut (optional, s. AGENTDECK_BUNDLE_TMUX)
#     licenses/              Lizenztexte von tmux, libevent, ncurses (wenn tmux gebaut wurde)
#     node/bin/node          Node 22 LTS (offizielles Tarball von nodejs.org, SHA256 im Skript gepinnt)
#     app/server/            gebauter Server (dist/) + package.json
#     app/packages/shared/   gebautes @agentdeck/shared (dist/ + package.json)
#     app/web/dist/          gebaute Web-App
#     app/node_modules/      nur Production-Abhaengigkeiten; node-pty gegen DAS gebuendelte Node gebaut
#     app/scripts/           update-zcode.sh (Admin-Rezept "ZCode installieren")
#     version.json           {"version":"x.y.z","builtAt":"…"}
#
# Das Layout ist der Vertrag mit desktop/ (extraResource -> resources/server) und
# mit `agentdeck-server service install` (kopiert den Ordner nach
# ~/.local/share/agentdeck/runtime/<version>/).
#
# Voraussetzung: `npm ci` im Repo ist gelaufen; fuer node-pty werden make, g++
# und python3 gebraucht (wie bei jedem node-gyp-Build).
#
# Umgebungsvariablen (alle optional):
#   AGENTDECK_VERSION            Version fuer version.json. Sonst: Tag ohne "v" (GITHUB_REF_NAME=vX.Y.Z),
#                                sonst `git describe`, sonst Version aus package.json.
#   AGENTDECK_BUNDLE_OUT         Zielordner (Default: <repo>/dist-bundle/agentdeck-server)
#   AGENTDECK_BUNDLE_NODE        Ordner eines bereits entpackten Node (bin/node + include/node)
#                                statt Download — fuer Tests ohne Netz.
#   AGENTDECK_BUNDLE_NODE_VERSION  andere Node-Version fuer den Download als die gepinnte (dann nur mit
#                                SHA256 aus SHASUMS256.txt derselben Quelle — mit Warnung)
#   AGENTDECK_BUNDLE_CACHE       Cache fuer Downloads (Default: ~/.cache/agentdeck-bundle)
#   AGENTDECK_BUNDLE_SKIP_BUILD  1 = `npm run build` ueberspringen (dist/-Ordner existieren schon)
#   AGENTDECK_BUNDLE_TMUX        1 = tmux bauen (scripts/lib/build-tmux-static.sh); Fehler sind nur
#                                eine Warnung: ohne bin/tmux nutzt der Server das System-tmux.
#                                required = wie 1, aber ein fehlgeschlagener Bau (oder ein tmux, das
#                                nicht startet) bricht das Skript ab — fuer Release-Builds in CI.
#                                Pfad zu einer tmux-Datei = die kopieren (ohne Lizenztexte).
set -euo pipefail

# Gepinnt: Node 22 LTS mit den SHA256-Summen der Tarballs (aus
# https://nodejs.org/dist/v<VERSION>/SHASUMS256.txt). Beim Anheben der Version beide
# Summen mitziehen — ein Cache-Treffer wird bei jedem Lauf erneut dagegen geprueft.
NODE_VERSION_PINNED="22.23.3"
NODE_SHA256_X64="df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de"
NODE_SHA256_ARM64="a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f"
NODE_VERSION="${AGENTDECK_BUNDLE_NODE_VERSION:-$NODE_VERSION_PINNED}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info() { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }

OUT="${AGENTDECK_BUNDLE_OUT:-$ROOT/dist-bundle/agentdeck-server}"
CACHE="${AGENTDECK_BUNDLE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/agentdeck-bundle}"
export AGENTDECK_BUNDLE_CACHE="$CACHE"   # auch fuer scripts/lib/build-tmux-static.sh

for tool in npm tar sed grep sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool nicht gefunden."
done

# Arbeitsordner: entpacktes Node und die Production-Abhaengigkeiten; wird am Ende geloescht.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/agentdeck-bundle.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

[[ "$(uname -s)" == "Linux" ]] || die "Das Bundle wird nur unter Linux gebaut ($(uname -s))."
case "$(uname -m)" in
  x86_64)        NODE_ARCH=x64;   NODE_SHA256="$NODE_SHA256_X64" ;;
  aarch64|arm64) NODE_ARCH=arm64; NODE_SHA256="$NODE_SHA256_ARM64" ;;
  *) die "Nicht unterstuetzte Architektur: $(uname -m)" ;;
esac

# ---------------------------------------------------------------- Version
# `v1.2.3` -> 1.2.3, `v1.2.3-4-gabc1234` -> 1.2.3-4-gabc1234 (wie server/src/version.ts)
version_from_describe() {
  [[ "$1" =~ ^v([0-9]+\.[0-9]+\.[0-9]+(-[0-9]+-g[0-9a-f]+)?)$ ]] && printf '%s' "${BASH_REMATCH[1]}"
}

VERSION="${AGENTDECK_VERSION:-}"
VERSION="${VERSION#v}"
if [[ -z "$VERSION" && "${GITHUB_REF_NAME:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  VERSION="${GITHUB_REF_NAME#v}"
fi
if [[ -z "$VERSION" ]] && command -v git >/dev/null 2>&1 && [[ -e .git ]]; then
  VERSION="$(version_from_describe "$(git describe --tags --match 'v[0-9]*' 2>/dev/null || true)" || true)"
fi
if [[ -z "$VERSION" ]]; then
  VERSION="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' package.json | head -n 1)"
fi
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*$ ]] || die "Unbrauchbare Version: '$VERSION'"
info "Version $VERSION (Node $NODE_VERSION, linux-$NODE_ARCH)"

# ---------------------------------------------------------------- Build
if [[ "${AGENTDECK_BUNDLE_SKIP_BUILD:-}" == "1" ]]; then
  info "Build uebersprungen (AGENTDECK_BUNDLE_SKIP_BUILD=1)"
else
  [[ -d node_modules ]] || die "node_modules fehlt — erst 'npm ci' ausfuehren."
  info "Baue shared, server und web (npm run build) …"
  npm run build
fi
[[ -f server/dist/cli.js ]]          || die "server/dist/cli.js fehlt — Server nicht gebaut."
[[ -f packages/shared/dist/index.js ]] || die "packages/shared/dist fehlt — shared nicht gebaut."
[[ -f web/dist/index.html ]]         || die "web/dist/index.html fehlt — Web-App nicht gebaut."

# ---------------------------------------------------------------- Node
# fetch_node entpackt Node nach $STAGE/node und gibt den Ordner aus (bin/node, include/node/).
# Das Tarball liegt im Cache und wird bei JEDEM Lauf gegen die gepinnte SHA256 geprueft
# (ein manipulierter Cache-Treffer faellt so auf); entpackt wird frisch.
fetch_node() {
  local name="node-v${NODE_VERSION}-linux-${NODE_ARCH}" base="https://nodejs.org/dist/v${NODE_VERSION}"
  local expected archive
  command -v xz >/dev/null 2>&1 || die "xz nicht gefunden (Node-Tarball ist .tar.xz; Ubuntu: apt install xz-utils)."
  archive="$CACHE/$name.tar.xz"
  if [[ "$NODE_VERSION" == "$NODE_VERSION_PINNED" ]]; then
    expected="$NODE_SHA256"
  else
    warn "Node $NODE_VERSION ist nicht gepinnt (gepinnt: $NODE_VERSION_PINNED) — die SHA256 kommt aus SHASUMS256.txt derselben Quelle, ohne unabhaengige Pruefung."
    mkdir -p "$CACHE"
    curl -fsSL --retry 3 -o "$CACHE/SHASUMS256-$NODE_VERSION.txt" "$base/SHASUMS256.txt" \
      || die "SHASUMS256.txt fuer Node $NODE_VERSION nicht ladbar ($base)."
    expected="$(grep -E "  ${name}\.tar\.xz\$" "$CACHE/SHASUMS256-$NODE_VERSION.txt" | cut -d' ' -f1 | head -n 1)"
    [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die "Keine Pruefsumme fuer $name.tar.xz in SHASUMS256.txt."
  fi
  if [[ -f "$archive" ]] && printf '%s  %s\n' "$expected" "$archive" | sha256sum -c --status - 2>/dev/null; then
    info "Node-Tarball aus dem Cache (SHA256 stimmt): $archive" >&2
  else
    command -v curl >/dev/null 2>&1 || die "curl nicht gefunden (Node-Download)."
    mkdir -p "$CACHE"
    info "Hole $name.tar.xz von nodejs.org …" >&2
    rm -f "$archive" "$archive.part"
    curl -fsSL --retry 3 -o "$archive.part" "$base/$name.tar.xz" || die "Download von $name.tar.xz fehlgeschlagen."
    if ! printf '%s  %s\n' "$expected" "$archive.part" | sha256sum -c --status -; then
      rm -f "$archive.part"
      die "SHA256 von $name.tar.xz stimmt nicht mit der Pruefsumme ueberein (erwartet $expected)."
    fi
    mv "$archive.part" "$archive"
  fi
  mkdir -p "$STAGE/node"
  tar -xf "$archive" -C "$STAGE/node"
  printf '%s' "$STAGE/node/$name"
}

if [[ -n "${AGENTDECK_BUNDLE_NODE:-}" ]]; then
  NODE_DIR="$(cd "$AGENTDECK_BUNDLE_NODE" && pwd)" || die "AGENTDECK_BUNDLE_NODE: Ordner nicht gefunden."
  info "Node aus AGENTDECK_BUNDLE_NODE: $NODE_DIR"
else
  NODE_DIR="$(fetch_node)"
fi
[[ -x "$NODE_DIR/bin/node" ]] || die "$NODE_DIR/bin/node fehlt oder ist nicht ausfuehrbar."
[[ -f "$NODE_DIR/include/node/node.h" ]] \
  || die "$NODE_DIR/include/node fehlt — node-pty braucht die Header des gebuendelten Node."
NODE_BUNDLED_VERSION="$("$NODE_DIR/bin/node" -p 'process.versions.node')"
[[ "${NODE_BUNDLED_VERSION%%.*}" == "22" ]] || warn "Gebuendeltes Node ist $NODE_BUNDLED_VERSION, erwartet wird 22.x."

# ---------------------------------------------------------------- Production-Abhaengigkeiten
# Staging-Ordner mit der Struktur des Repos (nur die package.json der Workspaces,
# damit das Root-Lockfile unveraendert zu ihnen passt) -> `npm ci --omit=dev -w server`
# installiert genau die Production-Abhaengigkeiten von server + shared, mit den
# Versionen aus dem Lockfile.
DEPS="$STAGE/deps"
mkdir -p "$DEPS"
cp package.json package-lock.json "$DEPS/"
for ws in $(node -p 'require("./package.json").workspaces.join(" ")' 2>/dev/null || echo "packages/* server web mobile"); do
  for dir in $ws; do
    [[ -f "$dir/package.json" ]] || continue
    mkdir -p "$DEPS/$dir"
    cp "$dir/package.json" "$DEPS/$dir/"
  done
done

info "Installiere Production-Abhaengigkeiten (npm ci --omit=dev) …"
# Das gebuendelte Node zuerst auf den PATH: npm/node-gyp laufen damit. Lifecycle-
# Skripte aus: nur node-pty hat eines und wird danach gezielt gebaut.
(
  cd "$DEPS"
  export PATH="$NODE_DIR/bin:$PATH"
  export npm_config_nodedir="$NODE_DIR"   # Header des gebuendelten Node, kein Download
  export npm_config_update_notifier=false
  npm ci --omit=dev -w server --ignore-scripts --no-audit --no-fund
  info "Baue node-pty gegen Node $NODE_BUNDLED_VERSION …"
  npm rebuild node-pty --foreground-scripts
)
[[ -f "$DEPS/node_modules/node-pty/build/Release/pty.node" ]] || die "node-pty wurde nicht gebaut (build/Release/pty.node fehlt)."

# ---------------------------------------------------------------- Zusammenbauen
info "Setze das Bundle zusammen: $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/node/bin" "$OUT/app/server" "$OUT/app/packages/shared" "$OUT/app/web" "$OUT/app/scripts"

install -m 0755 "$NODE_DIR/bin/node" "$OUT/node/bin/node"
[[ -f "$NODE_DIR/LICENSE" ]] && install -m 0644 "$NODE_DIR/LICENSE" "$OUT/node/LICENSE"

cp -a "$DEPS/node_modules" "$OUT/app/node_modules"
# Laufzeit-Ballast: Link-Ordner und npm-Metadaten; von node-pty bleiben lib/ und das gebaute pty.node.
rm -rf "$OUT/app/node_modules/.bin" "$OUT/app/node_modules/.package-lock.json"
PTY="$OUT/app/node_modules/node-pty"
find "$PTY" -mindepth 1 -maxdepth 1 ! -name lib ! -name build ! -name package.json ! -name LICENSE -exec rm -rf {} +
find "$PTY/build" -mindepth 1 -maxdepth 1 ! -name Release -exec rm -rf {} +
find "$PTY/build/Release" -mindepth 1 -maxdepth 1 ! -name pty.node -exec rm -rf {} +

# Die Workspace-Links (node_modules/@agentdeck/{server,shared}) zeigen auf ../../server
# und ../../packages/shared — also genau auf diese Ordner.
cp -a server/dist "$OUT/app/server/dist"
cp server/package.json "$OUT/app/server/package.json"
cp -a packages/shared/dist "$OUT/app/packages/shared/dist"
cp packages/shared/package.json "$OUT/app/packages/shared/package.json"
cp -a web/dist "$OUT/app/web/dist"
find "$OUT/app" -path "$OUT/app/node_modules" -prune -o -name '*.map' -type f -exec rm -f {} +
chmod +x "$OUT/app/server/dist/cli.js"
install -m 0755 scripts/update-zcode.sh "$OUT/app/scripts/update-zcode.sh"

printf '{"version":"%s","builtAt":"%s"}\n' "$VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/version.json"

# POSIX-sh-Starter: loest Symlinks auf (der Dienst startet ueber runtime/current/…),
# findet so node/ und app/ und uebergibt alle Argumente unveraendert.
cat > "$OUT/bin/agentdeck-server" <<'LAUNCHER'
#!/bin/sh
# AgentDeck server launcher — runs the bundled Node with the bundled server.
self="$0"
while [ -h "$self" ]; do
  dir="$(cd -P "$(dirname "$self")" && pwd)"
  target="$(readlink "$self")"
  case "$target" in
    /*) self="$target" ;;
    *) self="$dir/$target" ;;
  esac
done
ROOT="$(cd -P "$(dirname "$self")/.." && pwd)"
exec "$ROOT/node/bin/node" "$ROOT/app/server/dist/cli.js" "$@"
LAUNCHER
chmod 0755 "$OUT/bin/agentdeck-server"

# ---------------------------------------------------------------- tmux (optional)
TMUX_NOTE="nicht gebuendelt (System-tmux)"
TMUX_MODE="${AGENTDECK_BUNDLE_TMUX:-}"
case "$TMUX_MODE" in
  "" | 0) ;;
  1 | required)
    info "Baue tmux (libevent/ncurses statisch) …"
    if "$ROOT/scripts/lib/build-tmux-static.sh" "$OUT/bin/tmux" "$OUT/licenses" && "$OUT/bin/tmux" -V >/dev/null 2>&1; then
      TMUX_NOTE="$("$OUT/bin/tmux" -V) (libevent/ncurses statisch)"
    else
      rm -rf "$OUT/bin/tmux" "$OUT/licenses"
      [[ "$TMUX_MODE" != "required" ]] || die "AGENTDECK_BUNDLE_TMUX=required: tmux wurde nicht gebaut oder startet nicht."
      warn "tmux konnte nicht gebaut werden — das Bundle nutzt das tmux des Systems."
    fi
    ;;
  *)
    if [[ -x "$TMUX_MODE" ]] && install -m 0755 "$TMUX_MODE" "$OUT/bin/tmux"; then
      TMUX_NOTE="aus $TMUX_MODE kopiert (ohne Lizenztexte)"
    else
      warn "AGENTDECK_BUNDLE_TMUX=$TMUX_MODE ist keine ausfuehrbare Datei — ohne gebuendeltes tmux."
    fi
    ;;
esac

# ---------------------------------------------------------------- Selbsttest
info "Pruefe das Bundle …"
# Aus app/server/ heraus, damit die Module des Bundles aufgeloest werden, nicht die des Repos.
(
  cd "$OUT/app/server"
  "$OUT/node/bin/node" --input-type=module -e "
    const { createRequire } = await import('node:module');
    const pty = createRequire(process.cwd() + '/package.json')('node-pty');
    if (typeof pty.spawn !== 'function') throw new Error('node-pty hat kein spawn');
    await import('@agentdeck/shared');
  "
) || die "Das Bundle kann node-pty / @agentdeck/shared nicht laden."
INFO_JSON="$(AGENTDECK_DATA_DIR="$STAGE/selftest-data" "$OUT/bin/agentdeck-server" info --json)" \
  || die "'agentdeck-server info --json' schlaegt fehl."
printf '%s' "$INFO_JSON" | "$OUT/node/bin/node" -e '
  const info = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  if (info.version !== process.argv[1] || info.packaged !== true || !info.webDist) {
    throw new Error("unerwartete Info: " + JSON.stringify(info));
  }
' "$VERSION" || die "'agentdeck-server info --json' liefert unerwartete Daten: $INFO_JSON"

SIZE="$(du -sh "$OUT" | cut -f1)"
info "Fertig: $OUT ($SIZE)"
printf '    Version: %s\n    Node:    %s\n    tmux:    %s\n' "$VERSION" "$NODE_BUNDLED_VERSION" "$TMUX_NOTE"
