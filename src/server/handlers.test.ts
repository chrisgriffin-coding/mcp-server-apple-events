import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { handleToolCall, TOOLS } from '../tools/index.js';
import { registerHandlers } from './handlers.js';

jest.mock('../tools/index.js', () => ({
  TOOLS: [{ name: 'reminders_read' }],
  handleToolCall: jest.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'Mock result' }],
  }),
}));

interface MockServer {
  setRequestHandler: jest.MockedFunction<
    (schema: unknown, handler: unknown) => void
  >;
}

describe('server handlers', () => {
  let server: MockServer;

  beforeEach(() => {
    jest.clearAllMocks();
    server = { setRequestHandler: jest.fn() };
  });

  it('registers only list-tools and call-tool handlers', () => {
    registerHandlers(
      server as unknown as Parameters<typeof registerHandlers>[0],
    );

    expect(server.setRequestHandler).toHaveBeenCalledTimes(2);
    expect(server.setRequestHandler.mock.calls.map((call) => call[0])).toEqual([
      ListToolsRequestSchema,
      CallToolRequestSchema,
    ]);
  });

  it('returns the read-only tool definitions', async () => {
    registerHandlers(
      server as unknown as Parameters<typeof registerHandlers>[0],
    );
    const handler = server.setRequestHandler.mock
      .calls[0]?.[1] as () => Promise<unknown>;

    await expect(handler()).resolves.toEqual({ tools: TOOLS });
  });

  it('forwards tool name and normalizes missing arguments', async () => {
    registerHandlers(
      server as unknown as Parameters<typeof registerHandlers>[0],
    );
    const handler = server.setRequestHandler.mock.calls[1]?.[1] as (
      request: unknown,
    ) => Promise<unknown>;

    await handler({ params: { name: 'reminders_read' } });
    expect(handleToolCall).toHaveBeenCalledWith('reminders_read', {});
  });
});
