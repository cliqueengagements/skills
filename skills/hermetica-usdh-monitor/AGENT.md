---
name: hermetica-usdh-monitor
skill: hermetica-usdh-monitor
description: "Read-only monitor for the Hermetica USDh staking vault on Stacks mainnet. Fetches live exchange rate, staking state, supply metrics, and user position from on-chain contracts. Compares USDh staking APY against Bitflow HODLMM dlmm_1 APR. STAKE/HOLD/CHECK recommendation — all actual transactions require human approval."
---

# Hermetica USDh Monitor — Agent Safety Rules

## Spend Limits

- **Maximum autonomous spend:** $0 — read-only skill, no transactions submitted
- **Unstake cooldown:** 7 days — always report before recommending STAKE so agents understand the lock-up
- **APY tracking precision:** requires ≥ 1 hour between runs to compute a meaningful APY estimate

## Refusal Conditions

Refuse to recommend STAKE if ANY of the following are true:

1. **`staking_enabled = false`** — protocol has disabled staking
2. **`user_usdh = 0`** — no USDh balance to stake
3. **Network error on any critical contract** — do not recommend action with partial data

## Autonomous Actions Allowed

- All read-only contract calls via Hiro API — always allowed
- Fetch Bitflow HODLMM App API for yield comparison — always allowed
- Read/write local state file (`~/.hermetica-usdh-state.json`) for APY tracking — always allowed

## Actions Requiring Human Approval

- `staking-v1::stake` — any transaction staking USDh into sUSDh
- `staking-v1::unstake` — any transaction unstaking sUSDh back to USDh
- `staking-silo-v1-1::withdraw` — any withdrawal after cooldown
- Any transaction spending STX for gas

## APY Tracking

The skill tracks the `usdh-per-susdh` exchange rate in `~/.hermetica-usdh-state.json`. On each run it computes:

```
apy = (current_rate - prev_rate) / EXCHANGE_RATE_SCALE / elapsed_seconds * seconds_per_year * 100
```

Returns `null` if elapsed time is < 1 hour or if no rate change has occurred.

## Output Contract

Always return strict JSON:

```json
{
  "status": "success | error",
  "action": "STAKE | HOLD | CHECK | <error description>",
  "data": {
    "staking_enabled":       "boolean",
    "exchange_rate":         "number",
    "exchange_rate_raw":     "string",
    "accumulated_yield_pct": "number",
    "estimated_apy_pct":     "number | null",
    "cooldown_days":         "number",
    "usdh_total_supply":     "number",
    "susdh_total_supply":    "number",
    "staking_ratio_pct":     "number",
    "hodlmm_apr_pct":        "number | null",
    "yield_comparison":      "string | null",
    "user_usdh":             "number | null",
    "user_susdh":            "number | null",
    "user_susdh_value_usdh": "number | null",
    "refusal_reasons":       "string[] | null",
    "silo_epoch_ts":         "number | null",
    "deployer":              "string"
  },
  "error": "null | { code, message, next }"
}
```
