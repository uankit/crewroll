package expo.modules.airmeshlan

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.net.NetworkInterface

class AirMeshLanModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AirMeshLan")

    AsyncFunction<List<String>>("getIPv4AddressesAsync") {
      return@AsyncFunction NetworkInterface.getNetworkInterfaces()
        ?.toList()
        .orEmpty()
        .asSequence()
        .filter { networkInterface ->
          runCatching {
            networkInterface.isUp &&
              !networkInterface.isLoopback &&
              !networkInterface.isPointToPoint
          }.getOrDefault(false)
        }
        .flatMap { networkInterface -> networkInterface.inetAddresses.toList().asSequence() }
        .filterIsInstance<Inet4Address>()
        .filterNot { address -> address.isAnyLocalAddress || address.isLoopbackAddress }
        .mapNotNull { address -> address.hostAddress }
        .distinct()
        .sorted()
        .toList()
    }
  }
}
