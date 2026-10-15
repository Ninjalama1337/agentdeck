#!/usr/bin/env bash
# AgentDeck: tmux fuer das Server-Bundle bauen — libevent und ncurses statisch
# eingelinkt, nur libc bleibt dynamisch. Das Ergebnis laeuft auf Rechnern ohne
# installiertes tmux (z. B. unveraenderliche Systeme wie Bazzite) und braucht
# kein libevent/ncurses; die glibc muss zum Baurechner passen oder neuer sein
# (CI: ubuntu-22.04 -> glibc >= 2.35, also Ubuntu 22.04+, Fedora 36+, Debian 12+).
# Absichtlich NICHT voll statisch: eine statische glibc laedt NSS-Module des
# Hosts nach und stolpert ueber andere glibc-Versionen.
#
#   scripts/lib/build-tmux-static.sh <ausgabedatei> [<lizenz-ordner>]
#
# Mit <lizenz-ordner> werden die Lizenztexte von tmux, libevent und ncurses aus den
# Quell-Tarballs dorthin kopiert (tmux-COPYING, libevent-LICENSE, ncurses-COPYING) —
# wer die Binary weitergibt, gibt die Lizenzen mit.
#
# Wird von scripts/build-server-bundle.sh (AGENTDECK_BUNDLE_TMUX=1) aufgerufen.
# Die Quell-Tarballs sind unten mit Version und SHA256 gepinnt; Aenderungen an
# den Versionen muessen die Pruefsummen mitziehen.
#
# Voraussetzungen: curl, tar, make, gcc, yacc/bison.
#
# Umgebungsvariablen:
#   AGENTDECK_BUNDLE_CACHE   Download-Cache (Default: ~/.cache/agentdeck-bundle). Liegen die
#                            Tarballs schon dort (Dateiname wie unten), geht es ohne Netz.
#   AGENTDECK_TMUX_KEEP_BUILD  1 = Build-Ordner nicht loeschen (Fehlersuche)
set -euo pipefail

TMUX_VERSION="3.6a"
TMUX_SHA256="b6d8d9c76585db8ef5fa00d4931902fa4b8cbe8166f528f44fc403961a3f3759"
TMUX_URL="https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"

LIBEVENT_VERSION="2.1.12-stable"
LIBEVENT_SHA256="92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb"
LIBEVENT_URL="https://github.com/libevent/libevent/releases/download/release-${LIBEVENT_VERSION}/libevent-${LIBEVENT_VERSION}.tar.gz"

NCURSES_VERSION="6.5"
NCURSES_SHA256="136d91bc269a9a5785e5f9e980bc76ab57428f604ce3e5a5a90cebc767971cc6"
NCURSES_URL="https://ftp.gnu.org/gnu/ncurses/ncurses-${NCURSES_VERSION}.tar.gz"

# Wo tmux zur Laufzeit die Terminfo-Datenbank sucht (Debian/Ubuntu, Fedora, Alpine …).
TERMINFO_DIRS="/etc/terminfo:/lib/terminfo:/usr/share/terminfo:/usr/lib/terminfo"
# Zusaetzlich fest eingebaut, falls die Datenbank des Hosts einen Eintrag nicht hat.
TERMINFO_FALLBACKS="xterm-256color,xterm,screen-256color,screen,tmux-256color,tmux,linux,vt100"

info() { printf '==> %s\n' "$*" >&2; }
die()  { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }

[[ ($# -eq 1 || $# -eq 2) && -n "$1" ]] || die "Aufruf: $0 <ausgabedatei> [<lizenz-ordner>]"
OUTFILE="$1"
[[ "$OUTFILE" = /* ]] || OUTFILE="$PWD/$OUTFILE"
LICENSES_DIR="${2:-}"
[[ -z "$LICENSES_DIR" || "$LICENSES_DIR" = /* ]] || LICENSES_DIR="$PWD/$LICENSES_DIR"

for tool in curl tar make gcc sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool nicht gefunden."
done
# Der Parser von tmux wird beim Bauen erzeugt.
command -v yacc >/dev/null 2>&1 || command -v bison >/dev/null 2>&1 || command -v byacc >/dev/null 2>&1 \
  || die "yacc/bison nicht gefunden (Ubuntu: apt install bison, Fedora: dnf install bison)."

CACHE="${AGENTDECK_BUNDLE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/agentdeck-bundle}"
mkdir -p "$CACHE"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agentdeck-tmux.XXXXXX")"
if [[ "${AGENTDECK_TMUX_KEEP_BUILD:-}" == "1" ]]; then
  info "Build-Ordner bleibt erhalten: $WORK"
else
  trap 'rm -rf "$WORK"' EXIT
fi
PREFIX="$WORK/prefix"
LOG="$WORK/build.log"
JOBS="$(nproc 2>/dev/null || echo 2)"

# quiet <befehl …>: Ausgabe ins Log, nur bei einem Fehler die letzten Zeilen zeigen.
quiet() {
  if ! "$@" >>"$LOG" 2>&1; then
    tail -n 40 "$LOG" >&2
    die "'$*' ist fehlgeschlagen (Log: $LOG${AGENTDECK_TMUX_KEEP_BUILD:+, Ordner bleibt erhalten})."
  fi
}

# fetch <url> <sha256>: laedt (oder nimmt aus dem Cache) und prueft; gibt den Pfad aus.
fetch() {
  local url="$1" sha="$2" file
  file="$CACHE/$(basename "$url")"
  if [[ -f "$file" ]] && printf '%s  %s\n' "$sha" "$file" | sha256sum -c --status - 2>/dev/null; then
    printf '%s' "$file"
    return
  fi
  info "Lade $(basename "$url") …"
  curl -fsSL --retry 3 -o "$file.part" "$url" || die "Download fehlgeschlagen: $url"
  if ! printf '%s  %s\n' "$sha" "$file.part" | sha256sum -c --status -; then
    rm -f "$file.part"
    die "SHA256 von $(basename "$url") stimmt nicht mit der gepinnten Pruefsumme ueberein."
  fi
  mv "$file.part" "$file"
  printf '%s' "$file"
}

# unpack <tarball> <name>: entpackt nach $WORK/src/<name> und gibt den Pfad aus.
unpack() {
  mkdir -p "$WORK/src"
  tar -xzf "$1" -C "$WORK/src"
  printf '%s' "$WORK/src/$2"
}

LIBEVENT_TAR="$(fetch "$LIBEVENT_URL" "$LIBEVENT_SHA256")"
NCURSES_TAR="$(fetch "$NCURSES_URL" "$NCURSES_SHA256")"
TMUX_TAR="$(fetch "$TMUX_URL" "$TMUX_SHA256")"

# ---------------------------------------------------------------- libevent
info "Baue libevent $LIBEVENT_VERSION …"
LIBEVENT_SRC="$(unpack "$LIBEVENT_TAR" "libevent-$LIBEVENT_VERSION")"
SRC="$LIBEVENT_SRC"
(
  cd "$SRC"
  quiet ./configure --prefix="$PREFIX" --disable-shared --enable-static --with-pic \
    --disable-openssl --disable-samples --disable-libevent-regress --disable-debug-mode
  quiet make -j"$JOBS"
  quiet make install
)

# ---------------------------------------------------------------- ncurses
info "Baue ncurses $NCURSES_VERSION …"
NCURSES_SRC="$(unpack "$NCURSES_TAR" "ncurses-$NCURSES_VERSION")"
SRC="$NCURSES_SRC"
(
  cd "$SRC"
  quiet ./configure --prefix="$PREFIX" --without-shared --with-normal --without-debug \
    --without-ada --without-cxx --without-cxx-binding --without-manpages --without-tests \
    --enable-widec --enable-pc-files --with-pkg-config-libdir="$PREFIX/lib/pkgconfig" \
    --with-terminfo-dirs="$TERMINFO_DIRS" --with-default-terminfo-dir=/usr/share/terminfo \
    --with-fallbacks="$TERMINFO_FALLBACKS" --disable-stripping
  quiet make -j"$JOBS"
  # Nur Bibliotheken und Header; Terminfo-Datenbank und Programme braucht tmux nicht.
  quiet make install.libs
  quiet make install.includes
)
[[ -f "$PREFIX/lib/libncursesw.a" ]] || die "libncursesw.a wurde nicht gebaut."

# ---------------------------------------------------------------- tmux
info "Baue tmux $TMUX_VERSION …"
SRC="$(unpack "$TMUX_TAR" "tmux-$TMUX_VERSION")"
(
  cd "$SRC"
  # tmux sucht libevent und (zuerst) "tinfo" per pkg-config — und fande dabei die
  # dynamischen Bibliotheken des Systems. Mit vorgegebenen *_CFLAGS/*_LIBS fragt
  # configure nicht nach, sondern linkt genau unsere statischen .a-Dateien.
  # (libncursesw.a enthaelt auch die tinfo-Funktionen: ohne --with-termlib gebaut.)
  # --enable-sixel: tmux passes Sixel images of pane apps on to the app's xterm (image addon).
  quiet ./configure --prefix="$PREFIX" --enable-sixel \
    CFLAGS="-O2" \
    LIBEVENT_CORE_CFLAGS="-I$PREFIX/include" LIBEVENT_CORE_LIBS="$PREFIX/lib/libevent_core.a" \
    LIBEVENT_CFLAGS="-I$PREFIX/include" LIBEVENT_LIBS="$PREFIX/lib/libevent_core.a" \
    LIBTINFO_CFLAGS="-I$PREFIX/include/ncursesw -I$PREFIX/include" LIBTINFO_LIBS="$PREFIX/lib/libncursesw.a"
  quiet make -j"$JOBS"
)
BIN="$WORK/src/tmux-$TMUX_VERSION/tmux"
[[ -x "$BIN" ]] || die "tmux wurde nicht gebaut."

# Nur libc (und libm/libresolv, falls glibc sie noch getrennt fuehrt) duerfen dynamisch bleiben.
if command -v ldd >/dev/null 2>&1; then
  EXTRA="$(ldd "$BIN" 2>/dev/null | awk '{print $1}' | grep -Ev '^(linux-vdso|linux-gate|/lib.*/ld-|ld-linux|libc\.so|libm\.so|libresolv\.so|libutil\.so|libpthread\.so|libdl\.so|librt\.so)' || true)"
  [[ -z "$EXTRA" ]] || die "tmux haengt noch von weiteren Bibliotheken ab: $(echo $EXTRA)"
fi

strip "$BIN" 2>/dev/null || true
mkdir -p "$(dirname "$OUTFILE")"
install -m 0755 "$BIN" "$OUTFILE"
if [[ -n "$LICENSES_DIR" ]]; then
  mkdir -p "$LICENSES_DIR"
  install -m 0644 "$WORK/src/tmux-$TMUX_VERSION/COPYING" "$LICENSES_DIR/tmux-COPYING"
  install -m 0644 "$LIBEVENT_SRC/LICENSE" "$LICENSES_DIR/libevent-LICENSE"
  install -m 0644 "$NCURSES_SRC/COPYING" "$LICENSES_DIR/ncurses-COPYING"
fi
info "tmux $("$OUTFILE" -V | cut -d' ' -f2) -> $OUTFILE"
