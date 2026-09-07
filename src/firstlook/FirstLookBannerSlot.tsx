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
  onLoadFailed: (key: number) => void;
};

function SlotAd({
  attempt,
  hidden,
  cloudXAdUnitId,
  onLoaded,
  onLoadFailed,
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
          onAdLoadFailed={() => onLoadFailed(attempt.key)}
        />
      ) : (
        <GAMBannerAd
          unitId={AD_UNITS.gamBannerAdUnitId}
          sizes={[BannerAdSize.BANNER]}
          onAdLoaded={() => onLoaded(attempt.key)}
          onAdFailedToLoad={() => onLoadFailed(attempt.key)}
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
  const { displayed, loading, onAdLoaded, onAdLoadFailed } =
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
