import { Router, type IRouter } from "express";
import { getClient, getStartTime } from "../lib/discord-bot";
import { getRegisteredCommandNames } from "../lib/plugin-registrar.js";

const router: IRouter = Router();

router.get("/bot/status", (_req, res) => {
  const client = getClient();
  const startTime = getStartTime();

  if (!client || !client.isReady()) {
    res.json({ online: false });
    return;
  }

  const uptimeSeconds = startTime
    ? Math.floor((Date.now() - startTime.getTime()) / 1000)
    : 0;

  res.json({
    online: true,
    username: client.user.tag,
    id: client.user.id,
    guildCount: client.guilds.cache.size,
    uptimeSeconds,
  });
});

router.get("/bot/guilds", (_req, res) => {
  const client = getClient();

  if (!client || !client.isReady()) {
    res.json([]);
    return;
  }

  const guilds = client.guilds.cache.map((guild) => ({
    id: guild.id,
    name: guild.name,
    memberCount: guild.memberCount,
    iconUrl: guild.iconURL() ?? undefined,
  }));

  res.json(guilds);
});

router.get("/bot/commands", (_req, res) => {
  const cmds = getRegisteredCommandNames();
  res.json({ count: cmds.length, commands: cmds });
});

export default router;
