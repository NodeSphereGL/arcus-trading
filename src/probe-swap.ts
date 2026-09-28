// One round trip USDG -> NVDA -> USDG to verify the router accepts our signed swaps.
// Usage: npm run probe                        (dry run: quote + sign, nothing submitted)
//        npm run probe -- --live              (real swaps with real funds, first wallet)
//        npm run probe -- --live --usd 15 --wallet 2
import { formatUnits, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { balanceOf, logTrade, publicClient, waitForBalanceChange } from './chain.ts'
import { TOKENS, loadEnv, type Token } from './config.ts'
import { executeSwap, type SwapContext, type SwapResult } from './swap.ts'

const args = process.argv.slice(2)
const argValue = (name: string, fallback: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const live = args.includes('--live')
const usd = argValue('--usd', '10')
const walletNumber = Number(argValue('--wallet', '1'))

const env = loadEnv()
const privateKey = env.privateKeys[walletNumber - 1]
if (!privateKey) throw new Error(`--wallet ${walletNumber} out of range (have ${env.privateKeys.length})`)
const account = privateKeyToAccount(privateKey)
const ctx: SwapContext = { client: publicClient, account, slippageBps: env.slippageBps }

function report(result: SwapResult, sellToken: Token, buyToken: Token) {
  const ms = Object.entries(result.latencyMs).map(([k, v]) => `${k}=${Math.round(v)}ms`).join(' ')
  console.log(
    `  ${result.sell} -> ${result.buy}: sell ${formatUnits(result.sellAmount, sellToken.decimals)}, ` +
      `quoted ${formatUnits(result.quotedBuyAmount, buyToken.decimals)}, fees $${result.feesUsd.toFixed(4)}, ` +
      `permit=${result.withPermit}, status=${result.status}${result.errorCode ? ` (${result.errorCode})` : ''}`,
  )
  if (result.txHash) console.log(`  tx https://robinhoodchain.blockscout.com/tx/${result.txHash}`)
  console.log(`  latency ${ms}`)
  logTrade({ source: 'probe', taker: account.address, live, ...result })
}

async function main() {
  const { USDG, NVDA } = TOKENS
  const sellAmount = parseUnits(usd, USDG.decimals)
  const [usdgStart, nvdaStart] = await Promise.all([balanceOf(USDG, account.address), balanceOf(NVDA, account.address)])
  console.log(`wallet ${account.address} | ${live ? 'LIVE' : 'dry run'} | slippage ${env.slippageBps} bps`)
  console.log(`  USDG ${formatUnits(usdgStart, USDG.decimals)} | NVDA ${formatUnits(nvdaStart, NVDA.decimals)}`)
  if (usdgStart < sellAmount) {
    if (live) throw new Error(`need at least ${usd} USDG, wallet has ${formatUnits(usdgStart, USDG.decimals)}`)
    console.log('  (insufficient USDG; dry run continues to exercise quote + signing)')
  }

  console.log('leg 1')
  const buyLeg = await executeSwap(ctx, USDG, NVDA, sellAmount, { dryRun: !live })
  report(buyLeg, USDG, NVDA)
  if (live && buyLeg.status !== 'confirmed') throw new Error('buy leg did not confirm; stopping')

  // Sell back exactly what leg 1 delivered, never NVDA the wallet held before.
  const nvdaToSell = live
    ? (await waitForBalanceChange(NVDA, account.address, nvdaStart)) - nvdaStart
    : buyLeg.quotedBuyAmount
  if (nvdaToSell <= 0n) throw new Error('no NVDA received from leg 1')

  console.log('leg 2')
  const sellLeg = await executeSwap(ctx, NVDA, USDG, nvdaToSell, { dryRun: !live })
  report(sellLeg, NVDA, USDG)

  const usdgAfterBuy = usdgStart - sellAmount
  const usdgEnd = live
    ? await waitForBalanceChange(USDG, account.address, usdgAfterBuy)
    : usdgAfterBuy + sellLeg.quotedBuyAmount
  const loss = usdgStart - usdgEnd
  const volume = Number(usd) + Number(formatUnits(usdgEnd - usdgAfterBuy, USDG.decimals))
  console.log(
    `round trip: volume ~$${volume.toFixed(2)}, cost $${formatUnits(loss, USDG.decimals)} ` +
      `(${((Number(loss) / Number(sellAmount)) * 1e4).toFixed(1)} bps of size)`,
  )
}

main().catch((err) => {
  console.error('probe failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
