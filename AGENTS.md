# AgentDeck — Hinweise für Coding-Agents

Aufbau, Skripte und Doku: siehe [README.md](README.md) und `docs/`.

## Nach jedem Feature

Ein Feature ist erst fertig, wenn alle Schritte durch sind — nicht schon nach
dem Code. Schritt für Schritt, bei einem Fehler anhalten und melden:

1. **Prüfen:** `npm run typecheck && npm test`. Wurde `desktop/` angefasst
   (eigenes npm-Projekt, nicht in den Root-Workspaces): zusätzlich
   `cd desktop && npm ci && npm run typecheck && npm test`.
2. **Committen und pushen:** auf `main` committen, `git push origin main`.
   Gemergte Branches löschen, lokal und auf `origin`.
3. **Release anlegen:** `scripts/release.sh --wait` (nächste Patch-Version;
   `minor`, `major` oder `X.Y.Z` als Argument). GitHub Actions testet, baut
   die APK und veröffentlicht das Release; das Skript wartet, bis es online
   ist. Die Desktop-Pakete (AppImage, deb) hängt `desktop.yml` danach an —
   `--wait` wartet auch darauf. Exit-Code 3 heißt: Release ist online, nur die
   Desktop-Pakete fehlen — dem Nutzer melden, aber mit Schritt 4 weitermachen
   (Server und APK sind fertig).
4. **Laufenden Server aktualisieren:** im Checkout, aus dem der Server läuft
   (`readlink /proc/<server-pid>/cwd`), `scripts/update.sh`. Es holt das
   Release, baut, hinterlegt die APK und startet den Server neu (Terminals
   laufen in tmux und überleben den Neustart). Liegen dort uncommittete
   Änderungen, bricht es ab — dann nachfragen statt sie zu überschreiben.

Ändert sich nur Doku, genügen Schritt 1 und 2.

Weitere Server (zweiter Rechner) aktualisiert der Nutzer selbst in der App:
Settings → Server update.

Details: [docs/RELEASES.md](docs/RELEASES.md), APK-Bau
[docs/ANDROID.md](docs/ANDROID.md), Desktop-App und Dienst
[docs/DESKTOP.md](docs/DESKTOP.md).
