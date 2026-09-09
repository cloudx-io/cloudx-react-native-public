/*
 * Timing for the First Look cycle. Shared by both hooks.
 *
 * Reference implementation of the pattern documented at
 * https://docs.cloudx.io/en/react-native/integrations/first-look
 * These are the four numbers worth tuning; everything else about the cycle is
 * structural.
 */

/**
 * Wait after an ad is swapped in before starting the next cycle. Match it to
 * your existing GAM banner cadence. 30s is Google's floor for banner refresh,
 * and the effective interval is this plus the next ad's load time.
 */
export const REFRESH_DELAY_MS = 30_000;

/** Exponential backoff ceiling when BOTH CloudX and GAM miss, in seconds. */
export const MAX_BACKOFF_SECONDS = 64;

/**
 * How long one attempt may stay silent before it counts as failed. An ad view
 * mounted before `CloudX.initialize()` completes waits silently instead of
 * failing, and the cycle would never restart.
 */
export const ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * How long the SDK needs after an interstitial closes before it accepts a load
 * for that placement again. The hidden event fires first, so a load straight
 * from `onClosed` is rejected with "Cannot load while another ad is currently
 * being displayed" — which looks exactly like a no-fill, handing GAM an
 * opportunity CloudX never got. Measured on an Android emulator; treat it as a
 * floor.
 */
export const CLOSE_SETTLE_MS = 500;
