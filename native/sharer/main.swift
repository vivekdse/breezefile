// sharer — tiny CLI that pops macOS NSSharingServicePicker anchored to a
// screen rect for a given list of file paths.
//
// Why native (and not an AppleScript-only shim):
// The macOS share sheet is the only UI that exposes AirDrop, Notes,
// Reminders, Messages, and third-party share extensions in one menu.
// AppleScript can target individual services (Mail, Messages) but cannot
// surface AirDrop or arbitrary extensions. Shipping a ~50-line Swift
// binary gets us the full native picker with no Apple Developer fee.
//
// Usage:
//   sharer <x> <y> <w> <h> <path1> [path2 ...]
// Coordinates are screen pixels with top-left origin (matching
// window.screenX/screenY conventions in Electron); converted to macOS
// bottom-left origin internally.

import Cocoa

final class PickerDelegate: NSObject, NSSharingServicePickerDelegate, NSSharingServiceDelegate {
    var finished = false

    func sharingServicePicker(_ sharingServicePicker: NSSharingServicePicker,
                              didChoose service: NSSharingService?) {
        // nil service means the user dismissed the picker without picking.
        if service == nil {
            quit()
        }
        // Otherwise the service begins its flow; we'll quit when it
        // finishes or fails via the NSSharingServiceDelegate below.
        service?.delegate = self
    }

    func sharingService(_ sharingService: NSSharingService,
                        didShareItems items: [Any]) { quit() }
    func sharingService(_ sharingService: NSSharingService,
                        didFailToShareItems items: [Any],
                        error: Error) { quit() }

    func quit() {
        if finished { return }
        finished = true
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }
}

// ── Parse args ──────────────────────────────────────────────────────────────
let args = CommandLine.arguments
guard args.count >= 6,
      let x = Double(args[1]),
      let y = Double(args[2]),
      let w = Double(args[3]),
      let h = Double(args[4]) else {
    FileHandle.standardError.write(Data(
        "usage: sharer <x> <y> <w> <h> <path1> [path2 ...]\n".utf8))
    exit(2)
}
let paths = Array(args.dropFirst(5))
let urls: [NSURL] = paths.map { NSURL(fileURLWithPath: $0) }

// ── Bootstrap an accessory app (no Dock icon) ───────────────────────────────
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Convert top-left screen coords to macOS bottom-left (main screen).
let screenFrame = NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
let flippedY = screenFrame.height - y - h
let anchorRect = NSRect(x: x, y: flippedY, width: w, height: h)

// NSSharingServicePicker.show requires a view to anchor against. Create a
// minimal transparent window at the anchor rect and use its contentView.
let window = NSWindow(
    contentRect: anchorRect,
    styleMask: [.borderless],
    backing: .buffered,
    defer: false)
window.isOpaque = false
window.backgroundColor = .clear
window.level = .popUpMenu
window.ignoresMouseEvents = true
window.hasShadow = false
window.orderFront(nil)

let anchorView = NSView(frame: NSRect(x: 0, y: 0, width: w, height: h))
window.contentView = anchorView

let picker = NSSharingServicePicker(items: urls)
let delegate = PickerDelegate()
picker.delegate = delegate

app.activate(ignoringOtherApps: true)

// Defer to the next runloop tick so the window is actually on-screen before
// the picker tries to anchor to it.
DispatchQueue.main.async {
    picker.show(relativeTo: anchorView.bounds,
                of: anchorView,
                preferredEdge: .minY)
}

app.run()
