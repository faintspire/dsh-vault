# dsh-vault

English · [中文](README.md)

Backs up the **skills**, **memory** and **MCP configs** of your DSH setup into your own private Git repositories — once a day on a schedule, or on demand.

## Why "vault"

Not because it encrypts anything, but because everything that makes this agent *yours* ends up in one place you can diff, roll back, and carry to another machine.

## What it covers

| target | Contents | Default locations |
| --- | --- | --- |
| `skills` | Skill bundles (`SKILL.md` plus sibling scripts and references) | `~/.dsh/skills`, `~/.agents/skills` |
| `memory` | User profile `USER.md`, working memory `MEMORY.md`, project documents | `~/.mnemon/runtime`, `~/.mnemon/documents` |
| `mcp` | MCP server configs | whatever you list in `files` |

One target, one repository: skills to `dsh-skills`, memory to `dsh-memory`, MCP to `dsh-mcp`. A failure in one never blocks the others.

## Features

- **Independent targets**: separate clones, commits and failures.
- **Idempotent**: nothing changed means `up-to-date`, no empty commit (`index.json` deliberately carries no timestamp).
- **Secret scan**: `sk-`, `LTAI`, `AKIA`, `ghp_`, `BEGIN PRIVATE KEY`, long `Bearer` tokens abort that repo's push and name the file.
- **Deletions propagate**: the managed `<target>/` directory is rebuilt every run.
- **Index**: each repo root has an `index.json` with type, sha256, file count and bytes (skills also carry their description).
- **Three triggers**: daily schedule, the `vault_sync` tool, or the CLI.

## Install

```powershell
git clone https://github.com/faintspire/dsh-vault.git
# Over HTTPS GitHub is often reset from mainland China; SSH is steadier:
# git clone git@github.com:faintspire/dsh-vault.git
cd dsh-vault
node scripts/install.mjs --profile desktop
```

The script adds a `link:` dependency, appends `dsh-vault` to `dsh.profile.bundles`, and creates a junction (Windows) or symlink under `node_modules`. **A new bundle only loads after restarting DSH.**

## Panel

Once installed, a **Cloud backup** row appears in the sidebar:

- repo URL, branch, last status and item count per target, with **Test** and **Sync now** buttons
- **Git identity**: committer name, email and SSH private key path — hit Test to prove the key can reach the remote
- the daily-schedule switch and time
- **Save**: writes back to the plugin's own `cordis.patch.yml`, keeping a `.bak-<timestamp>` copy

Source directories (`skills` / `dirs` / `files`) are deliberately **not** editable in the panel — that keeps a slip of the mouse from emptying the backup set. They stay in the config file.

Behind the panel are four routes on the host's own `webServer`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/dsh-vault/state` | config (incl. git identity and whether the key exists), last result, next run |
| POST | `/api/dsh-vault/sync` | run a sync, body may carry `{ "target": "memory" }` |
| POST | `/api/dsh-vault/config` | save URLs / branches / time / switch / git identity |
| POST | `/api/dsh-vault/test` | run `git ls-remote` with the configured key to check connectivity |

All three POST routes accept loopback requests only, and invalid input returns 400 without touching the stored config: a time of `99:99`, an email without `@`, or a key path that does not exist are all rejected.

> The panel is the client half; the first install (or any change to `dsh.client`) needs one DSH restart, because the client asset roster is built at boot. Afterwards HMR covers code edits.


## Configure

Edit `cordis.patch.yml` in this directory:

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

| Field | Meaning |
| --- | --- |
| `targets[].name` | kebab-case; also the managed subdirectory name inside the repo |
| `targets[].repo.url` | Empty skips that target silently |
| `targets[].skills` | Skill roots; every direct subdirectory containing `SKILL.md` is one bundle |
| `targets[].dirs` | Whole directories copied verbatim (this is what memory uses) |
| `targets[].files` | Individual files (MCP configs) |
| `schedule.time` | 24-hour `HH:mm`, local time |
| `secretPolicy` | `block` aborts the push, `mask` replaces hits with `[REDACTED:xxx]` |
| `git.userName` / `git.userEmail` | Committer identity; empty falls back to `git config --global` |
| `git.sshKeyPath` | Private key used for pushes; empty falls back to the default key and `~/.ssh/config` |
| `token` | Only for `https://` URLs; otherwise `DSH_VAULT_TOKEN` |

`git.sshKeyPath` works by injecting `GIT_SSH_COMMAND=ssh -i <key> -o IdentitiesOnly=yes`, so another key sitting in ssh-agent cannot win; Host/Port rewrites in `~/.ssh/config` (e.g. github.com over 443) still apply.

Adding a fourth category (say, some plugin's config) needs no code change: add a target with `files` or `dirs`.

## Run it

```powershell
node index.js sync   --config vault.json
node index.js sync   --config vault.json --target memory
node index.js status --config vault.json
```

`vault.json` mirrors the `config` block above; copy `vault.example.json`.

Agent tools:

- `vault_sync` — sync now, optional `target: skills | memory | mcp`
- `vault_status` — repo URLs, last result, next scheduled run

## Repository layout

```
dsh-skills/                       dsh-memory/                      dsh-mcp/
├── skills/                       ├── memory/                      ├── mcp/
│   ├── automate/SKILL.md         │   ├── runtime/                 │   └── (empty)
│   └── mcp-builder/…             │   │   ├── memories.json        └── index.json
└── index.json                    │   │   ├── MEMORY.md
                                  │   │   └── USER.md
                                  │   └── documents/
                                  │       ├── active/*.md
                                  │       └── index.json
                                  └── index.json
```

`<target>/` is owned by the plugin and rebuilt every run. Hand-written files at the repo root (`README.md`, `LICENSE`, …) are never touched.

## Privacy

- **Keep every repo private.** Skill documents mention project names and internal paths; memory holds your personal preferences and project decisions.
- The plugin only calls your local `git`; nothing goes through a third party.
- The secret scan is regex-based and can produce false positives. Switch `secretPolicy` to `mask`, or exclude the file.
- `.mnemon/skills` (eval trajectories and ledger) is **deliberately excluded**: tens of megabytes that only make sense on this machine.

## Verify

```powershell
node test/verify.mjs
```

Runs the whole chain against three local bare repos in a temp directory: first push, idempotency, per-target failure isolation, secret blocking and recovery, `only` filtering, index shape, and a malformed config not taking the Host down. No network access.

## Limitations

- One-way only (local → remote). A `pull`/restore path is not implemented yet.
- The schedule only runs while the Host is up; missed days are not back-filled.
- One sync at a time; an overlapping run is skipped.
- Files above `maxFileBytes` (1 MB by default) are skipped.

## License

MIT
