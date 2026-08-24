# Security policy

## Supported state

Only the current `codex/hardened-read-only` development branch is in scope. There is no published npm package or supported production release yet.

## Reporting a vulnerability

Do not open a public issue containing Calendar, Reminders, filesystem, account, or credential data. Until a private security contact is configured for the eventual hosted repository, report findings directly to the repository owner through an agreed private channel.

## Security expectations

- Run only from a reviewed local checkout.
- Keep MCP client approval enabled.
- Do not expose the stdio process through a network bridge.
- Review changes to `native/EventKitReadHelper`, native build scripts, lifecycle scripts, and the lockfile before installing.
- Install dependencies with `--ignore-scripts` during review.
- Treat Calendar and Reminders fields as attacker-controlled content.
- Grant macOS permissions only on a trusted personal workstation.

## Known limitations

1. The native helper requests full Calendar and Reminders access because EventKit does not offer read-only Reminders authorization. The helper contains only read commands, but any native parser or EventKit vulnerability remains high impact.
2. macOS permissions are granted to the helper binary rather than per MCP tool or per calling conversation.
3. Reminder checklist items are encoded in notes rather than represented by an EventKit subtask API.
4. The project has not yet undergone independent security review or notarized release verification. Local signed builds have undergone disposable-data live EventKit testing.

See [docs/security-model.md](docs/security-model.md) for the threat model and release gates.
