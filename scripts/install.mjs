#!/usr/bin/env node
/**
 * 把本仓库登记进 DSH profile：dependencies 的 link: 条目、dsh.profile.bundles、node_modules 链接。
 * 用法：node scripts/install.mjs [--profile desktop] [--source <本目录>] [--dry-run]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function parseArgs(argv) {
  const out = { flags: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out.flags[key] = next
      i += 1
    } else out.flags[key] = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const profile = typeof args.flags.profile === 'string' ? args.flags.profile : 'desktop'
const source = path.resolve(typeof args.flags.source === 'string' ? args.flags.source : HERE)
const dryRun = args.flags['dry-run'] === true

const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
const name = pkg.name
if (!name) throw new Error(`package.json 缺 name: ${source}`)

const profilesDir = path.join(os.homedir(), '.dsh', 'profiles')
const profileDir = path.join(profilesDir, profile)
const profilePkgPath = path.join(profileDir, 'package.json')
if (!fs.existsSync(profilePkgPath)) {
  const known = fs.existsSync(profilesDir) ? fs.readdirSync(profilesDir).join(', ') : '(无)'
  throw new Error(`找不到 profile: ${profileDir}\n可用的 profile: ${known}`)
}

const profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
profilePkg.dependencies = profilePkg.dependencies || {}
profilePkg.dsh = profilePkg.dsh || {}
profilePkg.dsh.profile = profilePkg.dsh.profile || {}
profilePkg.dsh.profile.bundles = profilePkg.dsh.profile.bundles || []

const linkValue = `link:${source.replace(/\\/g, '/')}`
const changes = []

if (profilePkg.dependencies[name] !== linkValue) {
  profilePkg.dependencies[name] = linkValue
  changes.push(`dependencies["${name}"] = "${linkValue}"`)
}
if (!profilePkg.dsh.profile.bundles.includes(name)) {
  profilePkg.dsh.profile.bundles.push(name)
  changes.push(`dsh.profile.bundles += "${name}"`)
}

if (changes.length && !dryRun) {
  fs.writeFileSync(profilePkgPath, JSON.stringify(profilePkg, null, 2) + '\n', 'utf8')
}

const nodeModules = path.join(profileDir, 'node_modules')
const linkPath = path.join(nodeModules, name)
let linkNote = ''
if (fs.existsSync(linkPath)) {
  const current = (() => {
    try {
      return fs.realpathSync(linkPath)
    } catch {
      return ''
    }
  })()
  if (current && path.resolve(current) === path.resolve(source)) linkNote = '已存在，指向本目录'
  else linkNote = `已存在但指向别处（${current || '无法解析'}），未改动；需要就先删掉再跑一次`
} else if (!dryRun) {
  fs.mkdirSync(nodeModules, { recursive: true })
  fs.symlinkSync(source, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  linkNote = '已创建'
} else {
  linkNote = '将创建'
}

console.log(`profile : ${profileDir}`)
console.log(`包名    : ${name}`)
console.log(`源码    : ${source}`)
console.log(`配置改动: ${changes.length ? changes.join('; ') : '无（已经登记过）'}${dryRun ? '  [dry-run]' : ''}`)
console.log(`链接    : ${linkPath} -> ${linkNote}`)
console.log('\n下一步：重启 DSH 让新 bundle 生效，然后编辑 cordis.patch.yml 填仓库地址。')
