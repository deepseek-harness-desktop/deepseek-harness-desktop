import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeRoot = join(projectRoot, "src-tauri", "runtime");
const runtimeServer = join(runtimeRoot, "server");
const runtimeNode = join(runtimeRoot, "node");
const runtimeBin = join(runtimeRoot, "bin");
const runtimeSource = join(projectRoot, "runtime");
const requireNode = process.argv.includes("--require-node");

if (Number(process.versions.node.split(".")[0]) !== 24) {
  throw new Error(`Node 24 is required to stage the desktop runtime; found ${process.version}`);
}

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });

console.log("Deploying production Harness dependencies from the lockfile...");
const rootManifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const runtimeManifest = JSON.parse(readFileSync(join(runtimeSource, "package.json"), "utf8"));
if (runtimeManifest.dependencies?.["@deepseek-ai/dsh"] !== rootManifest.dependencies?.["@deepseek-ai/dsh"]) {
  throw new Error("runtime/package.json must pin the same @deepseek-ai/dsh version as package.json");
}
if (runtimeManifest.packageManager !== rootManifest.packageManager) {
  throw new Error("runtime/package.json and package.json must use the same package manager version");
}
const expectedPnpmVersion = rootManifest.packageManager?.replace(/^pnpm@/, "");
const pnpmCliCandidates = [
  resolve(projectRoot, "node_modules/pnpm/bin/pnpm.cjs"),
  expectedPnpmVersion && join(
    projectRoot,
    "node_modules",
    ".pnpm",
    `pnpm@${expectedPnpmVersion}`,
    "node_modules",
    "pnpm",
    "bin",
    "pnpm.cjs",
  ),
].filter(Boolean);
const pnpmCli = pnpmCliCandidates.find((candidate) => existsSync(candidate));
if (!pnpmCli) {
  throw new Error(`Project pnpm CLI is missing; checked: ${pnpmCliCandidates.join(", ")}`);
}
const deployRoot = mkdtempSync(join(tmpdir(), "deepseek-harness-deploy-"));
const deployProject = join(deployRoot, "project");
const deployServer = join(deployRoot, "server");
mkdirSync(deployProject, { recursive: true });
for (const entry of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
  cpSync(join(runtimeSource, entry), join(deployProject, entry));
}
try {
  execFileSync(process.execPath, [pnpmCli, "install", "--frozen-lockfile"], {
    cwd: deployProject,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [pnpmCli, "deploy", "--filter", ".", "--prod", deployServer, "--legacy"], {
    cwd: deployProject,
    stdio: "inherit",
  });
  cpSync(deployServer, runtimeServer, { recursive: true });
} finally {
  rmSync(deployRoot, { recursive: true, force: true });
}

for (const entry of readdirSync(runtimeServer)) {
  if (entry !== "node_modules") {
    rmSync(join(runtimeServer, entry), { recursive: true, force: true });
  }
}
removeSymlinks(runtimeServer);
writeFileSync(
  join(runtimeServer, "package.json"),
  `${JSON.stringify({
    name: "deepseek-harness-runtime",
    private: true,
    dependencies: { "@deepseek-ai/dsh": rootManifest.dependencies["@deepseek-ai/dsh"] },
  }, null, 2)}\n`,
);

const pnpmPackage = dirname(dirname(pnpmCli));
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

function removeSymlinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      rmSync(path, { force: true });
    } else if (entry.isDirectory()) {
      removeSymlinks(path);
    }
  }
}
