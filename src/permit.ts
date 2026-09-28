import {
  domainSeparator,
  erc20Abi,
  maxUint256,
  parseAbi,
  parseSignature,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type TypedDataDomain,
} from 'viem'
import { CHAIN_ID, PERMIT2 } from './config.ts'
import type { Erc2612Permit } from './router-client.ts'

const erc2612Abi = parseAbi([
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function name() view returns (string)',
])

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

const domainCache = new Map<Address, TypedDataDomain>()

// Tokens do not all expose eip712Domain(), so rebuild the domain from name() and
// match it against the on-chain DOMAIN_SEPARATOR to find the right version.
async function resolvePermitDomain(client: PublicClient, token: Address): Promise<TypedDataDomain> {
  const cached = domainCache.get(token)
  if (cached) return cached
  const [name, onChainSeparator] = await Promise.all([
    client.readContract({ address: token, abi: erc2612Abi, functionName: 'name' }),
    client.readContract({ address: token, abi: erc2612Abi, functionName: 'DOMAIN_SEPARATOR' }),
  ])
  for (const version of ['1', '2']) {
    const domain: TypedDataDomain = { name, version, chainId: CHAIN_ID, verifyingContract: token }
    if (domainSeparator({ domain }) === onChainSeparator) {
      domainCache.set(token, domain)
      return domain
    }
  }
  throw new Error(`could not resolve EIP-2612 domain for ${token} (${name})`)
}

/**
 * Returns a signed EIP-2612 permit granting Permit2 an unlimited allowance when the
 * current allowance cannot cover `amount`; the router relays it inside the swap tx,
 * so first-time trades need no ETH for gas. Returns undefined when already approved.
 */
export async function buildPermit2Approval(
  client: PublicClient,
  account: Account,
  token: Address,
  amount: bigint,
): Promise<Erc2612Permit | undefined> {
  const allowance = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, PERMIT2],
  })
  if (allowance >= amount) return undefined
  if (!account.signTypedData) throw new Error('account cannot sign typed data')

  const [domain, nonce] = await Promise.all([
    resolvePermitDomain(client, token),
    client.readContract({ address: token, abi: erc2612Abi, functionName: 'nonces', args: [account.address] }),
  ])
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60)
  const signature: Hex = await account.signTypedData({
    domain,
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: { owner: account.address, spender: PERMIT2, value: maxUint256, nonce, deadline },
  })
  const { r, s, v, yParity } = parseSignature(signature)
  return {
    token,
    value: maxUint256.toString(),
    deadline: deadline.toString(),
    v: Number(v ?? BigInt(yParity + 27)),
    r,
    s,
  }
}
