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

  if (message.content.startsWith('!balance')) {
    const args = message.content.split(' ').slice(1);
    const guildMemberName = args.join(' ').trim();

    if (!guildMemberName) {
      message.channel.send('Please provide a guild member name. Usage: `!balance <guild member name>`');
      return;
    }

    const SPREADSHEET_ID = '1pAcZtOQy07ZwdmfmDtjgzhR2dSl_3Xmlabmfstaza7wD';
    const RANGE = 'Silver Eclipse!A3:B';

    try {
      const data = await getSheetData(SPREADSHEET_ID, RANGE);

      if (!data || data.length === 0) {
        message.channel.send('No data found in the specified range.');
        return;
      }

      // Find the guild member in the data
      const memberData = data.find(row => row[1]?.toLowerCase() === guildMemberName.toLowerCase());

      if (memberData) {
        const balance = memberData[0]; // Balance is in column A (index 0)
        message.channel.send(`The balance for **${guildMemberName}** is: **${balance} DKP**.`);
      } else {
        message.channel.send(`Guild member **${guildMemberName}** not found.`);
      }
    } catch (error) {
      console.error('Error fetching data from Google Sheets:', error);
      message.channel.send('There was an error fetching the data. Check the logs.');
    }
  }
});

// 4. Login the bot
client.login(DISCORD_TOKEN);
