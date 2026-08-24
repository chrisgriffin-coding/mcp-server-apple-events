import { TOOLS } from './definitions.js';

describe('tool definitions', () => {
  it('advertises independently named tools', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      'reminders_read',
      'reminder_lists_read',
      'reminder_subtasks_read',
      'calendar_events_read',
      'calendars_read',
      'calendar_event_create',
    ]);
  });

  it('marks each read tool as read-only, idempotent, and closed-world', () => {
    for (const tool of TOOLS.filter(
      (tool) => tool.name !== 'calendar_event_create',
    )) {
      expect(tool.annotations).toEqual(
        expect.objectContaining({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        }),
      );
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description).toContain('untrusted');
    }
  });

  it('marks event creation as non-read-only, non-destructive, and non-idempotent', () => {
    const create = TOOLS.find((tool) => tool.name === 'calendar_event_create');
    expect(create?.annotations).toEqual(
      expect.objectContaining({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      }),
    );
    expect(create?.inputSchema.additionalProperties).toBe(false);
    expect(create?.inputSchema.required).toEqual([
      'title',
      'startDate',
      'endDate',
      'calendarId',
      'confirmed',
    ]);
    expect(create?.inputSchema.properties).not.toHaveProperty('action');
    expect(create?.inputSchema.properties).not.toHaveProperty('targetCalendar');
  });

  it('does not expose action or mutation fields', () => {
    const forbidden = [
      'action',
      'title',
      'newTitle',
      'name',
      'newName',
      'note',
      'dueDate',
      'list',
      'targetCalendar',
      'span',
      'completed',
    ];

    for (const tool of TOOLS.filter(
      (tool) => tool.name !== 'calendar_event_create',
    )) {
      const properties = tool.inputSchema.properties ?? {};
      for (const property of forbidden) {
        expect(properties).not.toHaveProperty(property);
      }
    }
  });

  it('retains the supported reminder due-date filters', () => {
    const reminders = TOOLS.find((tool) => tool.name === 'reminders_read');
    const dueWithin = reminders?.inputSchema.properties?.dueWithin as
      | { enum?: readonly string[] }
      | undefined;

    expect(dueWithin?.enum).toEqual([
      'today',
      'tomorrow',
      'this-week',
      'overdue',
      'no-date',
    ]);
  });
});
