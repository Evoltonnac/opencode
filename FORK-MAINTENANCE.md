# NaiVerse fork: OpenCode v2.4.1

This tree merges the v2.4.1 upstream tag into the maintained `naiverse-image` branch. The older `lite` history remains available.

## Memory changes

- Keep media selection before loading stored bytes, native base64 encoding, continuation comparison without JSON copies, and defer image reads until a generation job acquires the shared permit. These protect long or image-heavy sessions without changing the persisted session format.
- Keep lazy HTTP-body construction for healthy incremental OpenAI Responses WebSocket turns. A WebSocket failure still materializes the canonical HTTP fallback request.
- Use upstream Photon's serialized worker and 10-second idle shutdown instead of the fork's custom immediate-retirement lifecycle. The distinctive immediate-retirement peak savings were not established.
- Do not port `lite`'s custom segmented JSON encoder into this release. Healthy incremental WebSocket and upstream zstd support remain. Large uncompressed HTTP fallback requests may allocate more memory than that branch; this is a deliberate tradeoff, not a claim of identical peaks.

## Codex subscription images

The generic models.dev OpenAI API record for `gpt-image-2` is deprecated and remains filtered. The fork restores the same model ID only with an active Codex browser or device-code login and the Codex subscription catalog (or the known official ID when that catalog is absent). It does not override a custom OpenAI endpoint. The tool fails closed when the configured subscribed default cannot be used rather than selecting another provider, and checks the subscription again before dispatch. This alias does not identify the backend engine selected by OpenAI.

The tool is named `generate_image` in v2.4.1. Declarative image permissions from the older name are normalized by upstream; stored `Always Allow` decisions under the old tool name may need to be granted again. Do not broaden the existing model allowlist to recover them.

## Reusing a supervised server from local OpenCode commands

A foreground `opencode serve` started by systemd is not registered as the CLI's managed background service. For the NaiVerse VPS, add `Environment=OPENCODE_LOCAL_SERVER_PORT=4096` to the main service's `[Service]` drop-in, matching its existing loopback listener. Do not set this as a global login environment variable. Keep the existing server password configuration; do not put the password in command arguments or in this drop-in.

A child CLI that inherits this setting connects to `127.0.0.1` at that port with the existing password. Invalid configuration, an unavailable listener, or authentication failure is an error, not a reason to spawn a second server. Explicit `--server` or `--standalone` still acts as specified. An environment that does not inherit the setting (including remote shells and explicitly replaced session environments) retains normal CLI behavior. After restart, verify a nested `opencode api get /api/info` returns the systemd main PID. Roll back by removing the single setting and restarting the unit.
