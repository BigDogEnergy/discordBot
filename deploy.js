// deploy-commands.js
require('dotenv').config();

const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const { GUILD_ID, CLIENT_ID, DISCORD_BOT_TOKEN } = process.env;

const commands = [
  new SlashCommandBuilder()
    .setName('donate')
    .setDescription('Receive grace for donating an item to the guild bank')
].map(cmd => cmd.toJSON());

// 3) Construct and prepare an instance of the REST module
const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

// 4) Deploy the commands to the specified guild
(async () => {
  try {
    console.log('Started refreshing application (slash) commands...');

    // Guild-level registration:
    // Instantly update commands in a specific server (for testing)
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands },
    );

    console.log('Successfully reloaded application (slash) commands.');
  } catch (error) {
    console.error(error);
  }
})();
