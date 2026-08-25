import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HELPER_IDENTIFIER = 'com.chrisgriffin.mcp-server-eventkit.helper';
const DISCLAIM_IDENTIFIER = 'com.chrisgriffin.mcp-server-eventkit.disclaim';
const CREATE_HELPER_IDENTIFIER =
  'com.chrisgriffin.mcp-server-eventkit.calendar-create-helper';
const CREATE_DISCLAIM_IDENTIFIER =
  'com.chrisgriffin.mcp-server-eventkit.calendar-create-disclaim';
const REMINDER_CREATE_HELPER_IDENTIFIER =
  'com.chrisgriffin.mcp-server-eventkit.reminder-create-helper';
const REMINDER_CREATE_DISCLAIM_IDENTIFIER =
  'com.chrisgriffin.mcp-server-eventkit.reminder-create-disclaim';

async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, options);
    return { stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (error) {
    error.stdout = error.stdout ?? '';
    error.stderr = error.stderr ?? '';
    throw error;
  }
}

async function requireTool(name) {
  try {
    await run('xcrun', ['--find', name]);
  } catch {
    throw new Error(
      `${name} is required. Install Xcode or Xcode Command Line Tools first.`,
    );
  }
}

async function resolveSigningIdentity() {
  if (process.env.APPLE_SIGNING_IDENTITY) {
    return process.env.APPLE_SIGNING_IDENTITY;
  }

  const { stdout } = await run('security', [
    'find-identity',
    '-v',
    '-p',
    'codesigning',
  ]);
  const lines = stdout.split('\n');
  for (const prefix of ['Developer ID Application:', 'Apple Development:']) {
    const matches = lines.filter((line) => line.includes(prefix));
    if (matches.length === 1) {
      const identity = matches[0].match(/"([^"]+)"/)?.[1];
      if (identity) return identity;
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple ${prefix} identities are available. Set APPLE_SIGNING_IDENTITY explicitly.`,
      );
    }
  }

  throw new Error(
    'No trusted Apple code-signing identity is available. This security-focused build does not permit ad-hoc signing.',
  );
}

async function sha256(file) {
  const contents = await fs.readFile(file);
  return crypto.createHash('sha256').update(contents).digest('hex');
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('The EventKit helper can only be built on macOS.');
  }

  await Promise.all([
    requireTool('swiftc'),
    requireTool('lipo'),
    requireTool('clang'),
  ]);

  const scriptFile = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(scriptFile), '..');
  const sourceFile = path.join(
    projectRoot,
    'native',
    'EventKitReadHelper',
    'main.swift',
  );
  const createSourceFile = path.join(
    projectRoot,
    'native',
    'EventKitCalendarCreateHelper',
    'main.swift',
  );
  const reminderCreateSourceFile = path.join(
    projectRoot,
    'native',
    'EventKitReminderCreateHelper',
    'main.swift',
  );
  const binDir = path.join(projectRoot, 'bin');
  const buildDir = path.join(projectRoot, '.build', 'eventkit-read-helper');
  const helperOutput = path.join(binDir, 'eventkit-read-helper');
  const disclaimOutput = path.join(binDir, 'eventkit-read-helper-disclaim');
  const createHelperOutput = path.join(
    binDir,
    'eventkit-calendar-create-helper',
  );
  const createDisclaimOutput = path.join(
    binDir,
    'eventkit-calendar-create-helper-disclaim',
  );
  const reminderCreateHelperOutput = path.join(
    binDir,
    'eventkit-reminder-create-helper',
  );
  const reminderCreateDisclaimOutput = path.join(
    binDir,
    'eventkit-reminder-create-helper-disclaim',
  );
  const infoPlist = path.join(projectRoot, 'scripts', 'helper-Info.plist');
  const entitlements = path.join(projectRoot, 'scripts', 'helper.entitlements');
  const createInfoPlist = path.join(
    projectRoot,
    'scripts',
    'create-helper-Info.plist',
  );
  const createEntitlements = path.join(
    projectRoot,
    'scripts',
    'create-helper.entitlements',
  );
  const reminderCreateInfoPlist = path.join(
    projectRoot,
    'scripts',
    'reminder-create-helper-Info.plist',
  );
  const reminderCreateEntitlements = path.join(
    projectRoot,
    'scripts',
    'reminder-create-helper.entitlements',
  );
  const disclaimSource = path.join(projectRoot, 'scripts', 'disclaim.c');

  await Promise.all([
    fs.access(sourceFile),
    fs.access(createSourceFile),
    fs.access(reminderCreateSourceFile),
    fs.access(infoPlist),
    fs.access(entitlements),
    fs.access(createInfoPlist),
    fs.access(createEntitlements),
    fs.access(reminderCreateInfoPlist),
    fs.access(reminderCreateEntitlements),
    fs.access(disclaimSource),
  ]);
  await fs.rm(buildDir, { recursive: true, force: true });
  await Promise.all([
    fs.mkdir(buildDir, { recursive: true }),
    fs.mkdir(binDir, { recursive: true }),
  ]);

  const slices = [
    { arch: 'arm64', target: 'arm64-apple-macosx14.0' },
    { arch: 'x86_64', target: 'x86_64-apple-macosx14.0' },
  ];
  const sliceOutputs = await Promise.all(
    slices.map(async ({ arch, target }) => {
      const output = path.join(buildDir, `eventkit-read-helper-${arch}`);
      const { stderr } = await run('xcrun', [
        'swiftc',
        '-O',
        '-whole-module-optimization',
        '-parse-as-library',
        '-swift-version',
        '6',
        '-target',
        target,
        sourceFile,
        '-framework',
        'EventKit',
        '-framework',
        'CoreGraphics',
        '-Xlinker',
        '-sectcreate',
        '-Xlinker',
        '__TEXT',
        '-Xlinker',
        '__info_plist',
        '-Xlinker',
        infoPlist,
        '-o',
        output,
      ]);
      if (stderr) console.warn(`${arch} compiler warnings:\n${stderr}`);
      return output;
    }),
  );

  const createSliceOutputs = await Promise.all(
    slices.map(async ({ arch, target }) => {
      const output = path.join(
        buildDir,
        `eventkit-calendar-create-helper-${arch}`,
      );
      const { stderr } = await run('xcrun', [
        'swiftc',
        '-O',
        '-whole-module-optimization',
        '-parse-as-library',
        '-swift-version',
        '6',
        '-target',
        target,
        createSourceFile,
        '-framework',
        'EventKit',
        '-framework',
        'CoreGraphics',
        '-Xlinker',
        '-sectcreate',
        '-Xlinker',
        '__TEXT',
        '-Xlinker',
        '__info_plist',
        '-Xlinker',
        createInfoPlist,
        '-o',
        output,
      ]);
      if (stderr) console.warn(`${arch} create-helper warnings:\n${stderr}`);
      return output;
    }),
  );

  const reminderCreateSliceOutputs = await Promise.all(
    slices.map(async ({ arch, target }) => {
      const output = path.join(
        buildDir,
        `eventkit-reminder-create-helper-${arch}`,
      );
      const { stderr } = await run('xcrun', [
        'swiftc',
        '-O',
        '-whole-module-optimization',
        '-parse-as-library',
        '-swift-version',
        '6',
        '-target',
        target,
        reminderCreateSourceFile,
        '-framework',
        'EventKit',
        '-framework',
        'CoreGraphics',
        '-Xlinker',
        '-sectcreate',
        '-Xlinker',
        '__TEXT',
        '-Xlinker',
        '__info_plist',
        '-Xlinker',
        reminderCreateInfoPlist,
        '-o',
        output,
      ]);
      if (stderr) console.warn(`${arch} reminder-create warnings:\n${stderr}`);
      return output;
    }),
  );

  await run('xcrun', [
    'lipo',
    '-create',
    '-output',
    helperOutput,
    ...sliceOutputs,
  ]);
  await run('xcrun', [
    'lipo',
    '-create',
    '-output',
    createHelperOutput,
    ...createSliceOutputs,
  ]);
  await run('xcrun', [
    'lipo',
    '-create',
    '-output',
    reminderCreateHelperOutput,
    ...reminderCreateSliceOutputs,
  ]);
  await run('xcrun', [
    'clang',
    '-O2',
    '-mmacosx-version-min=14.0',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-DDISCLAIMER_NAME="eventkit-read-helper-disclaim"',
    '-o',
    disclaimOutput,
    disclaimSource,
  ]);
  await run('xcrun', [
    'clang',
    '-O2',
    '-mmacosx-version-min=14.0',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-DDISCLAIMER_NAME="eventkit-reminder-create-helper-disclaim"',
    '-o',
    reminderCreateDisclaimOutput,
    disclaimSource,
  ]);
  await run('xcrun', [
    'clang',
    '-O2',
    '-mmacosx-version-min=14.0',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-DDISCLAIMER_NAME="eventkit-calendar-create-helper-disclaim"',
    '-o',
    createDisclaimOutput,
    disclaimSource,
  ]);
  await Promise.all([
    fs.chmod(helperOutput, 0o755),
    fs.chmod(disclaimOutput, 0o755),
    fs.chmod(createHelperOutput, 0o755),
    fs.chmod(createDisclaimOutput, 0o755),
    fs.chmod(reminderCreateHelperOutput, 0o755),
    fs.chmod(reminderCreateDisclaimOutput, 0o755),
  ]);

  const signingIdentity = await resolveSigningIdentity();
  const sign = async (file, identifier, extraArgs = []) => {
    const { stderr } = await run('codesign', [
      '--force',
      '--sign',
      signingIdentity,
      '--options',
      'runtime',
      '--timestamp',
      '--identifier',
      identifier,
      ...extraArgs,
      file,
    ]);
    if (stderr)
      console.warn(`codesign warnings for ${path.basename(file)}:\n${stderr}`);
    await run('codesign', ['--verify', '--strict', '--verbose=2', file]);
  };

  await sign(helperOutput, HELPER_IDENTIFIER, ['--entitlements', entitlements]);
  await sign(disclaimOutput, DISCLAIM_IDENTIFIER);
  await sign(createHelperOutput, CREATE_HELPER_IDENTIFIER, [
    '--entitlements',
    createEntitlements,
  ]);
  await sign(createDisclaimOutput, CREATE_DISCLAIM_IDENTIFIER);
  await sign(reminderCreateHelperOutput, REMINDER_CREATE_HELPER_IDENTIFIER, [
    '--entitlements',
    reminderCreateEntitlements,
  ]);
  await sign(reminderCreateDisclaimOutput, REMINDER_CREATE_DISCLAIM_IDENTIFIER);

  const [
    helperHash,
    disclaimHash,
    createHelperHash,
    createDisclaimHash,
    reminderCreateHelperHash,
    reminderCreateDisclaimHash,
  ] = await Promise.all([
    sha256(helperOutput),
    sha256(disclaimOutput),
    sha256(createHelperOutput),
    sha256(createDisclaimOutput),
    sha256(reminderCreateHelperOutput),
    sha256(reminderCreateDisclaimOutput),
  ]);
  await Promise.all([
    fs.writeFile(
      path.join(binDir, 'eventkit-read-helper.sha256'),
      `${helperHash}\n`,
      { mode: 0o644 },
    ),
    fs.writeFile(
      path.join(binDir, 'eventkit-read-helper-disclaim.sha256'),
      `${disclaimHash}\n`,
      { mode: 0o644 },
    ),
    fs.writeFile(`${createHelperOutput}.sha256`, `${createHelperHash}\n`, {
      mode: 0o644,
    }),
    fs.writeFile(`${createDisclaimOutput}.sha256`, `${createDisclaimHash}\n`, {
      mode: 0o644,
    }),
    fs.writeFile(
      `${reminderCreateHelperOutput}.sha256`,
      `${reminderCreateHelperHash}\n`,
      { mode: 0o644 },
    ),
    fs.writeFile(
      `${reminderCreateDisclaimOutput}.sha256`,
      `${reminderCreateDisclaimHash}\n`,
      { mode: 0o644 },
    ),
  ]);

  console.log('EventKit helper build complete.');
  console.log(`Signing identity: ${signingIdentity}`);
  console.log(`EVENTKIT_HELPER_SHA256=${helperHash}`);
  console.log(`EVENTKIT_DISCLAIM_SHA256=${disclaimHash}`);
  console.log(`EVENTKIT_CREATE_HELPER_SHA256=${createHelperHash}`);
  console.log(`EVENTKIT_CREATE_DISCLAIM_SHA256=${createDisclaimHash}`);
  console.log(
    `EVENTKIT_REMINDER_CREATE_HELPER_SHA256=${reminderCreateHelperHash}`,
  );
  console.log(
    `EVENTKIT_REMINDER_CREATE_DISCLAIM_SHA256=${reminderCreateDisclaimHash}`,
  );
  console.log(
    'Each helper and shim hash is mandatory for its command path; the server fails closed if a required hash is absent or mismatched.',
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
