/**
 * Protocol-level tests. These deliberately avoid real EventKit reads so the
 * test suite never prompts for private-data access or touches a user's stores.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function createClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    stderr: 'pipe',
    cwd: process.cwd(),
  });
  const client = new Client({
    name: 'e2e-test-client',
    version: '1.0.0',
  });
  await client.connect(transport);
  return client;
}

describe('read-only MCP protocol surface', () => {
  let client: Client;

  beforeAll(async () => {
    client = await createClient();
  });

  afterAll(async () => {
    await client?.close();
  });

  it('initializes with tools but no prompts or resources', () => {
    expect(client.getServerVersion()).toEqual(
      expect.objectContaining({
        name: 'mcp-server-eventkit',
        version: '0.1.0',
      }),
    );
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
  });

  it('advertises exactly the read-only tools', async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'reminders_read',
      'reminder_lists_read',
      'reminder_subtasks_read',
      'calendar_events_read',
      'calendars_read',
    ]);

    for (const tool of result.tools) {
      expect(tool.annotations).toEqual(
        expect.objectContaining({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        }),
      );
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty('action');
    }
  });

  it('rejects an unknown tool without launching EventKit', async () => {
    const result = await client.callTool({
      name: 'reminders_delete',
      arguments: { id: 'never-routed' },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'Unknown tool: reminders_delete' },
    ]);
  });
});
