import { Client, Message, EmbedBuilder, AttachmentBuilder } from "discord.js";
import { generateImage } from "@workspace/integrations-gemini-ai/image";

export async function runImagine(message: Message, prompt: string): Promise<void> {
  if (!prompt) {
    await message.reply("Please provide a description. Usage: `!imagine <description>`");
    return;
  }

  await (message.channel as any).sendTyping().catch(() => {});

  try {
    const { b64_json, mimeType } = await generateImage(prompt);

    const ext = mimeType.includes("jpeg") ? "jpg" : "png";
    const fileName = `pixel_imagine.${ext}`;
    const buffer = Buffer.from(b64_json, "base64");
    const attachment = new AttachmentBuilder(buffer, { name: fileName });

    const embed = new EmbedBuilder()
      .setTitle("🎨 AI Generated Image")
      .setDescription(`**Prompt:** ${prompt}`)
      .setImage(`attachment://${fileName}`)
      .setColor(0x5865f2)
      .setFooter({ text: `Requested by ${message.author.tag} • Gemini AI` });

    await message.reply({ embeds: [embed], files: [attachment] });
  } catch (err) {
    console.error("[Imagine] Error:", err);
    await message.reply("❌ Could not generate the image. Please try again in a moment!");
  }
}

export function registerImagine(_client: Client): void {}
