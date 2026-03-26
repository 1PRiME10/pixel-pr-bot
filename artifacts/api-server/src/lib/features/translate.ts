import {
  Client,
  Events,
  MessageReaction,
  User,
  PartialMessageReaction,
  PartialUser,
  EmbedBuilder,
} from "discord.js";
import { generateWithFallback } from "@workspace/integrations-gemini-ai";

// ─── Supported flag → language mapping ───────────────────────────────────────
const FLAG_LANGUAGES: Record<string, string> = {
  "🇺🇸": "English",
  "🇬🇧": "English",
  "🇸🇦": "Arabic",
  "🇦🇪": "Arabic",
  "🇮🇶": "Arabic",
  "🇫🇷": "French",
  "🇩🇪": "German",
  "🇪🇸": "Spanish",
  "🇲🇽": "Spanish",
  "🇮🇹": "Italian",
  "🇷🇺": "Russian",
  "🇨🇳": "Chinese (Simplified)",
  "🇯🇵": "Japanese",
  "🇰🇷": "Korean",
  "🇧🇷": "Portuguese",
  "🇵🇹": "Portuguese",
  "🇹🇷": "Turkish",
  "🇮🇳": "Hindi",
  "🇮🇷": "Persian (Farsi)",
  "🇵🇱": "Polish",
  "🇳🇱": "Dutch",
  "🇸🇪": "Swedish",
  "🇳🇴": "Norwegian",
  "🇩🇰": "Danish",
  "🇫🇮": "Finnish",
  "🇬🇷": "Greek",
  "🇨🇿": "Czech",
  "🇷🇴": "Romanian",
  "🇭🇺": "Hungarian",
  "🇧🇬": "Bulgarian",
  "🇭🇷": "Croatian",
  "🇸🇰": "Slovak",
  "🇺🇦": "Ukrainian",
  "🇮🇱": "Hebrew",
  "🇹🇭": "Thai",
  "🇻🇳": "Vietnamese",
  "🇮🇩": "Indonesian",
  "🇲🇾": "Malay",
  "🇵🇭": "Filipino",
  "🇵🇰": "Urdu",
  "🇧🇩": "Bengali",
};

// ─── Extract translatable text from a message ─────────────────────────────────
function extractText(reaction: MessageReaction): string | null {
  const msg = reaction.message;

  // Plain text message
  if (msg.content && msg.content.trim().length > 0) {
    return msg.content.trim();
  }

  // Embed message (e.g. daily inspiration)
  if (msg.embeds.length > 0) {
    const embed = msg.embeds[0];
    const parts: string[] = [];
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  return null;
}

// ─── Register reaction-based translation ─────────────────────────────────────
export function registerTranslate(client: Client) {
  client.on(
    Events.MessageReactionAdd,
    async (
      reaction: MessageReaction | PartialMessageReaction,
      user: User | PartialUser,
    ) => {
      if (user.bot) return;

      const emoji = reaction.emoji.toString();
      const targetLang = FLAG_LANGUAGES[emoji];
      if (!targetLang) return;

      try {
        if (reaction.partial) await reaction.fetch();
        if (reaction.message.partial) await reaction.message.fetch();
      } catch {
        return;
      }

      const text = extractText(reaction as MessageReaction);
      if (!text) return;

      try {
        const translated = await generateWithFallback({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text:
                    `Translate the following text to ${targetLang}. ` +
                    `Preserve any markdown formatting (bold, italic, etc.). ` +
                    `Only return the translated text, nothing else:\n\n${text}`,
                },
              ],
            },
          ],
          maxOutputTokens: 4096,
        });

        if (!translated) return;

        // Send as an embed if the source was an embed, otherwise plain reply
        if (
          reaction.message.embeds.length > 0 &&
          !reaction.message.content?.trim()
        ) {
          const sourceEmbed = reaction.message.embeds[0];
          const translatedEmbed = new EmbedBuilder()
            .setColor(sourceEmbed.color ?? 0x5865f2)
            .setTitle(`🌐 ${sourceEmbed.title ?? "Translation"}`)
            .setDescription(translated)
            .setFooter({
              text: `Translated to ${targetLang} • requested by ${user}`,
            });
          await reaction.message.reply({ embeds: [translatedEmbed] });
        } else {
          await reaction.message.reply(
            `🌐 **Translation to ${targetLang}** (requested by ${user}):\n${translated}`,
          );
        }
      } catch (err) {
        console.error("[translate] Error:", err);
      }
    },
  );
}
