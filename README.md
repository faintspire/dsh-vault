# dsh-vault

[English](README.en.md) · 中文

把 DSH 的**技能**、**记忆**、**MCP 配置**分别同步到你自己的私有 Git 仓库：每天固定时刻自动推一次，也可以随时手动推。

## 为什么叫 vault

"保险库"不是指加密，而是指**只进不出、随时能翻旧账**：所有让这个 agent 变成"你的 agent"的东西，都收在一个能被 diff、能被回滚、能搬到另一台机器的地方。

## 它管哪些东西

| target | 内容 | 默认位置 |
| --- | --- | --- |
| `skills` | 技能包（`SKILL.md` 及其同目录的脚本、参考资料） | `~/.dsh/skills`、`~/.agents/skills` |
| `memory` | 用户画像 `USER.md`、工作记忆 `MEMORY.md`、项目文档 | `~/.mnemon/runtime`、`~/.mnemon/documents` |
| `mcp` | MCP 服务器配置 | 自己填 `files` |

每个 target 对应**一个独立仓库**：技能推 `dsh-skills`，记忆推 `dsh-memory`，MCP 推 `dsh-mcp`。一个仓库出问题不影响另一个。

## 特性

- **一 target 一仓库**：各自克隆、各自提交、各自失败，互不牵连。
- **幂等**：内容没变就报 `up-to-date`，不产生空提交（`index.json` 里故意不写时间戳）。
- **密钥扫描**：`sk-`、`LTAI`、`AKIA`、`ghp_`、`BEGIN PRIVATE KEY`、长 `Bearer` 命中就中止该仓库的推送，并指出文件。
- **删除也同步**：每次先清空被管理的 `<target>/` 再重建，本地删掉的东西远端不会残留。
- **索引**：每个仓库根 `index.json` 记录条目的类型、sha256、文件数、字节数（技能还带描述）。
- **三种触发**：每天定时、agent 调 `vault_sync`、命令行手动。

## 安装

```powershell
git clone https://github.com/faintspire/dsh-vault.git
# 国内走 HTTPS 连 GitHub 常被 reset，SSH 更稳：
# git clone git@github.com:faintspire/dsh-vault.git
cd dsh-vault
node scripts/install.mjs --profile desktop
```

脚本会：在 profile 的 `dependencies` 写 `link:` 指向本目录、把 `dsh-vault` 加进 `dsh.profile.bundles`、在 `node_modules` 下建 junction（Windows）或 symlink。**新增 bundle 要重启 DSH 才生效。**

## 配置

编辑本目录的 `cordis.patch.yml`（配置就是插件的 bundle patch，改完 HMR 生效）：

```yaml
- insert:
    - id: vault
      name: 'dsh-vault'
      config:
        targets:
          - name: skills
            repo:
              url: 'git@github.com:you/dsh-skills.git'
              workdir: '~/.dsh/vault/dsh-skills'
            skills: ['~/.dsh/skills', '~/.agents/skills']

          - name: memory
            repo:
              url: 'git@github.com:you/dsh-memory.git'
              workdir: '~/.dsh/vault/dsh-memory'
            dirs: ['~/.mnemon/runtime', '~/.mnemon/documents']

          - name: mcp
            repo:
              url: 'git@github.com:you/dsh-mcp.git'
              workdir: '~/.dsh/vault/dsh-mcp'
            files: []
        schedule:
          enabled: true
          time: '03:30'
        secretPolicy: 'block'
```

| 字段 | 说明 |
| --- | --- |
| `targets[].name` | kebab-case，同时是仓库里那个被管理子目录的名字 |
| `targets[].repo.url` | 留空则该 target 跳过，其它照跑 |
| `targets[].skills` | 技能根目录：每个含 `SKILL.md` 的直接子目录算一个技能包 |
| `targets[].dirs` | 整棵目录原样复制（记忆用的就是它） |
| `targets[].files` | 单个文件（MCP 配置用） |
| `schedule.time` | 24 小时制 `HH:mm`，本地时间 |
| `secretPolicy` | `block` 中止推送 / `mask` 替换成 `[REDACTED:xxx]` 后继续 |
| `token` | 仅 `https://` 地址需要；留空读环境变量 `DSH_VAULT_TOKEN` |

要加第四类东西（比如某个插件配置），不用改代码：加一个 target，配 `files` 或 `dirs` 就行。

## 手动同步

```powershell
node index.js sync   --config vault.json
node index.js sync   --config vault.json --target memory
node index.js status --config vault.json
```

`vault.json` 的字段和上面的 `config` 完全一致，从 `vault.example.json` 复制一份改。

给 agent 用的工具：

- `vault_sync` — 立即同步，可选 `target: skills | memory | mcp`
- `vault_status` — 各仓库地址、上次结果、下次自动同步时间

## 仓库长什么样

```
dsh-skills/                       dsh-memory/                      dsh-mcp/
├── skills/                       ├── memory/                      ├── mcp/
│   ├── automate/SKILL.md         │   ├── runtime/                 │   └── (空)
│   └── mcp-builder/…             │   │   ├── memories.json        └── index.json
└── index.json                    │   │   ├── MEMORY.md
                                  │   │   └── USER.md
                                  │   └── documents/
                                  │       ├── active/*.md
                                  │       └── index.json
                                  └── index.json
```

`<target>/` 由插件全权管理（每次重建）；`README.md`、`LICENSE` 这类手写文件放仓库根，不会被碰。

## 隐私

- **仓库必须私有**。技能文档带项目名和内部路径，记忆里有你的个人偏好和项目决策。
- 插件只调本机 `git`，不经过任何第三方服务。
- 密钥扫描是正则，会误报。确认误报就把 `secretPolicy` 改成 `mask`，或者把该文件移出同步范围。
- `.mnemon/skills`（评测轨迹、ledger）**故意不同步**：几十 MB，而且只对本机有意义。

## 验收

```powershell
node test/verify.mjs
```

用临时目录里的三个本地 bare 仓库当远端跑完整链路：首推、幂等、单 target 失败隔离、密钥拦截与恢复、`only` 过滤、index 结构、配置写错不影响 Host。不联网。

## 已知边界

- 只做「本机 → 远端」单向推送，恢复（`pull`）还没做。
- 定时只在 Host 运行时生效；Host 没开的那天不补跑。
- 同一时刻只允许一个同步任务，重叠的直接跳过。
- 单文件超过 `maxFileBytes`（默认 1 MB）会被跳过。

## License

MIT
