source 'https://rubygems.org'

# You may use http://rbenv.org/ or https://rvm.io/ to install and use this version.
#
# 3.2 is the floor the committed Gemfile.lock actually needs — connection_pool
# 3.0.2 in that lock requires >= 3.2.0. Leaving this at the React Native
# template's 2.6.10 let an older Ruby pass this check and then fail to install
# the locked set, at which point Bundler re-resolves and rewrites the lockfile,
# which is the drift committing it was meant to stop.
ruby ">= 3.2.0"

# Pinned to the toolchain that generated ios/Podfile.lock (see its COCOAPODS
# line). A floating constraint resolves a different CocoaPods than the lockfile
# records, which defeats the point of pinning this demo to one runtime.
gem 'cocoapods', '1.16.2'
gem 'activesupport', '>= 6.1.7.5', '!= 7.1.0'
gem 'concurrent-ruby', '< 1.3.4'

# Ruby 3.4.0 has removed some libraries from the standard library.
gem 'bigdecimal'
gem 'logger'
gem 'benchmark'
gem 'mutex_m'
