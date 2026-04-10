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

  await register({
    registerCommand(command) {
      commands.push(command);
    },
    registerManifestExtension(extension) {
      extensions.push(extension);
    }
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].namespace, "memory");
  assert.equal(extensions.length, 1);
  assert.equal(extensions[0].sectionKey, "memory");
});

test("memory extension validation enforces expected shape", async () => {
  const extensions = [];
  await register({
    registerCommand() {},
    registerManifestExtension(extension) {
      extensions.push(extension);
    }
  });

  const memoryExtension = extensions[0];
  assert.doesNotThrow(() => memoryExtension.validate({ enabled: true, provider: "mempalace", config: {} }));
  assert.throws(() => memoryExtension.validate({ enabled: "yes", provider: "mempalace", config: {} }), /memory\.enabled/i);
  assert.throws(() => memoryExtension.validate({ enabled: true, provider: "unknown", config: {} }), /Unknown memory provider/i);
});

test("memory enable writes manifest extension, memory skill, and system hint", async () => {
  const commands = [];
  await register({
    registerCommand(command) {
      commands.push(command);
    },
    registerManifestExtension() {}
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

  const manifest = JSON.parse(await fs.readFile(path.join(targetDir, ".anything-agent", "manifest.json"), "utf8"));
  assert.equal(manifest.extensions.memory.enabled, true);
  assert.equal(manifest.extensions.memory.provider, "mempalace");

  const memorySkill = await fs.readFile(path.join(targetDir, ".agents", "skills", "memory", "SKILL.md"), "utf8");
  assert.match(memorySkill, /anything-agent memory search/);

  const systemPrompt = await fs.readFile(path.join(targetDir, ".pi", "SYSTEM.md"), "utf8");
  assert.match(systemPrompt, /anything-agent-memory-hint/);
});
