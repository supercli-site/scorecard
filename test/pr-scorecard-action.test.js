import { test, expect } from 'bun:test'
import { parseEvent, renderSummary, confirmHead, confirmPublic, upsertComment } from '../bin/pr-scorecard.mjs'

const sha = 'a'.repeat(40)
const baseSha = 'c'.repeat(40)
const event = () => ({ repository: { full_name: 'owner/project', private: false }, pull_request: { number: 17, base: { sha: baseSha }, head: { sha, repo: { full_name: 'contributor/project', private: false } } } })

test('accepts a public fork head and rejects private repositories and malformed SHAs', () => {
  expect(parseEvent(event())).toEqual({ base: 'owner/project', source: 'contributor/project', sha, baseSha, number: 17 })
  const privateRepo = event(); privateRepo.repository.private = true
  expect(() => parseEvent(privateRepo)).toThrow('Only public')
  const privateFork = event(); privateFork.pull_request.head.repo.private = true
  expect(() => parseEvent(privateFork)).toThrow('Private')
  const badSha = event(); badSha.pull_request.head.sha = 'main'
  expect(() => parseEvent(badSha)).toThrow('full head SHA')
})

test('report shows immutable head, separates live metadata and never substitutes zero for missing dimensions', () => {
  const summary = renderSummary({ score: 8.2, band: '健康', type: 'cli', ts: '2026-11-08', dims: [{ name: '文档', score: null, gaps: [], manual: ['人工核实'] }] }, parseEvent(event()))
  expect(summary).toContain('8.2 / 10')
  expect(summary).toContain(`contributor/project@${sha}`)
  expect(summary).toContain('base repository at scan time')
  expect(summary).toContain('Unverifiable')
  expect(summary).toContain('人工核实')
  expect(() => renderSummary({ score: null }, parseEvent(event()))).toThrow('did not produce a score')
})

test('rechecks current visibility of both repositories before audit', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => ({ ok: true, json: async () => ({ full_name: url.endsWith('/owner/project') ? 'owner/project' : 'contributor/project', private: !url.endsWith('/owner/project') }) })
  try { await expect(confirmPublic(parseEvent(event()), 'token')).rejects.toThrow('no longer publicly accessible') } finally { globalThis.fetch = original }
})

test('stale head does not publish a report', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ head: { sha: 'b'.repeat(40), repo: { full_name: 'contributor/project' } } }) })
  try { await expect(confirmHead(parseEvent(event()), 'token')).rejects.toThrow('head, base or state changed') } finally { globalThis.fetch = original }
})

test('updates only the bot comment bearing the Scorecard marker', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method || 'GET', body: options.body })
    if (url.includes('/issues/17/comments?')) return { ok: true, json: async () => [
      { id: 1, user: { login: 'attacker' }, body: '<!-- project-scorecard-pr:v1 --> forged' },
      { id: 2, user: { login: 'github-actions[bot]' }, body: '<!-- project-scorecard-pr:v1 --> old' },
    ] }
    if (url.includes('/pulls/17')) return { ok: true, json: async () => ({ state: 'open', head: { sha, repo: { full_name: 'contributor/project' } }, base: { sha: baseSha, repo: { full_name: 'owner/project' } } }) }
    return { ok: true, json: async () => ({ id: 2 }) }
  }
  try {
    await upsertComment(parseEvent(event()), 'token', '<!-- project-scorecard-pr:v1 --> new')
    const write = calls.find((call) => call.method === 'PATCH')
    expect(write.url).toEndWith('/issues/comments/2')
    expect(JSON.parse(write.body).body).toContain('new')
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  } finally { globalThis.fetch = original }
})
