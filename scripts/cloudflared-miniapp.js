const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function upsertEnvLine(envText, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(envText)) return envText.replace(re, line);
  const trimmed = envText.replace(/\s+$/, '');
  return `${trimmed}\n${line}\n`;
}

function findTryCloudflareUrl(text) {
  const t = String(text || '');
  const m = t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? String(m[0]) : '';
}

async function main() {
  const root = process.cwd();
  const port = Number(process.env.MINIAPP_PROXY_PORT || 3111) || 3111;

  const bin = process.env.CLOUDFLARED_BIN
    ? String(process.env.CLOUDFLARED_BIN)
    : 'cloudflared';

  // If CLOUDFLARED_BIN is set, treat it as a file path. Otherwise assume it's on PATH.
  if (process.env.CLOUDFLARED_BIN && !fileExists(bin)) {
    console.error(`cloudflared not found at ${bin}`);
    process.exit(1);
  }

  const startChild = (cmd, args) =>
    spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const tryStart = () => {
    const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
    return startChild(bin, args);
  };

  const startDocker = () => {
    const args = [
      'run',
      '--rm',
      '--network',
      'host',
      'cloudflare/cloudflared:latest',
      'tunnel',
      '--no-autoupdate',
      '--url',
      `http://127.0.0.1:${port}`,
    ];
    return startChild('docker', args);
  };

  const child = tryStart();

  let publicUrl = '';
  let printed = false;
  const onData = (buf) => {
    const s = buf.toString('utf8');
    process.stdout.write(s);
    if (!publicUrl) publicUrl = findTryCloudflareUrl(s);
    if (!publicUrl || printed) return;
    printed = true;

    const envPath = path.join(root, '.env');
    const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const updated = upsertEnvLine(envText || '', 'MINIAPP_PUBLIC_URL', publicUrl);
    fs.writeFileSync(envPath, updated);

    console.log('\nMini App ready:');
    console.log(`- MINIAPP_PUBLIC_URL=${publicUrl}`);
    console.log(`- Open in Telegram: /app`);
    console.log(`- Mini App URL: ${publicUrl.replace(/[/]+$/, '')}/miniapp`);
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => {
    const msg = err?.message || String(err);
    if (String(err?.code || '').toUpperCase() === 'ENOENT' && bin === 'cloudflared') {
      console.error('cloudflared not found on PATH. Falling back to Docker image cloudflare/cloudflared:latest...');
      const dockerChild = startDocker();
      dockerChild.stdout.on('data', onData);
      dockerChild.stderr.on('data', onData);
      dockerChild.on('error', (dockerErr) => {
        console.error(dockerErr?.message || String(dockerErr));
        console.error('Neither cloudflared nor docker is available. Install one of them and retry.');
        process.exit(1);
      });
      dockerChild.on('exit', (code) => {
        process.exit(code == null ? 1 : code);
      });
      return;
    }

    console.error(msg);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code == null ? 1 : code);
  });
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
