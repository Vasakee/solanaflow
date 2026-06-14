import chalk from "chalk";
import type { ChalkInstance } from "chalk";
import { AgentDecision, CommitmentStage, LifecycleEntry } from "../types";
import { FinalReport } from "./lifecycleLogger";
import { lamportsToSol } from "../utils/stats";

export class LogFormatter {
  printBanner(): void {
    console.log(
      chalk.cyan(`
 ____        _                  _____ _
/ ___|  ___ | | __ _ _ __   __ |  ___| | _____      __
\\___ \\ / _ \\| |/ _\` | '_ \\ / _\` | |_  | |/ _ \\ \\ /\\ / /
 ___) | (_) | | (_| | | | | (_| |  _| | | (_) \\ V  V /
|____/ \\___/|_|\\__,_|_| |_|\\__,_|_|   |_|\\___/ \\_/\\_/
`)
    );
    console.log(chalk.bold.white("  Smart Solana Transaction Infrastructure Stack"));
    console.log(chalk.gray("  v1.0.0 — Powered by Yellowstone gRPC + Claude AI\n"));
  }

  printSubmitting(entry: LifecycleEntry, agentDecision: AgentDecision, n: number): void {
    console.log(
      chalk.bold.blue(
        `\n🚀 Submitting bundle #${n} | Tip: ${entry.tipLamports.toLocaleString()} lamports (${lamportsToSol(entry.tipLamports).toFixed(6)} SOL)`
      )
    );
    console.log(chalk.gray(`   Bundle ID: ${entry.bundleId}`));
    console.log(chalk.gray(`   Blockhash: ${entry.blockhash.slice(0, 16)}…`));
    console.log(chalk.italic.gray(`   AI Reasoning: ${agentDecision.reasoning}`));
    console.log(chalk.gray(`   Confidence: ${(agentDecision.confidence * 100).toFixed(0)}%`));
  }

  printStageChange(entry: LifecycleEntry, stage: CommitmentStage): void {
    let color: ChalkInstance;
    let icon: string;

    switch (stage) {
      case "processed":
        color = chalk.yellow;
        icon = "⚡";
        break;
      case "confirmed":
        color = chalk.green;
        icon = "✅";
        break;
      case "finalized":
        color = chalk.bold.greenBright;
        icon = "🔒";
        break;
      default:
        color = chalk.gray;
        icon = "ℹ️";
    }

    const slot =
      stage === "processed"
        ? entry.processedSlot
        : stage === "confirmed"
        ? entry.confirmedSlot
        : entry.finalizedSlot;

    const delta =
      stage === "processed"
        ? entry.submittedToProcessedMs
        : stage === "confirmed"
        ? entry.processedToConfirmedMs
        : entry.confirmedToFinalizedMs;

    const deltaStr = delta != null ? `+${delta}ms` : "";

    console.log(
      color(
        `   ${icon} ${stage.toUpperCase().padEnd(12)} | Slot: ${slot ?? "—"} | ${deltaStr}`
      )
    );
  }

  printFailure(entry: LifecycleEntry, agentDecision: AgentDecision): void {
    const action = agentDecision.decision["action"] as string ?? "—";
    console.log(
      chalk.bold.red(
        `\n   ❌ FAILED | Type: ${entry.failureType ?? "unknown"} | Agent action: ${action}`
      )
    );
    console.log(chalk.red(`      Reason: ${entry.failureReason ?? "—"}`));
    console.log(chalk.italic.red(`      AI: ${agentDecision.reasoning}`));
  }

  printRetry(entry: LifecycleEntry, retryCount: number, agentDecision: AgentDecision): void {
    const newTip = agentDecision.decision["new_tip_lamports"] as number | null;
    console.log(
      chalk.bold.yellow(
        `\n   🔄 RETRY #${retryCount} for bundle ${entry.bundleId.slice(0, 8)}…`
      ) +
        (newTip != null ? chalk.yellow(` | New tip: ${newTip.toLocaleString()} lamports`) : "")
    );
    console.log(chalk.italic.yellow(`      AI: ${agentDecision.reasoning}`));
  }

  printSummary(report: FinalReport): void {
    console.log(chalk.bold.cyan("\n══════════════════════════════════════════════════════"));
    console.log(chalk.bold.cyan("  FINAL SUMMARY"));
    console.log(chalk.bold.cyan("══════════════════════════════════════════════════════\n"));

    console.log(
      chalk.white(
        `  Total submissions : ${report.total_submissions}`
      )
    );
    console.log(chalk.green(`  Successful         : ${report.successful}`));
    console.log(chalk.red(`  Failed             : ${report.failed}`));
    console.log(
      chalk.white(
        `  Avg tip            : ${Math.round(report.average_tip_lamports).toLocaleString()} lamports`
      )
    );
    console.log(
      chalk.white(
        `  Avg confirmed lat  : ${Math.round(report.average_confirmed_latency_ms)}ms`
      )
    );
    console.log(
      chalk.white(
        `  Avg finalized lat  : ${Math.round(report.average_finalized_latency_ms)}ms`
      )
    );

    if (Object.keys(report.failure_breakdown).length > 0) {
      console.log(chalk.red("\n  Failure breakdown:"));
      for (const [type, count] of Object.entries(report.failure_breakdown)) {
        console.log(chalk.red(`    ${type}: ${count}`));
      }
    }

    console.log(chalk.bold.cyan("\n  Per-submission table:"));
    console.log(
      chalk.gray(
        "  #  | Status      | Slot      | Tip (lamps) | Confirmed | Finalized | Retries"
      )
    );
    console.log(chalk.gray("  " + "─".repeat(80)));

    report.entries.forEach((e, i) => {
      const statusColor =
        e.status === "finalized" || e.status === "confirmed"
          ? chalk.green
          : e.status === "failed"
          ? chalk.red
          : chalk.yellow;

      const row = [
        String(i + 1).padStart(2),
        statusColor(e.status.padEnd(12)),
        String(e.submittedSlot).padEnd(10),
        e.tipLamports.toLocaleString().padEnd(12),
        e.processedToConfirmedMs != null
          ? `${e.processedToConfirmedMs}ms`.padEnd(10)
          : "—".padEnd(10),
        e.confirmedToFinalizedMs != null
          ? `${e.confirmedToFinalizedMs}ms`.padEnd(10)
          : "—".padEnd(10),
        String(e.retryCount),
      ].join(" | ");

      console.log(`  ${row}`);
    });

    console.log(chalk.bold.cyan("\n══════════════════════════════════════════════════════\n"));
  }
}
