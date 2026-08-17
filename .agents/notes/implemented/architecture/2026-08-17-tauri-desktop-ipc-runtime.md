# Agent Note: Tauri desktop runtime and IPC transport

Status: implemented

[中文](2026-08-17-tauri-desktop-ipc-runtime.zh.md) | English

## Problem

The desktop application needs the existing React surface and TypeScript Harness runtime without exposing a local HTTP listener or duplicating Agent and Session logic in Rust.

## Decision

Tauri owns the native window and process lifecycle, while a Node sidecar owns the assembled Harness runtime. The sidecar exposes a newline JSON-RPC bridge over stdio; Tauri forwards runtime initialization, API calls, cancellation, streams, client boot manifests, and client bundles. The desktop profile keeps the shared web route registry available for existing plugins but disables its TCP listener. Platform sidecars are built from the CLI deployment closure with the existing pkg/SEA route and are supplied to Tauri through `externalBin`.

## Alternatives considered

**Rewrite runtime services in Rust.** Rejected because it would duplicate Agent, Session, tools, persistence, and provider behavior and create a second product runtime.

**Expose the existing Web HTTP server inside the desktop process.** Rejected because the desktop contract requires IPC as the formal application channel and a local port adds lifecycle, trust, and resource-path complexity.

**Maintain a separate desktop React application.** Rejected because it would split UI behavior and require parallel feature work; the existing `AppWebEntry` and client module graph already provide the reusable surface.

## Consequences

The desktop and Web surfaces share the same client modules and API contracts. Rust remains a transport and lifecycle layer rather than a business dispatcher. Packaging must run on native macOS and Windows runners because sidecar executables and installers are platform-specific. The generated sidecar is a build artifact and is not committed to the repository.
