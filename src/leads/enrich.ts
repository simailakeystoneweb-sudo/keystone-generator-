import { hostOf } from "../crm/db.js";
import { fetchPage, normalizeUrl, type FetchedPage } from "./audit.js";
import type { Fetch } from "./finder.js";

export interface Contact {
  email: string | null;
  contactName: string | null;
  phone: string | null;
  source: string | null;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const JUNK_EMAIL = /(example\.(com|org)|sentry|wixpress|godaddy|domain\.com|yourdomain|email\.com|@2x|\.(png|jpe?g|gif|svg|webp)$)/i;
const ROLE_PRIORITY = ["owner", "info", "contact", "hello", "office", "admin", "sales", "service", "support"];

/** Pull plausible business emails out of HTML, best first. */
export function extractEmails(html: string, siteHost: string | null): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) found.add(decodeURIComponent(m[1]).toLowerCase());
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  for (const m of text.matchAll(EMAIL_RE)) found.add(m[0].toLowerCase());
  const emails = [...found].filter((e) => !JUNK_EMAIL.test(e) && e.length < 80);
  const rank = (e: string) => {
    const [local, domain] = e.split("@");
    let r = 0;
    if (siteHost && domain.replace(/^www\./, "") === siteHost) r -= 100; // on the business's own domain
    if (/^[a-z]+(\.[a-z]+)?$/.test(local) && !ROLE_PRIORITY.includes(local)) r -= 50; // looks like a person
    const role = ROLE_PRIORITY.indexOf(local);
    if (role !== -1) r += role;
    return r;
  };
  return emails.sort((a, b) => rank(a) - rank(b));
}

const NAME = "([A-Z][a-z]+(?:[ '-][A-Z][a-z]+){0,2})";

/** Best-effort owner/manager name from schema.org markup or common phrasing. */
export function extractContactName(html: string): string | null {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const name = findPersonInJsonLd(JSON.parse(m[1]));
      if (name) return name;
    } catch {
      /* malformed JSON-LD is common; ignore */
    }
  }
  // Tags become line breaks so a name never runs on into the next element's text.
  const text = html.replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ");
  const patterns = [
    new RegExp(`(?:Owner|Founder|Proprietor|President|CEO|Principal|Managing Director)\\s*[:,–-]\\s*${NAME}`),
    new RegExp(`${NAME}\\s*[,–-]\\s*(?:Owner|Founder|Co-Founder|President|CEO|Principal)\\b`),
    new RegExp(`(?:Hi|Hello),? I'?m ${NAME}`),
    new RegExp(`(?:owned|founded|run) by ${NAME}`, "i"),
    new RegExp(`(?:Meet|About) (?:Dr\\. )?${NAME}\\b`),
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && !/^(Us|Our|The|We|Contact|Home)$/.test(m[1])) return m[1].trim();
  }
  return null;
}

function findPersonInJsonLd(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findPersonInJsonLd(n);
      if (r) return r;
    }
    return null;
  }
  const o = node as Record<string, unknown>;
  for (const key of ["founder", "employee", "author", "owner"]) {
    const v = o[key];
    const people = Array.isArray(v) ? v : v ? [v] : [];
    for (const p of people) {
      if (p && typeof p === "object" && typeof (p as Record<string, unknown>).name === "string") return String((p as Record<string, unknown>).name);
    }
  }
  if (o["@type"] === "Person" && typeof o.name === "string") return o.name;
  if (o["@graph"]) return findPersonInJsonLd(o["@graph"]);
  return null;
}

/** Find links to contact/about/team pages on the same site. */
export function findContactPages(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1];
    const label = m[2].replace(/<[^>]+>/g, "").toLowerCase();
    if (!/contact|about|team|staff|our-story|meet/i.test(href + " " + label)) continue;
    try {
      const u = new URL(href, baseUrl);
      if (hostOf(u.href) === hostOf(baseUrl)) out.add(u.href.split("#")[0]);
    } catch {
      /* ignore bad hrefs */
    }
  }
  return [...out].slice(0, 3);
}

interface HunterResponse {
  data?: { emails?: Array<{ value: string; first_name?: string; last_name?: string; position?: string; confidence?: number }> };
}

/** Optional: Hunter.io domain search for named decision-makers. */
export async function hunterLookup(domain: string, apiKey: string, fetchImpl: Fetch = fetch): Promise<Contact | null> {
  if (!apiKey || !domain) return null;
  const res = await fetchImpl(
    `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=10&api_key=${encodeURIComponent(apiKey)}`,
  );
  if (!res.ok) return null;
  const data = (await res.json()) as HunterResponse;
  const emails = data.data?.emails ?? [];
  const decisionMaker =
    emails.find((e) => /owner|founder|ceo|president|principal|director|manager/i.test(e.position ?? "")) ??
    emails.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  if (!decisionMaker) return null;
  const name = [decisionMaker.first_name, decisionMaker.last_name].filter(Boolean).join(" ") || null;
  return { email: decisionMaker.value, contactName: name, phone: null, source: "hunter" };
}

/**
 * Find a contact name + email for a business: homepage first, then its
 * contact/about pages, then Hunter.io if configured.
 */
export async function findContact(
  website: string | null,
  homepage: FetchedPage | null,
  opts: { hunterApiKey?: string; fetchImpl?: Fetch } = {},
): Promise<Contact> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const result: Contact = { email: null, contactName: null, phone: null, source: null };
  if (!website) return result;
  const host = hostOf(website);
  const pages: FetchedPage[] = [];
  if (homepage) pages.push(homepage);
  for (const link of homepage ? findContactPages(homepage.html, homepage.finalUrl || normalizeUrl(website)) : []) {
    const p = await fetchPage(link, fetchImpl, 10000);
    if (p && p.status < 400) pages.push(p);
  }
  for (const p of pages) {
    if (!result.email) result.email = extractEmails(p.html, host)[0] ?? null;
    if (!result.contactName) result.contactName = extractContactName(p.html);
    if (!result.phone) {
      const tel = /href=["']tel:([^"']+)["']/i.exec(p.html)?.[1];
      if (tel) result.phone = tel;
    }
    if (result.email && !result.source) result.source = "website";
  }
  if ((!result.email || !result.contactName) && opts.hunterApiKey && host) {
    const h = await hunterLookup(host, opts.hunterApiKey, fetchImpl).catch(() => null);
    if (h) {
      result.email ??= h.email;
      result.contactName ??= h.contactName;
      result.source ??= "hunter";
    }
  }
  return result;
}
