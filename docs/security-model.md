# Security model

## Goal

Allow a local MCP client to read Apple Calendar and Reminders data and, after explicit approval, create exactly one event or reminder in a specifically selected writable target.

## Trust boundaries

```text
MCP client / model
        |
        | untrusted JSON-RPC tool call
        v
TypeScript MCP server
  - advertises five reads and two create tools
  - rejects extra create properties at runtime
  - forces the action implied by each independent tool name
        |
        +-- argv, no shell --> read helper --> Calendar / Reminders reads
        |
        +-- argv, no shell --> event-create helper --> one Calendar save
        |
        +-- argv, no shell --> reminder-create helper --> one Reminders save
```

Calendar event fields, reminder fields, URLs, attendee data, list names, notes, and native-helper output are untrusted content. They may contain prompt-injection text. They are data to summarize or display, never instructions to invoke another tool, run code, reveal secrets, or change approval policy.

## Initial controls

- The server advertises no prompt capability and only two mutation tools: `calendar_event_create` and `reminder_create`.
- Read operations use separate tool names rather than an `action` discriminator.
- Each advertised schema sets `additionalProperties: false`. Both create schemas are strict at runtime, require `confirmed: true`, and accept only their documented fields and one stable target ID.
- The router places its internal read/create action after caller arguments so a forged action cannot override the independently named route.
- Tool-name dispatch checks own properties, preventing prototype-chain names such as `toString` from becoming routes.
- The native process is launched with `execFile` and an argv array, not through a shell.
- All three helpers and three TCC shims are constrained to exact repository `bin/` paths, reject symbolic links, require valid code signatures, and require separate exact SHA-256 environment pins.
- Native calls have a finite timeout and output-size cap.
- Runtime dependencies are exact-version pinned in both the manifest and lockfile.
- The project is private and is not published to npm during hardening.

## Residual risks

### Full native read permission

Apple does not provide read-only Reminders authorization, so the helper receives full EventKit authorization even though it implements no save/remove operations. A vulnerability in EventKit, the helper parser/mapping code, its build chain, or a future native change could still cross the intended boundary. Native source changes therefore require explicit review.

### Full Calendar permission for specific-calendar creation

EventKit write-only authorization does not expose real calendar metadata, so it cannot reliably select a requested calendar. The create helper therefore has full Calendar permission, resolves only the caller-supplied stable calendar ID, verifies that calendar is writable and event-capable, and exposes only one save command. A compromise of that binary would nevertheless inherit full Calendar access.

### Full Reminders permission for specific-list creation

Selecting a specifically requested reminder list by stable EventKit ID requires access to list metadata. The reminder-create helper therefore has full Reminders permission, resolves only the caller-supplied ID, verifies the list is writable and reminder-capable, and exposes only one save command. A compromise of that binary would nevertheless inherit full Reminders access.

### Retry ambiguity

Calendar and reminder creation are not idempotent. The server never retries them automatically. If a helper times out, the response says the item may already exist and requires inspecting the exact target before any retry. Concurrent or manual duplicate calls can still create duplicates.

### Supply chain

The repository includes npm dependencies, C code for a launch shim, repository-owned Swift source, and native signing logic. A lockfile and runtime hashes do not make those components inherently trustworthy. Review native source/build changes and avoid automatic dependency update merging.

### Local data disclosure

Read-only access can still expose highly sensitive information. Tool results flow into the MCP client and potentially its model provider. Users must understand the client's retention, logging, and data-use settings before granting access.

### Prompt injection

MCP annotations and descriptions are guidance, not a security boundary. The client remains responsible for treating returned fields as data and asking for approval before any unrelated tool use.

## Additional write-support release gates

Both create tools implement the applicable controls below. Every additional write tool must independently satisfy them:

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
- All updates, deletions, completion, recurrence, attendee, alarm, and availability changes
