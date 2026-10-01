# AgentDeck — Hinweise für Coding-Agents

Aufbau, Skripte und Doku: siehe [README.md](README.md) und `docs/`.

## Nach jedem Feature

Ein Feature ist erst fertig, wenn alle Schritte durch sind — nicht schon nach
dem Code. Schritt für Schritt, bei einem Fehler anhalten und melden:

1. **Prüfen:** `npm run typecheck && npm test`
2. **Committen und pushen:** auf `main` committen, `git push origin main`.
   Gemergte Branches löschen, lokal und auf `origin`.
3. **Bauen:** `npm run build`
4. **APK bauen und hinterlegen:**
   - Version = nächste Patch-Version über der gehosteten
     (`curl -s $AGENTDECK_URL/api/apk/info`).
   - `VITE_AGENTDECK_APK_VERSION=<version> scripts/build-android.sh`
   - `scripts/upload-apk.sh mobile/android/app/build/outputs/apk/debug/app-debug.apk <version>`
     (`AGENTDECK_URL` und `AGENTDECK_DATA_DIR` müssen auf den laufenden Server
     zeigen). Gepaarte Geräte sehen danach das Update-Banner.
5. **Laufenden Server aktualisieren:** im Checkout, aus dem der Server läuft
   (`readlink /proc/<server-pid>/cwd`), `main` pullen, bei geändertem
   `package-lock.json` `npm install`, dann `npm run build` und
   `scripts/restart.sh` (Terminals laufen in tmux und überleben den Neustart).
   Liegen dort uncommittete Änderungen, erst nachfragen statt sie zu
   überschreiben.

Details zu APK-Bau und -Verteilung: [docs/ANDROID.md](docs/ANDROID.md).
