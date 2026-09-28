// Runs every wallet in PRIVATE_KEYS concurrently. One trade = flip the whole USDG balance into
// NVDA and straight back. Each wallet rolls DAILY_TRADES_MIN..MAX trades per local day and
// spreads them across ACTIVE_HOURS_START..END with random gaps (clamped to DELAY_SEC_MIN..MAX).
// A wallet stops for good once it has lost MAX_LOSS_USD or holds < MIN_TRADE_USD.
// Ctrl+C / SIGTERM once: wallets finish any open trade (end in USDG) and stop. Twice: exit now.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { formatUnits, parseUnits, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { balanceOf, logTrade, publicClient, waitForBalanceChange } from './chain.ts'
import { TOKENS, loadEnv, type Token } from './config.ts'
import { formatDuration, msUntilNextDay, nextTradeDelayMs, planForToday, type DayPlan } from './schedule.ts'
import { executeSwap, type SwapContext } from './swap.ts'

const { USDG, NVDA } = TOKENS
const STATE_FILE = 'logs/state.json'
const MAX_CONSECUTIVE_FAILURES = 5
// Leftover NVDA below this (~$0.25) is not worth a swap and may fall under the router minimum.
const NVDA_DUST = parseUnits('0.001', NVDA.decimals)

interface WalletState {
  startUsdg: string
  nvdaBaseline: string
  volumeUsd: number
  roundTrips: number
  day?: DayPlan
}

const env = loadEnv()
const maxLoss = parseUnits(String(env.maxLossUsd), USDG.decimals)
const minTrade = parseUnits(String(env.minTradeUsd), USDG.decimals)
const state: Record<string, WalletState> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {}
const saveState = () => {
  mkdirSync('logs', { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

const stop = new AbortController()
const usd = (amount: bigint) => Number(formatUnits(amount, USDG.decimals))
// Resolves early when a stop is requested, so long waits never block shutdown.
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    if (stop.signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    stop.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })

async function runWallet(privateKey: Hex, index: number): Promise<string> {
  const account = privateKeyToAccount(privateKey)
  const label = `#${index + 1} ${account.address.slice(0, 8)}`
  const ctx: SwapContext = { client: publicClient, account, slippageBps: env.slippageBps }
  const log = (msg: string) => console.log(`${new Date().toLocaleTimeString('en-GB')} ${label} ${msg}`)

  let [usdg, nvda] = await Promise.all([balanceOf(USDG, account.address), balanceOf(NVDA, account.address)])
  // First run records the budget baseline; restarts keep it so the loss limit spans sessions.
  const s = (state[account.address] ??= {
    startUsdg: usdg.toString(),
    nvdaBaseline: nvda.toString(),
    volumeUsd: 0,
    roundTrips: 0,
  })
  saveState()
  const startUsdg = BigInt(s.startUsdg)
  const nvdaBaseline = BigInt(s.nvdaBaseline)
  log(`start USDG ${formatUnits(usdg, USDG.decimals)} (baseline ${formatUnits(startUsdg, USDG.decimals)}), volume so far $${s.volumeUsd.toFixed(2)}`)

  let failures = 0
  let lastRoundTripCost = 0n
  let roundTripStartUsdg = usdg

  async function leg(sell: Token, buy: Token, amount: bigint): Promise<boolean> {
    try {
      const result = await executeSwap(ctx, sell, buy, amount, { dryRun: false })
      logTrade({ source: 'bot', taker: account.address, ...result })
      if (result.status === 'confirmed') {
        failures = 0
        return true
      }
      log(`${sell.symbol}->${buy.symbol} ${result.status} ${result.errorCode ?? ''} tx=${result.txHash}`)
    } catch (err) {
      log(`${sell.symbol}->${buy.symbol} error: ${err instanceof Error ? err.message : err}`)
      logTrade({ source: 'bot', taker: account.address, error: String(err) })
    }
    failures++
    await sleep(1000 * failures)
    return false
  }

  for (;;) {
    if (failures >= MAX_CONSECUTIVE_FAILURES) return `${label} stopped: ${failures} consecutive failures`

    // Holding NVDA from our own buy (or from an interrupted run): sell it back right away,
    // even when stopping, so the trade completes as a back-to-back pair.
    const nvdaHeld = nvda - nvdaBaseline
    if (nvdaHeld > NVDA_DUST) {
      const before = usdg
      if (await leg(NVDA, USDG, nvdaHeld)) {
        usdg = await waitForBalanceChange(USDG, account.address, before)
        nvda = await balanceOf(NVDA, account.address)
        lastRoundTripCost = roundTripStartUsdg - usdg
        s.volumeUsd += usd(usdg - before)
        s.roundTrips++
        s.day = planForToday(s.day, env.dailyTrades)
        s.day.done++
        saveState()
        const loss = startUsdg - usdg
        log(
          `trade ${s.day.done}/${s.day.target} today | total rt=${s.roundTrips} vol=$${s.volumeUsd.toFixed(2)} ` +
            `loss=$${usd(loss).toFixed(4)} last cost=$${usd(lastRoundTripCost).toFixed(4)}`,
        )
      } else {
        ;[usdg, nvda] = await Promise.all([balanceOf(USDG, account.address), balanceOf(NVDA, account.address)])
      }
      continue
    }

    const loss = startUsdg - usdg
    if (stop.signal.aborted) return `${label} stopped by user`
    // Do not start a round trip that would likely push past the loss budget.
    if (loss + lastRoundTripCost >= maxLoss) return `${label} loss budget reached ($${usd(loss).toFixed(4)})`
    if (usdg < minTrade) return `${label} USDG ${formatUnits(usdg, USDG.decimals)} below MIN_TRADE_USD`

    const plan = (s.day = planForToday(s.day, env.dailyTrades))
    saveState()
    const delay = nextTradeDelayMs(plan, env.activeHours, env.delaySec)
    if (delay === null) {
      const wait = msUntilNextDay()
      const why = plan.done >= plan.target ? `daily target ${plan.target} reached` : `outside active hours (${plan.done}/${plan.target} done)`
      log(`${why}, new day in ${formatDuration(wait)}`)
      await sleep(wait + 1000)
      continue
    }

    const at = new Date(Date.now() + delay).toLocaleTimeString('en-GB')
    log(`next trade (${plan.done + 1}/${plan.target} today) at ${at}, in ${formatDuration(delay)}`)
    await sleep(delay)
    if (stop.signal.aborted) return `${label} stopped by user`

    // Balances may have changed while idle (e.g. a manual top-up).
    ;[usdg, nvda] = await Promise.all([balanceOf(USDG, account.address), balanceOf(NVDA, account.address)])
    if (usdg < minTrade || nvda - nvdaBaseline > NVDA_DUST) continue

    roundTripStartUsdg = usdg
    const before = nvda
    if (await leg(USDG, NVDA, usdg)) {
      nvda = await waitForBalanceChange(NVDA, account.address, before)
      s.volumeUsd += usd(usdg)
      saveState()
    } else {
      // A timed-out swap may still have settled; re-read so the next step sees real holdings.
      nvda = await balanceOf(NVDA, account.address)
    }
    usdg = await balanceOf(USDG, account.address)
  }
}

// SIGINT is Ctrl+C; SIGTERM is what systemd sends on `systemctl stop`.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stop.signal.aborted) process.exit(130)
    stop.abort()
    console.log(`\n${signal}: wallets finish any open trade, then exit (send again to exit now)`)
  })
}

async function main() {
  console.log(
    `${env.privateKeys.length} wallet(s) | slippage ${env.slippageBps} bps | max loss $${env.maxLossUsd}/wallet | ` +
      `min trade $${env.minTradeUsd} | gap ${env.delaySec.min}-${env.delaySec.max}s | ` +
      `${env.dailyTrades.min}-${env.dailyTrades.max} trades/day | active ${env.activeHours.min}h-${env.activeHours.max}h`,
  )
  const outcomes = await Promise.allSettled(env.privateKeys.map(runWallet))
  console.log('\n== summary')
  outcomes.forEach((o) => console.log(o.status === 'fulfilled' ? o.value : `failed: ${o.reason}`))
  const total = Object.values(state).reduce((sum, w) => sum + w.volumeUsd, 0)
  console.log(`total volume across wallets: $${total.toFixed(2)}`)
}

main().catch((err) => {
  console.error('bot failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
