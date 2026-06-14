#!/usr/bin/env bash
set -e

echo "🔧 Installing dependencies..."
npm install

echo ""
echo "📄 Creating .env from template..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "   .env created — please fill in your credentials"
else
  echo "   .env already exists, skipping"
fi

echo ""
echo "📁 Creating logs directory..."
mkdir -p logs

echo ""
echo "🔑 Checking for keypair..."
if [ ! -f keypair.json ]; then
  echo "   No keypair found. Generating one..."
  npx tsx scripts/generateKeypair.ts
else
  echo "   keypair.json already exists"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Edit .env with your YELLOWSTONE_GRPC_URL, YELLOWSTONE_GRPC_TOKEN, and ANTHROPIC_API_KEY"
echo "  2. Fund your wallet with devnet SOL (see above)"
echo "  3. Run: npm run start"
