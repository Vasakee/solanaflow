import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import {
  AgentDecision,
  FailureType,
  NetworkCongestion,
  TipAccountData,
} from "../types";
import { lamportsToSol } from "../utils/stats";

interface TipAgentInput {
  tipData: TipAccountData;
  congestion: NetworkCongestion;
  urgency: "normal" | "high";
  slotPosition: number;
  previousFailures: FailureType[];
}

interface TipDecision {
  tip_lamports: number;
  reasoning: string;
  confidence: number;
  expected_landing_probability: number;
}

export class TipAgent {
  private _client: Anthropic;

  constructor() {
    this._client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  async decideTip(input: TipAgentInput): Promise<AgentDecision> {
    const { tipData, congestion, urgency, slotPosition, previousFailures } =
      input;

    const systemPrompt = `You are an expert Solana transaction optimizer managing live infrastructure. Your decisions directly affect whether transactions land on-chain. Think carefully about the tradeoffs between cost and landing probability. Always reason step by step.`;

    const userPrompt = `You must decide the optimal Jito tip amount for a Solana bundle submission right now.

LIVE TIP STATISTICS (lamports):
- Median tip: ${tipData.median} (${lamportsToSol(tipData.median).toFixed(6)} SOL)
- 75th percentile: ${tipData.p75} (${lamportsToSol(tipData.p75).toFixed(6)} SOL)
- 95th percentile: ${tipData.p95} (${lamportsToSol(tipData.p95).toFixed(6)} SOL)
- Recent tip window size: ${tipData.recentTips.length} samples

NETWORK CONDITIONS:
- Congestion level: ${congestion}
- Urgency: ${urgency}
- Slots until next Jito leader window: ${slotPosition}
- Previous failures this submission: ${previousFailures.length > 0 ? previousFailures.join(", ") : "none"}

REASONING GUIDELINES:
1. Under LOW congestion: bidding at p75 is usually sufficient to land in 1-2 slots
2. Under MEDIUM congestion: p75 to p95 range is safer
3. Under HIGH congestion or HIGH urgency: p95 or above to compete aggressively
4. If previous failures include "fee_too_low": increase by at least 50% above p95
5. If multiple previous failures: consider 2x p95
6. Never bid below 1000 lamports (absolute minimum for Jito acceptance)

Think step by step, then output ONLY valid JSON (no markdown, no explanation outside the JSON):
{
  "tip_lamports": <integer number of lamports>,
  "reasoning": "<3-4 sentence explanation of your decision and the tradeoffs>",
  "confidence": <float 0.0-1.0>,
  "expected_landing_probability": <float 0.0-1.0>
}`;

    try {
      const response = await this._client.messages.create({
        model: config.anthropic.model,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";
      const decision = this._parseDecision(text);

      return {
        agentType: "tip",
        reasoning: decision.reasoning,
        decision: {
          tip_lamports: decision.tip_lamports,
          expected_landing_probability: decision.expected_landing_probability,
        },
        confidence: decision.confidence,
        timestamp: Date.now(),
      };
    } catch (err) {
      // Fallback: use p75
      const fallbackTip = Math.max(tipData.p75, 1_000);
      return {
        agentType: "tip",
        reasoning: `Fallback to p75 due to API unavailability: ${err instanceof Error ? err.message : String(err)}`,
        decision: { tip_lamports: fallbackTip, expected_landing_probability: 0.75 },
        confidence: 0.5,
        timestamp: Date.now(),
      };
    }
  }

  private _parseDecision(text: string): TipDecision {
    // Strip potential markdown code fences
    const cleaned = text.replace(/```(?:json)?/g, "").trim();
    // Extract JSON object
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`No JSON in response: ${text}`);
    const parsed = JSON.parse(match[0]) as TipDecision;
    return {
      tip_lamports: Math.max(1_000, Math.round(Number(parsed.tip_lamports))),
      reasoning: String(parsed.reasoning ?? ""),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.7))),
      expected_landing_probability: Math.min(
        1,
        Math.max(0, Number(parsed.expected_landing_probability ?? 0.7))
      ),
    };
  }
}
