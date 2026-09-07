/**
 * First Look interstitial.
 *
 * Reference implementation of the pattern documented at
 * https://docs.cloudx.io/en/react-native/integrations/first-look
 *
 * Interstitials are simpler than banners because there is no refresh timer:
 * load CloudX first, and only if CloudX fails, load the GAM interstitial as the
 * fallback for that opportunity. After a show and close, the next opportunity
 * starts back at CloudX.
 *
 * As with the banner hook, the logic matches the documented version and the
 * only addition is the optional `observer`.
 *
 * ---------------------------------------------------------------------------
 * ERROR PATHS — the part that is easy to get wrong
 * ---------------------------------------------------------------------------
 * - CloudX LOAD fails (no-fill or error) → load GAM for this opportunity.
 *   `error` from `useCloudXInterstitial` is set when the load-failed callback
 *   fires.
 *
 * - CloudX SHOW fails → the ad is consumed and the same `error` field is set,
 *   so GAM is loaded for this opportunity too. The fallback deliberately covers
 *   display failures, not just load failures. This includes an expired fill: a
 *   CloudX interstitial held loaded but unshown for a long time can expire and
 *   fail at show time, and the fallback picks it up.
 *
 * - `load()` called while an ad is showing fails immediately, and that error
 *   would trigger the GAM fallback for no reason. The guards below prevent it
 *   (`isLoaded` stays true until the ad is hidden), which is why `load()` must
 *   only be called after the close.
 *
 * - GAM also fails → `show()` returns false and the app flow continues without
 *   an ad. Call `load()` again before the next opportunity; if failures repeat,
 *   space the retries with an exponential delay (1, 2, 4, 8, ... seconds)
 *   rather than retrying immediately.
 *
 * ---------------------------------------------------------------------------
 * WHAT show() IS NOT
 * ---------------------------------------------------------------------------
 * `show()` does not block or wait for a load. It reports whether an
 * already-loaded ad was shown. It is NOT a way to try CloudX and then fall
 * through to GAM within the same call — falling back is this hook's job, on the
 * load-error path. Calling `show()` and then immediately loading or showing GAM
 * yourself double-books the opportunity.
 *
 * NEVER load CloudX and GAM in parallel. A parallel load produces two fills for
 * one opportunity; the discarded one is wasted (and a GAM interstitial held
 * unshown expires after about an hour with no impression), and your GAM show
 * rate collapses.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdEventType, GAMInterstitialAd } from 'react-native-google-mobile-ads';
import { useCloudXInterstitial } from 'cloudx-react-native';
import { ATTEMPT_TIMEOUT_MS } from '../config/adUnits';
import { onInterstitialClosed } from './interstitialCloseBus';

export type FirstLookInterstitialObserver = {
  onCloudXError?: (error: string) => void;
  onGamFallbackRequested?: () => void;
  onGamLoaded?: () => void;
  /** The GAM fallback request went silent past ATTEMPT_TIMEOUT_MS. */
  onGamLoadTimeout?: () => void;
  onShown?: (source: 'cloudx' | 'gam') => void;
  /**
   * The ad closed and the opportunity is over. Call `load()` from here to
   * prepare the next one — the hook deliberately does not reload for you, so
   * the app decides when a new load is appropriate.
   */
  onClosed?: (source: 'cloudx' | 'gam') => void;
  onNothingReady?: () => void;
};

export function useFirstLookInterstitial(
  cloudXAdUnitId: string,
  gamAdUnitId: string,
  observer?: FirstLookInterstitialObserver,
) {
  const {
    error: cloudXError,
    isLoaded: isCloudXLoaded,
    isLoading: isCloudXLoading,
    load: loadCloudX,
    show: showCloudX,
  } = useCloudXInterstitial(cloudXAdUnitId);

  /*
   * `GAMInterstitialAd` is the plugin's documented class for Ad Manager
   * units, and the `useInterstitialAd` hook does not surface GAM-specific
   * event types, so the GAM interstitial is managed directly.
   */
  const gamInterstitial = useMemo(
    () => GAMInterstitialAd.createForAdRequest(gamAdUnitId),
    [gamAdUnitId],
  );
  const [isGamLoaded, setIsGamLoaded] = useState(false);
  const gamLoadRequested = useRef(false);

  const observerRef = useRef(observer);
  observerRef.current = observer;

  /*
   * Mirrors the React state for callbacks that run outside render.
   *
   * Assigned on every render, so between a native event and the re-render it
   * triggers, these fields are one tick stale. Every handler that both changes
   * a flag and calls back into the app therefore writes the field here first —
   * see the close handlers below. Without that, a `load()` made from `onClosed`
   * reads the pre-close values and skips the load entirely.
   */
  const state = useRef({
    isGamLoaded,
    isCloudXLoaded,
    isCloudXLoading,
  });

  state.current = {
    isGamLoaded,
    isCloudXLoaded,
    isCloudXLoading,
  };

  // Cleared when GAM answers; see the timeout below for why it needs one.
  const gamLoadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearGamLoadTimer = useCallback(() => {
    if (gamLoadTimer.current) {
      clearTimeout(gamLoadTimer.current);
      gamLoadTimer.current = null;
    }
  }, []);

  // CloudX close signal.
  //
  // useCloudXInterstitial exposes {isLoaded, isLoading, error, load, show,
  // destroy} and no close/hidden state, so without this the CloudX leg has
  // nothing to react to when an ad is dismissed: the ad is consumed, isReady
  // goes false, and the slot stays dead for the rest of the session. The GAM
  // leg below already handles its own CLOSED; this makes the two symmetric.
  //
  // Routed through interstitialCloseBus rather than subscribing directly,
  // because the SDK's hidden-event listener is singleton — see that module for
  // why subscribing here directly silently breaks with two hook instances.
  useEffect(
    () =>
      onInterstitialClosed(cloudXAdUnitId, () => {
        // Before the observer runs, not after: `onClosed` is where the app
        // reloads, and the guards in load() read state.current.
        state.current.isCloudXLoaded = false;
        observerRef.current?.onClosed?.('cloudx');
      }),
    [cloudXAdUnitId],
  );

  useEffect(() => {
    const unsubscribe = gamInterstitial.addAdEventsListener(({ type }) => {
      if (type === AdEventType.LOADED) {
        clearGamLoadTimer();
        state.current.isGamLoaded = true;
        setIsGamLoaded(true);
        observerRef.current?.onGamLoaded?.();
      }
      // CLOSED clears the flag as well as ERROR: a shown-and-dismissed ad is
      // consumed, so the next opportunity must start fresh at CloudX rather
      // than believing GAM still has a fill in hand.
      if (type === AdEventType.ERROR || type === AdEventType.CLOSED) {
        clearGamLoadTimer();
        state.current.isGamLoaded = false;
        setIsGamLoaded(false);
        gamLoadRequested.current = false;
        if (type === AdEventType.CLOSED) {
          observerRef.current?.onClosed?.('gam');
        }
      }
    });
    return () => {
      clearGamLoadTimer();
      unsubscribe();
    };
  }, [clearGamLoadTimer, gamInterstitial]);

  // The single fallback trigger: a CloudX error (load OR show) starts GAM. GAM
  // is unreachable by any other path, which is what guarantees exactly one
  // source is ever loading.
  useEffect(() => {
    if (cloudXError && !state.current.isGamLoaded && !gamLoadRequested.current) {
      gamLoadRequested.current = true;
      observerRef.current?.onCloudXError?.(String(cloudXError));
      observerRef.current?.onGamFallbackRequested?.();
      /*
       * The latch stops a second GAM load racing the first, but GAM answering
       * is what clears it. A request that never calls back would leave it set
       * for the rest of the session, and every later load() would return early
       * — the slot would be dead with nothing to rescue it. Same reasoning as
       * ATTEMPT_TIMEOUT_MS in useFirstLookBanner.
       */
      clearGamLoadTimer();
      gamLoadTimer.current = setTimeout(() => {
        gamLoadTimer.current = null;
        gamLoadRequested.current = false;
        observerRef.current?.onGamLoadTimeout?.();
      }, ATTEMPT_TIMEOUT_MS);
      gamInterstitial.load();
    }
  }, [clearGamLoadTimer, cloudXError, gamInterstitial]);

  const load = useCallback(() => {
    const current = state.current;

    if (
      current.isCloudXLoading ||
      current.isCloudXLoaded ||
      current.isGamLoaded ||
      gamLoadRequested.current
    ) {
      return;
    }

    loadCloudX();
  }, [loadCloudX]);

  const show = useCallback((): boolean => {
    const current = state.current;

    if (current.isCloudXLoaded) {
      showCloudX();
      observerRef.current?.onShown?.('cloudx');
      return true;
    }

    /*
     * `gamInterstitial.loaded` rather than the mirrored flag: show() throws if
     * the ad is not actually loaded, and the mirror lags a native CLOSED/ERROR
     * by one render. Reading the live value keeps the documented contract —
     * show() reports whether an ad was shown, it never throws.
     */
    if (gamInterstitial.loaded) {
      gamInterstitial.show();
      observerRef.current?.onShown?.('gam');
      return true;
    }

    observerRef.current?.onNothingReady?.();
    return false;
  }, [gamInterstitial, showCloudX]);

  return {
    isReady: isCloudXLoaded || isGamLoaded,
    load,
    show,
  };
}
