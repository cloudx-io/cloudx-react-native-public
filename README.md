# CloudX First Look Demo — React Native

Reference implementation of the CloudX **First Look** integration with **Google Ad Manager (GAM)**
as the fallback, for React Native.

Companion to <https://docs.cloudx.io/en/react-native/integrations/first-look>.

---

## What First Look means

CloudX gets the first chance to fill a placement on **every** ad opportunity. If CloudX does not
fill, the app falls back to GAM for that opportunity only — and the next opportunity starts back at
CloudX.

Exactly one SDK owns the placement at any moment.

> **Never load CloudX and GAM in parallel.** That produces two fills for one opportunity: the
> discarded one is wasted, an unshown GAM interstitial expires after about an hour with no
> impression, and your show rate collapses. GAM must be reachable only from the CloudX error path.

## What's in here

One banner and one interstitial — the point is the pattern, not coverage.

Copy [`src/firstlook/`](src/firstlook) — the five files below are the whole
flow. Everything outside it is this demo's own scaffolding.

| File | What it is |
|---|---|
| [`src/firstlook/useFirstLookBanner.ts`](src/firstlook/useFirstLookBanner.ts) | The banner refresh cycle — the interesting one |
| [`src/firstlook/FirstLookBannerSlot.tsx`](src/firstlook/FirstLookBannerSlot.tsx) | How that cycle is rendered (visible slot + hidden preload slot) |
| [`src/firstlook/useFirstLookInterstitial.ts`](src/firstlook/useFirstLookInterstitial.ts) | The simpler fullscreen case |
| [`src/firstlook/firstLookTiming.ts`](src/firstlook/firstLookTiming.ts) | The four numbers worth tuning |
| [`src/firstlook/FirstLookSource.ts`](src/firstlook/FirstLookSource.ts) | The `'cloudx'` / `'gam'` union every callback reports |
| [`src/config/adUnits.ts`](src/config/adUnits.ts) | This demo's placements and the required dashboard setup — replace with your own |
| [`App.tsx`](App.tsx) | Minimal host screen |

A real integration renders `<FirstLookBannerSlot />` and calls
`useFirstLookInterstitial(...)` and nothing else.

## The banner cycle

```
       ┌──────────────────────────────────────────────┐
       │ load CloudX off-screen (previous ad visible) │
       └───────────────┬──────────────────────────────┘
                       │
          fill ────────┴──────── no-fill
            │                       │
     swap in, destroy       load GAM for this
     previous view            cycle only
            │                       │
            │              fill ────┴──── no-fill
            │                │            │
            └────────┬───────┘     back off 1,2,4,8…s
                     │             (capped at 64) and
             ad swapped in          retry from CloudX
                     │
            wait REFRESH_DELAY_MS
                     │
            ▼ next cycle starts at CloudX again
              (deferred while backgrounded)
```

Three things about this are easy to miss:

**The next cycle always returns to CloudX.** A one-way fallback that lets GAM keep the slot after
one miss is easier to build and permanently surrenders the placement. Returning is what makes it
first look on *every* opportunity.

**The fill starts the clock, not the impression** — promotion happens in the same handler, so the ad
is on screen when the wait begins. Impressions would be the obvious trigger and are not available:
neither view reports one, and the revenue callback is a bad proxy. It is slow (`onPaid` measured at
71s after the load, turning a 30s cadence into roughly 100s) and optional — an Ad Manager unit
without impression-level revenue reporting never emits it, stranding the slot on one ad forever.

**An attempt never starts while the app is backgrounded.** A cycle that comes due then runs when the
app returns, so a backgrounded app is not running auctions for ads nobody can see.

## Required setup

**1. Disable auto-refresh on both sides.** Two SDKs sharing one slot means two timers racing.

- **CloudX** — set the banner ad unit's refresh rate to `0` in the [dashboard](https://docs.cloudx.io/en/dashboard/ad-units).
  There is no client-side equivalent: `CloudXBannerAd.stopAutoRefresh()` resolves the ad unit id
  against the programmatic overlay ads created through that API, and a component-rendered banner is
  not in that registry, so the call silently does nothing. To check the dashboard value took effect,
  watch the log while a banner is on screen — `Banner refresh scheduled in 30s` means it did not:

  ```bash
  adb logcat | grep -E 'Banner refresh scheduled|auto-refresh'
  ```
- **GAM** — disable refresh for the ad unit in the Ad Manager UI, or use a non-refreshing unit.

**2. Initialize both SDKs before any ad view mounts.** A CloudX ad view mounted before
`CloudX.initialize()` completes waits *silently* instead of failing. `ATTEMPT_TIMEOUT_MS` keeps that
from hanging the slot forever, but do not rely on it.

**3. Set the Google Mobile Ads application ID.** `ios/CloudXReactNativeDemo/Info.plist`
(`GADApplicationIdentifier`) and `android/app/src/main/AndroidManifest.xml`
(`com.google.android.gms.ads.APPLICATION_ID`). The Google SDK fails at startup without it.

## Versions

Pinned to one published runtime, not the newest available, so the app reproduces on every machine:

| | Version | Why |
|---|---|---|
| `cloudx-react-native` | `3.4.7` | The published wrapper this app is written against |
| `CloudXCore` (iOS) | `3.4.5` **exact** | `~> 3.4.5` would resolve to 3.4.6 |
| `io.cloudx:sdk` (Android) | `4.4.0` | The wrapper declares 4.1.7 transitively — this app forces 4.4.0 |
| React Native | `0.76.2` | What `cloudx-react-native@3.4.7` targets |

`CloudXGoogleWaterfallAdapter` is deliberately **absent**: it runs AdMob demand *inside* the CloudX
auction, the opposite of First Look, and pins a `Google-Mobile-Ads-SDK` version that fights
`react-native-google-mobile-ads`.

## Running

```bash
# npm ci, not npm install: the committed package-lock.json pins the JS side,
# and `install` is free to move it.
npm ci

# Through Bundler, not global CocoaPods. The Gemfile holds CocoaPods in the
# 1.16.x line that generated ios/Podfile.lock; a global `pod install` can be
# any version and will regenerate the workspace with a different toolchain.
bundle install
(cd ios && bundle exec pod install)
```

`Gemfile.lock` is deliberately not committed; `ios/Podfile.lock` is the lockfile
that matters, because it pins the native dependency graph. Two Gemfile pins are
not inherited from the React Native template:

- **`cocoapods ~> 1.16.2`** — 1.17.0 cannot parse RN 0.76.2's Podfile
  (`unknown keyword: quirks_mode`).
- **`json < 3.0`** — json 3.0 dropped the `quirks_mode` option ActiveSupport 7.2
  still passes, which is where that error comes from.

The template's `xcodeproj < 1.26.0` cap is gone: CocoaPods 1.16.2 needs
xcodeproj >= 1.27.0, so the cap would drag CocoaPods back to 1.15.2.

```bash
npm run ios       # or
npm run android
```

## Verifying the fallback by hand

A normal run only proves CloudX renders; it never reaches the fallback, which is the point of the
pattern. To force it, set `cloudXBannerAdUnitId` in `src/config/adUnits.ts` to an id that is not
provisioned on the app key. That is a deterministic no-fill:

```
cloudx no-fill -> gam attempt -> gam fill -> (REFRESH_DELAY_MS) -> cloudx attempt
```

Both hooks take an optional `observer`, and every callback carries the source (`'cloudx'` or
`'gam'`). `App.tsx` wires and renders all of them, which is how you tell whether CloudX is filling:
if the status line only ever reads `(gam)`, check the app key, the ad unit ids and the dashboard
config.

| callback | banner | interstitial | meaning |
| --- | :-: | :-: | --- |
| `onAdLoaded` | yes | yes | a source filled |
| `onAdLoadFailed` | yes | yes | **both** sources missed; the opportunity is over |
| `onAdClicked` | CloudX only | yes | the user tapped the ad |
| `onAdShown` | — | yes | the SDK confirmed the ad is on screen, not inferred from `show()` |
| `onAdClosed` | — | yes | the ad was dismissed; the opportunity is over |
| `onAdShowFailed` | — | yes | a loaded ad could not be presented |

The one to get right is **`onAdLoadFailed`**. It is not raised when CloudX alone misses, because
that miss is what triggers the fallback — reloading there would double-book the opportunity while
GAM is still loading.

Two silences to know about. A GAM banner click is never reported:
[`react-native-google-mobile-ads`](https://github.com/invertase/react-native-google-mobile-ads)
exposes no banner click event on iOS or Android (the interstitial is unaffected). And the banner
cycle pauses while the app is backgrounded — on iOS that includes the ATT prompt, Control Centre and
the app switcher — with no callback for it; watch `AppState` yourself if you need to see it.
