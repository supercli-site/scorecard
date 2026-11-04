<script setup>
/**
 * 发布打法 —— 统一入口卡片。
 *
 * 「统一入口」的含义：报告内嵌引导、顶栏链接、Markdown 报告，指向的都是
 * #/playbook 这一个地址。后期转付费时只改 PlaybookPage 的 gate，
 * 引导卡的文案在 props 里已经预留了位置。
 *
 * hot = 分发维度有 gap：引导卡升级成「现在就该看」的强调态。
 */
defineProps({
  hot: { type: Boolean, default: false },
})
const ENTRY = '#/playbook'
</script>

<template>
  <aside class="pb-entry" :class="{ hot }">
    <div class="pb-entry__text">
      <p class="pb-entry__kicker">
        <span class="pb-entry__tag">PRO</span>
        高阶指导 · 发布打法
        <span class="pb-entry__price">限时免费</span>
      </p>
      <p class="pb-entry__title">同一份物料，所有渠道复用：README 首屏 → 小圈子 → Show HN / Product Hunt → awesome-list → 矩阵分发。</p>
      <p v-if="hot" class="pb-entry__hot">你的分发维度还有未清的整改项 —— 下面的打法按 30 天节奏带你逐条清零。</p>
    </div>
    <a class="pb-entry__cta" :href="ENTRY">查看完整打法 →</a>
  </aside>
</template>

<style scoped>
.pb-entry {
  display: flex;
  gap: 18px;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px;
  margin: 18px 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elev);
}
.pb-entry.hot {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}
.pb-entry__kicker {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--text-muted);
}
.pb-entry__tag {
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--accent);
  color: #0d1117;
  font-weight: 700;
  font-size: 10px;
  letter-spacing: 0.18em;
}
.pb-entry__price {
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 10px;
  color: var(--text-muted);
}
.pb-entry__title {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
}
.pb-entry__hot {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--accent);
}
.pb-entry__cta {
  flex-shrink: 0;
  padding: 10px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elev-2);
  color: var(--text);
  font-size: 13px;
  white-space: nowrap;
  transition: border-color 0.15s, color 0.15s;
}
.pb-entry__cta:hover {
  border-color: var(--accent);
  color: var(--accent);
}
@media (max-width: 700px) {
  .pb-entry { flex-direction: column; align-items: stretch; gap: 12px; }
  .pb-entry__cta { text-align: center; }
}
</style>
