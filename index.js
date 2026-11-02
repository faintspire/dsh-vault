/**
 * dsh-vault
 *
 * 把 DSH 的可携带资产分别同步到独立的私有 git 仓库：技能包、用户/项目记忆、MCP 配置。
 * 每个 target 一个仓库、一个被管理的子目录；插件按天定时 push，也可随时手动推。
 *
 * 约定：每个仓库里只有 <target>/ 目录由本插件管理，每次先清空再重建，所以远端不会残留
 * 本地已删除的条目；仓库根的 README / LICENSE 等手写文件不动。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERSION = '0.4.0'

const DEFAULTS = {
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

function normalizeTarget(raw, index) {
  const name = String(raw?.name || '').trim()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`target 名字必须是 kebab-case（小写字母/数字/连字符），第 ${index + 1} 个是 ${JSON.stringify(name)}`)
  }
  const repo = raw?.repo || {}
  const workdir = expandHome(repo.workdir || path.join(os.homedir(), '.dsh', 'vault', `dsh-${name}`))
  return {
    name,
    repo: {
      url: String(repo.url || '').trim(),
      branch: String(repo.branch || 'main'),
      remote: String(repo.remote || 'origin'),
      workdir,
      token: repo.token || process.env.DSH_VAULT_TOKEN || '',
    },
    // 技能根目录：每个含 SKILL.md 的直接子目录算一个技能包。
    skills: asList(raw?.skills).map(expandHome),
    // 整棵目录照搬（记忆的 runtime / documents 就是这种）。
    dirs: asList(raw?.dirs).map(expandHome),
    // 单个文件（MCP 配置这种）。
    files: asList(raw?.files).map(expandHome),
  }
}

export function normalizeConfig(config = {}) {
  const base = config || {}
  const rawTargets = Array.isArray(base.targets) ? base.targets : []
  const targets = rawTargets.map((raw, i) => normalizeTarget(raw, i))
  const names = new Set()
  for (const target of targets) {
    if (names.has(target.name)) throw new Error(`target 重名: ${target.name}`)
    names.add(target.name)
  }
  const out = {
    targets,
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

function collectSkills(roots, cfg, log) {
  const items = []
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
      if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue
      if (seen.has(entry.name)) {
        log(`条目重名，保留先出现的那个: ${entry.name} (${src})`)
        continue
      }
      seen.add(entry.name)
      items.push({ name: entry.name, type: 'skill', src, description: readSkillMeta(path.join(src, 'SKILL.md')).description || '' })
    }
  }
  return items
}

function exportTarget(target, cfg, log) {
  const root = path.join(target.repo.workdir, target.name)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })

  const items = []
  for (const item of collectSkills(target.skills, cfg, log)) items.push(item)
  for (const dir of target.dirs) {
    if (!fs.existsSync(dir)) {
      log(`目录不存在，跳过: ${dir}`)
      continue
    }
    items.push({ name: path.basename(dir), type: 'dir', src: dir })
  }
  for (const file of target.files) {
    if (!fs.existsSync(file)) {
      log(`文件不存在，跳过: ${file}`)
      continue
    }
    items.push({ name: path.basename(file), type: 'file', src: file })
  }

  const entries = []
  const used = new Set()
  for (const item of items) {
    if (used.has(item.name)) {
      log(`同一 target 内重名，跳过: ${item.name}`)
      continue
    }
    used.add(item.name)
    const dst = path.join(root, item.name)
    copyTree(item.src, dst, cfg)
    const digest = fs.statSync(dst).isDirectory() ? digestDir(dst) : digestFile(dst)
    entries.push({ name: item.name, type: item.type, ...(item.description ? { description: item.description } : {}), ...digest })
  }

  entries.sort((a, b) => a.name.localeCompare(b.name))
  return { root, entries }
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

async function scanSecrets(root, label, cfg, log) {
  const hits = []
  const files = []
  walkFiles(root, root, files)
  for (const rel of files) {
    const abs = path.join(root, rel)
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
  if (hits.length) log(`密钥扫描命中 ${hits.length} 处（策略 ${cfg.secretPolicy}）`)
  return hits
}

function writeIndex(repoDir, target, entries) {
  // 故意不写时间戳：index.json 必须内容稳定，否则每次同步都会产生一个空提交。
  const index = { generator: `dsh-vault@${VERSION}`, target: target.name, entries }
  fs.writeFileSync(path.join(repoDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')
  return index
}

// ---------------------------------------------------------------- 单个 target 同步

async function syncTarget(cfg, target, log) {
  const repo = target.repo
  if (!repo.url) return { name: target.name, status: 'unconfigured' }

  await ensureRepo(repo, log)
  const { root, entries } = exportTarget(target, cfg, log)

  const hits = await scanSecrets(root, target.name, cfg, log)
  if (hits.length && cfg.secretPolicy === 'block') {
    const detail = hits.map((h) => `${h.file} (${h.id})`).join('、')
    const err = new Error(`检测到疑似密钥，已中止推送：${detail}`)
    err.code = 'SECRET_DETECTED'
    err.hits = hits
    throw err
  }

  writeIndex(repo.workdir, target, entries)

  const status = await git(repo.workdir, ['status', '--porcelain'])
  if (!status.ok) throw new Error(`git status 失败: ${tail(status.stderr || status.message)}`)
  if (!status.stdout.trim()) return { name: target.name, status: 'up-to-date', count: entries.length, workdir: repo.workdir }

  await git(repo.workdir, ['add', '-A'])
  const stamp = new Date().toLocaleString('sv-SE').slice(0, 19)
  const message = `sync: ${stamp} · ${entries.length} ${target.name}`
  const commit = await git(repo.workdir, ['commit', '-m', message])
  if (!commit.ok) throw new Error(`git commit 失败: ${tail(commit.stderr || commit.message)}`)

  const push = await git(repo.workdir, ['push', '--set-upstream', repo.remote, repo.branch])
  if (!push.ok) {
    const err = new Error(`git push 失败: ${tail(push.stderr || push.message)}`)
    err.code = 'PUSH_FAILED'
    // 提交已经在本地，修好网络后重跑一次就能补推，不会重做提交。
    throw err
  }
  log(`已推送到 ${displayUrl(repo.url)} (${repo.remote}/${repo.branch}): ${message}`)
  return { name: target.name, status: 'pushed', count: entries.length, workdir: repo.workdir, message }
}

/**
 * 同步所有已配置的 target。单个失败不影响其它，结果里逐条报告。
 * @returns {{ status: string, targets: Array<object> }}
 */
export async function syncAll(rawConfig, { log = () => {}, only = null } = {}) {
  const cfg = normalizeConfig(rawConfig)
  const results = []
  for (const target of cfg.targets) {
    if (only && only !== target.name) continue
    try {
      results.push(await syncTarget(cfg, target, log))
    } catch (err) {
      results.push({
        name: target.name,
        status: 'failed',
        error: String(err && err.message ? err.message : err),
        code: err && err.code ? err.code : 'ERROR',
      })
    }
  }
  const failed = results.some((r) => r.status === 'failed')
  const changed = results.some((r) => r.status === 'pushed')
  const anyConfigured = results.some((r) => r.status !== 'unconfigured')
  const status = failed ? 'failed' : changed ? 'pushed' : anyConfigured ? 'up-to-date' : 'unconfigured'
  return { status, targets: results }
}

// ---------------------------------------------------------------- 状态

function stateFile() {
  return path.join(os.homedir(), '.dsh', 'vault-state.json')
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

async function guardedRun(ref, reason, log) {
  // ref.cfg 是活的引用：面板改完配置立刻生效，不必等下一次 HMR 重载。
  const cfg = ref.cfg
  if (!cfg.targets.some((t) => t.repo.url)) return { status: 'unconfigured', targets: [] }
  if (running) {
    log('上一次同步还没结束，本次跳过')
    return { status: 'busy', targets: [] }
  }
  running = (async () => {
    try {
      const result = await syncAll(cfg, { log })
      const patch = { lastRunAt: new Date().toISOString(), lastStatus: result.status, lastReason: reason, lastError: '' }
      for (const target of result.targets) patch[target.name] = target
      await writeState(patch)
      return result
    } catch (err) {
      const message = String(err && err.message ? err.message : err)
      console.error(`[vault] 同步失败: ${message}`)
      await writeState({ lastRunAt: new Date().toISOString(), lastStatus: 'failed', lastReason: reason, lastError: message })
      return { status: 'failed', targets: [], error: message }
    } finally {
      running = null
    }
  })()
  return running
}

function summarize(result) {
  if (!result || !result.targets || !result.targets.length) return result?.status || '无结果'
  return result.targets
    .map((target) => {
      if (target.status === 'pushed') return `${target.name}: 已推送 ${target.count} 条`
      if (target.status === 'up-to-date') return `${target.name}: 无变化`
      if (target.status === 'unconfigured') return `${target.name}: 未配置仓库`
      return `${target.name}: 失败 - ${target.error || ''}`
    })
    .join('\n')
}

async function registerTools(ctx, ref, log) {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') return
  let defineTool = null
  try {
    ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch {
    // 插件按裸 ESM 加载时可能解析不到宿主包，退化成普通对象注册。
    defineTool = (options) => options
  }

  const names = ref.cfg.targets.map((t) => t.name)

  const syncTool = defineTool({
    name: 'vault_sync',
    description:
      '立即把本地技能、用户/项目记忆、MCP 配置同步到配置好的私有 git 仓库并推送。用户说“备份一下”“同步到云端”“把技能和记忆传上去”时使用。',
    parameters: {
      target: { type: 'string', enum: names, description: `只同步其中一个 target（${names.join(' / ')}）；不传则全部同步。` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          summary: { type: 'string', required: true },
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
      const only = names.includes(args?.target) ? args.target : null
      const result = await guardedRun(ref, 'manual', log)
      const picked = only ? result.targets.filter((t) => t.name === only) : result.targets
      const failed = picked.find((t) => t.status === 'failed')
      return { status: failed ? 'failed' : result.status, summary: summarize({ ...result, targets: picked }), error: failed?.error || '' }
    },
  })

  const statusTool = defineTool({
    name: 'vault_status',
    description: '查看技能/记忆/配置同步的最近结果（时间、状态、错误）、各仓库地址以及下次自动同步时间。',
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
          targets: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => {
        const lines = [
          ...value.targets,
          `自动同步: ${value.enabled ? '开' : '关'}${value.nextRunAt ? ` (下次 ${value.nextRunAt})` : ''}`,
          `上次: ${value.lastStatus || '从未运行'}${value.lastRunAt ? ` @ ${value.lastRunAt}` : ''}`,
        ]
        if (value.lastError) lines.push(`错误: ${value.lastError}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const state = readState() || {}
      const cfg = ref.cfg
      const anyConfigured = cfg.targets.some((t) => t.repo.url)
      const nextRunAt = cfg.schedule.enabled && anyConfigured ? new Date(Date.now() + msUntil(cfg.schedule.time)).toISOString() : ''
      return {
        enabled: cfg.schedule.enabled === true,
        nextRunAt,
        lastRunAt: state.lastRunAt || '',
        lastStatus: state.lastStatus || '',
        lastError: state.lastError || '',
        targets: cfg.targets.map((t) => `${t.name}: ${t.repo.url ? displayUrl(t.repo.url) : '未配置'}`),
      }
    },
  })

  for (const tool of [syncTool, statusTool]) {
    try {
      ctx.tools.register(tool)
    } catch (err) {
      console.warn(`[vault] 注册工具 ${tool.name} 失败: ${err && err.message}`)
    }
  }
}

export function apply(ctx, config) {
  let timer = null
  let stopped = false
  let reschedule = () => {}
  const log = (message) => console.log(`[vault] ${message}`)
  let cfg
  try {
    cfg = normalizeConfig(config || {})
  } catch (err) {
    // 配置写错不能把整个 Host 拖下水：只报错，不注册任何东西。
    console.error(`[vault] 配置无效，插件未启用: ${err && err.message}`)
    return
  }

  // 面板写回配置后改的就是 ref.cfg：定时器和 agent 工具都读这份活引用。
  const ref = { cfg }

  const scheduleNext = () => {
    if (stopped || !ref.cfg.schedule.enabled) return
    if (!ref.cfg.targets.some((t) => t.repo.url)) return
    const delay = msUntil(ref.cfg.schedule.time)
    timer = setTimeout(async () => {
      await guardedRun(ref, 'schedule', log)
      scheduleNext()
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    log(`定时同步已开启，每天 ${ref.cfg.schedule.time}（下次 ${new Date(Date.now() + delay).toLocaleString()}）`)
  }
  reschedule = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!stopped) scheduleNext()
  }

  if (!ref.cfg.targets.some((t) => t.repo.url)) log('仓库地址还没配，定时同步不启动（补上配置后重启生效）')
  else scheduleNext()

  registerTools(ctx, ref, log).catch((err) => console.warn(`[vault] 工具注册跳过: ${err && err.message}`))
  mountPanel(ctx, ref, log, reschedule)

  const stop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
  if (typeof ctx?.effect === 'function') ctx.effect(() => stop)
  else process.on('exit', stop)
}

// ---------------------------------------------------------------- 面板接口

const API = {
  state: '/api/dsh-vault/state',
  sync: '/api/dsh-vault/sync',
  config: '/api/dsh-vault/config',
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** 只有本机能改配置、能触发同步：面板是同源页面，远端配对设备不该有这两个能力。 */
function isLoopback(req) {
  const addr = String(req.socket?.remoteAddress || '')
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.')
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

const yamlString = (value) => `'${String(value).replace(/'/g, "''")}'`

/** 面板保存时重新生成 bundle patch；结构固定，所以不需要通用 YAML 库。 */
function emitPatch(cfg) {
  const lines = [
    '# 由 dsh-vault 面板生成，也可以手改（改完 HMR 生效）。',
    '- insert:',
    '    - id: vault',
    "      name: 'dsh-vault'",
    '      config:',
    '        targets:',
  ]
  for (const target of cfg.targets) {
    lines.push(`          - name: ${yamlString(target.name)}`)
    lines.push('            repo:')
    lines.push(`              url: ${yamlString(target.repo.url)}`)
    lines.push(`              branch: ${yamlString(target.repo.branch)}`)
    lines.push(`              workdir: ${yamlString(target.repo.workdir)}`)
    if (target.skills.length) {
      lines.push('            skills:')
      for (const item of target.skills) lines.push(`              - ${yamlString(item)}`)
    }
    if (target.dirs.length) {
      lines.push('            dirs:')
      for (const item of target.dirs) lines.push(`              - ${yamlString(item)}`)
    }
    if (target.files.length) {
      lines.push('            files:')
      for (const item of target.files) lines.push(`              - ${yamlString(item)}`)
    }
    if (!target.skills.length && !target.dirs.length && !target.files.length) lines.push('            files: []')
  }
  lines.push('        schedule:')
  lines.push(`          enabled: ${cfg.schedule.enabled ? 'true' : 'false'}`)
  lines.push(`          time: ${yamlString(cfg.schedule.time)}`)
  lines.push(`        secretPolicy: ${yamlString(cfg.secretPolicy)}`)
  lines.push(`        maxFileBytes: ${cfg.maxFileBytes}`)
  return lines.join('\n') + '\n'
}

function panelState(ref) {
  const cfg = ref.cfg
  const state = readState() || {}
  const anyConfigured = cfg.targets.some((t) => t.repo.url)
  return {
    targets: cfg.targets.map((target) => ({
      name: target.name,
      url: displayUrl(target.repo.url),
      branch: target.repo.branch,
      workdir: target.repo.workdir,
      sources: target.skills.length + target.dirs.length + target.files.length,
      count: typeof state[target.name]?.count === 'number' ? state[target.name].count : null,
      status: state[target.name]?.status || '',
      error: state[target.name]?.error || '',
    })),
    schedule: { enabled: cfg.schedule.enabled, time: cfg.schedule.time },
    nextRunAt: cfg.schedule.enabled && anyConfigured ? new Date(Date.now() + msUntil(cfg.schedule.time)).toISOString() : '',
    lastRunAt: state.lastRunAt || '',
    lastStatus: state.lastStatus || '',
    lastError: state.lastError || '',
    secretPolicy: cfg.secretPolicy,
    busy: running !== null,
  }
}

/** 面板编辑只改「仓库地址 / 分支 / 时间 / 开关」，数据源目录由配置文件决定，避免误删。 */
function validatePanelInput(body) {
  for (const row of Array.isArray(body?.repos) ? body.repos : []) {
    const url = String(row?.url ?? '').trim()
    if (url && (/\s/.test(url) || !/[:/]/.test(url))) {
      throw new Error(`仓库地址看起来不对：${url}`)
    }
    const branch = String(row?.branch ?? '').trim()
    if (branch && /\s/.test(branch)) throw new Error(`分支名不能带空格：${branch}`)
  }
  const time = body?.schedule?.time
  if (time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) {
    throw new Error(`时间要写成 HH:mm（00:00–23:59），收到 ${JSON.stringify(time)}`)
  }
}

function mergePanelConfig(ref, body) {
  const byName = new Map((Array.isArray(body?.repos) ? body.repos : []).map((row) => [String(row?.name || ''), row]))
  const targets = ref.cfg.targets.map((target) => {
    const row = byName.get(target.name) || {}
    return {
      name: target.name,
      repo: {
        url: typeof row.url === 'string' && row.url.trim() ? row.url.trim() : target.repo.url,
        branch: typeof row.branch === 'string' && row.branch.trim() ? row.branch.trim() : target.repo.branch,
        workdir: target.repo.workdir,
        remote: target.repo.remote,
        token: target.repo.token,
      },
      skills: target.skills,
      dirs: target.dirs,
      files: target.files,
    }
  })
  return {
    targets,
    schedule: {
      enabled: body?.schedule?.enabled === true,
      time: typeof body?.schedule?.time === 'string' ? body.schedule.time : ref.cfg.schedule.time,
    },
    secretPolicy: ['block', 'mask'].includes(body?.secretPolicy) ? body.secretPolicy : ref.cfg.secretPolicy,
    maxFileBytes: ref.cfg.maxFileBytes,
  }
}

function panelRoutes(ref, log, reschedule) {
  return [
    {
      kind: 'exact',
      path: API.state,
      handler: async (req, res) => {
        if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        try {
          writeJson(res, 200, panelState(ref))
        } catch (err) {
          writeJson(res, 500, { error: String(err && err.message ? err.message : err) })
        }
      },
    },
    {
      kind: 'exact',
      path: API.sync,
      handler: async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'only the local machine may trigger a sync' })
        let body = {}
        try {
          body = await readJsonBody(req)
        } catch (err) {
          return writeJson(res, 400, { error: String(err.message) })
        }
        const wanted = typeof body?.target === 'string' ? body.target : null
        const result = await guardedRun(ref, 'panel', log)
        const picked = wanted ? result.targets.filter((t) => t.name === wanted) : result.targets
        writeJson(res, 200, {
          status: result.status,
          summary: summarize({ ...result, targets: picked }),
          targets: picked,
          state: panelState(ref),
        })
      },
    },
    {
      kind: 'exact',
      path: API.config,
      handler: async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'only the local machine may change the config' })
        let body = {}
        try {
          body = await readJsonBody(req)
        } catch (err) {
          return writeJson(res, 400, { error: String(err.message) })
        }
        let next
        try {
          validatePanelInput(body)
          next = normalizeConfig(mergePanelConfig(ref, body))
        } catch (err) {
          return writeJson(res, 400, { error: String(err && err.message ? err.message : err) })
        }
        const file = path.join(HERE, 'cordis.patch.yml')
        try {
          if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`)
          fs.writeFileSync(file, emitPatch(next), 'utf8')
        } catch (err) {
          return writeJson(res, 500, { error: `写配置失败: ${err && err.message}` })
        }
        ref.cfg = next
        reschedule()
        log('配置已保存（立即生效）')
        writeJson(res, 200, { ok: true, state: panelState(ref) })
      },
    },
  ]
}

function mountPanel(ctx, ref, log, reschedule) {
  let webServer
  try {
    webServer = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined
  } catch {
    webServer = undefined
  }
  if (!webServer) {
    try {
      webServer = ctx?.webServer
    } catch {
      webServer = undefined
    }
  }
  if (!webServer || typeof webServer.register !== 'function') {
    log('宿主没有 webServer 服务，面板接口未挂载（CLI 仍可用）')
    return
  }
  const disposers = []
  try {
    for (const route of panelRoutes(ref, log, reschedule)) disposers.push(webServer.register(route))
  } catch (err) {
    console.warn(`[vault] 面板路由注册失败: ${err && err.message}`)
    return
  }
  const dispose = () => {
    for (const d of disposers.splice(0)) {
      try {
        d()
      } catch {}
    }
  }
  if (typeof ctx?.effect === 'function') ctx.effect(() => dispose)
  log(`面板接口已挂载: ${API.state}`)
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
  const target = file ? path.resolve(expandHome(file)) : path.join(process.cwd(), 'vault.json')
  if (!fs.existsSync(target)) {
    throw new Error(`找不到配置文件 ${target}（把 vault.example.json 复制成 vault.json 再改）`)
  }
  return JSON.parse(fs.readFileSync(target, 'utf8'))
}

const HELP = `dsh-vault ${VERSION}

用法:
  node index.js sync   --config vault.json [--target skills|memory|mcp]   导出并 push
  node index.js status --config vault.json                                看上次结果与下次时间

配置字段见 README.md / vault.example.json。
`

export async function cli(argv) {
  const args = parseArgs(argv)
  const cmd = args._[0] || 'sync'
  if (cmd === 'help' || args.flags.help) {
    console.log(HELP)
    return
  }
  const cfg = normalizeConfig(loadConfigFile(args.flags.config))
  const log = (message) => console.log(`[vault] ${message}`)

  if (cmd === 'status') {
    const state = readState() || {}
    for (const target of cfg.targets) {
      console.log(`${target.name}: ${target.repo.url ? displayUrl(target.repo.url) : '未配置'} -> ${target.repo.workdir}`)
    }
    console.log(`自动同步: ${cfg.schedule.enabled ? `每天 ${cfg.schedule.time}` : '关'}`)
    console.log(`上次: ${state.lastStatus || '从未运行'}${state.lastRunAt ? ` @ ${state.lastRunAt}` : ''}`)
    if (state.lastError) console.log(`错误: ${state.lastError}`)
    return
  }
  if (cmd !== 'sync') throw new Error(`未知命令 ${cmd}（可用: sync / status）`)

  const only = cfg.targets.some((t) => t.name === args.flags.target) ? args.flags.target : null
  const result = await syncAll(cfg, { log, only })
  await writeState({ lastRunAt: new Date().toISOString(), lastStatus: result.status, lastReason: 'cli', lastError: '' })
  console.log(summarize(result))
  if (result.status === 'failed') process.exitCode = 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(`[vault] ${err && err.code ? `[${err.code}] ` : ''}${err && err.message ? err.message : err}`)
    process.exitCode = 1
  })
}
