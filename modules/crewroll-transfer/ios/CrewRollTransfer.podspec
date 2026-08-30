Pod::Spec.new do |s|
  s.name           = 'CrewRollTransfer'
  s.version        = '0.1.0'
  s.summary        = 'CrewRoll native transfer boundary'
  s.description    = 'Native command and durable-projection boundary for CrewRoll photo delivery.'
  s.license        = { :type => 'Proprietary' }
  s.author         = 'CrewRoll'
  s.homepage       = 'https://crewroll.app'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => 'https://github.com/uankit53/crewroll.git', :tag => s.version.to_s }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Reviewed Swift-Sodium 0.11.0 / libsodium 1.0.22 binary.
  # XCFramework inventory SHA-256: d63396012090ae91657484d892cae9b83aeaeb1202e4ea52ef563a21a68dce5b
  s.vendored_frameworks = 'Vendor/Clibsodium.xcframework'
  s.source_files = 'CrewRollTransferModule.swift', 'IdentityKeys/Sources/**/*.{h,m,mm,swift}'
  s.swift_version = '5.9'
end
