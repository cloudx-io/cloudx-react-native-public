/**
 * CloudX First Look demo — React Native.
 *
 * Reference implementation of https://docs.cloudx.io/en/react-native/integrations/first-look
 *
 * One banner and one interstitial, each giving CloudX the first chance to fill
 * and falling back to Google Ad Manager when CloudX does not. The interesting
 * code is in `src/firstlook/`; this screen is only a host for it.
 *
 * Read in this order:
 *   1. src/config/adUnits.ts            — placements + the required dashboard setup
 *   2. src/firstlook/useFirstLookBanner.ts   — the refresh cycle
 *   3. src/firstlook/FirstLookBannerSlot.tsx — how the cycle is rendered
 *   4. src/firstlook/useFirstLookInterstitial.ts — the simpler fullscreen case
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import CloudX from 'cloudx-react-native';
import mobileAds from 'react-native-google-mobile-ads';
import { FirstLookBannerSlot } from './src/firstlook/FirstLookBannerSlot';
import type { FirstLookSource } from './src/firstlook/FirstLookSource';
import { useFirstLookInterstitial } from './src/firstlook/useFirstLookInterstitial';
import { AD_UNITS, MAX_BACKOFF_SECONDS } from './src/config/adUnits';

export default function App() {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('initializing…');

  // Both SDKs must be initialized before any ad view mounts. A CloudX ad view
  // mounted before initialize() completes waits silently rather than reporting
  // a failure, which would stall the First Look cycle until its attempt timeout.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await mobileAds().initialize();
        const result = await CloudX.initialize(AD_UNITS.cloudXAppKey);
        if (cancelled) return;
        setReady(Boolean(result?.success));
        setStatus(
          result?.success
            ? 'ready'
            : `CloudX init failed: ${result?.message ?? 'unknown'}`,
        );
      } catch (err) {
        if (cancelled) return;
        setStatus(`init error: ${String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>CloudX First Look</Text>
        <Text style={styles.status}>{status}</Text>

        <Section title="Interstitial">
          {ready ? <InterstitialDemo /> : null}
        </Section>

        <Section title="Banner">
          {/*
            The slot owns its own refresh cycle. Mount it and leave it alone —
            no load call, no timer, no refresh handling in the host screen.
            The observer is optional and reports only; the cycle runs without it.
          */}
          {ready ? <BannerDemo /> : null}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function BannerDemo() {
  const [status, setStatus] = useState('idle');

  /*
   * Same line-plus-log split as the interstitial: the line shows the current
   * state, the log keeps the sequence. A banner cycles on its own, so the line
   * alone would only ever show the most recent fill.
   */
  const report = useCallback((text: string) => {
    setStatus(text);
    console.log(`[FirstLook] banner: ${text}`);
  }, []);

  const observer = useMemo(
    () => ({
      onAdLoaded: (source: FirstLookSource) => report(`Loaded (${source})`),
      onAdClicked: (source: FirstLookSource) => report(`Clicked (${source})`),
      /*
       * Both sources missed. Not raised for the CloudX miss on its own — that
       * one starts the GAM attempt rather than ending the cycle. The hook
       * handles its own backoff, so there is nothing to do here but report.
       */
      onAdLoadFailed: (source: FirstLookSource, error: string) =>
        report(`Load failed (${source}): ${error}`),
    }),
    [report],
  );

  return (
    <View>
      <Text style={styles.status}>{status}</Text>
      <FirstLookBannerSlot observer={observer} />
    </View>
  );
}

function InterstitialDemo() {
  /*
   * A failed opportunity is retried with a widening delay, never immediately.
   * Both sources missing tends to mean no demand right now, and reloading on
   * every failure would turn that into a request loop against both networks.
   * A close is different — an ad was shown — so that reloads straight away.
   */
  const retryAttempt = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef<() => void>(() => {});

  /*
   * Every observer callback is rendered here, which is what makes the source
   * visible: if this only ever reads `(gam)`, CloudX is not filling and the app
   * key, the ad unit ids or the dashboard config is wrong — not this hook.
   */
  const [adStatus, setAdStatus] = useState('idle');

  /*
   * Status line and log, together. The line shows the current state; the log
   * keeps the sequence, which the line cannot — a close is followed instantly
   * by the reload's fill, so "Closed" would never be readable on screen.
   */
  const report = useCallback((text: string) => {
    setAdStatus(text);
    console.log(`[FirstLook] interstitial: ${text}`);
  }, []);

  const scheduleRetry = useCallback(() => {
    const delaySeconds = Math.min(
      2 ** retryAttempt.current,
      MAX_BACKOFF_SECONDS,
    );
    retryAttempt.current += 1;
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
    }
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      loadRef.current();
    }, delaySeconds * 1000);
  }, []);

  const { isReady, load, show } = useFirstLookInterstitial(
    AD_UNITS.cloudXInterstitialAdUnitId,
    AD_UNITS.gamInterstitialAdUnitId,
    {
      onAdLoaded: source => report(`Loaded (${source})`),
      onAdShown: source => report(`Showing (${source})`),
      onAdClicked: source => report(`Clicked (${source})`),
      /*
       * Prepare the next opportunity once the current one is over. Showing
       * consumes the ad, so without this the slot is dead after the first
       * impression — isReady never returns true again.
       */
      onAdClosed: source => {
        report(`Closed (${source})`);
        load();
      },
      /*
       * Both sources missed, or the GAM request went silent. Neither produces a
       * close, so without this the slot would stay empty.
       */
      onAdLoadFailed: (source, error) => {
        report(`Load failed (${source}): ${error}`);
        scheduleRetry();
      },
      /*
       * A presentation that failed ends the opportunity with no ad shown and no
       * close to follow, so it needs the same backed-off retry. On the GAM
       * show-promise rejection the fill is actually still held, so this retry
       * early-returns in load() and the next tap shows the held ad — see the
       * note on that rejection in the hook.
       */
      onAdShowFailed: (source, error) => {
        report(`Show failed (${source}): ${error}`);
        scheduleRetry();
      },
    },
  );

  // Assigned in an effect, not during render: a render that is discarded
  // (StrictMode, or a concurrent render that never commits) must not write it.
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  // A fill means demand is back; the next failure starts the backoff over.
  useEffect(() => {
    if (isReady) {
      retryAttempt.current = 0;
    }
  }, [isReady]);

  // Prepare the placement when the screen is ready.
  useEffect(() => {
    load();
  }, [load]);

  // Do not let a pending retry fire into a torn-down screen.
  useEffect(
    () => () => {
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
      }
    },
    [],
  );

  return (
    <View>
      <Text style={styles.status}>{adStatus}</Text>
      <Button
        title={isReady ? 'Show interstitial' : 'Loading…'}
        // Deliberately NOT disabled while loading. show() already reports
        // whether anything was ready, so a tap during a load is a harmless
        // no-op that also re-arms the load — whereas disabling the button
        // turns any missed reload into a dead end with no way out.
        onPress={() => {
          // show() reports whether an already-loaded ad was shown. If it
          // returns false, neither source was ready — continue the app flow
          // without an ad rather than blocking on one.
          if (!show()) {
            load();
          }
        }}
      />
    </View>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24, gap: 28 },
  title: { fontSize: 24, fontWeight: '600' },
  status: { fontSize: 13, color: '#666' },
  section: { gap: 12 },
  sectionTitle: { fontSize: 16, fontWeight: '500' },
});
