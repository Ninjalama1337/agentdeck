# Android — PWA und APK

AgentDeck erreichst du auf dem Handy auf zwei Wegen: als **PWA** (Zero
Installation, läuft im Browser) oder als **APK** (echte App, via Capacitor).
Beide reden mit demselben Server — du kannst jederzeit mischen.

| | PWA | APK |
|---|---|---|
| Installation | „Zum Startbildschirm“, ein Tap | Datei laden + installieren |
| Updates | sofort (Server liefert UI aus) | neuer APK-Bau nötig (CI macht das) |
| Offline-Fähigkeit | PWA-Caching der Shell | WebView-Cache |
| Eigener App-Eintrag | ja | ja, mit eigenem Icon |
| Verteilung an andere | Link teilen | APK-Datei weitergeben |

## Weg 1: PWA installieren

1. Server starten (`npm start`, siehe [README Quickstart](../README.md#quickstart)).
2. Am Handy im **Chrome** (Android) `http://<lan-ip>:8787` öffnen und pairen.
3. Menü (⋮) → **Zum Startbildschirm** / **App installieren**.
4. iOS/Safari: Teilen-Menü → **Zum Home-Bildschirm** (PWA-Funktionen leicht
   eingeschränkt, aber nutzbar).

Die PWA wird vom Server ausgeliefert — ein `npm run build -w web` plus
Neuladen genügt, um alle zu aktualisieren.

## Weg 2: APK lokal bauen

### Voraussetzungen

- Node ≥ 20, npm
- **JDK 21** (z. B. [Temurin](https://adoptium.net/)) — Capacitor 7 braucht
  Java 21; `java -version` muss `21.x` zeigen
- **Android SDK**: entweder Android Studio (einfachste Variante) oder nur die
  [cmdline-tools](https://developer.android.com/studio#command-line-tools-only).
 SDK-Pfad merken, z. B. `~/Android/Sdk`.
- `ANDROID_SDK_ROOT` auf den SDK-Pfad setzen, falls nicht automatisch gefunden
  (z. B. in `~/.bashrc`):
  ```bash
  export ANDROID_SDK_ROOT="$HOME/Android/Sdk"
  ```

### Schritte

Alle Befehle aus dem Repository-Root (Details auch in
[mobile/README.md](../mobile/README.md)):

```bash
npm install                      # Workspaces (einmalig)
npm run sync -w mobile           # web bauen + nach mobile/dist kopieren + cap sync
npx cap add android -w mobile    # nur beim ERSTEN Mal (generiert mobile/android/)
npm run dist:android -w mobile   # cap sync + ./gradlew assembleDebug
```

Oder alles in einem: `scripts/build-android.sh` (prüft SDK und `android/`
vorher).

Ergebnis: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`
per `adb install` oder Download aufs Handy. Die Debug-APK ist für den
Eigengebrauch gedacht und installierbar; die signierte Release-APK ist
aktuell nicht automatisiert (siehe unten).

### Häufige Probleme

| Symptom | Ursache | Lösung |
|---|---|---|
| `SDK location not found` | Gradle findet kein SDK | `ANDROID_SDK_ROOT` setzen oder `mobile/android/local.properties` mit `sdk.dir=/pfad/zum/Sdk` anlegen |
| `Unsupported class file major version` / Gradle meckert über Java | falsche JDK-Version | JDK 21 installieren und `JAVA_HOME` darauf zeigen lassen (`./gradlew -version` prüft) |
| App lädt, aber „keine Serververbindung“ | Cleartext/HTTP | In der App die richtige `http://<lan-ip>:8787`-Adresse eintragen; cleartext ist erlaubt (siehe `mobile/capacitor.config.ts`) — bei HTTPS-Umgebung Flags in der Config entfernen |
| `cap` sagt `webDir dist existiert nicht` | Web-App noch nicht gebaut | `npm run sync -w mobile` (baut web und kopiert nach `mobile/dist`) |
| `npx cap add android`: Ordner existiert bereits | `mobile/android/` schon generiert | nichts tun — der Ordner bleibt lokal liegen und wird wiederverwendet |
| Emulator erreicht `localhost` nicht | Emulator-Netzwerk | Emulator nutzt `10.0.2.2` für den Host-Rechner |

## Weg 3: APK via GitHub Actions bauen (ohne lokales SDK)

Der Workflow [`.github/workflows/android.yml`](../.github/workflows/android.yml)
baut die APK auf GitHub-Infrastruktur:

1. Repo auf GitHub öffnen → **Actions** → **Android APK**.
2. **Run workflow** (*workflow_dispatch*) klicken — geht auch am Handy im
   Browser. Alternativ läuft der Workflow automatisch bei einem PR, der
   `mobile/**` ändert, und bei Push eines `v*`-Tags.
3. Nach dem Lauf das Artifact **`AgentDeck-debug-APK`** herunterladen
   (`app-debug.apk`) und installieren.
4. Die **GitHub-Android-App** kann Artifacts ebenfalls anzeigen und
   herunterladen — Bauen und Installieren komplett vom Telefon aus.

Bei einem `v*`-Tag läuft zusätzlich der Job `apk-release`, der eine
**unsignierte** Release-APK (`AgentDeck-release-APK-unsigned`) erzeugt. Ohne
Keystore im Repo (bewusst — Secrets gehören nicht ins Repo) musst du sie vor
der Verteilung selbst signieren (`apksigner`); für den Eigengebrauch nimm die
Debug-APK. Bei Tags erstellt der Workflow außerdem eine **GitHub Release** mit
beiden APKs und generierten Release-Notes.

## Updates & APK-Verteilung

### Update-Banner in der App

Jeder CI- und Local-Build brennt seine Version in die App ein
(`VITE_AGENTDECK_APK_VERSION`; Browser-/PWA-Builds bekommen `0.0.0-web` und
sehen das Banner nie — die PWA aktualisiert sich ohnehin selbst über den
Service Worker). Beim Start fragt die APK `GET /api/apk/info` ab: Ist die auf
dem Server liegende APK **neuer** als die installierte, erscheint oben das
Banner **„Update available — v<version>“** mit einem **Download**-Button
(`GET /api/apk/latest`) und einem × zum Ausblenden (pro Server-Version, im
`sessionStorage` — die nächste Version blendet es wieder ein).

Der Download ist ein schlichter Link, den Androids Download-Manager übernimmt.
Beim ersten Mal fragt Android, ob der Browser aus **unbekannten Quellen**
installieren darf — einmal erlauben, APK öffnen, **„App aktualisieren?“**
bestätigen: Daten und Pairing bleiben erhalten.

### APK auf den Server bringen

Die aktuell gebaute APK liegt unter `<dataDir>/apk/` und wird vom Server
unter `/api/apk/latest` verteilt (Download-Buttons auf der Pairing-Seite und
unter Settings → *Android app*). Drei Wege, sie dorthin zu bringen:

1. **CI automatisch:** Repo-Secrets `AGENTDECK_URL` (Server-Basis-URL) und
   `AGENTDECK_BRIDGE_TOKEN` (Inhalt von
   `~/.local/share/agentdeck/bridge-token`) setzen — dann pushed der
   Workflow nach jedem Build die APK an den Server (Header
   `x-bridge-token`).
2. **Lokal per Skript:** `scripts/upload-apk.sh <apk> [version]` (liest den
   Token default aus `dataDir`, `--help` zeigt alle Optionen).
3. **In der App:** Settings → *Android app* → *Publish a new build* — Datei
   wählen, Version wird aus dem Dateinamen (`agentdeck-<version>.apk`)
   übernommen, Upload läuft über das Geräte-JWT.

Grenzen und Details (Channels, `maxApkBytes`, Auto-Update-Konzept,
„remote UI“-Variante): [docs/REMOTE.md](REMOTE.md).

## F-Droid

Eine F-Droid-Aufnahme ist **nicht vorbereitet**: Sie verlangt reproduzierbare
Builds, freie Build-Infrastruktur und ein eigenes Signierungs-Setup. Die
Capacitor-App selbst enthält keine proprietären Abhängigkeiten — eine
Aufnahme ist aber erst sinnvoll, wenn Signing und Release-Prozess stehen.

## Berechtigungen

`mobile/scripts/patch-android.mjs` trägt beim Bau ein, was die APK über
`INTERNET` hinaus braucht:

| Berechtigung | Wofür |
|---|---|
| `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS` | Diktat |
| `POST_NOTIFICATIONS` | „Agent fertig / wartet“-Meldungen |
| `VIBRATE` | Haptik |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `WAKE_LOCK` | Hintergrundverbindung (siehe unten) |

Kein Standort, kein Speicherzugriff, keine Kamera — Uploads (z. B.
Screenshots) laufen über den normalen WebView-Datei-Dialog des Systems. Der
gesamte AgentDeck-Traffic geht als REST/WebSocket an deinen Server; die
WebView lädt ausschließlich lokal gebaute Assets aus dem APK.

### Hintergrundverbindung

Die WebView kennt kein Web Push; Meldungen kommen über den WebSocket. Damit
Android die App im Hintergrund nicht einfriert, startet sie einen
Vordergrund-Dienst (dauerhafte Benachrichtigung „AgentDeck — Connected“),
solange ein Terminal offen ist oder eine Session läuft. Abschaltbar unter
Settings → *Notifications* → *Stay connected in background*. Der Dienst hält
einen Wake-Lock und kostet Akku; im tiefen Doze-Modus kann Android die
Verbindung trotzdem pausieren — Meldungen kommen dann verspätet.
