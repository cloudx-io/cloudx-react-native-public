/**
 * First Look banner slot.
 *
 * Renders both halves of the cycle driven by `useFirstLookBanner`:
 *   - the DISPLAYED ad, normally visible
 *   - the LOADING ad, mounted but invisible
 *
 * Mounting is what triggers the load for both `CloudXBannerView` and GAM's
 * `GAMBannerAd`, so the hidden slot is how "load off-screen" is expressed.
 * Nothing is shown from the hidden slot until it fills, and promotion happens
 * immediately on fill — so the ad is on screen as soon as the cycle counts it.
 *
 * Drop `<FirstLookBannerSlot />` wherever the banner belongs in your layout.
 * When the screen unmounts, both slots unmount with it, which destroys the
 * native ads and clears the hook's timers.
 *
 * For MREC, swap `CloudXBannerView` for `CloudXMRECView`, GAM's
 * `sizes={[BannerAdSize.BANNER]}` for `sizes={[BannerAdSize.MEDIUM_RECTANGLE]}`,
 * and the slot size for 300x250.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { CloudXBannerView } from 'cloudx-react-native';
import { BannerAdSize, GAMBannerAd } from 'react-native-google-mobile-ads';
import { AD_UNITS } from '../config/adUnits';
import {
  useFirstLookBanner,
  type FirstLookAttempt,
  type FirstLookBannerObserver,
} from './useFirstLookBanner';

type SlotAdProps = {
  attempt: FirstLookAttempt;
  hidden: boolean;
  cloudXAdUnitId: string;
  onLoaded: (key: number) => void;
  onLoadFailed: (key: number, message: string) => void;
  onClicked: (key: number) => void;
};

function SlotAd({
  attempt,
  hidden,
  cloudXAdUnitId,
  onLoaded,
  onLoadFailed,
  onClicked,
}: SlotAdProps) {
  return (
    <View
      style={hidden ? styles.hidden : undefined}
      pointerEvents={hidden ? 'none' : 'auto'}
      // opacity:0 hides the preloading ad visually but leaves it in the
      // accessibility tree, where a screen reader would still announce it.
      // These two props remove it for assistive technology as well.
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
    >
      {attempt.source === 'cloudx' ? (
        <CloudXBannerView
          adUnitId={cloudXAdUnitId}
          onAdLoaded={() => onLoaded(attempt.key)}
          onAdLoadFailed={errorInfo =>
            onLoadFailed(attempt.key, errorInfo?.message ?? 'CloudX no-fill')
          }
          onAdClicked={() => onClicked(attempt.key)}
        />
      ) : (
        <GAMBannerAd
          unitId={AD_UNITS.gamBannerAdUnitId}
          sizes={[BannerAdSize.BANNER]}
          onAdLoaded={() => onLoaded(attempt.key)}
          onAdFailedToLoad={error =>
            onLoadFailed(attempt.key, error?.message ?? 'GAM no-fill')
          }
          /*
           * No click wiring, deliberately. react-native-google-mobile-ads
           * exposes no banner click event on either platform: its iOS view
           * never implements GADBannerViewDelegate's bannerViewDidRecordClick,
           * and its Android manager never maps AdListener.onAdClicked. The
           * props it does offer are onAdOpened ("the ad is now visible to the
           * user") and onAdClosed ("about to return to the app after tapping
           * on an ad"), and both are raised only when the ad presents a screen
           * INSIDE the app.
           *
           * That makes either one wrong as a click signal, in both directions.
           * It misses a click whose destination leaves the app — verified on
           * the iOS simulator, where Google's test banner opens Safari and
           * neither prop fires — and it would report an expandable creative
           * that opens an overlay without a tap.
           *
           * onAdOpened does happen to fire on an Android tap, because there
           * the destination opens in-app. That is the creative's behaviour,
           * not a contract, so it is not used here: a callback that fires on
           * one platform and silently never on the other is worse than one
           * that is documented as absent.
           *
           * https://github.com/invertase/react-native-google-mobile-ads
           */
        />
      )}
    </View>
  );
}

export type FirstLookBannerSlotProps = {
  /** Optional instrumentation. See `FirstLookBannerObserver`. */
  observer?: FirstLookBannerObserver;
};

export function FirstLookBannerSlot({
  observer,
}: FirstLookBannerSlotProps = {}) {
  const { displayed, loading, onAdLoaded, onAdLoadFailed, onAdClicked } =
    useFirstLookBanner(observer);

  const cloudXAdUnitId = AD_UNITS.cloudXBannerAdUnitId;

  return (
    <View style={styles.slot}>
      {displayed && (
        <SlotAd
          key={displayed.key}
          attempt={displayed}
          hidden={false}
          cloudXAdUnitId={cloudXAdUnitId}
          onLoaded={onAdLoaded}
          onLoadFailed={onAdLoadFailed}
          onClicked={onAdClicked}
        />
      )}
      {loading && (
        <SlotAd
          key={loading.key}
          attempt={loading}
          hidden
          cloudXAdUnitId={cloudXAdUnitId}
          onLoaded={onAdLoaded}
          onLoadFailed={onAdLoadFailed}
          onClicked={onAdClicked}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  /*
   * Phone banner size. On a tablet CloudXBannerView self-sizes to 728x90 while
   * the GAM leg stays 320x50, so a tablet layout needs this slot widened and
   * the GAM `sizes` changed to match — otherwise the CloudX ad is clipped.
   */
  slot: { width: 320, height: 50, alignSelf: 'center' },
  hidden: { position: 'absolute', opacity: 0 },
});
