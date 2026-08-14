// api/render-page.js
// Vercel Serverless Function
//
// Renders a fully translated version of a source page server-side, so the
// visitor's browser receives ready-to-paint HTML in their chosen language —
// no client-side swapping, no flash of untranslated content. Completely
// separate from the Stripe/PayPal API files; does not touch payments.
//
// GET /api/render-page?page=start&lang=fr
//
// Uses cheerio (a server-side jQuery-like HTML parser/manipulator) instead
// of regex-based text replacement, because regex against arbitrary HTML is
// fragile — it breaks on nested tags, attributes containing ">"/"<"-like
// text, and self-closing variations. Cheerio parses into a real DOM-like
// tree, so `data-i18n-key` elements and `href` attributes can be targeted
// precisely without touching anything else in the file.
//
// Cache-Control matches the guide's spec: 30-day CDN edge cache, serve
// stale for up to 1 day while revalidating in the background. This is what
// makes translated pages fast (served from Vercel's edge on repeat hits)
// without needing a database or a build-time static export per language.

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const TRANSLATIONS_DIR = path.join(__dirname, "..", "translations");
const SITE_ROOT = path.join(__dirname, "..");

// Built from whichever translations/{page}/{code}.json files actually
// exist on disk for THIS SPECIFIC page, not hand-maintained — this can
// never drift out of sync with what that page's translation run actually
// produced successfully. Checked per-page (not globally) since different
// pages may be translated at different times as the funnel is built out.
// en.json/en.meta.json are excluded since "en" isn't a translation target.
function getLangAllowList(page) {
  const dir = path.join(TRANSLATIONS_DIR, page);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "en.json" && f !== "en.meta.json")
    .map((f) => f.replace(/\.json$/, ""));
}

// Page-scope allow-list — deliberately a plain hand-maintained list, not
// derived from a directory scan. Scoped to the actual conversion funnel
// only (home -> start -> quiz -> results), per explicit product decision:
// footer/legal/docs pages (privacy, terms, refund, cookie, cancellation,
// contact, sign-in, pricing, help, etc.) are NOT translated — visitors
// don't need those in-language to complete the funnel, and translating
// legal text carries more risk than value here. "home" is a special
// sentinel for the site root (source file is SITE_ROOT/index.html, not
// SITE_ROOT/home/index.html, and its URL is /{lang} not /{lang}/home).
// NOTE: only add a page here once its translations/{page}/ directory
// actually exists and has been verified — listing a page before its
// translations exist would make render-page.js 500 (file not found)
// instead of cleanly rejecting it, for any real visitor who hits it early.
// Target funnel scope: home, start (done), quiz, results — added one at a
// time as each is built out.
const PAGE_ALLOW_LIST = [
  "home",
  "start",
  "quiz",
  "results",
];

function pageSourcePath(page) {
  if (page === "home") {
    return path.join(SITE_ROOT, "index.html");
  }
  return path.join(SITE_ROOT, page, "index.html");
}

// RTL scripts among the 38 target languages. Resolved from what Step 2's
// FLORES-200 mapping actually produced, not assumed: ar -> arb_Arab,
// fa-IR -> pes_Arab, he -> heb_Hebr are Arabic/Hebrew script (RTL). ku maps
// to kmr_Latn (Kurmanji, Latin script) per the deliberate resolution in
// scripts/translate-dictionary.js, so it is intentionally NOT in this list.
const RTL_LANGS = new Set(["ar", "fa-IR", "he"]);

// Matches an internal/same-site link, whether given as an absolute
// globaliqreport.com URL or a root-relative path, and captures the page
// segment right after the domain/root so it can be checked against
// PAGE_ALLOW_LIST and rewritten to /{lang}/{page} when eligible. A bare
// root link (the logo: href="https://globaliqreport.com" or href="/",
// with nothing after the domain/slash) maps to the "home" sentinel, since
// that's the page allow-list entry for the site root.
function parseInternalLink(href) {
  if (typeof href !== "string") return null;
  const absoluteRootMatch = href.match(/^https?:\/\/(?:www\.)?globaliqreport\.com\/?(\?.*)?(#.*)?$/i);
  if (absoluteRootMatch) {
    const rootPrefix = href.match(/^https?:\/\/(?:www\.)?globaliqreport\.com\//i)
      ? href.match(/^https?:\/\/(?:www\.)?globaliqreport\.com\//i)[0]
      : href.replace(/(\?.*)?(#.*)?$/, "") + "/";
    return { prefix: rootPrefix, page: "home", rest: (absoluteRootMatch[1] || "") + (absoluteRootMatch[2] || "") };
  }
  const absoluteMatch = href.match(/^https?:\/\/(?:www\.)?globaliqreport\.com\/([^/?#]+)(.*)$/i);
  if (absoluteMatch) {
    return { prefix: href.slice(0, href.indexOf(absoluteMatch[1])), page: absoluteMatch[1], rest: absoluteMatch[2] };
  }
  if (href === "/") {
    return { prefix: "/", page: "home", rest: "" };
  }
  const relativeMatch = href.match(/^\/([^/?#]+)(.*)$/);
  if (relativeMatch) {
    return { prefix: "/", page: relativeMatch[1], rest: relativeMatch[2] };
  }
  return null; // external link, mailto:, anchor-only, etc. — leave untouched
}

function renderTranslatedPage(page, lang) {
  const sourceHtml = fs.readFileSync(pageSourcePath(page), "utf8");
  const pageDir = path.join(TRANSLATIONS_DIR, page);
  const dict = JSON.parse(fs.readFileSync(path.join(pageDir, `${lang}.json`), "utf8"));
  const metaPath = path.join(pageDir, "en.meta.json");
  const htmlKeys = new Set(
    fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")).htmlKeys : []
  );

  const $ = cheerio.load(sourceHtml, { decodeEntities: false });

  // 5. Replace text content of every data-i18n-key element with the
  // translated value. HTML-fragment keys (e.g. disclaimer.text, which has
  // inline <a> tags) use .html() to preserve those tags; everything else
  // uses .text() so any literal "<"/"&" in translated text is escaped
  // safely rather than interpreted as markup.
  $("[data-i18n-key]").each((_, el) => {
    const key = $(el).attr("data-i18n-key");
    const value = dict[key];
    if (value === undefined) {
      throw new Error(`Missing translation for key "${key}" in lang "${lang}"`);
    }
    if (htmlKeys.has(key)) {
      $(el).html(value);
    } else {
      $(el).text(value);
    }
  });

  // 6. <html lang="..."> and RTL direction.
  const $html = $("html");
  $html.attr("lang", lang);
  if (RTL_LANGS.has(lang)) {
    $html.attr("dir", "rtl");
  } else {
    $html.removeAttr("dir");
  }

  // 7. Rewrite internal navigation links to stay language-prefixed, but
  // ONLY when the target page is itself in PAGE_ALLOW_LIST (i.e. it has a
  // translated version to link to) — otherwise leave the link pointing to
  // the plain English URL so it doesn't 404. Derived dynamically from
  // PAGE_ALLOW_LIST so this becomes correct automatically as more pages
  // are added later, with no special-casing here.
  //
  // Explicitly excludes .lang-option links (the footer language-switcher
  // itself, added in Step 5): those hrefs are deliberately fixed,
  // per-language destinations (e.g. the "English" option always points to
  // plain /start, even when rendering the French page) — rewriting them
  // to the CURRENT page's language would silently turn the switcher into
  // a no-op for every option except the current language.
  $("a[href]").each((_, el) => {
    if ($(el).hasClass("lang-option")) return;
    const href = $(el).attr("href");
    const parsed = parseInternalLink(href);
    if (!parsed) return; // external link, mailto:, #anchor — leave alone
    if (!PAGE_ALLOW_LIST.includes(parsed.page)) return; // no translated version to link to
    // "home" is served at the bare /{lang} URL, not /{lang}/home.
    const pageSegment = parsed.page === "home" ? "" : `/${parsed.page}`;
    $(el).attr("href", `${parsed.prefix}${lang}${pageSegment}${parsed.rest}`);
  });

  return "<!DOCTYPE html>\n" + $.html();
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { page, lang } = req.query || {};
  if (!page || typeof page !== "string") {
    return res.status(400).json({ error: "Query param 'page' is required." });
  }
  if (!lang || typeof lang !== "string") {
    return res.status(400).json({ error: "Query param 'lang' is required." });
  }

  if (!PAGE_ALLOW_LIST.includes(page)) {
    return res.status(400).json({ error: `Unknown page "${page}".` });
  }
  const langAllowList = getLangAllowList(page);
  if (!langAllowList.includes(lang)) {
    return res.status(400).json({ error: `Unsupported language "${lang}".` });
  }

  try {
    const html = renderTranslatedPage(page, lang);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=2592000, stale-while-revalidate=86400");
    return res.status(200).send(html);
  } catch (err) {
    console.error(`[render-page] Failed to render page="${page}" lang="${lang}":`, err);
    return res.status(500).json({ error: "Failed to render translated page." });
  }
};
