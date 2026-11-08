import { test, expect } from 'bun:test'
import { auditPage } from '../server/audit-page.js'

const origin = 'https://example.test'

async function auditWith(sitemap, links = '') {
  const original = globalThis.fetch
  globalThis.fetch = async (target) => {
    const url = String(target)
    if (url === `${origin}/`) return new Response(`<html lang="en"><head><title>Example</title></head><body><h1>Example</h1>${links}</body></html>`)
    if (url === `${origin}/sitemap.xml`) return new Response(sitemap)
    return new Response('not found', { status: 404 })
  }
  try {
    const result = await auditPage({ url: `${origin}/` })
    return result.dims.find((d) => d.key === 'root-files')
  } finally { globalThis.fetch = original }
}

test('单页 sitemap 不因只有一个 URL 被判为故障', async () => {
  const root = await auditWith(`<urlset><url><loc>${origin}/</loc></url></urlset>`)
  expect(root.evidence.join(' ')).toContain('1 个 loc 条目')
  expect(root.gaps.join(' ')).not.toContain('只有')
  expect(root.manual.join(' ')).toContain('实际收录状态需另行核实')
})

test('首页链接与 sitemap index 不被当作覆盖率证据', async () => {
  const root = await auditWith(`<sitemapindex><sitemap><loc>${origin}/child.xml</loc></sitemap></sitemapindex>`, '<a href="/login">登录</a>')
  expect(root.gaps.join(' ')).not.toContain('没进 sitemap')
  expect(root.evidence.join(' ')).not.toContain('覆盖完整')
  expect(root.manual.join(' ')).toContain('完整性')
})
