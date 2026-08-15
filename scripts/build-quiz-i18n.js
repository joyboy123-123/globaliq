// scripts/build-quiz-i18n.js
//
// ONE-TIME dev tool, run after scripts/translate-dictionary.js --page=quiz-questions
// has produced translations/quiz-questions/{lang}.json (flat key->string
// dicts, same shape as every other page). Reassembles each language's flat
// dict into the STRUCTURED shape the quiz engine actually consumes at
// runtime (window.QS_I18N — see quiz/index.html's i18nQ() helper and
// api/render-page.js's quiz-specific injection step).
//
// Structured shape:
// {
//   categories: { "<English category text>": "<translated>", ... },
//   likert_opts: ["<t1>", ..., "<t5>"],
//   questions: { "<QS array index>": { q: "<translated>", opts: [...] }, ... },
//   milestones: { "<n>": { headline: "<translated>", body: "<translated>" }, ... },
//   ui: { get_results: "<translated>", ... }
// }
//
// Usage: node scripts/build-quiz-i18n.js [--langs=fr,ar,zh]

const fs = require("fs");
const path = require("path");

const SRC_DIR = path.resolve(__dirname, "..", "translations", "quiz-questions");
const OUT_DIR = path.resolve(__dirname, "..", "translations", "quiz-i18n");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const enDict = JSON.parse(fs.readFileSync(path.join(SRC_DIR, "en.json"), "utf8"));

const langsArg = process.argv.find((a) => a.startsWith("--langs="));
const requestedCodes = langsArg ? langsArg.replace("--langs=", "").split(",") : null;

const allFiles = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".json") && f !== "en.json" && f !== "en.meta.json");
const files = requestedCodes ? allFiles.filter((f) => requestedCodes.includes(f.replace(/\.json$/, ""))) : allFiles;

if (files.length === 0) {
  console.error("No matching translation files found in translations/quiz-questions/");
  process.exit(1);
}

for (const file of files) {
  const lang = file.replace(/\.json$/, "");
  const dict = JSON.parse(fs.readFileSync(path.join(SRC_DIR, file), "utf8"));

  const structured = { categories: {}, likert_opts: [], questions: {}, milestones: {}, ui: {} };

  for (const [key, enValue] of Object.entries(enDict)) {
    const translated = dict[key];
    if (translated === undefined) {
      console.error(`  MISSING key "${key}" in ${file} — skipping (fallback to English at runtime)`);
      continue;
    }

    if (key.startsWith("cat.")) {
      // categories are looked up at runtime BY THE ENGLISH TEXT (q.cat is
      // always the original English string, since per-question overrides
      // never include a "cat" field) — so the structured map keys on
      // enValue, not the slug.
      structured.categories[enValue] = translated;
    } else if (key.startsWith("common.likert_opts.")) {
      const idx = parseInt(key.split(".").pop(), 10);
      structured.likert_opts[idx] = translated;
    } else if (key.startsWith("milestone.")) {
      const [, n, field] = key.split(".");
      if (!structured.milestones[n]) structured.milestones[n] = {};
      structured.milestones[n][field] = translated;
    } else if (key.startsWith("ui.")) {
      structured.ui[key.slice(3)] = translated;
    } else {
      // q{i}.q or q{i}.opts.{j}
      const m = key.match(/^q(\d+)\.(q|opts)(?:\.(\d+))?$/);
      if (!m) {
        console.error(`  UNRECOGNIZED key pattern "${key}" — skipping`);
        continue;
      }
      const [, idx, field, optIdx] = m;
      if (!structured.questions[idx]) structured.questions[idx] = {};
      if (field === "q") {
        structured.questions[idx].q = translated;
      } else {
        if (!structured.questions[idx].opts) structured.questions[idx].opts = [];
        structured.questions[idx].opts[parseInt(optIdx, 10)] = translated;
      }
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, `${lang}.json`), JSON.stringify(structured) + "\n");
  console.log(`Built translations/quiz-i18n/${lang}.json`);
}
