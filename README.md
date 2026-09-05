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

> **Never load CloudX and GAM in parallel.** A parallel load produces two fills for one opportunity.
> The discarded fill is wasted, a GAM interstitial held unshown expires after about an hour with no
> impression, and your GAM show rate collapses. GAM must be reachable only from the CloudX error
> path.

## What's in here

One banner and one interstitial. That's deliberate — the point is the pattern, not coverage.

| File | What it is |
|---|---|
| [`src/config/adUnits.ts`](src/config/adUnits.ts) | Placements, timing constants, and the required dashboard setup |
| [`src/firstlook/useFirstLookBanner.ts`](src/firstlook/useFirstLookBanner.ts) | The banner refresh cycle — the interesting one |
| [`src/firstlook/FirstLookBannerSlot.tsx`](src/firstlook/FirstLookBannerSlot.tsx) | How that cycle is rendered (visible slot + hidden preload slot) |
| [`src/firstlook/useFirstLookInterstitial.ts`](src/firstlook/useFirstLookInterstitial.ts) | The simpler fullscreen case |
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

Two things about this are easy to miss:

**The next cycle always returns to CloudX.** A simpler one-way fallback — swap to GAM on the first
miss and let GAM own the slot until the screen is recreated — is easier to build but permanently
surrenders the placement after a single no-fill. This is what makes it first look on *every*
opportunity.

**The fill starts the clock, not the impression.** Promotion happens in the same handler as the
fill, so the ad is on screen when the wait begins.

Keying the cycle on an impression would be the obvious choice and it does not work here. Neither
view reports one: `CloudXBannerView` exposes load, load-failed, click and revenue-paid, and GAM's
banner had no impression event before plugin v15.7.0. The revenue callback is the only available
proxy and it is a bad one in two ways. It is slow — `onPaid` has been measured firing 71s after the
load, on a banner visible the whole time, which turns a 30s cadence into roughly 100s. And it is
optional: an Ad Manager unit without impression-level revenue reporting never emits it at all, and
since nothing else restarts the cycle the slot would strand on one ad forever, silently.

**An attempt never starts while the app is backgrounded.** Cycling on the fill removes the only
thing that tied a refresh to the ad having been displayed, so the hook puts a coarse version back:
a cycle that comes due in the background is deferred and runs when the app returns. Without it a
backgrounded app keeps running auctions for ads nobody can see.

## Required setup

**1. Disable auto-refresh on both sides.** Two SDKs sharing one slot means two timers racing.

- **CloudX** — set the banner ad unit's refresh rate to `0` in the [dashboard](https://docs.cloudx.io/en/dashboard/ad-units).
  The in-tree `CloudXBannerView` / `CloudXMRECView` components follow the dashboard setting; there is
  no client-side override for them. `CloudXBannerAd.stopAutoRefresh()` only affects programmatic
  overlay ads created through that API, so it is not a substitute.
- **GAM** — disable refresh for the ad unit in the Ad Manager UI, or use a non-refreshing unit.

**2. Initialize both SDKs before any ad view mounts.** A CloudX ad view mounted before
`CloudX.initialize()` completes waits *silently* rather than emitting a failure. The hook's
`ATTEMPT_TIMEOUT_MS` exists to stop that from hanging the slot forever, but you should not rely on it.

**3. Set the Google Mobile Ads application ID.** `ios/CloudXReactNativeDemo/Info.plist`
(`GADApplicationIdentifier`) and `android/app/src/main/AndroidManifest.xml`
(`com.google.android.gms.ads.APPLICATION_ID`). The Google SDK fails at startup without it.

## Versions

Pinned to one specific published runtime, not the newest available, so the app reproduces the same
versions on every machine:

| | Version | Why |
|---|---|---|
| `cloudx-react-native` | `3.4.7` | The published wrapper this app is written against |
| `CloudXCore` (iOS) | `3.4.5` **exact** | `~> 3.4.5` would resolve to 3.4.6 |
| `io.cloudx:sdk` (Android) | `4.4.0` | The wrapper declares 4.1.7 transitively — this app forces 4.4.0 |
| React Native | `0.76.2` | What `cloudx-react-native@3.4.7` targets |

`CloudXGoogleWaterfallAdapter` is deliberately **absent**. It runs AdMob demand *inside* the CloudX
auction, which is the opposite of First Look — and it pins an exact `Google-Mobile-Ads-SDK` version
that fights `react-native-google-mobile-ads`.

## Running

```bash
npm install
cd ios && pod install && cd ..

npm run ios       # or
npm run android
```

## Verifying the fallback by hand

A normal run only proves CloudX renders — it never reaches the GAM fallback branch, which is the
whole point of the pattern. To exercise it, point the banner slot at a CloudX placement that cannot
fill: in `src/config/adUnits.ts`, temporarily set `cloudXBannerAdUnitId` to any id that is not
provisioned on the app key. That produces a deterministic no-fill, and the sequence to expect is

```
cloudx no-fill -> gam attempt -> gam fill -> (REFRESH_DELAY_MS) -> cloudx attempt
```

`useFirstLookBanner` takes an optional `observer` with `onAttemptStart`, `onFill`, `onNoFill`,
`onBackoff`, `onAttemptTimeout` and `onCycleDeferred` callbacks — pass one and log from it to watch
the cycle. `useFirstLookInterstitial` takes an equivalent observer.
