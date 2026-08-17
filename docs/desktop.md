# Desktop application

The desktop application is a Tauri 2 shell around a local dsh runtime. The
Rust process owns the window and sidecar lifecycle; the Node runtime owns
Cordis, Agent, Session, tools, and the Host API.

The sidecar speaks newline-delimited JSON-RPC over stdin/stdout. Unary API
calls use `api.invoke`, event streams use `api.stream.open` and
`api.stream.frame`, and shutdown uses `runtime.shutdown`. The browser-safe
`IApiClient` contract is reused by `TauriApiClient`, so UI packages do not
depend on Tauri APIs directly.

Run the shell during development with:

```sh
pnpm run dev:desktop
```

The default runtime command is `dsh --profile desktop`. Set
`DSH_DESKTOP_RUNTIME` to an alternate executable when testing a packaged
sidecar.

The desktop profile mounts `dsh-base`, the API proxy, workspace services, the
client module graph, and the desktop IPC server. It does not bind an HTTP port.
The runtime returns the composed Web boot manifest over IPC, and Tauri retrieves
client bundles over IPC before mounting the existing React Web UI through
`AppWebEntry`.

Build installers with:

```sh
pnpm run build:desktop
```

`build:desktop` first builds a target-specific Node sidecar with
`scripts/build-desktop-sidecar.ts`, places it under the Tauri `externalBin`
directory, and then creates the installer. The target is selected from
`TAURI_ENV_TARGET_TRIPLE` or the local Rust host. Windows sidecars and
installers must be built on a Windows CI runner. The repository workflow
`.github/workflows/desktop-packaging.yml` runs the macOS and Windows packaging
matrix and uploads the installers as CI artifacts.

The configured targets are macOS DMG and Windows MSI/NSIS. Cross-platform
installer builds must run on their native CI runners because the Tauri
toolchain and bundled runtime executable are platform-specific.
