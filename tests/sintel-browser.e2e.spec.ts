import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import 'mock-local-storage';
import { getDefaultAppContext, getDefaultNetContext } from '../../iz-nostrlib/node_modules/@red-token/welshman/build/src/app/index.js';
import { setContext } from '../../iz-nostrlib/node_modules/@red-token/welshman/build/src/lib/index.js';
import { getPublicKey, nip19 } from 'nostr-tools';
import SimplePeer from 'simple-peer';
import WebTorrent, { type Torrent } from 'webtorrent';
import { EventType } from 'iz-nostrlib';
import {
  CommunityNostrContext,
  GlobalNostrContext,
  Identity,
  Identifier,
  asyncCreateWelshmanSession
} from 'iz-nostrlib/communities';
import {
  Nip9999SeederTorrentTransformationRequestEvent,
  Nip9999SeederTorrentTransformationResponseEvent,
  NostrCommunityServiceClient
} from 'iz-nostrlib/seederbot';
import { Nip01UserMetaDataEvent, NostrUserProfileMetaData, UserType } from 'iz-nostrlib/nip01';
import { Nip65RelayListMetadataEvent } from 'iz-nostrlib/nip65';
import { SignerType } from 'iz-nostrlib/ses';
import { DynamicPublisher } from 'iz-nostrlib/ses';

const testFileDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testFileDir, '..');
const izStreamRoot = '/home/rene/git/iz-stream';

const relayUrl = process.env.RELAY_URL ?? 'ws://127.0.0.1:7777/';
const communityRelayUrls = (process.env.COMMUNITY_RELAY_URLS ?? `${relayUrl},ws://strfry:7777/`)
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const izStreamUrl = process.env.IZ_STREAM_URL ?? 'http://127.0.0.1:4173';
const keepStack = process.env.KEEP_STACK === '1';
const mediaCandidates = [
  process.env.SINTEL_FILE,
  path.join(projectRoot, '.assets/media/sintel/v1/Sintel.smoke.5s.mp4'),
  path.join(projectRoot, '.assets/media/sintel/v1/Sintel.2010.1080p.mkv')
].filter((value): value is string => Boolean(value));

const sourceMediaPath = mediaCandidates.find((candidate) => fs.existsSync(candidate));
const seedHashTimeoutMs = Number(process.env.SEED_HASH_TIMEOUT_MS ?? '30000');
const responseTimeoutMs = Number(process.env.RESPONSE_TIMEOUT_MS ?? '180000');

const botNsec = 'nsec17c0r3dwpf22vf6gw4qzldneqj9caukgs7ugea8qdsljsx3ulrm9s2kn0sc';
const bobNsec = 'nsec1zsp48upz3vd64lwhx7me8utrxyfxuzdwvxhfld2q0ehs0ya9mlxs47v64q';
const bigFishNsec = 'nsec16lc2cn2gzgf3vcv20lwkqquprqujpkq9pj0wcxmnw8scxh6j0yrqlc9ae0';
const bigFishPubkey = '76e75c0c50ce7ef714b76eaf06d6a06a29d296d5bb86270818675a669938dbe2';
const communityPubkey = bigFishPubkey;

const announce = (process.env.TORRENT_ANNOUNCE ??
  'http://127.0.0.1:8000/announce,ws://127.0.0.1:8000,wss://tracker.webtorrent.dev,wss://tracker.btorrent.xyz,wss://tracker.openwebtorrent.com')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

const browserAnnounce = (process.env.BROWSER_TORRENT_ANNOUNCE ?? 'ws://127.0.0.1:8000').split(',').map((value) => value.trim()).filter(Boolean).join(',');

function runCompose(args: string[]): void {
  execFileSync('docker', ['compose', ...args], {
    cwd: projectRoot,
    stdio: 'inherit'
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then((result) => {
      clearTimeout(timer);
      resolve(result);
    }).catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttpReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore and retry
    }
    await wait(1000);
  }

  throw new Error(`Service not ready at ${url} after ${timeoutMs}ms`);
}

async function getTorrentHash(torrent: Torrent): Promise<string> {
  return await new Promise((resolve, reject) => {
    if (torrent.infoHash) {
      resolve(torrent.infoHash);
      return;
    }

    torrent.once('infoHash', () => resolve(torrent.infoHash));
    torrent.once('error', reject);
  });
}

function waitForFinalResponse(dss: { eventStream: { emitter: { on: Function; off: Function } } }): Promise<{
  response: Nip9999SeederTorrentTransformationResponseEvent;
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      dss.eventStream.emitter.off(EventType.DISCOVERED, onDiscovered);
      reject(new Error(`Timed out waiting for final transformation response after ${responseTimeoutMs}ms`));
    }, responseTimeoutMs);

    const onDiscovered = (event: unknown) => {
      try {
        const response = Nip9999SeederTorrentTransformationResponseEvent.buildFromEvent(event as never);
        const finalFlag = Boolean(response.state?.final);
        const errored = response.state?.state === 'error';
        const terminalByMessage =
          typeof response.state?.message === 'string' &&
          response.state.message.toLowerCase().includes('starting to seed at');

        if (!finalFlag && !errored && !terminalByMessage) {
          return;
        }

        clearTimeout(timeout);
        dss.eventStream.emitter.off(EventType.DISCOVERED, onDiscovered);

        if (errored) {
          reject(new Error(`Transcoding failed: ${JSON.stringify(response.state)}`));
          return;
        }

        resolve({ response });
      } catch (error) {
        clearTimeout(timeout);
        dss.eventStream.emitter.off(EventType.DISCOVERED, onDiscovered);
        reject(error);
      }
    };

    dss.eventStream.emitter.on(EventType.DISCOVERED, onDiscovered);
  });
}

function getTagValue(tags: string[][] | undefined, name: string): string | null {
  if (!tags) {
    return null;
  }
  const tag = tags.find((item) => item[0] === name);
  return tag?.[1] ?? null;
}

function extractSeededHash(response: Nip9999SeederTorrentTransformationResponseEvent): string {
  const fromTag = getTagValue(response.event?.tags, 'x');
  if (fromTag) {
    return fromTag;
  }

  const message = String(response.state?.message ?? '');
  const match = message.match(/[a-f0-9]{40}/i);
  if (match) {
    return match[0];
  }

  throw new Error('Final response did not include seeded torrent hash');
}

function startIzStreamDevServer(): ChildProcess {
  const child = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4173'], {
    cwd: izStreamRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_APPLICATION_RELAY: relayUrl,
      VITE_DEFAULT_COMMUNITY_RELAY: relayUrl,
      VITE_TORRENT_ANNOUNCE: browserAnnounce
    }
  });

  return child;
}

function stopProcess(child: ChildProcess | null): void {
  if (!child || child.killed) {
    return;
  }
  child.kill('SIGTERM');
}

async function bootstrapBigFishCommunity(globalContext: GlobalNostrContext): Promise<void> {
  const session = await asyncCreateWelshmanSession({ type: SignerType.NIP01, nsec: bigFishNsec });
  const identity = new Identity(globalContext, new Identifier(session));
  if (identity.pubkey !== bigFishPubkey) {
    throw new Error('Configured Big Fish nsec does not match expected pubkey');
  }

  const publisher = new DynamicPublisher(globalContext.profileService, identity);
  publisher.publish(
    new Nip01UserMetaDataEvent(
      new NostrUserProfileMetaData('Big Fish', 'System-test community'),
      UserType.COMMUNITY,
      [['nip35']]
    )
  );
  publisher.publish(new Nip65RelayListMetadataEvent(communityRelayUrls.map((relay) => [relay])));
  await wait(1_500);
}

const rtcConfig = {
  iceServers: [
    {
      urls: ['turn:turn.stream.labs.h3.se'],
      username: 'test',
      credential: 'testme'
    },
    {
      urls: ['stun:stun.stream.labs.h3.se'],
      username: 'test',
      credential: 'testme'
    }
  ],
  iceTransportPolicy: 'all' as const,
  iceCandidatePoolSize: 0
};

test('sintel browser playback through iz-stream', async ({ page }) => {
  if (!sourceMediaPath) {
    throw new Error('No source media found. Set SINTEL_FILE or run: npm run assets:fetch.');
  }

  runCompose(['--profile', 'sintel', 'down', '-v', '--remove-orphans']);
  runCompose(['--profile', 'sintel', 'up', '-d', '--build', '--force-recreate']);

  const wt = new WebTorrent({
    tracker: {
      rtcConfig: {
        ...SimplePeer.config,
        ...rtcConfig
      }
    }
  });

  let devServer: ChildProcess | null = null;

  try {
    await waitForHttpReady('http://127.0.0.1:8000/stats', 60_000);

    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    setContext({
      net: getDefaultNetContext(),
      app: getDefaultAppContext()
    });

    const globalContext = new GlobalNostrContext([relayUrl]);
    await wait(2_000);
    await bootstrapBigFishCommunity(globalContext);

    const bobSession = await asyncCreateWelshmanSession({ type: SignerType.NIP01, nsec: bobNsec });
    const bobIdentity = new Identity(globalContext, new Identifier(bobSession));
    const communityContext = new CommunityNostrContext(communityPubkey, globalContext);
    if (communityContext.relays.value.length === 0) {
      communityContext.relays.value = [relayUrl];
    }
    const client = new NostrCommunityServiceClient(communityContext, bobIdentity);

    const torrent = wt.seed(sourceMediaPath, { announce, maxWebConns: 500 });
    const infoHash = await withTimeout(getTorrentHash(torrent), seedHashTimeoutMs, 'seed/hash stage');

    const botPrivate = nip19.decode(botNsec);
    if (botPrivate.type !== 'nsec') {
      throw new Error('Configured bot nsec is invalid');
    }

    const botPubkey = getPublicKey(botPrivate.data);

    const request = new Nip9999SeederTorrentTransformationRequestEvent(botPubkey, 'Sintel', infoHash, {
      imdbId: 'tt1727587',
      file: path.basename(sourceMediaPath),
      subtitles: [],
      formats: {
        tiny: {
          width: 426,
          height: 240
        }
      }
    });

    const { dss } = client.request(request);
    const { response } = await waitForFinalResponse(dss);
    const seededHash = extractSeededHash(response);

    devServer = startIzStreamDevServer();
    await waitForHttpReady(`${izStreamUrl}/e2e/watch?hash=${seededHash}`, 120_000);

    await page.goto(`${izStreamUrl}/e2e/watch?hash=${seededHash}`, { waitUntil: 'networkidle' });
    await expect(page.locator('[data-testid="missing-hash"]')).toHaveCount(0);
    await expect(page.locator('video[data-testid="video-player"]')).toBeVisible();
    expect(page.url()).toContain(`hash=${seededHash}`);
  } finally {
    stopProcess(devServer);
    wt.destroy();
    if (!keepStack) {
      runCompose(['--profile', 'sintel', 'down', '-v', '--remove-orphans']);
    }
  }
});
