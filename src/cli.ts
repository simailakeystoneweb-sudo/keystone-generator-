#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv, type Config } from "./config.js";
import { CRM } from "./crm/db.js";
import { ClaudePersonalizer, createClaudeService } from "./ai/personalize.js";
import type { ClaudeService } from "./ai/claude.js";
import { createEmailSender } from "./services/email/index.js";
import { createSmsSender } from "./services/sms/index.js";
import { importCsv } from "./leads/finder.js";
import { Pipeline } from "./pipeline.js";
import { createApp } from "./web/server.js";

const HELP = `keystone — lead generation & outreach pipeline

Usage: keystone <command> [options]

  find --industry <type> --city <city> [--limit 20]   Find businesses (Google Places)
  import <file.csv>                                   Import leads from CSV
  enrich [--id N]                                     Find contacts + audit websites (all 'new' leads by default)
  draft [--id N]                                      AI-write email + SMS, apply approval rules
  queue                                               Show leads waiting for approval
  approve --id N [--sms-consent]                      Approve a lead's draft
  reject --id N [--reason text]                       Reject a lead's draft
  send [--id N]                                       Send everything approved & due (respecting rules)
  run [--industry X --city Y] [--no-send]             Run every stage end to end
  stage --id N --to <interested|booked|closed|lost>   Move a lead manually
  leads [--status S]                                  List leads
  stats                                               Pipeline counts
  serve [--send-every 15]                             Dashboard + webhooks (+ send due messages every N minutes)

Set DRY_RUN=false to actually send. See .env.example for configuration.`;

function build(cfg: Config): { pipeline: Pipeline; claude: ClaudeService | null } {
  const crm = new CRM(cfg.dbPath);
  // The Claude client lives only in this server process; the key never leaves it.
  const svc = createClaudeService(cfg);
  const claude = svc.configured ? svc : null;
  const pipeline = new Pipeline({
    cfg,
    crm,
    claude,
    personalizer: claude ? new ClaudePersonalizer(claude) : null,
    email: createEmailSender(cfg),
    sms: createSmsSender(cfg),
  });
  return { pipeline, claude };
}

async function main() {
  loadDotEnv();
  const cfg = loadConfig();
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      id: { type: "string" },
      industry: { type: "string" },
      city: { type: "string" },
      limit: { type: "string" },
      status: { type: "string" },
      to: { type: "string" },
      reason: { type: "string" },
      note: { type: "string" },
      "sms-consent": { type: "boolean" },
      "no-send": { type: "boolean" },
      "send-every": { type: "string" },
    },
  });
  if (!cmd || cmd === "help" || cmd === "--help") return console.log(HELP);

  const { pipeline: p, claude } = build(cfg);
  const id = values.id ? Number(values.id) : undefined;
  const print = (x: unknown) => console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));

  switch (cmd) {
    case "find": {
      if (!values.industry || !values.city) throw new Error("--industry and --city are required");
      const r = await p.findLeads({ industry: values.industry, city: values.city, limit: Number(values.limit ?? 20) });
      print(`Found ${r.found} businesses, ${r.created.length} new leads.`);
      break;
    }
    case "import": {
      if (!positionals[0]) throw new Error("usage: keystone import <file.csv>");
      print(`Imported ${p.importRows(importCsv(positionals[0])).length} new leads.`);
      break;
    }
    case "enrich": {
      const ids = id ? [id] : p.crm.listLeads({ status: "new", limit: 10_000 }).map((l) => l.id);
      for (const i of ids) {
        const l = await p.enrich(i);
        print(`#${l.id} ${l.businessName}: score ${l.score}, email ${l.email ?? "—"}, contact ${l.contactName ?? "—"}, ${l.audit?.findings.length ?? 0} findings`);
      }
      break;
    }
    case "draft": {
      const ids = id ? [id] : p.crm.listLeads({ status: "enriched", limit: 10_000 }).map((l) => l.id);
      for (const i of ids) {
        const { lead, decision } = await p.draft(i);
        print(`#${lead.id} ${lead.businessName}: ${decision.action} (${decision.reasons.join("; ")})`);
      }
      break;
    }
    case "queue": {
      for (const l of p.crm.listLeads({ status: "pending_approval" })) {
        const d = p.crm.latestDraft(l.id);
        print(`\n#${l.id} ${l.businessName} <${l.email ?? "no email"}> ${l.phone ?? ""} score=${l.score}\nSubject: ${d?.emailSubject}\n${d?.emailBody}\nSMS: ${d?.smsBody}`);
      }
      break;
    }
    case "approve":
      if (!id) throw new Error("--id is required");
      print(`#${id} → ${p.approve(id, { smsConsent: values["sms-consent"] }, "cli").status}`);
      break;
    case "reject":
      if (!id) throw new Error("--id is required");
      print(`#${id} → ${p.reject(id, values.reason ?? "rejected", "cli").status}`);
      break;
    case "send": {
      if (id) print({ email: (await p.trySend(id, "email")) ?? "sent", sms: (await p.trySend(id, "sms")) ?? "sent" });
      else print(await p.sendDue());
      break;
    }
    case "run":
      print(
        await p.runAll({
          query: values.industry && values.city ? { industry: values.industry, city: values.city, limit: Number(values.limit ?? 20) } : undefined,
          send: !values["no-send"],
        }),
      );
      break;
    case "stage":
      if (!id || !values.to) throw new Error("--id and --to are required");
      print(`#${id} → ${p.markStage(id, values.to as never, values.note).status}`);
      break;
    case "leads":
      for (const l of p.crm.listLeads({ status: values.status as never })) {
        print(`#${l.id}\t${l.status}\t${l.score ?? "-"}\t${l.businessName}\t${l.email ?? ""}\t${l.phone ?? ""}`);
      }
      break;
    case "stats":
      print(p.crm.stats());
      break;
    case "serve": {
      const app = createApp(cfg, p, claude);
      app.listen(cfg.port, () => {
        print(`Dashboard: http://localhost:${cfg.port}  (public: ${cfg.publicBaseUrl})${cfg.dryRun ? "  [DRY RUN]" : ""}`);
        print(claude ? `Claude: ${cfg.anthropicModel}` : "Claude: not configured (set ANTHROPIC_API_KEY) — AI buttons will be disabled.");
        if (!cfg.dashboardToken) print("Warning: DASHBOARD_TOKEN is not set — the API is unauthenticated. Don't expose this port publicly.");
      });
      const every = Number(values["send-every"] ?? 0);
      if (every > 0) {
        let running = false;
        setInterval(async () => {
          if (running) return;
          running = true;
          try {
            const r = await p.sendDue();
            if (r.sent.length) print(`[scheduler] sent ${r.sent.length} message(s)`);
          } catch (e) {
            console.error("[scheduler]", e);
          } finally {
            running = false;
          }
        }, every * 60_000);
      }
      return; // keep process alive
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
  p.crm.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
