import { type Config, VOICE_LABELS } from './config';
import { voicesFor } from './speech-presets';
import { t, languageOf } from './locale';

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function setupForm(config: Config, key: string, savedToken: boolean): string {
  const h = escapeHtml;
  const field = (label: string, control: string, hint = '') => `<label>${h(t(label))}${control}${hint ? `<small>${h(t(hint))}</small>` : ''}</label>`;
  const input = (name: string, value: string, extra = '') => `<input name="${name}" value="${h(value)}" ${extra}>`;
  const locale = languageOf(config.locale);
  const voice = config.speechAdapter ? input('voice', config.voice, 'required')
    : `<select name="voice">${voicesFor(config.speechLanguage).map(v => `<option value="${v}" ${v === config.voice ? 'selected' : ''}>${h(VOICE_LABELS[v] ? t(VOICE_LABELS[v]!) : v)}</option>`).join('')}</select>`;
  return `<h1>Discord Voice Companion</h1>
<nav><a href="?locale=en" lang="en" ${locale === 'en' ? 'aria-current="true"' : ''}>English</a> · <a href="?locale=ru" lang="ru" ${locale === 'ru' ? 'aria-current="true"' : ''}>Русский</a></nav>
<p>${h(t('Set up your bot, then invite it to your server.'))}</p>
<p>${h(t('Create a bot in Discord Developer Portal and copy its bot token.'))} <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Discord Developer Portal</a></p>
<form method="post"><input type="hidden" name="csrf" value="${key}"><input type="hidden" name="locale" value="${h(config.locale)}">
${field('Discord bot token', `<input name="token" type="password" autocomplete="off" placeholder="${h(t(savedToken ? 'Saved; leave blank to keep it' : 'Bot token'))}">`, 'Stored on this computer; never sent to chat or written to logs.')}
${field('Server ID', input('guild', config.allowedGuildIds[0] ?? '', 'required inputmode="numeric"'))}
${field('Controller user ID (optional)', input('owner', config.controllerUserIds[0] ?? '', 'inputmode="numeric"'), 'When set, joining, leaving and changing voices require this user or Manage Server. Voice participants can stop replies.')}
${field('Bot name', input('name', config.botName, 'maxlength="40" required'))}
${field('Voice', voice)}
${field('Inference model (optional)', input('model', config.model), 'Use bun run models to see your account’s models. Leave blank to choose automatically.')}
<details><summary>${h(t('Conversation and network settings'))}</summary>
${field('Recognition language', input('speechLanguage', config.speechLanguage, 'required'), 'Use a speech model that supports this language.')}
${field('Reply language', input('responseLanguage', config.responseLanguage, 'required maxlength="80"'), 'Use auto to follow the speaker, or enter a language name or code.')}
${field('Conversation preferences', input('additionalInstructions', config.additionalInstructions, 'maxlength="4000"'), 'Optional tone, vocabulary or pronunciation preferences.')}
${field('Proactive session tasks', `<input type="checkbox" name="tasks" ${config.taskTools ? 'checked' : ''}>`, 'Recurring reminders, activity reactions and silence fillers. Tasks disappear on /leave; generated contributions use model allowance.')}
${field('Save local findings', `<input type="checkbox" name="reports" ${config.reportTools ? 'checked' : ''}>`, 'Save summarized bot issues and feedback on this computer.')}
${field('Review findings in the background', `<input type="checkbox" name="backgroundReports" ${config.backgroundReports ? 'checked' : ''}>`, 'Uses the selected model and its allowance. Turn off to save findings without extra model calls.')}
${field('Proxy behavior', `<select name="networkMode"><option value="environment" ${config.networkMode === 'environment' ? 'selected' : ''}>${h(t('Use proxy environment variables'))}</option><option value="direct" ${config.networkMode === 'direct' ? 'selected' : ''}>${h(t('Direct connections'))}</option></select>`, 'Applies after restart. System proxy settings are not read. Local speech stays on this computer.')}
${field('Text channel ID (optional)', input('chatChannel', config.chatChannelId, 'inputmode="numeric"'), 'Defaults to the channel where you use /join. Chat retrieval can read other named channels when asked.')}
${field('Live chat context', `<input type="checkbox" name="chat" ${config.chatContext ? 'checked' : ''}>`, 'Enable Message Content Intent in Developer Portal first.')}
${field('On-demand chat retrieval', `<input type="checkbox" name="chatTools" ${config.chatTools ? 'checked' : ''}>`, 'Enable Message Content Intent and grant Read Message History. Selected older messages are sent to the model when asked; every listener needs channel access.')}
${field('Chat timezone', input('chatTimezone', config.chatTimezone, 'required maxlength="100"'), 'IANA timezone for dates such as yesterday, for example UTC or Europe/Moscow.')}
${field('Server directory', `<input type="checkbox" name="members" ${config.memberContext ? 'checked' : ''}>`, 'Enable Server Members Intent first. Full lists are limited to small servers.')}
${field('Published status and activities', `<input type="checkbox" name="presence" ${config.presenceContext ? 'checked' : ''}>`, 'Enable Presence Intent in Developer Portal first.')}
</details><button>${h(t('Save and open Discord'))}</button></form>
<p>${h(t('Enable Developer Mode in Discord to copy IDs. Change settings while the bot is stopped.'))}</p>`;
}
