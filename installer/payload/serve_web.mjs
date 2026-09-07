// Servidor estatico do elfie-web/dist. Zero dependencias de proposito: e a unica
// peca que a bandeja precisa subir DEPOIS que o `npm install` do elfie-web ja
// rodou, e depender de um pacote aqui significaria um jeito a mais da instalacao
// quebrar sem que o app web sequer exista ainda.
//
// `vite preview` faria o mesmo, mas so funciona com as devDependencies intactas —
// isso continua servindo o dist mesmo se alguem podar node_modules depois.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'elfie-web', 'dist'));
const PORT = Number(process.env.ELFIE_WEB_PORT ?? 5173);
// Loopback por padrao: abrir na rede dispararia o alerta de firewall do Windows na
// primeira execucao, e quem acessa de outro aparelho fala com a API (3000), nao com isto.
const HOST = process.env.ELFIE_WEB_HOST ?? '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8',
};

async function send(res, file, status = 200) {
  const body = await readFile(file);
  res.writeHead(status, {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // O index.html nunca pode ficar em cache: e ele que aponta pros bundles com
    // hash no nome, entao um index velho depois de uma atualizacao serve o app
    // inteiro velho. Os assets com hash, ao contrario, sao imutaveis.
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(body);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    // normalize() antes de juntar: sem isso um GET /../../.env sai da pasta dist.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      await send(res, file);
    } catch {
      // Fallback de SPA: qualquer rota desconhecida devolve o index e o roteador
      // do lado do cliente resolve.
      await send(res, join(ROOT, 'index.html'));
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`elfie-web: ${err.message}`);
  }
}).listen(PORT, HOST, () => {
  console.log(`[elfie-web] servindo ${ROOT} em http://${HOST}:${PORT}`);
});
