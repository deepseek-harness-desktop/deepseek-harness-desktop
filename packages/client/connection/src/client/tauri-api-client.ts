/** Tauri IPC carrier for the existing browser-safe ApiProxy client. */

import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from './api.ts'
import { AbstractApiClient } from './api.ts'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'

/** Runtime bridge installed by the Tauri application before the client boots. */
export interface TauriIpcBridge {
  /** Invoke one `/api` endpoint through the Rust sidecar bridge. */
  invoke(channel: string, endpoint: string, request: unknown, signal?: AbortSignal): Promise<unknown>
  /** Cancel an in-flight request by its wire rpcId. */
  cancel(requestId: string): Promise<void>
  /** Open a sidecar event stream. */
  openStream(streamId: string, stream: 'mux' | 'host', request: unknown, signal: AbortSignal): Promise<void>
  /** Subscribe to frames from one sidecar event stream. */
  listenStream(streamId: string, listener: (frame: unknown) => void): Promise<() => void>
  /** Close one sidecar event stream. */
  closeStream(streamId: string): Promise<void>
}

declare global {
  // The property is intentionally optional: normal Web builds never install it.
  var __DSH_TAURI_IPC__: TauriIpcBridge | undefined
}

type StreamItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }

/** `AbstractApiClient` implementation over Tauri commands and events. */
export class TauriApiClient extends AbstractApiClient {
  private readonly bridge: TauriIpcBridge

  constructor(bridge: TauriIpcBridge | undefined = globalThis.__DSH_TAURI_IPC__) {
    super()
    if (bridge === undefined) throw new Error('Tauri IPC bridge is not installed')
    this.bridge = bridge
  }

  protected async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const bridge = this.bridge
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    const pathname = input.pathname
    const prefix = '/api/'
    if (!pathname.startsWith(prefix)) throw new Error(`Tauri IPC does not serve ${pathname}`)
    const endpoint = pathname.slice(prefix.length)
    const signal = init?.signal ?? undefined
    const requestId = typeof body === 'object' && body !== null ? String((body as { rpcId?: unknown }).rpcId ?? '') : ''
    const cancel = (): void => { if (requestId !== '') void bridge.cancel(requestId) }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const value = await bridge.invoke('/api', endpoint, body, signal)
      return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  protected override openMux(
    payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.openStream('mux', payload, signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.openStream('host', payload, signal, hostFrameSchema, onOpen)
  }

  private async *openStream<F extends MuxFrame | HostFrame>(
    stream: 'mux' | 'host',
    payload: unknown,
    signal: AbortSignal,
    frameSchema: { parse(value: unknown): F },
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const bridge = this.bridge
    const streamId = `stream-${crypto.randomUUID()}`
    const inbox: StreamItem<F>[] = []
    let wake: (() => void) | undefined
    let unlisten: (() => void) | undefined
    const enqueue = (item: StreamItem<F>): void => { inbox.push(item); wake?.(); wake = undefined }
    const onFrame = (value: unknown): void => {
      try {
        const full = serverRequestSchema.parse(value) as ServerRequest
        const frame = frameSchema.parse(full.payload)
        this.onEnvelope(full)
        enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
      } catch (error) {
        console.error(`[desktop-connection] dropping malformed ${stream} frame:`, error)
      }
    }
    const onAbort = (): void => { void bridge.closeStream(streamId); enqueue({ kind: 'end' }) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      unlisten = await bridge.listenStream(streamId, onFrame)
      await bridge.openStream(streamId, stream, { rpcId: crypto.randomUUID(), payload }, signal)
      onOpen?.()
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as StreamItem<F>
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      unlisten?.()
      await bridge.closeStream(streamId)
    }
  }
}
