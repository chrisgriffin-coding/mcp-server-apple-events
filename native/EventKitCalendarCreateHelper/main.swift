import CoreGraphics
import Darwin
@preconcurrency import EventKit
import Foundation

private let helperVersion = "0.2.0"

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

private enum ParsedDate {
  case allDay(Date)
  case timed(Date, TimeZone)
}

private enum DateParsing {
  private static func formatter(_ format: String, timeZone: TimeZone) -> DateFormatter {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = timeZone
    formatter.dateFormat = format
    formatter.isLenient = false
    return formatter
  }

  private static func parseStrict(
    _ value: String, formats: [String], timeZone: TimeZone
  ) -> Date? {
    for format in formats {
      let candidate = formatter(format, timeZone: timeZone)
      if let date = candidate.date(from: value), candidate.string(from: date) == value {
        return date
      }
    }
    return nil
  }

  static func parse(_ value: String) throws -> ParsedDate {
    if value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil {
      guard let date = parseStrict(value, formats: ["yyyy-MM-dd"], timeZone: .current) else {
        throw HelperError.usage("Invalid date '\(value)'.")
      }
      return .allDay(date)
    }

    let localFormats = [
      "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm",
      "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm",
    ]
    if let date = parseStrict(value, formats: localFormats, timeZone: .current) {
      return .timed(date, .current)
    }

    guard value.count > 10 else {
      throw HelperError.usage(
        "Invalid date-time '\(value)'; use YYYY-MM-DD, local YYYY-MM-DD HH:mm[:ss], or ISO 8601 with an offset."
      )
    }
    var normalized = value.replacingOccurrences(
      of: " ", with: "T", options: [],
      range: value.index(value.startIndex, offsetBy: 10)..<value.endIndex
    )
    if normalized.range(of: #"[+-]\d{4}$"#, options: .regularExpression) != nil {
      normalized.insert(":", at: normalized.index(normalized.endIndex, offsetBy: -2))
    }
    if normalized.range(
      of: #"T\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$"#, options: .regularExpression
    ) != nil {
      let suffixStart = normalized.lastIndex(where: { $0 == "Z" || $0 == "+" || $0 == "-" })!
      normalized.insert(contentsOf: ":00", at: suffixStart)
    }

    let iso = ISO8601DateFormatter()
    iso.formatOptions =
      normalized.contains(".")
      ? [.withInternetDateTime, .withFractionalSeconds]
      : [.withInternetDateTime]
    guard let date = iso.date(from: normalized) else {
      throw HelperError.usage(
        "Invalid date-time '\(value)'; use YYYY-MM-DD, local YYYY-MM-DD HH:mm[:ss], or ISO 8601 with an offset."
      )
    }
    let timeZone: TimeZone
    if normalized.hasSuffix("Z") {
      timeZone = TimeZone(secondsFromGMT: 0)!
    } else {
      let suffix = String(normalized.suffix(6))
      guard suffix.range(of: #"^[+-]\d{2}:\d{2}$"#, options: .regularExpression) != nil,
        let hours = Int(suffix.dropFirst().prefix(2)),
        let minutes = Int(suffix.suffix(2)), hours <= 23, minutes <= 59
      else {
        throw HelperError.usage("Invalid timezone offset in '\(value)'.")
      }
      let sign = suffix.first == "-" ? -1 : 1
      guard let fixed = TimeZone(secondsFromGMT: sign * ((hours * 60 + minutes) * 60)) else {
        throw HelperError.usage("Invalid timezone offset in '\(value)'.")
      }
      timeZone = fixed
    }
    return .timed(date, timeZone)
  }
}

private func writeJSON(_ object: Any) throws {
  guard JSONSerialization.isValidJSONObject(object) else {
    throw HelperError.system("Unable to encode calendar creation result as JSON.")
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

private func containsUnsafeText(_ value: String, allowLineBreaks: Bool) -> Bool {
  value.unicodeScalars.contains { scalar in
    let code = scalar.value
    if code == 0x09 || code == 0x0A || code == 0x0D {
      return !allowLineBreaks
    }
    return code < 0x20 || code == 0x7F || (0x202A...0x202E).contains(code)
      || (0x2066...0x2069).contains(code)
  }
}

@MainActor
private final class CalendarEventCreator {
  private let eventStore = EKEventStore()

  func create(
    title: String, start: ParsedDate, end: ParsedDate, calendarID: String,
    notes: String?, location: String?
  ) async throws -> [String: Any] {
    try await ensureFullAccess()

    let event = EKEvent(eventStore: eventStore)
    event.title = title
    event.notes = notes
    event.location = location

    switch (start, end) {
    case (.allDay(let startDate), .allDay(let inclusiveEndDate)):
      guard inclusiveEndDate >= startDate else {
        throw HelperError.usage("All-day end date must be on or after start date.")
      }
      guard
        let exclusiveEnd = Calendar.current.date(
          byAdding: .day, value: 1, to: inclusiveEndDate
        )
      else {
        throw HelperError.usage("All-day end date is outside the supported range.")
      }
      event.isAllDay = true
      event.startDate = startDate
      event.endDate = exclusiveEnd
    case (.timed(let startDate, let startZone), .timed(let endDate, let endZone)):
      guard endDate > startDate else {
        throw HelperError.usage("Timed event end must be after start.")
      }
      guard startZone.identifier == endZone.identifier else {
        throw HelperError.usage("Start and end must use the same timezone.")
      }
      event.isAllDay = false
      event.startDate = startDate
      event.endDate = endDate
      event.timeZone = startZone
    default:
      throw HelperError.usage("Start and end must both be dates or both be date-times.")
    }

    guard let calendar = eventStore.calendar(withIdentifier: calendarID) else {
      throw HelperError.usage("Calendar with ID '\(calendarID)' was not found.")
    }
    guard calendar.allowedEntityTypes.contains(.event) else {
      throw HelperError.usage("Calendar with ID '\(calendarID)' does not support events.")
    }
    guard calendar.allowsContentModifications else {
      throw HelperError.usage("Calendar with ID '\(calendarID)' is read-only.")
    }
    event.calendar = calendar

    do {
      try eventStore.save(event, span: .thisEvent, commit: true)
    } catch {
      throw HelperError.system("Calendar event could not be saved: \(error.localizedDescription)")
    }

    return [
      "created": true,
      "id": event.eventIdentifier ?? NSNull(),
      "title": title,
      "calendarId": calendar.calendarIdentifier,
      "calendar": calendar.title,
      "isAllDay": event.isAllDay,
    ]
  }

  private func ensureFullAccess() async throws {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess:
      return
    case .notDetermined:
      guard CGSessionCopyCurrentDictionary() != nil else {
        throw HelperError.permission(
          "Permission denied: No GUI session is available to display the Calendar full-access prompt."
        )
      }
      let granted: Bool
      do {
        granted = try await eventStore.requestFullAccessToEvents()
      } catch {
        throw HelperError.permission(
          "Permission denied: Calendar full access could not be requested: \(error.localizedDescription)"
        )
      }
      guard granted else {
        throw HelperError.permission(
          "Permission denied: Calendar full access was denied. Grant it in System Settings > Privacy & Security > Calendars."
        )
      }
    case .denied:
      throw HelperError.permission(
        "Permission denied: Calendar full access was denied. Grant it in System Settings > Privacy & Security > Calendars."
      )
    case .restricted:
      throw HelperError.permission(
        "Permission denied: Calendar access is restricted by system policy."
      )
    case .writeOnly:
      throw HelperError.permission(
        "Permission denied: Calendar permission is write-only. Full access is required to select a specific calendar by ID."
      )
    @unknown default:
      throw HelperError.permission("Permission denied: Unknown Calendar authorization status.")
    }
  }
}

private let helpText = """
  OVERVIEW: Create-only helper that creates one Apple Calendar event

  USAGE:
    eventkit-calendar-create-helper calendar create --calendar-id <id> --title <title> --start <date> --end <date> [--notes <notes>] [--location <location>] --json

  The helper requests full Calendar access so it can resolve the exact target calendar
  by stable EventKit ID. Its command surface cannot list, read, update, or delete events.
  """

@main
private struct EventKitCalendarCreateHelper {
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
    guard arguments.starts(with: ["calendar", "create"]) else {
      throw HelperError.usage(
        "Unsupported command. This helper can only create one calendar event."
      )
    }
    let options = try ParsedOptions.parse(
      arguments.dropFirst(2),
      valueOptions: [
        "--calendar-id", "--title", "--start", "--end", "--notes", "--location",
      ],
      flagOptions: ["--json"]
    )
    guard let rawTitle = options.values["--title"],
      let calendarID = options.values["--calendar-id"],
      let startValue = options.values["--start"],
      let endValue = options.values["--end"]
    else {
      throw HelperError.usage("--calendar-id, --title, --start, and --end are required.")
    }
    let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty, title.count <= 200, !containsUnsafeText(title, allowLineBreaks: false)
    else {
      throw HelperError.usage("Title must contain 1 to 200 characters.")
    }
    guard !calendarID.isEmpty, calendarID.count <= 512,
      !calendarID.contains(where: { $0.isWhitespace }),
      !containsUnsafeText(calendarID, allowLineBreaks: false)
    else {
      throw HelperError.usage("Calendar ID must contain 1 to 512 non-whitespace characters.")
    }
    if let notes = options.values["--notes"],
      notes.count > 20_000 || containsUnsafeText(notes, allowLineBreaks: true)
    {
      throw HelperError.usage("Notes contain invalid characters or exceed 20000 characters.")
    }
    if let location = options.values["--location"],
      location.count > 200 || containsUnsafeText(location, allowLineBreaks: false)
    {
      throw HelperError.usage("Location contains invalid characters or exceeds 200 characters.")
    }
    try writeJSON(
      await CalendarEventCreator().create(
        title: title,
        start: DateParsing.parse(startValue),
        end: DateParsing.parse(endValue),
        calendarID: calendarID,
        notes: options.values["--notes"],
        location: options.values["--location"]
      )
    )
  }
}
