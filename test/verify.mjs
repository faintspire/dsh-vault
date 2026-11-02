/**
 * 端到端验收：用临时目录里的两个本地 bare 仓库当远端，验证分仓同步的全部行为。
 * 运行：node test/verify.mjs   （不访问网络）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..', 'index.js')
const TMP = path.join(os.tmpdir(), 'dsh-skill-sync-verify')
const REMOTE_SKILLS = path.join(TMP, 'skills-remote.git')
const REMOTE_MCP = path.join(TMP, 'mcp-remote.git')
const WORK_SKILLS = path.join(TMP, 'work-skills')
const WORK_MCP = path.join(TMP, 'work-mcp')

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

process.env.GIT_AUTHOR_NAME = 'sync-test'
process.env.GIT_AUTHOR_EMAIL = 'sync-test@example.com'
process.env.GIT_COMMITTER_NAME = 'sync-test'
process.env.GIT_COMMITTER_EMAIL = 'sync-test@example.com'

// ---- 夹具
fs.rmSync(TMP, { recursive: true, force: true })
for (const dir of ['demo-a', 'demo-b', 'not-a-skill']) {
  fs.mkdirSync(path.join(TMP, 'skills', dir), { recursive: true })
}
fs.mkdirSync(path.join(TMP, 'mcp'), { recursive: true })
fs.writeFileSync(path.join(TMP, 'skills', 'demo-a', 'SKILL.md'), '---\nname: demo-a\ndescription: 演示技能 A\n---\n\n# Demo A\n\nbody\n')
fs.writeFileSync(path.join(TMP, 'skills', 'demo-a', 'notes.md'), '# notes\n')
fs.writeFileSync(path.join(TMP, 'skills', 'demo-b', 'SKILL.md'), '---\nname: demo-b\ndescription: demo b\n---\nbody b\n')
fs.writeFileSync(path.join(TMP, 'skills', 'not-a-skill', 'readme.md'), 'should be skipped\n')
fs.writeFileSync(path.join(TMP, 'mcp', 'mcp.json'), JSON.stringify({ servers: { demo: { command: 'node', args: ['x.js'] } } }, null, 2))

for (const remote of [REMOTE_SKILLS, REMOTE_MCP]) {
  fs.mkdirSync(remote, { recursive: true })
  git(['init', '--bare', '--quiet'], remote)
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
}

const cfg = {
  repos: {
    skills: {
      url: 'file:///' + REMOTE_SKILLS.replace(/\\/g, '/'),
      branch: 'main',
      workdir: WORK_SKILLS,
      roots: [path.join(TMP, 'skills')],
    },
    mcp: {
      url: 'file:///' + REMOTE_MCP.replace(/\\/g, '/'),
      branch: 'main',
      workdir: WORK_MCP,
      files: [path.join(TMP, 'mcp', 'mcp.json')],
    },
  },
  schedule: { enabled: false, time: '03:30' },
  secretPolicy: 'block',
}

const mod = await import(pathToFileURL(PLUGIN).href)
const quiet = { log: () => {} }

// ---- 1. 首次同步：两个空仓库都推送
const r1 = await mod.syncAll(cfg, quiet)
check(r1.status === 'pushed', '两个仓库都首次推送', JSON.stringify(r1.repos.map((r) => r.status)))
check(r1.repos.find((r) => r.kind === 'skills')?.count === 2, '技能仓库计数为 2')
check(r1.repos.find((r) => r.kind === 'mcp')?.count === 1, 'MCP 仓库计数为 1')

const skillsTree = tree(REMOTE_SKILLS)
check(skillsTree.includes('skills/demo-a/SKILL.md'), '技能仓库有 skills/demo-a/SKILL.md')
check(skillsTree.includes('skills/demo-a/notes.md'), '技能包内附加文件一并上传')
check(skillsTree.includes('index.json'), '技能仓库有 index.json')
check(!skillsTree.some((f) => f.includes('not-a-skill')), '没有 SKILL.md 的目录被跳过')
check(!skillsTree.some((f) => f.startsWith('mcp/')), 'MCP 配置没有混进技能仓库')

const mcpTree = tree(REMOTE_MCP)
check(mcpTree.includes('mcp/mcp.json'), 'MCP 仓库有 mcp/mcp.json')
check(mcpTree.includes('index.json'), 'MCP 仓库有 index.json')
check(!mcpTree.some((f) => f.startsWith('skills/')), '技能没有混进 MCP 仓库')

// ---- 2. 幂等
const h1 = { skills: head(REMOTE_SKILLS), mcp: head(REMOTE_MCP) }
const r2 = await mod.syncAll(cfg, quiet)
check(r2.status === 'up-to-date', '内容没变时两个仓库都 up-to-date')
check(head(REMOTE_SKILLS) === h1.skills && head(REMOTE_MCP) === h1.mcp, '幂等运行没有推进任何仓库的 HEAD')

// ---- 3. 密钥拦截：只拦命中的仓库
fs.mkdirSync(path.join(TMP, 'skills', 'demo-secret'), { recursive: true })
fs.writeFileSync(
  path.join(TMP, 'skills', 'demo-secret', 'SKILL.md'),
  '---\ndescription: leak\n---\napi key: sk-abcdefghijklmnopqrstuvwxyz0123456789\n',
)
const r3 = await mod.syncAll(cfg, quiet)
const skillsFail = r3.repos.find((r) => r.kind === 'skills')
const mcpOk = r3.repos.find((r) => r.kind === 'mcp')
check(r3.status === 'failed', '含密钥时整体状态为 failed')
check(skillsFail?.code === 'SECRET_DETECTED', '命中的仓库报 SECRET_DETECTED', skillsFail?.error?.slice(0, 60))
check(mcpOk?.status === 'up-to-date', '另一个仓库不受影响，照常执行')
check(head(REMOTE_SKILLS) === h1.skills, '被拦截的仓库没有推上去')

// ---- 4. 修正后恢复
fs.rmSync(path.join(TMP, 'skills', 'demo-secret'), { recursive: true, force: true })
fs.mkdirSync(path.join(TMP, 'skills', 'demo-c'), { recursive: true })
fs.writeFileSync(path.join(TMP, 'skills', 'demo-c', 'SKILL.md'), '---\nname: demo-c\ndescription: 新增技能\n---\nbody c\n')
const r4 = await mod.syncAll(cfg, quiet)
check(r4.status === 'pushed', '删掉密钥技能后可以正常推送', r4.status)
const tree4 = tree(REMOTE_SKILLS)
check(tree4.includes('skills/demo-c/SKILL.md'), '新增技能出现在远端')
check(!tree4.some((f) => f.includes('demo-secret')), '被拦截的密钥文件始终没有进仓库')
check(head(REMOTE_SKILLS) !== h1.skills, '恢复后远端 HEAD 前进')

// ---- 5. index.json 结构
const skillsIndex = JSON.parse(fs.readFileSync(path.join(WORK_SKILLS, 'index.json'), 'utf8'))
const demoA = skillsIndex.skills.find((s) => s.name === 'demo-a')
check(skillsIndex.skills.length === 3, 'index 里登记了 3 个技能', String(skillsIndex.skills.length))
check(demoA?.description === '演示技能 A', 'frontmatter 描述被解析', demoA?.description)
check(/^[0-9a-f]{64}$/.test(demoA?.sha256 || ''), '每个技能带 64 位 sha256')
const mcpIndex = JSON.parse(fs.readFileSync(path.join(WORK_MCP, 'index.json'), 'utf8'))
check(mcpIndex.configs?.[0]?.name === 'mcp.json', 'MCP 仓库 index 里有 configs 列表')

// ---- 6. 只同步单个仓库
const r6 = await mod.syncAll(cfg, { ...quiet, only: 'mcp' })
check(r6.repos.length === 1 && r6.repos[0].kind === 'mcp', 'only 参数只跑指定仓库')

// ---- 7. 未配置的仓库被跳过
const r7 = await mod.syncAll({ repos: { skills: { url: '' }, mcp: { url: '' } } }, quiet)
check(r7.status === 'unconfigured', '两个仓库都没配时报 unconfigured', r7.status)

// ---- 8. mask 策略：不拦截，替换后照常推送
fs.mkdirSync(path.join(TMP, 'skills', 'demo-mask'), { recursive: true })
fs.writeFileSync(path.join(TMP, 'skills', 'demo-mask', 'SKILL.md'), '---\ndescription: masked\n---\nkey: sk-abcdefghijklmnopqrstuvwxyz0123456789\n')
const r8 = await mod.syncAll({ ...cfg, secretPolicy: 'mask' }, quiet)
check(r8.status === 'pushed', 'mask 策略下照常推送', r8.status)
const masked = readRemoteFile(REMOTE_SKILLS, 'skills/demo-mask/SKILL.md')
check(masked.includes('[REDACTED:openai-key]') && !masked.includes('sk-abcdefghijklmnopqrstuvwxyz'), '密钥被替换成占位符后才进仓库')

// ---- 9. 插件入口
let applyErr = null
try {
  mod.apply({}, {})
} catch (err) {
  applyErr = err
}
check(applyErr === null, '空配置 apply 不抛异常', applyErr ? applyErr.message : '')

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
check(ctx.registered.length === 2, '注册 skill_sync / skill_sync_status', ctx.registered.map((t) => t.name).join(','))
check(typeof ctx.dispose === 'function', 'apply 注册了清理函数')
if (typeof ctx.dispose === 'function') ctx.dispose()

fs.rmSync(TMP, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
