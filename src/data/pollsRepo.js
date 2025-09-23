// src/data/pollsRepo.js
import { readSheet, appendRows, overwriteRows, idxMap } from '../infra/sheets.js'

const TAB = 'Polls'

async function nextId() {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header); const idIdx = m.get('id')
  if (idIdx == null) return 1
  let max = 0; for (const r of rows) { const v = parseInt(r[idIdx]||'0',10); if (v>max) max=v }
  return max + 1
}

export async function createPoll({ guild_id, name, expires_at=null, type, mode }) {
  const id = await nextId()
  await appendRows(TAB, [[String(id), guild_id, name, '1', expires_at?String(expires_at):'', type, mode]])
  return { id, guild_id, name, is_open:1, expires_at, type, mode }
}

export async function listPolls(guild_id) {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)
  return rows.filter(r => r[m.get('guild_id')] === guild_id).map(r => ({
    id: parseInt(r[m.get('id')],10),
    guild_id: r[m.get('guild_id')], name: r[m.get('name')],
    is_open: parseInt(r[m.get('is_open')]||'0',10),
    expires_at: r[m.get('expires_at')] ? parseInt(r[m.get('expires_at')],10) : null,
    type: r[m.get('type')], mode: r[m.get('mode')],
  })).sort((a,b)=>b.id-a.id)
}

export async function getPollById(id) {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)
  for (const r of rows) {
    if (parseInt(r[m.get('id')],10) === Number(id)) {
      return {
        id: Number(id), guild_id: r[m.get('guild_id')], name: r[m.get('name')],
        is_open: parseInt(r[m.get('is_open')]||'0',10),
        expires_at: r[m.get('expires_at')] ? parseInt(r[m.get('expires_at')],10) : null,
        type: r[m.get('type')], mode: r[m.get('mode')],
      }
    }
  }
  return null
}

export async function getPollByName(guild_id, name) {
  const all = await listPolls(guild_id)
  return all.find(p => p.name.toLowerCase() === name.toLowerCase()) || null
}

export async function setPollClosed(id) {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)
  for (const r of rows) {
    if (parseInt(r[m.get('id')],10) === Number(id)) { r[m.get('is_open')] = '0'; break }
  }
  await overwriteRows(TAB, header, rows)
}
