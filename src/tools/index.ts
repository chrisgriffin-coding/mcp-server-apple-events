/**
 * Read-only tool routing.
 *
 * The MCP-facing schemas intentionally omit the upstream action discriminator.
 * This router injects `read` internally so callers cannot smuggle a mutation
 * through a mixed-action tool.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  CalendarsToolArgs,
  CalendarToolArgs,
  RemindersToolArgs,
  SubtasksToolArgs,
} from '../types/index.js';
import { MESSAGES } from '../utils/constants.js';
import { TOOLS } from './definitions.js';
import {
  handleCreateCalendarEvent,
  handleReadCalendarEvents,
  handleReadCalendars,
  handleReadReminderLists,
  handleReadReminders,
  handleReadSubtasks,
} from './handlers/index.js';

type ToolArguments = Record<string, unknown>;
type ToolRouter = (args: ToolArguments) => Promise<CallToolResult>;

const TOOL_ROUTER_MAP = {
  reminders_read: async (args) =>
    handleReadReminders({ ...args, action: 'read' } as RemindersToolArgs),
  reminder_lists_read: async () => handleReadReminderLists(),
  reminder_subtasks_read: async (args) =>
    handleReadSubtasks({ ...args, action: 'read' } as SubtasksToolArgs),
  calendar_events_read: async (args) =>
    handleReadCalendarEvents({ ...args, action: 'read' } as CalendarToolArgs),
  calendars_read: async (args) =>
    handleReadCalendars({ ...args, action: 'read' } as CalendarsToolArgs),
  calendar_event_create: async (args) =>
    handleCreateCalendarEvent({
      ...args,
      action: 'create',
    } as CalendarToolArgs),
} satisfies Record<string, ToolRouter>;

type ToolName = keyof typeof TOOL_ROUTER_MAP;
const MANAGED_TOOL_NAMES = new Set<string>(Object.keys(TOOL_ROUTER_MAP));

const isManagedToolName = (value: string): value is ToolName =>
  MANAGED_TOOL_NAMES.has(value);

function createErrorResponse(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export async function handleToolCall(
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  if (!isManagedToolName(name)) {
    return createErrorResponse(MESSAGES.ERROR.UNKNOWN_TOOL(name));
  }

  const safeArgs =
    args !== null && typeof args === 'object' && !Array.isArray(args)
      ? (args as ToolArguments)
      : {};

  return TOOL_ROUTER_MAP[name](safeArgs);
}

export { TOOLS };
