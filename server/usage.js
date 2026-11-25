import { randomUUID } from 'node:crypto'

const ENGINES = new Set(['github', 'npm', 'page', 'profile', 'geo'])

// Explicit production opt-in keeps local audits and test fixtures out of public totals.
export async function recordUsage(engine, cached, fetcher = fetch) {
  if (process.env.SCORECARD_ANALYTICS !== '1' || !ENGINES.has(engine) || typeof cached !== 'boolean') return
  try {
    const response = await fetcher('https://api.webkubor.online/v1/analytics/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'scorecard', event_id: randomUUID(),
        event: cached ? 'report.cached' : 'audit.succeeded', properties: { engine },
      }),
      signal: AbortSignal.timeout(1500),
    })
    await response.body?.cancel()
  } catch {
    // Usage delivery is best effort; a failed counter must never fail an audit.
  }
}
