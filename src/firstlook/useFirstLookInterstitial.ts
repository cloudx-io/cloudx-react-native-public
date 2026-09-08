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
import { CloudXInterstitialAd, useCloudXInterstitial } from 'cloudx-react-native';
import { ATTEMPT_TIMEOUT_MS, CLOSE_SETTLE_MS } from '../config/adUnits';
import type { FirstLookSource } from './FirstLookSource';

/**
 * Ad lifecycle events, named and shaped like the public Unity demo's
 * FirstLookInterstitialController so one integration reads like the other.
 * Every callback carries the source that served the ad.
 *
 * The hook never reloads for you. `onAdClosed`, `onAdLoadFailed` and
 * `onAdShowFailed` each mean the opportunity is over — call `load()` from them.
 */
export type FirstLookInterstitialObserver = {
  /** A source filled. `source` is the answer to "is CloudX actually filling?" */
  onAdLoaded?: (source: FirstLookSource) => void;
  /**
   * The opportunity is over with no ad: both sources missed.
   *
   * Deliberately NOT emitted for the CloudX miss on its own. That miss is not
   * terminal — it is what triggers the GAM fallback — so reporting it here
   * would have the app back off and reload while GAM is still loading, which
   * double-books the opportunity. Only `'gam'` is emitted today, for the same
   * reason the Unity controller only raises AdLoadFailed once the fallback has
   * failed too.
   */
  onAdLoadFailed?: (source: FirstLookSource, error: string) => void;
  /**
   * An ad was presented — confirmed by the SDK, not inferred from calling
   * show(). CloudX reports this through its displayed event and GAM through
   * OPENED, so either way it means the ad actually appeared.
   */
  onAdShown?: (source: FirstLookSource) => void;
  /**
   * A loaded ad could not be presented. The opportunity is over.
   *
   * Only `'gam'` is emitted today: showCloudX() returns void, and CloudX
   * display failures arrive as an error on the load path, which is what
   * triggers the fallback. The union keeps both sources so this stays source
   * compatible if that changes.
   *
   * Two paths reach it, and the app treats them the same way (reload) even
   * though they differ underneath: a GAM ERROR raised while presenting, where
   * the ad was consumed; and the plugin's show() promise rejecting, where it
   * was not — see the note on that rejection in show() below.
   */
  onAdShowFailed?: (source: FirstLookSource, error: string) => void;
  /**
   * The ad closed and the opportunity is over. Call `load()` from here to
   * prepare the next one — the hook deliberately does not reload for you, so
   * the app decides when a new load is appropriate.
   */
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

  // The CloudX error this hook has already fallen back for.
  const handledErrorRef = useRef<string | null>(null);

  /*
   * Set from the moment either SDK is asked to present until that ad is gone.
   * Neither source clears its own ready flag on show — CloudX stays loaded
   * until its hidden event, and the GAM object keeps `loaded` true until
   * CLOSED/ERROR — so without this a second show() (a double tap is enough)
   * asks the same fullscreen ad to present again. On the CloudX path that also
   * risks starting the GAM fallback while the first ad is still on screen.
   *
   * Cleared by the presentation lifecycle only: CloudX hidden, a CloudX error,
   * GAM CLOSED/ERROR, or a rejected GAM show. A native side that answers with
   * none of those leaves this set and show() reports not-shown from then on.
   * This demo accepts that rather than carrying a timeout for it.
   */
  const presentingRef = useRef(false);

  /*
   * Synchronous mirror of "a CloudX load is in flight". isCloudXLoading only
   * reaches state.current on the next render, so two load() calls in one tick
   * — a retry timer landing on the same tick as a tap — would both pass the
   * guards and issue two requests. The GAM leg already had gamLoadRequested
   * for exactly this; this is its counterpart.
   *
   * Note this does not survive StrictMode's replayed effect phase: the release
   * effect below re-runs with isCloudXLoading still false and clears the
   * latch. Guarding that too would need the SDK to report in-flight state
   * synchronously.
   */
  const cloudXLoadRequested = useRef(false);

  /*
   * Set while the SDK is still tearing down the ad we just closed.
   *
   * The hidden event fires before the SDK's own manager releases the
   * placement, so a load issued straight from onClosed — the pattern this hook
   * documents — is rejected with "Cannot load while another ad is currently
   * being displayed". That rejection arrives as a plain cloudXError, and the
   * fallback effect cannot tell it from a no-fill, so GAM would take the next
   * opportunity even though CloudX was never actually asked. Measured on an
   * Android emulator: reloading immediately fails every time and GAM serves
   * the next tap; deferring past teardown succeeds.
   *
   * While this is set, a CloudX error is treated as "ask again", not as a
   * miss, so the placement stays with CloudX.
   */
  const settlingAfterCloseRef = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * Owned here rather than by the GAM listener effect. That effect re-runs
   * whenever gamInterstitial changes identity — a generation bump after a GAM
   * timeout, or a new gamAdUnitId — and clearing the settle timer from its
   * cleanup would cancel a pending CloudX retry while leaving the settling
   * flag set: no load, no error, no callback, and the next CloudX error taking
   * the settling branch instead of the fallback.
   */
  useEffect(
    () => () => {
      if (settleTimer.current) {
        clearTimeout(settleTimer.current);
        settleTimer.current = null;
      }
    },
    [],
  );

  /*
   * Release the in-flight latch once the SDK reports it is done, whichever way
   * it went: a fill clears isCloudXLoading, and so does a failure (which also
   * sets cloudXError and drives the fallback below).
   */
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

  // CloudX close signal.
  //
  // useCloudXInterstitial exposes {isLoaded, isLoading, error, load, show,
  // destroy} and no close/hidden state, so without this the CloudX leg has
  // nothing to react to when an ad is dismissed: the ad is consumed, isReady
  // goes false, and the slot stays dead for the rest of the session. The GAM
  // leg below already handles its own CLOSED; this makes the two symmetric.
  /*
   * The three listeners below — displayed, hidden and clicked — are SINGLETON
   * per event: the SDK's addEventListener removes any existing subscription
   * before installing the new one, and removeAd*EventListener removes that one
   * global subscription rather than a particular caller's. So this hook must be
   * the only thing in the app subscribing to the interstitial displayed, hidden
   * and clicked events. Mount it twice, or subscribe anywhere else, and the
   * earlier listener goes deaf with no error. cloudx-react-native 3.4.7 does
   * not export the shared NativeEventEmitter (cloudXEventEmitter was added
   * later), which is what a multi-subscriber app would need.
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
      /*
       * An event for another placement is not this slot's close, and a close
       * this hook did not present is not its opportunity — firing onAdClosed,
       * whose documented use is to reload, would invent one that never
       * happened.
       */
      if (adInfo?.adUnitId !== cloudXAdUnitId || !presentingRef.current) {
        return;
      }
      // Before the observer runs, not after: `onAdClosed` is where the app
      // reloads, and the guards in load() read state.current.
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
       * Reporting only. A click leaves the placement exactly as it was, so
       * nothing here touches presentingRef, state.current or any latch — and
       * there is no presentingRef check either: a click can only reach a
       * presented ad, and gating on the latch would drop clicks that arrive in
       * the same tick as the close.
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
      /*
       * OPENED is the only trustworthy "it is on screen" signal. The plugin
       * resolves the show() promise as soon as it has called the native show
       * (Android resolves on the UI thread right after adHelper.show()), so
       * resolution says the call was made, not that anything was presented.
       * The SDK reports actual presentation here.
       */
      if (type === AdEventType.OPENED) {
        observerRef.current?.onAdShown?.('gam');
      }
      // Reporting only: a click changes no state here, so it must not touch
      // presentingRef or the state.current mirror.
      if (type === AdEventType.CLICKED) {
        observerRef.current?.onAdClicked?.('gam');
      }
      if (type === AdEventType.LOADED) {
        clearGamLoadTimer();
        state.current.isGamLoaded = true;
        setIsGamLoaded(true);
        observerRef.current?.onAdLoaded?.('gam');
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

    /*
     * Still tearing down: this error is the SDK refusing a load it cannot
     * service yet, not a miss. Ask CloudX again rather than handing the
     * opportunity to GAM.
     */
    if (settlingAfterCloseRef.current) {
      if (settleTimer.current) {
        clearTimeout(settleTimer.current);
      }
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null;
        settlingAfterCloseRef.current = false;
        // A load in flight: claim the latch rather than clearing it. Clearing
        // it here would let a tap landing before setIsLoading commits issue a
        // second request for the same placement.
        cloudXLoadRequested.current = true;
        loadCloudX();
      }, CLOSE_SETTLE_MS);
      return;
    }

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
       * Clear before the observer, like the close handlers: onAdLoadFailed
       * is where an app would retry, and load() reads this latch.
       */
      gamLoadRequested.current = false;
      observerRef.current?.onAdLoadFailed?.(
        'gam',
        `GAM did not answer within ${ATTEMPT_TIMEOUT_MS}ms; its ad object cannot load again this session`,
      );
      /*
       * Clearing the latch keeps the slot alive — the next load() goes to
       * CloudX as usual — but it does not revive the GAM leg. The plugin's
       * load() early-returns while its internal _isLoadCalled is set, and only
       * a CLOSED or ERROR clears that, so this object cannot load again and
       * every later fallback attempt on it is a no-op. Recovering that needs
       * the ad object replaced, which means a new instance per timeout, and
       * MobileAd exposes no dispose to release the one being dropped. A
       * publisher who needs the fallback to survive a silent request should
       * recreate it; this demo keeps CloudX serving instead.
       */
    }, ATTEMPT_TIMEOUT_MS);
    gamInterstitial.load();
  }, [clearGamLoadTimer, cloudXError, gamInterstitial, loadCloudX]);

  /*
   * CloudX fill signal. useCloudXInterstitial reports isLoaded as state, not as
   * an event, so this edge-detects the false -> true transition and emits once.
   * The ref is what makes it once: without it every re-render while an ad is
   * held would emit again. It re-arms on the way down, so the settle-path
   * reload after a close reports its fill too.
   */
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

    if (
      cloudXLoadRequested.current ||
      current.isCloudXLoading ||
      current.isCloudXLoaded ||
      current.isGamLoaded ||
      gamLoadRequested.current
    ) {
      return;
    }

    cloudXLoadRequested.current = true;
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
      /*
       * No onAdShown here. showCloudX() returns void, so returning from it says
       * the show was requested, not that anything appeared — and a CloudX
       * display failure surfaces asynchronously as cloudXError, which would
       * leave an impression already counted for an ad that never showed.
       * onAdShown('cloudx') is emitted from the SDK's displayed event instead.
       */
      presentingRef.current = true;
      showCloudX();
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
       * made, not that an ad appeared — onAdShown is emitted from the OPENED
       * event instead.
       *
       * Resetting presentingRef is not optional: the rejection emits no plugin
       * event, so nothing else clears the latch and show() would report
       * not-shown for the rest of the session.
       *
       * Reported as onAdShowFailed, matching the Unity controller, which routes
       * the same condition (OnAdFullScreenContentFailed) there. Saying nothing
       * is worse than the alternative: show() has already returned true, so an
       * app waiting for the close before resuming its flow would wait forever.
       *
       * One difference from Unity worth knowing. Unity destroys the ad first,
       * so the app's reload is meaningful; here the rejection emits no event,
       * isGamLoaded is never cleared, and MobileAd exposes no dispose — so the
       * fill stays held. A reload from this callback therefore early-returns in
       * load(), and isReady stays true so the next show() presents the ad that
       * is still in hand. That is the better outcome anyway, since the failure
       * is environmental. It does leave the app's backoff counter one step
       * further along than the facts warrant.
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
