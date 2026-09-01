import Integration from '../models/Integration.js';
import { SERVICES, buildAuthUrl, exchangeCodeForTokens, revokeToken, hasGoogleCredentials, getRedirectUri } from '../googleAuth.js';
import { SERVICE_TOOLS } from '../googleTools.js';

function sendError(res, err, fallback) {
  console.error('[integrations]', err);
  res.status(err.status ?? 500).json({ error: err.status ? err.message : fallback });
}

function connectedPage(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Elfie</title>
<style>body{font:15px system-ui;background:#18181c;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style>
</head><body>${message}<script>
try { window.opener && window.opener.postMessage({ type: 'elfie-integration-connected' }, '*'); } catch (e) {}
setTimeout(() => { try { window.close(); } catch (e) {} }, 600);
</script></body></html>`;
}

export async function listIntegrations(_req, res) {
  try {
    const docs = await Integration.find();
    const byService = Object.fromEntries(docs.map((d) => [d.service, d]));
    res.json(
      Object.keys(SERVICES).map((service) => {
        const doc = byService[service];
        return {
          service,
          connected: !!doc,
          googleEmail: doc?.googleEmail ?? null,
          connectedAt: doc?.connectedAt ?? null,
          scopes: doc?.scopes ?? [],
          tools: SERVICE_TOOLS[service] ?? [],
        };
      }),
    );
  } catch (err) {
    sendError(res, err, 'Failed to list integrations');
  }
}

export function getGoogleConfig(_req, res) {
  res.json({ configured: hasGoogleCredentials(), redirectUri: getRedirectUri() });
}

export function startGoogleOAuth(req, res) {
  const { service } = req.query;
  if (!SERVICES[service]) {
    res.status(400).send('Unknown service');
    return;
  }
  if (!hasGoogleCredentials()) {
    res.status(500).send(
      'Client ID / Client Secret do Google ainda não configurados. '
      + 'Preencha em Settings > Integrações antes de conectar.',
    );
    return;
  }
  res.redirect(buildAuthUrl(service, service));
}

export async function googleOAuthCallback(req, res) {
  const { state: service, error, code } = req.query;
  if (error) {
    res.send(connectedPage('Conexão cancelada. Pode fechar esta aba.'));
    return;
  }
  if (!SERVICES[service] || !code) {
    res.status(400).send('Invalid callback');
    return;
  }
  try {
    const { tokens, email } = await exchangeCodeForTokens(code);
    await Integration.findOneAndUpdate(
      { service },
      {
        service,
        googleEmail: email,
        scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
        accessToken: tokens.access_token ?? '',
        refreshToken: tokens.refresh_token ?? '',
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        connectedAt: new Date(),
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    res.send(connectedPage('Conectado! Pode fechar esta aba e voltar pra Elfie.'));
  } catch (err) {
    console.error('[integrations] oauth callback failed:', err);
    res.status(500).send(connectedPage('Algo deu errado ao conectar. Pode fechar esta aba e tentar de novo.'));
  }
}

export async function disconnectIntegration(req, res) {
  try {
    const { service } = req.params;
    if (!SERVICES[service]) {
      res.status(400).json({ error: 'Unknown service' });
      return;
    }
    const doc = await Integration.findOne({ service }).select('+accessToken');
    if (doc) {
      await revokeToken(doc.accessToken);
      await doc.deleteOne();
    }
    res.status(204).end();
  } catch (err) {
    sendError(res, err, 'Failed to disconnect integration');
  }
}
