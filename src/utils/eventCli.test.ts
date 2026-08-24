/**
 * eventCli.test.ts
 * Tests for the `event` CLI execution wrapper.
 */

import type {
  ChildProcess,
  ExecFileException,
  ExecFileOptions,
} from 'node:child_process';
import { execFile } from 'node:child_process';
import {
  findSecureBinaryPath,
  getEnvironmentBinaryConfig,
} from './binaryValidator.js';
import {
  CliPermissionError,
  clearEventBinaryPathCache,
  executeCalendarCreateCliJson,
  executeEventCliJson,
  executeEventCliPlain,
} from './eventCli.js';
import { findProjectRoot } from './projectUtils.js';

type ExecFileCallback =
  | ((
      error: ExecFileException | null,
      stdout: string | Buffer,
      stderr: string | Buffer,
    ) => void)
  | null
  | undefined;

jest.mock('node:child_process');
jest.mock('./projectUtils.js', () => ({
  findProjectRoot: jest.fn(),
}));
jest.mock('./binaryValidator.js', () => ({
  findSecureBinaryPath: jest.fn(),
  getEnvironmentBinaryConfig: jest.fn(),
}));

const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;
const mockFindProjectRoot = findProjectRoot as jest.MockedFunction<
  typeof findProjectRoot
>;
const mockFindSecureBinaryPath = findSecureBinaryPath as jest.MockedFunction<
  typeof findSecureBinaryPath
>;
const mockGetEnvironmentBinaryConfig =
  getEnvironmentBinaryConfig as jest.MockedFunction<
    typeof getEnvironmentBinaryConfig
  >;

const invokeCallback = (
  optionsOrCallback?: ExecFileOptions | null | ExecFileCallback,
  callback?: ExecFileCallback,
): ExecFileCallback | undefined =>
  (typeof optionsOrCallback === 'function' ? optionsOrCallback : callback) as
    | ExecFileCallback
    | undefined;

// Stamps execFile mock with a configurable success/failure response.
const respondWith = (opts: {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: ExecFileException | null;
}) => {
  mockExecFile.mockImplementation(((
    _cliPath: string,
    _args: readonly string[] | null | undefined,
    optionsOrCallback?: ExecFileOptions | null | ExecFileCallback,
    callback?: ExecFileCallback,
  ) => {
    const cb = invokeCallback(optionsOrCallback, callback);
    cb?.(opts.error ?? null, opts.stdout ?? '', opts.stderr ?? '');
    return {} as ChildProcess;
  }) as unknown as typeof execFile);
};

describe('eventCli', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearEventBinaryPathCache();
    mockFindProjectRoot.mockReturnValue('/test/project');
    mockGetEnvironmentBinaryConfig.mockReturnValue({});
    mockFindSecureBinaryPath.mockImplementation((paths: string[]) => ({
      path: paths[0] ?? null,
    }));
    process.env.EVENTKIT_HELPER_SHA256 = 'a'.repeat(64);
    process.env.EVENTKIT_DISCLAIM_SHA256 = 'b'.repeat(64);
    process.env.EVENTKIT_CREATE_HELPER_SHA256 = 'c'.repeat(64);
    process.env.EVENTKIT_CREATE_DISCLAIM_SHA256 = 'd'.repeat(64);
    // Hermetic: a developer's shell-exported EVENTKIT_CLI_TIMEOUT_MS must
    // not change the expected default in assertions below.
    delete process.env.EVENTKIT_CLI_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.EVENTKIT_HELPER_SHA256;
    delete process.env.EVENTKIT_DISCLAIM_SHA256;
    delete process.env.EVENTKIT_CREATE_HELPER_SHA256;
    delete process.env.EVENTKIT_CREATE_DISCLAIM_SHA256;
  });

  describe('executeEventCliJson — success', () => {
    it('parses raw JSON array from stdout (no envelope)', async () => {
      respondWith({
        stdout: JSON.stringify([
          { id: 'abc', title: 'Hello', isCompleted: false },
        ]),
      });

      const result = await executeEventCliJson<
        Array<{ id: string; title: string; isCompleted: boolean }>
      >(['reminders', 'list', '--json']);

      expect(result).toEqual([
        { id: 'abc', title: 'Hello', isCompleted: false },
      ]);
      expect(mockExecFile).toHaveBeenCalledWith(
        '/test/project/bin/eventkit-read-helper-disclaim',
        [
          '/test/project/bin/eventkit-read-helper',
          'reminders',
          'list',
          '--json',
        ],
        {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
          killSignal: 'SIGKILL',
        },
        expect.any(Function),
      );
    });

    it('parses raw JSON object from stdout', async () => {
      respondWith({
        stdout: JSON.stringify({ id: 'xyz', title: 'Single' }),
      });

      const result = await executeEventCliJson<{ id: string; title: string }>([
        'reminders',
        'create',
        '--title',
        'Single',
        '--json',
      ]);

      expect(result).toEqual({ id: 'xyz', title: 'Single' });
    });

    it('decodes Buffer stdout via bufferToString', async () => {
      respondWith({
        stdout: Buffer.from(JSON.stringify({ ok: true })),
      });

      const result = await executeEventCliJson<{ ok: boolean }>([
        'reminders',
        'lists',
        'list',
        '--json',
      ]);

      expect(result).toEqual({ ok: true });
    });
  });

  describe('executeEventCliPlain — success', () => {
    it('returns trimmed stdout for plain-text commands', async () => {
      respondWith({ stdout: 'Reminder deleted successfully\n' });

      const result = await executeEventCliPlain([
        'reminders',
        'delete',
        '--id',
        'abc',
      ]);

      expect(result).toBe('Reminder deleted successfully');
    });
  });

  describe('executeCalendarCreateCliJson', () => {
    const createArgs = [
      'calendar',
      'create',
      '--calendar-id',
      'calendar-123',
      '--title',
      'Approved event',
      '--start',
      '2026-08-25 10:00',
      '--end',
      '2026-08-25 11:00',
      '--json',
    ];

    it('uses the separately pinned create-only helper and shim', async () => {
      respondWith({
        stdout: JSON.stringify({
          created: true,
          id: 'event-123',
          title: 'Approved event',
          calendar: 'Work',
          calendarId: 'calendar-123',
          isAllDay: false,
        }),
      });

      await executeCalendarCreateCliJson(createArgs);

      expect(mockExecFile).toHaveBeenCalledWith(
        '/test/project/bin/eventkit-calendar-create-helper-disclaim',
        ['/test/project/bin/eventkit-calendar-create-helper', ...createArgs],
        {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
          killSignal: 'SIGKILL',
        },
        expect.any(Function),
      );
      expect(
        (
          mockFindSecureBinaryPath.mock.calls[0]?.[1] as {
            expectedHash: string;
          }
        ).expectedHash,
      ).toBe('c'.repeat(64));
      expect(
        (
          mockFindSecureBinaryPath.mock.calls[1]?.[1] as {
            expectedHash: string;
          }
        ).expectedHash,
      ).toBe('d'.repeat(64));
    });

    it('fails closed when the create-helper hash is missing', async () => {
      delete process.env.EVENTKIT_CREATE_HELPER_SHA256;

      await expect(executeCalendarCreateCliJson(createArgs)).rejects.toThrow(
        /EVENTKIT_CREATE_HELPER_SHA256 is required/,
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('warns that a timed-out create may have committed and must not be retried automatically', async () => {
      const timeoutError = Object.assign(new Error('Command failed'), {
        killed: true,
        signal: 'SIGKILL',
      }) as ExecFileException;
      respondWith({ stdout: '', stderr: '', error: timeoutError });

      const result = executeCalendarCreateCliJson(createArgs);
      await expect(result).rejects.toThrow(/may already have been created/);
      await expect(result).rejects.toThrow(/Do not retry automatically/);
    });
  });

  describe('error mapping', () => {
    it('maps "Permission denied: Reminders access was denied" to CliPermissionError(reminders)', async () => {
      const error = Object.assign(new Error('Command failed'), {
        code: 1,
      }) as ExecFileException;
      respondWith({
        stdout: '',
        stderr:
          'Error: Permission denied: Reminders access was denied. Please grant access in System Settings > Privacy & Security > Reminders.\n',
        error,
      });

      try {
        await executeEventCliJson(['reminders', 'list', '--json']);
        throw new Error('expected throw');
      } catch (thrown) {
        expect(thrown).toBeInstanceOf(CliPermissionError);
        expect((thrown as CliPermissionError).domain).toBe('reminders');
        expect((thrown as Error).message).toContain('Reminders access');
      }
    });

    it('maps "Permission denied: Calendar access was denied" to CliPermissionError(calendars)', async () => {
      const error = Object.assign(new Error('Command failed'), {
        code: 1,
      }) as ExecFileException;
      respondWith({
        stdout: '',
        stderr:
          'Error: Permission denied: Calendar access was denied. Please grant access in System Settings > Privacy & Security > Calendars.\n',
        error,
      });

      try {
        await executeEventCliJson(['calendar', 'list', '--json']);
        throw new Error('expected throw');
      } catch (thrown) {
        expect(thrown).toBeInstanceOf(CliPermissionError);
        expect((thrown as CliPermissionError).domain).toBe('calendars');
      }
    });

    it('treats "Only write access to reminders" as a permission error', async () => {
      const error = Object.assign(new Error('Command failed'), {
        code: 1,
      }) as ExecFileException;
      respondWith({
        stdout: '',
        stderr:
          'Error: Permission denied: Only write access to reminders. Full access is required.\n',
        error,
      });

      await expect(
        executeEventCliJson(['reminders', 'list', '--json']),
      ).rejects.toBeInstanceOf(CliPermissionError);
    });

    it('throws CliUserError for "Not found:" errors, stripping the "Error: " prefix', async () => {
      const error = Object.assign(new Error('Command failed'), {
        code: 1,
      }) as ExecFileException;
      respondWith({
        stdout: '',
        stderr:
          "Error: Not found: Reminder with ID 'nonexistent-id-12345' not found\n",
        error,
      });

      const promise = executeEventCliJson([
        'reminders',
        'update',
        '--id',
        'nonexistent-id-12345',
        '--title',
        'x',
        '--json',
      ]);

      await expect(promise).rejects.toThrow(
        "Not found: Reminder with ID 'nonexistent-id-12345' not found",
      );
      await expect(promise).rejects.toMatchObject({ name: 'CliUserError' });
    });

    it('throws CliUserError for ArgumentParser usage errors (exit 64)', async () => {
      const error = Object.assign(new Error('Command failed'), {
        code: 64,
      }) as ExecFileException;
      respondWith({
        stdout: '',
        stderr: "Error: Missing expected argument '--title <title>'\n",
        error,
      });

      await expect(
        executeEventCliJson(['reminders', 'create', '--json']),
      ).rejects.toThrow("Missing expected argument '--title <title>'");
    });

    it('falls back to the raw stderr when no "Error:" prefix is present', async () => {
      const error = Object.assign(new Error('Command failed'), {
        code: 1,
      }) as ExecFileException;
      respondWith({ stdout: '', stderr: 'something blew up\n', error });

      await expect(
        executeEventCliJson(['reminders', 'list', '--json']),
      ).rejects.toThrow(/event execution failed.*something blew up/);
    });

    it('throws when stdout is invalid JSON in JSON mode', async () => {
      respondWith({ stdout: 'not actually json' });

      await expect(
        executeEventCliJson(['reminders', 'list', '--json']),
      ).rejects.toThrow(/Invalid CLI output/);
    });

    it('throws when stdout is empty in JSON mode', async () => {
      respondWith({ stdout: '' });

      await expect(
        executeEventCliJson(['reminders', 'list', '--json']),
      ).rejects.toThrow(/Empty CLI output/);
    });
  });

  describe('binary resolution', () => {
    it('returns a helpful error when the binary cannot be located', async () => {
      mockFindSecureBinaryPath.mockReturnValue({ path: null });

      await expect(
        executeEventCliJson(['reminders', 'list', '--json']),
      ).rejects.toThrow(/helper.*failed integrity\/signature validation/i);
    });

    it('mentions the explicit build path in the not-found message', async () => {
      mockFindSecureBinaryPath.mockReturnValue({ path: null });

      await expect(
        executeEventCliJson(['reminders', 'list', '--json']),
      ).rejects.toThrow(/pnpm.*build/);
    });

    it('uses findProjectRoot to compute the canonical helper paths', async () => {
      mockFindProjectRoot.mockReturnValue('/custom/project');
      respondWith({ stdout: JSON.stringify({ ok: true }) });

      await executeEventCliJson(['reminders', 'lists', 'list', '--json']);

      expect(mockExecFile).toHaveBeenCalledWith(
        '/custom/project/bin/eventkit-read-helper-disclaim',
        [
          '/custom/project/bin/eventkit-read-helper',
          'reminders',
          'lists',
          'list',
          '--json',
        ],
        {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
          killSignal: 'SIGKILL',
        },
        expect.any(Function),
      );
    });
  });

  describe('CLI timeout (issue #113)', () => {
    // Given execFile's default timeout is 0 ("wait forever"), when the
    // `event` CLI blocks on an EventKit permission prompt that can never be
    // displayed (headless/launchd context), the MCP request would hang
    // forever and leak a child per call. A bounded timeout kills the child
    // and settles with a readable error instead.
    const withTimeoutEnv = async (
      value: string | undefined,
      run: () => Promise<void>,
    ) => {
      const previous = process.env.EVENTKIT_CLI_TIMEOUT_MS;
      if (value === undefined) {
        delete process.env.EVENTKIT_CLI_TIMEOUT_MS;
      } else {
        process.env.EVENTKIT_CLI_TIMEOUT_MS = value;
      }
      try {
        await run();
      } finally {
        if (previous === undefined) {
          delete process.env.EVENTKIT_CLI_TIMEOUT_MS;
        } else {
          process.env.EVENTKIT_CLI_TIMEOUT_MS = previous;
        }
      }
    };

    it('spawns with a bounded timeout and SIGKILL by default', async () => {
      respondWith({ stdout: JSON.stringify({ ok: true }) });

      await executeEventCliJson(['reminders', 'list', '--json']);

      expect(mockExecFile).toHaveBeenCalledWith(
        '/test/project/bin/eventkit-read-helper-disclaim',
        [
          '/test/project/bin/eventkit-read-helper',
          'reminders',
          'list',
          '--json',
        ],
        { maxBuffer: 10 * 1024 * 1024, timeout: 30_000, killSignal: 'SIGKILL' },
        expect.any(Function),
      );
    });

    it('honors EVENTKIT_CLI_TIMEOUT_MS when set', async () => {
      await withTimeoutEnv('5000', async () => {
        respondWith({ stdout: JSON.stringify({ ok: true }) });

        await executeEventCliJson(['reminders', 'list', '--json']);

        const options = mockExecFile.mock.calls[0]?.[2] as
          | { timeout?: number }
          | undefined;
        expect(options?.timeout).toBe(5000);
      });
    });

    it('falls back to the default when EVENTKIT_CLI_TIMEOUT_MS is invalid', async () => {
      await withTimeoutEnv('not-a-number', async () => {
        respondWith({ stdout: JSON.stringify({ ok: true }) });

        await executeEventCliJson(['reminders', 'list', '--json']);

        const options = mockExecFile.mock.calls[0]?.[2] as
          | { timeout?: number }
          | undefined;
        expect(options?.timeout).toBe(30_000);
      });
    });

    it('falls back to the default for zero (cannot disable the timeout)', async () => {
      await withTimeoutEnv('0', async () => {
        respondWith({ stdout: JSON.stringify({ ok: true }) });

        await executeEventCliJson(['reminders', 'list', '--json']);

        const options = mockExecFile.mock.calls[0]?.[2] as
          | { timeout?: number }
          | undefined;
        expect(options?.timeout).toBe(30_000);
      });
    });

    it('accepts numeric-separator syntax like the codebase literals', async () => {
      await withTimeoutEnv('120_000', async () => {
        respondWith({ stdout: JSON.stringify({ ok: true }) });

        await executeEventCliJson(['reminders', 'list', '--json']);

        const options = mockExecFile.mock.calls[0]?.[2] as
          | { timeout?: number }
          | undefined;
        expect(options?.timeout).toBe(120_000);
      });
    });

    it('rejects exponent and hex syntax instead of silently reinterpreting', async () => {
      for (const raw of ['1e3', '0x10']) {
        await withTimeoutEnv(raw, async () => {
          respondWith({ stdout: JSON.stringify({ ok: true }) });

          await executeEventCliJson(['reminders', 'list', '--json']);

          const options = mockExecFile.mock.calls[0]?.[2] as
            | { timeout?: number }
            | undefined;
          expect(options?.timeout).toBe(30_000);
        });
      }
    });

    it('clamps values above 2^31-1 ms to 2^31-1 ms instead of an instant kill', async () => {
      // Node's internal timer clamps at 2^31-1 ms (and warns); a safe
      // integer above that would otherwise SIGKILL ~instantly.
      await withTimeoutEnv('5000000000', async () => {
        respondWith({ stdout: JSON.stringify({ ok: true }) });

        await executeEventCliJson(['reminders', 'list', '--json']);

        const options = mockExecFile.mock.calls[0]?.[2] as
          | { timeout?: number }
          | undefined;
        expect(options?.timeout).toBe(2_147_483_647);
      });
    });

    it('falls back to the default for values beyond Number.MAX_SAFE_INTEGER', async () => {
      await withTimeoutEnv('99999999999999999999', async () => {
        respondWith({ stdout: JSON.stringify({ ok: true }) });

        await executeEventCliJson(['reminders', 'list', '--json']);

        const options = mockExecFile.mock.calls[0]?.[2] as
          | { timeout?: number }
          | undefined;
        expect(options?.timeout).toBe(30_000);
      });
    });

    it('settles a hung CLI with an actionable error instead of hanging', async () => {
      const timeoutError = Object.assign(new Error('Command failed'), {
        killed: true,
        signal: 'SIGKILL',
      }) as ExecFileException;
      respondWith({ stdout: '', stderr: '', error: timeoutError });

      const promise = executeEventCliJson(['reminders', 'list', '--json']);

      await expect(promise).rejects.toMatchObject({ name: 'CliUserError' });
      await expect(promise).rejects.toThrow(/timed out after 30000 ms/);
      await expect(promise).rejects.toThrow(/EVENTKIT_CLI_TIMEOUT_MS/);
    });

    it('does not let stderr flushed before the kill mask the timeout diagnosis', async () => {
      // Given the killed child flushed a line to stderr before blocking,
      // when the timeout fires, then the error still reports the kill (with
      // the stderr appended) instead of surfacing the stale line as the cause.
      const timeoutError = Object.assign(new Error('Command failed'), {
        killed: true,
        signal: 'SIGKILL',
      }) as ExecFileException;
      respondWith({
        stdout: '',
        stderr: 'event: some warning before blocking\n',
        error: timeoutError,
      });

      const promise = executeEventCliJson(['reminders', 'list', '--json']);

      await expect(promise).rejects.toThrow(/timed out after 30000 ms/);
      await expect(promise).rejects.toThrow(
        /stderr before kill: event: some warning/,
      );
    });
  });

  describe('TCC disclaim shim routing (issue #93)', () => {
    // Given the build produced the helper and its responsibility shim,
    // when a read command runs, then it is spawned through the shim so
    // the TCC permission prompt is attributed to the helper itself instead of
    // the desktop MCP client that launched the server.
    const resolveBoth = () => {
      mockFindSecureBinaryPath.mockImplementation((paths: string[]) => ({
        path: paths[0] ?? null,
      }));
    };

    it('spawns the helper through the mandatory responsibility shim', async () => {
      resolveBoth();
      respondWith({ stdout: JSON.stringify({ ok: true }) });

      await executeEventCliJson(['reminders', 'list', '--json']);

      expect(mockExecFile).toHaveBeenCalledWith(
        '/test/project/bin/eventkit-read-helper-disclaim',
        [
          '/test/project/bin/eventkit-read-helper',
          'reminders',
          'list',
          '--json',
        ],
        {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
          killSignal: 'SIGKILL',
        },
        expect.any(Function),
      );
    });

    it('routes plain-text commands through the shim as well', async () => {
      resolveBoth();
      respondWith({ stdout: 'Reminder deleted successfully\n' });

      const result = await executeEventCliPlain([
        'reminders',
        'delete',
        '--id',
        'abc',
      ]);

      expect(result).toBe('Reminder deleted successfully');
      expect(mockExecFile).toHaveBeenCalledWith(
        '/test/project/bin/eventkit-read-helper-disclaim',
        [
          '/test/project/bin/eventkit-read-helper',
          'reminders',
          'delete',
          '--id',
          'abc',
        ],
        {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
          killSignal: 'SIGKILL',
        },
        expect.any(Function),
      );
    });

    it('fails closed when the mandatory shim is absent', async () => {
      mockFindSecureBinaryPath
        .mockReturnValueOnce({ path: '/test/project/bin/eventkit-read-helper' })
        .mockReturnValueOnce({ path: null });

      await expect(
        executeEventCliJson(['reminders', 'list', '--json']),
      ).rejects.toThrow(/responsibility shim.*failed integrity/i);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('applies distinct mandatory hashes to helper and shim validation', async () => {
      mockFindSecureBinaryPath.mockImplementation((paths: string[]) => ({
        path: paths[0] ?? null,
      }));
      respondWith({ stdout: JSON.stringify({ ok: true }) });

      await executeEventCliJson(['reminders', 'list', '--json']);

      const shimCall = mockFindSecureBinaryPath.mock.calls.find((call) =>
        (call[0] as string[])[0]?.endsWith('eventkit-read-helper-disclaim'),
      );
      expect(shimCall).toBeDefined();
      expect((shimCall?.[1] as { expectedHash?: string }).expectedHash).toBe(
        'b'.repeat(64),
      );
      expect(
        (
          mockFindSecureBinaryPath.mock.calls[0]?.[1] as {
            expectedHash?: string;
          }
        ).expectedHash,
      ).toBe('a'.repeat(64));
    });

    it('surfaces shim spawn failures verbatim as user-actionable errors', async () => {
      resolveBoth();
      const error = Object.assign(new Error('Command failed'), {
        code: 127,
      }) as ExecFileException;
      respondWith({
        stdout: '',
        stderr:
          'eventkit-read-helper-disclaim: failed to exec /test/project/bin/eventkit-read-helper: No such file or directory\n',
        error,
      });

      const promise = executeEventCliJson(['reminders', 'list', '--json']);

      await expect(promise).rejects.toThrow(
        'eventkit-read-helper-disclaim: failed to exec /test/project/bin/eventkit-read-helper',
      );
      await expect(promise).rejects.toMatchObject({ name: 'CliUserError' });
    });

    it('rejects a missing helper hash before attempting binary resolution', async () => {
      delete process.env.EVENTKIT_HELPER_SHA256;
      await expect(
        executeEventCliJson(['reminders', 'list', '--json']),
      ).rejects.toThrow(/EVENTKIT_HELPER_SHA256 is required/);
      expect(mockFindSecureBinaryPath).not.toHaveBeenCalled();
    });

    it('maps permission errors identically when spawned through the shim', async () => {
      resolveBoth();
      const error = Object.assign(new Error('Command failed'), {
        code: 1,
      }) as ExecFileException;
      respondWith({
        stdout: '',
        stderr:
          'Error: Permission denied: Reminders access was denied. Please grant access in System Settings > Privacy & Security > Reminders.\n',
        error,
      });

      await expect(
        executeEventCliJson(['reminders', 'list', '--json']),
      ).rejects.toBeInstanceOf(CliPermissionError);
    });
  });

  describe('CliPermissionError', () => {
    it('carries the permission domain', () => {
      const reminders = new CliPermissionError(
        'Permission denied: Reminders access was denied.',
        'reminders',
      );
      const calendars = new CliPermissionError(
        'Permission denied: Calendar access was denied.',
        'calendars',
      );

      expect(reminders.domain).toBe('reminders');
      expect(reminders.name).toBe('CliPermissionError');
      expect(calendars.domain).toBe('calendars');
    });
  });
});
