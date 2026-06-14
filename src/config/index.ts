import dotenv from "dotenv";
dotenv.config();

export const config = {
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    wsUrl: process.env.SOLANA_WS_URL || "wss://api.devnet.solana.com",
    network: process.env.NETWORK || "devnet",
  },
  geyser: {
    url: process.env.YELLOWSTONE_GRPC_URL || "",
    token: process.env.YELLOWSTONE_GRPC_TOKEN || "",
  },
  jito: {
    blockEngineUrl:
      process.env.JITO_BLOCK_ENGINE_URL ||
      "https://ny.mainnet.block-engine.jito.wtf",
    authKeypairPath: process.env.JITO_AUTH_KEYPAIR_PATH || "./keypair.json",
    tipAccounts: [
      "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
      "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
      "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
      "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13eDQRXD",
      "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
      "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
      "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
      "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
    ],
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: "claude-opus-4-5",
  },
  logging: {
    dir: process.env.LOG_DIR || "./logs",
  },
};
