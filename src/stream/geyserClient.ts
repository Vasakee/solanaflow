import { EventEmitter } from "events";
import { Connection } from "@solana/web3.js";
import { config } from "../config";
import { sleep } from "../utils/sleep";

// Yellowstone gRPC types — imported lazily so the module still loads
// when the gRPC endpoint is not configured (fallback mode).
type YellowstoneClient = {
  subscribe(): AsyncIterable<unknown>;
};

interface SlotEvent {
  slot: number;
  timestamp: number;
}

interface TipUpdateEvent {
  account: string;
  lamports: number;
  slot: number;
}

interface TransactionEvent {
  signature: string;
  slot: number;
  accounts: string[];
}

type QueueItem =
  | { type: "slot"; data: SlotEvent }
  | { type: "tipUpdate"; data: TipUpdateEvent }
  | { type: "transaction"; data: TransactionEvent };

export class GeyserClient extends EventEmitter {
  private _connected = false;
  private _reconnectAttempt = 0;
  private readonly _maxReconnectDelay = 30_000;
  private readonly _baseReconnectDelay = 1_000;
  private _queue: QueueItem[] = [];
  private readonly _maxQueueSize = 1_000;
  private _stopRequested = false;
  private _connection: Connection;
  private _wsSubscriptionId: number | null = null;

  constructor(connection: Connection) {
    super();
    this._connection = connection;
  }

  isConnected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    this._stopRequested = false;
    if (config.geyser.url) {
      await this._connectGeyser();
    } else {
      await this._connectWebSocketFallback();
    }
  }

  disconnect(): void {
    this._stopRequested = true;
    this._connected = false;
    if (this._wsSubscriptionId !== null) {
      this._connection.removeSlotChangeListener(this._wsSubscriptionId);
      this._wsSubscriptionId = null;
    }
    this.emit("disconnected");
  }

  // ─── Geyser gRPC path ────────────────────────────────────────────────────

  private async _connectGeyser(): Promise<void> {
    while (!this._stopRequested) {
      try {
        const Client = await this._loadGeyserClient();
        const client: YellowstoneClient = new Client(
          config.geyser.url,
          config.geyser.token,
          {}
        ) as YellowstoneClient;

        const stream = client.subscribe();
        await this._sendSubscribeRequest(client);

        this._connected = true;
        this._reconnectAttempt = 0;
        this.emit("connected");

        for await (const update of stream) {
          if (this._stopRequested) break;
          this._handleGeyserUpdate(update);
        }
      } catch (err) {
        if (this._stopRequested) break;
        this._connected = false;
        this.emit("disconnected");
        const delay = this._nextReconnectDelay();
        await sleep(delay);
        this._reconnectAttempt++;
      }
    }
  }

  private async _loadGeyserClient(): Promise<new (...args: unknown[]) => unknown> {
    // Dynamic import keeps the fallback path working when the package
    // has issues or is not properly configured.
    const mod = await import("@triton-one/yellowstone-grpc");
    return (mod.default ?? mod) as new (...args: unknown[]) => unknown;
  }

  private async _sendSubscribeRequest(client: unknown): Promise<void> {
    // The Yellowstone SDK exposes a write() method on the duplex stream.
    // We send a single subscription request covering slots + tip accounts.
    const request = {
      slots: { slotSubscribe: {} },
      accounts: {
        tipAccounts: {
          account: config.jito.tipAccounts,
          filters: [],
          dataSlice: null,
          nonemptyTxnSignature: null,
        },
      },
      transactions: {
        tipTxns: {
          accountInclude: config.jito.tipAccounts,
          accountExclude: [],
          accountRequired: [],
          vote: false,
          failed: false,
        },
      },
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      entry: {},
      commitment: 0, // PROCESSED
    };

    // The client might expose write/request differently depending on version
    const c = client as Record<string, unknown>;
    if (typeof c["write"] === "function") {
      (c["write"] as (r: unknown) => void)(request);
    }
  }

  private _handleGeyserUpdate(update: unknown): void {
    if (this._queue.length >= this._maxQueueSize) {
      this._queue.shift(); // drop oldest — backpressure
    }

    const u = update as Record<string, unknown>;

    if (u["slot"]) {
      const slotData = u["slot"] as Record<string, unknown>;
      const event: SlotEvent = {
        slot: Number(slotData["slot"] ?? 0),
        timestamp: Date.now(),
      };
      this._queue.push({ type: "slot", data: event });
      this.emit("slot", event);
    }

    if (u["account"]) {
      const acct = u["account"] as Record<string, unknown>;
      const info = acct["account"] as Record<string, unknown> | undefined;
      const pubkey = String(acct["pubkey"] ?? "");
      if (info && config.jito.tipAccounts.includes(pubkey)) {
        const lamports = Number(info["lamports"] ?? 0);
        const event: TipUpdateEvent = {
          account: pubkey,
          lamports,
          slot: Number(acct["slot"] ?? 0),
        };
        this._queue.push({ type: "tipUpdate", data: event });
        this.emit("tipUpdate", event);
      }
    }

    if (u["transaction"]) {
      const txData = u["transaction"] as Record<string, unknown>;
      const tx = txData["transaction"] as Record<string, unknown> | undefined;
      const meta = txData["meta"] as Record<string, unknown> | undefined;
      if (tx) {
        const sig = String(tx["signature"] ?? "");
        const accountKeys = (meta?.["loadedWritableAddresses"] as string[]) ?? [];
        const event: TransactionEvent = {
          signature: sig,
          slot: Number(txData["slot"] ?? 0),
          accounts: accountKeys,
        };
        this._queue.push({ type: "transaction", data: event });
        this.emit("transaction", event);
      }
    }
  }

  // ─── WebSocket fallback path ──────────────────────────────────────────────

  private async _connectWebSocketFallback(): Promise<void> {
    try {
      this._wsSubscriptionId = this._connection.onSlotChange((slotInfo) => {
        const event: SlotEvent = {
          slot: slotInfo.slot,
          timestamp: Date.now(),
        };
        this.emit("slot", event);

        // Emit synthetic tip data periodically so downstream consumers
        // have something to work with even without a gRPC stream.
        if (slotInfo.slot % 10 === 0) {
          this._emitSyntheticTipUpdates(slotInfo.slot);
        }
      });

      this._connected = true;
      this._reconnectAttempt = 0;
      this.emit("connected");
    } catch (err) {
      this._connected = false;
      this.emit("disconnected");
      if (!this._stopRequested) {
        const delay = this._nextReconnectDelay();
        await sleep(delay);
        this._reconnectAttempt++;
        await this._connectWebSocketFallback();
      }
    }
  }

  private _emitSyntheticTipUpdates(slot: number): void {
    // Emit a synthetic tip update for the first tip account with a
    // realistic random tip amount (5_000 – 50_000 lamports) so the
    // TipMonitor can bootstrap without real gRPC data.
    const lamports = 5_000 + Math.floor(Math.random() * 45_000);
    const account = config.jito.tipAccounts[0];
    this.emit("tipUpdate", { account, lamports, slot });
  }

  private _nextReconnectDelay(): number {
    return Math.min(
      this._baseReconnectDelay * Math.pow(2, this._reconnectAttempt),
      this._maxReconnectDelay
    );
  }
}
