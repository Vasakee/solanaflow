import { EventEmitter } from "events";
import {
  AgentDecision,
  BundleSubmission,
  CommitmentStage,
  FailureType,
  LifecycleEntry,
} from "../types";
import { generateId } from "../utils/stats";
import { config } from "../config";

export class LifecycleTracker extends EventEmitter {
  private _entries: Map<string, LifecycleEntry> = new Map();

  createEntry(
    submission: BundleSubmission,
    agentDecision: AgentDecision
  ): LifecycleEntry {
    const entry: LifecycleEntry = {
      id: generateId(),
      bundleId: submission.bundleId,
      signatures: submission.signatures,
      network: config.solana.network,
      tipLamports: submission.tipLamports,
      tipAccountUsed: config.jito.tipAccounts[0],
      agentDecision,
      submittedAt: submission.submittedAt,
      submittedSlot: submission.submittedSlot,
      blockhash: submission.blockhash,
      status: "submitted",
      retryCount: 0,
      retryHistory: [],
    };
    this._entries.set(entry.id, entry);
    return entry;
  }

  updateStage(
    id: string,
    stage: CommitmentStage,
    slot: number,
    timestamp: number
  ): void {
    const entry = this._entries.get(id);
    if (!entry) return;

    switch (stage) {
      case "processed":
        entry.processedAt = timestamp;
        entry.processedSlot = slot;
        entry.submittedToProcessedMs = timestamp - entry.submittedAt;
        break;
      case "confirmed":
        entry.confirmedAt = timestamp;
        entry.confirmedSlot = slot;
        entry.processedToConfirmedMs = entry.processedAt
          ? timestamp - entry.processedAt
          : undefined;
        break;
      case "finalized":
        entry.finalizedAt = timestamp;
        entry.finalizedSlot = slot;
        entry.confirmedToFinalizedMs = entry.confirmedAt
          ? timestamp - entry.confirmedAt
          : undefined;
        entry.totalLatencyMs = timestamp - entry.submittedAt;
        break;
      default:
        break;
    }

    if (stage !== "submitted") entry.status = stage;
    this._entries.set(id, entry);
    this.emit("stageChange", entry, stage);

    if (stage === "finalized") this.emit("completed", entry);
  }

  markFailed(id: string, failureType: FailureType, reason: string): void {
    const entry = this._entries.get(id);
    if (!entry) return;
    entry.status = "failed";
    entry.failureType = failureType;
    entry.failureReason = reason;
    this._entries.set(id, entry);
    this.emit("failed", entry);
  }

  addRetry(id: string, agentDecision: AgentDecision): void {
    const entry = this._entries.get(id);
    if (!entry) return;
    entry.retryCount++;
    entry.retryHistory = entry.retryHistory ?? [];
    entry.retryHistory.push(agentDecision);
    this._entries.set(id, entry);
  }

  getEntry(id: string): LifecycleEntry | undefined {
    return this._entries.get(id);
  }

  getAllEntries(): LifecycleEntry[] {
    return Array.from(this._entries.values());
  }
}
