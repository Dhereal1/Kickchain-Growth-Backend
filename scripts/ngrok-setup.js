const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(() => {
          fs.unlinkSync(dest);
          resolve(download(res.headers.location, dest));
        });
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', (err) => {
      try {
        file.close(() => {});
      } catch {
        // ignore
      }
      reject(err);
    });
  });
}

function extractTgz({ tgzPath, outDir }) {
  return new Promise((resolve, reject) => {
    const inStream = fs.createReadStream(tgzPath);
    const gunzip = zlib.createGunzip();
    const chunks = [];

    gunzip.on('data', (c) => chunks.push(c));
    gunzip.on('error', reject);
    gunzip.on('end', () => {
      const buf = Buffer.concat(chunks);

      // Minimal tar reader for this specific archive structure (single file "ngrok").
      // Tar header is 512 bytes; file size stored as octal at offset 124 length 12.
      const header = buf.subarray(0, 512);
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
      const size = parseInt(sizeOctal, 8);
      if (!name || !Number.isFinite(size) || size <= 0) {
        reject(new Error('Unexpected archive format'));
        return;
      }

      const fileStart = 512;
      const fileEnd = fileStart + size;
      const fileBuf = buf.subarray(fileStart, fileEnd);

      mkdirp(outDir);
      const outPath = path.join(outDir, path.basename(name));
      fs.writeFileSync(outPath, fileBuf, { mode: 0o755 });
      resolve(outPath);
    });

    inStream.pipe(gunzip);
  });
}

async function main() {
  const root = process.cwd();
  const outDir = path.join(root, 'tools', 'ngrok');
  const binPath = path.join(outDir, 'ngrok');
  if (fileExists(binPath)) {
    console.log(`ngrok already installed at ${binPath}`);
    return;
  }

  mkdirp(outDir);
  const tmp = path.join(outDir, 'ngrok.tgz');
  const url = 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz';

  console.log('Downloading ngrok…');
  await download(url, tmp);
  console.log('Extracting…');
  const extracted = await extractTgz({ tgzPath: tmp, outDir });
  fs.unlinkSync(tmp);

  if (!fileExists(extracted)) throw new Error('ngrok install failed');
  if (extracted !== binPath) {
    // Some archives may name it differently; normalize.
    fs.renameSync(extracted, binPath);
    fs.chmodSync(binPath, 0o755);
  }

  console.log(`Installed ngrok to ${binPath}`);
  console.log('Next: node scripts/ngrok-miniapp.js');
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});

