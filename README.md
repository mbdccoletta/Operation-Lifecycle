# Operation Lifecycle

Aplicativo Dynatrace AppEngine para triagem, priorização e
compartilhamento de problemas Davis com analítica multi-segmento.

Roda diretamente dentro da plataforma Dynatrace, consumindo dados via
DQL contra a tabela `dt.davis.problems` e tabelas auxiliares. Mantém
paridade de contagem com o app nativo Davis Problems, validado por
diff de HAR contra o tenant de referência.

## Visão geral funcional

O app oferece duas superfícies de leitura principais e um conjunto de
páginas auxiliares de analítica:

- **Incidents (rota `/`)** — view principal. Combina:
  - Constellation: visualização em quadrantes que distribui os
    problemas ativos por categoria Davis (Availability, Error,
    Slowdown, Resource Contention, Custom Alert, Monitoring
    Unavailable) ou por segmento. Cada problema vira um ponto cuja
    posição e tamanho refletem severidade, impacto e tempo aberto.
  - List: tabela tradicional com filtros (status, categoria, métrica,
    busca, segmento), expand inline por linha que mostra entidades
    afetadas, root cause, atividade, comentários e swimlane de
    eventos.
  - Toggle Constellation/List preserva o URL (deep-linkável).
- **Trends (rota `/trends`)** — analítica de equipe e tenant. Inclui:
  - KPIs MTTA / MTTR / MTBF / MTTF com mediana, p95, n e curva de
    evolução por janela temporal.
  - Top root causes (entidades que mais causam problemas).
  - Pain entities (entidades mais afetadas).
  - MTTR por categoria.
  - Cards "AT A GLANCE" com Active problems, MTTR, Resolution rate
    e Stuck > 4h.
- **Histograma de incidentes** — pulse chart no topo do Incidents que
  mostra a distribuição temporal de problemas Active vs Closed na
  janela selecionada, com markers para os top-tier (leaders) da
  constellation.

### Filtros e contexto

- **Timeframe Selector** (Strato) — presets nativos do Dynatrace
  (Last 30 min, 1h, 2h, Today, Yesterday, 24h, 7d) mais range
  customizado. Default: Today.
- **Segment Selector** (Strato) — filtra os dados por segmento de
  filtro do tenant. Afeta lista, KPIs e o badge global.
- **FILTERS strip** — chips de status (Active/Closed) e chips de
  categoria Davis com contagem por categoria atualizada em
  background.
- **Has Metric strip** — filtro por bounds de métrica (MTTA, MTTR,
  MTBF, MTTF) com sintaxe lenient (números puros viram minutos).

### Compartilhamento e drill-down

- Copy ID, Share link, WhatsApp share por problema.
- Link "Open Problem App" abre o problema no app nativo Davis.
- Drill-down do chart (brush horizontal) restringe a lista ao
  intervalo selecionado e desativa o auto-refresh.
- Click em categoria/entidade nos cards de analítica filtra a lista
  pela mesma faceta.

### Comentários e atividade

- Composer Strato (TextArea + Button) por problema, com mirror
  bidirecional para a stream de eventos `CUSTOM_ANNOTATION` que o
  app nativo Davis lê.
- Activity feed (lifecycle, comments+insights, automation+remediation)
  consolidado em três lanes, sincronizado com a swimlane visual.

## Pré-requisitos

### Ambiente local

- **Node.js** 16.13 ou superior. `dt-app` recomenda oficialmente v24;
  o build emite warning em outras versões mas ainda funciona em
  v18/v20/v22.
- **npm** 8+ (vem com Node).
- **Git** para clonar o repositório.
- **SSH key** configurada no GitHub se for usar transport SSH (ou
  Personal Access Token / `gh` CLI para HTTPS).

### Tenant Dynatrace

- Tenant com **AppEngine** habilitado (todos os SaaS atuais têm).
- URL do tenant no formato `https://<tenant>.apps.dynatrace.com`
  (campo `environmentUrl` em `app.config.json`).
- Permissões equivalentes às scopes declaradas em `app.config.json`:
  - `storage:events:read` — leitura da tabela `dt.davis.problems`
  - `storage:system:read` — leitura de `dt.system.events` para
    Automation Engine workflow executions
  - `storage:entities:read` — resolução de nomes de entidades
    afetadas e root cause
  - `storage:buckets:read` — metadata de buckets para validação de
    fetch targets
  - `storage:filter-segments:read` — leitura de filter segments para
    o Segment Selector
  - `document:documents:read` — leitura de comentários e segments
    salvos
  - `document:documents:write` — gravação de comentários
  - `environment-api:events:write` — ingestão de eventos
    `CUSTOM_ANNOTATION` para espelhar comentários no stream do app
    nativo Davis
- Usuário com perfil que tenha autorização para deployar apps no
  tenant (geralmente Administrator ou um perfil customizado com
  `app:apps:install`).

### Autenticação local (primeira vez)

O `dt-app` armazena tokens OAuth em `.dt-app/.tokens.json` (esse
arquivo está no `.gitignore` por ser secret). Na primeira execução
de qualquer comando que precise conversar com o tenant (`dev`,
`deploy`, `info`, etc.), o `dt-app` abre um fluxo OAuth no browser
para autenticar. Depois disso, o token é renovado automaticamente.

## Instalação e setup local

```bash
git clone git@github.com:mbdccoletta/Operation-Lifecycle.git
cd Operation-Lifecycle
npm install
```

A `npm install` baixa todas as dependências de runtime e dev
(React, dt-app, Strato components, vitest, RTL, jsdom, etc.).

## Scripts disponíveis

Definidos em `package.json`:

| Script              | Comando subjacente | Quando usar                                                  |
|---------------------|--------------------|--------------------------------------------------------------|
| `npm start`         | `dt-app dev`       | Dev server local com proxy pro tenant. HMR ativo.            |
| `npm run build`     | `dt-app build`     | Build de produção em `dist/ui/`. Não publica.                |
| `npm run deploy`    | `dt-app deploy`    | Build + upload + activate no tenant. Requer auth válida.     |
| `npm run uninstall` | `dt-app uninstall` | Remove a versão atual instalada do tenant.                   |
| `npm run update`    | `dt-app update`    | Atualiza o dt-app schema/scaffold local.                     |
| `npm run info`      | `dt-app info`      | Mostra estado da instalação no tenant.                       |
| `npm test`          | `vitest run`       | Roda a suíte completa de 143 testes uma vez.                 |
| `npm run test:watch`| `vitest`           | Roda em watch mode com re-run automático ao salvar arquivo.  |

## Fluxo de desenvolvimento

1. Clone e instale (ver "Instalação e setup local" acima).
2. Confirme o `environmentUrl` em `app.config.json` apontando pro
   seu tenant. O default no repo é o tenant de desenvolvimento
   `https://bwm98081.apps.dynatrace.com`; ajuste se necessário.
3. Rode `npm start`. Na primeira vez ele vai abrir o browser para
   OAuth. Depois disso, o dev server fica disponível no URL local
   que ele imprime (tipicamente `http://localhost:3000/`).
4. Edite os arquivos em `ui/app/`. HMR aplica em tempo real.
5. Rode `npm test` antes de commitar — todos os builders de DQL,
   o parser de timeframe e os helpers críticos têm testes que
   atuam como guardas de regressão de contagem.
6. Commit + push para o GitHub:
   ```bash
   git add -A
   git commit -m "descrição da mudança"
   git push
   ```

## Como fazer deploy

### Checklist pré-deploy

Antes de qualquer deploy, sempre:

1. **Tests verdes** — `npm test` deve passar 143/143 (ou o número
   atual de specs). Falha em qualquer DQL builder spec deve ser
   tratada como regressão de segurança ou de contagem, não como
   ruído de teste.
2. **Type check limpo** — `npx tsc --noEmit -p ui/tsconfig.json`.
   Saída vazia = OK.
3. **Versão bumpada** — em `app.config.json`, incremente o campo
   `app.version` (ex: `0.0.28` → `0.0.29`). O Dynatrace recusa
   re-publicar a mesma versão; tentar deployar sem bump retorna
   erro com a mensagem `version already exists` no final do log.
4. **App ID intacto** — `app.id` em `app.config.json` MUST ser
   `my.problems.hub`. Mudar o ID quebra deep-links existentes e
   cria uma instalação paralela em vez de atualizar a atual.
5. **Branch atualizada** — preferencialmente `main` com todos os
   commits relevantes pusheados pro origin antes de deployar, para
   manter git e tenant em sincronia.

### Comando de deploy

```bash
npm run deploy
```

O `dt-app deploy` executa, na ordem:

1. **Build** — compila TypeScript e gera bundle Vite em `dist/ui/`.
2. **Validate manifest** — confere `app.config.json` contra o
   schema em `.dt-app/app.config.schema.json`.
3. **Compress artifact** — empacota o bundle em um zip.
4. **Upload + activate** — envia para o tenant e ativa a nova
   versão. O usuário corrente passa a ver a versão recém-deployada
   em ~1 minuto (cache de bundle).

Saída esperada (sucesso):

```
Building your app
Creating bundles...
Built the app
Validating manifest
Compressing app artifact
Compressed app artifact
Deploying the app
App is deployed
Open your deployed app: 'https://<tenant>/ui/apps/my.problems.hub'
Done.
```

### Validação pós-deploy

1. Abra o URL impresso pelo deploy.
2. Confirme que a versão no canto da UI (geralmente no rodapé do
   menu lateral do Dynatrace) bate com `app.version` em
   `app.config.json`.
3. Faça um sanity check de contagem: aplique
   `Status=Closed + Category=Availability + Last 7 days` no app e
   compare com a mesma combinação no app nativo Davis Problems. Os
   números devem coincidir (paridade já validada por HAR diff no
   tenant de referência).

### Rollback

Para reverter para uma versão anterior:

```bash
# 1. Voltar app.config.json para a versão anterior
git checkout <commit-anterior> -- app.config.json
# 2. Deployar
npm run deploy
```

Ou, se quiser remover completamente o app:

```bash
npm run uninstall
```

Esse comando remove a versão atual do tenant. O app some do menu
para todos os usuários até que algum re-deploy aconteça.

## Estrutura do projeto

```
.
├── app.config.json            Manifest Dynatrace AppEngine (id, version, scopes)
├── icon.png                   Ícone do app (exibido no menu do Dynatrace)
├── package.json               Dependências + scripts npm
├── vitest.config.ts           Config do test runner
├── vitest.setup.ts            Setup global dos testes (jsdom, polyfills)
├── ui/
│   ├── tsconfig.json          Config TypeScript da UI
│   ├── main.tsx               Entrypoint React (renderiza <App/>)
│   └── app/
│       ├── App.tsx            Root: providers, router, tab bar global
│       ├── pages/             Routes
│       │   ├── Overview.tsx           Incidents view (constellation + list)
│       │   ├── TrendAnalysis.tsx      Trends page
│       │   ├── ProblemTimeline.tsx    Per-problem timeline drill-down
│       │   └── Timeline.tsx           Redirector legacy (compat com URLs antigas)
│       ├── components/        Componentes reutilizáveis
│       │   ├── ConstellationView.tsx        Canvas dos quadrantes
│       │   ├── PulseVisualizer.tsx          Histograma temporal
│       │   ├── MobileIncidentList.tsx       Variant mobile da lista
│       │   ├── CategoryFilterChips.tsx      Strip de chips de categoria
│       │   ├── ProblemActivityFeed.tsx      Comments + swimlane + events
│       │   ├── EventSwimlane.tsx            Visualização temporal por lane
│       │   ├── CommentsSection.tsx          Composer + lista de comments
│       │   ├── MetricFilterChip.tsx         Chip de filtro por bound de métrica
│       │   ├── ErrorBoundary.tsx            React error boundary global
│       │   ├── PinnedBanners.tsx            Banners de filtros ativos
│       │   ├── HealthRing.tsx               Ring de health score
│       │   ├── analytics/                   Cards de analítica (Trends page)
│       │   └── ...
│       ├── hooks/             React hooks
│       │   ├── useProblems.ts               useDql wrapper para lista
│       │   ├── useProblemTrend.ts           useDql para histograma
│       │   ├── useCategoryCounts.ts         useDql para chip badges
│       │   ├── useActiveProblemsCount.ts    useDql para tab badge global
│       │   ├── useSegmentMembership.ts      useDql + cache LRU para segments
│       │   ├── useTeamMetrics.ts            MTTA/MTTR/MTBF/MTTF aggregation
│       │   ├── useComments.ts               document store wrapper
│       │   ├── useTimeRange.ts              Brush range state
│       │   ├── useUiUtils.ts                useDebounce, useDelayedLoading, etc.
│       │   ├── useDevice.ts                 Mobile/tablet/desktop detection
│       │   └── useScenario.ts               Demo scenario state
│       ├── contexts/          React contexts
│       │   ├── CategoryFilterContext.tsx    Status + category chip state
│       │   ├── TimeRangeContext.tsx         Brush range (chart drill-down)
│       │   ├── RefreshSignalContext.tsx     Global manual-refresh tick
│       │   └── ScenarioContext.tsx          Demo scenario context
│       ├── utils/             Helpers puros (sem React)
│       │   ├── dql-queries.ts               Builders DQL com whitelist
│       │   ├── timeframe.ts                 Parser Strato Timeframe -> DQL
│       │   ├── filters.ts                   Helpers de filtro client-side
│       │   ├── formatters.ts                Formatação de duração/data/etc.
│       │   ├── scoring.ts                   Score helpers para ranking
│       │   ├── metricBound.ts               Parser de bounds de métrica
│       │   ├── grouping.ts                  Resolução de grupos category/segment
│       │   ├── dynatrace-links.ts           Deep links pra apps nativos
│       │   ├── davis-comments.ts            Ingestão CUSTOM_ANNOTATION
│       │   ├── debugScenario.ts             Cenários sintéticos (demo panel)
│       │   ├── problem-timeline-queries.ts  DQL para timeline page
│       │   ├── analyticsKpis.ts             KPI catalog (Trends page)
│       │   ├── logger.ts                    Logger estruturado
│       │   └── markdown.tsx                 Renderer markdown leve
│       ├── styles/
│       │   └── theme.css                    Tokens + estilos globais
│       └── *.test.ts/.test.tsx             Specs vitest co-localizados
```

Arquivos e diretórios ignorados (em `.gitignore`): `node_modules/`,
`dist/`, `.dt-app/`, `.claude/`, `reports/`, logs, `.env*`.

## Testes

143 specs vitest cobrindo:

- **DQL builders** (`utils/dql-queries.test.ts`) — guarda de segurança
  contra injeção de DQL via whitelist + invariantes de paridade com o
  nativo (sempre emite `from:`, filtro `is_duplicate` null-tolerante,
  dedup antes do summarize, etc.).
- **Timeframe parser** (`utils/timeframe.test.ts`) — cobertura dos
  presets do Strato (`now()-Xunit`, `@d`, custom ISO, etc.) e dos
  casos degenerados (null, undefined, absoluteDate ausente).
- **Filters** (`utils/filters.test.ts`) — predicados de filtro
  client-side (status, categoria, age, stuck, has-metric).
- **Formatters** (`utils/formatters.test.ts`) — duração, datas,
  labels de status/categoria.
- **Metric bound parser** (`utils/metricBound.test.ts`) — sintaxe
  lenient pra bounds de métrica (`>5m`, `< 1h`, etc.).
- **useTeamMetrics helpers** (`hooks/useTeamMetrics.helpers.test.ts`)
  — aggregations de MTTA/MTTR/MTBF/MTTF, percentis, buckets.
- **CategoryFilterContext** — store + ações + URL sync.
- **PinnedBanners** — DOM test do componente de banners.
- **dom-smoke** — render smoke test do App.

Rodar:

```bash
npm test            # uma vez
npm run test:watch  # watch mode
```

CI também roda esses comandos antes de qualquer merge em `main`.

## Arquitetura: notas críticas

### Construção de DQL

Toda DQL contra `dt.davis.problems` passa pelos builders em
`utils/dql-queries.ts`:

- `buildFilteredQuery` — lista paginada (Incidents page)
- `buildCategoryCountsQuery` — badges das chips de categoria
- `buildTrendQuery` — histograma temporal (Trends page)

Os três compartilham invariantes:

1. **`from:` clause sempre presente** — fallback de defesa
   `from: now() - 72h` se o caller passar input inválido. Davis sem
   `from:` cai numa janela implícita de ~2h que dá under-count
   silencioso.
2. **Filtro `is_duplicate` null-tolerante** —
   `isNull(dt.davis.is_duplicate) or not(dt.davis.is_duplicate)`.
   Mesma forma exata que o app nativo Davis Problems usa (validado
   por HAR diff). A forma estrita `== false` derruba registros com
   campo null e produz under-count em tenants com problem-grouping
   pesado.
3. **Whitelist de status e categoria** — qualquer valor fora da
   whitelist é silenciosamente descartado antes de ser concatenado
   na string DQL, removendo a superfície de injeção.

Quebrar qualquer um desses três contratos é considerado regressão
de contagem (ou de segurança), não mudança de comportamento.

### Parser de timeframe

`utils/timeframe.ts` traduz o objeto `Timeframe` do Strato em
`{ timeframe }` ou `{ from, to }` consumível pelos builders DQL.
Conhece todos os presets do Strato (`now()-30m`, `now()-1h`,
`now()-2h`, `@d`, `-1d@d`, `now()-24h`, `now()-7d`) mais ranges
custom ISO. Anything que não case com nenhum preset cai num fallback
de 72h documentado no código.

Por que isso importa: o parser inline anterior em `Overview.tsx` só
reconhecia a forma compacta (`-7d`); presets Strato vinham com o
prefixo `now()-` e caíam silenciosamente no fallback, produzindo o
bug "5 vs 35 closed Availability" que motivou a extração.

### Feature flags

- **`SHOW_SEGMENT_VIEW`** em `ui/app/pages/Overview.tsx` (escopo de
  módulo) — esconde a toggle Category/Segment e a coluna Segment da
  tabela. Atualmente `false`. Toda a infraestrutura segment continua
  funcional, basta trocar para `true` para reativar.

## Troubleshooting

### "Deploy fails with version already exists"

A `app.version` em `app.config.json` ainda é a mesma da versão já
instalada. Incremente antes de re-deployar.

### "Counts don't match native Davis Problems"

1. Compare via HAR: abra DevTools, capture um carregamento de página
   tanto no seu app quanto no nativo, exporte os HARs.
2. Procure as queries em `query:execute` ou `query/v1/`.
3. Diff a string DQL. Diferenças comuns:
   - Janela `from:` (presets do Strato vs string compacta).
   - Filtro `is_duplicate` (null-tolerant vs estrito vs ausente).
   - Status comparison (`==` UPPERCASE vs `matchesValue` Title Case;
     `matchesValue` é case-insensitive, então funcionalmente
     equivalente, mas presença do filtro importa).
   - `dedup display_id` antes ou depois do summarize.

### "OAuth token expired" durante deploy

Apague `.dt-app/.tokens.json` e rode o comando de novo. O `dt-app`
vai abrir o browser pra re-autenticar.

### Light theme: componentes com baixo contraste

Procure por `rgba(...)` hardcoded em inline styles dos componentes.
A maioria dos texts secundários devem usar `var(--neo-text-2)` que
flipa automaticamente entre dark (`#94a3b8`) e light (`#475569`).
Veja exemplos em `DebugScenarioPanel.tsx` e `HealthRing.tsx`.

### Build warning sobre versão do Node

```
To prevent potential issues, please use dt-app with the officially
supported Node.js version 24
```

`dt-app` recomenda v24 oficialmente, mas funciona em v16.13+ na
prática. Para silenciar o warning, instale a v24 (via `nvm install
24 && nvm use 24`). Se aparecer erro real de runtime, aí sim faça
o upgrade.

## Convenções de contribuição

1. **Sempre rode `npm test` antes de commitar.** Tests verdes são
   pré-condição para qualquer PR.
2. **Atualize a versão em `app.config.json`** se a mudança vai para
   produção. Bump patch (`0.0.X`) para fixes; minor (`0.X.0`) para
   features novas.
3. **Não toque em `app.id`** — `my.problems.hub` é o ID canônico
   referenciado em deep-links externos.
4. **DQL: sempre passe pelos builders.** Nunca concatene strings DQL
   diretamente em chamadas `useDql`. Os builders fazem whitelisting
   e mantêm os invariantes de paridade.
5. **Comentários em código:** escreva o "porquê", não o "o quê". O
   código já mostra o "o quê". Use os comentários longos do
   `ui/app/utils/dql-queries.ts` como referência de estilo.
6. **Cores:** novos componentes devem usar `var(--neo-*)` tokens em
   vez de hex/rgba hardcoded, para garantir suporte light theme.

## Tenant de referência

Toda a paridade com o app nativo foi validada contra o tenant
`bwm98081.apps.dynatrace.com` (DPS, prod3). Para validar em outro
tenant:

1. Mude `environmentUrl` em `app.config.json`.
2. Re-autentique (`rm .dt-app/.tokens.json` e rode qualquer comando
   `dt-app`).
3. Faça o sanity check de contagem descrito em "Validação
   pós-deploy".

## Licença

Veja `LICENSE.txt` (Apache-2.0 ou conforme atualizado pelo mantenedor).

## Links úteis

- Aplicativo em produção: https://bwm98081.apps.dynatrace.com/ui/apps/my.problems.hub
- Repositório: https://github.com/mbdccoletta/Operation-Lifecycle
- Documentação dt-app: https://developer.dynatrace.com/
- Strato design system: https://developer.dynatrace.com/develop/design-system/
- DQL reference: https://docs.dynatrace.com/docs/discover-dynatrace/references/dynatrace-query-language
