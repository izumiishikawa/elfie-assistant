; ============================================================================
;  Elfie — instalador do Windows (Inno Setup 6)
;
;  Compilado no Linux, dentro de container: ver build.sh (imagem amake/innosetup,
;  que roda o compilador do Inno sob Wine). Nao precisa de Windows nem de wine
;  instalado na maquina pra gerar o .exe.
;
;  Formato ONLINE: o .exe carrega so o codigo do Elfie (uns poucos MB). Node,
;  Python, ffmpeg e MongoDB sao baixados dos sites oficiais durante a instalacao,
;  e as dependencias (npm/pip) sao resolvidas na maquina do usuario — empacotar
;  tudo era inviavel: api/node_modules sozinho da 3,1 GB (huggingface, lancedb,
;  onnxruntime), e ainda teria que envelhecer junto com o installer.
;
;  Sem privilegio de administrador: instala em %LOCALAPPDATA%\Programs\Elfie, que
;  o usuario pode escrever em runtime — a API grava em api/uploads e
;  api/browser-profile relativos a propria pasta, entao Program Files quebraria
;  isso pra usuario nao-admin. O UNICO passo elevado e o MSI do MongoDB (um UAC
;  so), e ele e opcional: quem ja tem banco informa a URI e nao ve UAC nenhum.
; ============================================================================

#define AppName        "Elfie"
#define AppVersion     "1.0.0"
#define AppPublisher   "izumiishikawa"
#define AppURL         "https://github.com/izumiishikawa/elfie-assistant"
#define AppExeName     "Elfie.lnk"

; --- Downloads (todos oficiais, HTTPS). Bump aqui e em README.md. -----------
#define NodeVersion    "22.23.2"
#define NodeUrl        "https://nodejs.org/dist/v" + NodeVersion + "/node-v" + NodeVersion + "-win-x64.zip"
#define PythonVersion  "3.12.10"
#define PythonUrl      "https://www.python.org/ftp/python/" + PythonVersion + "/python-" + PythonVersion + "-amd64.exe"
; URL sem versao de proposito: o gyan.dev redireciona sempre pro build atual, entao
; o installer nao envelhece junto com o ffmpeg. Custo: nao da pra fixar hash.
#define FfmpegUrl      "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
#define MongoVersion   "8.0.15"
#define MongoUrl       "https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-" + MongoVersion + "-signed.msi"

[Setup]
AppId={{7B2F1C4E-9A3D-4E6B-8F51-3D0A6C41E7B9}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
DefaultDirName={localappdata}\Programs\Elfie
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=no
; Sem admin: ver o cabecalho. O MSI do Mongo se eleva sozinho, quando chega a hora.
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=ElfieSetup
SetupIconFile=assets\elfie.ico
UninstallDisplayIcon={app}\assets\elfie.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; O bootstrap baixa ~500 MB e o npm install da API descompacta varios GB — o Inno
; so sabe do payload minusculo, entao o aviso de espaco em disco viria errado.
ExtraDiskSpaceRequired=6000000000
ShowLanguageDialog=auto

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Types]
Name: "full";   Description: "{cm:TypeFull}"
Name: "custom"; Description: "{cm:TypeCustom}"; Flags: iscustom

[Components]
Name: "api";        Description: "{cm:CompApi}";        Types: full custom; Flags: fixed
Name: "web";        Description: "{cm:CompWeb}";        Types: full custom
Name: "daemon";     Description: "{cm:CompDaemon}";     Types: full custom
Name: "playwright"; Description: "{cm:CompPlaywright}"; Types: full

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "autostart";   Description: "{cm:TaskAutostart}"

[Files]
Source: "app\api\*";       DestDir: "{app}\api";       Flags: recursesubdirs createallsubdirs ignoreversion; Components: api
Source: "app\elfie-web\*"; DestDir: "{app}\elfie-web"; Flags: recursesubdirs createallsubdirs ignoreversion; Components: web
Source: "app\daemon\*";    DestDir: "{app}\daemon";    Flags: recursesubdirs createallsubdirs ignoreversion; Components: daemon
Source: "payload\*";       DestDir: "{app}\tools";     Flags: recursesubdirs createallsubdirs ignoreversion
Source: "assets\elfie.ico"; DestDir: "{app}\assets";   Flags: ignoreversion

[Dirs]
Name: "{app}\logs"
Name: "{app}\api\uploads"

[Icons]
; pythonw.exe (nao python.exe) pra bandeja nao arrastar uma janela de console junto.
Name: "{group}\{#AppName}"; Filename: "{app}\runtime\python\pythonw.exe"; \
      Parameters: """{app}\tools\elfie_tray.pyw"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\elfie.ico"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\runtime\python\pythonw.exe"; \
      Parameters: """{app}\tools\elfie_tray.pyw"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\elfie.ico"; \
      Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
      ValueName: "Elfie"; ValueData: """{app}\runtime\python\pythonw.exe"" ""{app}\tools\elfie_tray.pyw"""; \
      Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\runtime\python\pythonw.exe"; Parameters: """{app}\tools\elfie_tray.pyw"""; \
      WorkingDir: "{app}"; Description: "{cm:LaunchProgram,{#AppName}}"; \
      Flags: nowait postinstall skipifsilent; Check: TrayIsRunnable

[UninstallRun]
; O Python foi instalado pelo instalador OFICIAL dele, entao ele tem entrada
; propria em "Aplicativos e recursos". Apagar so a pasta deixaria essa entrada
; orfa apontando pro nada — por isso o bootstrap guarda o instalador em
; runtime\python-setup.exe e a desinstalacao o chama de volta.
Filename: "{app}\runtime\python-setup.exe"; Parameters: "/uninstall /quiet"; \
      Flags: skipifdoesntexist waituntilterminated runhidden; RunOnceId: "PythonUninstall"

[UninstallDelete]
; node_modules/dist/uploads/logs nascem depois da instalacao, entao o Inno nao os
; conhece — sem isso ficariam pastas de varios GB orfas depois de desinstalar.
Type: filesandordirs; Name: "{app}\api\node_modules"
Type: filesandordirs; Name: "{app}\api\browser-profile"
Type: filesandordirs; Name: "{app}\elfie-web\node_modules"
Type: filesandordirs; Name: "{app}\elfie-web\dist"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\daemon\__pycache__"

[CustomMessages]
brazilianportuguese.TypeFull=Instalação completa (recomendada)
brazilianportuguese.TypeCustom=Personalizada
brazilianportuguese.CompApi=Servidor Elfie (obrigatório)
brazilianportuguese.CompWeb=Aplicativo web (a interface onde você conversa)
brazilianportuguese.CompDaemon=Overlay de desktop e atalhos de voz
brazilianportuguese.CompPlaywright=Ferramentas de navegador (mais ~400 MB de download)
brazilianportuguese.CreateDesktopIcon=Criar um atalho na Área de Trabalho
brazilianportuguese.AdditionalIcons=Atalhos:
brazilianportuguese.TaskAutostart=Iniciar o Elfie junto com o Windows
brazilianportuguese.DbTitle=Banco de dados
brazilianportuguese.DbSubtitle=O Elfie guarda as conversas e a memória dele num MongoDB.
brazilianportuguese.DbInstall=Instalar o MongoDB nesta máquina (recomendado)
brazilianportuguese.DbInstallHint=Baixa e instala o MongoDB oficial como serviço do Windows. Vai aparecer UMA janela de permissão do Windows durante a instalação.
brazilianportuguese.DbExisting=Já tenho um MongoDB (ou uso o Atlas na nuvem)
brazilianportuguese.DbUriLabel=Endereço de conexão:
brazilianportuguese.DbUriInvalid=O endereço de conexão precisa começar com mongodb:// ou mongodb+srv://
brazilianportuguese.KeyTitle=Chave de IA
brazilianportuguese.KeySubtitle=O Elfie precisa de uma chave de algum provedor de IA pra pensar.
brazilianportuguese.KeyLabel=Chave da OpenRouter (openrouter.ai/keys):
brazilianportuguese.KeyHint=Pode deixar em branco e configurar depois: a chave fica no arquivo .env, que a bandeja do Elfie abre pra você em "Editar configuração".
brazilianportuguese.PrepTitle=Baixando componentes
brazilianportuguese.PrepSubtitle=Node.js, Python, ffmpeg e MongoDB, direto dos sites oficiais.
brazilianportuguese.StatusBootstrap=Configurando o Elfie — acompanhe o progresso na janela preta. Isso leva de 5 a 20 minutos.
brazilianportuguese.BootstrapFailed=A configuração falhou (código %1). O log completo está em:%n%n%2%n%nO Elfie foi instalado, mas não vai abrir até isso ser resolvido.
brazilianportuguese.NeedInternet=O instalador não conseguiu baixar os componentes:%n%n%1%n%nConfira sua conexão com a internet e tente de novo.

english.TypeFull=Full installation (recommended)
english.TypeCustom=Custom
english.CompApi=Elfie server (required)
english.CompWeb=Web app (the interface you chat in)
english.CompDaemon=Desktop overlay and voice hotkeys
english.CompPlaywright=Browser tools (extra ~400 MB download)
english.CreateDesktopIcon=Create a desktop shortcut
english.AdditionalIcons=Shortcuts:
english.TaskAutostart=Start Elfie with Windows
english.DbTitle=Database
english.DbSubtitle=Elfie keeps its conversations and memory in a MongoDB.
english.DbInstall=Install MongoDB on this machine (recommended)
english.DbInstallHint=Downloads and installs the official MongoDB as a Windows service. Windows will ask for permission ONCE during setup.
english.DbExisting=I already have a MongoDB (or I use Atlas)
english.DbUriLabel=Connection string:
english.DbUriInvalid=The connection string must start with mongodb:// or mongodb+srv://
english.KeyTitle=AI key
english.KeySubtitle=Elfie needs a key from an AI provider in order to think.
english.KeyLabel=OpenRouter key (openrouter.ai/keys):
english.KeyHint=You can leave this blank and set it later: the key lives in the .env file, which the Elfie tray opens for you under "Edit configuration".
english.PrepTitle=Downloading components
english.PrepSubtitle=Node.js, Python, ffmpeg and MongoDB, straight from the official sites.
english.StatusBootstrap=Setting Elfie up — follow along in the black window. This takes 5 to 20 minutes.
english.BootstrapFailed=Setup failed (code %1). The full log is at:%n%n%2%n%nElfie was installed, but it will not open until this is resolved.
english.NeedInternet=The installer could not download the components:%n%n%1%n%nCheck your internet connection and try again.

[Code]
var
  DownloadPage: TDownloadWizardPage;

  DbPage:        TWizardPage;
  DbInstallRadio: TRadioButton;
  DbExistingRadio: TRadioButton;
  DbUriEdit:     TEdit;
  DbUriLabel:    TLabel;

  KeyPage:  TWizardPage;
  KeyEdit:  TEdit;

function TrayIsRunnable: Boolean;
begin
  // O bootstrap pode ter falhado no meio (sem internet, MSI recusado). Oferecer
  // "abrir o Elfie agora" apontando pra um pythonw.exe que nao existe so trocaria
  // uma mensagem de erro clara por um dialogo do Windows sem explicacao nenhuma.
  Result := FileExists(ExpandConstant('{app}\runtime\python\pythonw.exe'));
end;

function Sanitize(const S: String): String;
begin
  // Tudo aqui vira linha de comando entre aspas pro PowerShell. Uma aspa ou uma
  // crase no meio de uma senha de MongoDB quebraria o parse, e o erro sairia em
  // PowerShell, sobre um argumento que o usuario nunca viu. `$` NAO entra nessa
  // lista de proposito: com -File os argumentos chegam literais, sem expansao de
  // variavel, e tirar `$` corromperia silenciosamente uma senha que o tenha.
  Result := S;
  StringChangeEx(Result, '"', '', True);
  StringChangeEx(Result, '`', '', True);
end;

function MongoWanted: Boolean;
begin
  Result := DbInstallRadio.Checked;
end;

function MongoUri: String;
begin
  if MongoWanted then
    Result := 'mongodb://localhost:27017/elfie'
  else
    Result := Trim(DbUriEdit.Text);
end;

procedure DbRadioClicked(Sender: TObject);
begin
  DbUriLabel.Enabled := DbExistingRadio.Checked;
  DbUriEdit.Enabled  := DbExistingRadio.Checked;
end;

procedure CreateDbPage;
var
  Hint: TLabel;
begin
  DbPage := CreateCustomPage(wpSelectComponents, ExpandConstant('{cm:DbTitle}'),
                             ExpandConstant('{cm:DbSubtitle}'));

  DbInstallRadio := TRadioButton.Create(DbPage);
  DbInstallRadio.Parent := DbPage.Surface;
  DbInstallRadio.Caption := ExpandConstant('{cm:DbInstall}');
  DbInstallRadio.Left := 0;
  DbInstallRadio.Top := 0;
  DbInstallRadio.Width := DbPage.SurfaceWidth;
  DbInstallRadio.Checked := True;
  DbInstallRadio.OnClick := @DbRadioClicked;

  Hint := TLabel.Create(DbPage);
  Hint.Parent := DbPage.Surface;
  Hint.Caption := ExpandConstant('{cm:DbInstallHint}');
  Hint.Left := ScaleX(18);
  Hint.Top := DbInstallRadio.Top + ScaleY(18);
  Hint.Width := DbPage.SurfaceWidth - ScaleX(18);
  Hint.WordWrap := True;
  Hint.AutoSize := False;
  Hint.Height := ScaleY(32);

  DbExistingRadio := TRadioButton.Create(DbPage);
  DbExistingRadio.Parent := DbPage.Surface;
  DbExistingRadio.Caption := ExpandConstant('{cm:DbExisting}');
  DbExistingRadio.Left := 0;
  DbExistingRadio.Top := Hint.Top + Hint.Height + ScaleY(12);
  DbExistingRadio.Width := DbPage.SurfaceWidth;
  DbExistingRadio.OnClick := @DbRadioClicked;

  DbUriLabel := TLabel.Create(DbPage);
  DbUriLabel.Parent := DbPage.Surface;
  DbUriLabel.Caption := ExpandConstant('{cm:DbUriLabel}');
  DbUriLabel.Left := ScaleX(18);
  DbUriLabel.Top := DbExistingRadio.Top + ScaleY(22);

  DbUriEdit := TEdit.Create(DbPage);
  DbUriEdit.Parent := DbPage.Surface;
  DbUriEdit.Left := ScaleX(18);
  DbUriEdit.Top := DbUriLabel.Top + ScaleY(16);
  DbUriEdit.Width := DbPage.SurfaceWidth - ScaleX(18);
  DbUriEdit.Text := 'mongodb://localhost:27017/elfie';

  DbRadioClicked(nil);
end;

procedure CreateKeyPage;
var
  Lbl, Hint: TLabel;
begin
  KeyPage := CreateCustomPage(DbPage.ID, ExpandConstant('{cm:KeyTitle}'),
                              ExpandConstant('{cm:KeySubtitle}'));

  Lbl := TLabel.Create(KeyPage);
  Lbl.Parent := KeyPage.Surface;
  Lbl.Caption := ExpandConstant('{cm:KeyLabel}');
  Lbl.Left := 0;
  Lbl.Top := 0;

  KeyEdit := TEdit.Create(KeyPage);
  KeyEdit.Parent := KeyPage.Surface;
  KeyEdit.Left := 0;
  KeyEdit.Top := ScaleY(18);
  KeyEdit.Width := KeyPage.SurfaceWidth;

  Hint := TLabel.Create(KeyPage);
  Hint.Parent := KeyPage.Surface;
  Hint.Caption := ExpandConstant('{cm:KeyHint}');
  Hint.Left := 0;
  Hint.Top := KeyEdit.Top + ScaleY(30);
  Hint.Width := KeyPage.SurfaceWidth;
  Hint.WordWrap := True;
  Hint.AutoSize := False;
  Hint.Height := ScaleY(48);
end;

function OnDownloadProgress(const Url, Filename: String; const Progress, ProgressMax: Int64): Boolean;
begin
  if Progress = ProgressMax then
    Log(Format('  concluido: %s', [Filename]));
  Result := True;
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage(ExpandConstant('{cm:PrepTitle}'),
                                     ExpandConstant('{cm:PrepSubtitle}'), @OnDownloadProgress);
  CreateDbPage;
  CreateKeyPage;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;

  if (CurPageID = DbPage.ID) and DbExistingRadio.Checked then begin
    if (Pos('mongodb://', LowerCase(MongoUri)) <> 1) and
       (Pos('mongodb+srv://', LowerCase(MongoUri)) <> 1) then begin
      MsgBox(ExpandConstant('{cm:DbUriInvalid}'), mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;

  if CurPageID = wpReady then begin
    DownloadPage.Clear;
    DownloadPage.Add('{#NodeUrl}', 'node.zip', '');
    // Python nao e opcional mesmo sem o daemon: a bandeja que gerencia tudo depois
    // da instalacao tambem roda nele.
    DownloadPage.Add('{#PythonUrl}', 'python-setup.exe', '');
    if WizardIsComponentSelected('daemon') then
      DownloadPage.Add('{#FfmpegUrl}', 'ffmpeg.zip', '');
    if MongoWanted then
      DownloadPage.Add('{#MongoUrl}', 'mongodb.msi', '');

    DownloadPage.Show;
    try
      try
        DownloadPage.Download;
      except
        SuppressibleMsgBox(FmtMessage(ExpandConstant('{cm:NeedInternet}'), [GetExceptionMessage]),
                           mbCriticalError, MB_OK, IDOK);
        Result := False;
      end;
    finally
      DownloadPage.Hide;
    end;
  end;
end;

function BootstrapArgs: String;
var
  Comp: String;
begin
  Comp := '';
  if WizardIsComponentSelected('web')        then Comp := Comp + ' -WithWeb';
  if WizardIsComponentSelected('daemon')     then Comp := Comp + ' -WithDaemon';
  if WizardIsComponentSelected('playwright') then Comp := Comp + ' -WithPlaywright';

  Result :=
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\tools\bootstrap.ps1') + '"' +
    ' -InstallDir "' + ExpandConstant('{app}') + '"' +
    ' -NodeZip "'   + ExpandConstant('{tmp}\node.zip') + '"' +
    ' -PythonExe "' + ExpandConstant('{tmp}\python-setup.exe') + '"' +
    ' -MongoUri "'  + Sanitize(MongoUri) + '"' +
    ' -OpenRouterKey "' + Sanitize(Trim(KeyEdit.Text)) + '"' +
    Comp;

  if WizardIsComponentSelected('daemon') then
    Result := Result + ' -FfmpegZip "' + ExpandConstant('{tmp}\ffmpeg.zip') + '"';
  if MongoWanted then
    Result := Result + ' -MongoMsi "' + ExpandConstant('{tmp}\mongodb.msi') + '"';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Msg: String;
begin
  if CurStep <> ssPostInstall then
    Exit;

  // O trabalho pesado (npm install da API leva minutos e baixa GBs) roda numa
  // janela de console VISIVEL de proposito. Um Exec do Inno bloqueia a thread da
  // interface, entao qualquer barra de progresso aqui ficaria congelada o tempo
  // todo — pra leigo, "congelou" e indistinguivel de "travou". O console rolando
  // e feio, mas nunca parece travado, e da pra printar quando algo quebra.
  WizardForm.StatusLabel.Caption := ExpandConstant('{cm:StatusBootstrap}');
  WizardForm.FilenameLabel.Caption := '';

  if not Exec('powershell.exe', BootstrapArgs, ExpandConstant('{app}'),
              SW_SHOW, ewWaitUntilTerminated, ResultCode) then
    ResultCode := -1;

  if ResultCode <> 0 then begin
    // O array do FmtMessage tem que caber na mesma linha da chamada: no [Code], o
    // parser do Inno olha o primeiro caractere nao-branco de cada linha, e uma
    // quebra que deixe o '[' abrindo a linha vira "Invalid section tag".
    Msg := FmtMessage(ExpandConstant('{cm:BootstrapFailed}'), [IntToStr(ResultCode), ExpandConstant('{app}\logs\install.log')]);
    SuppressibleMsgBox(Msg, mbCriticalError, MB_OK, IDOK);
  end;
end;
