//
//  AppDelegate.swift
//  Broom
//

import Cocoa
import SafariServices

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        UpdateService.shared.checkForUpdates { result in
            guard case .success(let check) = result, check.updateAvailable else { return }
            DispatchQueue.main.async {
                Self.presentUpdateAlert(check: check)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    @objc func showAboutPanel(_ sender: Any?) {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "Broom",
            .applicationVersion: AppVersion.formattedDisplay,
        ])
    }

    private static func presentUpdateAlert(check: UpdateCheckResult) {
        let alert = NSAlert()
        alert.messageText = check.manifest.critical ? "Important update available" : "A new version of Broom is available"
        alert.informativeText = "Version \(check.manifest.latestVersion) is available. You have \(check.currentVersion).\n\n\(check.manifest.releaseNotes)"
        alert.alertStyle = check.manifest.critical ? .critical : .informational
        alert.addButton(withTitle: "Download")
        alert.addButton(withTitle: "Later")
        let choice = alert.runModal()
        guard choice == .alertFirstButtonReturn,
              let url = URL(string: check.manifest.downloadUrl) else { return }
        NSWorkspace.shared.open(url)
    }
}
