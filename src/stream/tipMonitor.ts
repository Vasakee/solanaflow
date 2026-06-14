import { Connection } from "@solana/web3.js";
import { GeyserClient } from "./geyserClient";
import { config } from "../config";
import { TipAccountData } from "../types";
import { median, percentile } from "../utils/stats";

interface TipUpdateEvent {
  account: string;
  lamports: number;
  slot: number;
}

export class TipMonitor {
  private _tipsByAccount: Map<string, number[]> = new Map();
  private _primaryAccount: string;
  private _lastUpdated = 0;
  private readonly _windowSize = 50;

  constructor(
    private readonly _geyser: GeyserClient,
    private readonly _connection: Connection
  ) {
    this._primaryAccount = config.jito.tipAccounts[0];
    for (const acct of config.jito.tipAccounts) {
      this._tipsByAccount.set(acct, []);
    }
    this._geyser.on("tipUpdate", (event: TipUpdateEvent) => {
      this._recordTip(event.account, event.lamports);
    });
  }

  async initialize(): Promise<void> {
    // Pre-populate with recent transaction history via RPC
    for (const account of config.jito.tipAccounts) {
      try {
        const sigs = await this._connection.getSignaturesForAddress(
          new (await import("@solana/web3.js")).PublicKey(account),
          { limit: 20 }
        );
        for (const sigInfo of sigs) {
          if (sigInfo.err) continue;
          try {
            const tx = await this._connection.getParsedTransaction(
              sigInfo.signature,
              { maxSupportedTransactionVersion: 0 }
            );
            if (!tx?.meta) continue;
            // Approximate tip as the positive balance change on the tip account
            const preBalances = tx.meta.preBalances;
            const postBalances = tx.meta.postBalances;
            const accountKeys =
              tx.transaction.message.accountKeys.map((k) =>
                typeof k === "string" ? k : k.pubkey.toBase58()
              );
            const idx = accountKeys.findIndex((k) => k === account);
            if (idx >= 0) {
              const delta = postBalances[idx] - preBalances[idx];
              if (delta > 0) this._recordTip(account, delta);
            }
          } catch {
            // Skip individual transaction errors
          }
        }
      } catch {
        // If RPC bootstrap fails, continue — stream will populate data
      }
    }
  }

  getTipData(): TipAccountData {
    // Aggregate tips across all accounts for a global view
    const allTips: number[] = [];
    for (const tips of this._tipsByAccount.values()) {
      allTips.push(...tips);
    }

    const tips = allTips.length > 0 ? allTips : [5_000];

    return {
      account: this._primaryAccount,
      recentTips: tips.slice(-20),
      median: median(tips),
      p75: percentile(tips, 75),
      p95: percentile(tips, 95),
      updatedAt: this._lastUpdated || Date.now(),
    };
  }

  private _recordTip(account: string, lamports: number): void {
    if (lamports <= 0) return;
    let tips = this._tipsByAccount.get(account);
    if (!tips) {
      tips = [];
      this._tipsByAccount.set(account, tips);
    }
    tips.push(lamports);
    if (tips.length > this._windowSize) tips.shift();
    this._lastUpdated = Date.now();
  }
}
