import { readFileSync } from 'node:fs';
import path from 'node:path';

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), relativePath), 'utf8'),
  ) as Record<string, unknown>;
}

describe('Codex plugin packaging', () => {
  it('declares the EventKit MCP companion file', () => {
    const manifest = readJson('.codex-plugin/plugin.json');

    expect(manifest).toMatchObject({
      name: 'apple-eventkit',
      mcpServers: './.mcp.json',
      interface: {
        displayName: 'Apple EventKit',
        capabilities: ['Read', 'Write'],
      },
    });
  });

  it('launches the local server with write-aware approvals', () => {
    const config = readJson('.mcp.json');

    expect(config).toEqual({
      mcpServers: {
        eventkit: {
          command: 'node',
          args: ['./scripts/launch-codex-plugin.mjs'],
          cwd: '.',
          env_vars: ['PATH'],
          startup_timeout_sec: 10,
          tool_timeout_sec: 60,
          default_tools_approval_mode: 'writes',
        },
      },
    });
  });

  it('uses a self-contained integrity-pinned plugin bundle', () => {
    const launcher = readFileSync(
      path.join(process.cwd(), 'scripts/launch-codex-plugin.mjs'),
      'utf8',
    );

    expect(launcher).toContain("server: 'plugin-dist/index.mjs'");
    expect(launcher).toContain("serverHash: 'plugin-dist/index.mjs.sha256'");
    expect(launcher).toContain(
      'verifyHash(requiredFiles.server, requiredFiles.serverHash)',
    );
  });
});
