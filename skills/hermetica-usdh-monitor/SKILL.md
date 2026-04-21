---
name: hermetica-usdh-monitor
description: "Monitors Hermetica USDh staking vault on Stacks mainnet. Reads exchange rate, staking state, supply metrics, and user position from on-chain contracts. Compares USDh staking APY against Bitflow HODLMM yield and outputs a STAKE / HOLD / CHECK recommendation. Read-only — all stake/unstake actions require human approval."
metadata:
  author: cliqueengagements
  author-agent: "LAB Bounty Scout — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY"
  user-invocable: "true"
  arguments: "doctor | install-packs | run [--wallet <STX_ADDRESS>]"
  entry: "hermetica-usdh-monitor/hermetica-usdh-monitor.ts"
  requires: ""
  tags: "defi, hermetica, usdh, staking, hodlmm, read-only, mainnet-only, l2"
---

# Hermetica USDh Monitor

Monitors the Hermetica USDh staking vault on Stacks mainnet, tracking exchange rate, supply metrics, user position, and comparing yield against Bitflow HODLMM — all from live on-chain data.

## What it does

Queries five Hermetica mainnet contracts to fetch the live USDh→sUSDh exchange rate, staking enabled state, cooldown window, total USDh/sUSDh supply, and user position balances. Tracks the exchange rate in a local state file to estimate APY from ratio changes over time. Compares USDh staking yield against the live Bitflow HODLMM dlmm_1 APR for cross-protocol yield context. All price and yield data is sourced directly from Hermetica contracts and Bitflow App API — no external oracles.

## Why agents need it

USDh staking yield comes from options funding-rate settlements that update the `usdh-per-susdh` exchange rate. Without a monitor, agents cannot tell whether staking is open, what the current yield is, or whether their idle USDh should be staked. This skill closes that gap with a safe, read-only check.

## Safety notes

- **Read-only.** No transactions are submitted. Any stake/unstake requires explicit human approval.
- **Mainnet-only.** Hermetica contracts are deployed on Stacks mainnet only.
- Refuses to recommend STAKE if staking is disabled by the protocol.
- Unstake cooldown is 7 days — reported on every run so agents can plan withdrawals.
- All price data sourced from Hermetica contracts and Hiro/Bitflow public APIs — no external oracles.

## Commands

### doctor

Checks all data sources: staking-v1, staking-state-v1, USDh + sUSDh token contracts, and Bitflow HODLMM App API.

```bash
bun run hermetica-usdh-monitor/hermetica-usdh-monitor.ts doctor
```

### install-packs

No additional packs required — uses Hermetica contracts via Hiro public API and Bitflow App API directly.

```bash
bun run hermetica-usdh-monitor/hermetica-usdh-monitor.ts install-packs
```

### run

Fetches live vault state. Pass `--wallet` to check a specific position.

```bash
# Pool-only check (no position)
bun run hermetica-usdh-monitor/hermetica-usdh-monitor.ts run

# Full check with wallet
bun run hermetica-usdh-monitor/hermetica-usdh-monitor.ts run --wallet SP1234...
```

## Live terminal output

### doctor (all 4 sources reachable)

```json
{
  "status": "ok",
  "checks": [
    { "name": "Hermetica staking-v1",                      "ok": true, "detail": "exchange rate: 1.00000000 USDh/sUSDh" },
    { "name": "Hermetica staking-state-v1",                "ok": true, "detail": "staking enabled: true, cooldown: 7.0 days" },
    { "name": "Hermetica token contracts (USDh + sUSDh)",  "ok": true, "detail": "USDh supply: $9,049,413.13, sUSDh: 1,836,203.38" },
    { "name": "Bitflow HODLMM App API (yield comparison)", "ok": true, "detail": "dlmm_1 APR: 17.72%" }
  ],
  "message": "All data sources reachable. Ready to run."
}
```

### run (no wallet — pool-only check)

```json
{
  "status": "success",
  "action": "CHECK — staking enabled, protocol healthy. Provide --wallet to check position.",
  "data": {
    "staking_enabled": true,
    "exchange_rate": 1,
    "exchange_rate_raw": "100000000",
    "accumulated_yield_pct": 0,
    "estimated_apy_pct": null,
    "cooldown_days": 7,
    "usdh_total_supply": 9049413.13,
    "susdh_total_supply": 1836203.38,
    "staking_ratio_pct": 20.29,
    "hodlmm_apr_pct": 17.72,
    "yield_comparison": "HODLMM dlmm_1 APR: 17.72% | USDh staking APY: tracking started — check again in ≥1h",
    "user_usdh": null,
    "user_susdh": null,
    "user_susdh_value_usdh": null,
    "refusal_reasons": null,
    "silo_epoch_ts": 1774651801,
    "deployer": "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG"
  },
  "error": null
}
```

### run --wallet (wallet has no USDh position)

```json
{
  "status": "success",
  "action": "CHECK — staking enabled, protocol healthy. Provide --wallet to check position.",
  "data": {
    "staking_enabled": true,
    "exchange_rate": 1,
    "exchange_rate_raw": "100000000",
    "accumulated_yield_pct": 0,
    "estimated_apy_pct": null,
    "cooldown_days": 7,
    "usdh_total_supply": 9049413.13,
    "susdh_total_supply": 1836203.38,
    "staking_ratio_pct": 20.29,
    "hodlmm_apr_pct": 17.72,
    "yield_comparison": "HODLMM dlmm_1 APR: 17.72% | USDh staking APY: tracking started — check again in ≥1h",
    "user_usdh": 0,
    "user_susdh": 0,
    "user_susdh_value_usdh": 0,
    "refusal_reasons": null,
    "silo_epoch_ts": 1774651783,
    "deployer": "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG"
  },
  "error": null
}
```

### run --wallet (wallet has idle USDh — STAKE recommended)

```json
{
  "status": "success",
  "action": "STAKE — 500.00 USDh idle. Stake to earn funding-rate yield. Unstake cooldown: 7.0 days.",
  "data": {
    "staking_enabled": true,
    "exchange_rate": 1.00012345,
    "exchange_rate_raw": "100012345",
    "accumulated_yield_pct": 0.0123,
    "estimated_apy_pct": 4.51,
    "cooldown_days": 7,
    "usdh_total_supply": 9049413.13,
    "susdh_total_supply": 1836203.38,
    "staking_ratio_pct": 20.29,
    "hodlmm_apr_pct": 17.72,
    "yield_comparison": "HODLMM dlmm_1 APR: 17.72% > USDh staking (4.51% APY)",
    "user_usdh": 500.00,
    "user_susdh": 0,
    "user_susdh_value_usdh": 0,
    "refusal_reasons": null,
    "silo_epoch_ts": 1774651801,
    "deployer": "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG"
  },
  "error": null
}
```

## Output contract

All outputs are strict JSON to stdout.

| Field | Type | Description |
|---|---|---|
| `status` | `"success" \| "error"` | Overall result |
| `action` | `string` | `STAKE`, `HOLD`, `CHECK`, or error description |
| `data.staking_enabled` | `boolean` | Whether protocol allows staking |
| `data.exchange_rate` | `number` | USDh per sUSDh (human-readable) |
| `data.exchange_rate_raw` | `string` | Raw uint128 as decimal string |
| `data.accumulated_yield_pct` | `number` | Yield since genesis: `(rate/1e8 - 1) × 100` |
| `data.estimated_apy_pct` | `number \| null` | APY from local state tracking; `null` if < 1h of data |
| `data.cooldown_days` | `number` | Protocol unstake cooldown in days |
| `data.usdh_total_supply` | `number` | Total USDh in circulation |
| `data.susdh_total_supply` | `number` | Total sUSDh staked |
| `data.staking_ratio_pct` | `number` | `sUSDh / USDh × 100` |
| `data.hodlmm_apr_pct` | `number \| null` | Bitflow dlmm_1 24h APR for comparison |
| `data.yield_comparison` | `string \| null` | Human-readable USDh APY vs HODLMM APR |
| `data.user_usdh` | `number \| null` | Wallet's unstaked USDh balance |
| `data.user_susdh` | `number \| null` | Wallet's sUSDh balance |
| `data.user_susdh_value_usdh` | `number \| null` | sUSDh converted to USDh at current rate |
| `data.refusal_reasons` | `string[] \| null` | Why STAKE is blocked (if any) |
| `data.silo_epoch_ts` | `number \| null` | Current Unix timestamp from staking silo |
| `data.deployer` | `string` | Hermetica deployer address |
| `error` | `null \| object` | Present on error with `code`, `message`, `next` |

## Data sources

| Source | Data | Contract / Endpoint |
|---|---|---|
| Hermetica staking-v1 | Exchange rate (USDh per sUSDh) | `SPN5AK…HSG.staking-v1::get-usdh-per-susdh` |
| Hermetica staking-state-v1 | Staking enabled, cooldown window | `SPN5AK…HSG.staking-state-v1::get-staking-enabled`, `::get-cooldown-window` |
| Hermetica staking-silo-v1-1 | Current epoch timestamp | `SPN5AK…HSG.staking-silo-v1-1::get-current-ts` |
| Hermetica usdh-token-v1 | Total USDh supply, user balance | `SPN5AK…HSG.usdh-token-v1::get-total-supply` |
| Hermetica susdh-token-v1 | Total sUSDh supply, user balance | `SPN5AK…HSG.susdh-token-v1::get-total-supply` |
| Hiro Address API | User FT balances (USDh, sUSDh) | `api.mainnet.hiro.so/extended/v1/address/{addr}/balances` |
| Bitflow HODLMM App API | HODLMM dlmm_1 APR (yield comparison) | `bff.bitflowapis.finance/api/app/v1/pools` |
