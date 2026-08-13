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
      const override = MANUAL_SHORT_OVERRIDES[floresCode] && MANUAL_SHORT_OVERRIDES[floresCode][trimmed.toLowerCase()];
      if (override) {
        node.data = leadingWs + override + trailingWs;
        continue;
      }
      if (onShortNodeSkipped) onShortNodeSkipped(trimmed);
      continue; // leave node.data (English) untouched
    }

    let translated = await translateOne(trimmed);
    if (hasRepetitionLoop(translated) || isSuspiciouslyShort(trimmed, translated, floresCode)) {
      // One retry — quantized model inference isn't perfectly deterministic
      // run to run, so a second attempt sometimes succeeds cleanly even
      // when the first one degenerated or dropped content.
      const retry = await translateOne(trimmed);
      translated = (hasRepetitionLoop(retry) || isSuspiciouslyShort(trimmed, retry, floresCode)) ? null : retry;
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
  const enPath = path.resolve(__dirname, "..", "translations", "en.json");
  const metaPath = path.resolve(__dirname, "..", "translations", "en.meta.json");
  if (!fs.existsSync(enPath)) {
    console.error("translations/en.json not found — run scripts/extract-strings.js first.");
    process.exit(1);
  }
  const enDict = JSON.parse(fs.readFileSync(enPath, "utf8"));
  const htmlKeys = new Set(
    fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")).htmlKeys : []
  );
  const keys = Object.keys(enDict);
  console.log(`Loaded ${keys.length} source strings from en.json (${htmlKeys.size} are HTML fragments: ${[...htmlKeys].join(", ") || "none"})`);

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

  const outDir = path.resolve(__dirname, "..", "translations");
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
        } else {
          let translated = await translateOne(sourceText);
          if (hasRepetitionLoop(translated) || isSuspiciouslyShort(sourceText, translated, floresCode)) {
            const retry = await translateOne(sourceText);
            if (hasRepetitionLoop(retry) || isSuspiciouslyShort(sourceText, retry, floresCode)) {
              throw new Error("translation degenerated (repetition loop or suspiciously short/truncated) on both attempts");
            }
            translated = retry;
          }
          result[key] = translated;
        }
      } catch (err) {
        console.error(`  FAILED [${code}] key="${key}": ${err.message}`);
        failedKeys.push(key);
        result[key] = null;
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
