const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function parseEnvFile(text) {
  const parsed = dotenv.parse(String(text || ''));
  return Object.entries(parsed).map(([key, value]) => ({ key, value }));
}

function hasKey(envText, key) {
  const re = new RegExp(`^\\s*${key}\\s*=`, 'm');
  return re.test(envText);
}

function isSecretKey(key) {
  const k = String(key || '').toUpperCase();
  return (
    k === 'DATABASE_URL' ||
    k.includes('PASSWORD') ||
    k.endsWith('_TOKEN') ||
    k.endsWith('_SECRET') ||
    k.endsWith('_API_KEY') ||
    k.endsWith('_KEY')
  );
}

function syncEnv({ examplePath, targetPath }) {
  const exampleText = fs.readFileSync(examplePath, 'utf8');
  const targetText = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';

  const exampleEntries = parseEnvFile(exampleText);
  const missingLines = [];
  for (const { key, value } of exampleEntries) {
    if (!hasKey(targetText, key)) {
      missingLines.push(`${key}=${isSecretKey(key) ? '' : value}`);
    }
  }

  if (!missingLines.length) {
    console.log(`OK: ${targetPath} already has all keys from ${examplePath}`);
    return;
  }

  const banner = `\n# ---- Added by scripts/env-sync.js (${new Date().toISOString()}) ----\n`;
  const out =
    (targetText ? (targetText.endsWith('\n') ? targetText : `${targetText}\n`) : '') +
    banner +
    `${missingLines.join('\n')}\n`;

  fs.writeFileSync(targetPath, out);
  console.log(`Updated: ${targetPath} (+${missingLines.length} vars)`);
}

function main() {
  const root = process.cwd();
  syncEnv({
    examplePath: path.join(root, '.env.example'),
    targetPath: path.join(root, '.env'),
  });

  syncEnv({
    examplePath: path.join(root, 'bot', '.env.example'),
    targetPath: path.join(root, 'bot', '.env'),
  });
}

main();
