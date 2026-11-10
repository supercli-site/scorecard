// scorecard geo-dashboard —— 本地 GEO 看板（只读，只绑回环地址）。
//
//   scorecard geo-dashboard [serve] [--port 54447] [--host 127.0.0.1]   起本机看板
//   scorecard geo-dashboard export <id> --out <file.html> [--snapshot <名>]   导出自包含 HTML
//
// 数据目录与 geo-track 相同：~/.scorecard/geo（SCORECARD_GEO_DIR 可改）。
import { writeFileSync } from 'node:fs'
import { buildTrackModel, renderTrack, startDashboardServer, DEFAULT_PORT, DEFAULT_HOST } from '../server/geo-dashboard.js'

export const GEO_DASHBOARD_HELP = `
scorecard geo-dashboard — 本地 GEO 看板：查看 track、基线、整改与快照（只读）

  serve（默认）                  起本机看板，只绑回环地址
    --port <n>                   默认 ${DEFAULT_PORT}
    --host <h>                   只接受 127.0.0.1 / ::1 / localhost；其他一律拒绝
  export <id> --out <file.html>  导出单个 track 的自包含 HTML（不覆盖已有文件）
    --snapshot <名>              展开指定快照的查询明细（默认基线）

看板不采集、不写数据；原始检索响应与本机路径不会出现在页面里。
远程查看请用 SSH 端口转发，不要把看板开到公网。
`

export async function runGeoDashboard(positional, args) {
  const [sub = 'serve', id] = positional
  if (args.help || args.h || sub === 'help') { console.log(GEO_DASHBOARD_HELP); return }

  if (sub === 'serve') {
    const host = args.host && args.host !== true ? String(args.host) : DEFAULT_HOST
    const port = Number(args.port) || DEFAULT_PORT
    const server = await startDashboardServer({ host, port })
    const shown = host.includes(':') ? `[${host}]` : host
    console.log(`GEO 本地看板：http://${shown}:${server.address().port}/  （仅本机，Ctrl+C 退出）`)
    return
  }

  if (sub === 'export') {
    if (!id) throw new Error('export 需要 track id')
    if (!args.out || args.out === true) throw new Error('export 需要 --out <file.html>')
    const focus = args.snapshot && args.snapshot !== true ? String(args.snapshot) : undefined
    const html = renderTrack(buildTrackModel(id, { focus }))
    writeFileSync(String(args.out), html, { flag: 'wx' })
    console.log(`✅ 已导出 ${args.out}（含本机 GEO 数据，请勿公开上传）`)
    return
  }

  throw new Error(`未知子命令：${sub}\n${GEO_DASHBOARD_HELP}`)
}
