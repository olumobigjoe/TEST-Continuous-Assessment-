#!/usr/bin/env node
/**
 * Replaces user-facing "Examination" wording with "TEST" across a codebase.
 *
 *   node scripts/rename-terminology.mjs <dir>            # dry run: prints every change
 *   node scripts/rename-terminology.mjs <dir> --apply    # writes the changes
 *   options: --include-exam   also convert "Exam"/"Exams" (off by default)
 *            --report out.csv write a CSV of every change
 *
 * Only USER-FACING text is changed; identifiers, routes, DB columns and object keys stay as they are:
 *  - code (.js .jsx .ts .tsx .py .php .rb .java .cs .dart): only inside string literals and JSX text,
 *    and never in strings that look machine-readable (no spaces, e.g. "examination_id", "/api/examinations")
 *  - JSON: only values, never keys
 *  - markup / templates / text (.html .vue .svelte .hbs .ejs .pug .twig .md .txt .mjml .blade.php): text and
 *    attribute values like title/placeholder/alt/aria-label, but not inside URLs or class/id/name attributes
 * Always review the dry run and your diff before committing.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--'));
const APPLY = args.includes('--apply');
const INCLUDE_EXAM = args.includes('--include-exam');
const reportIdx = args.indexOf('--report');
const REPORT = reportIdx >= 0 ? args[reportIdx + 1] : null;
if (!root) { console.error('Usage: node rename-terminology.mjs <dir> [--apply] [--include-exam] [--report out.csv]'); process.exit(1); }

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', 'coverage', '__pycache__', 'migrations', '.venv', 'venv']);
const CODE = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.php', '.rb', '.java', '.cs', '.dart', '.kt', '.go']);
const MARKUP = new Set(['.html', '.htm', '.vue', '.svelte', '.hbs', '.handlebars', '.ejs', '.pug', '.twig', '.md', '.txt', '.mjml', '.njk', '.liquid', '.jinja', '.j2', '.erb']);
const JSON_EXT = new Set(['.json']);

// Ordered: plurals and phrases first. Output is always upper-case TEST / TESTS.
const RULES = [
  [/\bEXAMINATIONS\b/g, 'TESTS'], [/\bExaminations\b/g, 'TESTS'], [/\bexaminations\b/g, 'TESTS'],
  [/\bEXAMINATION\b/g, 'TEST'], [/\bExamination\b/g, 'TEST'], [/\bexamination\b/g, 'TEST'],
];
if (INCLUDE_EXAM) RULES.push(
  [/\bEXAMS\b/g, 'TESTS'], [/\bExams\b/g, 'TESTS'], [/\bexams\b/g, 'TESTS'],
  [/\bEXAM\b/g, 'TEST'], [/\bExam\b/g, 'TEST'], [/\bexam\b/g, 'TEST'],
);
const ANY = new RegExp(RULES.map(([r]) => r.source).join('|'));

const machineLike = (s) => !/\s/.test(s) && /^[\w.\/:\-?=&#%{}$]*$/.test(s) && !/^[A-Z]/.test(s);
const replaceText = (s) => RULES.reduce((acc, [r, to]) => acc.replace(r, to), s);

/** Replace within string literals (and optionally JSX text) of one code file. */
function transformCode(src, { jsx, jsonValuesOnly }) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], c2 = src.slice(i, i + 2);
    if (!jsonValuesOnly && (c2 === '//' || (c === '#' && /\.py$/.test(currentFile)))) { // line comment: keep
      const j = src.indexOf('\n', i); const end = j < 0 ? n : j; out += src.slice(i, end); i = end; continue;
    }
    if (!jsonValuesOnly && c2 === '/*') { const j = src.indexOf('*/', i + 2); const end = j < 0 ? n : j + 2; out += src.slice(i, end); i = end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; if (c !== '`' && src[j] === '\n') break; j++; }
      const body = src.slice(i + 1, j);
      let isKey = false;
      if (jsonValuesOnly) { let k = j + 1; while (k < n && /\s/.test(src[k])) k++; isKey = src[k] === ':'; }
      const keep = isKey || machineLike(body);
      const replaced = c === '`'
        ? body.split(/(\$\{[^}]*\})/).map((part, k) => (k % 2 ? part : replaceText(part))).join('')
        : replaceText(body);
      out += c + (keep ? body : replaced) + (j < n ? c : '');
      i = j + 1; continue;
    }
    if (jsx && (c === '>' || c === '}')) {
      // JSX text: from '>' to next '<' or '{', only if it contains letters and no code-ish chars
      let j = i + 1;
      while (j < n && src[j] !== '<' && src[j] !== '{' && src[j] !== '}' && src[j] !== ';' && src[j] !== '(' && src[j] !== ')' && src[j] !== '=') j++;
      const seg = src.slice(i + 1, j);
      const ok = c === '>' ? (src[j] === '<' || src[j] === '{') : src[j] === '<'; // after '}', only text that runs into a tag
      out += c + (ok && /[A-Za-z]/.test(seg) ? replaceText(seg) : seg);
      i = j; continue;
    }
    out += c; i++;
  }
  return out;
}

/** Markup: replace in text nodes and in human-readable attributes; protect URLs and technical attributes. */
function transformMarkup(src) {
  const protectedAttr = /\b(href|src|action|class|className|id|name|for|v-model|v-if|v-for|:[\w-]+|@[\w-]+|data-[\w-]+|key|ref|to|type|method)\s*=\s*("[^"]*"|'[^']*')/g;
  const holes = [];
  let s = src.replace(protectedAttr, (m) => { holes.push(m); return `\u0000${holes.length - 1}\u0000`; });
  // template expressions {{ ... }}, <% %>, {% %}, <?php ?> are code: protect identifiers inside them
  s = s.replace(/(\{\{[\s\S]*?\}\}|<%[\s\S]*?%>|\{%[\s\S]*?%\}|<\?php[\s\S]*?\?>|<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>)/g, (m) => {
    holes.push(m.startsWith('<script') ? m.replace(/(<script[^>]*>)([\s\S]*?)(<\/script>)/, (_, a, b, c) => a + transformCode(b, { jsx: false }) + c) : transformCode(m, { jsx: false }));
    return `\u0000${holes.length - 1}\u0000`;
  });
  s = s.replace(/https?:\/\/\S+/g, (m) => { holes.push(m); return `\u0000${holes.length - 1}\u0000`; });
  s = replaceText(s);
  return s.replace(/\u0000(\d+)\u0000/g, (_, k) => holes[Number(k)]);
}

let currentFile = '';
const changes = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
    const ext = e.name.endsWith('.blade.php') ? '.html' : path.extname(e.name).toLowerCase();
    if (!CODE.has(ext) && !MARKUP.has(ext) && !JSON_EXT.has(ext)) continue;
    if (/package(-lock)?\.json$|tsconfig.*\.json$|\.min\./.test(e.name)) continue;
    const src = fs.readFileSync(p, 'utf8');
    if (!ANY.test(src) && !ANY.test(src.toLowerCase())) continue;
    currentFile = p;
    const out = MARKUP.has(ext) ? transformMarkup(src)
      : JSON_EXT.has(ext) ? transformCode(src, { jsx: false, jsonValuesOnly: true })
      : transformCode(src, { jsx: /\.(jsx|tsx|js)$/.test(ext) });
    if (out === src) continue;
    const a = src.split('\n'), b = out.split('\n');
    a.forEach((line, k) => { if (line !== b[k]) changes.push({ file: path.relative(root, p), line: k + 1, before: line.trim(), after: (b[k] ?? '').trim() }); });
    if (APPLY) fs.writeFileSync(p, out);
  }
}

walk(path.resolve(root));
for (const c of changes) console.log(`${c.file}:${c.line}\n  - ${c.before}\n  + ${c.after}`);
const files = new Set(changes.map((c) => c.file)).size;
console.log(`\n${changes.length} line(s) in ${files} file(s) ${APPLY ? 'updated' : 'would change (dry run — add --apply to write)'}.`);
console.log('Not changed on purpose: identifiers, routes, DB names, object keys, URLs and class names. Search for any remaining "exam" text by hand.');
if (REPORT) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  fs.writeFileSync(REPORT, 'file,line,before,after\n' + changes.map((c) => [c.file, c.line, c.before, c.after].map(q).join(',')).join('\n'));
  console.log(`Report written to ${REPORT}`);
}
