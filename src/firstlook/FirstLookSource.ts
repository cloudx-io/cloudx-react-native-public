/*
 * Which SDK served an ad in the First Look flow. Shared by both hooks so a
 * single handler can take events from either format.
 *
 * `gam` rather than `admob`: the fallback in this demo is Google Ad Manager,
 * reached through GAMInterstitialAd and GAMBannerAd. A publisher falling back
 * to plain AdMob would rename it.
 *
 * https://docs.cloudx.io/en/react-native/integrations/first-look
 */
export type FirstLookSource = 'cloudx' | 'gam';
