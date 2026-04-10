# Anything Memory Plugin

Pluggable `memory` primitive for `anything-agent`.

This is a standalone plugin repo (not `anything-agent` core) so memory remains optional and provider-pluggable.

## Philosophy

- optional primitive, enabled per agent
- CLI/text-first behavior
- provider-pluggable backend (`mempalace` in v1)
- no MCP dependency in the host integration contract
- deploy-aware via plugin-owned deploy intents (no core patch required)

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
- sets deploy defaults under `extensions.memory.config.deploy`:
  - `enabled: true`
  - `maintenance.intervalMinutes: 360`
  - `ingestion.enabled: false`

You can override deploy settings during enable:

```bash
anything-agent memory enable ./my-agent \
  --deploy-enabled true \
  --deploy-maintenance-interval-minutes 360 \
  --deploy-ingestion-enabled false
```

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

## Deployment-aware behavior

The plugin registers a deploy contribution (`kind: "deploy-contribution", id: "memory"`).

Deploy intents are emitted only when all are true:

- `extensions.memory.enabled === true`
- `extensions.memory.provider === "mempalace"`
- deploy target resolves to AWS Lambda path (`sst` target with AWS provider and non-`fargate` execution)

For supported targets:

- always emits a `scheduled-task` maintenance intent (`every-minutes`, default 360)
- emits an `event-poller` intent only when `extensions.memory.config.deploy.ingestion.enabled === true`

For unsupported targets (`vps`, `fargate`, or non-AWS/non-lambda paths), it emits no memory intents.

## Tests

```bash
npm test
```
