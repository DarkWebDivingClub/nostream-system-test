import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(projectRoot, 'assets.manifest.json');
const assetsRoot = path.join(projectRoot, '.assets');
const lockPath = path.join(assetsRoot, 'manifest.lock.json');

function request(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;

    const req = client.get(url, (res) => {
      const statusCode = res.statusCode ?? 0;
      const location = res.headers.location;

      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects while downloading ${url}`));
          return;
        }

        res.resume();
        const nextUrl = new URL(location, url).toString();
        resolve(request(nextUrl, redirectsLeft - 1));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(new Error(`Failed downloading ${url}: HTTP ${statusCode}`));
        return;
      }

      resolve(res);
    });

    req.on('error', reject);
  });
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);

  stream.on('data', (chunk) => hash.update(chunk));

  await new Promise((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return hash.digest('hex');
}

async function downloadAsset(url, destination) {
  const tmpPath = `${destination}.part`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const response = await request(url);
  const output = fs.createWriteStream(tmpPath);
  await pipeline(response, output);
  fs.renameSync(tmpPath, destination);
}

function loadManifest() {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);

  if (!Array.isArray(manifest.assets)) {
    throw new Error('assets.manifest.json: "assets" must be an array');
  }

  return manifest;
}

async function main() {
  const manifest = loadManifest();
  fs.mkdirSync(assetsRoot, { recursive: true });

  const lock = {
    generatedAt: new Date().toISOString(),
    assets: []
  };

  for (const asset of manifest.assets) {
    if (!asset?.id || !asset?.url || !asset?.target) {
      throw new Error('Each asset requires id, url, and target');
    }

    const targetPath = path.join(assetsRoot, asset.target);

    if (!fs.existsSync(targetPath)) {
      console.log(`Downloading ${asset.id} -> ${asset.target}`);
      await downloadAsset(asset.url, targetPath);
    } else {
      console.log(`Using existing ${asset.id} -> ${asset.target}`);
    }

    const stat = fs.statSync(targetPath);
    const sha256 = await sha256File(targetPath);

    if (asset.sha256 && asset.sha256 !== sha256) {
      throw new Error(`Checksum mismatch for ${asset.id}: expected ${asset.sha256}, got ${sha256}`);
    }

    lock.assets.push({
      id: asset.id,
      url: asset.url,
      target: asset.target,
      size: stat.size,
      sha256
    });
  }

  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  console.log(`Wrote lock file: ${path.relative(projectRoot, lockPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
