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
// 归类词表。历史派生基线用过这些值，不能因为收紧校验把旧证据判成非法。
// 未列出的值一律当「未归类」，不算命中 —— 缺失或非法不能被当成命中。
const KNOWN_SOURCE_KINDS = new Set([
  'owned', 'owned_site', 'owned_repository', 'owned_package', 'owned_gallery',
  'official_gallery', 'official_site', 'official_repository',
  'verified_third_party_directory', 'verified_third_party_gallery',
  'verified_third_party_package_page', 'verified_third_party_org_mirror',
  'unclassified', 'unparseable',
])
// 归类词表里明确表示「不算命中」的
const NON_HIT_SOURCE_KINDS = new Set(['unclassified', 'unparseable'])

/**
 * 校验一条来源归类（来自 CSV 或 track.json，人工填写，可能拼错）。
 *   缺失 / 空白 / 不在词表内 → 'unclassified'（不算命中）
 *   词表内的值 → 原样保留
 * 之所以要规范化：归类拼错时不能默默变成「命中自有资产」——
 * 那等于把没核实过的来源算进成绩。
 */
export function normalizeSourceKind(kind) {
  const raw = String(kind ?? '').trim()
  if (!raw) return 'unclassified'
  if (KNOWN_SOURCE_KINDS.has(raw)) return raw
  return 'unclassified'
}

/**
 * 这一条来源算不算「命中自有资产」。
 * 空 / unclassified / unparseable / 词表外的值都不算。
 */
export function isHitKind(kind) {
  return !NON_HIT_SOURCE_KINDS.has(normalizeSourceKind(kind))
}

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

/**
 * 题型冻结（v2）：brand / category 决定分组统计，改了题型前后分组就不是同一口径。
 * 为兼容已有 track，不改 queriesDigest（改了旧哈希全部失效）；新 track 另存 kindsSha256。
 * 旧 track 没有 kindsSha256 = 旧格式：题型改动拦不住，报告里明确标注。
 */
function kindsDigest(queries) {
  return sha256(Buffer.from(JSON.stringify(queries.map((q) => ({ id: q.id, kind: q.kind || 'category' })))))
}

function queryKindMap(queries) {
  return Object.fromEntries(queries.map((q) => [q.id, q.kind || 'category']))
}

/** YYYY-MM-DD 且是真实日历日期（2026-02-31 不算）。 */
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

// 查询 id 会直接当文件名用（raw/<id>.json、metadata/<id>.json），
// 所以只允许「字母数字下划线点连字符」——不许出现 / 或 \ 或 ..，
// 否则一个 id 就能把采集结果写到快照目录外面去。
const QUERY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function queryIdError(q) {
  if (!q?.id) return '查询 id 缺失'
  if (!QUERY_ID_RE.test(q.id)) return `查询 id 非法：${q.id}（只能含字母、数字、下划线、点、连字符，不能含路径分隔符）`
  return null
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
    const idErr = queryIdError(q)
    if (idErr) errors.push(idErr)
    if (qids.has(q?.id)) errors.push(`查询 id 缺失或重复：${q?.id}`)
    qids.add(q?.id)
    if (!entryIds.has(q?.entry)) errors.push(`查询 ${q?.id} 的 entry 不存在：${q?.entry}`)
    if (!String(q?.query || '').trim()) errors.push(`查询 ${q?.id} 文本为空`)
    if (q?.kind && !QUERY_KINDS.has(q.kind)) errors.push(`查询 ${q?.id} 的 kind 只能是 brand | category`)
  }
  // 补充查询单独校验：它和固定题是两套东西，编号不能重名（否则补充采集会盖掉
  // 固定题的原始响应），也不能引用不存在的 entry。
  const supplement = Array.isArray(track.supplementary) ? track.supplementary : []
  const sids = new Set()
  for (const q of supplement) {
    const idErr = queryIdError(q)
    if (idErr) errors.push(`补充查询：${idErr}`)
    if (qids.has(q?.id)) errors.push(`补充查询 id 与固定题重名：${q?.id}（补充题用独立编号，如 X-S1）`)
    if (sids.has(q?.id)) errors.push(`补充查询 id 重复：${q?.id}（落盘会撞名）`)
    sids.add(q?.id)
    if (!entryIds.has(q?.entry)) errors.push(`补充查询 ${q?.id} 的 entry 不存在：${q?.entry}`)
    if (!String(q?.query || '').trim()) errors.push(`补充查询 ${q?.id} 文本为空`)
  }
  const w = track.window
  if (w && !(isRealDate(w.start) && isRealDate(w.end) && w.start <= w.end)) {
    errors.push('window 需要 start ≤ end，格式 YYYY-MM-DD，且是真实日期')
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
    frozen: { queriesSha256: queriesDigest(track.queries), kindsSha256: kindsDigest(track.queries), frozenAt: new Date().toISOString() },
    remediation: track.remediation || [],
    installEvidence: track.installEvidence || [],
  }
  writeFileSync(join(dir, 'track.json'), JSON.stringify(stored, null, 2) + '\n', { flag: 'wx' })
  return stored
}

function dateIn(timeZone, date = new Date()) {
  // en-CA 输出 YYYY-MM-DD，正好可做字典序比较
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
  } catch (error) {
    // 时区写错时 Intl 抛 RangeError，会盖掉原本该给用户看的中文提示。
    throw new Error(`window.timezone 不是合法时区：${timeZone}（${error.name}）`)
  }
}

/** 判断本次采集允许以哪种 kind 进行；不允许时抛错，错误文案直接给用户看。 */
export function captureGate(track, kind, { now = new Date(), snapshots = [] } = {}) {
  if (!['baseline', 'retest', 'preview'].includes(kind)) throw new Error('采集 kind 只能是 baseline | retest | preview')
  if (queriesDigest(track.queries) !== track.frozen?.queriesSha256) {
    throw new Error('查询与冻结时的哈希不一致：冻结后不能改查询。需要新问题请新建 track，或写进 supplementary')
  }
  if (track.frozen?.kindsSha256 && kindsDigest(track.queries) !== track.frozen.kindsSha256) {
    throw new Error('题型（brand/category）与冻结时不一致：改题型会改变分组统计。需要请新建 track')
  }
  if (kind === 'baseline' && snapshots.some((s) => s.kind === 'baseline' || s.kind === 'derived-recovered')) {
    throw new Error('这个 track 已有基线；之后的采集用 retest 或 preview')
  }
  if (kind === 'retest') {
    if (!snapshots.some((s) => s.kind === 'baseline' || s.kind === 'derived-recovered')) throw new Error('还没有基线，不能做复测')
    const w = track.window
    if (!w) throw new Error('track 没有登记复测窗口（window），正式复测无从判断；先跑 preview')
    if (!isRealDate(w.start) || !isRealDate(w.end)) {
      throw new Error(`window 的 start / end 需要 YYYY-MM-DD 格式的真实日期，收到：${w.start} / ${w.end}`)
    }
    const tz = w.timezone || 'UTC'
    const today = dateIn(tz, now)
    if (today < w.start || today > w.end) throw new Error(`正式复测只允许 ${w.start}..${w.end}（${tz}），今天是 ${today}；窗口外请用 --preview`)
  }
}

/**
 * 判断一个快照目录是不是「采集被中断留下的残骸」。
 *
 * capture 是先建目录再采集的，中途 Ctrl-C 或进程被杀会留下只有
 * snapshot.json（甚至连 snapshot.json 都没写完）的目录。这种残骸不能算基线 ——
 * 否则一次采到一半的失败会让这个 track 永远做不了正式复测。
 * 完整快照以完整性清单（integrity-manifest.json）为准。
 */
function isIncompleteSnapshot(dir) {
  // 采集是先写 snapshot.json 再写证据、最后才写清单；
  // 没有清单 = 没采完，或者被外部改动过。
  return !existsSync(join(dir, MANIFEST))
}

export function listSnapshots(id, env = process.env) {
  const root = join(trackDir(id, env), 'snapshots')
  if (!existsSync(root)) return []
  return readdirSync(root).sort().flatMap((name) => {
    const dir = join(root, name)
    const file = join(dir, 'snapshot.json')
    if (!existsSync(file)) return []
    // 残缺快照不计入 —— 采集中断的目录不算基线，也不该挡住重采。
    if (isIncompleteSnapshot(dir)) return []
    try { return [{ name, dir, ...JSON.parse(readFileSync(file, 'utf8')) }] } catch { return [] }
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

/**
 * 归类规则快照：采集当下每个 entry 的 sources（前缀 + 归类）。
 * 写进 snapshot.json（受完整性清单保护）。读快照时按这份规则归类，
 * 而不是按今天的 track.json —— 否则事后改 sources 会倒改历史快照的命中结论。
 */
function classificationRules(entries) {
  const sourcesByEntry = Object.fromEntries(entries.map((e) => [e.id, (e.sources || []).map((s) => ({ prefix: String(s.prefix || ''), kind: s.kind ?? null }))]))
  return { sourcesByEntry, sourcesSha256: sha256(Buffer.from(JSON.stringify(sourcesByEntry))) }
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
    if (host === sHost && (!sPath || path === sPath || path.startsWith(sPath + '/'))) {
      // track.json 里作者自己写的归类也要过词表：拼错的 kind 不能算命中
      return normalizeSourceKind(s.kind || 'owned')
    }
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
  // 并发数必须是正整数。0 或负数会让 mapLimit 一个 worker 都不起，
  // 结果是「一条查询都没跑」，但 summary 里 total 和 failedQueryIds 看起来都正常 ——
  // 那就是一份凭空捏造的全零命中基线，比崩掉危险得多。
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`并发数必须是 ≥ 1 的整数，收到：${concurrency}`)
  }
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
    queryKinds: queryKindMap(track.queries),
    classification: classificationRules(track.entries),
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
 * 读派生基线的覆盖清单。
 * 返回 null = 旧版本没有这份清单（只能用「有来源行」兜底推断）。
 */
function readDerivedCoverage(dir) {
  const file = join(dir, 'derived', 'coverage.json')
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return new Set(Array.isArray(data.coveredQueryIds) ? data.coveredQueryIds : [])
  } catch {
    return null
  }
}

/**
 * 导入一份只剩派生数据的旧基线（例如原始响应已丢失，只剩人工归类的来源表）。
 * kind 固定为 derived-recovered，报告里永远带「原始响应缺失」的说明。
 */
export function importDerived(id, { sources, note = '', now = new Date(), env = process.env, coveredQueryIds = null }) {
  const track = loadTrack(id, env)
  const snapshots = listSnapshots(id, env)
  if (snapshots.some((s) => s.kind === 'baseline' || s.kind === 'derived-recovered')) throw new Error('这个 track 已有基线')
  const qids = new Set(track.queries.map((q) => q.id))
  for (const s of sources) {
    if (!qids.has(s.queryId)) throw new Error(`派生来源里的查询不在冻结查询中：${s.queryId}`)
    if (!s.url) throw new Error(`派生来源缺 url：${s.queryId}`)
  }
  // 归类规范化：缺失或不在词表内的值一律当 unclassified（不算命中），
  // 原始值留在 kindRaw 里 —— 原始 CSV 另存一份，人工填错要看得见，不能被静默改掉。
  const normalizedSources = sources.map((s) => ({
    ...s,
    kind: normalizeSourceKind(s.kind),
    ...(String(s.kind ?? '').trim() === normalizeSourceKind(s.kind) ? {} : { kindRaw: String(s.kind ?? '') }),
  }))
  // 覆盖清单：显式登记这次采集覆盖了哪些查询。
  // 不传就按「有来源行即视为覆盖」兜底 —— 那是旧行为，只有真的一题都没漏时才对。
  let covered
  if (coveredQueryIds == null) {
    covered = [...new Set(sources.map((s) => s.queryId))]
  } else {
    covered = [...new Set(coveredQueryIds)]
    for (const qid of covered) if (!qids.has(qid)) throw new Error(`覆盖清单里的查询不在冻结查询中：${qid}`)
  }
  const dest = join(trackDir(id, env), 'snapshots', `${now.toISOString().replace(/[:.]/g, '-')}-derived-recovered`)
  mkdirSync(join(dest, 'derived'), { recursive: true })
  const context = {
    kind: 'derived-recovered', trackId: id, importedAtUtc: new Date().toISOString(),
    queriesSha256: track.frozen.queriesSha256, queryKinds: queryKindMap(track.queries), rawMissing: true, note,
    interpretation: `${CAVEAT} 该基线原始响应缺失，只能做有限比较。`,
  }
  writeFileSync(join(dest, 'snapshot.json'), JSON.stringify(context, null, 2) + '\n', { flag: 'wx' })
  writeFileSync(join(dest, 'derived', 'sources.json'), JSON.stringify(normalizedSources, null, 2) + '\n', { flag: 'wx' })
  writeFileSync(join(dest, 'derived', 'coverage.json'), JSON.stringify({ coveredQueryIds: covered }, null, 2) + '\n', { flag: 'wx' })
  writeFileSync(join(dest, 'summary.json'), JSON.stringify({ total: track.queries.length, sourceRows: sources.length, coveredQueryIds: covered.length }, null, 2) + '\n', { flag: 'wx' })
  writeManifest(dest)
  return { dir: dest, context }
}

// ---------- 读取与比较 ----------

/** 把一份快照读成「每个查询：状态 + URL + 归类」。先校验完整性。 */
export function readSnapshot(track, snap) {
  const rows = readSnapshotRows(track, snap)
  // 快照记下了采集当时的题型：与当前 track 不同 → 这题分组口径已变，不参与统计与比较
  const kinds = snap.queryKinds
  if (kinds) {
    for (const q of track.queries) {
      if (kinds[q.id] && kinds[q.id] !== (q.kind || 'category')) rows[q.id] = { ...rows[q.id], status: 'kind-changed', hit: null }
    }
  }
  return rows
}

function readSnapshotRows(track, snap) {
  verifySnapshot(snap.dir)
  if (snap.queriesSha256 !== track.frozen.queriesSha256) throw new Error(`快照 ${snap.name} 与当前冻结查询不匹配`)
  const entryOf = Object.fromEntries(track.entries.map((e) => [e.id, e]))
  const rows = {}
  if (snap.kind === 'derived-recovered') {
    const sources = JSON.parse(readFileSync(join(snap.dir, 'derived', 'sources.json'), 'utf8'))
    // 显式覆盖证据：导入时登记「这次采集确实覆盖了哪些查询」。
    // 没有覆盖记录的查询 = 这次没采到，不是「采到了但零命中」——
    // 两者混在一起会把不可比数据写成可比数据，直接污染正式复测。
    const coverage = readDerivedCoverage(snap.dir)
    for (const q of track.queries) {
      const mine = sources.filter((s) => s.queryId === q.id)
      // 派生基线沿用当时的人工归类，不用今天的规则重算 —— 否则口径悄悄变了
      const kinds = Object.fromEntries(mine.map((s) => [s.url, normalizeSourceKind(s.kind)]))
      const covered = coverage === null ? mine.length > 0 : coverage.has(q.id)
      if (!covered) { rows[q.id] = { status: 'missing', urls: null, kinds: {}, hit: null, rules: 'derived', rulesSha256: null }; continue }
      const urls = [...new Set(mine.map((s) => s.url))]
      rows[q.id] = { status: 'ok', urls, kinds, hit: urls.some((u) => isHitKind(kinds[u])), rules: 'derived', rulesSha256: null }
    }
    return rows
  }
  // 新快照按采集当下冻结的规则归类；旧快照（无规则快照）只能按当前 track.json 重算，
  // 结论不保证与采集当时一致 —— 行上标 rules: 'legacy'，报告里明确提示，不静默。
  const frozenRules = snap.classification?.sourcesByEntry
  const rules = frozenRules ? 'frozen' : 'legacy'
  const rulesSha256 = frozenRules ? snap.classification.sourcesSha256 : null
  const tag = { rules, rulesSha256 }
  for (const q of track.queries) {
    const metaFile = join(snap.dir, 'metadata', `${q.id}.json`)
    if (!existsSync(metaFile)) { rows[q.id] = { status: 'missing', urls: null, kinds: {}, hit: null, ...tag }; continue }
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
    if (meta.query !== q.query || meta.id !== q.id) { rows[q.id] = { status: 'invalid', urls: null, kinds: {}, hit: null, ...tag }; continue }
    if (meta.status !== 'ok') { rows[q.id] = { status: meta.status, urls: null, kinds: {}, hit: null, ...tag }; continue }
    try {
      const parsed = parseResponse(readFileSync(join(snap.dir, 'raw', `${q.id}.json`)))
      const urls = extractUrls(parsed.texts)
      const sources = frozenRules ? (frozenRules[q.entry] || []) : (entryOf[q.entry]?.sources || [])
      const kinds = Object.fromEntries(urls.map((u) => [u, classifyUrl(u, sources)]))
      rows[q.id] = { status: parsed.status, urls, kinds, hit: urls.some((u) => isHitKind(kinds[u])), ...tag }
    } catch (error) {
      rows[q.id] = { status: 'invalid', urls: null, kinds: {}, hit: null, error: error.name, ...tag }
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
    // 两份快照都冻结了归类规则但规则不同 → 前后不是同一把尺子，不能比
    const rulesChanged = b?.rules === 'frozen' && a?.rules === 'frozen' && b.rulesSha256 !== a.rulesSha256
    // 任一侧是旧快照（没有规则快照）→ 只能按当前规则重算，不保证可比
    const rulesUnverified = b?.rules === 'legacy' || a?.rules === 'legacy'
    let change = 'unavailable'
    if (rulesChanged) change = 'rules-changed'
    else if (comparable) change = b.hit === a.hit ? (a.hit ? 'still-hit' : 'still-miss') : (a.hit ? 'now-hit' : 'now-miss')
    const ownedAfter = (a?.urls || []).filter((u) => isHitKind(a.kinds[u]))
    return { id: q.id, entry: q.entry, query: q.query, before: b?.status, after: a?.status, change, ownedAfter, rulesUnverified }
  })
}

export function reportMarkdown(track, { before, after, diff, beforeSummary, afterSummary }) {
  const lines = [`# GEO 检索基线：${track.name || track.id}`, '', `> ${CAVEAT}`, '']
  if (before?.kind === 'derived-recovered') lines.push('> 基线为派生恢复数据（原始响应缺失），以下只是有限比较。', '')
  if (after?.kind === 'preview') lines.push('> 本次是 **preview**，不是正式复测，不能当作复测结果引用。', '')
  if (!track.frozen?.kindsSha256) {
    lines.push('> ⚠ 该 track 为旧格式冻结（哈希不含题型 brand/category）：改题型不会被拦截。' +
      '快照若记录了采集时题型，与当前不一致的题会单列为不可比较；没有记录的旧快照，品牌/品类分组**不保证**与采集时一致。', '')
  }
  for (const s of [before, after]) {
    if (s && !s.queryKinds) lines.push(`> ⚠ 快照 ${s.name} 未记录采集时题型（旧格式），分组统计按当前 track.json 计算。`, '')
  }
  for (const s of [before, after]) {
    if (s && s.kind !== 'derived-recovered' && !s.classification) {
      lines.push(`> ⚠ 快照 ${s.name} 由旧版本采集，没有冻结归类规则，已按当前 track.json 的 sources 重算；若采集后改过 sources，结论与当时不一致，前后**不保证可比**。`, '')
    }
  }
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
    const isKindChanged = (d) => d.before === 'kind-changed' || d.after === 'kind-changed'
    const kindChanged = diff.filter(isKindChanged)
    const unavailable = diff.filter((d) => d.change === 'unavailable' && !isKindChanged(d))
    lines.push('', '## 变化的查询', '')
    if (!moved.length) lines.push('无。')
    for (const d of moved) lines.push(`- \`${d.id}\` ${d.change === 'now-hit' ? '未中 → 命中' : '命中 → 未中'}：${d.query}${d.ownedAfter.length ? `（${d.ownedAfter.join('，')}）` : ''}`)
    if (unavailable.length) lines.push('', `## 不可比较（${unavailable.length}）`, '', '采集失败或缺失，不计为零命中：' + unavailable.map((d) => `\`${d.id}\``).join('、'))
    if (kindChanged.length) lines.push('', `## 题型已变，不可比较（${kindChanged.length}）`, '', '采集时的 brand/category 与当前 track.json 不同，分组口径不一致：' + kindChanged.map((d) => `\`${d.id}\``).join('、'))
    const rulesChanged = diff.filter((d) => d.change === 'rules-changed')
    if (rulesChanged.length) lines.push('', `## 归类规则已变，不可比较（${rulesChanged.length}）`, '', '两份快照采集时的 sources 不同，命中口径不一致；要比较请新建 track 或用同一套 sources 重采：' + rulesChanged.map((d) => `\`${d.id}\``).join('、'))
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
