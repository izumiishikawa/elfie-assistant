<#
    Elfie — passo pesado da instalacao no Windows.

    Chamado UMA vez pelo elfie.iss (CurStepChanged/ssPostInstall) numa janela de
    console visivel. E aqui que mora tudo que demora: descompactar os runtimes,
    instalar o MongoDB, e resolver as dependencias de npm e pip na maquina do
    usuario (empacotar node_modules era inviavel — 3,1 GB so na API).

    Regras de projeto:
      * Runtimes PRIVADOS, dentro de <InstallDir>\runtime. Nada entra no PATH do
        sistema e nada depende do que o usuario ja tem instalado — o Node/Python
        "errado" da maquina do usuario e a fonte classica de bug de instalador,
        e nao ter esse eixo de variacao vale os ~90 MB de download.
      * Todo passo imprime o que esta fazendo ANTES de fazer. Uma instalacao de
        20 minutos sem saida nenhuma e indistinguivel de uma travada.
      * O que ja existe nao e sobrescrito: reinstalar por cima nao pode apagar o
        .env com as chaves de API do usuario.
#>

param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$NodeZip,
    [Parameter(Mandatory = $true)][string]$PythonExe,
    [string]$FfmpegZip = '',
    [string]$MongoMsi = '',
    [string]$MongoUri = 'mongodb://localhost:27017/elfie',
    [string]$OpenRouterKey = '',
    [switch]$WithWeb,
    [switch]$WithDaemon,
    [switch]$WithPlaywright
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # a barra do Expand/Invoke-* pisca feio no console

$RuntimeDir = Join-Path $InstallDir 'runtime'
$NodeDir    = Join-Path $RuntimeDir 'node'
$PyDir      = Join-Path $RuntimeDir 'python'
$FfmpegDir  = Join-Path $RuntimeDir 'ffmpeg\bin'
$LogDir     = Join-Path $InstallDir 'logs'
$ApiDir     = Join-Path $InstallDir 'api'
$WebDir     = Join-Path $InstallDir 'elfie-web'
$DaemonDir  = Join-Path $InstallDir 'daemon'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Start-Transcript -Path (Join-Path $LogDir 'install.log') -Force | Out-Null

$script:StepNo    = 0
$script:StepTotal = 4
if ($MongoMsi)     { $script:StepTotal++ }
if ($WithDaemon)   { $script:StepTotal++ }
if ($WithWeb)      { $script:StepTotal++ }

function Step([string]$Text) {
    $script:StepNo++
    Write-Host ''
    Write-Host "  [$script:StepNo/$script:StepTotal] $Text" -ForegroundColor Cyan
    Write-Host ''
}
function Info([string]$Text) { Write-Host "        $Text" -ForegroundColor DarkGray }
function Warn([string]$Text) { Write-Host ''; Write-Host "  !!  $Text" -ForegroundColor Yellow; Write-Host '' }

function Expand-Zip([string]$Zip, [string]$Dest) {
    # [IO.Compression] em vez de Expand-Archive: o zip do Node tem ~30 mil arquivos
    # e o cmdlet leva minutos neles (ele reprocessa o pipeline arquivo a arquivo).
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Dest)
}

function Invoke-Npm([string]$WorkDir, [string[]]$NpmArgs) {
    # Chama o npm-cli.js pelo node.exe direto: npm.cmd depende de resolucao por PATH
    # e de politica de execucao de .cmd, dois jeitos a mais de quebrar sem precisar.
    $npmCli = Join-Path $NodeDir 'node_modules\npm\bin\npm-cli.js'
    Push-Location $WorkDir
    try {
        & (Join-Path $NodeDir 'node.exe') $npmCli @NpmArgs
        if ($LASTEXITCODE -ne 0) { throw "npm $($NpmArgs -join ' ') falhou (código $LASTEXITCODE) em $WorkDir" }
    } finally { Pop-Location }
}

function Install-NodeDeps([string]$WorkDir, [string[]]$Extra) {
    # `npm ci` e bem mais rapido e instala exatamente o que esta no package-lock —
    # mas ele aborta se o lock estiver dessincronizado do package.json, o que num
    # repositorio em movimento acontece. Nesse caso cai pro `npm install`, que
    # resolve as versoes na hora, em vez de derrubar a instalacao inteira.
    try {
        Invoke-Npm $WorkDir (@('ci', '--no-audit', '--no-fund', '--loglevel', 'http') + $Extra)
    } catch {
        Warn 'O package-lock.json está dessincronizado; resolvendo as versões com `npm install`.'
        Invoke-Npm $WorkDir (@('install', '--no-audit', '--no-fund', '--loglevel', 'http') + $Extra)
    }
}

function Wait-ForPort([string]$MongoHost, [int]$Port, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $c = New-Object System.Net.Sockets.TcpClient
            $c.Connect($MongoHost, $Port); $c.Close()
            return $true
        } catch { Start-Sleep -Milliseconds 700 }
    }
    return $false
}

try {

Write-Host ''
Write-Host '  ============================================================' -ForegroundColor Magenta
Write-Host '     Elfie — configurando. Pode ir tomar um café.' -ForegroundColor Magenta
Write-Host '     Esta janela fecha sozinha quando terminar.' -ForegroundColor Magenta
Write-Host '  ============================================================' -ForegroundColor Magenta

# ─────────────────────────────────────────────────────────────── Node.js ────
Step 'Instalando o Node.js (uso interno do Elfie, não mexe no seu sistema)'
$tmpNode = Join-Path $env:TEMP 'elfie-node-extract'
Expand-Zip $NodeZip $tmpNode
$inner = Get-ChildItem $tmpNode -Directory | Select-Object -First 1
if (-not $inner) { throw 'O zip do Node.js veio com um formato inesperado.' }
if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
Move-Item $inner.FullName $NodeDir
Remove-Item -Recurse -Force $tmpNode -ErrorAction SilentlyContinue
Info (& (Join-Path $NodeDir 'node.exe') --version)

# ──────────────────────────────────────────────────────────────── Python ────
Step 'Instalando o Python (roda o daemon e o ícone da bandeja)'
# TargetDir + InstallAllUsers=0 = instalacao privada, sem admin e sem PATH: nao
# encosta numa instalacao de Python que o usuario ja tenha.
$pyArgs = @(
    '/quiet', 'InstallAllUsers=0', "TargetDir=$PyDir",
    'AssociateFiles=0', 'Shortcuts=0', 'PrependPath=0', 'CompileAll=0',
    'Include_launcher=0', 'InstallLauncherAllUsers=0',
    'Include_test=0', 'Include_doc=0', 'Include_tcltk=0', 'Include_pip=1'
)
$p = Start-Process -FilePath $PythonExe -ArgumentList $pyArgs -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "O instalador do Python retornou o código $($p.ExitCode)." }
$python = Join-Path $PyDir 'python.exe'
if (-not (Test-Path $python)) { throw "O Python não apareceu em $PyDir." }
Info (& $python --version)
# Guarda o instalador: o Python se registra em "Aplicativos e recursos", entao a
# desinstalacao do Elfie precisa chamar `/uninstall` nele (ver [UninstallRun] no
# elfie.iss) em vez de so apagar a pasta e deixar a entrada orfa.
Copy-Item $PythonExe (Join-Path $RuntimeDir 'python-setup.exe') -Force

# ──────────────────────────────────────────────────────────────── ffmpeg ────
if ($WithDaemon) {
    Step 'Instalando o ffmpeg (microfone e áudio da voz)'
    $tmpFf = Join-Path $env:TEMP 'elfie-ffmpeg-extract'
    Expand-Zip $FfmpegZip $tmpFf
    New-Item -ItemType Directory -Force -Path $FfmpegDir | Out-Null
    foreach ($exe in @('ffmpeg.exe', 'ffplay.exe', 'ffprobe.exe')) {
        $src = Get-ChildItem $tmpFf -Recurse -Filter $exe | Select-Object -First 1
        if (-not $src) { throw "$exe não veio no pacote do ffmpeg." }
        Copy-Item $src.FullName (Join-Path $FfmpegDir $exe) -Force
        Info $exe
    }
    Remove-Item -Recurse -Force $tmpFf -ErrorAction SilentlyContinue
}

# ─────────────────────────────────────────────────────────────── MongoDB ────
if ($MongoMsi) {
    Step 'Instalando o MongoDB (o Windows vai pedir permissão — clique em Sim)'
    $mongoLog = Join-Path $LogDir 'mongodb-install.log'
    $ok = $false
    try {
        $m = Start-Process msiexec.exe -Verb RunAs -Wait -PassThru -ArgumentList @(
            '/i', "`"$MongoMsi`"", '/qn', '/l*v', "`"$mongoLog`"",
            'SHOULD_INSTALL_COMPASS=0', 'ADDLOCAL=ServerService,Client'
        )
        $ok = ($m.ExitCode -eq 0)
        if (-not $ok) { Warn "O instalador do MongoDB retornou o código $($m.ExitCode). Detalhes em $mongoLog" }
    } catch {
        Warn 'Você recusou a permissão do Windows, então o MongoDB não foi instalado.'
    }

    if ($ok) {
        Info 'Esperando o serviço do MongoDB subir...'
        if (Wait-ForPort '127.0.0.1' 27017 90) {
            Info 'MongoDB respondendo na porta 27017.'
        } else {
            Warn 'O MongoDB foi instalado mas não respondeu na porta 27017 em 90s. Reinicie o PC e tente abrir o Elfie de novo.'
        }
    } else {
        # Nao aborta a instalacao: todo o resto do Elfie ficou correto, e trocar
        # o banco depois e uma linha no .env. Abortar aqui obrigaria a refazer o
        # download inteiro por causa de um clique num dialogo.
        Warn @'
O Elfie foi instalado, mas SEM banco de dados — ele não vai conseguir abrir assim.
Você tem duas saídas:
  1. Instale o MongoDB Community de https://www.mongodb.com/try/download/community
  2. Ou crie um banco gratis em https://www.mongodb.com/atlas e cole o endereco de
     conexão em MONGODB_URI, no arquivo .env (bandeja do Elfie > Editar configuração).
'@
    }
}

# ───────────────────────────────────────────────────────────── configuracao ────
Step 'Escrevendo a configuração'
$envPath = Join-Path $ApiDir '.env'
if (Test-Path $envPath) {
    # Reinstalacao por cima: as chaves de API que o usuario ja colou aqui valem
    # mais do que qualquer default nosso. So garante que MONGODB_URI exista.
    Info '.env já existe, preservando (só conferindo o MONGODB_URI)'
    $lines = Get-Content $envPath
    if (-not ($lines -match '^\s*MONGODB_URI\s*=')) {
        Add-Content $envPath "MONGODB_URI=$MongoUri"
        Info 'MONGODB_URI adicionado'
    }
} else {
    $envLines = @(
        '# Configuração do Elfie. Linhas começando com # estão desligadas.',
        '# A lista completa de opções está em .env.example, nesta mesma pasta.',
        '',
        "MONGODB_URI=$MongoUri",
        'PORT=3000',
        'WS_PORT=41906',
        'APP_URL=http://localhost:3000',
        ''
    )
    if ($OpenRouterKey) {
        $envLines += @("OPENROUTER_API_KEY=$OpenRouterKey", 'OPENROUTER_MODEL=anthropic/claude-opus-4-5')
    } else {
        $envLines += @('# Cole sua chave da OpenRouter aqui (pegue em https://openrouter.ai/keys):',
                       '# OPENROUTER_API_KEY=sk-or-v1-...',
                       'OPENROUTER_MODEL=anthropic/claude-opus-4-5')
    }
    Set-Content -Path $envPath -Value $envLines -Encoding UTF8
    Info '.env criado'
}

if ($WithWeb) {
    Set-Content -Path (Join-Path $WebDir '.env') -Value 'VITE_API_URL=http://localhost:3000' -Encoding UTF8
}

if ($WithDaemon) {
    # O daemon le daqui (platform_compat.config_dir()), nao da pasta de instalacao.
    $daemonCfgDir = Join-Path $env:APPDATA 'elfie'
    New-Item -ItemType Directory -Force -Path $daemonCfgDir | Out-Null
    $daemonCfg = Join-Path $daemonCfgDir 'daemon.json'
    if (-not (Test-Path $daemonCfg)) {
        Set-Content -Path $daemonCfg -Encoding UTF8 -Value '{"apiBase": "http://localhost:3000", "chatId": ""}'
        Info "daemon.json criado em $daemonCfg"
    } else {
        Info 'daemon.json já existe, preservando'
    }
}

# ──────────────────────────────────────────────── dependencias do servidor ────
Step 'Instalando as dependências do servidor (o passo mais demorado — vários minutos)'
$env:PATH = "$NodeDir;$env:PATH"
$env:npm_config_update_notifier = 'false'
$env:npm_config_fund = 'false'
$env:npm_config_audit = 'false'
if (-not $WithPlaywright) {
    # O pacote playwright baixa ~400 MB de navegadores no postinstall. Quem nao
    # marcou as ferramentas de navegador nao deve pagar por isso.
    $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
    Info 'ferramentas de navegador desmarcadas: pulando o download dos navegadores'
}
# --omit=dev: a unica devDependency da API e o nodemon, e a bandeja sobe o
# servidor com `node server.js` direto, sem recarregamento automatico.
Install-NodeDeps $ApiDir @('--omit=dev')

# ───────────────────────────────────────────────────────── aplicativo web ────
if ($WithWeb) {
    Step 'Montando o aplicativo web'
    # Aqui as devDependencies SAO necessarias: vite e typescript compilam o app.
    Install-NodeDeps $WebDir @()
    Invoke-Npm $WebDir @('run', 'build')
}

# ──────────────────────────────────────────────── dependencias do Python ────
Step 'Instalando as dependências do Python'
& $python -m pip install --upgrade pip --disable-pip-version-check --quiet
if ($LASTEXITCODE -ne 0) { throw "Falha ao atualizar o pip (código $LASTEXITCODE)." }
# pystray/Pillow sao da BANDEJA, nao do daemon — por isso ficam aqui e nao no
# requirements.txt do daemon, que e compartilhado com o Linux.
& $python -m pip install --disable-pip-version-check pystray Pillow
if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar as dependências da bandeja (código $LASTEXITCODE)." }
if ($WithDaemon) {
    & $python -m pip install --disable-pip-version-check -r (Join-Path $DaemonDir 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar as dependências do daemon (código $LASTEXITCODE)." }
}

Write-Host ''
Write-Host '  ============================================================' -ForegroundColor Green
Write-Host '     Pronto! O Elfie vai abrir na bandeja, perto do relógio.' -ForegroundColor Green
Write-Host '  ============================================================' -ForegroundColor Green
Write-Host ''
Start-Sleep -Seconds 3
Stop-Transcript | Out-Null
exit 0

} catch {
    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Red
    Write-Host '     A configuração falhou.' -ForegroundColor Red
    Write-Host "     $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "     Log completo: $(Join-Path $LogDir 'install.log')" -ForegroundColor Red
    Write-Host '  ============================================================' -ForegroundColor Red
    Write-Host ''
    # Sem esta pausa a janela some junto com o processo e o usuario nunca ve o
    # motivo — que e exatamente o que precisa ir no relato do bug.
    Write-Host '  Esta janela fecha em 60 segundos. Tire um print antes.' -ForegroundColor Yellow
    Start-Sleep -Seconds 60
    Stop-Transcript | Out-Null
    exit 1
}
