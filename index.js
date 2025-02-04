require('dotenv').config();

// Environment Variables
const discordToken = process.env.DISCORD_BOT_TOKEN;
const googleSheetsKeyFile = process.env.GOOGLE_SHEETS_KEY_FILE;
const spreadsheetId = process.env.SPREADSHEET_ID;

const { 
  Client, 
  GatewayIntentBits, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  StringSelectMenuBuilder,
  EmbedBuilder 
} = require('discord.js');

const { google } = require('googleapis');

// Bosses Loot Tables

const bossItems = {
  "Adentus": [
    "Adentus's Gargantuan Greatsword",
    "Shadow Harvester Mask",
    "Blessed Templar Helmet",
    "Girdle of Spectral Skulls"
  ],
  "Ahzreil": [
    "Ahzreil's Siphoning Sword",
    "Swirling Essence Pants",
    "Divine Justiciar Pants",
    "Blessed Templar Cloak",
    "Gilded Raven Trousers"
  ],
  "Aridus": [
    "Aridus's Gnarled Voidstaff",
    "Phantom Wolf Breeches",
    "Breeches of the Executioner",
    "Belt of Bloodlust",
    "Gilded Raven Mask"
  ],
  "Chernobog": [
    "Chernobog's Blade of Beheading",
    "Helm of the Field General",
    "Arcane Shadow Shoes",
    "Bile Drenched Veil"
  ],
  "Cornelius": [
    "Cornelius's Animated Edge",
    "Ascended Guardian Hood",
    "Divine Justiciar Attire",
    "Abyssal Grace Charm"
  ],
  "Excavator-9": [
    "Excavator's Mysterious Scepter",
    "Heroic Breeches of the Resistance",
    "Embossed Granite Band",
  ],
  "Grand Aelon": [
    "Aelon's Rejuvenating Longbow",
    "Greaves of the Field General",
    "Arcane Shadow Pants",
    "Wrapped Coin Necklace"
  ],
  "Junobote": [
    "Junobote's Juggernaut Warblade",
    "Arcane Shadow Robes",
    "Shadow Harvester Trousers",
    "Forsaken Embrace",
    "Junobote's Smoldering Ranseur"
  ],
  "Kowazan": [
    "Kowazan's Twilight Daggers",
    "Kowazan's Sunflare Crossbows",
    "Shock Commander Greaves",
    "Collar of Decimation",
    "Arcane Shadow Hat",
  ],
  "Malakar": [
    "Malakar's Energizing Crossbows",
    "Shock Commander Visor",
    "Ebon Roar Gauntlets",
    "Gilded Infernal Wristlet"
  ],
  "Minezerok": [
    "Minzerok's Daggers of Crippling",
    "Swirling Essence Hat",
    "Divine Justiciar Gloves",
    "Blessed Templar Choker"
  ],
  "Morokai": [
    "Morokai's Greatblade of Corruption",
    "Arcane Shadow Gloves",
    "Abyssal Grace Pendant"
  ],
  "Nirma": [
    "Nirma's Sword of Echoes",
    "Ascended Guardian Pants",
    "Divine Justiciar Shoes",
    "Clasp of the Overlord"
  ],
  "Queen Bellandir": [
    "Queen Bellandir's Languishing Blade",
    "Queen Bellandir's Toxic Spine Throwers",
    "Queen Bellandir's Hivemind Staff",
    "Queen Bellandir's Serrated Spike",
    "Sabatons of the Field General",
    "Phantom Wolf Boots",
    "Ascended Guardian Shoes",
    "Band of Universal Power"
  ],
  "Talus": [
    "Talus's Crystalline Staff",
    "Phantom Wolf Mask",
    "Blessed Templar Plate Mail",
    "Forged Golden Bangle"
  ],
  "Tevent": [
    "Tevent's Warblade of Despair",
    "Tevent's Fangs of Fury",
    "Tevent's Arc of Wailing Death",
    "Tevent's Grasp of Withering",
    "Shock Commander Gauntlets",
    "Shadow Harvester Grips",
    "Swirling Essence Gloves",
    "Gilded Raven Grips"
  ]
};

const itemTraits = [
  "Attack Speed",
  "Bind Resistance",
  "Buff Duration",
  "Collision Resistance",
  "Cooldown Speed",
  "Critical Hit",
  "Debuff Duration",
  "Heavy Attack Chance",
  "Hit",
  "Magic Endurance",
  "Magic Evasion",
  "Mana Regen",
  "Max Health",
  "Max Mana",
  "Melee Endurance",
  "Melee Evasion",
  "Move Speed",
  "Ranged Endurance",
  "Ranged Evasion",
  "Silence Resistance",
  "Skill Damage Boost",
  "Skill Damage Resistance"
];

// Support Functions
    async function getSheetData(spreadsheetId, range) {
      try {
        const authClient = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });

        // console.log(`Fetching data from Spreadsheet: ${spreadsheetId}, Range: ${range}`);
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: spreadsheetId,
          range: range,
        });

        // console.log('Data fetched:', response.data.values);
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

    // Ready Event
    client.on('ready', () => {
      console.log(`Logged in as ${client.user.tag}!`);
    });

//////////////////////////////////////////////////////////////
//                      !gracelist
//////////////////////////////////////////////////////////////

    // Message Event -- !gracelist Command (List all guild members & their balance)
    client.on('messageCreate', async (message) => {
      if (message.author.bot) return;

      if (message.content.startsWith('!gracelist')) {
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

//////////////////////////////////////////////////////////////
//                      !balance
//////////////////////////////////////////////////////////////

    // Message Event -- !balance Command (Check balance of a specific guild member)
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
          // console.log('Fetched rows:', data);
    
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
    
//////////////////////////////////////////////////////////////
//                      !addgrace
//////////////////////////////////////////////////////////////
  
    // Message Event -- !addgrace Command (Add points to a specific guild member)
    client.on('messageCreate', async (message) => {
      if (message.author.bot) return;
    
      if (message.content.startsWith('!addgrace')) {
        // Ensure the user has the "Silver Eclipse Leader" role
        const memberRoles = message.member.roles.cache;
        if (!memberRoles.some(role => role.name === 'Silver Eclipse Leader')) {
          message.channel.send('You do not have permission to use this command.');
          return;
        }
    
        // Extract arguments: guildMember and points
        const args = message.content.split(' ').slice(1);
        if (args.length < 2) {
          message.channel.send('Usage: `!addgrace <guildMember> <points>`');
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

//////////////////////////////////////////////////////////////
//                      /donate
//////////////////////////////////////////////////////////////

    client.on('interactionCreate', async (interaction) => {
      // We check if it's a slash command
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'donate') {
          // Step 1: Show boss list (ephemeral)
          const bossOptions = Object.keys(bossItems).map((boss) => ({
            label: boss,
            value: boss,
          }));

          const bossRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('select_boss')
              .setPlaceholder('Select a boss...')
              .addOptions(bossOptions)
          );

          await interaction.reply({
            content: 'Please select the boss from which the item dropped:',
            components: [bossRow],
            ephemeral: true,
          });
        }
      }
      // If it's not a slash command, check if it’s a select menu or button
      else if (interaction.isStringSelectMenu()) {
        // handle ephemeral steps for boss/item/trait
        if (interaction.customId === 'select_boss') {
          const selectedBoss = interaction.values[0];
          const items = bossItems[selectedBoss] || [];

          const itemOptions = items.map(item => ({ label: item, value: item }));
          const itemRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('select_item')
              .setPlaceholder(`Select an item from ${selectedBoss}...`)
              .addOptions(itemOptions)
          );

          await interaction.update({
            content: `You selected **${selectedBoss}**. Now select an item:`,
            components: [itemRow],
          });
        }
        else if (interaction.customId === 'select_item') {
          const selectedItem = interaction.values[0];

          const traitOptions = itemTraits.map(trait => ({ label: trait, value: trait }));
          const traitRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('select_trait')
              .setPlaceholder(`Select a trait for ${selectedItem}...`)
              .addOptions(traitOptions)
          );

          await interaction.update({
            content: `You selected **${selectedItem}**. Now select a trait:`,
            components: [traitRow],
          });
        }
        else if (interaction.customId === 'select_trait') {
          // parse item from the ephemeral content
          const matchedItem = interaction.message.content.match(/You selected \*\*(.*)\*\*/);
          const selectedItem = matchedItem ? matchedItem[1] : 'UnknownItem';

          const selectedTrait = interaction.values[0];

          // create the thread publicly
          const targetChannel = interaction.guild.channels.cache.find(
            (ch) => ch.name === '🎰⥐guild-chest-requests'
          );
          if (!targetChannel) {
            await interaction.update({
              content: 'Target channel not found. Please notify an admin.',
              components: [],
            });
            return;
          }

          const threadName = `${selectedItem} (${selectedTrait})`;
          const thread = await targetChannel.threads.create({
            name: threadName,
            reason: 'Grace Request',
          });

          // donor is who initiated the menu steps
          const donorName = interaction.member?.displayName || interaction.user.username;

          // build the approve/deny buttons
          const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('approve_donation')
              .setLabel('Approve')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId('deny_donation')
              .setLabel('Deny')
              .setStyle(ButtonStyle.Danger)
          );

          await thread.send({
            content: `Donated by: **${donorName}**\nItem: **${selectedItem}**\nTrait: **${selectedTrait}**\n<@&1293318534142623775>`,
            components: [actionRow],
          });

          // ephemeral final step
          await interaction.update({
            content: `Your donation request for **${selectedItem}** with trait **${selectedTrait}** has been submitted for approval in ${thread.toString()}.`,
            components: [],
          });
        }
      }
      else if (interaction.isButton()) {
        // button logic for approve / deny
        // Ensure role
        const memberRoles = interaction.member.roles.cache;
        if (!memberRoles.some(role => role.name === 'Silver Eclipse Leader')) {
          await interaction.reply({ content: 'You do not have permission to use this button.', ephemeral: true });
          return;
        }

        // parse the donor from "Donated by: **someName**"
        const donorMatch = interaction.message.content.match(/Donated by: \**([\w]+)\**/);
        const donorName = donorMatch ? donorMatch[1] : null;
        // console.log("This is our donorName", donorName);

        if (!donorName) {
          await interaction.reply({ content: 'Unable to determine the donor.', ephemeral: true });
          return;
        }

        // fetch sheet data to update DKP
        let data;
        try {
          data = await getSheetData(spreadsheetId, 'Balance!A2:B71');
        } catch (err) {
          console.error('Error fetching data:', err);
          await interaction.reply({ content: 'Error fetching data. Check logs.', ephemeral: true });
          return;
        }

        const rowIndex = data.findIndex(row => row[0]?.toLowerCase() === donorName.toLowerCase());
        if (rowIndex === -1) {
          await interaction.reply({ content: `User **${donorName}** not found in the balance sheet.`, ephemeral: true });
          return;
        }

        const currentBalance = parseInt(data[rowIndex][1], 10) || 0;
        let newBalance = currentBalance;

        // approve
        if (interaction.customId === 'approve_donation') {
          newBalance += 1000; // or your chosen DKP

          // update
          try {
            const authClient = await auth.getClient();
            const sheets = google.sheets({ version: 'v4', auth: authClient });
            await sheets.spreadsheets.values.update({
              spreadsheetId,
              range: `Balance!B${rowIndex + 2}`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [[newBalance]] },
            });
          } catch (err) {
            console.error('Error updating balance:', err);
            await interaction.reply({ content: 'Error updating balance. Check logs.', ephemeral: true });
            return;
          }

          // remove buttons
          await interaction.deferUpdate();
          await interaction.message.edit({ components: [] });

          const approverName = interaction.member?.displayName || interaction.user.username;
          await interaction.channel.send(
            `Donation approved by **${approverName}**. **${donorName}** now has **${newBalance} DKP**.`
          );
        }
        // deny
        else if (interaction.customId === 'deny_donation') {
          await interaction.deferUpdate();
          await interaction.message.edit({ components: [] });

          const approverName = interaction.member?.displayName || interaction.user.username;
          await interaction.channel.send(
            `Donation request denied by **${approverName}**. **${donorName}** still has **${currentBalance} DKP**.`
          );
        }
      }
    });
    
    



// 4. Login the bot
    client.login(DISCORD_TOKEN);
