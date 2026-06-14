import fs from "fs";
import path from "path";
import { Connection, Keypair } from "@solana/web3.js";
import { config } from "./config";
import { StreamManager } from "./stream/streamManager";
import { AgentOrchestrator } from "./agent/agentOrchestrator";
import { BundleBuilder } from "./bundle/bundleBuilder";
import { JitoClient } from "./bundle/jitoClient";
import { FaultInjector } from "./bundle/faultInjector";
import { LifecycleTracker } from "./lifecycle/tracker";
import { Confirmer } from "./lifecycle/confirmer";
import { FailureClassifier } from "./lifecycle/failureClassifier";
import logger, {
  logLifecycleEntry,
  writeFinalReport,
} from "./log/lifecycleLogger";
import { LogFormatter } from "./log/logFormatter";
import { CommitmentStage, FailureType, LifecycleEntry } from "./types";
import { sleep } from "./utils/sleep";

const TOTAL_SUBMISSIONS = 12;
const MAX_RETRIES = 3;
const BETWEEN_SUBMISSIONS_MS = 2_000;

async function loadWallet(): Promise<Keypair> {
  const keypairPath = path.resolve(
    process.env.WALLET_KEYPAIR_PATH || "./keypair.json"
  );
  if (!fs.existsSync(keypairPath)) {
    throw new Error(
      `Wallet keypair not found at ${keypairPath}. Run: npm run generate-keypair`
    );
  }
  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main(): Promise<void> {
  const formatter = new LogFormatter();
  formatter.printBanner();

  // ── Setup ─────────────────────────────────────────────────────────────────
  logger.info("Loading configuration…");
  if (!config.anthropic.apiKey) {
    logger.warn("ANTHROPIC_API_KEY not set — agents will use fallback mode");
  }

  let wallet: Keypair;
  try {
    wallet = await loadWallet();
    logger.info(`Wallet loaded: ${wallet.publicKey.toBase58()}`);
  } catch (err) {
    logger.error(`Failed to load wallet: ${err}`);
    process.exit(1);
  }

  const connection = new Connection(config.solana.rpcUrl, {
    wsEndpoint: config.solana.wsUrl,
    commitment: "confirmed",
  });

  const streamManager = new StreamManager(connection);
  await streamManager.start();

  const orchestrator = new AgentOrchestrator();
  const bundleBuilder = new BundleBuilder();
  const jitoClient = new JitoClient();
  const faultInjector = new FaultInjector();
  const lifecycleTracker = new LifecycleTracker();
  const confirmer = new Confirmer(connection, streamManager.geyser);
  const failureClassifier = new FailureClassifier();

  logger.info("All systems initialised. Starting submission loop…\n");

  const submittedEntries: LifecycleEntry[] = [];
  const allPreviousFailures: FailureType[] = [];

  // ── Main loop ─────────────────────────────────────────────────────────────
  for (let i = 1; i <= TOTAL_SUBMISSIONS; i++) {
    logger.info(`\n[Submission ${i}/${TOTAL_SUBMISSIONS}]`);

    const fault = faultInjector.shouldInjectFault(i);
    if (fault) {
      logger.warn(`⚠️  Fault injection planned for submission #${i}: ${fault}`);
    }

    // ── (b) Timing decision ──────────────────────────────────────────────
    const streamState = streamManager.getState();
    const timingDecision = await orchestrator.waitForGoodWindow(
      streamState,
      20,
      () => streamManager.getState()
    );
    logger.info(`Timing: ${timingDecision.reasoning}`);

    // ── (c) Tip decision ─────────────────────────────────────────────────
    const currentState = streamManager.getState();
    const submissionDecision = await orchestrator.decideSubmission(
      currentState,
      "normal",
      allPreviousFailures
    );
    let tipLamports = submissionDecision.tipLamports;

    if (fault === "low_tip") {
      tipLamports = faultInjector.injectLowTip(tipLamports);
    }

    // ── (d) Build bundle ─────────────────────────────────────────────────
    const tipAccount = jitoClient.getNextJitoTipAccount();
    let builtBundle = await bundleBuilder.buildBundle(
      wallet,
      tipLamports,
      tipAccount,
      connection
    );

    if (fault === "expired_blockhash") {
      builtBundle.transactions = faultInjector.injectExpiredBlockhash(
        builtBundle.transactions
      );
    }

    // ── (e) Submit ────────────────────────────────────────────────────────
    const slotAtSubmit = streamManager.getState().currentSlot;
    let bundleSubmission;
    try {
      bundleSubmission = await jitoClient.submitBundle(
        builtBundle.transactions,
        tipLamports,
        connection,
        slotAtSubmit
      );
    } catch (err) {
      // Submission itself failed — classify and handle below
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Submission error: ${errorMsg}`);

      // Build a minimal fake submission record so we can create an entry
      const fakeSubmission = {
        bundleId: `failed-${Date.now()}`,
        signatures: [],
        tipLamports,
        blockhash: builtBundle.blockhash,
        lastValidBlockHeight: builtBundle.lastValidBlockHeight,
        submittedSlot: slotAtSubmit,
        submittedAt: Date.now(),
        agentDecision: submissionDecision.tipDecision,
      };

      const entry = lifecycleTracker.createEntry(
        fakeSubmission,
        submissionDecision.tipDecision
      );
      formatter.printSubmitting(entry, submissionDecision.tipDecision, i);

      const classified = failureClassifier.classify(err);
      entry.status = "failed";
      entry.failureType = classified.failureType;
      entry.failureReason = classified.details;

      await _handleFailureWithRetry(
        entry,
        errorMsg,
        i,
        wallet,
        connection,
        builtBundle,
        streamManager,
        orchestrator,
        bundleBuilder,
        jitoClient,
        lifecycleTracker,
        confirmer,
        failureClassifier,
        formatter,
        allPreviousFailures
      );

      submittedEntries.push(
        lifecycleTracker.getEntry(entry.id) ?? entry
      );
      logLifecycleEntry(lifecycleTracker.getEntry(entry.id) ?? entry);
      await sleep(BETWEEN_SUBMISSIONS_MS);
      continue;
    }

    const entry = lifecycleTracker.createEntry(
      bundleSubmission,
      submissionDecision.tipDecision
    );
    formatter.printSubmitting(entry, submissionDecision.tipDecision, i);

    // ── (f) Track lifecycle ───────────────────────────────────────────────
    const primarySig = bundleSubmission.signatures[0];
    if (primarySig) {
      try {
        await confirmer.confirmTransaction(
          primarySig,
          entry,
          (stage: CommitmentStage, slot: number, timestamp: number) => {
            lifecycleTracker.updateStage(entry.id, stage, slot, timestamp);
            const updated = lifecycleTracker.getEntry(entry.id) ?? entry;
            if (stage !== "failed") {
              formatter.printStageChange(updated, stage);
            }
          }
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Confirmation error: ${errorMsg}`);
        const classified = failureClassifier.classify(err);
        lifecycleTracker.markFailed(entry.id, classified.failureType, classified.details);
        allPreviousFailures.push(classified.failureType);
      }
    }

    const finalEntry = lifecycleTracker.getEntry(entry.id) ?? entry;

    // ── (g) Handle failure if needed ──────────────────────────────────────
    if (finalEntry.status === "failed") {
      allPreviousFailures.push(finalEntry.failureType ?? "unknown");
      const errorMsg = finalEntry.failureReason ?? "Unknown failure";
      const failureDecision = await orchestrator.handleFailure(
        finalEntry,
        errorMsg,
        streamManager.getState(),
        finalEntry.retryCount
      );
      formatter.printFailure(finalEntry, failureDecision);

      const action = failureDecision.decision["action"] as string;
      if (action !== "abort" && finalEntry.retryCount < MAX_RETRIES) {
        await _handleFailureWithRetry(
          finalEntry,
          errorMsg,
          i,
          wallet,
          connection,
          builtBundle,
          streamManager,
          orchestrator,
          bundleBuilder,
          jitoClient,
          lifecycleTracker,
          confirmer,
          failureClassifier,
          formatter,
          allPreviousFailures
        );
      }
    }

    // ── (h) Log entry ─────────────────────────────────────────────────────
    const completedEntry = lifecycleTracker.getEntry(entry.id) ?? entry;
    submittedEntries.push(completedEntry);
    logLifecycleEntry(completedEntry);

    await sleep(BETWEEN_SUBMISSIONS_MS);
  }

  // ── Completion phase ──────────────────────────────────────────────────────
  const allDecisions = orchestrator.getAllDecisions();
  const report = writeFinalReport(submittedEntries, allDecisions);
  formatter.printSummary(report);

  const logDir = config.logging.dir;
  const today = new Date().toISOString().split("T")[0];
  console.log(`\n📁 Log files written to ${logDir}/`);
  console.log(`   lifecycle-${today}.jsonl`);
  console.log(`   summary-${today}.txt`);
  console.log(`   final-report-${today}.json`);
  console.log(`   app.log\n`);

  // ── README answers printed with data from actual run ────────────────────
  const avgProcessedToConfirmed = Math.round(report.average_confirmed_latency_ms);
  const health = avgProcessedToConfirmed < 800 ? "healthy" : "stressed";

  console.log("═══════════════════════════════════════════════════════");
  console.log("README QUESTION ANSWERS (from this run)");
  console.log("═══════════════════════════════════════════════════════\n");

  console.log("Q1: processed_at → confirmed_at delta");
  console.log(
    `    Average in this run: ${avgProcessedToConfirmed}ms — indicating ${health} network conditions.\n`
  );

  console.log("Q2: Why not use finalized commitment for blockhash?");
  console.log(
    "    A finalized blockhash is ~32 slots old, burning ~20% of the 150-slot validity window\n" +
      "    before the transaction is even built. Under retry scenarios this creates expiry races.\n"
  );

  console.log("Q3: What happens when a Jito leader skips their slot?");
  console.log(
    "    The bundle is silently dropped — never rejected, never included. Our stack detects\n" +
      "    this via slot-gap monitoring and resubmits with a refreshed blockhash.\n"
  );

  streamManager.shutdown();
  process.exit(0);
}

// ── Retry helper ──────────────────────────────────────────────────────────
async function _handleFailureWithRetry(
  entry: LifecycleEntry,
  errorMsg: string,
  submissionNumber: number,
  wallet: Keypair,
  connection: Connection,
  originalBundle: { transactions: import("@solana/web3.js").Transaction[]; blockhash: string; lastValidBlockHeight: number; tipAccount: string },
  streamManager: StreamManager,
  orchestrator: AgentOrchestrator,
  bundleBuilder: BundleBuilder,
  jitoClient: JitoClient,
  lifecycleTracker: LifecycleTracker,
  confirmer: Confirmer,
  failureClassifier: FailureClassifier,
  formatter: LogFormatter,
  allPreviousFailures: FailureType[]
): Promise<void> {
  let retryCount = entry.retryCount;

  while (retryCount < MAX_RETRIES) {
    const currentState = streamManager.getState();
    const failureDecision = await orchestrator.handleFailure(
      entry,
      errorMsg,
      currentState,
      retryCount
    );

    const action = failureDecision.decision["action"] as string;
    if (action === "abort") {
      logger.warn(`Agent says abort after ${retryCount} retries`);
      break;
    }

    lifecycleTracker.addRetry(entry.id, failureDecision);
    retryCount++;
    formatter.printRetry(entry, retryCount, failureDecision);

    // Determine new tip
    const newTip =
      (failureDecision.decision["new_tip_lamports"] as number | null) ??
      currentState.tipData.p75;

    // Refresh blockhash if needed
    const needsBlockhash =
      action === "refresh_blockhash" ||
      action === "refresh_blockhash_and_increase_tip";

    let blockhash = entry.blockhash;
    let lastValidBlockHeight = 0;

    if (needsBlockhash) {
      const refreshed = await bundleBuilder.refreshBlockhash(
        originalBundle.transactions,
        wallet,
        connection
      );
      blockhash = refreshed.blockhash;
      lastValidBlockHeight = refreshed.lastValidBlockHeight;
    }

    const retryTip =
      action === "increase_tip" || action === "refresh_blockhash_and_increase_tip"
        ? newTip
        : entry.tipLamports;

    // Rebuild if blockhash was refreshed
    let transactionsToSubmit = originalBundle.transactions;
    if (needsBlockhash) {
      const rebuilt = await bundleBuilder.buildBundle(
        wallet,
        retryTip,
        originalBundle.tipAccount,
        connection
      );
      transactionsToSubmit = rebuilt.transactions;
      blockhash = rebuilt.blockhash;
      lastValidBlockHeight = rebuilt.lastValidBlockHeight;
    }

    try {
      const slot = streamManager.getState().currentSlot;
      const retrySubmission = await jitoClient.submitBundle(
        transactionsToSubmit,
        retryTip,
        connection,
        slot
      );

      // Update entry with new submission details
      entry.tipLamports = retryTip;
      entry.blockhash = blockhash;
      entry.status = "submitted";
      entry.failureType = undefined;
      entry.failureReason = undefined;

      const primarySig = retrySubmission.signatures[0];
      if (primarySig) {
        await confirmer.confirmTransaction(
          primarySig,
          entry,
          (stage: CommitmentStage, slot: number, timestamp: number) => {
            lifecycleTracker.updateStage(entry.id, stage, slot, timestamp);
            const updated = lifecycleTracker.getEntry(entry.id) ?? entry;
            if (stage !== "failed") formatter.printStageChange(updated, stage);
          }
        );
      }

      const updated = lifecycleTracker.getEntry(entry.id) ?? entry;
      if (updated.status !== "failed") return; // success
      errorMsg = updated.failureReason ?? "Unknown";
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      const classified = failureClassifier.classify(err);
      lifecycleTracker.markFailed(entry.id, classified.failureType, classified.details);
      allPreviousFailures.push(classified.failureType);
      logger.error(`Retry ${retryCount} failed: ${errorMsg}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
