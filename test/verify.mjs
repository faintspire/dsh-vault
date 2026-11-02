/**
 * 端到端验收：用临时目录里的三个本地 bare 仓库当远端，验证多 target 同步的全部行为。
 * 运行：node test/verify.mjs   （不访问网络）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..', 'index.js')
const TMP = path.join(os.tmpdir(), 'dsh-vault-verify')

let failures = 0
function check(cond, label, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' :: ' + extra : ''}`)
  if (!cond) failures += 1
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const tree = (remote) => git(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'HEAD'], TMP).trim().split('\n').filter(Boolean)
const head = (remote) => git(['--git-dir', remote, 'rev-parse', 'HEAD'], TMP).trim()
const readRemoteFile = (remote, file) => git(['--git-dir', remote, 'show', `HEAD:${file}`], TMP)

console.log('node', process.version)
console.log('git ', execSync('git --version', { encoding: 'utf8' }).trim())

process.env.GIT_AUTHOR_NAME = 'vault-test'
process.env.GIT_AUTHOR_EMAIL = 'vault-test@example.com'
process.env.GIT_COMMITTER_NAME = 'vault-test'
process.env.GIT_COMMITTER_EMAIL = 'vault-test@example.com'

// ---- 夹具：技能 / 记忆 / MCP
fs.rmSync(TMP, { recursive: true, force: true })
for (const dir of ['skills/demo-a', 'skills/demo-b', 'skills/not-a-skill', 'mem/runtime', 'mem/documents/active']) {
  fs.mkdirSync(path.join(TMP, dir), { recursive: true })
}
fs.writeFileSync(path.join(TMP, 'skills/demo-a/SKILL.md'), '---\nname: demo-a\ndescription: 演示技能 A\n---\n\n# Demo A\n')
fs.writeFileSync(path.join(TMP, 'skills/demo-a/notes.md'), '# notes\n')
fs.writeFileSync(path.join(TMP, 'skills/demo-b/SKILL.md'), '---\nname: demo-b\ndescription: demo b\n---\nbody b\n')
fs.writeFileSync(path.join(TMP, 'skills/not-a-skill/readme.md'), 'should be skipped\n')
fs.writeFileSync(path.join(TMP, 'mem/runtime/MEMORY.md'), '# 工作记忆\n\n- 一条事实\n')
fs.writeFileSync(path.join(TMP, 'mem/runtime/USER.md'), '# 用户画像\n')
fs.writeFileSync(path.join(TMP, 'mem/runtime/memories.json'), JSON.stringify({ version: 1, entries: [] }))
fs.writeFileSync(path.join(TMP, 'mem/documents/active/doc-1.md'), '# 项目文档\n')
fs.writeFileSync(path.join(TMP, 'mem/documents/index.json'), JSON.stringify({ documents: [] }))

const remotes = {}
for (const name of ['skills', 'memory', 'mcp']) {
  const remote = path.join(TMP, `${name}-remote.git`)
  fs.mkdirSync(remote, { recursive: true })
  git(['init', '--bare', '--quiet'], remote)
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
  remotes[name] = remote
}

const cfg = {
  targets: [
    {
      name: 'skills',
      repo: { url: 'file:///' + remotes.skills.replace(/\\/g, '/'), branch: 'main', workdir: path.join(TMP, 'work-skills') },
      skills: [path.join(TMP, 'skills')],
    },
    {
      name: 'memory',
      repo: { url: 'file:///' + remotes.memory.replace(/\\/g, '/'), branch: 'main', workdir: path.join(TMP, 'work-memory') },
      dirs: [path.join(TMP, 'mem/runtime'), path.join(TMP, 'mem/documents')],
    },
    {
      name: 'mcp',
      repo: { url: 'file:///' + remotes.mcp.replace(/\\/g, '/'), branch: 'main', workdir: path.join(TMP, 'work-mcp') },
      files: [],
    },
  ],
  schedule: { enabled: false, time: '03:30' },
  secretPolicy: 'block',
}

const mod = await import(pathToFileURL(PLUGIN).href)
const quiet = { log: () => {} }

// ---- 1. 首次同步：三个仓库都推送
const r1 = await mod.syncAll(cfg, quiet)
check(r1.status === 'pushed', '三个仓库都首次推送', JSON.stringify(r1.targets.map((t) => t.status)))
check(r1.targets.find((t) => t.name === 'skills')?.count === 2, 'skills 计数为 2')
check(r1.targets.find((t) => t.name === 'memory')?.count === 2, 'memory 计数为 2（runtime + documents）')
check(r1.targets.find((t) => t.name === 'mcp')?.count === 0, 'mcp 为空但照常推送')

const skillTree = tree(remotes.skills)
check(skillTree.includes('skills/demo-a/SKILL.md'), '技能仓库有 skills/demo-a/SKILL.md')
check(skillTree.includes('skills/demo-a/notes.md'), '技能包内附加文件一并上传')
check(!skillTree.some((f) => f.includes('not-a-skill')), '没有 SKILL.md 的目录被跳过')
check(!skillTree.some((f) => f.startsWith('memory/')), '记忆没有混进技能仓库')

const memTree = tree(remotes.memory)
check(memTree.includes('memory/runtime/MEMORY.md'), '记忆仓库有 runtime/MEMORY.md')
check(memTree.includes('memory/runtime/USER.md'), '记忆仓库有 runtime/USER.md')
check(memTree.includes('memory/runtime/memories.json'), '记忆仓库有 memories.json（事实源）')
check(memTree.includes('memory/documents/active/doc-1.md'), '记忆仓库有项目文档')
check(!memTree.some((f) => f.startsWith('skills/')), '技能没有混进记忆仓库')

const mcpTree = tree(remotes.mcp)
check(mcpTree.length === 1 && mcpTree[0] === 'index.json', '空 MCP 仓库只有 index.json', mcpTree.join(','))

// ---- 2. 幂等
const h1 = { skills: head(remotes.skills), memory: head(remotes.memory), mcp: head(remotes.mcp) }
const r2 = await mod.syncAll(cfg, quiet)
check(r2.status === 'up-to-date', '内容没变时全部 up-to-date')
check(head(remotes.skills) === h1.skills && head(remotes.memory) === h1.memory && head(remotes.mcp) === h1.mcp, '幂等运行没有推进任何 HEAD')

// ---- 3. 密钥拦截：只拦命中的 target
fs.mkdirSync(path.join(TMP, 'skills/demo-secret'), { recursive: true })
fs.writeFileSync(path.join(TMP, 'skills/demo-secret/SKILL.md'), '---\ndescription: leak\n---\napi key: sk-abcdefghijklmnopqrstuvwxyz0123456789\n')
const r3 = await mod.syncAll(cfg, quiet)
check(r3.status === 'failed', '含密钥时整体状态为 failed')
check(r3.targets.find((t) => t.name === 'skills')?.code === 'SECRET_DETECTED', '命中的 target 报 SECRET_DETECTED')
check(r3.targets.find((t) => t.name === 'memory')?.status === 'up-to-date', '记忆不受影响，照常执行')
check(head(remotes.skills) === h1.skills, '被拦截的仓库没有推上去')

// ---- 4. 修正后恢复
fs.rmSync(path.join(TMP, 'skills/demo-secret'), { recursive: true, force: true })
fs.mkdirSync(path.join(TMP, 'skills/demo-c'), { recursive: true })
fs.writeFileSync(path.join(TMP, 'skills/demo-c/SKILL.md'), '---\nname: demo-c\ndescription: 新增技能\n---\nbody c\n')
const r4 = await mod.syncAll(cfg, quiet)
check(r4.status === 'pushed', '删掉密钥技能后可以正常推送', r4.status)
const tree4 = tree(remotes.skills)
check(tree4.includes('skills/demo-c/SKILL.md'), '新增技能出现在远端')
check(!tree4.some((f) => f.includes('demo-secret')), '被拦截的密钥文件始终没有进仓库')

// ---- 5. index.json 结构
const skillIndex = JSON.parse(fs.readFileSync(path.join(TMP, 'work-skills/index.json'), 'utf8'))
const demoA = skillIndex.entries.find((e) => e.name === 'demo-a')
check(skillIndex.target === 'skills' && skillIndex.entries.length === 3, 'skills index 有 3 条 entry')
check(demoA?.type === 'skill' && demoA?.description === '演示技能 A', '技能 entry 带 type 与描述')
check(/^[0-9a-f]{64}$/.test(demoA?.sha256 || ''), '每个 entry 带 64 位 sha256')
const memIndex = JSON.parse(fs.readFileSync(path.join(TMP, 'work-memory/index.json'), 'utf8'))
check(memIndex.entries.every((e) => e.type === 'dir'), '记忆 entry 的 type 是 dir')

// ---- 6. 只同步单个 target
const r6 = await mod.syncAll(cfg, { ...quiet, only: 'memory' })
check(r6.targets.length === 1 && r6.targets[0].name === 'memory', 'only 参数只跑指定 target')

// ---- 7. 未配置的仓库被跳过
const r7 = await mod.syncAll({ targets: [{ name: 'skills', repo: { url: '' }, skills: [] }] }, quiet)
check(r7.status === 'unconfigured', '仓库没配时报 unconfigured', r7.status)

// ---- 8. mask 策略
fs.mkdirSync(path.join(TMP, 'skills/demo-mask'), { recursive: true })
fs.writeFileSync(path.join(TMP, 'skills/demo-mask/SKILL.md'), '---\ndescription: masked\n---\nkey: sk-abcdefghijklmnopqrstuvwxyz0123456789\n')
const r8 = await mod.syncAll({ ...cfg, secretPolicy: 'mask' }, quiet)
check(r8.status === 'pushed', 'mask 策略下照常推送', r8.status)
const masked = readRemoteFile(remotes.skills, 'skills/demo-mask/SKILL.md')
check(masked.includes('[REDACTED:openai-key]') && !masked.includes('sk-abcdefghijklmnopqrstuvwxyz'), '密钥被替换成占位符后才进仓库')

// ---- 9. 插件入口
let applyErr = null
try {
  mod.apply({}, {})
} catch (err) {
  applyErr = err
}
check(applyErr === null, '空配置 apply 不抛异常', applyErr ? applyErr.message : '')

let badConfigErr = null
try {
  mod.apply({}, { targets: [{ name: 'Bad Name', repo: {} }] })
} catch (err) {
  badConfigErr = err
}
check(badConfigErr === null, '配置写错也只报错、不抛异常（不会拖垮 Host）', badConfigErr ? badConfigErr.message : '')

const ctx = {
  registered: [],
  effect(fn) {
    this.dispose = fn
  },
  tools: {
    register(tool) {
      ctx.registered.push(tool)
      return () => {}
    },
  },
}
mod.apply(ctx, { ...cfg, schedule: { enabled: true, time: '03:30' } })
await new Promise((resolve) => setTimeout(resolve, 300))
check(ctx.registered.length === 2, '注册 vault_sync / vault_status', ctx.registered.map((t) => t.name).join(','))
check(typeof ctx.dispose === 'function', 'apply 注册了清理函数')
if (typeof ctx.dispose === 'function') ctx.dispose()

fs.rmSync(TMP, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
