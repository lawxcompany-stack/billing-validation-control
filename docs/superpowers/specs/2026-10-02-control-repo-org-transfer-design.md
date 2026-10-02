# Design: mover o repositório de controle para a organização GitHub Free

## Objetivo e decisão

Preparar a migração do repositório público `billing-validation-control` da conta pessoal `lawxcompany-stack` para a organização GitHub Free `lawx-ai`, de modo que o projeto possa usar um runner group de organização sem enfraquecer os limites do runner ou envolver o repositório da aplicação.

A mudança é exclusivamente no plano de controle. Não transfere `Plataforma-LawX`, não muda Supabase, Vercel Production ou Stripe Live e não executa cenários financeiros. O PR de código será preparado e revisado antes da operação de transferência. A transferência real será feita separadamente pelo owner do GitHub, após review/merge e confirmação das precondições.

## Contexto verificado

- `lawxcompany-stack/billing-validation-control` é público, propriedade de uma conta `User`, ID GitHub `1384018279`, branch padrão `main`.
- A implementação contém referências de identidade do controle em workflows, contrato de dispatch, autorização/atestações, trust policy do runner, imagem GHCR, testes e runbooks. Uma substituição textual global também alteraria referências legítimas à aplicação `lawxcompany-stack/Plataforma-LawX`; portanto, cada ocorrência será classificada pelo seu papel.
- O workflow de PR executa em `ubuntu-latest`. O runner privilegiado é selecionado apenas no caminho operacional protegido, por label de tentativa, e o registro atual requer o grupo `billing-validation-isolated`.
- GitHub anunciou runner groups com self-hosted runners para organizações Free. A documentação também alerta que repositórios públicos aumentam o risco de código de forks alcançar runners próprios; a política de grupo e workflow precisa ser lida de volta e provada antes de qualquer registro ou execução. Referências: [disponibilidade no Free](https://github.blog/changelog/2024-10-17-actions-runner-groups-now-available-for-organizations-on-free-plan) e [controles e avisos de runners](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access).
- GitHub informa que, em transferências, issues, PRs, secrets e deploy keys permanecem associados, enquanto permissões padrão da organização passam a valer; pacotes podem ser transferidos ou perder o vínculo conforme o registry. Por isso proteções, environments, App, colaboradores e GHCR exigem readback pós-transferência. Referência: [transferir um repositório](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository).
- A transferência e este PR não são evidência de prontidão financeira. O projeto Supabase de cenários ainda precisa receber sua configuração validada, o runner não foi registrado/testado e nenhum dos 43 cenários remotos foi comprovado.

## Invariantes de segurança

1. A identidade do repositório de controle é o ID GitHub `1384018279` combinado com owner/name canônico confirmado por readback; o nome sozinho nunca autoriza execução.
2. Após a transferência, o owner canônico esperado é `lawx-ai/billing-validation-control`. Se o GitHub readback não confirmar o mesmo ID e o nome canônico, todos os caminhos operacionais permanecem bloqueados; não se atualiza o pin automaticamente.
3. `lawxcompany-stack/Plataforma-LawX`, seu ID `1234079266`, branches, workflows, deployment e credenciais ficam fora do escopo da transferência e não podem ser reescritos como parte da migração.
4. Pull requests continuam exclusivamente em runners GitHub-hosted. Nenhum PR, fork, branch não protegida ou código da aplicação candidata pode selecionar o runner local.
5. O runner segue ephemeral, single-job, sem labels padrão e vinculado ao attempt. Não remover `--runnergroup`, reduzir validações de owner/repository ID, ampliar secrets ou aceitar runner persistente para fazer o job começar.
6. Nenhum runner é registrado/ativado e nenhum workflow financeiro é disparado antes de readback da branch protection, environments, owner/ID, grupo e restrições de workflow.
7. Nenhuma credencial, token, URL com senha, valor de secret, conteúdo financeiro ou estado de sessão entra no PR, logs, artifacts ou documentação.

## Desenho da alteração no repositório

O PR altera somente referências que identificam o repositório de controle. Antes da alteração, cada referência a `lawxcompany-stack/billing-validation-control` ou `ghcr.io/lawxcompany-stack/billing-validation-control` será classificada como identidade runtime, assinatura/attestation, runner, container package, fixture de teste ou documentação. Referências à aplicação candidata permanecem inalteradas.

O owner/name novo será centralizado onde isso for compatível com os limites atuais de módulos e APIs. Os validadores de dispatch e autorização continuarão falhando fechado para ID divergente, owner arbitrário, branch diferente de `main`, workflow/ref incorreto ou evento não autorizado. As fixtures testarão explicitamente identidade nova válida, identidade antiga apenas onde seja necessária para validar proveniência histórica, owner arbitrário com mesmo formato, ID errado e tentativa de usar a identidade da aplicação como controle.

Não se fará substituição global de strings nem edição das migrations já aplicadas/pinadas do control store. Dados históricos só poderão ser aceitos por uma regra explícita de compatibilidade e com prova de identidade pelo ID; caso os verificadores atuais não consigam provar essa vinculação, evidências antigas não autorizam execução e a migração para. O repositório ainda não tem execução financeira remota comprovada, então não se inventará uma compatibilidade de histórico para contornar validações.

### GHCR e artefatos assinados

O caminho `ghcr.io/lawxcompany-stack/billing-validation-control` não será renomeado por busca/substituição. Antes da transferência, registrar somente metadados não secretos do pacote: existência, visibilidade, vínculo ao repositório, digest/release consumido e permissões efetivas. Depois da transferência, confirmar qual owner/path e vínculo o GitHub apresenta. Só alterar o URI fixado se o readback provar a localização e o digest esperado; se pacote, assinatura ou provenance não puderem ser verificados, o caminho do runner permanece desabilitado até PR separado com nova revisão.

## Política do runner group

No owner `lawx-ai`, o grupo `billing-validation-isolated` deve:

- permitir somente `lawx-ai/billing-validation-control`;
- restringir o uso ao workflow operacional revisado na branch protegida `main` (no desenho atual, `.github/workflows/validate-billing.yml`); nenhum workflow de PR é elegível;
- não permitir acesso genérico a todos os repositórios nem aceitar automaticamente forks;
- ter acesso a repositório público habilitado somente se a configuração exigir isso e o workflow restriction exato estiver confirmado por API/readback independente;
- usar runner self-hosted ephemeral, single-job e label aleatória de 128 bits por attempt.

Se o GitHub Free não permitir aplicar/readback essas restrições exatas para o grupo escolhido, não se registra o runner. Não se substitui o grupo restrito pelo grupo default, runner de repositório amplo ou configuração que apenas confia em `runs-on`.

## Sequência de rollout

1. Manter dispatches operacionais congelados; deixar os checks normais de PR continuarem em `ubuntu-latest`.
2. Preparar este PR a partir do `main` integrado, adicionar primeiro testes que falhem para as novas identidades e manter migrations do control store intocadas.
3. Rodar suíte de testes, PostgreSQL local aplicável, lint de workflows, secret-boundary e diff checks; revisar o diff focado em todas as identidades fixas e em ausência de referências Production/Live/credenciais.
4. Obter aprovação independente e merge pela proteção já configurada. Até a transferência, não executar `collect`/`recheck` nem registrar runner.
5. O owner transfere, pela interface oficial do GitHub, somente `billing-validation-control` para `lawx-ai`; o agente não chama API/CLI de transferência. A visibilidade continua pública e o nome do repositório continua `billing-validation-control`.
6. Fazer readback pós-transferência: canonical owner/name, ID `1384018279`, branch padrão `main`, proteção e regras de review, Actions permissions, cinco environments e seus deployment/reviewer rules, nomes de secrets sem revelar valores, instalação/scopes do GitHub App, colaboradores/permissões, pacote GHCR, e runner group/restrições.
7. Executar primeiro apenas o workflow de policy/identity sem secrets e sem runner local. Verificar que pull requests permanecem em runner hospedado e que o workflow operacional não começa quando qualquer identidade/grupo está incorreto.
8. Só após esses critérios passarem, criar ou ajustar o grupo pelo owner, limitar a um repo e workflow e fazer Task 0/9 de readback da estação dedicada. O primeiro runner permanece single-use. Aprovação do ambiente e provisionamento de credenciais seguem seus gates existentes, sem inserir segredos no PR.
9. A validação financeira é uma etapa posterior e separada: projeto Supabase de cenários isolado e saudável, Preview imutável do SHA, Stripe TEST identificado, inbox/test webhook isolado, lease/fence/capacidade/recovery provados e todos os cenários aprovados com evidência independente. Nada nesta migração declara os 43 cenários aprovados.

## Falha, parada e recuperação

- Qualquer divergência de owner, ID, branch, workflow, protection, environment, colaborador, runner group ou GHCR é bloqueio; não há fallback automático.
- Se a transferência não concluir, o código deve continuar sem executar caminho operacional; checks hospedados continuam disponíveis. A recuperação é corrigir/reverter o PR por outro PR revisado, não reduzir guardas.
- Se a transferência concluir mas as políticas não forem preservadas, manter runners offline e restaurar manualmente as proteções aprovadas antes de reabrir dispatch. Não fazer transferência de volta automaticamente.
- Se o pacote GHCR mudar de localização ou permissão, não baixar/puxar imagem por um caminho alternativo e não publicar digest novo sem revisão e verificação independente.
- Não executar migrations Supabase, deploy Vercel, mutação Stripe, atualização de secrets nem alterações em produção durante esse rollout.

## Critérios de aceite do PR

- Cada identidade fixa do controle foi inventariada; identidade de candidato não foi alterada.
- Testes negativos cobrem ID errado, owner/name estranho, branch/ref/workflow divergente e caminho PR tentando alcançar runner self-hosted.
- O workflow de PR permanece em runner hospedado e secrets permanecem indisponíveis nele.
- Não há mudança nas migrations/pins do control store, chaves de signing, policy financeira, Vercel, Stripe ou Supabase.
- Suíte integral, PostgreSQL harness aplicável, lint workflow, secret-boundary e `git diff --check` passam localmente e o check `policy` passa no PR.
- O PR documenta as leituras externas pós-transferência como gates, sem afirmar que elas ocorreram.

## Fora do escopo e estado de produção

Fora do escopo: transferir a aplicação, iniciar/configurar o runner neste PR, mudar organização/planos pagos, criar ou alterar projetos Supabase, adicionar secrets, fazer deploy, migrar billing, usar Stripe Live, executar cobrança/fixture real ou habilitar produção.

Estado atual: esta alteração é pré-requisito de controle de acesso, não certificação de prontidão. Produção continua **não validada** enquanto o runner, o ambiente remoto isolado e os 43 cenários não tiverem evidência completa e revisada.
