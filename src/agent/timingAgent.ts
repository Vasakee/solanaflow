import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { AgentDecision, StreamState } from "../types";
import { sleep } from "../utils/sleep";

interface TimingDecision {
  submit: boolean;
  waitSlots: number;
  reasoning: string;
  confidence: number;
}

export class TimingAgent {
  private _client: Anthropic;

  constructor() {
    this._client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  async decideTiming(state: StreamState): Promise<AgentDecision> {
    const systemPrompt = `You are an expert Solana transaction optimizer managing live infrastructure. Your decisions directly affect whether transactions land on-chain. Think carefully about the tradeoffs between cost and landing probability. Always reason step by step.`;

    const userPrompt = `You must decide whether to submit a Jito bundle RIGHT NOW or wait for a better window.

CURRENT NETWORK STATE:
- Current slot: ${state.currentSlot}
- Current leader: ${state.currentLeader ?? "unknown"}
- Is current leader a Jito validator: ${state.isJitoLeader}
- Slots until next Jito leader window: ${state.slotsUntilNextJitoLeader}
- Network congestion: ${state.congestion}
- Tip data: median=${state.tipData.median} lamports, p75=${state.tipData.p75}, p95=${state.tipData.p95}

REASONING GUIDELINES:
1. If the current leader IS a Jito validator: submit NOW (isJitoLeader=true means maximum landing probability)
2. If slots until next Jito window is 0-2: submit now to be ready when the window opens
3. If slots until next Jito window is 3-8 and congestion is LOW: it may be worth waiting briefly (1-4 slots)
4. If congestion is HIGH: submit now regardless — the delay risk outweighs timing benefits
5. Never recommend waiting more than 10 slots (4 seconds) — blockhash validity is precious
6. waitSlots should be 0 if submit is true

Think step by step, then output ONLY valid JSON (no markdown):
{
  "submit": <true or false>,
  "waitSlots": <integer, 0 if submit is true>,
  "reasoning": "<3-4 sentence explanation>",
  "confidence": <float 0.0-1.0>
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
        agentType: "timing",
        reasoning: decision.reasoning,
        decision: { submit: decision.submit, waitSlots: decision.waitSlots },
        confidence: decision.confidence,
        timestamp: Date.now(),
      };
    } catch (err) {
      // Fallback: submit now
      return {
        agentType: "timing",
        reasoning: `Fallback to immediate submission due to API error: ${err instanceof Error ? err.message : String(err)}`,
        decision: { submit: true, waitSlots: 0 },
        confidence: 0.5,
        timestamp: Date.now(),
      };
    }
  }

  async waitForGoodWindow(
    state: StreamState,
    maxWaitSlots: number,
    getLatestState: () => StreamState
  ): Promise<AgentDecision> {
    let slotsWaited = 0;
    let checkCount = 0;
    let lastDecision: AgentDecision | null = null;

    while (slotsWaited < maxWaitSlots) {
      // Call Claude every 5 checks (≈2 seconds) to save API calls
      if (checkCount % 5 === 0) {
        const currentState = getLatestState();
        lastDecision = await this.decideTiming(currentState);
        const submit = lastDecision.decision["submit"] as boolean;
        if (submit) return lastDecision;
      }

      await sleep(400); // ~1 slot
      slotsWaited++;
      checkCount++;
    }

    // Max wait reached — submit anyway
    if (!lastDecision) {
      lastDecision = await this.decideTiming(getLatestState());
    }
    return {
      ...lastDecision,
      reasoning: `Max wait of ${maxWaitSlots} slots reached. ${lastDecision.reasoning}`,
      decision: { submit: true, waitSlots: 0 },
    };
  }

  private _parseDecision(text: string): TimingDecision {
    const cleaned = text.replace(/```(?:json)?/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`No JSON in response: ${text}`);
    const parsed = JSON.parse(match[0]) as TimingDecision;
    return {
      submit: Boolean(parsed.submit),
      waitSlots: Math.max(0, Math.min(20, Number(parsed.waitSlots ?? 0))),
      reasoning: String(parsed.reasoning ?? ""),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.7))),
    };
  }
}
