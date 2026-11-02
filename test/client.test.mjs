/**
 * 客户端半边（lib/client.js）的结构验收：不启动浏览器，用假的 __ModuleLoader__ / React / slots
 * 跑一遍注册流程，确认它会往 sidebar.panellist 和 main 各注册一项。
 * 运行：node test/client.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'lib', 'client.js')

let failures = 0
function check(cond, label, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' :: ' + extra : ''}`)
  if (!cond) failures += 1
}

// ---- 假的浏览器环境
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(options) {
      loaded = options
    },
  },
}

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  Fragment: "Fragment",
}

const requireStub = (id) => {
  if (id === 'react') return fakeReact
  throw new Error(`unexpected require: ${id}`)
}

await import(pathToFileURL(CLIENT).href)

check(loaded !== null, 'client.js 调用了 window.__ModuleLoader__.load')
check(loaded && loaded.id === 'dsh-vault', '模块 id 是包名', loaded ? loaded.id : '')

const client = loaded.factory(requireStub)
check(typeof client.apply === 'function', '导出了 apply')
check(Array.isArray(client.inject) && client.inject.includes('slots'), 'inject 声明了 slots', JSON.stringify(client.inject))

// ---- 假的客户端 context
const registrations = []
const injected = []
const ctx = {
  slots: {
    register(spec, component) {
      registrations.push({ spec, component })
      return () => {}
    },
    inject(seat, callback) {
      injected.push(seat)
      return typeof callback === 'function' ? callback() : () => {}
    },
  },
  effect(fn) {
    const dispose = fn()
    check(typeof dispose === 'function', 'apply 注册了清理函数')
  },
}

client.apply(ctx)

check(injected.includes('sidebar.panellist'), '先等 sidebar.panellist 这个座位', injected.join(','))
check(registrations.length === 2, '注册了侧边栏行 + 主页面两处', String(registrations.length))

const row = registrations.find((r) => r.spec.name === 'sidebar.panellist')
const page = registrations.find((r) => r.spec.name === 'main')

check(row && row.spec.id === 'vault', '侧边栏行 id 是 vault')
check(row && typeof row.spec.label === 'function' && row.spec.label() === '云端备份', '侧边栏行文案是「云端备份」')
check(row && typeof row.component === 'function', '侧边栏图标是组件')
check(page && page.spec.key === 'vault', '主页面的 key 与行 id 相同（点击才会切过去）')
check(page && typeof page.component === 'function', '主页面是组件')

// ---- 页面组件不是空函数
const src = fs.readFileSync(CLIENT, 'utf8')
check(src.includes('api/dsh-vault/state'), '页面会读 api/dsh-vault/state')
check(src.includes('api/dsh-vault/sync'), '页面会调 api/dsh-vault/sync')
check(src.includes('api/dsh-vault/config'), '页面会写 api/dsh-vault/config')
check(src.includes('api/dsh-vault/test'), '页面会调 api/dsh-vault/test 验证连通性')
check(src.includes('sshKeyPath'), '面板有 SSH 私钥输入框')
check(src.includes('userEmail'), '面板有提交者邮箱输入框')
check(!/^import\s/m.test(src), '没有裸 import（必须走 require，模块加载器只认这个）')

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
