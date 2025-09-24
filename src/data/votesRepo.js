import { readSheet, appendRows, overwriteRows, idxMap } from '../infra/sheets.js'
import { SHEET_VOTES as TAB } from '../infra/constants.js';

export async function countVotesForItem(poll_id, item_id) {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)
  return rows.filter(r =>
    parseInt(r[m.get('poll_id')],10) === Number(poll_id) &&
    parseInt(r[m.get('item_id')],10) === Number(item_id)
  ).length
}

export async function votersForItem(poll_id, item_id) {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)
  return rows.filter(r =>
    parseInt(r[m.get('poll_id')],10) === Number(poll_id) &&
    parseInt(r[m.get('item_id')],10) === Number(item_id)
  ).map(r => ({
    id: r[m.get('user_id')],
    name: m.has('user_name') ? (r[m.get('user_name')] || '') : ''
  }))
}

export async function voteWithMode(poll_id, item_id, user_id, user_name='', mode) {
  const vs = await readSheet(TAB)
  const m = idxMap(vs.header)
  const exists = vs.rows.some(r =>
    parseInt(r[m.get('poll_id')],10) === Number(poll_id) &&
    parseInt(r[m.get('item_id')],10) === Number(item_id) &&
    r[m.get('user_id')] === user_id &&
    (!m.has('mode') || r[m.get('mode')] === mode)
  )
  if (!exists) {
    const row = new Array(vs.header.length).fill('')
    row[m.get('poll_id')] = String(poll_id)
    row[m.get('item_id')] = String(item_id)
    row[m.get('user_id')] = user_id
    if (m.has('user_name'))  row[m.get('user_name')]  = user_name || ''
    if (m.has('mode'))       row[m.get('mode')]       = mode
    if (m.has('created_at')) row[m.get('created_at')] = String(Date.now())
    await appendRows(TAB, [row])
  }
}

export async function removeVoteForUserItemMode(poll_id, item_id, user_id, mode) {
  const vs = await readSheet(TAB)
  const m = idxMap(vs.header)
  const before = vs.rows.length
  const rows = vs.rows.filter(r => !(
    parseInt(r[m.get('poll_id')],10) === Number(poll_id) &&
    parseInt(r[m.get('item_id')],10) === Number(item_id) &&
    r[m.get('user_id')] === user_id &&
    (!m.has('mode') || r[m.get('mode')] === mode)
  ))
  if (rows.length !== before) await overwriteRows(TAB, vs.header, rows)
  return before - rows.length
}

export async function removeVoteForUserItemAllModes(poll_id, item_id, user_id) {
  const vs = await readSheet(TAB)
  const m = idxMap(vs.header)
  const before = vs.rows.length
  const rows = vs.rows.filter(r => !(
    parseInt(r[m.get('poll_id')],10) === Number(poll_id) &&
    parseInt(r[m.get('item_id')],10) === Number(item_id) &&
    r[m.get('user_id')] === user_id
  ))
  if (rows.length !== before) await overwriteRows(TAB, vs.header, rows)
  return before - rows.length
}

export async function clearVotesForUser(poll_id, user_id) {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)
  const newRows = rows.filter(r => !(parseInt(r[m.get('poll_id')],10)===Number(poll_id) && r[m.get('user_id')]===user_id))
  const removed = rows.length - newRows.length
  if (removed) await overwriteRows(TAB, header, newRows)
  return removed
}

export async function clearVotesForItem(poll_id, item_id) {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)
  const newRows = rows.filter(r => !(parseInt(r[m.get('poll_id')],10)===Number(poll_id) && parseInt(r[m.get('item_id')],10)===Number(item_id)))
  const removed = rows.length - newRows.length
  if (removed) await overwriteRows(TAB, header, newRows)
  return removed
}

export async function clearAllVotesInPoll(poll_id) {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)
  const newRows = rows.filter(r => parseInt(r[m.get('poll_id')],10) !== Number(poll_id))
  const removed = rows.length - newRows.length
  if (removed) await overwriteRows(TAB, header, newRows)
  return removed
}

export async function deleteVotesForPoll(poll_id) {
  await clearAllVotesInPoll(poll_id)
}

export async function removeVoteForUserItem(poll_id, item_id, user_id) {
  const { header, rows } = await readSheet(TAB)
  const m = idxMap(header)
  const newRows = rows.filter(r => !(parseInt(r[m.get('poll_id')],10)===Number(poll_id) && parseInt(r[m.get('item_id')],10)===Number(item_id) && r[m.get('user_id')]===(user_id)))
  const removed = rows.length - newRows.length
  if (removed) await overwriteRows(TAB, header, newRows)
  return removed
}