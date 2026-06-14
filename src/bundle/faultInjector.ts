import { Transaction } from "@solana/web3.js";
import logger from "../log/lifecycleLogger";

// A known-expired blockhash (all zeros — will always be rejected by the runtime)
const EXPIRED_BLOCKHASH = "11111111111111111111111111111111";

export class FaultInjector {
  injectExpiredBlockhash(transactions: Transaction[]): Transaction[] {
    logger.warn("FAULT INJECTED: expired blockhash");
    for (const tx of transactions) {
      tx.recentBlockhash = EXPIRED_BLOCKHASH;
      // Re-sign with the existing signers to keep the transaction structurally valid
      // but with an invalid blockhash that the network will reject.
      tx.signatures = tx.signatures.map((s) => ({
        publicKey: s.publicKey,
        signature: s.signature,
      }));
    }
    return transactions;
  }

  injectLowTip(_originalTip: number): number {
    logger.warn("FAULT INJECTED: low tip (1 lamport)");
    return 1;
  }

  shouldInjectFault(
    submissionNumber: number
  ): "expired_blockhash" | "low_tip" | null {
    if (submissionNumber === 3) return "expired_blockhash";
    if (submissionNumber === 7) return "low_tip";
    return null;
  }
}
