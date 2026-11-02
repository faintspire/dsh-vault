# dsh-skill-sync

[English](README.en.md) · 中文

把 DSH 的**技能**（`SKILL.md` 技能包）和 **MCP 配置**分别同步到两个私有 Git 仓库：每天固定时刻自动跑一次，也可以随时手动推。

## 它解决什么问题

技能散落在 `~/.dsh/skills` 和 `~/.agents/skills` 两个目录，MCP 配置又是另一份文件。换机器、重装系统、或者同时用几台电脑时，这些东西得靠手工捡回来。这个插件把「备份」变成一条每天自动执行的 Git 提交，同时保留完整的 diff 和回滚能力。

## 特性

- **分仓**：技能推 `dsh-skills`，MCP 推 `dsh-mcp`，互不干扰，一个失败不影响另一个。
- **幂等**：内容没变就报 `up-to-date`，不产生空提交（`index.json` 里故意不写时间戳）。
- **密钥扫描**：`sk-`、`LTAI`、`AKIA`、`ghp_`、`BEGIN PRIVATE KEY`、长 `Bearer` 命中就中止该仓库的推送，并指出是哪个文件。
- **删除也同步**：每次先清空被管理的子目录再重建，本地删掉的技能远端不会残留。
- **索引**：每个仓库根目录有 `index.json`，记录名称、描述、sha256、文件数和字节数，方便肉眼比差异。
- **三种触发**：每天定时、agent 调 `skill_sync`、命令行手动。

## 安装

```powershell
git clone https://github.com/faintspire/dsh-skill-sync.git
cd dsh-skill-sync
node scripts/install.mjs --profile desktop
```

脚本会做三件事：在 profile 的 `dependencies` 里写 `link:` 指向本目录、把包名加进 `dsh.profile.bundles`、在 `node_modules` 下建 junction（Windows）或 symlink。**新增 bundle 要重启 DSH 才生效。**

想手工装也行，就是上面三处各改一次，参考 `~/.dsh/profiles/desktop/package.json` 里 `dsh-lan-share` 的写法。

## 配置

装好后编辑本目录的 `cordis.patch.yml`（配置就是插件的 bundle patch，改完 HMR 生效）：

```yaml
- insert:
    - id: skill-sync
      name: 'dsh-skill-sync'
      config:
        repos:
          skills:
            url: 'git@github.com:you/dsh-skills.git'
            branch: 'main'
            workdir: '~/.dsh/skill-sync/dsh-skills'
            roots:
              - '~/.dsh/skills'
              - '~/.agents/skills'
          mcp:
            url: 'git@github.com:you/dsh-mcp.git'
            branch: 'main'
            workdir: '~/.dsh/skill-sync/dsh-mcp'
            files: ['~/.dsh/mcp.json']
        schedule:
          enabled: true
          time: '03:30'
        secretPolicy: 'block'
```

| 字段 | 说明 |
| --- | --- |
| `repos.skills.url` / `repos.mcp.url` | 留空则该仓库跳过，不会报错 |
| `repos.skills.roots` | 技能根目录，只同步**直接子目录**里含 `SKILL.md` 的 |
| `repos.mcp.files` | MCP 配置文件绝对路径，可多个 |
| `schedule.time` | 24 小时制 `HH:mm`，每天这个点跑 |
| `secretPolicy` | `block` 中止推送 / `mask` 替换成 `[REDACTED:xxx]` 后继续 |
| `token` | 仅 `https://` 地址需要；留空则读环境变量 `DSH_SKILL_SYNC_TOKEN` |

SSH 地址最省事：直接复用本机已有的 GitHub key，不用在配置里放任何凭据。

## 手动同步

命令行（不需要 Host 在跑）：

```powershell
node index.js sync   --config skill-sync.json
node index.js sync   --config skill-sync.json --repo skills
node index.js status --config skill-sync.json
```

`skill-sync.json` 的字段和上面的 `config` 完全一致，从 `skill-sync.example.json` 复制一份改。

给 agent 用的工具：

- `skill_sync` — 立即同步，可选 `repo: skills | mcp` 只同步一个
- `skill_sync_status` — 上次结果、上次时间、下次自动同步时间

## 仓库长什么样

```
dsh-skills/                    dsh-mcp/
├── skills/                    ├── mcp/
│   ├── automate/SKILL.md      │   └── mcp.json
│   └── mcp-builder/…          └── index.json
└── index.json
```

`skills/` 和 `mcp/` 由插件全权管理（每次重建）；`README.md`、`LICENSE` 这类手写文件放在仓库根，不会被碰。

## 隐私

- **仓库必须是私有的**。技能文档里通常带项目名、模块路径、内部约定。
- 插件只走本机 `git`，不经过任何第三方服务。
- 密钥扫描是正则，会误报。确认是误报就把 `secretPolicy` 改成 `mask`，或者把该文件排除在同步范围外。

## 验收

```powershell
node test/verify.mjs
```

用临时目录里的两个本地 bare 仓库当远端，跑完整链路：首推空仓库、幂等、密钥拦截、单仓失败不影响另一仓、index 结构、工具注册。全程不联网。

## 已知边界

- 只做「本机 → 远端」单向推送。从远端恢复到本机的 `pull` 还没做（要先定覆盖策略）。
- 定时只在 Host 运行时生效；Host 没开的那天不补跑。
- 同一时刻只允许一个同步任务，重叠的会直接跳过。
- 单文件超过 `maxFileBytes`（默认 1 MB）会被跳过。

## License

MIT
