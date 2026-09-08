export type Naming = 'standard' | 'legacy';

export function terminology(naming: Naming = 'standard') {
  const legacy = naming === 'legacy';
  const server = legacy ? 'Tavern' : 'server';
  const channel = legacy ? 'Guild' : 'channel';
  return {
    server, channel,
    servers: legacy ? 'Taverns' : 'servers',
    channels: legacy ? 'Guilds' : 'channels',
    label(text: string) {
      if (legacy) return text;
      return text.replace(/\bGUILDS\b/g, 'CHANNELS')
        .replace(/\bGUILD\b/g, 'CHANNEL')
        .replace(/\bGuilds\b/g, 'channels')
        .replace(/\bGuild\b/g, 'channel')
        .replace(/\bYour Tavern\b/g, 'Your server')
        .replace(/\byour Tavern\b/g, 'your server')
        .replace(/^channel/, 'Channel');
    },
  };
}
