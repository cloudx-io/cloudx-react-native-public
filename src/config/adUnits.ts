/**
 * Ad units and timing for the First Look demo.
 *
 * CloudX gets the first chance on EVERY ad opportunity. If it does not fill,
 * the app falls back to Google Ad Manager for that opportunity only, and the
 * next one starts back at CloudX. Never load both at once: a parallel load
 * produces two fills for one opportunity and your GAM show rate collapses.
 *
 * REQUIRED — set the CloudX banner ad unit's refresh rate to 0 in the
 * dashboard. This app owns the refresh cycle, and a second SDK timer would swap
 * an ad in mid-cycle. It cannot be done from the client:
 * `CloudXBannerAd.stopAutoRefresh()` only knows the programmatic overlay ads
 * created through that API, not component-rendered banners. `Banner refresh
 * scheduled in 30s` in the SDK log means the dashboard value did not take.
 *
 * Do not point CloudX at a `gw-admob-*` placement — that runs AdMob demand
 * inside the CloudX auction, which is the opposite of First Look.
 *
 * The ids below belong to the public CloudX sample app (`io.cloudx.sample`).
 * Replace them, and the app key, with your own.
 */

import { Platform } from 'react-native';
import { TestIds } from 'react-native-google-mobile-ads';

/*
 * Google's AdMob test ids, so the GAM leg works with no Ad Manager account.
 * Replace with your own units.
 */

export type FirstLookAdUnits = {
  /** CloudX app key for this platform's demo app. */
  cloudXAppKey: string;
  /** CloudX banner placement. Dashboard refresh rate must be 0. */
  cloudXBannerAdUnitId: string;
  /** CloudX interstitial placement. */
  cloudXInterstitialAdUnitId: string;
  /* The sample app's other placements. Nothing in this demo reads them. */
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
 * Wait after an ad is swapped in before starting the next cycle. Match it to
 * your existing GAM banner cadence. 30s is Google's floor for banner refresh,
 * and the effective interval is this plus the next ad's load time.
 */
export const REFRESH_DELAY_MS = 30_000;

/** Exponential backoff ceiling when BOTH CloudX and GAM miss, in seconds. */
export const MAX_BACKOFF_SECONDS = 64;

/**
 * How long one attempt may stay silent before it counts as failed. An ad view
 * mounted before `CloudX.initialize()` completes waits silently instead of
 * failing, and the cycle would never restart.
 */
export const ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * How long the SDK needs after an interstitial closes before it accepts a load
 * for that placement again. The hidden event fires first, so a load straight
 * from `onClosed` is rejected with "Cannot load while another ad is currently
 * being displayed" — which looks exactly like a no-fill, handing GAM an
 * opportunity CloudX never got. Measured on an Android emulator; treat it as a
 * floor.
 */
export const CLOSE_SETTLE_MS = 500;
