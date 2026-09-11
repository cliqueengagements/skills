#!/usr/bin/env bun

import { Command } from "commander";
import {
  AnchorMode,
  type ClarityValue,
  type PostCondition,
  PostConditionMode,
  broadcastTransaction,
  cvToJSON,
  fetchCallReadOnlyFunction,
  getAddressFromPrivateKey,
  makeContractCall,
  principalCV,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonMap = { [key: string]: Json };
type Status = "success" | "blocked" | "error";

interface TokenInfo {
  tokenId: string;
  symbol: string;
  name: string;
  tokenContract: string | null;
  tokenName: string | null;
  tokenDecimals: number;
  status?: string;
  type?: string;
}

interface SharedOptions {
  wallet?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  slippageBps?: string;
  feeUstx?: string;
  minGasReserveUstx?: string;
  mempoolDepthLimit?: string;
  waitSeconds?: string;
  search?: string;
  limit?: string;
}

interface RunOptions extends SharedOptions {
  confirm?: string;
}

interface BitflowRouteQuote {
  bestRoute: {
    route: unknown;
    quote?: number | null;
    tokenPath?: string[];
    dexPath?: string[];
    tokenXDecimals?: number;
    tokenYDecimals?: number;
    priceImpact?: unknown;
  } | null;
}

interface BitflowSwapParams {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: ClarityValue[];
  postConditions: PostCondition[];
}

interface BitflowSdkLike {
  getAvailableTokens(): Promise<unknown[]>;
  getQuoteForRoute(tokenIn: string, tokenOut: string, amountIn: number): Promise<BitflowRouteQuote>;
  prepareSwap?: (
    swapExecutionData: { route: unknown; amount: number; tokenXDecimals: number; tokenYDecimals: number },
    senderAddress: string,
    slippageTolerance?: number
  ) => Promise<BitflowSwapParams>;
  getSwapParams?: (
    swapExecutionData: { route: unknown; amount: number; tokenXDecimals: number; tokenYDecimals: number },
    senderAddress: string,
    slippageTolerance?: number
  ) => Promise<BitflowSwapParams>;
}

interface Context {
  wallet: string;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountHuman: number;
  amountAtomic: bigint;
  slippageDecimal: number;
  fee: bigint;
  minGasReserve: bigint;
  pendingDepth: number;
  mempoolDepthLimit: number;
  inputBalance: bigint;
  outputBalance: bigint;
  stxAvailable: bigint;
  quote: BitflowRouteQuote | null;
  swapParams: BitflowSwapParams | null;
}

interface SessionFile {
  version: number;
  expiresAt?: string;
  encrypted: { ciphertext: string; iv: string; authTag: string };
}

const NETWORK = process.env.NETWORK || "mainnet";
const HIRO_API = process.env.STACKS_API_HOST || "https://api.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";
const CONFIRM_TOKEN = "SWAP";
const DEFAULT_WAIT_SECONDS = 240;
const DEFAULT_SDK_TIMEOUT_MS = 25_000;
const DEFAULT_FEE_USTX = 70_000n;
const DEFAULT_MIN_GAS_RESERVE_USTX = 500_000n;
const DEFAULT_SLIPPAGE_BPS = 100;
const DEFAULT_MEMPOOL_DEPTH_LIMIT = 3;

class BlockedError extends Error {
  constructor(
    public code: string,
    message: string,
    public next: string,
    public data: JsonMap = {}
  ) {
    super(message);
  }
}

function stringify(value: unknown): Json {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stringify);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, stringify(val)])) as JsonMap;
  }
  if (value === undefined) return null;
  return value as Json;
}

function output(status: Status, action: string, data: JsonMap, error: JsonMap | null): void {
  process.stdout.write(`${JSON.stringify({ status, action, data: stringify(data), error: stringify(error) }, null, 2)}\n`);
}

function success(action: string, data: JsonMap): void {
  output("success", action, data, null);
}

function blocked(action: string, code: string, message: string, next: string, data: JsonMap = {}): void {
  output("blocked", action, data, { code, message, next });
}

function fail(action: string, error: unknown): void {
  if (error instanceof BlockedError) {
    blocked(action, error.code, error.message, error.next, error.data);
    process.exit(0);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  output("error", action, {}, { code: "ERROR", message, next: "Run doctor/status and inspect the failing check before retrying." });
  process.exitCode = 1;
  if (message.startsWith("SDK_TIMEOUT:")) {
    process.exit(1);
  }
}

function parseContractId(contractId: string): { address: string; name: string } {
  const [address, name] = contractId.split(".");
  if (!address || !name) throw new Error(`Invalid contract id: ${contractId}`);
  return { address, name };
}

function parsePositiveHuman(value: string | undefined, label: string): number {
  if (!value) throw new Error(`${label} is required`);
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`${label} must be a positive decimal`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be greater than 0`);
  return parsed;
}

function decimalToAtomic(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`Invalid decimal amount: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`Amount has more than ${decimals} decimal places`);
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

function parseInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function parseNonNegativeBigInt(value: string | undefined, fallback: bigint, label: string): bigint {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(value);
}

function parseBps(value: string | undefined): number {
  const parsed = parseInteger(value, DEFAULT_SLIPPAGE_BPS, "--slippage-bps");
  if (parsed < 0 || parsed > 10_000) throw new Error("--slippage-bps must be between 0 and 10000");
  return parsed;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} from ${url}${body ? `: ${body.slice(0, 180)}` : ""}`);
  }
  return response.json() as Promise<T>;
}

async function createBitflowSdk(): Promise<BitflowSdkLike> {
  const { BitflowSDK } = await import("@bitflowlabs/core-sdk") as any;
  return new BitflowSDK({
    BITFLOW_API_HOST: process.env.BITFLOW_API_HOST || "https://api.bitflowapis.finance",
    API_HOST: process.env.API_HOST || "https://api.bitflowapis.finance",
    STACKS_API_HOST: process.env.STACKS_API_HOST || "https://api.hiro.so",
    READONLY_CALL_API_HOST: process.env.READONLY_CALL_API_HOST || "https://api.hiro.so",
    KEEPER_API_HOST: process.env.KEEPER_API_HOST || "https://api.bitflowapis.finance",
    KEEPER_API_URL: process.env.KEEPER_API_URL || "https://api.bitflowapis.finance",
  });
}

const originalConsole = {
  warn: console.warn,
  error: console.error,
  log: console.log,
};
let quietSdkDepth = 0;

async function quietSdk<T>(fn: () => Promise<T>): Promise<T> {
  if (quietSdkDepth === 0) {
    console.warn = () => {};
    console.error = () => {};
    console.log = () => {};
  }
  quietSdkDepth += 1;
  try {
    return await fn();
  } finally {
    quietSdkDepth = Math.max(quietSdkDepth - 1, 0);
    if (quietSdkDepth === 0) {
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      console.log = originalConsole.log;
    }
  }
}

async function sdkCall<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const timeoutMs = parseInteger(process.env.BITFLOW_SDK_TIMEOUT_MS, DEFAULT_SDK_TIMEOUT_MS, "BITFLOW_SDK_TIMEOUT_MS");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      quietSdk(fn),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`SDK_TIMEOUT: ${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeToken(raw: any): TokenInfo {
  const tokenContract = raw.tokenContract && raw.tokenContract !== "null" ? String(raw.tokenContract) : null;
  const tokenName = raw.tokenName && raw.tokenName !== "null" ? String(raw.tokenName) : null;
  return {
    tokenId: String(raw.tokenId ?? raw["token-id"]),
    symbol: String(raw.symbol ?? raw.tokenId ?? raw["token-id"]),
    name: String(raw.name ?? raw.symbol ?? raw.tokenId ?? raw["token-id"]),
    tokenContract,
    tokenName,
    tokenDecimals: Number(raw.tokenDecimals ?? 6),
    status: raw.status ? String(raw.status) : undefined,
    type: raw.type ? String(raw.type) : undefined,
  };
}

async function getTokens(sdk: BitflowSdkLike): Promise<TokenInfo[]> {
  const tokens = await sdkCall("getAvailableTokens", () => sdk.getAvailableTokens());
  return tokens.map(normalizeToken);
}

function matchesToken(token: TokenInfo, selector: string): boolean {
  const needle = selector.toLowerCase();
  return (
    token.tokenId.toLowerCase() === needle ||
    token.symbol.toLowerCase() === needle ||
    token.name.toLowerCase() === needle ||
    token.tokenContract?.toLowerCase() === needle ||
    token.tokenId.toLowerCase().includes(needle) ||
    token.symbol.toLowerCase().includes(needle)
  );
}

async function resolveToken(sdk: BitflowSdkLike, selector: string | undefined, label: string): Promise<TokenInfo> {
  return resolveTokenFromList(await getTokens(sdk), selector, label);
}

function resolveTokenFromList(tokens: TokenInfo[], selector: string | undefined, label: string): TokenInfo {
  if (!selector) throw new Error(`${label} is required`);
  const matches = tokens.filter((token) => matchesToken(token, selector));
  if (matches.length === 0) {
    throw new BlockedError("TOKEN_NOT_FOUND", `Could not resolve ${label}: ${selector}`, "Run tokens --search <symbol> and use a live Bitflow token ID.", { selector });
  }
  const needle = selector.toLowerCase();
  const exactMatches = matches.filter(
    (token) =>
      token.tokenId.toLowerCase() === needle ||
      token.symbol.toLowerCase() === needle ||
      token.tokenContract?.toLowerCase() === needle
  );
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1 || matches.length > 1) {
    throw new BlockedError(
      "AMBIGUOUS_TOKEN",
      `Ambiguous ${label}: ${selector}`,
      "Run tokens --search <selector> and rerun with a specific token ID or contract ID.",
      { selector, candidates: matches.map(tokenSummary) }
    );
  }
  return matches[0];
}

function tokenSummary(token: TokenInfo): JsonMap {
  return {
    tokenId: token.tokenId,
    symbol: token.symbol,
    name: token.name,
    tokenContract: token.tokenContract,
    tokenName: token.tokenName,
    tokenDecimals: token.tokenDecimals,
    status: token.status ?? null,
    type: token.type ?? null,
  };
}

function isStx(token: TokenInfo): boolean {
  return token.tokenId === "token-stx" || token.symbol.toLowerCase() === "stx";
}

async function getStxAvailable(wallet: string): Promise<bigint> {
  const response = await fetchJson<{ balance: string; locked: string }>(`${HIRO_API}/extended/v1/address/${wallet}/stx`);
  return BigInt(response.balance) - BigInt(response.locked);
}

async function getPendingDepth(wallet: string): Promise<number> {
  const response = await fetchJson<{ total?: number; results?: unknown[] }>(`${HIRO_API}/extended/v1/tx/mempool?sender_address=${wallet}&limit=20`);
  return response.total ?? response.results?.length ?? 0;
}

async function getFtBalance(wallet: string, token: TokenInfo): Promise<bigint> {
  if (isStx(token)) return getStxAvailable(wallet);
  if (!token.tokenContract) throw new Error(`Token ${token.tokenId} has no token contract`);
  const { address, name } = parseContractId(token.tokenContract);
  const cv = await fetchCallReadOnlyFunction({
    network: STACKS_MAINNET,
    contractAddress: address,
    contractName: name,
    functionName: "get-balance",
    functionArgs: [principalCV(wallet)],
    senderAddress: wallet,
  });
  const json: any = cvToJSON(cv);
  if (!json?.success) throw new Error(`get-balance failed for ${token.tokenContract}: ${JSON.stringify(json)}`);
  return BigInt(String(json.value?.value ?? json.value));
}

function routeSummary(quote: BitflowRouteQuote | null): JsonMap {
  const best = quote?.bestRoute ?? null;
  const route = (best?.route ?? null) as any;
  return {
    quote: best?.quote ?? quote?.quote ?? null,
    tokenPath: best?.tokenPath ?? route?.token_path ?? null,
    dexPath: best?.dexPath ?? route?.dex_path ?? null,
    quoteContract: route?.quoteData?.contract ?? null,
    quoteFunction: route?.quoteData?.function ?? null,
    swapContract: route?.swapData?.contract ?? null,
    swapFunction: route?.swapData?.function ?? null,
    tokenXDecimals: best?.tokenXDecimals ?? null,
    tokenYDecimals: best?.tokenYDecimals ?? null,
    priceImpact: best?.priceImpact ?? null,
    rawRouteKeys: best ? Object.keys(best).sort() : [],
  };
}

function assertSwapParams(raw: unknown): BitflowSwapParams {
  const params = raw as Partial<BitflowSwapParams> | null;
  if (
    !params ||
    typeof params.contractAddress !== "string" ||
    typeof params.contractName !== "string" ||
    typeof params.functionName !== "string" ||
    !Array.isArray(params.functionArgs) ||
    !Array.isArray(params.postConditions)
  ) {
    throw new BlockedError("PREPARE_SWAP_FAILED", "Bitflow SDK did not return complete executable swap parameters.", "Inspect quote output and retry later.");
  }
  return params as BitflowSwapParams;
}

async function prepareSwap(sdk: BitflowSdkLike, context: Omit<Context, "swapParams">): Promise<BitflowSwapParams> {
  if (!context.quote?.bestRoute?.route) {
    throw new BlockedError("NO_ROUTE", "Bitflow aggregator did not return an executable route.", "Try a different token pair or amount.");
  }
  const swapExecutionData = {
    route: context.quote.bestRoute.route,
    amount: context.amountHuman,
    tokenXDecimals: context.tokenIn.tokenDecimals,
    tokenYDecimals: context.tokenOut.tokenDecimals,
  };
  if (typeof sdk.prepareSwap === "function") {
    return assertSwapParams(await sdkCall("prepareSwap", () => sdk.prepareSwap!(swapExecutionData, context.wallet, context.slippageDecimal)));
  }
  if (typeof sdk.getSwapParams === "function") {
    return assertSwapParams(await sdkCall("getSwapParams", () => sdk.getSwapParams!(swapExecutionData, context.wallet, context.slippageDecimal)));
  }
  throw new BlockedError("PREPARE_SWAP_UNAVAILABLE", "Bitflow SDK does not expose prepareSwap or getSwapParams.", "Use an SDK version with executable swap preparation support.");
}

function postconditionSummary(postConditions: unknown[]): Json[] {
  return postConditions.map((pc: any, index) => {
    try {
      return {
        index,
        conditionCode: pc.conditionCode ?? pc.condition_code ?? null,
        principal: String(pc.principal ?? pc.principalString ?? pc.conditionPrincipal ?? "unknown"),
        asset: String(pc.assetInfo ?? pc.asset ?? pc.assetName ?? "stx-or-unknown"),
        amount: String(pc.amount ?? "unknown"),
      };
    } catch {
      return { index, rawType: typeof pc };
    }
  });
}

/**
 * The prepared swap as an UNSIGNED contract call, for a wallet other than this
 * skill's to sign.
 *
 * `plan` used to print only a summary of the prepared swap: the function
 * arguments were dropped and the post-conditions were read with field names the
 * installed @stacks/transactions does not use, so every one came out as
 * "unknown". An agent that never holds the person's key (SmartX) could see the
 * route but could not hand the person the exact transaction to sign. This emits
 * the same call `run` would sign, in a JSON form such an agent can rebuild
 * exactly: typed Clarity arguments and explicit post-conditions, deny mode.
 * Nothing here signs or broadcasts.
 */
function clarityToJson(cv: any): Json {
  switch (cv?.type) {
    case "uint": return { type: "uint", value: String(cv.value) };
    case "int": return { type: "int", value: String(cv.value) };
    case "true": return { type: "bool", value: true };
    case "false": return { type: "bool", value: false };
    case "address":
    case "contract": return { type: "principal", value: String(cv.value) };
    case "none": return { type: "none" };
    case "some": return { type: "some", value: clarityToJson(cv.value) };
    case "list": return { type: "list", value: (cv.value as unknown[]).map(clarityToJson) };
    case "tuple": {
      const fields: { [key: string]: Json } = {};
      for (const [k, v] of Object.entries(cv.value as Record<string, unknown>)) fields[k] = clarityToJson(v);
      return { type: "tuple", value: fields };
    }
    case "buffer": return { type: "buffer", value: String(cv.value) };
    case "ascii": return { type: "string-ascii", value: String(cv.value) };
    case "utf8": return { type: "string-utf8", value: String(cv.value) };
    default:
      throw new BlockedError("UNSUPPORTED_ARGUMENT", `The prepared swap has a ${String(cv?.type)} argument that cannot be expressed for an external signer.`, "Report the route to the skill maintainer.");
  }
}

function postConditionToJson(pc: any): Json {
  if (pc?.type === "stx-postcondition") {
    return { type: "stx", principal: String(pc.address), conditionCode: String(pc.condition), amount: String(pc.amount) };
  }
  if (pc?.type === "ft-postcondition") {
    const [asset, assetName] = String(pc.asset).split("::");
    return { type: "ft", principal: String(pc.address), asset: asset ?? "", assetName: assetName ?? "", conditionCode: String(pc.condition), amount: String(pc.amount) };
  }
  throw new BlockedError("UNSUPPORTED_POSTCONDITION", `The prepared swap has a ${String(pc?.type)} post-condition that cannot be expressed for an external signer.`, "Report the route to the skill maintainer.");
}

function tokenAssetId(token: TokenInfo): string {
  return isStx(token) ? "STX" : `${token.tokenContract}::${token.tokenName}`;
}

function unsignedInstruction(context: Context): JsonMap | null {
  const p = context.swapParams;
  if (!p) return null;
  const postConditions = p.postConditions.map(postConditionToJson) as JsonMap[];
  const delivers = tokenAssetId(context.tokenOut);
  // The least the person receives: the one "at least" condition on the output token.
  const floors = postConditions.filter((pc) => pc.conditionCode === "gte" && (pc.type === "ft" ? `${pc.asset}::${pc.assetName}` : "STX") === delivers);
  const least = floors.length === 1 ? Number(floors[0].amount) / 10 ** context.tokenOut.tokenDecimals : null;
  const path = (context.quote?.bestRoute?.tokenPath ?? []).join(" > ");
  return {
    tool: "call_contract",
    description: `Swap ${context.amountHuman} ${context.tokenIn.symbol} to ${least === null ? "" : `at least ${least} `}${context.tokenOut.symbol} via Bitflow${path ? ` (${path})` : ""}`,
    params: {
      contractAddress: p.contractAddress,
      contractName: p.contractName,
      functionName: p.functionName,
      functionArgs: p.functionArgs.map(clarityToJson),
      postConditionMode: "deny",
      postConditions,
      // Read what this delivered before doing anything with it: the amount that
      // arrives can differ from the quote.
      requires_residual_check: true,
      delivers,
    },
  };
}

/*
 * Bitflow's own quote service, the one the Bitflow app uses.
 *
 * `plan` and `quote` used the SDK's `getQuoteForRoute`, which calls each pool's
 * read-only quote function and never checks whether the call succeeded. Measured
 * on 2026-09-11: for USDCx to USDh the pools answer `(err u1010)` and
 * `(err u6014)` (ERR_QUOTE_B in router-stableswap-xyk-multihop-v-1-5), and the SDK
 * returned those error codes AS the quote: 0.0000101 and 0.00006014 USDh for any
 * input. The "at least" floor built from that protected nothing. The newest SDK
 * (4.2.0) computes quotes with the same code.
 *
 * The quote service answers correctly (10 USDCx quoted 9.988 USDh through the
 * HODLMM usdh/usdcx pool) and, from its quote, returns the swap call with typed
 * arguments and post-conditions. Everything it returns is cross-checked below
 * before it is handed on: nothing here signs or broadcasts.
 */
const QUOTE_SERVICE = "https://bff.bitflowapis.finance/api/quotes/v1";
/** The router the service built every checked swap against, 2026-09-11. Any other contract is refused. */
const DLMM_SWAP_ROUTER = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1";
const CONTRACT_ID = /^S[PM][0-9A-Z]{27,40}\.[a-zA-Z][a-zA-Z0-9_-]{0,127}$/;
const DIGITS = /^\d+$/;

/** An exact atomic amount in whole tokens, with no float in between: 989232733 at 8 places is 9.89232733. */
function atomicToHuman(atomic: string, decimals: number): string {
  const padded = atomic.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  const frac = decimals > 0 ? padded.slice(-decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_SDK_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new BlockedError("QUOTE_SERVICE_ERROR", `Bitflow's quote service returned HTTP ${response.status}.`, "Retry later.", { detail: text.slice(0, 180) });
  }
  return response.json() as Promise<T>;
}

/** The quote service's token list, with the decimals it quotes in. A row without whole decimals is refused. */
async function serviceTokens(): Promise<TokenInfo[]> {
  const response = await fetch(`${QUOTE_SERVICE}/tokens`, { signal: AbortSignal.timeout(DEFAULT_SDK_TIMEOUT_MS) });
  if (!response.ok) throw new BlockedError("QUOTE_SERVICE_ERROR", `Bitflow's quote service returned HTTP ${response.status} for its token list.`, "Retry later.");
  const body = (await response.json()) as { tokens?: any[] };
  if (!Array.isArray(body.tokens)) throw new BlockedError("QUOTE_SERVICE_ERROR", "Bitflow's quote service returned no token list.", "Retry later.");
  return body.tokens
    .filter((t) => typeof t?.contract_address === "string" && CONTRACT_ID.test(t.contract_address))
    .map((t) => ({
      tokenId: String(t.contract_address),
      symbol: String(t.symbol ?? t.contract_address),
      name: String(t.name ?? t.symbol ?? t.contract_address),
      tokenContract: String(t.contract_address),
      tokenName: typeof t.asset_name === "string" && t.asset_name ? t.asset_name : null,
      // No default. A missing figure would silently size the swap in the wrong unit.
      tokenDecimals: Number.isInteger(t.decimals) && t.decimals >= 0 ? t.decimals : Number.NaN,
    }));
}

/** Exact match only: the contract id, or the symbol. A symbol "usdh" must never find "susdh". */
function resolveExact(tokens: TokenInfo[], selector: string | undefined, label: string): TokenInfo {
  if (!selector) throw new Error(`${label} is required`);
  const needle = selector.toLowerCase();
  const matches = tokens.filter((t) => t.tokenContract?.toLowerCase() === needle || t.symbol.toLowerCase() === needle);
  if (matches.length === 0) throw new BlockedError("TOKEN_NOT_FOUND", `Bitflow's quote service does not list ${label} ${selector}.`, "Use the token's contract id.", { selector });
  if (matches.length > 1) throw new BlockedError("AMBIGUOUS_TOKEN", `More than one token matches ${label} ${selector}.`, "Use the token's contract id.", { selector });
  const token = matches[0];
  // STX is listed under Bitflow's wrapper contract with no real asset name
  // ("unknown"); it leaves the wallet as native STX under an stx post-condition,
  // so it needs no asset name. Every other token does.
  if (!Number.isInteger(token.tokenDecimals) || (!token.tokenName && !isStx(token))) {
    throw new BlockedError("TOKEN_METADATA", `Bitflow's quote service lists ${selector} without its decimals or asset name.`, "Report the token to Bitflow.");
  }
  return token;
}

interface ServiceQuote {
  success?: boolean;
  error?: unknown;
  amount_out?: string;
  min_amount_out?: string;
  route_path?: string[];
  execution_path?: unknown[];
  input_token_decimals?: number;
  output_token_decimals?: number;
  execution_details?: Record<string, unknown>;
}

interface ServiceSwap {
  success?: boolean;
  error?: unknown;
  swap_contract?: string;
  function_name?: string;
  swap_parameters_typed?: unknown[];
  post_conditions?: any[];
  total_hops?: number;
}

/**
 * The best route through ONE pool holding both tokens, or a refusal.
 *
 * A swap goes through a single pool, never a chain (the SmartX owner's ruling,
 * 11 September 2026). A chained route passes the in-between token through the
 * wallet, pinned only by "the wallet sends at least 0", which leaves every unit
 * of that token movable. The service's best route changes with the amount
 * (sBTC to USDCx went direct at 2,000 sats and through STX at 5,000), so every
 * route is asked for and the best single-pool one is taken. They come sorted
 * best first.
 */
async function serviceQuote(tokenIn: TokenInfo, tokenOut: TokenInfo, amountAtomic: bigint, slippagePct: number): Promise<ServiceQuote> {
  const multi = await postJson<{ success?: boolean; error?: unknown; routes?: ServiceQuote[] }>(`${QUOTE_SERVICE}/quote/multi`, {
    input_token: tokenIn.tokenContract, output_token: tokenOut.tokenContract, amount_in: amountAtomic.toString(),
    slippage_tolerance: slippagePct, allow_split: false,
  });
  if (multi.success !== true || multi.error || !Array.isArray(multi.routes)) {
    throw new BlockedError("NO_ROUTE", "Bitflow's quote service found no route for this swap.", "Try a different token pair or amount.", { error: String(multi.error ?? "") });
  }
  // Single pool: in then out, every execution step naming the same pool (a real
  // string), and no "empty swap" step. Measured: some two-token routes walk one
  // pool's bins from an empty step and build a swap spending more than asked
  // (5,001 for 5,000); they fail the amount check, so they are skipped here and
  // the next single-pool route is used instead.
  const single = multi.routes.filter((r) => Array.isArray(r?.route_path) && r.route_path.length === 2
    && r.route_path[0] === tokenIn.tokenContract && r.route_path[1] === tokenOut.tokenContract
    && Array.isArray(r.execution_path) && r.execution_path.length > 0
    && r.execution_path.every((e: any) => typeof e?.pool_trait === "string" && e.pool_trait === (r.execution_path![0] as any).pool_trait && e?.is_empty_swap !== true)
    && DIGITS.test(String(r.amount_out)));
  // The most out, chosen here rather than trusting the service's order.
  const quote = single.reduce<ServiceQuote | undefined>(
    (best, r) => (best === undefined || BigInt(String(r.amount_out)) > BigInt(String(best.amount_out)) ? r : best), undefined);
  if (!quote) {
    throw new BlockedError(
      "NO_SINGLE_POOL",
      `Bitflow has no single pool between ${tokenIn.symbol} and ${tokenOut.symbol}, and swaps here go through one pool only.`,
      "Choose two tokens that share a pool, or make two separate swaps.",
      { routes: multi.routes.map((r) => (r?.route_path ?? []).join(" > ")) as Json },
    );
  }
  if (!DIGITS.test(String(quote.amount_out)) || !DIGITS.test(String(quote.min_amount_out)) || BigInt(quote.min_amount_out!) <= 0n) {
    throw new BlockedError("QUOTE_UNREADABLE", "Bitflow's quote gave no positive amount out.", "Retry later.");
  }
  if (quote.input_token_decimals !== tokenIn.tokenDecimals || quote.output_token_decimals !== tokenOut.tokenDecimals) {
    throw new BlockedError("QUOTE_MISMATCH", "Bitflow's quote uses different decimals from its own token list.", "Retry later; report it if it persists.");
  }
  if (!Array.isArray(quote.execution_path) || quote.execution_path.length === 0) {
    throw new BlockedError("NO_ROUTE", "Bitflow's quote came with no execution path.", "Try a different token pair or amount.");
  }
  return quote;
}

async function serviceSwap(quote: ServiceQuote, tokenIn: TokenInfo, tokenOut: TokenInfo, amountAtomic: bigint, slippagePct: number): Promise<ServiceSwap> {
  const swap = await postJson<ServiceSwap>(`${QUOTE_SERVICE}/swap`, {
    execution_path: quote.execution_path, amount_in: amountAtomic.toString(), amount_out: quote.amount_out,
    input_token: tokenIn.tokenContract, output_token: tokenOut.tokenContract,
    input_token_decimals: tokenIn.tokenDecimals, output_token_decimals: tokenOut.tokenDecimals, slippage_tolerance: slippagePct,
  });
  if (swap.success !== true || swap.error) {
    throw new BlockedError("PREPARE_SWAP_FAILED", "Bitflow's quote service could not build the swap.", "Retry later.", { error: String(swap.error ?? "") });
  }
  // The only call shape verified against the router's interface on 2026-09-11:
  // `swap-simple-multi` takes ONE argument, a list of swap tuples.
  if (swap.function_name !== "swap-simple-multi" || typeof swap.swap_contract !== "string" || !CONTRACT_ID.test(swap.swap_contract)) {
    throw new BlockedError("UNSUPPORTED_ROUTE", `Bitflow's quote service built a ${String(swap.function_name)} call, which plan does not express yet.`, "Report the route to the skill maintainer.");
  }
  if (!Array.isArray(swap.swap_parameters_typed) || swap.swap_parameters_typed.length === 0 || !Array.isArray(swap.post_conditions)) {
    throw new BlockedError("PREPARE_SWAP_FAILED", "Bitflow's quote service returned an incomplete swap.", "Retry later.");
  }
  return swap;
}

/** The service's typed argument, as the JSON an external signer rebuilds. Unknown types refuse. */
function serviceArgToJson(v: any): Json {
  switch (v?.type) {
    case "uint":
      if (!DIGITS.test(String(v.value))) break;
      return { type: "uint", value: String(v.value) };
    case "int":
      if (!/^-?\d+$/.test(String(v.value))) break;
      return { type: "int", value: String(v.value) };
    case "true": return { type: "bool", value: true };
    case "false": return { type: "bool", value: false };
    case "bool":
      // Anything but a real boolean refuses: a garbled flag could flip a swap's direction.
      if (v.value === true || v.value === "true") return { type: "bool", value: true };
      if (v.value === false || v.value === "false") return { type: "bool", value: false };
      break;
    case "contract":
    case "principal":
      if (typeof v.value !== "string" || !CONTRACT_ID.test(v.value) && !/^S[PM][0-9A-Z]{27,40}$/.test(v.value)) break;
      return { type: "principal", value: v.value };
    case "tuple": {
      if (!v.value || typeof v.value !== "object") break;
      const fields: { [key: string]: Json } = {};
      for (const [k, x] of Object.entries(v.value as Record<string, unknown>)) fields[k] = serviceArgToJson(x);
      return { type: "tuple", value: fields };
    }
  }
  throw new BlockedError("UNSUPPORTED_ARGUMENT", `Bitflow's quote service returned a ${String(v?.type)} argument plan cannot express.`, "Report the route to the skill maintainer.");
}

const CONDITION_CODES: Record<string, string> = {
  less_than_or_equal_to: "lte", greater_than_or_equal_to: "gte", equal_to: "eq", less_than: "lt", greater_than: "gt",
};

/** The service's post-condition in the plan's JSON form. `tx-sender` is the wallet. Unknown shapes refuse. */
function servicePcToJson(pc: any, wallet: string): JsonMap {
  const principal = pc?.sender_address === "tx-sender" ? wallet : String(pc?.sender_address ?? "");
  const conditionCode = CONDITION_CODES[String(pc?.condition_code)];
  const amount = String(pc?.amount ?? "");
  if (!conditionCode || !DIGITS.test(amount) || !(CONTRACT_ID.test(principal) || /^S[PM][0-9A-Z]{27,40}$/.test(principal))) {
    throw new BlockedError("UNSUPPORTED_POSTCONDITION", "Bitflow's quote service returned a post-condition plan cannot express.", "Report the route to the skill maintainer.");
  }
  const kind = String(pc?.post_condition_type);
  if (kind === "standard_stx" || kind === "contract_stx") return { type: "stx", principal, conditionCode, amount };
  if (kind === "standard_fungible" || kind === "contract_fungible") {
    const [asset, named] = String(pc.token_contract ?? "").split("::");
    const assetName = /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(String(pc.token_asset_name ?? "")) ? String(pc.token_asset_name) : named;
    if (!asset || !CONTRACT_ID.test(asset) || !assetName) {
      throw new BlockedError("UNSUPPORTED_POSTCONDITION", "Bitflow's quote service returned a token post-condition without a readable asset.", "Report the route to the skill maintainer.");
    }
    return { type: "ft", principal, asset, assetName, conditionCode, amount };
  }
  throw new BlockedError("UNSUPPORTED_POSTCONDITION", `Bitflow's quote service returned a ${kind} post-condition plan cannot express.`, "Report the route to the skill maintainer.");
}

interface ServiceContext {
  wallet: string;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountHuman: string;
  amountAtomic: bigint;
  slippageBps: number;
  quote: ServiceQuote;
  swap: ServiceSwap;
  balances: JsonMap;
  safety: JsonMap;
}

async function buildServiceContext(opts: SharedOptions, withSwap: boolean): Promise<ServiceContext> {
  if (NETWORK !== "mainnet") throw new BlockedError("MAINNET_ONLY", "bitflow-swap-aggregator is mainnet-only.", "Set NETWORK=mainnet.");
  if (!opts.wallet) throw new Error("--wallet is required");
  const tokens = await serviceTokens();
  const tokenIn = resolveExact(tokens, opts.tokenIn, "--token-in");
  const tokenOut = resolveExact(tokens, opts.tokenOut, "--token-out");
  if (tokenIn.tokenContract === tokenOut.tokenContract) throw new BlockedError("SAME_TOKEN", "The input and output tokens are the same.", "Choose two different tokens.");
  parsePositiveHuman(opts.amountIn, "--amount-in");
  const amountHuman = opts.amountIn!;
  const amountAtomic = decimalToAtomic(amountHuman, tokenIn.tokenDecimals);
  if (amountAtomic <= 0n) throw new Error("--amount-in is required");
  const slippageBps = parseBps(opts.slippageBps);
  const slippagePct = slippageBps / 100;
  const fee = parseNonNegativeBigInt(opts.feeUstx, DEFAULT_FEE_USTX, "--fee-ustx");
  const minGasReserve = parseNonNegativeBigInt(opts.minGasReserveUstx, DEFAULT_MIN_GAS_RESERVE_USTX, "--min-gas-reserve-ustx");
  const [quote, inputBalance, stxAvailable, pendingDepth] = await Promise.all([
    serviceQuote(tokenIn, tokenOut, amountAtomic, slippagePct),
    getFtBalance(opts.wallet, tokenIn),
    getStxAvailable(opts.wallet),
    getPendingDepth(opts.wallet),
  ]);
  if (withSwap && inputBalance < amountAtomic) {
    throw new BlockedError("INSUFFICIENT_INPUT_BALANCE", "Wallet input balance is below the requested swap amount.", "Fund the wallet or reduce --amount-in.", { inputBalance, amountAtomic, tokenIn: tokenSummary(tokenIn) });
  }
  // STX pays the fee too, so swapping STX needs the amount AND the fee AND the reserve.
  const stxNeeded = (isStx(tokenIn) ? amountAtomic : 0n) + fee + minGasReserve;
  if (withSwap && stxAvailable < stxNeeded) {
    throw new BlockedError("INSUFFICIENT_GAS_RESERVE", "Native STX cannot cover the swap, the fee and the residual gas reserve.", "Fund STX or reduce --amount-in.", { stxAvailable, fee, minGasReserve, stxNeeded });
  }
  const swap = withSwap ? await serviceSwap(quote, tokenIn, tokenOut, amountAtomic, slippagePct) : ({} as ServiceSwap);
  return {
    wallet: opts.wallet, tokenIn, tokenOut, amountHuman, amountAtomic, slippageBps, quote, swap,
    balances: { inputBalance, stxAvailable },
    safety: { pendingDepth, fee, minGasReserve },
  };
}

function serviceQuoteData(ctx: ServiceContext): JsonMap {
  return {
    network: NETWORK,
    wallet: ctx.wallet,
    source: "Bitflow quote service",
    tokens: { input: tokenSummary(ctx.tokenIn), output: tokenSummary(ctx.tokenOut) },
    amount: { amountInHuman: ctx.amountHuman, amountInAtomic: ctx.amountAtomic, slippageBps: ctx.slippageBps },
    quote: {
      amountOut: ctx.quote.amount_out ?? null,
      minAmountOut: ctx.quote.min_amount_out ?? null,
      routePath: (ctx.quote.route_path ?? []) as Json,
      details: stringify(ctx.quote.execution_details ?? null),
    },
    balances: ctx.balances,
    safety: ctx.safety,
  };
}

/**
 * The service's swap as an unsigned call, after checking it says what was asked.
 *
 * Refused unless: the first step spends exactly the amount asked; the wallet's
 * own condition caps that token at that amount; and a positive "at least"
 * condition on the output token, from someone other than the wallet, matches the
 * last step's `min-received`. Those are the numbers the person will read.
 */
function serviceInstruction(ctx: ServiceContext): JsonMap {
  const steps = (ctx.swap.swap_parameters_typed ?? []).map(serviceArgToJson) as any[];
  // One pool, so one swap tuple: true by construction, not by an argument about the router.
  if (steps.length !== 1) {
    throw new BlockedError("MULTI_STEP_ROUTE", "Bitflow's swap has more than one step, and swaps here go through one pool only.", "Retry; report it if it persists.");
  }
  const only = steps[0]?.value;
  if (steps[0]?.type !== "tuple" || only?.amount?.value !== ctx.amountAtomic.toString()) {
    throw new BlockedError("SWAP_MISMATCH", "Bitflow's swap does not spend the amount that was asked.", "Retry; report it if it persists.");
  }
  const last = only;
  const postConditions = (ctx.swap.post_conditions ?? []).map((pc) => servicePcToJson(pc, ctx.wallet));
  // STX has no asset id; it is keyed as "STX" on both sides.
  const keyOf = (pc: JsonMap) => (pc.type === "stx" ? "STX" : `${pc.asset}::${pc.assetName}`);
  const inAsset = isStx(ctx.tokenIn) ? "STX" : `${ctx.tokenIn.tokenContract}::${ctx.tokenIn.tokenName}`;
  const delivers = isStx(ctx.tokenOut) ? "STX" : `${ctx.tokenOut.tokenContract}::${ctx.tokenOut.tokenName}`;
  const cap = postConditions.find((pc) => pc.principal === ctx.wallet && keyOf(pc) === inAsset
    && (pc.conditionCode === "lte" || pc.conditionCode === "eq") && pc.amount === ctx.amountAtomic.toString());
  if (!cap) throw new BlockedError("SWAP_MISMATCH", "Bitflow's swap does not cap what leaves the wallet at the amount asked.", "Retry; report it if it persists.");
  // The ONE cap is the only condition allowed on the wallet. A route through a
  // second pool passes the in-between token through the wallet, and the service
  // pins it with "the wallet sends at least 0", which under deny mode makes every
  // unit of that token the wallet holds movable. Refused until such a leg can
  // carry a real ceiling. Measured 2026-09-11: sBTC to USDh routes via USDCx.
  if (postConditions.some((pc) => pc.principal === ctx.wallet && pc !== cap)) {
    throw new BlockedError(
      "MULTI_STEP_ROUTE",
      `Bitflow's swap for ${ctx.tokenIn.symbol} to ${ctx.tokenOut.symbol} lets another token leave the wallet, so plan will not hand it on.`,
      "Retry; report it if it persists.",
      { routePath: (ctx.quote.route_path ?? []) as Json },
    );
  }
  if (ctx.swap.swap_contract !== DLMM_SWAP_ROUTER) {
    throw new BlockedError("UNSUPPORTED_ROUTE", `Bitflow's quote service built a call to ${String(ctx.swap.swap_contract)}, which plan does not know.`, "Report the route to the skill maintainer.");
  }
  const floors = postConditions.filter((pc) => pc.principal !== ctx.wallet && pc.conditionCode === "gte"
    && keyOf(pc) === delivers && BigInt(String(pc.amount)) > 0n);
  if (floors.length !== 1 || last?.["min-received"]?.value !== floors[0].amount) {
    throw new BlockedError("SWAP_MISMATCH", "Bitflow's swap has no single positive 'at least' on the token received that matches its own minimum.", "Retry; report it if it persists.");
  }
  const least = atomicToHuman(String(floors[0].amount), ctx.tokenOut.tokenDecimals);
  const [contractAddress, contractName] = String(ctx.swap.swap_contract).split(".");
  return {
    tool: "call_contract",
    description: `Swap ${ctx.amountHuman} ${ctx.tokenIn.symbol} to at least ${least} ${ctx.tokenOut.symbol} via Bitflow`,
    params: {
      contractAddress,
      contractName,
      functionName: "swap-simple-multi",
      functionArgs: [{ type: "list", value: steps }],
      postConditionMode: "deny",
      postConditions,
      // Read what this delivered before doing anything with it: the amount that
      // arrives can differ from the quote.
      requires_residual_check: true,
      delivers,
    },
  };
}

async function buildContext(opts: SharedOptions, requireAmount: boolean): Promise<Context> {
  if (NETWORK !== "mainnet") {
    throw new BlockedError("MAINNET_ONLY", "bitflow-swap-aggregator is mainnet-only.", "Set NETWORK=mainnet.");
  }
  if (!opts.wallet) throw new Error("--wallet is required");
  const sdk = await createBitflowSdk();
  const tokens = await getTokens(sdk);
  const tokenIn = resolveTokenFromList(tokens, opts.tokenIn, "--token-in");
  const tokenOut = resolveTokenFromList(tokens, opts.tokenOut, "--token-out");
  const amountHuman = opts.amountIn ? parsePositiveHuman(opts.amountIn, "--amount-in") : 0;
  const amountAtomic = opts.amountIn ? decimalToAtomic(opts.amountIn, tokenIn.tokenDecimals) : 0n;
  if (requireAmount && amountAtomic <= 0n) throw new Error("--amount-in is required");
  const slippageBps = parseBps(opts.slippageBps);
  const slippageDecimal = slippageBps / 10_000;
  const fee = parseNonNegativeBigInt(opts.feeUstx, DEFAULT_FEE_USTX, "--fee-ustx");
  const minGasReserve = parseNonNegativeBigInt(opts.minGasReserveUstx, DEFAULT_MIN_GAS_RESERVE_USTX, "--min-gas-reserve-ustx");
  const mempoolDepthLimit = parseInteger(opts.mempoolDepthLimit, DEFAULT_MEMPOOL_DEPTH_LIMIT, "--mempool-depth-limit");
  const [quote, inputBalance, outputBalance, stxAvailable, pendingDepth] = await Promise.all([
    requireAmount ? sdkCall("getQuoteForRoute", () => sdk.getQuoteForRoute(tokenIn.tokenId, tokenOut.tokenId, amountHuman)) : Promise.resolve(null),
    getFtBalance(opts.wallet, tokenIn),
    getFtBalance(opts.wallet, tokenOut),
    getStxAvailable(opts.wallet),
    getPendingDepth(opts.wallet),
  ]);
  if (requireAmount && !quote?.bestRoute?.route) {
    throw new BlockedError("NO_ROUTE", "Bitflow aggregator did not return an executable route.", "Try a different token pair or amount.", { tokenIn: tokenIn.tokenId, tokenOut: tokenOut.tokenId, amountIn: amountHuman });
  }
  if (requireAmount && inputBalance < amountAtomic) {
    throw new BlockedError("INSUFFICIENT_INPUT_BALANCE", "Wallet input balance is below the requested swap amount.", "Fund the wallet or reduce --amount-in.", { inputBalance, amountAtomic, tokenIn: tokenSummary(tokenIn) });
  }
  if (requireAmount && isStx(tokenIn)) {
    const totalStxNeeded = amountAtomic + fee + minGasReserve;
    if (stxAvailable < totalStxNeeded) {
      throw new BlockedError("INSUFFICIENT_STX_FOR_SWAP_AND_GAS", "Native STX cannot cover input amount, fee, and residual gas reserve.", "Reduce --amount-in or fund the wallet.", { stxAvailable, amountAtomic, fee, minGasReserve, totalStxNeeded });
    }
  } else if (stxAvailable < fee + minGasReserve) {
    throw new BlockedError("INSUFFICIENT_GAS_RESERVE", "Native STX cannot cover fee and residual gas reserve.", "Fund STX for transaction fees.", { stxAvailable, fee, minGasReserve });
  }
  const partialContext = {
    wallet: opts.wallet,
    tokenIn,
    tokenOut,
    amountHuman,
    amountAtomic,
    slippageDecimal,
    fee,
    minGasReserve,
    pendingDepth,
    mempoolDepthLimit,
    inputBalance,
    outputBalance,
    stxAvailable,
    quote,
  };
  const swapParams = requireAmount ? await prepareSwap(sdk, partialContext) : null;
  if (requireAmount && !swapParams?.contractAddress) {
    throw new BlockedError("PREPARE_SWAP_FAILED", "Bitflow SDK did not return executable swap parameters.", "Inspect quote output and retry later.", { route: routeSummary(quote) });
  }
  return { ...partialContext, swapParams } as Context;
}

function contextData(context: Context): JsonMap {
  return {
    network: NETWORK,
    wallet: context.wallet,
    tokens: {
      input: tokenSummary(context.tokenIn),
      output: tokenSummary(context.tokenOut),
    },
    amount: {
      amountInHuman: context.amountHuman,
      amountInAtomic: context.amountAtomic,
      slippageBps: Math.round(context.slippageDecimal * 10_000),
    },
    quote: context.quote ? routeSummary(context.quote) : null,
    execution: context.swapParams
      ? {
          contract: `${context.swapParams.contractAddress}.${context.swapParams.contractName}`,
          function: context.swapParams.functionName,
          postConditionMode: "deny",
          postConditionCount: Array.isArray(context.swapParams.postConditions) ? context.swapParams.postConditions.length : 0,
          postConditions: postconditionSummary(context.swapParams.postConditions ?? []),
        }
      : null,
    balances: {
      inputBalance: context.inputBalance,
      outputBalance: context.outputBalance,
      stxAvailable: context.stxAvailable,
    },
    safety: {
      pendingDepth: context.pendingDepth,
      mempoolDepthLimit: context.mempoolDepthLimit,
      fee: context.fee,
      minGasReserve: context.minGasReserve,
    },
  };
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function aibtcPath(...parts: string[]): string {
  return path.join(os.homedir(), ".aibtc", ...parts);
}

async function decryptSessionAccount(walletId: string): Promise<{ privateKey: string; address: string; source: string }> {
  const session = await readJsonFile<SessionFile>(aibtcPath("sessions", `${path.basename(walletId)}.json`));
  if (!session || session.version !== 1) throw new Error("unsupported AIBTC session format");
  if (session.expiresAt && new Date(session.expiresAt) < new Date()) throw new Error("AIBTC wallet session expired");
  const sessionKey = await fs.readFile(aibtcPath("sessions", ".session-key")).catch(() => null);
  if (!sessionKey || sessionKey.length !== 32) throw new Error("AIBTC session key missing");
  const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey, Buffer.from(session.encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(session.encrypted.authTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(session.encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
  const account = JSON.parse(decrypted.toString("utf8"));
  return { privateKey: account.privateKey, address: account.address, source: "AIBTC_SESSION_FILE" };
}

async function decryptAibtcKeystore(enc: any, password: string): Promise<string> {
  const { N, r, p, keyLen } = enc.scryptParams;
  const salt = Buffer.from(enc.salt, "base64");
  const iv = Buffer.from(enc.iv, "base64");
  const authTag = Buffer.from(enc.authTag, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const key = crypto.scryptSync(password, salt, keyLen ?? 32, { N, r, p });
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8").trim();
}

async function decryptKeystoreAccount(walletId: string, password: string): Promise<{ privateKey: string; address: string; source: string }> {
  const keystore = await readJsonFile<any>(aibtcPath("wallets", path.basename(walletId), "keystore.json"));
  let mnemonic: string | null = null;
  if (keystore.encrypted?.ciphertext) {
    mnemonic = await decryptAibtcKeystore(keystore.encrypted, password);
  } else if (keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic) {
    const { decryptMnemonic } = await import("@stacks/encryption") as any;
    mnemonic = await decryptMnemonic(keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic, password);
  }
  if (!mnemonic) throw new Error("Unsupported AIBTC keystore format");
  const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk") as any;
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
  return { privateKey: account.stxPrivateKey, address: getStxAddress(account), source: "AIBTC_KEYSTORE" };
}

async function resolveSigner(expectedWallet: string): Promise<{ privateKey: string; address: string; source: string }> {
  const attempts: string[] = [];
  const config = await readJsonFile<{ activeWalletId?: string }>(aibtcPath("config.json")).catch(() => ({}));
  const walletId = process.env.AIBTC_WALLET_ID || config.activeWalletId;
  if (walletId) {
    try {
      const account = await decryptSessionAccount(walletId);
      if (account.address !== expectedWallet) throw new Error(`AIBTC session resolves to ${account.address}, expected ${expectedWallet}`);
      return account;
    } catch (error) {
      attempts.push(`AIBTC_SESSION: ${error instanceof Error ? error.message : String(error)}`);
    }
    const password = process.env.AIBTC_WALLET_PASSWORD;
    if (password) {
      try {
        const account = await decryptKeystoreAccount(walletId, password);
        if (account.address !== expectedWallet) throw new Error(`AIBTC keystore resolves to ${account.address}, expected ${expectedWallet}`);
        return account;
      } catch (error) {
        attempts.push(`AIBTC_KEYSTORE: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      attempts.push("AIBTC_KEYSTORE: AIBTC_WALLET_PASSWORD not set");
    }
  } else {
    attempts.push("AIBTC: no active wallet id");
  }
  const privateKey = process.env.STACKS_PRIVATE_KEY?.trim();
  if (privateKey) {
    const address = getAddressFromPrivateKey(privateKey, "mainnet");
    if (address !== expectedWallet) throw new Error(`STACKS_PRIVATE_KEY resolves to ${address}, expected ${expectedWallet}`);
    return { privateKey, address, source: "STACKS_PRIVATE_KEY" };
  }
  attempts.push("STACKS_PRIVATE_KEY: not set");
  throw new Error(`Could not resolve signer. ${attempts.join("; ")}`);
}

async function broadcast(tx: Awaited<ReturnType<typeof makeContractCall>>): Promise<string> {
  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result) throw new Error(JSON.stringify(result));
  return result.txid.startsWith("0x") ? result.txid : `0x${result.txid}`;
}

async function waitForTx(txid: string, waitSeconds: number): Promise<JsonMap | null> {
  const deadline = Date.now() + waitSeconds * 1000;
  let last: JsonMap | null = null;
  while (Date.now() <= deadline) {
    try {
      const tx = await fetchJson<JsonMap>(`${HIRO_API}/extended/v1/tx/${txid}`);
      last = tx;
      const status = String(tx.tx_status ?? "");
      if (status === "success" || status === "failed" || status.startsWith("abort")) return tx;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("HTTP 404 ")) throw error;
      last = { tx_status: "not_indexed", tx_id: txid };
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return last;
}

function txProof(txid: string, tx: JsonMap | null, fallback: { contract: string; functionName: string }, postConditionCount: number): JsonMap {
  return {
    txid,
    explorer: `${EXPLORER}/${txid}?chain=mainnet`,
    status: tx?.tx_status ?? "unknown",
    sender: tx?.sender_address ?? null,
    contract: (tx?.contract_call as JsonMap | undefined)?.contract_id ?? fallback.contract,
    function: (tx?.contract_call as JsonMap | undefined)?.function_name ?? fallback.functionName,
    result: (tx?.tx_result as JsonMap | undefined)?.repr ?? null,
    postConditionMode: tx?.post_condition_mode ?? "deny",
    postConditionCount: Array.isArray(tx?.post_conditions) ? (tx?.post_conditions as Json[]).length : postConditionCount,
  };
}

async function runDoctor(opts: SharedOptions) {
  try {
    if (NETWORK !== "mainnet") throw new BlockedError("MAINNET_ONLY", "bitflow-swap-aggregator is mainnet-only.", "Set NETWORK=mainnet.");
    const sdk = await createBitflowSdk();
    const tokens = await getTokens(sdk);
    const walletChecks: JsonMap = {};
    if (opts.wallet) {
      walletChecks.stxAvailable = await getStxAvailable(opts.wallet);
      walletChecks.pendingDepth = await getPendingDepth(opts.wallet);
    }
    success("doctor", {
      network: NETWORK,
      bitflowSdk: {
        getAvailableTokens: typeof sdk.getAvailableTokens === "function",
        getQuoteForRoute: typeof sdk.getQuoteForRoute === "function",
        prepareSwap: typeof sdk.prepareSwap === "function",
        getSwapParams: typeof sdk.getSwapParams === "function",
      },
      tokenCount: tokens.length,
      sampleTokens: tokens.slice(0, 10).map(tokenSummary),
      wallet: opts.wallet ?? null,
      walletChecks,
    });
  } catch (error) {
    fail("doctor", error);
  }
}

async function runTokens(opts: SharedOptions) {
  try {
    const sdk = await createBitflowSdk();
    let tokens = await getTokens(sdk);
    if (opts.search) tokens = tokens.filter((token) => matchesToken(token, opts.search!));
    const limit = parseInteger(opts.limit, 50, "--limit");
    success("tokens", {
      count: tokens.length,
      showing: Math.min(tokens.length, limit),
      tokens: tokens.slice(0, limit).map(tokenSummary),
    });
  } catch (error) {
    fail("tokens", error);
  }
}

async function runQuote(opts: SharedOptions) {
  try {
    // Bitflow's quote service, not the SDK's route quote: see QUOTE_SERVICE.
    const context = await buildServiceContext(opts, false);
    success("quote", serviceQuoteData(context));
  } catch (error) {
    fail("quote", error);
  }
}

async function runPlan(opts: SharedOptions) {
  try {
    // Bitflow's quote service builds the swap; this checks it and hands it on
    // unsigned. Nothing here signs or broadcasts.
    const context = await buildServiceContext(opts, true);
    success("plan", { ...serviceQuoteData(context), instructions: [serviceInstruction(context)] });
  } catch (error) {
    fail("plan", error);
  }
}

async function runSwap(opts: RunOptions) {
  try {
    if (opts.confirm !== CONFIRM_TOKEN) {
      throw new BlockedError("CONFIRMATION_REQUIRED", "This write skill requires --confirm=SWAP.", "Re-run with --confirm=SWAP after reviewing plan output.");
    }
    const context = await buildContext(opts, true);
    if (context.pendingDepth > context.mempoolDepthLimit) {
      throw new BlockedError("PENDING_TX_DEPTH", "Wallet has pending STX transactions above the configured limit.", "Wait for pending transactions to settle before broadcasting.", { pendingDepth: context.pendingDepth, mempoolDepthLimit: context.mempoolDepthLimit });
    }
    if (!context.swapParams) {
      throw new BlockedError("PREPARE_SWAP_FAILED", "Bitflow SDK did not return executable swap parameters.", "Inspect plan output and retry later.");
    }
    const swapParams = context.swapParams;
    const signer = await resolveSigner(context.wallet);
    const tx = await makeContractCall({
      contractAddress: swapParams.contractAddress,
      contractName: swapParams.contractName,
      functionName: swapParams.functionName,
      functionArgs: swapParams.functionArgs,
      postConditions: swapParams.postConditions,
      postConditionMode: PostConditionMode.Deny,
      network: STACKS_MAINNET,
      senderKey: signer.privateKey,
      anchorMode: AnchorMode.Any,
      fee: context.fee,
    });
    const txid = await broadcast(tx);
    const waitSeconds = parseInteger(opts.waitSeconds, DEFAULT_WAIT_SECONDS, "--wait-seconds");
    const mined = await waitForTx(txid, waitSeconds);
    const proof = txProof(
      txid,
      mined,
      { contract: `${swapParams.contractAddress}.${swapParams.contractName}`, functionName: swapParams.functionName },
      Array.isArray(swapParams.postConditions) ? swapParams.postConditions.length : 0
    );
    const [inputBalanceAfter, outputBalanceAfter, stxAvailableAfter] = await Promise.all([
      getFtBalance(context.wallet, context.tokenIn),
      getFtBalance(context.wallet, context.tokenOut),
      getStxAvailable(context.wallet),
    ]);
    const balancesAfter = { inputBalance: inputBalanceAfter, outputBalance: outputBalanceAfter, stxAvailable: stxAvailableAfter };
    if (proof.status !== "success") {
      const message =
        proof.status === "not_indexed"
          ? "Broadcast transaction was not confirmed as success within the wait window."
          : `Broadcast transaction finished with status ${proof.status}.`;
      throw new BlockedError("TX_NOT_SUCCESS", message, "Inspect the proof payload, adjust the plan, and retry only after the blocker is understood.", {
        ...contextData(context),
        signer: { source: signer.source, address: signer.address },
        proof,
        balancesAfter,
      });
    }
    success("run", {
      ...contextData(context),
      signer: { source: signer.source, address: signer.address },
      proof,
      balancesAfter,
    });
  } catch (error) {
    fail("run", error);
  }
}

function addSharedOptions(command: Command): Command {
  return command
    .option("--wallet <stacks-address>", "wallet that owns the input asset")
    .option("--token-in <token>", "input token symbol, token ID, or contract ID")
    .option("--token-out <token>", "output token symbol, token ID, or contract ID")
    .option("--amount-in <decimal>", "human-readable input amount")
    .option("--slippage-bps <bps>", "slippage tolerance in basis points", String(DEFAULT_SLIPPAGE_BPS))
    .option("--fee-ustx <uSTX>", "transaction fee in micro-STX", DEFAULT_FEE_USTX.toString())
    .option("--min-gas-reserve-ustx <uSTX>", "minimum residual STX after write", DEFAULT_MIN_GAS_RESERVE_USTX.toString())
    .option("--mempool-depth-limit <number>", "maximum allowed pending STX transactions", String(DEFAULT_MEMPOOL_DEPTH_LIMIT))
    .option("--wait-seconds <seconds>", "transaction status wait window", String(DEFAULT_WAIT_SECONDS));
}

const program = new Command();

program
  .name("bitflow-swap-aggregator")
  .description("Quote, plan, and execute Bitflow aggregator swaps on Stacks mainnet")
  .version("0.1.0");

addSharedOptions(program.command("doctor").description("Check environment and Bitflow readiness")).action(runDoctor);

program
  .command("tokens")
  .description("List live Bitflow tokens")
  .option("--search <value>", "filter by symbol, token ID, or contract ID")
  .option("--limit <number>", "maximum tokens to return", "50")
  .action(runTokens);

addSharedOptions(program.command("quote").description("Fetch a live Bitflow aggregator quote")).action(runQuote);
addSharedOptions(program.command("plan").description("Prepare a Bitflow aggregator swap without broadcasting")).action(runPlan);
addSharedOptions(program.command("run").description("Execute a Bitflow aggregator swap"))
  .option("--confirm <SWAP>", "required confirmation token")
  .action(runSwap);

program.parse(process.argv);
