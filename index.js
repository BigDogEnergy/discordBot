require('dotenv').config();

// Access environment variables
const discordToken = process.env.DISCORD_BOT_TOKEN;
const googleSheetsToken = process.env.GOOGLE_SHEETS_TOKEN;


const { Client, GatewayIntentBits } = require('discord.js');
const { google } = require('googleapis');
const fs = require('fs');

// 1. Discord Bot Setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

// Insert your bot token here
const DISCORD_TOKEN = discordToken;

// 2. Google Sheets Setup
const auth = new google.auth.GoogleAuth({
  keyFile: googleSheetsToken,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});


// 3. Discord Events & Commands
client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
  // Simple command check. In practice, use a more robust command handler.
  if (message.author.bot) return;

  if (message.content === '!getdata') {
    // Replace with your Spreadsheet ID (found in the sheet’s URL)
    const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID';
    // Specify the range you want to read, e.g., "Sheet1!A1:C10"
    const RANGE = 'Sheet1!A1:C10';

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
