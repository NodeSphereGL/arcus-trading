import { defineChain, type Address, type Hex } from 'viem'

export const ROUTER_URL = 'https://router.spot.arcus.xyz'
export const CHAIN_ID = 4663
export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
// From GET /v1/deployment; the only spender a swap intent may authorize.
export const ARCUS_SETTLEMENT: Address = '0x006102b16A04c20306A28b652745D3973D7D24fa'

export const TOKENS = {
  USDG: { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 },
  NVDA: { symbol: 'NVDA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', decimals: 18 },
} as const satisfies Record<string, Token>

export interface Token {
  symbol: string
  address: Address
  decimals: number
}

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'] } },
})

export interface BotEnv {
  privateKeys: Hex[]
  slippageBps: number
  maxLossUsd: number
  minTradeUsd: number
  delaySec: Range
  dailyTrades: Range
  // Local hours [min, max) during which trades may happen.
  activeHours: Range
}

export interface Range {
  min: number
  max: number
}

function rangeEnv(prefix: string, fallback: Range, floor: number): Range {
  const range = {
    min: numberEnv(`${prefix}_MIN`, fallback.min, floor, 1_000_000),
    max: numberEnv(`${prefix}_MAX`, fallback.max, floor, 1_000_000),
  }
  if (range.min > range.max) throw new Error(`${prefix}_MIN must be <= ${prefix}_MAX`)
  return range
}

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`)
  }
  return value
}

export function loadEnv(): BotEnv {
  // PRIVATE_KEYS is a comma-separated list; PRIVATE_KEY alone still works for a single wallet.
  const raw = process.env.PRIVATE_KEYS || process.env.PRIVATE_KEY || ''
  const privateKeys = raw.split(',').map((k) => k.trim()).filter(Boolean)
  if (!privateKeys.length) throw new Error('PRIVATE_KEYS (or PRIVATE_KEY) missing in .env')
  privateKeys.forEach((key, i) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`private key #${i + 1} malformed (expected 0x + 64 hex chars)`)
  })
  const slippageBps = numberEnv('SLIPPAGE_BPS', 50, 1, 500)
  if (!Number.isInteger(slippageBps)) throw new Error('SLIPPAGE_BPS must be an integer')
  return {
    privateKeys: privateKeys as Hex[],
    slippageBps,
    maxLossUsd: numberEnv('MAX_LOSS_USD', 20, 0.01, 1_000_000),
    minTradeUsd: numberEnv('MIN_TRADE_USD', 10, 1, 1_000_000),
    delaySec: rangeEnv('DELAY_SEC', { min: 300, max: 5400 }, 0),
    // ~18 trades/day at ~$0.079 each burns about $20 over 14 days from a ~$30 wallet.
    dailyTrades: rangeEnv('DAILY_TRADES', { min: 14, max: 22 }, 1),
    activeHours: activeHoursEnv(),
  }
}

function activeHoursEnv(): Range {
  const hours = {
    min: numberEnv('ACTIVE_HOURS_START', 8, 0, 23),
    max: numberEnv('ACTIVE_HOURS_END', 23, 1, 24),
  }
  if (!Number.isInteger(hours.min) || !Number.isInteger(hours.max) || hours.min >= hours.max) {
    throw new Error('ACTIVE_HOURS_START and ACTIVE_HOURS_END must be whole hours with START < END')
  }
  return hours
}
