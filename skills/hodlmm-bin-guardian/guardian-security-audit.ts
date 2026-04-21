#!/usr/bin/env bun
/**
 * HODLMM Bin Guardian — Security Audit & Drain Simulation Suite
 * Tests all known drain vectors against the guardian's safety measures.
 * Output: JSON audit report with PASS/FAIL per vector.
 */

// ── Safety constants (must match AGENT.md) ──────────────────────────────────
const MIN_24H_VOLUME_USD = 10_000;
const MAX_SLIPPAGE = 0.005;        // 0.5%
const MAX_STX_PER_TX = 50;         // STX
const COOLDOWN_HOURS = 4;

// ── Guardian core logic (inlined for isolated testing) ──────────────────────

interface GuardianInput {
  volume24hUsd: number;
  liquidityUsd: number;
  slippage: number;
  stxAmount: number;
  activeBinId: number;
  lastRebalanceHoursAgo: number;
  poolId: string;
  volume7dUsd?: number;
  feeBps?: number;
}

interface GuardianDecision {
  allow: boolean;
  refusal_reason?: string;
  in_range: boolean;
  current_apr: string;
  recommendation: string;
}

function estimateApr(liquidityUsd: number, volume7dUsd: number, feeBps: number): string {
  if (liquidityUsd <= 0 || volume7dUsd <= 0 || !isFinite(liquidityUsd) || !isFinite(volume7dUsd)) return "N/A";
  const annualizedVolume = volume7dUsd * (365 / 7);
  const annualFeeRevenue = annualizedVolume * (feeBps / 10_000);
  const apr = (annualFeeRevenue / liquidityUsd) * 100;
  if (!isFinite(apr)) return "N/A";
  return `${apr.toFixed(2)}%`;
}

function runGuardian(input: GuardianInput): GuardianDecision {
  const inRange = input.activeBinId > 0 && isFinite(input.activeBinId);

  // --- Safety gate checks (NaN-safe) ---
  if (!isFinite(input.volume24hUsd) || isNaN(input.volume24hUsd) || input.volume24hUsd < MIN_24H_VOLUME_USD) {
    return { allow: false, refusal_reason: `24h volume $${input.volume24hUsd} < $${MIN_24H_VOLUME_USD} threshold`, in_range: inRange, current_apr: "N/A", recommendation: "HOLD — low volume refusal" };
  }
  if (!isFinite(input.slippage) || isNaN(input.slippage) || input.slippage > MAX_SLIPPAGE) {
    return { allow: false, refusal_reason: `Slippage ${isNaN(input.slippage) ? "NaN" : (input.slippage * 100).toFixed(2) + "%"} exceeds 0.5% cap`, in_range: inRange, current_apr: "N/A", recommendation: "HOLD — slippage refusal" };
  }
  if (!isFinite(input.stxAmount) || isNaN(input.stxAmount) || input.stxAmount < 0 || input.stxAmount > MAX_STX_PER_TX) {
    return { allow: false, refusal_reason: `STX amount ${input.stxAmount} invalid or exceeds 50 STX cap`, in_range: inRange, current_apr: "N/A", recommendation: "HOLD — spend limit refusal" };
  }
  if (input.lastRebalanceHoursAgo < COOLDOWN_HOURS) {
    return { allow: false, refusal_reason: `Cooldown active — last rebalance ${input.lastRebalanceHoursAgo}h ago, need ${COOLDOWN_HOURS}h`, in_range: inRange, current_apr: "N/A", recommendation: "HOLD — cooldown refusal" };
  }
  if (!inRange) {
    return { allow: false, refusal_reason: `Active bin ID invalid (${input.activeBinId})`, in_range: false, current_apr: "N/A", recommendation: "HOLD — invalid bin state" };
  }
  if (input.liquidityUsd <= 0 || !isFinite(input.liquidityUsd)) {
    return { allow: false, refusal_reason: `Liquidity invalid: ${input.liquidityUsd}`, in_range: inRange, current_apr: "N/A", recommendation: "HOLD — invalid liquidity" };
  }
  if (!input.poolId || input.poolId.trim() === "") {
    return { allow: false, refusal_reason: "Empty pool ID — possible injection attempt", in_range: inRange, current_apr: "N/A", recommendation: "HOLD — invalid pool" };
  }
  // Reject non-alphanumeric pool IDs (command injection guard)
  if (!/^[a-zA-Z0-9_\-]+$/.test(input.poolId)) {
    return { allow: false, refusal_reason: `Suspicious pool ID: "${input.poolId}" — possible command injection`, in_range: inRange, current_apr: "N/A", recommendation: "HOLD — injection guard triggered" };
  }

  const apr = estimateApr(input.liquidityUsd, input.volume7dUsd ?? input.volume24hUsd * 7, input.feeBps ?? 10);

  return {
    allow: true,
    in_range: inRange,
    current_apr: apr,
    recommendation: inRange
      ? `HOLD — in range at bin ${input.activeBinId}. APR: ${apr}`
      : `REBALANCE APPROVED — out of range. Requires human sign-off.`,
  };
}

// ── Audit result types ───────────────────────────────────────────────────────

interface AuditResult {
  id: string;
  vector: string;
  description: string;
  input: GuardianInput;
  decision: GuardianDecision;
  expected_allow: boolean;
  pass: boolean;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  notes: string;
}

// ── Drain simulation scenarios ───────────────────────────────────────────────

const BASE_SAFE: GuardianInput = {
  volume24hUsd: 25_000,
  liquidityUsd: 1_430_000,
  slippage: 0.001,
  stxAmount: 30,
  activeBinId: 570,
  lastRebalanceHoursAgo: 6,
  poolId: "dlmm_1",
  volume7dUsd: 175_000,
  feeBps: 10,
};

const SCENARIOS: Array<{
  id: string;
  vector: string;
  description: string;
  input: Partial<GuardianInput>;
  expected_allow: boolean;
  severity: AuditResult["severity"];
  notes: string;
}> = [
  // ── BASELINE ──────────────────────────────────────────────────────────────
  {
    id: "S-00",
    vector: "Baseline Safe",
    description: "All conditions healthy — guardian should allow",
    input: {},
    expected_allow: true,
    severity: "INFO",
    notes: "Control case. If this fails, logic is broken.",
  },

  // ── DRAIN VECTOR 1: Low Volume ─────────────────────────────────────────────
  {
    id: "S-01",
    vector: "Low Volume Drain",
    description: "24h volume at $0 — dead pool, fees worthless, rebalance wastes gas",
    input: { volume24hUsd: 0 },
    expected_allow: false,
    severity: "HIGH",
    notes: "Rebalancing into a dead pool costs gas with zero fee return. Must refuse.",
  },
  {
    id: "S-02",
    vector: "Low Volume — Just Below Threshold",
    description: "Volume at $9,999 — 1 dollar below $10k threshold",
    input: { volume24hUsd: 9_999 },
    expected_allow: false,
    severity: "HIGH",
    notes: "Boundary test. Guardian must enforce strict < not <=.",
  },
  {
    id: "S-03",
    vector: "Low Volume — Exactly At Threshold",
    description: "Volume at exactly $10,000",
    input: { volume24hUsd: 10_000 },
    expected_allow: true,
    severity: "MEDIUM",
    notes: "Boundary test. $10k exactly should pass.",
  },

  // ── DRAIN VECTOR 2: Slippage Attack ───────────────────────────────────────
  {
    id: "S-04",
    vector: "Slippage Drain — Sandwich Attack",
    description: "Slippage at 5% — attacker sandwiched the tx",
    input: { slippage: 0.05 },
    expected_allow: false,
    severity: "CRITICAL",
    notes: "A 5% slippage on a rebalance bleeds the position. Must hard-refuse.",
  },
  {
    id: "S-05",
    vector: "Slippage — At Cap",
    description: "Slippage exactly 0.5%",
    input: { slippage: 0.005 },
    expected_allow: true,
    severity: "MEDIUM",
    notes: "Exactly at the cap. Should pass.",
  },
  {
    id: "S-06",
    vector: "Slippage — 1 Basis Point Over Cap",
    description: "Slippage at 0.51% — just above 0.5% cap",
    input: { slippage: 0.0051 },
    expected_allow: false,
    severity: "HIGH",
    notes: "Strict > enforcement — any excess over cap must refuse.",
  },
  {
    id: "S-07",
    vector: "Slippage — 100% (Full Drain)",
    description: "Slippage at 100% — entire position would be extracted",
    input: { slippage: 1.0 },
    expected_allow: false,
    severity: "CRITICAL",
    notes: "Extreme case — full loss scenario. Must refuse immediately.",
  },

  // ── DRAIN VECTOR 3: Spend Limit Breach ────────────────────────────────────
  {
    id: "S-08",
    vector: "Spend Limit — Over Cap",
    description: "Attempted 51 STX transaction — 1 over the 50 STX cap",
    input: { stxAmount: 51 },
    expected_allow: false,
    severity: "HIGH",
    notes: "Even 1 STX over cap must be refused. Strict enforcement.",
  },
  {
    id: "S-09",
    vector: "Spend Limit — Exactly At Cap",
    description: "50 STX exactly",
    input: { stxAmount: 50 },
    expected_allow: true,
    severity: "LOW",
    notes: "Exactly at the 50 STX cap. Should pass.",
  },
  {
    id: "S-10",
    vector: "Spend Limit — Massive Drain Attempt",
    description: "10,000 STX transaction attempted",
    input: { stxAmount: 10_000 },
    expected_allow: false,
    severity: "CRITICAL",
    notes: "Large spend drain attempt. Must refuse.",
  },
  {
    id: "S-11",
    vector: "Spend Limit — Negative Value",
    description: "Negative STX amount — possible underflow/bypass attempt",
    input: { stxAmount: -1 },
    expected_allow: false, // patched: stxAmount < 0 check now refuses negative values
    severity: "HIGH",
    notes: "PATCHED: negative STX now refused via stxAmount < 0 guard in NaN-safe check.",
  },

  // ── DRAIN VECTOR 4: Cooldown Bypass ───────────────────────────────────────
  {
    id: "S-12",
    vector: "Cooldown — Rapid Rebalance",
    description: "Rebalance attempted 1 minute after last (0.016h)",
    input: { lastRebalanceHoursAgo: 0.016 },
    expected_allow: false,
    severity: "HIGH",
    notes: "Rapid rebalance drains gas. Cooldown must block this.",
  },
  {
    id: "S-13",
    vector: "Cooldown — Zero (Immediate Re-entry)",
    description: "Rebalance attempted immediately (0h ago)",
    input: { lastRebalanceHoursAgo: 0 },
    expected_allow: false,
    severity: "HIGH",
    notes: "Zero cooldown — reentrancy-style drain attempt.",
  },
  {
    id: "S-14",
    vector: "Cooldown — Exactly At 4 Hours",
    description: "4h exactly since last rebalance",
    input: { lastRebalanceHoursAgo: 4 },
    expected_allow: true,
    severity: "LOW",
    notes: "Boundary test. Should pass.",
  },

  // ── DRAIN VECTOR 5: Invalid Pool / Bin State ──────────────────────────────
  {
    id: "S-15",
    vector: "Zero Active Bin",
    description: "Active bin ID is 0 — uninitialized pool state",
    input: { activeBinId: 0 },
    expected_allow: false,
    severity: "CRITICAL",
    notes: "Bin ID 0 means uninitialized or drained pool. Must refuse.",
  },
  {
    id: "S-16",
    vector: "Negative Bin ID",
    description: "Active bin ID is -1 — impossible state, possible spoofed data",
    input: { activeBinId: -1 },
    expected_allow: false,
    severity: "CRITICAL",
    notes: "Negative bin is physically impossible — spoofed/corrupted data. Must refuse.",
  },
  {
    id: "S-17",
    vector: "Infinite Bin ID",
    description: "Active bin ID is Infinity — overflow/injection",
    input: { activeBinId: Infinity },
    expected_allow: false,
    severity: "CRITICAL",
    notes: "Infinite bin triggers Infinity check in isFinite guard.",
  },
  {
    id: "S-18",
    vector: "NaN Bin ID",
    description: "Active bin ID is NaN — malformed data",
    input: { activeBinId: NaN },
    expected_allow: false,
    severity: "CRITICAL",
    notes: "NaN bin — isFinite(NaN) = false. Must refuse.",
  },

  // ── DRAIN VECTOR 6: Liquidity Manipulation ────────────────────────────────
  {
    id: "S-19",
    vector: "Zero Liquidity",
    description: "Pool has $0 liquidity — empty pool drain",
    input: { liquidityUsd: 0 },
    expected_allow: false,
    severity: "CRITICAL",
    notes: "Adding to an empty pool is a drain. Must refuse.",
  },
  {
    id: "S-20",
    vector: "Negative Liquidity",
    description: "Negative liquidity value — spoofed API response",
    input: { liquidityUsd: -1_000 },
    expected_allow: false,
    severity: "CRITICAL",
    notes: "Negative liquidity is physically impossible. Spoofed data guard must catch this.",
  },
  {
    id: "S-21",
    vector: "Infinite Liquidity",
    description: "Liquidity reported as Infinity — API manipulation",
    input: { liquidityUsd: Infinity },
    expected_allow: false,
    severity: "HIGH",
    notes: "Infinity causes APR to calculate as 0. isFinite guard must catch this.",
  },

  // ── DRAIN VECTOR 7: Command Injection via Pool ID ─────────────────────────
  {
    id: "S-22",
    vector: "Command Injection — Shell Characters",
    description: "Pool ID contains shell metacharacters: 'dlmm_1; rm -rf /'",
    input: { poolId: "dlmm_1; rm -rf /" },
    expected_allow: false,
    severity: "CRITICAL",
    notes: "Shell injection via pool ID. Regex guard must catch non-alphanumeric chars.",
  },
  {
    id: "S-23",
    vector: "Command Injection — Backtick",
    description: "Pool ID with backtick execution: 'dlmm_1`cat /etc/passwd`'",
    input: { poolId: "dlmm_1`cat /etc/passwd`" },
    expected_allow: false,
    severity: "CRITICAL",
    notes: "Backtick injection. Regex guard must block.",
  },
  {
    id: "S-24",
    vector: "Command Injection — Empty String",
    description: "Empty pool ID passed",
    input: { poolId: "" },
    expected_allow: false,
    severity: "HIGH",
    notes: "Empty pool ID could fallback to unexpected default. Must refuse.",
  },
  {
    id: "S-25",
    vector: "Command Injection — Path Traversal",
    description: "Pool ID with path traversal: '../../etc/passwd'",
    input: { poolId: "../../etc/passwd" },
    expected_allow: false,
    severity: "CRITICAL",
    notes: "Path traversal attempt. Regex must block '.' and '/'.",
  },

  // ── DRAIN VECTOR 8: Overflow / Math Exploits ──────────────────────────────
  {
    id: "S-26",
    vector: "Volume Overflow — MAX_SAFE_INTEGER",
    description: "Volume set to Number.MAX_SAFE_INTEGER",
    input: { volume24hUsd: Number.MAX_SAFE_INTEGER, volume7dUsd: Number.MAX_SAFE_INTEGER },
    expected_allow: true, // passes checks, APR might be absurd but math handles it
    severity: "MEDIUM",
    notes: "Extremely large volume passes all safety gates. APR calculation should still work or return N/A.",
  },
  {
    id: "S-27",
    vector: "Volume — NaN",
    description: "24h volume is NaN — API returned malformed data",
    input: { volume24hUsd: NaN },
    expected_allow: false,
    severity: "HIGH",
    notes: "NaN < 10000 is false in JS — this BYPASSES the volume check! Critical gap.",
  },
  {
    id: "S-28",
    vector: "Slippage — NaN",
    description: "Slippage is NaN — API returned malformed data",
    input: { slippage: NaN },
    expected_allow: false, // patched: isNaN guard now catches this
    severity: "CRITICAL",
    notes: "PATCHED: isNaN(slippage) guard added — NaN slippage now correctly refused.",
  },
  {
    id: "S-29",
    vector: "STX Amount — NaN",
    description: "STX amount is NaN",
    input: { stxAmount: NaN },
    expected_allow: false, // patched: isNaN guard now catches this
    severity: "CRITICAL",
    notes: "PATCHED: isNaN(stxAmount) guard added — NaN spend amount now correctly refused.",
  },

  // ── DRAIN VECTOR 9: Combination / Multi-Vector ────────────────────────────
  {
    id: "S-30",
    vector: "Multi-Vector — Slippage + Low Volume",
    description: "Both high slippage AND low volume — double drain",
    input: { slippage: 0.1, volume24hUsd: 500 },
    expected_allow: false,
    severity: "CRITICAL",
    notes: "Multiple failures — volume check should catch this first.",
  },
  {
    id: "S-31",
    vector: "Multi-Vector — Overcap STX + No Cooldown",
    description: "Over spend limit AND cooldown not elapsed",
    input: { stxAmount: 200, lastRebalanceHoursAgo: 1 },
    expected_allow: false,
    severity: "CRITICAL",
    notes: "Volume check passes, then cooldown catches it.",
  },
];

// ── Run audit ────────────────────────────────────────────────────────────────

function runAudit(): void {
  const results: AuditResult[] = [];
  let passed = 0;
  let failed = 0;
  const vulnerabilities: AuditResult[] = [];

  for (const scenario of SCENARIOS) {
    const input: GuardianInput = { ...BASE_SAFE, ...scenario.input };
    const decision = runGuardian(input);
    const pass = decision.allow === scenario.expected_allow;

    if (pass) passed++;
    else failed++;

    const result: AuditResult = {
      id: scenario.id,
      vector: scenario.vector,
      description: scenario.description,
      input,
      decision,
      expected_allow: scenario.expected_allow,
      pass,
      severity: scenario.severity,
      notes: scenario.notes,
    };

    results.push(result);
    if (!pass) vulnerabilities.push(result);
  }

  // Summary
  const summary = {
    total: results.length,
    passed,
    failed,
    pass_rate: `${((passed / results.length) * 100).toFixed(1)}%`,
    vulnerabilities_found: vulnerabilities.length,
    critical_failures: vulnerabilities.filter((v) => v.severity === "CRITICAL").length,
    high_failures: vulnerabilities.filter((v) => v.severity === "HIGH").length,
  };

  // Detailed results
  const report = {
    summary,
    vulnerabilities: vulnerabilities.map((v) => ({
      id: v.id,
      severity: v.severity,
      vector: v.vector,
      expected_allow: v.expected_allow,
      actual_allow: v.decision.allow,
      notes: v.notes,
      fix_required: true,
    })),
    full_results: results.map((r) => ({
      id: r.id,
      severity: r.severity,
      vector: r.vector,
      pass: r.pass,
      expected_allow: r.expected_allow,
      actual_allow: r.decision.allow,
      recommendation: r.decision.recommendation,
      refusal_reason: r.decision.refusal_reason ?? null,
    })),
  };

  console.log(JSON.stringify(report, null, 2));
}

runAudit();
