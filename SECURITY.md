# Security policy

## Supported state

Only the current development branch is in scope. There is no published npm package or supported production release yet.

## Reporting a vulnerability

Do not open a public issue containing Calendar, Reminders, filesystem, account, or credential data. Until a private security contact is configured for the eventual hosted repository, report findings directly to the repository owner through an agreed private channel.

## Security expectations

- Run only from a reviewed local checkout.
- Keep MCP client approval enabled.
- Do not expose the stdio process through a network bridge.
- Review changes to all native helper directories, native build scripts, lifecycle scripts, and the lockfile before installing.
- Install dependencies with `--ignore-scripts` during review.
- Treat Calendar and Reminders fields as attacker-controlled content.
- Grant macOS permissions only on a trusted personal workstation.

## Known limitations

1. The read helper requests full Calendar and Reminders access because EventKit does not offer read-only access. It contains only read commands, but any native parser or EventKit vulnerability remains high impact.
2. The separate event-create and reminder-create helpers request full access to their respective EventKit stores because write-only permission cannot select a specific real calendar or reminder list. Each command surface performs one save and no read/update/complete/delete, but a compromise inherits the broader OS permission.
3. macOS permissions are granted to helper binaries rather than per MCP tool or per calling conversation. `confirmed: true` is defense in depth, not proof that a human approved the call; the MCP client must enforce approval.
4. Calendar and reminder creation are non-idempotent. After a timeout, inspect the exact target before retrying or a duplicate may be created.
5. Reminder checklist items are encoded in notes rather than represented by an EventKit subtask API.
6. The project has not yet undergone independent security review or notarized release verification. Local signed builds use disposable-data live EventKit testing.

See [docs/security-model.md](docs/security-model.md) for the threat model and release gates.
