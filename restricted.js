import 'dotenv/config'
import {
  Client, Events, GatewayIntentBits, Partials,
  REST, Routes
} from 'discord.js'

import { ENV } from './config/env.js'
import { ensureHeaders } from './infra/sheetsInit.js'
import * as polls   from './data/pollsRepo.js'
import * as items   from './data/itemsRepo.js'
import * as votes   from './data/votesRepo.js'
import * as presets from './data/presetsRepo.js'   // create this if you call loadPresetItems / bySlot
import { getPollChannel, registerGuildCommands } from './infra/discord.js'

// ⬇️ bring in any pure helpers you split out (labels/rules/ui)
import { checkVoteAllowedByMode, labelModeLong } from './domain/rules.js'
import { pollEmbed, buildButtons, buildResultsEmbed,
         councilEmbed, councilButtons } from './ui/embeds.js'

// keep your existing commands array (or import from a module)
import { commandsJSON } from './router/commandsRegistry.js' // if you already built this

// --- tiny client bootstrap ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
})

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`)
  await ensureHeaders()
  // if you have commandsJSON():
  await registerGuildCommands(client, commandsJSON())
  // else do it inline:
  // const rest = new REST({ version: '10' }).setToken(ENV.TOKEN)
  // const guilds = await c.guilds.fetch()
  // for (const [, g] of guilds) await rest.put(Routes.applicationGuildCommands(ENV.CLIENT_ID, g.id), { body: commands })

  setInterval(() => checkExpirationsTick(), 60_000)
})

// --- move your old checkExpirations here but using repos ---
async function checkExpirationsTick() {
  const all = await polls.listPollsForAllGuilds?.()  // if you don't have this, do per guild:
  // SIMPLE: per guild
  for (const [, guild] of client.guilds.cache) {
    const ps = await polls.listPolls(guild.id)
    const now = Date.now()
    for (const p of ps) {
      if (p.is_open && p.expires_at && p.expires_at < now) {
        await polls.setPollClosed(p.id)
        const chan = getPollChannel(guild) || guild.systemChannel
        if (chan) {
          const its = await items.getItems(p.id)
          for (const it of its) it._count = await votes.countVotesForItem(p.id, it.id)
          await chan.send({ content: `Poll **${p.name}** expired.`, embeds: [pollEmbed(p, its)] })
        }
      }
    }
  }
}

// --- ROUTING: reuse your existing handlers, but switch data calls to repos ---
// Example: inside your existing handleVote:
async function handleVote(inter) {
  const guildId = inter.guildId
  const idOrName = inter.options.getString('poll', true)
  const itemName = inter.options.getString('item', true)
  const mode     = inter.options.getString('mode', true)

  const poll = isNaN(+idOrName) ? await polls.getPollByName(guildId, idOrName)
                                : await polls.getPollById(+idOrName)
  if (!poll) return inter.reply({ content:'Poll not found.', flags: MessageFlags.Ephemeral })
  if (!poll.is_open) return inter.reply({ content:'Poll is closed.', flags: MessageFlags.Ephemeral })

  const item = await items.getItemByName(poll.id, itemName)
  if (!item) return inter.reply({ content:'Item not found in this poll.', flags: MessageFlags.Ephemeral })

  // gather user's votes across guild for this mode (you already wrote this—put it in votesRepo or a service)
  const userVotes = await votes.getUserVotesAcrossGuildByMode(guildId, inter.user.id, mode)
  const gate = checkVoteAllowedByMode({ userVotes, item, mode })
  if (!gate.ok) return inter.reply({ content:`Cannot vote: ${gate.reason}`, flags: MessageFlags.Ephemeral })

  await votes.voteWithMode(poll.id, item.id, inter.user.id, inter.member?.displayName || inter.user.username, mode)
  await inter.reply({ content:`Voted for **${item.name}** — ${labelModeLong(mode)}.`, flags: MessageFlags.Ephemeral })

  const chan = getPollChannel(inter.guild) || inter.channel
  const its = await items.getItems(poll.id)
  for (const it of its) it._count = await votes.countVotesForItem(poll.id, it.id)
  await chan.send({ embeds:[pollEmbed(poll, its)] }) // or call a shared upsertPollMessage()
}

// …Do the same swap (read/write via repos) in your other handlers…

client.on(Events.InteractionCreate, async (interaction) => {
  // call your existing handlePoll / handleVote / handleUnvote / handleAdmin / handleCouncil
  // just ensure they use the imported repos instead of local readSheet/appendRows, etc.
})

client.login(ENV.TOKEN)
