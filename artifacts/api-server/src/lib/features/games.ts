import { isClaimed } from "../message-gate.js";
import { Client, Events, Message } from "discord.js";
import { generateWithFallback } from "@workspace/integrations-gemini-ai";

interface WordChainState {
  currentWord: string;
  lastPlayerId: string;
  active: boolean;
  usedWords: Set<string>;
}

const wordChainGames = new Map<string, WordChainState>();

// Strip any @mention from the front of a message
function cleanContent(message: Message): string {
  return message.content.replace(/<@!?\d+>\s*/g, "").trim();
}

// Ask AI to give a valid word starting with the given letter
async function botPickWord(startLetter: string, usedWords: Set<string>): Promise<string | null> {
  try {
    const usedList = usedWords.size > 0 ? `\nDo NOT use any of these words: ${[...usedWords].join(", ")}.` : "";
    const prompt = `Give me ONE common English word that starts with the letter "${startLetter.toUpperCase()}". Just the word, nothing else, no punctuation.${usedList}`;
    const raw = await generateWithFallback({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      maxOutputTokens: 32,
    });
    const word = raw?.trim().toLowerCase().replace(/[^a-z]/g, "");
    if (!word || !word.startsWith(startLetter.toLowerCase())) return null;
    return word;
  } catch {
    return null;
  }
}

// ─── Exported helpers for slash command integration ───────────────────────────
/**
 * Start a word chain game in a channel.
 * Returns { started: true, currentWord } if game was started,
 * or { started: false, currentWord } if already running.
 */
export function startWordChain(
  channelId: string,
  botUserId: string,
): { started: boolean; currentWord: string } {
  const existing = wordChainGames.get(channelId);
  if (existing?.active) {
    return { started: false, currentWord: existing.currentWord };
  }
  const startWord = "apple";
  wordChainGames.set(channelId, {
    currentWord: startWord,
    lastPlayerId: botUserId,
    active: true,
    usedWords: new Set([startWord]),
  });
  return { started: true, currentWord: startWord };
}

/**
 * Stop a word chain game in a channel.
 * Returns true if a game was running and stopped, false if no game.
 */
export function stopWordChain(channelId: string): boolean {
  if (wordChainGames.has(channelId)) {
    wordChainGames.delete(channelId);
    return true;
  }
  return false;
}

/** Returns true if a word chain game is currently active in the given channel. */
export function isWordChainActive(channelId: string): boolean {
  return wordChainGames.get(channelId)?.active === true;
}

export function registerGames(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (!(await isClaimed(message.id))) return;

    const content = cleanContent(message);

    // --- Would You Rather ---
    if (content === "!wyr") {
      const thinking = await message.reply("🤔 Coming up with a question...");
      try {
        const question = (await generateWithFallback({
          contents: [{
            role: "user",
            parts: [{ text: "Give me a fun 'Would You Rather' question with two clear options. Format it exactly like this:\n**Would You Rather...**\n🅰️ Option A\n🅱️ Option B\n\nKeep it light-hearted and suitable for all ages." }],
          }],
          maxOutputTokens: 256,
        })) ?? "Would you rather eat pizza every day 🍕 or tacos every day 🌮?";
        const msg = await thinking.edit(question);
        await msg.react("🅰️").catch(() => {});
        await msg.react("🅱️").catch(() => {});
      } catch (err) {
        console.error("WYR error:", err);
        await thinking.edit("❌ Could not generate a question. Try again!");
      }
      return;
    }

    // --- Start Word Chain ---
    if (content === "!wordchain") {
      const state = wordChainGames.get(message.channelId);
      if (state?.active) {
        await message.reply(`🔤 A word chain game is already running! Current word: **${state.currentWord}**\nGive a word starting with **${state.currentWord.slice(-1).toUpperCase()}**.`);
        return;
      }
      const startWord = "apple";
      wordChainGames.set(message.channelId, {
        currentWord: startWord,
        lastPlayerId: client.user!.id,
        active: true,
        usedWords: new Set([startWord]),
      });
      await message.reply(
        `🔤 **Word Chain Game Started!**\n` +
        `Rules: Reply with a word that starts with the **last letter** of my word. No repeating words!\n` +
        `Type \`!stopchain\` to end the game.\n\n` +
        `My word: **${startWord.toUpperCase()}** — your turn! Give a word starting with **E**.`
      );
      return;
    }

    // --- Stop Word Chain ---
    if (content === "!stopchain") {
      if (wordChainGames.has(message.channelId)) {
        wordChainGames.delete(message.channelId);
        await message.reply("🛑 Word chain game stopped. GG!");
      }
      return;
    }

    // --- Word Chain: player's turn ---
    const game = wordChainGames.get(message.channelId);
    if (!game?.active) return;
    if (content.startsWith("!")) return;

    const word = content.toLowerCase().replace(/[^a-z]/g, "");
    if (!word) return;

    // Player can't go twice in a row
    if (game.lastPlayerId === message.author.id) {
      await message.reply("⚠️ You can't play twice in a row! Wait for someone else to go.");
      return;
    }

    const lastLetter = game.currentWord.slice(-1);

    // Word must start with the last letter of current word
    if (!word.startsWith(lastLetter)) {
      await message.reply(
        `❌ **${word}** doesn't start with **${lastLetter.toUpperCase()}**! Game over.\n` +
        `The last valid word was **${game.currentWord.toUpperCase()}**. Better luck next time! 😄`
      );
      wordChainGames.delete(message.channelId);
      return;
    }

    // No repeating words
    if (game.usedWords.has(word)) {
      await message.reply(`❌ **${word}** was already used! Game over. Try not to repeat words next time!`);
      wordChainGames.delete(message.channelId);
      return;
    }

    // Valid word — accept it and bot plays its own word
    game.usedWords.add(word);
    game.currentWord = word;
    game.lastPlayerId = message.author.id;
    await message.react("✅").catch(() => {});

    // Bot picks a word starting with the last letter of the player's word
    const botLetter = word.slice(-1);
    const botWord = await botPickWord(botLetter, game.usedWords);

    if (!botWord) {
      await (message.channel as any).send(
        `🤖 Hmm, I can't think of a word starting with **${botLetter.toUpperCase()}**! You win! 🎉\nGame over.`
      );
      wordChainGames.delete(message.channelId);
      return;
    }

    game.usedWords.add(botWord);
    game.currentWord = botWord;
    game.lastPlayerId = client.user!.id;

    await (message.channel as any).send(
      `🤖 My word: **${botWord.toUpperCase()}** — your turn! Give a word starting with **${botWord.slice(-1).toUpperCase()}**.`
    );
  });
}
