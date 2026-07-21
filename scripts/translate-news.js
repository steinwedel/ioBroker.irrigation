#!/usr/bin/env node
/**
 * translate-news.js
 *
 * Der `@alcalzone/release-script-plugin-iobroker` übersetzt neue News-Einträge
 * in io-package.json standardmäßig über https://translator.iobroker.in
 * (Fallback: DeepL, falls DEEPL_API_KEY gesetzt ist). Ist der ioBroker-Dienst
 * down (z.B. "HTTPError: ... 501 Not Implemented") und kein DeepL-Key
 * vorhanden, bricht `npm run release` mit einem Rollback ab.
 *
 * Dieses Skript übernimmt die Übersetzung stattdessen selbst über die im
 * Projekt bereits für die Changelog-Generierung genutzte KI-API (.env:
 * OPENROUTER_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY) und schreibt das
 * Ergebnis direkt unter dem News-Key der *nächsten* Version in
 * io-package.json (`common.news[<version>]`).
 *
 * Das release-script überspringt die Online-Übersetzung, sobald der
 * News-Key der Zielversion bereits existiert (siehe
 * @alcalzone/release-script-plugin-iobroker/build/index.js:
 * `if (newVersion in ioPack.common.news) { ... not changing it }`).
 *
 * Verwendung (vor `npm run release <bump>` aufrufen):
 *   node scripts/translate-news.js [patch|minor|major]
 *   npm run release:translate-news -- patch
 *
 * Sprachen entsprechen denen, die der ioBroker-Übersetzer/DeepL-Pfad im
 * release-script erzeugt: en, de, ru, pt, nl, fr, it, es, pl, uk, zh-cn.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const CHANGELOG_PATH = path.join(PROJECT_ROOT, 'CHANGELOG.md');
const IO_PACKAGE_PATH = path.join(PROJECT_ROOT, 'io-package.json');
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, 'package.json');
const PLACEHOLDER_REGEX = /^## \*\*WORK IN PROGRESS\*\*\s*$/m;

// Gleiche Zielsprachen wie translateWithDeepL/-IoBroker im release-script-plugin.
const TARGET_LANGUAGES = ['de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

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

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 4)}\n`);
}

/** Mirrors cleanChangelogForNews() from release-script-plugin-iobroker/build/tools.js */
function cleanChangelogForNews(changelog) {
    const changelogAuthorRegex = /^[ \t]*[*-][ \t]*\([\p{L}\p{M}0-9@\-_,;&+/ ]+\)[ \t]*/gimu;
    const changelogBulletPointTestRegex = /^[ \t]*[*-][ \t]*/;
    const changelogBulletPointReplaceRegex = new RegExp(changelogBulletPointTestRegex, 'mg');

    changelog = changelog
        .trim()
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(changelogAuthorRegex, '* ');

    const lines = changelog.split('\n');
    if (lines.every(line => !line || changelogBulletPointTestRegex.test(line))) {
        changelog = changelog.replace(changelogBulletPointReplaceRegex, '');
    }
    return changelog;
}

function extractWorkInProgressBody(changelog) {
    const match = PLACEHOLDER_REGEX.exec(changelog);
    if (!match) {
        throw new Error('No "## **WORK IN PROGRESS**" section found in CHANGELOG.md.');
    }
    const rest = changelog.slice(match.index + match[0].length);
    const nextHeadlineIndex = rest.search(/^## /m);
    const body = (nextHeadlineIndex === -1 ? rest : rest.slice(0, nextHeadlineIndex)).trim();
    if (!body) {
        throw new Error('"## **WORK IN PROGRESS**" section is empty in CHANGELOG.md.');
    }
    return body;
}

function buildTranslationPrompt(textEN, languages) {
    return `Translate the following ioBroker adapter changelog/news text from English into these languages: ${languages.join(', ')}.

Rules:
- Preserve markdown bold markers (**like this**) and backtick-quoted identifiers (\`like this\`) exactly, do not translate their inner code-identifier content.
- Preserve the bullet list structure and line breaks.
- Translate naturally and idiomatically for a technical software changelog audience, not literally word-by-word.
- Return ONLY a single valid JSON object, no markdown code fences, no commentary, no trailing commas.
- The JSON object must have exactly these keys: ${languages.join(', ')}.
- Each value is the full translated text for that language code, as a single valid JSON string.
- CRITICAL: any double-quote character (") that appears inside a translated value (e.g. quoting a UI label) MUST be escaped as \\" so the overall result is valid, parseable JSON. Prefer using this escaping over other quote styles.
- Do not add newlines inside the JSON string values; keep each translation as one continuous string (use spaces instead of line breaks).

Text to translate:
"""
${textEN}
"""`;
}

/** Best-effort repair for near-valid JSON that has unescaped inner double quotes. */
function repairJsonWithUnescapedQuotes(text, keys) {
    // Try to fix the common failure mode: a value contains raw " characters
    // (e.g. "Selected plan") instead of \". Walk key by key and escape stray
    // quotes that are not part of the key/value delimiters.
    let repaired = text;
    for (const key of keys) {
        const keyPattern = new RegExp(`"${key}"\\s*:\\s*"`, 'g');
        let match;
        while ((match = keyPattern.exec(repaired))) {
            const valueStart = match.index + match[0].length;
            // Find the end of this value: the next `",` or `"}` at the start of
            // a new key, scanning forward and escaping any quote that isn't
            // immediately followed by a JSON structural character.
            let i = valueStart;
            let out = '';
            let closed = false;
            while (i < repaired.length) {
                const ch = repaired[i];
                if (ch === '\\') {
                    out += repaired.slice(i, i + 2);
                    i += 2;
                    continue;
                }
                if (ch === '"') {
                    const rest = repaired.slice(i + 1).match(/^\s*[,}]/);
                    if (rest) {
                        out += '"';
                        i += 1;
                        closed = true;
                        break;
                    }
                    out += '\\"';
                    i += 1;
                    continue;
                }
                out += ch;
                i += 1;
            }
            if (!closed) {
                break;
            }
            repaired = repaired.slice(0, valueStart) + out + repaired.slice(i);
            keyPattern.lastIndex = valueStart + out.length;
        }
    }
    return repaired;
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
            temperature: 0.1,
            response_format: { type: 'json_object' },
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
            temperature: 0.1,
            response_format: { type: 'json_object' },
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
            max_tokens: 4096,
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

async function callAi(prompt) {
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
        'No AI API key configured. Set one of OPENROUTER_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY in .env.',
    );
}

function extractJson(raw, keys) {
    if (!raw) {
        throw new Error('AI returned an empty response.');
    }
    let text = raw.trim();
    // Strip markdown code fences if the model added them despite instructions.
    const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
    if (fenceMatch) {
        text = fenceMatch[1];
    }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) {
        throw new Error(`AI response did not contain a JSON object:\n${raw}`);
    }
    text = text.slice(firstBrace, lastBrace + 1);
    try {
        return JSON.parse(text);
    } catch (err) {
        if (keys && keys.length) {
            try {
                return JSON.parse(repairJsonWithUnescapedQuotes(text, keys));
            } catch {
                // fall through to throw the original error below
            }
        }
        throw new Error(`Failed to parse AI JSON response (${err.message}):\n${text}`);
    }
}

async function translateNews(textEN) {
    const prompt = buildTranslationPrompt(textEN, TARGET_LANGUAGES);
    const raw = await callAi(prompt);
    const parsed = extractJson(raw, TARGET_LANGUAGES);

    const translations = { en: textEN };
    for (const lang of TARGET_LANGUAGES) {
        if (typeof parsed[lang] !== 'string' || !parsed[lang].trim()) {
            throw new Error(`AI translation is missing or empty for language "${lang}".`);
        }
        translations[lang] = parsed[lang].trim();
    }
    return translations;
}

function prependKey(obj, newKey, value) {
    const ret = { [newKey]: value };
    for (const [k, v] of Object.entries(obj)) {
        ret[k] = v;
    }
    return ret;
}

function computeNextVersion(bump) {
    const semver = require(path.join(PROJECT_ROOT, 'node_modules', 'semver'));
    const pkg = readJson(PACKAGE_JSON_PATH);
    const next = semver.inc(pkg.version, bump);
    if (!next) {
        throw new Error(`Could not compute next version from "${pkg.version}" with bump "${bump}".`);
    }
    return next;
}

async function main() {
    loadDotEnv();

    const bump = process.argv[2] || 'patch';
    if (!['patch', 'minor', 'major'].includes(bump)) {
        console.error(`Unknown version bump "${bump}". Use one of: patch, minor, major.`);
        process.exit(1);
    }

    const nextVersion = computeNextVersion(bump);

    const ioPack = readJson(IO_PACKAGE_PATH);
    ioPack.common.news ??= {};

    if (nextVersion in ioPack.common.news) {
        console.log(
            `common.news["${nextVersion}"] already present in io-package.json - nothing to translate. ` +
                `release-script will skip online translation for this version.`,
        );
        return;
    }

    const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
    const wipBody = extractWorkInProgressBody(changelog);
    const newsTextEN = cleanChangelogForNews(wipBody);

    console.log(`Translating news for version ${nextVersion} via AI (${TARGET_LANGUAGES.join(', ')})...`);
    console.log('\nEnglish source text:\n');
    console.log(newsTextEN);
    console.log('');

    const translations = await translateNews(newsTextEN);

    ioPack.common.news = prependKey(ioPack.common.news, nextVersion, translations);
    writeJson(IO_PACKAGE_PATH, ioPack);

    console.log(`Wrote translated news for "${nextVersion}" to io-package.json.`);
    for (const lang of Object.keys(translations)) {
        console.log(`  - ${lang}: ${translations[lang].slice(0, 80)}${translations[lang].length > 80 ? '…' : ''}`);
    }

    const status = git(['status', '--porcelain', '--', 'io-package.json']);
    if (status) {
        console.log('\nio-package.json has uncommitted changes (expected). release-script will pick these up.');
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
