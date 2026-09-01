import { google } from 'googleapis';
import { randomUUID } from 'crypto';
import { getAuthorizedClient } from './googleAuth.js';

export const SERVICE_TOOLS = {
  gmail: [
    { name: 'list_emails', label: 'Listar emails' },
    { name: 'read_email', label: 'Ler email' },
    { name: 'send_email', label: 'Enviar email' },
    { name: 'reply_email', label: 'Responder email' },
    { name: 'forward_email', label: 'Encaminhar email' },
    { name: 'delete_email', label: 'Apagar email' },
    { name: 'permanently_delete_email', label: 'Apagar email permanentemente' },
    { name: 'update_email_labels', label: 'Gerenciar marcadores de email' },
    { name: 'list_drafts', label: 'Listar rascunhos' },
    { name: 'create_draft', label: 'Criar rascunho' },
    { name: 'send_draft', label: 'Enviar rascunho' },
    { name: 'delete_draft', label: 'Apagar rascunho' },
  ],
  calendar: [
    { name: 'list_calendar_events', label: 'Ver agenda' },
    { name: 'get_calendar_event', label: 'Ver detalhes do evento' },
    { name: 'list_calendars', label: 'Listar agendas' },
    { name: 'create_calendar_event', label: 'Criar evento' },
    { name: 'update_calendar_event', label: 'Editar evento' },
    { name: 'delete_calendar_event', label: 'Apagar evento' },
    { name: 'respond_to_calendar_event', label: 'Responder convite' },
    { name: 'check_free_busy', label: 'Verificar disponibilidade' },
  ],
  drive: [
    { name: 'list_drive_files', label: 'Listar arquivos' },
    { name: 'read_drive_file', label: 'Ler arquivo' },
    { name: 'create_drive_file', label: 'Criar arquivo' },
    { name: 'update_drive_file', label: 'Editar arquivo' },
    { name: 'delete_drive_file', label: 'Apagar arquivo' },
    { name: 'create_drive_folder', label: 'Criar pasta' },
    { name: 'move_drive_file', label: 'Mover arquivo' },
    { name: 'copy_drive_file', label: 'Copiar arquivo' },
    { name: 'share_drive_file', label: 'Compartilhar arquivo' },
  ],
  playconsole: [
    { name: 'get_play_listing', label: 'Ver ficha da loja (Play Store)' },
    { name: 'update_play_listing', label: 'Publicar ficha da loja (Play Store)' },
    { name: 'list_play_reviews', label: 'Ver avaliações (Play Store)' },
    { name: 'reply_to_play_review', label: 'Responder avaliação (Play Store)' },
    { name: 'get_play_vitals', label: 'Ver métricas técnicas (Android vitals)' },
  ],
};

const MAX_CHARS = 4000;

function truncate(s) {
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n\n[...truncated]` : s;
}

async function requireClient(service, label) {
  const auth = await getAuthorizedClient(service);
  if (!auth) {
    const err = new Error(`${label} not connected — ask the user to connect it in Settings > Integrações first.`);
    err.notConnected = true;
    throw err;
  }
  return auth;
}

export function describeGoogleError(err) {
  if (err.notConnected) return err.message;
  const detail = err.response?.data?.error?.message || err.errors?.[0]?.message || err.message;
  return `Google API error: ${detail || 'unknown error'}`;
}

function header(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeBase64Url(data) {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function extractPlainTextBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainTextBody(part);
      if (text) return text;
    }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBase64Url(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

function buildRawMessage({ to, subject, body, cc, inReplyTo, references }) {
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${subject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].filter((l) => l !== null).join('\r\n');
  return Buffer.from(lines).toString('base64url');
}


export async function listEmails({ query, max_results }) {
  const auth = await requireClient('gmail', 'Gmail');
  const gmail = google.gmail({ version: 'v1', auth });
  const { data } = await gmail.users.messages.list({
    userId: 'me',
    q: query || undefined,
    maxResults: Math.min(max_results || 10, 20),
  });
  const messages = data.messages ?? [];
  if (messages.length === 0) return 'No emails found.';
  const details = await Promise.all(messages.map(async (m) => {
    const { data: msg } = await gmail.users.messages.get({
      userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'],
    });
    return {
      id: msg.id,
      from: header(msg.payload.headers, 'From'),
      subject: header(msg.payload.headers, 'Subject') || '(no subject)',
      date: header(msg.payload.headers, 'Date'),
      snippet: msg.snippet,
    };
  }));
  return truncate(
    details.map((d, i) => `[${i + 1}] id: ${d.id}\nFrom: ${d.from}\nSubject: ${d.subject}\nDate: ${d.date}\n${d.snippet}`).join('\n\n'),
  );
}

export async function readEmail({ email_id }) {
  if (!email_id) throw new Error('email_id is required.');
  const auth = await requireClient('gmail', 'Gmail');
  const gmail = google.gmail({ version: 'v1', auth });
  const { data: msg } = await gmail.users.messages.get({ userId: 'me', id: email_id, format: 'full' });
  const body = extractPlainTextBody(msg.payload) || msg.snippet || '(no readable content)';
  return truncate(
    `From: ${header(msg.payload.headers, 'From')}\nTo: ${header(msg.payload.headers, 'To')}\n`
    + `Subject: ${header(msg.payload.headers, 'Subject')}\nDate: ${header(msg.payload.headers, 'Date')}\n\n${body}`,
  );
}

export async function sendEmail({ to, subject, body, cc }) {
  if (!to || !subject || !body) throw new Error('to, subject and body are required.');
  const auth = await requireClient('gmail', 'Gmail');
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawMessage({ to, subject, body, cc });
  const { data } = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return `Email sent to ${to} (id: ${data.id}).`;
}

export async function replyEmail({ email_id, body }) {
  if (!email_id || !body) throw new Error('email_id and body are required.');
  const auth = await requireClient('gmail', 'Gmail');
  const gmail = google.gmail({ version: 'v1', auth });
  const { data: original } = await gmail.users.messages.get({
    userId: 'me', id: email_id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Message-ID'],
  });
  const subject = header(original.payload.headers, 'Subject');
  const to = header(original.payload.headers, 'From');
  const messageId = header(original.payload.headers, 'Message-ID');
  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const raw = buildRawMessage({ to, subject: replySubject, body, inReplyTo: messageId, references: messageId });
  const { data } = await gmail.users.messages.send({
    userId: 'me', requestBody: { raw, threadId: original.threadId },
  });
  return `Reply sent to ${to} (id: ${data.id}).`;
}

export async function forwardEmail({ email_id, to, body, cc }) {
  if (!email_id || !to) throw new Error('email_id and to are required.');
  const auth = await requireClient('gmail', 'Gmail');
  const gmail = google.gmail({ version: 'v1', auth });
  const { data: original } = await gmail.users.messages.get({ userId: 'me', id: email_id, format: 'full' });
  const subject = header(original.payload.headers, 'Subject');
  const originalFrom = header(original.payload.headers, 'From');
  const originalDate = header(original.payload.headers, 'Date');
  const originalBody = extractPlainTextBody(original.payload) || original.snippet || '';
  const fwdSubject = /^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`;
  const fullBody = `${body ? `${body}\n\n` : ''}---------- Forwarded message ---------\nFrom: ${originalFrom}\nDate: ${originalDate}\nSubject: ${subject}\n\n${originalBody}`;
  const raw = buildRawMessage({ to, subject: fwdSubject, body: fullBody, cc });
  const { data } = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return `Email forwarded to ${to} (id: ${data.id}).`;
}

export async function deleteEmail({ email_id }) {
  if (!email_id) throw new Error('email_id is required.');
  const auth = await requireClient('gmail', 'Gmail');
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.messages.trash({ userId: 'me', id: email_id });
  return `Email moved to trash (id: ${email_id}).`;
}

export async function permanentlyDeleteEmail({ email_id }) {
  if (!email_id) throw new Error('email_id is required.');
  const auth = await requireClient('gmail', 'Gmail');
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.messages.delete({ userId: 'me', id: email_id });
  return `Email permanently deleted (id: ${email_id}). This cannot be undone.`;
}

export async function updateEmailLabels({ email_id, add_labels, remove_labels }) {
  if (!email_id) throw new Error('email_id is required.');
  if (!add_labels?.length && !remove_labels?.length) throw new Error('add_labels or remove_labels is required.');
  const auth = await requireClient('gmail', 'Gmail');
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.messages.modify({
    userId: 'me',
    id: email_id,
    requestBody: {
      addLabelIds: add_labels?.map((l) => l.toUpperCase()) ?? [],
      removeLabelIds: remove_labels?.map((l) => l.toUpperCase()) ?? [],
    },
  });
  return `Labels updated for email (id: ${email_id}).`;
}

export async function listDrafts({ max_results }) {
  const auth = await requireClient('gmail', 'Gmail');
  const gmail = google.gmail({ version: 'v1', auth });
  const { data } = await gmail.users.drafts.list({ userId: 'me', maxResults: Math.min(max_results || 10, 20) });
  const drafts = data.drafts ?? [];
  if (drafts.length === 0) return 'No drafts found.';
  const details = await Promise.all(drafts.map(async (d) => {
    const { data: draft } = await gmail.users.drafts.get({ userId: 'me', id: d.id, format: 'metadata' });
    const msg = draft.message;
    return {
      id: d.id,
      to: header(msg.payload.headers, 'To'),
      subject: header(msg.payload.headers, 'Subject') || '(no subject)',
    };
  }));
  return truncate(
    details.map((d, i) => `[${i + 1}] draft_id: ${d.id}\nTo: ${d.to}\nSubject: ${d.subject}`).join('\n\n'),
  );
}

export async function createDraft({ to, subject, body, cc }) {
  if (!to || !subject || !body) throw new Error('to, subject and body are required.');
  const auth = await requireClient('gmail', 'Gmail');
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawMessage({ to, subject, body, cc });
  const { data } = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
  return `Draft created (id: ${data.id}).`;
}

export async function sendDraft({ draft_id }) {
  if (!draft_id) throw new Error('draft_id is required.');
  const auth = await requireClient('gmail', 'Gmail');
  const gmail = google.gmail({ version: 'v1', auth });
  const { data } = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: draft_id } });
  return `Draft sent (id: ${data.id}).`;
}

export async function deleteDraft({ draft_id }) {
  if (!draft_id) throw new Error('draft_id is required.');
  const auth = await requireClient('gmail', 'Gmail');
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.drafts.delete({ userId: 'me', id: draft_id });
  return `Draft deleted (id: ${draft_id}).`;
}


const EVENT_COLOR_NAMES = {
  lavender: '1', sage: '2', grape: '3', flamingo: '4', banana: '5',
  tangerine: '6', peacock: '7', graphite: '8', blueberry: '9', basil: '10', tomato: '11',
};

function resolveColorId(color) {
  if (color === undefined || color === null || color === '') return undefined;
  const s = String(color).trim();
  if (/^([1-9]|1[01])$/.test(s)) return s;
  const id = EVENT_COLOR_NAMES[s.toLowerCase()];
  if (!id) {
    throw new Error(
      `Unknown calendar color "${color}". Use one of: Lavender, Sage, Grape, Flamingo, Banana, `
      + 'Tangerine, Peacock, Graphite, Blueberry, Basil, Tomato (or a colorId 1-11).',
    );
  }
  return id;
}

function colorNameForId(colorId) {
  if (!colorId) return undefined;
  return Object.entries(EVENT_COLOR_NAMES).find(([, id]) => id === colorId)?.[0];
}

const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildEventDateTime(value, timezone) {
  if (value === undefined) return undefined;
  return { dateTime: value, timeZone: timezone || DEFAULT_TIME_ZONE };
}

function buildReminders(reminders) {
  if (reminders === undefined) return undefined;
  if (!Array.isArray(reminders) || reminders.length === 0) return { useDefault: false, overrides: [] };
  return {
    useDefault: false,
    overrides: reminders.map((r) => ({ method: r.method === 'email' ? 'email' : 'popup', minutes: r.minutes })),
  };
}

export async function listCalendarEvents({ query, time_min, time_max, max_results, calendar_id }) {
  const auth = await requireClient('calendar', 'Google Calendar');
  const calendar = google.calendar({ version: 'v3', auth });
  const { data } = await calendar.events.list({
    calendarId: calendar_id || 'primary',
    q: query || undefined,
    timeMin: time_min || new Date().toISOString(),
    timeMax: time_max || undefined,
    maxResults: Math.min(max_results || 10, 20),
    singleEvents: true,
    orderBy: 'startTime',
  });
  const events = data.items ?? [];
  if (events.length === 0) return 'No events found.';
  return truncate(
    events.map((e, i) =>
      `[${i + 1}] id: ${e.id}\n${e.summary || '(no title)'}\nStart: ${e.start?.dateTime || e.start?.date}\n`
      + `End: ${e.end?.dateTime || e.end?.date}${e.location ? `\nLocation: ${e.location}` : ''}`
      + `${e.recurrence?.length ? '\nRecurring event' : ''}${colorNameForId(e.colorId) ? `\nColor: ${colorNameForId(e.colorId)}` : ''}`
    ).join('\n\n'),
  );
}

export async function getCalendarEvent({ event_id, calendar_id }) {
  if (!event_id) throw new Error('event_id is required.');
  const auth = await requireClient('calendar', 'Google Calendar');
  const calendar = google.calendar({ version: 'v3', auth });
  const { data: e } = await calendar.events.get({ calendarId: calendar_id || 'primary', eventId: event_id });
  const attendees = (e.attendees ?? [])
    .map((a) => `${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ''}`)
    .join(', ');
  return truncate(
    `${e.summary || '(no title)'}\nid: ${e.id}\nStart: ${e.start?.dateTime || e.start?.date}\n`
    + `End: ${e.end?.dateTime || e.end?.date}\n`
    + `${e.location ? `Location: ${e.location}\n` : ''}`
    + `${e.recurrence?.length ? `Recurrence: ${e.recurrence.join('; ')}\n` : ''}`
    + `${colorNameForId(e.colorId) ? `Color: ${colorNameForId(e.colorId)}\n` : ''}`
    + `${e.hangoutLink ? `Google Meet: ${e.hangoutLink}\n` : ''}`
    + `${e.transparency === 'transparent' ? 'Shown as: free\n' : ''}`
    + `${e.visibility && e.visibility !== 'default' ? `Visibility: ${e.visibility}\n` : ''}`
    + `${attendees ? `Attendees: ${attendees}\n` : ''}`
    + `${e.description ? `\n${e.description}` : ''}`,
  );
}

export async function listCalendars() {
  const auth = await requireClient('calendar', 'Google Calendar');
  const calendar = google.calendar({ version: 'v3', auth });
  const { data } = await calendar.calendarList.list();
  const items = data.items ?? [];
  if (items.length === 0) return 'No calendars found.';
  return items.map((c, i) => `[${i + 1}] id: ${c.id}\n${c.summary}${c.primary ? ' (primary)' : ''}`).join('\n\n');
}

export async function createCalendarEvent({
  title, start, end, timezone, description, location, attendees, calendar_id,
  recurrence, color, reminders, visibility, busy, add_google_meet, notify_attendees,
}) {
  if (!title || !start || !end) throw new Error('title, start and end are required.');
  const auth = await requireClient('calendar', 'Google Calendar');
  const calendar = google.calendar({ version: 'v3', auth });
  const requestBody = {
    summary: title,
    description,
    location,
    start: buildEventDateTime(start, timezone),
    end: buildEventDateTime(end, timezone),
    attendees: Array.isArray(attendees) ? attendees.map((email) => ({ email })) : undefined,
    recurrence: Array.isArray(recurrence) && recurrence.length ? recurrence : undefined,
    colorId: resolveColorId(color),
    reminders: buildReminders(reminders),
    visibility: visibility || undefined,
    transparency: busy === false ? 'transparent' : undefined,
  };
  if (add_google_meet) {
    requestBody.conferenceData = {
      createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
    };
  }
  const { data } = await calendar.events.insert({
    calendarId: calendar_id || 'primary',
    requestBody,
    conferenceDataVersion: add_google_meet ? 1 : undefined,
    sendUpdates: notify_attendees || undefined,
  });
  const meetLine = data.hangoutLink ? `\nGoogle Meet: ${data.hangoutLink}` : '';
  return `Event created: "${title}" (id: ${data.id}, link: ${data.htmlLink}).${meetLine}`;
}

export async function updateCalendarEvent({
  event_id, title, start, end, timezone, description, location, attendees, calendar_id,
  recurrence, color, reminders, visibility, busy, notify_attendees,
}) {
  if (!event_id) throw new Error('event_id is required.');
  const auth = await requireClient('calendar', 'Google Calendar');
  const calendar = google.calendar({ version: 'v3', auth });
  const requestBody = {};
  if (title !== undefined) requestBody.summary = title;
  if (description !== undefined) requestBody.description = description;
  if (location !== undefined) requestBody.location = location;
  if (start !== undefined) requestBody.start = buildEventDateTime(start, timezone);
  if (end !== undefined) requestBody.end = buildEventDateTime(end, timezone);
  if (attendees !== undefined) requestBody.attendees = attendees.map((email) => ({ email }));
  if (recurrence !== undefined) requestBody.recurrence = recurrence;
  if (color !== undefined) requestBody.colorId = resolveColorId(color);
  if (reminders !== undefined) requestBody.reminders = buildReminders(reminders);
  if (visibility !== undefined) requestBody.visibility = visibility;
  if (busy !== undefined) requestBody.transparency = busy ? 'opaque' : 'transparent';
  const { data } = await calendar.events.patch({
    calendarId: calendar_id || 'primary',
    eventId: event_id,
    requestBody,
    sendUpdates: notify_attendees || undefined,
  });
  return `Event updated: "${data.summary}" (id: ${data.id}).`;
}

export async function deleteCalendarEvent({ event_id, calendar_id, notify_attendees }) {
  if (!event_id) throw new Error('event_id is required.');
  const auth = await requireClient('calendar', 'Google Calendar');
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({
    calendarId: calendar_id || 'primary', eventId: event_id, sendUpdates: notify_attendees || undefined,
  });
  return `Event deleted (id: ${event_id}).`;
}

export async function respondToCalendarEvent({ event_id, response, calendar_id }) {
  if (!event_id || !response) throw new Error('event_id and response are required.');
  const status = { accept: 'accepted', decline: 'declined', tentative: 'tentative' }[response.toLowerCase()];
  if (!status) throw new Error('response must be "accept", "decline", or "tentative".');
  const auth = await requireClient('calendar', 'Google Calendar');
  const calendar = google.calendar({ version: 'v3', auth });
  const cid = calendar_id || 'primary';
  const { data: event } = await calendar.events.get({ calendarId: cid, eventId: event_id });
  const oauth2 = google.oauth2({ auth, version: 'v2' });
  const { data: me } = await oauth2.userinfo.get();
  const attendees = event.attendees ?? [];
  const selfIndex = attendees.findIndex((a) => a.email?.toLowerCase() === me.email?.toLowerCase());
  if (selfIndex === -1) throw new Error("Couldn't find the user among this event's attendees.");
  attendees[selfIndex] = { ...attendees[selfIndex], responseStatus: status };
  await calendar.events.patch({ calendarId: cid, eventId: event_id, requestBody: { attendees } });
  return `RSVP set to "${status}" for event "${event.summary}" (id: ${event_id}).`;
}

export async function checkFreeBusy({ time_min, time_max, calendar_ids }) {
  if (!time_min || !time_max) throw new Error('time_min and time_max are required.');
  const auth = await requireClient('calendar', 'Google Calendar');
  const calendar = google.calendar({ version: 'v3', auth });
  const ids = calendar_ids?.length ? calendar_ids : ['primary'];
  const { data } = await calendar.freebusy.query({
    requestBody: { timeMin: time_min, timeMax: time_max, items: ids.map((id) => ({ id })) },
  });
  const lines = Object.entries(data.calendars ?? {}).map(([id, cal]) => {
    const busy = cal.busy ?? [];
    if (busy.length === 0) return `${id}: free for the whole period.`;
    return `${id}:\n${busy.map((b) => `  Busy: ${b.start} to ${b.end}`).join('\n')}`;
  });
  return truncate(lines.join('\n\n'));
}


const GOOGLE_NATIVE_EXPORT_MIME = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

const READABLE_MIME_PREFIXES = ['text/', 'application/json'];

export async function listDriveFiles({ query, folder_id, max_results }) {
  const auth = await requireClient('drive', 'Google Drive');
  const drive = google.drive({ version: 'v3', auth });
  const clauses = ['trashed = false'];
  if (query) clauses.push(`name contains '${query.replace(/'/g, "\\'")}'`);
  if (folder_id) clauses.push(`'${folder_id}' in parents`);
  const { data } = await drive.files.list({
    q: clauses.join(' and '),
    pageSize: Math.min(max_results || 10, 20),
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
  });
  const files = data.files ?? [];
  if (files.length === 0) return 'No files found.';
  return truncate(
    files.map((f, i) => `[${i + 1}] id: ${f.id}\n${f.name} (${f.mimeType})\nModified: ${f.modifiedTime}\nLink: ${f.webViewLink}`).join('\n\n'),
  );
}

export async function readDriveFile({ file_id }) {
  if (!file_id) throw new Error('file_id is required.');
  const auth = await requireClient('drive', 'Google Drive');
  const drive = google.drive({ version: 'v3', auth });
  const { data: meta } = await drive.files.get({ fileId: file_id, fields: 'name,mimeType' });

  const exportMime = GOOGLE_NATIVE_EXPORT_MIME[meta.mimeType];
  if (exportMime) {
    const { data } = await drive.files.export({ fileId: file_id, mimeType: exportMime }, { responseType: 'text' });
    return truncate(`${meta.name}:\n\n${data}`);
  }
  if (!READABLE_MIME_PREFIXES.some((p) => meta.mimeType?.startsWith(p))) {
    return `"${meta.name}" is a ${meta.mimeType} file — not readable as text (only plain text/CSV/JSON and Google Docs/Sheets/Slides can be read this way).`;
  }
  const { data } = await drive.files.get({ fileId: file_id, alt: 'media' }, { responseType: 'text' });
  return truncate(`${meta.name}:\n\n${data}`);
}

export async function createDriveFile({ name, content, mime_type, parent_folder_id }) {
  if (!name || content === undefined) throw new Error('name and content are required.');
  const auth = await requireClient('drive', 'Google Drive');
  const drive = google.drive({ version: 'v3', auth });
  const mimeType = mime_type || 'text/plain';
  const { data } = await drive.files.create({
    requestBody: { name, mimeType, parents: parent_folder_id ? [parent_folder_id] : undefined },
    media: { mimeType, body: content },
    fields: 'id,webViewLink',
  });
  return `File created: "${name}" (id: ${data.id}, link: ${data.webViewLink}).`;
}

export async function updateDriveFile({ file_id, content, name, mime_type }) {
  if (!file_id) throw new Error('file_id is required.');
  if (content === undefined && name === undefined) throw new Error('content or name is required.');
  const auth = await requireClient('drive', 'Google Drive');
  const drive = google.drive({ version: 'v3', auth });
  const params = { fileId: file_id, fields: 'id,name,webViewLink' };
  if (name !== undefined) params.requestBody = { name };
  if (content !== undefined) params.media = { mimeType: mime_type || 'text/plain', body: content };
  const { data } = await drive.files.update(params);
  return `File updated: "${data.name}" (id: ${data.id}, link: ${data.webViewLink}).`;
}

export async function deleteDriveFile({ file_id, permanent }) {
  if (!file_id) throw new Error('file_id is required.');
  const auth = await requireClient('drive', 'Google Drive');
  const drive = google.drive({ version: 'v3', auth });
  if (permanent) {
    await drive.files.delete({ fileId: file_id });
    return `File permanently deleted (id: ${file_id}). This cannot be undone.`;
  }
  await drive.files.update({ fileId: file_id, requestBody: { trashed: true } });
  return `File moved to trash (id: ${file_id}).`;
}

export async function createDriveFolder({ name, parent_folder_id }) {
  if (!name) throw new Error('name is required.');
  const auth = await requireClient('drive', 'Google Drive');
  const drive = google.drive({ version: 'v3', auth });
  const { data } = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parent_folder_id ? [parent_folder_id] : undefined,
    },
    fields: 'id,webViewLink',
  });
  return `Folder created: "${name}" (id: ${data.id}, link: ${data.webViewLink}).`;
}

export async function moveDriveFile({ file_id, new_parent_folder_id }) {
  if (!file_id || !new_parent_folder_id) throw new Error('file_id and new_parent_folder_id are required.');
  const auth = await requireClient('drive', 'Google Drive');
  const drive = google.drive({ version: 'v3', auth });
  const { data: meta } = await drive.files.get({ fileId: file_id, fields: 'parents,name' });
  const previousParents = (meta.parents ?? []).join(',');
  const { data } = await drive.files.update({
    fileId: file_id,
    addParents: new_parent_folder_id,
    removeParents: previousParents || undefined,
    fields: 'id,name,webViewLink',
  });
  return `Moved "${data.name}" (id: ${data.id}) to folder ${new_parent_folder_id}.`;
}

export async function copyDriveFile({ file_id, name }) {
  if (!file_id) throw new Error('file_id is required.');
  const auth = await requireClient('drive', 'Google Drive');
  const drive = google.drive({ version: 'v3', auth });
  const { data } = await drive.files.copy({
    fileId: file_id,
    requestBody: name ? { name } : undefined,
    fields: 'id,name,webViewLink',
  });
  return `File copied: "${data.name}" (id: ${data.id}, link: ${data.webViewLink}).`;
}

export async function shareDriveFile({ file_id, email, role, anyone_with_link }) {
  if (!file_id) throw new Error('file_id is required.');
  if (!email && !anyone_with_link) throw new Error('email or anyone_with_link is required.');
  const auth = await requireClient('drive', 'Google Drive');
  const drive = google.drive({ version: 'v3', auth });
  const permissionRole = role || 'reader';
  const requestBody = anyone_with_link
    ? { type: 'anyone', role: permissionRole }
    : { type: 'user', role: permissionRole, emailAddress: email };
  await drive.permissions.create({ fileId: file_id, requestBody, sendNotificationEmail: !!email });
  const { data: meta } = await drive.files.get({ fileId: file_id, fields: 'webViewLink' });
  return anyone_with_link
    ? `File is now shared with anyone who has the link (role: ${permissionRole}). Link: ${meta.webViewLink}`
    : `File shared with ${email} (role: ${permissionRole}).`;
}


async function withPlayEdit(auth, packageName, fn) {
  const publisher = google.androidpublisher({ version: 'v3', auth });
  const { data: edit } = await publisher.edits.insert({ packageName, requestBody: {} });
  return fn(publisher, edit.id);
}

export async function getPlayListing({ package_name, language }) {
  if (!package_name) throw new Error('package_name is required.');
  const auth = await requireClient('playconsole', 'Google Play Console');
  const lang = language || 'pt-BR';
  return withPlayEdit(auth, package_name, async (publisher, editId) => {
    const { data } = await publisher.edits.listings.get({
      packageName: package_name, editId, language: lang,
    });
    const title = data.title || '';
    const shortDescription = data.shortDescription || '';
    return truncate(
      `Language: ${data.language}\n`
      + `Title (${title.length}/30): ${title || '(empty)'}\n`
      + `Short description (${shortDescription.length}/80): ${shortDescription || '(empty)'}\n\n`
      + `Full description:\n${data.fullDescription || '(empty)'}`,
    );
  });
}

export async function updatePlayListing({
  package_name, language, title, short_description, full_description,
}) {
  if (!package_name) throw new Error('package_name is required.');
  if (title === undefined && short_description === undefined && full_description === undefined) {
    throw new Error('At least one of title, short_description or full_description is required.');
  }
  const auth = await requireClient('playconsole', 'Google Play Console');
  const lang = language || 'pt-BR';
  return withPlayEdit(auth, package_name, async (publisher, editId) => {
    const { data: current } = await publisher.edits.listings.get({
      packageName: package_name, editId, language: lang,
    });
    const requestBody = {
      language: lang,
      title: title !== undefined ? title : current.title,
      shortDescription: short_description !== undefined ? short_description : current.shortDescription,
      fullDescription: full_description !== undefined ? full_description : current.fullDescription,
    };
    await publisher.edits.listings.update({
      packageName: package_name, editId, language: lang, requestBody,
    });
    await publisher.edits.commit({ packageName: package_name, editId });
    return `Published for ${package_name} (${lang}) — this is now live on the Play Store.\n`
      + `Title: ${requestBody.title}\n`
      + `Short description: ${requestBody.shortDescription}`;
  });
}

export async function listPlayReviews({ package_name, max_results }) {
  if (!package_name) throw new Error('package_name is required.');
  const auth = await requireClient('playconsole', 'Google Play Console');
  const publisher = google.androidpublisher({ version: 'v3', auth });
  const { data } = await publisher.reviews.list({
    packageName: package_name,
    maxResults: Math.min(max_results || 10, 100),
  });
  const reviews = data.reviews ?? [];
  if (reviews.length === 0) {
    return 'No reviews with written text found in the recent window the Play API exposes '
      + '(it never returns star-only ratings with no comment).';
  }
  return truncate(
    reviews.map((r, i) => {
      const user = r.comments?.find((c) => c.userComment)?.userComment;
      if (!user) return null;
      const devReply = r.comments?.find((c) => c.developerComment)?.developerComment;
      const date = user.lastModified?.seconds
        ? new Date(Number(user.lastModified.seconds) * 1000).toISOString().slice(0, 10)
        : 'unknown date';
      return `[${i + 1}] review_id: ${r.reviewId}\n`
        + `${user.starRating}/5 · ${date} · ${user.device || 'unknown device'}\n`
        + `"${user.text || '(no text)'}"\n`
        + (devReply ? `Developer reply: "${devReply.text}"` : 'Developer reply: none yet');
    }).filter(Boolean).join('\n\n'),
  );
}

export async function replyToPlayReview({ package_name, review_id, reply_text }) {
  if (!package_name || !review_id || !reply_text) {
    throw new Error('package_name, review_id and reply_text are required.');
  }
  if (reply_text.length > 350) throw new Error('reply_text must be 350 characters or fewer (Play Store limit).');
  const auth = await requireClient('playconsole', 'Google Play Console');
  const publisher = google.androidpublisher({ version: 'v3', auth });
  await publisher.reviews.reply({
    packageName: package_name, reviewId: review_id, requestBody: { replyText: reply_text },
  });
  return `Reply posted to review ${review_id}: "${reply_text}"`;
}


const VITALS_METRIC_SETS = {
  crash_rate: { resource: 'crashrate', metricSetName: 'crashRateMetricSet', metric: 'crashRate', label: 'Crash rate' },
  anr_rate: { resource: 'anrrate', metricSetName: 'anrRateMetricSet', metric: 'anrRate', label: 'ANR rate' },
  excessive_wakeup_rate: {
    resource: 'excessivewakeuprate', metricSetName: 'excessiveWakeupRateMetricSet',
    metric: 'excessiveWakeupRate', label: 'Excessive wakeup rate',
  },
  slow_start_rate: { resource: 'slowstartrate', metricSetName: 'slowStartRateMetricSet', metric: 'slowStartRate', label: 'Slow start rate' },
  slow_rendering_rate: {
    resource: 'slowrenderingrate', metricSetName: 'slowRenderingRateMetricSet',
    metric: 'slowRenderingRate20Fps', label: 'Slow rendering rate',
  },
  stuck_wakelock_rate: {
    resource: 'stuckbackgroundwakelockrate', metricSetName: 'stuckBackgroundWakelockRateMetricSet',
    metric: 'stuckBgWakelockRate', label: 'Stuck background wakelock rate',
  },
};

function dateTimeParts(date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function dailyTimelineSpec(days) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { aggregationPeriod: 'DAILY', startTime: dateTimeParts(start), endTime: dateTimeParts(end) };
}

export async function getVitalsMetric({ package_name, metric_set, days }) {
  if (!package_name) throw new Error('package_name is required.');
  const spec = VITALS_METRIC_SETS[metric_set];
  if (!spec) {
    throw new Error(`Unknown metric_set "${metric_set}". Use one of: ${Object.keys(VITALS_METRIC_SETS).join(', ')}.`);
  }
  const auth = await requireClient('playconsole', 'Google Play Console');
  const reporting = google.playdeveloperreporting({ version: 'v1beta1', auth });
  const { data } = await reporting.vitals[spec.resource].query({
    name: `apps/${package_name}/${spec.metricSetName}`,
    requestBody: {
      metrics: [spec.metric],
      timelineSpec: dailyTimelineSpec(Math.min(days || 30, 90)),
    },
  });
  const rows = data.rows ?? [];
  if (rows.length === 0) {
    return `No ${spec.label.toLowerCase()} data available for the requested period — `
      + 'the app may be too new or too low-traffic for this metric to be populated yet.';
  }
  const points = rows.map((row) => {
    const d = row.startTime;
    const dateStr = d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : '?';
    const raw = row.metrics?.find((m) => m.metric === spec.metric)?.decimalValue?.value;
    return { dateStr, value: raw === undefined ? null : Number(raw) };
  });
  const numeric = points.filter((p) => p.value !== null && !Number.isNaN(p.value));
  const avg = numeric.length ? (numeric.reduce((s, p) => s + p.value, 0) / numeric.length).toFixed(2) : 'n/a';
  const latest = points[points.length - 1];
  const fmt = (v) => (v === null || Number.isNaN(v) ? 'n/a' : `${v.toFixed(2)}%`);
  const trend = points.map((p) => `${p.dateStr}: ${fmt(p.value)}`).join('\n');
  return truncate(
    `${spec.label} for ${package_name} — last ${points.length} days\n`
    + `Latest (${latest.dateStr}): ${fmt(latest.value)} · Average: ${avg}%\n\n${trend}`,
  );
}
