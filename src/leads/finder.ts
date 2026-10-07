import { readFileSync } from "node:fs";
import type { RawBusiness } from "../types.js";

export type Fetch = typeof fetch;

export interface SearchQuery {
  /** What kind of business, e.g. "plumber", "dentist", "hair salon". */
  industry: string;
  /** Where, e.g. "Austin, TX". */
  city: string;
  limit?: number;
}

const PLACES_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.primaryTypeDisplayName",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "nextPageToken",
].join(",");

interface PlacesResponse {
  places?: Array<{
    id: string;
    displayName?: { text: string };
    formattedAddress?: string;
    addressComponents?: Array<{ longText: string; types: string[] }>;
    nationalPhoneNumber?: string;
    internationalPhoneNumber?: string;
    websiteUri?: string;
    primaryTypeDisplayName?: { text: string };
    rating?: number;
    userRatingCount?: number;
    businessStatus?: string;
  }>;
  nextPageToken?: string;
}

/**
 * Find businesses with the Google Places API (New) Text Search endpoint.
 * https://developers.google.com/maps/documentation/places/web-service/text-search
 */
export async function searchGooglePlaces(q: SearchQuery, apiKey: string, fetchImpl: Fetch = fetch): Promise<RawBusiness[]> {
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY is not set (or use `keystone import <file.csv>`)");
  const limit = Math.min(q.limit ?? 20, 60);
  const out: RawBusiness[] = [];
  let pageToken: string | undefined;
  do {
    const res = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": PLACES_FIELDS,
      },
      body: JSON.stringify({
        textQuery: `${q.industry} in ${q.city}`,
        pageSize: Math.min(20, limit - out.length),
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Google Places error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as PlacesResponse;
    for (const p of data.places ?? []) {
      if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;
      const locality = p.addressComponents?.find((c) => c.types.includes("locality"))?.longText;
      out.push({
        businessName: p.displayName?.text ?? "Unknown business",
        phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
        website: p.websiteUri ?? null,
        industry: p.primaryTypeDisplayName?.text ?? q.industry,
        city: locality ?? q.city,
        address: p.formattedAddress ?? null,
        source: "google_places",
        sourceId: p.id,
        rating: p.rating ?? null,
        reviewCount: p.userRatingCount ?? null,
      });
      if (out.length >= limit) break;
    }
    pageToken = data.nextPageToken;
  } while (pageToken && out.length < limit);
  return out;
}

/** Parse a CSV string (RFC 4180-ish: quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((f) => f.trim() !== ""));
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export interface ImportedRow extends RawBusiness {
  contactName?: string | null;
  email?: string | null;
  smsConsent?: boolean;
}

/**
 * Import leads from a CSV export (another lead tool, a spreadsheet, a purchased list).
 * Recognised columns: business_name|name|company, contact_name|contact, email, phone,
 * website|url, industry|category, city, address, sms_consent.
 */
export function importCsv(path: string): ImportedRow[] {
  const pick = (r: Record<string, string>, ...keys: string[]) => keys.map((k) => r[k]).find((v) => v) || null;
  return parseCsv(readFileSync(path, "utf8"))
    .map((r): ImportedRow => ({
      businessName: pick(r, "business_name", "business", "company", "name") ?? "",
      contactName: pick(r, "contact_name", "contact", "owner", "first_name"),
      email: pick(r, "email", "email_address"),
      phone: pick(r, "phone", "phone_number", "mobile"),
      website: pick(r, "website", "url", "site"),
      industry: pick(r, "industry", "category", "type"),
      city: pick(r, "city", "town", "locality"),
      address: pick(r, "address", "street"),
      source: "csv",
      sourceId: null,
      smsConsent: ["1", "true", "yes", "y"].includes((r.sms_consent ?? "").toLowerCase()),
    }))
    .filter((r) => r.businessName);
}
