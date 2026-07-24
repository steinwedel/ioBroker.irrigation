#!/usr/bin/env node
/**
 * release-with-translation.js
 *
 * Wrapper um `release-script --addPlaceholder <args...>`, der vorher die
 * News-Übersetzung für io-package.json per KI erledigt (siehe
 * scripts/translate-news.js), falls der Online-Übersetzungsdienst von
 * ioBroker down ist und kein DEEPL_API_KEY konfiguriert wurde.
 *
 * Nimmt exakt die Argumente entgegen, die auch an `release-script` gehen
 * würden (z.B. "patch", "minor", "major", "--dry-run", ...), verwendet das
 * erste positionsbasierte "patch"/"minor"/"major"-Argument zur Berechnung
 * der nächsten Version und ruft dann:
 *   1. node scripts/translate-news.js <bump>
 *      -> schreibt die KI-Übersetzung direkt (unstaged) in io-package.json
 *   2. release-script --addPlaceholder --all <alle Original-Argumente>
 *      -> "--all" (a.k.a. -A/--includeUnstaged) ist nötig, weil
 *         release-script sonst mit "uncommitted changes" abbricht; die
 *         vorbereitete io-package.json-Änderung wird dadurch regulär in den
 *         Release-Commit übernommen. release-script erkennt den bereits
 *         vorhandenen News-Key der Zielversion und überspringt seinen
 *         eigenen (kaputten) Online-Übersetzungsaufruf.
 */

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const bump = args.find(a => ['patch', 'minor', 'major'].includes(a)) || 'patch';

function run(command, commandArgs) {
    const result = spawnSync(command, commandArgs, {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

run('node', [path.join('scripts', 'translate-news.js'), bump]);

const releaseArgs = ['--addPlaceholder', '--yes'];
if (!args.includes('--all') && !args.includes('-A') && !args.includes('--includeUnstaged')) {
    releaseArgs.push('--all');
}
releaseArgs.push(...args);

const releaseScriptBin = path.join(
    PROJECT_ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'release-script.cmd' : 'release-script',
);
run(releaseScriptBin, releaseArgs);
