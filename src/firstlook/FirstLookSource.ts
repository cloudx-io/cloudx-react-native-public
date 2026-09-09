/*
 * Which SDK served an ad. Shared by both hooks so one handler can take events
 * from either format. `gam` because the fallback here is Google Ad Manager;
 * rename it if you fall back to plain AdMob.
 */
export type FirstLookSource = 'cloudx' | 'gam';
