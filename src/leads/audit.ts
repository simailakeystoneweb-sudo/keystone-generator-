import type { WebsiteAudit, WebsiteFinding } from "../types.js";
import type { Fetch } from "./finder.js";

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  html: string;
  loadMs: number;
  bytes: number;
}

const UA = "Mozilla/5.0 (compatible; KeystoneAudit/0.1; +https://example.com/bot)";

export function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export async function fetchPage(url: string, fetchImpl: Fetch = fetch, timeoutMs = 15000): Promise<FetchedPage | null> {
  const started = Date.now();
  try {
    const res = await fetchImpl(normalizeUrl(url), {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const html = await res.text();
    return {
      url,
      finalUrl: res.url || normalizeUrl(url),
      status: res.status,
      html,
      loadMs: Date.now() - started,
      bytes: Buffer.byteLength(html),
    };
  } catch {
    return null;
  }
}

const has = (html: string, re: RegExp) => re.test(html);
const first = (html: string, re: RegExp) => re.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || null;

/**
 * Inspect a business homepage for problems a web agency can fix, and
 * opportunities worth pitching. Pure function over the fetched HTML so it is
 * deterministic and testable; `auditWebsite` does the fetching.
 */
export function analyzeHtml(page: FetchedPage, now = new Date()): WebsiteAudit {
  const html = page.html;
  const lower = html.toLowerCase();
  const findings: WebsiteFinding[] = [];
  const problem = (code: string, detail: string) => findings.push({ kind: "problem", code, detail });
  const opportunity = (code: string, detail: string) => findings.push({ kind: "opportunity", code, detail });

  const https = page.finalUrl.toLowerCase().startsWith("https://");
  const title = first(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription =
    first(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ??
    first(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);

  if (page.status >= 400) problem("http_error", `Homepage returns HTTP ${page.status}.`);
  if (!https) problem("no_https", "Site is not served over HTTPS — browsers show a 'Not secure' warning.");
  if (!has(html, /<meta[^>]+name=["']viewport["']/i))
    problem("not_mobile_friendly", "No mobile viewport tag — the site likely renders poorly on phones.");
  if (!title) problem("missing_title", "Page has no <title>, which hurts search rankings.");
  else if (title.length < 15) problem("weak_title", `Page title "${title}" is too short to rank well.`);
  if (!metaDescription) problem("missing_meta_description", "No meta description — Google picks a random snippet.");
  if (!has(html, /<h1[\s>]/i)) problem("missing_h1", "No H1 headline on the homepage.");

  if (page.loadMs > 4000) problem("slow_load", `Homepage took ${(page.loadMs / 1000).toFixed(1)}s to load.`);
  if (page.bytes > 3_000_000) problem("heavy_page", `Homepage HTML is ${(page.bytes / 1e6).toFixed(1)} MB.`);

  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  const noAlt = imgs.filter((t) => !/\balt=["'][^"']+["']/i.test(t)).length;
  if (imgs.length >= 3 && noAlt / imgs.length > 0.5)
    problem("images_missing_alt", `${noAlt} of ${imgs.length} images have no alt text (SEO + accessibility).`);

  const years = [...html.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => Number(m[1]));
  const latest = years.length ? Math.max(...years) : null;
  if (latest && latest < now.getFullYear() - 1)
    problem("outdated_copyright", `Footer copyright says ${latest} — the site looks unmaintained.`);

  if (/<table[^>]+width=|<font\b|<marquee|<center>/i.test(html))
    problem("legacy_markup", "Uses 1990s-era HTML (tables/font tags) — likely an old, hard-to-update site.");
  if (/wix\.com|squarespace|godaddy|weebly/i.test(lower) && !/<link[^>]+rel=["']canonical/i.test(html))
    opportunity("site_builder", "Built on a DIY site builder — a custom site could load faster and convert better.");

  const hasForm = /<form\b/i.test(html);
  const hasBooking = /calendly|acuityscheduling|booksy|vagaro|squareup\.com\/appointments|setmore|schedul|book (now|online|an appointment)/i.test(lower);
  const hasTelLink = /href=["']tel:/i.test(html);
  if (!hasForm) opportunity("no_contact_form", "No contact or quote form — visitors must call or leave.");
  if (!hasBooking) opportunity("no_online_booking", "No online booking — competitors let customers book 24/7.");
  if (!hasTelLink) opportunity("no_click_to_call", "Phone number isn't a click-to-call link on mobile.");
  if (!/application\/ld\+json/i.test(html)) opportunity("no_schema", "No LocalBusiness schema markup for Google rich results.");
  if (!/googletagmanager|gtag\(|google-analytics|plausible|fbq\(|clarity\.ms/i.test(lower))
    opportunity("no_analytics", "No analytics or ad pixel detected — no way to measure leads.");
  if (!/review|testimonial|stars?\b/i.test(lower)) opportunity("no_social_proof", "No reviews or testimonials shown on the homepage.");
  if (!/facebook\.com|instagram\.com|linkedin\.com|tiktok\.com|yelp\.com/i.test(lower))
    opportunity("no_social_links", "No links to social profiles or Yelp.");

  return {
    url: page.finalUrl,
    reachable: page.status < 400,
    https,
    loadMs: page.loadMs,
    pageKb: Math.round(page.bytes / 1024),
    title,
    metaDescription,
    findings,
  };
}

export async function auditWebsite(url: string | null, fetchImpl: Fetch = fetch): Promise<{ audit: WebsiteAudit; page: FetchedPage | null }> {
  if (!url) {
    return {
      page: null,
      audit: {
        url: "",
        reachable: false,
        https: false,
        loadMs: null,
        pageKb: null,
        title: null,
        metaDescription: null,
        findings: [{ kind: "opportunity", code: "no_website", detail: "Business has no website listed — customers can't find them online." }],
      },
    };
  }
  const page = await fetchPage(url, fetchImpl);
  if (!page) {
    return {
      page: null,
      audit: {
        url,
        reachable: false,
        https: false,
        loadMs: null,
        pageKb: null,
        title: null,
        metaDescription: null,
        findings: [{ kind: "problem", code: "site_down", detail: "Website didn't respond — it may be down or the domain expired." }],
      },
    };
  }
  return { page, audit: analyzeHtml(page) };
}

/**
 * Fit score 0–100: how likely this business needs (and can afford) web work and
 * whether we can reach them. Used by the approval rules.
 */
export function scoreLead(input: {
  audit: WebsiteAudit | null;
  email: string | null;
  phone: string | null;
  contactName: string | null;
  rating: number | null;
  reviewCount: number | null;
}): number {
  let s = 0;
  const f = input.audit?.findings ?? [];
  const problems = f.filter((x) => x.kind === "problem").length;
  const opps = f.filter((x) => x.kind === "opportunity").length;
  if (f.some((x) => x.code === "no_website" || x.code === "site_down")) s += 35;
  s += Math.min(problems * 8, 35);
  s += Math.min(opps * 3, 15);
  if (input.email) s += 15;
  if (input.contactName) s += 5;
  if (input.phone) s += 5;
  // Established businesses (real reviews) have budget and reputation to protect.
  if ((input.reviewCount ?? 0) >= 20) s += 5;
  if ((input.rating ?? 0) >= 4) s += 5;
  if (!input.email && !input.phone) s = Math.min(s, 10); // unreachable
  return Math.max(0, Math.min(100, s));
}
