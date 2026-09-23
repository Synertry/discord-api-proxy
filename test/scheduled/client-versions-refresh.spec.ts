/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module scheduled/client-versions-refresh.spec
 * Covers `refreshClientVersions`'s persistence step: the two version records
 * are independent DO storage writes, so a rejected write for one must not stop
 * the other from landing (nor throw the whole refresh), and a record whose
 * write failed must not be reported as refreshed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { refreshClientVersions } from '../../src/scheduled/client-versions-refresh';
import type { Bindings } from '../../src/types';

interface VersionStub {
  setBuildNumberRecord: (record: unknown) => Promise<void>;
  setChromeVersionRecord: (record: unknown) => Promise<void>;
}

function envWithStub(stub: VersionStub): Bindings {
  return {
    TOKEN_POOL: {
      idFromName: (name: string) => name,
      get: () => stub,
    },
  } as unknown as Bindings;
}

/** Both scrapes succeed: Discord login HTML carries the build number, the Chrome version history carries the major. */
function stubSuccessfulScrapes(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://discord.com/login') {
        return new Response('<html>"BUILD_NUMBER":"123456"</html>', { status: 200 });
      }
      if (url.startsWith('https://versionhistory.googleapis.com/')) {
        return new Response(JSON.stringify({ versions: [{ version: '131.0.6778.86' }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

describe('refreshClientVersions: independent persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('still persists the chrome record when the build-number write fails', async () => {
    stubSuccessfulScrapes();
    const setBuildNumberRecord = vi.fn(async () => {
      throw new Error('build write failed');
    });
    const setChromeVersionRecord = vi.fn(async () => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const records = await refreshClientVersions(envWithStub({ setBuildNumberRecord, setChromeVersionRecord }));

    expect(setChromeVersionRecord).toHaveBeenCalledTimes(1);
    expect(setChromeVersionRecord).toHaveBeenCalledWith(expect.objectContaining({ major: 131, source: 'scraped' }));
    // The failed build write must not be reported as refreshed.
    expect(records.build).toBeNull();
    expect(records.chrome?.major).toBe(131);
  });

  it('still persists the build-number record when the chrome write fails', async () => {
    stubSuccessfulScrapes();
    const setBuildNumberRecord = vi.fn(async () => undefined);
    const setChromeVersionRecord = vi.fn(async () => {
      throw new Error('chrome write failed');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const records = await refreshClientVersions(envWithStub({ setBuildNumberRecord, setChromeVersionRecord }));

    expect(setBuildNumberRecord).toHaveBeenCalledTimes(1);
    expect(setBuildNumberRecord).toHaveBeenCalledWith(expect.objectContaining({ buildNumber: 123456, source: 'scraped' }));
    expect(records.build?.buildNumber).toBe(123456);
    expect(records.chrome).toBeNull();
  });

  it('reports both records null without throwing when both writes fail', async () => {
    stubSuccessfulScrapes();
    const setBuildNumberRecord = vi.fn(async () => {
      throw new Error('build write failed');
    });
    const setChromeVersionRecord = vi.fn(async () => {
      throw new Error('chrome write failed');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const records = await refreshClientVersions(envWithStub({ setBuildNumberRecord, setChromeVersionRecord }));

    expect(setBuildNumberRecord).toHaveBeenCalledTimes(1);
    expect(setChromeVersionRecord).toHaveBeenCalledTimes(1);
    expect(records.build).toBeNull();
    expect(records.chrome).toBeNull();
  });

  it('persists and reports both records on a clean run', async () => {
    stubSuccessfulScrapes();
    const setBuildNumberRecord = vi.fn(async () => undefined);
    const setChromeVersionRecord = vi.fn(async () => undefined);

    const records = await refreshClientVersions(envWithStub({ setBuildNumberRecord, setChromeVersionRecord }));

    expect(setBuildNumberRecord).toHaveBeenCalledTimes(1);
    expect(setChromeVersionRecord).toHaveBeenCalledTimes(1);
    expect(records.build?.buildNumber).toBe(123456);
    expect(records.chrome?.major).toBe(131);
  });
});
