// geo-dashboard 契约测试 —— 全部离线：临时数据目录 + 假检索适配器。
//
// 锁住看板的几条保护数据边界：
//   ① 只绑回环地址；Host 头不是回环一律拒绝（DNS rebinding）
//   ② 只读：看板渲染前后数据目录逐字节不变
//   ③ 原始响应、未归类第三方 URL、本机绝对路径不进页面
//   ④ 不可用不算未中；preview 不冒充正式复测；完整性失败的快照不参与统计
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initTrack, capture, importDerived, listSnapshots, trackDir } from '../server/geo-track.js'
import {
  handle, buildTrackModel, buildIndexModel, renderTrack, isLoopbackHost, isLoopbackHostHeader,
  startDashboardServer, CSP, webmasterLinks,
} from '../server/geo-dashboard.js'

const TRACK = {
  id: 'demo',
  name: 'Demo <script>',
  window: { start: '2026-11-15', end: '2026-11-22', timezone: 'Asia/Taipei' },
  entries: [{ id: 'A', name: 'Alpha', sources: [{ prefix: 'alpha.example.com', kind: 'owned_site' }] }],
  queries: [
    { id: 'A-B1', entry: 'A', kind: 'brand', query: 'alpha plugin' },
    { id: 'A-Q1', entry: 'A', kind: 'category', query: 'best plugin for x' },
  ],
  remediation: [{ date: '2026-11-09', entry: 'A', what: '补安装指南 https://alpha.example.com/install. <img src=x>' }],
}

const env = () => ({ SCORECARD_GEO_DIR: mkdtempSync(join(tmpdir(), 'geo-dash-')) })
const reply = (text) => ({ raw: Buffer.from(JSON.stringify({ content: [{ type: 'text', text }] })), exitCode: 0, timedOut: false })
const adapter = (answers) => ({ tool: 'fake', async search(q) { return answers[q] ?? reply('nothing here') } })
const LOCAL = '127.0.0.1:54447'

async function seeded() {
  const e = env()
  initTrack(TRACK, e)
  await capture('demo', {
    kind: 'baseline', env: e, now: new Date('2026-11-08T04:00:00Z'),
    adapter: adapter({
      'alpha plugin': reply('see https://alpha.example.com/docs and https://secret-third-party.example/leak?token=abc'),
      'best plugin for x': { raw: Buffer.alloc(0), exitCode: null, timedOut: true },
    }),
  })
  return e
}

function snapshotTree(root) {
  const out = {}
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else out[p] = readFileSync(p, 'utf8')
    }
  }
  walk(root)
  return out
}

test('只认回环：host 与 Host 头都要是 127.0.0.1 / ::1 / localhost', async () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '127.0.0.2']) expect(isLoopbackHost(h)).toBe(true)
  for (const h of ['0.0.0.0', '192.168.1.10', 'example.com', '', '::']) expect(isLoopbackHost(h)).toBe(false)
  expect(isLoopbackHostHeader('[::1]:54447')).toBe(true)
  expect(isLoopbackHostHeader('evil.example:54447')).toBe(false)
  await expect(startDashboardServer({ host: '0.0.0.0', port: 0 })).rejects.toThrow(/拒绝绑定/)
  const e = await seeded()
  expect(handle({ method: 'GET', url: '/', host: 'attacker.example' }, { env: e }).status).toBe(421)
  expect(handle({ method: 'POST', url: '/', host: LOCAL }, { env: e }).status).toBe(405)
})

test('只读：渲染所有页面后数据目录逐字节不变', async () => {
  const e = await seeded()
  const before = snapshotTree(e.SCORECARD_GEO_DIR)
  expect(handle({ method: 'GET', url: '/', host: LOCAL }, { env: e }).status).toBe(200)
  expect(handle({ method: 'GET', url: '/t/demo', host: LOCAL }, { env: e }).status).toBe(200)
  const [snap] = listSnapshots('demo', e)
  expect(handle({ method: 'GET', url: `/t/demo?snapshot=${encodeURIComponent(snap.name)}`, host: LOCAL }, { env: e }).status).toBe(200)
  expect(snapshotTree(e.SCORECARD_GEO_DIR)).toEqual(before)
})

test('页面不带原始响应、第三方地址、本机路径，且对数据做转义', async () => {
  const e = await seeded()
  const html = handle({ method: 'GET', url: '/t/demo', host: LOCAL }, { env: e }).body
  expect(html).toContain('https://alpha.example.com/docs')
  expect(html).not.toContain('secret-third-party')
  expect(html).not.toContain('token=abc')
  expect(html).not.toContain(e.SCORECARD_GEO_DIR)
  expect(html).not.toContain('<script')
  expect(html).not.toContain('<img src=x>')
  expect(html).toContain('Demo &lt;script&gt;')
  expect(html).toContain('另有 1 条第三方来源（不展示地址）')
  // 整改里的裸链接：句末句号不进链接
  expect(html).toContain('href="https://alpha.example.com/install"')
  expect(CSP).toContain("script-src 'none'")
})

test('不可用单列、不算未中；preview 对照会被标明不是正式复测', async () => {
  const e = await seeded()
  await capture('demo', { kind: 'preview', env: e, now: new Date('2026-11-10T04:00:00Z'), adapter: adapter({ 'best plugin for x': reply('try https://alpha.example.com') }) })
  const m = buildTrackModel('demo', { env: e, now: new Date('2026-11-10T04:00:00Z') })
  const a = m.entries[0]
  expect(a.baseline.category).toEqual({ hits: 0, misses: 0, unavailable: 1, total: 1 })
  expect(m.comparison.available).toBe(true)
  expect(m.comparison.counts.unavailable).toBe(1) // 基线一侧失败 → 不可比较，而不是「变成命中」
  expect(m.comparison.afterKind).toBe('preview')
  expect(m.window.state).toBe('before')
  expect(m.retest.allowed).toBe(false)
  expect(renderTrack(m)).toContain('不是正式复测')
})

test('完整性失败的快照标记为不可用，页面不崩、不参与比较', async () => {
  const e = await seeded()
  await capture('demo', { kind: 'preview', env: e, now: new Date('2026-11-10T04:00:00Z'), adapter: adapter({}) })
  const [, after] = listSnapshots('demo', e)
  writeFileSync(join(after.dir, 'raw', 'A-B1.json'), 'tampered')
  const m = buildTrackModel('demo', { env: e })
  expect(m.snapshots.find((s) => s.name === after.name).readable).toBe(false)
  expect(m.comparison.available).toBe(false)
  const res = handle({ method: 'GET', url: '/t/demo', host: LOCAL }, { env: e })
  expect(res.status).toBe(200)
  expect(res.body).toContain('完整性校验失败')
})

test('派生恢复基线标明原始响应缺失；未知 track / 快照返回 404', async () => {
  const e = env()
  initTrack(TRACK, e)
  importDerived('demo', { env: e, sources: [{ queryId: 'A-B1', url: 'https://alpha.example.com/x', kind: 'owned_site' }] })
  const html = handle({ method: 'GET', url: '/t/demo', host: LOCAL }, { env: e }).body
  expect(html).toContain('原始响应缺失')
  expect(handle({ method: 'GET', url: '/t/nope', host: LOCAL }, { env: e }).status).toBe(404)
  expect(handle({ method: 'GET', url: '/t/demo?snapshot=x', host: LOCAL }, { env: e }).status).toBe(404)
  expect(handle({ method: 'GET', url: '/t/../../etc', host: LOCAL }, { env: e }).status).toBe(404)
})

test('站长工具入口：项目级链接优先，缺哪家补通用入口；危险链接丢弃，不声称已验证', () => {
  expect(webmasterLinks({}).map((w) => [w.provider, w.configured])).toEqual([['Google Search Console', false], ['Bing Webmaster Tools', false]])
  const e = env()
  initTrack({ ...TRACK, webmasterTools: [
    { name: 'GSC · <b>alpha</b>', url: 'https://search.google.com/search-console?resource_id=sc-domain%3Aalpha.example.com', note: '需登录' },
    { name: 'evil', url: 'javascript:alert(1)' },
  ] }, e)
  const m = buildTrackModel('demo', { env: e })
  expect(m.webmaster.map((w) => [w.provider, w.configured])).toEqual([['Google Search Console', true], ['Bing Webmaster Tools', false]])
  const html = renderTrack(m)
  expect(html).toContain('href="https://search.google.com/search-console?resource_id=sc-domain%3Aalpha.example.com"')
  expect(html).toContain('GSC · &lt;b&gt;alpha&lt;/b&gt;')
  expect(html).toContain('href="https://www.bing.com/webmasters"')
  expect(html).not.toContain('javascript:')
  expect(html).toContain('不能证明拥有权限，也不能证明已收录')
  expect(html).not.toMatch(/已验证|已收录[^；]/)
})

test('窄屏不横向溢出：表格单元格允许长链接 / code 在任意位置换行', async () => {
  // 2026-11-10 实测 390px：查询明细里的长 URL 把 table 撑到 522px，document 横向溢出。
  // 离线测试不起浏览器，锁住修复所依赖的那条样式；真实测量见 PR 记录。
  const e = await seeded()
  const html = handle({ method: 'GET', url: '/t/demo', host: LOCAL }, { env: e }).body
  const rule = html.match(/th,td\{[^}]*\}/)?.[0] || ''
  expect(rule).toContain('overflow-wrap:anywhere')
})

test('track 顶层 notes 作为「非实时」历史备注展示并转义；没有 notes 不出该区块', () => {
  const e = env()
  initTrack({ ...TRACK, notes: ['2026-11-09 GSC 观察：请求是否受理未知 <b>x</b>', 42] }, e)
  const html = renderTrack(buildTrackModel('demo', { env: e }))
  expect(html).toContain('历史备注 <span class="tag">非实时</span>')
  expect(html).toContain('请求是否受理未知 &lt;b&gt;x&lt;/b&gt;')
  const e2 = env()
  initTrack(TRACK, e2)
  expect(renderTrack(buildTrackModel('demo', { env: e2 }))).not.toContain('历史备注')
})

test('归类规则变更：汇总单列「规则变更，不可比较」，每条查询恰好计入一个桶，不会呈现全零', async () => {
  // 回归：#28 给 compare 加了 rules-changed，看板汇总曾没计入，页面显示全是 0，像「没有变化」。
  const e = env()
  initTrack(TRACK, e)
  const a = adapter({ 'alpha plugin': reply('only https://other.site/x'), 'best plugin for x': reply('see https://other.site/y') })
  await capture('demo', { kind: 'baseline', env: e, now: new Date('2026-11-08T04:00:00Z'), adapter: a })
  // 采集后改 sources（不影响冻结哈希）—— 下一次采集冻结的是另一套规则
  const file = join(trackDir('demo', e), 'track.json')
  const t = JSON.parse(readFileSync(file, 'utf8'))
  t.entries[0].sources.push({ prefix: 'other.site', kind: 'owned_site' })
  writeFileSync(file, JSON.stringify(t, null, 2))
  await capture('demo', { kind: 'preview', env: e, now: new Date('2026-11-09T04:00:00Z'), adapter: a })

  const c = buildTrackModel('demo', { env: e, now: new Date('2026-11-09T04:00:00Z') }).comparison
  expect(c.available).toBe(true)
  expect(c.counts.rulesChanged).toBe(2)
  expect(c.rulesChangedIds).toEqual(['A-B1', 'A-Q1'])
  const { nowHit, nowMiss, stillHit, stillMiss, unavailable, rulesChanged, kindChanged, total } = c.counts
  expect(nowHit + nowMiss + stillHit + stillMiss + unavailable + rulesChanged + kindChanged).toBe(total)
  expect(nowHit + nowMiss + stillHit + stillMiss).toBe(0)

  const html = handle({ method: 'GET', url: '/t/demo', host: LOCAL }, { env: e }).body
  expect(html).toContain('规则变更，不可比较')
  expect(html).toContain('上面的 0 不代表「没有变化」')
  expect(html).not.toContain('<span class="ok">未中 → 命中</span>')
})

test('空数据目录：首页给出起步指引', () => {
  const e = env()
  expect(buildIndexModel({ env: e })).toEqual([])
  expect(handle({ method: 'GET', url: '/', host: LOCAL }, { env: e }).body).toContain('还没有 track')
})

test('真实 HTTP：回环服务带安全头', async () => {
  const e = await seeded()
  const server = await startDashboardServer({ port: 0, env: e })
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/t/demo`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe(CSP)
    expect(res.headers.get('cache-control')).toBe('no-store')
  } finally { server.close() }
})
