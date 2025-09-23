// src/data/itemsRepo.js
import { readSheet, appendRows, overwriteRows, idxMap } from '../infra/sheets.js'
const TAB = 'Items'

async function nextId() {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header); const idIdx = m.get('id')
  if (idIdx == null) return 1
  let max = 0; for (const r of rows) { const v = parseInt(r[idIdx]||'0',10); if (v>max) max=v }
  return max + 1
}

export async function getItems(poll_id) {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)
  return rows.filter(r => parseInt(r[m.get('poll_id')],10) === Number(poll_id)).map(r => ({
    id: parseInt(r[m.get('id')],10),
    poll_id: parseInt(r[m.get('poll_id')],10),
    name: r[m.get('name')],
    name_lc: r[m.get('name_lc')],
    category: r[m.get('category')],
    slot: r[m.get('slot')] || '',
  })).sort((a,b)=>a.name.localeCompare(b.name))
}

export async function getItemByName(poll_id, itemName) {
  const items = await getItems(poll_id)
  const lc = (itemName||'').toLowerCase()
  return items.find(i => (i.name_lc || i.name.toLowerCase()) === lc) || null
}

export async function upsertItem(poll_id, name, category, slot='') {
  const id = await nextId()
  await appendRows(TAB, [[String(id), String(poll_id), name, name.toLowerCase(), category, slot]])
  return { id, poll_id, name, name_lc: name.toLowerCase(), category, slot }
}

export async function deleteItemsForPoll(poll_id) {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)
  const newRows = rows.filter(r => parseInt(r[m.get('poll_id')],10) !== Number(poll_id))
  await overwriteRows(TAB, header, newRows)
}
