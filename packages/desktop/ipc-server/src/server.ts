/** Tauri-facing stdio JSON-RPC bridge for the complete Host API. */

import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'
import { JsonRpcLineTransport, type DesktopApiInvokeParams, type DesktopStreamOpenParams } from '@deepseek-ai/dsh-sdk-protocol'
import { toFetchHandler, type ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'

interface DesktopStreamRecord { readonly controller: AbortController; readonly task: Promise<void> }

/** Options for the desktop runtime JSON-RPC bridge. */
export interface DesktopIpcConfig { input?: Readable; output?: Writable }

/** JSON-RPC server that exposes the existing ApiProxy and event streams. */
export class DesktopIpcServer {
  private readonly streams = new Map<string, DesktopStreamRecord>()
  private readonly requests = new Map<string, AbortController>()
  private initialized = false
  private shutdownTask: Promise<Record<string, never>> | undefined

  constructor(private readonly ctx: Context, private readonly transport: JsonRpcLineTransport) {}

  /**
   * Dispatch one desktop request.
   * @param method JSON-RPC method name.
   * @param params JSON-safe method parameters.
   * @returns The JSON-safe method result.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'runtime.initialize': return this.initialize(params as unknown as { cwd: string })
      case 'client.bundle': return this.clientBundle(params?.['id'] as string)
      case 'api.invoke': return this.invoke(params as unknown as DesktopApiInvokeParams)
      case 'api.cancel': return this.cancel(params?.['requestId'] as string)
      case 'api.stream.open': return this.openStream(params as unknown as DesktopStreamOpenParams)
      case 'api.stream.close': return this.closeStream(params?.['streamId'] as string)
      case 'runtime.shutdown': return this.shutdown()
      default: throw new Error(`unknown desktop runtime method: ${method}`)
    }
  }

  private initialize(params: { cwd: string }): { protocol: string; runtime: string; boot?: unknown } {
    if (this.initialized) throw new Error('desktop runtime is already initialized')
    if (typeof params.cwd !== 'string' || params.cwd === '') throw new TypeError('runtime.initialize cwd is required')
    process.chdir(params.cwd)
    this.initialized = true
    const clientModules = this.ctx.get('clientModules') as { graph(): unknown } | undefined
    return {
      protocol: 'dsh-desktop-ipc/1',
      runtime: 'deepseek-harness',
      ...(clientModules === undefined ? {} : { boot: clientModules.graph() }),
    }
  }

  private async clientBundle(id: string): Promise<{ id: string; source: string }> {
    if (!this.initialized) throw new Error('desktop runtime is not initialized')
    if (typeof id !== 'string' || id === '') throw new TypeError('client.bundle id is required')
    const clientModules = this.ctx.get('clientModules') as { clientPath(id: string): string | undefined } | undefined
    const path = clientModules?.clientPath(id)
    if (path === undefined) throw new Error(`desktop client bundle is unavailable: ${id}`)
    return { id, source: await readFile(path, 'utf8') }
  }

  private async invoke(params: DesktopApiInvokeParams): Promise<unknown> {
    if (!this.initialized) throw new Error('desktop runtime is not initialized')
    if (params.channel !== '/api') throw new Error(`unsupported desktop channel: ${params.channel}`)
    const api = this.ctx.get('apiProxy') as ApiProxy | undefined
    if (api === undefined) throw new Error('desktop runtime apiProxy is unavailable')
    const requestId = typeof params.request === 'object' && params.request !== null
      ? String((params.request as { rpcId?: unknown }).rpcId ?? '') : ''
    const controller = new AbortController()
    if (requestId !== '') this.requests.set(requestId, controller)
    try {
      const response = await toFetchHandler(api).fetch(new Request(`http://dsh.internal/api/${params.endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params.request), signal: controller.signal,
      }))
      return response.json()
    } finally {
      if (requestId !== '') this.requests.delete(requestId)
    }
  }

  private async openStream(params: DesktopStreamOpenParams): Promise<Record<string, never>> {
    if (!this.initialized) throw new Error('desktop runtime is not initialized')
    if (this.streams.has(params.streamId)) throw new Error(`desktop stream already exists: ${params.streamId}`)
    const api = this.ctx.get('apiProxy') as ApiProxy | undefined
    if (api === undefined) throw new Error('desktop runtime apiProxy is unavailable')
    const controller = new AbortController()
    const task = this.pumpStream(params, api, controller)
    this.streams.set(params.streamId, { controller, task })
    return {}
  }

  private async pumpStream(params: DesktopStreamOpenParams, api: ApiProxy, controller: AbortController): Promise<void> {
    const stream = params.stream === 'mux'
      ? api.events.mux(params.request as RpcRequest<{ since?: Record<string, number> }>, controller.signal)
      : api.events.host(params.request as RpcRequest<{}>, controller.signal)
    try {
      for await (const frame of stream) this.transport.notify('api.stream.frame', { streamId: params.streamId, frame })
    } catch (error) {
      if (!controller.signal.aborted) this.transport.notify('runtime.error', {
        code: 'stream-failed', message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.transport.notify('api.stream.end', { streamId: params.streamId })
      this.streams.delete(params.streamId)
    }
  }

  private async closeStream(streamId: string): Promise<Record<string, never>> {
    this.streams.get(streamId)?.controller.abort()
    return {}
  }

  private async cancel(requestId: string): Promise<Record<string, never>> {
    this.requests.get(requestId)?.abort()
    return {}
  }

  private shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= (async () => {
      for (const stream of this.streams.values()) stream.controller.abort()
      await Promise.allSettled([...this.streams.values()].map(stream => stream.task))
      this.streams.clear()
      return {}
    })()
    return this.shutdownTask
  }
}

/** Stable Cordis plugin name. */
export const name = 'desktop-ipc-server'
export const inject = ['apiProxy']

/** Mount the desktop bridge over stdio. */
export function apply(ctx: Context, config: DesktopIpcConfig = {}): void {
  const transport = new JsonRpcLineTransport(config.input ?? process.stdin, config.output ?? process.stdout)
  const server = new DesktopIpcServer(ctx, transport)
  transport.onRequest((method, params) => server.handleRequest(method, params))
  ctx.effect(() => {
    transport.start()
    return async () => { await server.handleRequest('runtime.shutdown', {}); transport.close() }
  }, 'desktop-ipc-server')
}
