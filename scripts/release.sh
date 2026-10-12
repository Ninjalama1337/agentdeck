#!/usr/bin/env bash
# AgentDeck: ein Release anlegen. Ein Release ist ein Git-Tag vX.Y.Z auf main;
# GitHub Actions testen, bauen die APK (android.yml) und die Desktop-Pakete (desktop.yml) und
# veroeffentlichen das GitHub-Release. Server holen es sich danach selbst
# (App: Settings → Server update, oder scripts/update.sh).
#
#   scripts/release.sh            naechste Patch-Version
#   scripts/release.sh minor      naechste Minor-Version (major genauso)
#   scripts/release.sh 1.2.3      genau diese Version
#   scripts/release.sh --wait     zusaetzlich warten, bis das Release und die Desktop-Pakete online sind
#                                 (Exit 3 = Release ist online, nur die Desktop-Pakete fehlen)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info() { printf '==> %s\n' "$*"; }
die()  { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }

BUMP="patch"
WAIT=0
for arg in "$@"; do
  case "$arg" in
    --wait) WAIT=1 ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) BUMP="$arg" ;;
  esac
done

for tool in git npm gh; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool nicht gefunden."
done

[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || die "Releases entstehen auf main."
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "Uncommittete Aenderungen — erst committen."
git fetch --quiet --tags origin
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] \
  || die "main und origin/main sind nicht gleich — erst pushen (oder pullen)."

LAST="$(git tag -l 'v[0-9]*' --sort=-v:refname | head -n 1)"
if [[ "$BUMP" =~ ^v?([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  NEXT="${BASH_REMATCH[1]}"
else
  [[ -n "$LAST" ]] || die "Noch kein Release vorhanden — erste Version ausschreiben, z. B. scripts/release.sh 1.0.0"
  IFS=. read -r MAJOR MINOR PATCH <<< "${LAST#v}"
  case "$BUMP" in
    patch) PATCH=$((PATCH + 1)) ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    *) die "Unbekanntes Argument: $BUMP (patch | minor | major | X.Y.Z | --wait)" ;;
  esac
  NEXT="$MAJOR.$MINOR.$PATCH"
fi
TAG="v$NEXT"

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "$TAG gibt es schon."
if [[ -n "$LAST" ]]; then
  [[ "$(printf '%s\n%s\n' "${LAST#v}" "$NEXT" | sort -V | tail -n 1)" == "$NEXT" ]] \
    || die "$TAG waere aelter als das letzte Release $LAST."
  [[ "$(git rev-parse "$LAST^{commit}")" != "$(git rev-parse HEAD)" ]] \
    || die "Seit $LAST gibt es keine neuen Commits."
fi

info "Pruefe (typecheck + tests) …"
npm run typecheck
npm test

info "Tagge $TAG (${LAST:-erstes Release} → $TAG) und pushe das Tag …"
git tag -a "$TAG" -m "AgentDeck $TAG"
git push --quiet origin "$TAG"
info "$TAG ist gepusht — GitHub Actions baut jetzt APK, Release und Desktop-Pakete."

# Die Desktop-Pakete (AppImage, deb) haengt .github/workflows/desktop.yml erst an das Release, wenn
# android.yml es angelegt hat. Fehlen sie, ist das KEIN Fehler des Releases (Server und APK sind fertig),
# aber auch nicht still: Exit-Code 3 — melden und trotzdem mit dem Server-Update weitermachen.
wait_desktop() {
  info "Warte auf die Desktop-Pakete (AppImage, deb) — bis zu 40 min …"
  local assets run
  for _ in $(seq 1 160); do
    assets="$(gh release view "$TAG" --json assets -q '.assets[].name' 2>/dev/null || true)"
    if grep -q '\.AppImage$' <<< "$assets" && grep -q '\.deb$' <<< "$assets"; then
      info "Desktop-Pakete sind am Release."
      return 0
    fi
    run="$(gh run list --workflow desktop.yml --branch "$TAG" --limit 1 --json conclusion -q '.[0].conclusion' 2>/dev/null || true)"
    if [[ -n "$run" && "$run" != "success" ]]; then
      printf 'WARNUNG: Der Desktop-Workflow fuer %s endete mit "%s" — das Release hat keine Desktop-Pakete: gh run list --workflow desktop.yml\n' "$TAG" "$run" >&2
      return 3
    fi
    sleep 15
  done
  printf 'WARNUNG: Die Desktop-Pakete fehlen nach 40 min noch am Release %s: gh run list --workflow desktop.yml\n' "$TAG" >&2
  return 3
}

if (( WAIT )); then
  info "Warte auf das Release (bis zu 25 min) …"
  for _ in $(seq 1 100); do
    if gh release view "$TAG" --json tagName >/dev/null 2>&1; then
      info "Release $TAG ist online: $(gh release view "$TAG" --json url -q .url)"
      wait_desktop || exit $?
      exit 0
    fi
    CONCLUSION="$(gh run list --workflow android.yml --branch "$TAG" --limit 1 --json conclusion -q '.[0].conclusion' 2>/dev/null || true)"
    if [[ "$CONCLUSION" == "failure" || "$CONCLUSION" == "cancelled" ]]; then
      die "Der Release-Workflow fuer $TAG ist fehlgeschlagen: gh run list --workflow android.yml"
    fi
    sleep 15
  done
  die "Release $TAG ist nach 25 min noch nicht online — gh run list --workflow android.yml"
fi
printf 'Fortschritt:  gh run list --workflow android.yml   (Desktop: --workflow desktop.yml)\n'
