// scripts/translate-dictionary.js
//
// ONE-TIME dev tool — not part of the deployed website, never called at
// runtime, not a Vercel serverless function. Runs locally only. Reads
// translations/en.json and translates every string into all 38 target
// languages using @huggingface/transformers running the NLLB-200 model
// entirely offline (no API key, no per-request cost, ever).
//
// Language code mapping — verified against the official FLORES-200 table
// (https://github.com/facebookresearch/flores/blob/main/flores200/README.md),
// not guessed. Region-variant codes (pt-BR, es-MX, da-DK, et-EE, ga-IE,
// fa-IR, uk-UA, mt-MT) share the same FLORES-200 target as their base
// language, since FLORES-200 doesn't model that regional distinction —
// they intentionally produce identical translated text to their base code.
//
// Two deliberate resolutions worth noting:
//   - "no" (Norwegian) maps to Bokmål (nob_Latn), the majority written
//     standard, not Nynorsk (nno_Latn) — FLORES-200 has no single generic
//     "Norwegian" code, a choice had to be made.
//   - "ku" (Kurdish) maps to Northern Kurdish / Kurmanji (kmr_Latn, Latin
//     script, left-to-right) rather than Central Kurdish / Sorani
//     (ckb_Arab, Arabic script, right-to-left) — FLORES-200 models these
//     as two distinct languages, not one. This resolves the RTL ambiguity
//     flagged earlier in the project: "ku" is NOT treated as RTL.

const LANGUAGE_MAP = {
  "fr": "fra_Latn",
  "de": "deu_Latn",
  "no": "nob_Latn",
  "es": "spa_Latn",
  "pt": "por_Latn",
  "pl": "pol_Latn",
  "da-DK": "dan_Latn",
  "cs": "ces_Latn",
  "it": "ita_Latn",
  "ro": "ron_Latn",
  "sv": "swe_Latn",
  "el": "ell_Grek",
  "lv": "lvs_Latn",
  "sl": "slv_Latn",
  "hu": "hun_Latn",
  "hr": "hrv_Latn",
  "fi": "fin_Latn",
  "et-EE": "est_Latn",
  "sk": "slk_Latn",
  "lt": "lit_Latn",
  "nl": "nld_Latn",
  "pt-BR": "por_Latn",
  "bg": "bul_Cyrl",
  "mt-MT": "mlt_Latn",
  "es-MX": "spa_Latn",
  "ga-IE": "gle_Latn",
  "tr": "tur_Latn",
  "ar": "arb_Arab",
  "fa-IR": "pes_Arab",
  "ku": "kmr_Latn",
  "ru": "rus_Cyrl",
  "ko": "kor_Hang",
  "zh": "zho_Hans",
  "th": "tha_Thai",
  "ja": "jpn_Jpan",
  "uk-UA": "ukr_Cyrl",
  "he": "heb_Hebr",
  "is": "isl_Latn",
};

const SOURCE_LANG = "eng_Latn";
const MODEL_NAME = "Xenova/nllb-200-distilled-600M";

// Translates an HTML fragment (e.g. disclaimer.text, which has 3 inline
// links woven through one sentence) while leaving every tag, attribute,
// and href completely untouched.
//
// History of two failed approaches, kept here so the reasoning isn't lost:
//  1. Node-by-node translation (translate each text node in total isolation)
//     — produced real, reproducible corruption specifically on very SHORT
//     fragments: French hallucinated an entire extra sentence with no
//     source ("- Je suis désolé.") when translating just the word "here";
//     Chinese degenerated into a repeated-word loop ("咨询咨询咨询,...")
//     translating just "Questions?" alone. Longer segments (full
//     sentences) translated correctly with this approach.
//  2. Placeholder-token substitution (replace each <a> with a token like
//     "XPLACEHOLDERX2X", translate the whole paragraph as one string, swap
//     tokens back) — intended to fix #1 by giving the model full sentence
//     context. Instead, the unusual token format itself broke generation:
//     the model's output was silently truncated right before reaching the
//     token, byte-for-byte identical even after raising max_new_tokens to
//     512, proving it wasn't a length-limit issue but the token confusing
//     the model outright.
//
// Current approach: back to per-node translation (proven correct for
// longer segments), but any text node under SHORT_NODE_THRESHOLD
// characters is left UNTRANSLATED in English and logged as needing manual
// review, instead of risking another silent hallucination.
//
// Threshold tuning, from actual test data, not a guess: 20 chars was
// initially too aggressive — it also skipped "Terms & Conditions" (19
// chars) and "Privacy Notice" (14 chars), both of which translated
// CORRECTLY in the very first test run, before this skip logic existed.
// The only fragments that actually produced bad output (a hallucinated
// extra sentence in French, a repeated-word loop in Chinese) were "here"
// (4 chars) and "Questions?" (10 chars). 12 catches both of those while
// letting the longer, already-proven-safe phrases translate normally.
const SHORT_NODE_THRESHOLD = 12;

// General safety net, found necessary after the length-threshold approach
// alone still let a real failure through: ". Questions? Contact support "
// (29 chars, well above the threshold, translated fine in French and
// Arabic) degenerated into a repeated-character loop specifically in
// Chinese: "咨询咨询咨询,咨询咨询,咨询,咨询,咨询,咨询,". This proves
// length isn't a reliable predictor by itself — some language/phrase
// combinations just trigger degenerate generation unpredictably. Rather
// than try to predict every such case in advance, this detects the
// failure PATTERN itself, in the output, regardless of cause. Works on
// CJK text (no whitespace between words) via character-level regex, not
// token splitting.
function hasRepetitionLoop(text) {
  return /(.{2,10})\1{2,}/.test(text);
}

// Second safety net, found necessary after a spot-check of the fr/ar/zh
// smoke test: the source node ". Questions? Contact support " (29 chars)
// translated in French to just "- Des questions? " — no repetition loop,
// no hallucination, just silently DROPPED "Contact support". Neither prior
// check catches this because the output is short, valid-looking text, not
// garbage. Heuristic: if the translated text is implausibly short relative
// to the source (empirically, honest translations of English source rarely
// come in under ~45% of the source char count, even for compact target
// languages like Chinese), treat it as suspect and apply the same
// retry-then-fallback handling as a repetition loop.
// CJK/Thai scripts encode far more meaning per character than Latin/Cyrillic
// text (no spaces, logographic/abugida density), so a flat ratio flags
// CORRECT Chinese/Japanese/Korean/Thai translations as "too short" — proven
// empirically: the first version of this check (0.45 flat) rejected valid
// short Chinese translations of every single key. Use a much looser ratio
// for those scripts, since the real failure mode there (dropped trailing
// clause) still comes in far below even a lenient bar.
const COMPACT_SCRIPTS = ["_Hans", "_Hant", "_Hang", "_Thai", "_Jpan"];
function isSuspiciouslyShort(sourceText, translatedText, floresCode) {
  if (sourceText.length < 20) return false; // heuristic is noisy on short input, skip it there
  const isCompact = COMPACT_SCRIPTS.some((suffix) => floresCode && floresCode.endsWith(suffix));
  const ratio = isCompact ? 0.15 : 0.45;
  return translatedText.length < sourceText.length * ratio;
}

// Third safety net, found necessary after a spot-check of the rebuilt
// fineprint.text fragment: the source lead sentence "Price excludes tax.
// Prices are in USD. GlobalIQ is for educational/entertainment purposes
// only, not a professional evaluation. By continuing, you agree to our "
// (4 sentences) translated to French with TWO full sentences silently
// dropped ("Price excludes tax." and "By continuing, you agree to our"
// both vanished) — yet the surviving output was still long enough to pass
// isSuspiciouslyShort's length ratio, since the other two sentences are
// themselves fairly long. A length ratio alone can't catch "dropped a
// whole clause but padded the rest normally." Counting sentence-ending
// punctuation is a cheap, language-agnostic proxy for "did entire
// sentences go missing": if the source has 2+ sentences and the
// translation has under half as many terminators, treat it as suspect.
function countSentences(text) {
  const matches = text.match(/[.!?。！？؟]+/g);
  return matches ? matches.length : (text.trim() ? 1 : 0);
}
function hasMissingClauses(sourceText, translatedText) {
  const sourceSentences = countSentences(sourceText);
  if (sourceSentences < 2) return false; // heuristic only meaningful on multi-sentence input
  // Deliberately strict (ANY drop, not a ratio): the real failure case this
  // caught was a 3-sentence source losing just 1 sentence (3 -> 2), which a
  // 50%-loss ratio would have missed entirely. A false positive here just
  // costs one retry (and, worst case, a safe English fallback for that key)
  // — cheap insurance against silently dropped content in legal/pricing text.
  return countSentences(translatedText) < sourceSentences;
}

function isDegenerate(sourceText, translatedText, floresCode) {
  return hasRepetitionLoop(translatedText)
    || isSuspiciouslyShort(sourceText, translatedText, floresCode)
    || hasMissingClauses(sourceText, translatedText);
}

// Splits on sentence-ending punctuation followed by whitespace, keeping the
// punctuation with its sentence. Deliberately simple (no abbreviation
// handling) — good enough for the marketing/FAQ copy this runs on, and a
// slightly-wrong split just means slightly different sentence boundaries,
// not corrupted output.
function splitIntoSentences(text) {
  const matches = text.match(/[^.!?]+[.!?]+(\s+|$)/g);
  if (!matches || matches.length < 2) return [text];
  return matches.map((s) => s.trim()).filter(Boolean);
}

// Third-tier fallback for plain (non-HTML) keys, tried after a whole-string
// translation degenerates twice. Long multi-sentence paragraphs (FAQ
// answers, legal copy) fail far more often as one big translation call than
// their individual sentences do — the same "smaller units are more
// reliable" lesson already proven true for HTML-fragment text nodes.
// Translates each sentence independently (one retry each); any sentence
// that still fails falls back to its own English text rather than reverting
// the ENTIRE paragraph to English just because one clause was difficult.
async function translateWithSentenceFallback(sourceText, translateOne, floresCode) {
  const sentences = splitIntoSentences(sourceText);
  if (sentences.length < 2) return null; // nothing to gain by splitting a single sentence

  const translatedParts = [];
  let anySucceeded = false;
  for (const sentence of sentences) {
    let translated = await translateOne(sentence);
    if (isDegenerate(sentence, translated, floresCode)) {
      const retry = await translateOne(sentence);
      translated = isDegenerate(sentence, retry, floresCode) ? null : retry;
    }
    if (translated === null) {
      translatedParts.push(sentence); // this sentence only, in English
    } else {
      translatedParts.push(translated);
      anySucceeded = true;
    }
  }
  // If EVERY sentence individually failed too, there's nothing gained over
  // the plain whole-English fallback the caller already has — let it use
  // that instead of a needlessly reassembled all-English paragraph.
  return anySucceeded ? translatedParts.join(" ") : null;
}

// Small manual override table for the specific short, context-free words
// that recur in this exact disclaimer sentence and are unsafe to run
// through the model in isolation (see history above: "here" caused a
// hallucinated extra sentence in French). Hand-verified per language
// rather than model-generated. Only covers words actually present in the
// current source content — extend if new short fragments are added.
const MANUAL_SHORT_OVERRIDES = {
  nob_Latn: { and: "og", here: "her" },
  fra_Latn: { and: "et", here: "ici" },
  arb_Arab: { and: "و", here: "هنا" },
  zho_Hans: { and: "和", here: "这里" },
  deu_Latn: { and: "und", here: "hier" },
  spa_Latn: { and: "y", here: "aquí" },
  por_Latn: { and: "e", here: "aqui" },
  pol_Latn: { and: "i", here: "tutaj" },
  dan_Latn: { and: "og", here: "her" },
  ces_Latn: { and: "a", here: "zde" },
  ita_Latn: { and: "e", here: "qui" },
  ron_Latn: { and: "și", here: "aici" },
  swe_Latn: { and: "och", here: "här" },
  ell_Grek: { and: "και", here: "εδώ" },
  lvs_Latn: { and: "un", here: "šeit" },
  slv_Latn: { and: "in", here: "tukaj" },
  hun_Latn: { and: "és", here: "itt" },
  hrv_Latn: { and: "i", here: "ovdje" },
  fin_Latn: { and: "ja", here: "täällä" },
  est_Latn: { and: "ja", here: "siin" },
  slk_Latn: { and: "a", here: "tu" },
  lit_Latn: { and: "ir", here: "čia" },
  nld_Latn: { and: "en", here: "hier" },
  bul_Cyrl: { and: "и", here: "тук" },
  mlt_Latn: { and: "u", here: "hawn" },
  gle_Latn: { and: "agus", here: "anseo" },
  tur_Latn: { and: "ve", here: "burada" },
  pes_Arab: { and: "و", here: "اینجا" },
  kmr_Latn: { and: "û", here: "li vir" },
  rus_Cyrl: { and: "и", here: "здесь" },
  kor_Hang: { and: "그리고", here: "여기" },
  tha_Thai: { and: "และ", here: "ที่นี่" },
  jpn_Jpan: { and: "そして", here: "ここ" },
  ukr_Cyrl: { and: "і", here: "тут" },
  heb_Hebr: { and: "ו", here: "כאן" },
  isl_Latn: { and: "og", here: "hér" },
};

async function translateHtmlFragment(html, translateOne, onShortNodeSkipped, floresCode) {
  const $ = cheerio.load(`<div id="__root">${html}</div>`, { decodeEntities: false });
  const root = $("#__root")[0];

  const textNodes = [];
  (function collect(node) {
    for (const child of node.children || []) {
      if (child.type === "text" && child.data && child.data.trim().length > 0) {
        textNodes.push(child);
      } else if (child.children) {
        collect(child);
      }
    }
  })(root);

  for (const node of textNodes) {
    const original = node.data;
    const leadingWs = original.match(/^\s*/)[0];
    const trailingWs = original.match(/\s*$/)[0];
    const trimmed = original.trim();
    if (!trimmed) continue;

    if (trimmed.length < SHORT_NODE_THRESHOLD) {
      // The override table is keyed on the bare word ("and", "here"), but a
      // short node can arrive with punctuation still attached depending on
      // where it sits in the sentence (e.g. ", and" between two <strong>
      // tags) — found via spot-check: ", and" didn't match "and" and fell
      // through to the English-fallback path instead of translating.
      // Strip leading/trailing non-letter characters for the lookup only,
      // then splice the override back between the original punctuation.
      const punctMatch = trimmed.match(/^(\W*)([\s\S]*?)(\W*)$/);
      const [, leadPunct, core, trailPunct] = punctMatch || ["", "", trimmed, ""];
      const override = MANUAL_SHORT_OVERRIDES[floresCode] && MANUAL_SHORT_OVERRIDES[floresCode][core.toLowerCase()];
      if (override) {
        node.data = leadingWs + leadPunct + override + trailPunct + trailingWs;
        continue;
      }
      if (onShortNodeSkipped) onShortNodeSkipped(trimmed);
      continue; // leave node.data (English) untouched
    }

    let translated = await translateOne(trimmed);
    if (hasRepetitionLoop(translated) || isSuspiciouslyShort(trimmed, translated, floresCode) || hasMissingClauses(trimmed, translated)) {
      // One retry — quantized model inference isn't perfectly deterministic
      // run to run, so a second attempt sometimes succeeds cleanly even
      // when the first one degenerated or dropped content.
      const retry = await translateOne(trimmed);
      translated = (hasRepetitionLoop(retry) || isSuspiciouslyShort(trimmed, retry, floresCode) || hasMissingClauses(trimmed, retry)) ? null : retry;
    }
    if (translated === null) {
      // Both attempts degenerated — fall back to leaving this node in
      // English rather than write garbled repeated text, and make sure
      // it's visible in the same "needs manual review" report as the
      // short-node skips, not silently swallowed.
      if (onShortNodeSkipped) onShortNodeSkipped(trimmed + " [repetition-loop fallback]");
      continue;
    }
    node.data = leadingWs + translated + trailingWs;
  }

  return $("#__root").html().trim();
}

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

// Previous runs died with exit code 1 and NO error output at all, even with
// stderr merged into the captured log — that pattern means something is
// bypassing normal JS error handling (an uncaught rejection Node's default
// handler doesn't verbosely print in this context, or similar). These two
// handlers guarantee SOMETHING gets logged before the process ever exits,
// so a real diagnosis is possible instead of guessing again.
process.on("unhandledRejection", (reason) => {
  console.error("\n=== UNHANDLED REJECTION ===");
  console.error(reason && reason.stack ? reason.stack : reason);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("\n=== UNCAUGHT EXCEPTION ===");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

async function main() {
  // --page=<pageId> selects which page's translations/{page}/en.json to
  // translate, matching the per-page directory layout extract-strings.js
  // writes to (translations/{page}/en.json, translations/{page}/{lang}.json).
  // Required now that the site has more than one translated page — a flat
  // shared dictionary would risk key collisions between pages.
  const pageArg = process.argv.find((a) => a.startsWith("--page="));
  const page = pageArg ? pageArg.replace("--page=", "") : null;
  if (!page) {
    console.error("Usage: node scripts/translate-dictionary.js --page=<pageId> [--langs=fr,ar,zh]");
    process.exit(1);
  }
  const pageDir = path.resolve(__dirname, "..", "translations", page);
  const enPath = path.join(pageDir, "en.json");
  const metaPath = path.join(pageDir, "en.meta.json");
  if (!fs.existsSync(enPath)) {
    console.error(`${enPath} not found — run scripts/extract-strings.js first.`);
    process.exit(1);
  }
  const enDict = JSON.parse(fs.readFileSync(enPath, "utf8"));
  const htmlKeys = new Set(
    fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")).htmlKeys : []
  );
  const keys = Object.keys(enDict);
  console.log(`Loaded ${keys.length} source strings for page "${page}" (${htmlKeys.size} are HTML fragments: ${[...htmlKeys].join(", ") || "none"})`);

  console.log(`Loading ${MODEL_NAME} (quantized q8 variant)...`);
  const { pipeline } = await import("@huggingface/transformers");
  const lastLoggedPct = {};
  const translator = await pipeline("translation", MODEL_NAME, {
    dtype: "q8",
    progress_callback: (info) => {
      if (info.status === "progress" && typeof info.progress === "number") {
        const pct = Math.floor(info.progress);
        const fileKey = info.file || "unknown-file";
        // Only log every 10% per file, not on every single chunk event.
        if (pct % 10 === 0 && lastLoggedPct[fileKey] !== pct) {
          lastLoggedPct[fileKey] = pct;
          console.log(`  [download] ${fileKey}: ${pct}%`);
        }
      } else if (info.status && info.status !== "progress") {
        console.log(`  [status] ${info.status}${info.file ? " - " + info.file : ""}`);
      }
    },
  });
  console.log("Model loaded.\n");

  const outDir = pageDir;
  const summary = { fullSuccess: [], partial: [], failed: [], shortNodesByLang: {} };

  // Optional: node scripts/translate-dictionary.js --langs=fr,ar,zh
  // Lets a small subset run first as a smoke test before committing to the
  // full (slow, multi-GB-download) run across all languages.
  const langsArg = process.argv.find((a) => a.startsWith("--langs="));
  const requestedCodes = langsArg ? langsArg.replace("--langs=", "").split(",") : null;
  const entriesToRun = requestedCodes
    ? Object.entries(LANGUAGE_MAP).filter(([code]) => requestedCodes.includes(code))
    : Object.entries(LANGUAGE_MAP);
  if (requestedCodes) {
    console.log(`Running a SUBSET only: ${entriesToRun.map(([c]) => c).join(", ")}\n`);
  }

  for (const [code, floresCode] of entriesToRun) {
    console.log(`Translating -> ${code} (${floresCode})...`);
    const result = {};
    const failedKeys = [];

    const translateOne = async (text) => {
      const output = await translator(text, { src_lang: SOURCE_LANG, tgt_lang: floresCode, max_new_tokens: 512 });
      const translated = Array.isArray(output) ? output[0].translation_text : output.translation_text;
      if (!translated) throw new Error("empty translation result");
      return translated;
    };
    const shortNodesSkipped = [];

    for (const key of keys) {
      const sourceText = enDict[key];
      if (!sourceText) {
        result[key] = "";
        continue;
      }
      try {
        if (htmlKeys.has(key)) {
          result[key] = await translateHtmlFragment(sourceText, translateOne, (shortText) => {
            shortNodesSkipped.push({ key, text: shortText });
          }, floresCode);
        } else if (/^\d+$/.test(sourceText.trim())) {
          // Found via spot-check on the quiz question bank: an isolated
          // bare number like "8" or "4" (a multiple-choice answer option)
          // gave the model nothing real to translate, and it sometimes
          // "completed" it into unrelated hallucinated text instead — e.g.
          // "8" became "8 Les États membres" ("8 Member States") in
          // French. None of the existing checks catch this: it's not a
          // repetition loop, the output isn't too SHORT (it's longer than
          // expected, not shorter), and there's no sentence structure to
          // check for dropped clauses. Digits are universal across every
          // target language anyway — there is nothing to translate — so
          // skip the model entirely for pure-integer values rather than
          // try to catch every way it could go wrong after the fact.
          result[key] = sourceText;
        } else {
          let translated = await translateOne(sourceText);
          if (isDegenerate(sourceText, translated, floresCode)) {
            const retry = await translateOne(sourceText);
            translated = isDegenerate(sourceText, retry, floresCode) ? null : retry;
          }
          if (translated === null) {
            // Whole-paragraph translation degenerated twice. Before giving
            // up entirely, try sentence-by-sentence — smaller units are
            // consistently more reliable in this pipeline, and this way a
            // partially-translated result beats an all-English one.
            translated = await translateWithSentenceFallback(sourceText, translateOne, floresCode);
          }
          if (translated === null) {
            // Nothing worked, not even per-sentence. Previously this threw
            // and left the key OUT of the written JSON as `null` — which
            // render-page.js would then render as the literal string
            // "null" on the page (cheerio's .text(null) stringifies it).
            // Fall back to the original English text instead, same
            // graceful-degradation pattern already used for HTML-fragment
            // text nodes, and flag it in the same "needs manual review"
            // report rather than silently emitting a visible bug.
            shortNodesSkipped.push({ key, text: sourceText + " [repetition-loop fallback]" });
            result[key] = sourceText;
          } else {
            result[key] = translated;
          }
        }
      } catch (err) {
        console.error(`  FAILED [${code}] key="${key}": ${err.message}`);
        failedKeys.push(key);
        result[key] = null;
      }
    }

    // Collision check: found via manual spot-check on the results page —
    // "First name" and "Last name" both translated to the French for
    // "Last name" ("Nom de famille"). Neither is a repetition loop, neither
    // is short/truncated, neither drops a clause — it's a plain
    // mistranslation, a failure mode none of the checks above catch. If two
    // keys with DIFFERENT source text end up with the SAME translated
    // value, that's a strong signal at least one is wrong. Retry each
    // colliding key once (independently, without the other's interference);
    // if the retry still collides with something else, fall back to
    // English for that key rather than risk shipping the wrong word.
    const byTranslatedValue = {};
    for (const key of keys) {
      const val = result[key];
      if (typeof val !== "string" || !val || htmlKeys.has(key)) continue; // HTML fragments checked per-node already; plain-string only here
      const sourceText = enDict[key];
      if (!byTranslatedValue[val]) byTranslatedValue[val] = [];
      byTranslatedValue[val].push(key);
    }
    // Normalize before comparing sources: lowercase, strip trailing arrows/
    // punctuation, collapse whitespace. Retroactive scan across home's
    // completed translations surfaced ~50 "collisions" that were all false
    // positives — e.g. "How it Works" / "How It Works" (case only) and
    // "Start IQ Test Now" / "Start IQ Test Now →" (trailing arrow) are
    // legitimately the same phrase reused in nav + mobile-nav + section
    // heading, and SHOULD translate identically. Only a real semantic
    // difference (like "First name" vs "Last name") should trigger a retry.
    const normalize = (s) => s.toLowerCase().replace(/[→→]/g, "").replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
    for (const [val, collidingKeys] of Object.entries(byTranslatedValue)) {
      if (collidingKeys.length < 2) continue;
      const distinctSources = new Set(collidingKeys.map((k) => normalize(enDict[k])));
      if (distinctSources.size < 2) continue; // same source text (or a trivial variant) legitimately sharing a key — not a bug
      console.error(`  COLLISION [${code}]: keys [${collidingKeys.join(", ")}] all translated to the same value "${val}" despite different source text — retrying each independently`);
      // Retrying isn't guaranteed to fix it — spot-check on results/fr found
      // the model deterministically mistranslates "First name" the same
      // wrong way every time (not random degeneration, a consistent wrong
      // answer), so a naive "accept the retry" would silently keep shipping
      // it. After retrying, re-check whether the NEW value still collides
      // with anything else currently in `result` (not just the other
      // originally-colliding keys) — if so, the retry didn't actually
      // resolve the ambiguity, so fall back to English rather than trust it.
      for (const key of collidingKeys) {
        const retry = await translateOne(enDict[key]);
        let finalVal = isDegenerate(enDict[key], retry, floresCode) ? null : retry;
        if (finalVal !== null) {
          const stillColliding = Object.entries(result).some(
            ([otherKey, otherVal]) => otherKey !== key && otherVal === finalVal && normalize(enDict[otherKey] || "") !== normalize(enDict[key])
          );
          if (stillColliding) finalVal = null;
        }
        if (finalVal === null) {
          result[key] = enDict[key];
          shortNodesSkipped.push({ key, text: enDict[key] + " [translation-collision fallback]" });
        } else {
          result[key] = finalVal;
        }
      }
    }

    if (shortNodesSkipped.length > 0) {
      console.log(`  Left untranslated (short/context-free, needs manual review): ${shortNodesSkipped.map((s) => `"${s.text}"`).join(", ")}`);
      summary.shortNodesByLang[code] = shortNodesSkipped;
    }

    if (failedKeys.length === 0) {
      fs.writeFileSync(
        path.join(outDir, `${code}.json`),
        JSON.stringify(result, null, 2) + "\n"
      );
      summary.fullSuccess.push(code);
      console.log(`  Wrote translations/${code}.json (${keys.length}/${keys.length} keys)`);
    } else if (failedKeys.length < keys.length) {
      // Final safety net: a genuinely unexpected error (not the controlled
      // degenerate-output checks above, which already fall back to English)
      // still leaves `null` in `result`. Never let that reach the written
      // file — cheerio's .text(null) would render the literal word "null"
      // on the live page. Fall back to English here too.
      for (const key of failedKeys) {
        if (result[key] === null) result[key] = enDict[key];
      }
      fs.writeFileSync(
        path.join(outDir, `${code}.json`),
        JSON.stringify(result, null, 2) + "\n"
      );
      summary.partial.push({ code, failedKeys });
      console.log(`  Wrote translations/${code}.json PARTIALLY (${keys.length - failedKeys.length}/${keys.length} keys, ${failedKeys.length} failed)`);
    } else {
      summary.failed.push(code);
      console.log(`  SKIPPED translations/${code}.json entirely — every key failed for this language.`);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Fully succeeded (${summary.fullSuccess.length}/${entriesToRun.length}):`, summary.fullSuccess.join(", ") || "(none)");
  if (summary.partial.length > 0) {
    console.log(`\nPartially succeeded (${summary.partial.length}):`);
    summary.partial.forEach(({ code, failedKeys }) => {
      console.log(`  ${code}: failed keys -> ${failedKeys.join(", ")}`);
    });
  }
  if (Object.keys(summary.shortNodesByLang).length > 0) {
    console.log(`\nLeft in English intentionally (short/context-free text, needs manual translation review):`);
    for (const [code, items] of Object.entries(summary.shortNodesByLang)) {
      console.log(`  ${code}: ${items.map((s) => `"${s.text}"`).join(", ")}`);
    }
  }
  if (summary.failed.length > 0) {
    console.log(`\nCompletely failed, no file written (${summary.failed.length}):`, summary.failed.join(", "));
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
