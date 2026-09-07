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
  /**
   * The GAM fallback request went silent past ATTEMPT_TIMEOUT_MS.
   *
   * Call `load()` from here. A request that never answers produces no close
   * event, so nothing else reports that the opportunity is over — without a
   * load the slot stays `isReady === false` for the rest of the session. As
   * with `onClosed`, the hook does not reload for you.
   */
  onGamLoadTimeout?: () => void;
  /**
   * The GAM fallback answered with an error — both sources missed, so the
   * opportunity is over.
   *
   * Call `load()` from here too. This is the common no-fill path (CloudX
   * misses, then GAM misses) and it produces no close and no timeout, so it is
   * the only signal for it.
   */
  onGamFailed?: () => void;
  /**
   * An ad reported loaded but failed to present.
   *
   * Only `'gam'` is emitted today: showCloudX() returns void, and CloudX
   * display failures arrive as an error on the load path, which is what
   * triggers the fallback. The union keeps both sources so this stays source
   * compatible if that changes.
   *
   * The opportunity is over when this fires — no ad was displayed and no close
   * will follow — so reload from here as you would from `onClosed`.
   */
  onShowFailed?: (source: 'cloudx' | 'gam', error: string) => void;
  /**
   * An ad was presented. For `'gam'` this fires on the SDK's OPENED event, so
   * it means the ad actually appeared — not merely that show() was called.
   */
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
  /*
   * Bumped to abandon a GAM request that never answered. The plugin's load()
   * early-returns while its internal _isLoadCalled is set, and only a CLOSED
   * or ERROR event clears that — so a silent request makes every later load()
   * on the same object a no-op. Clearing our own latch is not enough; the
   * object itself has to be replaced.
   */
  const [gamGeneration, setGamGeneration] = useState(0);

  const gamInterstitial = useMemo(
    () => GAMInterstitialAd.createForAdRequest(gamAdUnitId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gamAdUnitId, gamGeneration],
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

  // The CloudX error this hook has already fallen back for.
  const handledErrorRef = useRef<string | null>(null);

  /*
   * Set from the moment either SDK is asked to present until that ad is gone.
   * Neither source clears its own ready flag on show — CloudX stays loaded
   * until its hidden event, and the GAM object keeps `loaded` true until
   * CLOSED/ERROR — so without this a second show() (a double tap is enough)
   * asks the same fullscreen ad to present again. On the CloudX path that also
   * risks starting the GAM fallback while the first ad is still on screen.
   */
  const presentingRef = useRef(false);

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
        /*
         * The bus fans out to every hook watching this ad unit, but only the
         * instance that called show() owns the presentation. Without this, a
         * second instance would clear its state and fire onClosed — whose
         * documented use is to reload — inventing an opportunity that never
         * happened.
         */
        if (!presentingRef.current) {
          return;
        }
        // Before the observer runs, not after: `onClosed` is where the app
        // reloads, and the guards in load() read state.current.
        state.current.isCloudXLoaded = false;
        presentingRef.current = false;
        observerRef.current?.onClosed?.('cloudx');
      }),
    [cloudXAdUnitId],
  );

  useEffect(() => {
    const unsubscribe = gamInterstitial.addAdEventsListener(({ type, payload }) => {
      /*
       * OPENED is the only trustworthy "it is on screen" signal. The plugin
       * resolves the show() promise as soon as it has called the native show
       * (Android resolves on the UI thread right after adHelper.show()), so
       * resolution says the call was made, not that anything was presented.
       * The SDK reports actual presentation here.
       */
      if (type === AdEventType.OPENED) {
        observerRef.current?.onShown?.('gam');
      }
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
        /*
         * ERROR is not only a load failure. Both platforms report a failed
         * presentation through the same event — iOS from
         * didFailToPresentFullScreenContentWithError, Android from the
         * equivalent full-screen callback — so the latch is what distinguishes
         * them: if we were presenting, this is a show failure, not a no-fill.
         */
        const wasPresenting = presentingRef.current;
        clearGamLoadTimer();
        state.current.isGamLoaded = false;
        setIsGamLoaded(false);
        gamLoadRequested.current = false;
        presentingRef.current = false;
        // Flags first, then the observer: every branch here is a place an app
        // reloads from, and load() reads them.
        if (type === AdEventType.CLOSED) {
          observerRef.current?.onClosed?.('gam');
        } else if (wasPresenting) {
          const message =
            (payload as { message?: string } | undefined)?.message ??
            'GAM failed to present';
          observerRef.current?.onShowFailed?.('gam', message);
        } else {
          observerRef.current?.onGamFailed?.();
        }
      }
    });
    return () => {
      clearGamLoadTimer();
      unsubscribe();
      /*
       * These flags describe the instance being torn down, so they must not
       * carry over — whether it is being replaced after a timeout or because
       * the caller changed gamAdUnitId. Leaving them set would make load()
       * early-return against a fresh object that has nothing loaded.
       */
      gamLoadRequested.current = false;
      state.current.isGamLoaded = false;
      setIsGamLoaded(false);
    };
  }, [clearGamLoadTimer, gamInterstitial]);

  /*
   * The single fallback trigger: a CloudX error (load OR show) starts GAM. GAM
   * is unreachable by any other path, which is what guarantees exactly one
   * source is ever loading.
   *
   * One fallback per error, tracked here rather than by the latch alone. This
   * effect also re-runs when `gamInterstitial` changes identity — which is
   * exactly what a timeout does — and `cloudXError` is still set at that
   * point, because useCloudXInterstitial clears it only on the next load() or
   * a fill. Without this guard the recovery would immediately request GAM
   * again and arm another timeout, forever.
   *
   * The record deliberately survives a gamAdUnitId change too. Clearing it
   * there would re-enter the fallback for an error already handled and request
   * GAM on the new placement without CloudX ever getting a first look at it.
   * The listener effect's cleanup (it keys on gamInterstitial) clears both
   * flags, so the app's next load() passes every guard and starts at CloudX,
   * which is where a new opportunity belongs.
   *
   * One caveat, deliberately not papered over: changing gamAdUnitId while a
   * fallback is still in flight abandons that request without any callback —
   * no fill, no timeout, no error, because the timer went with the old
   * instance. Call load() yourself after changing the placement. The demo
   * passes a constant id and never hits this.
   */
  useEffect(() => {
    if (!cloudXError) {
      // A new load() cleared the error; the next failure is a new opportunity.
      handledErrorRef.current = null;
      return;
    }

    // A display failure surfaces here and never produces a hidden event, so
    // this is the only place that can release the latch on that path.
    presentingRef.current = false;

    const errorKey = String(cloudXError);
    if (
      handledErrorRef.current === errorKey ||
      state.current.isGamLoaded ||
      gamLoadRequested.current
    ) {
      return;
    }

    handledErrorRef.current = errorKey;
    gamLoadRequested.current = true;
    observerRef.current?.onCloudXError?.(errorKey);
    observerRef.current?.onGamFallbackRequested?.();
    /*
     * The latch stops a second GAM load racing the first, but GAM answering is
     * what clears it. A request that never calls back would leave it set for
     * the rest of the session, and every later load() would return early — the
     * slot would be dead with nothing to rescue it. Same reasoning as
     * ATTEMPT_TIMEOUT_MS in useFirstLookBanner.
     */
    clearGamLoadTimer();
    gamLoadTimer.current = setTimeout(() => {
      gamLoadTimer.current = null;
      /*
       * Clear before the observer, like the close handlers: onGamLoadTimeout
       * is where an app would retry, and load() reads this latch.
       */
      gamLoadRequested.current = false;
      observerRef.current?.onGamLoadTimeout?.();
      /*
       * Replacing the ad object is what actually recovers: the plugin's load()
       * early-returns while its internal _isLoadCalled is set, and only a
       * CLOSED or ERROR clears that, so the old object can never load again.
       * The abandoned request keeps running natively; any fill it produces
       * belongs to an instance nothing reads.
       *
       * Note this leaks: MobileAd registers a native listener in its
       * constructor and exposes no dispose, so each replaced instance stays
       * subscribed. Bounded here at one per CloudX error, which is why the
       * guard above matters.
       */
      setGamGeneration(generation => generation + 1);
    }, ATTEMPT_TIMEOUT_MS);
    gamInterstitial.load();
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

    // Already presenting: report not-shown rather than asking an ad that is
    // on screen to present again.
    if (presentingRef.current) {
      return false;
    }

    if (current.isCloudXLoaded) {
      presentingRef.current = true;
      showCloudX();
      observerRef.current?.onShown?.('cloudx');
      return true;
    }

    /*
     * `gamInterstitial.loaded` rather than the mirrored flag: the plugin's
     * show() throws when the ad is not loaded, and the mirror lags a native
     * CLOSED/ERROR by one render, so the mirror would let that throw through.
     *
     * The returned promise still has to be handled. It rejects if the native
     * side cannot present (on Android, no resumed activity), and by then this
     * function has already returned true — so the app was told an ad was
     * shown. Nothing here can un-tell it; the rejection is surfaced to the
     * observer instead of becoming an unhandled rejection.
     */
    if (gamInterstitial.loaded) {
      /*
       * Rejection only. A resolved promise means the native show call was
       * made, not that an ad appeared — onShown is emitted from the OPENED
       * event instead. A rejection is a real invocation failure (on Android,
       * no current Activity), so it is worth reporting.
       */
      presentingRef.current = true;
      Promise.resolve(gamInterstitial.show()).catch(error => {
        presentingRef.current = false;
        observerRef.current?.onShowFailed?.('gam', String(error));
      });
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
