import { test, expect } from 'bun:test'
import { recordUsage } from '../server/usage.js'

test('usage sends only fixed events and engine enums, with distinct event UUIDs', async () => {
  const previous = process.env.SCORECARD_ANALYTICS
  process.env.SCORECARD_ANALYTICS = '1'
  const requests = []
  const send = async (url, options) => {
    requests.push({ url, options, payload: JSON.parse(options.body) })
    return new Response(null, { status: 201 })
  }
  try {
    for (const engine of ['github', 'npm', 'page', 'profile', 'geo']) {
      await recordUsage(engine, false, send)
      await recordUsage(engine, true, send)
    }
    await recordUsage('https://private.example/?token=secret', false, send)
    await recordUsage('github', 'false', send)
    expect(requests).toHaveLength(10)
    expect(new Set(requests.map(r => r.payload.event_id)).size).toBe(10)
    for (const [i, { url, options, payload }] of requests.entries()) {
      expect(url).toBe('https://api.webkubor.online/v1/analytics/events')
      expect(options.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(options.signal).toBeInstanceOf(AbortSignal)
      expect(Object.keys(payload).sort()).toEqual(['event', 'event_id', 'project', 'properties'])
      expect(payload.project).toBe('scorecard')
      expect(payload.event).toBe(i % 2 ? 'report.cached' : 'audit.succeeded')
      expect(Object.keys(payload.properties)).toEqual(['engine'])
    }
    await expect(recordUsage('github', false, async () => { throw new Error('offline') })).resolves.toBeUndefined()
    process.env.SCORECARD_ANALYTICS = '0'
    await recordUsage('github', false, send)
    expect(requests).toHaveLength(10)
  } finally {
    if (previous === undefined) delete process.env.SCORECARD_ANALYTICS
    else process.env.SCORECARD_ANALYTICS = previous
  }
})
