import { Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";

const keypair = Keypair.generate();
const secretKeyArray = Array.from(keypair.secretKey);
const keypairPath = path.resolve("./keypair.json");

fs.writeFileSync(keypairPath, JSON.stringify(secretKeyArray), "utf8");
console.log(`✅ Keypair generated: ${keypairPath}`);
console.log(`   Public key: ${keypair.publicKey.toBase58()}`);
console.log(`\n   Fund with devnet SOL:`);
console.log(
  `   solana airdrop 2 ${keypair.publicKey.toBase58()} --url devnet`
);

// Add keypair.json to .gitignore if not already present
const gitignorePath = path.resolve("./.gitignore");
const entry = "keypair.json";
if (fs.existsSync(gitignorePath)) {
  const content = fs.readFileSync(gitignorePath, "utf8");
  if (!content.includes(entry)) {
    fs.appendFileSync(gitignorePath, `\n${entry}\n`, "utf8");
    console.log(`\n   Added ${entry} to .gitignore`);
  }
} else {
  fs.writeFileSync(gitignorePath, `${entry}\n`, "utf8");
  console.log(`\n   Created .gitignore with ${entry}`);
}
