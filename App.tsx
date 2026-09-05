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

import React, { useEffect, useState } from 'react';
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
import { useFirstLookInterstitial } from './src/firstlook/useFirstLookInterstitial';
import { AD_UNITS } from './src/config/adUnits';

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
          */}
          {ready ? <FirstLookBannerSlot /> : null}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function InterstitialDemo() {
  const { isReady, load, show } = useFirstLookInterstitial(
    AD_UNITS.cloudXInterstitialAdUnitId,
    AD_UNITS.gamInterstitialAdUnitId,
    {
      // Prepare the next opportunity once the current one is over. Showing
      // consumes the ad, so without this the slot is dead after the first
      // impression — isReady never returns true again.
      onClosed: () => load(),
    },
  );

  // Prepare the placement when the screen is ready.
  useEffect(() => {
    load();
  }, [load]);

  return (
    <View>
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
