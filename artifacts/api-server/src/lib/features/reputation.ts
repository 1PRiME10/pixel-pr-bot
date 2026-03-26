import { isClaimed } from "../message-gate.js";
import { Client, Events, Message, EmbedBuilder } from "discord.js";
import { db, reputationTable } from "@workspace/db";
import { eq, and, desc, sum } from "drizzle-orm";

const REP_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// In DMs there is no guild — use "global" as a shared pool
const DM_GUILD = "global";

export function registerReputation(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (!(await isClaimed(message.id))) return;

    const guildId = message.guild?.id ?? DM_GUILD;
    const isDM = !message.guild;

    // +rep @user
    if (message.content.startsWith("+rep")) {
      // In servers use guild member mention; in DMs fall back to user mention
      const targetMember = message.mentions.members?.first();
      const targetUser = targetMember?.user ?? message.mentions.users.first();
      if (!targetUser) {
        await message.reply("Please mention a user. Usage: `+rep @user`");
        return;
      }
      if (targetUser.id === message.author.id) {
        await message.reply("You cannot give reputation to yourself! 😅");
        return;
      }
      if (targetUser.bot) {
        await message.reply("You cannot give reputation to a bot!");
        return;
      }

      const giverRecord = await db.query.reputationTable.findFirst({
        where: and(
          eq(reputationTable.userId, message.author.id),
          eq(reputationTable.guildId, guildId)
        ),
      });

      if (giverRecord?.lastGivenAt) {
        const elapsed = Date.now() - giverRecord.lastGivenAt.getTime();
        if (elapsed < REP_COOLDOWN_MS) {
          const hoursLeft = Math.ceil((REP_COOLDOWN_MS - elapsed) / 3_600_000);
          await message.reply(`⏳ You can give reputation again in **${hoursLeft} hour(s)**.`);
          return;
        }
      }

      const existing = await db.query.reputationTable.findFirst({
        where: and(
          eq(reputationTable.userId, targetUser.id),
          eq(reputationTable.guildId, guildId)
        ),
      });

      if (existing) {
        await db.update(reputationTable)
          .set({ points: existing.points + 1 })
          .where(and(eq(reputationTable.userId, targetUser.id), eq(reputationTable.guildId, guildId)));
      } else {
        await db.insert(reputationTable).values({ userId: targetUser.id, guildId, points: 1 });
      }

      if (giverRecord) {
        await db.update(reputationTable)
          .set({ lastGivenAt: new Date() })
          .where(and(eq(reputationTable.userId, message.author.id), eq(reputationTable.guildId, guildId)));
      } else {
        await db.insert(reputationTable).values({ userId: message.author.id, guildId, points: 0, lastGivenAt: new Date() });
      }

      const newPoints = (existing?.points ?? 0) + 1;
      const displayName = targetMember?.displayName ?? targetUser.username;
      await message.reply(`⭐ You gave reputation to **${displayName}**! They now have **${newPoints} points**.`);
    }

    // !rep @user or !rep (self)
    if (message.content.startsWith("!rep")) {
      let targetId: string;
      let displayName: string;

      if (isDM) {
        // In DMs, always check the requester's own rep
        targetId = message.author.id;
        displayName = message.author.username;
      } else {
        const targetMember = message.mentions.members?.first() ?? message.member;
        if (!targetMember) return;
        targetId = targetMember.id;
        displayName = targetMember.displayName;
      }

      const record = await db.query.reputationTable.findFirst({
        where: and(
          eq(reputationTable.userId, targetId),
          eq(reputationTable.guildId, guildId)
        ),
      });

      await message.reply(`⭐ **${displayName}** has **${record?.points ?? 0} reputation points**.`);
    }

    // !leaderboard
    if (message.content.trim() === "!leaderboard") {
      const top = await db
        .select()
        .from(reputationTable)
        .where(eq(reputationTable.guildId, guildId))
        .orderBy(desc(reputationTable.points))
        .limit(10);

      if (top.length === 0) {
        await message.reply("No reputation data yet. Start giving +rep to members!");
        return;
      }

      const lines = await Promise.all(
        top.map(async (row, i) => {
          let name = `User ${row.userId}`;
          if (!isDM) {
            const member = await message.guild!.members.fetch(row.userId).catch(() => null);
            name = member?.displayName ?? name;
          } else {
            const user = await client.users.fetch(row.userId).catch(() => null);
            name = user?.username ?? name;
          }
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
          return `${medal} **${name}** — ${row.points} pts`;
        })
      );

      const embed = new EmbedBuilder()
        .setTitle("🏆 Reputation Leaderboard")
        .setDescription(lines.join("\n"))
        .setColor(0xffd700);

      await message.reply({ embeds: [embed] });
    }
  });
}
