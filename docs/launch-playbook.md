# 发布打法（Launch Playbook）

> 配套引擎判据：`server/audit.js` 的「分发」维度。引擎管**客观可核实**的部分
> （安装命令、demo 物料、badges、registry、release 产物），本文管**节奏与渠道**
> —— 两边合起来才是完整的 launch。
>
> 原则只有一条：**物料做一次，所有渠道复用。** 不是每个渠道各做一套内容。

## 一、物料（先做齐，再谈渠道）

| 物料 | 标准 | 判据在引擎里吗 |
|---|---|---|
| README 首屏 | 3 秒讲清是什么 + 一行可复制的安装命令 + badges | ✅ 安装命令/badges 自动判 |
| demo 动图/视频 | 15-45 秒，README / 社媒 / 落地页三处复用；终端项目 `vhs` 一键录，GUI 用 Screen Studio | ✅ 自动判 |
| social preview | 1280×640，仓库 Settings → Social preview；转发到任何社交平台都是这张图 | ⚠️ API 读不到，人工核对 |
| 落地页/官网 | 一个能点开试用的 URL（哪怕是 demo 站） | ✅ homepage 自动判 |
| 英文 README | 面向 HN/PH；中文项目至少首屏双语 | ⚠️ 人工 |

## 二、节奏（30 天）

**第 1 周：物料 + 小圈子**
- 按上表补齐物料，跑一遍 scorecard 把「分发」维度的 gap 清零
- 找 5-10 个真实用户试用，修掉首批 issue（别带着已知 bug 冷启动）

**第 2 周：开发者渠道首发**
- **Show HN**：开发者工具首选。标题只写「做了什么 + 为谁」，
  正文准备一段"为什么造这个轮子"——HN 一定会问
- **V2EX 分享创造** / **掘金**：中文首发；掘金要干货密度，别写成公告
- 发布日集中引 star：Trending 看的是**增速**不是绝对数，发布周集中所有渠道

**第 3 周：泛渠道**
- **Product Hunt**：偏消费级、看重落地页完成度——落地页没做好就别上
- dev.to / Hashnode 英文交叉发布，**canonical 指回自己的博客**（SEO 归自己）
- 提 PR 进相关 **awesome-list**：单条链接长期带量，杠杆最高

**第 4 周：矩阵分发 + 度量**
- 短视频：录屏 → 剪映/Screen Studio → **socialhub**（自有矩阵分发）或
  [social-auto-upload](https://github.com/dreammis/social-auto-upload)
  一键投抖音/小红书/视频号/B站
- 度量：[star-history](https://star-history.com) 曲线（下一轮发布帖的素材）、
  [ossinsight](https://ossinsight.io)（来源分析）、`gh api repos/<r>/traffic/popular/referrers`（需 push 权限）

## 三、平台口吻（同一事实，不同表达）

| 平台 | 心智 | 写法 |
|---|---|---|
| Show HN | 厌恶营销腔 | 第一行直给做了什么；准备回答"为什么不用 X" |
| Product Hunt | 看图说话 | 落地页 + demo 视频是主角，文案短 |
| V2EX 分享创造 | 同侧交流 | 说踩坑过程，别写成发布公告 |
| 掘金 | 干货密度 | 技术实现 > 产品介绍 |
| 小红书/视频号 | 3 秒钩子 | 前 3 秒给结果画面，再讲怎么做 |

## 四、自己的项目映射（2026-11）

| 项目 | 首选渠道 | 已有素材 |
|---|---|---|
| **kyvault** | Show HN / V2EX | crates.io + Homebrew + GitHub Release 三渠道已就绪；"AI agent 明文不出本机"是 HN 有受众的故事 |
| **context-slim** | 等 magpie-community 合并后 launch | 163k→42k prompt tokens 实测数据（PR #467）；合并当天发，借 maintainer 曝光 |
| **dsh-bloom-theme** | DeepSeek 社区/Discord | 生态插件，精准渠道优于泛渠道 |

## 五、红线

- 不买 star、不互刷——Trending 与 OSSInsight 都能识别异常增速，被标记后永久降权
- awesome-list PR 先读 contributing，格式不对直接关
- Show HN 一年别超过两次自推，账号有历史权重
