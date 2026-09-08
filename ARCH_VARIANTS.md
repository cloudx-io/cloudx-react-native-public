# Demo App — Architecture Variants

This demo app can be built and run in **two** configurations per platform:

| Variant | Engine | When to use |
|---------|--------|-------------|
| OldArch | Paper renderer + legacy native modules | Current publisher baseline; default |
| NewArch | Fabric renderer + TurboModules + codegen | Forward-compatibility check |

Both variants share the same JavaScript source tree (`App.tsx`, `src/`). Only the build configuration differs.

## iOS

Controlled by the `RCT_NEW_ARCH_ENABLED` environment variable at `pod install` time. See `ios/Podfile`.

```bash
# OldArch (Paper) — default
(cd ios && bundle exec pod install)
xcodebuild -workspace ios/CloudXReactNativeDemo.xcworkspace -scheme CloudXReactNativeDemo …

# NewArch (Fabric + TurboModules)
(cd ios && RCT_NEW_ARCH_ENABLED=1 bundle exec pod install)
xcodebuild -workspace ios/CloudXReactNativeDemo.xcworkspace -scheme CloudXReactNativeDemo …
```

Through Bundler, as in the README: a global `pod install` can be any version and
would regenerate the workspace with a different toolchain than `ios/Podfile.lock`
records. The environment variable still goes in front of the pinned executable.

Switching variants requires a fresh `pod install`; the two builds cannot coexist in the same checkout without reinstalling Pods.

## Android

Controlled by the `newArchEnabled` Gradle property. See `android/gradle.properties`.

```bash
# OldArch (Paper) — default
(cd android && ./gradlew :app:assembleRelease)

# NewArch (Fabric + TurboModules)
(cd android && ./gradlew :app:assembleRelease -PnewArchEnabled=true)
```

Unlike iOS, Android can produce both variants from the same working tree by varying the CLI flag per invocation.
