import { FailureType } from "../types";

export interface ClassifiedFailure {
  failureType: FailureType;
  details: string;
}

const PATTERNS: Array<[RegExp, FailureType]> = [
  [/BlockhashNotFound|blockhash not found|block hash not found/i, "expired_blockhash"],
  [/blockhash/i, "expired_blockhash"],
  [/InsufficientFundsForFee|insufficient.*fee|fee.*too low|fee.*low/i, "fee_too_low"],
  [/ComputationalBudgetExceeded|compute.*budget.*exceeded|exceeded.*compute/i, "compute_exceeded"],
  [/bundle.*drop|bundle.*fail|dropped.*bundle|jito.*bundle/i, "bundle_failure"],
  [/leader.*skip|skip.*leader|slot.*skip/i, "leader_skipped"],
  [/simulation.*fail|failed.*simulation|simulate.*error/i, "simulation_failed"],
];

export class FailureClassifier {
  classify(error: unknown): ClassifiedFailure {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
        ? error
        : JSON.stringify(error);

    for (const [pattern, type] of PATTERNS) {
      if (pattern.test(message)) {
        return { failureType: type, details: message };
      }
    }

    return { failureType: "unknown", details: message };
  }
}
