import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { register } from "../plugin.mjs";

function createWritableCapture() {
  const chunks = [];
  return {
    stream: {
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      }
    },
    read() {
      return chunks.join("");
    }
  };
}

async function createAgentDir(prefix = "anything-memory-plugin-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(path.join(dir, "AGENTS.md"), "# Agent\n", "utf8");
  await fs.mkdir(path.join(dir, ".anything-agent"), { recursive: true });
  await fs.mkdir(path.join(dir, ".pi"), { recursive: true });
  await fs.writeFile(path.join(dir, ".pi", "SYSTEM.md"), "You are a folder-based agent.\n", "utf8");
  await fs.writeFile(
    path.join(dir, ".anything-agent", "manifest.json"),
    JSON.stringify({ version: 3, runtime: { env: {}, defaults: {} }, deploy: { defaultTarget: "production", targets: {} } }, null, 2) + "\n",
    "utf8"
  );
  return dir;
}

test("register exposes memory command and memory manifest extension", async () => {
  const commands = [];
  const extensions = [];
  const capabilities = [];

  await register({
    registerCommand(command) {
      commands.push(command);
    },
    registerManifestExtension(extension) {
      extensions.push(extension);
    },
    registerCapability(capability) {
      capabilities.push(capability);
    }
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].namespace, "memory");
  assert.equal(extensions.length, 1);
  assert.equal(extensions[0].sectionKey, "memory");
  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0].kind, "deploy-contribution");
  assert.equal(capabilities[0].id, "memory");
});

test("memory extension validation enforces expected shape", async () => {
  const extensions = [];
  await register({
    registerCommand() {},
    registerManifestExtension(extension) {
      extensions.push(extension);
    },
    registerCapability() {}
  });

  const memoryExtension = extensions[0];
  assert.doesNotThrow(() => memoryExtension.validate({ enabled: true, provider: "mempalace", config: {} }));
  assert.throws(() => memoryExtension.validate({ enabled: "yes", provider: "mempalace", config: {} }), /memory\.enabled/i);
  assert.doesNotThrow(() => memoryExtension.validate({ enabled: true, provider: "unknown", config: {} }));
  assert.throws(
    () => memoryExtension.validate({ enabled: true, provider: "mempalace", config: { deploy: { maintenance: { intervalMinutes: 0 } } } }),
    /intervalMinutes/
  );
  assert.throws(
    () => memoryExtension.validate({ enabled: true, provider: "mempalace", config: { deploy: { ingestion: { enabled: "yes" } } } }),
    /ingestion\.enabled/
  );
});

test("memory deploy contribution emits maintenance intent on supported lambda target", async () => {
  const capabilities = [];
  await register({
    registerCommand() {},
    registerManifestExtension() {},
    registerCapability(capability) {
      capabilities.push(capability);
    }
  });

  const deployContribution = capabilities.find((item) => item.id === "memory").value;
  const intents = await deployContribution.collect({
    targetDir: process.cwd(),
    manifestPath: ".anything-agent/manifest.json",
    packageRoot: process.cwd(),
    manifest: {
      version: 3,
      extensions: {
        memory: {
          enabled: true,
          provider: "mempalace",
          config: {}
        }
      }
    },
    resolvedTarget: {
      name: "production",
      manifest: {
        type: "sst",
        provider: {
          type: "aws"
        }
      }
    }
  });

  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, "scheduled-task");
  assert.equal(intents[0].schedule.kind, "every-minutes");
  assert.equal(intents[0].schedule.intervalMinutes, 360);
});

test("memory deploy contribution emits ingestion poller only when explicitly enabled", async () => {
  const capabilities = [];
  await register({
    registerCommand() {},
    registerManifestExtension() {},
    registerCapability(capability) {
      capabilities.push(capability);
    }
  });

  const deployContribution = capabilities.find((item) => item.id === "memory").value;
  const intents = await deployContribution.collect({
    targetDir: process.cwd(),
    manifestPath: ".anything-agent/manifest.json",
    packageRoot: process.cwd(),
    manifest: {
      version: 3,
      extensions: {
        memory: {
          enabled: true,
          provider: "mempalace",
          config: {
            deploy: {
              ingestion: {
                enabled: true
              }
            }
          }
        }
      }
    },
    resolvedTarget: {
      name: "production",
      manifest: {
        type: "sst",
        provider: {
          type: "aws",
          config: {
            execution: "lambda"
          }
        }
      }
    }
  });

  assert.equal(intents.length, 2);
  assert.equal(intents[0].kind, "scheduled-task");
  assert.equal(intents[1].kind, "event-poller");
});

test("memory deploy contribution skips when disabled/provider mismatch/unsupported targets", async () => {
  const capabilities = [];
  await register({
    registerCommand() {},
    registerManifestExtension() {},
    registerCapability(capability) {
      capabilities.push(capability);
    }
  });

  const deployContribution = capabilities.find((item) => item.id === "memory").value;
  const collect = async (memory, targetManifest) => await deployContribution.collect({
    targetDir: process.cwd(),
    manifestPath: ".anything-agent/manifest.json",
    packageRoot: process.cwd(),
    manifest: {
      version: 3,
      extensions: {
        memory
      }
    },
    resolvedTarget: targetManifest
      ? {
          name: "production",
          manifest: targetManifest
        }
      : undefined
  });

  assert.equal((await collect({ enabled: false, provider: "mempalace", config: {} }, { type: "sst", provider: { type: "aws" } })).length, 0);
  assert.equal((await collect({ enabled: true, provider: "other", config: {} }, { type: "sst", provider: { type: "aws" } })).length, 0);
  assert.equal((await collect({ enabled: true, provider: "mempalace", config: {} }, { type: "vps" })).length, 0);
  assert.equal((await collect({ enabled: true, provider: "mempalace", config: {} }, { type: "fargate" })).length, 0);
  assert.equal(
    (await collect(
      { enabled: true, provider: "mempalace", config: {} },
      { type: "sst", provider: { type: "aws", config: { execution: "fargate" } } }
    )).length,
    0
  );
});

test("memory enable writes manifest extension, memory skill, and system hint", async () => {
  const commands = [];
  await register({
    registerCommand(command) {
      commands.push(command);
    },
    registerManifestExtension() {},
    registerCapability() {}
  });

  const memory = commands.find((item) => item.namespace === "memory");
  assert.ok(memory);

  const targetDir = await createAgentDir();
  const stdoutCapture = createWritableCapture();

  const exitCode = await memory.run(["enable", targetDir, "--json"], {
    cwd: process.cwd(),
    env: process.env,
    stdout: stdoutCapture.stream,
    stderr: process.stderr
  });

  assert.equal(exitCode, 0);

  const payload = JSON.parse(stdoutCapture.read());
  assert.equal(payload.memory.enabled, true);
  assert.equal(payload.memory.provider, "mempalace");
  assert.equal(payload.memory.config.deploy.enabled, true);
  assert.equal(payload.memory.config.deploy.maintenance.intervalMinutes, 360);
  assert.equal(payload.memory.config.deploy.ingestion.enabled, false);

  const manifest = JSON.parse(await fs.readFile(path.join(targetDir, ".anything-agent", "manifest.json"), "utf8"));
  assert.equal(manifest.extensions.memory.enabled, true);
  assert.equal(manifest.extensions.memory.provider, "mempalace");
  assert.equal(manifest.extensions.memory.config.deploy.enabled, true);
  assert.equal(manifest.extensions.memory.config.deploy.maintenance.intervalMinutes, 360);
  assert.equal(manifest.extensions.memory.config.deploy.ingestion.enabled, false);

  const memorySkill = await fs.readFile(path.join(targetDir, ".agents", "skills", "memory", "SKILL.md"), "utf8");
  assert.match(memorySkill, /anything-agent memory search/);

  const systemPrompt = await fs.readFile(path.join(targetDir, ".pi", "SYSTEM.md"), "utf8");
  assert.match(systemPrompt, /anything-agent-memory-hint/);
});

test("memory enable is idempotent for manifest, memory skill, and system hint", async () => {
  const commands = [];
  await register({
    registerCommand(command) {
      commands.push(command);
    },
    registerManifestExtension() {},
    registerCapability() {}
  });

  const memory = commands.find((item) => item.namespace === "memory");
  assert.ok(memory);

  const targetDir = await createAgentDir("anything-memory-plugin-idempotent-");

  const firstCapture = createWritableCapture();
  const firstCode = await memory.run(["enable", targetDir, "--json"], {
    cwd: process.cwd(),
    env: process.env,
    stdout: firstCapture.stream,
    stderr: process.stderr
  });
  assert.equal(firstCode, 0);

  const secondCapture = createWritableCapture();
  const secondCode = await memory.run(["enable", targetDir, "--json"], {
    cwd: process.cwd(),
    env: process.env,
    stdout: secondCapture.stream,
    stderr: process.stderr
  });
  assert.equal(secondCode, 0);

  const secondPayload = JSON.parse(secondCapture.read());
  assert.ok(secondPayload.skipped.includes(".agents/skills/memory/SKILL.md"));
  assert.ok(secondPayload.skipped.includes(".pi/SYSTEM.md"));

  const systemPrompt = await fs.readFile(path.join(targetDir, ".pi", "SYSTEM.md"), "utf8");
  const markerCount = (systemPrompt.match(/anything-agent-memory-hint/g) ?? []).length;
  assert.equal(markerCount, 1);
});
