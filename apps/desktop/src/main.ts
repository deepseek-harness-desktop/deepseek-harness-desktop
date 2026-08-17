import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

interface TauriIpcBridge {
  invoke(channel: string, endpoint: string, request: unknown, signal?: AbortSignal): Promise<unknown>
  cancel(requestId: string): Promise<void>
  openStream(streamId: string, stream: 'mux' | 'host', request: unknown, signal: AbortSignal): Promise<void>
  listenStream(streamId: string, listener: (frame: unknown) => void): Promise<() => void>
  closeStream(streamId: string): Promise<void>
  loadBundle(url: string): Promise<void>
}

declare global { var __DSH_BOOT__: unknown }

interface RuntimeNotification {
  method: string
  params: { streamId?: string; frame?: unknown }
}

const listeners = new Map<string, Set<(frame: unknown) => void>>()

const bridge: TauriIpcBridge = {
  async invoke(channel, endpoint, request, signal) {
    return invoke('runtime_invoke', { channel, endpoint, request, signal: signal?.aborted === true })
  },
  async cancel(requestId) {
    await invoke('runtime_cancel', { requestId })
  },
  async openStream(streamId, stream, request, signal) {
    if (signal.aborted) throw new Error('stream open aborted')
    await invoke('runtime_open_stream', { streamId, stream, request })
  },
  async listenStream(streamId, listener) {
    let bucket = listeners.get(streamId)
    if (bucket === undefined) {
      bucket = new Set()
      listeners.set(streamId, bucket)
    }
    bucket.add(listener)
    return () => {
      bucket?.delete(listener)
      if (bucket?.size === 0) listeners.delete(streamId)
    }
  },
  async closeStream(streamId) {
    await invoke('runtime_close_stream', { streamId })
  },
  async loadBundle(url) {
    const id = decodeURIComponent(new URL(url, 'http://dsh.internal').pathname.split('/')[2] ?? '')
    const result = await invoke<{ id: string; source: string }>('runtime_bundle', { id })
    const script = document.createElement('script')
    const objectUrl = URL.createObjectURL(new Blob([result.source], { type: 'text/javascript' }))
    script.src = objectUrl
    await new Promise<void>((resolve, reject) => {
      script.addEventListener('load', () => resolve(), { once: true })
      script.addEventListener('error', () => reject(new Error(`desktop: client bundle ${id} failed to load`)), { once: true })
      document.head.append(script)
    })
    script.remove()
    URL.revokeObjectURL(objectUrl)
  },
}

;(globalThis as unknown as { __DSH_TAURI_IPC__: TauriIpcBridge }).__DSH_TAURI_IPC__ = bridge

await listen<RuntimeNotification>('dsh://runtime-notification', (event) => {
  const notification = event.payload
  if (notification.method !== 'api.stream.frame' || notification.params.streamId === undefined) return
  for (const listener of listeners.get(notification.params.streamId) ?? []) {
    if (notification.params.frame !== undefined) listener(notification.params.frame)
  }
})

const root = document.querySelector<HTMLElement>('#root')
if (root === null) throw new Error('desktop: missing #root')

try {
  const initialized = await invoke<{ boot?: unknown }>('runtime_start')
  if (initialized.boot === undefined) throw new Error('desktop: runtime did not return a client boot manifest')
  ;(globalThis as { __DSH_BOOT__: unknown }).__DSH_BOOT__ = initialized.boot
  await new AppWebEntry(root, { loadBundle: bridge.loadBundle }).run()
} catch (error) {
  root.innerHTML = `<section style="font-family: system-ui; max-width: 760px; margin: 12vh auto; padding: 2rem"><h1>DeepSeek Harness Desktop</h1><p>Runtime failed to start: ${String(error)}</p></section>`
}
