export type CommitmentStage =
  | "submitted"
  | "processed"
  | "confirmed"
  | "finalized"
  | "failed";

export type FailureType =
  | "expired_blockhash"
  | "fee_too_low"
  | "compute_exceeded"
  | "bundle_failure"
  | "leader_skipped"
  | "simulation_failed"
  | "unknown";

export type NetworkCongestion = "low" | "medium" | "high";

export interface SlotInfo {
  slot: number;
  timestamp: number;
  leader: string | null;
  isJitoLeader: boolean;
}

export interface TipAccountData {
  account: string;
  recentTips: number[];
  median: number;
  p75: number;
  p95: number;
  updatedAt: number;
}

export interface AgentDecision {
  agentType: "tip" | "timing" | "failure";
  reasoning: string;
  decision: Record<string, unknown>;
  confidence: number;
  timestamp: number;
}

export interface BundleSubmission {
  bundleId: string;
  signatures: string[];
  tipLamports: number;
  blockhash: string;
  lastValidBlockHeight: number;
  submittedSlot: number;
  submittedAt: number;
  agentDecision: AgentDecision;
}

export interface LifecycleEntry {
  id: string;
  bundleId: string;
  signatures: string[];
  network: string;

  tipLamports: number;
  tipAccountUsed: string;

  agentDecision: AgentDecision;

  submittedAt: number;
  submittedSlot: number;
  blockhash: string;

  processedAt?: number;
  processedSlot?: number;
  submittedToProcessedMs?: number;

  confirmedAt?: number;
  confirmedSlot?: number;
  processedToConfirmedMs?: number;

  finalizedAt?: number;
  finalizedSlot?: number;
  confirmedToFinalizedMs?: number;

  totalLatencyMs?: number;

  status: CommitmentStage;
  failureType?: FailureType;
  failureReason?: string;
  retryCount: number;
  retryHistory?: AgentDecision[];
}

export interface StreamState {
  currentSlot: number;
  currentLeader: string | null;
  isJitoLeader: boolean;
  slotsUntilNextJitoLeader: number;
  congestion: NetworkCongestion;
  tipData: TipAccountData;
  lastUpdated: number;
}
