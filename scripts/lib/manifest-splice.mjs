// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { readFileSync, writeFileSync } from 'node:fs';

// Editing manifest.json in place, never reserialising it.
//
// scripts/lib/version.mjs already states the rule: JSON files other tools and
// humans own are rewritten with targeted replacements, because reserialising
// reformats parts nobody asked to change. generate-surfaces.mjs used to ignore
// that and `JSON.stringify` the whole manifest, which expanded every
// hand-written inline array — so `npm run generate` produced diff noise in
// blocks (`data_collection_permissions.required`, most visibly) with nothing
// to do with AI surfaces, and a reviewer had to read the diff to find out
// whether anything real had moved.
//
// So: splice a fresh serialization of ONE top-level key's value into the
// original text and leave every other byte alone.

/**
 * Write only when the bytes actually change, and report whether they did.
 *
 * Running a generator for an unrelated reason should leave a clean tree clean.
 * A generator that always writes turns "did the catalog move?" into a question
 * you answer by reading a diff.
 */
export function writeIfChanged(path, next) {
  let current = null;
  try { current = readFileSync(path, 'utf8'); } catch { /* new file */ }
  if (current === next) return false;
  writeFileSync(path, next);
  return true;
}

/**
 * The `[start, end)` span of `key`'s value in `text`, whatever its type.
 *
 * Containers are bracket-matched rather than regexed, and string literals are
 * skipped as literals: a match pattern carries no brackets today, but a rule
 * that only holds because of the data currently in the file is not a rule.
 */
export function valueSpan(text, key) {
  const { colon } = findTopLevelKey(text, key);
  const start = colon + 1 + text.slice(colon + 1).search(/\S/);

  if (text[start] === '"') return [start, endOfString(text, start) + 1];
  if (text[start] !== '[' && text[start] !== '{') {
    const scalar = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(start));
    if (!scalar) throw new Error(`"${key}" has no value this can locate`);
    return [start, start + scalar[0].length];
  }

  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') { i = endOfString(text, i); continue; }
    if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return [start, i + 1];
    }
  }
  throw new Error(`"${key}" value is not balanced`);
}

/**
 * Locate a key of the ROOT object — not the first text that looks like it.
 *
 * `"storage"` is both a top-level manifest key and a string inside the
 * `permissions` array; `indexOf` finds the permission and a delete built on it
 * corrupts the file. So this tracks nesting depth, skips string literals, and
 * only accepts a depth-1 string that a `:` follows. Same hazard
 * scripts/lib/version.mjs guards with its `"` before `version`, one level up.
 */
function findTopLevelKey(text, key) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      const end = endOfString(text, i);
      if (depth === 1 && text.slice(i + 1, end) === key) {
        const gap = text.slice(end + 1).search(/\S/);
        if (gap !== -1 && text[end + 1 + gap] === ':') return { keyStart: i, colon: end + 1 + gap };
      }
      i = end;
      continue;
    }
    if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
  }
  throw new Error(`no top-level "${key}" key`);
}

/** Index of the closing quote of the string literal opening at `start`. */
function endOfString(text, start) {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i;
  }
  throw new Error('unterminated string literal');
}

/**
 * Serialize at the file's own indentation. A top-level key's value sits one
 * level in, so every line after the opening bracket gains the 2-space step —
 * which is what makes splicing an unchanged value a byte-for-byte no-op.
 */
export function serializeAtDepth1(value) {
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : `  ${line}`))
    .join('\n');
}

/** `text` with `key`'s value replaced, and every byte outside it untouched. */
export function spliceValue(text, key, value) {
  const [start, end] = valueSpan(text, key);
  return text.slice(0, start) + serializeAtDepth1(value) + text.slice(end);
}

/**
 * `text` with one top-level key and its value removed, by lines.
 *
 * The comma is the whole difficulty. An entry in the middle owns the comma
 * that follows it; the LAST entry owns none, and the comma that has to go is
 * the one on the entry before it — miss that and the object is left with a
 * dangling separator that no longer parses.
 */
export function removeTopLevelKey(text, key) {
  const [, valueEnd] = valueSpan(text, key);
  const { keyStart } = findTopLevelKey(text, key);
  const lineStart = text.lastIndexOf('\n', keyStart) + 1;

  const trailing = /^[ \t]*,[ \t]*\r?\n/.exec(text.slice(valueEnd));
  if (trailing) {
    return text.slice(0, lineStart) + text.slice(valueEnd + trailing[0].length);
  }

  // Last entry in its object: take the preceding separator with it. That comma
  // is the final character before this entry's line, so the last one in the
  // text before `lineStart` is always it — a comma inside an earlier string
  // cannot be later than the separator that ends that line.
  const before = text.slice(0, lineStart);
  const comma = before.lastIndexOf(',');
  if (comma === -1) throw new Error(`"${key}" appears to be the only key — refusing to empty the object`);
  const rest = /^[ \t]*\r?\n/.exec(text.slice(valueEnd));
  return before.slice(0, comma) + before.slice(comma + 1) + text.slice(valueEnd + (rest ? rest[0].length : 0));
}

/**
 * `text` with the key at `path` removed.
 *
 * A top-level key goes by lines. A nested one re-serializes only its top-level
 * container — `background` is three keys, not a whole manifest — so the blast
 * radius stays at the container the caller is actually editing.
 */
export function deletePath(text, path) {
  if (path.length === 1) return removeTopLevelKey(text, path[0]);
  const [start, end] = valueSpan(text, path[0]);
  const container = JSON.parse(text.slice(start, end));
  let node = container;
  for (const key of path.slice(1, -1)) node = node?.[key];
  if (node === undefined) throw new Error(`no container at ${path.slice(0, -1).join('.')}`);
  delete node[path[path.length - 1]];
  return spliceValue(text, path[0], container);
}
