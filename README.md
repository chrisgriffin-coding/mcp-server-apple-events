# EventKit MCP Server

A security-focused MCP server for reading Apple Calendar and Reminders data on macOS through EventKit.

This repository began as a fork of [FradSer/mcp-server-apple-events](https://github.com/FradSer/mcp-server-apple-events). The first hardened release intentionally exposes only read operations while its permission, validation, and approval boundaries are established and tested.

## Current status

- Local development only; not published to npm.
- Read-only MCP surface for reminders, reminder lists, reminder checklist items, calendar events, and calendars.
- No MCP prompts or write tools.
- Native EventKit access is provided by the pinned `vendor/event` Swift submodule.
- Calendar and Reminders content is explicitly classified as untrusted data.

The native helper currently requests full EventKit access because Apple does not offer read-only Reminders authorization and the upstream helper uses full Calendar authorization. The MCP server does not advertise or route any mutation, but the helper itself contains write commands. See [SECURITY.md](SECURITY.md) and [docs/security-model.md](docs/security-model.md) before enabling it.

## Requirements

- macOS 14 or later
- Node.js 20 or later
- pnpm 10.28.2
- Xcode Command Line Tools or a compatible Xcode/Swift toolchain

## Local development

Clone with the pinned native submodule, then install without executing package lifecycle scripts during the first review:

```bash
git clone --recurse-submodules <our-repository-url>
cd mcp-server-eventkit
pnpm install --ignore-scripts --frozen-lockfile
pnpm exec tsc --noEmit --project tsconfig.json
pnpm test
pnpm exec biome check .
```

Build the native helper only after reviewing the pinned submodule commit:

```bash
pnpm run build:event
pnpm run build:ts
```

No read will be attempted during installation or build. The first actual EventKit read may cause macOS to request Calendar or Reminders permission for the native `event` helper.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `reminders_read` | Read and filter reminders |
| `reminder_lists_read` | Read reminder-list metadata |
| `reminder_subtasks_read` | Read checklist items encoded in a reminder note |
| `calendar_events_read` | Read and filter events in a date range |
| `calendars_read` | Read calendar names observed in a date range |

Every tool is annotated with `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`. Advertised schemas set `additionalProperties: false` and contain no action discriminator or mutation fields. Runtime read validation strips unrecognized fields, and the router overwrites any unadvertised `action` argument with `read` as defense in depth.

## Local MCP configuration

After building, configure a local stdio MCP client with an absolute path:

```json
{
  "mcpServers": {
    "eventkit": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-eventkit/dist/index.js"]
    }
  }
}
```

Keep client approval enabled. Do not use an unreviewed npm or `npx` package in place of this local checkout.

## Planned write support

Writes will not be re-enabled through the upstream mixed-action tools. Each mutation will be a separate MCP tool so a client can distinguish and approve it:

- create reminder or calendar event
- update reminder or calendar event
- complete a reminder
- delete reminder or calendar event

Destructive tools will require stable EventKit identifiers, explicit target metadata in the response, and separate confirmation-oriented tests before release.

## Attribution and license

Original work copyright its contributors, including Frad Lee. This fork remains available under the [MIT License](LICENSE).
