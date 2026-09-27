# Task 4 — transporte híbrido, fixtures e leitores independentes

**Status:** desenho aprovado incrementalmente pelo usuário em 2026-09-27. Implementação ainda não iniciada.
**Escopo:** complemento específico da Task 4 do plano `2026-09-26-trusted-billing-43-collector.md`.
**Autorização:** somente implementação e testes locais/offline. Sem acesso ou mutação remota, sem alteração de secrets/configuração, push, PR, merge ou deploy.

## Entendimento confirmado

- Construir no repositório de controle o transporte e as interfaces para fixtures sintéticas por tentativa e observações independentes.
- Conduzir somente as jornadas aprovadas contra um Preview imutável, sem executar código/workflows da PR no job privilegiado.
- Usar Playwright para navegação/interação real e adapters separados para publicação de fixture e leitura de prova.
- Não usar resposta HTTP/visual do candidato como prova de sucesso; a conclusão depende de leitores independentes.
- Preservar o fencing/lease e o histórico append-only; falhas ambíguas permanecem pendentes para reconciliação.
- Não enviar dados reais, segredos, cookies ou estado de sessão para logs/artifacts.
- A Task 4 local, isoladamente, não prova 43/43 nem prontidão para produção.

## Premissas e limites

- Uma única suíte por vez na branch Supabase e conta Stripe TEST compartilhadas; casos sequenciais por padrão, com paralelismo apenas dentro de um caso que o exija.
- Timeouts e limites de resposta serão finitos e definidos no código de controle; não há meta de baixa latência.
- As allowlists e schemas serão derivados de rotas/contratos revisados e mantidos no repositório de controle. Nenhuma URL/operação será aceita de input do operador, resposta do candidato ou artifact.
- Qualquer caso de signup que exija confirmação por e-mail permanece bloqueado até haver um inbox de teste isolado, verificado e sem entrega a destinatários reais. Não se fabricará confirmação nem se usará endereço real.
- As interfaces poderão ser testadas com adapters offline; saúde/migrations/identidade dos serviços remotos continuam gates externos e não serão inferidos por testes locais.
- O dono das allowlists, contratos e política de fixtures é o repositório de controle e seus revisores.

## Decisões registradas

| Decisão | Alternativas consideradas | Motivo |
|---|---|---|
| Transporte híbrido: Playwright restrito para jornadas do Preview; adapters confiáveis para fixtures e leitores. | HTTP-only; browser-first. | Exercita navegação/cookies reais sem dar ao browser autoridade para publicar fixtures, escolher operações financeiras ou declarar sucesso. |
| Rede deny-by-default, com origem, rota, método e schemas fechados. | Navegação livre dentro do domínio; proxy genérico. | Reduz SSRF, redirecionamento/exfiltração e chamadas fora do contrato. |
| Contexto de browser descartável; cookies/sessão somente em memória. | Persistir `storageState`, traces ou vídeos. | Evita transformar credenciais de sessão em artifacts/logs e limita duração do estado. |
| Identificadores aleatórios confiáveis e namespace distinto por tentativa/caso. | Reutilizar run ID, e-mail/IDs fornecidos pelo operador ou fixture global. | Impede colisão/replay entre execuções e associa recursos à tentativa certa. Casos de replay/corrida só compartilham identidade dentro do mesmo caso. |
| Mutação por RPC nominal allowlisted, com ownership e fence verificados na mesma transação; somente inserções sintéticas. | Escrita direta em tabelas, operação genérica, update/delete ou SQL do candidato. | Preserva isolamento, append-only e controle atômico de ownership. |
| Leitores independentes e read-only para Supabase e Stripe TEST. | Tratar HTTP/UI, resposta de mutação ou payload do candidato como prova. | Vincula prova ao recurso/provider/environment corretos sem confiar na aplicação avaliada. |
| Timeout/resultado de mutação ambíguo não é repetido; manter lease/reserva para reconciliação. | Retry automático, inclusive com chave idempotente igual. | Evita duplicar efeitos externos e não assume que idempotência do provider seja permanente. |
| Cleanup só libera recursos depois de reconciliação e recibo append-only persistido. | Liberar ao expirar lease ou após cleanup apenas em memória. | Impede perder evidência/ownership e corrige requisito já aprovado no plano. |
| Testes locais/offline são o aceite da Task 4; TestSprite não substitui testes do backend nem autoriza execução remota. | Tratar suíte local ou screenshot como validação financeira remota. | Mantém a distinção entre teste do controle e prova de ambiente/provider real. |

## Desenho final

### Componentes e fluxo

1. Uma tentativa já admitida pelo control plane fornece `attemptId`, `fixtureRunId` e fence vigente. O gerador confiável usa aleatoriedade criptográfica; nenhum identificador financeiro, e-mail ou operação é escolhido por caller ou por resposta do candidato.
2. O adapter Playwright recebe apenas o deployment imutável previamente verificado e o catálogo fechado de jornadas. Toda navegação/request é comparada com allowlist de HTTPS origin, path, method e schema. Redirect não aprovado, popup/download não previsto, URL ou header arbitrário, chamada fora da allowlist e response acima do limite são recusados. Requisições do Preview não recebem segredo de Stripe, Supabase control-plane, GitHub, ativação ou runner.
3. O contexto Playwright é exclusivo da tentativa/caso e descartável. Sessão e cookies residem apenas em memória. Não persistir cookies, `storageState`, trace, vídeo, screenshot de dados financeiros nem corpo bruto em artifact.
4. O publisher recebe `caseId`, namespace confiável, ambiente verificado e fence. Executa apenas RPCs nominais aprovadas, com validação transacional de attempt/fence e ownership; cria dados sintéticos novos e marcados, recusa IDs preexistentes e nunca altera catálogo fora do namespace ou apaga histórico. Não inclui envio de e-mail/invite real. Se um caso depender de e-mail sem sink isolado, ele não passa.
5. Readers separados e read-only obtêm snapshots Supabase da branch autorizada e objetos Stripe TEST por IDs conhecidos pelo controle. Cada leitura verifica `attemptId`, branch/account exatos, janela temporal e linhagem dos objetos. Ausência/divergência de reader ou provider interrompe a prova. Só projeções fechadas, sanitizadas e digests podem sair do adapter.
6. A resposta do Preview serve exclusivamente para conduzir a próxima interação. A conclusão de caso é decidida pelas observações independentes e contratos confiáveis.

### Falhas, segurança e recuperação

- Cada request tem timeout e máximo de bytes configurados. Apenas leituras provadamente idempotentes podem ser repetidas.
- Timeout/cancelamento durante POST ou mutação não é retryável por padrão. O reconciliador consulta leitores independentes; enquanto o efeito for incerto, mantém intent, lease e reserva pendentes.
- Perda do fence, destino incompatível, falha de reader, schema desconhecido, resposta inválida ou tentativa de operação fora da allowlist falha fechado, com código sanitizado. Não publicar resultado `passed`.
- A suíte usa lock global e é sequencial por padrão. Concorrência somente dentro do cenário que testa corrida, com identidade compartilhada naquele cenário.
- Recheck/takeover exige prova de término do runner anterior, remoção do runner e resolução terminal das intents. Tempo de lease, sozinho, não autoriza takeover.
- Cleanup bem-sucedido verifica ownership/inventário e ausência de acesso ativo, persiste recibo append-only e só então libera lease/reserva. Sempre retorna `databaseBaselineRestored=false` e `fixtureReusable=false`.
- Histórico financeiro, Auth e Stripe é retido; nenhum purge/branch rotation é parte deste desenho.

### Testes e critérios de aceite local

Testes offline devem cobrir: allowlist de origem/rota/método e schema; redirect, URL/header arbitrário e destino hostil; timeout e limite de bytes; requests e responses não confiáveis; isolamento e ausência de persistência de cookies; IDs não derivados de caller/run/email; operação RPC fora da allowlist; insert sem overwrite/delete; fence vencido; associação incorreta de branch/account/attempt/janela/objeto; reader ausente/falho; sanitização; e garantia de nenhuma chamada remota nos testes. Executar testes focados, `npm test` completo e `git diff --check`.

O TestSprite só será considerado se houver projeto/target frontend efetivamente pertinente à mudança. A Task 4 altera o control plane, não a UI do produto; TestSprite não substitui a suíte Node e nenhuma execução remota/Preview será iniciada sob esta autorização local.

O aceite Task 4 significa apenas que interfaces e testes offline atendem a este contrato. Não significa 43/43, saúde do Preview/Supabase/Stripe, aprovação de CI remoto ou prontidão para produção. Esses resultados dependem das Tasks 5–10 e dos gates externos documentados na spec principal.

## Riscos/gates ainda abertos

- Ainda é necessário validar e corrigir os três achados da revisão da Task 3 antes de iniciar a Task 4: recibo de cleanup antes de release; flags de retorno corretas; handoff de recovery retomável sem permitir takeover inseguro.
- A existência/configuração de RPCs de fixture e leitores com grants mínimos precisa ser comprovada em implementação local e, futuramente, por readback da branch filha autorizada. Nenhuma migration remota está aprovada aqui.
- Os estados atuais registrados de migration/fingerprint/webhook continuam externos e bloqueantes; esta documentação não os altera nem os revalida.
- A skill `multi-agent-brainstorming` não estava disponível na sessão. Para reduzir risco, o plano deverá usar implementação sequencial com subagente implementador e revisão independente por subagente, além dos gates de teste locais.
