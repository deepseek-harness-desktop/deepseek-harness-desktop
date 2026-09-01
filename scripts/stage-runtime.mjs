import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeRoot = join(projectRoot, "src-tauri", "runtime");
const runtimeServer = join(runtimeRoot, "server");
const runtimeNode = join(runtimeRoot, "node");
const runtimeBin = join(runtimeRoot, "bin");
const requireNode = process.argv.includes("--require-node");

if (Number(process.versions.node.split(".")[0]) !== 24) {
  throw new Error(`Node 24 is required to stage the desktop runtime; found ${process.version}`);
}

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeServer, { recursive: true });

console.log("Staging production Harness dependencies...");
const rootManifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
writeFileSync(
  join(runtimeServer, "package.json"),
  `${JSON.stringify({
    name: "deepseek-harness-runtime",
    private: true,
    dependencies: { "@deepseek-ai/dsh": rootManifest.dependencies["@deepseek-ai/dsh"] },
  }, null, 2)}\n`,
);
writeFileSync(join(runtimeServer, "pnpm-workspace.yaml"), `allowBuilds:\n  '@deepseek-ai/dsh-subprocess-local': true\n  '@google/genai': true\n  koffi: true\n  node-pty: true\n  protobufjs: true\n`);
execFileSync(process.execPath, [resolve(projectRoot, "node_modules/pnpm/bin/pnpm.cjs"), "install", "--prod", "--lockfile=false", "--dir", runtimeServer], {
  cwd: projectRoot,
  stdio: "inherit",
});

const require = createRequire(import.meta.url);
const pnpmPackage = dirname(require.resolve("pnpm"));
const pnpmRuntime = join(runtimeRoot, "pnpm");
mkdirSync(pnpmRuntime, { recursive: true });
for (const entry of readdirSync(pnpmPackage)) {
  cpSync(join(pnpmPackage, entry), join(pnpmRuntime, entry), { recursive: true });
}
mkdirSync(runtimeBin, { recursive: true });

const unixPnpm = join(runtimeBin, "pnpm");
writeFileSync(unixPnpm, "#!/bin/sh\nset -eu\nexec node \"$(dirname \"$0\")/../pnpm/bin/pnpm.cjs\" \"$@\"\n");
chmodSync(unixPnpm, 0o755);
writeFileSync(join(runtimeBin, "pnpm.cmd"), "@echo off\r\nnode \"%~dp0\\..\\pnpm\\bin\\pnpm.cjs\" %*\r\n");

const nodeSource = process.env.DSH_NODE_BINARY || process.execPath;
const nodeTarget = join(runtimeNode, process.platform === "win32" ? "node.exe" : "node");
if (existsSync(nodeSource)) {
  mkdirSync(runtimeNode, { recursive: true });
  cpSync(nodeSource, nodeTarget);
  if (process.platform !== "win32") chmodSync(nodeTarget, 0o755);
  console.log(`Staged Node runtime from ${nodeSource}`);
} else if (requireNode) {
  throw new Error(`Embedded Node binary not found: ${nodeSource}`);
}

const manifestPath = join(runtimeServer, "node_modules", "@deepseek-ai", "dsh", "package.json");
if (!existsSync(manifestPath)) {
  throw new Error(`Harness package was not staged: ${manifestPath}`);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
console.log(`Staged @deepseek-ai/dsh@${manifest.version}`);
