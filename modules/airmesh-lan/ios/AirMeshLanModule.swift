import Darwin
import Foundation
import ExpoModulesCore

public final class AirMeshLanModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AirMeshLan")

    AsyncFunction("getIPv4AddressesAsync") { () -> [String] in
      var firstAddress: UnsafeMutablePointer<ifaddrs>?
      guard getifaddrs(&firstAddress) == 0, let firstAddress else {
        return []
      }
      defer { freeifaddrs(firstAddress) }

      var results = Set<String>()
      for pointer in sequence(first: firstAddress, next: { $0.pointee.ifa_next }) {
        let interface = pointer.pointee
        guard let socketAddress = interface.ifa_addr,
              socketAddress.pointee.sa_family == UInt8(AF_INET) else {
          continue
        }

        let flags = Int32(interface.ifa_flags)
        guard flags & IFF_UP != 0,
              flags & IFF_LOOPBACK == 0,
              flags & IFF_POINTOPOINT == 0 else {
          continue
        }

        var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let status = getnameinfo(
          socketAddress,
          socklen_t(socketAddress.pointee.sa_len),
          &hostname,
          socklen_t(hostname.count),
          nil,
          0,
          NI_NUMERICHOST
        )
        if status == 0 {
          results.insert(String(cString: hostname))
        }
      }
      return results.sorted()
    }

    AsyncFunction("excludeFromBackupAsync") { (locations: [String]) throws in
      for location in locations {
        try excludeFromBackup(location: location)
      }
    }
  }
}

private func excludeFromBackup(location: String) throws {
  let url: URL
  if location.hasPrefix("file://"), let parsed = URL(string: location), parsed.isFileURL {
    url = parsed
  } else if location.hasPrefix("/") {
    url = URL(fileURLWithPath: location, isDirectory: true)
  } else {
    throw backupPolicyError("Backup exclusion requires an absolute file path or file:// URI.")
  }

  let container = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    .standardizedFileURL
    .resolvingSymlinksInPath()
  var target = url.standardizedFileURL.resolvingSymlinksInPath()
  let containerPrefix = container.path.hasSuffix("/") ? container.path : container.path + "/"
  guard target.path == container.path || target.path.hasPrefix(containerPrefix) else {
    throw backupPolicyError("Backup exclusion target is outside the application container.")
  }
  guard FileManager.default.fileExists(atPath: target.path) else {
    throw backupPolicyError("Backup exclusion target does not exist: \(target.lastPathComponent)")
  }

  var values = URLResourceValues()
  values.isExcludedFromBackup = true
  try target.setResourceValues(values)
  let persisted = try target.resourceValues(forKeys: [.isExcludedFromBackupKey])
  guard persisted.isExcludedFromBackup == true else {
    throw backupPolicyError("iOS did not persist backup exclusion for \(target.lastPathComponent).")
  }
}

private func backupPolicyError(_ message: String) -> NSError {
  NSError(
    domain: "com.uankit53.airmesh.backup-policy",
    code: 1,
    userInfo: [NSLocalizedDescriptionKey: message]
  )
}
