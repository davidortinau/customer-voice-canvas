import AppKit
import UniformTypeIdentifiers

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let panel = NSOpenPanel()
panel.title = "Select a survey export"
panel.message = "Select a CSV or Excel export. The file stays in its current location."
panel.canChooseFiles = true
panel.canChooseDirectories = false
panel.allowsMultipleSelection = false
panel.allowedContentTypes = [UTType(filenameExtension: "csv")!, UTType(filenameExtension: "xlsx")!]
app.activate(ignoringOtherApps: true)
let path = panel.runModal() == .OK ? panel.url?.path : nil
let result: [String: Any] = ["path": path as Any? ?? NSNull()]
let data = try JSONSerialization.data(withJSONObject: result)
FileHandle.standardOutput.write(data)
