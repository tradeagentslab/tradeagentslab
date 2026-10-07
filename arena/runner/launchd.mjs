#!/usr/bin/env node
// Prints the launchd job that runs the house agents' decisions four times a day
// (00, 06, 12, 18 UTC). It only prints: installing it is the operator's call.
//
//   node runner/launchd.mjs --config /abs/path/config.json > job.plist

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { BRAND } from '../../guard/src/brand.js';

const UTC_HOURS = [0, 6, 12, 18];

/** launchd counts in the Mac's local time; convert the UTC hours for a given offset (minutes east of UTC). */
export function localHours(offsetMin = -new Date().getTimezoneOffset()) {
  return UTC_HOURS.map((h) => ({ hour: (((h * 60 + offsetMin) / 60) % 24 + 24) % 24, minute: ((offsetMin % 60) + 60) % 60 }));
}

export function plist({ config, node = process.execPath, offsetMin }) {
  const script = fileURLToPath(new URL('./run.mjs', import.meta.url));
  const home = JSON.parse(readFileSync(config, 'utf8')).home;
  const times = localHours(offsetMin).map(({ hour, minute }) => `    <dict><key>Hour</key><integer>${Math.floor(hour)}</integer><key>Minute</key><integer>${minute + 1}</integer></dict>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${BRAND.short}.arena-runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${script}</string>
    <string>--config</string>
    <string>${config}</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
${times}
  </array>
  <key>StandardOutPath</key><string>${home}/log/launchd.out</string>
  <key>StandardErrorPath</key><string>${home}/log/launchd.err</string>
</dict>
</plist>
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--config');
  process.stdout.write(plist({ config: process.argv[i + 1] }));
}
