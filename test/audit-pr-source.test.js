import { test, expect } from 'bun:test'
import { auditProject } from '../server/audit.js'

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)

function fixture({ headContents = true, headStatus = 200, truncateRoot = false, issueEntries = null, failPath = '', failStatus = 403, sourceRepo = 'example/project', pkgName = 'project', hasBin = true, readme = '# Project\n\nReadme body.' } = {}) {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async url => {
    const parsed = new URL(url)
    const path = parsed.pathname
    const sourcePath = path.replace(`/repos/${sourceRepo}/`, '/repos/example/project/')
    const ref = parsed.searchParams.get('ref')
    calls.push({ path, ref, hostname: parsed.hostname })
    const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) })
    if (sourcePath.endsWith(failPath) && failPath) return json({ message: 'unavailable' }, failStatus)
    if (path === '/repos/example/project') {
      return json({ name: 'project', default_branch: 'main', description: 'A CLI tool for developers', topics: ['cli'], pushed_at: new Date().toISOString(), stargazers_count: 12, license: { spdx_id: 'MIT' }, homepage: 'https://example.com', archived: false, open_issues_count: 1 })
    }
    if (sourcePath === '/repos/example/project/community/profile') return json({ files: { license: { path: 'LICENSE' } } })
    if (sourcePath === '/repos/example/project/readme') return { ok: true, status: 200, text: async () => readme }
    if (sourcePath === '/repos/example/project/contents') {
      if (ref && !headContents) return json({ message: 'Not Found' }, headStatus)
      if (ref && truncateRoot) return json(Array.from({ length: 1000 }, (_, i) => ({ name: `file-${i}`, type: 'file' })))
      return json([{ name: 'package.json', type: 'file' }, { name: 'README.md', type: 'file' }, ...(ref ? [{ name: 'LICENSE.md', type: 'file' }] : []), ...(issueEntries ? [{ name: '.github', type: 'dir' }] : [])])
    }
    if (sourcePath === '/repos/example/project/contents/package.json') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ name: pkgName, ...(hasBin ? { bin: { project: './bin/x.js' } } : {}) }) }
    }
    if (sourcePath === '/repos/example/project/contents/LICENSE') return json({ name: 'LICENSE' }, ref ? 200 : 404)
    if (sourcePath === '/repos/example/project/contents/CONTRIBUTING.md') return json({ message: 'Not Found' }, 404)
    if (sourcePath === '/repos/example/project/contents/.github' && issueEntries) return json([{ name: 'ISSUE_TEMPLATE', type: 'dir' }])
    if (sourcePath === '/repos/example/project/contents/.github/ISSUE_TEMPLATE') return json(issueEntries || [{ name: 'bug.md', type: 'file' }])
    if (sourcePath === '/repos/example/project/releases') return json([])
    if (sourcePath === '/repos/example/project/tags') return json([])
    if (sourcePath === '/repos/example/project/actions/runs') return json({ workflow_runs: [] })
    if (sourcePath === '/repos/example/project/issues') return json([])
    if (sourcePath === '/repos/example/project/traffic/views') return json({ count: 0, uniques: 0 })
    return json({ message: 'Not Found' }, 404)
  }
  return { calls, restore: () => { globalThis.fetch = originalFetch } }
}

test('PR 报告把仓库文件读取固定到该提交', async () => {
  const f = fixture()
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
    expect(report.error).toBeUndefined()
    expect(report.score).not.toBeNull()
    const reads = f.calls.filter(c => c.path.startsWith('/repos/example/project/contents') || c.path.endsWith('/readme'))
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read.ref).toBe(SHA)
    expect(report.source).toEqual({ repository: 'example/project', sha: SHA, files: 'commit', metadata: 'live base repository' })
    expect(f.calls.every(c => c.hostname === 'api.github.com')).toBe(true)
    expect(f.calls.some(c => c.path.endsWith('/traffic/views'))).toBe(false)
    expect(report.dims.flatMap(d => d.manual || []).join(' ')).toContain('不向第三方 registry')
  } finally { f.restore() }
})

test('fork PR 文件读取使用 fork 和不可变提交，元数据仍来自基础仓库', async () => {
  const f = fixture({ sourceRepo: 'contributor/project' })
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'contributor/project', sha: SHA } })
    expect(report.score).not.toBeNull()
    expect(f.calls.some(c => c.path === '/repos/example/project' && c.ref === null)).toBe(true)
    expect(f.calls.some(c => c.path === '/repos/contributor/project/contents' && c.ref === SHA)).toBe(true)
    expect(f.calls.some(c => c.path === '/repos/contributor/project/readme' && c.ref === SHA)).toBe(true)
  } finally { f.restore() }
})

test('默认分支报告不携带提交来源，且不追加 ref', async () => {
  const f = fixture()
  try {
    const report = await auditProject({ owner: 'example', repo: 'project' })
    expect(report.source).toBeUndefined()
    const reads = f.calls.filter(c => c.path.startsWith('/repos/example/project/contents') || c.path.endsWith('/readme'))
    for (const read of reads) expect(read.ref).toBeNull()
  } finally { f.restore() }
})

test('PR 提交不可读时不得产生分数', async () => {
  const f = fixture({ headContents: false, headStatus: 404 })
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
    expect(report.score).toBeNull()
    expect(report.errorStatus).toBe(404)
    expect(report.error).toContain('404')
  } finally { f.restore() }
})

test('达到 GitHub 目录返回上限时不把未返回文件判为缺失', async () => {
  const f = fixture({ truncateRoot: true })
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
    expect(report.score).toBeNull()
    expect(report.error).toContain('possibly truncated')
  } finally { f.restore() }
})

test('单个 PR 文件读取遇到限流或服务故障时中止评分', async () => {
  for (const [failPath, status] of [['/readme', 403], ['/contents/package.json', 429], ['/contents/.github/copilot-instructions.md', 503]]) {
    const f = fixture({ failPath, failStatus: status })
    try {
      await expect(auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })).rejects.toThrow(/PR head/)
    } finally { f.restore() }
  }
})

test('实时仓库元数据读取失败不会伪装成没有 tag、CI 或 issue', async () => {
  for (const [failPath, failStatus] of [['/tags', 403], ['/releases', 429], ['/actions/runs', 503], ['/issues', 403]]) {
    const f = fixture({ failPath, failStatus })
    try {
      await expect(auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })).rejects.toThrow(/metadata unavailable/)
    } finally { f.restore() }
  }
})

test('来源必须是完整提交 SHA 与合法仓库名', async () => {
  const f = fixture()
  try {
    await expect(auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: 'abc' } })).rejects.toThrow(/40-character/)
    await expect(auditProject({ owner: 'example', repo: 'project', source: { repository: 'not a repo', sha: SHA } })).rejects.toThrow(/owner\/repository/)
  } finally { f.restore() }
})

test('带开发依赖标志的 npm 系命令与一分钟接入章节可被识别', async () => {
  for (const command of ['pnpm add -D vite-plugin-agent-eyes', 'npm install --save-dev pkg', 'yarn add --dev pkg', 'bun add -D pkg']) {
    const f = fixture({ readme: `## 一分钟接入\n\n\`\`\`sh\n${command}\n\`\`\`` })
    try {
      const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
      const distribution = report.dims.find(d => d.key === 'distribution')
      const docs = report.dims.find(d => d.key === 'docs')
      expect(distribution.evidence.join(' ')).toContain('npm 系安装命令')
      expect(docs.gaps.join(' ')).not.toContain('没有安装章节')
      expect(docs.gaps.join(' ')).not.toContain('没有快速开始')
    } finally { f.restore() }
  }
})

test('README 中 API 参考链接计为文档证据但保留访问人工核验', async () => {
  const f = fixture({ readme: '## 一分钟接入\n```sh\npnpm add -D vite-plugin-agent-eyes\n```\n[完整 API](https://example.com/api/reference)' })
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
    const docs = report.dims.find(d => d.key === 'docs')
    expect(docs.evidence.join(' ')).toContain('链接到 API/配置参考')
    expect(docs.gaps.join(' ')).not.toContain('没有 API/配置参考')
    expect(docs.manual.join(' ')).toContain('链接可访问')
  } finally { f.restore() }
})

test('普通 rapid 指南链接不会被误认作 API 文档', async () => {
  const f = fixture({ readme: '## Rapid guide\n[Rapid guide](https://example.com/guide)' })
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
    const evidence = report.dims.find(d => d.key === 'docs').evidence.join(' ')
    expect(evidence).not.toContain('链接到 API/配置参考')
    expect(evidence).not.toContain('有 API/配置章节')
  } finally { f.restore() }
})

test('卸载章节不会被误认为安装章节', async () => {
  const f = fixture({ readme: '## Uninstall\nRemove the package.' })
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
    expect(report.dims.find(d => d.key === 'docs').evidence.join(' ')).not.toContain('有安装章节')
  } finally { f.restore() }
})

test('没有包名的安装命令不会被识别为完整安装路径', async () => {
  const f = fixture({ readme: '## 一分钟接入\n\npnpm add -D\r\nThis installs the plugin.' })
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
    expect(report.dims.find(d => d.key === 'distribution').gaps.join(' ')).toContain('找不到')
  } finally { f.restore() }
})

test('同一代码块中的目标仓库克隆和依赖安装可作为安装说明', async () => {
  const f = fixture({ readme: '## 快速开始\n```bash\ngit clone https://github.com/example/project.git\ncd project\nbun install          # 或 npm install\nbun run build\n```' })
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
    const distribution = report.dims.find(d => d.key === 'distribution')
    expect(distribution.evidence.join(' ')).toContain('克隆目标仓库并安装依赖')
    expect(distribution.manual.join(' ')).toContain('实际执行')
    expect(distribution.gaps.join(' ')).not.toContain('找不到一条')
  } finally { f.restore() }
})

test('其他仓库或缺少进入目录的片段不算目标仓库安装路径', async () => {
  for (const readme of [
    '```sh\ngit clone https://github.com/other/project.git\ncd project\nbun install\n```',
    '```sh\ngit clone https://github.com/example/project.git\nbun install\n```',
    '```sh\ngit clone https://github.com/example/project.git\ncd project\n```\n```sh\nbun install\n```',
    '```sh\ngit clone https://github.com/example/project.git\ncd project\ncd ../other\nbun install\n```',
    '```sh\ngit clone https://github.com/example/project.git.evil.test\ncd project\nbun install\n```',
  ]) {
    const f = fixture({ readme })
    try {
      const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
      expect(report.dims.find(d => d.key === 'distribution').evidence.join(' ')).not.toContain('克隆目标仓库')
    } finally { f.restore() }
  }
})

test('DSH 界面安装说明不被误判为缺少命令，首次操作保留人工核验', async () => {
  const f = fixture({ readme: '### 安装\n在 DeepSeek Harness 的「插件」里搜索 **`example`** 并安装；按提示重启后，点顶栏的按钮。' })
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
    const distribution = report.dims.find(d => d.key === 'distribution')
    const docs = report.dims.find(d => d.key === 'docs')
    expect(distribution.evidence.join(' ')).toContain('界面搜索和安装')
    expect(distribution.gaps.join(' ')).not.toContain('找不到一条')
    expect(docs.gaps.join(' ')).not.toContain('没有快速开始')
    expect(docs.manual.join(' ')).toContain('人工核实')
  } finally { f.restore() }
})

test('主题没有 API 章节时保留人工核验，不按库的要求扣分', async () => {
  const f = fixture({ pkgName: 'example-theme', hasBin: false, readme: '### 安装\n在 DeepSeek Harness 的插件中搜索 example 并安装。' })
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
    const docs = report.dims.find(d => d.key === 'docs')
    expect(report.type).toBe('theme')
    expect(docs.gaps.join(' ')).not.toContain('没有 API/配置参考')
    expect(docs.manual.join(' ')).toContain('主题的图形配置')
  } finally { f.restore() }
})

test('带可执行命令的主题包仍按 CLI 分类，避免错误应用主题豁免', async () => {
  const f = fixture({ pkgName: 'example-theme', hasBin: true })
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
    expect(report.type).toBe('cli')
  } finally { f.restore() }
})

test('只有 issue 模板目录配置文件时不误报存在模板', async () => {
  const f = fixture({ issueEntries: [{ name: 'config.yml', type: 'file' }] })
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
    const community = report.dims.find(d => d.key === 'community')
    expect(community.gaps.join(' ')).toContain('没有 issue 模板')
    expect(community.evidence.join(' ')).not.toContain('有 issue 模板')
  } finally { f.restore() }
})

test('真实 issue 模板按 head 提交识别', async () => {
  const f = fixture({ issueEntries: [{ name: 'config.yml', type: 'file' }, { name: 'bug.yml', type: 'file' }] })
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: SHA } })
    const community = report.dims.find(d => d.key === 'community')
    expect(community.evidence.join(' ')).toContain('有 issue 模板')
    expect(f.calls.some(c => c.path.endsWith('/contents/.github/ISSUE_TEMPLATE') && c.ref === SHA)).toBe(true)
  } finally { f.restore() }
})

test('PR 报告的 LICENSE 判定读提交，不读默认分支', async () => {
  const f = fixture()
  try {
    const report = await auditProject({ owner: 'example', repo: 'project', source: { repository: 'example/project', sha: OTHER_SHA } })
    const community = report.dims.find(d => d.key === 'community')
    expect(community.evidence.join(' ')).toContain('LICENSE')
    expect(f.calls.some(c => c.path === '/repos/example/project/contents' && c.ref === OTHER_SHA)).toBe(true)
  } finally { f.restore() }
})
