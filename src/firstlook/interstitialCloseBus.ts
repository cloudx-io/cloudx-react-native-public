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
 */

import { CloudXInterstitialAd } from 'cloudx-react-native';

type CloseListener = () => void;

const listeners = new Set<CloseListener>();
let installed = false;

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  CloudXInterstitialAd.addAdHiddenEventListener(() => {
    // Copy before iterating: a listener may unregister itself in response.
    for (const listener of [...listeners]) {
      listener();
    }
  });
}

/** Registers a close listener. Returns an unsubscribe function. */
export function onInterstitialClosed(listener: CloseListener): () => void {
  ensureInstalled();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
