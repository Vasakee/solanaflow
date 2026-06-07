# SolanaFlow — Smart Transaction Infrastructure Stack

> Production-grade Solana bundle submission with live Yellowstone gRPC streaming, AI-powered tip sizing and timing decisions via Claude, and full commitment lifecycle tracking.

---

## Architecture

**5-layer architecture:**

```
┌─────────────────────────────────────────────────────┐
│  1. Stream Layer  (Yellowstone gRPC / WS fallback)  │
│     GeyserClient → TipMonitor + SlotTracker         │
├─────────────────────────────────────────────────────┤
│  2. AI Agent Layer  (Claude claude-opus-4-5)        │
│     TipAgent + TimingAgent + FailureAgent           │
│     Orchestrated by AgentOrchestrator               │
├─────────────────────────────────────────────────────┤
│  3. Bundle Layer  (Jito block engine / devnet RPC)  │
│     BundleBuilder → JitoClient → FaultInjector      │
├─────────────────────────────────────────────────────┤
│  4. Lifecycle Layer  (stream-primary, poll-backup)  │
│     Confirmer → LifecycleTracker → FailureClassifier│
├─────────────────────────────────────────────────────┤
│  5. Logging Layer  (JSONL + summary + final report) │
│     LifecycleLogger → LogFormatter (chalk CLI)      │
└─────────────────────────────────────────────────────┘
```

Architecture doc: _[Notion link — to be added]_

---

## Prerequisites

- Node.js 20+
- A Solana wallet with devnet SOL
- Yellowstone gRPC endpoint (apply for SolInfra credits at [triton.one](https://triton.one))
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com))

---

## Setup

```bash
git clone <repo-url>
cd solanaflow
npm install
cp .env.example .env
# Edit .env — fill in YELLOWSTONE_GRPC_URL, YELLOWSTONE_GRPC_TOKEN, ANTHROPIC_API_KEY

# Generate a fresh wallet keypair
npm run generate-keypair

# Fund it with devnet SOL (replace with your pubkey from above)
solana airdrop 2 <YOUR_PUBKEY> --url devnet

# Run
npm run start
```

Or use the setup script:

```bash
bash scripts/setup.sh
```

---

## What It Demonstrates

| Feature | Implementation |
|---|---|
| Live slot streaming | Yellowstone gRPC subscription, WebSocket fallback |
| Live tip monitoring | Rolling 50-sample window per Jito tip account |
| AI tip sizing | Claude reasons over median/p75/p95 + congestion + urgency |
| AI submission timing | Claude decides submit-now vs wait-N-slots per Jito leader window |
| AI failure diagnosis | Claude classifies error, chooses retry strategy + new tip |
| Lifecycle tracking | submitted → processed → confirmed → finalized with ms deltas |
| Stream-primary confirmation | Geyser transaction events; RPC poll as backup |
| Fault injection | Submission #3: expired blockhash. Submission #7: 1-lamport tip |
| Structured logs | JSONL per entry, human summary, final JSON report |
| Explorer links | Every log entry includes `solana_explorer_url` |

---

## Sample Log Entry

```json
{
  "id": "3f2e1a4b-...",
  "bundleId": "a3c9f1...",
  "signatures": ["5KJp3..."],
  "network": "devnet",
  "tipLamports": 12500,
  "tipAccountUsed": "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "agentDecision": {
    "agentType": "tip",
    "reasoning": "Network congestion is low with a slot rate of 2.5/s. The p75 tip of 10,000 lamports provides sufficient priority. Given no prior failures and normal urgency, targeting p75 is cost-optimal while maintaining >90% landing probability.",
    "decision": { "tip_lamports": 12500, "expected_landing_probability": 0.92 },
    "confidence": 0.88,
    "timestamp": 1717668468192
  },
  "submittedAt": 1717668468200,
  "submittedSlot": 312450,
  "blockhash": "GHt7...",
  "processedAt": 1717668468620,
  "processedSlot": 312451,
  "submittedToProcessedMs": 420,
  "confirmedAt": 1717668469240,
  "confirmedSlot": 312453,
  "processedToConfirmedMs": 620,
  "finalizedAt": 1717668472800,
  "finalizedSlot": 312462,
  "confirmedToFinalizedMs": 3560,
  "totalLatencyMs": 4600,
  "status": "finalized",
  "retryCount": 0,
  "timestamp_iso": "2024-06-06T11:54:28.192Z",
  "solana_explorer_url": "https://explorer.solana.com/tx/5KJp3...?cluster=devnet"
}
```

---

## README Questions

### Q1: What does the delta between `processed_at` and `confirmed_at` tell you about network health?

The processed → confirmed delta reflects how quickly the validator network reaches supermajority agreement (66%+ of stake). Under normal conditions on a healthy network this delta is 400–800ms (roughly 2–4 slots at 400ms/slot). A delta above 2,000ms signals one of three conditions: validators are disagreeing on the canonical fork, the network is experiencing unusually high fork frequency, or there is a stake-weighted partition where the minority fork containing your transaction is being abandoned. In our observed runs, this delta averaged **[populated at runtime]** ms, indicating **[healthy/stressed]** network conditions at the time of submission. This delta is more informative than total latency because it isolates the consensus layer from ingestion — `processed_at` reflects TPU ingestion speed while the delta reflects validator coordination speed.

### Q2: Why should you never use `finalized` commitment when fetching a blockhash?

A finalized blockhash is at minimum 32 slots old (approximately 13 seconds). Solana blockhashes remain valid for approximately 150 slots (roughly 60 seconds). Using a finalized blockhash therefore burns 20–25% of the validity window before the transaction is even constructed. Under any retry scenario involving even one failed attempt and a 2-second wait, you lose another 5 slots. By the third retry attempt you may be submitting a blockhash that has less than 90 slots of validity remaining, creating a race condition between your retry loop and blockhash expiry. The correct commitment level for fetching blockhashes in time-sensitive contexts is `"confirmed"` (2–3 slots old, giving you 147+ slots of remaining validity) or `"processed"` (0–1 slots, maximum validity window) when latency is critical.

### Q3: What happens to your bundle if the Jito leader skips their slot?

When a Jito-enabled validator skips their leader slot, no block is produced for that slot interval, and any bundles submitted to that validator's leader window are silently dropped by the block engine — they are never included in any block. This is different from a transaction failure: the bundle is not rejected with an error, it simply never appears on-chain. The correct detection mechanism is to watch for slot gaps in your stream subscription: if slot N is a Jito leader slot and slot N+1 arrives without your transaction appearing in N, the slot was likely skipped. Our stack handles this by monitoring slot progression via the Geyser stream and treating any bundle unconfirmed after 8 slots past the target leader window as a leader-skip event, triggering the failure agent to resubmit in the next available Jito leader window with a refreshed blockhash.

---

## Project Structure

```
solanaflow/
├── src/
│   ├── stream/
│   │   ├── geyserClient.ts        # Yellowstone gRPC + WS fallback
│   │   ├── slotTracker.ts         # Slot rate, Jito leader detection, congestion
│   │   ├── tipMonitor.ts          # Rolling 50-sample tip window per account
│   │   └── streamManager.ts       # Lifecycle manager for all streams
│   ├── agent/
│   │   ├── tipAgent.ts            # Claude decides tip amount
│   │   ├── timingAgent.ts         # Claude decides when to submit
│   │   ├── failureAgent.ts        # Claude diagnoses failures + retry strategy
│   │   └── agentOrchestrator.ts   # Coordinates agents, tracks decisions
│   ├── bundle/
│   │   ├── bundleBuilder.ts       # Builds self-transfer + tip transactions
│   │   ├── jitoClient.ts          # Mainnet Jito / devnet RPC simulation
│   │   ├── tipCalculator.ts       # Heuristic tip calculator (pre-AI)
│   │   └── faultInjector.ts       # Injects failures for submissions #3 and #7
│   ├── lifecycle/
│   │   ├── tracker.ts             # In-memory LifecycleEntry store + events
│   │   ├── confirmer.ts           # Stream-primary, RPC-backup confirmation
│   │   └── failureClassifier.ts   # Error string → FailureType mapping
│   ├── log/
│   │   ├── lifecycleLogger.ts     # Winston logger + JSONL/summary/report writer
│   │   └── logFormatter.ts        # Chalk CLI pretty-printer
│   ├── config/index.ts
│   ├── types/index.ts
│   ├── utils/
│   │   ├── sleep.ts
│   │   ├── retry.ts
│   │   └── stats.ts
│   └── main.ts
├── logs/
├── scripts/
│   ├── generateKeypair.ts
│   └── setup.sh
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## License

MIT
