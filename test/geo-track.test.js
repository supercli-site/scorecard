// geo-track 契约测试 —— 全部离线：用假适配器代替 magpie，不发网络请求。
//
// 锁住的是 2026-11 实测踩过的几类错：
//   ① 冻结后改查询还能继续采集 —— 前后不是同一组问题，比较就是假的
//   ② 窗口外跑出「正式复测」—— 时间点不受控，复测失去意义
//   ③ 覆盖已有快照 / 改了证据还能比较
//   ④ 采集失败被当成零命中
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initTrack, loadTrack, capture, captureGate, listSnapshots, importDerived, readSnapshot,
  summarize, compare, reportMarkdown, classifyUrl, extractUrls, trackDir, CAVEAT,
} from '../server/geo-track.js'

const TRACK = {
  id: 'demo',
  name: 'Demo',
  window: { start: '2026-11-15', end: '2026-11-22', timezone: 'Asia/Taipei' },
  entries: [{ id: 'A', name: 'Alpha', sources: [{ prefix: 'alpha.example.com', kind: 'owned_site' }, { prefix: 'github.com/me/alpha', kind: 'owned_repository' }] }],
  queries: [
    { id: 'A-B1', entry: 'A', kind: 'brand', query: 'alpha plugin' },
    { id: 'A-Q1', entry: 'A', kind: 'category', query: 'best plugin for x' },
  ],
}

const env = () => ({ SCORECARD_GEO_DIR: mkdtempSync(join(tmpdir(), 'geo-track-')) })
const reply = (text) => ({ raw: Buffer.from(JSON.stringify({ content: [{ type: 'text', text }] })), exitCode: 0, timedOut: false })
const adapter = (answers) => ({ tool: 'fake', async search(q) { return answers[q] ?? reply('nothing here') } })
const IN_WINDOW = new Date('2026-11-16T04:00:00Z')

test('冻结后改查询，采集直接拒绝', async () => {
  const e = env()
  initTrack(TRACK, e)
  const file = join(trackDir('demo', e), 'track.json')
  const t = JSON.parse(readFileSync(file, 'utf8'))
  t.queries[0].query = 'alpha plugin changed'
  writeFileSync(file, JSON.stringify(t))
  await expect(capture('demo', { kind: 'preview', adapter: adapter({}), env: e })).rejects.toThrow(/冻结/)
})

test('同一 id 不能 init 两次', () => {
  const e = env()
  initTrack(TRACK, e)
  expect(() => initTrack(TRACK, e)).toThrow(/已存在/)
})

test('正式复测只在窗口内允许，且必须先有基线', () => {
  const t = { ...TRACK, frozen: loadTrackFrozen() }
  expect(() => captureGate(t, 'retest', { now: IN_WINDOW, snapshots: [] })).toThrow(/基线/)
  const base = [{ kind: 'baseline' }]
  expect(() => captureGate(t, 'retest', { now: new Date('2026-11-10T04:00:00Z'), snapshots: base })).toThrow(/窗口外/)
  expect(() => captureGate(t, 'retest', { now: IN_WINDOW, snapshots: base })).not.toThrow()
  // 时区边界：UTC 11-14 17:00 已是台北 11-15 01:00
  expect(() => captureGate(t, 'retest', { now: new Date('2026-11-14T17:00:00Z'), snapshots: base })).not.toThrow()
  expect(() => captureGate(t, 'baseline', { now: IN_WINDOW, snapshots: base })).toThrow(/已有基线/)
})

function loadTrackFrozen() {
  const e = env()
  return initTrack(TRACK, e).frozen
}

test('采集写出原始响应与完整性清单；失败查询不算零命中', async () => {
  const e = env()
  initTrack(TRACK, e)
  const a = adapter({
    'alpha plugin': reply('see https://alpha.example.com/docs and https://other.site/x.'),
    'best plugin for x': { raw: Buffer.alloc(0), exitCode: null, timedOut: true },
  })
  const r = await capture('demo', { kind: 'baseline', adapter: a, env: e, now: new Date('2026-11-08T04:00:00Z') })
  expect(r.summary.failedQueryIds).toEqual(['A-Q1'])
  const track = loadTrack('demo', e)
  const [snap] = listSnapshots('demo', e)
  const rows = readSnapshot(track, snap)
  expect(rows['A-B1'].hit).toBe(true)
  expect(rows['A-B1'].urls).toContain('https://alpha.example.com/docs')
  expect(rows['A-Q1'].hit).toBe(null)
  const [s] = summarize(track, rows)
  expect(s.brand).toEqual({ hits: 1, misses: 0, unavailable: 0, total: 1 })
  expect(s.category).toEqual({ hits: 0, misses: 0, unavailable: 1, total: 1 })
})

test('证据被改动后不能比较', async () => {
  const e = env()
  initTrack(TRACK, e)
  await capture('demo', { kind: 'preview', adapter: adapter({}), env: e })
  const [snap] = listSnapshots('demo', e)
  writeFileSync(join(snap.dir, 'raw', 'A-B1.json'), JSON.stringify({ content: [{ type: 'text', text: 'https://alpha.example.com' }] }))
  expect(() => readSnapshot(loadTrack('demo', e), snap)).toThrow(/完整性/)
})

test('派生基线沿用当时归类，与新快照做有限比较；报告带口径声明', async () => {
  const e = env()
  initTrack(TRACK, e)
  importDerived('demo', { env: e, now: new Date('2026-11-08T00:00:00Z'), sources: [
    { queryId: 'A-B1', url: 'https://github.com/me/alpha', kind: 'owned_repository' },
    { queryId: 'A-Q1', url: 'https://other.site/y', kind: 'unclassified' },
  ] })
  await capture('demo', { kind: 'preview', env: e, now: new Date('2026-11-10T00:00:00Z'), adapter: adapter({ 'best plugin for x': reply('try https://alpha.example.com') }) })
  const track = loadTrack('demo', e)
  const [before, after] = listSnapshots('demo', e)
  expect(before.kind).toBe('derived-recovered')
  const b = readSnapshot(track, before), a = readSnapshot(track, after)
  const diff = compare(track, b, a)
  expect(diff.find((d) => d.id === 'A-B1').change).toBe('now-miss')
  expect(diff.find((d) => d.id === 'A-Q1').change).toBe('now-hit')
  const md = reportMarkdown(track, { before, after, diff, beforeSummary: summarize(track, b), afterSummary: summarize(track, a) })
  expect(md).toContain(CAVEAT)
  expect(md).toContain('原始响应缺失')
  expect(md).toContain('不是正式复测')
})

test('来源归类：host + 路径前缀，不做模糊匹配', () => {
  const s = TRACK.entries[0].sources
  expect(classifyUrl('https://www.alpha.example.com/x', s)).toBe('owned_site')
  expect(classifyUrl('https://github.com/me/alpha/issues', s)).toBe('owned_repository')
  expect(classifyUrl('https://github.com/me/alphabet', s)).toBe('unclassified')
  expect(classifyUrl('https://evil-alpha.example.com', s)).toBe('unclassified')
  expect(extractUrls(['a https://x.io/p). b https://x.io/p'])).toEqual(['https://x.io/p'])
})
