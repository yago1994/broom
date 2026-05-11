//
//  AppVersion.swift
//  Broom
//

import Foundation

enum AppVersion {
    static var shortVersionString: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "?"
    }

    static var buildNumber: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? ""
    }

    /// Marketing version with optional build, for About and the main window.
    static var formattedDisplay: String {
        let build = buildNumber
        return build.isEmpty ? shortVersionString : "\(shortVersionString) (\(build))"
    }
}
