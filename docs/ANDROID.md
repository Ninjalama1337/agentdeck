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

Releases (`vX.Y.Z`) baut GitHub Actions samt APK; Server holen sich Release und
APK selbst — der ganze Ablauf steht in [RELEASES.md](RELEASES.md). Wichtig für
Updates der installierten App: alle Builds müssen **dieselbe Signatur** tragen,
siehe dort „Signatur".

### Update-Banner in der App

Jeder CI- und Local-Build brennt seine Version in die App ein
(`VITE_AGENTDECK_APK_VERSION`; Browser-/PWA-Builds bekommen `0.0.0-web` und
sehen das Banner nie — die PWA aktualisiert sich ohnehin selbst über den
Service Worker). Beim Start liest die APK das neueste **GitHub-Release**
(`GET https://api.github.com/repos/<repo>/releases/latest`): Ist die Release-APK
**neuer** als die installierte, erscheint oben das Banner **„Update available —
v<version>“** mit einem **Install**-Button (lädt das `app-debug.apk`-Asset
direkt von GitHub) und einem × zum Ausblenden (pro Release-Version, im
`sessionStorage` — die nächste Version blendet es wieder ein). Das Repo ist beim
Bauen als `__RELEASE_REPO__` eingebrannt (Default `Ninjalama1337/agentdeck`;
für Forks `VITE_AGENTDECK_RELEASE_REPO` setzen).

In der App lädt der Button die APK selbst herunter (Fortschritt im Button)
und öffnet danach Androids Installer (natives `ApkInstall`-Plugin, Recht
`REQUEST_INSTALL_PACKAGES`) — ohne Umweg über den Browser, der sonst für jeden
Download einen Tab offen ließe. Beim ersten Mal die Installation aus dieser
Quelle erlauben, dann **„App aktualisieren?“** bestätigen: Daten und Pairing
bleiben erhalten. APKs vor v0.11.6 kennen das Plugin noch nicht und legen die
Datei stattdessen in den Downloads-Ordner (dort antippen). Im Browser/PWA ist
der Button ein schlichter Download-Link.

Dasselbe Plugin installiert auch APKs aus einem Projekt: Im **Files**-Tab hat
jede `.apk` im Menü **Install** — die App lädt sie (Fortschritt über der
Liste) und öffnet direkt den Installer, ohne Umweg über Downloads und einen
Dateimanager.

### Update-Benachrichtigung (auch bei geschlossener App)

Die APK prüft zusätzlich im Hintergrund (`UpdateCheckWorker`, WorkManager,
alle 6 Stunden bei Netz, erster Lauf direkt nach dem Start), ob das neueste
GitHub-Release eine neuere APK hat. Dann kommt **einmal pro Version** die
Benachrichtigung **„AgentDeck vX.Y.Z is available“**. Antippen (oder
**Install**) öffnet die App und startet sofort Download und Installer — du
bestätigst nur noch „App aktualisieren?“. Ist die App gerade im Vordergrund,
bleibt es beim Banner. Abschalten: Android-Einstellungen → Apps → AgentDeck →
Benachrichtigungen → **App updates**. Der Worker liest das Repo, das die App
beim Start übergibt (`__RELEASE_REPO__`). Erst ab der APK mit dieser Funktion
— die Version davor bekommt das Update noch über Banner bzw. Settings.

### Verteilung

Die APK hängt als `app-debug.apk` am GitHub-Release und wird von dort verteilt
— **kein Server hostet sie mehr**. Install-Buttons (Pairing-Seite und
Settings → *Android app*) sowie das Update-Banner verlinken direkt auf das
Release-Asset. Der Server lädt oder speichert die APK nicht.

Voraussetzung: Das Repo (bzw. das Release) muss **öffentlich** abrufbar sein,
sonst findet die App kein Release und zeigt weder Karte noch Banner.

Konzept und „remote UI“-Variante: [docs/REMOTE.md](REMOTE.md).

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
Screenshots) laufen über den normalen WebView-Datei-Dialog des Systems.
Datei-Downloads übernimmt der Download-Manager von Android (eigenes Plugin
`FileDownload` in `mobile/native/`, vom Patch-Skript ins Android-Projekt
kopiert): Die Datei landet im Ordner „Downloads“, Fortschritt und Abschluss
zeigt die System-Benachrichtigung. Das braucht ab Android 10 keine
Berechtigung; ältere Geräte laden über den System-Browser. Der
gesamte AgentDeck-Traffic geht als REST/WebSocket an deinen Server; die
WebView lädt ausschließlich lokal gebaute Assets aus dem APK.

### Bilder aus der Tastatur und der Zwischenablage

Eine WebView meldet der Tastatur von sich aus nicht, dass ihre Textfelder
Bilder annehmen — Gboard zeigt Screenshots in seiner Zwischenablage-Zeile
dann als „hier nicht unterstützt“. Das Patch-Skript ersetzt deshalb
Capacitors Activity-Layout (`res/layout/capacitor_bridge_layout_main.xml`)
durch eines mit `AgentDeckWebView` (`mobile/native/`): Sie trägt `image/*`
als annehmbaren Inhalt ein und nimmt entgegen, was die Tastatur einfügt.
Das Plugin `MediaInput` (`MediaInputPlugin.java`) kopiert die Datei sofort
in den App-Cache (der Lesezugriff der Tastatur endet gleich wieder; höchstens
25 MB, die letzten 20 bleiben liegen) und meldet sie der Web-App, die sie dem
Eingabefeld gibt, das gerade den Fokus hat — Chat-Nachricht oder Terminal.
Dasselbe Plugin liest für „Paste from clipboard“ die System-Zwischenablage
samt Bild. Eine Berechtigung braucht beides nicht.

### Teilen-Ziel

Das Patch-Skript trägt in die `MainActivity` Intent-Filter für
`ACTION_SEND` (Text, Bilder, Dateien) und `ACTION_SEND_MULTIPLE` (Bilder)
ein — AgentDeck erscheint damit im Teilen-Menü anderer Apps. Das Plugin
`ShareTarget` (`mobile/native/ShareTargetPlugin.java`) meldet der Web-App,
was geteilt wurde, und liefert die Dateien auf Anfrage (bis 10 Dateien, je
25 MB). Die App fragt, in welchen Chat es soll; dort landet es als Entwurf.
Eine Berechtigung braucht das nicht: Die teilende App gibt den Lesezugriff
auf genau diese Dateien mit.

### Hintergrundverbindung

Die WebView kennt kein Web Push; Meldungen kommen über den WebSocket. Damit
Android die App im Hintergrund nicht einfriert, startet sie einen
Vordergrund-Dienst (dauerhafte Benachrichtigung „AgentDeck — Connected“),
solange ein Terminal offen ist oder eine Session läuft. Abschaltbar unter
Settings → *Notifications* → *Stay connected in background*. Der Dienst hält
einen Wake-Lock und kostet Akku; im tiefen Doze-Modus kann Android die
Verbindung trotzdem pausieren — Meldungen kommen dann verspätet.

### Google-Push (FCM)

Zuverlässig auch im Doze kommen Meldungen über Firebase Cloud Messaging.
Dafür braucht es zwei Teile aus **demselben** Firebase-Projekt:

1. **App:** `google-services.json` als Repo-Secret `GOOGLE_SERVICES_JSON`
   (siehe `android.yml`) — die APK aus GitHub Actions bringt es dann mit.
2. **Server:** den Service-Account-Schlüssel. Firebase-Konsole →
   Projekteinstellungen → *Dienstkonten* → *Neuen privaten Schlüssel
   generieren*, dann in der App unter Settings → *Notifications* → *Why no
   alert?* → **add the key file** auswählen. Der Server prüft ihn bei Google,
   legt ihn als `fcm-service-account.json` (0600) im Datenordner ab und
   schaltet FCM sofort ein, ohne Neustart. Von Hand dorthin kopiert wirkt er
   nach dem nächsten Serverstart.
