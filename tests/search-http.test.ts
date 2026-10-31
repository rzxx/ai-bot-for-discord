import { expect, test } from 'bun:test';
import { createPageReader, publicAddress } from '../src/search-http';

test('page addresses reject private, reserved, mapped and transition ranges', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '64:ff9b::a00:1', '2002:7f00:1::', 'not-an-ip']) expect(publicAddress(ip)).toBe(false);
  expect(publicAddress('1.1.1.1')).toBe(true); expect(publicAddress('2606:4700:4700::1111')).toBe(true);
});

test('a reader pins the validated address and revalidates redirects without requesting private hosts', async () => {
  const requests: string[] = [], resolved: string[] = [];
  const reader = createPageReader({
    resolve: async host => { resolved.push(host); return [{ address: host === 'private.org' ? '10.0.0.1' : '1.1.1.1', family: 4 }]; },
    request: async (url, address) => { requests.push(url.host + '@' + address.address); return { status: 302, type: 'text/html', location: 'https://private.org/secret', text: '' }; },
  });
  await expect(reader('https://public.org/', new AbortController().signal)).rejects.toThrow('Non-public address');
  expect(resolved).toEqual(['public.org', 'private.org']); expect(requests).toEqual(['public.org@1.1.1.1']);
});

test('mixed DNS answers, non-HTTPS redirects, binaries, excess redirects and canceled reads cannot pass', async () => {
  let calls = 0;
  const mixed = createPageReader({ resolve: async () => [{ address: '1.1.1.1', family: 4 }, { address: '::1', family: 6 }], request: async () => { calls++; throw new Error(); } });
  await expect(mixed('https://public.org/', new AbortController().signal)).rejects.toThrow(); expect(calls).toBe(0);
  for (const response of [{ status: 302, location: 'http://public.org/', type: 'text/html', text: '' },
    { status: 302, location: '/again', type: 'text/html', text: '' }, { status: 200, type: 'application/pdf', text: 'pdf' },
    { status: 200, type: 'text/html', text: 'x'.repeat(800001) }]) {
    const reader = createPageReader({ resolve: async () => [{ address: '1.1.1.1', family: 4 }], request: async () => response });
    await expect(reader('https://public.org/', new AbortController().signal)).rejects.toThrow();
  }
  const aborted = new AbortController(); aborted.abort();
  await expect(mixed('https://public.org/', aborted.signal)).rejects.toThrow(); expect(calls).toBe(0);
});
