import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { SCORE_LABELS, GEO_SCORE_LABELS, SCORE_HINT, displayBand } from '../server/score-labels.js'
import { auditGeo } from '../server/audit-geo.js'

const root = new URL('..', import.meta.url).pathname

test('分档文案只描述规则得分，不暗示排名、安全性或逐项成立', () => {
  for (const label of [...SCORE_LABELS, ...GEO_SCORE_LABELS]) {
    expect(label).not.toMatch(/头部|放心使用|健康|练习|谨慎|友好|查不到|存在感|白板|草稿|简历级/)
  }
  expect(SCORE_HINT).toContain('未核实项不计入评分')
})

test('五引擎旧标签按 targetType 精确映射，未知标签与其它引擎原样返回', () => {
  expect(displayBand('github', '同品类头部')).toBe(SCORE_LABELS[0])
  expect(displayBand('github', '工程健康但分发薄弱')).toBe(SCORE_LABELS[1])
  expect(displayBand('github', '能用但门面/发布有欠账')).toBe(SCORE_LABELS[2])
  expect(displayBand('github', '个人练习仓库')).toBe(SCORE_LABELS[3])
  expect(displayBand('npm', '可放心使用')).toBe(SCORE_LABELS[1])
  expect(displayBand('npm', '能用但有欠账')).toBe(SCORE_LABELS[2])
  expect(displayBand('npm', '谨慎使用')).toBe(SCORE_LABELS[3])
  expect(displayBand('page', 'AI 与人类都友好')).toBe(SCORE_LABELS[0])
  expect(displayBand('page', '可访问、需补 AI 端')).toBe(SCORE_LABELS[1])
  expect(displayBand('page', '能打开但欠账多')).toBe(SCORE_LABELS[2])
  expect(displayBand('page', '站点对 AI 不友好')).toBe(SCORE_LABELS[3])
  expect(displayBand('profile', '简历级个人主页')).toBe(SCORE_LABELS[0])
  expect(displayBand('profile', '有模有样、可视化可补')).toBe(SCORE_LABELS[1])
  expect(displayBand('profile', '资料不全的草稿')).toBe(SCORE_LABELS[2])
  expect(displayBand('profile', '还是一块白板')).toBe(SCORE_LABELS[3])
  expect(displayBand('geo', 'AI 里有存在感')).toBe(GEO_SCORE_LABELS[0])
  expect(displayBand('geo', '偶尔出现，位置不稳')).toBe(GEO_SCORE_LABELS[1])
  expect(displayBand('geo', '几乎不被提及')).toBe(GEO_SCORE_LABELS[2])
  expect(displayBand('geo', 'AI 里查不到你')).toBe(GEO_SCORE_LABELS[3])
  // 类型隔离：同名字符串不得跨引擎套用
  expect(displayBand('npm', 'AI 与人类都友好')).toBe('AI 与人类都友好')
  expect(displayBand('github', '简历级个人主页')).toBe('简历级个人主页')
  expect(displayBand('geo', '同品类头部')).toBe('同品类头部')
  expect(displayBand('github', '同品类头部项目')).toBe('同品类头部项目')
  expect(displayBand('github', null)).toBeNull()
})

test('对外文案不做绝对保证，且两份 llms 同源', () => {
  for (const file of ['README.md', 'llms.txt', 'public/llms.txt']) {
    const text = readFileSync(root + file, 'utf8')
    expect(text).not.toMatch(/不会高于|绝不会高于|互补，不重叠/)
    expect(text).toContain('互不替代')
  }
  expect(readFileSync(root + 'llms.txt', 'utf8')).toBe(readFileSync(root + 'public/llms.txt', 'utf8'))
})

test('GEO 201 问中仅一次提及时总分可能为 0，但文案保持中性', async () => {
  const questions = Array.from({ length: 201 }, (_, i) => `问题 ${i + 1}？`)
  const adapter = {
    async ask(_env, question) {
      return question === questions[0]
        ? { text: '提到过一次测试品牌。', citations: [], inlineUrls: [] }
        : { text: '完全无关的回答。', citations: [], inlineUrls: [] }
    },
  }
  const report = await auditGeo({ brand: '测试品牌', questions, competitors: ['其他品牌'], adapter })
  expect(report.score).toBe(0)
  expect(report.band).toBe(GEO_SCORE_LABELS[3])
  expect(report.bandHint).toBe(SCORE_HINT)
  expect(report.bandHint).not.toMatch(/所有问题都没有出现|查不到你/)
})
