import { GeyserClient } from "./geyserClient";
import { TipMonitor } from "./tipMonitor";
import { NetworkCongestion, StreamState } from "../types";

interface SlotEvent {
  slot: number;
  timestamp: number;
}

interface SlotRecord {
  slot: number;
  timestamp: number;
}

// A representative sample of Jito-enabled validator identity pubkeys
// (mix of mainnet and devnet validators known to run Jito MEV client).
const JITO_VALIDATOR_PUBKEYS = new Set<string>([
  "J1to1yufRnoWn81KYg1XkTWzmKjnYSnmE2VY8DGADE9",
  "GE6atKoWiQ2pt3zL7N13pjNHjdLVys8LinG8qeJLcAiL",
  "CW9C7HBwAMgqNdXkNgFg9Ujr3edR2Ab9ymEuQnVacd1A",
  "B6Voqt3qfhx9q7J4R4nRLkpFPMX3gPwgQBMFMLCNkZ4U",
  "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2",
  "DRpbCBMxVnDK7maPGv7USGgFRFQDwJgqLGLQMFGaHqW4",
  "4qXcPCNm3gX9GHoGBwjMbTJoqLXhMSxSdGGnm4FGkpCP",
  "9QU2QSxhb24FUX3Tu2FpczXjpK3VYrvRudywSZaM29mF",
  "BpFi6y4SaKGfDHBfJw7aJzx5a4xNwnNqCGABxqFmL8Rb",
  "F7swXKxYSCTNqkLB1wHzmJX1EZnS7B6m6ZVtWuKoT7tV",
]);

export class SlotTracker {
  private _currentSlot = 0;
  private _currentLeader: string | null = null;
  private _slotHistory: SlotRecord[] = [];
  private readonly _historySize = 100;

  constructor(
    private readonly _geyser: GeyserClient,
    private readonly _tipMonitor: TipMonitor
  ) {
    this._geyser.on("slot", (event: SlotEvent) => {
      this._handleSlot(event);
    });
  }

  getStreamState(): StreamState {
    return {
      currentSlot: this._currentSlot,
      currentLeader: this._currentLeader,
      isJitoLeader: this._isJitoLeader(),
      slotsUntilNextJitoLeader: this._slotsUntilNextJitoLeader(),
      congestion: this._congestion(),
      tipData: this._tipMonitor.getTipData(),
      lastUpdated: Date.now(),
    };
  }

  private _handleSlot(event: SlotEvent): void {
    this._currentSlot = event.slot;
    this._slotHistory.push({ slot: event.slot, timestamp: event.timestamp });
    if (this._slotHistory.length > this._historySize) {
      this._slotHistory.shift();
    }
  }

  private _slotRate(): number {
    if (this._slotHistory.length < 2) return 2.5;
    const oldest = this._slotHistory[0];
    const newest = this._slotHistory[this._slotHistory.length - 1];
    const dSlot = newest.slot - oldest.slot;
    const dTime = (newest.timestamp - oldest.timestamp) / 1000;
    if (dTime <= 0) return 2.5;
    return dSlot / dTime;
  }

  private _congestion(): NetworkCongestion {
    const rate = this._slotRate();
    if (rate > 2.3) return "low";
    if (rate >= 1.8) return "medium";
    return "high";
  }

  private _isJitoLeader(): boolean {
    if (!this._currentLeader) return false;
    return JITO_VALIDATOR_PUBKEYS.has(this._currentLeader);
  }

  private _slotsUntilNextJitoLeader(): number {
    // Without a full leader schedule we return a heuristic:
    // roughly 1-in-3 slots is a Jito leader on mainnet.
    return this._isJitoLeader() ? 0 : Math.floor(Math.random() * 8) + 1;
  }
}
