/**
 * CloudX First Look demo — React Native.
 *
 * Reference implementation of https://docs.cloudx.io/en/react-native/integrations/first-look
 *
 * One banner and one interstitial, each giving CloudX the first chance to fill
 * and falling back to Google Ad Manager when it does not. The pattern lives in
 * `src/firstlook/`; this screen only hosts it.
 *
 * Read in this order:
 *   1. src/config/adUnits.ts                     — placements + dashboard setup
 *   2. src/firstlook/useFirstLookBanner.ts       — the refresh cycle
 *   3. src/firstlook/FirstLookBannerSlot.tsx     — how it is rendered
 *   4. src/firstlook/useFirstLookInterstitial.ts — the fullscreen case
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
import { AD_UNITS } from './src/config/adUnits';
import { MAX_BACKOFF_SECONDS } from './src/firstlook/firstLookTiming';

export default function App() {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('initializing…');

  // Both SDKs must be initialized before any ad view mounts: one mounted
  // earlier waits silently instead of reporting a failure.
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
            The slot owns its refresh cycle. Mount it and leave it alone: no
            load call, no timer, no refresh handling here.
          */}
          {ready ? <BannerDemo /> : null}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function BannerDemo() {
  const [status, setStatus] = useState('idle');

  // The line shows the current state, the log keeps the sequence.
  const report = useCallback((text: string) => {
    setStatus(text);
    console.log(`[FirstLook] banner: ${text}`);
  }, []);

  const observer = useMemo(
    () => ({
      onAdLoaded: (source: FirstLookSource) => report(`Loaded (${source})`),
      onAdClicked: (source: FirstLookSource) => report(`Clicked (${source})`),
      // Both missed. The hook backs off on its own, so this only reports.
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
   * A failed opportunity is retried with a widening delay: both sources missing
   * means no demand right now, and reloading on every failure would be a
   * request loop. A close is different — an ad was shown — so it reloads at
   * once.
   */
  const retryAttempt = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef<() => void>(() => {});

  /*
   * Every callback is rendered, which is what makes the source visible: if this
   * only ever reads `(gam)`, CloudX is not filling and the app key, the ad unit
   * ids or the dashboard config is wrong — not this hook.
   */
  const [adStatus, setAdStatus] = useState('idle');

  // The line shows the current state, the log keeps the sequence: a close is
  // followed instantly by the reload's fill.
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
      // Showing consumes the ad, so without this reload the slot is dead after
      // the first impression.
      onAdClosed: source => {
        report(`Closed (${source})`);
        load();
      },
      // No close follows a miss, so nothing else would refill the slot.
      onAdLoadFailed: (source, error) => {
        report(`Load failed (${source}): ${error}`);
        scheduleRetry();
      },
      // Same: no ad shown, no close to follow. On a GAM show rejection the fill
      // is still held, so this retry no-ops and the next tap shows it.
      onAdShowFailed: (source, error) => {
        report(`Show failed (${source}): ${error}`);
        scheduleRetry();
      },
    },
  );

  // In an effect, not during render: a render that never commits must not
  // write it.
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
        // Deliberately not disabled while loading: a tap is a harmless no-op
        // that re-arms the load, while disabling it makes a missed reload a
        // dead end.
        onPress={() => {
          // False means neither source was ready: continue the app flow
          // without an ad rather than block on one.
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
