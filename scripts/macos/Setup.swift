import AppKit

struct Plan: Decodable {
    var path: String?
    var upgrade: Bool?
    var needsFolder: Bool?
    var version: String?
}

enum SetupError: LocalizedError {
    case missingResources
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .missingResources: return "The installer is missing its bundled runtime."
        case .failed(let message): return message
        }
    }
}

func run(_ action: String, folder: String? = nil) throws -> Plan {
    guard let resources = Bundle.main.resourceURL else { throw SetupError.missingResources }
    let process = Process()
    process.executableURL = resources.appendingPathComponent("node")
    process.arguments = [resources.appendingPathComponent("macos/install.mjs").path, action] +
        (folder.map { [$0] } ?? [])
    let output = Pipe()
    process.standardOutput = output
    let errors = Pipe()
    process.standardError = errors
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        let detail = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        throw SetupError.failed(detail.split(separator: "\n").prefix(5).joined(separator: "\n"))
    }
    return try JSONDecoder().decode(Plan.self, from: data)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)

do {
    var existing = try run("plan")
    var folder: String?
    let confirm = NSAlert()
    confirm.messageText = existing.upgrade == true || existing.needsFolder == true ? "Update Dev Browser" : "Install Dev Browser"
    confirm.informativeText = "Installs the Chrome extension, local relay, and Chrome approval helper together for this Mac user."
    confirm.addButton(withTitle: "Continue")
    if existing.upgrade != true {
        confirm.addButton(withTitle: "Use Existing Extension Folder…")
    }
    confirm.addButton(withTitle: "Cancel")
    let answer = confirm.runModal()
    if answer == .alertSecondButtonReturn && existing.upgrade == true { exit(0) }
    if answer == .alertThirdButtonReturn { exit(0) }
    if answer == .alertSecondButtonReturn || existing.needsFolder == true {
        let picker = NSOpenPanel()
        picker.message = "Choose the Dev Browser folder listed under Source in Chrome’s extension details."
        picker.canChooseDirectories = true
        picker.canChooseFiles = false
        guard picker.runModal() == .OK else { exit(0) }
        folder = picker.url?.path
        existing = try run("plan", folder: folder)
    }
    let result = try run("install", folder: folder)
    guard let extensionPath = result.path else { throw SetupError.failed("Select the existing Dev Browser extension folder.") }
    let done = NSAlert()
    done.messageText = result.upgrade == true ? "Dev Browser updated" : "Dev Browser installed"
    done.informativeText = result.upgrade == true
        ? "In Chrome, reload Dev Browser on the Extensions page. Your profile approval stays saved."
        : "In Chrome, turn on Developer mode, click Load unpacked, and choose the folder shown in Finder. The Dev Browser popup has switches for local control and SSH access."
    done.addButton(withTitle: "Open Chrome Extensions")
    done.addButton(withTitle: "Done")
    if done.runModal() == .alertFirstButtonReturn {
        if result.upgrade != true {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: extensionPath)])
        }
        let chrome = Process()
        chrome.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        chrome.arguments = ["-a", "Google Chrome", "chrome://extensions/"]
        try chrome.run()
    }
} catch {
    let alert = NSAlert(error: error)
    alert.runModal()
    exit(1)
}
