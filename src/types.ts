export type SupportedPlatform = "macos-arm64" | "macos-x64" | "windows-x64";

export interface PluginCatalogItem {
  id: string;
  name: string;
  description: string;
  author: string;
  sourceUrl: string;
  installSpec: string;
  packageName: string;
  version: string;
  category: string;
  dshVersionRange: string;
  platforms: SupportedPlatform[];
  capabilities: string[];
  license: string;
  verifiedAt: string;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  packageName: string;
  version: string;
}

export type PluginOperation =
  | { state: "running"; operationId: string; logPath: string }
  | { state: "success"; operationId: string; requiresRestart: boolean }
  | { state: "failed"; operationId: string; message: string; logPath: string };

export interface HarnessLaunchInfo {
  url: string;
  port: number;
  version: string;
}

export type HarnessStatus =
  | { state: "starting"; logPath: string }
  | { state: "ready"; url: string; port: number }
  | { state: "failed"; message: string; logPath: string }
  | { state: "stopped" };

export interface RuntimeToolStatus {
  path: string;
  available: boolean;
  version: string;
}

export interface RuntimeStatus {
  ready: boolean;
  node: RuntimeToolStatus;
  pnpm: RuntimeToolStatus;
  dsh: RuntimeToolStatus;
}
