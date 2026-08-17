# `@deepseek-ai/dsh-desktop`

Desktop profile bundle for the Tauri application. It mounts the shared base
runtime and the transport-only desktop IPC server; it does not open an HTTP
listener or embed a browser server.

## Model Experience

### Desktop runtime composition

#### What the model sees

No additional model-visible content; the selected runtime plugins own the prompt, tool, and session context assembled by `dsh-base`.

#### Token effect

No direct token effect; transport and profile selection do not add model request content.

#### KV Cache effect

None directly; model-visible behavior remains owned by the selected runtime plugins.

## Known Limitations and Deferred Work

- The Web UI boot manifest and client bundles are transported through the desktop IPC bridge.
- Packaged Node sidecar artifacts are generated per target by the Tauri build workflow.
