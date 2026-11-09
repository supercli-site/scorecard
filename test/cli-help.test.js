import { test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../bin/scorecard.mjs', import.meta.url))

test('explicit help succeeds for root, GEO and compare invocations', () => {
  for (const args of [['--help'], ['-h'], ['geo', '--help'], ['--compare-a', 'x', '--help']]) {
    const result = spawnSync('node', [cli, ...args], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('用法:')
  }
})

test('missing target still returns an error', () => {
  const result = spawnSync('node', [cli], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stdout).toContain('用法:')
})
