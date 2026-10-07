import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeHtml, scoreLead } from "../src/leads/audit.js";
import { extractContactName, extractEmails, findContactPages } from "../src/leads/enrich.js";
import { parseCsv, searchGooglePlaces } from "../src/leads/finder.js";
import { fakeFetch, MODERN_SITE, OLD_SITE } from "./helpers.js";

const page = (html: string, finalUrl = "http://joesplumbing.com/", loadMs = 800) => ({
  url: finalUrl, finalUrl, status: 200, html, loadMs, bytes: html.length,
});

test("audit flags problems on an old site", () => {
  const a = analyzeHtml(page(OLD_SITE, "http://joesplumbing.com/", 5200), new Date("2026-06-01"));
  const codes = a.findings.map((f) => f.code);
  for (const c of ["no_https", "not_mobile_friendly", "weak_title", "missing_meta_description", "missing_h1", "slow_load", "outdated_copyright", "legacy_markup", "no_contact_form", "no_online_booking", "no_click_to_call", "no_analytics"]) {
    assert.ok(codes.includes(c), `expected ${c} in ${codes.join(",")}`);
  }
  assert.equal(a.https, false);
});

test("audit is quiet on a modern site", () => {
  const a = analyzeHtml(page(MODERN_SITE, "https://brightsmiles.com/"));
  assert.deepEqual(a.findings.filter((f) => f.kind === "problem"), []);
  assert.equal(a.title, "Bright Smiles Dental — Family Dentist in Austin");
});

test("score prefers broken sites with reachable contacts", () => {
  const bad = analyzeHtml(page(OLD_SITE, "http://joesplumbing.com/", 5200));
  const good = analyzeHtml(page(MODERN_SITE, "https://brightsmiles.com/"));
  const base = { phone: "+15125550100", contactName: null, rating: 4.5, reviewCount: 40 };
  const sBad = scoreLead({ ...base, audit: bad, email: "joe@joesplumbing.com" });
  const sGood = scoreLead({ ...base, audit: good, email: "info@brightsmiles.com" });
  assert.ok(sBad > sGood, `${sBad} > ${sGood}`);
  assert.ok(scoreLead({ audit: bad, email: null, phone: null, contactName: null, rating: null, reviewCount: null }) <= 10);
});

test("extractEmails ranks on-domain personal addresses first and drops junk", () => {
  const html = `<a href="mailto:info@joes.com">x</a> sales@other.com joe@joes.com logo@2x.png noreply@sentry.io`;
  assert.deepEqual(extractEmails(html, "joes.com"), ["joe@joes.com", "info@joes.com", "sales@other.com"]);
});

test("extractContactName from text and JSON-LD", () => {
  assert.equal(extractContactName(OLD_SITE), "Joe Smith");
  assert.equal(extractContactName(MODERN_SITE), "Dr Maria Lopez");
  assert.equal(extractContactName("<p>Hi, I'm Sarah Connor and I run this bakery</p>"), "Sarah Connor");
});

test("findContactPages keeps same-site links only", () => {
  const html = `<a href="/contact-us">Contact</a><a href="https://facebook.com/about">About</a><a href="about.html">Our story</a>`;
  assert.deepEqual(findContactPages(html, "https://joes.com/"), ["https://joes.com/contact-us", "https://joes.com/about.html"]);
});

test("parseCsv handles quotes, commas and CRLF", () => {
  const rows = parseCsv('Business Name,Email,City\r\n"Acme, Inc",a@acme.com,"Austin"\r\n"Say ""hi""",,Dallas\r\n');
  assert.deepEqual(rows, [
    { business_name: "Acme, Inc", email: "a@acme.com", city: "Austin" },
    { business_name: 'Say "hi"', email: "", city: "Dallas" },
  ]);
});

test("searchGooglePlaces maps fields and skips closed businesses", async () => {
  const f = fakeFetch({
    "https://places.googleapis.com/v1/places:searchText": {
      body: {
        places: [
          {
            id: "p1", displayName: { text: "Joe's Plumbing" }, nationalPhoneNumber: "(512) 555-0100", websiteUri: "http://joesplumbing.com",
            primaryTypeDisplayName: { text: "Plumber" }, addressComponents: [{ longText: "Austin", types: ["locality"] }],
            rating: 4.6, userRatingCount: 88, businessStatus: "OPERATIONAL",
          },
          { id: "p2", displayName: { text: "Closed Co" }, businessStatus: "CLOSED_PERMANENTLY" },
        ],
      },
    },
  });
  const r = await searchGooglePlaces({ industry: "plumber", city: "Austin, TX" }, "k", f);
  assert.equal(r.length, 1);
  assert.equal(r[0].businessName, "Joe's Plumbing");
  assert.equal(r[0].city, "Austin");
  assert.equal(r[0].industry, "Plumber");
  assert.equal(r[0].sourceId, "p1");
});
