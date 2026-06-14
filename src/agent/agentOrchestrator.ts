import { TipAgent } from "./tipAgent";
import { TimingAgent } from "./timingAgent";
import { FailureAgent } from "./failureAgent";
import {
  AgentDecision,
  FailureType,
  LifecycleEntry,
  StreamState,
} from "../types";
import logger from "../log/lifecycleLogger";

interface SubmissionDecision {
  tipDecision: AgentDecision;
  timingDecision: AgentDecision;
  tipLamports: number;
  shouldSubmitNow: boolean;
  combinedReasoning: string;
}

interface ActionStats {
  retry: number;
  increase_tip: number;
  refresh_blockhash: number;
  refresh_blockhash_and_increase_tip: number;
  abort: number;
}

export class AgentOrchestrator {
  private _tipAgent: TipAgent;
  private _timingAgent: TimingAgent;
  private _failureAgent: FailureAgent;
  private _actionStats: ActionStats = {
    retry: 0,
    increase_tip: 0,
    refresh_blockhash: 0,
    refresh_blockhash_and_increase_tip: 0,
    abort: 0,
  };
  private _decisions: AgentDecision[] = [];

  constructor() {
    this._tipAgent = new TipAgent();
    this._timingAgent = new TimingAgent();
    this._failureAgent = new FailureAgent();
  }

  async decideSubmission(
    streamState: StreamState,
    urgency: "normal" | "high" = "normal",
    previousFailures: FailureType[] = []
  ): Promise<SubmissionDecision> {
    const [timingDecision, tipDecision] = await Promise.all([
      this._timingAgent.decideTiming(streamState),
      this._tipAgent.decideTip({
        tipData: streamState.tipData,
        congestion: streamState.congestion,
        urgency,
        slotPosition: streamState.slotsUntilNextJitoLeader,
        previousFailures,
      }),
    ]);

    this._track(timingDecision);
    this._track(tipDecision);

    const tipLamports = tipDecision.decision["tip_lamports"] as number;
    const shouldSubmitNow = timingDecision.decision["submit"] as boolean;

    const combinedReasoning = [
      `TIMING: ${timingDecision.reasoning}`,
      `TIP: ${tipDecision.reasoning}`,
    ].join(" | ");

    logger.info("AgentOrchestrator submission decision", {
      tipLamports,
      shouldSubmitNow,
      timingConfidence: timingDecision.confidence,
      tipConfidence: tipDecision.confidence,
    });

    return {
      tipDecision,
      timingDecision,
      tipLamports,
      shouldSubmitNow,
      combinedReasoning,
    };
  }

  async waitForGoodWindow(
    streamState: StreamState,
    maxWaitSlots: number,
    getLatestState: () => StreamState
  ): Promise<AgentDecision> {
    return this._timingAgent.waitForGoodWindow(
      streamState,
      maxWaitSlots,
      getLatestState
    );
  }

  async handleFailure(
    entry: LifecycleEntry,
    errorMessage: string,
    streamState: StreamState,
    retryCount: number
  ): Promise<AgentDecision> {
    const decision = await this._failureAgent.diagnose({
      entry,
      errorMessage,
      streamState,
      retryCount,
    });

    this._track(decision);
    const action = decision.decision["action"] as string;
    if (action in this._actionStats) {
      this._actionStats[action as keyof ActionStats]++;
    }

    logger.info("FailureAgent decision", {
      action,
      failure_type: decision.decision["failure_type"],
      confidence: decision.confidence,
      reasoning: decision.reasoning,
    });

    return decision;
  }

  getAllDecisions(): AgentDecision[] {
    return [...this._decisions];
  }

  getActionStats(): ActionStats {
    return { ...this._actionStats };
  }

  private _track(decision: AgentDecision): void {
    this._decisions.push(decision);
  }
}
