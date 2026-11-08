import { test, expect, beforeAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { sitemapHandler } from '../server/sitemap.js'

const root = new URL('..', import.meta.url).pathname
const tmp = mkdtempSync(join(tmpdir(), 'scorecard-static-'))
const dist = join(tmp, 'dist')
let app

beforeAll(async () => {
  // 独立构建目录避免依赖旧 dist，也不覆盖开发者正在查看的产物。
  const build = Bun.spawnSync(['bun', 'run', 'build', '--outDir', dist], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (build.exitCode !== 0) throw new Error(`vite build failed: ${build.stderr.toString()}`)
  const oldDist = process.env.SCORECARD_DIST_DIR
  const oldData = process.env.SCORECARD_DATA_DIR
  process.env.SCORECARD_DIST_DIR = dist
  process.env.SCORECARD_DATA_DIR = join(tmp, 'data')
  try { ({ app } = await import('../server/index.js?sitemap-static-test')) }
  finally {
    if (oldDist === undefined) delete process.env.SCORECARD_DIST_DIR
    else process.env.SCORECARD_DIST_DIR = oldDist
    if (oldData === undefined) delete process.env.SCORECARD_DATA_DIR
    else process.env.SCORECARD_DATA_DIR = oldData
  }
})

test('/sitemap.xml 返回真实构建 XML 而不是首页 HTML', async () => {
  const res = await app.request('/sitemap.xml')
  expect(res.status).toBe(200)
  expect(res.headers.get('Content-Type')).toMatch(/application\/xml/i)
  const body = await res.text()
  expect(body).toContain('<loc>https://scorecard.webkubor.online/</loc>')
  expect(body).not.toContain('<!DOCTYPE html>')
})

test('sitemap 缺失返回 404，不能落入 SPA fallback', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'scorecard-no-sitemap-'))
  const isolated = new Hono()
  isolated.get('/sitemap.xml', sitemapHandler(empty))
  isolated.get('*', (c) => c.html('<!DOCTYPE html><title>fallback</title>'))
  const res = await isolated.request('/sitemap.xml')
  expect(res.status).toBe(404)
  expect(await res.text()).not.toContain('fallback')
})

test('robots 和无 JS 首页来自实际构建产物', async () => {
  const robots = await app.request('/robots.txt')
  expect(robots.status).toBe(200)
  expect(await robots.text()).toContain('Sitemap: https://scorecard.webkubor.online/sitemap.xml')
  const home = await app.request('/')
  expect(home.status).toBe(200)
  const body = await home.text()
  expect(body).toContain('开源项目成熟度质检')
  expect(body).toContain('https://github.com/supercli-site/scorecard')
  expect(body).toContain('/skill.md')
})
