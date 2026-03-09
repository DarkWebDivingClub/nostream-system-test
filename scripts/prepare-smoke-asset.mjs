import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const source = path.join(projectRoot, '.assets/media/sintel/v1/Sintel.2010.1080p.mkv');
const smoke = path.join(projectRoot, '.assets/media/sintel/v1/Sintel.smoke.5s.mp4');

if (!fs.existsSync(source)) {
  console.log('Skipping smoke asset generation: missing source Sintel file. Run `npm run assets:fetch` first.');
  process.exit(0);
}

fs.mkdirSync(path.dirname(smoke), { recursive: true });

const shouldRebuild = !fs.existsSync(smoke) || fs.statSync(smoke).mtimeMs < fs.statSync(source).mtimeMs;

if (!shouldRebuild) {
  console.log(`Smoke asset already ready: ${path.relative(projectRoot, smoke)}`);
  process.exit(0);
}

console.log(`Generating smoke clip: ${path.relative(projectRoot, smoke)}`);
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-ss',
    '00:00:05',
    '-i',
    source,
    '-t',
    '5',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '28',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    smoke
  ],
  { stdio: 'inherit' }
);

const sizeMb = (fs.statSync(smoke).size / (1024 * 1024)).toFixed(2);
console.log(`Smoke asset ready (${sizeMb} MB)`);
