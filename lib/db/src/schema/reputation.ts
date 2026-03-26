import { pgTable, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const reputationTable = pgTable("reputation", {
  id: text("id").primaryKey().$defaultFn(() => `${Math.random().toString(36).slice(2)}`),
  userId: text("user_id").notNull(),
  guildId: text("guild_id").notNull(),
  points: integer("points").notNull().default(0),
  lastGivenAt: timestamp("last_given_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("rep_user_guild_idx").on(table.userId, table.guildId),
]);

export type Reputation = typeof reputationTable.$inferSelect;
