import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { handleToolCall } from './index.js';

jest.mock('./handlers/index.js', () => ({
  handleReadReminders: jest.fn(),
  handleReadReminderLists: jest.fn(),
  handleReadSubtasks: jest.fn(),
  handleReadCalendarEvents: jest.fn(),
  handleReadCalendars: jest.fn(),
}));

import {
  handleReadCalendarEvents,
  handleReadCalendars,
  handleReadReminderLists,
  handleReadReminders,
  handleReadSubtasks,
} from './handlers/index.js';

const success: CallToolResult = {
  content: [{ type: 'text', text: 'Success' }],
};

describe('read-only tool routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['reminders_read', handleReadReminders, { id: 'reminder-id' }],
    [
      'reminder_subtasks_read',
      handleReadSubtasks,
      { reminderId: 'reminder-id' },
    ],
    [
      'calendar_events_read',
      handleReadCalendarEvents,
      { startDate: '2026-08-24' },
    ],
    ['calendars_read', handleReadCalendars, { endDate: '2026-08-31' }],
  ])('routes %s with a server-forced read action', async (name, handler, args) => {
    const mockedHandler = handler as unknown as jest.Mock;
    mockedHandler.mockResolvedValue(success);

    await expect(handleToolCall(name, args)).resolves.toEqual(success);
    expect(mockedHandler).toHaveBeenCalledWith({ ...args, action: 'read' });
  });

  it('routes reminder-list reads without accepting arguments', async () => {
    const mockedHandler = handleReadReminderLists as jest.MockedFunction<
      typeof handleReadReminderLists
    >;
    mockedHandler.mockResolvedValue(success);

    await expect(
      handleToolCall('reminder_lists_read', { action: 'delete' }),
    ).resolves.toEqual(success);
    expect(mockedHandler).toHaveBeenCalledWith();
  });

  it.each([
    'delete',
    'update',
    'create',
  ])('overrides a smuggled %s action with read', async (action) => {
    const mockedHandler = handleReadReminders as jest.MockedFunction<
      typeof handleReadReminders
    >;
    mockedHandler.mockResolvedValue(success);

    await handleToolCall('reminders_read', {
      action,
      id: 'reminder-id',
    });

    expect(mockedHandler).toHaveBeenCalledWith({
      action: 'read',
      id: 'reminder-id',
    });
  });

  it.each([
    'unknown_tool',
    '',
    'toString',
    '__proto__',
  ])('rejects unmanaged tool name %s', async (name) => {
    await expect(handleToolCall(name, {})).resolves.toEqual({
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    });
  });

  it('normalizes non-object arguments before routing', async () => {
    const mockedHandler = handleReadCalendars as jest.MockedFunction<
      typeof handleReadCalendars
    >;
    mockedHandler.mockResolvedValue(success);

    await handleToolCall('calendars_read', ['hostile']);
    expect(mockedHandler).toHaveBeenCalledWith({ action: 'read' });
  });
});
