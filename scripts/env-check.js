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

function main() {
  const root = process.cwd();
  const rootResult = checkOne({
    name: 'Root env (.env)',
    examplePath: path.join(root, '.env.example'),
    envPath: path.join(root, '.env'),
    requiredKeys: ['DATABASE_URL', 'BOT_TOKEN'],
  });
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
