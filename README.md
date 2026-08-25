# EventKit MCP Server

A security-focused MCP server for Apple Calendar and Reminders on macOS through EventKit.

This repository began as a fork of [FradSer/mcp-server-apple-events](https://github.com/FradSer/mcp-server-apple-events). The hardened surface exposes five reads and one separately approved calendar-event creation operation.

## Current status

- Local development only; not published to npm.
- Read-only MCP tools for reminders, reminder lists, reminder checklist items, calendar events, and calendars.
- One non-idempotent `calendar_event_create` tool; no update, completion, or deletion tools.
- Native reads and creation use separate dependency-free Swift binaries in `native/`.
- Calendar and Reminders content is explicitly classified as untrusted data.

The read helper requests full EventKit access because Apple does not offer read-only Calendar or Reminders authorization. It contains no save/remove calls. The separate create helper also requires full Calendar access because selecting a specific calendar by stable EventKit ID is impossible under write-only authorization; its command surface contains one save path and no event listing, update, or deletion path. Neither helper has a network client, database, Shortcut integration, or background service. See [SECURITY.md](SECURITY.md) and [docs/security-model.md](docs/security-model.md) before enabling them.

## Requirements

- macOS 14 or later
- Node.js 20 or later
- pnpm 10.28.2
- Xcode Command Line Tools or a compatible Xcode/Swift toolchain

## Local development

Clone, then install without executing package lifecycle scripts during the first review:

```bash
git clone <our-repository-url>
cd mcp-server-eventkit
pnpm install --ignore-scripts --frozen-lockfile
pnpm exec tsc --noEmit --project tsconfig.json
pnpm run build:ts
pnpm test
pnpm exec biome check .
```

Build the native helper after reviewing the repository-owned Swift source:

```bash
pnpm run build:helper
```

The build requires a trusted Apple code-signing identity; ad-hoc signing is rejected. Record all four exact helper and TCC-shim hashes it prints for the MCP configuration below.

No EventKit access is attempted during installation or build. The first read may request Calendar or Reminders permission for `EventKit Read Helper`; the first creation may separately request full Calendar permission for `EventKit Calendar Create Helper`.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `reminders_read` | Read and filter reminders |
| `reminder_lists_read` | Read reminder-list metadata |
| `reminder_subtasks_read` | Read checklist items encoded in a reminder note |
| `calendar_events_read` | Read and filter events in a date range |
| `calendars_read` | Read every calendar's stable ID, writable status, and optional date-range event count |
| `calendar_event_create` | Create exactly one approved event in a writable calendar selected by stable ID |

The five read tools are annotated read-only and idempotent. `calendar_event_create` is marked `readOnlyHint: false`, `destructiveHint: false`, and `idempotentHint: false`. It requires `confirmed: true` after the client presents the exact event details and obtains user approval. Every schema sets `additionalProperties: false`; the strict runtime create schema rejects unadvertised fields, calendar names, and default-calendar fallbacks. The router overwrites any forged action with the operation implied by the independently named tool.

Creation requires the exact `calendarId` returned by `calendars_read`. It fails if the ID is missing, read-only, or not event-capable. Bare `YYYY-MM-DD` inputs create all-day events and use an inclusive `endDate`; timed events require an end instant after the start. Creation is not automatically retried: if the native process times out after saving, its result explicitly says the outcome is unknown and Calendar must be inspected before retrying.

## Local MCP configuration

After building, configure a local stdio MCP client with an absolute path and the four mandatory hashes shown above.

```json
{
  "mcpServers": {
    "eventkit": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-eventkit/dist/index.js"],
      "env": {
        "EVENTKIT_HELPER_SHA256": "<exact helper hash>",
        "EVENTKIT_DISCLAIM_SHA256": "<exact read shim hash>",
        "EVENTKIT_CREATE_HELPER_SHA256": "<exact create-helper hash>",
        "EVENTKIT_CREATE_DISCLAIM_SHA256": "<exact create shim hash>"
      }
    }
  }
}
```

Keep client approval enabled. Do not use an unreviewed npm or `npx` package in place of this local checkout.

## Codex plugin

This repository is also a local Codex plugin. Its MCP configuration starts a
repository-owned launcher, which reads the four signed-binary hashes from the
build outputs instead of duplicating machine-specific hashes in plugin
configuration. Codex is configured to prompt for non-read-only tools; the
server still independently requires `confirmed: true` for event creation.

Prepare the exact source directory that the local marketplace will snapshot:

```bash
git clone git@github.com:chrisgriffin-coding/mcp-server-apple-events.git ~/plugins/apple-eventkit
cd ~/plugins/apple-eventkit
pnpm install --ignore-scripts --frozen-lockfile
pnpm exec tsc --noEmit --project tsconfig.json
pnpm run build:ts
pnpm test --runInBand
pnpm exec biome check .
pnpm run build:plugin
```

Review both Swift helpers and the signing identity, then explicitly build the
native binaries:

```bash
pnpm run build:helper
node scripts/launch-codex-plugin.mjs
```

The last command starts the stdio server and waits for MCP input; press
Control-C after confirming that it starts without an integrity or signature
error. Add `apple-eventkit` to a trusted local Codex marketplace only after
these checks. The plugin bundle is self-contained because Codex deliberately
excludes `node_modules` from installed plugin snapshots. Rebuild and reinstall
the plugin whenever its server, launcher, dependencies, or native helpers
change so the installed snapshot stays in sync.

## Planned additional write support

Writes will not be added to the read helper. Each mutation will use a separately named MCP tool and narrowly scoped native write helper so a client can distinguish and approve it:

- create reminder
- update reminder or calendar event
- complete a reminder
- delete reminder or calendar event

Destructive tools will require stable EventKit identifiers, explicit target metadata in the response, and separate confirmation-oriented tests before release.

## Attribution and license

Original work copyright its contributors, including Frad Lee. This fork remains available under the [MIT License](LICENSE).
