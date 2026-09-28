import { appendFileSync, mkdirSync } from 'node:fs'
import { createPublicClient, erc20Abi, http, type Address, type PublicClient } from 'viem'
import { robinhoodChain, type Token } from './config.ts'

export const publicClient: PublicClient = createPublicClient({ chain: robinhoodChain, transport: http() })

export function balanceOf(token: Token, owner: Address): Promise<bigint> {
  return publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
}

// The RPC node can trail the router's confirmation by a block, so wait until the balance moves.
export async function waitForBalanceChange(token: Token, owner: Address, previous: bigint, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const current = await balanceOf(token, owner)
    if (current !== previous || Date.now() > deadline) return current
    await new Promise((r) => setTimeout(r, 200))
  }
}

export function logTrade(entry: Record<string, unknown>) {
  mkdirSync('logs', { recursive: true })
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  )
  appendFileSync('logs/trades.jsonl', line + '\n')
}
