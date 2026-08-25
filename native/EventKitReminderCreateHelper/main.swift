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
    _ arguments: ArraySlice<String>, valueOptions: Set<String>, flagOptions: Set<String>
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

private enum ParsedDueDate {
  case dateOnly(year: Int, month: Int, day: Int)
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

  static func parse(_ value: String) throws -> ParsedDueDate {
    if value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil {
      guard let date = parseStrict(value, formats: ["yyyy-MM-dd"], timeZone: .current) else {
        throw HelperError.usage("Invalid due date '\(value)'.")
      }
      let components = Calendar(identifier: .gregorian).dateComponents(
        [.year, .month, .day], from: date
      )
      guard let year = components.year, let month = components.month, let day = components.day else {
        throw HelperError.usage("Invalid due date '\(value)'.")
      }
      return .dateOnly(year: year, month: month, day: day)
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
        "Invalid due date-time '\(value)'; use YYYY-MM-DD, local YYYY-MM-DD HH:mm[:ss], or ISO 8601 with an offset."
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
        "Invalid due date-time '\(value)'; use YYYY-MM-DD, local YYYY-MM-DD HH:mm[:ss], or ISO 8601 with an offset."
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
    throw HelperError.system("Unable to encode reminder creation result as JSON.")
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
private final class ReminderCreator {
  private let eventStore = EKEventStore()

  func create(
    title: String, reminderListID: String, dueDate: ParsedDueDate?, notes: String?,
    url: URL?, priority: Int
  ) async throws -> [String: Any] {
    try await ensureFullAccess()

    guard let list = eventStore.calendar(withIdentifier: reminderListID) else {
      throw HelperError.usage("Reminder list with ID '\(reminderListID)' was not found.")
    }
    guard list.allowedEntityTypes.contains(.reminder) else {
      throw HelperError.usage(
        "Reminder list with ID '\(reminderListID)' does not support reminders."
      )
    }
    guard list.allowsContentModifications else {
      throw HelperError.usage("Reminder list with ID '\(reminderListID)' is read-only.")
    }

    let reminder = EKReminder(eventStore: eventStore)
    reminder.title = title
    reminder.calendar = list
    reminder.notes = notes
    reminder.url = url
    reminder.priority = priority

    if let dueDate {
      switch dueDate {
      case .dateOnly(let year, let month, let day):
        reminder.dueDateComponents = DateComponents(
          calendar: Calendar(identifier: .gregorian), timeZone: .current,
          year: year, month: month, day: day
        )
      case .timed(let date, let timeZone):
        var components = Calendar(identifier: .gregorian).dateComponents(
          in: timeZone, from: date
        )
        components.calendar = Calendar(identifier: .gregorian)
        components.timeZone = timeZone
        reminder.dueDateComponents = components
        reminder.timeZone = timeZone
      }
    }

    do {
      try eventStore.save(reminder, commit: true)
    } catch {
      throw HelperError.system("Reminder could not be saved: \(error.localizedDescription)")
    }

    return [
      "created": true,
      "id": reminder.calendarItemIdentifier,
      "title": title,
      "list": list.title,
      "reminderListId": list.calendarIdentifier,
      "hasDueDate": reminder.dueDateComponents != nil,
      "priority": reminder.priority,
    ]
  }

  private func ensureFullAccess() async throws {
    switch EKEventStore.authorizationStatus(for: .reminder) {
    case .fullAccess:
      return
    case .notDetermined:
      guard CGSessionCopyCurrentDictionary() != nil else {
        throw HelperError.permission(
          "Permission denied: No GUI session is available to display the Reminders full-access prompt."
        )
      }
      let granted: Bool
      do {
        granted = try await eventStore.requestFullAccessToReminders()
      } catch {
        throw HelperError.permission(
          "Permission denied: Reminders full access could not be requested: \(error.localizedDescription)"
        )
      }
      guard granted else {
        throw HelperError.permission(
          "Permission denied: Reminders full access was denied. Grant it in System Settings > Privacy & Security > Reminders."
        )
      }
    case .denied:
      throw HelperError.permission(
        "Permission denied: Reminders full access was denied. Grant it in System Settings > Privacy & Security > Reminders."
      )
    case .restricted:
      throw HelperError.permission(
        "Permission denied: Reminders access is restricted by system policy."
      )
    case .writeOnly:
      throw HelperError.permission(
        "Permission denied: Reminders permission is write-only. Full access is required to select a specific reminder list by ID."
      )
    @unknown default:
      throw HelperError.permission("Permission denied: Unknown Reminders authorization status.")
    }
  }
}

private let helpText = """
  OVERVIEW: Create-only helper that creates one Apple Reminder

  USAGE:
    eventkit-reminder-create-helper reminder create --list-id <id> --title <title> [--due <date>] [--notes <notes>] [--url <url>] [--priority <0|1|5|9>] --json

  The helper requests full Reminders access so it can resolve the exact target list
  by stable EventKit ID. Its command surface cannot list, read, update, complete, or delete reminders.
  """

@main
private struct EventKitReminderCreateHelper {
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
    guard arguments.starts(with: ["reminder", "create"]) else {
      throw HelperError.usage(
        "Unsupported command. This helper can only create one reminder."
      )
    }
    let options = try ParsedOptions.parse(
      arguments.dropFirst(2),
      valueOptions: [
        "--list-id", "--title", "--due", "--notes", "--url", "--priority",
      ],
      flagOptions: ["--json"]
    )
    guard let rawTitle = options.values["--title"],
      let reminderListID = options.values["--list-id"]
    else {
      throw HelperError.usage("--list-id and --title are required.")
    }
    let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty, title.count <= 200,
      !containsUnsafeText(title, allowLineBreaks: false)
    else {
      throw HelperError.usage("Title is empty, too long, or contains unsafe characters.")
    }
    guard !reminderListID.isEmpty, reminderListID.count <= 512,
      reminderListID.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
    else {
      throw HelperError.usage("Reminder list ID is empty, too long, or contains whitespace.")
    }
    let notes = options.values["--notes"]
    if let notes {
      guard notes.count <= 20_000, !containsUnsafeText(notes, allowLineBreaks: true) else {
        throw HelperError.usage("Notes are too long or contain unsafe characters.")
      }
    }
    let url: URL?
    if let rawURL = options.values["--url"] {
      guard rawURL.count <= 500, !containsUnsafeText(rawURL, allowLineBreaks: false),
        let parsedURL = URL(string: rawURL)
      else {
        throw HelperError.usage("URL is invalid, too long, or contains unsafe characters.")
      }
      url = parsedURL
    } else {
      url = nil
    }
    let priority: Int
    if let rawPriority = options.values["--priority"] {
      guard let parsed = Int(rawPriority), [0, 1, 5, 9].contains(parsed) else {
        throw HelperError.usage("Priority must be 0, 1, 5, or 9.")
      }
      priority = parsed
    } else {
      priority = 0
    }
    let dueDate = try options.values["--due"].map(DateParsing.parse)

    let result = try await ReminderCreator().create(
      title: title, reminderListID: reminderListID, dueDate: dueDate,
      notes: notes, url: url, priority: priority
    )
    try writeJSON(result)
  }
}
