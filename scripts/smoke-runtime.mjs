import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeRoot = join(projectRoot, "src-tauri", "runtime");
const nodeBinary = join(runtimeRoot, "node", process.platform === "win32" ? "node.exe" : "node");
const dshEntry = join(runtimeRoot, "server", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const runtimeBin = join(runtimeRoot, "bin");
const smokeHome = join(tmpdir(), `deepseek-harness-desktop-smoke-${process.pid}-${Date.now()}`);

if (!existsSync(nodeBinary) || !existsSync(dshEntry)) {
  throw new Error("Runtime is not staged; run `pnpm stage:runtime -- --require-node` first");
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function redactSensitive(input) {
  return input
    .replace(/((?:token|api[_-]?key|password|secret)\s*[:=]\s*)[^\s&"')]+/gi, "$1[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]");
}

function findHarnessUrl(output) {
  const match = output.match(/http:\/\/127\.0\.0\.1:\d+(?:\/[^\s)"']*)?/);
  return match?.[0]?.replace(/[),"'`]+$/, "") ?? null;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  } else {
    child.kill();
  }
  await Promise.race([new Promise((resolveExit) => child.once("close", resolveExit)), delay(3000)]);
}

let child;
let output = "";
let harnessUrl = null;
let httpStatus = null;

try {
  const pathEntries = [runtimeBin, join(runtimeRoot, "node"), process.env.PATH].filter(Boolean);
  child = spawn(nodeBinary, [dshEntry, "web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
    cwd: runtimeRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      DSH_HOME: smokeHome,
      DSH_NODE_PATH: nodeBinary,
      DSH_DESKTOP_RUNTIME: "1",
      PATH: pathEntries.join(process.platform === "win32" ? ";" : ":"),
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const collect = (chunk) => {
    output += chunk.toString();
    harnessUrl ??= findHarnessUrl(output);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Harness exited before becoming ready: ${child.exitCode}`);
    }
    if (harnessUrl) {
      try {
        const response = await fetch(harnessUrl, { redirect: "manual" });
        httpStatus = response.status;
        if (httpStatus >= 200 && httpStatus < 500) break;
      } catch {
        // The process has announced its port; wait briefly for the HTTP listener.
      }
    }
    await delay(100);
  }

  if (!harnessUrl || httpStatus === null || httpStatus < 200 || httpStatus >= 500) {
    const recentOutput = redactSensitive(output).split("\n").slice(-20).join("\n");
    throw new Error(`Harness did not become HTTP-ready within 15 seconds.\n${recentOutput}`);
  }

  const port = new URL(harnessUrl).port;
  console.log(`Harness runtime smoke passed: 127.0.0.1:${port} responded with HTTP ${httpStatus}`);
} finally {
  await stopProcess(child);
  rmSync(smokeHome, { recursive: true, force: true });
}
