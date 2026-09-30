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
  process.exit(0);
}
const lines = missing.map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
xml = xml.replace(/(<\/manifest>\s*)$/, `${lines}\n$1`);
fs.writeFileSync(manifest, xml);
console.log(`patch-android: added ${missing.join(', ')}`);
