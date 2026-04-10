# Anything Memory Plugin

Pluggable `memory` primitive for `anything-agent`.

This is a standalone plugin repo (not `anything-agent` core) so memory remains optional and provider-pluggable.

## Philosophy

- optional primitive, enabled per agent
- CLI/text-first behavior
- provider-pluggable backend (`mempalace` in v1)
- no MCP dependency in the host integration contract

## Install

Point your agent repo to this local plugin module via `.anything-agent/plugins.json`:

```json
{
  "version": 1,
  "plugins": [
    {
      "module": "../anything-memory-plugin/plugin.mjs"
    }
  ]
}
```

## Enable For An Agent

```bash
anything-agent memory enable ./my-agent
```

This command:

- writes `manifest.extensions.memory`
- installs `.agents/skills/memory/SKILL.md` if missing
- appends a minimal memory usage hint to `.pi/SYSTEM.md` if missing

## Commands

```bash
anything-agent memory doctor ./my-agent --json
anything-agent memory status ./my-agent --json
anything-agent memory search ./my-agent --query "prior decision" --json
anything-agent memory write ./my-agent --wing "project" --room "auth" --content "Switched to token rotation." --json
anything-agent memory write ./my-agent --mode diary --agent-name "my-agent" --topic "delivery" --entry "Shipped memory integration." --json
```

## Provider

V1 provider: `mempalace`.

`doctor` checks availability and returns actionable errors if Python or `mempalace` are not available.

## Tests

```bash
npm test
```
