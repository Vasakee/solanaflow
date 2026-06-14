import { Connection } from "@solana/web3.js";
import { GeyserClient } from "../stream/geyserClient";
import { CommitmentStage, LifecycleEntry } from "../types";
import { sleep } from "../utils/sleep";
import logger from "../log/lifecycleLogger";

type StageChangeCallback = (
  stage: CommitmentStage,
  slot: number,
  timestamp: number
) => void;

interface TransactionEvent {
  signature: string;
  slot: number;
}

export class Confirmer {
  constructor(
    private readonly _connection: Connection,
    private readonly _geyser: GeyserClient
  ) {}

  async confirmTransaction(
    signature: string,
    entry: LifecycleEntry,
    onStageChange: StageChangeCallback,
    lastValidBlockHeight?: number
  ): Promise<LifecycleEntry> {
    return new Promise((resolve) => {
      let resolved = false;
      let processedSlot = 0;
      let confirmedSlot = 0;

      // ── Stream listener (primary) ─────────────────────────────────────────
      const onTransaction = (event: TransactionEvent) => {
        if (event.signature !== signature) return;
        // Geyser fires at PROCESSED commitment
        if (!entry.processedAt) {
          processedSlot = event.slot;
          onStageChange("processed", event.slot, Date.now());
        }
      };
      this._geyser.on("transaction", onTransaction);

      // ── RPC polling fallback ──────────────────────────────────────────────
      const pollInterval = setInterval(async () => {
        if (resolved) return;
        try {
          const statuses = await this._connection.getSignatureStatuses([
            signature,
          ]);
          const status = statuses.value[0];
          if (!status) return;

          const slot = status.slot;
          const commitment = status.confirmationStatus;

          if (commitment === "processed" && !entry.processedAt) {
            processedSlot = slot;
            onStageChange("processed", slot, Date.now());
          }

          if (
            (commitment === "confirmed" || commitment === "finalized") &&
            !entry.confirmedAt
          ) {
            confirmedSlot = slot;
            onStageChange("confirmed", slot, Date.now());
          }

          if (commitment === "finalized" && !entry.finalizedAt) {
            onStageChange("finalized", slot, Date.now());
            cleanup();
            resolve(entry);
          }
        } catch (err) {
          logger.warn(`Poll error for ${signature}: ${err}`);
        }
      }, 500);

      // ── Blockhash expiry timeout ──────────────────────────────────────────
      const checkExpiry = setInterval(async () => {
        if (resolved) return;
        try {
          const blockHeight = await this._connection.getBlockHeight("confirmed");
          const expiryHeight = lastValidBlockHeight ?? (entry.submittedSlot + 150);
          if (blockHeight > expiryHeight) {
            logger.warn(
              `Blockhash expired for ${signature} at height ${blockHeight}`
            );
            onStageChange("failed", 0, Date.now());
            cleanup();
            resolve({ ...entry, status: "failed" });
          }
        } catch {
          // ignore
        }
      }, 2_000);

      const cleanup = () => {
        resolved = true;
        this._geyser.off("transaction", onTransaction);
        clearInterval(pollInterval);
        clearInterval(checkExpiry);
      };

      // Safety net: 90-second absolute timeout
      setTimeout(() => {
        if (!resolved) {
          logger.warn(`Confirmation timeout for ${signature}`);
          onStageChange("failed", 0, Date.now());
          cleanup();
          resolve({ ...entry, status: "failed" });
        }
      }, 90_000);
    });
  }
}
