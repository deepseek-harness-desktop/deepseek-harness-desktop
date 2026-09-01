import { openUrl } from "@tauri-apps/plugin-opener";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

const HARNESS_WINDOW_LABEL = "harness-web";

let activeHarnessUrl: string | null = null;

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function describeError(payload: unknown) {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

async function openInBrowser(url: string) {
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    await openUrl(url);
  }
}

export async function openHarnessWindow(url: string): Promise<"embedded" | "browser"> {
  if (!isTauriRuntime()) {
    await openInBrowser(url);
    return "browser";
  }

  const existing = await WebviewWindow.getByLabel(HARNESS_WINDOW_LABEL);
  if (existing && activeHarnessUrl === url) {
    await existing.show();
    await existing.setFocus();
    return "embedded";
  }

  if (existing) {
    await existing.destroy().catch(() => undefined);
  }

  const harnessWindow = new WebviewWindow(HARNESS_WINDOW_LABEL, {
    url,
    title: "DeepSeek Harness",
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    center: true,
    focus: true,
    resizable: true,
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    void harnessWindow.once("tauri://created", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    void harnessWindow.once("tauri://error", (event) => {
      if (settled) return;
      settled = true;
      reject(new Error(`无法打开 Harness Web UI：${describeError(event.payload)}`));
    });
  });

  activeHarnessUrl = url;
  return "embedded";
}

export async function closeHarnessWindow() {
  if (!isTauriRuntime()) return;
  const existing = await WebviewWindow.getByLabel(HARNESS_WINDOW_LABEL);
  if (existing) {
    await existing.destroy().catch(() => undefined);
  }
  activeHarnessUrl = null;
}
