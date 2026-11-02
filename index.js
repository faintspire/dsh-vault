/**
 * dsh-skill-sync
 *
 * 把本地技能包（<name>/SKILL.md）与 MCP 配置分别同步到两个私有 git 仓库：
 * 插件侧按天定时 push，并向 agent 暴露 skill_sync / skill_sync_status；
 * 命令行侧 `node index.js sync --config skill-sync.json` 手动跑同一条路径。
 *
 * 约定：每个仓库里只有一个被管理的子目录（skills/ 或 mcp/），每次同步先清空再重建，
 * 所以远端不会残留本地已删除的条目；仓库根的 README / LICENSE 等文件不动。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const VERSION = '0.2.0'
const KINDS = ['skills', 'mcp']

const DEFAULTS = {
  repos: {
    skills: {
      url: '',
      branch: 'main',
      remote: 'origin',
      workdir: path.join(os.homedir(), '.dsh', 'skill-sync', 'dsh-skills'),
      roots: [path.join(os.homedir(), '.dsh', 'skills'), path.join(os.homedir(), '.agents', 'skills')],
    },
    mcp: {
      url: '',
      branch: 'main',
      remote: 'origin',
      workdir: path.join(os.homedir(), '.dsh', 'skill-sync', 'dsh-mcp'),
      files: [],
    },
  },
  schedule: { enabled: false, time: '03:30' },
  // block：发现密钥就中止该仓库的推送；mask：把命中的片段替换成 [REDACTED:xxx] 后继续。
  secretPolicy: 'block',
  maxFileBytes: 1024 * 1024,
  ignored: ['.git', 'node_modules', '.DS_Store', 'Thumbs.db', '.idea', '.vscode', 'dist', 'build', 'target', '__pycache__'],
}

/** 高置信度的密钥特征，宁可误报也不要把 token 推上去。 */
const SECRET_PATTERNS = [
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'aliyun-ak', re: /\bLTAI[A-Za-z0-9]{12,}\b/g },
  { id: 'aws-ak', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/g },
  { id: 'private-key', re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g },
]

// ---------------------------------------------------------------- 配置

function expandHome(p) {
  const s = String(p == null ? '' : p).trim()
  if (!s) return ''
  if (s === '~') return os.homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2))
  return path.resolve(s)
}

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter((x) => typeof x === 'string' && x.trim())

function normalizeRepo(raw, defaults) {
  const repo = { ...defaults, ...(raw || {}) }
  repo.url = String(repo.url || '').trim()
  repo.branch = String(repo.branch || 'main')
  repo.remote = String(repo.remote || 'origin')
  repo.workdir = expandHome(repo.workdir || defaults.workdir)
  repo.token = repo.token || process.env.DSH_SKILL_SYNC_TOKEN || ''
  return repo
}

export function normalizeConfig(config = {}) {
  const base = config || {}
  const raw = base.repos || {}
  const skills = normalizeRepo(raw.skills, DEFAULTS.repos.skills)
  const mcp = normalizeRepo(raw.mcp, DEFAULTS.repos.mcp)
  skills.roots = asList(skills.roots).filter(Boolean).map(expandHome)
  if (!skills.roots.length) skills.roots = DEFAULTS.repos.skills.roots
  mcp.files = asList(mcp.files).filter(Boolean).map(expandHome)

  const out = {
    repos: { skills, mcp },
    schedule: { ...DEFAULTS.schedule, ...(base.schedule || {}) },
    secretPolicy: ['block', 'mask'].includes(base.secretPolicy) ? base.secretPolicy : 'block',
    maxFileBytes: Number(base.maxFileBytes) || DEFAULTS.maxFileBytes,
    ignored: new Set(asList(base.ignored).length ? asList(base.ignored) : DEFAULTS.ignored),
  }
  if (!/^\d{1,2}:\d{2}$/.test(String(out.schedule.time))) out.schedule.time = DEFAULTS.schedule.time
  out.schedule.enabled = out.schedule.enabled === true
  return out
}

/** https 地址在带 token 时注入凭据；SSH 地址原样返回，交给本机 ssh key。 */
function authUrl(repo) {
  const url = String(repo.url || '')
  if (!repo.token || !/^https?:/i.test(url)) return url
  try {
    const u = new URL(url)
    u.username = 'x-access-token'
    u.password = repo.token
    return u.toString()
  } catch {
    return url
  }
}

/** 打印用地址：去掉密码，避免 token 落进日志。 */
function displayUrl(url) {
  return String(url).replace(/\/\/([^/@]+)@/, '//***@')
}

// ---------------------------------------------------------------- 进程调用

function tail(s, n = 600) {
  const text = String(s || '').trim()
  return text.length > n ? '...' + text.slice(-n) : text
}

function git(cwd, args, { timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        // 没有可用凭据时立刻失败，不要挂在交互式密码提示上（定时任务会卡死）。
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          message: err ? String(err.message || err) : '',
        })
      },
    )
    child.stdin?.end()
  })
}

// ---------------------------------------------------------------- 仓库

async function ensureRepo(repo, log) {
  const { workdir, branch, remote } = repo
  const url = authUrl(repo)

  if (!fs.existsSync(path.join(workdir, '.git'))) {
    await fsp.mkdir(path.dirname(workdir), { recursive: true })
    log(`clone ${displayUrl(url)} -> ${workdir}`)
    const clone = await git(path.dirname(workdir), ['clone', '--branch', branch, '--', url, workdir])
    if (!clone.ok) {
      // 空仓库（还没有任何提交）clone 会失败，退化成 init + remote add。
      await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
      await fsp.mkdir(workdir, { recursive: true })
      const init = await git(workdir, ['init'])
      if (!init.ok) throw new Error(`git init 失败: ${tail(init.stderr || init.message)}`)
      await git(workdir, ['remote', 'add', remote, url])
      await git(workdir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
    }
  }

  const current = await git(workdir, ['remote', 'get-url', remote])
  if (!current.ok) await git(workdir, ['remote', 'add', remote, url])
  else if (current.stdout.trim() !== url) await git(workdir, ['remote', 'set-url', remote, url])

  // 另一台机器可能已经推过：先拉一次，冲突交给用户看，不静默覆盖。
  const fetch = await git(workdir, ['fetch', '--prune', remote])
  if (!fetch.ok) {
    log(`fetch 失败（网络或凭据问题，稍后 push 会再报）: ${tail(fetch.stderr || fetch.message)}`)
    return workdir
  }
  const hasLocal = await git(workdir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (hasLocal.ok) {
    const pull = await git(workdir, ['pull', '--rebase', '--autostash', remote, branch])
    if (!pull.ok) log(`pull 失败，继续用本地副本: ${tail(pull.stderr || pull.message)}`)
  } else {
    // 远端还没有这个分支（空仓库首推）时没有可 checkout 的起点，保持当前 HEAD。
    const hasRemote = await git(workdir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`])
    if (hasRemote.ok) {
      const co = await git(workdir, ['checkout', '-B', branch, `${remote}/${branch}`])
      if (!co.ok) log(`checkout ${branch} 失败: ${tail(co.stderr || co.message)}`)
    }
  }
  return workdir
}

// ---------------------------------------------------------------- 导出

function copyTree(src, dst, cfg) {
  const filter = (from) => {
    const base = path.basename(from)
    if (cfg.ignored.has(base)) return false
    try {
      const st = fs.statSync(from)
      if (st.isFile() && st.size > cfg.maxFileBytes) return false
    } catch {
      return false
    }
    return true
  }
  fs.cpSync(src, dst, { recursive: true, filter, force: true, errorOnExist: false })
}

function walkFiles(root, dir, out) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(root, abs, out)
    else if (entry.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'))
  }
}

function digestDir(dir) {
  const files = []
  walkFiles(dir, dir, files)
  files.sort()
  const hash = crypto.createHash('sha256')
  let bytes = 0
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(dir, rel))
    bytes += buf.length
    hash.update(rel).update('\0').update(buf).update('\0')
  }
  return { sha256: hash.digest('hex'), files: files.length, bytes }
}

function digestFile(file) {
  const buf = fs.readFileSync(file)
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), files: 1, bytes: buf.length }
}

/** 读 SKILL.md 的 YAML frontmatter，只取本插件要用的几个字段。 */
function readSkillMeta(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end < 0) return {}
  const meta = {}
  for (const line of text.slice(3, end).split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (!m) continue
    meta[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return meta
}

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}

function exportSkills(repoDir, roots, cfg, log) {
  const target = path.join(repoDir, 'skills')
  resetDir(target)
  const skills = []
  const seen = new Set()
  for (const root of roots) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      log(`技能目录不可读，跳过: ${root}`)
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || cfg.ignored.has(entry.name)) continue
      const src = path.join(root, entry.name)
      const skillFile = path.join(src, 'SKILL.md')
      if (!fs.existsSync(skillFile)) continue
      if (seen.has(entry.name)) {
        log(`技能重名，保留先出现的那个: ${entry.name} (${src})`)
        continue
      }
      seen.add(entry.name)
      const dst = path.join(target, entry.name)
      copyTree(src, dst, cfg)
      const meta = readSkillMeta(skillFile)
      skills.push({ name: entry.name, description: meta.description || '', source: src, ...digestDir(dst) })
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills.map(({ name, description, sha256, files, bytes }) => ({ name, description, sha256, files, bytes }))
}

function exportMcp(repoDir, files, cfg, log) {
  const target = path.join(repoDir, 'mcp')
  resetDir(target)
  const configs = []
  for (const src of files) {
    let stat
    try {
      stat = fs.statSync(src)
    } catch {
      log(`MCP 配置不存在，跳过: ${src}`)
      continue
    }
    if (!stat.isFile()) continue
    const name = path.basename(src)
    const dst = path.join(target, name)
    copyTree(src, dst, cfg)
    configs.push({ name, ...digestFile(dst) })
  }
  configs.sort((a, b) => a.name.localeCompare(b.name))
  return configs.map(({ name, sha256, bytes }) => ({ name, sha256, bytes }))
}

// ---------------------------------------------------------------- 密钥扫描

function isTextFile(file) {
  try {
    if (fs.statSync(file).size > 512 * 1024) return false
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(4096)
    const read = fs.readSync(fd, buf, 0, 4096, 0)
    fs.closeSync(fd)
    for (let i = 0; i < read; i += 1) if (buf[i] === 0) return false
    return true
  } catch {
    return false
  }
}

async function scanSecrets(repoDir, cfg, log) {
  const hits = []
  const root = path.join(repoDir, 'skills')
  const mcpRoot = path.join(repoDir, 'mcp')
  for (const base of [root, mcpRoot]) {
    const files = []
    walkFiles(base, base, files)
    const label = path.basename(base)
    for (const rel of files) {
      const abs = path.join(base, rel)
      if (!isTextFile(abs)) continue
      let text
      try {
        text = await fsp.readFile(abs, 'utf8')
      } catch {
        continue
      }
      let masked = text
      for (const pattern of SECRET_PATTERNS) {
        pattern.re.lastIndex = 0
        if (!pattern.re.test(text)) continue
        hits.push({ file: `${label}/${rel}`, id: pattern.id })
        if (cfg.secretPolicy === 'mask') {
          pattern.re.lastIndex = 0
          masked = masked.replace(pattern.re, `[REDACTED:${pattern.id}]`)
        }
      }
      if (cfg.secretPolicy === 'mask' && masked !== text) await fsp.writeFile(abs, masked)
    }
  }
  if (hits.length) log(`密钥扫描命中 ${hits.length} 处（策略 ${cfg.secretPolicy}）`)
  return hits
}

// ---------------------------------------------------------------- 单个仓库同步

function writeIndex(repoDir, kind, payload) {
  // 故意不写时间戳：index.json 必须内容稳定，否则每次同步都会产生一个空提交。
  const index = { generator: `dsh-skill-sync@${VERSION}`, ...payload }
  fs.writeFileSync(path.join(repoDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')
  return index
}

async function syncRepo(kind, repo, cfg, log) {
  if (!repo.url) return { kind, status: 'unconfigured' }

  await ensureRepo(repo, log)
  const dir = repo.workdir

  const payload = kind === 'skills'
    ? { skills: exportSkills(dir, repo.roots, cfg, log) }
    : { configs: exportMcp(dir, repo.files, cfg, log) }
  const count = kind === 'skills' ? payload.skills.length : payload.configs.length

  const hits = await scanSecrets(dir, cfg, log)
  if (hits.length && cfg.secretPolicy === 'block') {
    const detail = hits.map((h) => `${h.file} (${h.id})`).join('、')
    const err = new Error(`检测到疑似密钥，已中止推送：${detail}`)
    err.code = 'SECRET_DETECTED'
    err.hits = hits
    throw err
  }

  writeIndex(dir, kind, payload)

  const status = await git(dir, ['status', '--porcelain'])
  if (!status.ok) throw new Error(`git status 失败: ${tail(status.stderr || status.message)}`)
  if (!status.stdout.trim()) return { kind, status: 'up-to-date', count, workdir: dir }

  await git(dir, ['add', '-A'])
  const stamp = new Date().toLocaleString('sv-SE').slice(0, 19)
  const message = `sync: ${stamp} · ${count} ${kind === 'skills' ? 'skills' : 'configs'}`
  const commit = await git(dir, ['commit', '-m', message])
  if (!commit.ok) throw new Error(`git commit 失败: ${tail(commit.stderr || commit.message)}`)

  const push = await git(dir, ['push', '--set-upstream', repo.remote, repo.branch])
  if (!push.ok) {
    const err = new Error(`git push 失败: ${tail(push.stderr || push.message)}`)
    err.code = 'PUSH_FAILED'
    // 提交已经在本地，修好网络后重跑一次就能补推，不会重做提交。
    throw err
  }
  log(`已推送到 ${displayUrl(repo.url)} (${repo.remote}/${repo.branch}): ${message}`)
  return { kind, status: 'pushed', count, workdir: dir, message }
}

/**
 * 同步所有已配置的仓库。单个仓库失败不影响另一个，结果里逐条报告。
 * @returns {{ status: string, repos: Array<object> }}
 */
export async function syncAll(rawConfig, { log = () => {}, only = null } = {}) {
  const cfg = normalizeConfig(rawConfig)
  const repos = []
  for (const kind of KINDS) {
    if (only && only !== kind) continue
    try {
      repos.push(await syncRepo(kind, cfg.repos[kind], cfg, log))
    } catch (err) {
      repos.push({
        kind,
        status: 'failed',
        error: String(err && err.message ? err.message : err),
        code: err && err.code ? err.code : 'ERROR',
      })
    }
  }
  const failed = repos.some((r) => r.status === 'failed')
  const changed = repos.some((r) => r.status === 'pushed')
  const anyConfigured = repos.some((r) => r.status !== 'unconfigured')
  const status = failed ? 'failed' : changed ? 'pushed' : anyConfigured ? 'up-to-date' : 'unconfigured'
  return { status, repos }
}

// ---------------------------------------------------------------- 状态

function stateFile() {
  return path.join(os.homedir(), '.dsh', 'skill-sync-state.json')
}

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
  } catch {
    return null
  }
}

async function writeState(patch) {
  const next = { ...(readState() || {}), ...patch }
  await fsp.mkdir(path.dirname(stateFile()), { recursive: true })
  await fsp.writeFile(stateFile(), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

// ---------------------------------------------------------------- 插件入口

function msUntil(time) {
  const [h, m] = String(time).split(':').map(Number)
  const now = new Date()
  const next = new Date(now)
  next.setHours(h || 0, m || 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

let running = null

async function guardedRun(cfg, reason, log) {
  const configured = KINDS.filter((kind) => cfg.repos[kind].url)
  if (!configured.length) return { status: 'unconfigured', repos: [] }
  if (running) {
    log('上一次同步还没结束，本次跳过')
    return { status: 'busy', repos: [] }
  }
  running = (async () => {
    try {
      const result = await syncAll(cfg, { log })
      const patch = { lastRunAt: new Date().toISOString(), lastStatus: result.status, lastReason: reason, lastError: '' }
      for (const repo of result.repos) patch[repo.kind] = repo
      await writeState(patch)
      return result
    } catch (err) {
      const message = String(err && err.message ? err.message : err)
      console.error(`[skill-sync] 同步失败: ${message}`)
      await writeState({ lastRunAt: new Date().toISOString(), lastStatus: 'failed', lastReason: reason, lastError: message })
      return { status: 'failed', repos: [], error: message }
    } finally {
      running = null
    }
  })()
  return running
}

function summarize(result) {
  if (!result || !result.repos || !result.repos.length) return result?.status || '无结果'
  return result.repos
    .map((repo) => {
      const label = repo.kind === 'skills' ? '技能' : 'MCP'
      if (repo.status === 'pushed') return `${label}: 已推送 ${repo.count} 条`
      if (repo.status === 'up-to-date') return `${label}: 无变化`
      if (repo.status === 'unconfigured') return `${label}: 未配置仓库`
      return `${label}: 失败 - ${repo.error || ''}`
    })
    .join('\n')
}

async function registerTools(ctx, cfg, log) {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') return
  let defineTool = null
  try {
    ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch {
    // 插件按裸 ESM 加载时可能解析不到宿主包，退化成普通对象注册。
    defineTool = (options) => options
  }

  const syncTool = defineTool({
    name: 'skill_sync',
    description:
      '立即把本地技能目录（SKILL.md）与 MCP 配置同步到配置好的私有 git 仓库并推送。用于用户说“同步技能”“上传技能到云端”“备份 MCP 配置”时。',
    parameters: {
      repo: { type: 'string', enum: ['skills', 'mcp'], description: '只同步其中一个仓库；不传则两个都同步。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          skills: { type: 'integer' },
          mcp: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const lines = [`状态: ${value.status}`, value.summary]
        if (value.error) lines.push(`错误: ${value.error}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const result = await guardedRun(cfg, 'manual', log)
      const repo = args?.repo
      const filtered = repo ? result.repos.filter((r) => r.kind === repo) : result.repos
      const failed = filtered.find((r) => r.status === 'failed')
      return {
        status: failed ? 'failed' : result.status,
        summary: summarize({ ...result, repos: filtered }),
        skills: filtered.find((r) => r.kind === 'skills')?.count ?? 0,
        mcp: filtered.find((r) => r.kind === 'mcp')?.count ?? 0,
        error: failed?.error || '',
      }
    },
  })

  const statusTool = defineTool({
    name: 'skill_sync_status',
    description: '查看技能/MCP 同步的最近一次结果（时间、状态、错误）以及下次自动同步时间。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', required: true },
          nextRunAt: { type: 'string' },
          lastRunAt: { type: 'string' },
          lastStatus: { type: 'string' },
          lastError: { type: 'string' },
          skillsRepo: { type: 'string' },
          mcpRepo: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const lines = [
          `技能仓库: ${value.skillsRepo || '未配置'}`,
          `MCP 仓库: ${value.mcpRepo || '未配置'}`,
          `自动同步: ${value.enabled ? '开' : '关'}${value.nextRunAt ? ` (下次 ${value.nextRunAt})` : ''}`,
          `上次: ${value.lastStatus || '从未运行'}${value.lastRunAt ? ` @ ${value.lastRunAt}` : ''}`,
        ]
        if (value.lastError) lines.push(`错误: ${value.lastError}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const state = readState() || {}
      const anyConfigured = KINDS.some((kind) => cfg.repos[kind].url)
      const nextRunAt = cfg.schedule.enabled && anyConfigured
        ? new Date(Date.now() + msUntil(cfg.schedule.time)).toISOString()
        : ''
      return {
        enabled: cfg.schedule.enabled === true,
        nextRunAt,
        lastRunAt: state.lastRunAt || '',
        lastStatus: state.lastStatus || '',
        lastError: state.lastError || '',
        skillsRepo: cfg.repos.skills.url ? displayUrl(cfg.repos.skills.url) : '',
        mcpRepo: cfg.repos.mcp.url ? displayUrl(cfg.repos.mcp.url) : '',
      }
    },
  })

  for (const tool of [syncTool, statusTool]) {
    try {
      ctx.tools.register(tool)
    } catch (err) {
      console.warn(`[skill-sync] 注册工具 ${tool.name} 失败: ${err && err.message}`)
    }
  }
}

export function apply(ctx, config) {
  let timer = null
  let stopped = false
  const cfg = normalizeConfig(config || {})
  const log = (message) => console.log(`[skill-sync] ${message}`)

  const scheduleNext = () => {
    if (stopped || !cfg.schedule.enabled) return
    if (!KINDS.some((kind) => cfg.repos[kind].url)) return
    const delay = msUntil(cfg.schedule.time)
    timer = setTimeout(async () => {
      await guardedRun(cfg, 'schedule', log)
      scheduleNext()
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    log(`定时同步已开启，每天 ${cfg.schedule.time}（下次 ${new Date(Date.now() + delay).toLocaleString()}）`)
  }

  if (!KINDS.some((kind) => cfg.repos[kind].url)) log('仓库地址还没配，定时同步不启动（补上配置后重启生效）')
  else scheduleNext()

  registerTools(ctx, cfg, log).catch((err) => console.warn(`[skill-sync] 工具注册跳过: ${err && err.message}`))

  const stop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
  if (typeof ctx?.effect === 'function') ctx.effect(() => stop)
  else process.on('exit', stop)
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out.flags[key] = next
        i += 1
      } else out.flags[key] = true
    } else out._.push(arg)
  }
  return out
}

function loadConfigFile(file) {
  const target = file ? path.resolve(expandHome(file)) : path.join(process.cwd(), 'skill-sync.json')
  if (!fs.existsSync(target)) {
    throw new Error(`找不到配置文件 ${target}（把 skill-sync.example.json 复制成 skill-sync.json 再改）`)
  }
  return JSON.parse(fs.readFileSync(target, 'utf8'))
}

const HELP = `dsh-skill-sync ${VERSION}

用法:
  node index.js sync   --config skill-sync.json [--repo skills|mcp]   导出并 push
  node index.js status --config skill-sync.json                       看上次结果与下次时间

配置字段见 README.md / skill-sync.example.json。
`

export async function cli(argv) {
  const args = parseArgs(argv)
  const cmd = args._[0] || 'sync'
  if (cmd === 'help' || args.flags.help) {
    console.log(HELP)
    return
  }
  const cfg = normalizeConfig(loadConfigFile(args.flags.config))
  const log = (message) => console.log(`[skill-sync] ${message}`)

  if (cmd === 'status') {
    const state = readState() || {}
    console.log(`技能仓库: ${cfg.repos.skills.url ? displayUrl(cfg.repos.skills.url) : '未配置'}`)
    console.log(`MCP 仓库: ${cfg.repos.mcp.url ? displayUrl(cfg.repos.mcp.url) : '未配置'}`)
    console.log(`克隆目录: ${cfg.repos.skills.workdir} / ${cfg.repos.mcp.workdir}`)
    console.log(`自动同步: ${cfg.schedule.enabled ? `每天 ${cfg.schedule.time}` : '关'}`)
    console.log(`上次: ${state.lastStatus || '从未运行'}${state.lastRunAt ? ` @ ${state.lastRunAt}` : ''}`)
    if (state.lastError) console.log(`错误: ${state.lastError}`)
    return
  }
  if (cmd !== 'sync') throw new Error(`未知命令 ${cmd}（可用: sync / status）`)

  const only = ['skills', 'mcp'].includes(args.flags.repo) ? args.flags.repo : null
  const result = await syncAll(cfg, { log, only })
  await writeState({ lastRunAt: new Date().toISOString(), lastStatus: result.status, lastReason: 'cli', lastError: '' })
  console.log(summarize(result))
  if (result.status === 'failed') process.exitCode = 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(`[skill-sync] ${err && err.code ? `[${err.code}] ` : ''}${err && err.message ? err.message : err}`)
    process.exitCode = 1
  })
}
