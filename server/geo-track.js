// GEO 检索基线追踪（geo-track）—— 本地自托管模式。
//
// 与 audit-geo.js 的分工：
//   audit-geo.js  = 问 LLM 品类问题，看答案里有没有提到品牌（答案层）
//   geo-track.js  = 用固定问题调检索工具，看返回的来源里有没有自有页面（来源层）
// 两种口径互不换算，报告里分开写。
//
// 为什么只做本地：采集要调用本机的检索工具（默认 magpie web_search），也会产生
// 第三方页面的原始响应。线上实例不采集、不存别人的数据；数据目录默认在
// ~/.scorecard/geo，不在仓库里。
//
// 几条不能放松的纪律（来自 2026-11 四个入口的实测）：
//   1. 查询先冻结再采样。冻结后改一个字，哈希就对不上，采集直接拒绝。
//   2. 正式复测只在项目登记的窗口内允许；窗口外只能跑 preview，并且永久标成 preview。
//   3. 快照目录只新建、不覆盖；采完写 sha256 清单，比较前先校验。
//   4. 采集失败的查询不是「零命中」，比较时单独列出。
//   5. 检索工具返回的可能是模型组织的摘要。URL 出现只证明本次响应含该字符串，
//      不证明搜索排名、收录、安装或因果。

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const MANIFEST = 'integrity-manifest.json'
export const CAVEAT = '检索工具的响应可能是模型组织的摘要；URL 出现只证明本次响应含该链接，不代表搜索排名、收录、安装或因果。少量样本不构成统计显著。'
const URL_RE = /https?:\/\/[^\s<>"'`）】]+/gi
const QUERY_KINDS = new Set(['brand', 'category'])
const SNAPSHOT_KINDS = new Set(['baseline', 'retest', 'preview', 'derived-recovered'])

export function dataDir(env = process.env) {
  return resolve(env.SCORECARD_GEO_DIR || join(homedir(), '.scorecard', 'geo'))
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 冻结范围只含会影响采集结果的字段：查询 id、文本、所属入口。备注改了不影响。 */
export function queriesDigest(queries) {
  const canonical = queries.map((q) => ({ id: q.id, entry: q.entry, query: q.query }))
  return sha256(Buffer.from(JSON.stringify(canonical)))
}

export function validateTrack(track) {
  const errors = []
  if (!track || typeof track !== 'object') return ['track 必须是对象']
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(track.id || '')) errors.push('id 只能是小写字母、数字和连字符')
  const entries = Array.isArray(track.entries) ? track.entries : []
  if (!entries.length) errors.push('至少要有一个 entries 条目')
  const entryIds = new Set()
  for (const e of entries) {
    if (!e?.id || entryIds.has(e.id)) errors.push(`entries.id 缺失或重复：${e?.id}`)
    entryIds.add(e?.id)
    if (!Array.isArray(e?.sources)) errors.push(`entries[${e?.id}].sources 必须是数组（可为空）`)
  }
  const queries = Array.isArray(track.queries) ? track.queries : []
  if (!queries.length) errors.push('queries 不能为空')
  const qids = new Set()
  for (const q of queries) {
    if (!q?.id || qids.has(q.id)) errors.push(`查询 id 缺失或重复：${q?.id}`)
    qids.add(q?.id)
    if (!entryIds.has(q?.entry)) errors.push(`查询 ${q?.id} 的 entry 不存在：${q?.entry}`)
    if (!String(q?.query || '').trim()) errors.push(`查询 ${q?.id} 文本为空`)
    if (q?.kind && !QUERY_KINDS.has(q.kind)) errors.push(`查询 ${q?.id} 的 kind 只能是 brand | category`)
  }
  const w = track.window
  if (w && !(/^\d{4}-\d{2}-\d{2}$/.test(w.start || '') && /^\d{4}-\d{2}-\d{2}$/.test(w.end || '') && w.start <= w.end)) {
    errors.push('window 需要 start ≤ end，格式 YYYY-MM-DD')
  }
  return errors
}

export function trackDir(id, env = process.env) {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id || '')) throw new Error(`非法 track id：${id}`)
  return join(dataDir(env), 'tracks', id)
}

export function loadTrack(id, env = process.env) {
  const file = join(trackDir(id, env), 'track.json')
  if (!existsSync(file)) throw new Error(`没有这个 track：${id}（先 scorecard geo-track init）`)
  const track = JSON.parse(readFileSync(file, 'utf8'))
  const errors = validateTrack(track)
  if (errors.length) throw new Error(`track.json 不合法：\n  - ${errors.join('\n  - ')}`)
  return track
}

export function listTracks(env = process.env) {
  const root = join(dataDir(env), 'tracks')
  if (!existsSync(root)) return []
  return readdirSync(root).filter((name) => existsSync(join(root, name, 'track.json'))).sort()
}

/** 新建 track。已存在就拒绝 —— 已冻结的查询不能被一次 init 静默改掉。 */
export function initTrack(track, env = process.env) {
  const errors = validateTrack(track)
  if (errors.length) throw new Error(`track 定义不合法：\n  - ${errors.join('\n  - ')}`)
  const dir = trackDir(track.id, env)
  if (existsSync(join(dir, 'track.json'))) throw new Error(`track 已存在：${track.id}；要改查询请新建另一个 track`)
  mkdirSync(join(dir, 'snapshots'), { recursive: true })
  const stored = {
    ...track,
    frozen: { queriesSha256: queriesDigest(track.queries), frozenAt: new Date().toISOString() },
    remediation: track.remediation || [],
    installEvidence: track.installEvidence || [],
  }
  writeFileSync(join(dir, 'track.json'), JSON.stringify(stored, null, 2) + '\n', { flag: 'wx' })
  return stored
}

function dateIn(timeZone, date = new Date()) {
  // en-CA 输出 YYYY-MM-DD，正好可做字典序比较
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** 判断本次采集允许以哪种 kind 进行；不允许时抛错，错误文案直接给用户看。 */
export function captureGate(track, kind, { now = new Date(), snapshots = [] } = {}) {
  if (!['baseline', 'retest', 'preview'].includes(kind)) throw new Error('采集 kind 只能是 baseline | retest | preview')
  if (queriesDigest(track.queries) !== track.frozen?.queriesSha256) {
    throw new Error('查询与冻结时的哈希不一致：冻结后不能改查询。需要新问题请新建 track，或写进 supplementary')
  }
  if (kind === 'baseline' && snapshots.some((s) => s.kind === 'baseline' || s.kind === 'derived-recovered')) {
    throw new Error('这个 track 已有基线；之后的采集用 retest 或 preview')
  }
  if (kind === 'retest') {
    if (!snapshots.some((s) => s.kind === 'baseline' || s.kind === 'derived-recovered')) throw new Error('还没有基线，不能做复测')
    const w = track.window
    if (!w) throw new Error('track 没有登记复测窗口（window），正式复测无从判断；先跑 preview')
    const tz = w.timezone || 'UTC'
    const today = dateIn(tz, now)
    if (today < w.start || today > w.end) throw new Error(`正式复测只允许 ${w.start}..${w.end}（${tz}），今天是 ${today}；窗口外请用 --preview`)
  }
}

export function listSnapshots(id, env = process.env) {
  const root = join(trackDir(id, env), 'snapshots')
  if (!existsSync(root)) return []
  return readdirSync(root).sort().flatMap((name) => {
    const file = join(root, name, 'snapshot.json')
    if (!existsSync(file)) return []
    try { return [{ name, dir: join(root, name), ...JSON.parse(readFileSync(file, 'utf8')) }] } catch { return [] }
  })
}

// ---------- 完整性清单 ----------

function evidenceFiles(root) {
  const files = ['snapshot.json', 'summary.json']
  for (const folder of ['raw', 'metadata', 'supplementary/raw', 'supplementary/metadata', 'derived']) {
    const dir = join(root, folder)
    if (!existsSync(dir)) continue
    if (lstatSync(dir).isSymbolicLink()) throw new Error(`证据目录不能是软链接：${folder}`)
    for (const name of readdirSync(dir)) {
      const st = lstatSync(join(dir, name))
      if (!st.isFile() || st.isSymbolicLink()) throw new Error(`证据目录里有非常规文件：${folder}/${name}`)
      files.push(`${folder}/${name}`)
    }
  }
  for (const f of files) {
    if (!existsSync(join(root, f))) throw new Error(`缺少证据文件：${f}`)
  }
  return files.sort()
}

export function writeManifest(root) {
  const files = Object.fromEntries(evidenceFiles(root).map((f) => [f, sha256(readFileSync(join(root, f)))]))
  const manifest = {
    algorithm: 'sha256',
    limitations: '只能发现清单生成之后的改动，前提是清单本身被另行妥善保存；它不证明采集来源的真实性。',
    files,
  }
  writeFileSync(join(root, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  return manifest
}

export function verifySnapshot(root) {
  const file = join(root, MANIFEST)
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) throw new Error('缺少完整性清单，快照可能不完整')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  if (manifest?.algorithm !== 'sha256' || typeof manifest.files !== 'object') throw new Error('完整性清单格式不对')
  const actual = Object.fromEntries(evidenceFiles(root).map((f) => [f, sha256(readFileSync(join(root, f)))]))
  const expected = manifest.files
  const missing = Object.keys(expected).filter((k) => !(k in actual))
  const extra = Object.keys(actual).filter((k) => !(k in expected))
  const changed = Object.keys(actual).filter((k) => k in expected && actual[k] !== expected[k])
  if (missing.length || extra.length || changed.length) {
    throw new Error(`完整性校验失败：缺少 ${missing.join(',') || '无'}；多出 ${extra.join(',') || '无'}；改动 ${changed.join(',') || '无'}`)
  }
  return Object.keys(actual).length
}

// ---------- 检索适配器 ----------

/**
 * 默认适配器：本机 magpie 的 web_search。返回原始 stdout（Buffer），不做任何改写 ——
 * 原始响应是唯一可复查的证据，解析交给后面统一的 extractUrls。
 */
export const magpieAdapter = {
  tool: 'magpie tool web_search',
  async search(query, { count = 8, timeoutMs = 90_000 } = {}) {
    return await new Promise((resolvePromise) => {
      const child = spawn('magpie', ['tool', 'web_search', '--query', query, '--count', String(count), '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const out = []
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
      child.stdout.on('data', (d) => out.push(d))
      child.on('error', (error) => { clearTimeout(timer); resolvePromise({ raw: Buffer.concat(out), exitCode: null, timedOut, error: error.code || error.message }) })
      child.on('close', (code) => { clearTimeout(timer); resolvePromise({ raw: Buffer.concat(out), exitCode: code, timedOut }) })
    })
  },
}

/** magpie 的 --json 是 MCP 结果：{ content: [{type:'text', text}], isError }。 */
export function parseResponse(raw) {
  const payload = JSON.parse(raw.toString('utf8'))
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.content)) throw new Error('响应缺少 content 数组')
  if (payload.isError) return { status: 'tool_error', texts: [] }
  const texts = payload.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text)
  if (!texts.some((t) => t.trim())) return { status: 'empty_response', texts }
  return { status: 'ok', texts }
}

export function extractUrls(texts) {
  const seen = new Set()
  for (const t of texts) for (const m of t.match(URL_RE) || []) seen.add(m.replace(/[.,;:!?)\]}>]+$/, ''))
  return [...seen]
}

/** 按 entry 的 sources 前缀归类。匹配 host + 路径前缀，不做模糊匹配。 */
export function classifyUrl(url, sources = []) {
  let u
  try { u = new URL(url) } catch { return 'unparseable' }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const path = u.pathname.replace(/\/+$/, '').toLowerCase()
  for (const s of sources) {
    const [sHost, ...rest] = String(s.prefix || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')
    const sPath = rest.length ? '/' + rest.join('/').replace(/\/+$/, '') : ''
    if (host === sHost && (!sPath || path === sPath || path.startsWith(sPath + '/'))) return s.kind || 'owned'
  }
  return 'unclassified'
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i) }
  })
  await Promise.all(workers)
  return results
}

// ---------- 采集 ----------

export async function capture(id, { kind, adapter = magpieAdapter, count = 8, concurrency = 3, now = new Date(), env = process.env, includeSupplementary = false } = {}) {
  const track = loadTrack(id, env)
  const snapshots = listSnapshots(id, env)
  captureGate(track, kind, { now, snapshots })
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const dest = join(trackDir(id, env), 'snapshots', `${stamp}-${kind}`)
  if (existsSync(dest)) throw new Error(`快照目录已存在，拒绝覆盖：${dest}`)
  mkdirSync(join(dest, 'raw'), { recursive: true })
  mkdirSync(join(dest, 'metadata'))
  const supplement = includeSupplementary ? (track.supplementary || []) : []
  if (supplement.length) mkdirSync(join(dest, 'supplementary', 'raw'), { recursive: true }), mkdirSync(join(dest, 'supplementary', 'metadata'))

  const context = {
    kind,
    trackId: id,
    startedAtUtc: new Date().toISOString(),
    timezone: track.window?.timezone || 'UTC',
    tool: adapter.tool,
    countRequested: count,
    backend: 'unknown',
    queriesSha256: track.frozen.queriesSha256,
    interpretation: CAVEAT,
  }
  writeFileSync(join(dest, 'snapshot.json'), JSON.stringify(context, null, 2) + '\n', { flag: 'wx' })

  const one = async (q, dir, group) => {
    const meta = { id: q.id, entry: q.entry, query: q.query, group, tool: adapter.tool, countRequested: count, startedAtUtc: new Date().toISOString() }
    try {
      const r = await adapter.search(q.query, { count })
      meta.exitCode = r.exitCode
      if (r.raw?.length) writeFileSync(join(dir, 'raw', `${q.id}.json`), r.raw, { flag: 'wx' })
      if (r.timedOut) Object.assign(meta, { status: 'timeout', rawIsPartial: Boolean(r.raw?.length) })
      else if (r.error) Object.assign(meta, { status: 'error', error: String(r.error) })
      else if (r.exitCode) meta.status = 'process_error'
      else meta.status = parseResponse(r.raw).status
    } catch (error) {
      Object.assign(meta, { status: 'error', error: error.name || 'Error' })
    }
    meta.finishedAtUtc = new Date().toISOString()
    writeFileSync(join(dir, 'metadata', `${q.id}.json`), JSON.stringify(meta, null, 2) + '\n', { flag: 'wx' })
    return meta
  }

  const fixed = await mapLimit(track.queries, concurrency, (q) => one(q, dest, 'fixed'))
  const extra = []
  for (const q of supplement) extra.push(await one(q, join(dest, 'supplementary'), 'supplementary-no-baseline'))
  const summary = {
    finishedAtUtc: new Date().toISOString(),
    total: fixed.length,
    failedQueryIds: fixed.filter((m) => m.status !== 'ok').map((m) => m.id),
    supplementaryTotal: extra.length,
    supplementaryFailedQueryIds: extra.filter((m) => m.status !== 'ok').map((m) => m.id),
    note: '失败的查询不是零命中；补充查询没有历史基线。',
  }
  writeFileSync(join(dest, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
  writeManifest(dest)
  return { dir: dest, context, summary }
}

/**
 * 导入一份只剩派生数据的旧基线（例如原始响应已丢失，只剩人工归类的来源表）。
 * kind 固定为 derived-recovered，报告里永远带「原始响应缺失」的说明。
 */
export function importDerived(id, { sources, note = '', now = new Date(), env = process.env }) {
  const track = loadTrack(id, env)
  const snapshots = listSnapshots(id, env)
  if (snapshots.some((s) => s.kind === 'baseline' || s.kind === 'derived-recovered')) throw new Error('这个 track 已有基线')
  const qids = new Set(track.queries.map((q) => q.id))
  for (const s of sources) {
    if (!qids.has(s.queryId)) throw new Error(`派生来源里的查询不在冻结查询中：${s.queryId}`)
    if (!s.url) throw new Error(`派生来源缺 url：${s.queryId}`)
  }
  const dest = join(trackDir(id, env), 'snapshots', `${now.toISOString().replace(/[:.]/g, '-')}-derived-recovered`)
  mkdirSync(join(dest, 'derived'), { recursive: true })
  const context = {
    kind: 'derived-recovered', trackId: id, importedAtUtc: new Date().toISOString(),
    queriesSha256: track.frozen.queriesSha256, rawMissing: true, note,
    interpretation: `${CAVEAT} 该基线原始响应缺失，只能做有限比较。`,
  }
  writeFileSync(join(dest, 'snapshot.json'), JSON.stringify(context, null, 2) + '\n', { flag: 'wx' })
  writeFileSync(join(dest, 'derived', 'sources.json'), JSON.stringify(sources, null, 2) + '\n', { flag: 'wx' })
  writeFileSync(join(dest, 'summary.json'), JSON.stringify({ total: track.queries.length, sourceRows: sources.length }, null, 2) + '\n', { flag: 'wx' })
  writeManifest(dest)
  return { dir: dest, context }
}

// ---------- 读取与比较 ----------

/** 把一份快照读成「每个查询：状态 + URL + 归类」。先校验完整性。 */
export function readSnapshot(track, snap) {
  verifySnapshot(snap.dir)
  if (snap.queriesSha256 !== track.frozen.queriesSha256) throw new Error(`快照 ${snap.name} 与当前冻结查询不匹配`)
  const entryOf = Object.fromEntries(track.entries.map((e) => [e.id, e]))
  const rows = {}
  if (snap.kind === 'derived-recovered') {
    const sources = JSON.parse(readFileSync(join(snap.dir, 'derived', 'sources.json'), 'utf8'))
    for (const q of track.queries) {
      const mine = sources.filter((s) => s.queryId === q.id)
      const urls = [...new Set(mine.map((s) => s.url))]
      // 派生基线沿用当时的人工归类，不用今天的规则重算 —— 否则口径悄悄变了
      const kinds = Object.fromEntries(mine.map((s) => [s.url, s.kind || 'unclassified']))
      rows[q.id] = { status: 'ok', urls, kinds, hit: urls.some((u) => kinds[u] !== 'unclassified') }
    }
    return rows
  }
  for (const q of track.queries) {
    const metaFile = join(snap.dir, 'metadata', `${q.id}.json`)
    if (!existsSync(metaFile)) { rows[q.id] = { status: 'missing', urls: null, kinds: {}, hit: null }; continue }
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
    if (meta.query !== q.query || meta.id !== q.id) { rows[q.id] = { status: 'invalid', urls: null, kinds: {}, hit: null }; continue }
    if (meta.status !== 'ok') { rows[q.id] = { status: meta.status, urls: null, kinds: {}, hit: null }; continue }
    try {
      const parsed = parseResponse(readFileSync(join(snap.dir, 'raw', `${q.id}.json`)))
      const urls = extractUrls(parsed.texts)
      const sources = entryOf[q.entry]?.sources || []
      const kinds = Object.fromEntries(urls.map((u) => [u, classifyUrl(u, sources)]))
      rows[q.id] = { status: parsed.status, urls, kinds, hit: urls.some((u) => !['unclassified', 'unparseable'].includes(kinds[u])) }
    } catch (error) {
      rows[q.id] = { status: 'invalid', urls: null, kinds: {}, hit: null, error: error.name }
    }
  }
  return rows
}

export function summarize(track, rows) {
  return track.entries.map((e) => {
    const qs = track.queries.filter((q) => q.entry === e.id)
    const by = (kind) => qs.filter((q) => (q.kind || 'category') === kind)
    const count = (list) => ({ hits: list.filter((q) => rows[q.id]?.hit === true).length, misses: list.filter((q) => rows[q.id]?.hit === false).length, unavailable: list.filter((q) => rows[q.id]?.hit == null).length, total: list.length })
    return { entry: e.id, name: e.name || e.id, brand: count(by('brand')), category: count(by('category')) }
  })
}

export function compare(track, beforeRows, afterRows) {
  return track.queries.map((q) => {
    const b = beforeRows[q.id], a = afterRows[q.id]
    const comparable = b?.hit != null && a?.hit != null
    let change = 'unavailable'
    if (comparable) change = b.hit === a.hit ? (a.hit ? 'still-hit' : 'still-miss') : (a.hit ? 'now-hit' : 'now-miss')
    const ownedAfter = (a?.urls || []).filter((u) => !['unclassified', 'unparseable'].includes(a.kinds[u]))
    return { id: q.id, entry: q.entry, query: q.query, before: b?.status, after: a?.status, change, ownedAfter }
  })
}

export function reportMarkdown(track, { before, after, diff, beforeSummary, afterSummary }) {
  const lines = [`# GEO 检索基线：${track.name || track.id}`, '', `> ${CAVEAT}`, '']
  if (before?.kind === 'derived-recovered') lines.push('> 基线为派生恢复数据（原始响应缺失），以下只是有限比较。', '')
  if (after?.kind === 'preview') lines.push('> 本次是 **preview**，不是正式复测，不能当作复测结果引用。', '')
  lines.push(`- 基线：${before?.name || '无'}（${before?.kind || '-'}）`)
  if (after) lines.push(`- 对照：${after.name}（${after.kind}）`)
  lines.push('', '| 入口 | 品牌题 命中/未中/不可用 | 品类题 命中/未中/不可用 |' + (after ? ' 对照 品牌题 | 对照 品类题 |' : ''), '|---|---|---|' + (after ? '---|---|' : ''))
  const fmt = (c) => `${c.hits}/${c.misses}/${c.unavailable}（共 ${c.total}）`
  for (const s of beforeSummary) {
    const t = afterSummary?.find((x) => x.entry === s.entry)
    lines.push(`| ${s.name} | ${fmt(s.brand)} | ${fmt(s.category)} |` + (t ? ` ${fmt(t.brand)} | ${fmt(t.category)} |` : ''))
  }
  if (diff) {
    const moved = diff.filter((d) => d.change === 'now-hit' || d.change === 'now-miss')
    const unavailable = diff.filter((d) => d.change === 'unavailable')
    lines.push('', '## 变化的查询', '')
    if (!moved.length) lines.push('无。')
    for (const d of moved) lines.push(`- \`${d.id}\` ${d.change === 'now-hit' ? '未中 → 命中' : '命中 → 未中'}：${d.query}${d.ownedAfter.length ? `（${d.ownedAfter.join('，')}）` : ''}`)
    if (unavailable.length) lines.push('', `## 不可比较（${unavailable.length}）`, '', '采集失败或缺失，不计为零命中：' + unavailable.map((d) => `\`${d.id}\``).join('、'))
  }
  const rem = track.remediation || []
  if (rem.length) {
    lines.push('', '## 已登记的整改', '', '时间早于对照快照的整改只说明「已上线」，不能说明是它造成了变化。', '')
    for (const r of rem) lines.push(`- ${r.date || ''} \`${r.entry || '-'}\` ${r.what}${r.url ? ` — ${r.url}` : ''}${r.state ? `（${r.state}）` : ''}`)
  }
  const ev = track.installEvidence || []
  if (ev.length) {
    lines.push('', '## 安装成功证据', '')
    for (const e of ev) lines.push(`- ${e.date || ''} \`${e.entry || '-'}\` ${e.source === 'volunteer' ? '用户自愿反馈' : '本机隔离测试'}：${e.note || ''}${e.url ? ` — ${e.url}` : ''}`)
  }
  return lines.join('\n') + '\n'
}
