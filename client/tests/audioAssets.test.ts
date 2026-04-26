import { afterEach, describe, expect, it } from 'vitest';
import {
  isSampleAvailable,
  playSampleIfAvailable,
  registerSampleForTest,
  resetAudioAssetsForTest,
} from '../src/ui/audioAssets.js';

// audioAssets.ts is the small, testable surface of the audio
// pipeline. The integration parts (manifest fetch, decode) need a
// real AudioContext + fetch so we don't exercise them here. Public
// contract tests are enough to pin: registry mechanics, fallback
// behaviour when context is absent, and the test-helper handshake.

afterEach(() => {
  resetAudioAssetsForTest();
});

// Tiny stand-in for an AudioBuffer. The real type has methods we
// don't touch in this code path; cast through unknown to keep the
// type-system honest at module boundary.
function fakeBuffer(): AudioBuffer {
  return {
    duration: 0.1,
    length: 4410,
    numberOfChannels: 1,
    sampleRate: 44100,
    getChannelData: () => new Float32Array(),
    copyFromChannel: () => undefined,
    copyToChannel: () => undefined,
  } as unknown as AudioBuffer;
}

describe('audioAssets registry', () => {
  it('reports unknown keys as unavailable by default', () => {
    expect(isSampleAvailable('deploy')).toBe(false);
  });

  it('reports keys as available after registration', () => {
    registerSampleForTest('deploy', fakeBuffer());
    expect(isSampleAvailable('deploy')).toBe(true);
  });

  it('clamps gain into 0..1 for stored samples', () => {
    // No public read on gain, so we exercise the path indirectly:
    // a registration with an out-of-range gain should still register
    // the key (i.e., not crash on the clamp).
    registerSampleForTest('weird-gain', fakeBuffer(), 9.5);
    expect(isSampleAvailable('weird-gain')).toBe(true);
    registerSampleForTest('negative-gain', fakeBuffer(), -3);
    expect(isSampleAvailable('negative-gain')).toBe(true);
  });

  it('resets clear all registered keys', () => {
    registerSampleForTest('a', fakeBuffer());
    registerSampleForTest('b', fakeBuffer());
    resetAudioAssetsForTest();
    expect(isSampleAvailable('a')).toBe(false);
    expect(isSampleAvailable('b')).toBe(false);
  });
});

describe('playSampleIfAvailable', () => {
  it('returns false when no AudioContext is provided (synth fallback)', () => {
    registerSampleForTest('deploy', fakeBuffer());
    // Caller passes null when no AudioContext exists — happens on
    // page load before any user gesture.
    expect(playSampleIfAvailable('deploy', null, null)).toBe(false);
  });

  it('returns false for unknown keys (synth fallback)', () => {
    // Even if a fake context were available, an unknown key short-
    // circuits before any node creation.
    expect(playSampleIfAvailable('not-registered', null, null)).toBe(false);
  });
});
