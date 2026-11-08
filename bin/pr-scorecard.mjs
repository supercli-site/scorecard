#!/usr/bin/env bun
import { readFile, appendFile } from 'node:fs/promises'
import { auditProject } from '../server/audit.js'

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA = /^[a-f0-9]{40}$/i
const MARKER = '<!-- project-scorecard-pr:v1 -->'
const safe = (value) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[<>|\[\]`]/g, '\\$&').slice(0, 500)

export function parseEvent(event) {
  const base = event?.repository?.full_name
  const head = event?.pull_request?.head
  const baseSha = event?.pull_request?.base?.sha
  const number = event?.pull_request?.number
  if (event?.repository?.private !== false) throw new Error('Only public repositories are supported; private repository metadata is not sent to public services.')
  if (!REPO.test(base || '') || !REPO.test(head?.repo?.full_name || '') || !SHA.test(head?.sha || '') || !SHA.test(baseSha || '') || !Number.isSafeInteger(number) || number < 1) {
    throw new Error('A GitHub pull_request event with a public head repository and full head SHA is required.')
  }
  if (head.repo.private !== false) throw new Error('Private or inaccessible fork heads cannot be audited.')
  return { base, source: head.repo.full_name, sha: head.sha.toLowerCase(), baseSha: baseSha.toLowerCase(), number }
}

export function renderSummary(report, context) {
  if (typeof report?.score !== 'number' || !Number.isFinite(report.score)) throw new Error('Audit did not produce a score.')
  const lines = [
    MARKER,
    '## Scorecard · PR project maturity',
    '',
    `**${report.score.toFixed(1)} / 10** · ${safe(report.band)} · ${safe(report.type)}`,
    '',
    `File evidence: \`${safe(context.source)}@${safe(context.sha)}\` · PR #${context.number} · base \`${safe(context.baseSha)}\``,
    '',
    `Rules: Scorecard ${safe(report.rulesVersion || 'unknown')} · Scored ${safe(report.scoredCount)} of ${(report.dims || []).length} dimensions. Partial or unverifiable checks are listed below.`,
    '',
    '> File checks use this exact PR head. Stars, issues, releases, CI and other repository metadata describe the base repository at scan time. The PR audit does not contact the project homepage or package registries. This is a maturity audit, not a security scan or proof that every changed line works.',
    '',
    '| Dimension | Score | Checkable weight | Next check |',
    '| --- | ---: | ---: | --- |',
  ]
  for (const dim of report.dims || []) {
    const score = typeof dim.score === 'number' && Number.isFinite(dim.score) ? `${dim.score.toFixed(1)} / 10` : 'Unverifiable'
    const remaining = typeof dim.unverifiable === 'number' && Number.isFinite(dim.unverifiable) ? `${Math.max(0, 10 - dim.unverifiable).toFixed(1)} / 10` : 'Unknown'
    lines.push(`| ${safe(dim.name)} | ${score} | ${remaining} | ${safe((dim.gaps || [])[0] || (dim.manual || [])[0] || 'No automatic gap found')} |`)
  }
  const manual = (report.dims || []).flatMap((dim) => (dim.manual || []).map((item) => `- **${safe(dim.name)}**: ${safe(item)}`))
  if (manual.length) lines.push('', '<details><summary>Manual and unverifiable checks</summary>', '', ...manual, '', '</details>')
  lines.push('', `Scanned at ${safe(report.ts)}. [Scorecard project](https://github.com/supercli-site/scorecard) · [Open the web tool](https://scorecard.webkubor.online/)`, '')
  return lines.join('\n')
}

async function request(path, token, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(options.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const error = new Error(`GitHub API returned HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return response.json()
}

export async function confirmPublic(context, token) {
  for (const full of new Set([context.base, context.source])) {
    const repo = await request(`/repos/${full}`, token)
    if (repo?.private !== false || repo?.full_name?.toLowerCase() !== full.toLowerCase()) {
      throw new Error('Base repository or PR head is no longer publicly accessible.')
    }
  }
}

export async function confirmHead(context, token) {
  const current = await request(`/repos/${context.base}/pulls/${context.number}`, token)
  if (current?.head?.sha?.toLowerCase() !== context.sha || current?.head?.repo?.full_name?.toLowerCase() !== context.source.toLowerCase() ||
      current?.base?.sha?.toLowerCase() !== context.baseSha || current?.base?.repo?.full_name?.toLowerCase() !== context.base.toLowerCase() || current?.state !== 'open') {
    throw new Error('PR head, base or state changed during the audit; the result was not published.')
  }
}

export async function upsertComment(context, token, body) {
  let existing = null
  for (let page = 1; page <= 10; page++) {
    const comments = await request(`/repos/${context.base}/issues/${context.number}/comments?per_page=100&page=${page}`, token)
    if (!Array.isArray(comments)) throw new Error('GitHub returned an invalid comment list.')
    existing = comments.find((comment) => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(MARKER))
    if (existing || comments.length < 100) break
    if (page === 10) throw new Error('Too many comments to safely find the existing Scorecard report.')
  }
  // Check again immediately before publication; caller should also cancel superseded workflow runs.
  await confirmHead(context, token)
  const path = existing ? `/repos/${context.base}/issues/comments/${existing.id}` : `/repos/${context.base}/issues/${context.number}/comments`
  await request(path, token, { method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) })
}

export async function main(env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') throw new Error('This action only supports pull_request events.')
  if (!env.GITHUB_EVENT_PATH || !env.GITHUB_STEP_SUMMARY || !env.INPUT_GITHUB_TOKEN) throw new Error('Missing GitHub event, summary, or read token.')
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
  const context = parseEvent(event)
  await confirmPublic(context, env.INPUT_GITHUB_TOKEN)
  const [owner, repo] = context.base.split('/')
  const report = await auditProject({ owner, repo, token: env.INPUT_GITHUB_TOKEN, source: { repository: context.source, sha: context.sha } })
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  report.rulesVersion = `${manifest.version} (${env.SCORECARD_ACTION_REF || 'local working copy'})`
  if (report?.error) throw new Error(`Audit unavailable: ${report.error}`)
  await confirmPublic(context, env.INPUT_GITHUB_TOKEN)
  await confirmHead(context, env.INPUT_GITHUB_TOKEN)
  const summary = renderSummary(report, context)
  await appendFile(env.GITHUB_STEP_SUMMARY, `${summary}\n`)
  if (env.INPUT_COMMENT === 'true') {
    try {
      await upsertComment(context, env.INPUT_GITHUB_TOKEN, summary)
    } catch (error) {
      if (error.status !== 403) throw error
      await appendFile(env.GITHUB_STEP_SUMMARY, '\n> The PR comment was not updated: GitHub returned HTTP 403 during publication. Check token permissions or rate limits. The score above remains available in this workflow summary.\n')
      console.warn('Scorecard comment unavailable: GitHub returned HTTP 403; summary remains available.')
    }
  }
  return { score: report.score, sha: context.sha }
}

if (import.meta.main) {
  main().then((result) => console.log(`Scorecard audit complete: ${result.score}/10 at ${result.sha}`)).catch((error) => {
    console.error(`Scorecard audit unavailable: ${error.message}`)
    process.exitCode = 1
  })
}
