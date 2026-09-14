# Robinhood Chain Trading Bot

Real-time token screening + auto-trading bot untuk Robinhood Chain (EVM chain ID 4663), powered by [GMGN OpenAPI](https://docs.gmgn.ai) via `gmgn-cli`. Swap dieksekusi on-chain lewat Uniswap Trading API / Uniswap V3 / V4 / GMGN — dry-run maupun live lewat interface executor yang sama.

## Stack

- Node.js >= 18 (TypeScript, ESM)
- `gmgn-cli` — screener + data (market, token, portfolio; chain: `robinhood`)
- viem — RPC read/verify & swap on-chain (Alchemy)
- Telegraf — Telegram bot untuk monitoring & kontrol
- Swap path: Uniswap Trading API → Uniswap V3 → V4 → GMGN (auto-fallback)

## Setup

### 1. Clone

```bash
git clone https://github.com/kontia1/robinhood-bot.git
cd robinhood-bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Konfigurasi `.env`

```bash
cp .env.example .env
```

Isi minimal:

| Var | Wajib | Keterangan |
|---|---|---|
| `GMGN_API_KEY` | ✅ | API key GMGN (lihat alur credential di bawah) |
| `GMGN_PRIVATE_KEY` | ✅ | Ed25519 signing key GMGN (bukan wallet key) |
| `ALCHEMY_API_KEY` | ✅ | RPC Robinhood Chain — URL di-derive otomatis dari key ini |
| `UNISWAP_API_KEY` | ⚠️ | Wajib kalau mau swap via Uniswap API (path utama). Ambil di developers.uniswap.org |
| `TELEGRAM_BOT_TOKEN` | ⚠️ | Wajib kalau mau kontrol via Telegram (buat di @BotFather) |
| `TELEGRAM_CHAT_ID` | ⚠️ | Chat ID admin untuk notifikasi |

Opsional: `RPC_URL` / `RPC_WS_URL` (override), `TELEGRAM_ALLOWED_IDS` (allowlist numeric ID, koma), `EVENTS_WS_ENABLED` (default off — chain robinhood ~0.2s/block, WS newHeads boros compute unit Alchemy), `SCAN_INTERVAL_MS` (default 60000), `SETTINGS_FILE` / `WALLET_FILE` (override path runtime state).

### 4. GMGN credential flow

1. Generate Ed25519 keypair (request-signing key, BUKAN wallet key):
   ```bash
   openssl genpkey -algorithm ed25519 -out keypair.pem
   ```
2. Upload public key di https://gmgn.ai/ai → dapat `GMGN_API_KEY`.
3. Isi `GMGN_API_KEY` + `GMGN_PRIVATE_KEY` (isi isi file PEM, format satu baris dengan `\n`) di `.env`.
   Simpan juga di `~/.config/gmgn/.env` (chmod 600) kalau mau dipakai gmgn-cli langsung.

### 5. Wallet

Buat `wallet.json` di root project (gitignored, chmod 600):

```json
[
  {
    "address": "0x…",
    "privateKey": "0x…",
    "label": "main",
    "isActive": true
  }
]
```

Field `privateKey` lama yang pakai snake_case (`private_key`, `created_at`) tetap didukung — auto-normalisasi.

> Dry-run TIDAK butuh wallet berisi — posisi cuma simulasi. Reconcile on-chain (deteksi jual manual) cuma aktif di mode `live`.

### 6. Mode & settings

Mode runtime dibaca dari `settings.json` (auto-dibuat dengan default saat pertama jalan). Ganti lewat Telegram menu atau edit file langsung:

```json
{
  "mode": "dry-run"
}
```

`MODE` di `.env` cuma buat banner startup. Mode beneran yang dipakai executor = `settings.json`.

### 7. Jalankan

```bash
npm run dev          # dry-run (default)
npm run build        # compile → dist/
npm start            # jalan dari dist/
npm run typecheck    # verifikasi tipe
```

## Fitur

- Screener GMGN (`trenches` + `trending`) dengan filter-based gating — tanpa scoring, semua kandidat lewat filter ketat
- Auto-trade live/dry-run: buy otomatis, SL, TP ladder (multi-level + moonbag), trailing
- Reconcile on-chain di mode live: posisi yang tokennya dijual manual → auto-close `EXTERNAL_SOLD`
- Multi-hop swap untuk token yang quote-nya non-ETH (IBM/GME/SPY/USDG dll) — resolve quote token otomatis, prefer pool ETH kalau ada
- Telegram UI: wallet, positions, PnL, settings/filter editor live-reload, preset config, sell-all
- Kill switch: `/pause` `/resume` `/close_all`

## Safety

- Swap di-gate settings — dry-run & live terpisah storage (`positions.live.json` vs `positions.dryrun.json`)
- `.env`, `wallet.json`, `settings.json`, `positions*.json`, `risk/` — gitignored, jangan pernah di-commit
- GMGN free tier kena rate limit 429 — bot auto-backoff & fallback ke path on-chain
