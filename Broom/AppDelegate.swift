//
//  AppDelegate.swift
//  Broom
//

import Cocoa
import SafariServices

private let safariExtensionBundleIdentifier = "yam.team.broom.Extension"

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Nothing to do on launch — the ViewController handles extension state.
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}
