# mobile/ — Capacitor-Wrapper (Android-APK)

Dieser Workspace verpackt die gebaute Web-App (`web/dist`) mit
[Capacitor 7](https://capacitorjs.com/) als Android-APK. Die
`android/`-Plattformdateien werden generiert und sind **nicht** Teil des Repos.

## Voraussetzungen

- Node ≥ 20, npm
- JDK 21 (z. B. Temurin) — Capacitor 7 benötigt Java 21
- Android SDK: Android Studio **oder** nur die cmdline-tools
  (`ANDROID_SDK_ROOT` setzen, siehe `docs/ANDROID.md`)

## APK lokal bauen

Alle Befehle aus dem Repository-Root:

```bash
npm install                      # Workspaces installieren (einmalig)
npm run sync -w mobile           # baut web, kopiert nach mobile/dist, cap sync
npx cap add android -w mobile    # nur beim ERSTEN Mal: generiert mobile/android/
npm run dist:android -w mobile   # cap sync + gradlew assembleDebug
```

Die fertige APK liegt danach unter:

```
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Bequemer: `scripts/build-android.sh` prüft SDK, `android/`-Ordner und führt
dieselben Schritte aus.

## Android Studio

`npm run android -w mobile` öffnet das generierte Projekt in Android Studio
(Emulator, Signierung, Profiling).

## CI

`.github/workflows/android.yml` baut die APK automatisch:
manuell per *workflow_dispatch*, bei Push eines `v*`-Tags (zusätzlich
Release-APK, unsigniert) und bei PRs, die `mobile/**` ändern. Das Artifact
heißt `AgentDeck-debug-APK` — wie du es aufs Handy bekommst, steht in
[`docs/ANDROID.md`](../docs/ANDROID.md).
