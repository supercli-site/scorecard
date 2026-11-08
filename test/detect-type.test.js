import { test, expect } from 'bun:test'
import { detectType } from '../server/audit.js'

const owner = 'webkubor'
const repo = { name: 'vite-plugin-agent-eyes', description: 'Vite plugin for agent runtime diagnostics', topics: ['vite-plugin', 'agent'] }

test('带 skill 的公开 Vite 插件保留产品类型，不被根 SKILL.md 降级', () => {
  const files = ['SKILL.md', 'package.json', 'README.md']
  const pkg = { name: 'vite-plugin-agent-eyes', exports: { '.': './dist/index.js' } }
  expect(detectType(files, [], pkg, repo, owner)).toBe('library')
})

test('公开 CLI 与主题优先于附带 skill，CLI 仍优先于主题/库', () => {
  const files = ['SKILL.md', 'package.json']
  expect(detectType(files, [], { name: 'my-cli', bin: './cli.js', exports: './lib.js' }, repo, owner)).toBe('cli')
  expect(detectType(files, [], { name: 'my-theme', main: './index.js' }, repo, owner)).toBe('theme')
  expect(detectType(files, [], { name: 'my-theme-cli', bin: './cli.js', main: './index.js' }, repo, owner)).toBe('cli')
})

test('纯 skill 与附 private 测试工具包仍是 skill', () => {
  const files = ['SKILL.md', 'README.md']
  expect(detectType(files, [], null, repo, owner)).toBe('skill')
  expect(detectType(files, [], { name: 'private-skill-tool', private: true, bin: './test.js', exports: './index.js' }, repo, owner)).toBe('skill')
  expect(detectType(files, [], { name: 'skill-metadata' }, repo, owner)).toBe('skill')
})
