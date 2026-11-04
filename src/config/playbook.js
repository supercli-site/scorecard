/**
 * 发布打法（launch playbook）—— 统一入口的数据与渲染。
 *
 * 内容唯一真源是 docs/launch-playbook.md（仓库读者、报告、页面共用一份）。
 * 客户端没有 markdown 依赖，也不打算为一个页面引入一整个渲染库 ——
 * 这里的渲染器只认本文档用到的语法（标题/引用块/表格/有序无序列表/
 * 粗体/行内代码/链接/分隔线），先整体转义再转换，不吃外部输入。
 *
 * 入口收敛：所有引用只允许指向 PLAYBOOK_ENTRY_URL。后期转付费时改这一个
 * 模块（加 gate / 换价格页），报告、页面、Markdown 三处自动跟着走。
 */
import raw from '../../docs/launch-playbook.md?raw'

/** 站内唯一入口（hash 路由）。顶栏、报告引导卡、Markdown 报告都指向它。 */
export const PLAYBOOK_ENTRY_URL = '#/playbook'
/** 供 server 端 Markdown 报告使用的绝对地址。 */
export const PLAYBOOK_ABS_URL = 'https://scorecard.webkubor.online/#/playbook'

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const inline = (s) =>
  escapeHtml(s)
    /* 行内代码 */
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    /* 链接：只放行 http(s) 与站内 hash/相对路径 */
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, href) =>
      /^(https?:\/\/|\/|#)/.test(href) ? `<a href="${href}" target="_blank" rel="noopener">${text}</a>` : text)
    /* 粗体 */
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

/**
 * 受限 markdown → HTML。逐行状态机：表格、引用块、有序/无序列表、标题、分隔线。
 * 渲染的是仓库内的静态文档，不是用户输入 —— 但转义仍然前置，规则只有一条才不会被绕过。
 */
export function renderPlaybook(src = raw) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n')
  const out = []
  let list = null // 'ul' | 'ol' | null
  let table = null // 行缓冲
  let quote = null

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }
  const closeQuote = () => {
    if (quote) {
      out.push('<blockquote>' + quote.join('<br>') + '</blockquote>')
      quote = null
    }
  }
  const closeTable = () => {
    if (table) {
      const [head, ...rows] = table
      out.push('<table><thead><tr>' +
        head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>')
      table = null
    }
  }
  const cells = (line) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

  for (const line of lines) {
    const t = line.trim()
    if (/^\|/.test(t)) {
      closeList(); closeQuote()
      if (/^\|[\s:|-]+\|$/.test(t)) continue // 表头分隔行
      table = table || []
      table.push(cells(t))
      continue
    }
    closeTable()
    if (/^>\s?/.test(t)) {
      closeList()
      if (quote === null) { out.push('<blockquote>'); quote = [] }
      quote.push(inline(t.replace(/^>\s?/, '')))
      continue
    }
    closeQuote()
    if (/^(---|\*\*\*)\s*$/.test(t)) { closeList(); out.push('<hr>'); continue }
    const h = t.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      closeList()
      const level = Math.min(h[1].length + 1, 5) // 文档的 # 是页内 h2，往下顺延
      out.push(`<h${level}>${inline(h[2])}</h${level}>`)
      continue
    }
    const ol = t.match(/^(\d+)\.\s+(.*)$/)
    if (ol) {
      closeQuote()
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol' }
      out.push(`<li>${inline(ol[2])}</li>`)
      continue
    }
    const ul = t.match(/^[-*]\s+(.*)$/)
    if (ul) {
      closeQuote()
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul' }
      out.push(`<li>${inline(ul[1])}</li>`)
      continue
    }
    closeList()
    if (t) out.push(`<p>${inline(t)}</p>`)
  }
  closeList(); closeQuote(); closeTable()
  return out.join('\n')
}

export const playbookHtml = renderPlaybook()
