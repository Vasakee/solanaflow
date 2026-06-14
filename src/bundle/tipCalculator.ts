import { TipMonitor } from "../stream/tipMonitor";
import { NetworkCongestion, TipAccountData } from "../types";

export interface TipCalculatorData {
  recommended: number;
  tipData: TipAccountData;
}

export class TipCalculator {
  constructor(private readonly _tipMonitor: TipMonitor) {}

  calculate(
    congestion: NetworkCongestion,
    urgency: "normal" | "high"
  ): TipCalculatorData {
    const tipData = this._tipMonitor.getTipData();
    let recommended: number;

    if (urgency === "high" || congestion === "high") {
      recommended = Math.max(tipData.p95, 10_000);
    } else if (congestion === "medium") {
      recommended = Math.max(tipData.p75, 5_000);
    } else {
      recommended = Math.max(tipData.median, 1_000);
    }

    return { recommended, tipData };
  }
}
