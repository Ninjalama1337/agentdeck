# Releases & Updates

Ein Release ist ein Git-Tag `vX.Y.Z` auf `main`. GitHub Actions testet den
Stand, baut die Android-APK und veröffentlicht beides als GitHub-Release; der
Desktop-Workflow hängt danach AppImage und deb an dasselbe Release. Jeder
AgentDeck-Server holt sich das Release selbst — so laufen mehrere Server auf
derselben Version, und die App bekommt die passende APK.

```
scripts/release.sh ──► Tag vX.Y.Z ──► GitHub Actions: Tests + APK ──► GitHub-Release
                                                                         │
        App: Settings → Server update   oder   scripts/update.sh  ◄──────┘
        (Checkout auf das Tag, bauen, APK hinterlegen, Neustart)
```

## Release anlegen

```bash
scripts/release.sh            # nächste Patch-Version
scripts/release.sh minor      # oder: major, oder eine Version wie 1.2.3
scripts/release.sh --wait     # wartet, bis das Release und die Desktop-Pakete online sind
```

Das Skript verlangt einen sauberen, gepushten `main`, lässt Typecheck und Tests
laufen, taggt und pusht das Tag. Den Rest macht
[`.github/workflows/android.yml`](../.github/workflows/android.yml): Schlagen
dort Typecheck oder Tests fehl, entsteht kein Release.

## Desktop-Pakete

[`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml) baut auf
`ubuntu-22.04` das Server-Bundle (`scripts/build-server-bundle.sh`: Node 22,
`node-pty`, statisches tmux, gebauter Server und Web-App) und daraus
`AgentDeck-<version>-linux-x64.AppImage`, das `.deb` und `latest-linux.yml`
für das Auto-Update des AppImage. Der Workflow legt **kein** Release an: Er
wartet (bis zu 60 min), bis `android.yml` es nach grünen Tests erzeugt hat, und
lädt die Pakete dann hoch. Fehlen sie, meldet `scripts/release.sh --wait` eine
Warnung — Server und APK des Releases sind davon nicht betroffen.

Ein Server aus dem Desktop-Paket aktualisiert sich nicht über
`scripts/update.sh` (kein Git-Checkout), sondern mit der App; Details in
[DESKTOP.md](DESKTOP.md#updates).

## Server aktualisieren

**In der App:** Settings → *Server update* zeigt die installierte Version und
das neueste Release. *Update server to vX.Y.Z* startet das Update mit
Live-Ausgabe; am Ende startet der Server neu und die App verbindet sich wieder.
Mit mehreren gespeicherten Servern: Server wechseln, dort ebenfalls updaten.

**Von Hand** (im Checkout, aus dem der Server läuft):

```bash
scripts/update.sh             # neuestes Release
scripts/update.sh v1.2.3      # ein bestimmtes
```

Was dabei passiert:

1. Der Checkout muss sauber sein (keine uncommitteten Änderungen), sonst bricht
   das Update ab.
2. Fast-Forward auf das Tag; bei geändertem `package-lock.json` `npm ci`, dann
   `npm run build`.
3. Baut das Release nicht, geht der Checkout auf den alten Stand zurück — der
   laufende Server bleibt, wie er ist.
4. Die APK des Releases wird beim Server hinterlegt (`/api/apk/latest`);
   gepaarte Handys sehen danach das Update-Banner.
5. Neustart über `scripts/restart.sh` (systemd-Unit oder direkter Prozess).
   Terminals laufen in tmux weiter.

Das Protokoll liegt in `<dataDir>/update.log`.

Voraussetzungen auf dem Server: ein Git-Checkout (kein entpacktes Archiv) und
die GitHub-CLI `gh`, angemeldet mit Zugriff auf das Repo (`gh auth login`) —
darüber findet der Server das neueste Release und lädt die APK.

## Versionen

Die Version steht nirgends in einer Datei: Der Server liest sie beim Start aus
dem Checkout (`git describe`). Auf einem Release-Tag ist das `1.2.3`, ein paar
Commits dahinter `1.2.3-4-gabc1234`. Ein Checkout ganz ohne Release-Tag meldet
`0.1.0`. Die APK bekommt die Version des Tags, aus dem sie gebaut wurde.

## Signatur

Android installiert ein Update nur, wenn es mit demselben Schlüssel signiert
ist wie die installierte App. Ohne festen Schlüssel erzeugt jeder CI-Lauf einen
neuen Debug-Schlüssel — die APK ließe sich dann nur nach Deinstallation
installieren. Deshalb liest der Workflow den Keystore aus dem Repo-Secret
`ANDROID_DEBUG_KEYSTORE_B64`:

```bash
base64 -w0 ~/.android/debug.keystore | gh secret set ANDROID_DEBUG_KEYSTORE_B64
```

Nimm den Keystore des Rechners, auf dem die bisher installierte APK gebaut
wurde; dann bleiben auch bestehende Installationen updatefähig. Fehlt das
Secret, baut der Workflow trotzdem — nur eben mit wechselnder Signatur.
