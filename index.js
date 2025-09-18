// Discord Loot Poll Bot — Throne & Liberty (Google Sheets + Categories + Presets + Vote Limits)
// ------------------------------------------------------------------------------------
// NEW in this version
// - Presets: preload items per boss from a "Presets" sheet (supports all T3 World Bosses & Archbosses)
// - Slots: armor/accessory items can specify a slot (helmet, chest, cloak, gloves, pants, boots, accessory)
// - Vote limits:
//    • Main PvP weapons: max 2 votes per user
//    • Main PvE weapons: max 2 votes per user
//    • Main PvP armor slots (helmet, chest, cloak, gloves, pants, boots): max 1 vote per slot per user
//    • Accessory: max 1 vote (any accessory) per user
// - New command: /poll preset boss:<name> type:<world_boss|archboss> mode:<main_pvp|main_pve|offspec>
//   -> Creates a poll and auto-loads its items (Weapon/Armor/Accessory + optional slot) from Presets.
//
// Google Sheet tabs structure (add this 4th tab):
//   • Polls: id, guild_id, name, is_open, expires_at, type, mode
//   • Items: id, poll_id, name, name_lc, category, slot
//   • Votes: poll_id, item_id, user_id
//   • Presets: boss, type, item, category, slot   (type: world_boss|archboss; category: weapon|armor|accessory; slot optional)
//     Example rows:
//       Kazar,world_boss,Stormbreaker Halberd,weapon,
//       Kazar,world_boss,Warlord’s Mail,armor,chest
//       Kazar,world_boss,Amber Signet,accessory,accessory
//
// NOTE: You can bulk-maintain the Presets tab (CSV paste) so we don’t hardcode loot tables.

import 'dotenv/config'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  InteractionType,
  ChannelType,
} from 'discord.js'
import { google } from 'googleapis'

// ---------- ENV ----------
const TOKEN = process.env.DISCORD_BOT_TOKEN
const CLIENT_ID = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID
const ADMIN_ROLE_NAME = process.env.LOOT_ADMIN_ROLE || 'Loot Admin'
const SPREADSHEET_ID = process.env.SPREADSHEET_ID
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL
let GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY
if (GOOGLE_PRIVATE_KEY && !GOOGLE_PRIVATE_KEY.includes('BEGIN PRIVATE KEY')) {
  GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
}
if (!TOKEN || !CLIENT_ID || !SPREADSHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error('Missing required env vars: TOKEN, CLIENT_ID, SPREADSHEET_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY')
  process.exit(1)
}

// ---------- Google Sheets Client ----------
const auth = new google.auth.JWT({
  email: GOOGLE_CLIENT_EMAIL,
  key: GOOGLE_PRIVATE_KEY,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
})
const sheets = google.sheets({ version: 'v4', auth })

// Sheet names
const SHEET_POLLS = 'Polls'
const SHEET_ITEMS = 'Items'
const SHEET_VOTES = 'Votes'
const SHEET_PRESETS = 'Presets'

// Ensure headers exist
async function ensureHeaders() {
  const headers = {
    [SHEET_POLLS]: ['id','guild_id','name','is_open','expires_at','type','mode'],
    [SHEET_ITEMS]: ['id','poll_id','name','name_lc','category','slot'],
    [SHEET_VOTES]: ['poll_id','item_id','user_id'],
    [SHEET_PRESETS]: ['boss','type','item','category','slot'],
  }
  for (const [tab, cols] of Object.entries(headers)) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!1:1` }).catch(()=>({data:{}}))
    const row = res.data.values?.[0] || []
    if (row.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${tab}!A1:${String.fromCharCode(64+cols.length)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [cols] },
      })
    }
  }
}

function idxMap(header) {
  const m = new Map()
  header.forEach((h,i)=>m.set(h,i))
  return m
}

async function readSheet(tab) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A:Z` })
  const values = res.data.values || []
  if (values.length === 0) return { header: [], rows: [] }
  const header = values[0]
  const rows = values.slice(1)
  return { header, rows }
}

async function appendRows(tab, rows) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tab}!A:Z`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  })
}

async function overwriteRows(tab, header, rows) {
  const width = header.length
  const endCol = String.fromCharCode(64 + width)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tab}!A1:${endCol}${rows.length + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [header, ...rows] },
  })
}

// ---------- Data Access Layer ----------
const TYPES = ['world_boss','archboss']
const MODES = ['main_pvp','main_pve','offspec']
const CATS = ['weapon','armor','accessory']
const SLOTS = ['helmet','chest','cloak','gloves','pants','boots','accessory','']

async function nextId(tab) {
  const { header, rows } = await readSheet(tab)
  const m = idxMap(header)
  const idIdx = m.get('id')
  if (idIdx == null) return 1
  let max = 0
  for (const r of rows) {
    const v = parseInt(r[idIdx] || '0', 10)
    if (v > max) max = v
  }
  return max + 1
}

async function createPoll({ guild_id, name, expires_at=null, type, mode }) {
  const id = await nextId(SHEET_POLLS)
  await appendRows(SHEET_POLLS, [[String(id), guild_id, name, '1', expires_at?String(expires_at):'', type, mode]])
  return { id, guild_id, name, is_open:1, expires_at, type, mode }
}

async function listPolls(guild_id) {
  const { header, rows } = await readSheet(SHEET_POLLS)
  const m = idxMap(header)
  return rows
    .filter(r => r[m.get('guild_id')] === guild_id)
    .map(r => ({
      id: parseInt(r[m.get('id')],10),
      guild_id: r[m.get('guild_id')],
      name: r[m.get('name')],
      is_open: parseInt(r[m.get('is_open')]||'0',10),
      expires_at: r[m.get('expires_at')]? parseInt(r[m.get('expires_at')],10): null,
      type: r[m.get('type')],
      mode: r[m.get('mode')],
    }))
    .sort((a,b)=>b.id-a.id)
}

async function getPollById(id) {
  const { header, rows } = await readSheet(SHEET_POLLS)
  const m = idxMap(header)
  for (const r of rows) {
    if (parseInt(r[m.get('id')],10) === Number(id)) {
      return {
        id: Number(id),
        guild_id: r[m.get('guild_id')],
        name: r[m.get('name')],
        is_open: parseInt(r[m.get('is_open')]||'0',10),
        expires_at: r[m.get('expires_at')]? parseInt(r[m.get('expires_at')],10): null,
        type: r[m.get('type')],
        mode: r[m.get('mode')],
      }
    }
  }
  return null
}

async function getPollByName(guild_id, name) {
  const all = await listPolls(guild_id)
  return all.find(p => p.name.toLowerCase() === name.toLowerCase()) || null
}

async function setPollClosed(id) {
  const { header, rows } = await readSheet(SHEET_POLLS)
  const m = idxMap(header)
  for (const r of rows) {
    if (parseInt(r[m.get('id')],10) === Number(id)) {
      r[m.get('is_open')] = '0'
      break
    }
  }
  await overwriteRows(SHEET_POLLS, header, rows)
}

async function wipePoll(id) {
  let pr = await readSheet(SHEET_POLLS)
  let pm = idxMap(pr.header)
  pr.rows = pr.rows.filter(r => parseInt(r[pm.get('id')],10) !== Number(id))
  await overwriteRows(SHEET_POLLS, pr.header, pr.rows)
  let ir = await readSheet(SHEET_ITEMS)
  let im = idxMap(ir.header)
  const itemIds = new Set(
    ir.rows.filter(r => parseInt(r[im.get('poll_id')],10) === Number(id)).map(r => parseInt(r[im.get('id')],10))
  )
  ir.rows = ir.rows.filter(r => parseInt(r[im.get('poll_id')],10) !== Number(id))
  await overwriteRows(SHEET_ITEMS, ir.header, ir.rows)
  let vr = await readSheet(SHEET_VOTES)
  let vm = idxMap(vr.header)
  vr.rows = vr.rows.filter(r => parseInt(r[vm.get('poll_id')],10) !== Number(id) && !itemIds.has(parseInt(r[vm.get('item_id')],10)))
  await overwriteRows(SHEET_VOTES, vr.header, vr.rows)
}

async function upsertItem(poll_id, name, category, slot='') {
  const id = await nextId(SHEET_ITEMS)
  await appendRows(SHEET_ITEMS, [[String(id), String(poll_id), name, name.toLowerCase(), category, slot]])
  return { id, poll_id, name, name_lc: name.toLowerCase(), category, slot }
}

async function getItems(poll_id) {
  const { header, rows } = await readSheet(SHEET_ITEMS)
  const m = idxMap(header)
  return rows
    .filter(r => parseInt(r[m.get('poll_id')],10) === Number(poll_id))
    .map(r => ({
      id: parseInt(r[m.get('id')],10),
      poll_id: parseInt(r[m.get('poll_id')],10),
      name: r[m.get('name')],
      name_lc: r[m.get('name_lc')],
      category: r[m.get('category')],
      slot: r[m.get('slot')]||'',
    }))
    .sort((a,b)=> a.name.localeCompare(b.name))
}

async function getItemByName(poll_id, itemName) {
  const items = await getItems(poll_id)
  const lc = itemName.toLowerCase()
  return items.find(i => i.name_lc === lc) || null
}

async function vote(poll_id, item_id, user_id) {
  const { header, rows } = await readSheet(SHEET_VOTES)
  const m = idxMap(header)
  const exists = rows.some(r => parseInt(r[m.get('poll_id')],10)===Number(poll_id) && parseInt(r[m.get('item_id')],10)===Number(item_id) && r[m.get('user_id')]===(user_id))
  if (!exists) await appendRows(SHEET_VOTES, [[String(poll_id), String(item_id), user_id]])
}

async function unvote(poll_id, item_id, user_id) {
  const { header, rows } = await readSheet(SHEET_VOTES)
  const m = idxMap(header)
  const newRows = rows.filter(r => !(parseInt(r[m.get('poll_id')],10)===Number(poll_id) && parseInt(r[m.get('item_id')],10)===Number(item_id) && r[m.get('user_id')]===(user_id)))
  if (newRows.length !== rows.length) await overwriteRows(SHEET_VOTES, header, newRows)
}

async function clearVotesForUser(poll_id, user_id) {
  const { header, rows } = await readSheet(SHEET_VOTES)
  const m = idxMap(header)
  const newRows = rows.filter(r => !(parseInt(r[m.get('poll_id')],10)===Number(poll_id) && r[m.get('user_id')]===(user_id)))
  const removed = rows.length - newRows.length
  if (removed) await overwriteRows(SHEET_VOTES, header, newRows)
  return removed
}

async function removeVoteForUserItem(poll_id, item_id, user_id) {
  const { header, rows } = await readSheet(SHEET_VOTES)
  const m = idxMap(header)
  const newRows = rows.filter(r => !(parseInt(r[m.get('poll_id')],10)===Number(poll_id) && parseInt(r[m.get('item_id')],10)===Number(item_id) && r[m.get('user_id')]===(user_id)))
  const removed = rows.length - newRows.length
  if (removed) await overwriteRows(SHEET_VOTES, header, newRows)
  return removed
}

async function countVotesForItem(poll_id, item_id) {
  const { header, rows } = await readSheet(SHEET_VOTES)
  const m = idxMap(header)
  return rows.filter(r => parseInt(r[m.get('poll_id')],10)===Number(poll_id) && parseInt(r[m.get('item_id')],10)===Number(item_id)).length
}

async function votersForItem(poll_id, item_id) {
  const { header, rows } = await readSheet(SHEET_VOTES)
  const m = idxMap(header)
  return rows.filter(r => parseInt(r[m.get('poll_id')],10)===Number(poll_id) && parseInt(r[m.get('item_id')],10)===Number(item_id)).map(r => r[m.get('user_id')])
}

async function getUserVotesDetailed(poll_id, user_id) {
  const votes = await readSheet(SHEET_VOTES)
  const vm = idxMap(votes.header)
  const mine = votes.rows.filter(r => parseInt(r[vm.get('poll_id')],10)===Number(poll_id) && r[vm.get('user_id')] === user_id)
  const items = await getItems(poll_id)
  const itemMap = new Map(items.map(i=>[i.id, i]))
  return mine.map(r => ({
    item_id: parseInt(r[vm.get('item_id')],10),
    item: itemMap.get(parseInt(r[vm.get('item_id')],10))
  })).filter(v => !!v.item)
}

// ---------- Vote Limit Logic ----------
// Rules requested:
// - Two votes per user for Main PvP weapons
// - Two votes per user for Main PvE weapons
// - One vote per slot (helmet, chest, cloak, gloves, pants, boots) for Main PvP armor
// - One vote total for accessory (any mode? request specified "one vote for accessory"; we'll apply globally per poll)
function isWeapon(it){ return it.category === 'weapon' }
function isArmor(it){ return it.category === 'armor' }
function isAccessory(it){ return it.category === 'accessory' }
const ARMOR_SLOTS = ['helmet','chest','cloak','gloves','pants','boots']

// scope: 'poll' (current behavior), 'guild' (all polls), 'guild+mode' (all polls with same mode)
async function checkVoteAllowed(poll, user_id, item, scope = 'poll') {
  let mine;

  if (scope === 'poll') {
    mine = await getUserVotesDetailed(poll.id, user_id);
  } else {
    const scopedVotes = await getUserVotesAcrossGuild(poll.guild_id, {
      sameMode: scope === 'guild+mode' ? poll.mode : null,
      onlyOpen: true,
      user_id // <- we’ll add this to the helper signature in a second
    });
    // Normalize to { item } shape like getUserVotesDetailed
    mine = scopedVotes.map(v => ({ item: v.item }));
  }

  const isWeapon = (it) => it.category === 'weapon';
  const isArmor  = (it) => it.category === 'armor';
  const isAccessory = (it) => it.category === 'accessory';
  const ARMOR_SLOTS = ['helmet','chest','cloak','gloves','pants','boots'];

  if (isWeapon(item)) {
    if (poll.mode === 'main_pvp' || poll.mode === 'main_pve') {
      const count = mine.filter(v => v.item.category === 'weapon').length;
      const limit = 2;
      if (count >= limit) return { ok:false, reason:`Limit reached: ${limit} ${poll.mode==='main_pvp'?'Main PvP':'Main PvE'} weapons` };
    }
  } else if (isArmor(item)) {
    if (poll.mode === 'main_pvp') {
      const slot = (item.slot||'').toLowerCase();
      if (ARMOR_SLOTS.includes(slot)) {
        const has = mine.some(v => v.item.category==='armor' && (v.item.slot||'').toLowerCase()===slot);
        if (has) return { ok:false, reason:`Limit 1 per ${slot} in Main PvP` };
      }
    }
  } else if (isAccessory(item)) {
    const count = mine.filter(v => v.item.category==='accessory').length;
    if (count >= 1) return { ok:false, reason:'Limit 1 accessory' };
  }
  return { ok:true };
}


// ---------- Presets ----------
async function loadPresetItems({ boss, type }) {
  const { header, rows } = await readSheet(SHEET_PRESETS)
  const m = idxMap(header)
  const out = []
  for (const r of rows) {
    if (!r.length) continue
    const bossName = (r[m.get('boss')]||'').trim().toLowerCase()
    const rowType = (r[m.get('type')]||'').trim().toLowerCase()
    if (bossName === boss.trim().toLowerCase() && rowType === type) {
      out.push({
        item: r[m.get('item')],
        category: (r[m.get('category')]||'').toLowerCase(),
        slot: (r[m.get('slot')]||'').toLowerCase(),
      })
    }
  }
  return out
}

// ---------- Helpers ----------
function isAdmin(member) {
  if (!member) return false
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true
  if (member.id === member.guild?.ownerId) return true
  return member.roles?.cache?.some(r => r.name === ADMIN_ROLE_NAME)
}

async function resolvePoll(guildId, idOrName) {
  const byId = Number(idOrName)
  if (!Number.isNaN(byId)) {
    const p = await getPollById(byId)
    if (p && p.guild_id === guildId) return p
  }
  return await getPollByName(guildId, idOrName)
}

function pollEmbed(poll, items) {
  const title = `Loot Poll: ${poll.name} — ${labelType(poll.type)} • ${labelMode(poll.mode)} ${poll.is_open ? '' : '(closed)'}`
  const fields = []
  for (const cat of CATS) {
    const group = items.filter(i=>i.category===cat)
    if (!group.length) continue
    const lines = group.map(it => `• ${it.name}${it.slot?` (${it.slot})`:''} — ${it._count} vote${it._count===1?'':'s'}`)
    fields.push({ name: labelCat(cat), value: lines.join('\n'), inline: true })
  }
  if (!fields.length) fields.push({ name: 'No items yet', value: 'Use /poll add or /poll preset to add loot.' })
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(poll.expires_at ? `Expires: <t:${Math.floor(poll.expires_at/1000)}:R>` : 'No expiry')
    .addFields(fields)
    .setFooter({ text: `Poll ID: ${poll.id}` })
}

function labelType(t){ return t==='archboss' ? 'Archboss' : 'World Boss' }
function labelMode(m){ return m==='main_pve' ? 'Main PvE' : m==='offspec' ? 'offspec' : 'Main PvP' }
function labelCat(c){ return c==='weapon' ? 'Weapons' : c==='armor' ? 'Armor' : 'Accessories' }
function chunk(arr, n){ const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out }

function buildButtons(items) {
  const rows = []
  for (const cat of CATS) {
    const group = items.filter(i=>i.category===cat)
    if (!group.length) continue
    const groups = chunk(group, 5)
    for (const g of groups) {
      rows.push(new ActionRowBuilder().addComponents(
        ...g.map(it => new ButtonBuilder()
          .setCustomId(`vote:${it.id}`)
          .setLabel(it.slot ? `${it.name} (${it.slot})` : it.name)
          .setStyle(ButtonStyle.Secondary)
        )
      ))
    }
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin:panel').setLabel('Admin Panel').setStyle(ButtonStyle.Danger)
  ))
  return rows
}

async function upsertPollMessage(channel, poll) {
  const items = await getItems(poll.id)
  for (const it of items) it._count = await countVotesForItem(poll.id, it.id)
  const embed = pollEmbed(poll, items)
  const components = buildButtons(items)
  const msgs = await channel.messages.fetch({ limit: 50 }).catch(()=>null)
  const existing = msgs?.find(m => m.author.id === channel.client.user.id && m.embeds[0]?.footer?.text?.includes(`Poll ID: ${poll.id}`))
  if (existing) return existing.edit({ embeds:[embed], components })
  return channel.send({ embeds:[embed], components })
}

// ---------- Commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create/manage loot polls')
    .addSubcommand(sc=> sc.setName('create').setDescription('Create a new poll')
      .addStringOption(o=>o.setName('name').setDescription('Poll name').setRequired(true))
      .addStringOption(o=>o.setName('type').setDescription('Boss type').addChoices(
        {name:'World Boss', value:'world_boss'},
        {name:'Archboss', value:'archboss'},
      ).setRequired(true))
      .addStringOption(o=>o.setName('mode').setDescription('Mode').addChoices(
        {name:'Main PvP', value:'main_pvp'},
        {name:'Main PvE', value:'main_pve'},
        {name:'Fun PvP', value:'offspec'},
      ).setRequired(true))
      .addIntegerOption(o=>o.setName('expires_hours').setDescription('Auto-close after N hours'))
    )
    .addSubcommand(sc=> sc.setName('add').setDescription('Add an item to a poll')
      .addStringOption(o=>o.setName('poll').setDescription('Poll ID or name').setRequired(true))
      .addStringOption(o=>o.setName('item').setDescription('Item name').setRequired(true))
      .addStringOption(o=>o.setName('category').setDescription('Category').addChoices(
        {name:'Weapon', value:'weapon'},
        {name:'Armor', value:'armor'},
        {name:'Accessory', value:'accessory'},
      ).setRequired(true))
      .addStringOption(o=>o.setName('slot').setDescription('Slot (armor/accessory)').addChoices(
        {name:'Helmet', value:'helmet'},
        {name:'Chest', value:'chest'},
        {name:'Cloak', value:'cloak'},
        {name:'Gloves', value:'gloves'},
        {name:'Pants', value:'pants'},
        {name:'Boots', value:'boots'},
        {name:'Accessory', value:'accessory'},
      ))
    )
    .addSubcommand(sc=> sc.setName('preset').setDescription('Create a poll from a boss preset (loads items from sheet)')
      .addStringOption(o=>o.setName('boss').setDescription('Boss name, e.g. Kazar').setRequired(true))
      .addStringOption(o=>o.setName('type').setDescription('Boss type').addChoices(
        {name:'World Boss', value:'world_boss'},
        {name:'Archboss', value:'archboss'},
      ).setRequired(true))
      .addStringOption(o=>o.setName('mode').setDescription('Mode').addChoices(
        {name:'Main PvP', value:'main_pvp'},
        {name:'Main PvE', value:'main_pve'},
        {name:'Fun PvP', value:'offspec'},
      ).setRequired(true))
      .addStringOption(o=>o.setName('name').setDescription('Poll name override (optional)'))
      .addIntegerOption(o=>o.setName('expires_hours').setDescription('Auto-close after N hours'))
    )
    .addSubcommand(sc=> sc.setName('list').setDescription('List polls'))
    .addSubcommand(sc=> sc.setName('close').setDescription('Close a poll')
      .addStringOption(o=>o.setName('poll').setDescription('Poll ID or name').setRequired(true))
    )
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('vote')
    .setDescription('Vote for an item in a poll')
    .addStringOption(o=>o.setName('poll').setDescription('Poll ID or name').setRequired(true))
    .addStringOption(o=>o.setName('item').setDescription('Item name').setRequired(true).setAutocomplete(true))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('unvote')
    .setDescription('Remove your vote from an item')
    .addStringOption(o=>o.setName('poll').setDescription('Poll ID or name').setRequired(true))
    .addStringOption(o=>o.setName('item').setDescription('Item name').setRequired(true).setAutocomplete(true))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin tools for loot polls')
    .addSubcommand(sc=> sc.setName('removevote').setDescription('Remove a user\'s vote for an item')
      .addStringOption(o=>o.setName('poll').setDescription('Poll ID or name').setRequired(true))
      .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption(o=>o.setName('item').setDescription('Item name').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand(sc=> sc.setName('clearvotes').setDescription('Clear all votes for a user in a poll')
      .addStringOption(o=>o.setName('poll').setDescription('Poll ID or name').setRequired(true))
      .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true))
    )
    .addSubcommand(sc=> sc.setName('wipe').setDescription('Delete a poll and all data')
      .addStringOption(o=>o.setName('poll').setDescription('Poll ID or name').setRequired(true))
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
].map(c => c.toJSON())

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
})

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`)
  await ensureHeaders()
  const rest = new REST({ version: '10' }).setToken(TOKEN)
  const guilds = await c.guilds.fetch()
  for (const [, g] of guilds) {
    try {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, g.id), { body: commands })
      console.log(`Registered commands to guild ${g.name}`)
    } catch (e) {
      console.error('Failed to register commands for guild', g.id, e)
    }
  }
  setInterval(checkExpirations, 60 * 1000)
})

async function checkExpirations() {
  const all = await readSheet(SHEET_POLLS)
  const m = idxMap(all.header)
  const now = Date.now()
  const toClose = []
  all.rows.forEach(r => {
    const isOpen = (r[m.get('is_open')]||'0') === '1'
    const exp = r[m.get('expires_at')]? parseInt(r[m.get('expires_at')],10): null
    if (isOpen && exp && exp < now) toClose.push(parseInt(r[m.get('id')],10))
  })
  for (const id of toClose) {
    await setPollClosed(id)
    for (const [, guild] of client.guilds.cache) {
      const poll = await getPollById(id)
      if (!poll) continue
      const channel = guild.systemChannel || guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.viewable && ch.permissionsFor(guild.members.me).has(PermissionFlagsBits.SendMessages))
      if (channel && guild.id === poll.guild_id) {
        const items = await getItems(poll.id)
        for (const it of items) it._count = await countVotesForItem(poll.id, it.id)
        await channel.send({ content: `Poll **${poll.name}** expired.`, embeds:[pollEmbed(poll, items)] })
      }
    }
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
      return handleAutocomplete(interaction)
    }
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return

    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction
      if (commandName === 'poll') return handlePoll(interaction)
      if (commandName === 'vote') return handleVote(interaction)
      if (commandName === 'unvote') return handleUnvote(interaction)
      if (commandName === 'admin') return handleAdmin(interaction)
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('vote:')) return handleVoteButton(interaction)
      if (interaction.customId === 'admin:panel') return handleAdminPanel(interaction)
    }
  } catch (e) {
    console.error('Interaction error', e)
    const msg = { content: 'Something went wrong. Try again.', ephemeral: true }
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(()=>null)
    else await interaction.reply(msg).catch(()=>null)
  }
})

// ---------- Handlers ----------
async function handlePoll(inter) {
  const sub = inter.options.getSubcommand()
  const guildId = inter.guildId
  if (!guildId) return inter.reply({ content: 'Guild-only command.', ephemeral: true })

  if (sub === 'create') {
    const name = inter.options.getString('name', true).trim()
    const type = inter.options.getString('type', true)
    const mode = inter.options.getString('mode', true)
    const expiresHours = inter.options.getInteger('expires_hours')
    if (!isAdmin(inter.member)) return inter.reply({ content: 'Only admins can create polls.', ephemeral: true })
    if (!TYPES.includes(type) || !MODES.includes(mode)) return inter.reply({ content: 'Invalid type or mode.', ephemeral: true })

    let expires = null
    if (expiresHours && expiresHours > 0) expires = Date.now() + (expiresHours * 3600 * 1000)

    const exists = await getPollByName(guildId, name)
    if (exists) return inter.reply({ content: 'A poll with that name already exists.', ephemeral: true })

    const poll = await createPoll({ guild_id: guildId, name, expires_at: expires, type, mode })
    await inter.reply({ content: `Created poll **${poll.name}** (ID ${poll.id}).` })
    await upsertPollMessage(inter.channel, poll)
  }
  else if (sub === 'add') {
    const idOrName = inter.options.getString('poll', true)
    const itemName = inter.options.getString('item', true).trim()
    const category = inter.options.getString('category', true)
    const slot = inter.options.getString('slot') || ''
    if (!CATS.includes(category)) return inter.reply({ content: 'Category must be weapon, armor, or accessory.', ephemeral: true })
    if (slot && !SLOTS.includes(slot)) return inter.reply({ content: 'Invalid slot.', ephemeral: true })
    const poll = await resolvePoll(guildId, idOrName)
    if (!poll) return inter.reply({ content: 'Poll not found.', ephemeral: true })
    if (!isAdmin(inter.member)) return inter.reply({ content: 'Only admins can add items.', ephemeral: true })
    if (!poll.is_open) return inter.reply({ content: 'Poll is closed.', ephemeral: true })

    const existing = await getItemByName(poll.id, itemName)
    if (existing) return inter.reply({ content: 'That item already exists in this poll.', ephemeral: true })

    await upsertItem(poll.id, itemName, category, slot)
    await inter.reply({ content: `Added **${itemName}** (${labelCat(category)}${slot?` • ${slot}`:''}) to **${poll.name}**.` })
    await upsertPollMessage(inter.channel, poll)
  }
  else if (sub === 'preset') {
    if (!isAdmin(inter.member)) return inter.reply({ content: 'Only admins can create presets.', ephemeral: true })
    const boss = inter.options.getString('boss', true)
    const type = inter.options.getString('type', true)
    const mode = inter.options.getString('mode', true)
    const nameOverride = inter.options.getString('name')
    const expiresHours = inter.options.getInteger('expires_hours')

    if (!TYPES.includes(type) || !MODES.includes(mode)) return inter.reply({ content: 'Invalid type or mode.', ephemeral: true })

    const pollName = nameOverride || `${boss} — ${labelType(type)} • ${labelMode(mode)}`
    const exists = await getPollByName(guildId, pollName)
    if (exists) return inter.reply({ content: 'A poll with that name already exists.', ephemeral: true })

    let expires = null
    if (expiresHours && expiresHours > 0) expires = Date.now() + (expiresHours * 3600 * 1000)

    const poll = await createPoll({ guild_id: guildId, name: pollName, expires_at: expires, type, mode })
    const rows = await loadPresetItems({ boss, type })
    if (!rows.length) {
      await inter.reply({ content: `Created **${poll.name}** but found no preset rows for boss "${boss}" (${labelType(type)}). Add rows to the Presets tab.`, ephemeral: true })
      await upsertPollMessage(inter.channel, poll)
      return
    }
    for (const r of rows) {
      if (!CATS.includes(r.category)) continue
      const slot = (r.slot||'')
      await upsertItem(poll.id, r.item, r.category, slot)
    }
    await inter.reply({ content: `Created poll **${poll.name}** with ${rows.length} preset item(s).` })
    await upsertPollMessage(inter.channel, poll)
  }
  else if (sub === 'list') {
    const rows = await listPolls(guildId)
    if (!rows.length) return inter.reply({ content: 'No polls yet.' })
    const lines = rows.map(p => `• **${p.name}** (ID ${p.id}) — ${labelType(p.type)} • ${labelMode(p.mode)} — ${p.is_open? 'open':'closed'}${p.expires_at ? ` — expires <t:${Math.floor(p.expires_at/1000)}:R>`:''}`)
    return inter.reply({ content: lines.join('\n') })
  }
  else if (sub === 'close') {
    const idOrName = inter.options.getString('poll', true)
    const poll = await resolvePoll(guildId, idOrName)
    if (!poll) return inter.reply({ content: 'Poll not found.', ephemeral: true })
    if (!isAdmin(inter.member)) return inter.reply({ content: 'Only admins can close polls.', ephemeral: true })
    await setPollClosed(poll.id)
    const updated = { ...poll, is_open: 0 }
    await inter.reply({ content: `Closed poll **${poll.name}**.` })
    await upsertPollMessage(inter.channel, updated)
  }
}

async function handleVote(inter) {
  const guildId = inter.guildId
  const idOrName = inter.options.getString('poll', true)
  const itemName = inter.options.getString('item', true)
  const poll = await resolvePoll(guildId, idOrName)
  if (!poll) return inter.reply({ content: 'Poll not found.', ephemeral: true })
  if (!poll.is_open) return inter.reply({ content: 'Poll is closed.', ephemeral: true })
  const item = await getItemByName(poll.id, itemName)
  if (!item) return inter.reply({ content: 'Item not found in this poll.', ephemeral: true })

  const gate = await checkVoteAllowed(poll, inter.user.id, item, 'guild+mode')
  if (!gate.ok) return inter.reply({ content: `Cannot vote: ${gate.reason}`, ephemeral: true })

  await vote(poll.id, item.id, inter.user.id)
  await inter.reply({ content: `Voted for **${item.name}** in **${poll.name}**.`, ephemeral: true })
  await upsertPollMessage(inter.channel, poll)
}

async function handleUnvote(inter) {
  const guildId = inter.guildId
  const idOrName = inter.options.getString('poll', true)
  const itemName = inter.options.getString('item', true)
  const poll = await resolvePoll(guildId, idOrName)
  if (!poll) return inter.reply({ content: 'Poll not found.', ephemeral: true })
  const item = await getItemByName(poll.id, itemName)
  if (!item) return inter.reply({ content: 'Item not found in this poll.', ephemeral: true })

  await unvote(poll.id, item.id, inter.user.id)
  await inter.reply({ content: `Removed your vote from **${item.name}**.`, ephemeral: true })
  await upsertPollMessage(inter.channel, poll)
}

async function handleAdmin(inter) {
  if (!isAdmin(inter.member)) return inter.reply({ content: 'Admin only.', ephemeral: true })
  const sub = inter.options.getSubcommand()
  const guildId = inter.guildId
  const idOrName = inter.options.getString('poll', true)
  const poll = await resolvePoll(guildId, idOrName)
  if (!poll) return inter.reply({ content: 'Poll not found.', ephemeral: true })

  if (sub === 'clearvotes') {
    const user = inter.options.getUser('user', true)
    const removed = await clearVotesForUser(poll.id, user.id)
    await inter.reply({ content: `Cleared ${removed} vote(s) for ${user} in **${poll.name}**.` })
    await upsertPollMessage(inter.channel, poll)
  }
  else if (sub === 'removevote') {
    const user = inter.options.getUser('user', true)
    const itemName = inter.options.getString('item', true)
    const item = await getItemByName(poll.id, itemName)
    if (!item) return inter.reply({ content: 'Item not found in this poll.', ephemeral: true })
    const removed = await removeVoteForUserItem(poll.id, item.id, user.id)
    await inter.reply({ content: removed ? `Removed ${user}'s vote for **${item.name}**.` : `${user} had no vote on **${item.name}**.` })
    await upsertPollMessage(inter.channel, poll)
  }
  else if (sub === 'wipe') {
    await wipePoll(poll.id)
    await inter.reply({ content: `Deleted poll **${poll.name}**.` })
  }
}

async function handleVoteButton(inter) {
  const itemId = Number(inter.customId.split(':')[1])
  const poll = await getPollIdForItem(itemId)
  if (!poll) return inter.reply({ content: 'Poll not found (item may have been deleted).', ephemeral: true })
  if (!poll.is_open) return inter.reply({ content: 'Poll closed.', ephemeral: true })
  const item = (await getItems(poll.id)).find(i=>i.id===itemId)
  if (!item) return inter.reply({ content: 'Item not found.', ephemeral: true })

  const has = (await votersForItem(poll.id, item.id)).includes(inter.user.id)
  if (has) {
    await unvote(poll.id, item.id, inter.user.id)
    await inter.reply({ content: `Removed your vote from **${item.name}**.`, ephemeral: true })
  } else {
    const gate = await checkVoteAllowed(poll, inter.user.id, item, 'guild+mode')
    if (!gate.ok) return inter.reply({ content: `Cannot vote: ${gate.reason}`, ephemeral: true })
    await vote(poll.id, item.id, inter.user.id)
    await inter.reply({ content: `Voted for **${item.name}** in **${poll.name}**.`, ephemeral: true })
  }
  await upsertPollMessage(inter.channel, poll)
}

async function getPollIdForItem(itemId){
  const { header, rows } = await readSheet(SHEET_ITEMS)
  const m = idxMap(header)
  for (const r of rows) {
    if (parseInt(r[m.get('id')],10) === Number(itemId)) {
      const poll_id = parseInt(r[m.get('poll_id')],10)
      return await getPollById(poll_id)
    }
  }
  return null
}

async function handleAdminPanel(inter) {
  if (!isAdmin(inter.member)) return inter.reply({ content: 'Admin only.', ephemeral: true })
  const embed = new EmbedBuilder().setTitle('Loot Poll Admin Panel').setDescription('Use /poll preset to load boss loot, then /admin tools to manage votes.')
  await inter.reply({ embeds:[embed], ephemeral: true })
}

async function handleAutocomplete(inter) {
  const cmd = inter.commandName
  const guildId = inter.guildId
  const pollArg = inter.options.getString('poll')
  const entered = (inter.options.getFocused() || '').toLowerCase()
  const poll = pollArg ? await resolvePoll(guildId, pollArg) : null
  if (!poll) return inter.respond([])
  const items = await getItems(poll.id)
  const choices = items
    .filter(i => `${i.name}${i.slot?` (${i.slot})`:''}`.toLowerCase().includes(entered))
    .slice(0, 25)
    .map(i => ({ name: `${labelCat(i.category)} • ${i.name}${i.slot?` (${i.slot})`:''}`, value: i.name }))
  await inter.respond(choices)
}

async function getUserVotesAcrossGuild(guild_id, { sameMode = null, onlyOpen = true, user_id }) {
  const polls = await listPolls(guild_id);
  const scope = polls.filter(p => (!onlyOpen || p.is_open) && (sameMode ? p.mode === sameMode : true));

  const votes = await readSheet(SHEET_VOTES);
  const vm = idxMap(votes.header);

  const out = [];
  for (const p of scope) {
    const mine = votes.rows.filter(r =>
      parseInt(r[vm.get('poll_id')],10) === Number(p.id) &&
      r[vm.get('user_id')] === user_id
    );
    if (!mine.length) continue;

    const items = await getItems(p.id);
    const itemMap = new Map(items.map(i => [i.id, i]));
    for (const r of mine) {
      const itemId = parseInt(r[vm.get('item_id')],10);
      const item = itemMap.get(itemId);
      if (item) out.push({ poll: p, item });
    }
  }
  return out;
}



client.login(TOKEN)

