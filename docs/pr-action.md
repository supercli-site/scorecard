# Pull request 项目质检

在公开仓库的 PR 上，用 Scorecard 的 GitHub 九维规则生成一份可复核的成熟度报告。报告绑定 PR 的完整 head 和 base SHA；它评的是该提交对应的项目状态，不是对每一行改动的正确性证明。

## 在公开仓库启用

把以下内容保存为 `.github/workflows/scorecard.yml`。示例使用经过审阅的固定 Action 提交；升级时请审查并更新完整 SHA。这个工作流不 checkout 或执行 PR 的代码；GitHub 托管 Ubuntu runner 自带 Node.js，其他 runner 需要 Node.js 20 及以上。Action 只安装锁定的 `dayjs` 运行依赖，并禁用安装脚本。

```yaml
name: Scorecard PR maturity
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: read
concurrency:
  group: scorecard-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  maturity:
    runs-on: ubuntu-latest
    steps:
      - uses: supercli-site/scorecard@0035a31d038b45052d19c8a804797647ea0ef4ec
        with:
          github-token: ${{ github.token }}
```

结果在 PR 的 **Checks → Scorecard PR maturity → Summary** 中。默认不设置最低分门槛；结果取得失败时任务会报告不可用，而不会把空结果写成零分或合格。

如果希望工作流更新一条 PR 评论，在上面的 `permissions` 中把 `pull-requests` 改为 `write`，并在 `with` 下增加 `comment: 'true'`。外部 fork 的 GitHub token 通常会被 GitHub 降为只读；若评论 API 返回 403，Action 明确提示评论没有更新，评分仍留在 Summary。不要为此把个人访问令牌交给不可信 PR，也不要在 `pull_request_target` 中检出或执行 PR 代码。

## 范围与限制

- 仅支持**当前公开的基础仓库和 PR head 仓库**；私有仓库不运行。审计前后重新确认公开状态，但 API 检查和后续操作不具备原子性，不能排除极短时间内状态变化。
- 文件从 GitHub API 按 head 仓库和完整 SHA 读取；star、issue、release 和默认分支 CI 等使用基础仓库审计时的实时元数据。目录可能达到 GitHub 返回上限、文件或元数据读取失败时，拒绝输出误导性分数。
- PR 模式不访问项目的任意 homepage、不查询外部 registry，也不读取私有 GitHub Traffic；这些判据标为无法核实，不按零分扣除。报告不向 Scorecard 线上服务器发送仓库内容。
- 符合语法的许可证、安装说明、README 和配置文件仍可能不正确；人工项需要自行核实。项目质检不是 SAST、依赖漏洞扫描，也不代替测试和真实用户验收。
- 评论的查找与更新不是原子操作。上面的 `concurrency` 可取消同 PR 旧运行，报告中的 SHA 可供核对，但不能保证绝无竞态或重复评论。
