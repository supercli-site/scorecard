// geo-track 契约测试 —— 全部离线：用假适配器代替 magpie，不发网络请求。
//
// 锁住的是 2026-11 实测踩过的几类错：
//   ① 冻结后改查询还能继续采集 —— 前后不是同一组问题，比较就是假的
//   ② 窗口外跑出「正式复测」—— 时间点不受控，复测失去意义
//   ③ 覆盖已有快照 / 改了证据还能比较
//   ④ 采集失败被当成零命中
//   ⑤ 并发数写 0 → 一条查询都没跑，却写出一份「全零命中」的假基线
//   ⑥ 派生基线里没采到的查询被当成零命中 → 不可比数据混进正式复测
//   ⑦ 采集中断留下的残目录被当成基线 → 这个 track 永远做不了正式复测
//   ⑧ 查询 id 能带路径分隔符 → 采集结果写到快照目录外面
//   ⑨ 补充题与固定题共用编号 → 补充采集盖掉固定题的原始响应
//   ⑪ 题型（brand/category）冻结：新 track 拦截改动；旧格式 track 不改哈希、明确标注
//   ⑩ 事后改 sources 倒改历史快照的命中结论 → 新快照冻结归类规则，旧快照明确提示
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initTrack, loadTrack, capture, captureGate, listSnapshots, importDerived, readSnapshot,
  summarize, compare, reportMarkdown, classifyUrl, extractUrls, trackDir, validateTrack,
  normalizeSourceKind, isHitKind, writeManifest, MANIFEST, freezeKinds, CAVEAT,
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

// ---------- ⑤ 并发数必须是正整数 ----------

test('并发数 ≤ 0 直接拒绝，不能写出「全零命中」的假基线', async () => {
  const e = env()
  initTrack(TRACK, e)
  for (const bad of [0, -1, 1.5, NaN]) {
    await expect(capture('demo', { kind: 'baseline', concurrency: bad, env: e, adapter: adapter({}) }))
      .rejects.toThrow(/并发数必须是 ≥ 1 的整数/)
  }
  // 拒绝之后不能留下任何快照，更不能留下「看起来跑完了」的 summary
  expect(listSnapshots('demo', e)).toEqual([])
})

test('并发数为 1 时照常采集，不被误伤', async () => {
  const e = env()
  initTrack(TRACK, e)
  const r = await capture('demo', {
    kind: 'baseline', concurrency: 1, env: e,
    adapter: adapter({ 'alpha plugin': reply('https://alpha.example.com/docs') }),
  })
  expect(r.summary.total).toBe(2)
  expect(r.summary.failedQueryIds).toEqual([])
})

// ---------- ⑥ 派生基线：没采到 ≠ 零命中 ----------

test('派生基线里没有来源记录的查询算「缺失」，不算零命中', async () => {
  const e = env()
  initTrack(TRACK, e)
  // 只给了 A-B1 的来源，A-Q1 一条来源都没有 —— 那是「没采到」，不是「采到了但没命中」
  importDerived('demo', { env: e, now: new Date('2026-11-08T00:00:00Z'), sources: [
    { queryId: 'A-B1', url: 'https://alpha.example.com', kind: 'owned_site' },
  ] })
  const track = loadTrack('demo', e)
  const [snap] = listSnapshots('demo', e)
  const rows = readSnapshot(track, snap)
  expect(rows['A-B1'].hit).toBe(true)
  expect(rows['A-Q1'].status).toBe('missing')
  expect(rows['A-Q1'].hit).toBe(null)
  const [s] = summarize(track, rows)
  expect(s.brand).toEqual({ hits: 1, misses: 0, unavailable: 0, total: 1 })
  expect(s.category).toEqual({ hits: 0, misses: 0, unavailable: 1, total: 1 })
})

test('派生基线用显式覆盖清单区分「确实零来源」和「没采到」', async () => {
  const e = env()
  initTrack(TRACK, e)
  // A-Q1 明确登记为「覆盖到了、结果就是零来源」→ 那才算零命中
  importDerived('demo', {
    env: e, now: new Date('2026-11-08T00:00:00Z'),
    coveredQueryIds: ['A-B1', 'A-Q1'],
    sources: [{ queryId: 'A-B1', url: 'https://alpha.example.com', kind: 'owned_site' }],
  })
  const track = loadTrack('demo', e)
  const [snap] = listSnapshots('demo', e)
  const rows = readSnapshot(track, snap)
  expect(rows['A-Q1'].status).toBe('ok')
  expect(rows['A-Q1'].hit).toBe(false)
  const [s] = summarize(track, rows)
  expect(s.category).toEqual({ hits: 0, misses: 1, unavailable: 0, total: 1 })
})

test('派生来源归类缺失或非法时不算命中，原值留档可查', async () => {
  const e = env()
  initTrack(TRACK, e)
  importDerived('demo', { env: e, now: new Date('2026-11-08T00:00:00Z'), sources: [
    { queryId: 'A-B1', url: 'https://alpha.example.com', kind: 'owned_site' },
    { queryId: 'A-Q1', url: 'https://other.site/y', kind: 'typo_kind' },
  ] })
  const track = loadTrack('demo', e)
  const [snap] = listSnapshots('demo', e)
  const rows = readSnapshot(track, snap)
  expect(rows['A-Q1'].hit).toBe(false)
  expect(rows['A-Q1'].kinds['https://other.site/y']).toBe('unclassified')
  // 原始填写值留在 kindRaw 里，证据不被静默改掉
  const saved = JSON.parse(readFileSync(join(snap.dir, 'derived', 'sources.json'), 'utf8'))
  expect(saved.find((s) => s.queryId === 'A-Q1').kindRaw).toBe('typo_kind')
})

test('归类词表：历史词表全兼容，未知词表不算命中', () => {
  for (const k of ['owned', 'owned_site', 'owned_repository', 'official_gallery', 'verified_third_party_directory',
    'verified_third_party_gallery', 'verified_third_party_package_page', 'verified_third_party_org_mirror']) {
    expect(normalizeSourceKind(k)).toBe(k)
    expect(isHitKind(k)).toBe(true)
  }
  expect(normalizeSourceKind('unclassified')).toBe('unclassified')
  expect(isHitKind('unclassified')).toBe(false)
  expect(isHitKind('unparseable')).toBe(false)
  expect(isHitKind('')).toBe(false)
  expect(isHitKind(undefined)).toBe(false)
  // 词表外的值（如人工填错）不算命中
  expect(normalizeSourceKind('typo_kind')).toBe('unclassified')
  expect(isHitKind('typo_kind')).toBe(false)
  // track.json 里作者自己写的 kind 拼错时，同样不能算命中
  expect(classifyUrl('https://alpha.example.com/x', [{ prefix: 'alpha.example.com', kind: 'owned_sit' }]))
    .toBe('unclassified')
})

// ---------- ⑦ 采集中断的残目录不能算基线 ----------

test('采集中断留下的残快照不算基线，也不挡住重新采集', async () => {
  const e = env()
  initTrack(TRACK, e)
  // 模拟 capture 建了目录、写了 snapshot.json 就被 Ctrl-C 掉
  const debris = join(trackDir('demo', e), 'snapshots', '2026-11-08T04-00-00-000Z-baseline')
  mkdirSync(join(debris, 'raw'), { recursive: true })
  mkdirSync(join(debris, 'metadata'))
  writeFileSync(join(debris, 'snapshot.json'), JSON.stringify({ kind: 'baseline', trackId: 'demo' }))
  expect(listSnapshots('demo', e)).toEqual([])
  // 基线必须还能采
  const r = await capture('demo', { kind: 'baseline', env: e, adapter: adapter({ 'alpha plugin': reply('https://alpha.example.com') }) })
  expect(r.summary.total).toBe(2)
  expect(listSnapshots('demo', e).length).toBe(1)
})

// ---------- ⑧ 查询 id 不能带路径分隔符 ----------

test('查询 id 带路径分隔符直接拒绝，不会写到快照目录外面', () => {
  const evil = {
    ...TRACK,
    queries: [{ id: '../../../../tmp/pwned', entry: 'A', kind: 'brand', query: 'x' }],
  }
  const errors = validateTrack(evil)
  expect(errors.some((e) => /查询 id 非法/.test(e))).toBe(true)
  expect(() => initTrack(evil, env())).toThrow(/查询 id 非法/)
})

test('补充查询的 id 也要合法，且不能与固定题重名', () => {
  const dup = { ...TRACK, supplementary: [{ id: 'A-B1', entry: 'A', query: 'supp' }] }
  expect(validateTrack(dup).some((e) => /重名/.test(e))).toBe(true)
  const traversal = { ...TRACK, supplementary: [{ id: '../evil', entry: 'A', query: 'supp' }] }
  expect(validateTrack(traversal).some((e) => /补充查询.*非法/.test(e))).toBe(true)
  const badEntry = { ...TRACK, supplementary: [{ id: 'A-S1', entry: 'NOPE', query: 'supp' }] }
  expect(validateTrack(badEntry).some((e) => /entry 不存在/.test(e))).toBe(true)
  // 合法补充题不报错
  expect(validateTrack({ ...TRACK, supplementary: [{ id: 'A-S1', entry: 'A', query: 'supp' }] })).toEqual([])
})

test('补充查询与固定题分开落盘，互不覆盖', async () => {
  const e = env()
  const t = { ...TRACK, supplementary: [{ id: 'A-S1', entry: 'A', query: 'supplementary q' }] }
  initTrack(t, e)
  const r = await capture('demo', {
    kind: 'baseline', includeSupplementary: true, env: e,
    adapter: adapter({ 'alpha plugin': reply('https://alpha.example.com/docs') }),
  })
  expect(existsSync(join(r.dir, 'metadata', 'A-B1.json'))).toBe(true)
  expect(existsSync(join(r.dir, 'supplementary', 'metadata', 'A-S1.json'))).toBe(true)
  expect(existsSync(join(r.dir, 'metadata', 'A-S1.json'))).toBe(false)
})

// ---------- 非法时区与窗口格式 ----------

test('时区写错时给中文提示，不抛 RangeError', () => {
  const t = { ...TRACK, window: { start: '2026-11-15', end: '2026-11-22', timezone: 'Not/AZone' }, frozen: loadTrackFrozen() }
  expect(() => captureGate(t, 'retest', { now: IN_WINDOW, snapshots: [{ kind: 'baseline' }] }))
    .toThrow(/不是合法时区/)
})

test('窗口日期格式非法时给中文提示', () => {
  const t = { ...TRACK, window: { start: '2026/11/15', end: '2026-11-22', timezone: 'UTC' }, frozen: loadTrackFrozen() }
  expect(() => captureGate(t, 'retest', { now: IN_WINDOW, snapshots: [{ kind: 'baseline' }] }))
    .toThrow(/YYYY-MM-DD/)
})

// ---------- ⑩ 归类规则冻结 ----------

const addSource = (e, src) => {
  const file = join(trackDir('demo', e), 'track.json')
  const t = JSON.parse(readFileSync(file, 'utf8'))
  t.entries[0].sources.push(src)
  writeFileSync(file, JSON.stringify(t, null, 2))
}

test('事后改 sources 不会倒改已采快照的命中结论', async () => {
  const e = env()
  initTrack(TRACK, e)
  await capture('demo', { kind: 'baseline', env: e, adapter: adapter({ 'alpha plugin': reply('only https://other.site/x') }) })
  const [snap] = listSnapshots('demo', e)
  expect(readSnapshot(loadTrack('demo', e), snap)['A-B1'].hit).toBe(false)
  addSource(e, { prefix: 'other.site', kind: 'owned_site' })
  const row = readSnapshot(loadTrack('demo', e), snap)['A-B1']
  expect(row.hit).toBe(false)
  expect(row.rules).toBe('frozen')
})

test('前后快照归类规则不同 → 标为不可比较，不算进命中变化', async () => {
  const e = env()
  initTrack(TRACK, e)
  const a = adapter({ 'alpha plugin': reply('only https://other.site/x') })
  await capture('demo', { kind: 'baseline', env: e, now: new Date('2026-11-08T04:00:00Z'), adapter: a })
  addSource(e, { prefix: 'other.site', kind: 'owned_site' })
  await capture('demo', { kind: 'preview', env: e, now: new Date('2026-11-09T04:00:00Z'), adapter: a })
  const track = loadTrack('demo', e)
  const [before, after] = listSnapshots('demo', e)
  const b = readSnapshot(track, before), af = readSnapshot(track, after)
  const diff = compare(track, b, af)
  expect(diff.find((d) => d.id === 'A-B1').change).toBe('rules-changed')
  const md = reportMarkdown(track, { before, after, diff, beforeSummary: summarize(track, b), afterSummary: summarize(track, af) })
  expect(md).toContain('归类规则已变')
  expect(md).not.toContain('未中 → 命中')
})

test('旧快照没有规则快照：按当前规则重算，但行上标 legacy、报告明确提示不保证可比', async () => {
  const e = env()
  initTrack(TRACK, e)
  await capture('demo', { kind: 'baseline', env: e, adapter: adapter({ 'alpha plugin': reply('https://alpha.example.com') }) })
  const [snap] = listSnapshots('demo', e)
  // 模拟旧版本采集：snapshot.json 里没有 classification，清单按旧内容重写
  const ctx = JSON.parse(readFileSync(join(snap.dir, 'snapshot.json'), 'utf8'))
  delete ctx.classification
  writeFileSync(join(snap.dir, 'snapshot.json'), JSON.stringify(ctx, null, 2) + '\n')
  rmSync(join(snap.dir, MANIFEST))
  writeManifest(snap.dir)
  const track = loadTrack('demo', e)
  const [legacy] = listSnapshots('demo', e)
  const rows = readSnapshot(track, legacy)
  expect(rows['A-B1'].rules).toBe('legacy')
  expect(rows['A-B1'].hit).toBe(true)
  const diff = compare(track, rows, rows)
  expect(diff.every((d) => d.rulesUnverified)).toBe(true)
  const md = reportMarkdown(track, { before: legacy, after: legacy, diff, beforeSummary: summarize(track, rows), afterSummary: summarize(track, rows) })
  expect(md).toContain('不保证可比')
})

// ---------- 新用户模板 ----------

test('examples 模板能直接 init，且字段与校验规则一致', () => {
  const tpl = JSON.parse(readFileSync(new URL('../examples/geo-track.track.json', import.meta.url), 'utf8'))
  expect(validateTrack(tpl)).toEqual([])
  const stored = initTrack(tpl, env())
  expect(stored.frozen.queriesSha256).toMatch(/^[0-9a-f]{64}$/)
  for (const e of tpl.entries) for (const s of e.sources) expect(normalizeSourceKind(s.kind)).toBe(s.kind)
})

test('CLI import-derived --coverage 显式登记零来源题', async () => {
  const { runGeoTrack } = await import('../bin/geo-track.mjs')
  const e = env()
  const prev = process.env.SCORECARD_GEO_DIR
  process.env.SCORECARD_GEO_DIR = e.SCORECARD_GEO_DIR
  try {
    initTrack(TRACK, e)
    const dir = mkdtempSync(join(tmpdir(), 'geo-cli-'))
    const csv = join(dir, 'sources.csv'), cov = join(dir, 'coverage.txt')
    writeFileSync(csv, 'query_id,url,source_kind\nA-B1,https://alpha.example.com,owned_site\n')
    writeFileSync(cov, '# 当时采到的题\nA-B1\nA-Q1\n')
    const log = console.log; console.log = () => {}
    try { await runGeoTrack(['import-derived', 'demo', csv], { coverage: cov }) } finally { console.log = log }
    const [snap] = listSnapshots('demo', e)
    const rows = readSnapshot(loadTrack('demo', e), snap)
    expect(rows['A-Q1']).toMatchObject({ status: 'ok', hit: false })
  } finally {
    if (prev === undefined) delete process.env.SCORECARD_GEO_DIR; else process.env.SCORECARD_GEO_DIR = prev
  }
})

test('CLI --concurrency 0 直接报错，不被吞成默认值', async () => {
  const { runGeoTrack } = await import('../bin/geo-track.mjs')
  const e = env()
  const prev = process.env.SCORECARD_GEO_DIR
  process.env.SCORECARD_GEO_DIR = e.SCORECARD_GEO_DIR
  try {
    initTrack(TRACK, e)
    for (const bad of ['0', '-1', 'abc']) {
      await expect(runGeoTrack(['capture', 'demo'], { kind: 'preview', concurrency: bad })).rejects.toThrow(/--concurrency/)
    }
    expect(listSnapshots('demo', e)).toEqual([])
  } finally {
    if (prev === undefined) delete process.env.SCORECARD_GEO_DIR; else process.env.SCORECARD_GEO_DIR = prev
  }
})

// ---------- 补充题重复 id、真实日期 ----------

test('两个补充题同 id 直接拒绝', () => {
  const t = { ...TRACK, supplementary: [{ id: 'A-S1', entry: 'A', query: 'x' }, { id: 'A-S1', entry: 'A', query: 'y' }] }
  expect(validateTrack(t).some((e) => /补充查询 id 重复/.test(e))).toBe(true)
})

test('窗口日期必须是真实日历日期', () => {
  expect(validateTrack({ ...TRACK, window: { start: '2026-02-31', end: '2026-03-05' } }).some((e) => /真实日期/.test(e))).toBe(true)
  expect(validateTrack({ ...TRACK, window: { start: '2028-02-29', end: '2028-03-05' } })).toEqual([])
  const t = { ...TRACK, window: { start: '2026-11-15', end: '2026-11-31', timezone: 'UTC' }, frozen: loadTrackFrozen() }
  expect(() => captureGate(t, 'retest', { now: IN_WINDOW, snapshots: [{ kind: 'baseline' }] })).toThrow(/真实日期/)
})

// ---------- ⑪ 题型冻结 ----------

const setKind = (e, qid, kind, dropKindsHash = false) => {
  const file = join(trackDir('demo', e), 'track.json')
  const t = JSON.parse(readFileSync(file, 'utf8'))
  t.queries.find((q) => q.id === qid).kind = kind
  if (dropKindsHash) delete t.frozen.kindsSha256
  writeFileSync(file, JSON.stringify(t, null, 2))
}

test('新 track 冻结题型：改 brand/category 后拒绝采集；queriesSha256 保持旧算法', async () => {
  const e = env()
  const stored = initTrack(TRACK, e)
  expect(stored.frozen.kindsSha256).toMatch(/^[0-9a-f]{64}$/)
  setKind(e, 'A-B1', 'category')
  await expect(capture('demo', { kind: 'baseline', env: e, adapter: adapter({}) })).rejects.toThrow(/题型/)
})

test('旧格式 track（无 kindsSha256）照常可用，不被改写；题型改动后快照单列不可比较，报告标注旧格式', async () => {
  const e = env()
  initTrack(TRACK, e)
  // 模拟旧版本 init：去掉 kindsSha256
  setKind(e, 'A-B1', 'brand', true)
  const before = readFileSync(join(trackDir('demo', e), 'track.json'), 'utf8')
  await capture('demo', { kind: 'baseline', env: e, adapter: adapter({ 'alpha plugin': reply('https://alpha.example.com') }) })
  expect(readFileSync(join(trackDir('demo', e), 'track.json'), 'utf8')).toBe(before)
  setKind(e, 'A-B1', 'category')
  const track = loadTrack('demo', e)
  const [snap] = listSnapshots('demo', e)
  const rows = readSnapshot(track, snap)
  expect(rows['A-B1']).toMatchObject({ status: 'kind-changed', hit: null })
  const diff = compare(track, rows, rows)
  const md = reportMarkdown(track, { before: snap, after: snap, diff, beforeSummary: summarize(track, rows), afterSummary: summarize(track, rows) })
  expect(md).toContain('旧格式冻结')
  expect(md).toContain('题型已变')
})

// ---------- freeze-kinds 迁移 ----------

const snapshotHashes = (e) => listSnapshots('demo', e).map((s) => readdirSyncDeep(s.dir))
import { readdirSync as _rd, statSync as _st } from 'node:fs'
import { createHash as _ch } from 'node:crypto'
function readdirSyncDeep(dir) {
  const out = {}
  for (const n of _rd(dir)) { const p = join(dir, n); if (_st(p).isDirectory()) Object.assign(out, Object.fromEntries(Object.entries(readdirSyncDeep(p)).map(([k, v]) => [`${n}/${k}`, v]))); else out[n] = _ch('sha256').update(readFileSync(p)).digest('hex') }
  return out
}

test('freeze-kinds：只对旧格式生效，记录迁移时间，不改快照，重复执行拒绝', async () => {
  const e = env()
  initTrack(TRACK, e)
  setKind(e, 'A-B1', 'brand', true) // 模拟旧格式
  await capture('demo', { kind: 'baseline', env: e, adapter: adapter({ 'alpha plugin': reply('https://alpha.example.com') }) })
  const before = snapshotHashes(e)
  const r = freezeKinds('demo', { env: e, now: new Date('2026-11-10T09:00:00Z') })
  expect(r.kindsFrozenAt).toBe('2026-11-10T09:00:00.000Z')
  const t = loadTrack('demo', e)
  expect(t.frozen.kindsFrozenBy).toBe('migration')
  expect(t.frozen.queriesSha256).toBe(loadTrackFrozen().queriesSha256) // 原哈希不变
  expect(snapshotHashes(e)).toEqual(before) // 快照一个字节不变
  expect(() => freezeKinds('demo', { env: e })).toThrow(/不能重复执行/)
  // 迁移后改题型 → 拒绝采集
  setKind(e, 'A-B1', 'category')
  await expect(capture('demo', { kind: 'preview', env: e, adapter: adapter({}) })).rejects.toThrow(/题型/)
  setKind(e, 'A-B1', 'brand')
  const [snap] = listSnapshots('demo', e)
  const track = loadTrack('demo', e)
  const rows = readSnapshot(track, snap)
  const md = reportMarkdown(track, { before: snap, diff: compare(track, rows, rows), beforeSummary: summarize(track, rows) })
  expect(md).toContain('不能证明')
  expect(md).not.toContain('旧格式冻结（哈希不含题型')
})

test('freeze-kinds：新格式 track 拒绝；查询已被改动时拒绝', () => {
  const e = env()
  initTrack(TRACK, e)
  expect(() => freezeKinds('demo', { env: e })).toThrow(/已冻结/)
  const e2 = env()
  initTrack(TRACK, e2)
  const file = join(trackDir('demo', e2), 'track.json')
  const t = JSON.parse(readFileSync(file, 'utf8'))
  delete t.frozen.kindsSha256
  t.queries[0].query = 'changed'
  writeFileSync(file, JSON.stringify(t))
  expect(() => freezeKinds('demo', { env: e2 })).toThrow(/哈希不一致/)
})

// ---------- 真实 track 在用的归类值不能回归 ----------

test('真实 track（dsh-four-entries）在用的 9 种 kind 全部在词表内，且自有来源照常命中', () => {
  const real = ['owned_site', 'owned_site_old_domain', 'owned_repository', 'owned_package_page',
    'official_gallery', 'verified_third_party_directory', 'verified_third_party_gallery',
    'verified_third_party_org_mirror', 'verified_third_party_package_page']
  for (const k of real) {
    expect(normalizeSourceKind(k)).toBe(k)
    expect(isHitKind(k)).toBe(true)
  }
  const sources = [
    { prefix: 'www.npmjs.com/package/dsh-bloom-theme', kind: 'owned_package_page' },
    { prefix: 'scorecard.webkubor.online', kind: 'owned_site_old_domain' },
  ]
  expect(classifyUrl('https://www.npmjs.com/package/dsh-bloom-theme', sources)).toBe('owned_package_page')
  expect(classifyUrl('https://scorecard.webkubor.online/report', sources)).toBe('owned_site_old_domain')
})
