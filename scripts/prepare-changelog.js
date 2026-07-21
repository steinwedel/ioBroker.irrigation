#!/usr/bin/env node
/**
 * prepare-changelog.js
 *
 * Bereitet CHANGELOG.md für einen anschließenden `release-script`-Lauf vor:
 *
 *   1. Prüft, ob CHANGELOG.md bereits einen befüllten
 *      "## **WORK IN PROGRESS**"-Platzhalter enthält (das release-script
 *      verlangt zwingend genau diesen Marker, um den "nächste Version"-Block
 *      zu erkennen - siehe the `\@alcalzone/release-script-plugin-changelog` package.
 *   2. Falls der Platzhalter fehlt oder leer ist: sammelt alle Commits seit
 *      dem letzten Git-Tag (bzw. dem letzten Changelog-Versionseintrag),
 *      lässt daraus per LLM-API eine Changelog-Beschreibung im Projektformat
 *      generieren ("* (Autor) **TYPE**: Beschreibung") und fügt sie direkt
 *      nach "# Changelog" unter einem neuen "## **WORK IN PROGRESS**"-Block
 *      ein.
 *   3. Committet die aktualisierte CHANGELOG.md (git add + git commit).
 *
 * Anschließend kann `npm run release` (release-script) unverändert laufen,
 * weil der benötigte Platzhalter jetzt garantiert vorhanden und befüllt ist.
 *
 * Konfiguration (.env im Projekt-Root, siehe .env):
 *   - Einer der folgenden API-Keys muss gesetzt sein:
 *       OPENROUTER_API_KEY   (nutzt OpenRouter, Modell über CHANGELOG_AI_MODEL
 *                             konfigurierbar, Default: "anthropic/claude-sonnet-4.5")
 *       OPENAI_API_KEY       (nutzt OpenAI Chat Completions API)
 *       ANTHROPIC_API_KEY    (nutzt Anthropic Messages API)
 *   - CHANGELOG_AI_MODEL     optionales Modell-Override
 *
 * Verwendung:
 *   node scripts/prepare-changelog.js
 *   npm run release:prepare
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const CHANGELOG_PATH = path.join(PROJECT_ROOT, 'CHANGELOG.md');
const PLACEHOLDER_LINE = '## **WORK IN PROGRESS**';
const PLACEHOLDER_REGEX = /^## \*\*WORK IN PROGRESS\*\*\s*$/m;

function loadDotEnv() {
    const envPath = path.join(PROJECT_ROOT, '.env');
    if (!fs.existsSync(envPath)) {
        return;
    }
    const content = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const eqIndex = line.indexOf('=');
        if (eqIndex === -1) {
            continue;
        }
        const key = line.slice(0, eqIndex).trim();
        let value = line.slice(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

function git(args) {
    return execFileSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
}

function getLastReleaseRef() {
    try {
        return git(['describe', '--tags', '--abbrev=0']);
    } catch {
        // No tags yet - fall back to the repo root commit.
        return git(['rev-list', '--max-parents=0', 'HEAD']);
    }
}

function getCommitsSince(ref) {
    const log = git(['log', `${ref}..HEAD`, '--pretty=format:%H%x01%an%x01%s%x01%b%x02']);
    if (!log) {
        return [];
    }
    return log
        .split('\x02')
        .map(entry => entry.trim())
        .filter(Boolean)
        .map(entry => {
            const [hash, author, subject, body] = entry.split('\x01');
            return { hash, author, subject, body: (body || '').trim() };
        });
}

function getDiffStatSince(ref) {
    try {
        return git(['diff', '--stat', `${ref}..HEAD`]);
    } catch {
        return '';
    }
}

function getDiffSince(ref, maxChars = 12000) {
    try {
        // Exclude generated/build artifacts and lockfiles - they add noise
        // without giving the model useful signal for a changelog summary.
        const diff = git(['diff', `${ref}..HEAD`, '--', '.', ':!build', ':!package-lock.json', ':!*.map']);
        return diff.length > maxChars ? `${diff.slice(0, maxChars)}\n... (truncated)` : diff;
    } catch {
        return '';
    }
}

function readChangelog() {
    return fs.readFileSync(CHANGELOG_PATH, 'utf8');
}

function countPlaceholders(changelog) {
    const matches = changelog.match(new RegExp(PLACEHOLDER_REGEX.source, 'gm'));
    return matches ? matches.length : 0;
}

function hasFilledPlaceholder(changelog) {
    const match = PLACEHOLDER_REGEX.exec(changelog);
    if (!match) {
        return false;
    }
    const rest = changelog.slice(match.index + match[0].length);
    const nextHeadlineIndex = rest.search(/^## /m);
    const body = (nextHeadlineIndex === -1 ? rest : rest.slice(0, nextHeadlineIndex)).trim();
    return body.length > 0;
}

function insertPlaceholderWithBody(changelog, body) {
    const existingMatch = PLACEHOLDER_REGEX.exec(changelog);
    if (existingMatch) {
        // An empty (or whitespace-only) placeholder already exists somewhere in the
        // file - fill it in place instead of inserting a second marker above it,
        // which would otherwise duplicate "## **WORK IN PROGRESS**" in the output.
        // PLACEHOLDER_REGEX's trailing \s* is greedy and swallows any blank/
        // whitespace-only lines already following the marker line, so anchor
        // "before" right after the literal marker text (not the full match) to
        // discard that existing whitespace instead of preserving it verbatim.
        const afterMarkerText = existingMatch.index + PLACEHOLDER_LINE.length;
        const afterWholeMatch = existingMatch.index + existingMatch[0].length;
        const rest = changelog.slice(afterWholeMatch);
        const nextHeadlineIndex = rest.search(/^## /m);
        const after = (nextHeadlineIndex === -1 ? '' : rest.slice(nextHeadlineIndex)).replace(/^\n*/, '');
        const before = changelog.slice(0, afterMarkerText).replace(/\n*$/, '\n');
        return `${before}${body.trim()}\n\n${after}`;
    }

    const headerMatch = /^# Changelog\s*\n/.exec(changelog);
    if (!headerMatch) {
        throw new Error('CHANGELOG.md does not start with "# Changelog" - cannot insert placeholder.');
    }
    const insertAt = headerMatch.index + headerMatch[0].length;
    const before = changelog.slice(0, insertAt).replace(/\n*$/, '\n');
    const after = changelog.slice(insertAt).replace(/^\n*/, '');
    return `${before}${PLACEHOLDER_LINE}\n${body.trim()}\n\n${after}`;
}

function buildPrompt({ author, commits, diffStat, diff }) {
    const commitList = commits
        .map(c => `- ${c.subject}${c.body ? `\n  ${c.body.replace(/\n/g, '\n  ')}` : ''}`)
        .join('\n');

    return `You write CHANGELOG.md entries for the ioBroker adapter "iobroker.irrigation".

Format rules (follow exactly):
- Output ONLY changelog lines, no headings, no extra commentary.
- Each line has the form: * (${author}) **TYPE**: Description
- TYPE is one of: NEW, FIXED, ENHANCED (uppercase, matches the existing changelog convention).
- Write concise, technical, English descriptions of what changed and why, in the same style as existing entries (see examples).
- Group related commits into a single bullet if they describe the same change; skip purely mechanical commits (e.g. "chore: bump version") that have no user-visible effect.
- Do not invent changes that are not supported by the commits/diff.

Existing changelog style examples (for tone/format reference only, do not repeat them):
* (Gerhard Steinwedel) **FIXED**: Root cause of the adapter restart loop found and fixed — \`extendForeignObjectAsync\` deep-merges arrays by index instead of replacing them, so stale \`valves\`/\`plans\` array elements survived and kept re-triggering the "needs migration" check on every restart. All native config writes now use a full read-modify-write (\`writeNativeAsync\`) instead
* (Gerhard Steinwedel) **ENHANCED**: Plans now reference valve indexes directly (\`valveIndexes: number[]\`) — \`groups\` removed from valves. Plan assignment uses multi-select dropdown + bulk add/remove buttons in admin UI. Empty valve list = all valves (default "Alle" plan)

Commits since the last release:
${commitList}

Diff stat since the last release:
${diffStat}

Diff (may be truncated):
${diff}

Now output the changelog bullet lines for these changes.`;
}

async function callOpenRouter(prompt) {
    const model = process.env.CHANGELOG_AI_MODEL || 'anthropic/claude-sonnet-4.5';
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
        }),
    });
    if (!response.ok) {
        throw new Error(
            `OpenRouter API request failed: HTTP ${response.status} ${response.statusText} - ${await response.text()}`,
        );
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim();
}

async function callOpenAI(prompt) {
    const model = process.env.CHANGELOG_AI_MODEL || 'gpt-4o-mini';
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
        }),
    });
    if (!response.ok) {
        throw new Error(
            `OpenAI API request failed: HTTP ${response.status} ${response.statusText} - ${await response.text()}`,
        );
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim();
}

async function callAnthropic(prompt) {
    const model = process.env.CHANGELOG_AI_MODEL || 'claude-sonnet-4-5';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model,
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
        }),
    });
    if (!response.ok) {
        throw new Error(
            `Anthropic API request failed: HTTP ${response.status} ${response.statusText} - ${await response.text()}`,
        );
    }
    const data = await response.json();
    return data.content?.[0]?.text?.trim();
}

async function generateChangelogBody(prompt) {
    if (process.env.OPENROUTER_API_KEY) {
        return callOpenRouter(prompt);
    }
    if (process.env.OPENAI_API_KEY) {
        return callOpenAI(prompt);
    }
    if (process.env.ANTHROPIC_API_KEY) {
        return callAnthropic(prompt);
    }
    throw new Error(
        'No AI API key configured. Set one of OPENROUTER_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY in .env to auto-generate the changelog entry.',
    );
}

function sanitizeBody(body) {
    return body
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('*'))
        .join('\n');
}

function hasUncommittedChangesOtherThan(...allowedPaths) {
    const status = git(['status', '--porcelain']);
    const allowed = new Set(allowedPaths);
    return status
        .split('\n')
        .filter(Boolean)
        .some(line => {
            const file = line.slice(3).trim();
            return !allowed.has(file);
        });
}

async function main() {
    loadDotEnv();

    if (!fs.existsSync(CHANGELOG_PATH)) {
        console.error('CHANGELOG.md not found in project root.');
        process.exit(1);
    }

    const changelog = readChangelog();

    const placeholderCount = countPlaceholders(changelog);
    if (placeholderCount > 1) {
        console.error(
            `Found ${placeholderCount} "${PLACEHOLDER_LINE}" markers in CHANGELOG.md - there must be exactly one. ` +
                'Remove the duplicate(s) manually (keep the one with content, if any) before running this script again.',
        );
        process.exit(1);
    }

    if (hasFilledPlaceholder(changelog)) {
        console.log(`${PLACEHOLDER_LINE} already present with content - nothing to do.`);
        return;
    }

    console.log(`No filled "${PLACEHOLDER_LINE}" section found - generating one from recent commits...`);

    const lastRef = getLastReleaseRef();
    const commits = getCommitsSince(lastRef);
    if (commits.length === 0) {
        console.error(
            `No commits found since ${lastRef}. Add a "${PLACEHOLDER_LINE}" entry to CHANGELOG.md manually before releasing.`,
        );
        process.exit(1);
    }

    const author = commits[0].author;
    const diffStat = getDiffStatSince(lastRef);
    const diff = getDiffSince(lastRef);

    const prompt = buildPrompt({ author, commits, diffStat, diff });

    let body;
    try {
        body = await generateChangelogBody(prompt);
    } catch (err) {
        console.error(`Failed to generate changelog entry via AI: ${err.message}`);
        process.exit(1);
    }

    body = sanitizeBody(body || '');
    if (!body) {
        console.error('AI returned an empty or unparseable changelog body. Aborting.');
        process.exit(1);
    }

    console.log('\nGenerated changelog entry:\n');
    console.log(body);
    console.log('');

    const updatedChangelog = insertPlaceholderWithBody(changelog, body);
    fs.writeFileSync(CHANGELOG_PATH, updatedChangelog);
    console.log(`Updated ${path.relative(PROJECT_ROOT, CHANGELOG_PATH)}.`);

    if (hasUncommittedChangesOtherThan('CHANGELOG.md')) {
        console.log(
            'Note: there are other uncommitted changes besides CHANGELOG.md. Only CHANGELOG.md will be committed here.',
        );
    }

    git(['add', 'CHANGELOG.md']);
    const commitMessage = `docs(changelog): add WORK IN PROGRESS entry\n\nAuto-generated from commits since ${lastRef}.`;
    git(['commit', '-m', commitMessage]);
    console.log('Committed CHANGELOG.md update.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
