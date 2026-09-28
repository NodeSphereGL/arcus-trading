import type { Range } from './config.ts'

export interface DayPlan {
  date: string
  target: number
  done: number
}

export const randomInt = (r: Range) => Math.floor(r.min + Math.random() * (Math.floor(r.max) - Math.floor(r.min) + 1))

// Local calendar date (machine time zone), e.g. 2026-09-28.
export const localDate = (now = new Date()) => now.toLocaleDateString('en-CA')

export function msUntilNextDay(now = new Date()): number {
  const next = new Date(now)
  next.setHours(24, 0, 0, 0)
  return next.getTime() - now.getTime()
}

// Keeps today's plan, or rolls a fresh daily target once the date changes.
export function planForToday(current: DayPlan | undefined, dailyTrades: Range, now = new Date()): DayPlan {
  const date = localDate(now)
  if (current?.date === date) return current
  return { date, target: randomInt(dailyTrades), done: 0 }
}

/**
 * Wait before the next trade, spreading the day's remaining trades across what is left of the
 * active window: each gap is a random 0.5x-1.5x of the even spacing, clamped to delaySec.
 * Returns null when no trade is left today or the next one would fall past the window's end.
 */
export function nextTradeDelayMs(
  plan: DayPlan,
  activeHours: Range,
  delaySec: Range,
  now = new Date(),
  random = Math.random,
): number | null {
  const remainingTrades = plan.target - plan.done
  const windowStart = new Date(now).setHours(activeHours.min, 0, 0, 0)
  const windowEnd = new Date(now).setHours(activeHours.max, 0, 0, 0)
  const from = Math.max(now.getTime(), windowStart)
  if (remainingTrades <= 0 || from >= windowEnd) return null
  const evenSpacing = (windowEnd - from) / remainingTrades
  const gap = Math.min(Math.max(evenSpacing * (0.5 + random()), delaySec.min * 1000), delaySec.max * 1000)
  const at = from + gap
  return at > windowEnd ? null : at - now.getTime()
}

export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return [h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ')
}
