# Robinhood Chain Trading Bot

Real-time token/pool screening, signal scoring, auto-trade (dry-run/live) for Robinhood Chain, powered by [GMGN OpenAPI](https://docs.gmgn.ai) via `gmgn-cli`.

## Stack

- TypeScript / Node.js (>= 18)
- `gmgn-cli` — market, token, portfolio, swap (chain: `robinhood`)
- viem — RPC read/verify on Robinhood Chain (Alchemy)
- Telegram (telegraf) — monitoring/control
- PostgreSQL + Redis (optional persistence)
- Food: dry-run → live via same `TradeExecutor` interface

## Setup

```bash
cp ~/.config/gmgn/.env .env   # GMGN_API_KEY + GMGN_PRIVATE_KEY
npm install
npm run dev                    # MODE=dry-run by default
```

### GMGN credential flow

1. Generate Ed25519 keypair (request-signing key, NOT a wallet key):
   `openssl genpkey -algorithm ed25519 -out keypair.pem`
2. Upload public key at https://gmgn.ai/ai → get `GMGN_API_KEY`
3. Put `GMGN_API_KEY` + `GMGN_PRIVATE_KEY` in `~/.config/gmgn/.env` (chmod 600)

The Signing Private key is used only to sign API requests. The bot's Robinhood wallet
lives in `wallet.json` (chmod 600, gitignored).

## Safety

- Scanner never trades; all trades go through Risk Manager
- Dry-run and live share the same executor interface
- Kill switch via Telegram: `/pause` `/resume` `/close_all`
- Never commit `.env` or `wallet.json` — enforced by `.gitignore`