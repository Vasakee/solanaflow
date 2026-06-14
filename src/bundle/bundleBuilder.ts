import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

export interface BuiltBundle {
  transactions: Transaction[];
  blockhash: string;
  lastValidBlockHeight: number;
  tipAccount: string;
}

export class BundleBuilder {
  async buildBundle(
    wallet: Keypair,
    tipLamports: number,
    tipAccount: string,
    connection: Connection
  ): Promise<BuiltBundle> {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    // Payload: self-transfer of 1000 lamports
    const payloadTx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: wallet.publicKey,
    }).add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: wallet.publicKey,
        lamports: 1_000,
      })
    );
    payloadTx.sign(wallet);

    // Tip transaction
    const tipTx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: wallet.publicKey,
    }).add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports: tipLamports,
      })
    );
    tipTx.sign(wallet);

    return {
      transactions: [payloadTx, tipTx],
      blockhash,
      lastValidBlockHeight,
      tipAccount,
    };
  }

  async refreshBlockhash(
    transactions: Transaction[],
    wallet: Keypair,
    connection: Connection
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    for (const tx of transactions) {
      tx.recentBlockhash = blockhash;
      tx.signatures = [];
      tx.sign(wallet);
    }

    return { blockhash, lastValidBlockHeight };
  }
}
