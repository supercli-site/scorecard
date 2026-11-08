import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// 不把缺失的 sitemap 交给 SPA fallback，否则 HTML 会被误当成 XML。
export function sitemapHandler(distDir) {
  return async (c) => {
    try {
      const xml = await readFile(join(distDir, 'sitemap.xml'))
      c.header('Content-Type', 'application/xml; charset=utf-8')
      c.header('Cache-Control', 'public, max-age=3600')
      return c.body(xml)
    } catch (error) {
      if (error.code === 'ENOENT') return c.notFound()
      throw error
    }
  }
}
