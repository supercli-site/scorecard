// scorecard geo-track —— 本地 GEO 检索基线追踪（不经过线上 API）。
//
//   scorecard geo-track init <track.json>                     冻结查询，建 track
//   scorecard geo-track list                                  列出本机 track
//   scorecard geo-track status <id>                           查询冻结状态、快照、复测窗口
//   scorecard geo-track capture <id> --kind baseline|retest|preview [--supplementary]
//   scorecard geo-track import-derived <id> <sources.csv> [--coverage <file>] [--note "..."]
//   scorecard geo-track report <id> [--before <快照名>] [--after <快照名>] [--out <file.md>]
//   scorecard geo-track freeze-kinds <id>                      旧格式 track 显式补冻结题型（只能执行一次）
//   scorecard geo-track log <id> --type remediation|install --entry <入口> --what "..." [--url ...] [--state ...] [--source volunteer|isolated]
//
// 数据目录：~/.scorecard/geo（SCORECARD_GEO_DIR 可改）。项目数据不进仓库。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  dataDir, initTrack, listTracks, loadTrack, listSnapshots, capture, importDerived,
  readSnapshot, summarize, compare, reportMarkdown, trackDir, queriesDigest, freezeKinds,
} from '../server/geo-track.js'

export const GEO_TRACK_HELP = `
scorecard geo-track — 本地 GEO 检索基线（固定查询 → 基线 → 整改 → 窗口内复测）

  init <track.json>              冻结查询并建 track；已存在则拒绝
                                 格式模板：包内 examples/geo-track.track.json
  list                           列出本机所有 track
  status <id>                    冻结哈希、快照列表、复测窗口
  capture <id> --kind <k>        k = baseline | retest | preview
                                 retest 只允许在 track.window 内；窗口外用 preview
    --supplementary              顺带采集 supplementary 查询（无历史基线，单列）
    --concurrency <n>            并发数，默认 3
  import-derived <id> <csv>      导入只剩派生数据的旧基线（CSV 列：query_id,url,source_kind）
    --coverage <file>            覆盖清单（query_id 列的 CSV 或每行一个 id）；
                                 不给则没有来源行的查询记为缺失，不算零命中
  report <id>                    基线与最新快照的有限比较（Markdown）
    --before <名> --after <名>   指定快照；--out <file> 写文件（不覆盖）
  freeze-kinds <id>              旧格式 track 按当前 brand/category 补冻结题型；只能执行一次，
                                 不改已有快照，也不能证明迁移之前的题型
  log <id> --type remediation|install --entry <入口> --what "..."
                                 登记整改或安装证据（install 需 --source volunteer|isolated）

数据目录：${'${SCORECARD_GEO_DIR:-~/.scorecard/geo}'}。采集默认调用本机 magpie web_search。
URL 出现在响应里不代表搜索排名、收录、安装或因果；少量样本不构成统计显著。
`

function parseCsv(text) {
  const rows = []
  let field = '', row = [], quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((v) => v !== '')) rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((v) => v !== '')) rows.push(row) }
  const [header, ...body] = rows
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])))
}

/** 覆盖清单：带 query_id 表头的 CSV，或每行一个查询 id（# 开头为注释）。 */
function readCoverage(text) {
  const firstLine = text.split(/\r?\n/, 1)[0]
  if (/(^|,)\s*query_id\s*(,|$)/.test(firstLine)) return parseCsv(text).map((r) => r.query_id).filter(Boolean)
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
}

function pick(snaps, name, fallback) {
  if (!name) return fallback
  const s = snaps.find((x) => x.name === name)
  if (!s) throw new Error(`找不到快照：${name}`)
  return s
}

export async function runGeoTrack(argv, args) {
  const [sub, id, file] = argv
  if (!sub || args.help || args.h) { console.log(GEO_TRACK_HELP); return }

  if (sub === 'list') {
    const ids = listTracks()
    console.log(`数据目录：${dataDir()}`)
    if (!ids.length) console.log('还没有 track。先 scorecard geo-track init <track.json>')
    for (const t of ids) console.log(`  · ${t}（${listSnapshots(t).length} 份快照）`)
    return
  }

  if (sub === 'init') {
    const path = id
    if (!path || !existsSync(path)) throw new Error('init 需要一个 track.json 路径；格式见包内 examples/geo-track.track.json')
    const stored = initTrack(JSON.parse(readFileSync(path, 'utf8')))
    console.log(`✅ 已建 track ${stored.id}：${stored.queries.length} 条查询已冻结（sha256 ${stored.frozen.queriesSha256.slice(0, 12)}…）`)
    console.log(`   位置：${trackDir(stored.id)}`)
    return
  }

  if (!id) throw new Error(`${sub} 需要 track id`)
  const track = loadTrack(id)

  if (sub === 'status') {
    const snaps = listSnapshots(id)
    const intact = queriesDigest(track.queries) === track.frozen.queriesSha256
    console.log(`${track.name || track.id}  ·  ${track.entries.length} 个入口 · ${track.queries.length} 条查询 · 冻结${intact ? '有效' : '已被改动 ❌'}`)
    if (!track.frozen.kindsSha256) console.log('⚠ 旧格式冻结：哈希不含题型（brand/category），改题型不会被拦截；核对题型后可执行 freeze-kinds 补冻结')
    else if (track.frozen.kindsFrozenBy === 'migration') console.log(`题型冻结于 ${track.frozen.kindsFrozenAt}（迁移，不证明此前题型）`)
    console.log(`复测窗口：${track.window ? `${track.window.start}..${track.window.end}（${track.window.timezone || 'UTC'}）` : '未登记'}`)
    console.log(`快照（${snaps.length}）：`)
    for (const s of snaps) console.log(`  · ${s.name}  [${s.kind}]`)
    console.log(`整改 ${(track.remediation || []).length} 条 · 安装证据 ${(track.installEvidence || []).length} 条`)
    return
  }

  if (sub === 'capture') {
    const kind = String(args.kind || '')
    // 并发数要显式校验：`Number(x) || 3` 会把 0 吞成 3，也会把非数字变成 NaN。
    // 传进来之前先确认是正整数，错误提示直接给用户看。
    let concurrency = 3
    if (args.concurrency != null) {
      concurrency = Number(args.concurrency)
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error(`--concurrency 必须是 ≥ 1 的整数，收到：${args.concurrency}`)
      }
    }
    const r = await capture(id, { kind, includeSupplementary: Boolean(args.supplementary), concurrency })
    console.log(`${kind}: ${r.summary.total} 条，失败 ${r.summary.failedQueryIds.length}；快照 ${r.dir}`)
    if (r.summary.failedQueryIds.length) {
      console.error(`失败（不计为零命中）：${r.summary.failedQueryIds.join(', ')}`)
      process.exitCode = 1
    }
    return
  }

  if (sub === 'import-derived') {
    if (!file || !existsSync(file)) throw new Error('import-derived 需要 CSV 路径（列：query_id,url,source_kind）')
    const sources = parseCsv(readFileSync(file, 'utf8')).map((r) => ({ queryId: r.query_id, url: r.url, kind: r.source_kind || 'unclassified', title: r.title || '' }))
    // 覆盖清单：显式登记当时确实采到的查询（含「采到了但零来源」的）。
    // 不给就按「CSV 里有来源行」推断，没来源行的查询记为缺失，不算零命中。
    let coveredQueryIds = null
    if (args.coverage) {
      if (!existsSync(String(args.coverage))) throw new Error(`找不到覆盖清单：${args.coverage}`)
      coveredQueryIds = readCoverage(readFileSync(String(args.coverage), 'utf8'))
    }
    const r = importDerived(id, { sources, coveredQueryIds, note: String(args.note || '') })
    console.log(`✅ 已导入派生基线：${sources.length} 行来源 → ${r.dir}`)
    return
  }

  if (sub === 'report') {
    const snaps = listSnapshots(id)
    const baseline = snaps.find((s) => s.kind === 'baseline' || s.kind === 'derived-recovered')
    const before = pick(snaps, args.before, baseline)
    if (!before) throw new Error('还没有基线快照')
    const later = snaps.filter((s) => s.name > before.name)
    const after = pick(snaps, args.after, later[later.length - 1])
    const beforeRows = readSnapshot(track, before)
    const afterRows = after ? readSnapshot(track, after) : null
    const md = reportMarkdown(track, {
      before, after,
      beforeSummary: summarize(track, beforeRows),
      afterSummary: afterRows ? summarize(track, afterRows) : null,
      diff: afterRows ? compare(track, beforeRows, afterRows) : null,
    })
    if (args.out) {
      writeFileSync(String(args.out), md, { flag: 'wx' })
      console.log(`✅ 报告已写入 ${args.out}`)
    } else console.log(md)
    return
  }

  if (sub === 'freeze-kinds') {
    const r = freezeKinds(id)
    console.log(`✅ 已冻结 ${r.queries} 条查询的题型（sha256 ${r.kindsSha256.slice(0, 12)}…，${r.kindsFrozenAt}）`)
    console.log('   之后改 brand/category 会拒绝采集。已有快照未改动；迁移证明不了此前的题型，报告会注明迁移时间。')
    return
  }

  if (sub === 'log') {
    const type = String(args.type || '')
    const entry = String(args.entry || '')
    if (!track.entries.some((e) => e.id === entry)) throw new Error(`--entry 不在这个 track 的入口里：${entry}`)
    if (!args.what || args.what === true) throw new Error('--what 必填')
    const item = { date: new Date().toISOString().slice(0, 10), entry, what: String(args.what), url: args.url ? String(args.url) : undefined, state: args.state ? String(args.state) : undefined }
    if (type === 'remediation') track.remediation = [...(track.remediation || []), item]
    else if (type === 'install') {
      if (!['volunteer', 'isolated'].includes(String(args.source))) throw new Error('install 证据必须标 --source volunteer（用户自愿）或 isolated（本机隔离测试）')
      track.installEvidence = [...(track.installEvidence || []), { ...item, source: String(args.source), note: item.what }]
    } else throw new Error('--type 只能是 remediation | install')
    // 只追加记录；queries 与 frozen 原样写回，不影响冻结哈希
    writeFileSync(join(trackDir(id), 'track.json'), JSON.stringify(track, null, 2) + '\n')
    console.log(`✅ 已登记 ${type}：${item.what}`)
    return
  }

  throw new Error(`未知子命令：${sub}\n${GEO_TRACK_HELP}`)
}
