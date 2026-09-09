/**
 * First Look banner/MREC refresh cycle.
 *
 * Reference implementation of the pattern documented at
 * https://docs.cloudx.io/en/react-native/integrations/first-look
 * The only addition is the optional `observer`, which reports what the cycle is
 * doing.
 *
 * THE CYCLE
 *   1. Load a CloudX banner off-screen while the previous ad stays visible.
 *      Mounting the view is what starts the load, so "off-screen" means
 *      "mounted hidden" — there is a fill ready when the refresh moment comes.
 *   2. On fill, swap it in; the previous ad unmounts and its native view is
 *      destroyed.
 *   3. On CloudX no-fill, load GAM for this cycle only.
 *   4. If both miss, back off (1,2,4,8...s) and retry from CloudX.
 *   5. REFRESH_DELAY_MS after the swap, start again at CloudX.
 *
 * Step 5 is what makes this first look on EVERY opportunity. A one-way fallback
 * that lets GAM keep the slot after one miss is easier to build and permanently
 * surrenders the placement.
 *
 * Both SDKs' own refresh must be off — CloudX dashboard rate 0, GAM disabled in
 * the Ad Manager UI — or two timers race over one slot.
 *
 * The cycle restarts on the fill, not on an impression, because neither view
 * reports one. The revenue callback is the only proxy and it is a bad one: it
 * has been measured firing 71s after the load, and an Ad Manager unit without
 * impression-level revenue reporting never emits it at all, which would strand
 * the slot on one ad forever.
 *
 * An attempt never starts while the app is backgrounded; a cycle that comes due
 * then runs when the app returns.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';
import {
  ATTEMPT_TIMEOUT_MS,
  MAX_BACKOFF_SECONDS,
  REFRESH_DELAY_MS,
} from '../config/adUnits';
import type { FirstLookSource } from './FirstLookSource';

/* Re-exported so a caller importing this hook does not need a second import. */
export type { FirstLookSource };

export type FirstLookAttempt = {
  source: FirstLookSource;
  /** Changes on every attempt so React remounts the ad view, triggering a new load. */
  key: number;
};

/**
 * Optional. Reports what the cycle is doing; every callback carries the source
 * that served the ad. The cycle runs whether or not you pass one.
 */
export type FirstLookBannerObserver = {
  /** A fill, which is also the swap: it goes on screen in the same handler. */
  onAdLoaded?: (source: FirstLookSource) => void;
  /**
   * Both sources missed and the opportunity is over. Not raised for the CloudX
   * miss alone — that one starts the GAM attempt, so the cycle is still
   * running. Only `'gam'` is emitted today.
   */
  onAdLoadFailed?: (source: FirstLookSource, error: string) => void;
  /**
   * The user tapped the ad. Reporting only.
   *
   * CloudX banners only: react-native-google-mobile-ads wires no banner click
   * event on either platform, so a GAM banner click cannot be reported. The
   * interstitial is unaffected and reports both sources.
   * https://github.com/invertase/react-native-google-mobile-ads
   */
  onAdClicked?: (source: FirstLookSource) => void;
};

export function useFirstLookBanner(observer?: FirstLookBannerObserver) {
  // The ad on screen. It stays mounted until the next fill is ready.
  const [displayed, setDisplayed] = useState<FirstLookAttempt | null>(null);
  // The ad loading off-screen. Null while waiting out a delay.
  const [loading, setLoading] = useState<FirstLookAttempt | null>(null);
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const displayedRef = useRef(displayed);
  displayedRef.current = displayed;

  // In a ref so a new observer identity never tears down a running cycle.
  const observerRef = useRef(observer);
  observerRef.current = observer;

  const nextKey = useRef(0);
  const consecutiveNoFills = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Lets startAttempt arm the timeout before onAdLoadFailed is defined.
  const failAttemptRef = useRef<(key: number, message: string) => void>(
    () => {},
  );
  // Tells a real no-fill from a source that never called back.
  const timedOut = useRef(false);
  // A cycle came due while the app was backgrounded.
  const pendingCycle = useRef(false);

  // Every attempt is timed: a source that answers neither way counts as failed,
  // so the slot cannot hang on it.
  const startAttempt = useCallback((source: FirstLookSource) => {
    /*
     * Gated here so every entry point — the post-fill timer, the fallback, the
     * backoff retry — is covered. 'unknown' does not count as away: React
     * Native reports it before resolving, and can leave it without a 'change'
     * event, stranding the cycle with nothing to restart it.
     */
    const appState = AppState.currentState;
    if (appState === 'background' || appState === 'inactive') {
      pendingCycle.current = true;
      // Cancel the attempt outright: the hidden view and its timeout.
      if (attemptTimer.current) {
        clearTimeout(attemptTimer.current);
        attemptTimer.current = null;
      }
      setLoading(null);
      /*
       * No callback reports this, so it looks like no demand. Worth knowing
       * because 'inactive' covers the iOS ATT prompt, Control Centre and the
       * app switcher. Watch AppState yourself if you need to see it.
       */
      return;
    }
    if (attemptTimer.current) {
      clearTimeout(attemptTimer.current);
    }
    const key = nextKey.current++;
    attemptTimer.current = setTimeout(() => {
      timedOut.current = true;
      failAttemptRef.current(key, 'no answer');
    }, ATTEMPT_TIMEOUT_MS);
    setLoading({ source, key });
  }, []);

  // Through startAttempt, so attempt zero is timed like the rest — it is the
  // one most likely to race CloudX.initialize().
  useEffect(() => {
    startAttempt('cloudx');
  }, [startAttempt]);

  // Resume a cycle that came due while the app was backgrounded.
  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (state: AppStateStatus) => {
        if (state !== 'active' || !pendingCycle.current) {
          return;
        }
        pendingCycle.current = false;
        startAttempt('cloudx');
      },
    );
    return () => subscription.remove();
  }, [startAttempt]);

  // No refresh may fire into a torn-down slot.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
      if (attemptTimer.current) {
        clearTimeout(attemptTimer.current);
      }
    },
    [],
  );

  // The off-screen ad filled: swap it in. That unmounts the previous ad view
  // and destroys its native ad.
  const onAdLoaded = useCallback((key: number) => {
    const filled = loadingRef.current;
    /*
     * Only the attempt loading off-screen. The displayed ad shares these
     * handlers and can emit its own load — an auto-refresh left enabled — which
     * would promote the hidden attempt before it filled and blank the slot.
     */
    if (!filled || filled.key !== key) {
      return;
    }
    if (attemptTimer.current) {
      clearTimeout(attemptTimer.current);
    }
    timedOut.current = false;
    consecutiveNoFills.current = 0;
    observerRef.current?.onAdLoaded?.(filled.source);
    setDisplayed(filled);
    // Nothing else is in flight until the refresh delay elapses.
    setLoading(null);
    // Whoever just served, the next cycle begins at CloudX.
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => startAttempt('cloudx'), REFRESH_DELAY_MS);
  }, [startAttempt]);

  // CloudX no-fill falls back to GAM for this cycle. A GAM no-fill means both
  // sources missed, so retry from CloudX with an exponential delay.
  const onAdLoadFailed = useCallback((key: number, message: string) => {
    const failed = loadingRef.current;
    // Same guard: a failure from the displayed ad must not abort the attempt
    // in flight behind it.
    if (!failed || failed.key !== key) {
      return;
    }
    if (attemptTimer.current) {
      clearTimeout(attemptTimer.current);
    }
    const wasSilent = timedOut.current;
    timedOut.current = false;

    // The CloudX miss is not reported: it starts the GAM attempt below.
    if (failed.source === 'cloudx') {
      startAttempt('gam');
      return;
    }

    // Both missed. A silent attempt is still a miss; it only changes the text.
    observerRef.current?.onAdLoadFailed?.(
      'gam',
      wasSilent
        ? `GAM did not answer within ${ATTEMPT_TIMEOUT_MS}ms`
        : message,
    );

    const delaySeconds = Math.min(
      2 ** consecutiveNoFills.current,
      MAX_BACKOFF_SECONDS,
    );
    consecutiveNoFills.current += 1;
    setLoading(null);
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(
      () => startAttempt('cloudx'),
      delaySeconds * 1000,
    );
  }, [startAttempt]);

  failAttemptRef.current = onAdLoadFailed;

  /*
   * Matched against `displayed`, not `loading` — the opposite of the callbacks
   * above. Only the on-screen ad can be tapped; the loading slot is rendered
   * with pointerEvents="none".
   */
  const onAdClicked = useCallback((key: number) => {
    const shown = displayedRef.current;
    if (!shown || shown.key !== key) {
      return;
    }
    observerRef.current?.onAdClicked?.(shown.source);
  }, []);

  return { displayed, loading, onAdLoaded, onAdLoadFailed, onAdClicked };
}
