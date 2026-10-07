import { describe, expect, it } from 'vitest';
import { isPublicAddress } from './ssrf.js';

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '151.101.1.69', '2606:4700::6810:84e5'])('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.0.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});
