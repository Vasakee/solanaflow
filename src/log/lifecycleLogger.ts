import winston from "winston";
import fs from "fs";
import path from "path";
import { config } from "../config";
import { AgentDecision, LifecycleEntry } from "../types";
import { mean } from "../utils/stats";

// ── Shared Winston logger (console + file) ─────────────────────────────────
const logDir = config.logging.dir;
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    new winston.transports.File({
      filename: path.join(logDir, "app.log"),
    }),
  ],
});

export default logger;

// ── Lifecycle log writer ───────────────────────────────────────────────────
function dateTag(): string {
  return new Date().toISOString().split("T")[0];
}

function jsonlPath(): string {
  return path.join(logDir, `lifecycle-${dateTag()}.jsonl`);
}

function summaryPath(): string {
  return path.join(logDir, `summary-${dateTag()}.txt`);
}

function finalReportPath(): string {
  return path.join(logDir, `final-report-${dateTag()}.json`);
}

export function logLifecycleEntry(entry: LifecycleEntry): void {
  const enriched = {
    ...entry,
    timestamp_iso: new Date().toISOString(),
    solana_explorer_url: entry.signatures[0]
      ? `https://explorer.solana.com/tx/${entry.signatures[0]}?cluster=${entry.network}`
      : null,
  };

  fs.appendFileSync(jsonlPath(), JSON.stringify(enriched) + "\n", "utf8");

  const summary = [
    `--- Entry ${entry.id} ---`,
    `Status: ${entry.status}`,
    `Bundle: ${entry.bundleId}`,
    `Tip: ${entry.tipLamports} lamports`,
    `Submitted at slot ${entry.submittedSlot}`,
    entry.totalLatencyMs != null
      ? `Total latency: ${entry.totalLatencyMs}ms`
      : "",
    entry.failureReason ? `Failure: ${entry.failureReason}` : "",
    entry.signatures[0]
      ? `Explorer: https://explorer.solana.com/tx/${entry.signatures[0]}?cluster=${entry.network}`
      : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  fs.appendFileSync(summaryPath(), summary, "utf8");
}

export interface FinalReport {
  total_submissions: number;
  successful: number;
  failed: number;
  average_tip_lamports: number;
  average_confirmed_latency_ms: number;
  average_finalized_latency_ms: number;
  failure_breakdown: Record<string, number>;
  agent_decisions: AgentDecision[];
  entries: LifecycleEntry[];
}

export function writeFinalReport(
  entries: LifecycleEntry[],
  agentDecisions: AgentDecision[]
): FinalReport {
  const successful = entries.filter(
    (e) => e.status === "finalized" || e.status === "confirmed"
  ).length;
  const failed = entries.filter((e) => e.status === "failed").length;

  const confirmedLatencies = entries
    .filter((e) => e.processedToConfirmedMs != null)
    .map((e) => e.processedToConfirmedMs!);

  const finalizedLatencies = entries
    .filter((e) => e.totalLatencyMs != null)
    .map((e) => e.totalLatencyMs!);

  const failureBreakdown: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.failureType) {
      failureBreakdown[entry.failureType] =
        (failureBreakdown[entry.failureType] ?? 0) + 1;
    }
  }

  const report: FinalReport = {
    total_submissions: entries.length,
    successful,
    failed,
    average_tip_lamports: mean(entries.map((e) => e.tipLamports)),
    average_confirmed_latency_ms: mean(confirmedLatencies),
    average_finalized_latency_ms: mean(finalizedLatencies),
    failure_breakdown: failureBreakdown,
    agent_decisions: agentDecisions,
    entries,
  };

  fs.writeFileSync(finalReportPath(), JSON.stringify(report, null, 2), "utf8");
  logger.info(`Final report written to ${finalReportPath()}`);
  return report;
}
