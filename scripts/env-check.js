const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function parseEnv(text) {
  const parsed = dotenv.parse(String(text || ''));
  return new Map(Object.entries(parsed));
}

function checkOne({ name, examplePath, envPath, requiredKeys = [], optionalRequiredKeys = [] }) {
  const exampleText = fs.readFileSync(examplePath, 'utf8');
  const example = parseEnv(exampleText);

  const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const env = parseEnv(envText);

  const missingKeys = [];
  const emptyRequired = [];
  const emptyOptional = [];

  for (const key of example.keys()) {
    if (!env.has(key)) missingKeys.push(key);
  }
  for (const key of requiredKeys) {
    const v = String(env.get(key) ?? '').trim();
    if (!v) emptyRequired.push(key);
  }
  for (const key of optionalRequiredKeys) {
    const v = String(env.get(key) ?? '').trim();
    if (!v) emptyOptional.push(key);
  }

  console.log(`\n${name}`);
  console.log(`- Example: ${examplePath}`);
  console.log(`- Env:     ${envPath}${fs.existsSync(envPath) ? '' : ' (missing file)'}`);
  console.log(`- Missing keys vs example: ${missingKeys.length}`);
  if (missingKeys.length) console.log(`  ${missingKeys.join(', ')}`);
  console.log(`- Empty required keys: ${emptyRequired.length}`);
  if (emptyRequired.length) console.log(`  ${emptyRequired.join(', ')}`);
  if (optionalRequiredKeys.length) {
    console.log(`- Empty optional keys: ${emptyOptional.length}`);
    if (emptyOptional.length) console.log(`  ${emptyOptional.join(', ')}`);
  }

  return {
    missingKeys,
    emptyRequired,
  };
}

function readInt(envMap, key) {
  const raw = String(envMap.get(key) ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function main() {
  const root = process.cwd();
  const rootResult = checkOne({
    name: 'Root env (.env)',
    examplePath: path.join(root, '.env.example'),
    envPath: path.join(root, '.env'),
    requiredKeys: ['DATABASE_URL', 'BOT_TOKEN'],
  });
  // Extra sanity checks that help avoid "Mini App not loading" footguns.
  try {
    const envPath = path.join(root, '.env');
    const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const env = parseEnv(envText);
    const proxyPort = readInt(env, 'MINIAPP_PROXY_PORT');
    const targetPort = readInt(env, 'MINIAPP_TARGET_PORT');
    if (proxyPort != null && targetPort != null && proxyPort === targetPort) {
      console.log('\nMini App sanity');
      console.log(
        `- MINIAPP_TARGET_PORT (${targetPort}) must not equal MINIAPP_PROXY_PORT (${proxyPort}); set MINIAPP_TARGET_PORT to your backend PORT (default 3004).`
      );
      rootResult.emptyRequired.push('MINIAPP_TARGET_PORT');
    }
  } catch {
    // ignore
  }

  const botResult = checkOne({
    name: 'Bot env (bot/.env)',
    examplePath: path.join(root, 'bot', '.env.example'),
    envPath: path.join(root, 'bot', '.env'),
    optionalRequiredKeys: ['BOT_TOKEN'],
  });

  const shouldFail =
    rootResult.missingKeys.length ||
    rootResult.emptyRequired.length ||
    botResult.missingKeys.length ||
    botResult.emptyRequired.length;
  if (shouldFail) {
    process.exitCode = 1;
  }
}

main();
