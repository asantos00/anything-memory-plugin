import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const MEMORY_SYSTEM_HINT_MARKER = "anything-agent-memory-hint";
const PROVIDERS = Object.freeze(["mempalace"]);
const MEMORY_DEPLOY_DEFAULT_INTERVAL_MINUTES = 360;

const MEMORY_SKILL_CONTENT = `---
name: memory
description: Use when you need recall from prior work or to persist important decisions/outcomes for future sessions.
---

# Memory

Use \`anything-agent memory\` primitives to keep work compounding over time.

## Retrieval before substantial work

For non-trivial tasks, run a targeted memory search first:

\`anything-agent memory search . --query "<task context>" --json\`

Summarize relevant hits and use them in your plan.

## Retrieval when uncertain

If a fact is uncertain (names, prior decisions, why something changed), search memory before answering.

## Writeback after substantial work

When a task meaningfully changes context, persist memory:

- Drawer write:
  \`anything-agent memory write . --wing "project" --room "topic" --content "<decision/outcome>" --json\`
- Diary write:
  \`anything-agent memory write . --mode diary --agent-name "anything-agent" --topic "delivery" --entry "<summary>" --json\`

Keep writebacks concise and factual.
`;

const MEMPALACE_BRIDGE_SCRIPT = `
import json
import os
import traceback

payload = json.loads(os.environ.get("ANYTHING_AGENT_MEMORY_INPUT", "{}"))
operation = payload.get("operation")
config = payload.get("config") or {}

palace_path = config.get("palacePath")
if isinstance(palace_path, str) and palace_path.strip():
    os.environ["MEMPALACE_PALACE_PATH"] = palace_path.strip()


def emit(data):
    print(json.dumps(data, ensure_ascii=False))

try:
    from mempalace.mcp_server import tool_status, tool_search, tool_add_drawer, tool_diary_write

    if operation == "status":
        emit({"ok": True, "result": tool_status()})
    elif operation == "search":
        query = payload.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ValueError("search requires a non-empty query")
        limit = payload.get("limit")
        if not isinstance(limit, int):
            limit = 5
        wing = payload.get("wing") if isinstance(payload.get("wing"), str) else None
        room = payload.get("room") if isinstance(payload.get("room"), str) else None
        emit({"ok": True, "result": tool_search(query=query, limit=limit, wing=wing, room=room)})
    elif operation == "write":
        mode = payload.get("mode")
        if mode == "drawer":
            wing = payload.get("wing")
            room = payload.get("room")
            content = payload.get("content")
            if not isinstance(wing, str) or not wing.strip():
                raise ValueError("drawer write requires wing")
            if not isinstance(room, str) or not room.strip():
                raise ValueError("drawer write requires room")
            if not isinstance(content, str) or not content.strip():
                raise ValueError("drawer write requires content")
            emit({"ok": True, "result": tool_add_drawer(wing=wing, room=room, content=content, added_by="anything-agent")})
        elif mode == "diary":
            agent_name = payload.get("agentName")
            topic = payload.get("topic")
            entry = payload.get("entry")
            if not isinstance(agent_name, str) or not agent_name.strip():
                raise ValueError("diary write requires agentName")
            if not isinstance(topic, str) or not topic.strip():
                topic = "general"
            if not isinstance(entry, str) or not entry.strip():
                raise ValueError("diary write requires entry")
            emit({"ok": True, "result": tool_diary_write(agent_name=agent_name, topic=topic, entry=entry)})
        else:
            raise ValueError("write requires mode=drawer|diary")
    else:
        raise ValueError(f"unknown operation: {operation}")
except Exception as exc:
    emit({"ok": False, "error": str(exc), "trace": traceback.format_exc()})
`;

function parseFlags(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }

  return { positional, flags };
}

function stringFlag(flags, name) {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function booleanFlag(flags, name) {
  return flags[name] === true;
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asPositiveInt(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer '${value}'.`);
  }
  return parsed;
}

function asOptionalPositiveInt(value, fieldName) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return value;
}

function parseOptionalBooleanFlag(flags, name) {
  const value = flags[name];
  if (value === undefined) {
    return undefined;
  }
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }
  throw new Error(`Flag --${name} must be true or false.`);
}

function parseOptionalPositiveIntFlag(flags, name) {
  const value = flags[name];
  if (value === undefined) {
    return undefined;
  }
  if (value === true) {
    throw new Error(`Flag --${name} requires a numeric value.`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Flag --${name} must be a positive integer.`);
  }
  return parsed;
}

function defaultManifest() {
  return {
    version: 3,
    runtime: {
      env: {},
      defaults: {},
      events: {
        processing: {
          concurrency: 1,
          retryLimit: 3
        },
        sources: {}
      }
    },
    deploy: {
      defaultTarget: "production",
      targets: {
        production: {
          type: "sst",
          adapter: {
            type: "webhook"
          },
          provider: {
            type: "aws"
          },
          config: {
            stage: "production"
          }
        }
      }
    }
  };
}

function resolveProvider(providerId) {
  if (!PROVIDERS.includes(providerId)) {
    throw new Error(`Unknown memory provider '${providerId}'. Supported providers: ${PROVIDERS.join(", ")}`);
  }
  return providerId;
}

function normalizeMemoryDeployConfig(section, options = {}) {
  const deployEnabledDefault = options.deployEnabledDefault ?? true;
  if (section === undefined) {
    return {
      enabled: deployEnabledDefault,
      maintenance: {
        intervalMinutes: MEMORY_DEPLOY_DEFAULT_INTERVAL_MINUTES
      },
      ingestion: {
        enabled: false
      }
    };
  }

  const input = asRecord(section);
  if (!input) {
    throw new Error("manifest extension 'memory.config.deploy' must be an object.");
  }

  const enabled = input.enabled === undefined ? deployEnabledDefault : input.enabled;
  if (typeof enabled !== "boolean") {
    throw new Error("manifest extension 'memory.config.deploy.enabled' must be a boolean.");
  }

  const maintenanceInput = input.maintenance === undefined ? {} : input.maintenance;
  const maintenanceRecord = asRecord(maintenanceInput);
  if (!maintenanceRecord) {
    throw new Error("manifest extension 'memory.config.deploy.maintenance' must be an object.");
  }
  const intervalMinutes = asOptionalPositiveInt(
    maintenanceRecord.intervalMinutes ?? MEMORY_DEPLOY_DEFAULT_INTERVAL_MINUTES,
    "manifest extension 'memory.config.deploy.maintenance.intervalMinutes'"
  );

  const ingestionInput = input.ingestion === undefined ? {} : input.ingestion;
  const ingestionRecord = asRecord(ingestionInput);
  if (!ingestionRecord) {
    throw new Error("manifest extension 'memory.config.deploy.ingestion' must be an object.");
  }
  const ingestionEnabled = ingestionRecord.enabled === undefined ? false : ingestionRecord.enabled;
  if (typeof ingestionEnabled !== "boolean") {
    throw new Error("manifest extension 'memory.config.deploy.ingestion.enabled' must be a boolean.");
  }

  return {
    enabled,
    maintenance: {
      intervalMinutes
    },
    ingestion: {
      enabled: ingestionEnabled
    }
  };
}

function normalizeMemoryConfig(section) {
  if (section === undefined) {
    return {
      enabled: false,
      provider: "mempalace",
      config: {}
    };
  }

  const input = asRecord(section);
  if (!input) {
    throw new Error("manifest extension 'memory' must be an object.");
  }

  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== "boolean") {
    throw new Error("manifest extension 'memory.enabled' must be a boolean.");
  }

  const provider = input.provider === undefined ? "mempalace" : input.provider;
  if (typeof provider !== "string" || !provider.trim()) {
    throw new Error("manifest extension 'memory.provider' must be a non-empty string.");
  }

  const config = input.config === undefined ? {} : input.config;
  const configRecord = asRecord(config);
  if (!configRecord) {
    throw new Error("manifest extension 'memory.config' must be an object.");
  }

  if ("pythonCommand" in configRecord && typeof configRecord.pythonCommand !== "string") {
    throw new Error("manifest extension 'memory.config.pythonCommand' must be a string.");
  }
  if ("palacePath" in configRecord && typeof configRecord.palacePath !== "string") {
    throw new Error("manifest extension 'memory.config.palacePath' must be a string.");
  }
  if ("defaultAgentName" in configRecord && typeof configRecord.defaultAgentName !== "string") {
    throw new Error("manifest extension 'memory.config.defaultAgentName' must be a string.");
  }

  const normalizedDeployConfig = normalizeMemoryDeployConfig(configRecord.deploy, {
    deployEnabledDefault: enabled
  });

  return {
    enabled,
    provider,
    config: {
      ...configRecord,
      deploy: normalizedDeployConfig
    }
  };
}

function resolvePythonCommand(memoryConfig, flags) {
  return stringFlag(flags, "python-command") ??
    (typeof memoryConfig.config.pythonCommand === "string" && memoryConfig.config.pythonCommand.trim()
      ? memoryConfig.config.pythonCommand
      : "python3");
}

function resolvePalacePath(memoryConfig, flags) {
  const fromFlags = stringFlag(flags, "palace-path");
  if (fromFlags) {
    return fromFlags;
  }
  return typeof memoryConfig.config.palacePath === "string" && memoryConfig.config.palacePath.trim()
    ? memoryConfig.config.palacePath
    : undefined;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runProcess(command, args, context, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: context.cwd,
      env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({
        code: signal ? 1 : code ?? 0,
        stdout,
        stderr
      });
    });
  });
}

async function runPythonJson(pythonCommand, payload, context) {
  const result = await runProcess(
    pythonCommand,
    ["-c", MEMPALACE_BRIDGE_SCRIPT],
    context,
    {
      ...context.env,
      ANYTHING_AGENT_MEMORY_INPUT: JSON.stringify(payload)
    }
  );

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `python exited with code ${result.code}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`Failed to parse memory provider response: ${result.stdout.trim()}`);
  }

  const parsedRecord = asRecord(parsed);
  if (!parsedRecord) {
    throw new Error("Memory provider returned a non-object response.");
  }

  if (parsedRecord.ok !== true) {
    const providerError = typeof parsedRecord.error === "string" ? parsedRecord.error : "Unknown memory provider error.";
    throw new Error(providerError);
  }

  return asRecord(parsedRecord.result) ?? { result: parsedRecord.result };
}

async function readManifest(targetDir) {
  const manifestPath = path.join(targetDir, ".anything-agent", "manifest.json");
  if (!(await pathExists(manifestPath))) {
    return {
      path: manifestPath,
      manifest: defaultManifest()
    };
  }

  const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const parsedRecord = asRecord(parsed);
  if (!parsedRecord) {
    throw new Error(`Invalid manifest at ${manifestPath}.`);
  }

  return {
    path: manifestPath,
    manifest: parsedRecord
  };
}

function memoryConfigFromManifest(manifest) {
  const extensions = asRecord(manifest.extensions);
  return normalizeMemoryConfig(extensions?.memory);
}

async function ensureMemorySkill(targetDir) {
  const skillPath = path.join(targetDir, ".agents", "skills", "memory", "SKILL.md");
  if (await pathExists(skillPath)) {
    return "skipped";
  }
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, MEMORY_SKILL_CONTENT, "utf8");
  return "created";
}

async function ensureMemorySystemHint(targetDir) {
  const systemPath = path.join(targetDir, ".pi", "SYSTEM.md");
  if (!(await pathExists(systemPath))) {
    return "skipped";
  }

  const current = await fs.readFile(systemPath, "utf8");
  if (current.includes(MEMORY_SYSTEM_HINT_MARKER)) {
    return "skipped";
  }

  const hintBlock = `\n- [${MEMORY_SYSTEM_HINT_MARKER}] If memory is enabled in \`.anything-agent/manifest.json\` (\`extensions.memory.enabled=true\`), run memory recall before substantial tasks and write back key outcomes afterward using \`anything-agent memory ...\`.\n`;
  await fs.writeFile(systemPath, `${current.trimEnd()}${hintBlock}\n`, "utf8");
  return "updated";
}

async function enableMemory(targetDir, input) {
  const absoluteTargetDir = path.resolve(targetDir);
  const { path: manifestPath, manifest } = await readManifest(absoluteTargetDir);
  const extensions = asRecord(manifest.extensions) ? { ...manifest.extensions } : {};
  const previous = normalizeMemoryConfig(extensions.memory);

  const provider = resolveProvider(input.provider.trim());
  const previousDeployConfig = normalizeMemoryDeployConfig(previous.config.deploy, { deployEnabledDefault: true });
  const nextDeployConfig = {
    enabled: input.deployEnabled ?? previousDeployConfig.enabled,
    maintenance: {
      intervalMinutes: input.deployMaintenanceIntervalMinutes ?? previousDeployConfig.maintenance.intervalMinutes
    },
    ingestion: {
      enabled: input.deployIngestionEnabled ?? previousDeployConfig.ingestion.enabled
    }
  };
  const nextConfig = {
    ...previous.config,
    ...(input.pythonCommand ? { pythonCommand: input.pythonCommand } : {}),
    ...(input.palacePath ? { palacePath: input.palacePath } : {}),
    ...(input.defaultAgentName ? { defaultAgentName: input.defaultAgentName } : {}),
    deploy: nextDeployConfig
  };

  const nextMemoryConfig = {
    enabled: true,
    provider,
    config: nextConfig
  };

  extensions.memory = nextMemoryConfig;
  manifest.extensions = extensions;

  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const applied = [".anything-agent/manifest.json"];
  const skipped = [];

  const skillResult = await ensureMemorySkill(absoluteTargetDir);
  if (skillResult === "created") {
    applied.push(".agents/skills/memory/SKILL.md");
  } else {
    skipped.push(".agents/skills/memory/SKILL.md");
  }

  const hintResult = await ensureMemorySystemHint(absoluteTargetDir);
  if (hintResult === "updated") {
    applied.push(".pi/SYSTEM.md");
  } else {
    skipped.push(".pi/SYSTEM.md");
  }

  return {
    targetDir: absoluteTargetDir,
    applied,
    skipped,
    memory: nextMemoryConfig
  };
}

function printUsage(context) {
  context.stderr.write(
    "Usage: anything-agent memory <enable|doctor|status|search|write> [folder] [--provider <id>] [--python-command <cmd>] [--palace-path <path>] [--deploy-enabled <true|false>] [--deploy-maintenance-interval-minutes <n>] [--deploy-ingestion-enabled <true|false>] [--json]\\n"
  );
}

function isSstAwsLambdaTarget(resolvedTarget) {
  if (!resolvedTarget || !resolvedTarget.manifest || resolvedTarget.manifest.type !== "sst") {
    return false;
  }
  const provider = resolvedTarget.manifest.provider;
  if (!provider || provider.type !== "aws") {
    return false;
  }
  const providerConfig = asRecord(provider.config);
  const execution = providerConfig?.execution;
  if (execution === undefined || execution === "lambda") {
    return true;
  }
  return false;
}

function createMemoryDeployContribution() {
  return {
    id: "memory",
    summary: "Translate memory extension config into deploy intents for supported targets.",
    async collect(input) {
      const memory = memoryConfigFromManifest(input.manifest);
      if (!memory.enabled || memory.provider !== "mempalace") {
        return [];
      }

      const deploy = normalizeMemoryDeployConfig(memory.config.deploy, { deployEnabledDefault: true });
      if (!deploy.enabled) {
        return [];
      }
      if (!isSstAwsLambdaTarget(input.resolvedTarget)) {
        return [];
      }

      const intents = [
        {
          kind: "scheduled-task",
          plugin: "memory",
          id: "memory-maintenance",
          enabled: true,
          description: "Periodic memory maintenance to keep long-term context healthy.",
          prompt:
            "Perform memory maintenance for this agent. Consolidate and reconcile recent memory entries, remove obvious duplication, and keep memory state query-friendly.",
          promptSource: {
            type: "inline"
          },
          metadata: {
            plugin: "anything-memory-plugin",
            provider: memory.provider,
            task: "maintenance"
          },
          delivery: {
            kind: "default"
          },
          schedule: {
            kind: "every-minutes",
            intervalMinutes: deploy.maintenance.intervalMinutes
          }
        }
      ];

      if (deploy.ingestion.enabled) {
        intents.push({
          kind: "event-poller",
          plugin: "memory",
          source: "memory",
          enabled: true,
          description: "Poll configured memory ingestion source.",
          metadata: {
            plugin: "anything-memory-plugin",
            provider: memory.provider,
            task: "ingestion"
          },
          schedule: {
            kind: "every-minutes",
            intervalMinutes: deploy.maintenance.intervalMinutes
          }
        });
      }

      return intents;
    }
  };
}

function createMempalaceProvider() {
  return {
    id: "mempalace",
    async doctor(args, context) {
      const importProbe = await runProcess(
        args.pythonCommand,
        ["-c", "import mempalace; print('ok')"],
        context,
        {
          ...context.env,
          ...(args.palacePath ? { MEMPALACE_PALACE_PATH: args.palacePath } : {})
        }
      );

      return {
        provider: "mempalace",
        pythonCommand: args.pythonCommand,
        importOk: importProbe.code === 0,
        palacePath: args.palacePath ?? null,
        ...(importProbe.code === 0
          ? {}
          : {
              error: importProbe.stderr.trim() || importProbe.stdout.trim() || "mempalace import failed"
            })
      };
    },
    async status(args, context) {
      return await runPythonJson(
        args.pythonCommand,
        {
          operation: "status",
          config: {
            ...(args.palacePath ? { palacePath: args.palacePath } : {})
          }
        },
        context
      );
    },
    async search(args, context) {
      return await runPythonJson(
        args.pythonCommand,
        {
          operation: "search",
          query: args.query,
          limit: args.limit,
          wing: args.wing,
          room: args.room,
          config: {
            ...(args.palacePath ? { palacePath: args.palacePath } : {})
          }
        },
        context
      );
    },
    async write(args, context) {
      return await runPythonJson(
        args.pythonCommand,
        {
          operation: "write",
          ...args,
          config: {
            ...(args.palacePath ? { palacePath: args.palacePath } : {})
          }
        },
        context
      );
    }
  };
}

function createMemoryCommandPlugin() {
  const mempalace = createMempalaceProvider();

  return {
    namespace: "memory",
    summary: "Manage optional agent memory primitives with pluggable providers.",
    async run(args, context) {
      const [subcommand, ...rest] = args;
      const { positional, flags } = parseFlags(rest);
      const json = booleanFlag(flags, "json");
      const targetDir = path.resolve(context.cwd, positional[0] ?? ".");

      if (!subcommand || subcommand === "help" || subcommand === "--help") {
        printUsage(context);
        return subcommand ? 0 : 1;
      }

      if (subcommand === "enable") {
        const provider = stringFlag(flags, "provider") ?? "mempalace";
        const result = await enableMemory(targetDir, {
          provider,
          pythonCommand: stringFlag(flags, "python-command"),
          palacePath: stringFlag(flags, "palace-path"),
          defaultAgentName: stringFlag(flags, "agent-name"),
          deployEnabled: parseOptionalBooleanFlag(flags, "deploy-enabled"),
          deployMaintenanceIntervalMinutes: parseOptionalPositiveIntFlag(flags, "deploy-maintenance-interval-minutes"),
          deployIngestionEnabled: parseOptionalBooleanFlag(flags, "deploy-ingestion-enabled")
        });

        if (json) {
          context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          context.stdout.write(`Enabled memory for ${result.targetDir}\n`);
          context.stdout.write(`Provider: ${result.memory.provider}\n`);
          context.stdout.write(`Applied: ${result.applied.join(", ") || "(none)"}\n`);
          if (result.skipped.length > 0) {
            context.stdout.write(`Kept: ${result.skipped.join(", ")}\n`);
          }
        }
        return 0;
      }

      const { manifest } = await readManifest(targetDir);
      const memory = memoryConfigFromManifest(manifest);
      const provider = resolveProvider(memory.provider);
      const pythonCommand = resolvePythonCommand(memory, flags);
      const palacePath = resolvePalacePath(memory, flags);

      if (subcommand === "doctor") {
        const status = await mempalace.doctor({ pythonCommand, palacePath }, context);
        const payload = {
          targetDir,
          memoryEnabled: memory.enabled,
          provider,
          status
        };
        context.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return status.importOk === true ? 0 : 1;
      }

      if (!memory.enabled) {
        context.stderr.write("Memory is not enabled for this agent. Run: anything-agent memory enable <folder>\\n");
        return 1;
      }

      if (subcommand === "status") {
        const result = await mempalace.status({ pythonCommand, palacePath }, context);
        context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }

      if (subcommand === "search") {
        const query = stringFlag(flags, "query");
        if (!query) {
          throw new Error("Missing --query for memory search.");
        }
        const result = await mempalace.search(
          {
            pythonCommand,
            palacePath,
            query,
            limit: asPositiveInt(stringFlag(flags, "limit"), 5),
            wing: stringFlag(flags, "wing"),
            room: stringFlag(flags, "room")
          },
          context
        );
        context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }

      if (subcommand === "write") {
        const mode = stringFlag(flags, "mode") ?? "drawer";
        if (mode === "drawer") {
          const wing = stringFlag(flags, "wing");
          const room = stringFlag(flags, "room");
          const content = stringFlag(flags, "content");
          if (!wing || !room || !content) {
            throw new Error("Drawer write requires --wing, --room, and --content.");
          }
          const result = await mempalace.write(
            {
              mode: "drawer",
              pythonCommand,
              palacePath,
              wing,
              room,
              content
            },
            context
          );
          context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return 0;
        }

        if (mode === "diary") {
          const defaultAgentName = typeof memory.config.defaultAgentName === "string" && memory.config.defaultAgentName.trim()
            ? memory.config.defaultAgentName
            : path.basename(targetDir);
          const agentName = stringFlag(flags, "agent-name") ?? defaultAgentName;
          const topic = stringFlag(flags, "topic") ?? "general";
          const entry = stringFlag(flags, "entry") ?? stringFlag(flags, "content");
          if (!entry) {
            throw new Error("Diary write requires --entry (or --content).");
          }
          const result = await mempalace.write(
            {
              mode: "diary",
              pythonCommand,
              palacePath,
              agentName,
              topic,
              entry
            },
            context
          );
          context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return 0;
        }

        throw new Error("Invalid write mode. Use --mode drawer|diary.");
      }

      printUsage(context);
      return 1;
    }
  };
}

function createMemoryManifestExtension() {
  return {
    sectionKey: "memory",
    summary: "memory extension",
    validate(section) {
      normalizeMemoryConfig(section);
    },
    resolve(section) {
      const normalized = normalizeMemoryConfig(section);
      return {
        enabled: normalized.enabled,
        provider: normalized.provider,
        config: normalized.config
      };
    }
  };
}

export async function register(registry) {
  registry.registerCommand(createMemoryCommandPlugin());
  registry.registerManifestExtension(createMemoryManifestExtension());
  registry.registerCapability({
    kind: "deploy-contribution",
    id: "memory",
    summary: "memory deploy contribution",
    value: createMemoryDeployContribution()
  });
}

export default register;
