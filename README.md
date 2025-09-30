# MySol Agent — Your Telegram-native Solana Copilot

Turn Telegram into your command center for Solana. Create and manage wallets, swap tokens, on/off-ramp, and run rich token research — all through a friendly agent that understands natural language.

## Why you’ll love it

- Lightning-fast setup: no dashboards, just Telegram
- Wallet superpowers: create, send, swap, and cash in/out (fiat on/off-ramp)
- Research that reads your mind: “search BONK”, “info USDC”, “sentiment JUP last week”
- Built for safety: AES-256-GCM wallet encryption and confirm-before-execute flows

## What it can do

- Wallet mode
  - Create/set primary wallets, view balances and portfolios
  - Send SOL, swap tokens via Jupiter
  - On-ramp (fiat → crypto) and Off-ramp (USDC → bank)

- Research mode (natural language)
  - Token search and profiles (symbol/name/mint)
  - Token validation and bundle-risk checks
  - Wallet and NFT portfolio lookups
  - Online sentiment with smart fallback

## 60‑second start

```bash
npm install
cp .env.example .env   # fill required keys
npm run dev            # Mastra agent (web UI)
npm run backend:dev    # Telegram bot
```

Minimum env to get moving:

```env
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
ENCRYPTION_MASTER_KEY=change_this_master_key
```

See `.env.example` for optional power‑ups (Helius RPC, PAJ Ramp, sentiment, etc.).

## Using the Telegram agent

- /start → choose Wallet or Research
- /wallet → wallet mode (create, balance, send, swap, on/off-ramp)
- /research → free-form research (search, info, bundle, portfolios, sentiment)

Examples you can type:

```text
create wallet
what is my balance
swap 0.05 SOL to USDC
onramp 2000 NGN
sentiment BONK last week
bundle 9xQeWvG816bUx9EPjHmaT...  # any mint
```

## Mastra web interface (optional, powerful)

Prefer a desktop UI? Run the Mastra app alongside Telegram for a richer, visual experience:

```bash
npm run dev
```

Then open `http://localhost:8080`.

What you get:
- Conversational agent in the browser (same brains, more screen space)
- One‑click access to research tools and multi‑step workflows
- Clear, formatted outputs for token profiles, portfolios, validations, and sentiment

Built‑in workflows:
- Token Research: search → profile → validation → risks
- Portfolio Analysis: holdings → value → bundle checks → insights
- Trading Workflow: pre‑trade checks → swap preview → confirmations
- Token Launch: sanity checks → launch via Pump.fun → verification

Use Telegram for fast actions on the go; use Mastra for deep dives and richer summaries.

## Under the hood

- Secure secrets: AES‑256‑GCM encryption for wallet data
- Modular services: clean wallet/swap/portfolio/off‑ramp logic
- Research tools: Mastra agents with token info, search, validation, sentiment

## Scripts

```bash
npm run dev           # Start Mastra web app
npm run backend:dev   # Start Telegram bot
npm run lint          # Lint
npm run format        # Format
```

## Coming soon

- Wider on-ramp/off-ramp currency and region coverage
- Smarter agentic trading: multi-step planning, guardrails, and auto-retries
- Cross-chain expansions and more swap routes
- Portfolio alerts, price/risk notifications, and scheduled digests
- Richer research views in Mastra (charts, comparables, historical context)
- Multi-wallet UX improvements and team/collab primitives

## License

ISC
