/**
 * First Look banner/MREC refresh cycle.
 *
 * Reference implementation of the pattern documented at
 * https://docs.cloudx.io/en/react-native/integrations/first-look
 *
 * The cycle logic below is kept identical to the documented hook so the two
 * cannot drift. The only additions are the optional `observer` callbacks, which
 * exist so a host can observe the cycle — see the note above the type.
 *
 * ---------------------------------------------------------------------------
 * WHY THE APP OWNS REFRESH
 * ---------------------------------------------------------------------------
 * Banners are normally refreshed by each SDK's own internal timer. With two
 * SDKs sharing one slot, two timers race: CloudX swaps in a new ad while GAM is
 * mid-load, impressions double-count, and neither SDK knows the other exists.
 *
 * So refresh is made explicit and the app owns the cycle:
 *   - CloudX auto-refresh off → dashboard ad unit refresh rate = 0
 *   - GAM auto-refresh off    → Google Ad Manager UI (or a non-refreshing unit)
 *
 * ---------------------------------------------------------------------------
 * THE CYCLE
 * ---------------------------------------------------------------------------
 *   1. Load a CloudX banner off-screen while the previous ad stays visible.
 *   2. On fill, swap it in — the previous ad unmounts, destroying its native view.
 *   3. On CloudX no-fill, load the GAM banner for this cycle instead.
 *   4. If both miss, retry from CloudX with an exponential delay (1,2,4,8...s).
 *   5. Once the ad is swapped in, wait REFRESH_DELAY_MS, then start again at
 *      CloudX. A new attempt only starts while the app is foregrounded; a load
 *      already in flight finishes normally.
 *
 * Step 5 is what makes this "first look on EVERY opportunity" rather than
 * "first look until CloudX misses once." A simpler one-way fallback — swap to
 * GAM on the first miss and let GAM own the slot until the screen is recreated
 * — is easier to build but permanently surrenders the placement after a single
 * no-fill. This hook always returns to CloudX.
 *
 * ---------------------------------------------------------------------------
 * WHY LOADING HAPPENS OFF-SCREEN
 * ---------------------------------------------------------------------------
 * The next ad loads in the background while the current one is still visible,
 * so there is a fill ready the instant the refresh moment arrives — no empty
 * slot, and CloudX's optimistic loading has time to work. Mounting the view is
 * what triggers the load for both `CloudXBannerView` and GAM's `GAMBannerAd`,
 * so "load off-screen" means "mount hidden."
 *
 * ---------------------------------------------------------------------------
 * WHAT STARTS THE NEXT CYCLE
 * ---------------------------------------------------------------------------
 * The fill does. Promotion happens in the same handler, so the ad is on screen
 * by the time the REFRESH_DELAY_MS clock starts.
 *
 * This deliberately does NOT wait for an impression. Neither view reports one:
 * `CloudXBannerView` exposes load, load-failed, click and revenue-paid, and
 * GAM's banner has no impression event before plugin v15.7.0. The revenue
 * callback is the only available proxy and it is a poor one, for two reasons.
 * It is slow — `onPaid` has been measured firing 71s after the load, on a
 * banner that was visible the whole time, which turns a 30s cadence into ~100s.
 * And it is optional: an Ad Manager unit without impression-level revenue
 * reporting never emits it at all, which would strand the slot on one ad
 * forever.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FOREGROUND GATE
 * ---------------------------------------------------------------------------
 * Cycling on the fill removes the only thing that tied a refresh to the ad
 * having been displayed, so the gate puts a coarse version of that back: an
 * attempt never starts while the app is backgrounded, and a cycle deferred that
 * way resumes when the app returns. Without it a backgrounded app would keep
 * running auctions for ads nobody can see.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';
import {
  ATTEMPT_TIMEOUT_MS,
  MAX_BACKOFF_SECONDS,
  REFRESH_DELAY_MS,
} from '../config/adUnits';

export type FirstLookSource = 'cloudx' | 'gam';

export type FirstLookAttempt = {
  source: FirstLookSource;
  /** Changes on every attempt so React remounts the ad view, triggering a new load. */
  key: number;
};

/**
 * Optional instrumentation.
 *
 * Not part of the documented pattern. Pass an observer to log or assert that
 * the fallback, the backoff, and the return-to-CloudX actually happen; most
 * callers pass nothing. Kept out of the cycle logic below so the hook stays
 * copy-pasteable as written.
 */
export type FirstLookBannerObserver = {
  onAttemptStart?: (source: FirstLookSource, key: number) => void;
  onFill?: (source: FirstLookSource) => void;
  onNoFill?: (source: FirstLookSource) => void;
  /** Both sources missed; retrying CloudX after `delaySeconds`. */
  onBackoff?: (attempt: number, delaySeconds: number) => void;
  /** An attempt went silent past ATTEMPT_TIMEOUT_MS and was treated as failed. */
  onAttemptTimeout?: (source: FirstLookSource) => void;
  /** A cycle came due while the app was backgrounded and is waiting to resume. */
  onCycleDeferred?: () => void;
};

export function useFirstLookBanner(observer?: FirstLookBannerObserver) {
  // The ad on screen. It stays mounted until the next fill is ready.
  const [displayed, setDisplayed] = useState<FirstLookAttempt | null>(null);
  // The ad loading off-screen. Null while waiting out a delay.
  const [loading, setLoading] = useState<FirstLookAttempt | null>(null);
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  // Held in a ref so the callbacks never need it in their dep arrays — an
  // observer identity change must not tear down a running cycle.
  const observerRef = useRef(observer);
  observerRef.current = observer;

  const nextKey = useRef(0);
  const consecutiveNoFills = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Lets startAttempt arm the timeout before onAdLoadFailed is defined.
  const failAttemptRef = useRef<(key: number) => void>(() => {});
  // Distinguishes "this attempt failed" from "this attempt never called back",
  // which an observer needs to tell a real no-fill from a silent source.
  const timedOut = useRef(false);
  // A cycle came due while the app was backgrounded. The AppState effect below
  // starts it when the app returns.
  const pendingCycle = useRef(false);

  // Every attempt carries a timeout: an attempt that emits neither loaded nor
  // failed (for example a view mounted before CloudX.initialize() completes)
  // counts as a failure, so the slot cannot hang on a silent source.
  const startAttempt = useCallback((source: FirstLookSource) => {
    // The gate lives here rather than at the call sites: every way a cycle can
    // start — the post-fill timer, the GAM fallback, the backoff retry — may
    // come due with the app away. Only 'background' and 'inactive' count as
    // away. 'unknown' is what React Native reports before it has resolved the
    // state, and it can leave that state without emitting a 'change', which
    // would strand a deferred cycle here with no timeout to rescue it. A
    // deferred cycle resumes at CloudX: a gap in visibility ends the current
    // opportunity, so the next one starts fresh.
    const appState = AppState.currentState;
    if (appState === 'background' || appState === 'inactive') {
      pendingCycle.current = true;
      // Cancel the attempt outright: the hidden view, and the timeout that
      // would have policed it.
      if (attemptTimer.current) {
        clearTimeout(attemptTimer.current);
        attemptTimer.current = null;
      }
      setLoading(null);
      observerRef.current?.onCycleDeferred?.();
      return;
    }
    if (attemptTimer.current) {
      clearTimeout(attemptTimer.current);
    }
    const key = nextKey.current++;
    attemptTimer.current = setTimeout(() => {
      timedOut.current = true;
      observerRef.current?.onAttemptTimeout?.(source);
      failAttemptRef.current(key);
    }, ATTEMPT_TIMEOUT_MS);
    observerRef.current?.onAttemptStart?.(source, key);
    setLoading({ source, key });
  }, []);

  // The first attempt goes through startAttempt too, so it carries the same
  // timeout as every later one. Seeding `loading` directly into useState would
  // skip the timeout on attempt zero — which is the mount most likely to race
  // CloudX.initialize(), the exact case the timeout exists for.
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

  // Clear both timers on unmount so a backgrounded screen cannot fire a refresh
  // into a torn-down slot.
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

  // The off-screen ad filled: swap it in. Replacing `displayed` unmounts the
  // previous ad view, which destroys its native ad.
  const onAdLoaded = useCallback((key: number) => {
    const filled = loadingRef.current;
    /*
     * Ignore anything that is not the attempt currently loading off-screen.
     * The displayed ad shares these handlers, and it can emit a load of its
     * own — an SDK or Ad Manager refresh that was left enabled fires
     * onAdLoaded on a view that is already on screen. Without this check that
     * event would promote the hidden attempt before it had filled, blanking
     * the slot for a whole cycle.
     */
    if (!filled || filled.key !== key) {
      return;
    }
    if (attemptTimer.current) {
      clearTimeout(attemptTimer.current);
    }
    timedOut.current = false;
    consecutiveNoFills.current = 0;
    observerRef.current?.onFill?.(filled.source);
    setDisplayed(filled);
    // Nothing else is in flight until the refresh delay elapses.
    setLoading(null);
    // The ad is on screen as of this render, so start the clock for the next
    // cycle now. Whoever just served, the next one begins at CloudX.
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => startAttempt('cloudx'), REFRESH_DELAY_MS);
  }, [startAttempt]);

  // CloudX no-fill falls back to GAM for this cycle. A GAM no-fill means both
  // sources missed, so retry from CloudX with an exponential delay.
  const onAdLoadFailed = useCallback((key: number) => {
    const failed = loadingRef.current;
    // Same guard as onAdLoaded: a refresh failure on the displayed ad must not
    // abort the CloudX attempt that is in flight behind it.
    if (!failed || failed.key !== key) {
      return;
    }
    if (attemptTimer.current) {
      clearTimeout(attemptTimer.current);
    }
    if (!timedOut.current) {
      observerRef.current?.onNoFill?.(failed.source);
    }
    timedOut.current = false;

    if (failed.source === 'cloudx') {
      startAttempt('gam');
      return;
    }

    const delaySeconds = Math.min(
      2 ** consecutiveNoFills.current,
      MAX_BACKOFF_SECONDS,
    );
    consecutiveNoFills.current += 1;
    observerRef.current?.onBackoff?.(consecutiveNoFills.current, delaySeconds);
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

  return { displayed, loading, onAdLoaded, onAdLoadFailed };
}
