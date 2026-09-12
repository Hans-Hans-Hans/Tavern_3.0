import type { ChannelKind } from './channel-policy';
export type StarterChannel = { name: string; kind: ChannelKind; description: string };
export const serverTemplates: Record<string, { name: string; description: string; channels: StarterChannel[] }> = {
  blank: { name: 'Start from scratch', description: 'Add your own channels when you are ready.', channels: [] },
  friends: { name: 'Friends', description: 'Everyday conversations, a hangout and shared photos.', channels: [
    { name: 'general', kind: 'text', description: 'Say hello and catch up.' }, { name: 'hangout', kind: 'voice', description: 'Drop in when you want to talk.' }, { name: 'photos', kind: 'media', description: 'Share moments with the group.' }] },
  gaming: { name: 'Gaming', description: 'Updates, finding a group and a place to play together.', channels: [
    { name: 'general', kind: 'text', description: 'Talk about what you are playing.' }, { name: 'announcements', kind: 'announcement', description: 'Community updates and events.' }, { name: 'find-a-group', kind: 'forum', description: 'Start a discussion for your next session.' }, { name: 'party-chat', kind: 'voice', description: 'Meet your group in voice.' }] },
  study: { name: 'Study group', description: 'Questions, shared resources and quiet study sessions.', channels: [
    { name: 'general', kind: 'text', description: 'Check in with the group.' }, { name: 'questions', kind: 'forum', description: 'One discussion per question.' }, { name: 'resources', kind: 'read-only', description: 'Useful references maintained by moderators.' }, { name: 'study-room', kind: 'voice', description: 'Study together with optional conversation.' }] },
  team: { name: 'Small team', description: 'Team conversation, updates and meetings.', channels: [
    { name: 'general', kind: 'text', description: 'Team conversation and daily updates.' }, { name: 'announcements', kind: 'announcement', description: 'Updates everyone should see.' }, { name: 'meetings', kind: 'video', description: 'Meet face to face and share a screen.' }] },
};
