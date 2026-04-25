const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function readAuthtokenFromConfig(cfgPath) {
  try {
    const text = fs.readFileSync(cfgPath, 'utf8');
    const m = text.match(/^\s*authtoken\s*:\s*(.+?)\s*$/m);
    return m ? String(m[1]).trim() : '';
  } catch {
    return '';
  }
}

function upsertAuthtokenIntoConfig(cfgPath, token) {
  const tokenLine = `authtoken: ${token}`;
  const versionLine = 'version: 2';

  const existing = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
  const text = existing || '';

  if (!text.trim()) {
    fs.writeFileSync(cfgPath, `${versionLine}\n${tokenLine}\n`);
    return;
  }

  const hasAuthtoken = /^\s*authtoken\s*:/m.test(text);
  if (hasAuthtoken) {
    const updated = text.replace(/^\s*authtoken\s*:.*$/m, tokenLine);
    fs.writeFileSync(cfgPath, updated.endsWith('\n') ? updated : `${updated}\n`);
    return;
  }

  const hasVersion = /^\s*version\s*:\s*\d+\s*$/m.test(text);
  if (hasVersion) {
    const updated = text.replace(/^\s*version\s*:\s*\d+\s*$/m, (m) => `${m}\n${tokenLine}`);
    fs.writeFileSync(cfgPath, updated.endsWith('\n') ? updated : `${updated}\n`);
    return;
  }

  fs.writeFileSync(cfgPath, `${versionLine}\n${tokenLine}\n${text.endsWith('\n') ? text : `${text}\n`}`);
}

async function fetchJson(url, { timeoutMs = 1500 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function waitForNgrokUrl({ apiUrl, tries = 40 }) {
  for (let i = 0; i < tries; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const j = await fetchJson(`${apiUrl}/api/tunnels`, { timeoutMs: 1200 });
      const tunnels = Array.isArray(j?.tunnels) ? j.tunnels : [];
      const https = tunnels.find((t) => String(t?.public_url || '').startsWith('https://'));
      const any = tunnels[0];
      const url = https?.public_url || any?.public_url || '';
      if (url) return String(url);
    } catch {
      // ignore until ready
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(350);
  }
  return '';
}

async function main() {
  const root = process.cwd();
  const port = Number(process.env.MINIAPP_PROXY_PORT || 3111) || 3111;
  const bin = path.join(root, 'tools', 'ngrok', 'ngrok');
  if (!fileExists(bin)) {
    console.error(`ngrok not found at ${bin}`);
    console.error('Run: node scripts/ngrok-setup.js');
    process.exit(1);
  }

  const cfgDir = path.join(root, '.ngrok');
  const cfgPath = path.join(cfgDir, 'ngrok.yml');
  fs.mkdirSync(cfgDir, { recursive: true });

  const tokenFromEnv = String(process.env.NGROK_AUTHTOKEN || '').trim();
  const tokenFromCfg = readAuthtokenFromConfig(cfgPath);
  const token = tokenFromEnv || tokenFromCfg;

  if (!token) {
    console.error('ngrok authtoken is missing.');
    console.error(`Set NGROK_AUTHTOKEN env var or add it to ${cfgPath} as: authtoken: <token>`);
    process.exit(1);
  }

  if (tokenFromEnv || !fs.existsSync(cfgPath)) {
    upsertAuthtokenIntoConfig(cfgPath, token);
  }

  const apiUrl = 'http://127.0.0.1:4040';
  const domain = String(process.env.NGROK_DOMAIN || '').trim();
  const region = String(process.env.NGROK_REGION || '').trim();
  const args = [
    'http',
    String(port),
    '--config',
    cfgPath,
    '--log',
    'stdout',
  ];
  if (region) {
    args.push('--region', region);
  }
  if (domain) {
    // Requires a reserved ngrok domain (paid or configured in your account).
    args.push('--domain', domain);
  }

  const child = spawn(bin, args, { stdio: 'inherit' });
  child.on('exit', (code) => {
    process.exit(code == null ? 1 : code);
  });

  const publicUrl = await waitForNgrokUrl({ apiUrl });
  if (!publicUrl) {
    console.error('Failed to detect ngrok public URL (check ngrok logs above).');
    process.exit(1);
  }

  const envPath = path.join(root, '.env');
  const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const updated = upsertEnvLine(envText || '', 'MINIAPP_PUBLIC_URL', publicUrl);
  fs.writeFileSync(envPath, updated);

  console.log('\nMini App ready:');
  console.log(`- MINIAPP_PUBLIC_URL=${publicUrl}`);
  console.log(`- Open in Telegram: /app`);
  console.log(`- Mini App URL: ${publicUrl.replace(/[/]+$/, '')}/miniapp`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
