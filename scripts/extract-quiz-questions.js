// scripts/extract-quiz-questions.js
//
// ONE-TIME dev tool — extracts translatable strings from quiz/index.html's
// embedded JS data (the QS question-bank array, the MILESTONES object, and
// a small set of hardcoded UI strings used by the quiz engine's render
// functions). These are pure JS literals, not HTML, so extract-strings.js
// (cheerio-based) can't handle them — this parses the exact array/object
// literal text and safely evaluates it via `new Function`, which executes
// no code beyond constructing literal data (strings/numbers/arrays/
// objects), no side effects.
//
// Produces translations/quiz-questions/en.json in the SAME flat
// key -> string format used everywhere else, so the existing
// translate-dictionary.js pipeline works unmodified. Categories and the
// repeated Likert 5-point scale are deduplicated to unique keys (translated
// once, reused by every question that shares that exact English text) —
// same reasoning as reusing "How it Works" across nav/mobile-nav/heading.

const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "..", "quiz", "index.html");
const html = fs.readFileSync(SRC, "utf8");

function extractLiteral(varName) {
  const startMarker = `var ${varName}=`;
  const start = html.indexOf(startMarker);
  if (start === -1) throw new Error(`Could not find "${startMarker}" in quiz/index.html`);
  const exprStart = start + startMarker.length;
  // Find the matching closing bracket/brace by counting depth, respecting
  // single-quoted string literals (the only quote style used in this file)
  // so a "]" or "}" inside a string doesn't end the scan early.
  const openChar = html[exprStart];
  const closeChar = openChar === "[" ? "]" : "}";
  let depth = 0;
  let stringQuote = null; // null, or the quote char (' or ") currently open
  let i = exprStart;
  for (; i < html.length; i++) {
    const c = html[i];
    if (stringQuote) {
      if (c === "\\") { i++; continue; } // skip escaped char
      if (c === stringQuote) stringQuote = null;
      continue;
    }
    if (c === "'" || c === '"') { stringQuote = c; continue; }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const literalText = html.slice(exprStart, i);
  return new Function(`return (${literalText});`)();
}

const QS = extractLiteral("QS");
const MILESTONES = extractLiteral("MILESTONES");

const strings = {};
const htmlKeys = []; // milestone headline/body contain <span> markup

// 1. Categories — deduplicated. Slug = lowercase, spaces -> underscores.
const seenCats = new Map(); // englishText -> slug
function catSlug(cat) {
  if (seenCats.has(cat)) return seenCats.get(cat);
  const slug = cat.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  seenCats.set(cat, slug);
  strings[`cat.${slug}`] = cat;
  return slug;
}

// 2. Likert scale — the 5-option array is byte-identical across all 3
// likert questions in the current question bank; dedupe by serialized
// value so it's only translated once. Falls back to per-question keys if a
// future edit ever makes the arrays diverge (safe either way).
const likertOptsSeen = new Map(); // JSON.stringify(opts) -> key prefix used

QS.forEach((entry, i) => {
  if (entry.q) {
    strings[`q${i}.q`] = entry.q;
  }
  if (entry.opts) {
    if (entry.type === "likert") {
      const sig = JSON.stringify(entry.opts);
      if (!likertOptsSeen.has(sig)) {
        const prefix = `common.likert_opts`;
        entry.opts.forEach((opt, j) => { strings[`${prefix}.${j}`] = opt; });
        likertOptsSeen.set(sig, prefix);
      }
      // No per-question key needed — quiz.html will look up common.likert_opts directly.
    } else {
      entry.opts.forEach((opt, j) => { strings[`q${i}.opts.${j}`] = opt; });
    }
  }
  if (entry.cat) catSlug(entry.cat);
});

// 3. Milestones (headline contains a <span>, body sometimes does too)
Object.entries(MILESTONES).forEach(([n, m]) => {
  strings[`milestone.${n}.headline`] = m.headline;
  htmlKeys.push(`milestone.${n}.headline`);
  strings[`milestone.${n}.body`] = m.body;
  htmlKeys.push(`milestone.${n}.body`);
});

// 4. Misc UI strings hardcoded in the render/game logic (verified present
// via grep against the current file — if this script ever errors below
// because one of these isn't found verbatim, the source text changed and
// this list needs updating, not silently skipped).
const MISC_UI = {
  "ui.get_results": "Get My Results",
  "ui.confirm_note": "Do you want to confirm your answers? You will not be able to edit them after validation.",
  "ui.find_the_ball": "Find the Ball",
  "ui.cup_prompt": "Which cup has the ball? Tap one!",
  "ui.cup_press_start": "Press START, then watch closely…",
  "ui.fold_shape_prompt": "Which shape results after folding along the dotted lines?",
  "ui.choose_answer_prompt": "Choose your answer:",
};
for (const [key, text] of Object.entries(MISC_UI)) {
  if (!html.includes(`'${text.replace(/'/g, "\\'")}'`) && !html.includes(text)) {
    console.error(`  WARNING: could not verify "${text}" (key ${key}) still appears verbatim in quiz/index.html — source may have changed.`);
  }
  strings[key] = text;
}

const outDir = path.resolve(__dirname, "..", "translations", "quiz-questions");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "en.json"), JSON.stringify(strings, null, 2) + "\n");
fs.writeFileSync(path.join(outDir, "en.meta.json"), JSON.stringify({ htmlKeys }, null, 2) + "\n");

console.log(`Extracted ${Object.keys(strings).length} strings from quiz/index.html's embedded JS data.`);
console.log(`  ${seenCats.size} unique categories, ${QS.length} question-bank entries scanned, ${Object.keys(MILESTONES).length} milestones, ${Object.keys(MISC_UI).length} misc UI strings.`);
console.log(`Wrote translations/quiz-questions/en.json and en.meta.json`);
