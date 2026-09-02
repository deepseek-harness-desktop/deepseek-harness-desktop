import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeRoot = join(projectRoot, "src-tauri", "runtime");
const nodeBinary = join(runtimeRoot, "node", process.platform === "win32" ? "node.exe" : "node");
const pnpmCli = join(runtimeRoot, "pnpm", "bin", "pnpm.cjs");
const dshEntry = join(runtimeRoot, "server", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const dshManifest = join(runtimeRoot, "server", "node_modules", "@deepseek-ai", "dsh", "package.json");
const pnpmLauncher = join(runtimeRoot, "bin", process.platform === "win32" ? "pnpm.cmd" : "pnpm");

const requiredFiles = [
  ["Node binary", nodeBinary],
  ["bundled pnpm CLI", pnpmCli],
  ["pnpm launcher", pnpmLauncher],
  ["dsh entry", dshEntry],
  ["dsh package manifest", dshManifest],
];

for (const [label, path] of requiredFiles) {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing: ${path}`);
  }
}

if (process.platform !== "win32" && (statSync(nodeBinary).mode & 0o111) === 0) {
  throw new Error(`Node binary is not executable: ${nodeBinary}`);
}

const nodeVersion = execFileSync(nodeBinary, ["--version"], { encoding: "utf8" }).trim();
if (!/^v24\./.test(nodeVersion)) {
  throw new Error(`Embedded Node 24 is required; found ${nodeVersion}`);
}

const pnpmVersion = execFileSync(nodeBinary, [pnpmCli, "--version"], { encoding: "utf8" }).trim();
const rootManifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const expectedPnpmVersion = rootManifest.packageManager?.replace(/^pnpm@/, "");
if (expectedPnpmVersion && pnpmVersion !== expectedPnpmVersion) {
  throw new Error(`Bundled pnpm version mismatch: expected ${expectedPnpmVersion}, found ${pnpmVersion}`);
}
const expectedDshVersion = rootManifest.dependencies["@deepseek-ai/dsh"];
const stagedDshVersion = JSON.parse(readFileSync(dshManifest, "utf8")).version;
if (stagedDshVersion !== expectedDshVersion) {
  throw new Error(`Staged dsh version mismatch: expected ${expectedDshVersion}, found ${stagedDshVersion}`);
}

console.log(`Runtime layout verified: Node ${nodeVersion}, pnpm ${pnpmVersion}, @deepseek-ai/dsh ${stagedDshVersion}`);
