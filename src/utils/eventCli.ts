/**
 * @fileoverview EventKit helper execution wrapper
 * @module utils/eventCli
 * @description Spawns this repository's separately signed read-only and
 * create-only Swift helpers, translating stdout / stderr / exit status into
 * JSON or domain-specific errors.
 */

import type { ExecFileException } from 'node:child_process';
import { execFile } from 'node:child_process';
import path from 'node:path';
import {
  findSecureBinaryPath,
  getEnvironmentBinaryConfig,
} from './binaryValidator.js';
import { FILE_SYSTEM } from './constants.js';
import { CliUserError } from './errorHandling.js';
import { bufferToString } from './helpers.js';
import { findProjectRoot } from './projectUtils.js';

/**
 * How to launch the helper through its mandatory TCC responsibility shim.
 * TCC-responsible process — the EventKit permission prompt then appears
 * regardless of whether the host MCP client (Codex Desktop, Claude Desktop,
 * …) declares EventKit usage strings (issue #93).
 */
interface ResolvedLaunch {
  cliPath: string;
  disclaimPath: string;
}

/** Clears mutable warning state (kept under the historical test helper name). */
export function clearEventBinaryPathCache(): void {
  warnedInvalidTimeout = false;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function requireSha256Environment(
  name: string,
  value: string | undefined,
): string {
  const normalized = value?.trim();
  if (!normalized || !SHA256_PATTERN.test(normalized)) {
    throw new CliUserError(
      `${name} is required and must be the 64-character SHA-256 printed by \`pnpm run build:helper\`.`,
    );
  }
  return normalized.toLowerCase();
}

/**
 * Maximum wall-clock time the EventKit helper may run before it is killed
 * (default 30 s, overridable via `EVENTKIT_CLI_TIMEOUT_MS`). `execFile`'s
 * default timeout is 0 — "wait forever" — which hangs the MCP request and
 * leaks a child when the helper blocks on an EventKit permission prompt that can
 * never be displayed (headless/launchd context, issue #113). Killed with
 * SIGKILL because the disclaim shim exec-replaces itself into the helper
 * (same PID), so the kill always reaches the real process.
 */
const DEFAULT_CLI_TIMEOUT_MS = 30_000;

// Node's internal timer clamps at 2^31 - 1 ms (emitting a
// TimeoutOverflowWarning and killing ~immediately); clamp here so absurd
// values mean "effectively no timeout" instead of an instant SIGKILL.
const MAX_CLI_TIMEOUT_MS = 2_147_483_647;

// Emitted once per process so a silently-ignored (invalid/zero) timeout
// config is diagnosable from the host's MCP server logs.
let warnedInvalidTimeout = false;

function warnInvalidTimeout(raw: string): void {
  if (!warnedInvalidTimeout && process.env.NODE_ENV !== 'test') {
    warnedInvalidTimeout = true;
    console.error(
      `Invalid EVENTKIT_CLI_TIMEOUT_MS value "${raw}" — expected a positive integer ` +
        `number of milliseconds (e.g. 30000 or 120_000); falling back to ` +
        `${DEFAULT_CLI_TIMEOUT_MS}. Zero cannot disable the timeout.`,
    );
  }
}

function resolveCliTimeoutMs(): number {
  const raw = process.env.EVENTKIT_CLI_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_CLI_TIMEOUT_MS;
  // Accept numeric-separator syntax ("120_000", matching this file's own
  // `30_000` literals) but nothing else: exponent/hex forms ("1e3", "0x10")
  // would silently change meaning, commas are locale-dependent.
  const digits = raw.trim().replace(/_/g, '');
  if (!/^\d+$/.test(digits)) {
    warnInvalidTimeout(raw);
    return DEFAULT_CLI_TIMEOUT_MS;
  }
  const parsed = Number(digits);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    warnInvalidTimeout(raw);
    return DEFAULT_CLI_TIMEOUT_MS;
  }
  return Math.min(parsed, MAX_CLI_TIMEOUT_MS);
}

interface ExecResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
  /** The enforced timeout for this spawn (captured once at spawn time). */
  timeoutMs: number;
}

const execFilePromise = (
  cliPath: string,
  args: string[],
): Promise<{ result: ExecResult; error: ExecFileException | null }> =>
  new Promise((resolve) => {
    const timeoutMs = resolveCliTimeoutMs();
    execFile(
      cliPath,
      args,
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        // Hand both branches to the caller so it can decide based on stderr
        // content rather than the exit code alone — `event` emits structured
        // EventCLIError messages on stderr regardless of which exit code path
        // ArgumentParser chose (1 for app errors, 64 for usage errors).
        resolve({
          result: { stdout, stderr, timeoutMs },
          error: error ?? null,
        });
      },
    );
  });

export type PermissionDomain = 'reminders' | 'calendars';

/**
 * Detects an `event` permission error and which EventKit domain it belongs to.
 *
 * `event`'s error format is `Error: Permission denied: <domain-specific text>`
 * where the domain word ("Reminders" / "Reminder" or "Calendar"/"Calendars")
 * always appears in the second half of the message. We match anchored on the
 * "Permission denied" prefix so we never misclassify the unrelated phrase
 * "permission" used in normal output.
 */
// An ordered array (not a `Record`) because iteration order matters: a
// defensive message that names both domains is attributed to whichever
// pattern appears first here, and `Record`/`Object.entries` iteration order
// isn't guaranteed by the type system even though it happens to match
// insertion order at runtime.
const PERMISSION_DOMAIN_PATTERNS: [PermissionDomain, RegExp][] = [
  ['reminders', /Permission denied:[\s\S]*?reminders?/i],
  ['calendars', /Permission denied:[\s\S]*?calendars?/i],
];

function detectPermissionDomain(message: string): PermissionDomain | null {
  for (const [domain, pattern] of PERMISSION_DOMAIN_PATTERNS) {
    if (pattern.test(message)) {
      return domain;
    }
  }
  return null;
}

/** Custom error class for permission-related failures from the `event` CLI. */
export class CliPermissionError extends Error {
  constructor(
    message: string,
    public readonly domain: PermissionDomain,
  ) {
    super(message);
    this.name = 'CliPermissionError';
  }
}

/**
 * Pulls the meaningful message out of `event`'s stderr. ArgumentParser prepends
 * `Error: ` to every EventCLIError and to its own usage errors, so we strip
 * that and trim trailing whitespace. The boolean signals whether the stderr
 * looked like a structured event-emitted error or some other failure mode.
 */
function extractStderrMessage(stderr: string): {
  message: string;
  hadErrorPrefix: boolean;
} {
  const trimmed = stderr.replace(/\r?\n/g, '\n').trim();
  if (!trimmed) return { message: '', hadErrorPrefix: false };
  if (trimmed.startsWith('Error: ')) {
    return {
      message: trimmed.slice('Error: '.length),
      hadErrorPrefix: true,
    };
  }
  return { message: trimmed, hadErrorPrefix: false };
}

function throwForStderr(stderr: string): never {
  const { message, hadErrorPrefix } = extractStderrMessage(stderr);
  if (!message) {
    throw new Error('event execution failed: unknown error');
  }
  // The disclaim shim reports its own spawn failures as
  // `eventkit-read-helper-disclaim: <detail>` (no "Error: " prefix).
  // as user-actionable errors — otherwise production error formatting
  // collapses them into a generic "System error occurred".
  if (
    message.startsWith('eventkit-read-helper-disclaim:') ||
    message.startsWith('eventkit-calendar-create-helper-disclaim:') ||
    message.startsWith('eventkit-reminder-create-helper-disclaim:')
  ) {
    throw new CliUserError(message);
  }
  // Only structured "Error: ..." stderr is treated as a user-actionable
  // CliUserError or permission error. Anything else (panics, OS-level
  // failures, etc.) is wrapped so the host surface mentions the `event`
  // binary instead of attributing the message to our own code.
  if (!hadErrorPrefix) {
    throw new Error(`event execution failed: ${message}`);
  }
  const domain = detectPermissionDomain(message);
  if (domain) {
    throw new CliPermissionError(message, domain);
  }
  throw new CliUserError(message);
}

async function runEventCli(
  launch: ResolvedLaunch,
  args: string[],
  mutationTarget?: 'calendar event' | 'reminder',
): Promise<ExecResult> {
  const { result, error } = await execFilePromise(launch.disclaimPath, [
    launch.cliPath,
    ...args,
  ]);
  const stderr = bufferToString(result.stderr) ?? '';

  if (error) {
    // Check the timeout first: `killed: true` is set only when *we* killed
    // the child (verified: external signal deaths leave it false), so it is
    // timeout-specific. stderr flushed before the kill is appended rather
    // than allowed to mask the timeout diagnosis.
    if (error.killed) {
      const stderrDetail = stderr
        ? ` (stderr before kill: ${stderr.trim()})`
        : '';
      const mutationWarning = mutationTarget
        ? ` The ${mutationTarget} may already have been created. Do not retry automatically; inspect the target ${mutationTarget === 'calendar event' ? 'calendar' : 'reminder list'} first to avoid a duplicate.`
        : '';
      throw new CliUserError(
        `event execution failed: timed out after ${result.timeoutMs} ms (killed)${stderrDetail}.${mutationWarning} ` +
          'The CLI was stuck — possible causes: an EventKit permission prompt that cannot ' +
          'be displayed (headless/launchd context), a slow operation exceeding the timeout, ' +
          'or a stalled system. Grant access in System Settings > Privacy & Security if a ' +
          'prompt was expected; otherwise raise EVENTKIT_CLI_TIMEOUT_MS.',
      );
    }
    if (stderr) {
      throwForStderr(stderr);
    }
    const msg = error.message || String(error);
    throw new Error(`event execution failed: ${msg}`);
  }

  return result;
}

function resolveLaunchOrThrow(): ResolvedLaunch {
  const projectRoot = findProjectRoot();
  const binaryName = FILE_SYSTEM.SWIFT_BINARY_NAME;
  const canonicalPath = path.join(projectRoot, 'bin', binaryName);
  const helperHash = requireSha256Environment(
    'EVENTKIT_HELPER_SHA256',
    process.env.EVENTKIT_HELPER_SHA256,
  );

  // Restrict validation to the one absolute helper path in this checkout.
  const config = {
    ...getEnvironmentBinaryConfig(),
    expectedHash: helperHash,
    allowedPaths: [canonicalPath],
  };

  const { path: cliPath } = findSecureBinaryPath([canonicalPath], config);
  if (!cliPath) {
    throw new CliUserError(
      `Read-only EventKit helper was not found or failed integrity/signature validation at ${canonicalPath}.

The repository-owned helper is built only by an explicit command and requires
the exact SHA-256 printed by that build.

From the repository root, build it explicitly:
   pnpm install --ignore-scripts --frozen-lockfile
   pnpm run build:helper
   pnpm run build:ts

Then set EVENTKIT_HELPER_SHA256 and EVENTKIT_DISCLAIM_SHA256 to the values
printed by the build in your MCP client environment.`,
    );
  }

  const disclaimCanonicalPath = path.join(
    projectRoot,
    'bin',
    FILE_SYSTEM.DISCLAIM_BINARY_NAME,
  );
  const { path: disclaimPath } = findSecureBinaryPath([disclaimCanonicalPath], {
    ...getEnvironmentBinaryConfig(),
    expectedHash: requireSha256Environment(
      'EVENTKIT_DISCLAIM_SHA256',
      process.env.EVENTKIT_DISCLAIM_SHA256,
    ),
    maxFileSize: 1024 * 1024,
    allowedPaths: [disclaimCanonicalPath],
  });

  if (!disclaimPath) {
    throw new CliUserError(
      `EventKit responsibility shim was not found or failed integrity/signature validation at ${disclaimCanonicalPath}. Rebuild with \`pnpm run build:helper\` and update EVENTKIT_DISCLAIM_SHA256.`,
    );
  }

  return { cliPath, disclaimPath };
}

function resolveCreateLaunchOrThrow(): ResolvedLaunch {
  const projectRoot = findProjectRoot();
  const binaryName = FILE_SYSTEM.CALENDAR_CREATE_BINARY_NAME;
  const canonicalPath = path.join(projectRoot, 'bin', binaryName);
  const helperHash = requireSha256Environment(
    'EVENTKIT_CREATE_HELPER_SHA256',
    process.env.EVENTKIT_CREATE_HELPER_SHA256,
  );
  const { path: cliPath } = findSecureBinaryPath([canonicalPath], {
    ...getEnvironmentBinaryConfig(),
    expectedHash: helperHash,
    allowedPaths: [canonicalPath],
  });
  if (!cliPath) {
    throw new CliUserError(
      `Create-only EventKit helper was not found or failed integrity/signature validation at ${canonicalPath}. Rebuild with \`pnpm run build:helper\` and update EVENTKIT_CREATE_HELPER_SHA256.`,
    );
  }

  const disclaimCanonicalPath = path.join(
    projectRoot,
    'bin',
    FILE_SYSTEM.CALENDAR_CREATE_DISCLAIM_BINARY_NAME,
  );
  const { path: disclaimPath } = findSecureBinaryPath([disclaimCanonicalPath], {
    ...getEnvironmentBinaryConfig(),
    expectedHash: requireSha256Environment(
      'EVENTKIT_CREATE_DISCLAIM_SHA256',
      process.env.EVENTKIT_CREATE_DISCLAIM_SHA256,
    ),
    maxFileSize: 1024 * 1024,
    allowedPaths: [disclaimCanonicalPath],
  });
  if (!disclaimPath) {
    throw new CliUserError(
      `Create-helper responsibility shim was not found or failed integrity/signature validation at ${disclaimCanonicalPath}. Rebuild with \`pnpm run build:helper\` and update EVENTKIT_CREATE_DISCLAIM_SHA256.`,
    );
  }
  return { cliPath, disclaimPath };
}

function resolveReminderCreateLaunchOrThrow(): ResolvedLaunch {
  const projectRoot = findProjectRoot();
  const binaryName = FILE_SYSTEM.REMINDER_CREATE_BINARY_NAME;
  const canonicalPath = path.join(projectRoot, 'bin', binaryName);
  const helperHash = requireSha256Environment(
    'EVENTKIT_REMINDER_CREATE_HELPER_SHA256',
    process.env.EVENTKIT_REMINDER_CREATE_HELPER_SHA256,
  );
  const { path: cliPath } = findSecureBinaryPath([canonicalPath], {
    ...getEnvironmentBinaryConfig(),
    expectedHash: helperHash,
    allowedPaths: [canonicalPath],
  });
  if (!cliPath) {
    throw new CliUserError(
      `Reminder create-only EventKit helper was not found or failed integrity/signature validation at ${canonicalPath}. Rebuild with \`pnpm run build:helper\` and update EVENTKIT_REMINDER_CREATE_HELPER_SHA256.`,
    );
  }

  const disclaimCanonicalPath = path.join(
    projectRoot,
    'bin',
    FILE_SYSTEM.REMINDER_CREATE_DISCLAIM_BINARY_NAME,
  );
  const { path: disclaimPath } = findSecureBinaryPath([disclaimCanonicalPath], {
    ...getEnvironmentBinaryConfig(),
    expectedHash: requireSha256Environment(
      'EVENTKIT_REMINDER_CREATE_DISCLAIM_SHA256',
      process.env.EVENTKIT_REMINDER_CREATE_DISCLAIM_SHA256,
    ),
    maxFileSize: 1024 * 1024,
    allowedPaths: [disclaimCanonicalPath],
  });
  if (!disclaimPath) {
    throw new CliUserError(
      `Reminder create-helper responsibility shim was not found or failed integrity/signature validation at ${disclaimCanonicalPath}. Rebuild with \`pnpm run build:helper\` and update EVENTKIT_REMINDER_CREATE_DISCLAIM_SHA256.`,
    );
  }
  return { cliPath, disclaimPath };
}

/**
 * Executes the read-only helper and parses its stdout as raw JSON.
 *
 * @template T - Expected JSON type emitted by `event`
 * @param args - Full argv (including subcommand and `--json` where supported)
 * @returns Parsed JSON value
 * @throws {CliPermissionError} on EventKit permission failure (domain-typed)
 * @throws {CliUserError} on application errors surfaced by `event` (Not found,
 *   Invalid input, ArgumentParser usage errors)
 * @throws {Error} when stdout is empty or unparseable
 *
 * @security
 * - Uses `execFile` (not `exec`) so shell metacharacters in argv are inert.
 * - Argv is passed as an array; each token is delivered to the binary verbatim
 *   via `execve()`, preventing argument-boundary injection.
 * - Binary path is validated against an allowlist tied to the project root.
 */
export async function executeEventCliJson<T>(args: string[]): Promise<T> {
  const launch = resolveLaunchOrThrow();
  const { stdout } = await runEventCli(launch, args);
  const normalized = bufferToString(stdout);
  if (!normalized) {
    throw new Error('event execution failed: Empty CLI output');
  }
  try {
    return JSON.parse(normalized) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`event execution failed: Invalid CLI output - ${detail}`);
  }
}

/** Executes the separately signed create-only Calendar helper. */
export async function executeCalendarCreateCliJson<T>(
  args: string[],
): Promise<T> {
  const launch = resolveCreateLaunchOrThrow();
  const { stdout } = await runEventCli(launch, args, 'calendar event');
  const normalized = bufferToString(stdout);
  if (!normalized) {
    throw new Error('event creation failed: Empty CLI output');
  }
  try {
    return JSON.parse(normalized) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`event creation failed: Invalid CLI output - ${detail}`);
  }
}

/** Executes the separately signed create-only Reminders helper. */
export async function executeReminderCreateCliJson<T>(
  args: string[],
): Promise<T> {
  const launch = resolveReminderCreateLaunchOrThrow();
  const { stdout } = await runEventCli(launch, args, 'reminder');
  const normalized = bufferToString(stdout);
  if (!normalized) {
    throw new Error('reminder creation failed: Empty CLI output');
  }
  try {
    return JSON.parse(normalized) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`reminder creation failed: Invalid CLI output - ${detail}`);
  }
}

/**
 * Executes the `event` binary and returns its trimmed stdout as plain text.
 * Used for commands that emit a success message instead of JSON (e.g.
 * `event reminders delete` returns "Reminder deleted successfully").
 */
export async function executeEventCliPlain(args: string[]): Promise<string> {
  const launch = resolveLaunchOrThrow();
  const { stdout } = await runEventCli(launch, args);
  const normalized = bufferToString(stdout) ?? '';
  return normalized.trim();
}
