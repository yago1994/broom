//
//  AppConfig.swift
//  Broom
//

import Foundation

enum AppConfig {
    /// Fallback when `BroomUpdateManifestURL` is absent from Info.plist (host JSON without rebuilding).
    static let defaultUpdateManifestURL = URL(string: "https://yagoarconada.com/apps/broom-files/update.json")!

    static var updateManifestURL: URL {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "BroomUpdateManifestURL") as? String,
              !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let url = URL(string: raw)
        else { return defaultUpdateManifestURL }
        return url
    }
}
