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
| Os 43 IDs de caso são os IDs fixos do registro `BILLING_43_IDS`; apenas IDs de recursos/fixtures são aleatórios, com namespace distinto por tentativa/caso. | Randomizar IDs de cenário ou reutilizar run ID, e-mail/IDs fornecidos pelo operador ou fixture global. | Mantém a suíte canônica estável sem sacrificar isolamento/replay. Casos de replay/corrida só compartilham identidade de recurso dentro do mesmo caso. |
| Mutação por RPC nominal allowlisted, com ownership e fence verificados na mesma transação; somente inserções sintéticas. | Escrita direta em tabelas, operação genérica, update/delete ou SQL do candidato. | Preserva isolamento, append-only e controle atômico de ownership. |
| Leitores independentes e read-only para Supabase, inbox/recibos de webhook Supabase e objetos/eventos/endpoint Stripe TEST. | Tratar HTTP/UI, resposta de mutação ou payload do candidato como prova. | Vincula prova à branch, conta, endpoint, evento e recurso corretos sem confiar na aplicação avaliada. |
| A reserva suficiente, lease e fence são pré-condição verificada antes da primeira RPC de fixture; cada escrita revalida ownership na transação. | Começar publicação e verificar capacidade/lease durante ou depois das mutações. | Falha fechada com zero escrita se a tentativa não tiver capacidade e ownership válidos. |
| Identidades Auth só são criadas pelo fluxo normal de signup no Preview; confirmação de e-mail exige inbox isolado sem entrega. | Criar identidade por SQL/admin Auth ou enviar e-mail real. | Exercita o caminho de produto sem falsificar Auth nem contactar terceiros; casos dependentes ficam bloqueados sem inbox seguro. |
| O bundle imutável do Preview pode rodar apenas no browser descartável; o processo Node privilegiado nunca importa/avalia código do candidato. | Executar artifacts da PR no coletor ou permitir scripts/operações definidos por resposta. | Exercita a UI real mantendo código não confiável fora da fronteira privilegiada e sem autoridade operacional. |
| Timeout/resultado de mutação ambíguo não é repetido; manter lease/reserva para reconciliação. | Retry automático, inclusive com chave idempotente igual. | Evita duplicar efeitos externos e não assume que idempotência do provider seja permanente. |
| Cleanup só libera recursos depois de reconciliação e recibo append-only persistido. | Liberar ao expirar lease ou após cleanup apenas em memória. | Impede perder evidência/ownership e corrige requisito já aprovado no plano. |
| Testes locais/offline são o aceite da Task 4; TestSprite não substitui testes do backend nem autoriza execução remota. | Tratar suíte local ou screenshot como validação financeira remota. | Mantém a distinção entre teste do controle e prova de ambiente/provider real. |

## Desenho final

### Componentes e fluxo

1. Uma tentativa já admitida pelo control plane fornece `attemptId`, `fixtureRunId` e fence vigente. Os IDs dos casos vêm exclusivamente do registro canônico e congelado `BILLING_43_IDS`, exatamente uma vez cada; IDs de caso não são aleatórios. Aleatoriedade criptográfica é usada apenas para IDs dos recursos/fixtures de cada tentativa e caso. Nenhum ID financeiro, e-mail ou operação é escolhido por caller ou por resposta do candidato.
2. Antes de qualquer RPC de fixture, a tentativa precisa possuir reserva suficiente de capacidade, lease da branch/conta e fence vigente. O adapter confere esses vínculos antes da primeira chamada e a mutação os revalida atomicamente na transação; reserva ausente/insuficiente, lease perdido ou fence divergente implica zero escrita.
3. O adapter Playwright recebe apenas o deployment imutável previamente verificado e o catálogo fechado de jornadas. É permitido carregar e executar o bundle imutável do Preview dentro do browser descartável e restrito, para exercitar as jornadas reais. É proibido importar ou executar artifacts/código candidato no processo Node privilegiado, injetar scripts arbitrários ou deixar respostas escolher operações. Toda navegação/request é comparada com allowlist de HTTPS origin, path, method e schema. Redirect não aprovado, popup/download não previsto, URL ou header arbitrário, chamada fora da allowlist e response acima do limite são recusados. Requisições do Preview não recebem segredo de Stripe, Supabase control-plane, GitHub, ativação ou runner.
4. O contexto Playwright é exclusivo da tentativa/caso e descartável. Sessão e cookies residem apenas em memória. Não persistir cookies, `storageState`, trace, vídeo, screenshot de dados financeiros nem corpo bruto em artifact.
5. O publisher recebe somente `caseId` do registro `BILLING_43_IDS`, namespace aleatório confiável, ambiente verificado e fence. Antes da primeira RPC, exige reserva/capacidade e lease/fence válidos; cada RPC nominal aprovada revalida transacionalmente attempt/fence, reserva e ownership. Cria dados sintéticos novos e marcados, recusa IDs preexistentes e nunca altera catálogo fora do namespace ou apaga histórico. Identidades Auth só podem ser criadas pela jornada real de cadastro na rota do Preview; é proibido SQL direto em `auth.users` e uso da API administrativa Auth para fabricar identidades. Não inclui envio de e-mail/invite real. Se houver confirmação de e-mail, exige inbox isolado, verificado e sem entrega; caso contrário, o caso e os dependentes ficam bloqueados antes da mutação.
6. Antes de qualquer mutação do provider, o controle confirma que cada reader obrigatório está disponível, read-only e fixado à branch/conta/endpoint corretos; a inexistência ou divergência dessa capacidade/configuração bloqueia o dispatch. Após a jornada gerar efeitos, readers separados obtêm snapshots Supabase da branch autorizada, registros/recibos da inbox de webhook Supabase e objetos/eventos Stripe TEST por IDs ou chaves de busca derivados pelo controle. Cada observação verifica `attemptId`, branch/account exatos, endpoint/event/object, janela temporal e linhagem; os readers correlacionam evento Stripe com inbox/recibo Supabase sem confiar na resposta do candidato. Ausência ou divergência da evidência esperada impede aprovação e mantém recursos/intent para reconciliação. Só projeções fechadas, sanitizadas e digests podem sair do adapter.
7. A resposta do Preview serve exclusivamente para conduzir a próxima interação. A conclusão de caso é decidida pelas observações independentes e contratos confiáveis.

### Falhas, segurança e recuperação

- Cada request tem timeout e máximo de bytes configurados. Apenas leituras provadamente idempotentes podem ser repetidas.
- Timeout/cancelamento durante POST ou mutação não é retryável por padrão. O reconciliador consulta leitores independentes; enquanto o efeito for incerto, mantém intent, lease e reserva pendentes.
- Perda do fence, destino incompatível, falha de reader, schema desconhecido, resposta inválida ou tentativa de operação fora da allowlist falha fechado, com código sanitizado. Não publicar resultado `passed`.
- A suíte usa lock global e é sequencial por padrão. Concorrência somente dentro do cenário que testa corrida, com identidade compartilhada naquele cenário.
- Recheck/takeover exige prova de término do runner anterior, remoção do runner e resolução terminal das intents. Tempo de lease, sozinho, não autoriza takeover.
- Cleanup bem-sucedido verifica ownership/inventário e ausência de acesso ativo, persiste recibo append-only e só então libera lease/reserva. Sempre retorna `databaseBaselineRestored=false` e `fixtureReusable=false`.
- Histórico financeiro, Auth e Stripe é retido; nenhum purge/branch rotation é parte deste desenho.

### Testes e critérios de aceite local

Testes offline devem cobrir: lista exata e sem duplicatas dos 43 IDs canônicos; IDs aleatórios de recursos não derivados de caller/run/email; reserva insuficiente/ausente, lease/fence vencido e garantia de zero RPC; allowlist de origem/rota/método e schema; execução somente do bundle imutável dentro do browser isolado (sem import/exec no Node privilegiado ou injeção arbitrária); redirect, URL/header arbitrário e destino hostil; timeout e limite de bytes; requests e responses não confiáveis; isolamento e ausência de persistência de cookies; operação RPC fora da allowlist; insert sem overwrite/delete; tentativa de criação Auth fora da rota nativa e bloqueio sem inbox isolado; associação incorreta de branch/account/attempt/janela/objeto; reader ausente/falho incluindo endpoint/evento Stripe e inbox/recibo de webhook Supabase; sanitização; e garantia de nenhuma chamada remota nos testes. Executar testes focados, `npm test` completo e `git diff --check`.

O TestSprite só será considerado se houver projeto/target frontend efetivamente pertinente à mudança. A Task 4 altera o control plane, não a UI do produto; TestSprite não substitui a suíte Node e nenhuma execução remota/Preview será iniciada sob esta autorização local.

O aceite Task 4 significa apenas que interfaces e testes offline atendem a este contrato. Não significa 43/43, saúde do Preview/Supabase/Stripe, aprovação de CI remoto ou prontidão para produção. Esses resultados dependem das Tasks 5–10 e dos gates externos documentados na spec principal.

## Riscos/gates ainda abertos

- Os achados das revisões da Task 3 foram corrigidos e a rodada 2 recebeu revisão independente limpa. A implementação da Task 4 pode começar localmente; isso não supre a integração futura dos verificadores de recovery/cleanup exigidos nas Tasks 8/9.
- A existência/configuração de RPCs de fixture e leitores com grants mínimos precisa ser representada por interfaces fail-closed e testes locais, e futuramente comprovada por readback da branch filha autorizada. Nenhuma migration remota está aprovada aqui.
- Os estados atuais registrados de migration/fingerprint/webhook continuam externos e bloqueantes; esta documentação não os altera nem os revalida.
- A skill `multi-agent-brainstorming` não estava disponível na sessão. Para reduzir risco, o plano deverá usar implementação sequencial com subagente implementador e revisão independente por subagente, além dos gates de teste locais.
