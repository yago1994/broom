//
//  SafariWebExtensionHandler.swift
//  Broom Extension
//

import SafariServices
import Cocoa
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        let responsePayload: [String: Any]
        if let dict = message as? [String: Any] {
            if let command = dict["command"] as? String, command == "open-onboarding-app" {
                do {
                    try openContainingApp()
                    responsePayload = ["ok": true]
                } catch {
                    responsePayload = ["ok": false, "error": error.localizedDescription]
                }
            } else {
                os_log(
                    .default,
                    "Broom received message: %{public}@ (profile: %{public}@)",
                    String(describing: message),
                    profile?.uuidString ?? "none"
                )
                responsePayload = ["echo": dict]
            }
        } else {
            os_log(
                .default,
                "Broom received message: %{public}@ (profile: %{public}@)",
                String(describing: message),
                profile?.uuidString ?? "none"
            )
            responsePayload = ["echo": message as Any]
        }

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: responsePayload]
        } else {
            response.userInfo = ["message": responsePayload]
        }

        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    private func openContainingApp() throws {
        let extensionBundleURL = Bundle.main.bundleURL
        guard extensionBundleURL.pathExtension == "appex" else {
            throw NSError(
                domain: "broom",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Could not locate the Broom app bundle."]
            )
        }

        let appURL = extensionBundleURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()

        if #available(macOS 10.15, *) {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { _, error in
                if let error {
                    os_log(.error, "Failed to open Broom app: %{public}@", error.localizedDescription)
                }
            }
            return
        }

        let didLaunch = NSWorkspace.shared.launchApplication(appURL.path)
        if !didLaunch {
            throw NSError(
                domain: "broom",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Could not open the Broom app."]
            )
        }
    }
}
