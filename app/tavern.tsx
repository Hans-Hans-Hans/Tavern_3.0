'use client';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
import { DeviceManager } from './device-manager';
import { SecurityCenter, VerificationDialog } from './security-center';
import { CallButtons, CallPanel } from './call-panel';
import { CollaborationBoard } from './collaboration-board';
import { ConferenceButton } from './conference-panel';
import { RoomPermissions } from './room-permissions';
import { setNotificationFocus } from '@/lib/notifications';
import { ChannelAdmin } from './channel-admin';
import { matrixTyping, sendMatrixTyping } from '@/lib/matrix';
import { readInstanceConfig } from '@/lib/instance';
import { matrixApi as api, connectMatrix, restoreMatrixSession, disconnectMatrix, matrixStatus, onMatrixUpdate, uploadMatrixFile, downloadMatrixFile, exportMatrixMessages, exportEncryptionKeys, importEncryptionKeys, getMatrixClient, resolveMatrixMessage } from '@/lib/matrix';
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
    encrypted?: boolean;
    private?: boolean;
};
type Attachment = {
    id: string;
    name: string;
    size: number;
    url?: string;
    file?: any;
};
type Msg = {
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
const memoryDrafts = new Map<string, string>();
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
export default function Tavern() { return <TooltipProvider delayDuration={300}><SidebarProvider className='tavern-root'><Workspace /><VerificationDialog /><CallPanel /></SidebarProvider><Toaster position='bottom-right' richColors/></TooltipProvider>; }
function Workspace() {
    const { setOpenMobile } = useSidebar();
    const [lockedServer, setLockedServer] = useState(false);
    const [server, setServer] = useState(''), [loginUser, setLoginUser] = useState(''), [password, setPassword] = useState(''), [loginStatus, setLoginStatus] = useState(''), [loginError, setLoginError] = useState(''), [connecting, setConnecting] = useState(false), [keyPassword, setKeyPassword] = useState('');
    const keyInput = useRef<HTMLInputElement>(null);
    const pendingRoom = useRef(new URLSearchParams(window.location.hash.slice(1)).get('room')||new URLSearchParams(window.location.hash.slice(1)).get('server'));
    useEffect(() => { let active = true; readInstanceConfig().then(config => { if (active && config.homeserverUrl)
        { setServer(current => current || config.homeserverUrl); setLockedServer(!!config.lockHomeserver); } }); return () => { active = false; }; }, []);
    const [data, setData] = useState<Bootstrap | null>(null), [prefs, setPrefs] = useState<Prefs>(defaultPrefs), [channel, setGuild] = useState('general'), [view, setView] = useState('channel'), [tab, setTab] = useState('messages');
    const [messages, setMessages] = useState<Msg[]>([]), [loading, setLoading] = useState(true), [connection, setConnection] = useState('Connecting'), [error, setError] = useState('');
    const [modal, setModal] = useState(''), [detail, setDetail] = useState(false), [thread, setThread] = useState<Msg | null>(null), [replies, setReplies] = useState<Msg[]>([]), [search, setSearch] = useState(''), [results, setResults] = useState<Msg[]>([]), [searching, setSearching] = useState(false);
    const [deleting, setDeleting] = useState<Msg | null>(null), [editing, setEditing] = useState<Msg | null>(null), [editBody, setEditBody] = useState(''), [settingsTab, setSettingsTab] = useState('appearance');
    const [hasMore, setHasMore] = useState(false), [busy, setBusy] = useState(false), [channelName, setGuildName] = useState(''), [channelDesc, setGuildDesc] = useState(''), [isPrivate, setIsPrivate] = useState(false), [selectedMembers, setSelectedMembers] = useState<string[]>([]), [email, setEmail] = useState(''), [invited, setInvited] = useState<string[]>([]), [profileName, setProfileName] = useState(''), [workspaceName, setWorkspaceName] = useState('');
    const bottom = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null), nearBottom = useRef(true), generation = useRef(0), searchGeneration = useRef(0);
    const [selectedServer, setSelectedServer] = useState('all');
    useEffect(()=>setNotificationFocus(prefs.focus),[prefs.focus]);
    const terms = terminology(prefs.naming), label = terms.label;
    const currentServer = data?.servers?.find(s => s.id === selectedServer);
    const visibleChannels = data?.conversations.filter(c => c.kind !== 'dm' && (!currentServer || currentServer.roomIds.includes(c.id)));
    function chooseServer(id: string) { setSelectedServer(id); setView('channel'); setThread(null); const server = data?.servers?.find(s => s.id === id); setGuild(server ? data?.conversations.find(c => server.roomIds.includes(c.id))?.id || '' : data?.conversations[0]?.id || 'general'); }
    const me = data?.me;
    const active = data?.conversations.find(c => c.id === channel);
    const muted = prefs.muted.includes(channel);
    function convName(c: Conv) { if (c.kind !== 'dm')
        return c.name; const peer = data?.memberships.find(m => m.conversation_id === c.id && m.user_id !== me?.id); return peer ? data?.members.find(m => m.id === peer.user_id)?.name || 'Direct message' : 'Notes to self'; }
    const name = active ? convName(active) : data?.preview ? 'general' : label("your Tavern");
    const channelMembers = data?.preview ? data.members : (data?.members || []).filter(m => data?.memberships.some(cm => cm.conversation_id === channel && cm.user_id === m.id));
    useEffect(()=>setNotificationFocus(prefs.focus),[prefs.focus]);
    const loadBootstrap = useCallback(async () => { const b = await api('bootstrap'); setData(b); setPrefs({ ...defaultPrefs, ...b.preferences }); setProfileName(b.me.name); setWorkspaceName(b.workspace.name); if (!b.preview) {
        const linked = pendingRoom.current;
        const linkedServer=b.servers?.find((s:{id:string})=>s.id===linked);
        if(linkedServer){setSelectedServer(linkedServer.id);setGuild(b.conversations.find((c:Conv)=>linkedServer.roomIds.includes(c.id))?.id||'');pendingRoom.current=null;return b as Bootstrap;}
        if (linked && b.conversations.some((c: Conv) => c.id === linked)) {
            setGuild(linked);
            pendingRoom.current = null;
        }
        else {
            setGuild(current => b.conversations.some((c: Conv) => c.id === current) ? current : b.conversations[0]?.id || 'general');
            if (linked && b.invitations?.some((r: {
                id: string;
            }) => r.id === linked))
                setModal('roomInvites');
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
        setMessages(r.messages);
        setHasMore(r.hasMore);
        setConnection(matrixStatus().state);
        setError('');
        if (view === 'channel' && tab === 'messages' && nearBottom.current && !document.hidden && matrixStatus().connected && getMatrixClient()?.getRoom(channel)) {
            await api('read', { conversation: channel, id: r.messages.at(-1)?.id });
            setData(d => d ? { ...d, conversations: d.conversations.map(c => c.id === channel ? { ...c, unread: 0 } : c) } : d);
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
    useEffect(() => { let timer: ReturnType<typeof setTimeout>; const off = onMatrixUpdate(() => { clearTimeout(timer); timer = setTimeout(() => { setConnection(matrixStatus().state); api('bootstrap').then(b => { setData(b); setPrefs({ ...defaultPrefs, ...b.preferences }); }).catch(() => { }); loadMessages(true); }, 150); }); return () => { off(); clearTimeout(timer); }; }, [loadMessages]);
    useEffect(() => { if (!data)
        return; nearBottom.current = true; setMessages([]); loadMessages(); const timer = setInterval(() => { if (!document.hidden)
        loadMessages(true); }, 5000); return () => { clearInterval(timer); generation.current++; }; }, [!!data, loadMessages]);
    useEffect(() => { if (!data)
        return; const timer = setInterval(() => { if (!document.hidden)
        api('bootstrap').then(b => setData(b)).catch(() => { }); }, 20000); return () => clearInterval(timer); }, [!!data]);
    useEffect(() => { document.documentElement.dataset.theme = prefs.theme; document.documentElement.dataset.accent = prefs.accent; }, [prefs]);
    useEffect(() => { const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setModal('search');
    } }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []);
    useEffect(() => { if (!thread)
        return; let live = true; const run = () => api('messages', undefined, { conversation: thread.conversation_id, parent: thread.id }).then(r => { if (live)
        setReplies(r.messages); }).catch(e => toast.error(e.message)); setReplies([]); run(); const t = setInterval(() => { if (!document.hidden)
        run(); }, 5000); return () => { live = false; clearInterval(t); }; }, [thread?.id]);
    useEffect(() => { const g = ++searchGeneration.current; if (!search.trim()) {
        setResults([]);
        setSearching(false);
        return;
    } setSearching(true); const t = setTimeout(() => api('search', undefined, { q: search }).then(r => { if (g === searchGeneration.current)
        setResults(r.messages); }).catch(e => toast.error(e.message)).finally(() => { if (g === searchGeneration.current)
        setSearching(false); }), 250); return () => clearTimeout(t); }, [search]);
    const select = (id: string) => { if(currentServer&&!currentServer.roomIds.includes(id))setSelectedServer('all'); setGuild(id); setView('channel'); setTab('messages'); setThread(null); setOpenMobile(false); };
    const go = (v: string) => { setView(v); setThread(null); setOpenMobile(false); };
    async function act(action: string, p: any) { try {
        const r = await api(action, p);
        await loadMessages(true);
        if (thread) {
            const t = await api('messages', undefined, { conversation: thread.conversation_id, parent: thread.id });
            setReplies(t.messages);
        }
        return r;
    }
    catch (e) {
        toast.error((e as Error).message);
        throw e;
    } }
    async function updatePrefs(p: Partial<Prefs>) { const next = { ...prefs, ...p }; try {
        await api('preferences', next);
        setPrefs(next);
    }
    catch (e) {
        toast.error((e as Error).message);
    } }
    function openSettings(t = 'appearance') { setSettingsTab(t); setModal('settings'); }
    async function startDm(member: string) { setBusy(true); try {
        const r = await api('create', { kind: 'dm', name: 'Direct message', members: [member] });
        await loadBootstrap();
        select(r.id);
        setModal('');
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
    async function loadOlder() { if (!messages.length)
        return; setBusy(true); try {
        const r = await api('messages', undefined, { conversation: channel, before: String(messages[0].created_at) });
        setMessages(r.messages);
        setHasMore(r.hasMore);
    }
    catch (e) {
        toast.error((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    function messageCard(m: Msg, inThread = false) {
        return <article className={'message ' + (prefs.compact ? 'compact ' : '') + (m.author_id === me?.id ? 'own' : '')} key={m.id} id={'message-' + m.id}>
  <Avatar name={m.author_name}/><div className='message-content'><div className='message-meta'><strong>{m.author_name}</strong>{m.author_id === me?.id && <span className='you-label'>you</span>}<time dateTime={new Date(m.created_at).toISOString()}>{new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>{m.edited_at && <span className='edited'>edited</span>}{m.pinned === 1 && <Pin size={13} className='pin-mark'/>}{view !== 'channel' && !inThread && <button className='source-channel' onClick={() => select(m.conversation_id)}>#{m.conversation_name}</button>}</div>
  <p className='message-body'><RichText text={m.body}/></p>{m.attachments.length > 0 && <div className='attachments'>{m.attachments.map(a => <button className='file-card' key={a.id} onClick={() => downloadMatrixFile(a).catch(e => toast.error(e.message))}><span className='file-icon'><FileText size={22}/></span><span><strong>{a.name}</strong><small>{bytes(a.size)} · Download</small></span><Download size={16}/></button>)}</div>}
  {m.reactions.length > 0 && <div className='reaction-row'>{m.reactions.map(r => <button className={'reaction ' + (r.mine ? 'selected' : '')} key={r.emoji} aria-label={`${r.emoji}, ${r.count} reactions${r.mine ? ', including you' : ''}`} onClick={() => act('react', { id: m.id, emoji: r.emoji }).catch(() => { })}>{r.emoji}<span>{r.count}</span></button>)}<button className='reaction-add' aria-label='Add thumbs up' onClick={() => act('react', { id: m.id, emoji: '👍' }).catch(() => { })}><Smile size={16}/><Plus size={10}/></button></div>}
  {!inThread && m.replies > 0 && <button className='thread-link' onClick={() => setThread(m)}><MessageCircle size={15}/>{m.replies} {m.replies === 1 ? 'reply' : 'replies'}<span>View thread</span><ChevronRight size={13}/></button>}
  </div><div className='message-actions'>
   <DropdownMenu><DropdownMenuTrigger asChild><button className='icon-button' aria-label='Add reaction'><Smile size={17}/></button></DropdownMenuTrigger><DropdownMenuContent className='emoji-menu'>{['👍', '❤️', '🎉', '🔥', '👀', '✅', '🚀', '😂'].map(e => <DropdownMenuItem key={e} onSelect={() => act('react', { id: m.id, emoji: e }).catch(() => { })}>{e}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
   {!inThread && !m.parent_id && <IconButton label='Reply in thread' onClick={() => setThread(m)}><MessageSquare size={17}/></IconButton>}
   <IconButton label={m.saved ? 'Remove from saved' : 'Save for later'} className={m.saved ? 'is-saved' : ''} onClick={() => act('save', { id: m.id }).then(() => toast.success(m.saved ? 'Removed from saved' : 'Saved for later')).catch(() => { })}><Bookmark size={17} fill={m.saved ? 'currentColor' : 'none'}/></IconButton>
   <DropdownMenu><DropdownMenuTrigger asChild><button className='icon-button' aria-label='More message actions'><MoreHorizontal size={18}/></button></DropdownMenuTrigger><DropdownMenuContent align='end'><DropdownMenuItem onSelect={() => act('pin', { id: m.id }).catch(() => { })}><Pin />{m.pinned ? 'Unpin message' : label("Pin to Guild")}</DropdownMenuItem>{m.author_id === me?.id && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => { setEditing(m); setEditBody(m.body); }}><Pencil />Edit message</DropdownMenuItem><DropdownMenuItem className='danger-text' onSelect={() => setDeleting(m)}><Trash2 />Delete message</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu>
  </div></article>;
    }
    const heading = view === 'channel' ? name : ({ mentions: 'Mentions', threads: 'Threads', saved: 'Saved for later', files: 'Shared files' } as any)[view] || name;
    return <>
 <aside className='workspace-rail' aria-label='Tavern navigation'><button className='brand-mark' aria-label='Tavern home' onClick={() => chooseServer('all')}><Beer size={27} strokeWidth={2}/></button><div className='rail-divider'/><button className={'workspace-icon ' + (selectedServer === 'all' ? 'selected' : '')} onClick={() => chooseServer('all')} title='All conversations' >T<span /></button>{data?.servers?.map(server => <button key={server.id} className={'workspace-icon ' + (selectedServer === server.id ? 'selected' : '')} title={server.name} onClick={() => chooseServer(server.id)}>{initials(server.name)}</button>)}<IconButton label={'Create ' + terms.server} disabled={!!data?.preview} onClick={() => setModal('server')}><Plus size={20}/></IconButton><IconButton label='Tavern settings' onClick={() => openSettings('workspace')}><Settings size={20}/></IconButton><div className='rail-spacer'/><IconButton label='About Tavern' onClick={() => openSettings('about')}><CircleHelp size={20}/></IconButton><button className='rail-profile' aria-label='Your profile' onClick={() => openSettings('profile')}><Avatar name={me?.name || 'You'} size='small'/></button></aside>
 <Sidebar collapsible='offcanvas' className='channel-sidebar'>
  <SidebarHeader className='workspace-header'><DropdownMenu><DropdownMenuTrigger asChild><button className='workspace-select'><span><strong>{currentServer?.name || data?.workspace.name || 'Tavern'}</strong><small><span className='matrix-wordmark'>[m]</span> Self-hosted · Matrix</small></span><ChevronDown size={17}/></button></DropdownMenuTrigger><DropdownMenuContent className='workspace-menu' align='start'><DropdownMenuItem onSelect={() => chooseServer('all')}>All conversations</DropdownMenuItem>{data?.servers?.map(server => <DropdownMenuItem key={server.id} onSelect={() => chooseServer(server.id)}>{server.name}</DropdownMenuItem>)}<DropdownMenuItem disabled={!!data?.preview} onSelect={() => setModal('server')}>Create {terms.server}</DropdownMenuItem>{currentServer&&<DropdownMenuItem onSelect={()=>setModal('inviteServer')}>Invite to {terms.server}</DropdownMenuItem>}<DropdownMenuSeparator /><DropdownMenuItem onSelect={() => setModal('invite')}><Users />Invite people</DropdownMenuItem><DropdownMenuItem onSelect={() => openSettings('workspace')}><Settings />Tavern settings</DropdownMenuItem><DropdownMenuItem onSelect={() => openSettings('privacy')}><ShieldCheck />Privacy & security</DropdownMenuItem></DropdownMenuContent></DropdownMenu></SidebarHeader>
  <SidebarContent className='navigation-content'><nav className='quick-nav' aria-label='Messages'><button className={view === 'mentions' ? 'active' : ''} onClick={() => go('mentions')}><AtSign size={18}/><span>Mentions</span></button><button className={view === 'threads' ? 'active' : ''} onClick={() => go('threads')}><MessageSquare size={18}/><span>Threads</span></button><button className={view === 'saved' ? 'active' : ''} onClick={() => go('saved')}><Bookmark size={18}/><span>Saved for later</span></button></nav>
   <div className='channel-section'><div className='nav-section-label'><span><ChevronDown size={13}/>{label(" GUILDS")}</span><IconButton label={label("Create a Guild")} onClick={() => setModal('create')}><Plus size={15}/></IconButton></div><nav aria-label={label("Guilds")}>{(visibleChannels || [{ id: 'general', name: 'general', kind: 'channel', description: '', unread: 0 }, { id: 'introductions', name: 'introductions', kind: 'channel', description: '', unread: 0 }, { id: 'phase-1', name: 'phase-1', kind: 'channel', description: '', unread: 0 }, { id: 'random', name: 'random', kind: 'channel', description: '', unread: 0 }]).map(c => <button key={c.id} className={'channel-link ' + (view === 'channel' && channel === c.id ? 'active ' : '') + (prefs.muted.includes(c.id) ? 'muted-channel' : '')} onClick={() => select(c.id)}>{c.kind === 'private' ? <LockKeyhole size={17}/> : <Hash size={18}/>}<span>{c.name}</span>{c.unread > 0 && !prefs.muted.includes(c.id) && !prefs.focus && <span className='unread-count'>{c.unread > 99 ? '99+' : c.unread}</span>}{prefs.muted.includes(c.id) && <BellOff size={13}/>}</button>)}</nav><button className='add-channel' onClick={() => setModal('create')}><Plus size={16}/>{label(" Add a Guild")}</button></div>
   <div className='channel-section dm-section'><div className='nav-section-label'><span><ChevronDown size={13}/> DIRECT MESSAGES</span><IconButton label='New direct message' onClick={() => setModal('dm')}><Plus size={15}/></IconButton></div>{data?.conversations.filter(c => c.kind === 'dm').map(c => <button key={c.id} className={'channel-link dm-link ' + (channel === c.id && view === 'channel' ? 'active' : '')} onClick={() => select(c.id)}><Avatar name={convName(c)} size='tiny'/><span>{convName(c)}</span>{c.unread > 0 && !prefs.focus && <span className='unread-count'>{c.unread}</span>}</button>)}{!data?.conversations.some(c => c.kind === 'dm') && <button className='channel-link dm-link' onClick={() => me && startDm(me.id)}><Avatar name={me?.name || 'You'} size='tiny'/><span>Notes to self</span><span className='small-note'>you</span></button>}<button className='add-channel' onClick={() => setModal('dm')}><Plus size={16}/> New message</button></div>
   <button className='invite-sidebar' onClick={() => setModal('invite')}><span className='invite-icon'><Users size={18}/></span><span><strong>Better with your people</strong><small>Invite them to Tavern</small></span><ChevronRight size={15}/></button>
  </SidebarContent><SidebarFooter className='sidebar-footer'><div className='connection'><span className={connection === 'Connected' ? 'live' : ''}/>{connection}<span className='version'>v0.3</span></div><button className='profile-button' onClick={() => openSettings('profile')}><Avatar name={me?.name || 'You'} size='small'/><span><strong>{me?.name || label("Your Tavern")}</strong><small>{data?.preview ? 'Not connected' : 'Matrix account'}</small></span><Settings size={17}/></button></SidebarFooter>
 </Sidebar>
 <main className='main-workspace'>
  <header className='global-header'><div className='breadcrumb'><SidebarTrigger className='mobile-sidebar-trigger'/><span>Tavern</span><ChevronRight size={12}/><strong>{view === 'channel' ? label("Guilds") : heading}</strong></div><button className='global-search' onClick={() => setModal('search')}><Search size={17}/><span>{label("Search your Tavern")}</span><kbd>Ctrl K</kbd></button><div className='header-end'><IconButton label={prefs.focus?'Leave focus mode':'Enter focus mode'} onClick={()=>updatePrefs({focus:!prefs.focus})}><Moon size={18} fill={prefs.focus?'currentColor':'none'}/></IconButton><span className='private-badge'><ShieldCheck size={14}/>{active?.encrypted ? 'Encrypted' : 'Matrix ready'}</span><IconButton label='Tavern members' onClick={() => setModal('members')}><Users size={18}/></IconButton></div></header>
  {data?.preview && <div className='matrix-banner'><span className='matrix-wordmark'>[matrix]</span><span>Your space. Your server. Connect Matrix to start a conversation.</span><button onClick={() => setModal('connect')}>Connect homeserver <ArrowRight size={13}/></button></div>}
  {!!data?.invitations?.length && <div className='matrix-banner'><Users size={16}/><span>{data.invitations.length} room invitation{data.invitations.length === 1 ? '' : 's'}</span><button onClick={() => setModal('roomInvites')}>View invitations</button></div>}
  <div className='channel-header'><div className='channel-heading'><span className='channel-symbol'>{view === 'channel' ? (active?.kind === 'private' ? <LockKeyhole size={23}/> : active?.kind === 'dm' ? <MessageCircle size={23}/> : <Hash size={27}/>) : view === 'saved' ? <Bookmark size={24}/> : view === 'mentions' ? <AtSign size={24}/> : <MessageSquare size={24}/>}</span><div><h1>{heading}</h1><p>{view === 'channel' ? (active?.kind === 'dm' ? 'A conversation just for you and the people here.' : active?.description || 'The home for your team.') : ({ mentions: 'The conversations that need your attention.', threads: 'Keep the conversation going, without the noise.', saved: 'The things you wanted to come back to.', files: 'Files shared across your conversations.' } as any)[view]}</p></div></div><div className='channel-controls'>{view === 'channel' && <><ConferenceButton key={channel} roomId={channel} disabled={!!data?.preview}/><CallButtons roomId={channel} direct={active?.kind==='dm'} disabled={!!data?.preview}/><button className='member-pill' onClick={() => setModal('members')}><Users size={15}/>{channelMembers.length || 1}</button><span className='control-divider'/><IconButton label={muted ? label("Unmute Guild") : label("Mute Guild")} onClick={() => updatePrefs({ muted: muted ? prefs.muted.filter(c => c !== channel) : [...prefs.muted, channel] })}>{muted ? <BellOff size={18}/> : <Bell size={18}/>}</IconButton><IconButton label={label("Guild details")} onClick={() => setDetail(true)}><Info size={18}/></IconButton></>}</div></div>
  {view === 'channel' && <Tabs value={tab} onValueChange={setTab} className='channel-tabs'><TabsList variant='line'><TabsTrigger value='messages'><MessageSquare />Messages</TabsTrigger><TabsTrigger value='files'><Paperclip />Files</TabsTrigger><TabsTrigger value='pins'><Pin />Pinned</TabsTrigger><TabsTrigger value='work'><CheckCircle2 />Work</TabsTrigger></TabsList><div className='channel-caption'>{active?.encrypted ? <ShieldCheck size={12}/> : <Info size={12}/>} {data?.preview ? 'Not connected' : active?.encrypted ? 'End-to-end encrypted' : 'Unencrypted room'}</div></Tabs>}
  <div className='conversation-layout'><section className='conversation-main'>
   {error && <div className='error-banner' role='alert'><Info size={17}/><span>{error}</span><button onClick={() => { if (data)
        loadMessages();
    else
        loadBootstrap().catch(e => setError(e.message)); }}>Retry</button></div>}
   {view==='channel'&&tab==='work'?<CollaborationBoard key={channel} roomId={channel}/>:<div className='message-scroll' ref={scroll} onScroll={() => { if (scroll.current)
        nearBottom.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 150; }}>
    {loading && messages.length === 0 ? <div className='loading-messages'><Loader2 size={23} className='spin'/><span>Opening your conversations…</span></div> : <>
     {view === 'channel' && tab === 'messages' && <div className='channel-intro'><span className='intro-hash'>{active?.kind === 'dm' ? <MessageCircle size={30}/> : active?.kind === 'private' ? <LockKeyhole size={30}/> : <Hash size={36}/>}</span><h2>{!active && !data?.preview ? label("Your Tavern is ready") : active?.kind === 'dm' ? name : `Welcome to #${name}`}</h2><p>{!active && !data?.preview ? 'Create your first encrypted room to start a conversation.' : active?.kind === 'dm' ? (name === 'Notes to self' ? 'A quiet spot for thoughts, links, and things to remember.' : 'This is the beginning of your private conversation.') : active?.description || 'This is the beginning of something good.'}</p><div className='intro-meta'><span><LockKeyhole size={13}/>{active?.kind === 'private' ? label("Private Guild") : active?.kind === 'dm' ? 'Private conversation' : active?.private ? 'Invite-only room' : 'Room members'}</span><span>·</span><button onClick={() => setDetail(true)}>View details <ArrowRight size={13}/></button></div></div>}
     {hasMore && view === 'channel' && tab === 'messages' && <button className='load-older' disabled={busy} onClick={loadOlder}>Load earlier messages</button>}
     {view === 'channel' && tab === 'messages' && messages.length === 0 && <><div className='date-divider'><span>Today</span></div><article className='welcome-message'><div className='guide-avatar'><Beer size={21}/></div><div><div className='message-meta'><strong>Tavern</strong><span className='guide-label'>GUIDE</span><span className='edited'>Getting started</span></div><p>Your conversations. Your rules.</p><p className='muted-copy'>{label("Your conversations, on your own server. Connect your local Matrix account, create a Guild, and bring your people together.")}</p><div className='getting-started'><button onClick={() => setModal(!active && !data?.preview ? 'create' : 'invite')}><span className='onboarding-icon'><Users size={20}/></span><strong>{!active && !data?.preview ? label("Create your first Guild") : 'Bring your people'}</strong><span>Good company. Great conversations.</span><small>{!active && !data?.preview ? label("Create a Guild") : 'Invite members'} <ArrowRight size={14}/></small></button><button onClick={() => openSettings()}><span className='onboarding-icon violet'><Paintbrush size={20}/></span><strong>Make yourself at home</strong><span>Your colors. Your kind of quiet.</span><small>Personalize Tavern <ArrowRight size={14}/></small></button></div><div className='guide-tip'><Sparkles size={15}/><span>A little tip: use <kbd>Ctrl K</kbd> to find a message, or save one to come back to later.</span></div></div></article></>}
     {(tab === 'pins' && view === 'channel' ? messages.filter(m => m.pinned) : messages).map((m, i, arr) => <div key={m.id}>{view === 'channel' && (i === 0 || new Date(m.created_at).toDateString() !== new Date(arr[i - 1].created_at).toDateString()) && <div className='date-divider'><span>{new Date(m.created_at).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span></div>}{messageCard(m)}</div>)}
     {((view !== 'channel' && messages.length === 0) || (view === 'channel' && tab !== 'messages' && (tab === 'pins' ? messages.filter(m => m.pinned).length === 0 : messages.length === 0))) && <div className='empty-state'><span>{tab === 'pins' ? <Pin size={28}/> : tab === 'files' ? <File size={28}/> : view === 'saved' ? <Bookmark size={28}/> : view === 'mentions' ? <AtSign size={28}/> : <MessageSquare size={28}/>}</span><h2>{tab === 'pins' ? 'Keep the essentials close' : tab === 'files' ? 'All your shared files, together' : view === 'saved' ? 'A place for the keepers' : view === 'mentions' ? 'You’re all caught up' : 'Room for a deeper conversation'}</h2><p>{tab === 'pins' ? 'Pin a message from its menu and it will appear here.' : tab === 'files' ? 'Attach a file to a message to share it with this conversation.' : view === 'saved' ? 'Save a message with the bookmark button. Only you can see your saved list.' : view === 'mentions' ? 'Messages that mention your display name or @everyone will appear here.' : 'Reply to a message in a thread to keep a topic together.'}</p></div>}
    </>}<div ref={bottom}/>
   </div>}
   {view === 'channel' && tab === 'messages' && <div className='typing-indicator' aria-live='polite'>{!prefs.focus && matrixTyping(channel).length > 0 ? matrixTyping(channel).slice(0, 3).join(', ') + (matrixTyping(channel).length === 1 ? ' is typing…' : ' are typing…') : ''}</div>}
   {view === 'channel' && tab === 'messages' && <Composer shareTyping={prefs.typing&&!prefs.focus} key={(me?.id||'preview')+':'+channel} conversation={channel} name={name} members={data?.members || []} disabled={!data || !!data.preview || !getMatrixClient()?.getRoom(channel)} onSent={async () => { nearBottom.current = true; await loadMessages(true); }}/>}
   {view === 'channel' && tab === 'messages' && <div className='composer-footnote'><span><LockKeyhole size={11}/> {data?.preview ? 'Connect your homeserver to send messages' : active?.encrypted ? 'Encrypted on this device before sending' : 'This room is not encrypted'}</span><span><strong>Enter</strong> to send · <strong>Shift + Enter</strong> for a new line</span></div>}
  </section>
  {view === 'channel' && !prefs.focus && <aside className='channel-overview'><div className='overview-title'><span>{label("IN THIS GUILD")}</span><IconButton label={label("Guild information")} onClick={() => setDetail(true)}><Info size={15}/></IconButton></div><div className='overview-about'><span className='small-hash'>{active?.kind === 'dm' ? <MessageCircle size={23}/> : <Hash size={25}/>}</span><h3>{name}</h3><p>{active?.description || 'A private place to share what matters.'}</p><span className='channel-type'><LockKeyhole size={12}/>{data?.preview ? 'Interface preview' : active?.encrypted ? 'Encrypted Matrix room' : 'Unencrypted Matrix room'}</span></div><div className='overview-section'><div className='overview-section-title'><h3>Members <span>{channelMembers.length}</span></h3><button onClick={() => setModal('members')}>View all</button></div>{channelMembers.slice(0, 5).map(m => <button className='member-row' key={m.id} onClick={() => startDm(m.id)}><Avatar name={m.name} size='small'/><span><strong>{m.name}{m.id === me?.id && <small> (you)</small>}</strong><small>{m.role === 'owner' ? 'Matrix account' : 'Member'}</small></span></button>)}<button className='invite-members-link' onClick={() => setModal('invite')}><Plus size={15}/> Invite people</button></div><div className='overview-section quick-links'><h3>{label("Guild essentials")}</h3><button onClick={() => setTab('files')}><Paperclip size={16}/> Shared files <ChevronRight size={14}/></button><button onClick={() => setTab('pins')}><Pin size={16}/> Pinned messages <ChevronRight size={14}/></button><button onClick={() => { setSearch(''); setModal('search'); }}><Search size={16}/> Search conversations <ChevronRight size={14}/></button></div><div className='privacy-note'><ShieldCheck size={22}/><h4>A little more peace of mind.</h4><p>No ads or tracking scripts in Tavern. Your homeserver, your conversations, your people.</p><button onClick={() => openSettings('privacy')}>Your privacy, explained <ArrowRight size={13}/></button></div><div className='tavern-signature'><Beer size={14}/><span>Made for conversation.</span></div></aside>}
  </div>
 </main>
 <ServerDialog open={modal === 'server'} naming={prefs.naming} onClose={() => setModal('')} onCreated={async (id) => { await loadBootstrap(); setSelectedServer(id); setGuild(''); setView('channel'); }}/>
 <Dialog open={['create', 'dm', 'invite', 'members', 'settings', 'search', 'connect', 'roomInvites', 'inviteServer'].includes(modal)} onOpenChange={v => { if (!v && !connecting)
        setModal(''); }}><DialogContent className={'tavern-dialog ' + (modal === 'settings' ? 'settings-dialog' : modal === 'search' ? 'search-dialog' : '')}>
  <DialogHeader><DialogTitle>{({ inviteServer:'Invite to '+terms.server, connect: 'Connect your Matrix homeserver', roomInvites: 'You’re invited', create: 'A new place to talk', dm: 'Start a conversation', invite: 'Bring your people to Tavern', members: 'Your people', settings: 'Make Tavern yours', search: 'Find the conversation' } as any)[modal]}</DialogTitle><DialogDescription>{({ inviteServer:'Invite an existing local account. Conversation access is managed separately.', connect: 'Your conversations stay on your server. Your keys stay with you.', roomInvites: 'Choose which conversations to join.', create: label("Give your Guild a name and a purpose."), dm: 'Choose a Tavern member, or start a note to yourself.', invite: 'Invite an existing Matrix account to this conversation.', members: 'The people who make this space yours.', settings: label("Your Tavern, set up the way you like it."), search: 'Search decrypted messages currently loaded on this device.' } as any)[modal]}</DialogDescription></DialogHeader>
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
  {modal === 'roomInvites' && <div className='dialog-member-list'>{data?.invitations?.map(r => <div className='room-invite' key={r.id}><Hash size={20}/><strong>{r.name}</strong><button className='primary-button' onClick={() => api('join', { id: r.id }).then(() => loadBootstrap()).then(() => { if(getMatrixClient()?.getRoom(r.id)?.isSpaceRoom()){setSelectedServer(r.id);setGuild('');setView('channel')}else select(r.id); setModal(''); }).catch(e => toast.error(e.message))}>Join</button><button className='icon-button' aria-label='Decline invitation' onClick={() => api('decline', { id: r.id }).then(() => loadBootstrap()).catch(e => toast.error(e.message))}><X size={16}/></button></div>)}</div>}
  {modal === 'create' && <form onSubmit={e => { e.preventDefault(); createGuild(); }} className='dialog-form'><label>{label("Guild name")}<div className='input-with-icon'><Hash size={17}/><input autoFocus value={channelName} onChange={e => setGuildName(e.target.value)} placeholder='e.g. weekend-projects' required maxLength={60}/></div></label><label>Description <span className='optional'>optional</span><input value={channelDesc} onChange={e => setGuildDesc(e.target.value)} placeholder={label("What\u2019s this Guild for?")} maxLength={200}/></label><div className='notice'><ShieldCheck size={19}/><p>New rooms are invite-only, end-to-end encrypted, and do not federate. Select members below or invite them by Matrix ID afterward.</p></div>{true && <div className='member-picker'>{data?.members.filter(m => m.id !== me?.id).map(m => <label key={m.id}><Checkbox checked={selectedMembers.includes(m.id)} onCheckedChange={v => setSelectedMembers(s => v ? [...s, m.id] : s.filter(x => x !== m.id))}/><Avatar name={m.name} size='tiny'/>{m.name}</label>)}{data?.members.length === 1 && <p>{label("You are the only member so far. Invite people before adding them to a private Guild.")}</p>}</div>}<button className='primary-button' disabled={busy || !channelName.trim()}>{busy ? <Loader2 className='spin' size={16}/> : <Plus size={16}/>}{label("Create Guild")}</button></form>}
  {modal === 'dm' && <div className='dialog-member-list'>{data?.members.map(m => <button key={m.id} disabled={busy} onClick={() => startDm(m.id)}><Avatar name={m.name}/><span><strong>{m.id === me?.id ? 'Notes to self' : m.name}</strong><small>{m.id === me?.id ? 'Just for you' : 'Send a private message'}</small></span><ArrowRight size={17}/></button>)}</div>}
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
  {modal === 'members' && <div className='dialog-member-list'>{channelMembers.map(m => <button key={m.id} onClick={() => startDm(m.id)}><Avatar name={m.name}/><span><strong>{m.name}{m.id === me?.id ? ' (you)' : ''}</strong><small>{m.role === 'owner' ? 'Matrix account' : 'Member'}</small></span><MessageCircle size={18}/></button>)}<button className='secondary-button' onClick={() => setModal('invite')}><Plus size={16}/>Invite people</button></div>}
  {modal === 'search' && <><div className='input-with-icon search-input'><Search size={20}/><input autoFocus aria-label='Search messages' placeholder='A word, an idea, a conversation…' value={search} maxLength={120} onChange={e => setSearch(e.target.value)}/>{searching && <Loader2 size={18} className='spin'/>}</div><div className='search-results'>{results.map(m => <button key={m.id} onClick={() => { select(m.conversation_id); setModal(''); if (m.parent_id)
        resolveMatrixMessage(m.conversation_id, m.parent_id).then(root => setThread(root as Msg)).catch(e => toast.error(e.message));
    else
        setThread(m); }}><div><Hash size={15}/><strong>{m.conversation_name}</strong><span>{new Date(m.created_at).toLocaleDateString()}</span></div><p><RichText text={m.body}/></p><small>{m.author_name}</small></button>)}{!search && <div className='search-hint'><Search size={27}/><p>Pick up where the conversation left off.</p><small>Search stays on this device. Load earlier messages to search more history.</small></div>}{search && !searching && results.length === 0 && <div className='search-hint'><p>No messages found for “{search}”.</p><small>Try a shorter phrase or a different word.</small></div>}</div></>}
  {modal === 'settings' && <Tabs value={settingsTab} onValueChange={setSettingsTab} className='settings-tabs'><TabsList><TabsTrigger value='appearance'>Appearance</TabsTrigger><TabsTrigger value='profile'>Profile</TabsTrigger><TabsTrigger value='privacy'>Privacy</TabsTrigger><TabsTrigger value='workspace'>Tavern</TabsTrigger><TabsTrigger value='about'>About</TabsTrigger></TabsList><TabsContent value='appearance'><div className='settings-section'><div className='setting-row'><span><strong>Legacy naming</strong><small>Use Taverns and Guilds. The default is servers and channels.</small></span><Switch aria-label='Use legacy naming' checked={prefs.naming === 'legacy'} onCheckedChange={legacy => updatePrefs({ naming: legacy ? 'legacy' : 'standard' })}/></div><h3>Find your light</h3><div className='theme-options'>{['light', 'dark'].map(t => <button key={t} className={'theme-option ' + t + ' ' + (prefs.theme === t ? 'chosen' : '')} onClick={() => updatePrefs({ theme: t })}><div className='theme-preview'><span /><div><i /><i /><i /></div></div><span>{t === 'light' ? <Sun size={16}/> : <Moon size={16}/>} {t === 'light' ? 'Daylight' : 'After hours'} {prefs.theme === t && <Check size={16}/>}</span></button>)}</div><div className='setting-row'><span><strong>Focus mode</strong><small>Hide unread counts, typing activity, and the details panel.</small></span><Switch aria-label='Focus mode' checked={prefs.focus} onCheckedChange={focus=>updatePrefs({focus})}/></div><h3>Your accent</h3><div className='accent-options'>{['gold', 'blue', 'violet'].map(a => <button key={a} onClick={() => updatePrefs({ accent: a })} className={a + ' ' + (prefs.accent === a ? 'chosen' : '')}><span>{prefs.accent === a && <Check size={14}/>}</span>{a === 'gold' ? 'Tavern gold' : a === 'blue' ? 'Slate blue' : 'Dusk violet'}</button>)}</div><div className='setting-row'><span><strong>Compact messages</strong><small>A little less space between conversations.</small></span><Switch checked={prefs.compact} onCheckedChange={compact => updatePrefs({ compact })} aria-label='Compact messages'/></div></div></TabsContent><TabsContent value='profile'><form className='dialog-form' onSubmit={async (e) => { e.preventDefault(); try {
        await api('profile', { name: profileName });
        await loadBootstrap();
        toast.success('Profile updated');
    }
    catch (e) {
        toast.error((e as Error).message);
    } }}><div className='profile-preview'><Avatar name={profileName || 'You'} size='large'/><div><strong>Your corner of Tavern</strong><p>Choose how you appear in conversations.</p></div></div><label>Display name<input value={profileName} maxLength={60} onChange={e => setProfileName(e.target.value)} required/></label><label>Matrix account<input value={me?.email || ''} readOnly/></label><button className='primary-button'>Save profile</button><button type='button' className='signout-link' onClick={() => disconnectMatrix().then(() => { memoryDrafts.clear();generation.current++;searchGeneration.current++;setThread(null);setMessages([]);setReplies([]);setGuild('general');setSelectedServer('all');setView('channel');setTab('messages');setSearch('');setResults([]);setKeyPassword('');setPassword('');setEmail('');setInvited([]);setEditing(null);setDeleting(null);setDetail(false);setError('');return loadBootstrap(); }).then(() => { setModal('connect'); toast.success('Signed out of Matrix'); }).catch(e => toast.error(e.message))}><LogOut size={15}/>Sign out of Matrix</button></form></TabsContent><TabsContent value='privacy'><div className='settings-section'><div className='privacy-summary'><ShieldCheck size={29}/><div><h3>Private by design. Clear by default.</h3><p>You should know exactly where your conversations stand.</p></div></div><div className='privacy-fact'><CheckCircle2 /><span><strong>Access is checked on every request</strong><p>{label("Private Guilds and DMs are limited to their members. Your Matrix homeserver enforces membership, permissions, and account access.")}</p></span></div><div className='privacy-fact'><CheckCircle2 /><span><strong>No advertising or tracking scripts</strong><p>Tavern does not load third-party embeds or link previews.</p></span></div><div className='privacy-fact'><Info /><span><strong>Encryption is shown for every room</strong><p>New rooms use Matrix end-to-end encryption, including files. Existing unencrypted rooms are labeled. Membership, timing, room names, and some other metadata remain visible to your homeserver.</p></span></div><div className='privacy-fact'><Info /><span><strong>You control your messages</strong><p>Edit or redact your messages, and export loaded history. Redaction does not delete others’ copies or existing backups. Bookmarks and preferences are stored as account data visible to your homeserver.</p></span></div><button className='secondary-button' onClick={() => exportMatrixMessages().catch(e => toast.error(e.message))}><Download size={16}/>Export my loaded messages</button><div className='setting-row'><span><strong>Share typing activity</strong><small>Let conversation members see when you are typing. Off by default.</small></span><Switch aria-label='Share typing activity' checked={prefs.typing} onCheckedChange={typing => updatePrefs({ typing })}/></div>{!data?.preview && <SecurityCenter />}<DeviceManager /><div className='key-management'><h3>Encryption keys</h3><p>Use an encrypted file as an additional offline backup, or import an export from Tavern or Element. Automatic recovery uses the encrypted backup configured above.</p><label>Key export passphrase<input type='password' value={keyPassword} onChange={e => setKeyPassword(e.target.value)} placeholder='At least 12 characters for export'/></label><div><button className='secondary-button' onClick={() => exportEncryptionKeys(keyPassword).then(() => toast.success('Encrypted key export downloaded')).catch(e => toast.error(e.message))}><Download size={15}/>Export keys</button><button className='secondary-button' onClick={() => keyInput.current?.click()}>Import keys</button><input type='file' className='sr-only' ref={keyInput} onChange={e => { const f = e.target.files?.[0]; if (f)
        importEncryptionKeys(f, keyPassword).then(() => { toast.success('Keys imported'); setKeyPassword(''); }).catch(e => toast.error(e.message)); e.target.value = ''; }}/></div></div><div className='matrix-session'>Session: {matrixStatus().userId || 'Not connected'}<br />Device: {matrixStatus().deviceId || '—'}<br />Sign-in credentials are stored in this tab’s session storage; encryption keys are in this browser’s IndexedDB. Use Sign out to revoke the server session.</div></div></TabsContent><TabsContent value='workspace'><form className='dialog-form' onSubmit={async (e) => { e.preventDefault(); try {
        await api('workspace', { name: workspaceName });
        await loadBootstrap();
        toast.success('Workspace updated');
    }
    catch (e) {
        toast.error((e as Error).message);
    } }}><label>Workspace label<input value={workspaceName} onChange={e => setWorkspaceName(e.target.value)} maxLength={60} disabled={!!data?.preview} required/></label><div className='notice'><LockKeyhole size={19}/><p>This label is your personal name for this homeserver. Each Matrix room has its own membership and permissions. New Tavern rooms are encrypted and invite-only.</p></div><button className='primary-button' disabled={!!data?.preview}>Save Tavern label</button><button type='button' className='secondary-button' onClick={() => setModal('invite')}><Users size={16}/>Invite members</button></form></TabsContent><TabsContent value='about'><div className='settings-section about-tavern'><span className='about-logo'><Beer size={36}/></span><h2>Tavern <span>0.3</span></h2><p>A home for your conversations.</p><div className='release-note'><strong>Working in this release</strong><p>Encrypted messaging, servers and channels, threads, files, verified identities, recovery, calls, conferences, tasks, notes, polls, notifications, and self-hosted webhooks.</p></div><div className='release-note'><strong>Up next</strong><p>Persistent voice channels, guest meetings, advanced roles, full-history indexing, SSO, mobile push, and broader app integrations.</p></div><small>Powered by the Matrix protocol and matrix-js-sdk. Live sync comes directly from your homeserver. Search covers decrypted history loaded on this device. Full product parity and live deployment acceptance remain incomplete. This release has not been independently security audited.</small></div></TabsContent></Tabs>}
 </DialogContent></Dialog>
 <Sheet open={!!thread} onOpenChange={v => { if (!v)
        setThread(null); }}><SheetContent className='thread-sheet'><SheetHeader><SheetTitle>Thread <span>#{thread?.conversation_name}</span></SheetTitle><SheetDescription>Keep this conversation together.</SheetDescription></SheetHeader><div className='thread-scroll'>{thread && messageCard(thread, true)}<div className='date-divider'><span>{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span></div>{replies.map(m => messageCard(m, true))}{!replies.length && <p className='thread-empty'>Be the first to reply.</p>}</div>{thread && <Composer shareTyping={prefs.typing&&!prefs.focus} key={(me?.id||'preview')+':'+thread.id} conversation={thread.conversation_id} parent={thread.id} name='this thread' members={data?.members || []} onSent={async () => { const r = await api('messages', undefined, { conversation: thread.conversation_id, parent: thread.id }); setReplies(r.messages); loadMessages(true); }}/>}</SheetContent></Sheet>
 <Sheet open={detail} onOpenChange={setDetail}><SheetContent className='detail-sheet'><SheetHeader><SheetTitle>{active?.kind === 'private' ? <LockKeyhole /> : <Hash />}{name}</SheetTitle><SheetDescription>About this conversation</SheetDescription></SheetHeader><div className='detail-content'><h3>Description</h3><p>{active?.description || 'A private conversation for the people here.'}</p><h3>Who can see this?</h3><div className='notice'><LockKeyhole size={20}/><p>{active?.kind === 'channel' ? 'The Matrix room’s membership and power levels determine who can read and post here.' : 'Only the members in this conversation can read and post here.'}</p></div><div className='setting-row'><span><strong>Mute this conversation</strong><small>Hide unread badges in the sidebar.</small></span><Switch aria-label='Mute conversation' checked={muted} onCheckedChange={() => updatePrefs({ muted: muted ? prefs.muted.filter(c => c !== channel) : [...prefs.muted, channel] })}/></div><RoomPermissions key={channel+':permissions'} roomId={channel}/><ChannelAdmin key={channel} roomId={channel} onChanged={loadBootstrap}/><h3>Members</h3>{channelMembers.map(m => <div className='member-row' key={m.id}><Avatar name={m.name} size='small'/><span><strong>{m.name}</strong><small>{m.role}</small></span></div>)}</div></SheetContent></Sheet>
 <Dialog open={!!editing} onOpenChange={v => { if (!v)
        setEditing(null); }}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>Edit message</DialogTitle><DialogDescription>Your message will be marked as edited.</DialogDescription></DialogHeader><textarea className='edit-input' value={editBody} onChange={e => setEditBody(e.target.value)} maxLength={8000}/><button className='primary-button' disabled={!editBody.trim()} onClick={() => act('edit', { id: editing?.id, body: editBody }).then(() => setEditing(null)).catch(() => { })}>Save changes</button></DialogContent></Dialog>
 <AlertDialog open={!!deleting} onOpenChange={v => { if (!v)
        setDeleting(null); }}><AlertDialogContent className='tavern-dialog'><AlertDialogHeader><AlertDialogTitle>Delete this message?</AlertDialogTitle><AlertDialogDescription>This requests a Matrix redaction. Thread replies remain, and recipients or backups may retain copies. Redaction cannot be undone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep message</AlertDialogCancel><AlertDialogAction className='delete-confirm' onClick={() => act('delete', { id: deleting?.id }).then(() => { if (thread?.id === deleting?.id)
        setThread(null); setDeleting(null); }).catch(() => { })}>Delete message</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
 </>;
}
function Composer({ conversation, parent, name, members, onSent, disabled = false, shareTyping = false }: {
    conversation: string;
    parent?: string;
    name: string;
    members: Member[];
    onSent: () => Promise<any>;
    disabled?: boolean;
    shareTyping?: boolean;
}) {
    const draftKey = (getMatrixClient()?.getUserId() || 'preview') + '|' + conversation + '|' + (parent || '');
    const lastTyping = useRef(0), typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => { clearTimeout(typingTimer.current); if (shareTyping)
        sendMatrixTyping(conversation, false).catch(() => { }); }, [conversation, shareTyping]);
    const [draft, setDraft] = useState(() => memoryDrafts.get(draftKey) || ''), [files, setFiles] = useState<Attachment[]>([]), [sending, setSending] = useState(false), [uploading, setUploading] = useState(false), [emojis, setEmojis] = useState(false);
    const input = useRef<HTMLTextAreaElement>(null), upload = useRef<HTMLInputElement>(null), nonce = useRef<string | null>(null);
    function change(value: string) { setDraft(value); memoryDrafts.set(draftKey, value); nonce.current = null; if (shareTyping && !disabled) {
        clearTimeout(typingTimer.current);
        if (Date.now() - lastTyping.current > 10000 || !value) {
            lastTyping.current = Date.now();
            sendMatrixTyping(conversation, !!value).catch(() => { });
        }
        typingTimer.current = setTimeout(() => { lastTyping.current = 0; sendMatrixTyping(conversation, false).catch(() => { }); }, 4000);
    } }
    async function send() { if (disabled || sending || uploading || (!draft.trim() && !files.length))
        return; setSending(true); nonce.current ??= crypto.randomUUID(); try {
        await api('send', { conversation, parent, body: draft, attachments: files.map(f => f.id), nonce: nonce.current });
        setDraft('');
        memoryDrafts.delete(draftKey);
        clearTimeout(typingTimer.current);
        if (shareTyping)
            sendMatrixTyping(conversation, false).catch(() => { });
        setFiles([]);
        nonce.current = null;
        await onSent();
        input.current?.focus();
    }
    catch (e) {
        toast.error((e as Error).message);
    }
    finally {
        setSending(false);
    } }
    async function attach(list: FileList | null) { if (disabled || !list)
        return; if (files.length + list.length > 5) {
        toast.error('Attach up to five files at a time.');
        return;
    } setUploading(true); for (const f of Array.from(list)) {
        if (f.size > 10 * 1024 * 1024) {
            toast.error(f.name + ' is larger than 10 MB.');
            continue;
        }
        try {
            const attachment = await uploadMatrixFile(f, conversation);
            setFiles(fs => [...fs, attachment]);
            nonce.current = null;
        }
        catch (e) {
            toast.error((e as Error).message);
        }
    } setUploading(false); if (upload.current)
        upload.current.value = ''; }
    return <div className='composer-wrap'><div className='composer' onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!disabled && !sending && !uploading)
        attach(e.dataTransfer.files); }}>{files.length > 0 && <div className='pending-files'>{files.map(f => <span key={f.id}><FileText size={15}/>{f.name}<button aria-label={'Remove ' + f.name} disabled={sending} onClick={() => { setFiles(fs => fs.filter(x => x.id !== f.id)); nonce.current = null; }}><X size={13}/></button></span>)}</div>}<textarea ref={input} aria-label={'Message ' + name} placeholder={parent ? 'Reply to this thread…' : `Message ${name === 'Notes to self' ? 'yourself' : '#' + name}`} value={draft} onChange={e => change(e.target.value)} maxLength={8000} disabled={disabled || sending} rows={2} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        send();
    } }}/><div className='composer-toolbar'><div className='composer-tools'><input className='sr-only' type='file' ref={upload} multiple onChange={e => attach(e.target.files)} tabIndex={-1}/><IconButton label='Attach files (up to 10 MB each)' disabled={disabled || sending || uploading} onClick={() => upload.current?.click()}>{uploading ? <Loader2 size={18} className='spin'/> : <Plus size={21}/>}</IconButton><span className='tool-divider'/><IconButton label='Bold text' onClick={() => { change(draft + '**bold text**'); input.current?.focus(); }}><strong className='bold-icon'>B</strong></IconButton><IconButton label='Code formatting' onClick={() => { change(draft + '`code`'); input.current?.focus(); }}><Code2 size={18}/></IconButton><DropdownMenu open={emojis} onOpenChange={setEmojis}><DropdownMenuTrigger asChild><button className='icon-button' aria-label='Insert emoji'><Smile size={19}/></button></DropdownMenuTrigger><DropdownMenuContent className='emoji-menu'>{['👋', '😊', '🎉', '❤️', '👍', '🚀', '✅', '💡'].map(e => <DropdownMenuItem key={e} onSelect={() => { change(draft + e); input.current?.focus(); }}>{e}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu><DropdownMenu><DropdownMenuTrigger asChild><button className='icon-button' aria-label='Mention a member'><AtSign size={19}/></button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onSelect={() => change(draft + '@everyone ')}>@everyone</DropdownMenuItem>{members.map(m => <DropdownMenuItem key={m.id} onSelect={() => { change(draft + '@' + m.name + ' '); input.current?.focus(); }}>{m.name}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div><div className='send-controls'>{draft.length > 7500 && <small>{8000 - draft.length}</small>}<button className='send-button' aria-label='Send message' onClick={send} disabled={disabled || sending || uploading || (!draft.trim() && !files.length)}>{sending ? <Loader2 size={17} className='spin'/> : <Send size={17}/>}<ChevronDown size={13}/></button></div></div></div></div>;
}
