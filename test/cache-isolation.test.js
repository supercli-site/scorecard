import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { SCORE_LABELS, GEO_SCORE_LABELS } from '../server/score-labels.js'

const dir = mkdtempSync(join(tmpdir(), 'scorecard-cache-isolation-'))
let app
let db
let insert

beforeAll(async () => {
  const previous = process.env.SCORECARD_DATA_DIR
  process.env.SCORECARD_DATA_DIR = dir
  try { ({ app } = await import('../server/index.js?cache-isolation-test')) }
  finally {
    if (previous === undefined) delete process.env.SCORECARD_DATA_DIR
    else process.env.SCORECARD_DATA_DIR = previous
  }
  db = new Database(join(dir, 'scorecard.sqlite'))
  insert = db.query(
    'INSERT INTO audits (projectId,targetType,ts,score,band,type,stars,dims,todos,meta) VALUES (?,?,?,?,?,?,?,?,?,?)'
  )
})

afterAll(() => { db.close() })

test('同一 projectId 的不同 targetType 各自映射自己的旧标签', async () => {
  const ts = new Date().toISOString()
  insert.run('same/key', 'github', ts, 9.2, '同品类头部', 'cli', 1, '[]', '[]', '{}')
  const newest = new Date(Date.now() + 1000).toISOString()
  insert.run('same/key', 'npm', newest, 9.2, '可放心使用', 'npm', 1, '[]', '[]', '{}')
  insert.run('same/key', 'page', ts, 9.2, 'AI 与人类都友好', 'page', 1, '[]', '[]', '{}')
  insert.run('same/key', 'profile', ts, 9.2, '简历级个人主页', 'profile', 1, '[]', '[]', '{}')
  insert.run('same/key', 'geo', ts, 9.2, 'AI 里有存在感', 'geo', 1, '[]', '[]', '{}')
  insert.run('owner/repo', 'github', ts, 9.2, '同品类头部', 'cli', 1, '[]', '[]', '{}')
  // 老数据：targetType 为 NULL，迁移前的行
  insert.run('null/type', null, ts, 9.2, '同品类头部', 'cli', 1, '[]', '[]', '{}')

  const board = await (await app.request('/api/scorecard/leaderboard')).json()
  const row = (id) => board.items.find((x) => x.projectId === id)
  // 排行榜按最新一行取值，同一 projectId 出现多类型时只保留一条，其余类型在各自历史里
  // 最新行来自 npm，即使同名 GitHub 有别的标签也不得套用 GitHub 映射。
  expect(row('same/key').band).toBe(SCORE_LABELS[1])
  const nullRow = row('null/type')
  expect(nullRow.band).toBe(SCORE_LABELS[0])
  expect(nullRow.band).not.toBe('同品类头部')

  const githubHistory = await (await app.request('/api/scorecard/history?type=github&target=same%2Fkey')).json()
  const npmHistory = await (await app.request('/api/scorecard/history?type=npm&target=same%2Fkey')).json()
  const pageHistory = await (await app.request('/api/scorecard/history?type=page&target=same%2Fkey')).json()
  const profileHistory = await (await app.request('/api/scorecard/history?type=profile&target=same%2Fkey')).json()
  const geoHistory = await (await app.request('/api/scorecard/history?type=geo&target=same%2Fkey')).json()
  expect(githubHistory.points[0].band).toBe(SCORE_LABELS[0])
  expect(npmHistory.points[0].band).toBe(SCORE_LABELS[1])
  expect(pageHistory.points[0].band).toBe(SCORE_LABELS[0])
  expect(profileHistory.points[0].band).toBe(SCORE_LABELS[0])
  expect(geoHistory.points[0].band).toBe(GEO_SCORE_LABELS[0])

  // 历史查询不得串类型：github 维度不带 npm 的标签
  expect(githubHistory.points.map((p) => p.band)).not.toContain('可放心使用')
  expect(npmHistory.points.map((p) => p.band)).not.toContain('同品类头部')
})

test('缓存报告按请求类型映射，不被其它类型的历史覆盖', async () => {
  const res = await app.request('/api/scorecard?repo=owner%2Frepo')
  const json = await res.json()
  expect(json.cached).toBe(true)
  expect(json.report.band).toBe(SCORE_LABELS[0])
  expect(json.report.bandHint).toContain('未核实项不计入评分')})

test('GitHub 分享图不会拿同名 npm 记录冒充，也不会把未知显示为零分', async () => {
  insert.run('only/npm', 'npm', new Date().toISOString(), 8.7, '可放心使用', 'npm', 12, '[]', '[]', '{}')
  const response = await app.request('/og/scorecard/only/npm?fmt=svg')
  expect(response.status).toBe(200)
  const svg = await response.text()
  expect(svg).toContain('暂无评分')
  expect(svg).toContain('尚未生成 GitHub 质检报告')
  expect(svg).not.toContain('8.7')
  expect(svg).not.toContain('0<tspan')
})

test('数据库里的旧标签保持原样，不做数据迁移', () => {
  const rows = db.query('SELECT projectId,targetType,band FROM audits WHERE projectId = ?').all('same/key')
  expect(Object.fromEntries(rows.map((r) => [r.targetType, r.band]))).toEqual({
    github: '同品类头部', npm: '可放心使用', page: 'AI 与人类都友好', profile: '简历级个人主页', geo: 'AI 里有存在感',
  })
  const nullRow = db.query('SELECT band FROM audits WHERE projectId = ?').get('null/type')
  expect(nullRow.band).toBe('同品类头部')
})
