# Extensões do navegador da Elfie

Chrome bloqueia instalar extensão pela Web Store quando o navegador tá sendo controlado por automação — então é assim, "unpacked":

1. Baixe a extensão como pasta descompactada (não o `.crx`). Formas comuns de conseguir isso:
   - Clone o repositório da extensão (se for open-source) e use a pasta que tem o `manifest.json`.
   - Use uma ferramenta tipo [crx-extractor](https://github.com/mediaz/crx-extractor) ou `crxviewer` pra baixar e descompactar uma extensão direto da Web Store.
2. Coloque essa pasta aqui dentro, ex: `api/browser-extensions/ublock-origin/` (tem que ter um `manifest.json` na raiz dessa pasta).
3. Reinicie a API. Toda pasta aqui com `manifest.json` é carregada automaticamente no navegador da Elfie na próxima vez que ela abrir.

Pode colocar quantas quiser, cada uma na sua própria pasta.
