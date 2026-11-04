<script setup>
/**
 * #/playbook —— 发布打法的完整阅读页，站内唯一入口的落点。
 *
 * 内容唯一真源是 docs/launch-playbook.md（?raw 引入，渲染规则见 playbook.js）。
 * 后期转付费：把本组件的 `ACCESS` 换成 gate 逻辑（登录/购买态），
 * 引导卡与 Markdown 报告不用动 —— 它们只指向 #/playbook 这个地址。
 */
import { playbookHtml } from '../config/playbook.js'
const ACCESS = 'free' // 'free' | 'paid' —— 转付费时在这里接 gate
</script>

<template>
  <div class="pb-page">
    <header class="pb-head">
      <p class="pb-head__kicker">
        <span class="pb-head__tag">PRO</span>
        高阶指导 · 发布打法
        <span class="pb-head__price">{{ ACCESS === 'free' ? '限时免费' : 'Pro 专享' }}</span>
      </p>
      <h1>同一份物料，所有渠道复用</h1>
      <p class="pb-head__sub">
        配套引擎判据：「分发」维度自动核实物料齐不齐，本文管节奏与渠道。
        质检报告里每条分发整改项，都能在这里找到对应的做法。
      </p>
    </header>

    <!-- 内容由仓库内静态文档渲染而来，无外部输入 -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <article class="pb-body" v-html="playbookHtml" />

    <footer class="pb-foot">
      <p>
        判据同源：引擎在
        <a href="https://github.com/webkubor/scorecard/blob/main/server/audit.js" target="_blank" rel="noopener">server/audit.js</a>
        · 文档在
        <a href="https://github.com/webkubor/scorecard/blob/main/docs/launch-playbook.md" target="_blank" rel="noopener">docs/launch-playbook.md</a>
      </p>
      <a class="pb-foot__back" href="#/">← 回去跑一次质检</a>
    </footer>
  </div>
</template>

<style scoped>
.pb-page {
  max-width: 760px;
  margin: 0 auto;
  padding: 34px 20px 60px;
}
.pb-head__kicker {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 14px;
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--text-muted);
}
.pb-head__tag {
  padding: 3px 9px;
  border-radius: 4px;
  background: var(--accent);
  color: #0d1117;
  font-weight: 700;
  font-size: 10px;
  letter-spacing: 0.2em;
}
.pb-head__price {
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 10px;
}
.pb-head h1 {
  margin: 0 0 12px;
  font-size: clamp(24px, 3vw, 34px);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text);
}
.pb-head__sub {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--text-muted);
}
.pb-body {
  margin-top: 26px;
  border-top: 1px solid var(--border-soft);
  padding-top: 8px;
  font-size: 13.5px;
  line-height: 1.85;
  color: var(--text);
}
.pb-body :deep(h2) {
  margin: 34px 0 12px;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}
.pb-body :deep(h3) {
  margin: 26px 0 10px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.pb-body :deep(p) { margin: 10px 0; }
.pb-body :deep(ul),
.pb-body :deep(ol) { margin: 10px 0; padding-left: 22px; }
.pb-body :deep(li) { margin: 5px 0; }
.pb-body :deep(blockquote) {
  margin: 14px 0;
  padding: 10px 16px;
  border-left: 2px solid var(--accent);
  background: var(--bg-elev);
  border-radius: 0 8px 8px 0;
  color: var(--text-muted);
  font-size: 12.5px;
}
.pb-body :deep(blockquote p) { margin: 4px 0; }
.pb-body :deep(code) {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-elev-2);
  font-size: 12px;
  color: var(--accent);
}
.pb-body :deep(a) { color: var(--accent); border-bottom: 1px solid transparent; }
.pb-body :deep(a:hover) { border-bottom-color: var(--accent); }
.pb-body :deep(hr) { margin: 26px 0; border: 0; border-top: 1px solid var(--border-soft); }
.pb-body :deep(table) {
  width: 100%;
  margin: 14px 0;
  border-collapse: collapse;
  font-size: 12.5px;
}
.pb-body :deep(th),
.pb-body :deep(td) {
  padding: 8px 12px;
  border: 1px solid var(--border-soft);
  text-align: left;
  vertical-align: top;
}
.pb-body :deep(th) { background: var(--bg-elev); color: var(--text); font-weight: 600; }
.pb-body :deep(strong) { color: var(--text); }
.pb-foot {
  margin-top: 46px;
  padding-top: 18px;
  border-top: 1px solid var(--border-soft);
  display: flex;
  gap: 14px;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-muted);
}
.pb-foot a { color: var(--text-muted); }
.pb-foot a:hover { color: var(--accent); }
.pb-foot__back { white-space: nowrap; }
</style>
