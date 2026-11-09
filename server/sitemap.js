import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// 不把缺失的 sitemap 交给 SPA fallback，否则 HTML 会被误当成 XML。
export function sitemapHandler(distDir) {
  return async (c) => {
    try {
      const path = join(distDir, 'sitemap.xml')
      const [xml, info] = await Promise.all([readFile(path), stat(path)])
      c.header('Last-Modified', info.mtime.toUTCString())
      c.header('Content-Type', 'application/xml; charset=utf-8')
      c.header('Cache-Control', 'public, max-age=3600')
      return c.body(xml)
    } catch (error) {
      if (error.code === 'ENOENT') return c.notFound()
      throw error
    }
  }
}
