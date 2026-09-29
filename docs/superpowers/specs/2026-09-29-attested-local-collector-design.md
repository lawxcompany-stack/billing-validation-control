# Coletor local isolado com autorização atestada

**Status:** contrato detalhado aprovado pelo usuário em 2026-09-29; primeiro incremento de autorização em implementação local, sem habilitação financeira.
**Base examinada:** `70822c0dc4dd8e9f34d84284682a8f888b147e99`, PR #3 do repositório de controle, ainda aberta.
**Escopo:** substituir a ativação/agendamento via Actions runner por execução local confiável, preservando as exigências financeiras já aprovadas.

## 1. Objetivo e limites

O GitHub autoriza uma execução específica e atesta um manifesto público sem segredos. Um supervisor na estação dedicada verifica essa autorização e executa uma imagem imutável do coletor. A estação **não se registra como Actions runner**, não recebe jobs do repositório público e não usa grupos de organização.

A troca não exige recurso pago de runner groups. Ela não promete custo zero de infraestrutura: a estação dedicada, conectividade e eventuais serviços de teste continuam sendo pré-requisitos.

Nenhum passo deste desenho autoriza merge da PR #139, acesso à Supabase main, Vercel Production, Stripe Live, reset de branch, purge de Auth/histórico, deploy ou aplicação remota de migrations. A implementação inicial e suas migrations são locais; ativação remota exige os gates verificáveis da seção 12.

**Não confundir três resultados:** atestação válida prova a origem da autorização; isolamento verificado permite iniciar o coletor; aprovação financeira exige evidência independente das jornadas e da reconciliação. Um não substitui o outro.

## 2. Por que mudar: evidência no código

| Componente atual | Lacuna verificada | Decisão |
| --- | --- | --- |
| `runner/entrypoint.sh` e `supervisor-internal.mjs` | Registro depende de token e grupo `billing-validation-isolated` em repositório de conta pessoal | Novo entrypoint fixo sem binário, token, labels ou API de registro Actions |
| `runner/workflow-context-internal.mjs` | Exige workflow `in_progress` | Autorização v2 exige tentativa de autorização terminada com sucesso; execução local tem ciclo próprio |
| `runner/activation-manifest.mjs` | Manifesto v1 não vincula imagem, árvore/base do candidato nem política de execução | Novo contrato v2 fechado e domain-separated; sem conversão automática do v1 |
| `runner/supervisor-internal.mjs` | Timer de 20 minutos do desafio permanece ativo após seu consumo | Separar prazo de ativação do prazo de execução e testar execução além da janela de ativação |
| `runner/egress-proxy.mjs` | CONNECT permite apenas 443; `pg` não ganha acesso ao banco por definir `HTTPS_PROXY` | Transporte PostgreSQL explícito, com destino exato e TLS ponta a ponta |
| `src/attempts/store.mjs` | Recovery/takeover depende de `runTerminal` e `runnerRemoved` | Prova autenticada de encerramento da execução local, nunca booleans fabricados |
| `store.mjs`: `resumeRecheck`/transições | A restrição de recheck depende do estado; a lease normal não recebe restrição persistente equivalente a recoveryOnly | Direitos persistentes e monotônicos, independentes do estado terminal |
| `store.mjs`: prepare/fixtureMutationWithReservation | Ordem de locks de capacidade e recursos diverge; verifiers podem esperar I/O segurando locks | Ordem única de locks e proofs obtidas antes de transação curta com revalidação |
| `src/attempts/schema.sql` | Há vínculos `runner_label` e cleanup ainda rejeita histórico DB retido | Contrato versionado de execução e integração da reconciliação append-only previamente aprovada |
| `src/contracts/billing-43.mjs` | Todos os 43 IDs continuam no bloqueio de Tasks 5/6 | Não remover bloqueios por causa do novo transporte; contratos executáveis são requisito separado |
| `.github/workflows/validate-billing.yml` | `test`/`publisher` são stubs que falham fechado | Separar autorização, coleta externa e verificação/publicação; nenhum stub vira sucesso fictício |

Essas são lacunas do desenho de controle. Não são apresentadas como causas comprovadas de todas as falhas históricas: o erro observado da PR #139 continua sendo o reset recusado por usuários Auth existentes.

## 3. Alternativas consideradas

1. **Coletor local atestado — selecionado pelo usuário.** Reutiliza verificação criptográfica, estação dedicada, browser supervisionado, lease e leitores. Retira a superfície de agendamento self-hosted público. Exige identidade e recuperação próprias para a execução externa.
2. **Migrar para organização com admissão de runners.** Preserva mais do código de agendamento, mas exige decisão administrativa, verificação de recursos do plano, novos vínculos de identidade e controles de acesso. Não é necessário para o caminho selecionado e não será executado.
3. **Executar toda a validação em runner hospedado.** Elimina registro local, mas não resolve automaticamente a operação gráfica supervisionada e o transporte seguro do operador já aprovado. Não será adotado como fallback silencioso.

## 4. Fronteiras e fluxo

```text
Estação dedicada: desafio local novo, sem segredos nos inputs
          |
          v
GitHub main protegido: autorizar -> ler candidato/CI -> atestar autorização
          |                  execução hospedada termina aqui
          v
Supervisor: verificar prova + estação + imagem -> iniciar ambiente isolado
          |
          v
Preflight independente -> consumir autorização no controle -> lease/capacidade
          |
          v
Coletor fixo + browser restrito -> observações -> reconciliação/cleanup
          |
          v
Verificador/publicador hospedado: consultar prova durável -> atestar resultado
          |
          v
Check financeiro no SHA exato da aplicação
```

- O workflow de autorização `.github/workflows/authorize-local-collector.yml` e o de resultado `.github/workflows/publish-billing-result.yml` são GitHub-hosted, em `main` protegida, com identidades criptográficas distintas. PRs continuam executando somente `policy`, sem credenciais financeiras.
- O supervisor, sua configuração e o daemon dedicado são parte da base confiável. A atestação GitHub não oferece atestação de hardware nem prova que o administrador local não está comprometido.
- A aplicação candidata é não confiável. Seu bundle roda somente no browser isolado; nunca é importado/executado pelo supervisor, por Node privilegiado ou por um job com credenciais.
- O coletor não recebe token GitHub, chave de App de leitura/publicação, nonce de ativação, Docker socket, diretório do projeto, home do operador ou credenciais de produção.
- Resultados do container são alegações até serem vinculados às observações e recibos duráveis. Código de saída zero, artifact JSON e screenshot não são provas financeiras.

## 5. Autorização v2

Criar schema distinto, sem aceitar aliases do v1. JSON canônico UTF-8 com ordem fixa, sem chaves duplicadas/desconhecidas, máximo de 16 KiB. Campos obrigatórios:

| Campo | Contrato |
| --- | --- |
| `schemaVersion`, `kind`, `executionMode` | `2`, `billing-collector-authorization`, `isolated-local` |
| `operation` | `collect`, `recover` ou `recheck`; permissões distintas |
| `executionId` | 128 bits aleatórios gerados pelo supervisor, hex minúsculo; não é label Actions |
| `activationCommitment` | SHA-256 com domínio `lawx/billing-validation/local-collector/activation/v2` sobre nonce local de 256 bits |
| `candidate` | repositório fixo, ID numérico confirmado, PR, SHA, tree SHA e base SHA |
| `prerequisites` | workflow, run/attempt e IDs dos três jobs observados, vinculados ao candidato; nunca resultado financeiro |
| `control` | repositório `lawxcompany-stack/billing-validation-control`, ID `1384018279`, ref `refs/heads/main`, workflow fixo, SHA, run/attempt e evento `workflow_dispatch` |
| `collectorRelease` | referência OCI por digest, config/image ID esperado, source SHA/tree e digest da política de release revisada |
| `policy` | digests canônicos do ambiente, contratos da suíte, egress e limites de execução/capacidade |
| `suite` | `billing-43` ou `billing-3ds-15`, exatamente como definido no registro revisado; sem lista de casos fornecida pelo caller |
| `issuedAt`, `expiresAt` | UTC, janela máxima de ativação de 20 minutos, emitida pelo controle |
| `sourceExecutionId` | `null` para collect; execução existente e imutável para recover/recheck |

`authorizationDigest` é calculado sobre os bytes canônicos completos e não integra seu próprio payload. O subject de atestação é esse arquivo; a prova de resultado utiliza outro `kind`, outro nome de subject e outro workflow.

### Verificação e replay

1. O supervisor gera o nonce em memória; somente commitment e executionId saem da estação. Inputs nunca selecionam comando, URL arbitrária, código, imagem, política ou credencial.
2. `authorize` valida operação/contexto; `reader` resolve o PR atual e qualidade/regressão/build; o emissor lê imagem/políticas do controle revisado, não de input/artifact do candidato.
3. O workflow de autorização deve conter apenas autorização/leitura/atestação hospedadas. Seu `completed/success` significa **autorização emitida**, não validação financeira.
4. A estação lê a tentativa exata e o run corrente pela API GitHub, incluindo jobs, SHA, repositório numérico, branch, evento e conclusão. Recusa falha, cancelamento, tentativa diferente, rerun posterior e fonte ambígua. Confere o SHA de `main` no momento de iniciar uma autorização nova e exige esse SHA na política local de versões de controle revisadas; SHA alegado pelo manifesto ou existência em `main` não bastam. `authorize`, `reader` e `attest-activation` devem ter sucesso na mesma tentativa, com nova leitura antes do consumo para detectar mudança.
5. Verifica subject digest, assinatura, emissor, workflow/ref/SHA, ID do repositório, environment `billing-validation-attestation`, identidade GitHub-hosted e timestamps verificados dentro da janela assinada e sob a confiança criptográfica revisada. Mantém `--deny-self-hosted-runners`. Prova assinada de outra finalidade não vale. O integrador emite capacidade opaca não serializável e de uso único; objeto congelado, `verified: true` ou ENV com valores coincidentes não conferem autoridade.
6. O desafio local precisa existir no mesmo processo, corresponder ao compromisso e estar válido por relógio monotônico. Validação UTC tolera no máximo 60 segundos de desvio futuro. Consumo local é único e apaga o nonce antes de Docker/display/credenciais. O timer de ativação é encerrado; não cancela o coletor já admitido aos 20 minutos.
7. Um journal privado durável registra o consumo antes do primeiro recurso local. Depois do preflight da branch, o controle grava o claim, único por `authorizationDigest` e `executionId`, junto com a tentativa, posse dos recursos e reserva de capacidade na mesma transação, antes da primeira mutação financeira. Disputa tem um único vencedor. Um acknowledgement perdido não permite repetir collect.
8. Reinício perde o nonce; manifesto/journal copiados não reabrem collect. Recuperação exige novo desafio e autorização `recover`, vinculados à execução original.

Para `recover`, o candidato original pode não ser mais o head da PR: isso não impede limpeza segura dos recursos antigos. A autorização nova vem do controle atual e preserva candidato/ambiente/recursos originais. Nunca publica sucesso no novo head. `recheck` também não cria recursos nem relança a suíte; aprovação final exige que o candidato ainda seja atual.

## 6. Imagem, estação e transporte

### Imagem confiável

- Um build separado, somente no controle protegido, produz a imagem a partir do source SHA revisado, lockfile e base Playwright por digest. Sem código candidato nem credenciais de providers no build.
- A proveniência da imagem é verificada separadamente da autorização. Labels OCI não são prova de origem. A política revisada vincula digest OCI, config/image ID e source SHA/tree. Não confundir digest do manifest OCI com ID local de configuração Docker.
- A política de release pode ser aprovada após o build: o SHA do código da imagem não precisa ser o SHA do workflow posterior que emite a autorização. Essa separação evita autorreferência impossível entre digest da imagem e commit que o registra.
- Node 22 e Playwright `1.62.1` permanecem as versões de referência deste corte. Testes de build conferem a versão real instalada. Entrypoint fixa `node /opt/billing-validation/collector-entrypoint.mjs`; não há `config.sh`, `run.sh`, download do Actions runner, npm/pnpm em runtime nem comando fornecido por manifesto.
- A imagem só é publicada/provisionada após revisão do build e de suas fontes. Esta especificação não dispara build remoto, push de imagem ou deploy.

### Estação dedicada

- Manter o contexto `billing-validation-isolated`, mas conferir também endpoint/identidade do daemon contra o inventário local protegido. O nome do contexto sozinho não prova isolamento. Se o daemon for compartilhado, estiver inacessível ou não puder ser identificado, bloquear.
- Provisionar e verificar o display da estação dedicada. Não assumir que mounts de um Docker remoto veem os arquivos locais de Xauthority. Supervisor, daemon e display devem estar na estação aprovada; nenhum relay no host compartilhado.
- Um executionId tem uma única encarnação ativa. Journal privado fora do repositório, diretório 0700 e arquivos 0600, sem links simbólicos/hardlinks, com criação exclusiva, fsync e recibos de intenção antes de efeitos locais. Falha de persistência impede a próxima fase.
- Container não-root, raiz read-only, `cap-drop=ALL`, `no-new-privileges`, limites de CPU/memória/PIDs e rede interna. Somente mounts verificados do display aninhado e sua credencial efêmera; sem portas publicadas. Preservar sandbox do Chromium e testar sua operação real.
- O browser não expõe endpoint de controle para fora do ambiente isolado. Cookies/sessão ficam em contexto descartável; screenshots, trace e storageState privados não viram artifacts.

### Rede e credenciais

- Proxy deny-by-default, sem gateway direto do coletor. Remover destinos exigidos apenas pelo Actions runner. Hosts do Preview imutável, Stripe TEST e Supabase de validação vêm do preflight/política, nunca do caller ou resposta da aplicação.
- Para PostgreSQL, usar gateway privado separado de destino único: endpoint **session pooler revisado na porta 5432**, sem transaction pooler, com DNS validado e TLS ponta a ponta. O cliente PostgreSQL usa o hostname original para verificar o certificado, não o nome/IP do gateway. Não desativar TLS para conseguir conexão.
- O gateway não aceita URL, host ou tenant variável do coletor, não publica porta no host, tem timeout/limite de conexões e não alcança endereços privados/metadata. Projeto/tenant/role são validados também pelo cliente e readback, antes de qualquer escrita. Um pooler compartilhado não prova por si só qual projeto está sendo acessado.
- Se esse endpoint ainda não estiver confirmado, a fase remota permanece bloqueada. Não ampliar para qualquer host/porta nem reutilizar URL do `.env.local`.
- Entregar credenciais de validação somente após verificar autorização, isolamento e configuração do destino. O supervisor usa pipe anônimo para o stdin do entrypoint fixo, por `docker start --attach --interactive`, sem TTY; o cliente Docker e o daemon locais são confiáveis e já verificados. Nada em argumentos, Docker `Config.Env`, imagem, logs ou artifacts. O protocolo de entrada tem frames com schema fechado, limite de bytes, sequência de fases e nenhum campo de comando. O worker não ecoa o conteúdo recebido. Primeiro recebe somente a credencial de observação; credenciais mutáveis são liberadas apenas após readback independente da identidade/saúde e confirmação atômica de posse/capacidade. Esse transporte exige testes reais de enquadramento, interrupção e não exposição; não basta habilitar stdin genericamente no executor de comandos.
- Credenciais distintas para fixtures, observações SELECT-only, controle de lease e publicação. Sem `postgres`/superusuário ou chave geral do projeto no coletor. A credencial de publicação/checks fica somente no job hospedado correspondente. O browser recebe apenas a sessão normal do usuário sintético.
- A estação precisa de provisionamento próprio em secret manager/armazenamento seguro administrativo. Os secrets de environments GitHub não são uma API de leitura de valores; nenhum workflow deve exportá-los em artifact, log ou output para transferi-los à estação. Não solicitar valores pelo chat nem ler automaticamente `.env.local`.
- O supervisor retém fora do worker a autoridade de registrar fatos do processo/cleanup local. Estado de daemon e alegação do worker são fontes diferentes. A implementação deve provar que encerramento/readback não pode ser declarado pelo próprio payload de resultado.

## 7. Estado, concorrência e recuperação

Persistir identidade de autorização separada de execução: `authorizationDigest`, `authorizationRunId`, `authorizationRunAttempt`, `executionId`, `incarnationId`, `collectorReleaseDigest`, `candidateSha`, `treeSha`, ambiente exato, suite, timestamps/heartbeat, estado e vínculos de recibos. Não reutilizar `runner_label` para fingir um runner existente.

Estados de execução: `prepared -> running -> reconciling -> complete`; falhas convergem para `recovery_required` enquanto efeitos ou isolamento não estiverem comprovadamente encerrados. `complete` significa recursos reconciliados; o outcome separado continua `passed`, `failed`, `cancelled` ou `timed_out`. Cleanup bem-sucedido não transforma falha de cenário em sucesso.

- Lease global por branch Supabase e conta Stripe TEST; reserva finita inclui auth/histórico, journal lógico, ownership e recibos. Fences e verificações transacionais existentes continuam obrigatórios. Nunca presumir fence numérico: o controle atual usa UUID; a migração deve manter comparação de identidade e ownership exata.
- Persistir classe de direitos `collect`, `recover` ou `recheck`, vinculada à autorização. Renovação, transição para `complete`, takeover e handoff nunca ampliam direitos. Recheck não se torna coletor após uma transição terminal nem pode substituir recursos/artifacts da coleta original.
- Adquirir locks sempre na ordem capacidade/escopo -> branch Supabase -> conta Stripe -> attempt/lease -> intents/receipts; recursos múltiplos são ordenados por chave canônica. Testar a interseção prepare/fixture/cleanup com dois backends PostgreSQL, não apenas mocks.
- Observações de provider/daemon ocorrem fora da transação de alteração de estado. O commit curto exige prova autenticamente emitida, vinculada ao owner/fence, ainda válida, e revalida identidade, locks e estado sob lock. A quiescência do executor deve ser uma revogação persistente de sua autoridade, não um snapshot que permita reinício logo após a observação. Corrida, I/O ambíguo ou qualquer mudança invalida o commit; não segurar transação enquanto se aguarda rede/operador.
- Heartbeat com intervalo de 20 segundos e TTL de 120 segundos. Perda de confirmação fecha o caminho de novas mutações e inicia parada segura; expiração não libera recursos nem transfere posse automaticamente. O watchdog fica fora do worker e compartilha a mesma identidade durável.
- Prazo de execução separado da ativação: padrão 180 minutos, teto 360 minutos, ambos assinados pela política. É orçamento inicial a aferir no ambiente real, não solução para erros de lógica. Casos mantêm limites específicos; requisições sem limite são proibidas. Cleanup tem orçamento próprio de 10 minutos e falha em `recovery_required` se não houver prova suficiente.
- Supervisor encerrado, container ainda ativo, resposta Docker perdida, daemon indisponível, processo in-flight ou journal ilegível: nunca marcar cleanup nem permitir nova coleta. Persistir o bloqueio para sobreviver ao reinício do Node.
- Recovery exige nova autorização, identidade da mesma execução, prova independente no daemon dedicado de que o worker anterior não executa, ausência dos seus canais de acesso e reconciliação dos efeitos externos. Container parado não prova que Stripe/webhooks terminaram; intents ambíguas continuam bloqueadas.
- Recovery cobre explicitamente crash em `prepared`, `running/collecting`, `reconciling` e no próprio recovery, com lease já expirada e com ou sem intent pendente. O caminho de recuperação não depende de uma transição assinada pela lease morta. Somente a nova autoridade de recovery pode transferir ownership após prova de quiescência, preservando os direitos limitados e recibos originais.
- `recover` permite somente ler/reconciliar e as ações reversíveis já allowlisted sobre recursos comprovadamente próprios. Não cria cobrança, cliente, Test Clock ou nova jornada. `recheck` é estritamente leitura/publicação de prova já completa.
- Um término do workflow de autorização **nunca** substitui prova de término do executor. Não adaptar o store retornando simplesmente `runTerminal: true, runnerRemoved: true`.
- Sem prova válida do daemon antigo, não transferir recuperação para outra máquina por presunção. Um protocolo futuro de reprovisionamento/atestação da estação é uma operação separada.

### Migração do controle

Usar schema versionado e migration forward-only local testada em PostgreSQL 16 efêmero. Preservar todas as linhas v1, com discriminador legado explícito; não preencher campos v2 inventados. Tentativas antigas não encerradas bloqueiam novas execuções até recuperação compatível, sem reclassificação automática.

Readback deve comprovar que `anon`, `authenticated`, `service_role` e demais credenciais alcançáveis pelo candidato não podem gravar nem forjar o estado/recibos do controle, diretamente, por membership ou por RPC EXECUTE. O SQL atual isoladamente não é evidência suficiente desses privilégios. Roles de supervisor, collector, observer e publisher têm capacidades separadas e verificadas.

O contrato append-only já aprovado permanece: histórico financeiro, Auth e objetos Stripe são retidos; fecha-se somente recurso reversível próprio. A implementação atual que exige `retainedDatabaseResources=[]` ainda precisa da reconciliação por ownership e projeção antes de liberar reserva/lease. O desenho novo não torna esse código pronto por renomeá-lo.

## 8. Coleta e resultado confiável

Antes de fixtures: provar imagem/código, políticas, Preview imutável/assinatura/SHA/tree, child Supabase `zjvqjdntasprusoqfsgw`, saúde/schema/migrations, conta Stripe TEST e webhook exato, readers mínimos, contratos executáveis completos e capacidade/lease.

- As 43 jornadas continuam exigindo contratos de transição, efeitos negativos, observações e retenção, exatamente uma vez cada. Não remover `TASK5_BLOCKED_ID_SET`/`TASK6_BLOCKED_ID_SET` em massa nem substituir por retorno `passed`.
- SQL/concurrency real segue gate separado, com dois backends e evidência de contenda; nenhum SQL/migration da PR é executado pelo coletor.
- 3DS supervisionado mantém sua suíte separada e confirmação independente de pagamento/autenticação. SSO ADVBOX não é implicitamente comprovado por 43/43 nem pelo transporte local.
- Cada caso registra recibos append-only vinculados ao fence, executionId, hashes de contratos e observações. Uma coleção de objetos com schema válido não basta: precisa de cadeia autoritativa de execução e provenance.
- Recibos incluem finalidade, emissor/verificador autorizado e referência durável por digest da observação. Reenvio idêntico é idempotente; alteração, troca de finalidade e replay entre execuções falham. Dois replay runs exigem executionIds distintos e comparação efetiva das projeções, não apenas duas entradas sequenciais no JSON.
- Só liberar lease/capacidade após nenhum acesso ativo, ownership reconciliado, intents resolvidas, cleanup local confirmado e recibo terminal durável. Relatar `databaseBaselineRestored=false` e `fixtureReusable=false` quando houver histórico retido.
- Receipt de cleanup, settlement da reserva e liberação de locks são vinculados atomicamente, sem atalho no takeover baseado em `cleanupComplete: true`. Um erro de COMMIT/ack conserva incerteza até readback independente e não autoriza repetição dos efeitos.

## 9. Verificação/publicação assíncrona

O publicador é execução separada, iniciada com apenas executionId/authorizationDigest. Ele não recebe status, casos ou provas fornecidos pelo operador como fonte confiável.

1. Lê diretamente o controle com credencial SELECT-only, verifica autorização/proveniência, identidade e encerramento local registrados pelo supervisor confiável, e a completude dos recibos de casos/SQL/cleanup.
2. Revalida invariantes terminais por readers independentes e hashes das observações; não aceita JSON/artifact/código de saída como substituto. Falta de reader ou cadeia de recibos impede publicação positiva.
3. Compara head atual da PR e deployment com o candidato da evidência; candidato antigo continua histórico e não libera novo commit. Emprega a política de source pins revisada, não autoaprovação.
4. Constrói manifesto sanitizado v2 de resultado, com outro `kind`/subject e seu próprio run/attempt de publicação, referenciando autorização e execução. Jobs de assinatura usam apenas OIDC/attestations/contents, sem provider secrets; job de publicação usa App restrito a Checks write no repositório da aplicação.
   A proveniência interna da coleta é `attested-local`; a emissão/verificação hospedada possui proveniência GitHub separada. Não falsificar `source=github-actions` ou `financialReport.githubOutputSha256` para encaixar a coleta externa no envelope legado.
5. O check obrigatório da aplicação verifica App emissor, SHA, proveniência e recibos do resultado. Sucesso do workflow de autorização, `neutral`, `skipped`, 43 objetos fabricados ou resultado de outro SHA nunca liberam o aceite.

O controle autenticado e a estação dedicada são fontes confiáveis operacionais, não hardware remotamente atestado. Comprometimento de seus administradores/credenciais está fora da garantia oferecida por uma assinatura GitHub; essa limitação deve permanecer no runbook.

## 10. Organização da implementação

| Área | Reaproveitar | Mudança focada |
| --- | --- | --- |
| Admissão do candidato | `src/github/candidate-reader.mjs`, `candidate-checks.mjs`, `read-client.mjs` | Expor tuple verificável para autorização; distinguir collect de recovery histórico |
| Autorização | `runner/activation*`, `workflow-context*`, emissor de manifesto | Módulos v2 em `src/authorization/`; não ativar v1 no novo caminho |
| Supervisor | checks de Docker/display/process-boundary | Módulos focados em `collector/`: identidade de estação, imagem, journal, launcher e watchdog; entrada pública sem seams arbitrários de teste |
| Imagem | base Playwright e lockfile | `collector/Dockerfile` e entrypoint fixo, sem Actions runner; build/proveniência independentes |
| Rede | verificadores de host/DNS e proxy HTTPS | política HTTPS mínima e gateway PostgreSQL de destino único em módulos separados |
| Estado | store/locks/retention e testes Postgres | identidade v2, receipt de processo/cleanup autenticado, anti-replay e recovery sem `runnerRemoved` |
| Jornadas | contratos, fixture-run, readers e operador | integração preserva cada caso bloqueado até operação/prova/retenção completas |
| GitHub | `policy`, reader protegido, environments existentes | workflow hospedado de autorização e workflow distinto de resultado; nenhum `runs-on` dinâmico/self-hosted no novo caminho |
| Aplicação | qualidade/regressão/build existentes | consumir evidência confiável e remover caminho privilegiado antigo somente após canário completo |

O plano de implementação posterior deve separar entregáveis revisáveis: autorização; supervisor/rede; estado/recovery; integração de coleta; publicador; consumo pela aplicação. A migração não é uma única troca do YAML.

O **primeiro incremento implementável** fica restrito ao schema/emissor/verificador v2 e ao workflow de autorização, com testes locais de rejeição e verificação sem iniciar Docker nem obter credenciais financeiras. Os contratos das seções 6–9 orientam compatibilidade, mas não devem virar uma PR única nem ter implementação presumida por esse primeiro incremento. Os incrementos seguintes precisam de planos próprios, mantendo os gates desta especificação.

## 11. Critérios verificáveis

### Offline e PostgreSQL efêmero

- v1/v2, autorização/resultado, imagem errada, política divergente, assinatura/subject/ref/SHA/environment inválidos, nonce copiado/consumido, expiração e tentativa reexecutada recusados antes de credenciais ou efeitos financeiros.
- Workflow de autorização completed/success aceito somente para ativação; nenhum teste trata isso como worker terminado. Falha/cancelamento/attempt antigo recusados.
- Simulação de execução superior a 20 minutos prova que o timer consumido não mata o worker; timeout de execução e cleanup continuam finitos e independentes.
- Dois supervisores/processos e PostgreSQL real disputam a mesma autorização: apenas um vence. Reinício, PID reutilizado, journal truncado/linkado e COMMIT ambíguo não reabrem collect.
- Rede testa PostgreSQL TLS/SNI, tenant/role exatos, recusa de transaction pooler, DNS privado/rebinding, bypass direto do proxy e host/porta não allowlisted. Nenhuma credencial aparece no Docker inspect ou nos logs.
- Interrupção entre cada intenção/efeito/ack preserva recovery; daemon inalcançável, worker sobrevivente e provider in-flight não liberam lease. Booleans forjados não contam como prova.
- Recheck seguido de `complete`, heartbeat ou handoff continua incapaz de iniciar Stripe intents/fixtures; retomada com lease expirada cobre todas as fases. O verifier não é opcional e precisa produzir prova positiva, não somente resolver uma Promise.
- Prepare concorrente com fixture/cleanup confirma ordem única de locks sem deadlock nem falso PASS. Prova vencida/alterada entre observação e commit recusa; takeover sem receipt durável e settlement antecipado não liberam capacidade.
- Roles do candidato não conseguem escrever/EXECUTE no controle; worker não pode declarar término do próprio processo nem cleanup do host. Publicador é SELECT-only no banco e não pode executar fixtures.
- Fonte/código de execução sempre fixos. Resultado antigo, artifact inventado, casos faltantes/duplicados/bloqueados e cleanup após falha não produzem success.

### Etapas reais, explicitamente distintas

1. Verificar imagem e protocolo em ambiente local descartável, sem providers e sem acesso ao host compartilhado.
2. Emitir/verificar uma autorização real e parar após a verificação, sem injetar credenciais financeiras nem executar jornadas. Esse teste prova somente o handoff.
3. Readback não mutável de Preview, child Supabase e Stripe TEST, roles, schema/receipts, políticas de environments e saúde. Nenhuma consulta à Supabase main.
4. Canário sintético mínimo com fence, observações e recuperação de interrupção. Não substitui a suíte completa.
5. Suíte SQL/concorrência, 43 jornadas e 3DS exigido, com evidência durável e publicação no SHA correto. Repetição serial confirma que retenção e recovery não deixam a próxima tentativa bloqueada indevidamente.

Falhas nessas etapas mantêm o gate fechado e são reportadas por fase. Testes de configuração/CLI não exigem TestSprite; UI/Preview só usa projeto/target apropriado depois dos gates e nunca substitui prova financeira.

## 12. Pré-requisitos externos e ordem de ativação

1. Revisar/mergear a PR #3 do controle; seu `policy` aprovado não habilita validação financeira.
2. Revisar este contrato e implementar/testar as fronteiras v2. Durante transição, os stubs antigos permanecem bloqueados; não registrar runner para contorná-los.
3. Provisionar/verificar a estação dedicada e proveniência da imagem. Sem endpoint/identidade confirmados, nenhuma execução Docker operacional.
4. Configurar Apps de leitura/publicação e credenciais mínimas, com readback dos escopos. Nunca copiar PAT de operador para o coletor.
5. Provisionar o schema/roles v2 somente na branch autorizada, após revisar a migration local e confirmar destino; sem reset e sem DDL do candidato. Atualizar políticas/fingerprints por evidência revisada.
6. Concluir contratos reais de jornadas e reconciliação append-only; configurar inbox sintético seguro quando necessário. Fonte ausente permanece bloqueada.
7. Executar as cinco etapas reais da seção 11, verificar interrupção/retomada e publicar prova.
8. Somente então ajustar/reenviar integração da PR #139 e verificar o CI do SHA resultante. Merge/release da aplicação exige revisão própria.

Readback desta sessão confirmou repositório público/pessoal `1384018279`, `main`, quatro environments restritos a políticas customizadas e zero runners registrados. Não foram lidos segredos nem acessados Supabase, Vercel ou Stripe. Saúde, credenciais e isolamento da estação não foram presumidos.

## Referências primárias

- [GitHub: disponibilidade e uso de Artifact Attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [GitHub CLI: verificação de atestações e filtros de proveniência](https://cli.github.com/manual/gh_attestation_verify)
- [Docker: fronteiras de segurança e autoridade do daemon](https://docs.docker.com/engine/security/)

Esta especificação substitui somente as suposições de agendamento e prova de término do runner na documentação anterior. As regras de negócio e as exigências de observação independente/append-only já aprovadas permanecem obrigatórias.
