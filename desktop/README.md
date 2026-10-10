# AgentDeck Desktop

Die Desktop-App für Linux (Ubuntu 24.04, Bazzite). Sie ist ein **Fenster auf den
AgentDeck-Server** (`http://127.0.0.1:<port>`) und hat keinen eigenen Zustand:
Handy und Desktop sehen dasselbe. Der Server läuft entweder als Hintergrunddienst
(`systemd --user`) oder – ohne systemd – losgelöst von der App.

Eigenes npm-Projekt (nicht in den Root-Workspaces, damit der Server-Build kein
Electron nachzieht). Typen und ein paar Konstanten kommen aus
[`packages/shared/src/desktop.ts`](../packages/shared/src/desktop.ts) (Vertrag mit
dem Server-CLI und der Web-UI).

## Aufbau

```
src/core/       Logik ohne Electron-Import, alle Abhängigkeiten injiziert (vitest)
  cli.ts          ruft agentdeck-server info/service … --json auf, parst die Antworten
  controller.ts   Start-Ablauf, Modus (service/detached/external/stopped), Dienst-Aktionen
  serverStatus.ts Modus-Ableitung aus Health-Probe + Dienststatus
  detached.ts     Server ohne systemd losgelöst starten/stoppen (server.pid, Marker)
  runtimeStage.ts Bundle aus dem AppImage-Mount in ein stabiles Verzeichnis kopieren
  closeDecision.ts, closeFlow.ts   Schließen-Dialog und was danach passiert
  pairing.ts, storagePairing.ts    Auto-Pairing (Format wie web/src/api/servers.ts)
  windowState.ts, settings.ts, autostart.ts, urlPolicy.ts, env.ts, …
src/main.ts     Electron-Einstieg: verdrahtet core mit Fenster, Menü, Dialogen
src/preload.ts  window.agentdeckDesktop (DesktopBridge) + Pairing vor dem ersten Seitenskript
src/ipc.ts, window.ts, menu.ts, dialogs.ts, updates.ts   dünne Electron-Schicht
build/          AppImage-Launcher (Sandbox-Prüfung), afterPack-Hook
electron-builder.cjs   AppImage + deb (x64); Server-Bundle als extraResource nach resources/server
scripts/        build.mjs (esbuild), Smoke-Tests (Xvfb), clean-release.mjs
test/           vitest; test/fixtures/fake-agentdeck-server.mjs ersetzt den echten Server
```

## Verhalten in Kürze

- **Start:** Single-Instance; `agentdeck-server info --json` liefert Port und Datenordner.
  Antwortet `GET /api/health` → verbinden (Dienst oder fremd gestarteter Server).
  Sonst: mit systemd einmalig fragen „Als Hintergrunddienst einrichten?“
  (`service install`), ohne systemd oder bei „Nein“ den Server losgelöst starten
  (Log: `~/.local/state/agentdeck/server.log`). Der **Port ist fest** – belegt ihn
  etwas anderes, gibt es eine Fehlermeldung statt eines anderen Ports (die
  Anmeldung im Fenster hängt am Origin). Antwortet dort ein anderes Programm, bekommt es
  weder die Bridge noch den Pairing-Code noch das Login der App: beides gibt es nur
  nach einer frischen Prüfung, dass `GET /api/health` von AgentDeck kommt.
- **Dienst aktuell halten:** Bringt die App einen neueren Server mit als der
  installierte Dienst, wird er beim Start per `service install` aktualisiert.
- **Pairing:** Fehlt dem Fenster das Login (oder kommt `agentdeck:unauthorized`),
  koppelt die App das Gerät mit dem Code aus `pairing-code.txt` als
  „<Rechnername> (Desktop)“ – vor dem ersten Skript der Seite.
- **Schließen:** Dialog „Im Hintergrund weiterlaufen“ / „Dienst stoppen und beenden“ /
  „Abbrechen“ (+ „Nicht mehr fragen“) mit der Zahl laufender Agent-Läufe und
  Terminals. „Stoppen“ gibt es nur für Dienst und selbst gestarteten Server; einen
  fremden Server beendet die App nie. Terminals laufen in tmux weiter. Vor dem
  Beenden wird der Browser-Speicher (`localStorage`) geschrieben.
- **Fenster:** Größe, Position, maximiert und Bildschirm werden gemerkt
  (`window-state.json`); Mindestbreite 1024 px (darunter schaltet die Web-UI auf
  das Handy-Layout). Route, Tab und Chat stellt die Web-UI selbst wieder her.
- **Autostart:** „Beim Anmelden starten“ legt `~/.config/autostart/agentdeck.desktop`
  an (`--hidden`: Server sicherstellen, kein Fenster, App beendet sich wieder). Schaltet
  der Desktop den Eintrag aus (GNOME Tweaks, KDE), bleibt er aus; beim Start wird nur sein
  `Exec=` angepasst (verschobenes AppImage), nie das Ein/Aus.
- **Handy-Zugriff:** Standard ist nur dieser Rechner (`127.0.0.1`). Die Statusanzeige
  (`host`) zeigt die tatsächliche Bindung, nicht die Config; der Schließen-Dialog sagt nur
  dann „das Handy bleibt verbunden“, wenn „Handy-Zugriff im LAN“ an ist.
- **Sicherheit:** `contextIsolation` und `sandbox` an, kein `nodeIntegration`;
  Navigation nur im Server-Origin, Web-Links öffnen im System-Browser; IPC nur von
  Seiten dieses Origins.
- Daten der App: `~/.config/agentdeck-desktop/` (feste Browser-Partition,
  `settings.json`, `window-state.json`, …); Log: `~/.local/state/agentdeck/desktop.log`.

Umgebungsvariablen: `AGENTDECK_SERVER_BIN` (anderes `agentdeck-server`),
`AGENTDECK_DESKTOP_USER_DATA`, `AGENTDECK_DEVTOOLS=1`, `AGENTDECK_NO_UPDATE_CHECK=1`,
`AGENTDECK_NO_SANDBOX=1` (siehe unten).

## Entwickeln

```bash
cd desktop
npm install                  # eigenes Lockfile; lädt das Electron-Binary
../scripts/build-server-bundle.sh   # einmalig: dist-bundle/agentdeck-server (oder AGENTDECK_SERVER_BIN setzen)
npm run build && npx electron . --no-sandbox   # oder: npm start (nur Entwicklung, ohne Sandbox)
```

Ohne Download des Electron-Binarys (Typecheck und Tests brauchen es nicht):
`ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`.

## Testen

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest: Core-Module, Launcher-Skript (kein Electron, kein systemd)
npm run smoke         # echte App unter Xvfb gegen einen Fake-Server (Bridge, Pairing, Schließen, Fensterzustand …)
npm run smoke:real    # dasselbe gegen das echte Bundle aus dist-bundle/ (inkl. echter Web-App)
node scripts/smoke-packaged.mjs release/linux-unpacked/agentdeck   # gebautes Paket starten
```

Die Smoke-Tests brauchen das Electron-Binary und `xvfb-run`; sie verwenden ein
Wegwerf-`HOME` und fassen weder systemd noch das echte Profil an. Als root läuft
Chromium nicht ohne `--no-sandbox` – `SMOKE_RUN_AS=<uid>` startet die App
stattdessen als normaler Benutzer mit der echten Sandbox.

## Bauen

```bash
../scripts/build-server-bundle.sh   # Voraussetzung: das Server-Bundle
npm run dist:deb                    # release/AgentDeck-<v>-linux-amd64.deb
npm run dist:appimage               # release/AgentDeck-<v>-linux-x86_64.AppImage + latest-linux.yml
```

`dist:appimage` zuletzt: es tauscht die Electron-Binary gegen den Launcher
(`build/after-pack-appimage.cjs`) und schreibt `latest-linux.yml`. Die Version
steht in `desktop/package.json` (CI setzt sie aus dem Tag). Das Bundle liegt
standardmäßig unter `../dist-bundle/agentdeck-server` (`AGENTDECK_SERVER_BUNDLE`
überschreibt das). Ohne Zugriff auf GitHub-Releases: `-c.electronDist=node_modules/electron/dist`.

CI: [`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml) – Tests, Bundle,
Pakete, Smoke-Tests; auf Tags wartet der Job auf das Release von `android.yml` und
hängt AppImage, deb und `latest-linux.yml` an (`--clobber`). Ein Release legt er nicht an.

## Bekannte Eigenheiten

- **Der Pairing-Code rotiert bei jedem Desktop-Pairing.** Ein dem Handy gerade gezeigter Code
  wird dadurch ungültig (der Server rotiert den Code nach jeder Nutzung); auf dem Handy den
  aktuellen Code neu holen.
- **Ein App-Update startet den Dienst ohne Rückfrage neu**, sobald die neue App zum ersten Mal
  läuft und ihr Server neuer ist als der des Dienstes. Terminals bleiben in tmux erhalten,
  laufende Agent-Läufe werden unterbrochen. Eine ältere App ersetzt nie einen neueren Dienst.
- **Fremde Server werden nur verbunden, nie gestoppt:** ein Checkout-Server oder ein manuell
  gestarteter Server. Eine laufende `agentdeck.service` ohne AgentDeck-Marker (z. B. aus `docs/`)
  zählt als Dienst: die App kann sie stoppen und neu starten, aber nicht neu installieren,
  deinstallieren oder in ihrer Netzwerk-Einstellung ändern.
- **Status:** Die Health-Prüfung läuft alle 5 s, solange das Fenster sichtbar ist; der
  Dienststatus (`systemctl` über das CLI) höchstens alle 30 s oder bei einer Änderung.

## Ubuntu 24.04: Chromium-Sandbox

Ubuntu 24.04 sperrt Benutzer-Namensräume für Programme ohne AppArmor-Profil.

- **deb:** richtet beim Installieren das Profil `/etc/apparmor.d/agentdeck` ein
  (`userns,`) – die Vorlage von electron-builder; ohne Namensräume fällt es auf
  das SUID-`chrome-sandbox` zurück.
- **AppImage:** kann kein Profil mitbringen. Der Launcher (`build/linux/agentdeck-launcher.sh`)
  prüft, ob eine Sandbox möglich ist, und bricht sonst mit einer Anleitung ab
  (Profil für das AppImage, oder das deb). Er verwirft jedes `--no-sandbox`, das
  electron-builders `AppRun` von sich aus anhängt. Die Sandbox geht nur über
  `AGENTDECK_NO_SANDBOX=1` aus.

## Updates

Die App prüft nach dem Start (nur gepackt) das neueste GitHub-Release und weist
mit einem Hinweis samt Link auf die Release-Seite hin; sie ersetzt sich nicht selbst.
Der Dienst wird von der neuen App beim ersten Start aktualisiert. `latest-linux.yml`
liegt am Release, damit ein späterer Wechsel auf `electron-updater` (AppImage) nur
Code in `src/updates.ts` braucht.
