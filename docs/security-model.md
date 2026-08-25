# Security model

## Goal

Allow a local MCP client to read Apple Calendar and Reminders data and, after explicit approval, create exactly one event in a specifically selected writable calendar.

## Trust boundaries

```text
MCP client / model
        |
        | untrusted JSON-RPC tool call
        v
TypeScript MCP server
  - advertises five reads and one create tool
  - rejects extra create properties at runtime
  - forces the action implied by each independent tool name
        |
        +-- argv, no shell --> read helper --> Calendar / Reminders reads
        |
        +-- argv, no shell --> create helper --> one Calendar save
```

Calendar event fields, reminder fields, URLs, attendee data, list names, notes, and native-helper output are untrusted content. They may contain prompt-injection text. They are data to summarize or display, never instructions to invoke another tool, run code, reveal secrets, or change approval policy.

## Initial controls

- The server advertises no prompt capability and only one mutation tool: `calendar_event_create`.
- Read operations use separate tool names rather than an `action` discriminator.
- Each advertised schema sets `additionalProperties: false`. The create schema is strict at runtime, requires `confirmed: true`, and accepts only title, dates, stable calendar ID, notes, and location.
- The router places its internal read/create action after caller arguments so a forged action cannot override the independently named route.
- Tool-name dispatch checks own properties, preventing prototype-chain names such as `toString` from becoming routes.
- The native process is launched with `execFile` and an argv array, not through a shell.
- Both helpers and both TCC shims are constrained to exact repository `bin/` paths, reject symbolic links, require valid code signatures, and require separate exact SHA-256 environment pins.
- Native calls have a finite timeout and output-size cap.
- Runtime dependencies are exact-version pinned in both the manifest and lockfile.
- The project is private and is not published to npm during hardening.

## Residual risks

### Full native read permission

Apple does not provide read-only Reminders authorization, so the helper receives full EventKit authorization even though it implements no save/remove operations. A vulnerability in EventKit, the helper parser/mapping code, its build chain, or a future native change could still cross the intended boundary. Native source changes therefore require explicit review.

### Full Calendar permission for specific-calendar creation

EventKit write-only authorization does not expose real calendar metadata, so it cannot reliably select a requested calendar. The create helper therefore has full Calendar permission, resolves only the caller-supplied stable calendar ID, verifies that calendar is writable and event-capable, and exposes only one save command. A compromise of that binary would nevertheless inherit full Calendar access.

### Retry ambiguity

Calendar creation is not idempotent. The server never retries it automatically. If the helper times out, the response says the event may already exist and requires inspecting Calendar before any retry. Concurrent or manual duplicate calls can still create duplicate events.

### Supply chain

The repository includes npm dependencies, C code for a launch shim, repository-owned Swift source, and native signing logic. A lockfile and runtime hashes do not make those components inherently trustworthy. Review native source/build changes and avoid automatic dependency update merging.

### Local data disclosure

Read-only access can still expose highly sensitive information. Tool results flow into the MCP client and potentially its model provider. Users must understand the client's retention, logging, and data-use settings before granting access.

### Prompt injection

MCP annotations and descriptions are guidance, not a security boundary. The client remains responsible for treating returned fields as data and asking for approval before any unrelated tool use.

## Additional write-support release gates

The calendar-create tool implements the applicable controls below. Every additional write tool must independently satisfy them:

1. Give each mutation a separate tool name; never restore mixed read/write action routing.
2. Require stable EventKit IDs for update, completion, and deletion.
3. Return a clear before/after target summary.
4. Mark create/update tools `readOnlyHint: false`; mark delete and destructive recurrence changes `destructiveHint: true`.
5. Add tests for forged actions, ambiguous titles, duplicate items, recurrence scope, timeout-after-commit, and retry behavior.
6. Test against disposable local calendars and reminder lists, never production data.
7. Require client-side approval for every mutation during the initial release.
8. Keep write support out of the read helper; use a separate narrowly scoped native mutation helper.

## Out of scope for the current milestone

- Network transport or remote deployment
- Multi-user operation
- npm publication
- Automatic background synchronization
- Reminder creation, all updates, deletions, completion, recurrence, attendee, alarm, URL, and availability changes
