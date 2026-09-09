source 'https://rubygems.org'

# You may use http://rbenv.org/ or https://rvm.io/ to install and use this version
ruby ">= 2.6.10"

# Exclude problematic versions of cocoapods and activesupport that causes build failures.
#
# Gemfile.lock is not committed — ios/Podfile.lock is the lock that pins this
# demo's native graph. These constraints stand in for it, and the two that are
# not from the React Native template have reasons:
#
#   cocoapods ~> 1.16.2  1.17.0 cannot parse React Native 0.76.2's Podfile.
#   json < 3.0           json 3.0 dropped the quirks_mode option ActiveSupport
#                        7.2 still passes; that is what makes 1.17.0 fail, and
#                        without this pin `bundle exec pod install` dies with
#                        "unknown keyword: quirks_mode" before installing.
#
# The template's `xcodeproj < 1.26.0` is deliberately absent: CocoaPods 1.16.2
# requires xcodeproj >= 1.27.0, so that cap drags CocoaPods back to 1.15.2 —
# older than the version that generated ios/Podfile.lock.
gem 'cocoapods', '~> 1.16.2'
gem 'activesupport', '>= 6.1.7.5', '!= 7.1.0'
gem 'concurrent-ruby', '< 1.3.4'
gem 'json', '< 3.0'

# Ruby 3.4.0 has removed some libraries from the standard library.
gem 'bigdecimal'
gem 'logger'
gem 'benchmark'
gem 'mutex_m'
