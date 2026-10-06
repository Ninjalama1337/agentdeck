#!/usr/bin/env node
/**
 * Adds what AgentDeck needs to the generated (uncommitted) android/ project:
 * permissions (microphone for Whisper dictation, notifications for "agent
 * finished / waiting" alerts, vibration for haptics), the foreground
 * service that keeps the connection alive in the background, and the app's own
 * Java sources from mobile/native (MainActivity, file download and app update
 * plugins), and the intent filters that make the app a share target.
 * Idempotent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = path.resolve(here, '../android/app/src/main/AndroidManifest.xml');

if (!fs.existsSync(manifest)) {
  console.error(`patch-android: ${manifest} not found — run \`npx cap add android\` first.`);
  process.exit(1);
}

const PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.VIBRATE',
  // Background connection (web/src/util/backgroundService.ts).
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.WAKE_LOCK',
  // In-app update: hand the downloaded APK to the package installer
  // (mobile/native/ApkInstallPlugin.java).
  'android.permission.REQUEST_INSTALL_PACKAGES',
];

// Foreground service of @capawesome-team/capacitor-android-foreground-service.
// Type "specialUse": no fixed category fits "hold a socket to the user's own
// server", and unlike "dataSync" it has no daily time limit on Android 15.
const FGS_PACKAGE = 'io.capawesome.capacitorjs.plugins.foregroundservice';
const FGS_COMPONENTS = `
        <receiver android:name="${FGS_PACKAGE}.NotificationActionBroadcastReceiver" />
        <service
            android:name="${FGS_PACKAGE}.AndroidForegroundService"
            android:exported="false"
            android:foregroundServiceType="specialUse">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="Keeps the connection to the user's own AgentDeck server open to deliver agent notifications" />
        </service>
`;

// FCM notifications are drawn by the system: give them the status-bar icon
// and a fallback channel (a message without a known channel_id).
const FCM_META = `
        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_stat_agentdeck" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="agentdeck-alerts" />
`;

// Our own FCM service replaces the Capacitor plugin's, so data-only messages for
// a terminal's yes/no question can be drawn with action buttons
// (mobile/native/AgentDeckMessagingService.java); everything else is passed on.
const MESSAGING_COMPONENTS = `
        <service
            android:name="com.capacitorjs.plugins.pushnotifications.MessagingService"
            tools:node="remove" />
        <service android:name="com.ninjalama.agentdeck.AgentDeckMessagingService" android:exported="false">
            <intent-filter>
                <action android:name="com.google.firebase.MESSAGING_EVENT" />
            </intent-filter>
        </service>
        <receiver android:name="com.ninjalama.agentdeck.AnswerReceiver" android:exported="false" />
`;

// Small icon of the service's permanent notification. Without a valid icon the
// service cannot enter the foreground and Android kills the app.
const STAT_ICON = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="M12,3 L20,21 H16.6 L15,17 H9 L7.4,21 H4 Z M12,9.2 L10.1,14.2 H13.9 Z" />
</vector>
`;

let xml = fs.readFileSync(manifest, 'utf8');
const missing = PERMISSIONS.filter((p) => !xml.includes(`"${p}"`));
if (missing.length === 0) {
  console.log('patch-android: permissions already present');
} else {
  const lines = missing.map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
  xml = xml.replace(/(<\/manifest>\s*)$/, `${lines}\n$1`);
  fs.writeFileSync(manifest, xml);
  console.log(`patch-android: added ${missing.join(', ')}`);
}

if (xml.includes(`${FGS_PACKAGE}.AndroidForegroundService`)) {
  console.log('patch-android: foreground service already present');
} else {
  xml = xml.replace(/(\n\s*<\/application>)/, `\n${FGS_COMPONENTS.trimEnd()}$1`);
  fs.writeFileSync(manifest, xml);
  console.log('patch-android: added foreground service');
}

if (xml.includes('default_notification_icon')) {
  console.log('patch-android: FCM defaults already present');
} else {
  xml = xml.replace(/(\n\s*<\/application>)/, `\n${FCM_META.trimEnd()}$1`);
  fs.writeFileSync(manifest, xml);
  console.log('patch-android: added FCM notification defaults');
}

if (xml.includes('AgentDeckMessagingService')) {
  console.log('patch-android: messaging service already present');
} else {
  if (!xml.includes('xmlns:tools=')) {
    xml = xml.replace('<manifest ', '<manifest xmlns:tools="http://schemas.android.com/tools" ');
  }
  xml = xml.replace(/(\n\s*<\/application>)/, `\n${MESSAGING_COMPONENTS.trimEnd()}$1`);
  fs.writeFileSync(manifest, xml);
  console.log('patch-android: added messaging service + answer receiver');
}

// "Share → AgentDeck" from other apps: text and links, images, any file
// (mobile/native/ShareTargetPlugin.java hands them to the web app).
const SHARE_FILTERS = `
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
                <data android:mimeType="image/*" />
                <data android:mimeType="application/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
            </intent-filter>
`;
if (xml.includes('android.intent.action.SEND')) {
  console.log('patch-android: share target already present');
} else if (!/<activity[^>]*MainActivity[\s\S]*?<\/activity>/.test(xml)) {
  console.error('patch-android: MainActivity not found in the manifest — share target NOT added');
  process.exit(1);
} else {
  // Into the main activity, the only one that takes intents.
  xml = xml.replace(/(<activity[^>]*MainActivity[\s\S]*?)(\n\s*<\/activity>)/, `$1\n${SHARE_FILTERS.trimEnd()}$2`);
  fs.writeFileSync(manifest, xml);
  console.log('patch-android: added share target');
}

const statIcon = path.resolve(here, '../android/app/src/main/res/drawable/ic_stat_agentdeck.xml');
if (!fs.existsSync(statIcon) || fs.readFileSync(statIcon, 'utf8') !== STAT_ICON) {
  fs.mkdirSync(path.dirname(statIcon), { recursive: true });
  fs.writeFileSync(statIcon, STAT_ICON);
  console.log('patch-android: wrote ic_stat_agentdeck drawable');
}

// App-local Java sources (MainActivity registers the plugins next to it).
const nativeSrc = path.resolve(here, '../native');
const javaDir = path.resolve(here, '../android/app/src/main/java/com/ninjalama/agentdeck');
for (const name of fs.readdirSync(nativeSrc).filter((f) => f.endsWith('.java'))) {
  const source = fs.readFileSync(path.join(nativeSrc, name), 'utf8');
  const target = path.join(javaDir, name);
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== source) {
    fs.mkdirSync(javaDir, { recursive: true });
    fs.writeFileSync(target, source);
    console.log(`patch-android: wrote ${name}`);
  }
}

// versionName/versionCode from the release version (VITE_AGENTDECK_APK_VERSION or
// APK_VERSION): 0.10.0 → 1000, 1.2.3 → 10203. Monotonic, so an update is never
// rejected as a downgrade. Never lowers an existing higher versionCode.
const version = process.env.APK_VERSION || process.env.VITE_AGENTDECK_APK_VERSION;
const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
const gradle = path.resolve(here, '../android/app/build.gradle');
if (m && fs.existsSync(gradle)) {
  const code = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  let g = fs.readFileSync(gradle, 'utf8');
  const current = Number(/versionCode\s+(\d+)/.exec(g)?.[1] ?? 0);
  const next = Math.max(code, current);
  g = g.replace(/versionCode\s+\d+/, `versionCode ${next}`).replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
  fs.writeFileSync(gradle, g);
  console.log(`patch-android: versionName ${version}, versionCode ${next}`);
}

// AgentDeckMessagingService extends the push plugin's FirebaseMessagingService,
// but the plugin keeps firebase-messaging to itself (implementation, not api):
// the app module needs it on its own compile classpath. Same version as the plugin.
if (fs.existsSync(gradle)) {
  let g = fs.readFileSync(gradle, 'utf8');
  if (!g.includes('com.google.firebase:firebase-messaging')) {
    g = g.replace(/dependencies\s*\{/, 'dependencies {\n    implementation "com.google.firebase:firebase-messaging:24.1.0"');
    fs.writeFileSync(gradle, g);
    console.log('patch-android: added firebase-messaging dependency');
  }
}
