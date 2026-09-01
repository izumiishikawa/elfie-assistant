import { google } from 'googleapis';
import Integration from './models/Integration.js';

let _settings = {};

export function setGoogleAuthSettings(s) {
  _settings = s ?? {};
}

export function hasGoogleCredentials() {
  return !!(_settings.googleClientId && _settings.googleClientSecret);
}

const BASE_SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email'];

export const SERVICES = {
  gmail: ['https://mail.google.com/'],
  calendar: ['https://www.googleapis.com/auth/calendar'],
  drive: ['https://www.googleapis.com/auth/drive'],
  playconsole: [
    'https://www.googleapis.com/auth/androidpublisher',
    'https://www.googleapis.com/auth/playdeveloperreporting',
  ],
};

export function getRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI
    || `${process.env.APP_URL ?? 'http://localhost:3000'}/api/integrations/google/callback`;
}

function client() {
  return new google.auth.OAuth2({
    clientId: _settings.googleClientId || '',
    clientSecret: _settings.googleClientSecret || '',
    redirectUri: getRedirectUri(),
  });
}

export function buildAuthUrl(service, state) {
  return client().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [...BASE_SCOPES, ...SERVICES[service]],
    state,
  });
}

export async function exchangeCodeForTokens(code) {
  const oauth2Client = client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
  const { data } = await oauth2.userinfo.get();
  return { tokens, email: data.email ?? '' };
}

export async function refreshAccessTokenIfNeeded(doc) {
  const soon = Date.now() + 5 * 60 * 1000;
  if (doc.tokenExpiry && doc.tokenExpiry.getTime() > soon) return doc;

  const oauth2Client = client();
  oauth2Client.setCredentials({ refresh_token: doc.refreshToken });
  const { credentials } = await oauth2Client.refreshAccessToken();

  doc.accessToken = credentials.access_token ?? doc.accessToken;
  doc.tokenExpiry = credentials.expiry_date ? new Date(credentials.expiry_date) : doc.tokenExpiry;
  await doc.save();
  return doc;
}

export async function getAuthorizedClient(service) {
  const doc = await Integration.findOne({ service }).select('+accessToken +refreshToken');
  if (!doc) return null;
  await refreshAccessTokenIfNeeded(doc);
  const oauth2Client = client();
  oauth2Client.setCredentials({ access_token: doc.accessToken, refresh_token: doc.refreshToken });
  return oauth2Client;
}

export async function revokeToken(token) {
  if (!token) return;
  try {
    await client().revokeToken(token);
  } catch (err) {
    console.error('[googleAuth] revoke failed (continuing with local disconnect):', err.message);
  }
}
