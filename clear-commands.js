require('dotenv').config();
const { REST, Routes } = require('discord.js');

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID; // optional: if commands were registered per-guild

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    // If you registered commands per-guild:
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });

    // If you registered them globally, clear this instead:
    // await rest.put(Routes.applicationCommands(clientId), { body: [] });

    console.log('Successfully deleted all application commands.');
  } catch (error) {
    console.error(error);
  }
})();
