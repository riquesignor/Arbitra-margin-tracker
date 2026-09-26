# Arbitra — instruções para o Claude Code

## Ambiente: projeto vive num pen drive exFAT, multi-máquina

Este repositório roda de um pen drive (exFAT) que o dono carrega entre
computadores diferentes (Windows e Linux). exFAT não suporta symlinks do
Unix, então `node_modules` não pode existir fisicamente dentro da pasta do
projeto em máquinas Linux — ele fica numa pasta local (`~/.cache/pendrive-node-modules/<projeto>`)
conectada via bind mount. Scripts em `scripts/`:

- `scripts/setup-linux-devenv.sh` — roda manualmente numa máquina Linux nova
  pra montar o node_modules e instalar dependências.
- `scripts/install-linux-automount.sh` — instala udev + systemd (uma vez por
  máquina, pede sudo só nessa vez) pra isso acontecer sozinho toda vez que o
  pen drive for plugado, sem comando manual depois.

Se aparecerem erros estranhos de `npm install`/`npm run` numa máquina Linux
nova (symlink EPERM, Node antigo demais), o problema é quase sempre
ambiente novo sem esse setup — não o código do projeto.

Line endings: `.gitattributes` força LF em todo o repo. Se `git status`
mostrar um monte de arquivo "modificado" sem você ter mexido neles, é
provável reaparecimento de CRLF — rode `git add --renormalize .` e
confirme com `git diff --stat` antes de decidir o que fazer.

## Fluxo de trabalho autorizado

O dono deste projeto (Nicolas) autorizou o Claude a **editar arquivos do
projeto livremente, sem pedir confirmação antes de cada edição** — pode
mexer no código, configs, scripts, etc. quando ele pedir uma mudança.

O que continua exigindo pedido explícito na conversa (não fazer sozinho por
padrão):
- `git commit` — normalmente quem comita é o próprio dono; só comite se ele
  pedir isso explicitamente na conversa.
- `git push` — **push pra `main` dispara deploy automático de produção na
  Vercel**. Só dar push se pedido explicitamente.

## Deploy

- Deploy é automático: qualquer push pra `main` no GitHub
  (`riquesignor/Arbitra-margin-tracker`) vai direto pra produção via Vercel.
  Não existe ambiente de staging — trate `main` como produção.
