import 'dotenv/config'

function requireEnv(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env: ${name}`)
  return v
}

const GOOGLE_PRIVATE_KEY_RAW = requireEnv('GOOGLE_PRIVATE_KEY')
export const ENV = {
  DISCORD_USER_ID: process.env.DISCORD_USER_ID || '',
  TOKEN: requireEnv('DISCORD_BOT_TOKEN'),
  CLIENT_ID: process.env.CLIENT_ID || requireEnv('DISCORD_CLIENT_ID'),
  SPREADSHEET_ID: requireEnv('SPREADSHEET_ID'),
  GOOGLE_CLIENT_EMAIL: requireEnv('GOOGLE_CLIENT_EMAIL'),
  GOOGLE_PRIVATE_KEY: GOOGLE_PRIVATE_KEY_RAW.includes('BEGIN PRIVATE KEY')
    ? GOOGLE_PRIVATE_KEY_RAW
    : GOOGLE_PRIVATE_KEY_RAW.replace(/\\n/g, '\n'),
  ADMIN_ROLE_NAME: process.env.LOOT_ADMIN_ROLE || 'Loot Admin',
  POLL_CHANNEL_ID: process.env.MAIN_LOOT_POLL_CHANNEL_ID || '',
  POLL_CHANNEL_NAME: process.env.MAIN_LOOT_POLL_CHANNEL_NAME || 'main-loot-poll',
  LOOT_COUNCIL_ROLES: (process.env.LOOT_COUNCIL_ROLES || 'Guild Leader,Advisor,Officer')
    .split(',').map(s=>s.trim()).filter(Boolean),
  DJS_DEBUG: !!process.env.DJS_DEBUG,
}
