/**
 * Ad unit configuration for the First Look demo.
 *
 * ---------------------------------------------------------------------------
 * WHAT "FIRST LOOK" MEANS HERE
 * ---------------------------------------------------------------------------
 * CloudX gets the first chance to fill a placement on EVERY ad opportunity.
 * If CloudX does not fill, the app falls back to Google Ad Manager (GAM) for
 * that opportunity only — and the next opportunity starts back at CloudX.
 *
 * Exactly one SDK owns the placement at any moment. CloudX and GAM are never
 * loaded in parallel: a parallel load produces two fills for one opportunity,
 * the discarded one is wasted, and your GAM show rate collapses.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE SPECIFIC CLOUDX AD UNITS
 * ---------------------------------------------------------------------------
 * These are the plain demo placements on the shared CloudX demo apps. They are
 * deliberately NOT the `gw-admob-*` placements that also exist on these same
 * app keys: those route AdMob demand *through* CloudX's Google Waterfall
 * adapter, which is the opposite of First Look. In First Look, GAM is the
 * publisher's own separate stack and CloudX never sees it.
 *
 * iOS placements resolve against bundle id `cloudx.CloudXObjCRemotePods`.
 * Android placements resolve against applicationId `io.cloudx.demo.demoapp`.
 * Both are shared with the native ObjC/Swift/Android demo apps so the
 * dashboard config is identical.
 *
 * ---------------------------------------------------------------------------
 * REQUIRED DASHBOARD SETUP
 * ---------------------------------------------------------------------------
 * The banner ad unit's refresh rate MUST be set to `0` (auto-refresh disabled)
 * in the CloudX dashboard. This app owns the refresh cycle; if the SDK also
 * runs its own 30s timer, two timers race over one slot.
 *
 * The in-tree `CloudXBannerView` / `CloudXMRECView` components follow the
 * dashboard setting — there is no client-side override for them.
 * `CloudXBannerAd.stopAutoRefresh()` only affects programmatic overlay ads
 * created through that API, so it is not a substitute here.
 *
 * Already satisfied for the two placements below — both read
 * `refresh_rate: 0ms` in the dashboard config, so nothing needs changing to run
 * this app, and nothing has to be flipped on the ad units that the native ObjC,
 * Swift, and Android demos share.
 *
 * Note that `android-demo-banner-1` also carries `disabled_mediators: [cloudx]`.
 * That does NOT suppress CloudX demand — the unit serves at roughly 95% fill
 * (1058 bid requests → 1002 loads → 936 impressions over 14 days, winning
 * bidder `meta`). It is a publisher-side mediation flag, not a kill switch.
 */

import { Platform } from 'react-native';
import { TestIds } from 'react-native-google-mobile-ads';

/*
 * WHY THE ADMOB TEST IDS AND NOT TestIds.GAM_*:
 * Historically the refresh cycle restarted on the `onPaid` revenue callback,
 * and Google's Ad Manager sample tags (`/6499/example/...`) fill through a real
 * AdManagerAdView but never emit it — verified on emulator 2026-08-19: fill at
 * +2s, no paid event within 148s, twice. That stalled the cycle, so the demo
 * used the AdMob test ids instead, which do emit paid events.
 *
 * The cycle now restarts on the fill, so nothing here depends on `onPaid` any
 * more and the sample tags would work. The ids are left alone deliberately:
 * switching them is a separate change with its own verification, not a
 * side effect of the trigger swap.
 */

export type FirstLookAdUnits = {
  /** CloudX app key for this platform's demo app. */
  cloudXAppKey: string;
  /** CloudX banner placement. Dashboard refresh rate must be 0. */
  cloudXBannerAdUnitId: string;
  /** CloudX interstitial placement. */
  cloudXInterstitialAdUnitId: string;
  /** GAM banner ad unit. */
  gamBannerAdUnitId: string;
  /** GAM interstitial ad unit. */
  gamInterstitialAdUnitId: string;
};

/**
 * iOS — bundle `cloudx.CloudXObjCRemotePods`.
 *
 *   LyPxKhBFiUCd1xMLYQhGc → dashboard name "demo-banner-1"
 *   txZ7NmISq-MsuPH0ULKbD → dashboard name "demo-interstitial-1"
 */
const IOS: FirstLookAdUnits = {
  cloudXAppKey: 'ihtOXvp3X9JlMQ5p0_RYL',
  cloudXBannerAdUnitId: 'LyPxKhBFiUCd1xMLYQhGc',
  cloudXInterstitialAdUnitId: 'txZ7NmISq-MsuPH0ULKbD',
  gamBannerAdUnitId: TestIds.BANNER,
  gamInterstitialAdUnitId: TestIds.INTERSTITIAL,
};

/**
 * Android — applicationId `io.cloudx.demo.demoapp`.
 *
 *   XK2rmLLtVg3PPfbXL97Xz → dashboard name "android-demo-banner-1"
 *   uKD1pe6nvi4T_ZqO4PmgG → dashboard name "android-demo-interstitial-1"
 */
const ANDROID: FirstLookAdUnits = {
  cloudXAppKey: 'A0LRd8vpppXoOfwq2vXvx',
  cloudXBannerAdUnitId: 'XK2rmLLtVg3PPfbXL97Xz',
  cloudXInterstitialAdUnitId: 'uKD1pe6nvi4T_ZqO4PmgG',
  gamBannerAdUnitId: TestIds.BANNER,
  gamInterstitialAdUnitId: TestIds.INTERSTITIAL,
};

export const AD_UNITS: FirstLookAdUnits = Platform.select({
  ios: IOS,
  android: ANDROID,
  default: ANDROID,
});

/**
 * How long the app waits after an ad is swapped in before starting the next
 * cycle.
 *
 * Align this with the publisher's existing GAM banner cadence. CloudX's own
 * default is 30s and the dashboard offers 30/60/90; this constant is the single
 * place to change it once a cadence is agreed.
 *
 * 30s is also the floor Google allows for banner refresh. The effective
 * interval is this delay plus the next ad's load time, so the cadence stays at
 * or above that floor.
 */
export const REFRESH_DELAY_MS = 30_000;

/** Exponential backoff ceiling when BOTH CloudX and GAM miss, in seconds. */
export const MAX_BACKOFF_SECONDS = 64;

/**
 * How long a single load attempt may stay silent before it counts as failed.
 *
 * This matters more than it looks: an ad view mounted before
 * `CloudX.initialize()` completes waits silently rather than emitting a
 * failure. Without this timeout the slot would hang forever on a source that
 * never calls back, and the cycle would never restart.
 */
export const ATTEMPT_TIMEOUT_MS = 15_000;
