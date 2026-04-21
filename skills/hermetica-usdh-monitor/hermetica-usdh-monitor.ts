#!/usr/bin/env bun
/**
 * Hermetica USDh Monitor
 * Monitors Hermetica USDh staking vault on Stacks mainnet: exchange rate,
 * staking state, supply metrics, user position, and HODLMM yield comparison.
 *
 * Self-contained: uses Hermetica on-chain contracts (via Hiro API) + Bitflow
 * HODLMM App API for yield comparison. No external oracles.
 *
 * Usage:
 *   bun run hermetica-usdh-monitor/hermetica-usdh-monitor.ts doctor
 *   bun run hermetica-usdh-monitor/hermetica-usdh-monitor.ts install-packs
 *   bun run hermetica-usdh-monitor/hermetica-usdh-monitor.ts run
 *   bun run hermetica-usdh-monitor/hermetica-usdh-monitor.ts run --wallet <STX_ADDRESS>
 *
 * Output: strict JSON { status, action, data, error }
 */

import { Command }      from "commander";
import { homedir }      from "os";
import { join }         from "path";
import { readFileSync, writeFileSync } from "fs";

// ── Constants ──────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS    = 30_000;
const EXCHANGE_RATE_SCALE = 100_000_000n;  // 1e8 — Hermetica's internal precision
const USDH_DECIMALS       = 8;
const HIRO_API            = "https://api.mainnet.hiro.so";
const BITFLOW_APP_API     = "https://bff.bitflowapis.finance";
const HERMETICA           = "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG";
const STATE_FILE          = join(homedir(), ".hermetica-usdh-state.json");
const NULL_SENDER         = "SP000000000000000000002Q6VF78";

// ── Contract IDs ───────────────────────────────────────────────────────────────
const C = {
  STAKING:       `${HERMETICA}.staking-v1`,
  STAKING_STATE: `${HERMETICA}.staking-state-v1`,
  STAKING_SILO:  `${HERMETICA}.staking-silo-v1-1`,
  USDH:          `${HERMETICA}.usdh-token-v1`,
  SUSDH:         `${HERMETICA}.susdh-token-v1`,
} as const;

// ── FT token identifiers for Hiro balance lookup ──────────────────────────────
const TOKEN_USDH  = `${HERMETICA}.usdh-token-v1::usdh`;
const TOKEN_SUSDH = `${HERMETICA}.susdh-token-v1::susdh`;

// ── Types ──────────────────────────────────────────────────────────────────────
interface CallReadResponse {
  okay:   boolean;
  result: string;
}

interface HiroFtEntry { balance: string }
interface HiroBalances { fungible_tokens?: Record<string, HiroFtEntry> }

interface AppPoolToken  { priceUsd: number; decimals: number }
interface AppPool {
  poolId:      string;
  apr24h:      number;
  tvlUsd:      number;
  volumeUsd1d: number;
  tokens: { tokenX: AppPoolToken; tokenY: AppPoolToken };
}
interface AppPoolsResponse { data?: AppPool[] }

interface MonitorState {
  last_run_at:        string;   // ISO timestamp
  last_exchange_rate: string;   // bigint stored as decimal string
}

interface CheckResult { name: string; ok: boolean; detail: string }

// ── Clarity value decoder ──────────────────────────────────────────────────────
function decodeUint128(hex: string): bigint {
  let h = hex.replace(/^0x/, "");
  if (h.startsWith("07")) h = h.slice(2);   // unwrap (response ok …)
  if (h.startsWith("08")) throw new Error("Contract returned error response");
  if (h.startsWith("01")) h = h.slice(2);   // strip uint128 type tag
  return BigInt("0x" + h.padStart(32, "0"));
}

function decodeBool(hex: string): boolean {
  const h = hex.replace(/^0x/, "");
  if (h === "03") return true;
  if (h === "04") return false;
  throw new Error(`Cannot decode bool from: ${hex}`);
}

// ── State helpers ──────────────────────────────────────────────────────────────
function readState(): Partial<MonitorState> {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) as MonitorState; }
  catch { return {}; }
}

function writeState(s: MonitorState): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

// ── Fetch helpers ──────────────────────────────────────────────────────────────
async function fetchJson<T>(url: string): Promise<T> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal:  ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "bff-skills/hermetica-usdh-monitor" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally { clearTimeout(timer); }
}

async function fetchPostJson<T>(url: string, body: unknown): Promise<T> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method:  "POST",
      signal:  ctrl.signal,
      headers: {
        Accept:         "application/json",
        "Content-Type": "application/json",
        "User-Agent":   "bff-skills/hermetica-usdh-monitor",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally { clearTimeout(timer); }
}

// ── Contract call helper ───────────────────────────────────────────────────────
async function callReadOnly(contractId: string, fn: string, args: string[] = []): Promise<string> {
  const [addr, name] = contractId.split(".");
  const url  = `${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${fn}`;
  const data = await fetchPostJson<CallReadResponse>(url, { sender: NULL_SENDER, arguments: args });
  if (!data.okay) throw new Error(`Contract call failed: ${contractId}::${fn}`);
  return data.result;
}

// ── Protocol data fetchers ─────────────────────────────────────────────────────
async function fetchExchangeRate(): Promise<bigint> {
  return decodeUint128(await callReadOnly(C.STAKING, "get-usdh-per-susdh"));
}

async function fetchStakingEnabled(): Promise<boolean> {
  return decodeBool(await callReadOnly(C.STAKING_STATE, "get-staking-enabled"));
}

async function fetchCooldownWindow(): Promise<bigint> {
  return decodeUint128(await callReadOnly(C.STAKING_STATE, "get-cooldown-window"));
}

async function fetchUsdhSupply(): Promise<bigint> {
  return decodeUint128(await callReadOnly(C.USDH, "get-total-supply"));
}

async function fetchSusdhSupply(): Promise<bigint> {
  return decodeUint128(await callReadOnly(C.SUSDH, "get-total-supply"));
}

async function fetchCurrentSiloTs(): Promise<bigint | null> {
  try { return decodeUint128(await callReadOnly(C.STAKING_SILO, "get-current-ts")); }
  catch { return null; }
}

async function fetchUserBalances(wallet: string): Promise<{ usdh: bigint; susdh: bigint }> {
  const data = await fetchJson<HiroBalances>(
    `${HIRO_API}/extended/v1/address/${wallet}/balances`,
  );
  const ft    = data.fungible_tokens ?? {};
  const usdh  = BigInt(ft[TOKEN_USDH]?.balance  ?? "0");
  const susdh = BigInt(ft[TOKEN_SUSDH]?.balance ?? "0");
  return { usdh, susdh };
}

async function fetchHodlmmApr(): Promise<number | null> {
  try {
    const data = await fetchJson<AppPoolsResponse>(`${BITFLOW_APP_API}/api/app/v1/pools`);
    const pool = (data.data ?? []).find((p) => p.poolId === "dlmm_1");
    return pool?.apr24h ?? null;
  } catch { return null; }
}

// ── Maths ──────────────────────────────────────────────────────────────────────
function toDecimal(raw: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const int   = raw / scale;
  const frac  = raw % scale;
  return parseFloat(`${int}.${frac.toString().padStart(decimals, "0")}`);
}

function accumulatedYieldPct(rate: bigint): number {
  return parseFloat(((Number(rate) / Number(EXCHANGE_RATE_SCALE) - 1) * 100).toFixed(4));
}

function estimateApy(current: bigint, prev: bigint, elapsedMs: number): number | null {
  if (elapsedMs < 3_600_000) return null;        // need ≥ 1h of data
  if (current <= prev)       return null;        // no change recorded yet
  const delta  = Number(current - prev) / Number(EXCHANGE_RATE_SCALE);
  const annPct = delta * ((365 * 24 * 3600) / (elapsedMs / 1000)) * 100;
  return parseFloat(annPct.toFixed(2));
}

// ── Commands ───────────────────────────────────────────────────────────────────
async function doctor(): Promise<void> {
  const checks: CheckResult[] = [];

  // 1. staking-v1 — exchange rate
  try {
    const rate = await fetchExchangeRate();
    const hr   = toDecimal(rate, USDH_DECIMALS);
    checks.push({ name: "Hermetica staking-v1", ok: true,
      detail: `exchange rate: ${hr.toFixed(8)} USDh/sUSDh` });
  } catch (e) {
    checks.push({ name: "Hermetica staking-v1", ok: false, detail: String(e) });
  }

  // 2. staking-state-v1 — enabled + cooldown
  try {
    const [enabled, cooldown] = await Promise.all([
      fetchStakingEnabled(),
      fetchCooldownWindow(),
    ]);
    const days = (Number(cooldown) / 86_400).toFixed(1);
    checks.push({ name: "Hermetica staking-state-v1", ok: true,
      detail: `staking enabled: ${enabled}, cooldown: ${days} days` });
  } catch (e) {
    checks.push({ name: "Hermetica staking-state-v1", ok: false, detail: String(e) });
  }

  // 3. USDh + sUSDh token contracts
  try {
    const [usdhSup, susdhSup] = await Promise.all([
      fetchUsdhSupply(),
      fetchSusdhSupply(),
    ]);
    const u = toDecimal(usdhSup, USDH_DECIMALS).toLocaleString("en-US",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const s = toDecimal(susdhSup, USDH_DECIMALS).toLocaleString("en-US",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    checks.push({ name: "Hermetica token contracts (USDh + sUSDh)", ok: true,
      detail: `USDh supply: $${u}, sUSDh: ${s}` });
  } catch (e) {
    checks.push({ name: "Hermetica token contracts (USDh + sUSDh)", ok: false, detail: String(e) });
  }

  // 4. Bitflow HODLMM App API — yield comparison source
  try {
    const apr = await fetchHodlmmApr();
    if (apr === null) throw new Error("dlmm_1 not found in pool list");
    checks.push({ name: "Bitflow HODLMM App API (yield comparison)", ok: true,
      detail: `dlmm_1 APR: ${apr.toFixed(2)}%` });
  } catch (e) {
    checks.push({ name: "Bitflow HODLMM App API (yield comparison)", ok: false, detail: String(e) });
  }

  const allOk = checks.every((c) => c.ok);
  console.log(JSON.stringify({
    status:  allOk ? "ok" : "degraded",
    checks,
    message: allOk
      ? "All data sources reachable. Ready to run."
      : "Some sources unavailable — yield comparison may be incomplete.",
  }, null, 2));
}

async function installPacks(): Promise<void> {
  console.log(JSON.stringify({
    status:  "ok",
    message: "No packs required. hermetica-usdh-monitor uses Hermetica contracts and Hiro public APIs only.",
    data:    { requires: [] },
  }, null, 2));
}

async function run(wallet?: string): Promise<void> {
  try {
    // ── Parallel fetch ─────────────────────────────────────────────────────
    const [rate, enabled, cooldownSecs, usdhSup, susdhSup, hodlmmApr, siloTs] =
      await Promise.all([
        fetchExchangeRate(),
        fetchStakingEnabled(),
        fetchCooldownWindow(),
        fetchUsdhSupply(),
        fetchSusdhSupply(),
        fetchHodlmmApr(),
        fetchCurrentSiloTs(),
      ]);

    // ── User position ──────────────────────────────────────────────────────
    let userUsdh:  bigint | null = null;
    let userSusdh: bigint | null = null;
    if (wallet) {
      const bal = await fetchUserBalances(wallet);
      userUsdh  = bal.usdh;
      userSusdh = bal.susdh;
    }

    // ── APY tracking via local state ───────────────────────────────────────
    const prev   = readState();
    const nowIso = new Date().toISOString();
    let apyPct: number | null = null;
    if (prev.last_exchange_rate && prev.last_run_at) {
      const prevRate  = BigInt(prev.last_exchange_rate);
      const elapsedMs = Date.now() - new Date(prev.last_run_at).getTime();
      apyPct = estimateApy(rate, prevRate, elapsedMs);
    }
    writeState({ last_run_at: nowIso, last_exchange_rate: rate.toString() });

    // ── Derived metrics ────────────────────────────────────────────────────
    const rateHuman        = toDecimal(rate, USDH_DECIMALS);
    const usdhHuman        = toDecimal(usdhSup, USDH_DECIMALS);
    const susdhHuman       = toDecimal(susdhSup, USDH_DECIMALS);
    const stakingRatioPct  = usdhHuman > 0
      ? parseFloat(((susdhHuman / usdhHuman) * 100).toFixed(2))
      : 0;
    const accYield         = accumulatedYieldPct(rate);
    const cooldownDays     = parseFloat((Number(cooldownSecs) / 86_400).toFixed(1));

    // ── User metrics ───────────────────────────────────────────────────────
    const userUsdhHuman    = userUsdh  !== null ? toDecimal(userUsdh, USDH_DECIMALS)  : null;
    const userSusdhHuman   = userSusdh !== null ? toDecimal(userSusdh, USDH_DECIMALS) : null;
    // sUSDh value in USDh = susdh_amount * exchange_rate / EXCHANGE_RATE_SCALE
    const userSusdhValRaw  = (userSusdh !== null)
      ? (userSusdh * rate) / EXCHANGE_RATE_SCALE
      : null;
    const userSusdhValue   = userSusdhValRaw !== null
      ? toDecimal(userSusdhValRaw, USDH_DECIMALS)
      : null;

    // ── Yield comparison ───────────────────────────────────────────────────
    let yieldComparison: string | null = null;
    if (hodlmmApr !== null) {
      if (apyPct !== null) {
        yieldComparison = apyPct >= hodlmmApr
          ? `USDh staking (${apyPct.toFixed(2)}% APY) ≥ HODLMM dlmm_1 (${hodlmmApr.toFixed(2)}% APR)`
          : `HODLMM dlmm_1 (${hodlmmApr.toFixed(2)}% APR) > USDh staking (${apyPct.toFixed(2)}% APY)`;
      } else {
        yieldComparison =
          `HODLMM dlmm_1 APR: ${hodlmmApr.toFixed(2)}% | USDh staking APY: tracking started — check again in ≥1h`;
      }
    }

    // ── Refusal / warning conditions ───────────────────────────────────────
    const refusalReasons: string[] = [];
    if (!enabled) refusalReasons.push("staking is currently disabled by protocol");

    // ── Recommendation ─────────────────────────────────────────────────────
    let action: string;
    if (!enabled) {
      action = "HOLD — staking disabled. Do not stake until protocol re-enables it.";
    } else if (userUsdh !== null && userUsdh > 0n && (userSusdh === null || userSusdh === 0n)) {
      action = `STAKE — ${userUsdhHuman?.toFixed(2)} USDh idle. Stake to earn funding-rate yield. Unstake cooldown: ${cooldownDays} days.`;
    } else if (userSusdh !== null && userSusdh > 0n) {
      action = `HOLD — ${userSusdhHuman?.toFixed(2)} sUSDh staked (~$${userSusdhValue?.toFixed(2)} USDh). Yield accruing via funding-rate settlements.`;
    } else {
      action = `CHECK — staking enabled, protocol healthy. Provide --wallet to check position.`;
    }

    console.log(JSON.stringify({
      status: "success",
      action,
      data: {
        staking_enabled:        enabled,
        exchange_rate:          parseFloat(rateHuman.toFixed(8)),
        exchange_rate_raw:      rate.toString(),
        accumulated_yield_pct:  accYield,
        estimated_apy_pct:      apyPct,
        cooldown_days:          cooldownDays,
        usdh_total_supply:      parseFloat(usdhHuman.toFixed(2)),
        susdh_total_supply:     parseFloat(susdhHuman.toFixed(2)),
        staking_ratio_pct:      stakingRatioPct,
        hodlmm_apr_pct:         hodlmmApr,
        yield_comparison:       yieldComparison,
        user_usdh:              userUsdhHuman !== null ? parseFloat(userUsdhHuman.toFixed(2)) : null,
        user_susdh:             userSusdhHuman !== null ? parseFloat(userSusdhHuman.toFixed(2)) : null,
        user_susdh_value_usdh:  userSusdhValue !== null ? parseFloat(userSusdhValue.toFixed(2)) : null,
        refusal_reasons:        refusalReasons.length > 0 ? refusalReasons : null,
        silo_epoch_ts:          siloTs !== null ? Number(siloTs) : null,
        deployer:               HERMETICA,
      },
      error: null,
    }, null, 2));

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      status: "error",
      action: `Error: ${msg}`,
      data:   null,
      error:  { code: "FETCH_ERROR", message: msg, next: "Check network connectivity and retry." },
    }, null, 2));
    process.exit(1);
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────────
const program = new Command();
program
  .name("hermetica-usdh-monitor")
  .description("Monitor Hermetica USDh staking vault on Stacks mainnet");

program
  .command("doctor")
  .description("Check all data sources are reachable")
  .action(() => doctor().catch((e: unknown) => { console.error(e); process.exit(1); }));

program
  .command("install-packs")
  .description("Install required skill packs")
  .option("--pack <pack>")
  .action(() => installPacks());

program
  .command("run")
  .description("Check USDh staking state and output JSON recommendation")
  .option("--wallet <address>", "STX address to check position for")
  .action((opts: { wallet?: string }) =>
    run(opts.wallet).catch((e: unknown) => { console.error(e); process.exit(1); }),
  );

program.parse(process.argv);
