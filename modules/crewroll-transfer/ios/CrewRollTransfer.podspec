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
  s.source_files = '**/*.{h,m,mm,swift}'
  s.swift_version = '5.9'
end
