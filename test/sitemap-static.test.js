import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const dist = join(root, 'dist')

let app

beforeAll(async () => {
  if (!existsSync(join(dist, 'sitemap.xml'))) {
    throw new Error('缺少构建产物：先跑 bun run build 再跑本测试')
  }
  ;({ app } = await import('../server/index.js?sitemap-test'))
})

afterAll(() => {})

test('/sitemap.xml 返回真实 XML 而不是首页 HTML', async () => {
  const res = await app.request('/sitemap.xml')
  expect(res.status).toBe(200)
  const type = res.headers.get('Content-Type') || ''
  expect(type).toMatch(/xml/i)
  const body = await res.text()
  expect(body).toContain('<loc>https://scorecard.webkubor.online/</loc>')
  expect(body).not.toContain('<!DOCTYPE html>')
  expect(body).not.toContain('<div id="app">')
})

test('robots.txt 声明 sitemap 绝对地址', async () => {
  const res = await app.request('/robots.txt')
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body).toContain('Sitemap: https://scorecard.webkubor.online/sitemap.xml')
})

test('首页 HTML 含无 JS 也可见的静态首屏与真实链接', async () => {
  const res = await app.request('/')
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body).toContain('开源项目成熟度质检')
  expect(body).toContain('https://github.com/supercli-site/scorecard')
  expect(body).toContain('/skill.md')
})
