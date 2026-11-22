// main.ts — mend, one patch tool for every AI edit format (SPEC.md).
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
// It reads all four formats the spec names — unified diffs (often with wrong
// line numbers), SEARCH/REPLACE blocks, V4A patches and text-editor tool
// calls as JSON — finds the lines an edit names even when the model drifted
// their whitespace or indentation, and changes every file or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// --- SPEC.md section 3: a file's lines, its line break, its final break ---

interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0];
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

// --- SPEC.md section 5: matching lines at three tiers ---

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trimEndWs(line);
  return trimWs(line);
}

function occurrencesAt(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < oldLines.length; k++) {
      if (normLine(lines[i + k], tier) !== normLine(oldLines[k], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], oldLines: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier++) {
    const pos = occurrencesAt(lines, oldLines, tier, from);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

// One body line of a hunk or a chunk: ' ' context, '-' old, '+' new, '\' a
// backslash line (as in `\ No newline at end of file`).
type HunkItem = { kind: ' ' | '-' | '+' | '\\'; text: string };

function countNew(items: HunkItem[]): number {
  return items.filter((x) => x.kind === ' ' || x.kind === '+').length;
}

function lastCtxOrPlus(items: HunkItem[]): number {
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k].kind === ' ' || items[k].kind === '+') return k;
  }
  return -1;
}

// True when a `\` line directly follows the body's last context or `+` line.
function noNewlineAfter(items: HunkItem[]): boolean {
  const k = lastCtxOrPlus(items);
  if (k < 0) return false;
  return items[k + 1] !== undefined && items[k + 1].kind === '\\';
}

// Replace the O lines at `at` (context and `-` lines) with the N lines
// (context and `+` lines), at the tier O was found at. A context line is
// written as the file's own matched line, never the patch's; at tier 2 every
// other line of N is re-indented from O's first line to the file's.
function applyItems(state: FileState, at: number, items: HunkItem[], tier: number): void {
  const O = items.filter((x) => x.kind === ' ' || x.kind === '-').map((x) => x.text);
  const F = leadingWs(state.lines[at] ?? '');
  const P = O.length > 0 ? leadingWs(O[0]) : '';
  const repl: string[] = [];
  let o = 0;
  for (const it of items) {
    if (it.kind === '-') {
      o++;
      continue;
    }
    if (it.kind === '\\') continue;
    if (it.kind === ' ') {
      repl.push(state.lines[at + o]);
      o++;
      continue;
    }
    const line = it.text;
    if (tier === 2 && line.trim() !== '' && line.startsWith(P)) repl.push(F + line.slice(P.length));
    else repl.push(line);
  }
  state.lines.splice(at, O.length, ...repl);
}

// Apply one section's hunks in order to a file's lines, each to the result
// of the ones before it (SPEC.md section 6, "Applying hunks").
function applyHunks(state: FileState, hunks: { a: number; items: HunkItem[] }[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const O = h.items.filter((x) => x.kind === ' ' || x.kind === '-').map((x) => x.text);
    if (O.length === 0) {
      const N = h.items.filter((x) => x.kind === '+').map((x) => x.text);
      const at = Math.max(0, Math.min(h.a + d, state.lines.length));
      const atEnd = at === state.lines.length;
      state.lines.splice(at, 0, ...N);
      if (atEnd) state.final = !noNewlineAfter(h.items);
      d += N.length;
      continue;
    }
    const found = findTier(state.lines, O, strict, 0);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const at = best;
    const runsToEnd = at + O.length === state.lines.length;
    applyItems(state, at, h.items, found.tier);
    if (runsToEnd) state.final = !noNewlineAfter(h.items);
    d += countNew(h.items) - O.length;
  }
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- SPEC.md section 6: unified diffs ---

interface UHunk {
  a: number;
  items: HunkItem[];
}

interface USection {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

// The path after `--- ` or `+++ `: the text after the four characters, up to
// the first tab, with surrounding spaces removed; a leading `a/` or `b/` is
// removed from either.
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0].trim();
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

// The file a section's hunks create: its `+` lines in order, with LF breaks,
// ending with a line break unless a `\` line follows its last `+` line.
function creationContent(hunks: UHunk[]): string {
  const plus: string[] = [];
  for (const h of hunks) for (const it of h.items) if (it.kind === '+') plus.push(it.text);
  if (plus.length === 0) return '';
  let noNl = false;
  outer: for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const items = hunks[hi].items;
    for (let k = items.length - 1; k >= 0; k--) {
      if (items[k].kind === '+') {
        noNl = items[k + 1] !== undefined && items[k + 1].kind === '\\';
        break outer;
      }
    }
  }
  return plus.join('\n') + (noNl ? '' : '\n');
}

function makeUnifiedEdit(s: USection, strict: boolean): Edit {
  const oldRaw = s.pairOld ?? s.renameOld ?? s.diffOld ?? '';
  const newRaw = s.pairNew ?? s.renameNew ?? s.diffNew ?? '';
  const isCreate = oldRaw === '/dev/null' || s.isCreate;
  const isDelete = newRaw === '/dev/null' || s.isDelete;
  return (tree) => {
    if (isCreate) {
      const p = newRaw;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, creationContent(s.hunks));
      return;
    }
    if (isDelete) {
      const p = oldRaw;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldRaw !== newRaw) {
      if (!safe(oldRaw)) throw new Fail('unsafe', oldRaw);
      if (!safe(newRaw)) throw new Fail('unsafe', newRaw);
      const before = tree.get(oldRaw);
      if (before === null) throw new Fail('missing', oldRaw);
      if (tree.get(newRaw) !== null) throw new Fail('exists', newRaw);
      const state = splitFile(before);
      applyHunks(state, s.hunks, strict, oldRaw);
      tree.now.set(oldRaw, null);
      tree.now.set(newRaw, joinFile(state));
      tree.moves.push([oldRaw, newRaw]);
      return;
    }
    const p = oldRaw;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const state = splitFile(before);
    applyHunks(state, s.hunks, strict, p);
    tree.now.set(p, joinFile(state));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const n = lines.length;
  let i = 0;
  let sec: (USection & { hasPair: boolean }) | null = null;
  const pushSec = (): void => {
    if (sec) {
      sections.push(sec);
      sec = null;
    }
  };
  const newSec = (): USection & { hasPair: boolean } => ({
    pairOld: null,
    pairNew: null,
    renameOld: null,
    renameNew: null,
    diffOld: null,
    diffNew: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
    hasPair: false,
  });
  while (i < n) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(.+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      pushSec();
      sec = newSec();
      sec.diffOld = m[1];
      sec.diffNew = m[2].replace(/[ \t]+$/, '');
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!sec || sec.hunks.length > 0) {
        pushSec();
        sec = newSec();
      }
      if (!sec.hasPair) {
        sec.pairOld = headerPath(l);
        sec.pairNew = headerPath(lines[i + 1]);
        sec.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (sec && sec.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (!sec) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1], 10);
      i++;
      const items: HunkItem[] = [];
      while (i < n) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          items.push({ kind: ' ', text: '' });
          i++;
        } else if (b[0] === ' ') {
          items.push({ kind: ' ', text: b.slice(1) });
          i++;
        } else if (b[0] === '-') {
          items.push({ kind: '-', text: b.slice(1) });
          i++;
        } else if (b[0] === '+') {
          items.push({ kind: '+', text: b.slice(1) });
          i++;
        } else if (b[0] === '\\') {
          items.push({ kind: '\\', text: b.slice(1) });
          i++;
        } else break;
      }
      while (items.length > 0 && items[items.length - 1].kind === ' ' && items[items.length - 1].text === '') items.pop();
      sec.hunks.push({ a, items });
      continue;
    }
    if (sec && sec.hunks.length === 0) {
      if (l.startsWith('rename from ')) {
        sec.renameOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renameNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.isCreate = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.isDelete = true;
        i++;
        continue;
      }
    }
    i++;
  }
  pushSec();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => makeUnifiedEdit(s, strict));
}

// --- SPEC.md section 7: SEARCH/REPLACE blocks ---

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const state = splitFile(before);
    const found = findTier(state.lines, oldLines, strict, 0);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const items: HunkItem[] = [
      ...oldLines.map((t): HunkItem => ({ kind: '-', text: t })),
      ...newLines.map((t): HunkItem => ({ kind: '+', text: t })),
    ];
    applyItems(state, found.pos[0], items, found.tier);
    tree.now.set(path, joinFile(state));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > prevReplaceEnd; j--) {
        const t = lines[j].trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let sep = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === '=======') {
          sep = j;
          break;
        }
        if (lines[j].trimEnd() === '>>>>>>> REPLACE') break;
      }
      if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = sep + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
      const oldLines = lines.slice(i + 1, sep);
      const newLines = lines.slice(sep + 1, rep);
      edits.push(makeSREdit(path, oldLines, newLines, strict));
      prevPath = path;
      prevReplaceEnd = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// --- SPEC.md section 8: V4A patches ---

interface VChunk {
  anchor: string | null;
  items: HunkItem[];
  eof: boolean;
}

function makeV4AAdd(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeV4ADelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function makeV4AUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const state = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = findTier(state.lines, [ch.anchor], strict, cursor);
        if (!found) throw new Fail('no-match', path);
        cursor = found.pos[0] + 1;
      }
      const O = ch.items.filter((x) => x.kind === ' ' || x.kind === '-').map((x) => x.text);
      if (O.length === 0) {
        const N = ch.items.filter((x) => x.kind === '+').map((x) => x.text);
        const at = ch.eof ? state.lines.length : cursor;
        state.lines.splice(at, 0, ...N);
        cursor = at + N.length;
        continue;
      }
      const found = findTier(state.lines, O, strict, cursor);
      if (!found) throw new Fail('no-match', path);
      const pos = ch.eof ? found.pos.filter((p) => p + O.length === state.lines.length) : found.pos;
      if (pos.length === 0) throw new Fail('no-match', path);
      const at = pos[0];
      applyItems(state, at, ch.items, found.tier);
      cursor = at + countNew(ch.items);
    }
    const out = joinFile(state);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const isAdd = l.startsWith('*** Add File: ');
      const isDel = l.startsWith('*** Delete File: ');
      const prefix = isAdd ? '*** Add File: ' : isDel ? '*** Delete File: ' : '*** Update File: ';
      const path = l.slice(prefix.length).trim();
      const sectionLine = i + 1;
      i++;
      const raw: { text: string; num: number }[] = [];
      while (i < last && !isSectionStart(lines[i])) {
        raw.push({ text: lines[i], num: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1].text)) raw.pop();
      if (isAdd) {
        const fileLines: string[] = [];
        for (const r of raw) {
          if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
          else if (r.text === '') fileLines.push('');
          else throw new Exit2(`error: parse ${r.num}`);
        }
        edits.push(makeV4AAdd(path, fileLines));
        continue;
      }
      if (isDel) {
        if (raw.length > 0) throw new Exit2(`error: parse ${raw[0].num}`);
        edits.push(makeV4ADelete(path));
        continue;
      }
      let moveTo: string | null = null;
      let k = 0;
      if (k < raw.length && raw[k].text.startsWith('*** Move to: ')) {
        moveTo = raw[k].text.slice('*** Move to: '.length).trim();
        k++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      while (k < raw.length) {
        const r = raw[k];
        if (r.text.startsWith('@@')) {
          cur = { anchor: r.text.slice(2).trim(), items: [], eof: false };
          chunks.push(cur);
          k++;
          continue;
        }
        if (r.text === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${r.num}`);
          cur.eof = true;
          cur = null;
          k++;
          continue;
        }
        if (r.text === '' || r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') {
          if (!cur) {
            if (chunks.length === 0) {
              cur = { anchor: null, items: [], eof: false };
              chunks.push(cur);
            } else {
              throw new Exit2(`error: parse ${r.num}`);
            }
          }
          cur.items.push({
            kind: r.text === '' ? ' ' : (r.text[0] as ' ' | '-' | '+'),
            text: r.text === '' ? '' : r.text.slice(1),
          });
          k++;
          continue;
        }
        throw new Exit2(`error: parse ${r.num}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
      edits.push(makeV4AUpdate(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [old, nw] of tree.moves) {
    if (tree.original(old) !== null && tree.original(nw) === null && tree.get(old) === null && tree.get(nw) !== null) {
      rows.push({ key: nw, line: `R ${old} -> ${nw}` });
      movedOld.add(old);
      movedNew.add(nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
