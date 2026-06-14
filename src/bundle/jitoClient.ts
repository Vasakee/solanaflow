import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import { config } from "../config";
import { BundleSubmission } from "../types";
import bs58 from "bs58";
import crypto from "crypto";
import logger from "../log/lifecycleLogger";

export class JitoClient {
  private _tipAccountIndex = 0;
  private _isMainnet: boolean;

  constructor() {
    this._isMainnet = config.solana.network === "mainnet-beta";
  }

  getNextJitoTipAccount(): string {
    const account = config.jito.tipAccounts[this._tipAccountIndex];
    this._tipAccountIndex =
      (this._tipAccountIndex + 1) % config.jito.tipAccounts.length;
    return account;
  }

  async submitBundle(
    transactions: Transaction[],
    tipLamports: number,
    connection: Connection,
    submittedSlot: number
  ): Promise<BundleSubmission> {
    const signatures = transactions.map((tx) => {
      const sig = tx.signatures[0];
      if (!sig?.signature) return "";
      return bs58.encode(sig.signature);
    });

    const blockhash = transactions[0].recentBlockhash ?? "";
    const bundleId = crypto
      .createHash("sha256")
      .update(signatures.join(""))
      .digest("hex");

    if (this._isMainnet) {
      return this._submitMainnet(
        transactions,
        signatures,
        bundleId,
        tipLamports,
        blockhash,
        submittedSlot
      );
    } else {
      return this._submitDevnet(
        transactions,
        signatures,
        bundleId,
        tipLamports,
        blockhash,
        submittedSlot,
        connection
      );
    }
  }

  // ── Devnet simulation ─────────────────────────────────────────────────────
  // Jito block engine only operates on mainnet. On devnet we submit via
  // standard RPC so all lifecycle tracking still works correctly.
  private async _submitDevnet(
    transactions: Transaction[],
    signatures: string[],
    bundleId: string,
    tipLamports: number,
    blockhash: string,
    submittedSlot: number,
    connection: Connection
  ): Promise<BundleSubmission> {
    logger.info(`[DEVNET] Submitting ${transactions.length} txns via RPC`);

    let lastValidBlockHeight = 0;
    try {
      const bh = await connection.getLatestBlockhash("confirmed");
      lastValidBlockHeight = bh.lastValidBlockHeight;
    } catch {
      lastValidBlockHeight = submittedSlot + 150;
    }

    // Send transactions sequentially (simulate bundle ordering)
    for (const tx of transactions) {
      try {
        const raw = tx.serialize();
        await connection.sendRawTransaction(raw, {
          skipPreflight: false,
          preflightCommitment: "processed",
        });
      } catch (err) {
        // Re-throw so the caller can classify and handle
        throw err;
      }
    }

    return {
      bundleId,
      signatures: signatures.filter(Boolean),
      tipLamports,
      blockhash,
      lastValidBlockHeight,
      submittedSlot,
      submittedAt: Date.now(),
      agentDecision: {
        agentType: "tip",
        reasoning: "Devnet RPC submission",
        decision: {},
        confidence: 1,
        timestamp: Date.now(),
      },
    };
  }

  // ── Mainnet Jito bundle submission ────────────────────────────────────────
  private async _submitMainnet(
    transactions: Transaction[],
    signatures: string[],
    bundleId: string,
    tipLamports: number,
    blockhash: string,
    submittedSlot: number
  ): Promise<BundleSubmission> {
    // Dynamic import of jito-ts to keep devnet path fast
    const jitoSdk = await import("jito-ts/dist/sdk/block-engine/searcher");
    const fsModule = await import("fs");
    const keypairBytes = JSON.parse(
      fsModule.readFileSync(config.jito.authKeypairPath, "utf8")
    ) as number[];
    const authKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairBytes));

    const client = jitoSdk.searcherClient(config.jito.blockEngineUrl, authKeypair);
    const jitoTypes = await import("jito-ts/dist/sdk/block-engine/types");
    const BundleClass = jitoTypes.Bundle;

    // jito-ts expects VersionedTransaction; serialize our legacy Transactions
    const { VersionedTransaction, Message } = await import("@solana/web3.js");
    const versionedTxs = transactions.map((tx) => {
      const serialized = tx.serialize();
      return VersionedTransaction.deserialize(serialized);
    });

    const bundle = new BundleClass(versionedTxs, versionedTxs.length);
    const result = await (client as unknown as { sendBundle: (b: unknown) => Promise<unknown> }).sendBundle(bundle);
    const resultObj = result as Record<string, unknown> | null;
    const jitoId = (resultObj?.["bundleId"] as string | undefined) ?? bundleId;

    const lastValidBlockHeight = submittedSlot + 150;

    return {
      bundleId: jitoId,
      signatures: signatures.filter(Boolean),
      tipLamports,
      blockhash,
      lastValidBlockHeight,
      submittedSlot,
      submittedAt: Date.now(),
      agentDecision: {
        agentType: "tip",
        reasoning: "Mainnet Jito bundle submission",
        decision: {},
        confidence: 1,
        timestamp: Date.now(),
      },
    };
  }

  async checkBundleStatus(bundleId: string): Promise<string> {
    // Jito provides a REST endpoint to poll bundle status
    try {
      const url = `${config.jito.blockEngineUrl}/api/v1/bundles/${bundleId}`;
      const res = await fetch(url);
      if (!res.ok) return "unknown";
      const data = (await res.json()) as { status?: string };
      return data.status ?? "unknown";
    } catch {
      return "unknown";
    }
  }
}
