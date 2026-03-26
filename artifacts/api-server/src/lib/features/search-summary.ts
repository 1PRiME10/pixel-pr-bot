import { isClaimed } from "../message-gate.js";
import { Client, Events, Message, EmbedBuilder } from "discord.js";
import { generateWithFallback } from "@workspace/integrations-gemini-ai";

export function registerSearchSummary(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (!(await isClaimed(message.id))) return;

    // --- Search ---
    if (message.content.startsWith("!search ")) {
      const query = message.content.slice("!search ".length).trim();
      if (!query) {
        await message.reply("Please provide a topic. Usage: `!search <topic>`");
        return;
      }

      const thinking = await message.reply("🔍 Searching...");
      try {
        const result = (await generateWithFallback({
          contents: [{
            role: "user",
            parts: [{ text: `Give a clear and informative summary about: "${query}"\n\nFormat your response as:\n**Summary:** (2-3 sentences)\n**Key Points:**\n• Point 1\n• Point 2\n• Point 3\n\nKeep it concise and accurate.` }],
          }],
          maxOutputTokens: 1024,
        }))?.trim() ?? "No results found.";
        const embed = new EmbedBuilder()
          .setTitle(`🔍 Search: ${query}`)
          .setDescription(result)
          .setColor(0x5865f2)
          .setFooter({ text: `Powered by AI • Requested by ${message.author.tag}` });

        await thinking.delete().catch(() => {});
        await message.reply({ embeds: [embed] });
      } catch (err) {
        console.error("Search error:", err);
        await thinking.edit("❌ Could not complete the search. Please try again.");
      }
    }

    // --- Summary ---
    if (message.content.trim() === "!summary") {
      const thinking = await message.reply("📖 Reading the last 50 messages...");
      try {
        const fetched = await message.channel.messages.fetch({ limit: 50, before: message.id });
        const msgs = [...fetched.values()]
          .reverse()
          .filter((m) => !m.author.bot && m.content.length > 0)
          .map((m) => `${m.author.username}: ${m.content}`)
          .join("\n");

        if (!msgs) {
          await thinking.edit("No recent messages to summarize.");
          return;
        }

        const summary = (await generateWithFallback({
          contents: [{
            role: "user",
            parts: [{ text: `Summarize the following Discord conversation into 3-5 bullet points. Focus on the main topics discussed. Be brief and clear.\n\n---\n${msgs}` }],
          }],
          maxOutputTokens: 512,
        }))?.trim() ?? "Could not generate a summary.";
        const embed = new EmbedBuilder()
          .setTitle("📖 Chat Summary (last 50 messages)")
          .setDescription(summary)
          .setColor(0x57f287)
          .setFooter({ text: `Requested by ${message.author.tag}` });

        await thinking.delete().catch(() => {});
        await message.reply({ embeds: [embed] });
      } catch (err) {
        console.error("Summary error:", err);
        await thinking.edit("❌ Could not summarize. Please try again.");
      }
    }
  });
}
