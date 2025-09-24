import 'dotenv/config'
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events,
  GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, EmbedBuilder, InteractionType, ChannelType,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  MessageFlags,                         
} from 'discord.js'
import * as pollsRepo from './src/data/pollsRepo.js'
import * as itemsRepo from './src/data/itemsRepo.js'
import * as votesRepo from './src/data/votesRepo.js'
import { sheets, readSheet, appendRows, overwriteRows, idxMap } from './src/infra/sheets.js'


process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  // In production you typically exit and let a process manager (pm2/systemd) restart:
  // setTimeout(() => process.exit(1), 1000);
});

process.on('warning', (warning) => {
  console.warn('[node warning]', warning);
});

// ---------- ENV ----------
const DISCORD_USER_ID = process.env.DISCORD_USER_ID
const TOKEN = process.env.DISCORD_BOT_TOKEN
const CLIENT_ID = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID
const ADMIN_ROLE_NAME = process.env.LOOT_ADMIN_ROLE || 'Loot Admin'
const SPREADSHEET_ID = process.env.SPREADSHEET_ID
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL
const POLL_CHANNEL_ID   = process.env.MAIN_LOOT_POLL_CHANNEL_ID || ''
const POLL_CHANNEL_NAME = process.env.MAIN_LOOT_POLL_CHANNEL_NAME || 'main-loot-poll'

function getPollChannel(guild) {
  // Prefer explicit ID
  if (POLL_CHANNEL_ID) {
    const byId = guild.channels.cache.get(POLL_CHANNEL_ID)
    if (byId?.isTextBased?.() && byId.viewable) return byId
  }
  // Fallback by name
  const byName = guild.channels.cache.find(
    ch => ch.type === ChannelType.GuildText && ch.name === POLL_CHANNEL_NAME && ch.viewable
  )
  return byName || guild.systemChannel || null
}


let GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY
if (GOOGLE_PRIVATE_KEY && !GOOGLE_PRIVATE_KEY.includes('BEGIN PRIVATE KEY')) {
  GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
}
if (!TOKEN || !CLIENT_ID || !SPREADSHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error('Missing required env vars: TOKEN, CLIENT_ID, SPREADSHEET_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY')
  process.exit(1)
}

// Sheet names
const SHEET_POLLS = 'Polls'
const SHEET_ITEMS = 'Items'
const SHEET_VOTES = 'Votes'
const SHEET_PRESETS = 'Presets'
const SHEET_COUNCIL_POLLS   = 'CouncilPolls'
const SHEET_COUNCIL_CAND    = 'CouncilCandidates'
const SHEET_COUNCIL_VOTES   = 'CouncilVotes'


// Ensure headers exist
async function ensureHeaders() {
  const headers = {
    [SHEET_POLLS]: ['id','guild_id','name','is_open','expires_at','type','mode'],
    [SHEET_ITEMS]: ['id','poll_id','name','name_lc','category','slot'],
    [SHEET_VOTES]: ['poll_id','item_id','user_id','user_name','mode','created_at'],
    [SHEET_PRESETS]: ['boss','type','item','category','slot'],
    [SHEET_COUNCIL_POLLS]: ['id','guild_id','item_name','mode','winners_needed','is_open','channel_id','created_by','created_at'],
    [SHEET_COUNCIL_CAND]:  ['id','council_poll_id','user_id','user_name'],
    [SHEET_COUNCIL_VOTES]: ['council_poll_id','candidate_user_id','voter_user_id','voter_name','created_at'],
  }

  for (const [tab, wantCols] of Object.entries(headers)) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${tab}!1:1`
    }).catch(()=>({data:{}}))

    const have = res.data.values?.[0] || []
    if (have.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${tab}!A1:${String.fromCharCode(64+wantCols.length)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [wantCols] },
      })
      continue
    }

    // Upgrade header if any columns are missing (esp. Votes.mode/created_at)
    const missing = wantCols.filter(c => !have.includes(c))
    if (missing.length) {
      const newHeader = have.concat(missing)
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${tab}!A1:${String.fromCharCode(64+newHeader.length)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [newHeader] },
      })
    }
  }
}


// ---------- Data Access Layer ----------
const TYPES = ['world_boss','archboss']
const MODES = ['main_pvp','main_pve','offspec']
const CATS = ['weapon','armor','accessory']
const SLOTS = [
  "belt",
  "boots",
  "bracelet",
  "cape",
  "chest",
  "dagger",
  "earring",
  "gloves",
  "gs",
  "head",
  "lb",
  "neck",
  "orb",
  "pants",
  "ring",
  "sns",
  "spear",
  "staff",
  "wand",
  "xb"
]

const SLOT_SYNONYMS = { head: 'helmet', cape: 'cloak' }
function normalizeSlotCode(s) {
  const v = (s || '').toLowerCase().trim()
  return SLOT_SYNONYMS[v] || v
}

const SLOT_LABELS = {
  belt:'Belt', boots:'Boots', bracelet:'Bracelet', cape:'Cape', chest:'Chest',
  dagger:'Dagger', earring:'Earring', gloves:'Gloves', gs:'Greatsword',
  head:'Helmet', lb:'Longbow', neck:'Necklace', orb:'Orb', pants:'Pants',
  ring:'Ring', sns:'Sword & Shield', spear:'Spear', staff:'Staff', wand:'Wand', xb:'Crossbow'
};
function labelSlot(s){ return SLOT_LABELS[s] || s; }

function labelType(t){
  return t === 'archboss' ? 'Archboss'
       : t === 'world_boss' ? 'World Boss'
       : 'Mixed';
}

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

async function getUserVotesAcrossGuildByMode(guild_id, user_id, mode, { onlyOpen = true } = {}) {
  const polls = await pollsRepo.listPolls(guild_id)
  const scope = polls.filter(p => !onlyOpen || p.is_open)
  const votes = await readSheet(SHEET_VOTES)
  const vm = idxMap(votes.header)
  const out = []

  for (const p of scope) {
    const mine = votes.rows.filter(r =>
      parseInt(r[vm.get('poll_id')],10) === Number(p.id) &&
      r[vm.get('user_id')] === user_id &&
      (!vm.has('mode') || r[vm.get('mode')] === mode)
    )
    if (!mine.length) continue
    const items = await itemsRepo.getItems(p.id)
    const itemMap = new Map(items.map(i => [i.id, i]))
    for (const r of mine) {
      const itemId = parseInt(r[vm.get('item_id')],10)
      const item = itemMap.get(itemId)
      if (item) out.push({ poll: p, item })
    }
  }
  return out
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

async function vote(poll_id, item_id, user_id, user_name= '') {
  const { header, rows } = await readSheet(SHEET_VOTES)
  const m = idxMap(header)
  const exists = rows.some(r => parseInt(r[m.get('poll_id')],10)===Number(poll_id) && parseInt(r[m.get('item_id')],10)===Number(item_id) && r[m.get('user_id')]===(user_id))
   if (!exists) {
    const values = [String(poll_id), String(item_id), user_id]
    if (m.has('user_name')) values.push(user_name || '')
    await appendRows(SHEET_VOTES, [values])
  }
}

async function unvote(poll_id, item_id, user_id) {
  const { header, rows } = await readSheet(SHEET_VOTES)
  const m = idxMap(header)
  const newRows = rows.filter(r => !(parseInt(r[m.get('poll_id')],10)===Number(poll_id) && parseInt(r[m.get('item_id')],10)===Number(item_id) && r[m.get('user_id')]===(user_id)))
  if (newRows.length !== rows.length) await overwriteRows(SHEET_VOTES, header, newRows)
}

async function getUserVotesDetailed(poll_id, user_id) {
  const votes = await readSheet(SHEET_VOTES)
  const vm = idxMap(votes.header)
  const mine = votes.rows.filter(r => parseInt(r[vm.get('poll_id')],10)===Number(poll_id) && r[vm.get('user_id')] === user_id)
  const items = await itemsRepo.getItems(poll_id)
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
const WEAPON_TYPES = ['gs','lb','xb','sns','dagger','spear','staff','wand','orb']
const ARMOR_SLOTS_LIMITED = ['cloak','helmet','chest','pants','boots','gloves']
const ACCESSORY_SLOTS = ['ring','neck','earring','bracelet']

function normalizeSlotForLimits(s) {
  const v = normalizeSlotCode(s)
  // normalize to the names used in limits
  if (v === 'head') return 'helmet'
  if (v === 'cape') return 'cloak'
  return v
}

function labelMode(m){ return m==='main_pve' ? 'Main PvE' : m==='offspec' ? 'Off‑spec' : 'Main PvP' }
function labelModeLong(m) { return labelMode(m) } // alias; used in replies


async function checkVoteAllowedByMode(poll, user_id, item, voteMode) {
  const mine = await getUserVotesAcrossGuildByMode(poll.guild_id, user_id, voteMode, { onlyOpen: true })
  const slot = normalizeSlotForLimits(item.slot || '')

  // ---- Weapons: 2 per mode (PvP, PvE, Off-spec) ----
  if (item.category === 'weapon') {
    const myWeapons = mine.filter(v => v.item.category === 'weapon')
    const totalLimit = 2
    if (myWeapons.length >= totalLimit) {
      return { ok:false, reason: `Limit reached: ${totalLimit} ${labelModeLong(voteMode)} weapon${totalLimit>1?'s':''}` }
    }
    return { ok:true }
  }

  // ---- Armor: 1 per slot per mode ----
  if (item.category === 'armor') {
    const s = slot
    const countSame = mine.filter(v => v.item.category==='armor' && normalizeSlotForLimits(v.item.slot)===s).length
    const limit = 1
    if (countSame >= limit) return { ok:false, reason: `Limit ${limit} ${labelSlot(s)} in ${labelModeLong(voteMode)}` }
    return { ok:true }
  }

  // ---- Accessories: Earrings = 2 per mode; others = 1 per mode ----
  if (item.category === 'accessory') {
    const s = slot
    const countSame = mine.filter(v => v.item.category==='accessory' && normalizeSlotForLimits(v.item.slot)===s).length
    const limit = (s === 'earring') ? 2 : 1
    if (countSame >= limit) {
      return { ok:false, reason: `Limit ${limit} ${labelSlot(s)}${limit>1?'s':''} in ${labelModeLong(voteMode)}` }
    }
    return { ok:true }
  }

  return { ok:true }
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

async function loadPresetItemsBySlot(slot) {
  const { header, rows } = await readSheet(SHEET_PRESETS);
  const m = idxMap(header);
  const want = (slot || '').toLowerCase();
  const out = [];
  for (const r of rows) {
    if (!r.length) continue;
    const rowSlot = (r[m.get('slot')] || '').trim().toLowerCase();
    if (rowSlot !== want) continue;
    out.push({
      boss: (r[m.get('boss')] || '').trim(),
      type: (r[m.get('type')] || '').trim().toLowerCase(),       // world_boss | archboss
      item: (r[m.get('item')] || '').trim(),
      category: (r[m.get('category')] || '').trim().toLowerCase(),
      slot: rowSlot
    });
  }
  return out;
}


// ---------- Helpers ----------
function niceName(inter) {
  return inter.member?.displayName
      || inter.user?.globalName
      || inter.user?.username
      || inter.user?.tag
      || inter.user?.id;
}

function isAdmin(member) {
  if (!member) return false
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true
  if (member.id === member.guild?.ownerId) return true
  if (member.id === DISCORD_USER_ID) return true
  return member.roles?.cache?.some(r => r.name === ADMIN_ROLE_NAME)
}

async function resolvePoll(guildId, idOrName) {
  const byId = Number(idOrName)
  if (!Number.isNaN(byId)) {
    const p = await pollsRepo.getPollById(byId)
    if (p && p.guild_id === guildId) return p
  }
  return pollsRepo.getPollByName(guildId, idOrName)
}

function pollEmbed(poll, items) {
  const title = `Loot Poll: ${poll.name} — ${labelType(poll.type)} ${poll.is_open ? '' : '(closed)'}`
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

function labelCat(c){ return c==='weapon' ? 'Weapons' : c==='armor' ? 'Armor' : 'Accessories' }
function chunk(arr, n){ const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out }

function buildButtons(items, poll) {
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
    new ButtonBuilder()
      .setCustomId(`admin:panel:${poll.id}`)   // include poll id
      .setLabel('Admin Panel')
      .setStyle(ButtonStyle.Danger)
  ))
  return rows
}


async function upsertPollMessage(channel, poll) {
  const items = await itemsRepo.getItems(poll.id)
  for (const it of items) it._count = await votesRepo.countVotesForItem(poll.id, it.id)
  const embed = pollEmbed(poll, items)
  const components = buildButtons(items, poll)
  const msgs = await channel.messages.fetch({ limit: 50 }).catch(()=>null)
  const existing = msgs?.find(m => m.author.id === channel.client.user.id && m.embeds[0]?.footer?.text?.includes(`Poll ID: ${poll.id}`))
  if (existing) return existing.edit({ embeds:[embed], components })
  return channel.send({ embeds:[embed], components })
}


// ---- Results helpers (NEW) ----

function mentionOrText(id, name) {
  return id === 'no_award' ? (name || 'No award') : `<@${id}>`
}

const LOOT_COUNCIL_ROLES = (process.env.LOOT_COUNCIL_ROLES || 'Guild Leader,Advisor,Officer')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

function isCouncil(member) {
  if (!member) return false
  if (member.id === member.guild?.ownerId) return true
  return member.roles.cache.some(r => LOOT_COUNCIL_ROLES.includes(r.name))
}

async function councilMembers(guild) {
  await guild.members.fetch() // ensure cache filled (needs Members intent)
  return guild.members.cache.filter(m => isCouncil(m)).map(m => m)
}

async function createCouncilPoll({ guild_id, item_name, mode='both', winners_needed=1, channel_id, created_by }) {
  const id = await nextId(SHEET_COUNCIL_POLLS)
  await appendRows(SHEET_COUNCIL_POLLS, [[
    String(id), guild_id, item_name, mode, String(winners_needed),
    '1', channel_id || '', created_by || '', String(Date.now())
  ]])
  return { id, guild_id, item_name, mode, winners_needed, is_open:1, channel_id: channel_id||'', created_by, created_at: Date.now() }
}

async function getCouncilPollById(id) {
  const { header, rows } = await readSheet(SHEET_COUNCIL_POLLS)
  const m = idxMap(header)
  for (const r of rows) {
    if (parseInt(r[m.get('id')],10) === Number(id)) {
      return {
        id: Number(id),
        guild_id: r[m.get('guild_id')],
        item_name: r[m.get('item_name')],
        mode: r[m.get('mode')],
        winners_needed: parseInt(r[m.get('winners_needed')]||'1',10),
        is_open: (r[m.get('is_open')]||'0') === '1' ? 1 : 0,
        channel_id: r[m.get('channel_id')] || '',
        created_by: r[m.get('created_by')] || '',
        created_at: parseInt(r[m.get('created_at')]||'0',10)
      }
    }
  }
  return null
}

async function addCouncilCandidate(council_poll_id, user_id, user_name) {
  const id = await nextId(SHEET_COUNCIL_CAND)
  await appendRows(SHEET_COUNCIL_CAND, [[String(id), String(council_poll_id), user_id, user_name || '' ]])
  return { id, council_poll_id, user_id, user_name }
}

async function getCouncilCandidates(council_poll_id) {
  const { header, rows } = await readSheet(SHEET_COUNCIL_CAND)
  const m = idxMap(header)
  return rows
    .filter(r => parseInt(r[m.get('council_poll_id')],10) === Number(council_poll_id))
    .map(r => ({ id: parseInt(r[m.get('id')],10), council_poll_id, user_id: r[m.get('user_id')], user_name: r[m.get('user_name')] || '' }))
}

async function councilVote(council_poll_id, candidate_user_id, voter_user_id, voter_name='') {
  const { header, rows } = await readSheet(SHEET_COUNCIL_VOTES)
  const m = idxMap(header)
  // one vote per council member: drop any existing vote from this voter in this council poll
  const newRows = rows.filter(r => !(parseInt(r[m.get('council_poll_id')],10)===Number(council_poll_id) && r[m.get('voter_user_id')]===voter_user_id))
  await overwriteRows(SHEET_COUNCIL_VOTES, header, newRows)
  await appendRows(SHEET_COUNCIL_VOTES, [[ String(council_poll_id), candidate_user_id, voter_user_id, voter_name || '', String(Date.now()) ]])
}

async function councilTallies(council_poll_id) {
  const { header, rows } = await readSheet(SHEET_COUNCIL_VOTES)
  const m = idxMap(header)
  const mine = rows.filter(r => parseInt(r[m.get('council_poll_id')],10)===Number(council_poll_id))
  const tally = new Map()
  for (const r of mine) {
    const cand = r[m.get('candidate_user_id')]
    tally.set(cand, (tally.get(cand)||0) + 1)
  }
  return tally // Map<candidate_user_id, count>
}

async function councilVoters(council_poll_id) {
  const { header, rows } = await readSheet(SHEET_COUNCIL_VOTES)
  const m = idxMap(header)
  return rows.filter(r => parseInt(r[m.get('council_poll_id')],10)===Number(council_poll_id))
            .map(r => ({ voter_id: r[m.get('voter_user_id')], voter_name: r[m.get('voter_name')] || '' }))
}

async function closeCouncilPoll(id) {
  const { header, rows } = await readSheet(SHEET_COUNCIL_POLLS)
  const m = idxMap(header)
  for (const r of rows) {
    if (parseInt(r[m.get('id')],10) === Number(id)) {
      r[m.get('is_open')] = '0'
      break
    }
  }
  await overwriteRows(SHEET_COUNCIL_POLLS, header, rows)
}

function fieldNameWithSuffix(base, idx) {
  return idx === 0 ? base : `${base} (cont. ${idx})`
}

function linesToFieldChunks(fieldBaseName, lines, maxCharsPerField = 950) {
  // Discord field limit is 1024; stay conservative
  const fields = []
  let chunk = []
  let chunkLen = 0
  for (const line of lines) {
    // +1 for newline
    if (chunkLen + line.length + 1 > maxCharsPerField) {
      fields.push({ name: fieldNameWithSuffix(fieldBaseName, fields.length), value: chunk.join('\n'), inline: true })
      chunk = [line]
      chunkLen = line.length + 1
    } else {
      chunk.push(line)
      chunkLen += line.length + 1
    }
  }
  if (chunk.length) {
    fields.push({ name: fieldNameWithSuffix(fieldBaseName, fields.length), value: chunk.join('\n'), inline: true })
  }
  return fields
}

function councilEmbed(poll, candidates, tally, notVotedCount, notVotedList) {
  // tally: Map<user_id, count>
  const lines = candidates.map(c => `• ${mentionOrText(c.user_id, c.user_name)} — **${tally.get(c.user_id) || 0}**`)
  const desc = [
    `Item: **${poll.item_name}** • Mode: ${poll.mode==='both' ? 'Main PvP + Main PvE' : labelMode(poll.mode)}`,
    `Status: ${poll.is_open ? 'Open' : 'Closed'}`,
    '',
    ...lines,
    '',
    `Votes received: **${(Array.from(tally.values()).reduce((a,b)=>a+b,0))}**`,
    `Council not voted yet (${notVotedCount}): ${notVotedList.length ? notVotedList.map(m=>`<@${m.id}>`).join(', ') : 'none'}`
  ].join('\n')

  return new EmbedBuilder()
    .setTitle(`Loot Council — ${poll.item_name}`)
    .setDescription(desc)
    .setFooter({ text: `Council Poll ID: ${poll.id}` })
}

function councilButtons(poll, candidates, isAdminView=false) {
  const rows = []
  // candidate buttons (max 5 per row)
  for (let i=0;i<candidates.length;i+=5) {
    rows.push(new ActionRowBuilder().addComponents(
      ...candidates.slice(i,i+5).map(c => new ButtonBuilder()
        .setCustomId(`council:vote:${poll.id}:${c.user_id}`)
        .setLabel(c.user_name ? c.user_name : c.user_id)
        .setStyle(ButtonStyle.Primary)
      )
    ))
  }
  // admin row
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`council:close:${poll.id}`).setLabel('Close').setStyle(ButtonStyle.Danger)
  ))
  return rows
}

async function getCandidatesFromMainVotes(guild_id, item_name_lc, wantModes /* array: ['main_pvp','main_pve'] or ['both'] */) {
  const modes = (wantModes.includes('both')) ? ['main_pvp','main_pve'] : wantModes
  const uniq = new Map() // user_id -> user_name
  for (const m of modes) {
    const agg = await aggregateVotesAcrossGuildForItemByMode(guild_id, item_name_lc, m)
    for (const { voters } of agg) {
      for (const v of voters) {
        if (!uniq.has(v.id)) uniq.set(v.id, v.name || '')
      }
    }
  }
  return Array.from(uniq, ([id, name]) => ({ id, name }))
}


async function tallyPollVotes(pollId) {
  // Build counts + voter map in one sheet read
  const vs = await readSheet(SHEET_VOTES)
  const vm = idxMap(vs.header)
  const counts = new Map()      // itemId -> count
  const votersMap = new Map()   // itemId -> [{id,name}]
  let total = 0
  for (const r of vs.rows) {
    if (parseInt(r[vm.get('poll_id')], 10) !== Number(pollId)) continue
    const itemId = parseInt(r[vm.get('item_id')], 10)
    counts.set(itemId, (counts.get(itemId) || 0) + 1)
    total++
    const voter = {
      id: r[vm.get('user_id')],
      name: vm.has('user_name') ? (r[vm.get('user_name')] || '') : ''
    }
    const arr = votersMap.get(itemId) || []
    arr.push(voter)
    votersMap.set(itemId, arr)
  }
  return { counts, votersMap, total }
}

async function buildResultsEmbed(poll, { includeVoters = false, voterLimit = 10, hideZero = false } = {}) {
  const items = await itemsRepo.getItems(poll.id)
  const { counts, votersMap, total } = await tallyPollVotes(poll.id)

  // decorate
  const withCounts = items.map(it => ({
    ...it,
    _count: counts.get(it.id) || 0,
    _voters: votersMap.get(it.id) || []
  }))

  const fields = []
  for (const cat of CATS) {
    const group = withCounts
      .filter(i => i.category === cat)
      .filter(i => !hideZero || i._count > 0)
      .sort((a, b) => b._count - a._count || a.name.localeCompare(b.name))

    if (!group.length) continue

    const lines = group.map((it, idx) => {
      const lead = `${idx + 1}) ${it.name}${it.slot ? ` (${it.slot})` : ''} — **${it._count}**`
      if (!includeVoters || it._voters.length === 0) return `• ${lead}`
      const names = it._voters
        .slice(0, Math.max(1, voterLimit || 10))
        .map(v => v.name || `<@${v.id}>`)
      const plus = it._voters.length > names.length ? ` +${it._voters.length - names.length} more` : ''
      return `• ${lead} — ${names.join(', ')}${plus}`
    })

    const baseName = labelCat(cat)
    fields.push(...linesToFieldChunks(baseName, lines))
  }

  if (!fields.length) {
    fields.push({ name: 'No items have votes yet', value: 'Use `/poll add` or `/poll preset` to add loot.', inline: false })
  }

  const title = `Results: ${poll.name} — ${labelType(poll.type)} ${poll.is_open ? '' : '(closed)'}`
  const desc = [
    poll.expires_at ? `Expires: <t:${Math.floor(poll.expires_at / 1000)}:R>` : 'No expiry',
    `Total votes: **${total}**`,
    `Poll ID: ${poll.id}`
  ].join(' • ')


  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .addFields(fields)
}

function chooseResultsChannel(inter, poll, explicitChannel = null) {
  return explicitChannel || inter.channel
}

// --- Admin helpers ---

function itemLabel(i) {
  return `${i.name}${i.slot ? ` (${i.slot})` : ''}`
}

async function aggregateVotesAcrossGuildForItemByMode(guild_id, item_name_lc, mode) {
  const polls = await pollsRepo.listPolls(guild_id) // open & closed
  const votes = await readSheet(SHEET_VOTES)
  const vm = idxMap(votes.header)

  const out = []
  for (const p of polls) {
    const items = await itemsRepo.getItems(p.id)
    const it = items.find(x => (x.name_lc || x.name?.toLowerCase()) === item_name_lc)
    if (!it) continue

    // filter votes for this poll+item with requested mode
    const rows = votes.rows.filter(r =>
      parseInt(r[vm.get('poll_id')],10) === Number(p.id) &&
      parseInt(r[vm.get('item_id')],10) === Number(it.id) &&
      (!vm.has('mode') || r[vm.get('mode')] === mode)
    )
    if (!rows.length) continue

    // unique voters
    const seen = new Set()
    const voters = []
    for (const r of rows) {
      const id = r[vm.get('user_id')]
      if (seen.has(id)) continue
      seen.add(id)
      voters.push({
        id,
        name: vm.has('user_name') ? (r[vm.get('user_name')] || '') : ''
      })
    }
    if (voters.length) out.push({ poll: p, item: it, voters })
  }
  return out
}


function fmtVoter(v) {
  return v.name ? `${v.name} (<@${v.id}>)` : `<@${v.id}>`
}


// ---------- Commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create/manage loot polls')
    .addSubcommand(sc => sc.setName('repost').setDescription('Repost a poll message to the main loot poll channel')
    .addStringOption(o => o.setName('poll').setDescription('Poll ID or name').setRequired(true)))
    .addSubcommand(sc => sc
      .setName('results')
      .setDescription('Post a results embed for a poll')
      .addStringOption(o => o.setName('poll').setDescription('Poll ID or name').setRequired(true))
    .addChannelOption(o => o
    .setName('channel')
    .setDescription('Channel to post results (optional)')
    .addChannelTypes(ChannelType.GuildText)
  )
  .addBooleanOption(o => o.setName('voters').setDescription('Include voter names per item (default: off)'))
  .addBooleanOption(o => o.setName('hide_zero').setDescription('Hide items with zero votes (default: show)'))
  )
    .addSubcommand(sc=> sc.setName('create').setDescription('Create a new poll')
      .addStringOption(o=>o.setName('name').setDescription('Poll name').setRequired(true))
      .addStringOption(o=>o.setName('type').setDescription('Boss type').addChoices(
        {name:'World Boss', value:'world_boss'},
        {name:'Archboss', value:'archboss'},
      ).setRequired(true))
      .addIntegerOption(o=>o.setName('expires_hours').setDescription('Auto-close after N hours'))
    )
    .addSubcommand(sc => sc
      .setName('slot')
      .setDescription('Create a poll from all preset items that match a slot (across all bosses)')
      .addStringOption(o => o.setName('slot').setDescription('Slot code, e.g. earring, ring, gs').setRequired(true)
        .addChoices(
          ...SLOTS.map(s => ({ name: SLOT_LABELS[s] || s, value: s }))
        )
      )
      .addIntegerOption(o => o.setName('expires_hours').setDescription('Auto-close after N hours'))
      .addStringOption(o => o.setName('name').setDescription('Poll name override (optional)'))
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
        // Armor
        {name:'Helmet', value:'helmet'},
        {name:'Chest', value:'chest'},
        {name:'Cloak', value:'cloak'},
        {name:'Gloves', value:'gloves'},
        {name:'Pants', value:'pants'},
        {name:'Boots', value:'boots'},
        // Accessory
        {name:'Ring', value:'ring'},
        {name:'Necklace', value:'neck'},
        {name:'Earring', value:'earring'},
        {name:'Bracelet', value:'bracelet'},
        {name:'Belt', value:'belt'}
      ))
    )
    .addSubcommand(sc=> sc.setName('preset').setDescription('Create a poll from a boss preset (loads items from sheet)')
      .addStringOption(o=>o.setName('boss').setDescription('Boss name, e.g. Kazar').setRequired(true))
      .addStringOption(o=>o.setName('type').setDescription('Boss type').addChoices(
        {name:'World Boss', value:'world_boss'},
        {name:'Archboss', value:'archboss'},
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
    .addStringOption(o=>o.setName('mode').setDescription('What is this vote for?')
    .addChoices(
     { name: 'Main PvP', value: 'main_pvp' },
     { name: 'Main PvE', value: 'main_pve' },
     { name: 'Off-spec', value: 'offspec' },
   ).setRequired(true))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('unvote')
    .setDescription('Remove your vote from an item')
    .addStringOption(o=>o.setName('poll').setDescription('Poll ID or name').setRequired(true))
    .addStringOption(o=>o.setName('item').setDescription('Item name').setRequired(true).setAutocomplete(true))
    .addStringOption(o=>o.setName('mode').setDescription('Which vote to remove (leave empty to remove all)') 
    .addChoices(
     { name: 'Main PvP', value: 'main_pvp' },
     { name: 'Main PvE', value: 'main_pve' },
     { name: 'Off-spec', value: 'offspec' },
   ))
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
  new SlashCommandBuilder()
  .setName('council')
  .setDescription('Loot council polls (leadership only)')
  .addSubcommand(sc => sc.setName('create').setDescription('Create a loot council poll for an item')
    .addStringOption(o => o.setName('item').setDescription('Exact item name').setRequired(true))
    .addStringOption(o => o.setName('mode').setDescription('Candidates come from…')
      .addChoices(
        {name:'Main PvP', value:'main_pvp'},
        {name:'Main PvE', value:'main_pve'},
        {name:'Both (PvP + PvE)', value:'both'},
      ).setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post (defaults to leadership channel if set)').addChannelTypes(ChannelType.GuildText))
    .addBooleanOption(o => o.setName('no_award').setDescription('Include a "No award" option (abstain)'))
  )
  .addSubcommand(sc => sc.setName('status').setDescription('Show status of a council poll')
    .addStringOption(o=>o.setName('id').setDescription('Council Poll ID').setRequired(true))
  )
  .addSubcommand(sc => sc.setName('close').setDescription('Close a council poll')
    .addStringOption(o=>o.setName('id').setDescription('Council Poll ID').setRequired(true))
  )
  .setDMPermission(false),

].map(c => c.toJSON())

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
})

// --- Discord client guards ---
client.on('error', (err) => console.error('[discord.js client error]', err));
client.on('shardError', (err) => console.error('[discord.js shard error]', err));
// Optional debug noise (enable via env):
if (process.env.DJS_DEBUG) {
  client.on('debug', (msg) => console.debug('[discord.js debug]', msg));
}

// If your discord.js version exposes a REST instance on the client:
if (client.rest?.on) {
  client.rest.on('rateLimited', (info) => console.warn('[REST rateLimited]', info));
}

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
    await pollsRepo.setPollClosed(id)
    for (const [, guild] of client.guilds.cache) {
      const poll = await pollsRepo.getPollById(id)
      if (!poll) continue
      const channel = getPollChannel(guild)
      if (channel && guild.id === poll.guild_id) {
        const items = await itemsRepo.getItems(poll.id)
        for (const it of items) it._count = await votesRepo.countVotesForItem(poll.id, it.id)
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
    if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu()) return

    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction
      if (commandName === 'poll') return handlePoll(interaction)
      if (commandName === 'vote') return handleVote(interaction)
      if (commandName === 'unvote') return handleUnvote(interaction)
      if (commandName === 'admin') return handleAdmin(interaction)
      if (commandName === 'council') return handleCouncil(interaction)
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('vote:')) return handleVoteButton(interaction)
      if (interaction.customId.startsWith('admin:panel:')) return handleAdminPanel(interaction)
      if (interaction.customId.startsWith('admin:voterspoll:')) return handleAdminVotersPoll(interaction)
      if (interaction.customId.startsWith('admin:clearitem:'))  return handleAdminClearItem(interaction)
      if (interaction.customId.startsWith('admin:clearpoll:'))  return handleAdminClearPoll(interaction)
      if (interaction.customId.startsWith('admin:back:'))       return handleAdminPanel(interaction)
      if (interaction.customId.startsWith('admin:cross:'))      return handleAdminCrossMode(interaction)
      if (interaction.customId.startsWith('council:vote:'))  return handleCouncilVote(interaction)
      if (interaction.customId.startsWith('council:close:')) return handleCouncilClose(interaction)
      if (interaction.customId.startsWith('vote-mode-add:'))  return handleVoteModeAdd(interaction)
      if (interaction.customId.startsWith('vote-mode-remove:')) return handleVoteModeRemove(interaction)
      if (interaction.customId.startsWith('vote-mode-replace:')) return handleVoteModeReplace(interaction)
      if (interaction.customId.startsWith('admin:deletepoll:'))   return handleAdminDeletePoll(interaction)
      if (interaction.customId.startsWith('admin:deleteconfirm:')) return handleAdminDeleteConfirm(interaction)
      if (interaction.customId === 'vote-mode-cancel') return handleVoteModeCancel(interaction)
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('admin:item:'))       return handleAdminSelectItem(interaction)
      if (interaction.customId.startsWith('admin:pickvoter:'))  return handleAdminPickVoter(interaction)
    }

  } catch (e) {
    console.error('Interaction error', e)
    const msg = { content: 'Something went wrong. Try again.', flags: MessageFlags.Ephemeral }
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(()=>null)
    else await interaction.reply(msg).catch(()=>null)
  }
})

// ---------- Handlers ----------
async function handleCouncil(inter) {
  const sub = inter.options.getSubcommand()
  if (sub === 'create') {
    // Only leadership creates
    if (!isAdmin(inter.member) && !isCouncil(inter.member)) {
      return inter.reply({ content: 'Leadership only.', flags: MessageFlags.Ephemeral })
    }

    const item = inter.options.getString('item', true).trim()
    const mode = inter.options.getString('mode', true) // 'main_pvp' | 'main_pve' | 'both'
    const channel = inter.options.getChannel('channel')
    const noAward = inter.options.getBoolean('no_award') || false

    // Build candidates from main votes
    const candidates = await getCandidatesFromMainVotes(inter.guildId, item.toLowerCase(), [mode])
    if (!candidates.length && !noAward) {
      return inter.reply({ content: `No candidates found for **${item}** from ${mode==='both'?'Main PvP + Main PvE':labelMode(mode)} votes.`, flags: MessageFlags.Ephemeral })
    }
    // Include "No award" synthetic candidate if requested (uses pseudo-user id "no_award")
    if (noAward) candidates.push({ id: 'no_award', name: 'No award' })

    // Create council poll record
    const leadershipChannelId = process.env.LEADERSHIP_CHANNEL_ID
    const postChannel = channel || (leadershipChannelId && inter.guild.channels.cache.get(leadershipChannelId)) || inter.channel
    const poll = await createCouncilPoll({
      guild_id: inter.guildId,
      item_name: item,
      mode,
      winners_needed: 1,
      channel_id: postChannel.id,
      created_by: inter.user.id
    })
    // Persist candidates
    for (const c of candidates) {
      await addCouncilCandidate(poll.id, c.id, c.name || '')
    }

    // Compute initial embed
    const cmembers = await councilMembers(inter.guild)
    const tallies = await councilTallies(poll.id)
    const notVoted = cmembers // none voted yet
    const candRows = (await getCouncilCandidates(poll.id)).map(c => ({ user_id: c.user_id, user_name: c.user_name }))
    const embed = councilEmbed(poll, candRows, tallies, notVoted.length, notVoted)
    const components = councilButtons(poll, candRows, true)

    await postChannel.send({ embeds:[embed], components })
    return inter.reply({ content:`Council poll created for **${item}** in ${postChannel}.`, flags: MessageFlags.Ephemeral })
  }

  else if (sub === 'status') {
    if (!isAdmin(inter.member) && !isCouncil(inter.member)) {
      return inter.reply({ content:'Leadership only.', flags: MessageFlags.Ephemeral })
    }
    const id = Number(inter.options.getString('id', true))
    const poll = await getCouncilPollById(id)
    if (!poll) return inter.reply({ content:'Council poll not found.', flags: MessageFlags.Ephemeral })

    const cmembers = await councilMembers(inter.guild)
    const cands = await getCouncilCandidates(poll.id)
    const tally = await councilTallies(poll.id)
    const voters = await councilVoters(poll.id)
    const votedSet = new Set(voters.map(v => v.voter_id))
    const notVoted = cmembers.filter(m => !votedSet.has(m.id))

    const embed = councilEmbed(poll, cands.map(c => ({ user_id:c.user_id, user_name:c.user_name })), tally, notVoted.length, notVoted)
    return inter.reply({ embeds:[embed], flags: MessageFlags.Ephemeral })
  }

  else if (sub === 'close') {
    if (!isAdmin(inter.member) && !isCouncil(inter.member)) {
      return inter.reply({ content:'Leadership only.', flags: MessageFlags.Ephemeral })
    }
    const id = Number(inter.options.getString('id', true))
    const poll = await getCouncilPollById(id)
    if (!poll) return inter.reply({ content:'Council poll not found.', flags: MessageFlags.Ephemeral })
    await doCloseCouncilPoll(inter.guild, poll, 'manual')
    return inter.reply({ content:`Closed council poll **${poll.item_name}**.`, flags: MessageFlags.Ephemeral })
  }
}

async function handleCouncilVote(inter) {
  const [, , pollIdStr, candidateId] = inter.customId.split(':') // council:vote:<pollId>:<candidate_user_id>
  const pollId = Number(pollIdStr)
  const poll = await getCouncilPollById(pollId)
  if (!poll) return inter.reply({ content:'Poll not found.', flags: MessageFlags.Ephemeral })
  if (!poll.is_open) return inter.reply({ content:'Poll is closed.', flags: MessageFlags.Ephemeral })
  if (!isCouncil(inter.member)) return inter.reply({ content:'Council only.', flags: MessageFlags.Ephemeral })

  // Ensure candidate belongs to this poll
  const candidates = await getCouncilCandidates(pollId)
  const ok = candidates.some(c => c.user_id === candidateId)
  if (!ok) return inter.reply({ content:'Invalid candidate.', flags: MessageFlags.Ephemeral })

  await councilVote(pollId, candidateId, inter.user.id, niceName(inter))

  // Re-render message where button was clicked
  const cmembers = await councilMembers(inter.guild)
  const tally = await councilTallies(pollId)
  const voters = await councilVoters(pollId)
  const votedSet = new Set(voters.map(v => v.voter_id))
  const notVoted = cmembers.filter(m => !votedSet.has(m.id))

  // Auto-close: all voted OR strict majority
  const totalCouncil = cmembers.length
  const maxVotes = Math.max(0, ...Array.from(tally.values()))
  const hasMajority = maxVotes > Math.floor(totalCouncil / 2)

  if (notVoted.length === 0 || hasMajority) {
    await doCloseCouncilPoll(inter.guild, poll, hasMajority ? 'majority' : 'all-voted')
    return inter.reply({ content:'Vote recorded. Poll closed.', flags: MessageFlags.Ephemeral })
  }

  const embed = councilEmbed(poll, candidates.map(c => ({ user_id:c.user_id, user_name:c.user_name })), tally, notVoted.length, notVoted)
  const components = councilButtons(poll, candidates.map(c => ({ user_id:c.user_id, user_name:c.user_name })), true)
  // Update the message (edit in place)
  await inter.message.edit({ embeds:[embed], components })
  return inter.reply({ content:'Vote recorded.', flags: MessageFlags.Ephemeral })
}

async function handleCouncilClose(inter) {
  const pollId = Number(inter.customId.split(':')[2])
  const poll = await getCouncilPollById(pollId)
  if (!poll) return inter.reply({ content:'Poll not found.', flags: MessageFlags.Ephemeral })
  if (!isAdmin(inter.member) && !isCouncil(inter.member)) return inter.reply({ content:'Leadership only.', flags: MessageFlags.Ephemeral })
  await doCloseCouncilPoll(inter.guild, poll, 'manual')
  return inter.reply({ content:'Poll closed.', flags: MessageFlags.Ephemeral })
}

// Finalize: compute winner(s), close, update message
async function doCloseCouncilPoll(guild, poll, reason) {
  await closeCouncilPoll(poll.id)
  const candidates = await getCouncilCandidates(poll.id)
  const tally = await councilTallies(poll.id)
  const cmembers = await councilMembers(guild)
  const voters = await councilVoters(poll.id)
  const votedSet = new Set(voters.map(v => v.voter_id))
  const notVoted = cmembers.filter(m => !votedSet.has(m.id))

  // Determine winners (plurality)
  let maxVotes = -1
  const scores = []
  for (const c of candidates) {
    const v = tally.get(c.user_id) || 0
    scores.push({ c, v })
    if (v > maxVotes) maxVotes = v
  }
  const winners = scores.filter(s => s.v === maxVotes && maxVotes >= 0).map(s => s.c)

  const embed = new EmbedBuilder()
    .setTitle(`Loot Council — ${poll.item_name} (Closed)`)
    .setDescription([
      `Close reason: ${reason}`,
      '',
      ...scores.map(s => `• ${mentionOrText(s.c.user_id, s.c.user_name)} — **${s.v}**`),
      '',
      winners.length === 1
        ? `Winner: **${mentionOrText(winners[0].user_id, winners[0].user_name)}**`
        : `Tie: ${winners.map(w => mentionOrText(w.user_id, w.user_name)).join(', ')}`
    ].join('\n'))
    .setFooter({ text: `Council Poll ID: ${poll.id}` })

  // Find the most recent council message in the target channel and edit it
  const chan = (poll.channel_id && guild.channels.cache.get(poll.channel_id))
            || guild.systemChannel
  if (chan && chan.isTextBased()) {
    try {
      // best effort: edit last 50 messages sent by the bot containing the poll ID
      const msgs = await chan.messages.fetch({ limit: 50 }).catch(()=>null)
      const msg = msgs?.find(m => m.author.id === guild.members.me.id && m.embeds[0]?.footer?.text?.includes(`Council Poll ID: ${poll.id}`))
      if (msg) await msg.edit({ embeds:[embed], components:[] })
      else await chan.send({ embeds:[embed] })
    } catch {}
  }
}


async function handlePoll(inter) {
  const sub = inter.options.getSubcommand()
  const guildId = inter.guildId
  if (!guildId) return inter.reply({ content: 'Guild-only command.', flags: MessageFlags.Ephemeral })

  if (sub === 'create') {
  const name = inter.options.getString('name', true).trim()
  const type = inter.options.getString('type', true)
  const expiresHours = inter.options.getInteger('expires_hours')
  if (!isAdmin(inter.member)) return inter.reply({ content: 'Only admins can create polls.', flags: MessageFlags.Ephemeral })
  if (!TYPES.includes(type)) return inter.reply({ content: 'Invalid type.', flags: MessageFlags.Ephemeral })

  let expires = null
  if (expiresHours && expiresHours > 0) expires = Date.now() + (expiresHours * 3600 * 1000)

  const exists = await pollsRepo.getPollByName(guildId, name)
  if (exists) return inter.reply({ content: 'A poll with that name already exists.', flags: MessageFlags.Ephemeral })

  // pass a neutral mode string for backward-compat storage; it is not shown/used
  const poll = await pollsRepo.createPoll({ guild_id: guildId, name, expires_at: expires, type, mode: 'all' })
  await inter.reply({ content: `Created poll **${poll.name}** (ID ${poll.id}).` })
  await upsertPollMessage(getPollChannel(inter.guild) || inter.channel, poll)

  } else if (sub === 'repost') {
    const idOrName = inter.options.getString('poll', true)
    const poll = await resolvePoll(guildId, idOrName)
    if (!poll) return inter.reply({ content: 'Poll not found.', flags: MessageFlags.Ephemeral })

    const chan = getPollChannel(inter.guild) || inter.channel
    await upsertPollMessage(chan, poll)
    return inter.reply({ content: `Reposted **${poll.name}** to ${chan}.`, flags: MessageFlags.Ephemeral })
  } else if (sub === 'add') {
    const idOrName = inter.options.getString('poll', true)
    const itemName = inter.options.getString('item', true).trim()
    const category = inter.options.getString('category', true)
    const slot = inter.options.getString('slot') || ''
    if (!CATS.includes(category)) return inter.reply({ content: 'Category must be weapon, armor, or accessory.', flags: MessageFlags.Ephemeral })
    if (slot && !SLOTS.includes(slot)) return inter.reply({ content: 'Invalid slot.', flags: MessageFlags.Ephemeral })
    const poll = await resolvePoll(guildId, idOrName)
    if (!poll) return inter.reply({ content: 'Poll not found.', flags: MessageFlags.Ephemeral })
    if (!isAdmin(inter.member)) return inter.reply({ content: 'Only admins can add items.', flags: MessageFlags.Ephemeral })
    if (!poll.is_open) return inter.reply({ content: 'Poll is closed.', flags: MessageFlags.Ephemeral })

    const existing = await itemsRepo.getItemByName(poll.id, itemName)
    if (existing) return inter.reply({ content: 'That item already exists in this poll.', flags: MessageFlags.Ephemeral })

    await itemsRepo.upsertItem(poll.id, itemName, category, slot)
    await inter.reply({ content: `Added **${itemName}** (${labelCat(category)}${slot?` • ${slot}`:''}) to **${poll.name}**.` })
    await upsertPollMessage(getPollChannel(inter.guild) || inter.channel, poll)
  } else if (sub === 'preset') {
    if (!isAdmin(inter.member)) return inter.reply({ content: 'Only admins can create presets.', flags: MessageFlags.Ephemeral })
    const boss = inter.options.getString('boss', true)
    const type = inter.options.getString('type', true)
    const nameOverride = inter.options.getString('name')
    const expiresHours = inter.options.getInteger('expires_hours')

    if (!TYPES.includes(type)) return inter.reply({ content: 'Invalid type.', flags: MessageFlags.Ephemeral })

    const pollName = nameOverride || `${boss} — ${labelType(type)}`
    const exists = await pollsRepo.getPollByName(guildId, pollName)
    if (exists) return inter.reply({ content: 'A poll with that name already exists.', flags: MessageFlags.Ephemeral })

    let expires = null
    if (expiresHours && expiresHours > 0) expires = Date.now() + (expiresHours * 3600 * 1000)

    const poll = await pollsRepo.createPoll({ guild_id: guildId, name: pollName, expires_at: expires, type, mode: 'all' })
    const rows = await loadPresetItems({ boss, type })
    if (!rows.length) {
      await inter.reply({ content: `Created **${poll.name}** but found no preset rows for boss "${boss}" (${labelType(type)}). Add rows to the Presets tab.`, flags: MessageFlags.Ephemeral })
      await upsertPollMessage(getPollChannel(inter.guild) || inter.channel, poll)
      return
    }
    for (const r of rows) {
      if (!CATS.includes(r.category)) continue
      await itemsRepo.upsertItem(poll.id, r.item, r.category, (r.slot||''))
    }
    await inter.reply({ content: `Created poll **${poll.name}** with ${rows.length} preset item(s).` })
    await upsertPollMessage(getPollChannel(inter.guild) || inter.channel, poll)
  }


  else if (sub === 'list') {
    const rows = await pollsRepo.listPolls(guildId)
    if (!rows.length) return inter.reply({ content: 'No polls yet.' })
    const lines = rows.map(p =>
      `• **${p.name}** (ID ${p.id}) — ${labelType(p.type)} — ${p.is_open? 'open':'closed'}${p.expires_at ? ` — expires <t:${Math.floor(p.expires_at/1000)}:R>`:''}`
    )
    return inter.reply({ content: lines.join('\n') })
  }
else if (sub === 'results') {
  const idOrName = inter.options.getString('poll', true)
  const targetChannel = inter.options.getChannel('channel') || inter.channel
  const includeVoters = inter.options.getBoolean('voters') || false
  const hideZero = inter.options.getBoolean('hide_zero') || false

  const poll = await resolvePoll(inter.guildId, idOrName)
  if (!poll) return inter.reply({ content: 'Poll not found.', flags: MessageFlags.Ephemeral })

  const items = await itemsRepo.getItems(poll.id)
  // attach counts & voters
  for (const it of items) {
    it._count = await votesRepo.countVotesForItem(poll.id, it.id)
    it._voters = includeVoters ? await votesRepo.votersForItem(poll.id, it.id) : []
  }

  const visible = hideZero ? items.filter(i => i._count > 0) : items
  if (!visible.length) return inter.reply({ content: 'No results to show.', flags: MessageFlags.Ephemeral })

  // Build fields respecting embed limits
  const fields = []
  for (const cat of CATS) {
    const group = visible.filter(i => i.category === cat)
    if (!group.length) continue

    const lines = []
    for (const it of group) {
      const base = `• ${it.name}${it.slot ? ` (${it.slot})` : ''} — **${it._count}**`
      if (includeVoters && it._voters.length) {
        const names = it._voters.map(v => v.name ? v.name : `<@${v.id}>`)
        lines.push(`${base}\n${names.map(n => `   · ${n}`).join('\n')}`)
      } else {
        lines.push(base)
      }
    }

    // Chunk if needed to avoid 1024 char field limit
    const text = lines.join('\n')
    if (text.length <= 1024) {
      fields.push({ name: labelCat(cat), value: text, inline: true })
    } else {
      // Split into multiple fields
      const chunks = []
      let buf = ''
      for (const ln of lines) {
        if ((buf + '\n' + ln).length > 1000) { chunks.push(buf); buf = ln }
        else buf = buf ? (buf + '\n' + ln) : ln
      }
      if (buf) chunks.push(buf)
      chunks.forEach((chunk, i) => fields.push({
        name: `${labelCat(cat)}${chunks.length>1?` (${i+1}/${chunks.length})`:''}`,
        value: chunk, inline: true
      }))
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`Results — ${poll.name}`)
    .setDescription(poll.expires_at ? `Status: ${poll.is_open ? 'Open' : 'Closed'} • Expires: <t:${Math.floor(poll.expires_at/1000)}:R>` : `Status: ${poll.is_open ? 'Open' : 'Closed'}`)
    .addFields(fields)
    .setFooter({ text: `Poll ID: ${poll.id}` })

  // If embed too long, attach txt
  const asText = ['Poll:', poll.name, '']
    .concat(fields.map(f => `${f.name}\n${f.value}`))
    .join('\n')
  if (asText.length > 5800) {
    const buf = Buffer.from(asText, 'utf8')
    await targetChannel.send({
      content: `Results for **${poll.name}**`,
      files: [{ attachment: buf, name: `poll-${poll.id}-results.txt` }]
    })
    return inter.reply({ content: `Posted results in ${targetChannel}.`, flags: MessageFlags.Ephemeral })
  }

  await targetChannel.send({ embeds: [embed] })
  return inter.reply({ content: `Posted results in ${targetChannel}.`, flags: MessageFlags.Ephemeral })
}
  else if (sub === 'slot') {
    if (!isAdmin(inter.member)) return inter.reply({ content: 'Only admins can create polls.', flags: MessageFlags.Ephemeral });
    const slot = (inter.options.getString('slot', true) || '').toLowerCase();
    const expiresHours = inter.options.getInteger('expires_hours');
    const nameOverride = inter.options.getString('name');
    const rows = await loadPresetItemsBySlot(slot);
    if (!rows.length) return inter.reply({ content: `No preset rows found for slot "${slot}".`, flags: MessageFlags.Ephemeral });

    const uniq = [];
    const seen = new Set();
    for (const r of rows) {
      const key = `${r.item.toLowerCase()}|${r.category}|${r.slot}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(r);
    }

    let expires = null;
    if (expiresHours && expiresHours > 0) expires = Date.now() + (expiresHours * 3600 * 1000);

    const pollName = nameOverride || `${labelSlot(slot)}`;
    const exists = await pollsRepo.getPollByName(guildId, pollName);
    if (exists) return inter.reply({ content: `Poll "${pollName}" already exists.`, flags: MessageFlags.Ephemeral });

    // "mixed" type fits since it spans bosses; keep mode:'all' for storage compatibility
    const poll = await pollsRepo.createPoll({
      guild_id: inter.guildId,
      name: pollName,
      expires_at: expires,
      type: 'mixed',
      mode: 'all'
    });

    for (const r of uniq) {
      if (!CATS.includes(r.category)) continue;
      await itemsRepo.upsertItem(poll.id, r.item, r.category, r.slot || '');
    }

    await inter.reply({ content: `Created **${poll.name}** with ${uniq.length} item(s) for slot **${labelSlot(slot)}**.` });
    await upsertPollMessage(getPollChannel(inter.guild) || inter.channel, poll);
  }

  else if (sub === 'close') {
    const idOrName = inter.options.getString('poll', true)
    const poll = await resolvePoll(guildId, idOrName)
    if (!poll) return inter.reply({ content: 'Poll not found.', flags: MessageFlags.Ephemeral })
    if (!isAdmin(inter.member)) return inter.reply({ content: 'Only admins can close polls.', flags: MessageFlags.Ephemeral })
    await pollsRepo.setPollClosed(poll.id)
    const updated = { ...poll, is_open: 0 }
    await inter.reply({ content: `Closed poll **${poll.name}**.` })
    await upsertPollMessage(getPollChannel(inter.guild) || inter.channel, updated)
  }
}

async function handleVote(inter) {
  const guildId = inter.guildId
  const idOrName = inter.options.getString('poll', true)
  const itemName = inter.options.getString('item', true)
  const mode = inter.options.getString('mode', true)
  const poll = await resolvePoll(guildId, idOrName)
  if (!poll) return inter.reply({ content: 'Poll not found.', flags: MessageFlags.Ephemeral })
  if (!poll.is_open) return inter.reply({ content: 'Poll is closed.', flags: MessageFlags.Ephemeral })
  const item = await itemsRepo.getItemByName(poll.id, itemName)
  if (!item) return inter.reply({ content: 'Item not found in this poll.', flags: MessageFlags.Ephemeral })

  const gate = await checkVoteAllowedByMode(poll, inter.user.id, item, mode)
  if (!gate.ok) return inter.reply({ content: `Cannot vote: ${gate.reason}`, flags: MessageFlags.Ephemeral })

 await votesRepo.voteWithMode(poll.id, item.id, inter.user.id, niceName(inter), mode)
 await inter.reply({ content: `Voted for **${item.name}** — ${labelModeLong(mode)}.`, flags: MessageFlags.Ephemeral })
 await upsertPollMessage(getPollChannel(inter.guild) || inter.channel, poll)
}

async function handleUnvote(inter) {
  const guildId = inter.guildId
  const idOrName = inter.options.getString('poll', true)
  const itemName = inter.options.getString('item', true)
  const mode = inter.options.getString('mode')
  const poll = await resolvePoll(guildId, idOrName)
  if (!poll) return inter.reply({ content: 'Poll not found.', flags: MessageFlags.Ephemeral })
  const item = await itemsRepo.getItemByName(poll.id, itemName)
  if (!item) return inter.reply({ content: 'Item not found in this poll.', flags: MessageFlags.Ephemeral })

let removed = 0
 if (mode) removed = await votesRepo.removeVoteForUserItemMode(poll.id, item.id, inter.user.id, mode)
 else       removed = await votesRepo.removeVoteForUserItemAllModes(poll.id, item.id, inter.user.id)
 if (!removed) return inter.reply({ content: `You had no vote on **${item.name}**${mode?` — ${labelModeLong(mode)}`:''}.`, flags: MessageFlags.Ephemeral })
 await inter.reply({ content: `Removed your vote${mode?` — ${labelModeLong(mode)}`:''} from **${item.name}**.`, flags: MessageFlags.Ephemeral })
 await upsertPollMessage(getPollChannel(inter.guild) || inter.channel, poll)
}

async function handleAdmin(inter) {
  if (!isAdmin(inter.member)) return inter.reply({ content: 'Admin only.', flags: MessageFlags.Ephemeral })
  const sub = inter.options.getSubcommand()
  const guildId = inter.guildId
  const idOrName = inter.options.getString('poll', true)
  const poll = await resolvePoll(guildId, idOrName)
  if (!poll) return inter.reply({ content: 'Poll not found.', flags: MessageFlags.Ephemeral })

  if (sub === 'clearvotes') {
    const user = inter.options.getUser('user', true)
    const removed = await votesRepo.clearVotesForUser(poll.id, user.id)
    await inter.reply({ content: `Cleared ${removed} vote(s) for ${user} in **${poll.name}**.` })
    await upsertPollMessage(getPollChannel(inter.guild) || inter.channel, poll)
  }
  else if (sub === 'removevote') {
    const user = inter.options.getUser('user', true)
    const itemName = inter.options.getString('item', true)
    const item = await itemsRepo.getItemByName(poll.id, itemName)
    if (!item) return inter.reply({ content: 'Item not found in this poll.', flags: MessageFlags.Ephemeral })
    const removed = await votesRepo.removeVoteForUserItem(poll.id, item.id, user.id)
    await inter.reply({ content: removed ? `Removed ${user}'s vote for **${item.name}**.` : `${user} had no vote on **${item.name}**.` })
    await upsertPollMessage(getPollChannel(inter.guild) || inter.channel, poll)
  }
  else if (sub === 'wipe') {
    await wipePoll(poll.id)
    await inter.reply({ content: `Deleted poll **${poll.name}**.` })
  }
}

async function handleVoteButton(inter) {
  const itemId = Number(inter.customId.split(':')[1])
  const poll = await getPollIdForItem(itemId)
  if (!poll) return inter.reply({ content: 'Poll not found (item may have been deleted).', flags: MessageFlags.Ephemeral })
  if (!poll.is_open) return inter.reply({ content: 'Poll closed.', flags: MessageFlags.Ephemeral })
  const item = (await itemsRepo.getItems(poll.id)).find(i => i.id === itemId)
  if (!item) return inter.reply({ content: 'Item not found.', flags: MessageFlags.Ephemeral })

  // Which modes does this user already have for this item?
  const vs = await readSheet(SHEET_VOTES)
  const m = idxMap(vs.header)
  const mineRows = vs.rows.filter(r =>
    parseInt(r[m.get('poll_id')],10)===Number(poll.id) &&
    parseInt(r[m.get('item_id')],10)===Number(item.id) &&
    r[m.get('user_id')]===inter.user.id
  )
  const have = new Set(mineRows.map(r => m.has('mode') ? r[m.get('mode')] : 'unknown'))

  const addRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vote-mode-add:${poll.id}:${item.id}:main_pvp`).setLabel('Add — Main PvP').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vote-mode-add:${poll.id}:${item.id}:main_pve`).setLabel('Add — Main PvE').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`vote-mode-add:${poll.id}:${item.id}:offspec`).setLabel('Add — Off‑spec').setStyle(ButtonStyle.Secondary),
  )

  const removeButtons = []
  if (have.has('main_pvp')) removeButtons.push(
    new ButtonBuilder().setCustomId(`vote-mode-remove:${poll.id}:${item.id}:main_pvp`).setLabel('Remove — Main PvP').setStyle(ButtonStyle.Danger)
  )
  if (have.has('main_pve')) removeButtons.push(
    new ButtonBuilder().setCustomId(`vote-mode-remove:${poll.id}:${item.id}:main_pve`).setLabel('Remove — Main PvE').setStyle(ButtonStyle.Danger)
  )
  if (have.has('offspec')) removeButtons.push(
    new ButtonBuilder().setCustomId(`vote-mode-remove:${poll.id}:${item.id}:offspec`).setLabel('Remove — Off‑spec').setStyle(ButtonStyle.Danger)
  )
  const rows = [addRow]
  if (removeButtons.length) rows.push(new ActionRowBuilder().addComponents(...removeButtons))

  return inter.reply({
    content: `**${item.name}** — choose what this vote is for:`,
    components: rows,
    flags: MessageFlags.Ephemeral
  })
}

async function handleVoteModeAdd(inter) {
  const [, , pollIdStr, itemIdStr, mode] = inter.customId.split(':') // vote-mode-add:<pollId>:<itemId>:<mode>
  const pollId = Number(pollIdStr)
  const itemId = Number(itemIdStr)
  const poll = await pollsRepo.getPollById(pollId)
  if (!poll) return inter.reply({ content: 'Poll not found.', flags: MessageFlags.Ephemeral })
  if (!poll.is_open) return inter.reply({ content: 'Poll closed.', flags: MessageFlags.Ephemeral })
  const item = (await itemsRepo.getItems(poll.id)).find(i => i.id === itemId)
  if (!item) return inter.reply({ content: 'Item not found.', flags: MessageFlags.Ephemeral })

  const gate = await checkVoteAllowedByMode(poll, inter.user.id, item, mode)

  if (!gate.ok) {
    // NEW: show replacement options for this bucket
    return presentReplacementPrompt(inter, { poll, newItem: item, mode, reason: gate.reason })
  }

  await votesRepo.voteWithMode(poll.id, item.id, inter.user.id, niceName(inter), mode)
  await inter.reply({ content: `Voted for **${item.name}** — ${labelModeLong(mode)}.`, flags: MessageFlags.Ephemeral })

  const chan = getPollChannel(inter.guild) || inter.channel
  await upsertPollMessage(chan, poll)
}

async function handleVoteModeRemove(inter) {
  const [, , pollIdStr, itemIdStr, mode] = inter.customId.split(':') // vote-mode-remove:<pollId>:<itemId>:<mode>
  const pollId = Number(pollIdStr)
  const itemId = Number(itemIdStr)
  const poll = await pollsRepo.getPollById(pollId)
  if (!poll) return inter.reply({ content: 'Poll not found.', flags: MessageFlags.Ephemeral })
  const item = (await itemsRepo.getItems(poll.id)).find(i => i.id === itemId)
  if (!item) return inter.reply({ content: 'Item not found.', flags: MessageFlags.Ephemeral })

  const removed = await votesRepo.removeVoteForUserItemMode(pollId, itemId, inter.user.id, mode)
  if (!removed) return inter.reply({ content: `You had no **${labelModeLong(mode)}** vote on **${item.name}**.`, flags: MessageFlags.Ephemeral })

  await inter.reply({ content: `Removed your **${labelModeLong(mode)}** vote for **${item.name}**.`, flags: MessageFlags.Ephemeral })

  const chan = getPollChannel(inter.guild) || inter.channel
  await upsertPollMessage(chan, poll)
}

async function presentReplacementPrompt(inter, { poll, newItem, mode, reason }) {
  const mine = await getUserVotesAcrossGuildByMode(poll.guild_id, inter.user.id, mode, { onlyOpen: true })
  const slot = normalizeSlotForLimits(newItem.slot || '')

  let bucketName = ''
  let current = []

  if (newItem.category === 'weapon') {
    bucketName = `${labelMode(mode)} weapons`
    current = mine.filter(v => v.item.category === 'weapon')
  } else if (newItem.category === 'accessory' && slot === 'earring') {
    bucketName = `${labelMode(mode)} earrings`
    current = mine.filter(v => v.item.category === 'accessory' && normalizeSlotForLimits(v.item.slot) === 'earring')
  } else if (newItem.category === 'armor') {
    bucketName = `${labelMode(mode)} ${labelSlot(slot)}`
    current = mine.filter(v => v.item.category === 'armor' && normalizeSlotForLimits(v.item.slot) === slot)
  } else if (newItem.category === 'accessory') {
    bucketName = `${labelMode(mode)} ${labelSlot(slot)}`
    current = mine.filter(v => v.item.category === 'accessory' && normalizeSlotForLimits(v.item.slot) === slot)
  } else {
    bucketName = `${labelMode(mode)}`
    current = mine
  }

  if (!current.length) {
    return inter.reply({ content: reason || 'You have reached the limit.', flags: MessageFlags.Ephemeral })
  }

  // Build "Replace" buttons (<= 5 per row)
  const rows = []
  for (let i=0; i<current.length; i+=5) {
    const slice = current.slice(i, i+5)
    rows.push(new ActionRowBuilder().addComponents(
      ...slice.map(({poll:oldPoll, item:oldItem}) =>
        new ButtonBuilder()
          .setCustomId(`vote-mode-replace:${oldPoll.id}:${oldItem.id}:${mode}:${poll.id}:${newItem.id}`)
          .setLabel(`Replace ${oldItem.name}`)
          .setStyle(ButtonStyle.Primary)
      )
    ))
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vote-mode-cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  ))

  const listing = current.map(({poll:pp, item:ii}) => `• **${ii.name}** — in poll *${pp.name}*`).join('\n')

  return inter.reply({
    content: `You have reached the limit for **${bucketName}**.\nChoose one to replace with **${newItem.name}**:\n\n${listing}`,
    components: rows,
    flags: MessageFlags.Ephemeral
  })
}

async function handleVoteModeReplace(inter) {
  const [, , oldPollIdStr, oldItemIdStr, mode, newPollIdStr, newItemIdStr] = inter.customId.split(':')
  const oldPollId = Number(oldPollIdStr)
  const newPollId = Number(newPollIdStr)
  const oldItemId = Number(oldItemIdStr)
  const newItemId = Number(newItemIdStr)

  const oldPoll = await pollsRepo.getPollById(oldPollId)
  const newPoll = await pollsRepo.getPollById(newPollId)
  if (!oldPoll || !newPoll) return inter.update({ content:'Poll not found.', components: [] })

  const oldItem = (await itemsRepo.getItems(oldPollId)).find(i => i.id === oldItemId)
  const newItem = (await itemsRepo.getItems(newPollId)).find(i => i.id === newItemId)
  if (!oldItem || !newItem) return inter.update({ content:'Item not found.', components: [] })

  // Remove old vote (mode) then add new
  await votesRepo.removeVoteForUserItemMode(oldPollId, oldItemId, inter.user.id, mode)

  // Re-check gate after removing one
  const gate = await checkVoteAllowedByMode(newPoll, inter.user.id, newItem, mode)
  if (!gate.ok) {
    return inter.update({ content:`Could not add new vote: ${gate.reason}`, components: [] })
  }

  await votesRepo.voteWithMode(newPollId, newItemId, inter.user.id, niceName(inter), mode)

  const chan = getPollChannel(inter.guild) || inter.channel
  await upsertPollMessage(chan, oldPoll)
  if (newPollId !== oldPollId) await upsertPollMessage(chan, newPoll)

  return inter.update({
    content:`Replaced your **${labelModeLong(mode)}** vote: **${oldItem.name}** → **${newItem.name}**.`,
    components: []
  })
}

async function handleVoteModeCancel(inter) {
  return inter.update({ content: 'Cancelled.', components: [] })
}


async function getPollIdForItem(itemId){
  const { header, rows } = await readSheet(SHEET_ITEMS)
  const m = idxMap(header)
  for (const r of rows) {
    if (parseInt(r[m.get('id')],10) === Number(itemId)) {
      const poll_id = parseInt(r[m.get('poll_id')],10)
      return await pollsRepo.getPollById(poll_id)
    }
  }
  return null
}

async function handleAdminPanel(inter) {
  const parts = inter.customId.split(':'); // admin:panel:<pollId>
  const pollId = Number(parts[2]);
  const poll = await pollsRepo.getPollById(pollId);

  if (!isAdmin(inter.member)) {
    return inter.reply({ content: 'Admin only.', flags: MessageFlags.Ephemeral });
  }
  if (!poll) {
    return inter.reply({ content: 'Poll not found for this admin panel.', flags: MessageFlags.Ephemeral });
  }

  const items = await itemsRepo.getItems(poll.id);
  const hasItems = items.length > 0;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`admin:item:${poll.id}`)
    .setPlaceholder(hasItems ? 'Select an item to manage...' : 'No items in this poll')
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(!hasItems);

  if (hasItems) {
    menu.addOptions(
      ...items.slice(0, 25).map(i =>
        new StringSelectMenuOptionBuilder().setLabel(itemLabel(i)).setValue(String(i.id))
      )
    );
  } else {
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('No items')
        .setValue('noop')
        .setDescription('Add items with /poll add')
        .setDefault(true)
    );
  }

  const row1 = new ActionRowBuilder().addComponents(menu);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin:voterspoll:${poll.id}`).setLabel('Show all voters (poll)').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`admin:clearpoll:${poll.id}`).setLabel('Clear ALL votes in poll').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`admin:deletepoll:${poll.id}`).setLabel('Delete Poll').setStyle(ButtonStyle.Danger)
  );

  const embed = new EmbedBuilder()
    .setTitle(`Admin • ${poll.name}`)
    .setDescription('Select an item to view/modify voters, or use actions below.');

  return inter.reply({ embeds:[embed], components:[row1, row2], flags: MessageFlags.Ephemeral });
}


async function renderItemAdminView(inter, poll, item) {
  const voters = await votesRepo.votersForItem(poll.id, item.id); // [{id,name}]
  const names = voters.map(fmtVoter);
  const header = `**${itemLabel(item)}** — ${names.length} vote${names.length===1?'':'s'}`;

  const hasVoters = voters.length > 0;

  // Build voter menu safely (must always have 1-25 options, even if disabled)
  const voterMenu = new StringSelectMenuBuilder()
    .setCustomId(`admin:pickvoter:${poll.id}:${item.id}`)
    .setPlaceholder(hasVoters ? 'Select a voter to remove…' : 'No voters')
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(!hasVoters);

  if (hasVoters) {
    voterMenu.addOptions(
      ...voters.slice(0, 25).map(v =>
        new StringSelectMenuOptionBuilder()
          .setLabel(v.name || v.id)
          .setDescription(v.name ? v.id : 'remove vote')
          .setValue(v.id)
      )
    );
  } else {
    voterMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('No voters')
        .setValue('noop')
        .setDescription('No one has voted on this item')
        .setDefault(true)
    );
  }

  const rowPicker = new ActionRowBuilder().addComponents(voterMenu);

  const rowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin:clearitem:${poll.id}:${item.id}`).setLabel('Clear ALL for this item').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`admin:back:${poll.id}`).setLabel('Back').setStyle(ButtonStyle.Secondary),
  );

  const rowModes = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin:cross:${poll.id}:${item.id}:main_pvp`).setLabel('Across polls: Main PvP').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`admin:cross:${poll.id}:${item.id}:main_pve`).setLabel('Across polls: Main PvE').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`admin:cross:${poll.id}:${item.id}:offspec`).setLabel('Across polls: Offspec').setStyle(ButtonStyle.Secondary),
  );

  const content = `${header}\n${names.length ? names.map(n => `• ${n}`).join('\n') : '• none'}`;

  // Do NOT include ephemeral in editReply payloads
  const payload = { content, components:[rowPicker, rowButtons, rowModes], embeds:[] };

  if (inter.deferred || inter.replied) {
    return inter.editReply(payload);
  }
  return inter.reply({ ...payload, flags: MessageFlags.Ephemeral });
}


async function handleAdminSelectItem(inter) {
  if (!isAdmin(inter.member)) return inter.reply({ content:'Admin only.', flags: MessageFlags.Ephemeral })
  const [ , , pollIdStr ] = inter.customId.split(':') // admin:item:<pollId>
  const pollId = Number(pollIdStr)
  const itemId = Number(inter.values?.[0])
  const poll = await pollsRepo.getPollById(pollId)
  if (!poll) return inter.reply({ content:'Poll not found.', flags: MessageFlags.Ephemeral })
  const item = (await itemsRepo.getItems(pollId)).find(i => i.id === itemId)
  if (!item) return inter.reply({ content:'Item not found.', flags: MessageFlags.Ephemeral })

  // show item admin view
  return inter.update({ content: 'Loading…', components: [], embeds: [] })
    .catch(()=>null)
    .then(() => renderItemAdminView(inter, poll, item))
}

async function handleAdminPickVoter(inter) {
  if (!isAdmin(inter.member)) return inter.reply({ content:'Admin only.', flags: MessageFlags.Ephemeral })
  const [ , , pollIdStr, itemIdStr ] = inter.customId.split(':') // admin:pickvoter:<pollId>:<itemId>
  const pollId = Number(pollIdStr)
  const itemId = Number(itemIdStr)
  const userId = inter.values?.[0]
  if (!userId) return inter.reply({ content:'No user selected.', flags: MessageFlags.Ephemeral })
  const poll = await pollsRepo.getPollById(pollId)
  if (!poll) return inter.reply({ content:'Poll not found.', flags: MessageFlags.Ephemeral })
  const item = (await itemsRepo.getItems(pollId)).find(i => i.id === itemId)
  if (!item) return inter.reply({ content:'Item not found.', flags: MessageFlags.Ephemeral })

  await votesRepo.removeVoteForUserItem(pollId, itemId, userId)
  await upsertPollMessage(getPollChannel(inter.guild) || inter.channel, poll)
  // re-render
  return renderItemAdminView(inter, poll, item)
}

async function handleAdminClearItem(inter) {
  if (!isAdmin(inter.member)) return inter.reply({ content:'Admin only.', flags: MessageFlags.Ephemeral })
  const [ , , pollIdStr, itemIdStr ] = inter.customId.split(':') // admin:clearitem:<pollId>:<itemId>
  const pollId = Number(pollIdStr)
  const itemId = Number(itemIdStr)
  const poll = await pollsRepo.getPollById(pollId)
  if (!poll) return inter.reply({ content:'Poll not found.', flags: MessageFlags.Ephemeral })
  const item = (await itemsRepo.getItems(pollId)).find(i => i.id === itemId)
  if (!item) return inter.reply({ content:'Item not found.', flags: MessageFlags.Ephemeral })

  const removed = await votesRepo.clearVotesForItem(pollId, itemId)
  await upsertPollMessage(getPollChannel(inter.guild) || inter.channel, poll)
  return renderItemAdminView(inter, poll, item)
    .then(()=> inter.followUp({ content:`Cleared ${removed} vote(s) for **${itemLabel(item)}**.`, flags: MessageFlags.Ephemeral }))
}

async function handleAdminClearPoll(inter) {
  if (!isAdmin(inter.member)) return inter.reply({ content:'Admin only.', flags: MessageFlags.Ephemeral })
  const pollId = Number(inter.customId.split(':')[2]) // admin:clearpoll:<pollId>
  const poll = await pollsRepo.getPollById(pollId)
  if (!poll) return inter.reply({ content:'Poll not found.', flags: MessageFlags.Ephemeral })

  const removed = await votesRepo.clearAllVotesInPoll(pollId)
  await upsertPollMessage(getPollChannel(inter.guild) || inter.channel, poll)
  return inter.update({ content:`Cleared ${removed} vote(s) in **${poll.name}**.`, embeds:[], components:[] })
}

async function handleAdminDeletePoll(inter) {
  if (!isAdmin(inter.member)) return inter.reply({ content: 'Admin only.', flags: MessageFlags.Ephemeral })
  const pollId = Number(inter.customId.split(':')[2]) // admin:deletepoll:<pollId>
  const poll = await pollsRepo.getPollById(pollId)
  if (!poll) return inter.update({ content:'Poll not found (it may already be deleted).', components:[], embeds:[] })

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin:deleteconfirm:${poll.id}`).setLabel('Yes, delete this poll').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`admin:back:${poll.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  )

  const warning = [
    `You are about to **permanently delete** **${poll.name}** (ID ${poll.id}).`,
    `This removes the poll, its items, and all votes from Google Sheets.`,
    `This action **cannot be undone**.`
  ].join('\n')

  return inter.update({ content: warning, components:[confirmRow], embeds:[] })
}

async function handleAdminDeleteConfirm(inter) {
  if (!isAdmin(inter.member)) return inter.reply({ content: 'Admin only.', flags: MessageFlags.Ephemeral })
  const pollId = Number(inter.customId.split(':')[2]) // admin:deleteconfirm:<pollId>
  const poll = await pollsRepo.getPollById(pollId)
  if (!poll) return inter.update({ content:'Poll not found (it may already be deleted).', components:[], embeds:[] })

  // 1) Wipe data from sheets
  await wipePoll(poll.id)

  // 2) Best-effort: remove the bot’s poll message(s) showing this poll in the likely channels
  async function deletePollMessagesInChannel(channel, id) {
    if (!channel?.isTextBased?.()) return
    try {
      const msgs = await channel.messages.fetch({ limit: 50 }).catch(()=>null)
      if (!msgs) return
      const mine = msgs.filter(m => m.author.id === channel.client.user.id && m.embeds[0]?.footer?.text?.includes(`Poll ID: ${id}`))
      for (const [, m] of mine) await m.delete().catch(()=>null)
    } catch {}
  }

  const tried = new Set()
  const targets = []
  const mainChan = getPollChannel(inter.guild)
  if (mainChan && !tried.has(mainChan.id)) { targets.push(mainChan); tried.add(mainChan.id) }
  if (inter.channel && !tried.has(inter.channel.id)) { targets.push(inter.channel); tried.add(inter.channel.id) }

  for (const chan of targets) await deletePollMessagesInChannel(chan, poll.id)

  // 3) Confirm to admin and clear components
  return inter.update({
    content: `Deleted poll **${poll.name}** (ID ${poll.id}).`,
    components: [],
    embeds: []
  })
}

async function handleAdminVotersPoll(inter) {
  if (!isAdmin(inter.member)) return inter.reply({ content:'Admin only.', flags: MessageFlags.Ephemeral })
  const pollId = Number(inter.customId.split(':')[2]) // admin:voterspoll:<pollId>
  const poll = await pollsRepo.getPollById(pollId)
  if (!poll) return inter.reply({ content:'Poll not found.', flags: MessageFlags.Ephemeral })

  const items = await itemsRepo.getItems(poll.id)
  const blocks = []
  for (const it of items) {
    const voters = await votesRepo.votersForItem(poll.id, it.id)
    const names = voters.map(fmtVoter)
    blocks.push(`**${itemLabel(it)}** — ${names.length} vote${names.length===1?'':'s'}\n${names.length?names.map(n=>`• ${n}`).join('\n'):'• none'}`)
  }
  const content = blocks.join('\n\n')
  if (content.length > 1900) {
    const buf = Buffer.from(content, 'utf8')
    return inter.reply({
      content: `Voters for **${poll.name}** (attached).`,
      files: [{ attachment: buf, name: `voters-poll-${poll.id}.txt` }],
      flags: MessageFlags.Ephemeral
    })
  }
  return inter.reply({ content, flags: MessageFlags.Ephemeral })
}

async function handleAdminCrossMode(inter) {
  if (!isAdmin(inter.member)) return inter.reply({ content:'Admin only.', flags: MessageFlags.Ephemeral })
  const [ , , pollIdStr, itemIdStr, mode ] = inter.customId.split(':') // admin:cross:<pollId>:<itemId>:<mode>
  const pollId = Number(pollIdStr)
  const itemId = Number(itemIdStr)
  const poll = await pollsRepo.getPollById(pollId)
  if (!poll) return inter.reply({ content:'Poll not found.', flags: MessageFlags.Ephemeral })
  const item = (await itemsRepo.getItems(pollId)).find(i => i.id === itemId)
  if (!item) return inter.reply({ content:'Item not found.', flags: MessageFlags.Ephemeral })

  const agg = await aggregateVotesAcrossGuildForItemByMode(poll.guild_id, (item.name_lc||item.name.toLowerCase()), mode)
  if (!agg.length) return inter.reply({ content:`No votes found across polls for **${item.name}** in **${labelMode(mode)}**.`, flags: MessageFlags.Ephemeral })

  const blocks = agg.map(({ poll:pp, item:ii, voters }) => {
    const names = voters.map(fmtVoter)
    return `**${pp.name}** — ${names.length} vote${names.length===1?'':'s'}\n${names.map(n=>`• ${n}`).join('\n')}`
  })
  const content = `Across polls for **${item.name}** • ${labelMode(mode)}:\n\n${blocks.join('\n\n')}`

  if (content.length > 1900) {
    const buf = Buffer.from(content, 'utf8')
    return inter.reply({
      content: `Cross-poll voters for **${item.name}** • ${labelMode(mode)} (attached).`,
      files: [{ attachment: buf, name: `voters-${item.name}-${mode}.txt` }],
      flags: MessageFlags.Ephemeral
    })
  }
  return inter.reply({ content, flags: MessageFlags.Ephemeral })
}


async function handleAutocomplete(inter) {
  const cmd = inter.commandName
  const guildId = inter.guildId
  const pollArg = inter.options.getString('poll')
  const entered = (inter.options.getFocused() || '').toLowerCase()
  const poll = pollArg ? await resolvePoll(guildId, pollArg) : null
  if (!poll) return inter.respond([])
  const items = await itemsRepo.getItems(poll.id)
  const choices = items
    .filter(i => `${i.name}${i.slot?` (${i.slot})`:''}`.toLowerCase().includes(entered))
    .slice(0, 25)
    .map(i => ({ name: `${labelCat(i.category)} • ${i.name}${i.slot?` (${i.slot})`:''}`, value: i.name }))
  await inter.respond(choices)
}

async function getUserVotesAcrossGuild(guild_id, { sameMode = null, onlyOpen = true, user_id }) {
  const polls = await pollsRepo.listPolls(guild_id);
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

    const items = await itemsRepo.getItems(p.id);
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

