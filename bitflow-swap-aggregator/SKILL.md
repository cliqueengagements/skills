---
name: bitflow-swap-aggregator
description: "Executes Bitflow aggregator swaps with route quotes, explicit confirmation, and proof-ready transaction output."
metadata:
  author: "macbotmini-eng"
  author-agent: "Hex Stallion"
  user-invocable: "false"
  arguments: "doctor | tokens | quote | plan | run"
  entry: "bitflow-swap-aggregator/bitflow-swap-aggregator.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# Bitflow Swap Aggregator

## What it does

`bitflow-swap-aggregator` quotes, plans, and executes swaps through Bitflow's aggregator route surface. `quote` and `plan` ask Bitflow's own quote service (the one the Bitflow app uses) for the route and the swap call; `run` resolves tokens from the live Bitflow token registry, asks the Bitflow SDK for the best executable route, prepares the swap call, and broadcasts the transaction only after explicit confirmation.

## Why agents need it

Autonomous strategies need a general Bitflow swap primitive that does not force one pool family. This skill gives higher-level controllers a route-aware swap leg that can choose the aggregator's current best supported route and return proof-ready execution details.

## Safety notes

- This is a write skill and can move wallet funds.
- Mainnet only.
- `run` refuses without `--confirm=SWAP`.
- The skill uses `PostConditionMode.Deny` with the postconditions produced by Bitflow's swap preparation path.
- The skill checks input balance, STX gas reserve, pending transaction depth, signer match, route availability, and mined transaction status.
- The skill blocks if the mined transaction status is not `success`.

## Commands

### doctor

Checks dependency readiness, Bitflow SDK access, live token registry access, Hiro reachability, and optional wallet readiness.

```bash
bun run bitflow-swap-aggregator/bitflow-swap-aggregator.ts doctor --wallet <stacks-address>
```

### tokens

Lists live Bitflow tokens and optionally filters by symbol, token ID, or contract ID.

```bash
bun run bitflow-swap-aggregator/bitflow-swap-aggregator.ts tokens --search stx
```

### quote

Fetches the current Bitflow aggregator quote and best route.

```bash
bun run bitflow-swap-aggregator/bitflow-swap-aggregator.ts quote --wallet <stacks-address> --token-in USDCx --token-out USDh --amount-in 1
```

### plan

Prepares the executable swap call and reports the contract/function, route, postconditions, balances, and safety gates without broadcasting.

It also returns `data.instructions`: an unsigned `call_contract` instruction with typed Clarity arguments and explicit deny mode post-conditions, so an agent that never holds the wallet's key can hand the owner the exact transaction to sign in their own wallet.

`plan` and `quote` take their quote and swap call from Bitflow's own quote service (`https://bff.bitflowapis.finance/api/quotes/v1`, the one the Bitflow app uses) and check it before handing it on: it must spend exactly the amount asked, cap that token at that amount, and carry one positive minimum on the token received, and nothing else may leave the wallet. Every swap goes through ONE pool that holds both tokens: of the routes the service lists, the best single-pool one is taken, and a pair with no such pool is refused (`NO_SINGLE_POOL`). A chained route would pass the in-between token through the wallet with only "at least 0" on it, which leaves every unit of that token movable. They do not use the SDK's route quote, which reads a pool's error code as a price (measured 2026-09-11: USDCx to USDh quoted 0.00006014 USDh for any input). Tokens are matched exactly, by contract id or symbol. STX is supported: Bitflow lists it under its wrapper contract, and it leaves the wallet as native STX under an STX post-condition. `run` still prepares its swap through the SDK.

```bash
bun run bitflow-swap-aggregator/bitflow-swap-aggregator.ts plan --wallet <stacks-address> --token-in USDCx --token-out USDh --amount-in 1
```

### run

Re-runs fresh quote and preparation checks, resolves the signer, broadcasts the Bitflow aggregator swap, waits for status, and returns proof-ready JSON.

```bash
bun run bitflow-swap-aggregator/bitflow-swap-aggregator.ts run --wallet <stacks-address> --token-in token-stx --token-out token-USDCx-auto --amount-in 1 --confirm=SWAP
```

## Output contract

Every command prints exactly one JSON object to stdout.

Success:

```json
{ "status": "success", "action": "plan", "data": {}, "error": null }
```

Blocked:

```json
{
  "status": "blocked",
  "action": "run",
  "data": {},
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "This write skill requires --confirm=SWAP.",
    "next": "Re-run with --confirm=SWAP after reviewing plan output."
  }
}
```

## Known constraints

- `quote` and `plan` use Bitflow's quote service; `run` uses Bitflow's SDK-supported aggregator route surface.
- `quote` and `plan` use single-pool routes only; `plan` builds through `dlmm-swap-router-v-1-1` only.
- Does not force HODLMM-only execution.
- Does not implement custom direct-pool HODLMM swap calls.
- Does not perform DCA scheduling, keeper orders, LP deposits, LP withdrawals, Zest writes, or controller checkpointing.
- Requires the wallet to already hold the selected input asset.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @macbotmini-eng
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/577
