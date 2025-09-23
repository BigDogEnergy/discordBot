// src/infra/sheets.js
import { google } from 'googleapis'

const {
  SPREADSHEET_ID,
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY: RAW_KEY,
} = process.env

if (!SPREADSHEET_ID || !GOOGLE_CLIENT_EMAIL || !RAW_KEY) {
  throw new Error('Missing SPREADSHEET_ID / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY')
}

const GOOGLE_PRIVATE_KEY = RAW_KEY.includes('BEGIN PRIVATE KEY')
  ? RAW_KEY
  : RAW_KEY.replace(/\\n/g, '\n')

const auth = new google.auth.JWT({
  email: GOOGLE_CLIENT_EMAIL,
  key: GOOGLE_PRIVATE_KEY,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
})

export const sheets = google.sheets({ version: 'v4', auth })

export async function readSheet(tab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${tab}!A:Z`
  })
  const values = res.data.values || []
  if (!values.length) return { header: [], rows: [] }
  return { header: values[0], rows: values.slice(1) }
}

export async function appendRows(tab, rows) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: `${tab}!A:Z`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  })
}

export async function overwriteRows(tab, header, rows) {
  // clear data area then write header + rows
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID, range: `${tab}!A2:Z`,
  })
  const width = header.length
  const endCol = String.fromCharCode(64 + width)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tab}!A1:${endCol}${rows.length + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [header, ...rows] },
  })
}

export function idxMap(header) {
  const m = new Map(); header.forEach((h,i)=>m.set(h,i)); return m
}

export { SPREADSHEET_ID, sheets as rawSheetsClient }
