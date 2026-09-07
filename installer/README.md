# Instalador do Windows

Gera um `ElfieSetup.exe` que instala as três partes do Elfie (servidor, app web e
daemon do overlay) numa máquina Windows sem que o usuário precise saber o que é
Node, Python ou MongoDB.

## Compilar

Precisa só de **Docker** — o compilador do Inno Setup vem do container
`amake/innosetup`, que o roda sob Wine. Não precisa de Windows nem de wine
instalado.

```bash
./installer/build.sh            # gera dist/ElfieSetup.exe
./installer/build.sh --stage    # só monta installer/build/, sem compilar
```

O build também copia o resultado por cima de `installer/ElfieSetup.exe`, que é
versionado no repo para quem só quer baixar e instalar. Isso significa que **cada
rebuild commitado adiciona ~2,8 MB permanentes ao histórico do git** — se um dia
isso incomodar, o lugar certo para o binário passa a ser um GitHub Release, e aí
é só apagar o arquivo daqui e apontar o README raiz para lá.

Precisa de Inno Setup **6.3 ou mais novo** (`ArchitecturesAllowed=x64compatible` e
`CreateDownloadPage` só existem a partir dele) — a tag `latest` da imagem já é.

O payload sai da **árvore de trabalho**, não de `git archive HEAD` — boa parte do
código atual (`platform_compat.py`, `overlay_win.py`, `elfie_inworld_call.py`, os
controllers novos da API) ainda não está commitada, e empacotar só o commitado
geraria um instalador que não bate com o repositório. O `build.sh` aborta se um
`.env` ou um `node_modules` entrar no payload por acidente.

## Como o instalador funciona

**Online, ~3 MB.** Só o código do Elfie vai dentro do `.exe`. Node, Python,
ffmpeg e MongoDB são baixados dos sites oficiais durante a instalação, e as
dependências de npm/pip são resolvidas na máquina do usuário.

Empacotar tudo não era uma opção: `api/node_modules` sozinho dá **3,1 GB**
(`@huggingface/transformers`, `@lancedb`, `onnxruntime`), mais ~400 MB de
navegadores do Playwright — um instalador de 4 GB que envelheceria a cada bump
de dependência.

### Sem administrador

Instala em `%LOCALAPPDATA%\Programs\Elfie`. Não é só preferência: a API grava em
`api/uploads` e `api/browser-profile` **relativos à própria pasta**, então
`Program Files` quebraria isso pra usuário não-admin.

O único passo elevado é o MSI do MongoDB — um UAC só, e ele é opcional: quem
informa a URI de um banco que já tem não vê UAC nenhum.

### Runtimes privados

Node, Python e ffmpeg vão para `<instalação>\runtime\`, fora do `PATH` do
sistema. O Node/Python "errado" já instalado na máquina do usuário é a fonte
clássica de bug de instalador; não ter esse eixo de variação vale os ~90 MB
extras de download. A bandeja injeta esses caminhos no `PATH` dos processos
filhos — é assim que o daemon acha `ffmpeg.exe`/`ffplay.exe`, que ele resolve por
`shutil.which`.

### Telas do assistente

1. Idioma (pt-BR / inglês)
2. Pasta de instalação
3. Componentes — servidor (fixo), app web, daemon, ferramentas de navegador
4. **Banco de dados** — instalar MongoDB local *ou* colar a URI de um existente
5. **Chave de IA** — chave da OpenRouter (pode ficar em branco)
6. Download dos componentes (barra nativa do Inno)
7. Configuração — `bootstrap.ps1` numa janela de console **visível**
8. Fim — abrir o Elfie agora

O console visível do passo 7 é deliberado. O `Exec` do Inno bloqueia a thread da
interface, então qualquer barra de progresso ficaria congelada os 5–20 minutos
inteiros — e, para um leigo, "congelou" é indistinguível de "travou". O console
rolando é mais feio, mas nunca parece travado, e dá para printar quando quebra.

## Arquivos

| Arquivo | O que é |
|---|---|
| `elfie.iss` | Script do Inno Setup: telas, downloads, componentes, atalhos, desinstalação |
| `build.sh` | Monta `installer/build/` e compila via Docker |
| `payload/bootstrap.ps1` | O passo pesado: runtimes, MongoDB, `.env`, `npm install`, `pip install` |
| `payload/elfie_tray.pyw` | Bandeja que gerencia os três processos depois de instalado |
| `payload/serve_web.mjs` | Servidor estático do `elfie-web/dist`, zero dependências |
| `assets/elfie.ico` | Ícone (cópia do favicon do elfie-web) |

## Layout depois de instalado

```
%LOCALAPPDATA%\Programs\Elfie\
├── api\            servidor + node_modules + .env + uploads
├── elfie-web\      fonte + node_modules + dist (compilado)
├── daemon\         daemon do overlay
├── tools\          bootstrap.ps1, elfie_tray.pyw, serve_web.mjs
├── runtime\        node\  python\  ffmpeg\bin\
├── logs\           api.log, web.log, daemon.log, install.log
└── assets\elfie.ico
```

O `daemon.json` fica fora, em `%APPDATA%\elfie\daemon.json`, porque é de lá que o
`platform_compat.config_dir()` lê.

## A bandeja

Ícone perto do relógio, verde/amarelo/vermelho conforme as três partes estejam no
ar. Menu: abrir o Elfie, iniciar/parar/reiniciar cada parte, ver o log de cada
parte, editar o `.env`, abrir a pasta de logs, iniciar com o Windows, sair.

Ela **não** ressuscita processo caído de propósito. Se o servidor está em loop de
crash por falta de `MONGODB_URI`, reinício automático só esconderia a causa — o
ícone fica vermelho e o log conta o resto.

## O que a desinstalação faz

Remove os três componentes, os runtimes privados (chamando o `/uninstall` do
próprio instalador do Python, para não deixar entrada órfã em "Aplicativos e
recursos"), os atalhos e a entrada de início automático.

**Deixa para trás de propósito:** o `api\.env` (suas chaves de API), o
`api\uploads` (imagens geradas), o `%APPDATA%\elfie\daemon.json` e o próprio
MongoDB com o banco. Reinstalar por cima reaproveita tudo isso; para apagar de
vez, delete a pasta na mão.

## Atualizar as versões baixadas

Tudo fica nos `#define` no topo do `elfie.iss`:

```
NodeVersion    22.23.2     https://nodejs.org/dist/
PythonVersion  3.12.10     https://www.python.org/ftp/python/
MongoVersion   8.0.15      https://www.mongodb.com/try/download/community
FfmpegUrl      (sem versão) https://www.gyan.dev/ffmpeg/builds/
```

A URL do ffmpeg é a "release-essentials" sem versão de propósito: o gyan.dev
redireciona sempre para o build atual, então o instalador não envelhece junto com
o ffmpeg. O custo é não dar para fixar hash nesse download.

## O que ainda não foi testado numa máquina Windows

O instalador foi escrito e compilado no Linux; nada abaixo foi executado num
Windows de verdade ainda:

- Os argumentos silenciosos do MSI do MongoDB (`ADDLOCAL=ServerService,Client`,
  `SHOULD_INSTALL_COMPASS=0`) e se o serviço realmente sobe sozinho depois.
- Se o `npm install` da API compila as dependências nativas (`sharp`,
  `onnxruntime-node`, `@lancedb`) sem as Build Tools do Visual Studio. Todos os
  três publicam binário pré-compilado para win32-x64, então em teoria sim.
- A bandeja (`pystray` + Pillow) e o WebView2 do overlay.
- Instalação silenciosa (`/SILENT`) **não é suportada**: os downloads acontecem no
  clique de "Avançar" da tela de pronto, que o modo silencioso pula.
