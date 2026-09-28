import type { Address, Hex, TypedDataDefinition } from 'viem'
import { CHAIN_ID, ROUTER_URL } from './config.ts'

export class RouterError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    readonly body: unknown,
  ) {
    super(`router ${httpStatus} ${code}: ${JSON.stringify(body)}`)
  }
}

export interface VenueQuote {
  venue: string
  buyAmount: string
  sellAmount: string
  expiry?: number
  fees: { amount: string; token: Address; type: string; bps: number; amountUsd: number }[]
  toSign?: TypedDataDefinition & { primaryType: string; message: Record<string, unknown> }
}

export interface QuoteResponse {
  recommended: string
  venue: string
  referencePrice: string | null
  all: VenueQuote[]
  errors: unknown[]
}

export interface Erc2612Permit {
  token: Address
  value: string
  deadline: string
  v: number
  r: Hex
  s: Hex
}

export interface SubmitRequest {
  venue: string
  chainId: number
  taker: Address
  signature: Hex
  typedData: unknown
  buyToken: Address
  permits?: Erc2612Permit[]
}

export interface SwapStatus {
  venue: string
  status: 'pending' | 'confirmed' | 'failed' | 'unknown'
  txHash: Hex
  blockNumber?: string
  reason?: string | null
  errorCode?: string | null
}

const MAX_RATE_LIMIT_RETRIES = 3

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res = await fetch(ROUTER_URL + path, init)
  // A 429 means the router did not process the request, so retrying (even a submit) is safe.
  for (let attempt = 0; res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
    const waitSec = Number(res.headers.get('retry-after')) || 2 ** (attempt + 1)
    await new Promise((r) => setTimeout(r, waitSec * 1000))
    res = await fetch(ROUTER_URL + path, init)
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const code = (body as { code?: string } | null)?.code ?? 'HTTP_ERROR'
    throw new RouterError(res.status, code, body)
  }
  return body as T
}

export function getQuote(params: {
  sellToken: Address
  buyToken: Address
  sellAmount: bigint
  taker: Address
  slippageBps: number
}): Promise<QuoteResponse> {
  const qs = new URLSearchParams({
    chainId: String(CHAIN_ID),
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    sellAmount: params.sellAmount.toString(),
    taker: params.taker,
    slippageBps: String(params.slippageBps),
    // Only the Arcus venue can win, so the submit payload shape stays fixed.
    sourceInclude: 'arcus',
  })
  return request(`/v1/quote?${qs}`)
}

export function submitSwap(body: SubmitRequest): Promise<{ venue: string; txHash: Hex; status?: string }> {
  return request('/v1/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function getSwapStatus(venue: string, txHash: Hex): Promise<SwapStatus> {
  const qs = new URLSearchParams({ chainId: String(CHAIN_ID), venue, id: txHash })
  return request(`/v1/status?${qs}`)
}
