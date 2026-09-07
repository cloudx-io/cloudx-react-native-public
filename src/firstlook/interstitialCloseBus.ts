/**
 * Fan-out for the CloudX interstitial "hidden" event.
 *
 * WHY THIS EXISTS
 * ---------------
 * `CloudXInterstitialAd.addAdHiddenEventListener` is SINGLETON per event. The
 * SDK's `addEventListener` removes any existing subscription before installing
 * the new one, so the last caller silently wins and every earlier subscriber
 * goes deaf with no error:
 *
 *   const current = subscriptions[event];
 *   if (current) { current.remove(); }
 *   subscriptions[event] = subscription;
 *
 * If each `useFirstLookInterstitial` instance subscribed directly, two mounted
 * instances would clobber each other — and `removeAdHiddenEventListener` is no
 * help on unmount, because it removes the *global* subscription rather than
 * just that instance's, so cleaning up would deafen whoever is still listening.
 *
 * That is not hypothetical. Two screens mounting the hook at the same time is
 * enough: the ad closes, and no close event reaches the listener that was
 * waiting for it — a silent failure that looks like the SDK not emitting at
 * all.
 *
 * So: this module owns the one subscription for the process and fans out to
 * however many listeners are registered. Register/unregister is safe and
 * order-independent.
 *
 * A publisher with a single interstitial does not need any of this — subscribe
 * directly. It matters as soon as anything else in the app also wants the event.
 *
 * KNOWN LIMITATION
 * ----------------
 * This module can itself be deafened. It subscribes through the same singleton
 * `addAdHiddenEventListener`, so any other call to that method anywhere in the
 * app replaces this subscription, and `installed` stays true so it is never
 * reinstalled — every listener goes quiet with no error. Subscribing to the
 * shared NativeEventEmitter directly would be immune, but cloudx-react-native
 * 3.4.7 does not export it (`cloudXEventEmitter` was added later). Until this
 * app moves to a version that exports it, treat this module as the single
 * owner of the interstitial hidden event and do not call
 * `addAdHiddenEventListener` anywhere else.
 */

import { CloudXInterstitialAd } from 'cloudx-react-native';

type CloseListener = () => void;

/*
 * Keyed by ad unit id. The SDK delivers the closed ad's id on the event, and an
 * app with more than one interstitial placement must not treat a close on unit
 * A as a close on unit B — the hook watching B would reload an opportunity that
 * never happened.
 */
const listeners = new Map<string, Set<CloseListener>>();
let installed = false;

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  CloudXInterstitialAd.addAdHiddenEventListener(adInfo => {
    const forAdUnit = listeners.get(adInfo?.adUnitId ?? '');
    if (!forAdUnit) {
      return;
    }
    // Copy before iterating: a listener may unregister itself in response.
    for (const listener of [...forAdUnit]) {
      listener();
    }
  });
}

/**
 * Registers a close listener for one ad unit. Returns an unsubscribe function.
 */
export function onInterstitialClosed(
  adUnitId: string,
  listener: CloseListener,
): () => void {
  ensureInstalled();
  const forAdUnit = listeners.get(adUnitId) ?? new Set<CloseListener>();
  forAdUnit.add(listener);
  listeners.set(adUnitId, forAdUnit);
  return () => {
    forAdUnit.delete(listener);
    if (forAdUnit.size === 0) {
      listeners.delete(adUnitId);
    }
  };
}
