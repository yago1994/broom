//
//  ViewController.swift
//  Broom
//

import Cocoa
import SafariServices
import WebKit

let extensionBundleIdentifier = "yam.team.broom.Extension"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.navigationDelegate = self
        webView.configuration.userContentController.add(self, name: "controller")
        webView.loadFileURL(
            Bundle.main.url(forResource: "Main", withExtension: "html")!,
            allowingReadAccessTo: Bundle.main.bundleURL
        )
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let versionForJS = Self.javaScriptStringLiteral(AppVersion.formattedDisplay)
        DispatchQueue.main.async {
            webView.evaluateJavaScript("setAppVersion(\(versionForJS))", completionHandler: nil)
        }
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, error in
            guard let state, error == nil else { return }
            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show(\(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show(\(state.isEnabled), false)")
                }
            }
        }
    }

    /// JSON-safe quoted fragment for embedding in JS: `NSJSONSerialization` only accepts array/dict at the root.
    private static func javaScriptStringLiteral(_ string: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [string]),
              let wrapped = String(data: data, encoding: .utf8),
              wrapped.count >= 2,
              wrapped.first == "[",
              wrapped.last == "]"
        else {
            return "\"\""
        }
        return String(wrapped.dropFirst().dropLast())
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let command = message.body as? String, command == "open-preferences" else { return }
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            if let error {
                NSLog("Failed to open Safari extension preferences: \(error.localizedDescription)")
            }
        }
    }
}
