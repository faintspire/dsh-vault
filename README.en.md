# dsh-skill-sync

English · [中文](README.md)

Backs up DSH **skills** (`SKILL.md` bundles) and **MCP configs** into two private Git repositories — once a day on a schedule, or on demand.

## Why

Skills live in two places (`~/.dsh/skills` and `~/.agents/skills`), MCP configs live in a third. Reinstalling, switching machines, or working across several computers means picking them all up by hand. This plugin turns that into one automatic Git commit per day, with real diffs, history and rollback.

## Features

- **Two repos, independent**: skills go to `dsh-skills`, MCP configs to `dsh-mcp`. A failure in one does not block the other.
- **Idempotent**: nothing changed means `up-to-date`, no empty commit (`index.json` deliberately carries no timestamp).
- **Secret scan**: `sk-`, `LTAI`, `AKIA`, `ghp_`, `BEGIN PRIVATE KEY`, long `Bearer` tokens abort that repo's push and name the offending file.
- **Deletions propagate**: the managed subdirectory is rebuilt on every run, so skills deleted locally disappear remotely too.
- **Index**: each repo root has an `index.json` with name, description, sha256, file count and bytes.
- **Three triggers**: daily schedule, the `skill_sync` agent tool, or the CLI.

## Install

```powershell
git clone https://github.com/faintspire/dsh-skill-sync.git
cd dsh-skill-sync
node scripts/install.mjs --profile desktop
```

The script adds a `link:` dependency to the profile, appends the package name to `dsh.profile.bundles`, and creates a junction (Windows) or symlink under `node_modules`. **A newly added bundle only loads after restarting DSH.**

## Configure

Edit `cordis.patch.yml` in this directory (it is the plugin's bundle patch; HMR picks up changes):

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

| Field | Meaning |
| --- | --- |
| `repos.*.url` | Leave empty to skip that repo silently |
| `repos.skills.roots` | Skill roots; only direct subdirectories containing `SKILL.md` are synced |
| `repos.mcp.files` | Absolute paths of MCP config files |
| `schedule.time` | 24-hour `HH:mm`, local time |
| `secretPolicy` | `block` aborts the push, `mask` replaces hits with `[REDACTED:xxx]` |
| `token` | Only for `https://` URLs; otherwise `DSH_SKILL_SYNC_TOKEN` is used |

SSH URLs are the easiest: they reuse your existing GitHub key, so no credential ever sits in the config.

## Run it

CLI (no Host required):

```powershell
node index.js sync   --config skill-sync.json
node index.js sync   --config skill-sync.json --repo skills
node index.js status --config skill-sync.json
```

`skill-sync.json` mirrors the `config` block above; copy `skill-sync.example.json` and edit.

Agent tools:

- `skill_sync` — sync now, optional `repo: skills | mcp`
- `skill_sync_status` — last result, last run, next scheduled run

## Repository layout

```
dsh-skills/                    dsh-mcp/
├── skills/                    ├── mcp/
│   ├── automate/SKILL.md      │   └── mcp.json
│   └── mcp-builder/…          └── index.json
└── index.json
```

`skills/` and `mcp/` are owned by the plugin and rebuilt every run. Files you write by hand at the repo root (`README.md`, `LICENSE`, …) are never touched.

## Privacy

- **Keep both repos private.** Skill documents routinely mention project names, module paths and internal conventions.
- The plugin only calls your local `git`; nothing goes through a third party.
- The secret scan is regex-based and can produce false positives. Switch `secretPolicy` to `mask`, or exclude the file, once you have confirmed it is safe.

## Verify

```powershell
node test/verify.mjs
```

Runs the whole chain against two local bare repos in a temp directory — first push into empty repos, idempotency, secret blocking, per-repo isolation, index shape, tool registration. No network access.

## Limitations

- One-way only (local → remote). A `pull`/restore path is not implemented yet; it needs a conflict policy first.
- The schedule only runs while the Host is up; missed days are not back-filled.
- One sync at a time; an overlapping run is skipped.
- Files above `maxFileBytes` (1 MB by default) are skipped.

## License

MIT
