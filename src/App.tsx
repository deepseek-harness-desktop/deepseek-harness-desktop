import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Boxes,
  Check,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Cpu,
  ExternalLink,
  Github,
  LayoutDashboard,
  LoaderCircle,
  Package,
  Play,
  PlugZap,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fallbackPluginCatalog } from "@/data/plugin-catalog";
import { closeHarnessWindow, openHarnessWindow } from "@/lib/harness-window";
import { tauri } from "@/lib/tauri";
import type { HarnessStatus, InstalledPlugin, PluginCatalogItem, PluginOperation } from "@/types";

type View = "overview" | "plugins";

const sleep = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function platformLabel() {
  if (navigator.platform.toLowerCase().includes("win")) return "Windows x64";
  return navigator.platform.toLowerCase().includes("arm") ? "macOS ARM64" : "macOS Intel";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isInstalled(plugin: PluginCatalogItem, installed: InstalledPlugin[]) {
  return installed.some((item) => item.packageName === plugin.packageName || item.id === plugin.id);
}

function operationIsRunning(operation: PluginOperation | undefined) {
  return operation?.state === "running";
}

export default function App() {
  const [view, setView] = useState<View>("overview");
  const [catalog, setCatalog] = useState<PluginCatalogItem[]>(fallbackPluginCatalog);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [harnessStatus, setHarnessStatus] = useState<HarnessStatus>({ state: "stopped" });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [operations, setOperations] = useState<Record<string, PluginOperation>>({});
  const [operationLogs, setOperationLogs] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isOpeningHarness, setIsOpeningHarness] = useState(false);

  const loadData = useCallback(async () => {
    const [catalogResult, installedResult, statusResult] = await Promise.allSettled([
      tauri.listPluginCatalog(),
      tauri.listInstalledPlugins(),
      tauri.getHarnessStatus(),
    ]);

    if (catalogResult.status === "fulfilled" && catalogResult.value.length > 0) {
      setCatalog(catalogResult.value);
    }
    if (installedResult.status === "fulfilled") {
      setInstalled(installedResult.value);
    }
    if (statusResult.status === "fulfilled") {
      setHarnessStatus(statusResult.value);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void tauri.getHarnessStatus().then(setHarnessStatus).catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const categories = useMemo(
    () => ["全部", ...new Set(catalog.map((plugin) => plugin.category))],
    [catalog],
  );

  const filteredPlugins = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return catalog.filter((plugin) => {
      const matchesCategory = category === "全部" || plugin.category === category;
      const matchesQuery = !normalizedQuery || [plugin.name, plugin.description, plugin.author, ...plugin.capabilities]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
      return matchesCategory && matchesQuery;
    });
  }, [catalog, category, query]);

  const startHarness = async () => {
    setIsStarting(true);
    setNotice(null);
    setHarnessStatus({ state: "starting", logPath: "" });
    try {
      const launchInfo = await tauri.startHarness();
      setHarnessStatus({ state: "ready", url: launchInfo.url, port: launchInfo.port });
      try {
        await openHarnessWindow(launchInfo.url);
      } catch (error) {
        setNotice(`Harness 已启动，但 Web UI 打开失败：${errorMessage(error)}`);
      }
    } catch (error) {
      setNotice(`Harness 启动失败：${errorMessage(error)}`);
      setHarnessStatus({ state: "failed", message: errorMessage(error), logPath: "" });
    } finally {
      setIsStarting(false);
    }
  };

  const openHarness = async () => {
    setIsOpeningHarness(true);
    setNotice(null);
    try {
      const status = await tauri.getHarnessStatus();
      if (status.state !== "ready") {
        await startHarness();
        return;
      }
      await openHarnessWindow(status.url);
    } catch (error) {
      setNotice(`Harness Web UI 打开失败：${errorMessage(error)}`);
    } finally {
      setIsOpeningHarness(false);
    }
  };

  const stopHarness = async () => {
    setNotice(null);
    try {
      await tauri.stopHarness();
      await closeHarnessWindow();
      setHarnessStatus({ state: "stopped" });
    } catch (error) {
      setNotice(`Harness 停止失败：${errorMessage(error)}`);
    }
  };

  const waitForOperation = async (operationId: string, operation: PluginOperation) => {
    let current = operation;
    setOperations((previous) => ({ ...previous, [operationId]: current }));
    const loadLog = async (id: string) => {
      try {
        const log = await tauri.readPluginLog(id);
        setOperationLogs((previous) => ({ ...previous, [operationId]: log }));
      } catch {
        // The browser preview has no Tauri log command; the desktop command is authoritative.
      }
    };
    await loadLog(current.operationId);
    while (current.state === "running") {
      await sleep(700);
      current = await tauri.getPluginOperation(current.operationId);
      setOperations((previous) => ({ ...previous, [operationId]: current }));
      await loadLog(current.operationId);
    }
    return current;
  };

  const runPluginOperation = async (plugin: PluginCatalogItem, action: "install" | "remove" | "update") => {
    const actionLabel = action === "install" ? "安装" : action === "remove" ? "卸载" : "更新";
    if (!window.confirm(`${actionLabel} ${plugin.name}？\n\n来源：${plugin.sourceUrl}\n权限：${plugin.capabilities.join("、")}`)) {
      return;
    }

    setNotice(null);
    try {
      const operation = action === "install"
        ? await tauri.installPlugin(plugin.id)
        : action === "remove"
          ? await tauri.removePlugin(plugin.id)
          : await tauri.updatePlugin(plugin.id);
      const result = await waitForOperation(plugin.id, operation);
      if (result.state === "success") {
        setNotice(`${plugin.name} ${actionLabel}完成，Harness 将重新加载插件。`);
        await loadData();
        if (ready) {
          const status = await tauri.getHarnessStatus();
          if (status.state === "ready") {
            await openHarnessWindow(status.url).catch((error) => {
              setNotice(`插件已更新，但 Harness Web UI 恢复失败：${errorMessage(error)}`);
            });
          }
        }
      } else if (result.state === "failed") {
        setNotice(`${plugin.name} ${actionLabel}失败：${result.message}`);
      }
    } catch (error) {
      setNotice(`${plugin.name} ${actionLabel}失败：${errorMessage(error)}`);
    }
  };

  const installedCount = installed.length;
  const ready = harnessStatus.state === "ready";
  const starting = isStarting || harnessStatus.state === "starting";
  const statusLabel = ready ? "服务在线" : starting ? "启动中" : harnessStatus.state === "failed" ? "启动失败" : "服务离线";

  return (
    <div className="flex min-h-screen bg-transparent text-foreground">
      <aside className="flex w-[248px] shrink-0 flex-col border-r bg-black/10 px-4 py-5">
        <div className="flex items-center gap-3 px-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_0_24px_rgb(196_243_74/0.18)]">
            <Zap className="size-5 fill-current" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight">DeepSeek Harness</div>
            <div className="text-xs text-muted-foreground">Desktop control plane</div>
          </div>
        </div>

        <div className="mt-9 space-y-1">
          <div className="px-3 pb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">工作台</div>
          <NavItem active={view === "overview"} icon={<LayoutDashboard />} label="概览" onClick={() => setView("overview")} />
          <NavItem active={view === "plugins"} icon={<Boxes />} label="插件市场" count={catalog.length} onClick={() => setView("plugins")} />
        </div>

        <div className="mt-auto space-y-3">
          <div className="rounded-xl border bg-card/60 p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-300">
              <CircleDot className={`size-3 ${ready ? "fill-emerald-400 text-emerald-400" : "text-zinc-500"}`} />
              {ready ? "Harness 正在运行" : "Harness 尚未运行"}
            </div>
            <div className="mt-2 text-xs leading-5 text-muted-foreground">
              {ready ? `127.0.0.1:${harnessStatus.port}` : "启动后将打开官方 Web UI"}
            </div>
          </div>
          <div className="flex items-center gap-2 px-3 text-xs text-zinc-500">
            <Settings2 className="size-3.5" />
            <span>Node 24 · pnpm 11</span>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <header className="flex h-[72px] items-center justify-between border-b px-10">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>DeepSeek Harness</span>
            <ChevronRight className="size-4 text-zinc-600" />
            <span className="text-foreground">{view === "overview" ? "概览" : "插件市场"}</span>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant={ready ? "success" : harnessStatus.state === "failed" ? "warning" : "secondary"}>
              <span className={`mr-1.5 size-1.5 rounded-full ${ready ? "bg-emerald-300" : starting ? "bg-amber-300" : "bg-zinc-500"}`} />
              {statusLabel}
            </Badge>
            {ready && (
              <Button size="sm" variant="ghost" onClick={openHarness} disabled={isOpeningHarness}>
                {isOpeningHarness ? <LoaderCircle className="animate-spin" /> : <ExternalLink data-icon="inline-start" />}
                {isOpeningHarness ? "打开中" : "打开 Web UI"}
              </Button>
            )}
            <Button size="sm" variant={ready ? "outline" : "default"} onClick={ready ? stopHarness : startHarness} disabled={starting}>
              {starting ? <LoaderCircle className="animate-spin" /> : ready ? <TerminalSquare /> : <Play />}
              {starting ? "启动中" : ready ? "停止服务" : "启动 Harness"}
            </Button>
          </div>
        </header>

        <div className="mx-auto max-w-[1380px] space-y-8 px-10 py-9">
          {notice && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm text-amber-100">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-300" />
              <span className="flex-1">{notice}</span>
              <button className="text-amber-300/70 hover:text-amber-200" onClick={() => setNotice(null)} aria-label="关闭提示">×</button>
            </div>
          )}

          {view === "overview" ? (
            <Overview
              catalog={catalog}
              installedCount={installedCount}
              harnessStatus={harnessStatus}
              onOpenPlugins={() => setView("plugins")}
              onStart={startHarness}
              onOpenHarness={openHarness}
              starting={isStarting}
              opening={isOpeningHarness}
            />
          ) : (
            <PluginMarket
              catalog={filteredPlugins}
              categories={categories}
              category={category}
              installed={installed}
              operations={operations}
              operationLogs={operationLogs}
              platform={platformLabel()}
              query={query}
              onCategoryChange={setCategory}
              onQueryChange={setQuery}
              onOperation={runPluginOperation}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function NavItem({ active, icon, label, count, onClick }: { active: boolean; icon: React.ReactNode; label: string; count?: number; onClick: () => void }) {
  return (
    <button
      className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
      onClick={onClick}
    >
      <span className={active ? "text-primary" : "text-zinc-500 group-hover:text-zinc-300"}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {count !== undefined && <span className="text-xs text-zinc-500">{count}</span>}
    </button>
  );
}

function Overview({ catalog, installedCount, harnessStatus, onOpenPlugins, onStart, onOpenHarness, starting, opening }: { catalog: PluginCatalogItem[]; installedCount: number; harnessStatus: HarnessStatus; onOpenPlugins: () => void; onStart: () => void; onOpenHarness: () => void; starting: boolean; opening: boolean }) {
  const ready = harnessStatus.state === "ready";
  return (
    <>
      <section className="relative overflow-hidden rounded-2xl border bg-card/70 p-8">
        <div className="pointer-events-none absolute -right-16 -top-24 size-72 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative max-w-2xl">
          <Badge variant="default"><Sparkles className="mr-1.5 size-3" />桌面运行时已就绪</Badge>
          <h1 className="mt-5 text-4xl font-semibold tracking-[-0.04em] text-zinc-50">把 Harness 变成<br /><span className="text-primary">可扩展的工作台。</span></h1>
          <p className="mt-4 max-w-xl text-[15px] leading-7 text-muted-foreground">通过内置 Node 24 和精选插件市场，一键管理 DeepSeek Harness。服务始终绑定在本机，模型密钥继续由 Harness 自己管理。</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button size="lg" onClick={ready ? onOpenHarness : onStart} disabled={starting || opening}>
              {starting || opening ? <LoaderCircle className="animate-spin" /> : ready ? <TerminalSquare /> : <Play />}
              {starting ? "启动中" : opening ? "打开中" : ready ? "打开 Harness" : "启动 Harness"}
              {!starting && !opening && <ArrowUpRight />}
            </Button>
            <Button size="lg" variant="outline" onClick={onOpenPlugins}><Boxes />查看精选插件</Button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard icon={<Cpu />} label="运行时" value="Node 24" hint="内置固定版本" />
        <StatCard icon={<PlugZap />} label="精选插件" value={String(catalog.length).padStart(2, "0")} hint="离线可浏览目录" />
        <StatCard icon={<ShieldCheck />} label="已安装" value={String(installedCount).padStart(2, "0")} hint="当前 web profile" />
      </section>

      <section className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
        <Card className="bg-card/60">
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div><CardTitle>运行状态</CardTitle><CardDescription className="mt-1.5">桌面端负责启动和回收官方 Harness Web 服务。</CardDescription></div>
              <Badge variant={ready ? "success" : "secondary"}>{ready ? "在线" : harnessStatus.state === "starting" ? "启动中" : "待启动"}</Badge>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <InfoRow label="绑定地址" value={ready ? `127.0.0.1:${harnessStatus.port}` : "127.0.0.1 · 自动端口"} />
              <InfoRow label="服务版本" value="@deepseek-ai/dsh" />
              <InfoRow label="包管理器" value="pnpm 11.7.0" />
              <InfoRow label="运行配置" value="web profile" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/60">
          <CardHeader><CardTitle>安全边界</CardTitle><CardDescription className="mt-1.5">插件属于可执行代码，请在安装前确认来源。</CardDescription></CardHeader>
          <CardContent className="space-y-3 text-sm text-zinc-300">
            <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-4 text-primary" /><span>普通模式仅允许精选清单中的固定版本。</span></div>
            <div className="flex items-start gap-3"><TerminalSquare className="mt-0.5 size-4 text-primary" /><span>安装命令使用参数数组，不经过 shell 拼接。</span></div>
            <div className="flex items-start gap-3"><TriangleAlert className="mt-0.5 size-4 text-amber-300" /><span>社区精选不代表 DeepSeek 官方认证或安全审计。</span></div>
          </CardContent>
        </Card>
      </section>
    </>
  );
}

function StatCard({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint: string }) {
  return <Card className="bg-card/50"><CardContent className="flex items-center gap-4 p-5"><div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">{icon}</div><div><div className="text-xs text-muted-foreground">{label}</div><div className="mt-0.5 text-xl font-semibold tracking-tight">{value}</div><div className="mt-0.5 text-xs text-zinc-500">{hint}</div></div></CardContent></Card>;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border bg-black/10 px-3 py-2.5"><div className="text-[11px] text-zinc-500">{label}</div><div className="mt-1 truncate text-sm text-zinc-200">{value}</div></div>;
}

function PluginMarket({ catalog, categories, category, installed, operations, operationLogs, platform, query, onCategoryChange, onQueryChange, onOperation }: { catalog: PluginCatalogItem[]; categories: string[]; category: string; installed: InstalledPlugin[]; operations: Record<string, PluginOperation>; operationLogs: Record<string, string>; platform: string; query: string; onCategoryChange: (category: string) => void; onQueryChange: (query: string) => void; onOperation: (plugin: PluginCatalogItem, action: "install" | "remove" | "update") => Promise<void> }) {
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div><div className="flex items-center gap-2 text-sm text-primary"><Sparkles className="size-4" />精选插件目录</div><h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em]">插件市场</h1><p className="mt-2 text-sm text-muted-foreground">为 web profile 选择可复现、可审阅的 Harness 扩展。</p></div>
        <div className="text-right text-xs text-zinc-500"><div>当前平台</div><div className="mt-1 text-zinc-300">{platform}</div></div>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-[260px] flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" /><Input className="pl-9" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索插件、能力或作者..." /></div>
        <div className="flex gap-1 overflow-x-auto rounded-lg border bg-card/50 p-1">{categories.map((item) => <button key={item} className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs transition-colors ${category === item ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`} onClick={() => onCategoryChange(item)}>{item}</button>)}</div>
      </div>
      {catalog.length === 0 ? <Card className="bg-card/50"><CardContent className="flex flex-col items-center justify-center p-16 text-center"><Search className="size-8 text-zinc-600" /><p className="mt-4 text-sm text-zinc-300">没有匹配的插件</p><p className="mt-1 text-xs text-zinc-500">换个关键词或分类试试。</p></CardContent></Card> : <div className="grid gap-4 xl:grid-cols-2">{catalog.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} installed={isInstalled(plugin, installed)} operation={operations[plugin.id]} operationLog={operations[plugin.id] ? operationLogs[operations[plugin.id].operationId] : undefined} onOperation={onOperation} />)}</div>}
      <div className="flex items-center gap-2 text-xs text-zinc-500"><ShieldCheck className="size-3.5 text-primary" />清单固定到版本并随应用发布；来源和权限会在每次安装前再次确认。</div>
    </>
  );
}

function PluginCard({ plugin, installed, operation, operationLog, onOperation }: { plugin: PluginCatalogItem; installed: boolean; operation?: PluginOperation; operationLog?: string; onOperation: (plugin: PluginCatalogItem, action: "install" | "remove" | "update") => Promise<void> }) {
  const running = operationIsRunning(operation);
  const failed = operation?.state === "failed";
  return <Card className="group flex flex-col bg-card/60 transition-colors hover:border-zinc-600"><CardHeader className="pb-4"><div className="flex items-start gap-4"><div className="flex size-11 shrink-0 items-center justify-center rounded-xl border bg-zinc-900 text-primary"><PlugZap className="size-5" /></div><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><CardTitle className="truncate">{plugin.name}</CardTitle>{installed && <Badge variant="success"><Check className="mr-1 size-3" />已安装</Badge>}</div><CardDescription className="mt-1.5 line-clamp-2 min-h-10">{plugin.description}</CardDescription></div></div></CardHeader><CardContent className="flex flex-1 flex-col gap-4"><div className="flex flex-wrap gap-1.5">{plugin.capabilities.map((capability) => <Badge key={capability} variant="secondary">{capability}</Badge>)}</div><div className="grid grid-cols-2 gap-3 rounded-lg border bg-black/10 p-3 text-xs"><div><div className="text-zinc-500">作者</div><div className="mt-1 truncate text-zinc-300">{plugin.author}</div></div><div><div className="text-zinc-500">版本</div><div className="mt-1 text-zinc-300">v{plugin.version}</div></div><div><div className="text-zinc-500">兼容 Harness</div><div className="mt-1 text-zinc-300">{plugin.dshVersionRange}</div></div><div><div className="text-zinc-500">许可证</div><div className="mt-1 text-zinc-300">{plugin.license}</div></div></div>{operationLog && <pre className="max-h-24 overflow-auto rounded-md bg-black/40 px-2.5 py-2 font-mono text-[10px] leading-4 text-zinc-500">{operationLog}</pre>}<div className="mt-auto flex items-center justify-between gap-3"><a className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300" href={plugin.sourceUrl} target="_blank" rel="noreferrer"><Github className="size-3.5 shrink-0" /><span className="truncate">查看来源仓库</span><ExternalLink className="size-3 shrink-0" /></a><div className="flex gap-2">{installed && <Button size="sm" variant="ghost" title="卸载" disabled={running} onClick={() => void onOperation(plugin, "remove")}><Trash2 className="text-zinc-400" /></Button>}{installed && <Button size="sm" variant="outline" disabled={running} onClick={() => void onOperation(plugin, "update")}>{running ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}更新</Button>}{!installed && <Button size="sm" disabled={running} onClick={() => void onOperation(plugin, "install")}>{running ? <LoaderCircle className="animate-spin" /> : <Package />}安装</Button>}</div></div>{failed && <div className="flex items-start gap-2 rounded-md bg-red-400/5 px-2.5 py-2 text-xs text-red-300"><CircleAlert className="mt-0.5 size-3.5 shrink-0" /><span className="line-clamp-2">{operation.message}</span></div>}</CardContent></Card>;
}
