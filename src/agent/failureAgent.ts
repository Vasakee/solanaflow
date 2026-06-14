import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import {
  AgentDecision,
  FailureType,
  LifecycleEntry,
  StreamState,
} from "../types";

interface FailureAgentInput {
  entry: LifecycleEntry;
  errorMessage: string;
  streamState: StreamState;
  retryCount: number;
}

type FailureAction =
  | "retry"
  | "increase_tip"
  | "refresh_blockhash"
  | "refresh_blockhash_and_increase_tip"
  | "abort";

interface FailureDecision {
  diagnosed_cause: string;
  failure_type: FailureType;
  action: FailureAction;
  new_tip_lamports: number | null;
  reasoning: string;
  confidence: number;
}

const ERROR_PATTERNS: Array<[RegExp, FailureType]> = [
  [/blockhash not found|blockhash|block hash/i, "expired_blockhash"],
  [/insufficient fee|fee too low|fee/i, "fee_too_low"],
  [/exceeded|compute budget|computational budget/i, "compute_exceeded"],
  [/bundle|dropped|bundle failure/i, "bundle_failure"],
  [/skip|leader skip|leader/i, "leader_skipped"],
  [/simulation|simulate/i, "simulation_failed"],
];

export function classifyErrorString(msg: string): FailureType {
  for (const [pattern, type] of ERROR_PATTERNS) {
    if (pattern.test(msg)) return type;
  }
  return "unknown";
}

export class FailureAgent {
  private _client: Anthropic;

  constructor() {
    this._client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  async diagnose(input: FailureAgentInput): Promise<AgentDecision> {
    const { entry, errorMessage, streamState, retryCount } = input;
    const preClassified = classifyErrorString(errorMessage);

    const systemPrompt = `You are an expert Solana transaction optimizer managing live infrastructure. Your decisions directly affect whether transactions land on-chain. Think carefully about the tradeoffs between cost and landing probability. Always reason step by step.`;

    const userPrompt = `A Solana bundle submission has FAILED. Diagnose the root cause and decide the recovery strategy.

FAILURE DETAILS:
- Error message: "${errorMessage}"
- Pre-classified failure type (heuristic): ${preClassified}
- Retry count so far: ${retryCount}
- Bundle ID: ${entry.bundleId}
- Original tip: ${entry.tipLamports} lamports
- Submission slot: ${entry.submittedSlot}
- Status: ${entry.status}

CURRENT NETWORK STATE:
- Current slot: ${streamState.currentSlot}
- Congestion: ${streamState.congestion}
- Is Jito leader now: ${streamState.isJitoLeader}
- Tip p75: ${streamState.tipData.p75} lamports
- Tip p95: ${streamState.tipData.p95} lamports

AVAILABLE ACTIONS:
- "retry": Simple retry with same parameters (use when failure was transient)
- "increase_tip": Retry with higher tip (use when fee_too_low or bundle_failure)
- "refresh_blockhash": Get new blockhash and retry (use when expired_blockhash)
- "refresh_blockhash_and_increase_tip": Both (use when unsure or multiple failures)
- "abort": Give up (use after 3+ retries or unrecoverable errors like compute_exceeded)

REASONING GUIDELINES:
1. expired_blockhash → always refresh_blockhash (or refresh_blockhash_and_increase_tip if also suspicious of fee)
2. fee_too_low → increase_tip, set new_tip_lamports to at least p95 * 1.5
3. bundle_failure → increase_tip if retries < 2, else abort
4. compute_exceeded → abort (cannot fix without code changes)
5. leader_skipped → refresh_blockhash (new leader window needs fresh submission)
6. After 3 retries on same submission → abort

Think step by step, then output ONLY valid JSON:
{
  "diagnosed_cause": "<detailed explanation of why this failure occurred>",
  "failure_type": "<one of: expired_blockhash|fee_too_low|compute_exceeded|bundle_failure|leader_skipped|simulation_failed|unknown>",
  "action": "<one of the actions above>",
  "new_tip_lamports": <integer or null>,
  "reasoning": "<3-4 sentences explaining your decision>",
  "confidence": <float 0.0-1.0>
}`;

    try {
      const response = await this._client.messages.create({
        model: config.anthropic.model,
        max_tokens: 768,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";
      const decision = this._parseDecision(text);

      return {
        agentType: "failure",
        reasoning: decision.reasoning,
        decision: {
          diagnosed_cause: decision.diagnosed_cause,
          failure_type: decision.failure_type,
          action: decision.action,
          new_tip_lamports: decision.new_tip_lamports,
        },
        confidence: decision.confidence,
        timestamp: Date.now(),
      };
    } catch (err) {
      // Fallback based on pre-classification
      const action = this._fallbackAction(preClassified, retryCount);
      return {
        agentType: "failure",
        reasoning: `Fallback diagnosis (API error: ${err instanceof Error ? err.message : String(err)}). Pre-classified as ${preClassified}. Action: ${action}.`,
        decision: {
          diagnosed_cause: errorMessage,
          failure_type: preClassified,
          action,
          new_tip_lamports:
            action === "increase_tip" || action === "refresh_blockhash_and_increase_tip"
              ? streamState.tipData.p95 * 2
              : null,
        },
        confidence: 0.4,
        timestamp: Date.now(),
      };
    }
  }

  private _fallbackAction(type: FailureType, retryCount: number): FailureAction {
    if (retryCount >= 3) return "abort";
    switch (type) {
      case "expired_blockhash":
        return "refresh_blockhash";
      case "fee_too_low":
        return "increase_tip";
      case "compute_exceeded":
        return "abort";
      case "bundle_failure":
        return retryCount < 2 ? "increase_tip" : "abort";
      case "leader_skipped":
        return "refresh_blockhash";
      default:
        return "refresh_blockhash_and_increase_tip";
    }
  }

  private _parseDecision(text: string): FailureDecision {
    const cleaned = text.replace(/```(?:json)?/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`No JSON in response: ${text}`);
    const parsed = JSON.parse(match[0]) as FailureDecision;
    return {
      diagnosed_cause: String(parsed.diagnosed_cause ?? "Unknown cause"),
      failure_type: (parsed.failure_type as FailureType) ?? "unknown",
      action: (parsed.action as FailureAction) ?? "refresh_blockhash_and_increase_tip",
      new_tip_lamports:
        parsed.new_tip_lamports != null
          ? Math.max(1_000, Math.round(Number(parsed.new_tip_lamports)))
          : null,
      reasoning: String(parsed.reasoning ?? ""),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.5))),
    };
  }
}
