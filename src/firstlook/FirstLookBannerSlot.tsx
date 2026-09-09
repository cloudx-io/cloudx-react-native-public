/**
 * Renders both halves of the cycle driven by `useFirstLookBanner`: the ad on
 * screen, and the next one loading invisibly behind it. Mounting an ad view is
 * what starts its load, so the hidden slot is how "preload off-screen" is
 * expressed.
 *
 * Drop `<FirstLookBannerSlot />` where the banner belongs. When the screen
 * unmounts, both slots go with it, destroying the native ads and clearing the
 * hook's timers.
 *
 * For MREC, swap `CloudXBannerView` for `CloudXMRECView`, GAM's
 * `sizes={[BannerAdSize.BANNER]}` for `[BannerAdSize.MEDIUM_RECTANGLE]`, and
 * the slot size for 300x250.
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
      // opacity:0 still leaves the preloading ad in the accessibility tree,
      // where a screen reader would announce it. These take it out.
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
           * No click wiring: react-native-google-mobile-ads exposes no banner
           * click event on either platform.
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
   * Phone size. On a tablet CloudXBannerView self-sizes to 728x90 while GAM
   * stays 320x50, so widen this and change GAM's `sizes` to match or the CloudX
   * ad is clipped.
   */
  slot: { width: 320, height: 50, alignSelf: 'center' },
  hidden: { position: 'absolute', opacity: 0 },
});
