// 分档只描述对应引擎已核实规则的得分区间，不推断逐项事实、排名或用途。
export const SCORE_HINT = '按已核实的规则计算；未核实项不计入评分。'
export const SCORE_LABELS = ['规则评分较高', '规则评分中等', '规则评分偏低', '规则评分较低']
export const GEO_SCORE_LABELS = ['规则得分较高', '规则得分中等', '规则得分偏低', '规则得分较低']

const LEGACY_LABELS = {
  github: ['同品类头部', '工程健康但分发薄弱', '能用但门面/发布有欠账', '个人练习仓库'],
  npm: ['同品类头部', '可放心使用', '能用但有欠账', '谨慎使用'],
  page: ['AI 与人类都友好', '可访问、需补 AI 端', '能打开但欠账多', '站点对 AI 不友好'],
  profile: ['简历级个人主页', '有模有样、可视化可补', '资料不全的草稿', '还是一块白板'],
  geo: ['AI 里有存在感', '偶尔出现，位置不稳', '几乎不被提及', 'AI 里查不到你'],
}

// 只在展示时精确映射旧标签；不修改其他引擎或持久化记录。
export function displayBand(type, band) {
  const labels = LEGACY_LABELS[type]
  const i = labels?.indexOf(band) ?? -1
  return i >= 0 ? (type === 'geo' ? GEO_SCORE_LABELS[i] : SCORE_LABELS[i]) : band
}
