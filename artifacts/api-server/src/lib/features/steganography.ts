import { isClaimed } from "../message-gate.js";
// ─── Steganography Engine — LSB (Least Significant Bit) ──────────────────────
// Hides text messages invisibly inside image pixels.
// The human eye cannot detect any change — only !reveal can find the message.
//
// Protocol (embedded in image bytes):
//   [4 bytes magic "PIXL"] [4 bytes uint32 length] [N bytes UTF-8 message]
//
// Security:
//   • Optional XOR passphrase (--key=<phrase>) — unreadable without the key
//   • Only lossless formats work (PNG, BMP) — JPEGs destroy LSB data
//   • Input images are fetched server-side; no file system writes
//   • Message max: 1500 chars; image min: enough pixels to carry the payload
//   • Commands only work in guild or DM — no shared key stored anywhere

import { Client, Message, AttachmentBuilder } from "discord.js";
import { Jimp, intToRGBA, rgbaToInt } from "jimp";

// ── Constants ─────────────────────────────────────────────────────────────────
const MAGIC = Buffer.from("PIXL");          // 4-byte magic header
const MAX_MESSAGE_LEN = 1_500;              // characters
const DEFAULT_KEY = "PIXEL_STEG_2025";     // default XOR passphrase

// ── XOR cipher (symmetric — same function to encrypt and decrypt) ─────────────
function xorCipher(data: Buffer, key: string): Buffer {
  const keyBytes = Buffer.from(key, "utf8");
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ^ keyBytes[i % keyBytes.length];
  }
  return out;
}

// ── Capacity check ────────────────────────────────────────────────────────────
function maxPayloadBytes(width: number, height: number): number {
  // 3 bits per pixel (R, G, B LSBs); 8 bits per byte
  return Math.floor((width * height * 3) / 8);
}

// ── Encode: embed bytes into image LSBs ────────────────────────────────────────
function encode(image: InstanceType<typeof Jimp>, payload: Buffer): void {
  const { width, height } = image.bitmap;
  const capacity = maxPayloadBytes(width, height);
  if (payload.length > capacity) {
    throw new Error(
      `Image too small. Need ${payload.length * 8 / 3 | 0} pixels, ` +
      `have ${width * height}. Use a larger image.`,
    );
  }

  let bitIndex = 0; // bit position in payload

  for (let y = 0; y < height && bitIndex < payload.length * 8; y++) {
    for (let x = 0; x < width && bitIndex < payload.length * 8; x++) {
      const pixel = image.getPixelColor(x, y);
      let { r, g, b, a } = intToRGBA(pixel);

      // Embed 3 bits per pixel into R, G, B LSBs
      const byteIdx  = (bitIndex / 8) | 0;
      const bitInByte = 7 - (bitIndex % 8);
      const bit0 = (payload[byteIdx] >> bitInByte) & 1;
      r = (r & 0xFE) | bit0;
      bitIndex++;

      if (bitIndex < payload.length * 8) {
        const byteIdx2   = (bitIndex / 8) | 0;
        const bitInByte2 = 7 - (bitIndex % 8);
        const bit1 = (payload[byteIdx2] >> bitInByte2) & 1;
        g = (g & 0xFE) | bit1;
        bitIndex++;
      }

      if (bitIndex < payload.length * 8) {
        const byteIdx3   = (bitIndex / 8) | 0;
        const bitInByte3 = 7 - (bitIndex % 8);
        const bit2 = (payload[byteIdx3] >> bitInByte3) & 1;
        b = (b & 0xFE) | bit2;
        bitIndex++;
      }

      image.setPixelColor(rgbaToInt(r, g, b, a), x, y);
    }
  }
}

// ── Decode: extract bytes from image LSBs ─────────────────────────────────────
function decode(image: InstanceType<typeof Jimp>): Buffer | null {
  const { width, height } = image.bitmap;
  const totalBits = width * height * 3;

  // We need at least 8 + 32 = 40 bits for magic + length
  if (totalBits < 64) return null;

  const rawBits: number[] = [];
  const needed = maxPayloadBytes(width, height) * 8;

  outer:
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rawBits.length >= needed) break outer;
      const pixel = image.getPixelColor(x, y);
      const { r, g, b } = intToRGBA(pixel);
      rawBits.push(r & 1, g & 1, b & 1);
    }
  }

  // Convert bits to bytes
  function bitsToBuffer(bits: number[], byteCount: number): Buffer {
    const buf = Buffer.allocUnsafe(byteCount);
    for (let i = 0; i < byteCount; i++) {
      let val = 0;
      for (let b = 0; b < 8; b++) {
        val = (val << 1) | (bits[i * 8 + b] ?? 0);
      }
      buf[i] = val;
    }
    return buf;
  }

  // Read magic (first 4 bytes = 32 bits)
  const magic = bitsToBuffer(rawBits, 4);
  if (!magic.equals(MAGIC)) return null; // no hidden message here

  // Read length (next 4 bytes = 32 bits)
  const lenBuf  = bitsToBuffer(rawBits.slice(32), 4);
  const msgLen   = lenBuf.readUInt32BE(0);
  if (msgLen === 0 || msgLen > MAX_MESSAGE_LEN * 4) return null; // sanity check

  // Read message bytes
  const msgBits = rawBits.slice(64);
  if (msgBits.length < msgLen * 8) return null;
  return bitsToBuffer(msgBits, msgLen);
}

// ── Build full payload: MAGIC + LENGTH + (optionally encrypted) message ───────
function buildPayload(message: string, key: string): Buffer {
  const msgBytes  = Buffer.from(message, "utf8");
  const encrypted = xorCipher(msgBytes, key);
  const lenBuf    = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(encrypted.length, 0);
  return Buffer.concat([MAGIC, lenBuf, encrypted]);
}

// ── Parse --key=<value> from args ─────────────────────────────────────────────
function parseKey(parts: string[]): { key: string; rest: string } {
  const keyIdx = parts.findIndex(p => p.startsWith("--key="));
  let key = DEFAULT_KEY;
  if (keyIdx !== -1) {
    key = parts[keyIdx].slice(6).trim() || DEFAULT_KEY;
    parts.splice(keyIdx, 1);
  }
  return { key, rest: parts.join(" ").trim() };
}

// ── Fetch image from URL → Buffer ─────────────────────────────────────────────
async function fetchImageBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Failed to fetch image: HTTP ${res.status}`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

// ── Public helpers for slash commands ────────────────────────────────────────
export async function hideInImage(
  secretMessage: string, imageUrl: string, key = DEFAULT_KEY,
): Promise<{ buffer: Buffer; isDefaultKey: boolean }> {
  if (secretMessage.length > MAX_MESSAGE_LEN)
    throw new Error(`Message too long — max ${MAX_MESSAGE_LEN} chars.`);
  const imgBuf = await fetchImageBuffer(imageUrl);
  const image  = await Jimp.read(imgBuf);
  const payload  = buildPayload(secretMessage, key);
  const capacity = maxPayloadBytes(image.bitmap.width, image.bitmap.height);
  if (payload.length > capacity)
    throw new Error(`Image too small (needs ${payload.length}b, fits ${capacity}b). Use a larger image or shorter message.`);
  encode(image as InstanceType<typeof Jimp>, payload);
  const buffer = await image.getBuffer("image/png");
  return { buffer, isDefaultKey: key === DEFAULT_KEY };
}

export async function revealFromImage(
  imageUrl: string, key = DEFAULT_KEY,
): Promise<"not_found" | "encrypted" | string> {
  const imgBuf    = await fetchImageBuffer(imageUrl);
  const image     = await Jimp.read(imgBuf);
  const rawPayload = decode(image as InstanceType<typeof Jimp>);
  if (!rawPayload) return "not_found";
  const decrypted = xorCipher(rawPayload, key);
  const revealed  = decrypted.toString("utf8");
  if (!/^[\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]*$/.test(revealed)) return "encrypted";
  return revealed;
}

// ── Register ──────────────────────────────────────────────────────────────────
export function registerSteganography(client: Client, PREFIX: string): void {

  client.on("messageCreate", async (message: Message) => {
    if (message.author.bot) return;
    if (!(await isClaimed(message.id))) return;
    const content = message.content.trim();

    // ── !hide <message> [--key=<passphrase>] ─────────────────────────────────
    if (content.toLowerCase().startsWith(`${PREFIX}hide`)) {
      const rawArgs = content.slice(`${PREFIX}hide`.length).trim();
      if (!rawArgs) {
        await message.reply(
          `**Usage:** \`!hide <your secret message>\`\n` +
          `**With a custom key:** \`!hide <message> --key=<passphrase>\`\n` +
          `**Required:** attach a PNG image *(JPEGs won't work — compression destroys hidden data)*`,
        );
        return;
      }

      const parts = rawArgs.split(" ");
      const { key, rest: secretMessage } = parseKey(parts);

      if (!secretMessage) {
        await message.reply("⚠️ Where's the message? Write something after `!hide`.");
        return;
      }
      if (secretMessage.length > MAX_MESSAGE_LEN) {
        await message.reply(`⚠️ Message too long — maximum is ${MAX_MESSAGE_LEN} characters.`);
        return;
      }

      // Find a PNG attachment
      const att = message.attachments.find(a => {
        const mime = a.contentType ?? "";
        const ext  = (a.name ?? "").split(".").pop()?.toLowerCase();
        return mime.includes("png") || mime.includes("bmp") || ext === "png" || ext === "bmp";
      });

      if (!att) {
        await message.reply(
          "⚠️ Please attach a **PNG** image with your message.\n" +
          "*JPEGs won't work — lossy compression destroys the hidden data.*",
        );
        return;
      }

      await (message.channel as any).sendTyping().catch(() => {});

      try {
        const imgBuf  = await fetchImageBuffer(att.url);
        const image   = await Jimp.read(imgBuf);
        const payload = buildPayload(secretMessage, key);
        const capacity = maxPayloadBytes(image.bitmap.width, image.bitmap.height);

        if (payload.length > capacity) {
          await message.reply(
            `⚠️ The image is too small for this message.\n` +
            `Message needs **${payload.length}** bytes, image fits **${capacity}** bytes.\n` +
            `Use a larger image or a shorter message.`,
          );
          return;
        }

        encode(image as InstanceType<typeof Jimp>, payload);

        const outBuf    = await image.getBuffer("image/png");
        const attachment = new AttachmentBuilder(outBuf, { name: "hidden.png" });

        const keyNote = key !== DEFAULT_KEY
          ? `\n🔑 Decryption key: \`${key}\` — keep it secret!`
          : "";

        await message.reply({
          content:
            `🔒 **Message hidden successfully!**\n` +
            `> The image looks completely normal to the human eye.\n` +
            `> To reveal it: save the image and send it with \`!reveal${key !== DEFAULT_KEY ? ` --key=${key}` : ""}\`` +
            keyNote,
          files: [attachment],
        });
      } catch (err) {
        console.error("[Steg] hide error:", err);
        await message.reply(`❌ Error: ${(err as Error).message}`);
      }
      return;
    }

    // ── !reveal [--key=<passphrase>] ─────────────────────────────────────────
    if (content.toLowerCase().startsWith(`${PREFIX}reveal`)) {
      const rawArgs = content.slice(`${PREFIX}reveal`.length).trim();
      const parts   = rawArgs.split(" ").filter(Boolean);
      const { key } = parseKey(parts);

      // Find any image attachment
      const att = message.attachments.find(a => {
        const mime = a.contentType ?? "";
        const ext  = (a.name ?? "").split(".").pop()?.toLowerCase();
        return (
          mime.startsWith("image/") ||
          ["png", "bmp", "gif", "webp"].includes(ext ?? "")
        );
      });

      if (!att) {
        await message.reply(
          "⚠️ Attach the image you want to scan with this command.\n" +
          "**Example:** `!reveal` *(with an image attached)*",
        );
        return;
      }

      await (message.channel as any).sendTyping().catch(() => {});

      try {
        const imgBuf    = await fetchImageBuffer(att.url);
        const image     = await Jimp.read(imgBuf);
        const rawPayload = decode(image as InstanceType<typeof Jimp>);

        if (!rawPayload) {
          await message.reply(
            "🔍 **No hidden message found in this image.**\n" +
            "*The image may have been compressed (JPEG) and the data destroyed.*",
          );
          return;
        }

        // Decrypt with XOR
        const decrypted = xorCipher(rawPayload, key);
        const revealed  = decrypted.toString("utf8");

        // Validate UTF-8 (bad key = garbage text)
        if (!/^[\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]*$/.test(revealed)) {
          await message.reply(
            "🔑 **Encrypted message found** — but the result is unreadable.\n" +
            "You may need a different key: `!reveal --key=<passphrase>`",
          );
          return;
        }

        await message.reply(
          `🔓 **Hidden message revealed!**\n\n` +
          `> ${revealed}`,
        );
      } catch (err) {
        console.error("[Steg] reveal error:", err);
        await message.reply(`❌ Reveal failed: ${(err as Error).message}`);
      }
      return;
    }
  });
}
