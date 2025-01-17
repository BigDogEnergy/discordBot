require('dotenv').config();

// Environment Variables
const discordToken = process.env.DISCORD_BOT_TOKEN;
const googleSheetsKeyFile = process.env.GOOGLE_SHEETS_KEY_FILE;
const spreadsheetId = process.env.SPREADSHEET_ID;

const { Client, GatewayIntentBits } = require('discord.js');
const { google } = require('googleapis');

// Support Functions
    async function getSheetData(spreadsheetId, range) {
      try {
        const authClient = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });

        console.log(`Fetching data from Spreadsheet: ${spreadsheetId}, Range: ${range}`);
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: spreadsheetId,
          range: range,
        });

        console.log('Data fetched:', response.data.values);
        return response.data.values; // Returns 2D array
      } catch (error) {
        console.error('Error in getSheetData:', error.message);
        throw error;
      }
    }

// 1. Discord Bot Setup
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
    const DISCORD_TOKEN = discordToken;

// 2. Google Sheets Setup
    const auth = new google.auth.GoogleAuth({
      keyFile: googleSheetsKeyFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

// 3. Discord Events & Commands
    client.on('ready', () => {
      console.log(`Logged in as ${client.user.tag}!`);
    });

    client.on('messageCreate', async (message) => {
      if (message.author.bot) return;

      if (message.content.startsWith('!graceList')) {
        const RANGE = 'Balance!A1:B71'; // Fetch headers and data from rows 1 to 71

        try {
          // Fetch data from Google Sheets
          const data = await getSheetData(spreadsheetId, RANGE);

          if (!data || data.length === 0) {
            message.channel.send('No data found in the specified range.');
            return;
          }

          // Extract headers (A1 and B1)
          const headers = data[0]; // First row (A1 and B1)

          // Extract data rows (A2:A71 and B2:B71)
          const rows = data.slice(1); // Skip the first row (headers)

          // Format the data
          const formattedRows = rows
            .map(row => `${row[0] || 'N/A'}: ${row[1] || 'No Guild Member'}`) // "Balance: Guild Member"
            .join('\n');

          // Send the response
          message.channel.send(
            `All Current Users:\n\`\`\`\n${formattedRows}\n\`\`\``
          );
        } catch (error) {
          console.error('Error fetching data from Google Sheets:', error.message);
          message.channel.send('There was an error fetching the data. Check the logs.');
        }
      }
    });

    client.on('messageCreate', async (message) => {
      if (message.author.bot) return;
    
      if (message.content.startsWith('!balance')) {
        const args = message.content.split(' ').slice(1);
        const guildMemberName = args.join(' ').trim(); // Extract the guild member name
    
        if (!guildMemberName) {
          message.channel.send('Please provide a guild member name. Usage: `!balance <guildMember>`');
          return;
        }
    
        const RANGE = 'Balance!A2:B71'; // Range for data (excluding headers)
    
        try {
          // Fetch data from the Google Sheet
          const data = await getSheetData(spreadsheetId, RANGE);
    
          if (!data || data.length === 0) {
            message.channel.send('No data found in the specified range.');
            return;
          }
    
          // Log all rows for debugging
          console.log('Fetched rows:', data);
    
          // Search for the guild member in column A
          const memberRow = data.find(row => row[0]?.toLowerCase() === guildMemberName.toLowerCase());
    
          if (memberRow) {
            const balance = memberRow[1]; // Balance is in column B
            message.channel.send(`**${guildMemberName}** has: **${balance} DKP**.`);
          } else {
            message.channel.send(`Guild member **${guildMemberName}** not found.`);
          }
        } catch (error) {
          console.error('Error fetching data from Google Sheets:', error.message);
          message.channel.send('There was an error fetching the data. Check the logs.');
        }
      }
    });    
    
    client.on('messageCreate', async (message) => {
      if (message.author.bot) return;
    
      if (message.content.startsWith('!addGrace')) {
        // Ensure the user has the "Silver Eclipse Leader" role
        const memberRoles = message.member.roles.cache;
        if (!memberRoles.some(role => role.name === 'Silver Eclipse Leader')) {
          message.channel.send('You do not have permission to use this command.');
          return;
        }
    
        // Extract arguments: guildMember and points
        const args = message.content.split(' ').slice(1);
        if (args.length < 2) {
          message.channel.send('Usage: `!addGrace <guildMember> <points>`');
          return;
        }
    
        const guildMemberName = args.slice(0, -1).join(' ').trim(); // All but the last argument
        const pointsToAdd = parseInt(args[args.length - 1], 10); // Last argument
    
        if (isNaN(pointsToAdd)) {
          message.channel.send('Please provide a valid number of points.');
          return;
        }
    
        const RANGE = 'Balance!A2:B71'; // Range for data (excluding headers)
    
        try {
          // Fetch data from the Google Sheet
          const data = await getSheetData(spreadsheetId, RANGE);
    
          if (!data || data.length === 0) {
            message.channel.send('No data found in the specified range.');
            return;
          }
    
          // Find the guild member in column A
          const rowIndex = data.findIndex(row => row[0]?.toLowerCase() === guildMemberName.toLowerCase());
    
          if (rowIndex === -1) {
            message.channel.send(`Guild member **${guildMemberName}** not found.`);
            return;
          }
    
          // Calculate new balance
          const currentBalance = parseInt(data[rowIndex][1], 10) || 0; // Column B
          const newBalance = currentBalance + pointsToAdd;
    
          // Update the balance in the Google Sheet
          const authClient = await auth.getClient();
          const sheets = google.sheets({ version: 'v4', auth: authClient });
    
          const updateRange = `Balance!B${rowIndex + 2}`; // Adjust for zero-index and skip headers
          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: {
              values: [[newBalance]],
            },
          });
    
          message.channel.send(
            `Added **${pointsToAdd}** points to **${guildMemberName}**. New balance: **${newBalance} DKP**.`
          );
        } catch (error) {
          console.error('Error updating balance:', error.message);
          message.channel.send('There was an error updating the balance. Check the logs.');
        }
      }
    });
    

// 4. Login the bot
    client.login(DISCORD_TOKEN);
