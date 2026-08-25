import { readFileSync } from 'node:fs';
import path from 'node:path';

const readProjectFile = (file: string): string =>
  readFileSync(path.resolve(process.cwd(), file), 'utf8');

describe('repository-owned EventKit helper', () => {
  const source = readProjectFile('native/EventKitReadHelper/main.swift');

  it('implements only the four native reads used by the MCP repositories', () => {
    expect(source).toContain('["reminders", "lists", "list"]');
    expect(source).toContain('["reminders", "list"]');
    expect(source).toContain('["calendar", "list"]');
    expect(source).toContain('["calendar", "calendars", "list"]');
    expect(source).toContain('This helper is read-only');
  });

  it('contains no EventKit mutation calls or adjacent integration clients', () => {
    expect(source).not.toMatch(
      /eventStore\.(save|remove|commit|reset|refresh)\s*\(/,
    );
    expect(source).not.toMatch(
      /URLSession|NWConnection|SQLite3|SQLiteConnection|NSAppleScript|Process\s*\(/,
    );
  });

  it('uses full-access APIs only to satisfy EventKit read authorization', () => {
    expect(source).toContain('requestFullAccessToReminders');
    expect(source).toContain('requestFullAccessToEvents');
    expect(source).not.toContain('requestWriteOnlyAccess');
  });
});

describe('repository-owned calendar create helper', () => {
  const source = readProjectFile(
    'native/EventKitCalendarCreateHelper/main.swift',
  );

  it('implements exactly one create command selected by stable calendar ID', () => {
    expect(source).toContain('["calendar", "create"]');
    expect(source).toContain('"--calendar-id"');
    expect(source).toContain('calendar(withIdentifier: calendarID)');
    expect(source).toContain('eventStore.save(event');
  });

  it('cannot list, update, or delete events and has no adjacent integration clients', () => {
    expect(source).not.toMatch(/predicateForEvents|events\(matching:/);
    expect(source).not.toMatch(
      /eventStore\.(remove|commit|reset|refresh)\s*\(/,
    );
    expect(source).not.toMatch(
      /URLSession|NWConnection|SQLite3|SQLiteConnection|NSAppleScript|Process\s*\(/,
    );
  });

  it('requires full Calendar access only to resolve a specific calendar', () => {
    expect(source).toContain('requestFullAccessToEvents');
    expect(source).not.toContain('requestWriteOnlyAccessToEvents');
    expect(source).not.toContain('requestFullAccessToReminders');
  });
});

describe('read-only helper build pipeline', () => {
  const buildScript = readProjectFile('scripts/build-helper.mjs');
  const infoPlist = readProjectFile('scripts/helper-Info.plist');
  const entitlements = readProjectFile('scripts/helper.entitlements');
  const createInfoPlist = readProjectFile('scripts/create-helper-Info.plist');
  const createEntitlements = readProjectFile(
    'scripts/create-helper.entitlements',
  );

  it('compiles local Swift source directly with no SwiftPM or remote fetch', () => {
    expect(buildScript).toContain("'swiftc'");
    expect(buildScript).toContain("'native'");
    expect(buildScript).toContain("'EventKitReadHelper'");
    expect(buildScript).toContain("'EventKitCalendarCreateHelper'");
    expect(buildScript).not.toMatch(/swift[\s\S]*?'build'/);
    expect(buildScript).not.toMatch(/vendor[\s\S]{0,40}event/);
    expect(buildScript).not.toMatch(/GIT_CONFIG|git@github|https:\/\/github/);
  });

  it('builds arm64 and x86_64 slices and merges them with lipo', () => {
    expect(buildScript).toContain('arm64-apple-macosx14.0');
    expect(buildScript).toContain('x86_64-apple-macosx14.0');
    expect(buildScript).toMatch(/'lipo'[\s\S]*?'-create'/);
  });

  it('requires a trusted signing identity and verifies both signatures', () => {
    expect(buildScript).toContain('No trusted Apple code-signing identity');
    expect(buildScript).not.toMatch(/return ['"]-['"]/);
    expect(buildScript).toMatch(
      /'codesign'[\s\S]*?'--verify'[\s\S]*?'--strict'/,
    );
  });

  it('prints mandatory, per-binary SHA-256 configuration', () => {
    expect(buildScript).toContain('EVENTKIT_HELPER_SHA256=');
    expect(buildScript).toContain('EVENTKIT_DISCLAIM_SHA256=');
    expect(buildScript).toContain('EVENTKIT_CREATE_HELPER_SHA256=');
    expect(buildScript).toContain('EVENTKIT_CREATE_DISCLAIM_SHA256=');
    expect(buildScript).toContain('fails closed');
  });

  it('gives the create helper only Calendar entitlement and an explicit full-access purpose string', () => {
    expect(createInfoPlist).toContain('NSCalendarsFullAccessUsageDescription');
    expect(createInfoPlist).toContain(
      'select an exact writable calendar by ID',
    );
    expect(createInfoPlist).not.toContain('NSReminders');
    expect(createEntitlements).toContain(
      'com.apple.security.personal-information.calendars',
    );
    expect(createEntitlements).not.toContain(
      'com.apple.security.personal-information.reminders',
    );
    expect(createEntitlements.match(/<key>/g)).toHaveLength(1);
  });

  it('embeds read-only purpose strings and no write-only usage descriptions', () => {
    expect(infoPlist).toContain('NSRemindersFullAccessUsageDescription');
    expect(infoPlist).toContain('NSCalendarsFullAccessUsageDescription');
    expect(infoPlist).toContain('It contains no write commands.');
    expect(infoPlist).not.toContain('WriteOnlyAccessUsageDescription');
  });

  it('requests only the EventKit personal-information entitlements', () => {
    expect(entitlements).toContain(
      'com.apple.security.personal-information.calendars',
    );
    expect(entitlements).toContain(
      'com.apple.security.personal-information.reminders',
    );
    expect(entitlements.match(/<key>/g)).toHaveLength(2);
  });
});
