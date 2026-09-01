import { invoke } from "@tauri-apps/api/core";

import type {
  HarnessStatus,
  InstalledPlugin,
  PluginCatalogItem,
  PluginOperation,
} from "@/types";

export const tauri = {
  listPluginCatalog: () => invoke<PluginCatalogItem[]>("list_plugin_catalog"),
  listInstalledPlugins: () => invoke<InstalledPlugin[]>("list_installed_plugins"),
  startHarness: () => invoke<{ url: string; port: number; version: string }>("start_harness"),
  stopHarness: () => invoke<void>("stop_harness"),
  getHarnessStatus: () => invoke<HarnessStatus>("get_harness_status"),
  installPlugin: (id: string) => invoke<PluginOperation>("install_plugin", { id }),
  removePlugin: (id: string) => invoke<PluginOperation>("remove_plugin", { id }),
  updatePlugin: (id: string) => invoke<PluginOperation>("update_plugin", { id }),
  getPluginOperation: (id: string) => invoke<PluginOperation>("get_plugin_operation", { id }),
  readPluginLog: (id: string) => invoke<string>("read_plugin_log", { id }),
};
