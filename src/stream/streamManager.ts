import { Connection } from "@solana/web3.js";
import { GeyserClient } from "./geyserClient";
import { TipMonitor } from "./tipMonitor";
import { SlotTracker } from "./slotTracker";
import { StreamState } from "../types";
import { sleep } from "../utils/sleep";
import logger from "../log/lifecycleLogger";

export class StreamManager {
  private _geyser: GeyserClient;
  private _tipMonitor: TipMonitor;
  private _slotTracker: SlotTracker;
  private _ready = false;

  constructor(connection: Connection) {
    this._geyser = new GeyserClient(connection);
    this._tipMonitor = new TipMonitor(this._geyser, connection);
    this._slotTracker = new SlotTracker(this._geyser, this._tipMonitor);

    this._geyser.on("connected", () =>
      logger.info("GeyserClient connected")
    );
    this._geyser.on("disconnected", () =>
      logger.warn("GeyserClient disconnected — reconnecting…")
    );
    this._geyser.on("slot", (e: { slot: number }) =>
      logger.debug(`Slot: ${e.slot}`)
    );
  }

  async start(): Promise<void> {
    logger.info("Initialising TipMonitor from RPC history…");
    await this._tipMonitor.initialize();

    logger.info("Connecting GeyserClient…");
    // connect() runs its own loop; don't await it indefinitely
    this._geyser.connect().catch((err) =>
      logger.error(`GeyserClient fatal: ${err}`)
    );

    // Wait until we have at least one slot update (max 15 s)
    logger.info("Waiting for first slot update…");
    await this._waitForFirstSlot(15_000);
    this._ready = true;
    logger.info("StreamManager ready");
  }

  getState(): StreamState {
    return this._slotTracker.getStreamState();
  }

  shutdown(): void {
    this._geyser.disconnect();
    logger.info("StreamManager shut down");
  }

  get geyser(): GeyserClient {
    return this._geyser;
  }

  private async _waitForFirstSlot(timeoutMs: number): Promise<void> {
    const start = Date.now();
    return new Promise((resolve) => {
      const onSlot = () => {
        this._geyser.off("slot", onSlot);
        resolve();
      };
      this._geyser.once("slot", onSlot);
      setTimeout(() => {
        this._geyser.off("slot", onSlot);
        logger.warn("Timed out waiting for first slot — continuing anyway");
        resolve();
      }, timeoutMs);
    });
  }
}
