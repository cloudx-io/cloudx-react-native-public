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
 * These are the placements of the public CloudX sample app, the same ones the
 * public Unity demo uses. Both demos resolve against the app identifier
 * `io.cloudx.sample` on iOS and Android, so the dashboard config is shared.
 *
 * Do not point this at a `gw-admob-*` placement. Those route AdMob demand
 * *through* CloudX's Google Waterfall adapter, which is the opposite of First
 * Look — here GAM is the publisher's own separate stack and CloudX never sees
 * it.
 *
 * ---------------------------------------------------------------------------
 * REQUIRED DASHBOARD SETUP
 * ---------------------------------------------------------------------------
 * Set the banner ad unit's refresh rate to `0` (auto-refresh disabled) in the
 * CloudX dashboard. This app owns the refresh cycle; if the SDK also runs its
 * own 30s timer, two timers race over one slot and the SDK will swap an ad in
 * while this app's cycle is mid-load.
 *
 * There is no way to satisfy this from the client. `CloudXBannerView` and
 * `CloudXMRECView` follow the dashboard setting, and
 * `CloudXBannerAd.stopAutoRefresh()` resolves the ad unit id against the
 * programmatic overlay ads created through that API — a component-rendered
 * banner is not in that registry, so the call silently does nothing. Setting
 * the dashboard value is the only option.
 *
 * To confirm the setting took effect, watch the SDK log while a banner is on
 * screen. `Banner refresh scheduled in 30s` or `Starting auto-refresh` for your
 * ad unit means refresh is still enabled:
 *
 *   adb logcat | grep -E 'Banner refresh scheduled|auto-refresh'
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
  /*
   * Carried so this config matches the public Unity demo's DemoConfig
   * field-for-field. This demo renders a banner and an interstitial only, so
   * nothing reads the three below yet.
   */
  /** CloudX MREC placement. Dashboard refresh rate must be 0. */
  cloudXMrecAdUnitId: string;
  /** CloudX app-open placement. */
  cloudXAppOpenAdUnitId: string;
  /** CloudX rewarded placement. */
  cloudXRewardedAdUnitId: string;
  /** GAM banner ad unit. */
  gamBannerAdUnitId: string;
  /** GAM interstitial ad unit. */
  gamInterstitialAdUnitId: string;
};

/** iOS — bundle id `io.cloudx.sample`. */
const IOS: FirstLookAdUnits = {
  cloudXAppKey: 'CmuKsWum6hx3yZK5SY_V_',
  cloudXBannerAdUnitId: '8H3K7_7aSdkNHgYHe10aB',
  cloudXInterstitialAdUnitId: '9SizbPM3Dctz71WM2BKpi',
  cloudXMrecAdUnitId: '6V_LoFhGlpRxQW-6gf9Cy',
  cloudXAppOpenAdUnitId: '3evNMg9P4E1pgRPyAYk9O',
  cloudXRewardedAdUnitId: '7T2i4VWjsG2I4PM5vircU',
  gamBannerAdUnitId: TestIds.BANNER,
  gamInterstitialAdUnitId: TestIds.INTERSTITIAL,
};

/** Android — applicationId `io.cloudx.sample`. */
const ANDROID: FirstLookAdUnits = {
  cloudXAppKey: '0qE4q2MoJzoOkFQQKAtkt',
  cloudXBannerAdUnitId: 'guDml31r4Ys6O6HroPJia',
  cloudXInterstitialAdUnitId: 'PwIOPhOD0KMCB_aqz8c89',
  cloudXMrecAdUnitId: 'TL6HTNWj7kkRUcodwGKSY',
  cloudXAppOpenAdUnitId: 'BI0Whd5_o8ZIxkdHBS7X_',
  cloudXRewardedAdUnitId: 'LZrqb2oz47LMG_TaaVtaR',
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
