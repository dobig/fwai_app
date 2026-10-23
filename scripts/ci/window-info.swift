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
