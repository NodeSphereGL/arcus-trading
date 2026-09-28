import { getAddress, isAddressEqual, type Account, type Address, type Hex, type PublicClient } from 'viem'
import { ARCUS_SETTLEMENT, CHAIN_ID, PERMIT2, type Token } from './config.ts'
import { buildPermit2Approval } from './permit.ts'
import { getQuote, getSwapStatus, submitSwap, type SwapStatus, type VenueQuote } from './router-client.ts'

export interface SwapContext {
  client: PublicClient
  account: Account
  slippageBps: number
}

export interface SwapResult {
  sell: string
  buy: string
  sellAmount: bigint
  quotedBuyAmount: bigint
  minBuyAmount: bigint
  feesUsd: number
  withPermit: boolean
  txHash?: Hex
  status: SwapStatus['status'] | 'dry-run'
  errorCode?: string | null
  latencyMs: { prepare: number; submit?: number; confirm?: number; total: number }
}

type IntentMessage = {
  permitted: { token: string; amount: string }
  spender: string
  witness: { taker: string; takerSellToken: string; takerBuyToken: string; sellAmount: string; minBuyAmount: string }
}

// Refuse to sign anything that does not exactly match the swap we asked for.
function assertIntentMatches(quote: VenueQuote, taker: Address, sell: Token, buy: Token, amount: bigint): IntentMessage {
  const toSign = quote.toSign
  if (!toSign) throw new Error('quote has no toSign payload')
  const domain = toSign.domain ?? {}
  const msg = toSign.message as unknown as IntentMessage
  const checks: [string, boolean][] = [
    ['primaryType', toSign.primaryType === 'PermitWitnessTransferFrom'],
    ['domain.chainId', Number(domain.chainId) === CHAIN_ID],
    ['domain.verifyingContract', !!domain.verifyingContract && isAddressEqual(domain.verifyingContract, PERMIT2)],
    ['spender', isAddressEqual(getAddress(msg.spender), ARCUS_SETTLEMENT)],
    ['permitted.token',isAddressEqual(getAddress(msg.permitted.token), sell.address)],
    ['permitted.amount', BigInt(msg.permitted.amount) === amount],
    ['witness.taker', isAddressEqual(getAddress(msg.witness.taker), taker)],
    ['witness.takerSellToken', isAddressEqual(getAddress(msg.witness.takerSellToken), sell.address)],
    ['witness.takerBuyToken', isAddressEqual(getAddress(msg.witness.takerBuyToken), buy.address)],
    ['witness.sellAmount', BigInt(msg.witness.sellAmount) === amount],
    ['witness.minBuyAmount', BigInt(msg.witness.minBuyAmount) > 0n],
  ]
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
  if (failed.length) throw new Error(`quote intent mismatch: ${failed.join(', ')}`)
  return msg
}

// The router returns uint256 values as decimal strings; viem encodes them as bigint.
function toSignableMessage(types: Record<string, readonly { name: string; type: string }[]>, type: string, value: any): any {
  const fields = types[type]
  if (!fields) return /^u?int\d*$/.test(type) ? BigInt(value) : value
  return Object.fromEntries(fields.map((f) => [f.name, toSignableMessage(types, f.type, value[f.name])]))
}

async function waitForSettlement(venue: string, txHash: Hex, timeoutMs = 60_000): Promise<SwapStatus> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await getSwapStatus(venue, txHash).catch(() => undefined)
    if (status && (status.status === 'confirmed' || status.status === 'failed')) return status
    if (Date.now() > deadline) return status ?? { venue, status: 'unknown', txHash }
    await new Promise((r) => setTimeout(r, 250))
  }
}

export async function executeSwap(
  ctx: SwapContext,
  sell: Token,
  buy: Token,
  sellAmount: bigint,
  opts: { dryRun: boolean },
): Promise<SwapResult> {
  const t0 = performance.now()
  const taker = ctx.account.address
  const [permit, quoteRes] = await Promise.all([
    buildPermit2Approval(ctx.client, ctx.account, sell.address, sellAmount),
    getQuote({ sellToken: sell.address, buyToken: buy.address, sellAmount, taker, slippageBps: ctx.slippageBps }),
  ])
  const quote = quoteRes.all.find((q) => q.venue === quoteRes.recommended)
  if (!quote || quote.venue !== 'arcus') throw new Error(`no arcus quote: ${JSON.stringify(quoteRes.errors)}`)
  const intent = assertIntentMatches(quote, taker, sell, buy, sellAmount)
  const toSign = quote.toSign!
  if (!ctx.account.signTypedData) throw new Error('account cannot sign typed data')
  const signature = await ctx.account.signTypedData({
    domain: toSign.domain,
    types: toSign.types,
    primaryType: toSign.primaryType,
    message: toSignableMessage(toSign.types as any, toSign.primaryType, toSign.message),
  } as any)
  const tPrepared = performance.now()

  const base = {
    sell: sell.symbol,
    buy: buy.symbol,
    sellAmount,
    quotedBuyAmount: BigInt(quote.buyAmount),
    minBuyAmount: BigInt(intent.witness.minBuyAmount),
    feesUsd: quote.fees.reduce((sum, f) => sum + f.amountUsd, 0),
    withPermit: !!permit,
  }
  if (opts.dryRun) {
    return { ...base, status: 'dry-run', latencyMs: { prepare: tPrepared - t0, total: tPrepared - t0 } }
  }

  const submitted = await submitSwap({
    venue: quote.venue,
    chainId: CHAIN_ID,
    taker,
    signature,
    typedData: toSign,
    buyToken: buy.address,
    ...(permit ? { permits: [permit] } : {}),
  })
  const tSubmitted = performance.now()
  const final = await waitForSettlement(submitted.venue, submitted.txHash)
  const tDone = performance.now()
  return {
    ...base,
    txHash: submitted.txHash,
    status: final.status,
    errorCode: final.errorCode ?? final.reason,
    latencyMs: { prepare: tPrepared - t0, submit: tSubmitted - tPrepared, confirm: tDone - tSubmitted, total: tDone - t0 },
  }
}
