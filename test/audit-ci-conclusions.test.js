import { test, expect } from 'bun:test'
import { auditProject } from '../server/audit.js'

async function auditRuns(workflowRuns) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async url => {
    const path = new URL(url).pathname
    const data = path === '/repos/example/project'
      ? { name: 'project', default_branch: 'main', description: 'A CLI tool for developers', topics: [], pushed_at: new Date().toISOString(), stargazers_count: 0, forks_count: 0 }
      : path.endsWith('/readme') ? '# Project\nInstall instructions'
      : path.endsWith('/community/profile') ? { files: {} }
      : path.endsWith('/runs') ? { workflow_runs: workflowRuns }
      : path.endsWith('/views') ? { count: 0, uniques: 0 } : []
    return new Response(typeof data === 'string' ? data : JSON.stringify(data))
  }
  try { return (await auditProject({ owner: 'example', repo: 'project' })).dims.find(d => d.key === 'release') }
  finally { globalThis.fetch = originalFetch }
}
const run = (name, conclusion, workflow_id, head_branch = 'main', event = 'push') => ({ name, status: 'completed', conclusion, workflow_id, head_branch, event })

test('skipped release workflow alongside successful CI is not a failing repository', async () => {
  const result = await auditRuns([run('Release Artifact Rebuild', 'skipped', 1), run('CI', 'success', 2)])
  expect(result.gaps.join(' ')).not.toContain('红')
  expect(result.evidence.join(' ')).toContain('success')
  expect(result.manual.join(' ')).toContain('skipped')
})

test('skipped, cancelled and unknown conclusions are neutral and unverifiable', async () => {
  for (const conclusion of ['skipped', 'cancelled', 'neutral', null, 'future_value']) {
    const result = await auditRuns([run('CI', conclusion, 1)])
    expect(result.gaps.join(' ')).not.toContain('红')
    expect(result.unverifiable).toBeGreaterThanOrEqual(2)
    expect(result.manual.join(' ')).toContain(String(conclusion ?? 'unknown'))
  }
})

test('actual failure is reported per workflow while a different success remains visible', async () => {
  const result = await auditRuns([run('Release', 'failure', 1), run('CI', 'success', 2)])
  expect(result.gaps.join(' ')).toContain('failure')
  expect(result.gaps.join(' ')).toContain('Release')
  expect(result.evidence.join(' ')).toContain('success')
})

test('feature-branch failure does not penalize a successful default branch', async () => {
  const result = await auditRuns([run('CI', 'failure', 1, 'feature/broken', 'pull_request'), run('CI', 'success', 1)])
  expect(result.gaps.join(' ')).not.toContain('failure')
  expect(result.evidence.join(' ')).toContain('success')
  expect(result.manual.join(' ')).toContain('feature/broken')
})

test('a pull request named main does not count as default branch evidence', async () => {
  const result = await auditRuns([run('CI', 'failure', 1, 'main', 'pull_request'), run('CI', 'success', 1)])
  expect(result.gaps.join(' ')).not.toContain('failure')
  expect(result.evidence.join(' ')).toContain('success')
})

test('missing event type is not treated as confirmed default-branch failure', async () => {
  const unknown = { ...run('CI', 'failure', 1), event: undefined }
  const result = await auditRuns([unknown])
  expect(result.gaps.join(' ')).not.toContain('failure')
  expect(result.unverifiable).toBeGreaterThanOrEqual(2)
  expect(result.manual.join(' ')).toContain('未计入默认分支评分')
})

test('a real default-branch failure remains a gap', async () => {
  const result = await auditRuns([run('CI', 'failure', 1), run('CI', 'success', 1, 'feature/other')])
  expect(result.gaps.join(' ')).toContain('failure')
})

test('no identifiable default-branch result is unverifiable', async () => {
  const result = await auditRuns([run('CI', 'failure', 1, 'feature/other')])
  expect(result.gaps.join(' ')).not.toContain('failure')
  expect(result.unverifiable).toBeGreaterThanOrEqual(2)
})

test('a skipped newer run does not make an older failure the current result', async () => {
  const result = await auditRuns([run('CI', 'skipped', 1), run('CI', 'failure', 1)])
  expect(result.gaps.join(' ')).not.toContain('failure')
  expect(result.manual.join(' ')).toContain('skipped')
  expect(result.unverifiable).toBeGreaterThanOrEqual(2)
})

test('older failure does not override later success for the same workflow', async () => {
  const result = await auditRuns([run('CI', 'success', 1), run('CI', 'failure', 1)])
  expect(result.gaps.join(' ')).not.toContain('failure')
  expect(result.evidence.join(' ')).toContain('success')
})
