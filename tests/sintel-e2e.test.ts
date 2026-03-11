import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import 'mock-local-storage';
import { getDefaultAppContext, getDefaultNetContext } from '../../iz-nostrlib/node_modules/@red-token/welshman/build/src/app/index.js';
import { setContext } from '../../iz-nostrlib/node_modules/@red-token/welshman/build/src/lib/index.js';
import SimplePeer from 'simple-peer';
import WebTorrent, { type Torrent } from 'webtorrent';
import { getPublicKey, nip19 } from 'nostr-tools';
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
import { Nip35TorrentEvent } from 'iz-nostrlib/nip35';
import { DynamicPublisher, DynamicSubscription } from 'iz-nostrlib/ses';
import { SignerType } from 'iz-nostrlib/ses';
import { describe, expect, it } from 'vitest';

const testFileDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testFileDir, '..');

const relayUrl = process.env.RELAY_URL ?? 'ws://127.0.0.1:7777/';
const communityRelayUrls = (process.env.COMMUNITY_RELAY_URLS ?? `${relayUrl},ws://strfry:7777/`)
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const keepStack = process.env.KEEP_STACK === '1';
const mediaCandidates = [
  process.env.SINTEL_FILE,
  path.join(projectRoot, '.assets/media/sintel/v1/Sintel.2010.1080p.mkv'),
  '/home/rene/git/iz-seeder-bot/test/data/sintel/orig/Sintel.2010.1080p.mkv'
].filter((value): value is string => Boolean(value));

const sourceMediaPath = mediaCandidates.find((candidate) => fs.existsSync(candidate));
const seedHashTimeoutMs = Number(process.env.SEED_HASH_TIMEOUT_MS ?? '30000');
const responseTimeoutMs = Number(process.env.RESPONSE_TIMEOUT_MS ?? '900000');

const botNsec = 'nsec17c0r3dwpf22vf6gw4qzldneqj9caukgs7ugea8qdsljsx3ulrm9s2kn0sc';
const bobNsec = 'nsec1zsp48upz3vd64lwhx7me8utrxyfxuzdwvxhfld2q0ehs0ya9mlxs47v64q';
const bigFishNsec = 'nsec16lc2cn2gzgf3vcv20lwkqquprqujpkq9pj0wcxmnw8scxh6j0yrqlc9ae0';
const bigFishPubkey = '76e75c0c50ce7ef714b76eaf06d6a06a29d296d5bb86270818675a669938dbe2';
const communityPubkey = bigFishPubkey;
const imdbId = 'tt1727587';

function runCompose(args: string[]): void {
  execFileSync('docker', ['compose', ...args], {
    cwd: projectRoot,
    stdio: 'inherit'
  });
}

function logStage(message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  if (data === undefined) {
    console.log(`[sintel-test] ${timestamp} ${message}`);
    return;
  }

  console.log(`[sintel-test] ${timestamp} ${message}`, data);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function dumpComposeDiagnostics(): void {
  try {
    execFileSync('docker', ['compose', '--profile', 'sintel', 'ps'], {
      cwd: projectRoot,
      stdio: 'inherit'
    });
    execFileSync('docker', ['compose', '--profile', 'sintel', 'logs', '--tail=200', 'seeder-bot', 'strfry', 'tracker'], {
      cwd: projectRoot,
      stdio: 'inherit'
    });
  } catch (error) {
    console.error('[sintel-test] failed to dump compose diagnostics', error);
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttpReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }
    await wait(1_000);
  }

  throw new Error(`Service not ready at ${url} after ${timeoutMs}ms: ${String(lastError)}`);
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
        logStage('response event received', {
          eventId: (event as { id?: string } | undefined)?.id ?? null,
          state: response.state
        });
        const finalFlag = Boolean(response.state?.final);
        const errored = response.state?.state === 'error';
        const terminalByMessage =
          typeof response.state?.message === 'string' &&
          response.state.message.toLowerCase().includes('starting to seed at');
        const terminalBySeq =
          response.state?.state === 'seeding' &&
          typeof response.state?.progress === 'number' &&
          response.state.progress >= 100;

        if (!finalFlag && !errored && !terminalByMessage && !terminalBySeq) {
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
  if (!tag || tag.length < 2) {
    return null;
  }
  return tag[1] ?? null;
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

async function downloadTorrentByHash(wt: WebTorrent.Instance, infoHash: string, outputPath: string): Promise<Torrent> {
  return await new Promise((resolve, reject) => {
    const torrent = wt.add(infoHash, { announce, path: outputPath, maxWebConns: 500 });

    torrent.once('done', () => resolve(torrent));
    torrent.once('error', reject);
  });
}

function readTorrentFileText(torrent: Torrent, outputPath: string, filenameSuffix: string): string {
  const file = torrent.files.find((item) => item.path.endsWith(filenameSuffix));
  if (!file) {
    throw new Error(`Could not find file matching suffix "${filenameSuffix}" in downloaded torrent`);
  }

  return fs.readFileSync(path.join(outputPath, file.path), 'utf8');
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

function waitForRegisteredAsset(dss: { eventStream: { emitter: { on: Function; off: Function } } }, expectedHash: string): Promise<Nip35TorrentEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      dss.eventStream.emitter.off(EventType.DISCOVERED, onDiscovered);
      reject(new Error(`Timed out waiting for registered Nip35 asset for hash ${expectedHash}`));
    }, responseTimeoutMs);

    const onDiscovered = (event: unknown) => {
      const trustedEvent = event as { kind?: number } | undefined;
      if (trustedEvent?.kind !== Nip35TorrentEvent.KIND) {
        return;
      }

      try {
        const asset = Nip35TorrentEvent.buildFromEvent(event as never);
        if (asset.x !== expectedHash) {
          return;
        }

        clearTimeout(timeout);
        dss.eventStream.emitter.off(EventType.DISCOVERED, onDiscovered);
        resolve(asset);
      } catch {
        // ignore non-matching/invalid events while waiting
      }
    };

    dss.eventStream.emitter.on(EventType.DISCOVERED, onDiscovered);
  });
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

const announce = (process.env.TORRENT_ANNOUNCE ??
  'http://127.0.0.1:8000/announce,wss://tracker.webtorrent.dev,wss://tracker.btorrent.xyz,wss://tracker.openwebtorrent.com')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

describe('sintel e2e', () => {
  const runSintel = process.env.RUN_SINTEL_E2E === '1';

  (runSintel ? it : it.skip)(
    'publishes a transformation request and receives final response',
    { timeout: 25 * 60 * 1000 },
    async () => {
      if (!sourceMediaPath) {
        throw new Error(
          'No source media found. Set SINTEL_FILE or run: npm run assets:fetch.'
        );
      }

      runCompose(['--profile', 'sintel', 'down', '-v', '--remove-orphans']);
      runCompose(['--profile', 'sintel', 'up', '-d', '--build', '--force-recreate']);
      await waitForHttpReady('http://127.0.0.1:8000/stats', 60_000);
      logStage('tracker ready', { url: 'http://127.0.0.1:8000/stats' });

      const wt = new WebTorrent({
        tracker: {
          rtcConfig: {
            ...SimplePeer.config,
            ...rtcConfig
          }
        }
      });

      try {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        setContext({
          net: getDefaultNetContext(),
          app: getDefaultAppContext()
        });

        const globalContext = new GlobalNostrContext([relayUrl]);
        await wait(2_000);
        await bootstrapBigFishCommunity(globalContext);
        logStage('big fish community bootstrapped', { bigFishPubkey, relayUrl });

        const bobSession = await asyncCreateWelshmanSession({ type: SignerType.NIP01, nsec: bobNsec });
        const bobIdentity = new Identity(globalContext, new Identifier(bobSession));
        const communityContext = new CommunityNostrContext(communityPubkey, globalContext);
        if (communityContext.relays.value.length === 0) {
          communityContext.relays.value = [relayUrl];
          logStage('client community relay fallback applied', { relayUrl });
        }
        const client = new NostrCommunityServiceClient(communityContext, bobIdentity);

        logStage('starting local seed', { sourceMediaPath });
        const torrent = wt.seed(sourceMediaPath, { announce, maxWebConns: 500 });
        const infoHash = await withTimeout(getTorrentHash(torrent), seedHashTimeoutMs, 'seed/hash stage');
        logStage('infoHash ready', { infoHash, seedHashTimeoutMs });

        const botPrivate = nip19.decode(botNsec);
        if (botPrivate.type !== 'nsec') {
          throw new Error('Configured bot nsec is invalid');
        }

        const botPubkey = getPublicKey(botPrivate.data);

        const request = new Nip9999SeederTorrentTransformationRequestEvent(botPubkey, 'Sintel', infoHash, {
          imdbId,
          file: path.basename(sourceMediaPath),
          subtitles: [],
          formats: {
            tiny: {
              width: 426,
              height: 240
            }
          }
        });

        logStage('publishing nip9999 transformation request');
        const { dss, pub } = client.request(request);
        logStage('request published', { requestEventId: request.event?.id ?? null });
        const { response } = await waitForFinalResponse(dss);
        logStage('final response received', { state: response.state });

        expect(response.asid).toBeDefined();
        expect(response.state?.final).toBe(true);
        expect(response.state?.state).toBe('seeding');
        expect(String(response.state?.message ?? '')).toContain('starting to seed at');

        const seededHash = extractSeededHash(response);
        const nowInSeconds = Math.floor(Date.now() / 1000);
        new DynamicSubscription(dss, [
          {
            kinds: [Nip35TorrentEvent.KIND],
            '#x': [seededHash],
            since: nowInSeconds - 5
          }
        ]);
        const registeredAssetWait = waitForRegisteredAsset(dss, seededHash);
        const assetRegistration = new Nip35TorrentEvent(
          'Sintel',
          seededHash,
          'Sintel transformed asset',
          [],
          announce,
          [`imdb:${imdbId}`],
          ['movie']
        );
        logStage('publishing nip35 asset registration', { seededHash, imdbId });
        pub.publish(assetRegistration);
        const registeredAsset = await registeredAssetWait;
        logStage('nip35 asset registered', {
          x: registeredAsset.x,
          title: registeredAsset.title,
          is: registeredAsset.is
        });

        logStage('downloading transformed output', { seededHash });
        const transformedOutputPath = path.join(projectRoot, '.assets', 'downloads', seededHash);
        fs.mkdirSync(transformedOutputPath, { recursive: true });

        const transformedTorrent = await withTimeout(
          downloadTorrentByHash(wt, seededHash, transformedOutputPath),
          responseTimeoutMs,
          'client download transformed output stage'
        );
        logStage('transformed output downloaded', {
          seededHash,
          files: transformedTorrent.files.map((item) => item.path)
        });

        const downloadedPaths = transformedTorrent.files.map((item) => item.path);
        expect(downloadedPaths.some((entry) => entry.endsWith('manifest.mpd'))).toBe(true);
        expect(downloadedPaths.some((entry) => entry.endsWith('.mp4'))).toBe(true);
        expect(downloadedPaths.some((entry) => entry.endsWith('.m4s'))).toBe(true);

        const manifestText = readTorrentFileText(transformedTorrent, transformedOutputPath, 'manifest.mpd');
        expect(manifestText).toContain('<MPD');
        expect(manifestText).toContain('SegmentTemplate');
        expect(manifestText).toContain('.m4s');
        expect(registeredAsset.is.some((value) => value.includes(imdbId))).toBe(true);
      } catch (error) {
        logStage('test failed, dumping compose diagnostics');
        dumpComposeDiagnostics();
        throw error;
      } finally {
        wt.destroy();
        if (!keepStack) {
          runCompose(['--profile', 'sintel', 'down', '-v', '--remove-orphans']);
        } else {
          logStage('KEEP_STACK=1 set, leaving docker compose stack running');
        }
      }
    }
  );
});
