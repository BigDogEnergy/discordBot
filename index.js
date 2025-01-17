require('dotenv').config();

// Environment Variables and Setup

const discordToken = process.env.DISCORD_BOT_TOKEN;
const googleSheetsKeyFile = process.env.GOOGLE_SHEETS_KEY_FILE;
const { Client, GatewayIntentBits } = require('discord.js');
const { google } = require('googleapis');
const fs = require('fs');

// Support Functions

async function getSheetData(spreadsheetId, range) {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: range,
  });

  return response.data.values; // -- This will return our data as a 2D array
}

// 1. Discord Bot Setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const DISCORD_TOKEN = discordToken;

// 2. Google Sheets Setup
const auth = new google.auth.GoogleAuth({
  keyFile: googleSheetsKeyFile,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});


// 3. Discord Events & Commands
client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content === '!getdata') {
    const SPREADSHEET_ID = '1pAcZtOQy07ZwdmfmDtjgzhR2dSl_3Xmlabmfstaza7wD';
    const RANGE = 'Silver Eclipse';


    try {
      const data = await getSheetData(SPREADSHEET_ID, RANGE);

      if (!data || data.length === 0) {
        message.channel.send('No data found in the specified range.');
        return;
      }

      // Format the data into a readable message
      const formattedData = data.map(row => row.join(' | ')).join('\n');
      message.channel.send('Here is the data from the sheet:\n```' + formattedData + '```');
    } catch (error) {
      console.error('Error fetching data from Google Sheets:', error);
      message.channel.send('There was an error fetching the data. Check the logs.');
    }
  }
});

// 4. Login the bot
client.login(DISCORD_TOKEN);
