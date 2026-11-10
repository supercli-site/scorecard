---
name: project-maturity-audit
description: 项目成熟度体检 — 按项目类型从门面、分发、发布工程、质量护栏、社区卫生、文档、安全、度量、AI 可读性九个维度做证据化评估，并可补充 GEO 搜索及 AI 可见性基线与复测。触发：项目体检、成熟度评估、开源检查、README 标准、GEO、搜索可见性、收录核查。可传仓库路径或 GitHub 仓库名；不传则审查当前目录。
type: procedure
category: coding
platform: shared
version: 1.0.0
---

# 项目成熟度体检 (Project Maturity Audit)

这是开源项目包装、README、发布、社区收录与推广的统一质检入口，按九维度和项目类型分别核验。先理解项目给谁用、希望达成什么，再判断内容是否有说服力，不能把走完命令或填满模板当作交付结果。**每一条结论必须有可追溯证据；未核实记为 manual/unverifiable。** 用户已明确授权实施时直接处理授权范围内的修改；只有缺少必要信息或授权时才询问。对外发帖、评论和通知须有用户明确指令。

## 统一入口与兼容

本技能覆盖开源项目的 README、品牌、媒体、分发、社区、发布、度量与交付验收。发布与推广是九维体检后的具体应用，不新造另一套评分维度或另一个互相冲突的 skill。可选的本机工具和规则只作为补充：若环境提供 CS，可按需读取 `cs rule open_source_project_baseline`、`cs rule release-notes-standard` 和 `cs rule release-semantics`；其他环境按本技能及项目现有约定执行，不依赖私有 CLI、地址或凭据。

## 评估流程

### 0. 确定对象与类型

- 对象：参数指定的路径 / GitHub 仓库；缺省用当前目录。
- **自动识别项目类型**（检查优先级：package.json > pyproject.toml > Cargo.toml > 单一 SKILL.md > README 中的关键词）：

| 类型 | 识别特征 | 示例 |
|------|---------|------|
| **skill/agent-skill** | 根目录有 SKILL.md 或 `skills/` 目录 | agent-skills, kyvault |
| **前端应用** | package.json + vue/react/svelte 依赖，有 build 脚本 | wechat-chat-gen, html-preview |
| **CLI/本地工具** | package.json bin 字段 或 setup.py console_scripts | kyvault CLI, voice-editor |
| **库/SDK** | package.json 无 bin，有 exports/main 字段 | vite-plugin-agent-eyes |
| **后端服务** | Dockerfile / docker-compose / 服务端框架（express/fastapi/gin） | — |
| **纯文档/教程** | 只有 markdown，无代码 | xiaobai-kanban |
| **主题/样式** | CSS/SCSS 为主，无 JS 逻辑 | typora-Bloom-theme |

- **对标**：`gh api "search/repositories?q=<品类关键词>&sort=stars"` 找同品类 star 前 3。

### 1. 九维度检查（并行收集证据）

#### ① 门面 First Impression（权重高——决定 10 秒去留）

**通用检查：**
- README：首屏 10 秒内能否明白“这是什么、给谁用、为什么值得用、如何开始”？精简重复内容，但保留经核实的差异化卖点、量化指标、必要文字与有效社区徽章；不要把信息全部删掉或堆砌图片。
- **真实媒体验收（人工项）**：每次 GitHub 版本发布，README 须有本版真实特色图与可在页面内直接播放的本版演示视频，除非用户明确指定例外；以匿名访客打开真实页面，实际看图、点击播放并验证进度，双语 README 若均提供演示则两份都检查。截图、视频与版本的关系必须准确标注；HTTP 200、文件存在、静态封面或 GIF 不能单独证明内嵌视频能播放。分别记录发布前候选和发布后页面 URL、版本或 commit、检查时间及结果。
- `gh api repos/<r> --jq '{description, topics, homepage}'`：description 有内容并同时说明用途与目标用户/场景；topics 建议 ≥6 个，且至少有一个 topic 与 description 的英文关键词可对应（单复数归一化）；description 未命中用途/对象词表、topics 无英文关键词对应时，各自 1 分标「无法核实」交人工判断，不能把词表盲区当语义不合格；不按特定行业硬编码必需 topic，也不凭 topic 名猜过期。门面计分：description 存在 +1、用途/用户语义覆盖 +1、topics ≥6 +1、topics 与 description 有可核实对应 +1；主页 +1，其余沿用引擎现有判据。
- 徽章：CI 状态、license、版本号——有没有、是不是活的。**数量 4–6 个为宜，每个必须传递真实可信度信号（版本/license/CI/下载量）；坏徽章（"not identifiable"、CI failing、404）比没有更伤门面，装饰性徽章（made-with-love 之类）一律不加。**

**Logo / Social Preview 检查（必须实际查文件，不只看 API）：**

⚠️ **Logo 和 Social Preview 是两个不同的东西，不能混为一谈。**

| 维度 | Logo | Social Preview |
|------|------|---------------|
| **用途** | 网站顶部小图标、npm icon、PyPI badge、GitHub 仓库小图标 | 分享链接到 Twitter/微信/飞书时显示的封面图 |
| **比例** | 1:1 正方形 | 2:1 横版（1280×640px） |
| **格式** | SVG（透明背景）> PNG | PNG/JPG |
| **位置** | README 顶部 `![logo](url)` | GitHub Settings → Social preview，或 README 首张横版图 |
| **背景** | 透明/半透明 | 可有背景色 |

**Logo 检查：**
1. 查仓库文件结构：`gh api repos/<r>/contents` 找 logo.* / icon.* / public/logo.* / assets/logo.*
2. 查 README 是否引用了图片：`gh api repos/<r>/readme --jq '.content' | base64 -d | grep -c '!\['`
3. 查 public/ 目录：favicon.ico、pwa-*.png、logo.svg
4. **SSoT 原则**：一个项目只能有一个官方 logo。多个 logo 文件 = 品牌混乱。
5. **1:1 比例**：logo 必须是正方形（1:1），SVG 透明背景优先。
6. **主题色一致**：logo 颜色必须与项目品牌色/主题色统一。

**Social Preview 检查：**
1. Social Preview 的正确设置方式是 **GitHub Settings → Social preview 直接上传 2:1 图（1280×640）**，与 README 排版解耦。GitHub 没有对应的写 API，需在网页端手动上传一次。
2. `curl -sL "https://github.com/<r>" | grep -o 'og:image.*content="[^"]*"'` 可以检查当前 Social Preview 是否已生效（默认值是 opengraph.githubassets.com 自动生成图 = 未设置）。
3. Social Preview 图应该包含：项目名 + 一句话定位 + 品牌色背景，横版构图。

**README 头部图片标准（只放一张品牌图，禁止 logo + banner 叠放）：**
1. 视觉型项目（主题/皮肤/UI 组件/出图类）：头部只放一张 2:1 横版 banner，banner 内已含品牌信息，不再单独放 logo。
2. 工具/库/CLI：头部放 1:1 透明底 logo + 标题即可，不强求 banner。
3. **反例教训**（typora-Bloom-theme）：README 顶部同时放小 logo 和 banner，logo 又是白底 PNG，深色模式下变成孤零零的白色方块，视觉打架。logo 的正确去处是 favicon、npm icon、官网头部，不是 README 里和 banner 抢位置。

**类型特有检查：**

| 类型 | 门面重点 |
|------|---------|
| **skill** | SKILL.md 格式规范、prompt 示例可复制、参考图（sample-output.*）存在且清晰 |
| **前端** | 首页有 Live demo 截图/GIF、浏览器兼容列表、移动端适配说明 |
| **CLI** | 安装命令一行跑通、帮助输出截图、跨平台（macOS/Linux/Windows）说明 |
| **库/SDK** | 30 秒 Quick Start 代码块、API 概览表、TypeScript 类型提示 |
| **后端** | API 文档链接、架构图、环境变量列表 |
| **纯文档** | 目录清晰、有学习路径、术语表 |
| **主题/皮肤** | 每套配色必须有真实渲染截图（截图墙/网格），纯文字的主题名列表没有说服力；截图直接引用仓库内文件，与官网共用一份资产 |

#### ② 分发 Distribution

- 是否发布到 registry（npm/PyPI/crates/…）？`npm view <pkg> version` / `pip index versions <pkg>`。清单文件常在子目录（`rust/Cargo.toml`、`python/pyproject.toml`），根目录没有不代表没发布。
- **发布物料**（一份物料三处复用：README / 社媒 / 落地页，节奏见 `docs/launch-playbook.md`）：
  - README 里的 demo 动图/视频 —— 终端项目用 vhs 录制，GUI 项目用 Screen Studio；README、社媒、落地页共用同一份。
  - README 头部 badges（license / 版本 / build）—— 让项目状态一眼可见；shields.io 三件套就够，徽章超过 6 个反而稀释可信度。
- 生态收录：逐个核对社区实际目录条目与上游 PR 的 `merged` 状态，保留准确链接。同一目录的多次更新不是多个社区；关闭不等于合并，上游主题收录也不等于下游插件被官方认证。只有实际搜索并覆盖目标目录后才能说“未查到”；权限或网络受限时标记 manual/unverifiable，说明未核实的范围。
- 推广：先准备符合用户语气与平台的文案及素材；向他人发帖、评论或发送消息必须有用户明确指令。用户要求自行发布时，仅交付稿件和素材，不代发。
- 流量来源：`gh api repos/<r>/traffic/popular/referrers`（需 push 权限）。

**类型特有分发：**

| 类型 | 核心渠道 |
|------|---------|
| **skill** | agent-skills 仓库收录、awesome-agent-skills、Agent 市场 |
| **前端** | Vercel/CF Pages demo、npm/Vue/React 生态 |
| **CLI** | npm/PyPI、Homebrew formula、AUR |
| **库/SDK** | npm/PyPI、官方文档站、包管理器搜索 |
| **后端** | Docker Hub、云市场（AWS/GCP/Azure） |

#### ③ 发布工程 Release Engineering

- **固定发布 SOP**：除非用户明确指定其他语言，面向用户的 Release 标题与主要正文使用中文；沿用既有版本说明结构，依次说明新增、体验优化、缺陷修复、兼容与迁移、安装与升级。英文自动提交列表不能替代面向读者的说明；未经证据不宣称“100% 兼容”或编造性能数据。
- **每个环节独立验收**：分别核对最新候选 head 的 CI 与评审、构建包、tag、GitHub Release、注册表精确版本与 latest、目标环境的实际安装；明确记录结果，不能把提交、合并、创建 Release 和包已发布混为一谈。
- **发布媒体**：每版 GitHub Release 正文公开时即须包含本版图片或可播放视频，除非用户明确指定例外；检查匿名访客能否访问。若只依赖发布后异步补图，要明确存在失败和无图窗口，不能当作发布时已满足。
- 版本化：tag 规范（semver）、CHANGELOG 持续更新；已发布产物不可变，不改写已发布包以掩盖差异。
- Release 资产完整性：`gh release view --json assets` 的 HTTP 状态只是可访问性线索；媒体展示还需真实页面验收。
- CI 管线状态：逐一核对实际 run、job 与必需检查；`skipped`、`neutral` 或 `cancelled` 不等于失败。无法判断时标记 manual/unverifiable，不用单个非决定性结果推断整仓 CI。
- 产物与源码同步：按项目的发布与打包契约检查；不要仅凭目录名判断 `dist/` 或 `build/` 是否应提交。

#### ④ 质量护栏 Quality Gates

- 测试存在且 CI 跑。
- lint/typecheck 有无、挂没挂 pre-commit/CI。
- 提交信息规范（conventional commits）。
- **类型特有**：

| 类型 | 质量门 |
|------|--------|
| **skill** | prompt 可复现（同一输入稳定输出）、示例图片清晰无水印 |
| **前端** | Lighthouse 分数、无障碍（a11y）检查、bundle 大小 |
| **CLI** | 卸载干净（无残留文件）、退出码规范、错误信息友好 |
| **库/SDK** | API 兼容性矩阵、breaking changes 策略 |

#### ⑤ 社区卫生 Community Hygiene

- LICENSE / CONTRIBUTING / issue 模板齐不齐。
- Open issue 年龄和响应：`gh issue list --state open --json createdAt,comments`——超 30 天无回应 = 口碑杀手。
- 最近 90 天有提交（活跃度信号）。

#### ⑥ 文档 Docs

- 安装/快速开始/API 参考/故障排查四件套。
- 链接全量体检：`curl -s -o /dev/null -w "%{http_code}"` 检查死链。
- agent 可读文档加分项：SKILL.md（AGENTS.md / llms.txt 归入 ⑨ AI 可读性单独打分，不在此重复计分）。

**类型特有文档：**

| 类型 | 必须有的文档 |
|------|------------|
| **skill** | SKILL.md（含触发词、示例、参数说明）、参考图 |
| **前端** | Demo 链接、截图、部署说明 |
| **CLI** | man page / --help 输出、shell completion、配置文件说明 |
| **库/SDK** | API Reference、Migration Guide、版本策略 |
| **后端** | API 文档（OpenAPI/Swagger）、部署指南、环境变量说明 |

#### ⑦ 安全 Security

- 上传展示素材前审查完整视频时间线、截图边缘、正文、工作区名、路径、账号、通知和凭据；使用受控的示例会话或可靠裁剪，局部抽帧、无音轨和文件名均不能证明整段安全。未经授权或未完成隐私审查，不得上传公开。
- 使用不回显秘密的凭据扫描器，报告规则、文件与行号等定位信息，不把疑似密钥正文打印到终端或日志。
- 依赖审计：`npm audit --omit=dev` / 等价物。
- SECURITY.md 有无。

#### ⑧ 度量 Metrics

- 使用数据：下载量、网站埋点、反馈渠道。引用下载量时记录来源、统计起止时间和单位；近 30 天不等于自然月，下载次数不等于用户人数。无数据或数据延迟时如实说明。

#### ⑨ AI 可读性 AI Readability

**AI 爬虫 / 编码助手能不能读懂这个项目。** 2025 年起 GitHub 原生支持 AGENTS.md，Copilot / Codex / Claude Code 进仓库第一件事就是读它；llmstxt.org 的 llms.txt 是给 LLM 的内容清单；官网 robots.txt 决定 GPTBot / ClaudeBot / PerplexityBot 等 AI 爬虫能不能引用站内内容。

- 仓库根目录有 `AGENTS.md` / `AGENT.md`（AI 协作规范，含构建命令、代码风格、禁止事项）。
- 仓库根目录有 `llms.txt` / `llms-full.txt`（LLM 内容清单，指向 README、文档、关键文件）。
- `.github/copilot-instructions.md`（Copilot 定制指令，提升 AI 补全与代码评审质量）。
- 官网 `robots.txt` 是否屏蔽主流 AI 爬虫：GPTBot / ClaudeBot / Claude-Web / PerplexityBot / Google-Extended / CCBot。`curl -s https://<site>/robots.txt` 检查 Disallow 段；无 robots.txt = 默认放行；有单列屏蔽 = 明确的反信号（可能是刻意选择，需在报告中说明）。
- 官网根目录有 `llms.txt`（`curl -s https://<site>/llms.txt`，内容非空）。

**主观补充（引擎判不了，skill 要读）：** AGENTS.md 写得是否真的有用（不是空模板）、README 首屏能否让 AI 与人都 10 秒看懂、官网内容是否服务端渲染可被爬虫抓取。

### 检索与 AI 可见性（GEO，独立补充，不改变九维评分）

本项回答目标用户搜索问题或向 AI 提问时能否发现项目；⑨ AI 可读性则检查项目内容能否被理解。保留现有社区版免费及自托管能力；付费托管能力不在本技能的实现范围。没有可靠数据时记 `unverifiable`，不要因为没有运行搜索就扣九维分数。

1. **固定基线。** 按用户与使用场景，为每个项目固定 5 个品牌查询、5 个非品牌问题，并写对应英文问题；先固定查询再采样。记录工具、参数、采集时间和时区、完整原始响应、实际返回的标题与 URL。标注自有站点、仓库、包、官方目录及第三方来源，逐项核查关键页面，保留失败与不可用状态。
2. **区分证据。** 工具返回顺序不是 Google/Bing 原生排名；摘要不等于实时页面正文。AI 回答中的提及与引用、站长平台索引、服务器抓取日志、下载次数、真实安装分别记录。`site:` 没结果或 TXT 存在都不证明索引/验证状态；sitemap 只有一条 URL 对单页站可属正常，不能按数量推断收录。
3. **先修使用路径。** 阅读首页和 README，核对目标用户、用途、安装或示例及真实效果。优先修复失效链接、错误安装说明和缺失的同场景下一步；不要为凑 URL、评分或关键词制造重复页面。对外联系、发帖或提交第三方 issue 需用户明确指令。
4. **对照复测。** 待整改实际部署后记录版本与时间；基线后第 7–14 天用同样查询、工具和参数保存另一份原始响应。来源数量和顺序只作为该工具的观察；后端、地区、语言或个性化不可核实须注明。少量样本不声称因果、用户量或统计显著。用户自愿提供的安装成功证据与本机隔离测试分别标注。
5. **核对工具输出。** 部分 AI 搜索工具返回模型组织的摘要而非原始搜索结果，列表与正文链接可能混合，格式和条目数也会变化。保留原文、记录输出格式；格式不同时不要直接比较数量或序号，URL 在摘要中出现只证明本次响应含该链接，不能直接视为引擎结果、收录或排名。可在同日重复采样，观察工具输出的波动，但两次样本不足以建立统计阈值或推断变化原因；域名迁移时分别记录新旧域名，固定基线查询不变。

**工具：** 以上 1、4、5 步用 `scorecard geo-track`（init 冻结查询 → capture baseline → log 整改/安装证据 → 窗口内 capture retest → report）执行，项目数据存本机 `~/.scorecard/geo`，不要再为单个项目另写采集脚本。

### 2. 输出报告

先给**直话诊断**（一两句），然后：

**记分卡**（每维 0-10 分，附证据）：

| 维度 | 得分 | 关键证据 | 最值得做的一件事 |
|---|---|---|---|

**整改清单**：按 `影响 ÷ 成本` 排序，每条标注预估耗时。

**对标差距**：与同品类头部 1-2 个刺眼差距。

### 3. 修复与交付

按照用户已明确授权的范围推进；低风险文档、元数据与验证可直接完成。确需选择、缺少授权或存在不可逆动作时再询问；向他人发送消息必须有明确指令。始终区分自动评分引擎可证实的事实与上述需要人工查看的验收项，人工项无证据时不得计为通过。

## 评分基准

- 9 至 10：规则评分较高（不代表同类排名）
- 6 至低于 9：规则评分中等
- 3 至低于 6：规则评分偏低
- 低于 3：规则评分较低

分档依据已核实的规则得分，未核实项不计入评分；分数不代表同类排名，也不能推断具体条件逐项成立。

## 已知教训

- 发布管线静默断裂：GITHUB_TOKEN 打 tag → 旧 workflow 永不再跑 → Release 无资产。
- 收录条目过期：awesome 列表里的 homepage 死链。
- open issue 积压 = "项目已死"错觉，即使代码活跃。
- **Logo 检查不能只看 API 字段**：必须查仓库文件结构（`public/logo.*`、`assets/logo.*`）和 README 引用。API 的 `social_preview_image` 字段不可靠。
- **Logo ≠ Social Preview**：Logo 是 1:1 小图标（网站/npm），Social Preview 是 2:1 横版图（1280×640，分享链接用）。两者用途、比例、格式完全不同。
- **一个项目一个 logo（SSoT）**：多个 logo 文件 = 品牌混乱。
- **Logo 必须 1:1 正方形，SVG 透明背景优先**：适配 npm icon、PyPI badge、GitHub 仓库图标。
- **Social Preview 要在 Settings 手动上传，不靠 README 首图**：不上传时 GitHub 用 opengraph 自动生成图（仓库名+头像），效果平庸但不算坏；靠"README 第一张图自动抓取"是不可靠的旧经验。README 头部图片与 Social Preview 各管各的。
- **README 头部只放一张品牌图**：视觉型项目放横版 banner，工具型放透明底 logo + 标题，两者不叠放。白底 PNG logo 在 GitHub 深色模式下是白色方块，必须透明底。
