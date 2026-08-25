import CoreGraphics
import Darwin
@preconcurrency import EventKit
import Foundation

private let helperVersion = "0.1.0"

private enum HelperError: Error {
  case usage(String)
  case permission(String)
  case system(String)

  var message: String {
    switch self {
    case .usage(let message), .permission(let message), .system(let message):
      return message
    }
  }

  var exitCode: Int32 {
    switch self {
    case .usage: return 64
    case .permission: return 77
    case .system: return 70
    }
  }
}

private struct ParsedOptions {
  var values: [String: String] = [:]
  var flags: Set<String> = []

  static func parse(
    _ arguments: ArraySlice<String>,
    valueOptions: Set<String>,
    flagOptions: Set<String>
  ) throws -> ParsedOptions {
    var parsed = ParsedOptions()
    var index = arguments.startIndex

    while index < arguments.endIndex {
      let argument = arguments[index]
      if valueOptions.contains(argument) {
        guard parsed.values[argument] == nil else {
          throw HelperError.usage("Duplicate option: \(argument)")
        }
        let valueIndex = arguments.index(after: index)
        guard valueIndex < arguments.endIndex else {
          throw HelperError.usage("Missing value for option: \(argument)")
        }
        parsed.values[argument] = arguments[valueIndex]
        index = arguments.index(after: valueIndex)
        continue
      }
      if flagOptions.contains(argument) {
        guard !parsed.flags.contains(argument) else {
          throw HelperError.usage("Duplicate option: \(argument)")
        }
        parsed.flags.insert(argument)
        index = arguments.index(after: index)
        continue
      }
      throw HelperError.usage("Unsupported option or command: \(argument)")
    }

    guard parsed.flags.contains("--json") else {
      throw HelperError.usage("This helper requires --json output.")
    }
    return parsed
  }
}

private enum DateFormatting {
  static func formatter(_ format: String, timeZone: TimeZone = .current) -> DateFormatter {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = timeZone
    formatter.dateFormat = format
    formatter.isLenient = false
    return formatter
  }

  static func parseDateOnly(_ value: String) throws -> Date {
    let formatter = formatter("yyyy-MM-dd")
    guard value.count == 10, let date = formatter.date(from: value),
      formatter.string(from: date) == value
    else {
      throw HelperError.usage("Invalid date '\(value)'; expected YYYY-MM-DD.")
    }
    return date
  }

  static func localDateTime(_ date: Date, timeZone: TimeZone = .current) -> String {
    formatter("yyyy-MM-dd HH:mm:ss", timeZone: timeZone).string(from: date)
  }

  static func dateOnly(_ date: Date, timeZone: TimeZone = .current) -> String {
    formatter("yyyy-MM-dd", timeZone: timeZone).string(from: date)
  }

  static func iso8601(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  static func date(from components: DateComponents, fallbackTimeZone: TimeZone) -> Date? {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = components.timeZone ?? fallbackTimeZone
    return calendar.date(from: components)
  }
}

private func jsonValue(_ value: Any?) -> Any {
  value ?? NSNull()
}

private func writeJSON(_ object: Any) throws {
  guard JSONSerialization.isValidJSONObject(object) else {
    throw HelperError.system("Unable to encode EventKit data as JSON.")
  }
  let data = try JSONSerialization.data(
    withJSONObject: object,
    options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
  )
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

private func writeError(_ message: String) {
  FileHandle.standardError.write(Data("Error: \(message)\n".utf8))
}

private func colorHex(for calendar: EKCalendar) -> String? {
  guard let components = calendar.cgColor.components else { return nil }
  let red: CGFloat
  let green: CGFloat
  let blue: CGFloat
  if components.count >= 3 {
    red = components[0]
    green = components[1]
    blue = components[2]
  } else if let gray = components.first {
    red = gray
    green = gray
    blue = gray
  } else {
    return nil
  }
  func channel(_ value: CGFloat) -> Int {
    Int((min(max(value, 0), 1) * 255).rounded())
  }
  return String(format: "#%02X%02X%02X", channel(red), channel(green), channel(blue))
}

private func recurrenceJSON(_ rule: EKRecurrenceRule) -> [String: Any] {
  let frequency: String
  switch rule.frequency {
  case .daily: frequency = "daily"
  case .weekly: frequency = "weekly"
  case .monthly: frequency = "monthly"
  case .yearly: frequency = "yearly"
  @unknown default: frequency = "unknown"
  }

  var json: [String: Any] = ["frequency": frequency, "interval": rule.interval]
  json["endDate"] = jsonValue(
    rule.recurrenceEnd?.endDate.map { DateFormatting.dateOnly($0) }
  )
  json["occurrenceCount"] = jsonValue(rule.recurrenceEnd?.occurrenceCount)
  json["daysOfWeek"] = jsonValue(rule.daysOfTheWeek?.map { $0.dayOfTheWeek.rawValue })
  json["daysOfMonth"] = jsonValue(rule.daysOfTheMonth?.map { $0.intValue })
  json["monthsOfYear"] = jsonValue(rule.monthsOfTheYear?.map { $0.intValue })
  return json
}

private func locationJSON(_ alarm: EKAlarm) -> [String: Any]? {
  guard let location = alarm.structuredLocation, let geo = location.geoLocation else {
    return nil
  }
  let proximity: String
  switch alarm.proximity {
  case .enter: proximity = "enter"
  case .leave: proximity = "leave"
  case .none: proximity = "none"
  @unknown default: proximity = "none"
  }
  return [
    "title": location.title ?? "Location",
    "latitude": geo.coordinate.latitude,
    "longitude": geo.coordinate.longitude,
    "radius": location.radius,
    "proximity": proximity,
  ]
}

private func alarmJSON(_ alarm: EKAlarm) -> [String: Any] {
  let type: String?
  switch alarm.type {
  case .display: type = "display"
  case .audio: type = "audio"
  case .procedure: type = "procedure"
  case .email: type = "email"
  @unknown default: type = nil
  }
  let relativeOffset: Any =
    alarm.absoluteDate == nil && alarm.structuredLocation == nil
    ? alarm.relativeOffset : NSNull()
  return [
    "relativeOffset": relativeOffset,
    "absoluteDate": jsonValue(alarm.absoluteDate.map(DateFormatting.iso8601)),
    "locationTrigger": jsonValue(locationJSON(alarm)),
    "alarmType": jsonValue(type),
  ]
}

private func participantJSON(_ participant: EKParticipant) -> [String: Any] {
  let status: String
  switch participant.participantStatus {
  case .unknown: status = "unknown"
  case .pending: status = "pending"
  case .accepted: status = "accepted"
  case .declined: status = "declined"
  case .tentative: status = "tentative"
  case .delegated: status = "delegated"
  case .completed: status = "completed"
  case .inProcess: status = "inProcess"
  @unknown default: status = "unknown"
  }
  let role: String
  switch participant.participantRole {
  case .unknown: role = "unknown"
  case .required: role = "required"
  case .optional: role = "optional"
  case .chair: role = "chair"
  case .nonParticipant: role = "nonParticipant"
  @unknown default: role = "unknown"
  }
  let type: String
  switch participant.participantType {
  case .unknown: type = "unknown"
  case .person: type = "person"
  case .room: type = "room"
  case .resource: type = "resource"
  case .group: type = "group"
  @unknown default: type = "unknown"
  }
  return [
    "name": jsonValue(participant.name), "url": participant.url.absoluteString,
    "status": status, "role": role, "type": type,
    "isCurrentUser": participant.isCurrentUser,
  ]
}

private struct ReminderBatch: @unchecked Sendable {
  let values: [EKReminder]
}

@MainActor
private final class EventKitReader {
  private let eventStore = EKEventStore()

  func reminderLists() async throws -> [[String: Any]] {
    try await ensureAccess(to: .reminder)
    return eventStore.calendars(for: .reminder)
      .sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
      .map { calendar in
        [
          "id": calendar.calendarIdentifier, "title": calendar.title,
          "color": jsonValue(colorHex(for: calendar)),
          "isImmutable": calendar.isImmutable,
        ]
      }
  }

  func reminders(
    listName: String?, includeCompleted: Bool, startDate: Date?, endDate: Date?
  ) async throws -> [[String: Any]] {
    try await ensureAccess(to: .reminder)
    let allCalendars = eventStore.calendars(for: .reminder)
    let calendars = listName.map { name in allCalendars.filter { $0.title == name } }
    if listName != nil && calendars?.isEmpty == true { return [] }

    let predicate = eventStore.predicateForReminders(in: calendars)
    let batch: ReminderBatch = await withCheckedContinuation { continuation in
      eventStore.fetchReminders(matching: predicate) { reminders in
        continuation.resume(returning: ReminderBatch(values: reminders ?? []))
      }
    }
    return batch.values
      .filter { reminder in
        if !includeCompleted && reminder.isCompleted { return false }
        guard startDate != nil || endDate != nil else { return true }
        guard let components = reminder.dueDateComponents,
          let due = DateFormatting.date(from: components, fallbackTimeZone: .current)
        else { return false }
        if let startDate, due < startDate { return false }
        if let endDate, due >= endDate { return false }
        return true
      }
      .sorted { lhs, rhs in
        let left =
          lhs.dueDateComponents.flatMap {
            DateFormatting.date(from: $0, fallbackTimeZone: .current)
          } ?? .distantFuture
        let right =
          rhs.dueDateComponents.flatMap {
            DateFormatting.date(from: $0, fallbackTimeZone: .current)
          } ?? .distantFuture
        if left != right { return left < right }
        return (lhs.title ?? "").localizedCaseInsensitiveCompare(rhs.title ?? "")
          == .orderedAscending
      }
      .map(reminderJSON)
  }

  func calendarEvents(
    startDate: Date, endDate: Date, calendarName: String?
  ) async throws -> [[String: Any]] {
    try await ensureAccess(to: .event)
    guard endDate > startDate else {
      throw HelperError.usage("Calendar end date must be after start date.")
    }
    let maximumWindow = TimeInterval(366 * 4 * 24 * 60 * 60)
    guard endDate.timeIntervalSince(startDate) <= maximumWindow else {
      throw HelperError.usage("Calendar date range cannot exceed four years.")
    }
    let allCalendars = eventStore.calendars(for: .event)
    let calendars = calendarName.map { name in allCalendars.filter { $0.title == name } }
    if calendarName != nil && calendars?.isEmpty == true { return [] }
    let predicate = eventStore.predicateForEvents(
      withStart: startDate, end: endDate, calendars: calendars
    )
    return eventStore.events(matching: predicate)
      .sorted { $0.startDate < $1.startDate }
      .map(eventJSON)
  }

  func calendars() async throws -> [[String: Any]] {
    try await ensureAccess(to: .event)
    return eventStore.calendars(for: .event)
      .sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
      .map { calendar in
        [
          "id": calendar.calendarIdentifier,
          "title": calendar.title,
          "color": jsonValue(colorHex(for: calendar)),
          "allowsContentModifications": calendar.allowsContentModifications,
          "isImmutable": calendar.isImmutable,
        ]
      }
  }

  private enum Entity {
    case reminder
    case event
    var displayName: String { self == .reminder ? "Reminders" : "Calendar" }
    var entityType: EKEntityType { self == .reminder ? .reminder : .event }
  }

  private func ensureAccess(to entity: Entity) async throws {
    switch EKEventStore.authorizationStatus(for: entity.entityType) {
    case .fullAccess:
      return
    case .notDetermined:
      guard CGSessionCopyCurrentDictionary() != nil else {
        throw HelperError.permission(
          "Permission denied: No GUI session is available to display the \(entity.displayName) access prompt."
        )
      }
      let granted: Bool
      do {
        granted =
          entity == .reminder
          ? try await eventStore.requestFullAccessToReminders()
          : try await eventStore.requestFullAccessToEvents()
      } catch {
        throw HelperError.permission(
          "Permission denied: \(entity.displayName) access could not be requested: \(error.localizedDescription)"
        )
      }
      guard granted else {
        throw HelperError.permission(
          "Permission denied: \(entity.displayName) access was denied. Please grant access in System Settings > Privacy & Security > \(entity.displayName)."
        )
      }
    case .denied:
      throw HelperError.permission(
        "Permission denied: \(entity.displayName) access was denied. Please grant access in System Settings > Privacy & Security > \(entity.displayName)."
      )
    case .restricted:
      throw HelperError.permission(
        "Permission denied: \(entity.displayName) access is restricted by system policy."
      )
    case .writeOnly:
      throw HelperError.permission(
        "Permission denied: Only write access to \(entity.displayName.lowercased()). Full access is required."
      )
    @unknown default:
      throw HelperError.permission(
        "Permission denied: Unknown authorization status for \(entity.displayName)."
      )
    }
  }

  private func reminderJSON(_ reminder: EKReminder) -> [String: Any] {
    let timeZone = reminder.timeZone ?? reminder.dueDateComponents?.timeZone ?? .current
    let dueDate = reminder.dueDateComponents
      .flatMap { DateFormatting.date(from: $0, fallbackTimeZone: timeZone) }
      .map { DateFormatting.localDateTime($0, timeZone: timeZone) }
    let startDate = reminder.startDateComponents
      .flatMap { DateFormatting.date(from: $0, fallbackTimeZone: timeZone) }
      .map { DateFormatting.localDateTime($0, timeZone: timeZone) }
    let alarms = reminder.alarms?.map(alarmJSON) ?? []
    let locationTrigger = reminder.alarms?.compactMap(locationJSON).first
    return [
      "id": reminder.calendarItemIdentifier,
      "externalId": jsonValue(reminder.calendarItemExternalIdentifier),
      "title": reminder.title ?? "", "isCompleted": reminder.isCompleted,
      "isFlagged": false, "list": reminder.calendar?.title ?? "Unknown",
      "notes": jsonValue(reminder.notes), "url": jsonValue(reminder.url?.absoluteString),
      "location": jsonValue(reminder.location),
      "timeZone": jsonValue(reminder.timeZone?.identifier),
      "dueDate": jsonValue(dueDate), "startDate": jsonValue(startDate),
      "completionDate": jsonValue(reminder.completionDate.map(DateFormatting.iso8601)),
      "creationDate": jsonValue(reminder.creationDate.map(DateFormatting.iso8601)),
      "lastModifiedDate": jsonValue(reminder.lastModifiedDate.map(DateFormatting.iso8601)),
      "priority": reminder.priority, "alarms": alarms,
      "recurrenceRules": reminder.recurrenceRules?.map(recurrenceJSON) ?? [],
      "locationTrigger": jsonValue(locationTrigger),
    ]
  }

  private func eventJSON(_ event: EKEvent) -> [String: Any] {
    let timeZone = event.isAllDay ? TimeZone.current : (event.timeZone ?? .current)
    let start = event.startDate ?? Date()
    let end = event.endDate ?? start
    let startDate: String
    let endDate: String
    if event.isAllDay {
      startDate = DateFormatting.dateOnly(start, timeZone: timeZone)
      endDate = DateFormatting.dateOnly(
        end > start ? end.addingTimeInterval(-1) : end, timeZone: timeZone
      )
    } else {
      startDate = DateFormatting.localDateTime(start, timeZone: timeZone)
      endDate = DateFormatting.localDateTime(end, timeZone: timeZone)
    }
    let status: String
    switch event.status {
    case .none: status = "none"
    case .confirmed: status = "confirmed"
    case .tentative: status = "tentative"
    case .canceled: status = "canceled"
    @unknown default: status = "unknown"
    }
    let availability: String
    switch event.availability {
    case .notSupported: availability = "not-supported"
    case .busy: availability = "busy"
    case .free: availability = "free"
    case .tentative: availability = "tentative"
    case .unavailable: availability = "unavailable"
    @unknown default: availability = "unknown"
    }
    let structuredLocation: [String: Any]? = event.structuredLocation.map { location in
      [
        "title": location.title ?? "Location",
        "latitude": jsonValue(location.geoLocation?.coordinate.latitude),
        "longitude": jsonValue(location.geoLocation?.coordinate.longitude),
        "radius": location.radius,
      ]
    }
    let identifier =
      event.eventIdentifier
      ?? event.calendarItemExternalIdentifier
      ?? "unidentified-event"
    return [
      "id": identifier, "externalId": jsonValue(event.calendarItemExternalIdentifier),
      "title": event.title ?? "", "calendar": event.calendar?.title ?? "Unknown",
      "calendarId": jsonValue(event.calendar?.calendarIdentifier),
      "startDate": startDate, "endDate": endDate, "isAllDay": event.isAllDay,
      "location": jsonValue(event.location),
      "structuredLocation": jsonValue(structuredLocation), "notes": jsonValue(event.notes),
      "url": jsonValue(event.url?.absoluteString),
      "timeZone": jsonValue(event.timeZone?.identifier), "dateFormatVersion": 1,
      "creationDate": jsonValue(event.creationDate.map(DateFormatting.iso8601)),
      "lastModifiedDate": jsonValue(event.lastModifiedDate.map(DateFormatting.iso8601)),
      "status": status, "availability": availability,
      "alarms": event.alarms?.map(alarmJSON) ?? [],
      "recurrenceRules": event.recurrenceRules?.map(recurrenceJSON) ?? [],
      "organizer": jsonValue(event.organizer.map(participantJSON)),
      "attendees": event.attendees?.map(participantJSON) ?? [],
      "isDetached": event.isDetached,
      "occurrenceDate": jsonValue(event.occurrenceDate.map(DateFormatting.iso8601)),
    ]
  }
}

private let helpText = """
  OVERVIEW: Read-only EventKit helper for Apple Reminders and Calendar

  USAGE:
    eventkit-read-helper reminders list [--list <name>] [--completed] [--start <YYYY-MM-DD> --end <YYYY-MM-DD>] --json
    eventkit-read-helper reminders lists list --json
    eventkit-read-helper calendar calendars list --json
    eventkit-read-helper calendar list --start <YYYY-MM-DD> --end <YYYY-MM-DD> [--calendar <name>] --json

  This helper intentionally implements no create, update, complete, delete, sync,
  network, Shortcut, SQLite, or launchd operations.
  """

@main
private struct EventKitReadHelper {
  @MainActor
  static func main() async {
    do {
      try await run(Array(CommandLine.arguments.dropFirst()))
    } catch let error as HelperError {
      writeError(error.message)
      Darwin.exit(error.exitCode)
    } catch {
      writeError("System error: \(error.localizedDescription)")
      Darwin.exit(70)
    }
  }

  @MainActor
  private static func run(_ arguments: [String]) async throws {
    if arguments == ["--version"] {
      print(helperVersion)
      return
    }
    if arguments.isEmpty || arguments == ["--help"] || arguments == ["-h"] {
      print(helpText)
      return
    }
    let reader = EventKitReader()
    if arguments.starts(with: ["reminders", "lists", "list"]) {
      _ = try ParsedOptions.parse(
        arguments.dropFirst(3), valueOptions: [], flagOptions: ["--json"]
      )
      try writeJSON(await reader.reminderLists())
      return
    }
    if arguments.starts(with: ["reminders", "list"]) {
      let options = try ParsedOptions.parse(
        arguments.dropFirst(2),
        valueOptions: ["--list", "--start", "--end"],
        flagOptions: ["--completed", "--json"]
      )
      let startValue = options.values["--start"]
      let endValue = options.values["--end"]
      guard (startValue == nil) == (endValue == nil) else {
        throw HelperError.usage("Reminder --start and --end must be supplied together.")
      }
      let startDate = try startValue.map(DateFormatting.parseDateOnly)
      let endDate = try endValue.map(DateFormatting.parseDateOnly)
      if let startDate, let endDate, endDate <= startDate {
        throw HelperError.usage("Reminder end date must be after start date.")
      }
      try writeJSON(
        await reader.reminders(
          listName: options.values["--list"],
          includeCompleted: options.flags.contains("--completed"),
          startDate: startDate, endDate: endDate
        )
      )
      return
    }
    if arguments.starts(with: ["calendar", "calendars", "list"]) {
      _ = try ParsedOptions.parse(
        arguments.dropFirst(3), valueOptions: [], flagOptions: ["--json"]
      )
      try writeJSON(await reader.calendars())
      return
    }
    if arguments.starts(with: ["calendar", "list"]) {
      let options = try ParsedOptions.parse(
        arguments.dropFirst(2),
        valueOptions: ["--start", "--end", "--calendar"], flagOptions: ["--json"]
      )
      guard let startValue = options.values["--start"],
        let endValue = options.values["--end"]
      else { throw HelperError.usage("Calendar --start and --end are required.") }
      try writeJSON(
        await reader.calendarEvents(
          startDate: DateFormatting.parseDateOnly(startValue),
          endDate: DateFormatting.parseDateOnly(endValue),
          calendarName: options.values["--calendar"]
        )
      )
      return
    }
    throw HelperError.usage(
      "Unsupported command. This helper is read-only; run --help for the allowed commands."
    )
  }
}
