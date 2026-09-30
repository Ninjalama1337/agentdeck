#!/usr/bin/env node
/**
 * Adds the Android permissions AgentDeck needs to the generated (uncommitted)
 * android/ project: microphone for Whisper dictation, notifications for
 * "agent finished / waiting" alerts, vibration for haptics. Idempotent.
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
];

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
