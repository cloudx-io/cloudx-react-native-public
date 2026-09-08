/**
 * Fan-out for the CloudX interstitial "hidden" and "displayed" events.
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
 * owner of the interstitial hidden and displayed events, and do not call
 * `addAdHiddenEventListener` or `addAdDisplayedEventListener` anywhere else.
 */

import { CloudXInterstitialAd } from 'cloudx-react-native';

type Listener = () => void;

/*
 * Keyed by ad unit id. The SDK delivers the ad's id on the event, and an app
 * with more than one interstitial placement must not treat an event for unit A
 * as one for unit B — the hook watching B would react to something that never
 * happened to it.
 */
type Registry = {
  listeners: Map<string, Set<Listener>>;
  installed: boolean;
  install: (dispatch: (adUnitId: string) => void) => void;
};

const registries: Record<'hidden' | 'displayed', Registry> = {
  hidden: {
    listeners: new Map(),
    installed: false,
    install: dispatch =>
      CloudXInterstitialAd.addAdHiddenEventListener(adInfo =>
        dispatch(adInfo?.adUnitId ?? ''),
      ),
  },
  displayed: {
    listeners: new Map(),
    installed: false,
    install: dispatch =>
      CloudXInterstitialAd.addAdDisplayedEventListener(adInfo =>
        dispatch(adInfo?.adUnitId ?? ''),
      ),
  },
};

function subscribe(
  registry: Registry,
  adUnitId: string,
  listener: Listener,
): () => void {
  if (!registry.installed) {
    /*
     * Marked installed only after install() returns. Setting it first would
     * leave the registry permanently deaf if the native module is not ready
     * yet and the call throws — the flag would say installed while no listener
     * was ever attached.
     */
    registry.install(id => {
      const forAdUnit = registry.listeners.get(id);
      if (!forAdUnit) {
        return;
      }
      // Copy before iterating: a listener may unregister itself in response.
      for (const each of [...forAdUnit]) {
        each();
      }
    });
    registry.installed = true;
  }

  const forAdUnit =
    registry.listeners.get(adUnitId) ?? new Set<Listener>();
  forAdUnit.add(listener);
  registry.listeners.set(adUnitId, forAdUnit);
  return () => {
    forAdUnit.delete(listener);
    if (forAdUnit.size === 0) {
      registry.listeners.delete(adUnitId);
    }
  };
}

/** Registers a close listener for one ad unit. Returns an unsubscribe function. */
export function onInterstitialClosed(
  adUnitId: string,
  listener: Listener,
): () => void {
  return subscribe(registries.hidden, adUnitId, listener);
}

/**
 * Registers a displayed listener for one ad unit. This is the SDK confirming
 * the ad is on screen — the only trustworthy point to count an impression,
 * since CloudX's show API returns void and cannot report presentation.
 */
export function onInterstitialDisplayed(
  adUnitId: string,
  listener: Listener,
): () => void {
  return subscribe(registries.displayed, adUnitId, listener);
}
