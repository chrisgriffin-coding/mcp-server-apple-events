# Security model

## Goal

Allow a local MCP client to read a user's Apple Calendar and Reminders data without giving model-controlled input a route to mutate that data.

## Trust boundaries

```text
MCP client / model
        |
        | untrusted JSON-RPC tool call
        v
TypeScript MCP server
  - advertises five read-only tools
  - rejects extra schema properties
  - forces action=read in the router
        |
        | argv array, no shell
        v
Repository-owned read-only EventKit helper
  - no third-party Swift dependencies
  - no mutation, network, database, Shortcut, or daemon code
        |
        | full EventKit permission
        v
Apple Calendar and Reminders stores
```

Calendar event fields, reminder fields, URLs, attendee data, list names, notes, and native-helper output are untrusted content. They may contain prompt-injection text. They are data to summarize or display, never instructions to invoke another tool, run code, reveal secrets, or change approval policy.

## Initial controls

- The server advertises no prompt capability and no mutation tools.
- Read operations use separate tool names rather than an `action` discriminator.
- Each advertised schema sets `additionalProperties: false` and omits mutation fields; runtime read schemas validate and sanitize arguments again.
- The router places `action: 'read'` after caller arguments so it cannot be overridden.
- Tool-name dispatch checks own properties, preventing prototype-chain names such as `toString` from becoming routes.
- The native process is launched with `execFile` and an argv array, not through a shell.
- The helper and TCC shim paths are constrained to exact repository `bin/` paths, reject symbolic links, require valid code signatures, and require separate exact SHA-256 environment pins.
- Native calls have a finite timeout and output-size cap.
- Runtime dependencies are exact-version pinned in both the manifest and lockfile.
- The project is private and is not published to npm during hardening.

## Residual risks

### Full native read permission

Apple does not provide read-only Reminders authorization, so the helper receives full EventKit authorization even though it implements no save/remove operations. A vulnerability in EventKit, the helper parser/mapping code, its build chain, or a future native change could still cross the intended boundary. Native source changes therefore require explicit review.

### Supply chain

The repository includes npm dependencies, C code for a launch shim, repository-owned Swift source, and native signing logic. A lockfile and runtime hashes do not make those components inherently trustworthy. Review native source/build changes and avoid automatic dependency update merging.

### Local data disclosure

Read-only access can still expose highly sensitive information. Tool results flow into the MCP client and potentially its model provider. Users must understand the client's retention, logging, and data-use settings before granting access.

### Prompt injection

MCP annotations and descriptions are guidance, not a security boundary. The client remains responsible for treating returned fields as data and asking for approval before any unrelated tool use.

## Write-support release gates

Before any write tool is advertised:

1. Give each mutation a separate tool name; never restore mixed read/write action routing.
2. Require stable EventKit IDs for update, completion, and deletion.
3. Return a clear before/after target summary.
4. Mark create/update tools `readOnlyHint: false`; mark delete and destructive recurrence changes `destructiveHint: true`.
5. Add tests for forged actions, ambiguous titles, duplicate items, recurrence scope, timeout-after-commit, and retry behavior.
6. Test against disposable local calendars and reminder lists, never production data.
7. Require client-side approval for every mutation during the initial release.
8. Keep write support out of the read helper; use a separate narrowly scoped native mutation helper.

## Out of scope for the initial milestone

- Network transport or remote deployment
- Multi-user operation
- npm publication
- Automatic background synchronization
- Writes, deletions, completion, or recurrence changes
