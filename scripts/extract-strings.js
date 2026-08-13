// scripts/extract-strings.js
//
// ONE-TIME dev tool — not part of the deployed website, never called at
// runtime. Scans a page for every element carrying a data-i18n-key
// attribute and produces translations/en.json, the English source
// dictionary that later steps translate into other languages.
//
// Extraction rule: an element marked data-i18n-html="true" is captured via
// its innerHTML (it legitimately contains nested markup, e.g. inline links
// woven through a sentence); every other tagged element is captured via
// its plain text content. This same rule is mirrored in the Step 3 render
// function when restoring translated values, so a key's "shape" (plain
// text vs. small HTML fragment) is consistent end to end.
//
// Usage: node scripts/extract-strings.js <path-to-html-file>

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const targetFile = process.argv[2];
if (!targetFile) {
  console.error("Usage: node scripts/extract-strings.js <path-to-html-file>");
  process.exit(1);
}

const absPath = path.resolve(targetFile);
if (!fs.existsSync(absPath)) {
  console.error("File not found:", absPath);
  process.exit(1);
}

const html = fs.readFileSync(absPath, "utf8");
const $ = cheerio.load(html, { decodeEntities: false });

const strings = {};
const htmlKeys = []; // keys whose value is an HTML fragment, not plain text
const seenKeys = new Set();
let duplicateKeys = [];

$("[data-i18n-key]").each((_, el) => {
  const $el = $(el);
  const key = $el.attr("data-i18n-key");

  if (seenKeys.has(key)) {
    duplicateKeys.push(key);
  }
  seenKeys.add(key);

  const isHtml = $el.attr("data-i18n-html") === "true";
  const value = isHtml ? $el.html().trim() : $el.text().trim();

  strings[key] = value;
  if (isHtml) htmlKeys.push(key);
});

if (duplicateKeys.length > 0) {
  console.error("ERROR: duplicate data-i18n-key values found (must be unique):");
  duplicateKeys.forEach((k) => console.error("  -", k));
  process.exit(1);
}

const outDir = path.resolve(__dirname, "..", "translations");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "en.json");
const metaPath = path.join(outDir, "en.meta.json");

fs.writeFileSync(outPath, JSON.stringify(strings, null, 2) + "\n");
// Separate metadata file recording which keys are HTML fragments (contain
// nested tags, e.g. inline links) vs. plain text — later translation and
// rendering steps need this to know whether to translate the whole value
// as markup-aware text-node-only translation, or as a plain string.
fs.writeFileSync(metaPath, JSON.stringify({ htmlKeys }, null, 2) + "\n");

console.log(`Extracted ${Object.keys(strings).length} strings from ${path.basename(absPath)}`);
console.log(`Wrote ${outPath}`);
console.log(`Wrote ${metaPath} (${htmlKeys.length} HTML-fragment key(s): ${htmlKeys.join(", ") || "none"})`);
console.log("\nKeys found:");
Object.keys(strings).forEach((k) => console.log("  -", k));
