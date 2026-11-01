import { t, translate, withLocale } from './locale';
import { Client, GatewayIntentBits, Events, SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType, Options, Routes, type ChatInputCommandInteraction, type GuildMember, type VoiceBasedChannel, type GuildTextBasedChannel } from 'discord.js';
import { VoiceConnectionStatus, EndBehaviorType, entersState, joinVoiceChannel, type VoiceConnection } from '@discordjs/voice';
import { Config, VOICE_LABELS, saveConfig, log, safeError } from './config';
import { voicesFor } from './speech-presets';
import { RoomController } from './room';
import { UtteranceGate } from './audio';
import type { Brain, Member } from './llm';
import { TaskQueue } from './queue';
import type { SpeechServices } from './speech';
import { DiscordPlayer } from './playback';
import { LiveOpusDecoder } from './live-decoder';
import { LiveVad } from './live-vad';
import { latency, diagnosticsEnabled, diagnosticFileStatus } from './telemetry';
import { voiceSnapshot } from './voice-diagnostics';
import { safeName, safeText } from './tool-safety';
import { visiblePresence, presenceDiagnostics } from './presence';
import { MemberDirectory } from './member-directory';
import { ChatRetrieval } from './chat-retrieval';
import type { Reporting } from './reporting';

interface Receiver { gate: UtteranceGate; decoder?: LiveOpusDecoder; vad?: LiveVad; destroy(): void }
interface Session { channel: VoiceBasedChannel; chat?: GuildTextBasedChannel; startedAt: number; controller: RoomController; player: DiscordPlayer; connection: VoiceConnection; receivers: Map<string, Receiver>; notice: (text: string) => void; emptyAt?: number; lastDiagnosticsAt?: number; presenceDiagnostics?: Map<string, string> }

const privilegedContexts = [
  { key: 'memberContext', intent: GatewayIntentBits.GuildMembers, label: 'Server Members Intent' },
  { key: 'presenceContext', intent: GatewayIntentBits.GuildPresences, label: 'Presence Intent' },
  { key: 'chatContext', intent: GatewayIntentBits.MessageContent, label: 'Message Content Intent' },
  { key: 'chatTools', intent: GatewayIntentBits.MessageContent, label: 'Message Content Intent' },
] as const;

export async function sendRoomMessage(client: Pick<Client, 'rest'>, channel: GuildTextBasedChannel | undefined, bot: GuildMember,
  actor: string, text: string, mentions: string[], signal: AbortSignal, authorized: () => boolean, textLimit = 500) {
  signal.throwIfAborted();
  if (!authorized() || !channel?.isSendable() || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) || mentions.length > 2
    || !channel.permissionsFor(actor)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
    || !channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
    || mentions.some(id => !channel.permissionsFor(id)?.has(PermissionFlagsBits.ViewChannel))) throw new Error(t("Message destination unavailable."));
  const clean = safeText(text, Math.min(1800, textLimit));
  if (!clean) throw new Error(t("Empty message."));
  signal.throwIfAborted();
  // An abortable queue entry and enforced nonce also cover Discord's internal
  // rate-limit queue/retries. There is no application-level resend on failure.
  await client.rest.post(Routes.channelMessages(channel.id), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    body: { content: `${mentions.map(id => `<@${id}>`).join(' ')} ${clean}`.trim(),
      allowed_mentions: { parse: [], users: mentions, replied_user: false }, flags: MessageFlags.SuppressEmbeds,
      nonce: crypto.randomUUID().replaceAll('-', '').slice(0, 24), enforce_nonce: true },
  });
}

export function roomCommands(config: Config) {
  return withLocale('en', () => [
    new SlashCommandBuilder().setName('join').setDescription(t("Join your voice channel")),
    new SlashCommandBuilder().setName('leave').setDescription(t("Disconnect from voice")),
    new SlashCommandBuilder().setName('stop').setDescription(t("Stop the current reply")),
    new SlashCommandBuilder().setName('pause').setDescription(t("Pause recognition and replies")),
    new SlashCommandBuilder().setName('resume').setDescription(t("Resume the conversation")),
    new SlashCommandBuilder().setName('status').setDescription(t("Show room state and speech queues")),
    new SlashCommandBuilder().setName('tasks').setDescription(t('Manage tasks for this voice session'))
      .addStringOption(o => o.setName('action').setDescription(t('Task action')).addChoices(
        ...['list', 'pause', 'resume', 'cancel'].map(value => ({ name: value, value }))))
      .addStringOption(o => o.setName('id').setDescription(t('Task identifier')).setMaxLength(12)),
    new SlashCommandBuilder().setName('name').setDescription(t("Set your preferred name"))
      .addStringOption(o => o.setName('name').setDescription(t("Your preferred name")).setRequired(true).setMaxLength(40))
      .addStringOption(o => o.setName('pronunciation').setDescription(t("Optional phonetic spelling for the selected speech model")).setMaxLength(60)),
    new SlashCommandBuilder().setName('voice').setDescription(t("Choose a voice supported by your speech adapter"))
      .addStringOption(o => {
        o.setName('voice').setDescription(t("Voice identifier")).setRequired(true).setMaxLength(100);
        const voices = voicesFor(config.speechLanguage);
        // Discord permits at most 25 choices; larger voice catalogs accept a voice ID.
        return config.speechAdapter || voices.length > 25 ? o : o.addChoices(...voices.map(value => ({ name: VOICE_LABELS[value] ?? value, name_localizations: { ru: translate('ru', VOICE_LABELS[value] ?? value) }, value })));
      }),
  ].map(c => {
    const names: Record<string, string> = { join: 'войти', leave: 'выйти', stop: 'стоп', pause: 'пауза', resume: 'продолжить', status: 'статус', tasks: 'задачи', name: 'имя', voice: 'голос' };
    const command = c.setNameLocalizations({ ru: names[c.name]! }).setDescriptionLocalizations({ ru: translate('ru', c.description) }).setDMPermission(false).toJSON();
    for (const option of command.options ?? []) option.description_localizations = { ru: translate('ru', option.description) };
    return command;
  }));
}

export class DiscordBot {
  private t = (message: string, ...values: unknown[]) => translate(this.config.locale, message, ...values);
  readonly client: Client;
  readonly sessions = new Map<string, Session>();
  readonly queue: TaskQueue;
  private housekeeping?: ReturnType<typeof setInterval>;
  private lastMaintenanceAt = 0;
  private toolLimits = new Map<string, number>();
  constructor(readonly config: Config, readonly brain: Brain, readonly speech: SpeechServices, readonly reporting?: Reporting) {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates,
      ...privilegedContexts.filter(context => config[context.key]).map(context => context.intent),
      ...(config.chatContext ? [GatewayIntentBits.GuildMessages] : [])],
      // Live messages only; never retain a Discord message-history cache.
      makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0 }) });
    this.queue = new TaskQueue(config.maxSttQueue);
    this.client.on(Events.Error, error => log(safeError(this.gatewayError(error))));
    this.client.on(Events.ShardError, error => log(this.t("Discord gateway: {0}", safeError(this.gatewayError(error)))));
    this.client.on(Events.InteractionCreate, i => { if (i.isChatInputCommand()) void withLocale(config.locale, () => this.command(i).catch(error => this.commandError(i, error))); });
    this.client.on(Events.PresenceUpdate, (_old, presence) => {
      const session = presence.guild && this.sessions.get(presence.guild.id);
      const person = presence.member;
      if (session && person && session.controller.members.has(person.id)) this.updateState(session, person);
    });
    this.client.on(Events.MessageCreate, message => {
      if (!config.chatContext || !message.guildId || message.author.bot || message.webhookId) return;
      const session = this.sessions.get(message.guildId);
      if (!session || message.channelId !== session.chat?.id || message.createdTimestamp < session.startedAt) return;
      // A channel visible to the bot must also be visible to the receiving room.
      if ([...session.controller.members.keys()].some(id => !session.chat!.permissionsFor(id)?.has(PermissionFlagsBits.ViewChannel))) return;
      const person = message.member ? this.member(message.member) : { id: message.author.id, name: safeName(config.preferredNames[message.author.id] ?? message.author.displayName) };
      session.controller.chat(person, message.cleanContent, message.createdTimestamp);
    });
    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      const session = this.sessions.get(newState.guild.id);
      if (!session) return;
      if (newState.id === this.client.user?.id) {
        if (newState.channelId !== session.channel.id || newState.serverDeaf || newState.serverMute) {
          session.notice(this.t("Bot moved, disconnected or muted by an administrator. Session stopped; use /join after resolving it."));
          this.leave(newState.guild.id);
        }
        return;
      }
      if (oldState.channelId === session.channel.id && newState.channelId !== session.channel.id) {
        session.receivers.get(newState.id)?.destroy(); session.receivers.delete(newState.id);
        session.controller.removeMember(newState.id);
      }
      if (newState.channelId === session.channel.id && newState.member && !newState.member.user.bot) this.attach(session, newState.member);
    });
  }
  private gatewayError(error: unknown): unknown {
    if (!(error instanceof Error) || (error.message !== 'Used disallowed intents'
      && !('code' in error && error.code === 'DisallowedIntents'))) return error;
    const requested = privilegedContexts.filter(context => this.config[context.key] && this.client.options.intents.has(context.intent));
    return new Error(this.t('Discord rejected the connection (4014, Used disallowed intents): a requested privileged intent is disabled or not approved. Open https://discord.com/developers/applications → your application → Bot → Privileged Gateway Intents. {0} Enable the required switches and save, or disable the corresponding features in config.json: {1}. Run bun start again.',
      requested.map(context => `${context.label} (${context.key})`).join('; '), requested.map(context => `"${context.key}": false`).join(', ')), { cause: error });
  }
  async start(token: string) {
    if (!this.config.allowedGuildIds.length) throw new Error(this.t("Set an allowed Discord server ID with bun run configure."));
    const ready = new Promise<void>(resolveReady => this.client.once(Events.ClientReady, () => resolveReady()));
    log(this.t("Connecting to Discord..."));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => { await this.client.login(token); await ready; })(),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error(this.t("Discord did not connect within 45 seconds. Check gateway.discord.gg connectivity and proxy configuration."))), 45000); }),
      ]);
    } catch (error) { await this.client.destroy(); throw this.gatewayError(error); }
    finally { clearTimeout(deadline); }
    for (const id of this.config.allowedGuildIds) {
      const guild = await this.client.guilds.fetch(id);
      await guild.commands.set(roomCommands(this.config));
      log(this.t("Commands registered: {0}.", guild.name));
    }
    this.housekeeping = setInterval(() => {
      if (Date.now() - this.lastMaintenanceAt >= 60000) {
        this.lastMaintenanceAt = Date.now();
        void this.brain.maintain?.().catch(error => log(this.t("Authorization maintenance: {0}", safeError(error))));
      }
      for (const [guildId, session] of this.sessions) {
        if (Date.now() - (session.lastDiagnosticsAt ?? 0) >= 30000) {
          session.lastDiagnosticsAt = Date.now();
          const received = [...session.receivers.values()].reduce((n, r) => n + (r.decoder?.metrics.received ?? 0), 0);
          log(this.t("Voice: {0}; packets {1}; active {2}; STT {3}/{4}; requests {5}; spoken {6}; stale {7}.", session.controller.phase, received, session.controller.activeSpeakers, session.controller.diagnostics.transcripts, session.controller.diagnostics.utterances, session.controller.diagnostics.modelCalls, session.controller.diagnostics.spokenReplies, session.controller.diagnostics.staleReplies));
          if (diagnosticsEnabled()) latency({ session: session.controller.sessionId, stage: 'room_health', phase: session.controller.phase,
            pendingSTT: session.controller.pendingSTT, modelCalls: session.controller.diagnostics.modelCalls,
            ...voiceSnapshot(session.connection), ...diagnosticFileStatus() });
          const detectors = [...session.receivers.values()].flatMap(receiver => receiver.vad ? [receiver.vad.metrics] : []);
          if (detectors.length) latency({ session: session.controller.sessionId, stage: 'live_vad', streams: detectors.length,
            batches: detectors.reduce((n, d) => n + d.batches, 0), droppedFrames: detectors.reduce((n, d) => n + d.dropped, 0),
            failures: detectors.reduce((n, d) => n + d.failures, 0), maxInferenceMs: Math.round(Math.max(...detectors.map(d => d.maxInferenceMs))),
            maxBufferedMs: Math.max(...detectors.map(d => d.maxBufferedMs)) });
        }
        if (session.controller.members.size) session.emptyAt = undefined;
        else {
          session.emptyAt ??= Date.now();
          if (Date.now() - session.emptyAt >= this.config.idleDisconnectMinutes * 60000) this.leave(guildId);
        }
      }
    }, 10000);
    log(this.t("Capabilities: chat={0}; presence={1}; messages={2}; reminders={3}; search={4}.", this.config.chatContext, this.config.presenceContext, this.config.messageTools, this.config.reminderTools, this.config.webSearch));
    log(this.t('Chat retrieval: {0}; timezone: {1}.', this.config.chatTools, this.config.chatTimezone));
    log(this.t("Bot {0} ready. Model: {1} ({2}). Use /join in Discord.", this.client.user?.tag, this.config.model, this.config.reasoningEffort));
  }
  private member(member: GuildMember): Member { return { id: member.id, name: safeName(this.config.preferredNames[member.id] ?? member.displayName) }; }
  private visibleActivity(member: GuildMember, session?: Session, source = 'state') {
    const presence = this.config.presenceContext ? member.presence : null;
    const summary = visiblePresence(presence);
    if (diagnosticsEnabled() && session) {
      const fields = presenceDiagnostics(presence, summary);
      const signature = JSON.stringify(fields);
      const observations = session.presenceDiagnostics ??= new Map();
      // A lookup is always measured. Repeated presence events with unchanged
      // types/availability need no extra log record or model request.
      if (source === 'lookup' || observations.get(member.id) !== signature) {
        latency({ session: session.controller.sessionId, stage: 'presence_observed', source,
          inVoice: session.controller.members.has(member.id), ...fields });
        observations.set(member.id, signature);
      }
    }
    return summary;
  }
  private updateState(session: Session, member: GuildMember) {
    const { status, activity } = this.visibleActivity(member, session);
    session.controller.setState({ userId: member.id, status, activity, muted: member.voice.mute ?? false, deafened: member.voice.deaf ?? false });
    if (this.config.presenceContext) session.controller.presence.update(member.id, member.presence, activity);
  }
  private attach(session: Session, member: GuildMember) {
    session.controller.setMember(this.member(member));
    this.updateState(session, member);
    if (session.receivers.has(member.id)) return;
    const receive = session.connection.receiver.subscribe(member.id, { end: { behavior: EndBehaviorType.Manual }, highWaterMark: 4 });
    const gate = new UtteranceGate({ silenceMs: this.config.utteranceSilenceMs, previewSilenceMs: this.config.earlyEndpointMs, minSpeechMs: this.config.minSpeechMs, maxMs: this.config.maxUtteranceMs, rms: this.config.speechRms },
      u => session.controller.ingest(this.member(member), u),
      (active, at) => session.controller.activity(member.id, active, at), Date.now,
      (u, accept) => session.controller.preview(this.member(member), u, accept));
    let disposed = false;
    let decoder: LiveOpusDecoder | undefined;
    let vad: LiveVad | undefined;
    try {
      if (this.config.liveVad && this.speech.vad) vad = new LiveVad(this.speech.vad.open(), (pcm, at, speech) => {
        if (session.controller.phase !== 'paused' && session.controller.phase !== 'closed') gate.push(pcm, at, speech);
      }, () => gate.discard());
    } catch (error) { session.notice(this.t("Using volume-based detection for one participant: {0}", safeError(error))); }
    let lastOverloadNotice = 0;
    const destroy = () => {
      if (disposed) return; disposed = true;
      vad?.close(); gate.close(); decoder?.destroy(); receive.destroy();
    };
    const failed = () => {
      if (disposed) return;
      destroy(); session.receivers.delete(member.id);
      session.notice(this.t("Recovered one participant stream after a decoding error."));
      setTimeout(() => { if (this.sessions.get(member.guild.id) === session && member.voice.channelId === session.channel.id) this.attach(session, member); }, 750);
    };
    receive.on('error', failed);
    receive.on('close', () => { if (!disposed) failed(); });
    decoder = new LiveOpusDecoder(receive, (pcm, at) => {
      if (session.controller.phase === 'paused' || session.controller.phase === 'closed') { vad?.discard(); gate.discard(); return; }
      if (vad) vad.push(pcm, at); else gate.push(pcm, at);
    }, failed, () => {
      vad?.discard(); gate.discard();
      if (Date.now() - lastOverloadNotice > 5000) {
        lastOverloadNotice = Date.now();
        session.notice(this.t("Incoming audio processing fell behind. Stale audio skipped; continuing with current speech."));
      }
    });
    session.receivers.set(member.id, { gate, decoder, vad, destroy });
  }
  private async join(i: ChatInputCommandInteraction, member: GuildMember) {
    const channel = member.voice.channel;
    if (!channel || channel.type !== 2) throw new Error(this.t("Join an ordinary server voice channel first. Stage channels are not supported."));
    const previous = this.sessions.get(member.guild.id);
    if (previous && previous.channel.id !== channel.id && !this.isController(member)) throw new Error(this.t("Bot is already in another channel. Only a controller or administrator can move it."));
    if (previous?.channel.id === channel.id) return;
    const me = await member.guild.members.fetchMe();
    const permissions = channel.permissionsFor(me);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) throw new Error(this.t("Bot needs View Channel, Connect and Speak permissions."));
    this.leave(member.guild.id);
    const player = new DiscordPlayer({ network: () => ({ ...voiceSnapshot(connection),
      serverMuted: me.voice.serverMute, selfMuted: me.voice.selfMute, suppressed: me.voice.suppress }) });
    const selected = this.config.chatChannelId ? await member.guild.channels.fetch(this.config.chatChannelId) : i.channel;
    const noticeChannel = selected?.isSendable() ? selected : undefined;
    // Bind tools/context to an ordinary guild text channel. Threads and voice
    // chats have additional membership/connect rules beyond ViewChannel.
    const textChannel = selected && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(selected.type) ? selected as GuildTextBasedChannel : undefined;
    const notice = (text: string) => {
      log(text);
      if (noticeChannel?.isSendable()) void noticeChannel.send({ content: text.slice(0, 1900), allowedMentions: { parse: [] } }).catch(() => {});
    };
    const controller: RoomController = new RoomController(this.config, this.brain, this.speech, this.speech, player, this.queue, notice, {
      reporting: this.reporting,
      canUseContext: () => !this.config.chatContext || !textChannel || [...controller.members.keys()].every(id => textChannel.permissionsFor(id)?.has(PermissionFlagsBits.ViewChannel)),
      tools: {
        limits: this.toolLimits,
        chat: this.config.chatTools ? {
          query: (...args) => retrieval.query(...args), continuationOwner: (...args) => retrieval.continuationOwner(...args),
          cancel: () => retrieval.cancel(), onSpeech: event => retrieval.onSpeech(event), canUseContext: () => retrieval.canUseContext(),
        } : undefined,
        privateTerms: () => [...member.guild.members.cache.values()].filter(p => !p.user.bot)
          .flatMap(p => [this.member(p).name, p.displayName, p.nickname, p.user.username, p.user.globalName].filter((s): s is string => !!s)),
        members: (query, signal) => directory.query(query, signal),
        resolveMember: (reference, signal) => directory.resolve(reference, signal),
        resolvePerson: reference => {
          const id = this.brain.resolveUser?.(controller.sessionId, reference);
          if (id) { const person = member.guild.members.cache.get(id); return person && !person.user.bot ? this.member(person) : undefined; }
          if (/^\d{15,22}$/.test(reference)) return;
          const normalized = (s: string) => s.toLowerCase().replaceAll('ё', 'е').replaceAll('+', '');
          const matches = [...member.guild.members.cache.values()].filter(p => !p.user.bot && normalized(this.member(p).name) === normalized(reference));
          return matches.length === 1 ? this.member(matches[0]!) : undefined;
        },
        activity: person => {
          const cached = member.guild.members.cache.get(person.id);
          return cached ? this.visibleActivity(cached, session, 'lookup') : { status: 'unknown', activity: '', presenceAvailable: false };
        },
        sendMessage: async (actor, text, mentions, signal) => {
          await sendRoomMessage(this.client, textChannel, me, actor, text, mentions, signal,
            () => this.sessions.get(member.guild.id)?.controller === controller && controller.members.has(actor));
        },
      },
    });
    const directory = new MemberDirectory(member.guild, this.config, {
      resolve: ref => this.brain.resolveUser?.(controller.sessionId, ref),
      reference: id => {
        const ref = this.brain.referenceUser?.(controller.sessionId, id);
        if (!ref) throw new Error(this.t("Session context unavailable."));
        return ref;
      },
    }, { channel, audience: () => [...controller.members.keys()], presence: p => this.visibleActivity(p, session, 'lookup') });
    const retrieval = new ChatRetrieval(member.guild, this.config, {
      defaultChannel: textChannel?.id, audience: () => [...controller.members.keys()],
      active: () => this.sessions.get(member.guild.id)?.controller === controller && controller.phase !== 'closed',
      resolve: (ref, signal) => directory.resolve(ref, signal),
      reference: id => {
        const ref = this.brain.referenceUser?.(controller.sessionId, id);
        if (!ref) throw new Error(this.t('Session context unavailable.'));
        return ref;
      },
    }, this.toolLimits);
    const connection = joinVoiceChannel({ channelId: channel.id, guildId: member.guild.id, adapterCreator: member.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
    const session: Session = { channel, chat: textChannel, startedAt: Date.now(), controller, player, connection, receivers: new Map(), notice };
    connection.on('stateChange', (oldState, newState) => {
      if (diagnosticsEnabled()) latency({ session: controller.sessionId, stage: 'voice_state', from: oldState.status, to: newState.status, ...voiceSnapshot(connection) });
    });
    this.sessions.set(member.guild.id, session);
    connection.on('error', error => { notice(`Voice connection: ${safeError(error)}`); });
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      const resumeAfterReconnect = controller.phase !== 'paused';
      controller.pause();
      try {
        await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5000), entersState(connection, VoiceConnectionStatus.Connecting, 5000)]);
        await entersState(connection, VoiceConnectionStatus.Ready, 20000);
        if (this.sessions.get(member.guild.id) !== session) return;
        for (const receiver of session.receivers.values()) receiver.destroy();
        session.receivers.clear();
        for (const id of controller.members.keys()) if (!channel.members.has(id)) controller.removeMember(id);
        for (const person of channel.members.values()) if (!person.user.bot) this.attach(session, person);
        if (resumeAfterReconnect) controller.resume();
      } catch { if (this.sessions.get(member.guild.id) === session) { notice('Voice connection lost. Use /join.'); this.leave(member.guild.id); } }
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30000);
      connection.subscribe(player.audio);
      if (diagnosticsEnabled()) latency({ session: controller.sessionId, stage: 'voice_subscribed', ...voiceSnapshot(connection) });
      for (const person of channel.members.values()) if (!person.user.bot) this.attach(session, person);
      log(this.t("Voice connection ready."));
    } catch (error) { this.leave(member.guild.id); throw error; }
  }
  private isController(member: GuildMember) { return member.permissions.has(PermissionFlagsBits.ManageGuild) || this.config.controllerUserIds.includes(member.id); }
  private async command(i: ChatInputCommandInteraction) {
    if (!i.guildId || !this.config.allowedGuildIds.includes(i.guildId)) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await i.guild!.members.fetch(i.user.id);
    const session = this.sessions.get(i.guildId);
    if (i.commandName !== 'join' && session && member.voice.channelId !== session.channel.id && !this.isController(member)) throw new Error(this.t("This command requires membership in the current voice channel."));
    if (this.config.controllerUserIds.length && ['join', 'leave', 'voice'].includes(i.commandName) && !this.isController(member)) throw new Error(this.t("This command requires a controller or administrator."));
    switch (i.commandName) {
      case 'join': await this.join(i, member); await i.editReply(this.t("Connected. Listening to your voice channel.")); break;
      case 'leave': this.leave(i.guildId); await i.editReply(this.t("Disconnected.")); break;
      case 'stop': session?.controller.stop(); await i.editReply(this.t("Reply stopped.")); break;
      case 'pause': session?.controller.pause(); for (const r of session?.receivers.values() ?? []) r.gate.flush(); await i.editReply(this.t("Recognition and replies paused.")); break;
      case 'resume': session?.controller.resume(); await i.editReply(this.t("Conversation resumed.")); break;
      case 'tasks': {
        if (!session) { await i.editReply(this.t('No tasks in this session.')); break; }
        const action = i.options.getString('action') ?? 'list';
        if (action === 'list') {
          const tasks = session.controller.tasks.list();
          const text = tasks.map(task => `${task.id}: ${task.intent} (${task.state}, ${task.pendingRuns})`).join('\n');
          await i.editReply({ content: text.slice(0, 1800) || this.t('No tasks in this session.'), allowedMentions: { parse: [] } });
        } else {
          const id = i.options.getString('id');
          if (!id || !['pause', 'resume', 'cancel'].includes(action)) throw new Error(this.t('Specify a task identifier.'));
          const ok = session.controller.manageTask(member.id, id, action as 'pause' | 'resume' | 'cancel');
          await i.editReply(ok ? this.t('Task updated: {0}.', id) : this.t('Unknown task: {0}.', id));
        }
        break;
      }
      case 'status': {
        const states = { idle: 'listening', thinking: 'thinking', synthesizing: 'synthesizing', ready: 'waiting for a pause', speaking: 'speaking', paused: 'paused', closed: 'disconnected' };
        const metrics = [...session?.receivers.values() ?? []].map(r => r.decoder?.metrics).filter(m => m !== undefined);
        const dropped = metrics.reduce((n, m) => n + m.dropped, 0);
        const maxAge = Math.max(0, ...metrics.map(m => m.maxQueueAgeMs));
        const context = session?.controller.contextMetrics;
        const contextStatus = context ? this.t("Context: {0} input tokens, {1} cached; last addition {2} characters. Append-only history. Completed requests: {3}; total input {4}, cached {5}, output {6}. Incomplete requests may consume allowance without reported usage.", context.lastInputTokens ?? '—', context.lastCachedTokens ?? '—', context.appendedChars, context.calls, context.totalInputTokens, context.totalCachedTokens, context.totalOutputTokens) : this.t("Context: no requests yet.");
        const d = session?.controller.diagnostics;
        const received = metrics.reduce((n, m) => n + m.received, 0);
        const progress = session && d ? this.t("\nModel: {0}. Packets: {1}; active speakers: {2}; transcripts {3}/{4}; spoken {5}, silent {6}, stale {7}. STT {8} ms, model {9} ms; first text {10} ms from request; first audio {11} ms after utterance. Streaming: {12}.\nEarly endpoints {13}; local replies {14}; thinking cues {15}; backchannels {16}; revisions {17}; yielded {18}; withheld {19}.{20}", this.config.model, received, session.controller.activeSpeakers, d.transcripts, d.utterances, d.spokenReplies, d.modelPasses, d.staleReplies, d.lastSttMs, d.lastModelMs, d.lastFirstTextMs || '—', d.lastFirstAudioMs || '—', this.config.streamReplies, d.earlyEndpoints, d.localReplies, d.thinkingCues, d.backchannels, d.revisions, d.yieldedReplies, d.withheldReplies, d.lastError ? this.t(" Error: {0}", d.lastError) : '') : '';
        const capabilities = this.t("Directory: {0}. Chat context: {1}{2}. Presence: {3}. Messages: {4}; reminders: {5}; search: {6}.", this.config.memberContext, this.config.chatContext, session?.chat ? this.t(", channel #{0}", session.chat.name) : '', this.config.presenceContext, this.config.messageTools, this.config.reminderTools, this.config.webSearch);
        const retrievalStatus = this.t('Chat retrieval: {0}; timezone: {1}.', this.config.chatTools, this.config.chatTimezone);
        await i.editReply(session ? this.t("State: {0}. Participants: {1}. Pending STT: {2}, shared queue: {3}. Voice: {4}.\n{5}\nAudio: maximum incoming packet wait {6} ms; overload drops {7}; maximum playback lag {8} ms.\n{9}{10}", this.t(states[session.controller.phase]), session.controller.members.size, session.controller.pendingSTT, this.queue.length, (VOICE_LABELS[this.config.voice] ? this.t(VOICE_LABELS[this.config.voice]!) : this.config.voice), `${capabilities} ${retrievalStatus}`, Math.round(maxAge), dropped, Math.round(session.player.metrics.maxSchedulerLagMs), contextStatus, progress) : this.t("Not in a voice channel. Use /join.\n{0}", `${capabilities} ${retrievalStatus}`)); break;
      }
      case 'name': {
        const name = i.options.getString('name', true).trim();
        const pronunciation = i.options.getString('pronunciation')?.trim();
        if (!/^[\p{L}\p{M}\p{N} +_-]{1,40}$/u.test(name) || pronunciation && !/^[\p{L}\p{M} +_-]{1,60}$/u.test(pronunciation)) throw new Error(this.t("Use letters and spaces; + stress marks are supported by the bundled preset."));
        this.config.preferredNames[i.user.id] = name;
        if (pronunciation) this.config.pronunciations[name] = pronunciation;
        await saveConfig(this.config); session?.controller.setMember(this.member(member));
        await i.editReply(this.t("Preferred name: {0}.", name)); break;
      }
      case 'voice': this.config.voice = i.options.getString('voice', true); await saveConfig(this.config); await i.editReply(this.t("Selected voice: {0}.", (VOICE_LABELS[this.config.voice] ? this.t(VOICE_LABELS[this.config.voice]!) : this.config.voice))); break;
    }
  }
  private async commandError(i: ChatInputCommandInteraction, error: unknown) {
    log(safeError(error));
    const text = safeError(error);
    if (i.deferred || i.replied) await i.editReply(text).catch(() => {});
    else await i.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  leave(guildId: string) {
    const session = this.sessions.get(guildId);
    if (!session) return;
    this.sessions.delete(guildId);
    session.controller.close();
    for (const receiver of session.receivers.values()) receiver.destroy();
    session.connection.destroy();
  }
  pauseAll(reason: string) { for (const session of this.sessions.values()) { session.controller.pause(); session.notice(reason); } }
  async stop() { clearInterval(this.housekeeping); for (const id of [...this.sessions.keys()]) this.leave(id); await this.client.destroy(); await this.reporting?.close(); }
}
