// scripts/test-all-pages.js
//
// Full-funnel regression test across all 4 translated pages (home, start,
// quiz, results) — verifies the render pipeline, RTL/LTR handling, dropdown
// wiring, and internal link persistence hold consistently for every page,
// not just start (which scripts/test-render-page.js already covers in
// detail). Complements, does not replace, the existing per-page suites.

const cheerio = require("cheerio");
const handler = require("../api/render-page.js");

const PAGES = ["home", "start", "quiz", "results"];
const RTL_LANGS = ["ar", "he", "fa-IR"];
const SPOT_CHECK_LANGS = ["fr", "de", "es", "zh", "ja", "ko", "ru", "is"];

function mockRes() {
  return {
    statusCode: null, headers: {}, body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(n, v) { this.headers[n.toLowerCase()] = v; },
    send(b) { this.body = b; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function render(page, lang) {
  const res = mockRes();
  await handler({ method: "GET", query: { page, lang } }, res);
  return res;
}

let failures = 0;
function check(label, cond) {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
}

const EXPECTED_CACHE_CONTROL = "public, s-maxage=2592000, stale-while-revalidate=86400";

async function main() {
  for (const page of PAGES) {
    console.log(`\n=== ${page} ===`);

    // 1. English source untouched — no /:lang prefix involved, plain page must render as-is via direct file read path (not exercised here, that's Vercel's filesystem serving) — instead confirm the render function itself behaves for a spot-check language.
    for (const lang of ["fr", ...RTL_LANGS, ...SPOT_CHECK_LANGS.filter((l) => l !== "fr")]) {
      const r = await render(page, lang);
      check(`${page}/${lang}: status 200`, r.statusCode === 200);
      check(`${page}/${lang}: <html lang="${lang}">`, r.body.includes(`lang="${lang}"`));
      check(`${page}/${lang}: Cache-Control correct`, r.headers["cache-control"] === EXPECTED_CACHE_CONTROL);
      if (RTL_LANGS.includes(lang)) {
        check(`${page}/${lang}: dir="rtl" present`, /<html[^>]*dir="rtl"/.test(r.body));
      } else {
        check(`${page}/${lang}: no dir="rtl"`, !/<html[^>]*dir="rtl"/.test(r.body));
      }
      check(`${page}/${lang}: no raw i18n key leaked as visible text`, !/>[a-z_]+\.[a-z_0-9]+</i.test(r.body.replace(/data-i18n-key="[^"]*"/g, "")));
    }

    // 2. ku is LTR everywhere (Kurmanji/Latin script resolution)
    const ku = await render(page, "ku");
    check(`${page}/ku: status 200`, ku.statusCode === 200);
    check(`${page}/ku: LTR (no dir=rtl)`, !/<html[^>]*dir="rtl"/.test(ku.body));

    // 3. Invalid lang/page rejected cleanly
    const badLang = await render(page, "xx");
    check(`${page}: invalid lang -> 400`, badLang.statusCode === 400);

    // 4. Dropdown present, 39 options, current-language option not disabled,
    // EN option points to the plain (unprefixed) URL for this page.
    const frRes = await render(page, "fr");
    const $ = cheerio.load(frRes.body);
    const options = $(".lang-option");
    check(`${page}: dropdown has 39 options`, options.length === 39);
    const frOpt = $('.lang-option[data-code="fr"]');
    check(`${page}: fr option not disabled`, !frOpt.hasClass("disabled"));
    const enOpt = $('.lang-option[data-code="en"]');
    const expectedEnHref = page === "home" ? "/" : page === "start" ? "/start" : `/${page}`;
    check(`${page}: EN option points to ${expectedEnHref}`, enOpt.attr("href") === expectedEnHref);
    const expectedFrHref = page === "home" ? "/fr" : `/fr/${page}`;
    check(`${page}: fr option points to ${expectedFrHref}`, frOpt.attr("href") === expectedFrHref);

    // 5. Progress bar present
    check(`${page}: #lang-progress-bar present`, $("#lang-progress-bar").length === 1);
  }

  console.log(`\n${failures === 0 ? "ALL CROSS-PAGE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
