import type { ChannelKind } from './channel-policy';

export type StarterCategory = { id: string; name: string; icon: string };
export type StarterChannel = { id: string; name: string; kind: ChannelKind; description: string; category: string };
export type ServerTemplate = { name: string; description: string; categories: StarterCategory[]; channels: StarterChannel[] };
const category = (id: string, name: string): StarterCategory => ({ id, name, icon: '' });
const channel = (name: string, kind: ChannelKind, category: string, description: string): StarterChannel => ({ id: name, name, kind, category, description });

export const serverTemplates: Record<string, ServerTemplate> = {
  blank: { name: 'Blank', description: 'An empty space. Add channels whenever you are ready.', categories: [], channels: [] },
  friends: {
    name: 'Friends', description: 'Catch up, share photos and drop into a voice hangout.',
    categories: [category('together', 'Together'), category('hangouts', 'Hangouts')],
    channels: [channel('general', 'text', 'together', 'Say hello and catch up.'), channel('hangout', 'voice', 'hangouts', 'Drop in when you want to talk.'), channel('photos', 'media', 'together', 'Share moments with the group.')],
  },
  gaming: {
    name: 'Gaming', description: 'Find a group, follow updates and play together.',
    categories: [category('community', 'Community'), category('play', 'Play together')],
    channels: [channel('general', 'text', 'community', 'Talk about what you are playing.'), channel('announcements', 'announcement', 'community', 'Community updates and events.'), channel('find-a-group', 'forum', 'play', 'Start a discussion for your next session.'), channel('party-chat', 'voice', 'play', 'Meet your group in voice.')],
  },
  community: {
    name: 'Community', description: 'Give newcomers a clear welcome and room to get involved.',
    categories: [category('start', 'Start here'), category('community', 'Community')],
    channels: [channel('rules', 'rules', 'start', 'Community rules and guidance maintained by moderators.'), channel('announcements', 'announcement', 'start', 'News from the community team.'), channel('general', 'text', 'community', 'Meet people and join the conversation.'), channel('ideas', 'forum', 'community', 'One discussion per suggestion.'), channel('lounge', 'voice', 'community', 'An open place to talk.')],
  },
  team: {
    name: 'Work / Team', description: 'Keep team conversations, decisions and meetings together.',
    categories: [category('team', 'Team'), category('meetings', 'Meetings')],
    channels: [channel('general', 'text', 'team', 'Team conversation and daily updates.'), channel('announcements', 'announcement', 'team', 'Updates everyone should see.'), channel('decisions', 'forum', 'team', 'Discuss a proposal and keep its context.'), channel('meetings', 'video', 'meetings', 'Meet face to face and share a screen.')],
  },
  development: {
    name: 'Development', description: 'Discuss a project, share releases and work through questions.',
    categories: [category('project', 'Project'), category('workshop', 'Workshop')],
    channels: [channel('general', 'text', 'project', 'Project conversation and coordination.'), channel('releases', 'announcement', 'project', 'Release notes from project maintainers.'), channel('questions', 'forum', 'workshop', 'Ask a question with enough context to help.'), channel('pairing', 'voice', 'workshop', 'Talk through a problem together.')],
  },
  study: {
    name: 'Study group', description: 'Ask questions, collect resources and study together.',
    categories: [category('learning', 'Learning'), category('sessions', 'Study sessions')],
    channels: [channel('general', 'text', 'learning', 'Check in with the group.'), channel('questions', 'forum', 'learning', 'One discussion per question.'), channel('resources', 'read-only', 'learning', 'Useful references maintained by moderators.'), channel('study-room', 'voice', 'sessions', 'Study together with optional conversation.')],
  },
  custom: { name: 'Custom', description: 'Design your own categories and channels before creating.', categories: [category('channels', 'Channels')], channels: [channel('general', 'text', 'channels', 'Start the conversation.')] },
};

// Reuse the existing versioned layout event. Reject invalid drafts before room creation.
export function starterCategories(value: unknown): StarterCategory[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error('Use up to 8 starting categories.');
  const ids = new Set<string>(), names = new Set<string>();
  return value.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 60 || /[\x00-\x1f\x7f]/.test(item.name)
      || names.has(item.name.trim().toLowerCase()) || typeof item.icon !== 'string' || item.icon.length > 16 || /[\x00-\x1f\x7f]/.test(item.icon)) {
      throw new Error('Give each category a unique name, up to 60 characters.');
    }
    ids.add(item.id); names.add(item.name.trim().toLowerCase());
    return { id: item.id, name: item.name.trim(), icon: item.icon };
  });
}

export function validateStarterChannels(channels: StarterChannel[], categories: StarterCategory[]) {
  const names = new Set<string>(), ids = new Set<string>();
  if (channels.length > 24) throw new Error('Create up to 24 starting channels. More can be added afterward.');
  for (const item of channels) {
    const name = item.name.trim();
    if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name) || names.has(name.toLowerCase()) || ids.has(item.id)) throw new Error('Give each included channel a unique name, up to 60 characters.');
    if (item.description.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item.description)) throw new Error('Channel descriptions can contain up to 500 characters.');
    if (item.category && !categories.some(category => category.id === item.category)) throw new Error('Choose an existing category for each channel.');
    names.add(name.toLowerCase()); ids.add(item.id);
  }
}
