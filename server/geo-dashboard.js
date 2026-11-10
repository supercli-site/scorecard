// GEO 本地看板（geo-dashboard）—— 只读消费 geo-track 已落盘的证据。
//
// 与 geo-track.js 的分工：
//   geo-track.js     = 冻结、采集、完整性校验、比较（会写数据）
//   geo-dashboard.js = 把本机已有证据整理成一屏可看的页面（只读，一个字节都不写）
//
// 为什么必须只读：看板一旦能写，就多了一条绕过 captureGate 的旁路，冻结哈希和
// 复测窗口这些纪律就形同虚设。所以这里只 import geo-track.js 的读接口。
//
// 保护数据的边界（全部在本文件收口）：
//   1. 只绑回环地址。非回环 host 直接拒绝启动，不提供任何「开放公网」的开关；
//      还校验请求的 Host 头，挡住 DNS rebinding。
//   2. 原始检索响应永不进页面：看板只给「命中 / 未中 / 不可用」计数，以及命中
//      「已登记来源」的 URL。未归类的第三方 URL 只给数量，不给地址。
//   3. 不暴露本机绝对路径（快照 dir、数据目录里的用户名）。
//   4. 页面零 JavaScript、零外部资源；CSP 只放行内联样式。
//   5. 不挂到 server/index.js —— 那是公网实例，GEO 数据不能出现在那里。

import { createServer } from 'node:http'
import {
  CAVEAT, captureGate, compare, listSnapshots, listTracks, loadTrack,
  queriesDigest, readSnapshot, summarize,
} from './geo-track.js'

export const DEFAULT_PORT = 54447
export const DEFAULT_HOST = '127.0.0.1'

// 与 geo-track.js compare() 同一口径：unclassified / unparseable 不算已登记来源。
// 复制这一行而不改 geo-track.js —— 看板是只读消费者，不碰核心采集逻辑。
const NOT_OWN = new Set(['unclassified', 'unparseable'])
const isOwn = (kind) => !NOT_OWN.has(kind)
const BASELINE_KINDS = new Set(['baseline', 'derived-recovered'])

const KIND_LABEL = {
  owned_site: '自有站点',
  owned_site_old_domain: '自有站点（旧域名）',
  owned_repository: '自有仓库',
  owned_package_page: '自有包页',
  official_gallery: '官方主题库',
  verified_third_party_directory: '已核验目录',
  verified_third_party_gallery: '已核验主题库',
  verified_third_party_org_mirror: '已核验镜像',
  verified_third_party_package_page: '已核验包页',
  owned: '已登记来源',
}
const SNAP_LABEL = {
  baseline: '基线',
  'derived-recovered': '派生恢复基线',
  retest: '正式复测',
  preview: '预览（非正式复测）',
}

// ---------- 判定 ----------

export function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
}

/** Host 头形如 127.0.0.1:54447 / localhost:54447 / [::1]:54447 —— 只认回环。 */
export function isLoopbackHostHeader(value) {
  const v = String(value || '').trim()
  if (!v) return false
  const m = v.match(/^\[([^\]]+)\](?::\d+)?$/) || v.match(/^([^:]+)(?::\d+)?$/)
  return Boolean(m) && isLoopbackHost(m[1])
}

function dateIn(timeZone, date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

export function windowState(track, now = new Date()) {
  const w = track.window
  if (!w) return { state: 'unset', label: '未登记复测窗口' }
  const tz = w.timezone || 'UTC'
  const today = dateIn(tz, now)
  const base = { start: w.start, end: w.end, timezone: tz, today }
  if (today < w.start) return { ...base, state: 'before', label: `未开始：${w.start} 起（${tz}）` }
  if (today > w.end) return { ...base, state: 'closed', label: `已结束：${w.end} 止（${tz}）` }
  return { ...base, state: 'open', label: `进行中：${w.start}..${w.end}（${tz}）` }
}

/** 用 geo-track 自己的 captureGate 判断「现在能不能正式复测」—— 不重写口径。 */
function retestGate(track, snapshots, now) {
  try { captureGate(track, 'retest', { now, snapshots }); return { allowed: true, reason: '可以正式复测' } }
  catch (error) { return { allowed: false, reason: error.message } }
}

// 站长工具入口：用户明确要求能一键直达。项目级链接写在 track.json 顶层
// webmasterTools: [{ name, url, note }]（不影响冻结哈希）；没配哪家就给那家的通用首页。
// 这些只是链接 —— 看板不登录、不调站长工具 API，不能据此声称有权限或已收录。
const WEBMASTER_PROVIDERS = [
  { name: 'Google Search Console', url: 'https://search.google.com/search-console', host: 'search.google.com' },
  { name: 'Bing Webmaster Tools', url: 'https://www.bing.com/webmasters', host: 'www.bing.com', path: '/webmasters' },
]
const providerOf = (href) => {
  const u = new URL(href)
  return WEBMASTER_PROVIDERS.find((p) => u.hostname === p.host && (!p.path || u.pathname.startsWith(p.path))) || null
}

export function webmasterLinks(track) {
  const configured = (Array.isArray(track.webmasterTools) ? track.webmasterTools : []).flatMap((t) => {
    const href = t && typeof t.url === 'string' ? safeHref(t.url) : null
    if (!href) return [] // 非 http(s)（如 javascript:）直接丢弃
    return [{ name: String(t.name || href).slice(0, 120), url: href, note: String(t.note || t.purpose || '').slice(0, 300), provider: providerOf(href)?.name || null, configured: true }]
  })
  const fallbacks = WEBMASTER_PROVIDERS.filter((p) => !configured.some((c) => c.provider === p.name))
    .map((p) => ({ name: p.name, url: p.url, note: '未配置项目级资源，打开的是通用首页', provider: p.name, configured: false }))
  return [...configured, ...fallbacks]
}

function readRows(track, snap) {
  try { return { rows: readSnapshot(track, snap), error: null } }
  catch (error) { return { rows: null, error: error.message } }
}

// ---------- 模型（显式挑字段，不 spread 原始对象） ----------

export function buildIndexModel({ env = process.env, now = new Date() } = {}) {
  return listTracks(env).map((id) => {
    try {
      const track = loadTrack(id, env)
      const snaps = listSnapshots(id, env)
      return {
        id,
        name: track.name || id,
        entries: track.entries.length,
        queries: track.queries.length,
        snapshots: snaps.length,
        hasBaseline: snaps.some((s) => BASELINE_KINDS.has(s.kind)),
        frozenIntact: queriesDigest(track.queries) === track.frozen?.queriesSha256,
        window: windowState(track, now),
        remediation: (track.remediation || []).length,
        installEvidence: (track.installEvidence || []).length,
        error: null,
      }
    } catch (error) {
      return { id, name: id, error: error.message }
    }
  })
}

function snapshotView(snap, read, { baselineName, latestName }) {
  return {
    name: snap.name,
    kind: snap.kind,
    kindLabel: SNAP_LABEL[snap.kind] || snap.kind,
    at: snap.startedAtUtc || snap.importedAtUtc || null,
    tool: snap.tool || null,
    countRequested: snap.countRequested ?? null,
    rawMissing: snap.rawMissing === true,
    note: snap.note || '',
    readable: Boolean(read.rows),
    error: read.error,
    isBaseline: snap.name === baselineName,
    isLatest: snap.name === latestName,
  }
}

function queryView(q, row) {
  const urls = row?.urls || []
  const own = urls.filter((u) => isOwn(row.kinds[u])).map((u) => ({ url: u, kind: row.kinds[u], kindLabel: KIND_LABEL[row.kinds[u]] || row.kinds[u] }))
  return {
    id: q.id,
    entry: q.entry,
    kind: q.kind || 'category',
    query: q.query,
    status: row?.status || 'missing',
    hit: row ? row.hit : null,
    own,
    thirdPartyCount: urls.length - own.length,
  }
}

/**
 * 一个 track 的完整看板模型。focus = 要展开查询明细的快照（默认基线）。
 * 比较只在「基线」与「基线之后最新的一份」之间做，与 geo-track report 同一挑法。
 */
export function buildTrackModel(id, { env = process.env, now = new Date(), focus } = {}) {
  const track = loadTrack(id, env)
  const snaps = listSnapshots(id, env)
  const baseline = snaps.find((s) => BASELINE_KINDS.has(s.kind)) || null
  const later = baseline ? snaps.filter((s) => s.name > baseline.name) : []
  const latest = later.length ? later[later.length - 1] : null
  const reads = Object.fromEntries(snaps.map((s) => [s.name, readRows(track, s)]))

  const focusSnap = (focus && snaps.find((s) => s.name === focus)) || baseline || snaps[snaps.length - 1] || null
  if (focus && (!focusSnap || focusSnap.name !== focus)) throw new Error(`找不到快照：${focus}`)
  const focusRows = focusSnap ? reads[focusSnap.name].rows : null

  const baseRows = baseline ? reads[baseline.name].rows : null
  const lateRows = latest ? reads[latest.name].rows : null
  let comparison = null
  if (baseline && latest) {
    const sameTool = !baseline.tool || !latest.tool || baseline.tool === latest.tool
    if (!baseRows || !lateRows) comparison = { available: false, reason: '有一侧快照读取失败，不能比较' }
    else if (!sameTool) comparison = { available: false, reason: `两份快照的检索工具不同（${baseline.tool} / ${latest.tool}），结果不可直接比较` }
    else {
      const diff = compare(track, baseRows, lateRows)
      const tally = (c) => diff.filter((d) => d.change === c).length
      comparison = {
        available: true,
        before: baseline.name,
        after: latest.name,
        afterKind: latest.kind,
        counts: { nowHit: tally('now-hit'), nowMiss: tally('now-miss'), stillHit: tally('still-hit'), stillMiss: tally('still-miss'), unavailable: tally('unavailable') },
        moved: diff.filter((d) => d.change === 'now-hit' || d.change === 'now-miss').map((d) => ({
          id: d.id, entry: d.entry, query: d.query, change: d.change,
          ownedAfter: d.ownedAfter.map((u) => ({ url: u, kindLabel: KIND_LABEL[lateRows[d.id]?.kinds[u]] || '已登记来源' })),
        })),
      }
    }
  }

  const sumOf = (rows) => (rows ? summarize(track, rows) : null)
  const baseSummary = sumOf(baseRows)
  const lateSummary = sumOf(lateRows)
  const focusSummary = sumOf(focusRows)

  const entries = track.entries.map((e) => ({
    id: e.id,
    name: e.name || e.id,
    sources: (e.sources || []).map((s) => ({ prefix: s.prefix, kind: s.kind || 'owned', kindLabel: KIND_LABEL[s.kind] || s.kind || '已登记来源' })),
    baseline: baseSummary?.find((s) => s.entry === e.id) || null,
    latest: lateSummary?.find((s) => s.entry === e.id) || null,
    focus: focusSummary?.find((s) => s.entry === e.id) || null,
    queries: track.queries.filter((q) => q.entry === e.id).map((q) => queryView(q, focusRows?.[q.id])),
    remediation: (track.remediation || []).filter((r) => r.entry === e.id).length,
  }))

  return {
    generatedAt: now.toISOString(),
    caveat: CAVEAT,
    track: {
      id: track.id,
      name: track.name || track.id,
      queryCount: track.queries.length,
      frozenIntact: queriesDigest(track.queries) === track.frozen?.queriesSha256,
      frozenSha: String(track.frozen?.queriesSha256 || '').slice(0, 12),
      frozenAt: track.frozen?.frozenAt || null,
      supplementary: (track.supplementary || []).length,
    },
    window: windowState(track, now),
    retest: retestGate(track, snaps, now),
    snapshots: snaps.map((s) => snapshotView(s, reads[s.name], { baselineName: baseline?.name, latestName: latest?.name })),
    focus: focusSnap ? { name: focusSnap.name, kind: focusSnap.kind, kindLabel: SNAP_LABEL[focusSnap.kind] || focusSnap.kind, readable: Boolean(focusRows), error: focusSnap ? reads[focusSnap.name].error : null, rawMissing: focusSnap.rawMissing === true } : null,
    baselineName: baseline?.name || null,
    latestName: latest?.name || null,
    comparison,
    entries,
    remediation: (track.remediation || []).map((r) => ({ date: r.date || '', entry: r.entry || '', what: r.what || '', url: r.url || '', state: r.state || '' })),
    webmaster: webmasterLinks(track),
    installEvidence: (track.installEvidence || []).map((r) => ({ date: r.date || '', entry: r.entry || '', what: r.note || r.what || '', url: r.url || '', source: r.source === 'volunteer' ? 'volunteer' : 'isolated' })),
  }
}

// ---------- 渲染（服务端渲染，零 JS） ----------

export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function safeHref(url) {
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) ? u.href : null } catch { return null }
}

function extLink(url, label = url) {
  const href = safeHref(url)
  return href ? `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${esc(label)}</a>` : esc(label)
}

/** 整改说明是本人写的 Markdown 片段：先切出 URL 再分别转义，避免先转义后链接化出错。 */
function linkify(text) {
  const src = String(text || '')
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>"'`）】)]+/g
  let out = '', last = 0, m
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index))
    if (m[1]) {
      out += extLink(m[2], m[1])
      last = m.index + m[0].length
    } else {
      const url = m[0].replace(/[.,;:!?]+$/, '') // 句末标点不算进链接，留给后面的普通文本
      out += extLink(url)
      last = m.index + url.length
    }
    re.lastIndex = last
  }
  return out + esc(src.slice(last))
}

const STYLE = `
:root{--bg:#0d1117;--bg-elev:#161b22;--bg-elev-2:#1c2128;--border:#30363d;--border-soft:#21262d;--text:#e6edf3;--text-muted:#8b949e;--accent:#58a6ff;--hit:#34d399;--miss:#59636e;--warn:#e3b341;--bad:#f47067;--radius:10px}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg-elev-2);padding:1px 6px;border-radius:5px;font-size:.92em;word-break:break-all}
header.top{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;padding:12px 28px;background:rgba(13,17,23,.92);border-bottom:1px solid var(--border)}
.brand{font-weight:700;letter-spacing:.3px}.brand small{color:var(--text-muted);font-weight:400;margin-left:8px}
.local{font-size:12px;color:var(--hit);border:1px solid rgba(52,211,153,.4);border-radius:999px;padding:2px 10px}
main{max-width:1100px;margin:0 auto;padding:24px 28px 64px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 12px}h3{font-size:14px;margin:0 0 6px}
.muted{color:var(--text-muted)}
.caveat{border-left:3px solid var(--warn);background:rgba(227,179,65,.08);padding:10px 14px;border-radius:0 8px 8px 0;margin:16px 0;color:#e8d9b0}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:16px 0}
.fact{background:var(--bg-elev);border:1px solid var(--border-soft);border-radius:var(--radius);padding:12px 14px}
.fact b{display:block;font-size:20px}.fact span{color:var(--text-muted);font-size:12px}
.ok{color:var(--hit)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.card{background:var(--bg-elev);border:1px solid var(--border-soft);border-radius:var(--radius);padding:16px}
.metric{margin:10px 0}.metric .row{display:flex;justify-content:space-between;font-size:13px}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--bg-elev-2);margin-top:4px}
.bar i{display:block;height:100%}.bar .h{background:var(--hit)}.bar .m{background:var(--miss)}
.bar .u{background:repeating-linear-gradient(45deg,var(--warn) 0 4px,transparent 4px 8px)}
.legend{display:flex;gap:14px;font-size:12px;color:var(--text-muted);margin:6px 0 14px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border-soft);vertical-align:top;overflow-wrap:anywhere}
th{color:var(--text-muted);font-weight:600;background:var(--bg-elev)}
.tag{display:inline-block;font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--border);color:var(--text-muted);white-space:nowrap}
.tag.base{color:var(--accent);border-color:rgba(88,166,255,.45)}.tag.prev{color:var(--warn);border-color:rgba(227,179,65,.45)}
.tag.hit{color:var(--hit);border-color:rgba(52,211,153,.45)}.tag.unav{color:var(--warn);border-color:rgba(227,179,65,.45)}
details{background:var(--bg-elev);border:1px solid var(--border-soft);border-radius:var(--radius);margin:10px 0}
details>summary{cursor:pointer;padding:10px 14px;font-weight:600}
details>summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
details>div{padding:0 14px 14px;overflow-x:auto}
.empty{color:var(--text-muted);padding:14px;border:1px dashed var(--border);border-radius:var(--radius)}
nav.tracks a{display:block;padding:12px 14px;border:1px solid var(--border-soft);border-radius:var(--radius);background:var(--bg-elev);margin-bottom:10px}
footer{color:var(--text-muted);font-size:12px;margin-top:40px;border-top:1px solid var(--border-soft);padding-top:12px}
@media (max-width:640px){main{padding:16px}header.top{padding:10px 16px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`

function page(title, body, { home = false } = {}) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><header class="top"><div class="brand">${home ? 'GEO 本地看板' : '<a href="/">GEO 本地看板</a>'}<small>Scorecard geo-track</small></div>
<span class="local" title="服务只绑定回环地址，数据不出本机">仅本机 · 不联网</span></header>
<main>${body}
<footer>只读视图：看板不采集、不写任何数据；原始检索响应与本机路径不会出现在页面里。采集、登记整改请用 <code>scorecard geo-track</code>。</footer>
</main></body></html>`
}

export function renderIndex(items) {
  const body = items.length
    ? `<h1>本机 track</h1><p class="muted">每个 track 是一组冻结的检索问题，以及它的基线、整改与快照。</p><nav class="tracks">${items.map((t) => t.error
      ? `<div class="card"><b>${esc(t.id)}</b> <span class="bad">读取失败：${esc(t.error)}</span></div>`
      : `<a href="/t/${esc(t.id)}"><b>${esc(t.name)}</b> <span class="muted">· ${esc(t.id)}</span><br><span class="muted">${t.entries} 个入口 · ${t.queries} 条查询 · ${t.snapshots} 份快照 · ${t.remediation} 条整改 · ${t.installEvidence} 条安装证据</span><br>
        <span class="${t.frozenIntact ? 'ok' : 'bad'}">${t.frozenIntact ? '冻结有效' : '冻结已被改动'}</span> · <span class="muted">${t.hasBaseline ? '已有基线' : '尚无基线'} · 复测窗口${esc(t.window.label)}</span></a>`).join('')}</nav>`
    : `<h1>还没有 track</h1><div class="empty">先用 <code>scorecard geo-track init track.json</code> 冻结一组查询，再 <code>capture --kind baseline</code> 建立基线。</div>`
  return page('GEO 本地看板', body, { home: true })
}

function metric(label, c) {
  if (!c || !c.total) return `<div class="metric"><div class="row"><span>${label}</span><span class="muted">无查询</span></div></div>`
  const pct = (n) => ((n / c.total) * 100).toFixed(1)
  return `<div class="metric"><div class="row"><span>${label}</span><span><b>${c.hits}</b>/${c.total} 命中${c.unavailable ? ` · <span class="warn">${c.unavailable} 不可用</span>` : ''}</span></div>
<div class="bar" role="img" aria-label="${label}：命中 ${c.hits}，未中 ${c.misses}，不可用 ${c.unavailable}，共 ${c.total}"><i class="h" style="width:${pct(c.hits)}%"></i><i class="m" style="width:${pct(c.misses)}%"></i><i class="u" style="width:${pct(c.unavailable)}%"></i></div></div>`
}

const delta = (a, b) => {
  if (!a || !b) return ''
  const d = b.hits - a.hits
  return d === 0 ? '<span class="muted">±0</span>' : `<span class="${d > 0 ? 'ok' : 'bad'}">${d > 0 ? '+' : ''}${d}</span>`
}

const fmtTime = (iso) => (iso ? esc(iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC')) : '<span class="muted">—</span>')

function hitTag(q) {
  if (q.hit === true) return '<span class="tag hit">命中</span>'
  if (q.hit === false) return '<span class="tag">未中</span>'
  return `<span class="tag unav" title="采集失败或缺失，不计为零命中">不可用 · ${esc(q.status)}</span>`
}

export function renderTrack(m) {
  const t = m.track
  const parts = []
  parts.push(`<p class="muted"><a href="/">全部 track</a> / ${esc(t.id)}</p><h1>${esc(t.name)}</h1>
<div class="caveat">${esc(m.caveat)}</div>
<div class="facts">
<div class="fact"><b class="${t.frozenIntact ? 'ok' : 'bad'}">${t.frozenIntact ? '冻结有效' : '已被改动'}</b><span>${t.queryCount} 条查询 · sha256 <code>${esc(t.frozenSha)}…</code></span></div>
<div class="fact"><b>${m.snapshots.length}</b><span>份快照${m.baselineName ? '' : ' · 尚无基线'}</span></div>
<div class="fact"><b class="${m.window.state === 'open' ? 'ok' : m.window.state === 'unset' ? 'bad' : 'warn'}">${esc({ before: '窗口未开始', open: '窗口进行中', closed: '窗口已结束', unset: '未登记窗口' }[m.window.state])}</b><span>${esc(m.window.label)}${m.window.today ? ` · 今天 ${esc(m.window.today)}` : ''}</span></div>
<div class="fact"><b class="${m.retest.allowed ? 'ok' : 'warn'}">${m.retest.allowed ? '可正式复测' : '暂不可正式复测'}</b><span>${esc(m.retest.reason)}</span></div>
<div class="fact"><b>${m.remediation.length}</b><span>条整改 · ${m.installEvidence.length} 条安装证据</span></div>
</div>`)

  // 站长工具入口（放在顶部：用户要求可直达）
  parts.push(`<h2 id=\"webmaster\">站长工具入口</h2><p class=\"muted\">只是入口链接：需登录有该资源权限的账号。看板不登录、不调用站长工具，不能证明拥有权限，也不能证明已收录；收录状态以登录后站内实际显示为准。</p>
<div class=\"cards\">${m.webmaster.map((w) => `<section class=\"card\"><h3>${extLink(w.url, w.name)}</h3><p class=\"muted\" style=\"margin:4px 0 0;font-size:12px\">${w.configured ? '<span class=\"tag base\">项目级链接</span>' : '<span class=\"tag\">通用入口</span>'} ${esc(w.note)}</p></section>`).join('')}</div>
<p class=\"muted\" style=\"font-size:12px\">在 track.json 顶层加 <code>webmasterTools: [{ \"name\", \"url\", \"note\" }]</code> 配置项目级资源，不影响冻结哈希。</p>`)

  // 基线
  const f = m.focus
  parts.push(`<h2 id="baseline">基线与入口</h2>`)
  if (!f) parts.push('<div class="empty">这个 track 还没有任何快照。先跑 <code>scorecard geo-track capture ' + esc(t.id) + ' --kind baseline</code>。</div>')
  else {
    parts.push(`<p class="muted">当前查看：<code>${esc(f.name)}</code> <span class="tag ${BASELINE_KINDS.has(f.kind) ? 'base' : f.kind === 'preview' ? 'prev' : ''}">${esc(f.kindLabel)}</span>${f.rawMissing ? ' · <span class="warn">原始响应缺失，只能做有限比较</span>' : ''}${f.name !== m.baselineName && m.baselineName ? ` · <a href="/t/${esc(t.id)}">回到基线</a>` : ''}</p>`)
    if (!f.readable) parts.push(`<div class="empty bad">这份快照读不出来：${esc(f.error)}。完整性校验失败的快照不参与任何统计。</div>`)
    parts.push('<div class="legend"><span><i style="background:var(--hit)"></i>命中已登记来源</span><span><i style="background:var(--miss)"></i>未中</span><span><i style="background:repeating-linear-gradient(45deg,var(--warn) 0 3px,transparent 3px 6px)"></i>不可用（不算零命中）</span></div>')
    parts.push(`<div class="cards">${m.entries.map((e) => `<section class="card"><h3>${esc(e.name)} <span class="muted">· ${esc(e.id)}</span></h3>
${metric('品牌题', e.focus?.brand)}${metric('品类 / 使用题', e.focus?.category)}
${m.comparison?.available && f.name === m.baselineName ? `<p class="muted" style="font-size:12px;margin:6px 0 0">对照最新快照：品牌 ${delta(e.baseline?.brand, e.latest?.brand)} · 品类 ${delta(e.baseline?.category, e.latest?.category)}</p>` : ''}
<p class="muted" style="font-size:12px;margin:8px 0 0">${e.sources.length} 个已登记来源 · ${e.remediation} 条整改</p></section>`).join('')}</div>`)
    for (const e of m.entries) {
      parts.push(`<details><summary>${esc(e.name)} · 查询明细（${e.queries.length}）</summary><div><table><thead><tr><th>查询</th><th>类型</th><th>结果</th><th>命中的已登记来源</th></tr></thead><tbody>${e.queries.map((q) => `<tr><td><code>${esc(q.id)}</code><br>${esc(q.query)}</td><td>${q.kind === 'brand' ? '品牌' : '品类'}</td><td>${hitTag(q)}</td><td>${q.own.length ? q.own.map((o) => `${extLink(o.url)} <span class="tag">${esc(o.kindLabel)}</span>`).join('<br>') : '<span class="muted">—</span>'}${q.thirdPartyCount ? `<br><span class="muted">另有 ${q.thirdPartyCount} 条第三方来源（不展示地址）</span>` : ''}</td></tr>`).join('')}</tbody></table>
<p class="muted" style="font-size:12px">已登记来源：${e.sources.map((s) => `<code>${esc(s.prefix)}</code> ${esc(s.kindLabel)}`).join('；') || '无'}</p></div></details>`)
    }
  }

  // 比较
  parts.push('<h2 id="compare">基线 → 最新快照</h2>')
  const c = m.comparison
  if (!c) parts.push(`<div class="empty">${m.baselineName ? '基线之后还没有新快照。窗口内跑 <code>capture --kind retest</code>，窗口外只能跑 <code>--kind preview</code>。' : '还没有基线，无从比较。'}</div>`)
  else if (!c.available) parts.push(`<div class="empty warn">${esc(c.reason)}</div>`)
  else {
    parts.push(`${c.afterKind === 'preview' ? '<div class="caveat">对照快照是 <b>preview</b>，不是正式复测，不能当作复测结果引用。</div>' : ''}
<div class="facts"><div class="fact"><b class="ok">${c.counts.nowHit}</b><span>未中 → 命中</span></div><div class="fact"><b class="bad">${c.counts.nowMiss}</b><span>命中 → 未中</span></div><div class="fact"><b>${c.counts.stillHit}</b><span>保持命中</span></div><div class="fact"><b>${c.counts.stillMiss}</b><span>保持未中</span></div><div class="fact"><b class="warn">${c.counts.unavailable}</b><span>不可比较（采集失败或缺失）</span></div></div>`)
    parts.push(c.moved.length ? `<table><thead><tr><th>查询</th><th>变化</th><th>对照快照里的已登记来源</th></tr></thead><tbody>${c.moved.map((d) => `<tr><td><code>${esc(d.id)}</code> ${esc(d.query)}</td><td>${d.change === 'now-hit' ? '<span class="ok">未中 → 命中</span>' : '<span class="bad">命中 → 未中</span>'}</td><td>${d.ownedAfter.map((o) => extLink(o.url)).join('<br>') || '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">没有查询发生命中变化。</div>')
  }

  // 整改
  parts.push('<h2 id="remediation">已登记的整改</h2><p class="muted">时间早于对照快照的整改只说明「已上线」，不能说明是它造成了变化。</p>')
  parts.push(m.remediation.length ? `<table><thead><tr><th style="width:96px">日期</th><th style="width:56px">入口</th><th>内容</th></tr></thead><tbody>${m.remediation.map((r) => `<tr><td>${esc(r.date)}</td><td><code>${esc(r.entry)}</code></td><td>${linkify(r.what)}${r.url ? `<br>${extLink(r.url)}` : ''}${r.state ? ` <span class="tag">${esc(r.state)}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">还没有整改记录。用 <code>scorecard geo-track log ${esc(t.id)} --type remediation --entry &lt;入口&gt; --what "..."</code> 登记。</div>`)

  parts.push('<h2 id="install">安装成功证据</h2>')
  parts.push(m.installEvidence.length ? `<table><thead><tr><th style="width:96px">日期</th><th style="width:56px">入口</th><th style="width:110px">来源</th><th>说明</th></tr></thead><tbody>${m.installEvidence.map((r) => `<tr><td>${esc(r.date)}</td><td><code>${esc(r.entry)}</code></td><td><span class="tag">${r.source === 'volunteer' ? '用户自愿反馈' : '本机隔离测试'}</span></td><td>${esc(r.what)}${r.url ? `<br>${extLink(r.url)}` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">还没有安装证据。</div>')

  // 快照
  parts.push('<h2 id="snapshots">快照</h2><p class="muted">快照只新建不覆盖；每份读之前先按 sha256 清单校验。点名称可查看该快照的查询明细。</p>')
  parts.push(m.snapshots.length ? `<table><thead><tr><th>名称</th><th>类型</th><th>时间</th><th>工具</th><th>完整性</th></tr></thead><tbody>${m.snapshots.map((s) => `<tr><td><a href="/t/${esc(t.id)}?snapshot=${encodeURIComponent(s.name)}"><code>${esc(s.name)}</code></a>${s.isBaseline ? ' <span class="tag base">基线</span>' : ''}${s.isLatest ? ' <span class="tag">最新对照</span>' : ''}${s.note ? `<br><span class="muted">${esc(s.note)}</span>` : ''}</td><td><span class="tag ${s.kind === 'preview' ? 'prev' : BASELINE_KINDS.has(s.kind) ? 'base' : ''}">${esc(s.kindLabel)}</span></td><td>${fmtTime(s.at)}</td><td>${s.tool ? esc(s.tool) : '<span class="muted">—</span>'}${s.rawMissing ? '<br><span class="warn">原始响应缺失</span>' : ''}</td><td>${s.readable ? '<span class="ok">校验通过</span>' : `<span class="bad">不可用：${esc(s.error)}</span>`}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">还没有快照。</div>')

  return page(`${t.name} · GEO 本地看板`, parts.join('\n'))
}

// ---------- 本地服务 ----------

const HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
}

/** 处理一次请求，返回 { status, body }。抽成纯函数便于离线测试。 */
export function handle({ method, url, host }, { env = process.env, now = new Date() } = {}) {
  if (!isLoopbackHostHeader(host)) return { status: 421, body: '只接受回环地址访问（Host 头不是 127.0.0.1 / localhost / ::1）' }
  if (method !== 'GET' && method !== 'HEAD') return { status: 405, body: '看板只读，只接受 GET' }
  let u
  try { u = new URL(url, 'http://127.0.0.1') } catch { return { status: 400, body: '请求地址不合法' } }
  if (u.pathname === '/') return { status: 200, body: renderIndex(buildIndexModel({ env, now })), html: true }
  const m = u.pathname.match(/^\/t\/([a-z0-9][a-z0-9-]{1,63})\/?$/)
  if (!m) return { status: 404, body: '没有这个页面' }
  if (!listTracks(env).includes(m[1])) return { status: 404, body: `没有这个 track：${m[1]}` }
  try {
    const focus = u.searchParams.get('snapshot') || undefined
    return { status: 200, body: renderTrack(buildTrackModel(m[1], { env, now, focus })), html: true }
  } catch (error) {
    return { status: /找不到快照/.test(error.message) ? 404 : 500, body: error.message }
  }
}

export function createDashboardServer({ env = process.env } = {}) {
  return createServer((req, res) => {
    let out
    try { out = handle({ method: req.method, url: req.url, host: req.headers.host }, { env }) }
    catch (error) { out = { status: 500, body: `看板内部错误：${error.message}` } }
    res.writeHead(out.status, { ...HEADERS, 'content-type': out.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' })
    res.end(req.method === 'HEAD' ? undefined : out.body)
  })
}

/** 启动本地看板。非回环 host 直接拒绝 —— 不提供任何开放公网的开关。 */
export async function startDashboardServer({ host = DEFAULT_HOST, port = DEFAULT_PORT, env = process.env } = {}) {
  if (!isLoopbackHost(host)) {
    throw new Error(`拒绝绑定 ${host}：GEO 看板只在本机回环地址提供（127.0.0.1 / ::1 / localhost）。需要远程查看请用 SSH 端口转发，或 export 成 HTML 文件。`)
  }
  const server = createDashboardServer({ env })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}
