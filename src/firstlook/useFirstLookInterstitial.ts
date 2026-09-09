/**
 * First Look interstitial.
 *
 * Reference implementation of the pattern documented at
 * https://docs.cloudx.io/en/react-native/integrations/first-look
 * The only addition is the optional `observer`.
 *
 * Simpler than the banner because there is no refresh timer: load CloudX, and
 * only if CloudX fails, load GAM for that opportunity. After a show and close,
 * the next opportunity starts back at CloudX.
 *
 * ERROR PATHS — the part that is easy to get wrong
 *
 * - CloudX LOAD fails → GAM is loaded for this opportunity.
 * - CloudX SHOW fails → same thing. The fallback deliberately covers display
 *   failures too, including a long-held fill that expired.
 * - `load()` while an ad is showing fails immediately, and that error would
 *   trigger the fallback for no reason. The guards below prevent it, which is
 *   why `load()` belongs after the close.
 * - GAM also fails → `show()` returns false; continue your flow without an ad
 *   and space the retries with a widening delay.
 *
 * `show()` does not wait for a load. It reports whether an already-loaded ad
 * was shown, and is NOT a way to try CloudX then fall through to GAM in one
 * call — falling back is this hook's job, on the load-error path.
 *
 * NEVER load CloudX and GAM in parallel. That produces two fills for one
 * opportunity; the wasted GAM fill expires unshown after about an hour and your
 * show rate collapses.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdEventType, GAMInterstitialAd } from 'react-native-google-mobile-ads';
import { CloudXInterstitialAd, useCloudXInterstitial } from 'cloudx-react-native';
import { ATTEMPT_TIMEOUT_MS, CLOSE_SETTLE_MS } from '../config/adUnits';
import type { FirstLookSource } from './FirstLookSource';

/**
 * Ad lifecycle events. Every callback carries the source that served the ad.
 *
 * The hook never reloads for you. `onAdClosed`, `onAdLoadFailed` and
 * `onAdShowFailed` each mean the opportunity is over — call `load()` from them.
 */
export type FirstLookInterstitialObserver = {
  /** A source filled. `source` is the answer to "is CloudX actually filling?" */
  onAdLoaded?: (source: FirstLookSource) => void;
  /**
   * Both sources missed and the opportunity is over. Not raised for the CloudX
   * miss alone — that one triggers the fallback, and reloading on it would
   * double-book the opportunity while GAM is still loading. Only `'gam'` is
   * emitted today.
   */
  onAdLoadFailed?: (source: FirstLookSource, error: string) => void;
  /** The SDK confirmed the ad is on screen. Not inferred from show(). */
  onAdShown?: (source: FirstLookSource) => void;
  /**
   * A loaded ad could not be presented; the opportunity is over. Only `'gam'`
   * today — a CloudX display failure arrives on the load path instead, which is
   * what triggers the fallback.
   */
  onAdShowFailed?: (source: FirstLookSource, error: string) => void;
  /** The ad closed. Call `load()` from here to prepare the next opportunity. */
  onAdClosed?: (source: FirstLookSource) => void;
  /** The user tapped the ad. Reporting only; the placement is unaffected. */
  onAdClicked?: (source: FirstLookSource) => void;
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

  // Managed directly: the plugin's useInterstitialAd hook does not surface
  // GAM-specific event types.
  const gamInterstitial = useMemo(
    () => GAMInterstitialAd.createForAdRequest(gamAdUnitId),
    [gamAdUnitId],
  );
  const [isGamLoaded, setIsGamLoaded] = useState(false);
  const gamLoadRequested = useRef(false);

  const observerRef = useRef(observer);
  observerRef.current = observer;

  /*
   * CloudX state readable from callbacks that run outside render. It is one
   * tick stale between a native event and the re-render, so every handler that
   * changes a flag and then calls the app writes it here first — otherwise a
   * `load()` from `onAdClosed` reads pre-close values and skips the load. GAM
   * needs no mirror; the plugin exposes `gamInterstitial.loaded` synchronously.
   */
  const state = useRef({
    isCloudXLoaded,
    isCloudXLoading,
  });

  state.current = {
    isCloudXLoaded,
    isCloudXLoading,
  };

  const gamLoadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The CloudX error this hook has already fallen back for.
  const handledErrorRef = useRef<string | null>(null);

  /*
   * Set from the moment either SDK is asked to present until that ad is gone.
   * Neither source clears its own ready flag on show, so without this a double
   * tap asks the same fullscreen ad to present twice.
   */
  const presentingRef = useRef(false);

  /*
   * "A CloudX load is in flight", readable now rather than next render — two
   * load() calls in one tick (a retry timer landing on a tap) would otherwise
   * both pass the guards.
   */
  const cloudXLoadRequested = useRef(false);

  /*
   * Set while the SDK is still tearing down the ad just closed. A load issued
   * straight from onClosed is rejected, and that rejection is indistinguishable
   * from a no-fill — so while this is set a CloudX error means "ask again", not
   * "miss", and the placement stays with CloudX. See CLOSE_SETTLE_MS.
   */
  const settlingAfterCloseRef = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Owned here, not by the GAM effect: that one re-runs on a gamAdUnitId
  // change, which would cancel a pending CloudX retry and leave the flag set.
  useEffect(
    () => () => {
      if (settleTimer.current) {
        clearTimeout(settleTimer.current);
        settleTimer.current = null;
      }
    },
    [],
  );

  // Release the latch once the SDK is done, fill or failure.
  useEffect(() => {
    if (!isCloudXLoading) {
      cloudXLoadRequested.current = false;
    }
  }, [isCloudXLoading]);

  const clearGamLoadTimer = useCallback(() => {
    if (gamLoadTimer.current) {
      clearTimeout(gamLoadTimer.current);
      gamLoadTimer.current = null;
    }
  }, []);

  /*
   * useCloudXInterstitial reports no close, so these three SDK listeners are
   * the CloudX leg's only view of the presentation.
   *
   * They are SINGLETON per event: addEventListener replaces any existing
   * subscription and removeAd*EventListener drops that one global
   * subscription. Mount this hook twice, or subscribe to these events
   * elsewhere, and the earlier listener goes deaf with no error.
   */
  useEffect(() => {
    CloudXInterstitialAd.addAdDisplayedEventListener(adInfo => {
      // Only this hook's ad unit, and only a presentation it asked for.
      if (adInfo?.adUnitId !== cloudXAdUnitId || !presentingRef.current) {
        return;
      }
      observerRef.current?.onAdShown?.('cloudx');
    });
    return () => CloudXInterstitialAd.removeAdDisplayedEventListener();
  }, [cloudXAdUnitId]);

  useEffect(() => {
    CloudXInterstitialAd.addAdHiddenEventListener(adInfo => {
      // Another placement, or a presentation this hook did not make, is not
      // this slot's close — onAdClosed is where the app reloads.
      if (adInfo?.adUnitId !== cloudXAdUnitId || !presentingRef.current) {
        return;
      }
      // Before the observer runs: load() reads these.
      state.current.isCloudXLoaded = false;
      presentingRef.current = false;
      settlingAfterCloseRef.current = true;
      if (settleTimer.current) {
        clearTimeout(settleTimer.current);
      }
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null;
        settlingAfterCloseRef.current = false;
      }, CLOSE_SETTLE_MS);
      observerRef.current?.onAdClosed?.('cloudx');
    });
    return () => CloudXInterstitialAd.removeAdHiddenEventListener();
  }, [cloudXAdUnitId]);

  useEffect(() => {
    CloudXInterstitialAd.addAdClickedEventListener(adInfo => {
      /*
       * Reporting only, so no state changes here. No presentingRef check
       * either: only a presented ad can be clicked, and the latch would drop a
       * click arriving in the same tick as the close.
       */
      if (adInfo?.adUnitId !== cloudXAdUnitId) {
        return;
      }
      observerRef.current?.onAdClicked?.('cloudx');
    });
    return () => CloudXInterstitialAd.removeAdClickedEventListener();
  }, [cloudXAdUnitId]);

  useEffect(() => {
    const unsubscribe = gamInterstitial.addAdEventsListener(({ type, payload }) => {
      // The only trustworthy "it is on screen": the show() promise resolves as
      // soon as the native call was made, not when anything appeared.
      if (type === AdEventType.OPENED) {
        observerRef.current?.onAdShown?.('gam');
      }
      // Reporting only.
      if (type === AdEventType.CLICKED) {
        observerRef.current?.onAdClicked?.('gam');
      }
      if (type === AdEventType.LOADED) {
        clearGamLoadTimer();
        setIsGamLoaded(true);
        observerRef.current?.onAdLoaded?.('gam');
      }
      /*
       * CLOSED clears the ready flag too: a dismissed ad is consumed, so the
       * next opportunity must start at CloudX rather than think GAM still has
       * a fill. And ERROR is not only a load failure — both platforms report a
       * failed presentation through it as well, so the latch is what tells
       * them apart.
       */
      if (type === AdEventType.ERROR || type === AdEventType.CLOSED) {
        const wasPresenting = presentingRef.current;
        clearGamLoadTimer();
        setIsGamLoaded(false);
        gamLoadRequested.current = false;
        presentingRef.current = false;
        // Flags first, then the observer: an app reloads from these.
        if (type === AdEventType.CLOSED) {
          observerRef.current?.onAdClosed?.('gam');
        } else if (wasPresenting) {
          const message =
            (payload as { message?: string } | undefined)?.message ??
            'GAM failed to present';
          observerRef.current?.onAdShowFailed?.('gam', message);
        } else {
          const message =
            (payload as { message?: string } | undefined)?.message ??
            'GAM no-fill';
          observerRef.current?.onAdLoadFailed?.('gam', message);
        }
      }
    });
    return () => {
      clearGamLoadTimer();
      unsubscribe();
      // These describe the instance being torn down; left set, load() would
      // early-return against a fresh object holding nothing.
      gamLoadRequested.current = false;
      setIsGamLoaded(false);
    };
  }, [clearGamLoadTimer, gamInterstitial]);

  /*
   * The single fallback trigger: a CloudX error, load OR show, starts GAM. GAM
   * is unreachable any other way, which is what guarantees only one source is
   * ever loading.
   *
   * One fallback per error. `handledErrorRef` is needed because this effect
   * also re-runs when `gamInterstitial` changes identity while `cloudXError` is
   * still set — useCloudXInterstitial clears it only on the next load or fill —
   * which would request GAM again, forever. It survives a gamAdUnitId change
   * for the same reason: the new placement must start at CloudX.
   *
   * Caveat: changing gamAdUnitId mid-fallback abandons that request with no
   * callback at all. Call load() yourself afterwards.
   */
  useEffect(() => {
    if (!cloudXError) {
      // A new load() cleared the error; the next failure is a new opportunity.
      handledErrorRef.current = null;
      return;
    }

    // A display failure produces no hidden event; this is the only place that
    // can release the latch on that path.
    presentingRef.current = false;

    // Still tearing down: the SDK refused a load it cannot service yet, which
    // is not a miss. Ask CloudX again rather than hand GAM the opportunity.
    if (settlingAfterCloseRef.current) {
      if (settleTimer.current) {
        clearTimeout(settleTimer.current);
      }
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null;
        settlingAfterCloseRef.current = false;
        // Claim the latch: a tap landing before setIsLoading commits would
        // otherwise issue a second request for the same placement.
        cloudXLoadRequested.current = true;
        loadCloudX();
      }, CLOSE_SETTLE_MS);
      return;
    }

    const errorKey = String(cloudXError);
    if (
      handledErrorRef.current === errorKey ||
      gamInterstitial.loaded ||
      gamLoadRequested.current
    ) {
      return;
    }

    handledErrorRef.current = errorKey;
    gamLoadRequested.current = true;
    // GAM answering is what clears the latch, so a request that never calls
    // back would leave every later load() returning early on a dead slot.
    clearGamLoadTimer();
    gamLoadTimer.current = setTimeout(() => {
      gamLoadTimer.current = null;
      // Clear before the observer: onAdLoadFailed is where an app retries.
      gamLoadRequested.current = false;
      observerRef.current?.onAdLoadFailed?.(
        'gam',
        `GAM did not answer within ${ATTEMPT_TIMEOUT_MS}ms; its ad object cannot load again this session`,
      );
      /*
       * The slot stays alive — the next load() goes to CloudX — but this GAM
       * object cannot load again: the plugin ignores load() while its internal
       * _isLoadCalled is set, and only CLOSED or ERROR clears that. Recovering
       * the GAM leg means recreating the ad object; this demo keeps CloudX
       * serving instead.
       */
    }, ATTEMPT_TIMEOUT_MS);
    gamInterstitial.load();
  }, [clearGamLoadTimer, cloudXError, gamInterstitial, loadCloudX]);

  // CloudX reports isLoaded as state, not an event, so the fill is the
  // false -> true edge. The ref is what keeps it to one call per fill.
  const reportedCloudXFill = useRef(false);

  useEffect(() => {
    if (isCloudXLoaded === reportedCloudXFill.current) {
      return;
    }
    reportedCloudXFill.current = isCloudXLoaded;
    if (isCloudXLoaded) {
      observerRef.current?.onAdLoaded?.('cloudx');
    }
  }, [isCloudXLoaded]);

  const load = useCallback(() => {
    const current = state.current;

    // gamInterstitial.loaded is the plugin's own state; the mirror exists only
    // for CloudX, which has no synchronous read.
    if (
      cloudXLoadRequested.current ||
      current.isCloudXLoading ||
      current.isCloudXLoaded ||
      gamInterstitial.loaded ||
      gamLoadRequested.current
    ) {
      return;
    }

    cloudXLoadRequested.current = true;
    loadCloudX();
  }, [gamInterstitial, loadCloudX]);

  const show = useCallback((): boolean => {
    const current = state.current;

    // Already presenting: report not-shown rather than present twice.
    if (presentingRef.current) {
      return false;
    }

    if (current.isCloudXLoaded) {
      // No onAdShown here: showCloudX() returns void, so it says the show was
      // requested, not that anything appeared. The displayed event says that.
      presentingRef.current = true;
      showCloudX();
      return true;
    }

    // The plugin's show() throws when the ad is not loaded, and the mirror
    // lags a native CLOSED/ERROR by one render.
    if (gamInterstitial.loaded) {
      /*
       * The promise rejects when the native side cannot present (on Android, no
       * resumed activity) — by which point this function has already returned
       * true. It is reported as onAdShowFailed because an app waiting for the
       * close would otherwise wait forever, and the latch has to be released
       * here since the rejection emits no plugin event.
       *
       * The fill is not lost: nothing clears isGamLoaded, so a reload from that
       * callback early-returns and the next show() presents the ad still in
       * hand.
       */
      presentingRef.current = true;
      Promise.resolve(gamInterstitial.show()).catch(error => {
        presentingRef.current = false;
        observerRef.current?.onAdShowFailed?.('gam', String(error));
      });
      return true;
    }

    return false;
  }, [gamInterstitial, showCloudX]);

  return {
    isReady: isCloudXLoaded || isGamLoaded,
    load,
    show,
  };
}
