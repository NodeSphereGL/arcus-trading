import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDuration, msUntilNextDay, nextTradeDelayMs, planForToday, randomInt } from './schedule.ts'

test('randomInt stays within the inclusive range and hits both ends', () => {
  const seen = new Set<number>()
  for (let i = 0; i < 2000; i++) {
    const n = randomInt({ min: 3, max: 5 })
    assert.ok(n >= 3 && n <= 5 && Number.isInteger(n))
    seen.add(n)
  }
  assert.deepEqual([...seen].sort(), [3, 4, 5])
  assert.equal(randomInt({ min: 4, max: 4 }), 4)
})

const HOURS = { min: 8, max: 23 }
const GAP = { min: 300, max: 5400 }
const at = (h: number, m = 0) => new Date(2026, 8, 28, h, m)

test('nextTradeDelayMs waits for the window to open before the first trade', () => {
  const plan = { date: '2026-09-28', target: 15, done: 0 }
  // 15 trades over 15h -> even spacing 1h; random 0.5 -> 1h gap after the 08:00 open.
  const ms = nextTradeDelayMs(plan, HOURS, GAP, at(6), () => 0.5)!
  assert.equal(ms, 3 * 3_600_000)
})

test('nextTradeDelayMs clamps gaps to DELAY_SEC bounds', () => {
  const few = { date: '2026-09-28', target: 1, done: 0 }
  assert.equal(nextTradeDelayMs(few, HOURS, GAP, at(8), () => 0.99), 5_400_000)
  const many = { date: '2026-09-28', target: 500, done: 0 }
  assert.equal(nextTradeDelayMs(many, HOURS, GAP, at(8), () => 0), 300_000)
})

test('nextTradeDelayMs returns null when done, past the window, or out of time', () => {
  assert.equal(nextTradeDelayMs({ date: '2026-09-28', target: 5, done: 5 }, HOURS, GAP, at(10)), null)
  assert.equal(nextTradeDelayMs({ date: '2026-09-28', target: 5, done: 0 }, HOURS, GAP, at(23, 30)), null)
  // 22:58 with a 5-minute minimum gap would land after 23:00.
  assert.equal(nextTradeDelayMs({ date: '2026-09-28', target: 5, done: 0 }, HOURS, GAP, at(22, 58)), null)
})

test('a simulated day fits the target inside the active window', () => {
  for (let run = 0; run < 200; run++) {
    const plan = { date: '2026-09-28', target: 22, done: 0 }
    let now = at(0).getTime()
    for (;;) {
      const ms = nextTradeDelayMs(plan, HOURS, GAP, new Date(now))
      if (ms === null) break
      now += ms + 5_000 // the trade itself takes a few seconds
      assert.ok(new Date(now).getHours() >= 8 && now <= at(23).getTime() + 5_000)
      plan.done++
    }
    assert.ok(plan.done >= 20, `only ${plan.done}/22 trades fit`)
  }
})

test('planForToday keeps the plan within a day and re-rolls on a new day', () => {
  const day1 = new Date(2026, 8, 28, 10, 0)
  const plan = planForToday(undefined, { min: 3, max: 8 }, day1)
  assert.equal(plan.date, '2026-09-28')
  assert.equal(plan.done, 0)
  plan.done = 2
  assert.equal(planForToday(plan, { min: 3, max: 8 }, new Date(2026, 8, 28, 23, 59)), plan)
  const next = planForToday(plan, { min: 3, max: 8 }, new Date(2026, 8, 29, 0, 1))
  assert.equal(next.date, '2026-09-29')
  assert.equal(next.done, 0)
})

test('msUntilNextDay counts to local midnight', () => {
  assert.equal(msUntilNextDay(new Date(2026, 8, 28, 23, 0)), 3_600_000)
})

test('formatDuration is human readable', () => {
  assert.equal(formatDuration(5_000), '5s')
  assert.equal(formatDuration(185_000), '3m 5s')
  assert.equal(formatDuration(3_725_000), '1h 2m 5s')
})
