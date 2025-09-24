// src/data/itemsRepo.js
import { readSheet, appendRows, overwriteRows, idxMap } from '../infra/sheets.js'

const TAB = 'Items'

async function nextId() {
  const { header, rows } = await readSheet(TAB)
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

export async function getItems(poll_id) {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)
  return rows
    .filter(r => Number(r[m.get('poll_id')]) === Number(poll_id))
    .map(r => ({
      id: Number(r[m.get('id')]),
      poll_id: Number(r[m.get('poll_id')]),
      name: r[m.get('name')] || '',
      // fall back to lower-cased name if name_lc was never backfilled
      name_lc: (r[m.get('name_lc')] || (r[m.get('name')] || '').toLowerCase()),
      category: (r[m.get('category')] || '').toLowerCase(),
      slot: (r[m.get('slot')] || '').toLowerCase(),
    }))
    .sort((a,b) => a.name.localeCompare(b.name))
}

export async function getItemByName(poll_id, itemName) {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)
  const targetLc = (itemName || '').trim().toLowerCase()

  const r = rows.find(r =>
    Number(r[m.get('poll_id')]) === Number(poll_id) &&
    ((r[m.get('name_lc')] || (r[m.get('name')] || '').toLowerCase()) === targetLc)
  )
  if (!r) return null

  return {
    id: Number(r[m.get('id')]),
    poll_id: Number(r[m.get('poll_id')]),
    name: r[m.get('name')] || itemName,
    name_lc: r[m.get('name_lc')] || targetLc,
    category: (r[m.get('category')] || '').toLowerCase(),
    slot: (r[m.get('slot')] || '').toLowerCase(),
  }
}

/**
 * Upsert semantics scoped to (poll_id, name_lc):
 * - If the item name already exists in THIS poll, update its category/slot/name_lc and return it.
 * - Otherwise, append a new row for THIS poll.
 */
export async function upsertItem(poll_id, name, category, slot = '') {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)

  const lc = (name || '').trim().toLowerCase()
  const cat = (category || '').trim().toLowerCase()
  const sl  = (slot || '').trim().toLowerCase()

  // Look only inside this poll
  const idx = rows.findIndex(r =>
    Number(r[m.get('poll_id')]) === Number(poll_id) &&
    ((r[m.get('name_lc')] || (r[m.get('name')] || '').toLowerCase()) === lc)
  )

  if (idx !== -1) {
    // Update in-place (true upsert)
    const r = rows[idx].slice()
    r[m.get('name')]     = name
    r[m.get('name_lc')]  = lc
    r[m.get('category')] = cat
    r[m.get('slot')]     = sl
    rows[idx] = r
    await overwriteRows(TAB, header, rows)
    return {
      id: Number(r[m.get('id')]),
      poll_id: Number(poll_id),
      name,
      name_lc: lc,
      category: cat,
      slot: sl
    }
  }

  // Not found in this poll: append a new row
  const id = await nextId()
  const newRow = []
  newRow[m.get('id')]       = String(id)
  newRow[m.get('poll_id')]  = String(poll_id)
  newRow[m.get('name')]     = name
  newRow[m.get('name_lc')]  = lc
  newRow[m.get('category')] = cat
  newRow[m.get('slot')]     = sl
  await appendRows(TAB, [newRow])

  return { id, poll_id, name, name_lc: lc, category: cat, slot: sl }
}

export async function deleteItemsForPoll(poll_id) {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)
  const newRows = rows.filter(r => Number(r[m.get('poll_id')]) !== Number(poll_id))
  await overwriteRows(TAB, header, newRows)
}
