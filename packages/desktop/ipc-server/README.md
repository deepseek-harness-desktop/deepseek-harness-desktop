# Desktop IPC server

`@deepseek-ai/dsh-desktop-ipc-server` provides the stdio JSON-RPC bridge used by the Tauri desktop runtime.

It handles runtime initialization and shutdown, unary API calls, cancellation, and API event streams. stdout is reserved for protocol frames; runtime diagnostics use the existing logger/stderr path.

## Model Experience

### IPC transport

#### What the model sees

No additional model-visible content; the bridge carries requests and responses assembled by the host `apiProxy` runtime.

#### Token effect

No direct token effect; IPC framing is outside model requests.

#### KV Cache effect

None; the bridge does not assemble or send provider requests.

## Known Limitations and Deferred Work

- The server relies on the host process to provide the assembled desktop profile.
- Packaging and supervision of a platform-specific executable remain Tauri responsibilities.
