Pod::Spec.new do |s|
  s.name           = 'AirMeshLan'
  s.version        = '0.2.0'
  s.summary        = 'CrewRoll native storage and LAN utilities'
  s.description    = 'Enforces iOS backup exclusion for private replicas and supports explicit LAN diagnostics.'
  s.license        = { :type => 'MIT' }
  s.author         = 'CrewRoll'
  s.homepage       = 'https://example.invalid/crewroll'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '6.0'
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
end
