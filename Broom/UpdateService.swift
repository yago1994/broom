//
//  UpdateService.swift
//  Broom
//

import Foundation

struct UpdateManifest: Codable {
    let latestVersion: String
    let downloadUrl: String
    let releaseNotes: String
    let critical: Bool
}

struct UpdateCheckResult: Sendable {
    let manifest: UpdateManifest
    let updateAvailable: Bool
    let currentVersion: String
}

enum SemanticVersion {
    /// Dot-separated numeric segments (e.g. 1.10.0 > 1.9.0). Non-numeric segments count as 0.
    static func compare(_ a: String, _ b: String) -> ComparisonResult {
        let ca = numericComponents(a)
        let cb = numericComponents(b)
        let n = max(ca.count, cb.count)
        for i in 0..<n {
            let va = i < ca.count ? ca[i] : 0
            let vb = i < cb.count ? cb[i] : 0
            if va != vb { return va < vb ? .orderedAscending : .orderedDescending }
        }
        return .orderedSame
    }

    static func isNewer(latest: String, than current: String) -> Bool {
        compare(latest, current) == .orderedDescending
    }

    private static func numericComponents(_ s: String) -> [Int] {
        s.split(separator: ".").map {
            Int(String($0).trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        }
    }
}

enum UpdateServiceError: Error {
    case noData
}

final class UpdateService {
    static let shared = UpdateService()

    func checkForUpdates(completion: @escaping @Sendable (Result<UpdateCheckResult, Error>) -> Void) {
        let url = AppConfig.updateManifestURL
        let current = AppVersion.shortVersionString
        let task = URLSession.shared.dataTask(with: url) { data, _, error in
            if let error {
                completion(.failure(error))
                return
            }
            guard let data else {
                completion(.failure(UpdateServiceError.noData))
                return
            }
            do {
                let manifest = try JSONDecoder().decode(UpdateManifest.self, from: data)
                let updateAvailable = SemanticVersion.isNewer(latest: manifest.latestVersion, than: current)
                completion(.success(UpdateCheckResult(manifest: manifest, updateAvailable: updateAvailable, currentVersion: current)))
            } catch {
                completion(.failure(error))
            }
        }
        task.resume()
    }
}
