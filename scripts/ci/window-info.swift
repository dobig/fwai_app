// Prints the screens and every on-screen-or-not window of a pid, for the
// smoke check's diagnostics: `swift scripts/ci/window-info.swift <pid>`.
import AppKit
import CoreGraphics

let pid = Int(CommandLine.arguments[1])!
for s in NSScreen.screens {
  print("screen frame=\(s.frame) visible=\(s.visibleFrame) scale=\(s.backingScaleFactor)")
}
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int) == pid {
  let b = w[kCGWindowBounds as String] as! [String: Any]
  let layer = w[kCGWindowLayer as String] as? Int ?? -1
  let on = w[kCGWindowIsOnscreen as String] as? Bool ?? false
  print("window layer=\(layer) onscreen=\(on) \(b["Width"]!)x\(b["Height"]!) @\(b["X"]!),\(b["Y"]!)")
}

// `--check-room`: exit 1 unless the app's main window is shorter than the
// screen's usable height. A window squeezed to the full height can't change
// size, so a resize feedback loop can't run in it and the smoke check would
// pass no matter what.
if CommandLine.arguments.contains("--check-room") {
  let main = list.filter {
    ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0
      && ($0[kCGWindowIsOnscreen as String] as? Bool) == true
  }.compactMap { $0[kCGWindowBounds as String] as? [String: Any] }
    .max { ($0["Height"] as! Double) < ($1["Height"] as! Double) }
  guard let main, let usable = NSScreen.main?.visibleFrame.height else {
    print("no on-screen window"); exit(1)
  }
  let height = main["Height"] as! Double
  // The window frame includes its title bar; leave a margin for it.
  if height >= usable - 2 {
    print("window \(Int(height)) px fills the usable screen height \(Int(usable)) px")
    exit(1)
  }
}
