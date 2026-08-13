// scripts/test-render-page.js
//
// One-time (re-runnable) local verification of api/render-page.js, per
// Step 3's test prompt. Calls the handler directly with mock req/res
// objects — same pattern used to sanity-check the existing Stripe API
// files — no HTTP server or Vercel dev environment required.

const fs = require("fs");
const path = require("path");
const handler = require("../api/render-page.js");

function mockRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    send(body) {
      this.body = body;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return res;
}

async function call(query, method = "GET") {
  const req = { method, query };
  const res = mockRes();
  await handler(req, res);
  return res;
}

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}`);
    failures++;
  }
}

async function main() {
  const EXPECTED_CACHE_CONTROL = "public, s-maxage=2592000, stale-while-revalidate=86400";

  // 1 & 5. fr renders real French text, correct headers.
  console.log("1) lang=fr");
  let res = await call({ page: "start", lang: "fr" });
  const fr = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "translations", "fr.json"), "utf8"));
  check("status 200", res.statusCode === 200);
  check("contains translated headline_prefix", res.body.includes(fr["hero.headline_prefix"]));
  check("contains translated checklist.item1", res.body.includes(fr["checklist.item1"]));
  check("contains translated gender.male_button", res.body.includes(fr["gender.male_button"]));
  check("no raw key leakage (e.g. 'hero.headline')", !/data-i18n-key="[^"]*">\s*hero\./.test(res.body) && !res.body.includes(">hero.headline_prefix<"));
  check('<html lang="fr">', /<html[^>]*\blang="fr"/.test(res.body));
  check("no dir=rtl for fr", !/<html[^>]*\bdir="rtl"/.test(res.body));
  check("Cache-Control correct", res.headers["cache-control"] === EXPECTED_CACHE_CONTROL);

  // 2 & 3. RTL check across ar, he, fa-IR (should be RTL) and ku (should NOT).
  console.log("2) RTL languages: ar, he, fa-IR");
  for (const lang of ["ar", "he", "fa-IR"]) {
    const r = await call({ page: "start", lang });
    check(`${lang}: status 200`, r.statusCode === 200);
    check(`${lang}: <html lang="${lang}">`, r.body.includes(`lang="${lang}"`));
    check(`${lang}: dir="rtl" present`, /<html[^>]*\bdir="rtl"/.test(r.body));
    check(`${lang}: Cache-Control correct`, r.headers["cache-control"] === EXPECTED_CACHE_CONTROL);
  }
  console.log("3) lang=ku (ambiguous script check)");
  const kuRes = await call({ page: "start", lang: "ku" });
  const kuIsRtl = /<html[^>]*\bdir="rtl"/.test(kuRes.body);
  console.log(`  ku rendered as: ${kuIsRtl ? "RTL (dir=rtl present)" : "LTR (no dir=rtl)"} — matches kmr_Latn (Latin script) resolution from Step 2, so LTR is correct.`);
  check("ku status 200", kuRes.statusCode === 200);
  check("ku is LTR (not RTL) — matches Kurmanji/Latin script choice", !kuIsRtl);

  // 4. Non-Latin scripts: zh, ja, ko, th.
  console.log("4) Non-Latin scripts: zh, ja, ko, th");
  for (const lang of ["zh", "ja", "ko", "th"]) {
    const r = await call({ page: "start", lang });
    const dict = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "translations", `${lang}.json`), "utf8"));
    check(`${lang}: status 200`, r.statusCode === 200);
    check(`${lang}: contains translated headline_prefix`, r.body.includes(dict["hero.headline_prefix"]));
    check(`${lang}: Cache-Control correct`, r.headers["cache-control"] === EXPECTED_CACHE_CONTROL);
  }

  // 6 & 7. Invalid lang / invalid page rejected cleanly.
  console.log("6) invalid lang");
  const badLang = await call({ page: "start", lang: "xx" });
  check("invalid lang -> 400, not 500/crash", badLang.statusCode === 400);
  console.log("7) invalid page");
  const badPage = await call({ page: "nonexistent", lang: "fr" });
  check("invalid page -> 400, not 500/crash", badPage.statusCode === 400);

  // 8. Elements without data-i18n-key are byte-identical to the source.
  console.log("8) untagged content byte-identical check");
  const sourceHtml = fs.readFileSync(path.join(__dirname, "..", "start", "index.html"), "utf8");
  // Base64 logo block is untouched, unique, and long — a reliable proxy for
  // "nothing outside data-i18n-key elements was touched."
  const logoSnippet = sourceHtml.match(/src="data:image\/png;base64,[^"]{200}/)[0];
  check("base64 logo snippet present unchanged in fr render", res.body.includes(logoSnippet));

  // 9. Link persistence: with page allow-list = ["start"] only, links to
  // /quiz, /terms, /privacy, /help must stay plain English (not /fr/quiz),
  // since none of those pages are in the allow-list yet.
  console.log("9) link persistence (page allow-list = ['start'] only)");
  check("male button still links to plain /quiz (not /fr/quiz)", res.body.includes('href="https://globaliqreport.com/quiz"') && !res.body.includes('href="https://globaliqreport.com/fr/quiz"'));
  check("female button still links to plain /quiz (not /fr/quiz)", (res.body.match(/href="https:\/\/globaliqreport\.com\/quiz"/g) || []).length >= 2);
  check("terms link still plain (not language-prefixed)", res.body.includes('href="https://globaliqreport.com/terms"'));
  check("privacy link still plain (not language-prefixed)", res.body.includes('href="https://globaliqreport.com/privacy"'));
  check("help link still plain (not language-prefixed)", res.body.includes('href="https://globaliqreport.com/help"'));

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Unexpected error running tests:", err);
  process.exit(1);
});
