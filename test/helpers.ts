import { loadConfig, type Config } from "../src/config.js";
import { CRM } from "../src/crm/db.js";
import type { Personalizer, Outreach, ReplyClassification } from "../src/ai/personalize.js";
import { DryRunEmailSender } from "../src/channels/email.js";
import { DryRunSmsSender } from "../src/channels/sms.js";
import { Pipeline } from "../src/pipeline.js";
import type { Fetch } from "../src/leads/finder.js";
import type { Lead } from "../src/types.js";

export function testConfig(over: Partial<Config["rules"]> = {}): Config {
  const cfg = loadConfig();
  cfg.dbPath = ":memory:";
  cfg.dryRun = true;
  cfg.appSecret = "test-secret";
  cfg.publicBaseUrl = "https://crm.example.test";
  cfg.googlePlacesApiKey = "test-key";
  cfg.hunterApiKey = "";
  cfg.dashboardToken = "";
  cfg.rules = {
    ...cfg.rules,
    approvalMode: "auto",
    autoApproveMinScore: 50,
    minScore: 20,
    sendWindowStart: 0,
    sendWindowEnd: 24,
    sendOnWeekends: true,
    timezone: "UTC",
    smsRequireConsent: true,
    smsDelayDays: 2,
    dailyEmailLimit: 100,
    dailySmsLimit: 100,
    blockedDomains: [],
    blockedIndustries: [],
    ...over,
  };
  return cfg;
}

export class FakePersonalizer implements Personalizer {
  drafts = 0;
  nextIntent: ReplyClassification["intent"] = "interested";
  async draft(lead: Lead): Promise<Outreach> {
    this.drafts++;
    return {
      email_subject: `quick note about ${lead.businessName}'s website`,
      email_body: `Hi ${lead.contactName ?? "there"},\n\nYour site doesn't load well on phones.\n\nAlex`,
      sms_body: `Hi, Alex from Keystone Web here — noticed ${lead.businessName}'s site isn't mobile friendly. Open to a quick call?`,
      reasoning: "led with mobile",
    };
  }
  async classifyReply(): Promise<ReplyClassification> {
    return { intent: this.nextIntent, summary: `fake ${this.nextIntent}`, suggested_response: "" };
  }
}

export const OLD_SITE = `<html><head><title>Joe's</title></head><body>
<table width="600"><tr><td><font>Welcome to Joe's Plumbing</font></td></tr></table>
<p>Call us at 555-1234. Email joe@joesplumbing.com</p>
<p>Owner: Joe Smith</p>
<a href="/contact-us">Contact</a>
<p>&copy; 2016 Joe's Plumbing</p></body></html>`;

export const MODERN_SITE = `<html><head><title>Bright Smiles Dental — Family Dentist in Austin</title>
<meta name="viewport" content="width=device-width"><meta name="description" content="Family dentistry">
<script type="application/ld+json">{"@type":"Dentist","founder":{"@type":"Person","name":"Dr Maria Lopez"}}</script>
<script async src="https://www.googletagmanager.com/gtag/js"></script></head>
<body><h1>Bright Smiles</h1><form></form><a href="tel:+15125550100">Call</a><a href="https://calendly.com/x">Book online</a>
<p>Read our reviews</p><a href="https://facebook.com/bs">fb</a><p>&copy; ${new Date().getFullYear()}</p></body></html>`;

/** A fetch stub routing by URL. */
export function fakeFetch(routes: Record<string, { status?: number; body: unknown; json?: boolean }>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error(`fetch: no route for ${url}`);
    const r = routes[key];
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    const res = new Response(body, { status: r.status ?? 200, headers: { "content-type": r.json === false || typeof r.body === "string" ? "text/html" : "application/json" } });
    Object.defineProperty(res, "url", { value: url });
    return res;
  }) as Fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export function makePipeline(cfg = testConfig(), fetchImpl?: Fetch, now?: () => Date) {
  const crm = new CRM(":memory:");
  const personalizer = new FakePersonalizer();
  const email = new DryRunEmailSender();
  const sms = new DryRunSmsSender();
  const pipeline = new Pipeline({ cfg, crm, personalizer, email, sms, fetchImpl, now });
  return { cfg, crm, personalizer, email, sms, pipeline };
}
