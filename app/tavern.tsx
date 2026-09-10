import { onParticipantNavigation } from '@/lib/participant-navigation';
import { ActivityNotifications } from './activity-notifications';
import { RoleMentionPicker } from './role-mention-picker';
import { DraftIndicator, DraftThreadLink, messageDrafts, useMessageDraft } from './message-drafts';
import { PrivateThreadLauncher, PrivateThreadPanel } from './private-thread';
import { PrivateDiscussionList } from './private-discussion-list';
import { privateThreadBinding, readPrivateThreadSettings, privateThreadMessagePermissions } from '@/lib/private-threads';
import { isPrivateDiscussion } from '@/lib/conversation-routing';
import './private-discussion-sheet.css';
import { ServerNicknameDialog, openServerNickname } from './server-nickname';
import { canManageServerNickname, serverNicknameForRoom } from '@/lib/server-nickname';
import { RoomIntegrations } from './room-integrations';
import { WebhookMessageLabel } from './webhook-avatar';
import { roomWebhookLocations } from '@/lib/room-integrations';
import { deferredPanel } from './deferred-panel';
import { roomReportLocations } from '@/lib/room-reports';
import { canBulkRedact } from '@/lib/bulk-moderation';
import { canViewServerAudit } from '@/lib/server-audit';
import { canAssignMemberRoles } from '@/lib/roles';
import { MemberRolesDialog, openMemberRoles } from './member-roles';
import { ServerWarnings, MyWarnings, canWarnMember } from './warnings';
import { canInviteToRoom } from '@/lib/interactions';
import { QuickProfile } from './quick-profile';
import { startCall } from '@/lib/calls';
import { canModerateMember } from '@/lib/channel-policy';
import { KeyboardShortcuts } from './keyboard-shortcuts';
import { ReadStateBadges, MarkAllReadButton, useMarkReadAction } from './read-state';
import { roomReadCounts } from '@/lib/read-state';
import { ReactionBar } from './reaction-bar';
import { AttachmentThumbnail } from './attachment-thumbnail';
import { useTextMedia, shouldSendOnKey } from '@/lib/text-media';
'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Beer, ArrowDown, ArrowRight, AtSign, Bell, BellOff, Bookmark, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Code2, Download, File, FileText, Hash, Headphones, Info, Link2, Loader2, LockKeyhole, LogOut, Menu, MessageCircle, MessageSquare, MoreHorizontal, Paperclip, Pencil, Plus, Search, Send, Settings, ShieldCheck, Smile, Sparkles, Star, Trash2, Users, X, Pin, Paintbrush, Sun, Moon, Monitor, CheckCircle2, Volume2, Zap } from 'lucide-react';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Toaster, toast } from 'sonner';
import { terminology, type Naming } from '@/lib/terminology';
import { ServerDialog } from './server-dialog';
import { SecurityCenter, VerificationDialog } from './security-center';
import { HistoryRecovery } from './history-recovery';
import { CallButtons, CallPanel } from './call-panel';
import { ConferenceButton, ConferencePanel } from './conference-panel';
import { VoiceChannel } from './voice-channel';
import { ChannelCreationForm } from './channel-creation';
import { setNotificationFocus } from '@/lib/notifications';
import { matrixTyping, sendMatrixTyping } from '@/lib/matrix';
import { ProfileSettings, CommunityImage, CommunityAvatar, UserProfileCard, ChannelAppearanceSettings, ServerCustomization, ServerWelcome, ChannelNavigation } from './community-settings';
import { ActionMenu, copyText, type ContextAction } from './action-menu';
import { EmojiPicker } from './emoji-picker';
import { ServerEmojiManager, ServerEmojiPicker, ServerEmojiText } from './server-emoji';
import { InviteManager, RedeemInvite } from './invitations';
import { ReportDialog, type ReportTarget } from './report-dialog';
import { PresenceSettings } from './presence-settings';
import { sendContactRequest } from '@/lib/social';
import { RichMessage } from './rich-message';
import { MediaViewer, type MediaAttachment } from './media-viewer';
import { CommandPalette, openCommandPalette } from './command-palette';
import { ServerNavigation } from './server-navigation';
import { applyAppearance, readAppearance } from '@/lib/appearance';
import { updateNotificationPreferences } from '@/lib/notification-preferences';
import { synchronizeNotificationRules } from '@/lib/notifications';
import { OutboxPanel, ScheduleMessage, ReminderDialog } from './outbox-panel';
import { deliverOutboxNow, enqueueOutbox, outboxOwner, retryOutbox } from '@/lib/outbox';
import { attachmentTransaction } from '@/lib/outbox-attachments';
import { ForumChannel } from './forum-channel';
import { ThreadSettings, EnableThreadSettings } from './thread-settings';
import { readThreadPolicy, threadReplyRestriction } from '@/lib/thread-policy';
import { InstallTavern } from './pwa-status';
import { firstUnreadMessage, parseConversationLink } from '@/lib/message-navigation';
import { WelcomeTour, openWelcomeTour } from './welcome-tour';
import { ThreadTools } from './thread-tools';
import { createThreadReplyRefresh } from '@/lib/thread-reply-refresh';
import { ForwardMessage } from './forward-message';
import { LinkPreviews } from './link-previews';
import { ServerWelcomeFlow, ServerOnboardingSettings } from './server-onboarding';
import { ChannelPolicySettings, ModerationActions } from './channel-policy';
import { postingRestriction, readChannelPolicy } from '@/lib/channel-policy';
import { MessageList } from './message-list';
import { ServerRoles, ServerRoleBadges } from './server-roles';
import { accountArtworkOwner, isManagedAccount, requestApi } from '@/lib/api';
import { dmRequests, isDmRequest } from '@/lib/dm-requests';
import { messagePermissions, navigationPreferences, setNavigationFlag, blockUser, isUserBlocked } from '@/lib/interactions';
import { canEditCommunity, canEditServerBranding, readChannelAppearance } from '@/lib/community';
import { readInstanceConfig } from '@/lib/instance';
import { matrixApi as api, connectMatrix, restoreMatrixSession, disconnectMatrix, matrixStatus, onMatrixUpdate, uploadMatrixFile, snapshotMatrixAttachments, snapshotMatrixSendAttempt, discardMatrixFile, downloadMatrixFile, exportMatrixMessages, exportEncryptionKeys, importEncryptionKeys, getMatrixClient, resolveMatrixMessage, markMatrixRoomsRead } from '@/lib/matrix';
const AccountSettings = deferredPanel('Account settings', () => import('./account-settings').then(m => ({ default: m.AccountSettings })));
const AppearanceSettings = deferredPanel('Appearance settings', () => import('./appearance-settings').then(m => ({ default: m.AppearanceSettings })));
const TextMediaSettings = deferredPanel('Text and media settings', () => import('./text-media-settings').then(m => ({ default: m.TextMediaSettings })));
const NotificationSettings = deferredPanel('Notification settings', () => import('./notification-settings').then(m => ({ default: m.NotificationSettings })));
const DeviceManager = deferredPanel('Devices', () => import('./device-manager').then(m => ({ default: m.DeviceManager })));
const MessageExport = deferredPanel('Message export', () => import('./message-export').then(m => ({ default: m.MessageExport })));
const ServerAudit = deferredPanel('Server audit', () => import('./server-audit').then(m => ({ default: m.ServerAudit })));
const CollaborationBoard = deferredPanel('Collaboration board', () => import('./collaboration-board').then(m => ({ default: m.CollaborationBoard })));
const RoomPermissions = deferredPanel('Room permissions', () => import('./room-permissions').then(m => ({ default: m.RoomPermissions })));
const ChannelAdmin = deferredPanel('Channel administration', () => import('./channel-admin').then(m => ({ default: m.ChannelAdmin })));
const SocialPanel = deferredPanel('Friends and privacy', () => import('./social-panel').then(m => ({ default: m.SocialPanel })));
const DmRequests = deferredPanel('Message requests', () => import('./dm-requests').then(m => ({ default: m.DmRequests })));
const MemberDirectory = deferredPanel('Members', () => import('./member-directory').then(m => ({ default: m.MemberDirectory })));
const RoomReportReview = deferredPanel('Report review', () => import('./room-report-review').then(m => ({ default: m.RoomReportReview })));
const TemporaryBans = deferredPanel('Temporary bans', () => import('./temporary-bans').then(m => ({ default: m.TemporaryBans })));
const BulkModeration = deferredPanel('Bulk moderation', () => import('./bulk-moderation').then(m => ({ default: m.BulkModeration })));
const GroupMessage = deferredPanel('Group messages', () => import('./group-message').then(m => ({ default: m.GroupMessage })));
const MessageSearch = deferredPanel('Message search', () => import('./message-search').then(m => ({ default: m.MessageSearch })));
const MessageHistoryPanel = deferredPanel('Message context', () => import('./message-history').then(m => ({ default: m.MessageHistoryPanel })));
type Member = {
    id: string;
    name: string;
    role: string;
    email?: string;
};
type Conv = {
    id: string;
    name: string;
    description: string;
    kind: string;
    unread: number;
    mentions?: number;
    encrypted?: boolean;
    private?: boolean;
};
type Attachment = {
    id: string;
    name: string;
    size: number;
    url?: string;
    file?: any;
    thumbnail?: {url:string;file?:any;type:string}|null;
};
type Msg = {
    webhook?: { id: string; name: string; avatar: string } | null;
    forum?: { title: string; tags: string[] } | null;
    lastActivity?: number;
    id: string;
    body: string;
    author_id: string;
    author_name: string;
    conversation_id: string;
    conversation_name: string;
    created_at: number;
    edited_at: number | null;
    parent_id: string | null;
    pinned: number;
    saved: number;
    replies: number;
    reactions: {
        emoji: string;
        count: number;
        mine: number;
        users:string[];
    }[];
    attachments: Attachment[];
};
type Prefs = {
    naming: Naming;
    typing: boolean;
    focus: boolean;
    theme: string;
    accent: string;
    compact: boolean;
    muted: string[];
};
type Bootstrap = {
    servers?: {
        id: string;
        name: string;
        roomIds: string[];
    }[];
    me: Member;
    workspace: {
        name: string;
    };
    members: Member[];
    conversations: Conv[];
    memberships: {
        conversation_id: string;
        user_id: string;
    }[];
    preferences: Partial<Prefs>;
    preview?: boolean;
    invitations?: {
        id: string;
        name: string;
    }[];
};
const defaultPrefs: Prefs = { naming: 'standard', typing: false, focus: false, theme: 'light', accent: 'gold', compact: false, muted: [] };
const initials = (name: string) => name.split(/[ @.]+/).filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase();
const colors = ['mint', 'purple', 'sand', 'blue', 'rose'];
function Avatar({ name, size = 'normal' }: {
    name: string;
    size?: string;
}) { return <span className={'avatar ' + size + ' ' + colors[Array.from(name).reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length]}>{initials(name)}</span>; }
function IconButton({ label, children, onClick, className = '', disabled = false }: {
    label: string;
    children: ReactNode;
    onClick?: () => void;
    className?: string;
    disabled?: boolean;
}) { return <Tooltip><TooltipTrigger asChild><button className={'icon-button ' + className} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>; }
function RichText({ text }: {
    text: string;
}) { return <>{text.split(/(`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s]+|@[\w.-]+)/g).map((part, i) => part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : /^https?:\/\//.test(part) ? <a key={i} href={part} target='_blank' rel='noopener noreferrer' referrerPolicy='no-referrer'>{part}</a> : part.startsWith('@') ? <span className='mention' key={i}>{part}</span> : part)}</>; }
function bytes(size: number) { return size < 1024 * 1024 ? Math.max(1, Math.round(size / 1024)) + ' KB' : (size / 1024 / 1024).toFixed(1) + ' MB'; }
export default function Tavern() { return <TooltipProvider delayDuration={300}><SidebarProvider className='tavern-root'><Workspace /><VerificationDialog /><CallPanel /><ConferencePanel/></SidebarProvider><Toaster position='bottom-right' richColors/></TooltipProvider>; }
export function Workspace() {
    const textMedia=useTextMedia();
    const { setOpenMobile } = useSidebar();
    const [callsEnabled,setCallsEnabled]=useState(false);
    const [lockedServer, setLockedServer] = useState(false),[rolePolicyEnabled,setRolePolicyEnabled]=useState(false);
    const [server, setServer] = useState(''), [loginUser, setLoginUser] = useState(''), [password, setPassword] = useState(''), [loginStatus, setLoginStatus] = useState(''), [loginError, setLoginError] = useState(''), [connecting, setConnecting] = useState(false), [keyPassword, setKeyPassword] = useState('');
    const keyInput = useRef<HTMLInputElement>(null);
    const initialLink=parseConversationLink(window.location.hash),pendingRoom=useRef(initialLink.roomId),pendingEvent=useRef(initialLink.eventId);
    const [forwarding,setForwarding]=useState<Msg|null>(null);
    const [privateRoom, setPrivateRoom] = useState(''), [privateFocus, setPrivateFocus] = useState<{id:string;request:number}|null>(null);
    const navigationGeneration=useRef(0);
    const [historySelection, setHistorySelection] = useState<{
        roomId: string; eventId: string; request: number; client: ReturnType<typeof getMatrixClient>;
        actor: string | null | undefined; device: string | null | undefined; base: string | undefined;
        account: ReturnType<typeof accountArtworkOwner>; room: ReturnType<NonNullable<ReturnType<typeof getMatrixClient>>['getRoom']>;
    } | null>(null);
    const activeHistorySelection = useRef(historySelection); activeHistorySelection.current = historySelection;
    function currentHistorySelection(target: typeof historySelection) {
        return !!target && activeHistorySelection.current === target && navigationGeneration.current === target.request && getMatrixClient() === target.client &&
            accountArtworkOwner() === target.account && target.client?.getUserId() === target.actor && target.client?.getDeviceId() === target.device &&
            target.client?.getHomeserverUrl() === target.base && target.client?.getRoom(target.roomId) === target.room && target.room?.getMyMembership() === 'join';
    }
    const historyTarget = currentHistorySelection(historySelection) ? historySelection : null;
    useEffect(() => { if (historySelection && !historyTarget) setHistorySelection(null); }, [historySelection, historyTarget]);
    useEffect(() => {
        const check = () => { const target = activeHistorySelection.current; if (target && !currentHistorySelection(target)) setHistorySelection(null); };
        const stop = onMatrixUpdate(check), timer = window.setInterval(check, 250);
        window.addEventListener('tavern:signout', check);
        return () => { stop(); clearInterval(timer); window.removeEventListener('tavern:signout', check); };
    }, []);
    function closeMessageHistory(target: typeof historySelection) { if (target && activeHistorySelection.current === target) { navigationGeneration.current++; setHistorySelection(null); } }
    const threadScroll=useRef<HTMLDivElement|null>(null);
    const [unreadStart,setUnreadStart]=useState<string|null>(null),[focusMessage,setFocusMessage]=useState<{id:string;request:number}|null>(null);
    useEffect(() => { let active = true; readInstanceConfig().then(config => { if (active && config.homeserverUrl)
        { setServer(current => current || config.homeserverUrl); setLockedServer(!!config.lockHomeserver); setRolePolicyEnabled(config.serverRolePolicy===true);setCallsEnabled(config.callsEnabled===true); } }); return () => { active = false; }; }, []);
    const [data, setData] = useState<Bootstrap | null>(null), [prefs, setPrefs] = useState<Prefs>(defaultPrefs), [channel, setGuild] = useState('general'), [view, setView] = useState('channel'), [tab, setTab] = useState('messages');
    const [messages, setMessages] = useState<Msg[]>([]), [loading, setLoading] = useState(true), [connection, setConnection] = useState('Connecting'), [error, setError] = useState('');
    const [modal, setModal] = useState(''), [detail, setDetail] = useState(false), [search, setSearch] = useState(''), [results, setResults] = useState<Msg[]>([]), [searching, setSearching] = useState(false);
    const [selectedThread, setSelectedThread] = useState<{
        message: Msg;
        client: ReturnType<typeof getMatrixClient>;
        actor: string | null | undefined;
        device: string | null | undefined;
        account: ReturnType<typeof accountArtworkOwner>;
        room: ReturnType<NonNullable<ReturnType<typeof getMatrixClient>>['getRoom']>;
    } | null>(null);
    function setThread(message: Msg | null) {
        const c = getMatrixClient();
        setSelectedThread(message ? {
            message, client: c, actor: c?.getUserId(), device: c?.getDeviceId(),
            account: accountArtworkOwner(), room: c?.getRoom(message.conversation_id) ?? null,
        } : null);
    }
    const selectedThreadClient = getMatrixClient();
    const thread = selectedThread
        && selectedThread.client === selectedThreadClient
        && selectedThread.actor === selectedThreadClient?.getUserId()
        && selectedThread.device === selectedThreadClient?.getDeviceId()
        && selectedThread.account === accountArtworkOwner()
        && (data?.preview || selectedThreadClient?.getRoom(selectedThread.message.conversation_id) === selectedThread.room
            && selectedThread.room?.getMyMembership() === 'join') ? selectedThread.message : null;
    useEffect(() => { if (selectedThread && !thread) setSelectedThread(null); }, [selectedThread, thread]);
    const [deleting, setDeleting] = useState<Msg | null>(null), [editing, setEditing] = useState<Msg | null>(null), [editBody, setEditBody] = useState(''), [settingsTab, setSettingsTab] = useState('appearance');
    const [hasMore, setHasMore] = useState(false), [busy, setBusy] = useState(false), [channelName, setGuildName] = useState(''), [channelDesc, setGuildDesc] = useState(''), [isPrivate, setIsPrivate] = useState(false), [selectedMembers, setSelectedMembers] = useState<string[]>([]), [email, setEmail] = useState(''), [invited, setInvited] = useState<string[]>([]), [profileName, setProfileName] = useState(''), [workspaceName, setWorkspaceName] = useState('');
    const bottom = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null), nearBottom = useRef(true), generation = useRef(0), searchGeneration = useRef(0);
    const [selectedServer, setSelectedServer] = useState('all');
    const [reminder,setReminder]=useState<{roomId:string;eventId:string}|null>(null);
    const [reportTarget,setReportTarget]=useState<ReportTarget|null>(null);
    const [media,setMedia]=useState<{items:MediaAttachment[];index:number;isCurrent?:()=>boolean}|null>(null);
    const [profileRoom,setProfileRoom]=useState('');
    const [profileUser, setProfileUser] = useState(''), [confirmAction, setConfirmAction] = useState<{title:string;description:string;run:()=>Promise<unknown>}|null>(null), [confirmBusy,setConfirmBusy] = useState(false);
    const [instanceAdmin,setInstanceAdmin] = useState(false);
    useEffect(()=>{const due=(event:Event)=>{const item=(event as CustomEvent).detail;toast('A message reminder is due',{action:{label:'Open',onClick:()=>{openMessage(item.roomId,item.eventId);}}});};window.addEventListener('tavern:reminder',due);return()=>window.removeEventListener('tavern:reminder',due);},[]);
    useEffect(()=>{if(isManagedAccount())requestApi('/auth/session').then(s=>setInstanceAdmin(s.admin===true)).catch(()=>{});},[]);
    useEffect(()=>setNotificationFocus(prefs.focus),[prefs.focus]);
    const terms = terminology(prefs.naming), label = terms.label;
    const currentServer = data?.servers?.find(s => s.id === selectedServer);
    const navPreferences=navigationPreferences();
    const readAction=useMarkReadAction(markMatrixRoomsRead);
    const visibleChannels = data?.conversations.filter(c => c.kind !== 'dm' && (!currentServer || currentServer.roomIds.includes(c.id))).map(c=>({...c,manualUnread:navPreferences.unread.includes(c.id)}));
    function chooseServer(id: string) { navigationGeneration.current++;setPrivateRoom('');setDetail(false);pendingRoom.current='';pendingEvent.current='';setSelectedServer(id); setView('channel'); setThread(null); const server = data?.servers?.find(s => s.id === id); setGuild(server ? data?.conversations.find(c => server.roomIds.includes(c.id))?.id || '' : data?.conversations[0]?.id || 'general'); }
    const me = data?.me;
    const active = data?.conversations.find(c => c.id === channel);
    useEffect(() => onParticipantNavigation(value => { if (value.action === 'profile') openProfile(value.userId, value.roomId); else void startDm(value.userId); }), [data, channel, selectedServer]);
    const forumMode=readChannelPolicy(channel).kind==='forum';
    const voiceMode=active?.kind!=='dm'&&readChannelPolicy(channel).kind==='voice';
    const muted = prefs.muted.includes(channel);
    function convName(c: Conv) { if (c.kind !== 'dm')
        return c.name; if((data?.memberships.filter(m=>m.conversation_id===c.id).length||0)>2)return c.name;const peer = data?.memberships.find(m => m.conversation_id === c.id && m.user_id !== me?.id); return peer ? data?.members.find(m => m.id === peer.user_id)?.name || 'Direct message' : 'Notes to self'; }
    const name = active ? convName(active) : data?.preview ? 'general' : label("your Tavern");
    const channelMembers = data?.preview ? data.members : (data?.members || []).filter(m => data?.memberships.some(cm => cm.conversation_id === channel && cm.user_id === m.id));
    const loadBootstrap = useCallback(async () => { const owner=getMatrixClient(),account=accountArtworkOwner(); const b = await api('bootstrap'); if(getMatrixClient()!==owner||accountArtworkOwner()!==account)return b as Bootstrap; setData(b); setPrefs({ ...defaultPrefs, ...b.preferences }); setProfileName(b.me.name); setWorkspaceName(b.workspace.name); if (!b.preview) {
        const linked = pendingRoom.current;
        if(linked&&isPrivateDiscussion(getMatrixClient()?.getRoom(linked))){const eventId=pendingEvent.current;openPrivateDiscussion(linked,eventId);setGuild(current=>b.conversations.some((c:Conv)=>c.id===current)?current:b.conversations[0]?.id||'');return b as Bootstrap;}
        const linkedServer=b.servers?.find((s:{id:string})=>s.id===linked);
        if(linkedServer){navigationGeneration.current++;setPrivateRoom('');setDetail(false);setView('channel');setTab('messages');setThread(null);setSelectedServer(linkedServer.id);setGuild(b.conversations.find((c:Conv)=>linkedServer.roomIds.includes(c.id))?.id||'');setModal(current=>current==='roomInvites'?'':current);pendingRoom.current='';return b as Bootstrap;}
        if (linked && b.conversations.some((c: Conv) => c.id === linked)) {
            navigationGeneration.current++;setPrivateRoom('');setDetail(false);setGuild(linked); setView('channel'); setTab('messages'); setThread(null);
            setModal(current=>current==='roomInvites'?'':current);
            setSelectedServer(current => b.servers?.some((server: {id: string; roomIds: string[]}) => server.id === current && server.roomIds.includes(linked)) ? current : 'all');
            pendingRoom.current = '';
            if(pendingEvent.current){const eventId=pendingEvent.current;pendingEvent.current='';openMessage(linked,eventId);}
        }
        else {
            setGuild(current => b.conversations.some((c: Conv) => c.id === current) ? current : b.conversations[0]?.id || 'general');
            if (linked && b.invitations?.some((r: {
                id: string;
            }) => r.id === linked))
                setModal(isDmRequest(getMatrixClient()?.getRoom(linked)) ? 'dmRequests' : 'roomInvites');
        }
    } return b as Bootstrap; }, []);
    const loadMessages = useCallback(async (silent = false) => { const g = ++generation.current; if (!silent)
        setLoading(true); try {
        const action = view === 'channel' ? (tab === 'files' ? 'files' : 'messages') : view;
        if (matrixStatus().connected && view === 'channel' && !getMatrixClient()?.getRoom(channel)) {
            setMessages([]);
            setLoading(false);
            return;
        }
        const r = await api(action, undefined, view === 'channel' ? { conversation: channel } : {});
        if (g !== generation.current)
            return;
        if(!silent&&view==='channel'){const c=getMatrixClient(),room=c?.getRoom(channel);setUnreadStart(firstUnreadMessage(r.messages,room?.getEventReadUpTo(c!.getUserId()!)||null,c?.getUserId()||'',!!room?.getUnreadNotificationCount()||navigationPreferences().unread.includes(channel)));}
        setMessages(r.messages);
        setHasMore(r.hasMore);
        setConnection(matrixStatus().state);
        setError('');
        if (view === 'channel' && tab === 'messages' && nearBottom.current && !document.hidden && matrixStatus().connected && getMatrixClient()?.getRoom(channel)) {
            const readOwner=getMatrixClient(),readGeneration=accountArtworkOwner();
            await api('read', { conversation: channel, id: r.messages.at(-1)?.id });
            if(g!==generation.current||getMatrixClient()!==readOwner||accountArtworkOwner()!==readGeneration)return;
            const readRoom=readOwner?.getRoom(channel);
            if(readRoom)setData(d => d ? { ...d, conversations: d.conversations.map(c => c.id === channel ? { ...c, ...roomReadCounts(readRoom) } : c) } : d);
        }
        if (nearBottom.current && view === 'channel')
            setTimeout(() => bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' }), 30);
    }
    catch (e) {
        if (g === generation.current) {
            setError((e as Error).message);
            setConnection('Reconnecting');
        }
    }
    finally {
        if (g === generation.current)
            setLoading(false);
    } }, [channel, tab, view]);
    useEffect(() => { restoreMatrixSession().catch(e => toast.error(e.message)).finally(() => loadBootstrap().catch(e => { setError(e.message); setLoading(false); setConnection('Offline'); })); }, [loadBootstrap]);
    useEffect(() => { let timer: ReturnType<typeof setTimeout>|undefined; const off = onMatrixUpdate(() => { if(timer)return;timer = setTimeout(() => { timer=undefined;setConnection(matrixStatus().state); (pendingRoom.current ? loadBootstrap() : api('bootstrap').then(b => { setData(b); setPrefs({ ...defaultPrefs, ...b.preferences }); })).catch(() => { }); void loadMessages(true); }, 150); }); return () => { off(); clearTimeout(timer); }; }, [loadMessages, loadBootstrap]);
    useEffect(() => { if (!data) return; nearBottom.current = true; setMessages([]); void loadMessages(); return () => { generation.current++; }; }, [!!data, loadMessages]);
    useEffect(() => { const visible = () => { if (!document.hidden && data) { void loadMessages(true); void loadBootstrap(); } }; document.addEventListener('visibilitychange', visible); return () => document.removeEventListener('visibilitychange', visible); }, [!!data,loadMessages,loadBootstrap]);
    useEffect(() => { document.documentElement.dataset.accent = prefs.accent; applyAppearance(readAppearance()); }, [prefs]);
    useEffect(() => { const onKey = (e: KeyboardEvent) => { if (!e.defaultPrevented && (e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setModal('search');
    } }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []);
    const threadClient=getMatrixClient(),threadAccount=accountArtworkOwner(),threadActor=threadClient?.getUserId(),threadDevice=threadClient?.getDeviceId();
    const threadRoom=thread?threadClient?.getRoom(thread.conversation_id):undefined,threadNavigation=navigationGeneration.current;
    const threadView=useMemo(()=>({client:threadClient,account:threadAccount,actor:threadActor,device:threadDevice,room:threadRoom,root:thread?.id,roomId:thread?.conversation_id,navigation:threadNavigation}),[threadClient,threadAccount,threadActor,threadDevice,threadRoom,thread?.id,thread?.conversation_id,threadNavigation]);
    const activeThreadView=useRef<typeof threadView|null>(threadView);activeThreadView.current=threadView;
    const [replyState,setReplyState]=useState<{view:typeof threadView;messages:Msg[]}|null>(null);
    const currentThreadView=()=>activeThreadView.current===threadView&&!!threadView.root&&navigationGeneration.current===threadView.navigation&&getMatrixClient()===threadView.client&&accountArtworkOwner()===threadView.account&&threadView.client?.getUserId()===threadView.actor&&threadView.client?.getDeviceId()===threadView.device&&threadView.client?.getRoom(threadView.roomId!)===threadView.room&&threadView.room?.getMyMembership()==='join';
    const threadReader=useMemo(()=>createThreadReplyRefresh(currentThreadView,async()=>{const result=await api('messages',undefined,{conversation:threadView.roomId!,parent:threadView.root!});return result.messages as Msg[];},messages=>setReplyState({view:threadView,messages})),[threadView]);
    const refreshThreadReplies=threadReader.refresh;
    const replies=replyState?.view===threadView&&currentThreadView()?replyState.messages:[];
    useEffect(()=>{activeThreadView.current=threadView;setReplyState(null);if(!threadView.root)return;
        const run=()=>refreshThreadReplies().catch(e=>{if(currentThreadView())toast.error(e.message);});
        void run();const off=onMatrixUpdate(()=>{if(!document.hidden)void run();});
        return()=>{if(activeThreadView.current===threadView)activeThreadView.current=null;threadReader.invalidate();off();};
    },[threadReader]);
    useEffect(()=>{const follow=()=>{const link=parseConversationLink(location.hash);if(!link.roomId)return;pendingRoom.current=link.roomId;pendingEvent.current=link.eventId;void loadBootstrap().catch(e=>toast.error(e.message));};window.addEventListener('hashchange',follow);return()=>window.removeEventListener('hashchange',follow);},[loadBootstrap]);
    function closePrivateDiscussion(){navigationGeneration.current++;setPrivateRoom('');setPrivateFocus(null);}
    function openPrivateDiscussion(roomId:string,eventId='') {
        navigationGeneration.current++;pendingRoom.current='';pendingEvent.current='';setThread(null);setDetail(false);setModal('');setPrivateRoom(roomId);setPrivateFocus(eventId?{id:eventId,request:Date.now()}:null);setOpenMobile(false);
    }
    function select(id: string) {
        if(isPrivateDiscussion(getMatrixClient()?.getRoom(id))){openPrivateDiscussion(id);return;}
        navigationGeneration.current++;pendingRoom.current='';pendingEvent.current='';setPrivateRoom('');setPrivateFocus(null);setDetail(false);setFocusMessage(null);setUnreadStart(null);setThread(null);setOpenMobile(false);
        if(matrixStatus().connected&&!getMatrixClient()?.getRoom(id)&&!data?.conversations.some(c=>c.id===id)){pendingRoom.current=id;void loadBootstrap().catch(e=>toast.error(e.message));return;}
        if(currentServer&&!currentServer.roomIds.includes(id))setSelectedServer('all');setGuild(id);setView('channel');setTab('messages');
    }
    function openThread(message:Msg) {
        if(isPrivateDiscussion(getMatrixClient()?.getRoom(message.conversation_id))){openPrivateDiscussion(message.conversation_id,message.id);return;}
        navigationGeneration.current++;setPrivateRoom('');setDetail(false);setModal('');setThread(message);
    }
    function openMessage(roomId:string,eventId='') {
        if(isPrivateDiscussion(getMatrixClient()?.getRoom(roomId))){openPrivateDiscussion(roomId,eventId);return;}
        select(roomId);setModal('');if(!eventId)return;
        if(pendingRoom.current===roomId){pendingEvent.current=eventId;return;}
        const request=navigationGeneration.current, client=getMatrixClient(), account=accountArtworkOwner(), actor=client?.getUserId(), device=client?.getDeviceId(), base=client?.getHomeserverUrl(), room=client?.getRoom(roomId)??null;
        const current=()=>request===navigationGeneration.current&&getMatrixClient()===client&&accountArtworkOwner()===account&&client?.getUserId()===actor&&client?.getDeviceId()===device&&client?.getHomeserverUrl()===base&&client?.getRoom(roomId)===room&&room?.getMyMembership()==='join';
        void resolveMatrixMessage(roomId,eventId).then(async message=>{
            if(!current())return;
            if(message.parent_id){const root=await resolveMatrixMessage(roomId,message.parent_id);if(current())openThread(root);return;}
            setHistorySelection({roomId,eventId,request,client,account,actor,device,base,room});
        }).catch(e=>{if(current())toast.error(e.message);});
    }
    function replyInThread(message:Msg) {
        if(!message.parent_id){openThread(message);return;}
        const request=navigationGeneration.current,client=getMatrixClient(),account=accountArtworkOwner();
        void resolveMatrixMessage(message.conversation_id,message.parent_id).then(root=>{if(request===navigationGeneration.current&&getMatrixClient()===client&&accountArtworkOwner()===account)openThread(root);}).catch(e=>{if(request===navigationGeneration.current)toast.error(e.message);});
    }
    const go = (v: string) => { navigationGeneration.current++;setPrivateRoom('');setDetail(false);setView(v); setThread(null); setOpenMobile(false); };
    async function act(action: string, p: any) { try {
        const r = await api(action, p);
        await loadMessages(true);
        if (thread) await refreshThreadReplies();
        return r;
    }
    catch (e) {
        toast.error((e as Error).message);
        throw e;
    } }
    async function updatePrefs(p: Partial<Prefs>) { const next = { ...prefs, ...p }; try {
        if(p.muted){const changed=[...new Set([...prefs.muted,...p.muted])].filter(id=>prefs.muted.includes(id)!==p.muted!.includes(id));if(changed.length){const rules=await updateNotificationPreferences(old=>({...old,rooms:{...old.rooms,...Object.fromEntries(changed.map(id=>[id,{...(old.rooms[id]||{mode:'inherit',mutedUntil:0}),mutedUntil:p.muted!.includes(id)?-1:0}]))}}));for(const roomId of changed)await synchronizeNotificationRules(rules,{roomId});}}
        await api('preferences', next);
        setPrefs(next);
    }
    catch (e) {
        toast.error((e as Error).message);
    } }
    function openSettings(t = 'appearance') { setSettingsTab(t); setModal('settings'); }
    function openProfile(id:string,roomId=channel){setProfileRoom(roomId);setProfileUser(id);}
    async function callUser(id:string){const roomId=await startDm(id);if(roomId)await startCall(roomId,false);}
    async function startDm(member: string) { setBusy(true); try {
        const r = await api('create', { kind: 'dm', name: 'Direct message', members: [member] });
        await loadBootstrap();
        select(r.id);
        setModal('');return r.id as string;
    }
    catch (e) {
        toast.error((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    async function createGuild() { setBusy(true); try {
        const r = await api('create', { kind: isPrivate ? 'private' : 'channel', name: channelName, description: channelDesc, members: selectedMembers, serverId: currentServer?.id });
        await loadBootstrap();
        select(r.id);
        setModal('');
        setGuildName('');
        setGuildDesc('');
        setSelectedMembers([]);
        toast.success(label("Your Guild is ready."));
    }
    catch (e) {
        toast.error((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    async function loadOlder() { if (busy || !hasMore) return; const request = ++generation.current; setBusy(true); try {
        const r = await api('messages', undefined, { conversation: channel, before: String(messages[0]?.created_at || 1) });
        if (request !== generation.current) return;
        setMessages(r.messages);
        setHasMore(r.hasMore);
    }
    catch (e) {
        toast.error((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    const messageLink = (m:Msg) => location.origin + '/#room=' + encodeURIComponent(m.conversation_id) + '&event=' + encodeURIComponent(m.id);
    function roomActions(c:Conv):ContextAction[]{const room=getMatrixClient()?.getRoom(c.id),uid=getMatrixClient()?.getUserId();const navPrefs=navigationPreferences();return [
      {label:'Mark read',run:()=>readAction.run([c.id])},
      {label:navPrefs.unread.includes(c.id)?'Clear unread marker':'Mark unread',run:()=>setNavigationFlag(c.id,'unread',!navPrefs.unread.includes(c.id))},
      {label:prefs.muted.includes(c.id)?'Unmute':'Mute',run:()=>updatePrefs({muted:prefsForMute(c.id)})},
      {label:navPrefs.favorites.includes(c.id)?'Remove favorite':'Favorite',run:()=>setNavigationFlag(c.id,'favorites',!navPrefs.favorites.includes(c.id))},
      {label:'Notification settings',run:()=>{select(c.id);setDetail(true);}},
      {label:'Copy channel link',run:()=>copyText(location.origin+'/#room='+encodeURIComponent(c.id))},
      {label:'Copy channel ID',run:()=>copyText(c.id)},
      {label:'Edit channel & permissions',visible:!!uid&&!!room?.currentState.maySendStateEvent('m.room.name',uid),run:()=>{select(c.id);setDetail(true);}},
      {label:'Leave conversation',danger:true,separator:true,run:()=>setConfirmAction({title:'Leave '+c.name+'?',description:'You may need a new invitation to return. Save your recovery key before leaving encrypted conversations.',run:async()=>{await getMatrixClient()!.leave(c.id);await loadBootstrap();}})},
    ];}
    function serverActions(server:{id:string;name:string}):ContextAction[]{const room=getMatrixClient()?.getRoom(server.id),prefs=navigationPreferences();return [{label:'Open server',run:()=>chooseServer(server.id)},{label:'Welcome and rules',run:()=>{chooseServer(server.id);setModal('serverWelcome');}},{label:prefs.favorites.includes(server.id)?'Remove favorite':'Favorite server',run:()=>setNavigationFlag(server.id,'favorites',!prefs.favorites.includes(server.id))},{label:'Mark server read',run:()=>readAction.run((room?.currentState.getStateEvents('m.space.child')||[]).filter(e=>Array.isArray(e.getContent().via)&&e.getContent().via.length>0).map(e=>e.getStateKey()!).filter(Boolean))},{label:'Server settings',visible:canEditCommunity(server.id,'layout'),run:()=>{chooseServer(server.id);setModal('serverSettings');}},{label:'Invite people',visible:canInviteToRoom(server.id),run:()=>{chooseServer(server.id);setModal('inviteServer');}},{label:'Manage integrations',visible:roomWebhookLocations(server.id).length>0,run:()=>{chooseServer(server.id);setModal('serverIntegrations');}},{label:'Review reports',visible:roomReportLocations(server.id).length>0,run:()=>{chooseServer(server.id);setModal('serverReports');}},{label:'Audit log',visible:canViewServerAudit(server.id),run:()=>{chooseServer(server.id);setModal('serverAudit');}},{label:'Member warnings',visible:isManagedAccount()&&canBulkRedact(server.id),run:()=>{chooseServer(server.id);setModal('serverWarnings');}},{label:'Copy server link',run:()=>copyText(location.origin+'/#server='+encodeURIComponent(server.id))},{label:'Copy server ID',run:()=>copyText(server.id)},{label:'Report server',visible:isManagedAccount(),run:()=>setReportTarget({kind:'server',roomId:server.id})},{label:'Leave server',danger:true,run:()=>setConfirmAction({title:'Leave '+server.name+'?',description:'This removes your server membership. Leave individual channels separately if you also want to leave those conversations.',run:async()=>{await getMatrixClient()!.leave(server.id);await loadBootstrap();chooseServer('all');}})}];}
    function prefsForMute(id:string){return prefs.muted.includes(id)?prefs.muted.filter(v=>v!==id):[...prefs.muted,id];}
    function userActions(id:string,roomId=channel):ContextAction[]{const server=currentServer&&(currentServer.id===roomId||currentServer.roomIds.includes(roomId))?currentServer:data?.servers?.find(s=>s.id===roomId||s.roomIds.includes(roomId));return [
      {label:'View profile',run:()=>openProfile(id,roomId)},
      {label:'Message',visible:id!==me?.id,run:()=>startDm(id)},
      {label:'Call',visible:callsEnabled&&id!==me?.id,run:()=>callUser(id)},
      {label:'Mention',visible:messagePermissions(roomId,me?.id||'').send,run:()=>{select(roomId);setTimeout(()=>window.dispatchEvent(new CustomEvent('tavern:quote',{detail:{roomId,text:id+' '}})),0);}},
      {label:'Assign roles',visible:!!server&&canAssignMemberRoles(server.id,id),run:()=>{if(server)openMemberRoles(server.id,id);}},
      {label:'Manage server nickname',visible:!!server&&canManageServerNickname(server.id,id),run:()=>{if(server)openServerNickname(server.id,id);}},
      {label:'Moderate member',visible:rolePolicyEnabled&&(['timeout','kick','ban'] as const).some(op=>canModerateMember(roomId,id,op)),run:()=>openProfile(id,roomId)},
      {label:'Member warnings',visible:isManagedAccount()&&canWarnMember(roomId,id,true),run:()=>openProfile(id,roomId)},
      {label:'Add contact',visible:isManagedAccount()&&id!==me?.id,run:()=>sendContactRequest(id)},
      {label:isUserBlocked(id)?'Unblock':'Block',visible:id!==me?.id,run:()=>blockUser(id,!isUserBlocked(id))},
      {label:'Copy user ID',run:()=>copyText(id)},
      {label:'Report user',visible:isManagedAccount()&&id!==me?.id,run:()=>setReportTarget({kind:'user',targetId:id,roomId})},
    ];}
    function messageCard(m: Msg, inThread = false, context?: {messages:Msg[];current:()=>boolean}) {
        if(context&&!context.current())return null;
        const messageServer=currentServer?.roomIds.includes(m.conversation_id)?currentServer:data?.servers?.find(s=>s.roomIds.includes(m.conversation_id));
        const authorName=serverNicknameForRoom(m.conversation_id,m.author_id,messageServer?.id)??m.author_name;
        if(isUserBlocked(m.author_id))return null;
        const privateMessage=isPrivateDiscussion(getMatrixClient()?.getRoom(m.conversation_id));
        const permissions=privateMessage?privateThreadMessagePermissions(m.conversation_id,m.author_id):messagePermissions(m.conversation_id,m.author_id);
        const gallery = (context?.messages || (privateMessage ? [m] : inThread ? [thread,...replies].filter(Boolean) as Msg[] : messages)).flatMap(item=>item.attachments.map(attachment=>({...attachment,messageUrl:messageLink(item)})));
        const previewAttachment=(id:string)=>{if(context&&!context.current())return;setMedia({items:gallery,index:gallery.findIndex(file=>file.id===id),...(context?{isCurrent:context.current}:{})});};
        const replyAllowed=!privateMessage&&permissions.send&&!threadReplyRestriction(m.conversation_id,m.parent_id||m.id,m.lastActivity);
        const actions:ContextAction[]=[
          {label:'Reply in thread',visible:replyAllowed,run:()=>replyInThread(m)},
          {label:'React with 👍',visible:permissions.react,run:()=>act('react',{id:m.id,emoji:'👍'})},
          {label:m.saved?'Remove bookmark':'Save message',run:()=>act('save',{id:m.id})},
          {label:m.pinned?'Unpin':'Pin message',visible:permissions.pin,run:()=>act('pin',{id:m.id})},
          {label:'Mark unread',run:()=>setNavigationFlag(m.conversation_id,'unread',true)},
          {label:'Quote message',visible:permissions.send,run:()=>{select(m.conversation_id);setTimeout(()=>window.dispatchEvent(new CustomEvent('tavern:quote',{detail:{roomId:m.conversation_id,text:'> '+authorName+' wrote:\n'+m.body.split('\n').map(line=>'> '+line).join('\n')+'\n\n'}})),50);}},{label:'Copy text',run:()=>copyText(m.body)},
          {label:'Remind me',run:()=>setReminder({roomId:m.conversation_id,eventId:m.id})},{label:'Copy message link',run:()=>copyText(messageLink(m))},
          {label:'Copy message ID',run:()=>copyText(m.id)},{label:'Forward message',run:()=>setForwarding(m)},
          {label:'Report message',visible:isManagedAccount(),run:()=>setReportTarget({kind:'message',roomId:m.conversation_id,eventId:m.id})},
          {label:'Edit message',visible:permissions.edit,run:()=>{setEditing(m);setEditBody(m.body);}},
          {label:'Delete message',visible:permissions.delete,danger:true,separator:true,run:()=>setDeleting(m)},
        ];
        return <ActionMenu key={m.id} actions={actions}><article tabIndex={0} className={'message ' + (prefs.compact ? 'compact ' : '') + (m.author_id === me?.id ? 'own' : '')} key={m.id} id={'message-' + m.id}>
  <ActionMenu actions={userActions(m.author_id,m.conversation_id)}><QuickProfile roomId={m.conversation_id} userId={m.author_id} serverId={messageServer?.id} onOpenFull={()=>openProfile(m.author_id,m.conversation_id)} onMessage={()=>void startDm(m.author_id)}><button aria-label={'View '+authorName+' profile'}><CommunityAvatar roomId={m.conversation_id} userId={m.author_id} serverId={messageServer?.id} fallback={authorName}/></button></QuickProfile></ActionMenu><div className='message-content'><div className='message-meta'><strong>{authorName}</strong>{messageServer&&<ServerRoleBadges serverId={messageServer.id} userId={m.author_id}/>} {m.author_id === me?.id && <span className='you-label'>you</span>}<time dateTime={new Date(m.created_at).toISOString()}>{new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>{m.edited_at && <span className='edited'>edited</span>}{m.pinned === 1 && <Pin size={13} className='pin-mark'/>}{view !== 'channel' && !inThread && <button className='source-channel' onClick={() => openMessage(m.conversation_id,m.id)}>#{m.conversation_name}</button>}</div>
  <WebhookMessageLabel value={m.webhook}/><div className='message-body'>{editing?.id===m.id?<form className='inline-message-edit' onSubmit={e=>{e.preventDefault();void act('edit',{id:m.id,body:editBody}).then(()=>setEditing(null)).catch(()=>{});}}><textarea autoFocus aria-label='Edit message text' value={editBody} onChange={e=>setEditBody(e.target.value)} maxLength={8000} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setEditing(null);}else if(shouldSendOnKey({...e,isComposing:e.nativeEvent.isComposing},textMedia.enterToSend)){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/><div className='product-actions'><button className='primary-button' disabled={!editBody.trim()}>Save</button><button className='secondary-button' type='button' onClick={()=>setEditing(null)}>Cancel</button></div></form>:<RichMessage text={m.body} renderText={text=><ServerEmojiText text={text} serverId={messageServer?.id}/>}/>}</div>{!editing&&<LinkPreviews text={m.body}/>} {m.attachments.length > 0 && <div className='attachments'>{m.attachments.map(a => <ActionMenu key={a.id} actions={[{label:'Preview',run:()=>previewAttachment(a.id)},{label:'Download',run:()=>downloadMatrixFile(a)},{label:'Copy filename',run:()=>copyText(a.name)},{label:'Remind me',run:()=>setReminder({roomId:m.conversation_id,eventId:m.id})},{label:'Copy message link',run:()=>copyText(messageLink(m))},{label:'Save message',run:()=>act('save',{id:m.id})}]}><button className='file-card' onClick={() => previewAttachment(a.id)}>{textMedia.inlineImages&&a.thumbnail?<AttachmentThumbnail preview={a.thumbnail} name={a.name}/>:<span className='file-icon'><FileText size={22}/></span>}<span><strong>{a.name}</strong><small>{bytes(a.size)} · Preview</small></span><Download size={16}/></button></ActionMenu>)}</div>}
  <ReactionBar roomId={m.conversation_id} eventId={m.id} reactions={m.reactions} canReact={permissions.react} onProfile={id=>openProfile(id,m.conversation_id)}/>
  {!privateMessage && !inThread && <DraftThreadLink roomId={m.conversation_id} rootId={m.id} replies={m.replies} onOpen={() => openThread(m)}/>}
  </div><div className='message-actions'>
   {permissions.react&&<DropdownMenu><DropdownMenuTrigger asChild><button className='icon-button' aria-label='Add reaction'><Smile size={17}/></button></DropdownMenuTrigger><DropdownMenuContent><EmojiPicker serverId={messageServer?.id} onSelectCustom={emoji=>void act('react',{id:m.id,emoji:emoji.uri}).catch(()=>{})} onSelect={emoji=>void act('react',{id:m.id,emoji}).catch(()=>{})}/></DropdownMenuContent></DropdownMenu>}
   {!inThread && !m.parent_id && replyAllowed && <IconButton label='Reply in thread' onClick={() => openThread(m)}><MessageSquare size={17}/></IconButton>}
   <IconButton label={m.saved ? 'Remove from saved' : 'Save for later'} className={m.saved ? 'is-saved' : ''} onClick={() => act('save', { id: m.id }).then(() => toast.success(m.saved ? 'Removed from saved' : 'Saved for later')).catch(() => { })}><Bookmark size={17} fill={m.saved ? 'currentColor' : 'none'}/></IconButton>
   <DropdownMenu><DropdownMenuTrigger asChild><button className='icon-button' aria-label='More message actions'><MoreHorizontal size={18}/></button></DropdownMenuTrigger><DropdownMenuContent align='end'>{permissions.pin&&<DropdownMenuItem onSelect={() => act('pin', { id: m.id }).catch(() => { })}><Pin />{m.pinned ? 'Unpin message' : label("Pin to Guild")}</DropdownMenuItem>}{(permissions.edit||permissions.delete) && <><DropdownMenuSeparator />{permissions.edit&&<DropdownMenuItem onSelect={() => { setEditing(m); setEditBody(m.body); }}><Pencil />Edit message</DropdownMenuItem>}{permissions.delete&&<DropdownMenuItem className='danger-text' onSelect={() => setDeleting(m)}><Trash2 />Delete message</DropdownMenuItem>}</>}</DropdownMenuContent></DropdownMenu>
  </div></article></ActionMenu>;
    }
    const profileServer=currentServer?.roomIds.includes(profileRoom||channel)?currentServer:data?.servers?.find(s=>s.roomIds.includes(profileRoom||channel));
    const visibleMessages=(tab==='pins'&&view==='channel'?messages.filter(m=>m.pinned):messages).filter(m=>!isUserBlocked(m.author_id));
    const heading = view === 'channel' ? name : ({ mentions: 'Mentions', threads: 'Threads', saved: 'Saved for later', files: 'Shared files' } as any)[view] || name;
    return <>
 <aside className='workspace-rail' aria-label='Tavern navigation'><button className='brand-mark' aria-label='Tavern home' onClick={() => chooseServer('all')}><Beer size={27} strokeWidth={2}/></button><div className='rail-divider'/><button className={'workspace-icon ' + (selectedServer === 'all' ? 'selected' : '')} onClick={() => chooseServer('all')} title='All conversations' >T<span /></button><ServerNavigation servers={data?.servers||[]} active={selectedServer} onSelectServer={chooseServer} renderServer={(server,button)=><ActionMenu actions={serverActions(server)}>{button}</ActionMenu>}/><IconButton label={'Create ' + terms.server} disabled={!!data?.preview} onClick={() => setModal('server')}><Plus size={20}/></IconButton><IconButton label='Tavern settings' onClick={() => openSettings('workspace')}><Settings size={20}/></IconButton><div className='rail-spacer'/><IconButton label='About Tavern' onClick={() => openSettings('about')}><CircleHelp size={20}/></IconButton><button className='rail-profile' aria-label='Your profile' onClick={() => openSettings('profile')}><Avatar name={me?.name || 'You'} size='small'/></button></aside>
 <Sidebar collapsible='offcanvas' className='channel-sidebar'>
  <SidebarHeader className='workspace-header'><DropdownMenu><DropdownMenuTrigger asChild><button className='workspace-select'><span><strong>{currentServer?.name || data?.workspace.name || 'Tavern'}</strong><small><span className='matrix-wordmark'>[m]</span> Self-hosted · Matrix</small></span><ChevronDown size={17}/></button></DropdownMenuTrigger><DropdownMenuContent className='workspace-menu' align='start'><DropdownMenuItem onSelect={() => chooseServer('all')}>All conversations</DropdownMenuItem>{currentServer&&<DropdownMenuItem onSelect={()=>setModal('serverWelcome')}>Welcome and rules</DropdownMenuItem>}{data?.servers?.map(server => <DropdownMenuItem key={server.id} onSelect={() => chooseServer(server.id)}>{server.name}</DropdownMenuItem>)}<DropdownMenuItem disabled={!!data?.preview} onSelect={() => setModal('server')}>Create {terms.server}</DropdownMenuItem>{currentServer&&canEditCommunity(currentServer.id,'layout')&&<DropdownMenuItem onSelect={()=>setModal('serverSettings')}>Server settings & categories</DropdownMenuItem>}{currentServer&&canInviteToRoom(currentServer.id)&&<DropdownMenuItem onSelect={()=>setModal('inviteServer')}>Invite to {terms.server}</DropdownMenuItem>}<DropdownMenuSeparator /><DropdownMenuItem onSelect={() => setModal('invite')}><Users />Invite people</DropdownMenuItem><DropdownMenuItem onSelect={() => openSettings('workspace')}><Settings />Tavern settings</DropdownMenuItem><DropdownMenuItem onSelect={() => openSettings('privacy')}><ShieldCheck />Privacy & security</DropdownMenuItem></DropdownMenuContent></DropdownMenu></SidebarHeader>
  <SidebarContent className='navigation-content'><nav className='quick-nav' aria-label='Messages'><button className={view === 'mentions' ? 'active' : ''} onClick={() => go('mentions')}><AtSign size={18}/><span>Mentions</span></button><button className={view === 'threads' ? 'active' : ''} onClick={() => go('threads')}><MessageSquare size={18}/><span>Threads</span></button><button className={view === 'saved' ? 'active' : ''} onClick={() => go('saved')}><Bookmark size={18}/><span>Saved for later</span></button><button onClick={()=>setModal('dmRequests')}><MessageCircle size={18}/><span>Message requests ({dmRequests().length})</span></button><button onClick={()=>setModal('privateDiscussions')}><LockKeyhole size={18}/><span>Private discussions</span></button></nav>
   {data?.conversations.some(c=>navPreferences.favorites.includes(c.id))&&<div className='channel-section'><div className='nav-section-label'>FAVORITES</div>{data.conversations.filter(c=>navPreferences.favorites.includes(c.id)).map(c=><ActionMenu key={c.id} actions={roomActions(c)}><button className={'channel-link '+(channel===c.id?'active':'')} onClick={()=>select(c.id)}><Star size={16}/><span>{convName(c)}</span><DraftIndicator roomId={c.id} label={'Draft in '+convName(c)}/></button></ActionMenu>)}</div>}<div className='channel-section'><div className='nav-section-label'><span><ChevronDown size={13}/>{label(" GUILDS")}</span><IconButton label={label("Create a Guild")} onClick={() => setModal('create')}><Plus size={15}/></IconButton></div><ChannelNavigation serverId={currentServer?.id} channels={visibleChannels||[]} active={view==='channel'?channel:''} muted={prefs.muted} focus={prefs.focus} onSelect={select} renderChannel={(c,button)=><ActionMenu key={c.id} actions={roomActions(data!.conversations.find(room=>room.id===c.id)!)}><div className='channel-nav-row'>{button}<DraftIndicator roomId={c.id} label={'Draft in '+c.name}/></div></ActionMenu>}/><button className='add-channel' onClick={() => setModal('create')}><Plus size={16}/>{label(" Add a Guild")}</button></div>
   <div className='channel-section dm-section'><div className='nav-section-label'><span><ChevronDown size={13}/> DIRECT MESSAGES</span><IconButton label='New direct message' onClick={() => setModal('dm')}><Plus size={15}/></IconButton></div>{data?.conversations.filter(c => c.kind === 'dm').map(c => <ActionMenu key={c.id} actions={roomActions(c)}><button key={c.id} className={'channel-link dm-link ' + (channel === c.id && view === 'channel' ? 'active' : '')} onClick={() => select(c.id)}><Avatar name={convName(c)} size='tiny'/><span>{convName(c)}</span><DraftIndicator roomId={c.id} label={'Draft in '+convName(c)}/><ReadStateBadges unread={c.unread} mentions={c.mentions} manual={navPreferences.unread.includes(c.id)} muted={prefs.muted.includes(c.id)} focus={prefs.focus}/></button></ActionMenu>)}{!data?.conversations.some(c => c.kind === 'dm') && <button className='channel-link dm-link' onClick={() => me && startDm(me.id)}><Avatar name={me?.name || 'You'} size='tiny'/><span>Notes to self</span><span className='small-note'>you</span></button>}<button className='add-channel' onClick={() => setModal('dm')}><Plus size={16}/> New message</button></div>
   <MarkAllReadButton onMarkAllRead={()=>void readAction.run()} busy={readAction.busy} disabled={!readAction.available||!!data?.preview}/>
   <button className='invite-sidebar' onClick={() => setModal('invite')}><span className='invite-icon'><Users size={18}/></span><span><strong>Better with your people</strong><small>Invite them to Tavern</small></span><ChevronRight size={15}/></button>
  </SidebarContent><SidebarFooter className='sidebar-footer'><div className='connection'><span className={connection === 'Connected' ? 'live' : ''}/>{connection}<span className='version'>v0.4.0</span></div><button className='profile-button' onClick={() => openSettings('profile')}><Avatar name={me?.name || 'You'} size='small'/><span><strong>{me?.name || label("Your Tavern")}</strong><small>{data?.preview ? 'Not connected' : 'Matrix account'}</small></span><Settings size={17}/></button></SidebarFooter>
 </Sidebar>
 <main className='main-workspace'>
  {!data?.preview && <HistoryRecovery/>}
  <header className='global-header'><div className='breadcrumb'><SidebarTrigger className='mobile-sidebar-trigger'/><span>Tavern</span><ChevronRight size={12}/><strong>{view === 'channel' ? label("Guilds") : heading}</strong></div><button className='global-search' onClick={() => openCommandPalette()}><Search size={17}/><span>{label("Search your Tavern")}</span><kbd>Ctrl K</kbd></button><div className='header-end'>{instanceAdmin&&<a className='secondary-button' href='/admin'>Admin</a>}<IconButton label={prefs.focus?'Leave focus mode':'Enter focus mode'} onClick={()=>updatePrefs({focus:!prefs.focus})}><Moon size={18} fill={prefs.focus?'currentColor':'none'}/></IconButton><span className='private-badge'><ShieldCheck size={14}/>{active?.encrypted ? 'Encrypted' : 'Matrix ready'}</span><IconButton label='Tavern members' onClick={() => setModal('members')}><Users size={18}/></IconButton></div></header>
  {data?.preview && <div className='matrix-banner'><span className='matrix-wordmark'>[matrix]</span><span>Your space. Your server. Connect Matrix to start a conversation.</span><button onClick={() => setModal('connect')}>Connect homeserver <ArrowRight size={13}/></button></div>}
  {!!data?.invitations?.length && <div className='matrix-banner'><Users size={16}/><span>{data.invitations.length} room invitation{data.invitations.length === 1 ? '' : 's'}</span><button onClick={() => setModal('roomInvites')}>View invitations</button></div>}
  <div className='channel-header'><div className='channel-heading'><span className='channel-symbol'>{view === 'channel' ? (active?.kind === 'private' ? <LockKeyhole size={23}/> : active?.kind === 'dm' ? <MessageCircle size={23}/> : <Hash size={27}/>) : view === 'saved' ? <Bookmark size={24}/> : view === 'mentions' ? <AtSign size={24}/> : <MessageSquare size={24}/>}</span><div><h1>{heading}</h1><p>{view === 'channel' ? (active?.kind === 'dm' ? 'A conversation just for you and the people here.' : active?.description || 'The home for your team.') : ({ mentions: 'The conversations that need your attention.', threads: 'Keep the conversation going, without the noise.', saved: 'The things you wanted to come back to.', files: 'Files shared across your conversations.' } as any)[view]}</p></div></div><div className='channel-controls'>{view === 'channel' && <><ConferenceButton key={channel} roomId={channel} disabled={!!data?.preview}/><CallButtons roomId={channel} direct={active?.kind==='dm'} disabled={!!data?.preview}/><button className='member-pill' onClick={() => setModal('members')}><Users size={15}/>{channelMembers.length || 1}</button><span className='control-divider'/><IconButton label={muted ? label("Unmute Guild") : label("Mute Guild")} onClick={() => updatePrefs({ muted: muted ? prefs.muted.filter(c => c !== channel) : [...prefs.muted, channel] })}>{muted ? <BellOff size={18}/> : <Bell size={18}/>}</IconButton><IconButton label={label("Guild details")} onClick={() => setDetail(true)}><Info size={18}/></IconButton></>}</div></div>
  {view === 'channel' && !voiceMode && <Tabs value={tab} onValueChange={setTab} className='channel-tabs'><TabsList variant='line'><TabsTrigger value='messages'><MessageSquare />Messages</TabsTrigger><TabsTrigger value='files'><Paperclip />Files</TabsTrigger><TabsTrigger value='pins'><Pin />Pinned</TabsTrigger><TabsTrigger value='work'><CheckCircle2 />Work</TabsTrigger></TabsList><div className='channel-caption'>{active?.encrypted ? <ShieldCheck size={12}/> : <Info size={12}/>} {data?.preview ? 'Not connected' : active?.encrypted ? 'End-to-end encrypted' : 'Unencrypted room'}</div></Tabs>}
  <div className='conversation-layout'><section className='conversation-main'>
   {error && <div className='error-banner' role='alert'><Info size={17}/><span>{error}</span><button onClick={() => { if (data)
        loadMessages();
    else
        loadBootstrap().catch(e => setError(e.message)); }}>Retry</button></div>}
   {view==='channel'&&voiceMode?<VoiceChannel key={channel} roomId={channel} name={heading} disabled={!!data?.preview} onProfile={id=>openProfile(id,channel)}/>:view==='channel'&&tab==='messages'&&forumMode?<ForumChannel key={channel} roomId={channel} serverId={currentServer?.id} messages={messages} onOpen={openThread} onSent={()=>loadMessages(true)} onProfile={id=>openProfile(id,channel)} hasMore={hasMore} loadingHistory={busy} onLoadHistory={loadOlder}/>:view==='channel'&&tab==='work'?<CollaborationBoard key={channel} roomId={channel}/>:<div className='message-scroll' ref={scroll} onScroll={() => { if (scroll.current)
        nearBottom.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 150; }}>
    {loading && messages.length === 0 ? <div className='loading-messages'><Loader2 size={23} className='spin'/><span>Opening your conversations…</span></div> : <>
     {view === 'channel' && tab === 'messages' && <div className='channel-intro'><span className='intro-hash'>{active?.kind === 'dm' ? <MessageCircle size={30}/> : active?.kind === 'private' ? <LockKeyhole size={30}/> : <Hash size={36}/>}</span><h2>{!active && !data?.preview ? label("Your Tavern is ready") : active?.kind === 'dm' ? name : `Welcome to #${name}`}</h2><p>{!active && !data?.preview ? 'Create your first encrypted room to start a conversation.' : active?.kind === 'dm' ? (name === 'Notes to self' ? 'A quiet spot for thoughts, links, and things to remember.' : 'This is the beginning of your private conversation.') : active?.description || 'This is the beginning of something good.'}</p><div className='intro-meta'><span><LockKeyhole size={13}/>{active?.kind === 'private' ? label("Private Guild") : active?.kind === 'dm' ? 'Private conversation' : active?.private ? 'Invite-only room' : 'Room members'}</span><span>·</span><button onClick={() => setDetail(true)}>View details <ArrowRight size={13}/></button></div></div>}
     {unreadStart&&view==='channel'&&tab==='messages'&&messages.some(message=>message.id===unreadStart)&&<button className='unread-jump' onClick={()=>{nearBottom.current=false;setFocusMessage({id:unreadStart,request:Date.now()});}}>Jump to first unread message</button>}{hasMore && view === 'channel' && tab === 'messages' && <button className='load-older' disabled={busy} onClick={loadOlder}>Load earlier messages</button>}
     {view === 'channel' && tab === 'messages' && messages.length === 0 && <><div className='date-divider'><span>Today</span></div><article className='welcome-message'><div className='guide-avatar'><Beer size={21}/></div><div><div className='message-meta'><strong>Tavern</strong><span className='guide-label'>GUIDE</span><span className='edited'>Getting started</span></div><p>Your conversations. Your rules.</p><p className='muted-copy'>{label("Your conversations, on your own server. Connect your local Matrix account, create a Guild, and bring your people together.")}</p><div className='getting-started'><button onClick={() => setModal(!active && !data?.preview ? 'create' : 'invite')}><span className='onboarding-icon'><Users size={20}/></span><strong>{!active && !data?.preview ? label("Create your first Guild") : 'Bring your people'}</strong><span>Good company. Great conversations.</span><small>{!active && !data?.preview ? label("Create a Guild") : 'Invite members'} <ArrowRight size={14}/></small></button><button onClick={() => openSettings()}><span className='onboarding-icon violet'><Paintbrush size={20}/></span><strong>Make yourself at home</strong><span>Your colors. Your kind of quiet.</span><small>Personalize Tavern <ArrowRight size={14}/></small></button></div><div className='guide-tip'><Sparkles size={15}/><span>A little tip: use <kbd>Ctrl K</kbd> to switch conversations, or save one to come back to later.</span></div></div></article></>}
     <MessageList key={channel+':'+tab+':'+view} items={visibleMessages} focusId={focusMessage} scroll={scroll} render={(m,i)=><div>{view==='channel'&&(i===0||new Date(m.created_at).toDateString()!==new Date(visibleMessages[i-1]?.created_at).toDateString())&&<div className='date-divider'><span>{new Date(m.created_at).toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})}</span></div>}{m.id===unreadStart&&view==='channel'&&tab==='messages'&&<div className='unread-divider' role='separator' aria-label='New messages'><span>New messages</span></div>}{messageCard(m)}</div>}/>
     {((view !== 'channel' && messages.length === 0) || (view === 'channel' && tab !== 'messages' && (tab === 'pins' ? messages.filter(m => m.pinned).length === 0 : messages.length === 0))) && <div className='empty-state'><span>{tab === 'pins' ? <Pin size={28}/> : tab === 'files' ? <File size={28}/> : view === 'saved' ? <Bookmark size={28}/> : view === 'mentions' ? <AtSign size={28}/> : <MessageSquare size={28}/>}</span><h2>{tab === 'pins' ? 'Keep the essentials close' : tab === 'files' ? 'All your shared files, together' : view === 'saved' ? 'A place for the keepers' : view === 'mentions' ? 'You’re all caught up' : 'Room for a deeper conversation'}</h2><p>{tab === 'pins' ? 'Pin a message from its menu and it will appear here.' : tab === 'files' ? 'Attach a file to a message to share it with this conversation.' : view === 'saved' ? 'Save a message with the bookmark button. Only you can see your saved list.' : view === 'mentions' ? 'Messages that mention your display name or @everyone will appear here.' : 'Reply to a message in a thread to keep a topic together.'}</p></div>}
    </>}<div ref={bottom}/>
   </div>}
   {view === 'channel' && tab === 'messages' && <div className='typing-indicator' aria-live='polite'>{!prefs.focus && matrixTyping(channel).length > 0 ? matrixTyping(channel).slice(0, 3).join(', ') + (matrixTyping(channel).length === 1 ? ' is typing…' : ' are typing…') : ''}</div>}
   {view === 'channel' && tab === 'messages' && !voiceMode && !forumMode && <Composer onEditLatest={()=>{const last=messages.filter(m=>m.author_id===me?.id).at(-1);if(last){setEditing(last);setEditBody(last.body);}}} serverId={currentServer?.id} shareTyping={prefs.typing&&!prefs.focus} key={(me?.id||'preview')+':'+channel} conversation={channel} name={name} members={data?.members || []} disabled={!data || !!data.preview || !getMatrixClient()?.getRoom(channel)} onSent={async () => { nearBottom.current = true; await loadMessages(true); }}/>}
   {view === 'channel' && tab === 'messages' && !voiceMode && <div className='composer-footnote'><span><LockKeyhole size={11}/> {data?.preview ? 'Connect your homeserver to send messages' : active?.encrypted ? 'Encrypted on this device before sending' : 'This room is not encrypted'}</span><span><strong>Enter</strong> to send · <strong>Shift + Enter</strong> for a new line</span></div>}
  </section>
  {view === 'channel' && !prefs.focus && <aside className='channel-overview'><div className='overview-title'><span>{label("IN THIS GUILD")}</span><IconButton label={label("Guild information")} onClick={() => setDetail(true)}><Info size={15}/></IconButton></div><div className='overview-about'><span className='small-hash'>{active?.kind === 'dm' ? <MessageCircle size={23}/> : <Hash size={25}/>}</span><h3>{name}</h3><p>{active?.description || 'A private place to share what matters.'}</p><span className='channel-type'><LockKeyhole size={12}/>{data?.preview ? 'Interface preview' : active?.encrypted ? 'Encrypted Matrix room' : 'Unencrypted Matrix room'}</span></div><div className='overview-section'><div className='overview-section-title'><h3>Members <span>{channelMembers.length}</span></h3><button onClick={() => setModal('members')}>View all</button></div>{channelMembers.slice(0, 5).map(m => <ActionMenu key={m.id} actions={userActions(m.id)}><QuickProfile roomId={channel} userId={m.id} serverId={currentServer?.id} onOpenFull={()=>openProfile(m.id)} onMessage={()=>void startDm(m.id)}><button className='member-row'><CommunityAvatar roomId={channel} serverId={currentServer?.id} userId={m.id} fallback={m.name} size={32}/><span><strong>{m.name}{m.id === me?.id && <small> (you)</small>}</strong><small>{m.id}</small></span></button></QuickProfile></ActionMenu>)}{canInviteToRoom(channel)&&<button className='invite-members-link' onClick={() => setModal('invite')}><Plus size={15}/> Invite people</button>}</div><div className='overview-section quick-links'><h3>{label("Guild essentials")}</h3><button onClick={() => setTab('files')}><Paperclip size={16}/> Shared files <ChevronRight size={14}/></button><button onClick={() => setTab('pins')}><Pin size={16}/> Pinned messages <ChevronRight size={14}/></button><button onClick={() => { setSearch(''); setModal('search'); }}><Search size={16}/> Search conversations <ChevronRight size={14}/></button></div><div className='privacy-note'><ShieldCheck size={22}/><h4>A little more peace of mind.</h4><p>No ads or tracking scripts in Tavern. Your homeserver, your conversations, your people.</p><button onClick={() => openSettings('privacy')}>Your privacy, explained <ArrowRight size={13}/></button></div><div className='tavern-signature'><Beer size={14}/><span>Made for conversation.</span></div></aside>}
  </div>
 </main>
 {currentServer&&<ServerWelcomeFlow key={currentServer.id} serverId={currentServer.id} forceOpen={modal==='serverWelcome'} autoOpen={!modal&&getMatrixClient()?.getAccountData('io.tavern.onboarding' as any)?.getContent()?.completed===true} onClosed={()=>{if(modal==='serverWelcome')setModal('');}} onSelect={id=>{void loadBootstrap().then(()=>select(id));}}/>}
 {data&&!data.preview&&getMatrixClient()&&<WelcomeTour key={data.me.id} invitations={data.invitations?.length||0} onCreateServer={()=>setModal('server')} onInvitations={()=>setModal('roomInvites')} onChanged={loadBootstrap}/>}
 {forwarding&&<ForwardMessage message={forwarding} onClose={()=>setForwarding(null)}/>}
 {reminder&&<ReminderDialog {...reminder} onClose={()=>setReminder(null)}/>}
 <KeyboardShortcuts currentRoomId={privateRoom||channel} userId={me?.id} enterToSend={textMedia.enterToSend} conversations={(data?.conversations||[]).map(c=>({id:c.id,unread:c.unread||Number(navigationPreferences().unread.includes(c.id)),muted:prefs.muted.includes(c.id)}))} onSelectRoom={select} onMarkAllRead={readAction.available&&!data?.preview?()=>void readAction.run():undefined}/><CommandPalette onMessage={startDm} onSelectRoom={select} onSelectServer={chooseServer} onSettings={openSettings} onSearch={query=>{setSearch(query||'');setModal('search');}} onCreate={!data?.preview&&(!currentServer||canEditCommunity(currentServer.id,'layout'))?()=>setModal('create'):undefined} onContacts={()=>openSettings('social')}/>
 <ServerDialog open={modal === 'server'} naming={prefs.naming} onClose={() => setModal('')} onCreated={async (id) => { await loadBootstrap(); setSelectedServer(id); setGuild(''); setView('channel'); }}/>
 <Dialog open={['create', 'dm', 'invite', 'members', 'settings', 'search', 'connect', 'roomInvites', 'inviteServer'].includes(modal)} onOpenChange={v => { if (!v && !connecting)
        setModal(''); }}><DialogContent className={'tavern-dialog ' + (modal === 'settings' ? 'settings-dialog' : modal === 'search' ? 'search-dialog' : '')}>
  <DialogHeader><DialogTitle>{({ inviteServer:'Invite to '+terms.server, connect: 'Connect your Matrix homeserver', roomInvites: 'You’re invited', create: 'A new place to talk', dm: 'Start a conversation', invite: 'Bring your people to Tavern', members: 'Your people', settings: 'Make Tavern yours', search: 'Find the conversation' } as any)[modal]}</DialogTitle><DialogDescription>{({ inviteServer:'Invite an existing local account. Conversation access is managed separately.', connect: 'Your conversations stay on your server. Your keys stay with you.', roomInvites: 'Choose which conversations to join.', create: label("Give your Guild a name and a purpose."), dm: 'Choose a Tavern member, or start a note to yourself.', invite: 'Invite an existing Matrix account to this conversation.', members: 'The people who make this space yours.', settings: label("Your Tavern, set up the way you like it."), search: 'Search decrypted messages in your private local index.' } as any)[modal]}</DialogDescription></DialogHeader>
  {modal === 'connect' && <form className='dialog-form' onSubmit={async (e) => { e.preventDefault(); setConnecting(true); setLoginError(''); try {
        await connectMatrix(server, loginUser, password, setLoginStatus);
        setPassword('');
        await loadBootstrap();
        setModal('');
        toast.success('Connected to your Matrix homeserver');
    }
    catch (e) {
        setLoginError((e as Error).message);
    }
    finally {
        setConnecting(false);
        setLoginStatus('');
    } }}><div className='login-logo'><span className='about-logo'><Beer size={26}/></span><strong>tavern</strong><span className='matrix-wordmark'>[matrix]</span></div><label>Homeserver address<input type='url' value={server} placeholder='https://chat.example.com' onChange={e => setServer(e.target.value)} required readOnly={lockedServer} disabled={connecting} autoComplete='url'/></label><label>Matrix username<input value={loginUser} placeholder='@hans:chat.example.com' onChange={e => setLoginUser(e.target.value)} required disabled={connecting} autoComplete='username'/></label><label>Password<input type='password' value={password} onChange={e => setPassword(e.target.value)} required disabled={connecting} autoComplete='current-password'/></label>{loginStatus && <div className='connect-status'><Loader2 size={17} className='spin'/>{loginStatus}</div>}{loginError && <p className='connect-error' role='alert'>{loginError}</p>}<button className='primary-button' disabled={connecting}>{connecting ? <Loader2 size={17} className='spin'/> : <LockKeyhole size={17}/>}Enter the Tavern</button><p className='login-help'>{label("Credentials go directly to the homeserver you enter. This first release supports password-enabled Matrix accounts. Use an account created by your Tavern administrator. The included Synapse setup keeps accounts on your own instance.")}</p></form>}
  {modal === 'roomInvites' && <div className='dialog-member-list'>{data?.invitations?.map(r => <div className='room-invite' key={r.id}><Hash size={20}/><strong>{r.name}</strong><button className='primary-button' onClick={() => isPrivateDiscussion(getMatrixClient()?.getRoom(r.id))?openPrivateDiscussion(r.id):isDmRequest(getMatrixClient()?.getRoom(r.id))?setModal('dmRequests'):api('join', { id: r.id }).then(() => loadBootstrap()).then(() => { if(getMatrixClient()?.getRoom(r.id)?.isSpaceRoom()){setSelectedServer(r.id);setGuild('');setView('channel')}else select(r.id); setModal(''); }).catch(e => toast.error(e.message))}>{isPrivateDiscussion(getMatrixClient()?.getRoom(r.id))?'View private invitation':isDmRequest(getMatrixClient()?.getRoom(r.id))?'Review message request':'Join'}</button>{!isDmRequest(getMatrixClient()?.getRoom(r.id))&&<button className='icon-button' aria-label='Decline invitation' onClick={() => api('decline', { id: r.id }).then(() => loadBootstrap()).catch(e => toast.error(e.message))}><X size={16}/></button>}</div>)}</div>}
  {modal === 'create' && !data?.preview && <ChannelCreationForm serverId={currentServer?.id} members={data?.members || []} policyEnabled={rolePolicyEnabled} callsEnabled={callsEnabled} onCreated={async id => { await loadBootstrap(); select(id); setModal(''); }}/>}
  {modal === 'dm' && <div className='dialog-member-list'><GroupMessage members={data?.members.filter(m=>m.id!==me?.id)||[]} onCreated={async id=>{await loadBootstrap();select(id);setModal('');}}/>{data?.members.map(m => <button key={m.id} disabled={busy} onClick={() => startDm(m.id)}><Avatar name={m.name}/><span><strong>{m.id === me?.id ? 'Notes to self' : m.name}</strong><small>{m.id === me?.id ? 'Just for you' : 'Send a private message'}</small></span><ArrowRight size={17}/></button>)}</div>}
  {(modal === 'invite'||modal==='inviteServer') && <form className='dialog-form' onSubmit={async (e) => { e.preventDefault(); setBusy(true); try {
        await api('invite', { email, conversation: modal==='inviteServer'?currentServer?.id:channel });
        setInvited(s => [...s, email]);
        setEmail('');
        toast.success('Matrix invitation sent.');
    }
    catch (e) {
        toast.error((e as Error).message);
    }
    finally {
        setBusy(false);
    } }}><label>Matrix ID<input type='text' value={email} onChange={e => setEmail(e.target.value)} placeholder='@alex:chat.example.com' required disabled={!!data?.preview}/></label><div className='notice'><LockKeyhole size={19}/><p>{data?.preview ? 'Connect your Matrix homeserver first. You can then invite an existing Matrix account to a room.' : `This sends a Matrix invitation to ${modal==='inviteServer'?currentServer?.name:name}. The homeserver enforces your permission to invite. On a private server, ask the administrator to create accounts first.`}</p></div>{invited.map(e => <div className='invited-person' key={e}><CheckCircle2 size={17}/>{e}<span>Invited</span></div>)}<button className='primary-button' disabled={busy || !!data?.preview || (modal==='inviteServer'?!currentServer:!active)}><Users size={16}/>Send room invitation</button><button className='secondary-button' type='button' onClick={() => navigator.clipboard.writeText(!data?.preview&&(modal==='inviteServer'?currentServer:active)?location.origin+location.pathname+(modal==='inviteServer'?'#server=':'#room=')+encodeURIComponent(modal==='inviteServer'?currentServer!.id:active!.id):location.origin).then(() => toast.success('Room link copied')).catch(() => toast.error('Could not copy. Copy the address from your browser.'))}><Link2 size={16}/>Copy room link</button></form>}
  {modal === 'members' && <MemberDirectory roomId={channel} serverId={currentServer?.id} onProfile={id=>{setModal('');openProfile(id);}} userActions={id=>userActions(id)} onMessage={id=>void startDm(id)} onInvite={()=>setModal('invite')}/>}
  {modal === 'search' && <MessageSearch initialQuery={search} roomId={channel} onSelectRoom={id=>{select(id);setModal('');}} onSelectServer={id=>{chooseServer(id);setModal('');}} onSelectPerson={(id,room)=>{setModal('');openProfile(id,room);}} onSelect={m=>openMessage(m.conversation_id,m.id)}/>}
  {modal === 'settings' && <Tabs value={settingsTab} onValueChange={setSettingsTab} className='settings-tabs'><TabsList><TabsTrigger value='appearance'>Appearance</TabsTrigger><TabsTrigger value='profile'>Profile</TabsTrigger>{isManagedAccount()&&<TabsTrigger value='social'>Friends & privacy</TabsTrigger>}{isManagedAccount()&&<TabsTrigger value='account'>Account & security</TabsTrigger>}<TabsTrigger value='notifications'>Notifications</TabsTrigger><TabsTrigger value='text-media'>Text & media</TabsTrigger><TabsTrigger value='outbox'>Outbox & reminders</TabsTrigger><TabsTrigger value='privacy'>Privacy</TabsTrigger><TabsTrigger value='workspace'>Tavern</TabsTrigger><TabsTrigger value='about'>About</TabsTrigger></TabsList><TabsContent value='appearance'><div className='settings-section'><div className='setting-row'><span><strong>Legacy naming</strong><small>Use Taverns and Guilds. The default is servers and channels.</small></span><Switch aria-label='Use legacy naming' checked={prefs.naming === 'legacy'} onCheckedChange={legacy => updatePrefs({ naming: legacy ? 'legacy' : 'standard' })}/></div><AppearanceSettings/><div className='setting-row'><span><strong>Focus mode</strong><small>Hide unread counts, typing activity, and the details panel.</small></span><Switch aria-label='Focus mode' checked={prefs.focus} onCheckedChange={focus=>updatePrefs({focus})}/></div><h3>Your accent</h3><div className='accent-options'>{['gold', 'blue', 'violet'].map(a => <button key={a} onClick={() => updatePrefs({ accent: a })} className={a + ' ' + (prefs.accent === a ? 'chosen' : '')}><span>{prefs.accent === a && <Check size={14}/>}</span>{a === 'gold' ? 'Tavern gold' : a === 'blue' ? 'Slate blue' : 'Dusk violet'}</button>)}</div><div className='setting-row'><span><strong>Compact messages</strong><small>A little less space between conversations.</small></span><Switch checked={prefs.compact} onCheckedChange={compact => updatePrefs({ compact })} aria-label='Compact messages'/></div></div></TabsContent>{isManagedAccount()&&<TabsContent value='social'><SocialPanel onMessage={id=>{void startDm(id);}}/></TabsContent>}<TabsContent value='profile'><PresenceSettings/><ProfileSettings onChanged={loadBootstrap}><button type='button' className='signout-link' onClick={() => disconnectMatrix().then(() => { messageDrafts.refresh();navigationGeneration.current++;setPrivateRoom('');setPrivateFocus(null);generation.current++;searchGeneration.current++;setThread(null);setMessages([]);setReplyState(null);setGuild('general');setSelectedServer('all');setView('channel');setTab('messages');setSearch('');setResults([]);setKeyPassword('');setPassword('');setEmail('');setInvited([]);setEditing(null);setDeleting(null);setDetail(false);setError('');return loadBootstrap(); }).then(() => { setModal('connect'); toast.success('Signed out of Matrix'); }).catch(e => toast.error(e.message))}><LogOut size={15}/>Sign out of Matrix</button></ProfileSettings>{currentServer&&<ProfileSettings key={currentServer.id} serverId={currentServer.id} onChanged={loadBootstrap}/>}</TabsContent>{isManagedAccount()&&<TabsContent value='account'><AccountSettings/><MyWarnings/></TabsContent>}<TabsContent value='notifications'><NotificationSettings/></TabsContent><TabsContent value='text-media'><TextMediaSettings/></TabsContent><TabsContent value='outbox'><OutboxPanel onOpen={openMessage}/></TabsContent><TabsContent value='privacy'><div className='settings-section'><div className='privacy-summary'><ShieldCheck size={29}/><div><h3>Private by design. Clear by default.</h3><p>You should know exactly where your conversations stand.</p></div></div><div className='privacy-fact'><CheckCircle2 /><span><strong>Access is checked on every request</strong><p>{label("Private Guilds and DMs are limited to their members. Your Matrix homeserver enforces membership, permissions, and account access.")}</p></span></div><div className='privacy-fact'><CheckCircle2 /><span><strong>No advertising or tracking scripts</strong><p>Tavern does not load advertising, tracking scripts, or third-party embeds. A link preview contacts its website only when you choose Preview.</p></span></div><div className='privacy-fact'><Info /><span><strong>Encryption is shown for every room</strong><p>New rooms use Matrix end-to-end encryption, including files. Existing unencrypted rooms are labeled. Membership, timing, room names, and some other metadata remain visible to your homeserver.</p></span></div><div className='privacy-fact'><Info /><span><strong>You control your messages</strong><p>Edit or redact your messages, and export loaded history. Redaction does not delete others’ copies or existing backups. Bookmarks and preferences are stored as account data visible to your homeserver.</p></span></div><button className='secondary-button' onClick={() => exportMatrixMessages().catch(e => toast.error(e.message))}><Download size={16}/>Export my loaded messages</button><div className='setting-row'><span><strong>Share typing activity</strong><small>Let conversation members see when you are typing. Off by default.</small></span><Switch aria-label='Share typing activity' checked={prefs.typing} onCheckedChange={typing => updatePrefs({ typing })}/></div>{!data?.preview && <SecurityCenter />}<DeviceManager /><MessageExport/><div className='key-management'><h3>Encryption keys</h3><p>Use an encrypted file as an additional offline backup, or import an export from Tavern or Element. Automatic recovery uses the encrypted backup configured above.</p><label>Key export passphrase<input type='password' value={keyPassword} onChange={e => setKeyPassword(e.target.value)} placeholder='At least 12 characters for export'/></label><div><button className='secondary-button' onClick={() => exportEncryptionKeys(keyPassword).then(() => toast.success('Encrypted key export downloaded')).catch(e => toast.error(e.message))}><Download size={15}/>Export keys</button><button className='secondary-button' onClick={() => keyInput.current?.click()}>Import keys</button><input type='file' className='sr-only' ref={keyInput} onChange={e => { const f = e.target.files?.[0]; if (f)
        importEncryptionKeys(f, keyPassword).then(() => { toast.success('Keys imported'); setKeyPassword(''); }).catch(e => toast.error(e.message)); e.target.value = ''; }}/></div></div><div className='matrix-session'>Session: {matrixStatus().userId || 'Not connected'}<br />Device: {matrixStatus().deviceId || '—'}<br />{isManagedAccount()?'Sign-in uses a secure HttpOnly session cookie.':'This legacy session uses tab session storage.'} Encryption keys stay in this browser. Sign out revokes the session.</div></div></TabsContent><TabsContent value='workspace'><form className='dialog-form' onSubmit={async (e) => { e.preventDefault(); try {
        await api('workspace', { name: workspaceName });
        await loadBootstrap();
        toast.success('Workspace updated');
    }
    catch (e) {
        toast.error((e as Error).message);
    } }}><label>Workspace label<input value={workspaceName} onChange={e => setWorkspaceName(e.target.value)} maxLength={60} disabled={!!data?.preview} required/></label><div className='notice'><LockKeyhole size={19}/><p>This label is your personal name for this homeserver. Each Matrix room has its own membership and permissions. New Tavern rooms are encrypted and invite-only.</p></div><button className='primary-button' disabled={!!data?.preview}>Save Tavern label</button><button type='button' className='secondary-button' onClick={() => setModal('invite')}><Users size={16}/>Invite members</button></form></TabsContent><TabsContent value='about'><div className='settings-section about-tavern'><span className='about-logo'><Beer size={36}/></span><h2>Tavern <span>0.4.0</span></h2><InstallTavern/><button className='secondary-button' onClick={()=>{setModal('');setTimeout(openWelcomeTour,0);}}>Getting started tour</button><p>A home for your conversations.</p><div className='release-note'><strong>Working in this release</strong><p>Encrypted messaging, servers and channels, threads, files, verified identities, recovery, calls, conferences, tasks, notes, polls, notifications, and self-hosted webhooks.</p></div><div className='release-note'><strong>Your instance</strong><p>Manage your password, verified email, two-step verification, contacts, and profiles from Settings. Administrators manage users, reports, email, backups, and releases from Admin.</p></div><small>Powered by the Matrix protocol and matrix-js-sdk. Live sync comes directly from your homeserver. Search indexes decrypted history privately on this device. Calls require the configured media services. See the release notes and validation guide for deployment checks.</small></div></TabsContent></Tabs>}
 </DialogContent></Dialog>
 {isManagedAccount()&&<RedeemInvite onJoined={roomId=>{void loadBootstrap().then(()=>select(roomId));}}/>}<ReportDialog target={reportTarget} onClose={()=>setReportTarget(null)}/>
 {media&&<MediaViewer items={media.items} index={media.index} isCurrent={media.isCurrent} onChange={index=>setMedia({...media,index})} onClose={()=>setMedia(null)}/>}
 <ActivityNotifications onOpenContacts={()=>openSettings('social')}/>
 <MemberRolesDialog onChanged={loadBootstrap}/>
 <ServerNicknameDialog onChanged={loadBootstrap}/>
 <Dialog open={modal==='serverIntegrations'} onOpenChange={open=>{if(!open)setModal('');}}><DialogContent className='tavern-dialog settings-dialog'><DialogHeader><DialogTitle>Server integrations</DialogTitle><DialogDescription>Incoming webhooks for channels you are authorized to manage.</DialogDescription></DialogHeader>{currentServer&&<RoomIntegrations key={currentServer.id} roomId={currentServer.id} inline/>}</DialogContent></Dialog>
 <Dialog open={modal==='serverReports'} onOpenChange={open=>{if(!open)setModal('');}}><DialogContent className='tavern-dialog settings-dialog'><DialogHeader><DialogTitle>Server report review</DialogTitle><DialogDescription>Reports explicitly shared with this community?s authorized moderators.</DialogDescription></DialogHeader>{currentServer&&<RoomReportReview key={currentServer.id} roomId={currentServer.id}/>}</DialogContent></Dialog>
 <Dialog open={modal==='serverAudit'} onOpenChange={open=>{if(!open)setModal('');}}><DialogContent className='tavern-dialog settings-dialog'><DialogHeader><DialogTitle>Server audit</DialogTitle><DialogDescription>Membership, moderation, and settings history for this server.</DialogDescription></DialogHeader>{currentServer&&<ServerAudit key={currentServer.id} serverId={currentServer.id}/>}</DialogContent></Dialog>
 <Dialog open={modal==='serverWarnings'} onOpenChange={open=>{if(!open)setModal('');}}><DialogContent className='tavern-dialog settings-dialog'><DialogHeader><DialogTitle>Server member warnings</DialogTitle><DialogDescription>Private warnings issued in this server.</DialogDescription></DialogHeader>{currentServer&&<ServerWarnings key={currentServer.id} roomId={currentServer.id}/>}</DialogContent></Dialog>
 <Dialog open={modal==='serverSettings'} onOpenChange={open=>{if(!open)setModal('');}}><DialogContent className='tavern-dialog settings-dialog'><DialogHeader><DialogTitle>Server settings</DialogTitle><DialogDescription>Appearance, welcome screen, and channel organization.</DialogDescription></DialogHeader>{currentServer&&<><ServerCustomization key={currentServer.id} serverId={currentServer.id} onChanged={loadBootstrap}/><ServerOnboardingSettings key={currentServer.id+':onboarding'} serverId={currentServer.id}/><ServerRoles serverId={currentServer.id} enabled={rolePolicyEnabled} onChanged={loadBootstrap}/><ServerEmojiManager serverId={currentServer.id}/><NotificationSettings serverId={currentServer.id}/>{isManagedAccount()&&<InviteManager roomId={currentServer.id}/>}</>}</DialogContent></Dialog>
 <Dialog open={!!profileUser} onOpenChange={open=>{if(!open)setProfileUser('');}}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>User profile</DialogTitle><DialogDescription>Profile shared with this conversation.</DialogDescription></DialogHeader>{profileUser&&<><ModerationActions roomId={profileRoom||channel} userId={profileUser} enabled={rolePolicyEnabled} onChanged={loadBootstrap}/><TemporaryBans key={(profileRoom||channel)+':ban:'+profileUser} roomId={profileRoom||channel} userId={profileUser}/><ServerWarnings key={(profileRoom||channel)+':'+profileUser} roomId={profileRoom||channel} userId={profileUser}/><UserProfileCard roomId={profileRoom||channel} serverId={profileServer?.id} userId={profileUser} actions={<><button className='secondary-button' onClick={()=>{void startDm(profileUser);setProfileUser('');}}>Message</button><button className='secondary-button' onClick={()=>copyText(profileUser)}>Copy ID</button>{userActions(profileUser,profileRoom||channel).filter(a=>a.visible!==false&&!['Message','Copy user ID','View profile','Moderate member'].includes(a.label)).map(a=><button className='secondary-button' key={a.label} onClick={()=>Promise.resolve(a.run()).catch(e=>toast.error(e.message))}>{a.label}</button>)}</>}/></>}</DialogContent></Dialog>
 <AlertDialog open={!!confirmAction} onOpenChange={open=>{if(!open&&!confirmBusy)setConfirmAction(null);}}><AlertDialogContent className='tavern-dialog'><AlertDialogHeader><AlertDialogTitle>{confirmAction?.title}</AlertDialogTitle><AlertDialogDescription>{confirmAction?.description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={confirmBusy}>Cancel</AlertDialogCancel><button className='primary-button delete-confirm' disabled={confirmBusy} onClick={async()=>{setConfirmBusy(true);try{await confirmAction?.run();setConfirmAction(null);}catch(e:any){toast.error(e.message);}finally{setConfirmBusy(false);}}}>Confirm</button></AlertDialogFooter></AlertDialogContent></AlertDialog>
 <Dialog open={modal==='dmRequests'} onOpenChange={open=>{if(!open)setModal('');}}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>Message requests</DialogTitle><DialogDescription>Choose whether to accept, decline or block an incoming conversation invitation.</DialogDescription></DialogHeader><DmRequests onOpen={async roomId=>{const owner=getMatrixClient(),account=accountArtworkOwner();await loadBootstrap();if(getMatrixClient()===owner&&accountArtworkOwner()===account){select(roomId);setModal('');}}}/></DialogContent></Dialog>
 <Dialog open={modal==='privateDiscussions'} onOpenChange={open=>{if(!open)setModal('');}}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>Your private discussions</DialogTitle><DialogDescription>Only rooms you joined or were invited to appear here.</DialogDescription></DialogHeader><PrivateDiscussionList onOpen={openPrivateDiscussion}/></DialogContent></Dialog>
 <Sheet open={!!historyTarget} onOpenChange={open=>{if(!open)closeMessageHistory(historyTarget);}}><SheetContent className='thread-sheet message-history-sheet'><SheetHeader><SheetTitle>Message context</SheetTitle><SheetDescription>Read surrounding messages in this conversation.</SheetDescription></SheetHeader>{historyTarget&&<MessageHistoryPanel key={historyTarget.roomId+':'+historyTarget.eventId+':'+historyTarget.request} roomId={historyTarget.roomId} eventId={historyTarget.eventId} isCurrent={()=>currentHistorySelection(historyTarget)} onClose={()=>closeMessageHistory(historyTarget)} onLatest={()=>{if(currentHistorySelection(historyTarget)){nearBottom.current=true;select(historyTarget.roomId);void loadMessages(true);}}} renderMessage={(message,items,current)=>messageCard(message,true,{messages:items,current})}/>}</SheetContent></Sheet>
 <Sheet open={!!privateRoom} onOpenChange={open=>{if(!open)closePrivateDiscussion();}}><SheetContent className='thread-sheet private-discussion-sheet'><SheetHeader><SheetTitle>Private discussion</SheetTitle><SheetDescription>A separate encrypted conversation for its invited members.</SheetDescription></SheetHeader>{privateRoom&&<PrivateThreadPanel key={(me?.id||'')+':'+privateRoom} roomId={privateRoom} focusId={privateFocus} onClose={closePrivateDiscussion} onOpenSource={openMessage} onMember={openProfile} renderMessage={message=>messageCard(message,true)} renderComposer={(onSent,disabled)=>{const room=getMatrixClient()?.getRoom(privateRoom),binding=privateThreadBinding(room),server=data?.servers?.find(s=>s.roomIds.includes(binding?.source_room_id||''));return <Composer key={(me?.id||'')+':private:'+privateRoom} conversation={privateRoom} name={readPrivateThreadSettings(room).title} serverId={server?.id} shareTyping={prefs.typing&&!prefs.focus} disabled={disabled} members={(room?.getJoinedMembers()||[]).map(member=>({id:member.userId,name:member.name,role:'member'}))} onSent={onSent}/>;}}/>}</SheetContent></Sheet>
 <Sheet open={!!thread&&!privateRoom} onOpenChange={v => { if (!v)
        setThread(null); }}><SheetContent className='thread-sheet'><SheetHeader><SheetTitle>{thread ? readThreadPolicy(thread.conversation_id,thread.id).title || thread.forum?.title || 'Thread' : 'Thread'} <span>#{thread?.conversation_name}</span>{thread&&<DraftIndicator roomId={thread.conversation_id} parent={thread.id} label={'Draft reply in '+thread.conversation_name}/>}</SheetTitle><SheetDescription>Keep this conversation together.</SheetDescription></SheetHeader> {thread&&<ThreadSettings key={thread.id} roomId={thread.conversation_id} rootId={thread.id} authorId={thread.author_id} enabled={rolePolicyEnabled} onChanged={loadBootstrap}/>}{thread&&<ThreadTools roomId={thread.conversation_id} rootId={thread.id} authorId={thread.author_id} replies={replies} onChanged={refreshThreadReplies}/>}<div className='thread-scroll' ref={threadScroll}>{thread&&<PrivateThreadLauncher key={thread.conversation_id+':'+thread.id} sourceRoomId={thread.conversation_id} sourceEventId={thread.id} onOpen={openPrivateDiscussion}/>}{thread && messageCard(thread, true)}<div className='date-divider'><span>{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span></div><MessageList key={thread?.id} items={replies} scroll={threadScroll} render={message=>messageCard(message,true)}/>{!replies.length && <p className='thread-empty'>Be the first to reply.</p>}</div>{thread && <Composer serverId={currentServer?.id} shareTyping={prefs.typing&&!prefs.focus} onEditLatest={()=>{const last=replies.filter(m=>m.author_id===me?.id).at(-1);if(last){setEditing(last);setEditBody(last.body);}}} key={(me?.id||'preview')+':'+thread.id} conversation={thread.conversation_id} parent={thread.id} name='this thread' members={data?.members || []} onSent={async () => { await refreshThreadReplies(); if(currentThreadView())await loadMessages(true); }}/>}</SheetContent></Sheet>
 <Sheet open={detail&&!privateRoom&&!thread} onOpenChange={setDetail}><SheetContent className='detail-sheet'><SheetHeader><SheetTitle>{active?.kind === 'private' ? <LockKeyhole /> : <Hash />}{name}</SheetTitle><SheetDescription>About this conversation</SheetDescription></SheetHeader><div className='detail-content'><h3>Description</h3><p>{active?.description || 'A private conversation for the people here.'}</p><h3>Who can see this?</h3><div className='notice'><LockKeyhole size={20}/><p>{active?.kind === 'channel' ? 'The Matrix room’s membership and power levels determine who can read and post here.' : 'Only the members in this conversation can read and post here.'}</p></div><div className='setting-row'><span><strong>Mute this conversation</strong><small>Hide unread badges in the sidebar.</small></span><Switch aria-label='Mute conversation' checked={muted} onCheckedChange={() => updatePrefs({ muted: muted ? prefs.muted.filter(c => c !== channel) : [...prefs.muted, channel] })}/></div><PrivateThreadLauncher key={channel+':private'} sourceRoomId={channel} onOpen={openPrivateDiscussion}/>{isManagedAccount()&&<InviteManager key={channel+':invites'} roomId={channel}/>}<ChannelAppearanceSettings key={channel+':appearance'} roomId={channel} onChanged={loadBootstrap}/><RoomIntegrations key={channel+':integrations'} roomId={channel}/><RoomReportReview key={channel+':reports'} roomId={channel}/><TemporaryBans key={channel+':bans'} roomId={channel}/><ServerWarnings key={channel+':warnings'} roomId={channel}/><BulkModeration roomId={channel} messages={messages.filter(m=>m.conversation_id===channel)} onChanged={()=>loadMessages(true)}/><ChannelPolicySettings roomId={channel} enabled={rolePolicyEnabled} onChanged={loadBootstrap}/><ModerationActions roomId={channel} enabled={rolePolicyEnabled} onChanged={loadBootstrap}/><EnableThreadSettings roomId={channel} enabled={rolePolicyEnabled}/><RoomPermissions key={channel+':permissions'} roomId={channel}/><ChannelAdmin key={channel} roomId={channel} onChanged={loadBootstrap}/><h3>Members</h3>{channelMembers.map(m => <div className='member-row' key={m.id}><Avatar name={m.name} size='small'/><span><strong>{m.name}</strong><small>{m.role}</small></span></div>)}</div></SheetContent></Sheet>
 <AlertDialog open={!!deleting} onOpenChange={v => { if (!v)
        setDeleting(null); }}><AlertDialogContent className='tavern-dialog'><AlertDialogHeader><AlertDialogTitle>Delete this message?</AlertDialogTitle><AlertDialogDescription>This requests a Matrix redaction. Thread replies remain, and recipients or backups may retain copies. Redaction cannot be undone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep message</AlertDialogCancel><AlertDialogAction className='delete-confirm' onClick={() => act('delete', { id: deleting?.id }).then(() => { if (thread?.id === deleting?.id)
        setThread(null); setDeleting(null); }).catch(() => { })}>Delete message</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
 </>;
}
function Composer({ conversation, parent, name, members, serverId, onSent, onEditLatest, disabled = false, shareTyping = false }: {
    conversation: string;
    serverId?: string;
    parent?: string;
    name: string;
    members: Member[];
    onSent: () => Promise<any>;
    onEditLatest?:()=>void;
    disabled?: boolean;
    shareTyping?: boolean;
}) {
    const textMedia=useTextMedia();
    const { owner: draftOwner, value: draftValue } = useMessageDraft(conversation, parent), draft = draftValue.text;
    const draftView = useRef(0);
    useEffect(() => { const view = ++draftView.current; setSending(false); setSendFailed(false); setParked([]); setFiles([]);setFailedUploads([]);setUploading(false);setUploadProgress(null);nonce.current = null; return () => { if (draftView.current === view) draftView.current++;uploadAbort.current?.abort();pendingIds.current.forEach(discardMatrixFile);pendingIds.current=[]; }; }, [conversation, parent, draftOwner]);
    const lastTyping = useRef(0), typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => { clearTimeout(typingTimer.current); if (shareTyping)
        sendMatrixTyping(conversation, false).catch(() => { }); }, [conversation, shareTyping]);
    const [sendFailed,setSendFailed]=useState(false);
    const [parked,setParked]=useState<{id:string;label:string;owner:object}[]>([]);
    const [uploadProgress,setUploadProgress]=useState<{name:string;percent:number}|null>(null),[failedUploads,setFailedUploads]=useState<File[]>([]);
    const uploadAbort=useRef<AbortController|null>(null),pendingIds=useRef<string[]>([]);
    useEffect(()=>()=>{uploadAbort.current?.abort();pendingIds.current.forEach(discardMatrixFile);},[]);
    const [files, setFiles] = useState<Attachment[]>([]), [sending, setSending] = useState(false), [uploading, setUploading] = useState(false), [emojis, setEmojis] = useState(false);
    useEffect(()=>{pendingIds.current=files.map(f=>f.id);},[files]);
    const input = useRef<HTMLTextAreaElement>(null), upload = useRef<HTMLInputElement>(null), nonce = useRef<string | null>(null);
    function change(value: string) { if (!messageDrafts.write(draftOwner, conversation, parent, value)) return; nonce.current = null; if (shareTyping && !disabled) {
        clearTimeout(typingTimer.current);
        if (Date.now() - lastTyping.current > 10000 || !value) {
            lastTyping.current = Date.now();
            sendMatrixTyping(conversation, !!value).catch(() => { });
        }
        typingTimer.current = setTimeout(() => { lastTyping.current = 0; sendMatrixTyping(conversation, false).catch(() => { }); }, 4000);
    } }
    useEffect(()=>{const quote=(event:Event)=>{const detail=(event as CustomEvent).detail;if(!parent&&detail?.roomId===conversation){change(draft+detail.text);input.current?.focus();}};window.addEventListener('tavern:quote',quote);return()=>window.removeEventListener('tavern:quote',quote);},[conversation,parent,draft]);
    const restriction=postingRestriction(conversation)||(parent?threadReplyRestriction(conversation,parent):'');
    async function send() { if(restriction){toast.error(restriction);return;} if (disabled || sending || uploading || (!draft.trim() && !files.length))
        return; if (!messageDrafts.isCurrent(draftOwner)) return;
        const view = draftView.current, current = () => draftView.current === view && messageDrafts.isCurrent(draftOwner);
        setSending(true);setSendFailed(false); nonce.current ??= crypto.randomUUID(); try {
        let saved:string|undefined;const deliveryOwner=outboxOwner();
        if(files.length){
            try{
                const attachments=snapshotMatrixAttachments(files.map(f=>f.id),conversation,parent,nonce.current);
                const item=await enqueueOutbox({kind:'draft',roomId:conversation,parent,serverId,body:draft,due:Date.now(),id:nonce.current,attachments,...snapshotMatrixSendAttempt(conversation,parent,nonce.current)});saved=item.id;
            }catch(error){if(!current())return;toast.error('Local retry copy unavailable: '+(error as Error).message+' Direct sending can still continue; keep this view and original files open if delivery fails.');}
        }
        if(saved){
            messageDrafts.clear(draftOwner,conversation,parent,draftValue);
            files.forEach(file=>discardMatrixFile(file.id));
            if(current()){pendingIds.current=[];setFiles([]);nonce.current=null;if(deliveryOwner)setParked(old=>[...old,{id:saved!,label:files.map(file=>file.name).join(', '),owner:deliveryOwner}]);}
            if(!messageDrafts.isCurrent(draftOwner)||outboxOwner()!==deliveryOwner)return;
            const delivered=await deliverOutboxNow(saved);
            if(!delivered){if(current())toast.error('Delivery was not fully acknowledged. The original message and file status are saved in Outbox.');return;}
            if(current())setParked(old=>old.filter(item=>item.id!==saved));
        }else await api('send', { conversation, parent, serverId, body: draft, attachments: files.map(f => f.id), nonce: nonce.current });
        messageDrafts.clear(draftOwner, conversation, parent, draftValue);
        if (!current()) return;
        clearTimeout(typingTimer.current);
        if (shareTyping)
            sendMatrixTyping(conversation, false).catch(() => { });
        setFiles([]);
        nonce.current = null;
        await onSent();
        if (current()) input.current?.focus();
    }
    catch (e) {
        if (current()) { setSendFailed(true);toast.error((e as Error).message); }
    }
    finally {
        if (current()) setSending(false);
    } }
    async function queueDraft() {
        if (!messageDrafts.isCurrent(draftOwner)) return;
        const view = draftView.current, current = () => draftView.current === view && messageDrafts.isCurrent(draftOwner);
        try {
            const id=nonce.current||crypto.randomUUID(),attachments=files.length?snapshotMatrixAttachments(files.map(file=>file.id),conversation,parent,id):undefined;
            await enqueueOutbox({kind:'queued',roomId:conversation,parent,serverId,body:draft,due:Date.now(),id,attachments,...snapshotMatrixSendAttempt(conversation,parent,id)});
            messageDrafts.clear(draftOwner,conversation,parent,draftValue);
            files.forEach(file=>discardMatrixFile(file.id));
            if (current()) { pendingIds.current=[];setFiles([]);nonce.current=null;setSendFailed(false); toast.success('Saved in the encrypted outbox'); }
        } catch (error) { if (current()) toast.error((error as Error).message); }
    }
    async function attach(list: FileList | File[] | null) { if (disabled || restriction || uploading || !list)
        return; if (files.length + list.length > 5) {
        toast.error('Attach up to five files at a time.');
        return;
    } if(!messageDrafts.isCurrent(draftOwner))return;const view=draftView.current,current=()=>draftView.current===view&&messageDrafts.isCurrent(draftOwner);
    setUploading(true);const controller=new AbortController();uploadAbort.current=controller; for (const f of Array.from(list)) {
        if(controller.signal.aborted)break;setUploadProgress({name:f.name,percent:0});setFailedUploads(old=>old.filter(item=>item!==f));
        if (f.size > 10 * 1024 * 1024) {
            toast.error(f.name + ' is larger than 10 MB.');
            continue;
        }
        try {
            const attachment = await uploadMatrixFile(f, conversation,{signal:controller.signal,onProgress:(loaded,total)=>{if(current())setUploadProgress({name:f.name,percent:Math.round(loaded/total*100)});}});
            if(!current()){discardMatrixFile(attachment.id);break;}
            pendingIds.current.push(attachment.id);
            setFiles(fs => [...fs, attachment]);
            nonce.current = null;
        }
        catch (e) {
            if(!controller.signal.aborted&&current()){
                const id=crypto.randomUUID(),fileId=crypto.randomUUID(),savedOwner=outboxOwner();
                try{
                    await enqueueOutbox({kind:'draft',roomId:conversation,parent,serverId,body:'',due:Date.now(),id,attachments:[{id:fileId,name:f.name,size:f.size,type:f.type,transactionId:attachmentTransaction(id,0)}]},new Map([[fileId,f]]));
                    if(current()&&savedOwner){setParked(old=>[...old,{id,label:f.name+' (file only; message text stays in the composer)',owner:savedOwner}]);toast.error('Upload failed. An encrypted unsent file copy is saved in Outbox.');}
                }catch(storageError){if(current()){toast.error((e as Error).message+' Retry copy was not saved: '+(storageError as Error).message+' Keep the original file.');setFailedUploads(old=>[...old,f]);}}
            }
        }
    } if(!current())return;setUploading(false);setUploadProgress(null);uploadAbort.current=null; if (upload.current)
        upload.current.value = ''; }
    return <div className='composer-wrap'>{parked.filter(item=>item.owner===outboxOwner()).map(item=><div className='upload-progress' role='status' key={item.id}><span>Saved unsent in Outbox: {item.label}. Open Outbox & reminders to see acknowledged files or cancel.</span><button className='secondary-button' disabled={disabled||!!restriction||sending} onClick={()=>{const view=draftView.current;if(!messageDrafts.isCurrent(draftOwner)||outboxOwner()!==item.owner)return;void retryOutbox(item.id).then(()=>{if(view===draftView.current&&messageDrafts.isCurrent(draftOwner)){setParked(old=>old.filter(value=>value.id!==item.id));toast.success('Queued for delivery while Tavern is open');}}).catch(error=>{if(view===draftView.current&&messageDrafts.isCurrent(draftOwner))toast.error(error.message);});}}>Retry delivery</button></div>)}{sendFailed&&(draft.trim()||files.length>0)&&<div className='upload-progress'><span>Message was not confirmed. Your draft is kept.</span><button className='secondary-button' disabled={disabled||!!restriction} onClick={()=>void queueDraft()}>Retry automatically from outbox</button></div>}{restriction&&<p className='composer-restriction' role='status'>{restriction}</p>}{uploadProgress&&<div className='upload-progress' role='status'><span>{uploadProgress.name} · {uploadProgress.percent}%</span><progress value={uploadProgress.percent} max={100}/><button className='secondary-button' onClick={()=>uploadAbort.current?.abort()}>Cancel upload</button></div>}{failedUploads.map((file,i)=><div className='upload-progress' key={i}><span>Upload failed: {file.name}</span><button className='secondary-button' disabled={uploading} onClick={()=>void attach([file])}>Retry</button><button className='secondary-button' onClick={()=>setFailedUploads(old=>old.filter(f=>f!==file))}>Dismiss</button></div>)}<div className='composer' onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!disabled && !sending && !uploading)
        attach(e.dataTransfer.files); }}>{files.length > 0 && <div className='pending-files'>{files.map(f => <span key={f.id}><FileText size={15}/>{f.name}<button aria-label={'Remove ' + f.name} disabled={sending} onClick={() => { discardMatrixFile(f.id);setFiles(fs => fs.filter(x => x.id !== f.id)); nonce.current = null; }}><X size={13}/></button></span>)}</div>}<textarea onPaste={e=>{if(e.clipboardData.files.length&&!disabled&&!sending&&!uploading){e.preventDefault();void attach(e.clipboardData.files);}}} ref={input} aria-label={'Message ' + name} placeholder={parent ? 'Reply to this thread…' : `Message ${name === 'Notes to self' ? 'yourself' : '#' + name}`} value={draft} onChange={e => change(e.target.value)} maxLength={8000} disabled={disabled || sending} rows={2} onKeyDown={e => { if(e.key==='ArrowUp'&&!draft&&!files.length&&onEditLatest){e.preventDefault();onEditLatest();return;}if (shouldSendOnKey({...e,isComposing:e.nativeEvent.isComposing},textMedia.enterToSend)) {
        e.preventDefault();
        send();
    } }}/><div className='composer-toolbar'><div className='composer-tools'><input className='sr-only' type='file' ref={upload} multiple onChange={e => attach(e.target.files)} tabIndex={-1}/><IconButton label='Attach files (up to 10 MB each)' disabled={disabled || !!restriction || sending || uploading} onClick={() => upload.current?.click()}>{uploading ? <Loader2 size={18} className='spin'/> : <Plus size={21}/>}</IconButton><span className='tool-divider'/><IconButton label='Bold text' onClick={() => { change(draft + '**bold text**'); input.current?.focus(); }}><strong className='bold-icon'>B</strong></IconButton><IconButton label='Code formatting' onClick={() => { change(draft + '`code`'); input.current?.focus(); }}><Code2 size={18}/></IconButton><DropdownMenu open={emojis} onOpenChange={setEmojis}><DropdownMenuTrigger asChild><button className='icon-button' aria-label='Insert emoji'><Smile size={19}/></button></DropdownMenuTrigger><DropdownMenuContent><EmojiPicker serverId={serverId} onSelect={emoji=>{change(draft+emoji);setEmojis(false);input.current?.focus();}}/></DropdownMenuContent></DropdownMenu><DropdownMenu><DropdownMenuTrigger asChild><button className='icon-button' aria-label='Mention a member'><AtSign size={19}/></button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onSelect={() => change(draft + '@everyone ')}>@everyone</DropdownMenuItem>{members.map(m => <DropdownMenuItem key={m.id} onSelect={() => { change(draft + '@' + m.name + ' '); input.current?.focus(); }}>{m.name}</DropdownMenuItem>)}<RoleMentionPicker roomId={conversation} disabled={disabled||sending||uploading||!!restriction} onSelect={token=>{change(draft+token+' ');input.current?.focus();}}/></DropdownMenuContent></DropdownMenu></div><div className='send-controls'><ScheduleMessage roomId={conversation} parent={parent} serverId={serverId} body={draft} disabled={disabled||!!restriction||sending||uploading||!!files.length} onScheduled={(()=>{const view=draftView.current;return()=>{if(messageDrafts.clear(draftOwner,conversation,parent,draftValue)&&messageDrafts.isCurrent(draftOwner)&&draftView.current===view)nonce.current=null;};})()}/>{draft.length > 7500 && <small>{8000 - draft.length}</small>}<button className='send-button' aria-label='Send message' onClick={send} disabled={disabled || !!restriction || sending || uploading || (!draft.trim() && !files.length)}>{sending ? <Loader2 size={17} className='spin'/> : <Send size={17}/>}<ChevronDown size={13}/></button></div></div></div></div>;
}
