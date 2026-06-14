# Como conectar o seu Google Calendar ao atendimento automático

Olá! Este guia liga a sua agenda do Google ao atendimento automático. Depois de conectado, todo horário que um cliente marcar pela conversa aparece **sozinho** na sua agenda — sem você digitar nada. Vamos com calma, um passo de cada vez. Você consegue.

> **Importante, leia antes:** em nenhum momento isto cobra nada de você. Não precisa de cartão de crédito. Tudo aqui é gratuito.

---

## O que você vai precisar (uns 10 minutos)

- Um **computador** com o navegador **Chrome** (dá pra fazer no celular, mas no computador é bem mais fácil).
- **Uma conta Gmail.** A nossa recomendação forte: crie uma conta **só para isto**, dedicada a este negócio — por exemplo `agenda.nomedocliente@gmail.com`. E dentro dela, uma **agenda separada** (não a sua agenda pessoal).
  - **Por quê?** Assim os horários do atendimento ficam isolados da sua vida particular. O robô que marca os horários não enxerga seus compromissos pessoais, e fica fácil desligar tudo depois se você quiser.
- Cerca de **10 minutos** sem pressa.

> ### ⭐ Regra de ouro: use a MESMA conta do começo ao fim
> Faça tudo, do **Passo 1 ao Passo 6**, logado na **mesma conta Gmail dedicada** (`agenda.nomedocliente@gmail.com`). **Não troque de conta no meio.** A "conta dona da agenda" do Passo 5 é essa mesma — não é outra. Quem tem várias contas Google abertas troca sem perceber; por isso, ao entrar em cada nova tela, dê uma olhada na **bolinha do canto superior direito** e confirme o e-mail.

> ### 🌐 E se a tela aparecer em inglês?
> O Google Cloud às vezes abre em inglês. Você pode trocar o idioma no **seletor lá no rodapé** da página (escolha **Português (Brasil)**), ou usar este mini-glossário:
> | Português | Inglês |
> |---|---|
> | Criar | Create |
> | Ativar | Enable |
> | Gerenciar | Manage |
> | Contas de serviço | Service Accounts |
> | Criar e continuar | Create and Continue |
> | Concluído | Done |
> | Chaves | Keys |
> | Adicionar chave | Add Key |
> | Criar nova chave | Create new key |
> | Configurações e compartilhamento | Settings and sharing |
> | Fazer alterações nos eventos | Make changes to events |
> | Integrar agenda | Integrate calendar |
> | ID da agenda | Calendar ID |

Ao longo do caminho vamos usar dois termos. Já explico em uma frase cada:

- **Conta de serviço (ou "robô"):** é um usuário automático — pense num "funcionário robô com crachá próprio" — que mexe na sua agenda em nome do sistema, sem ninguém precisar fazer login toda vez.
- **Chave JSON:** é a "senha" desse robô, só que em vez de uma palavra digitada, é um **arquivo** que você baixa. **Quem tem o arquivo, é o robô** — por isso ele vale como senha máxima.

---

## ⚠️ Os dois avisos que evitam quase todos os problemas

Leia com atenção, porque 9 em cada 10 erros caem num destes dois pontos:

1. **Se você não ATIVAR a API do Calendar (Passo 2), tudo falha com erro `403`.**
2. **Se você não COMPARTILHAR a agenda com o robô (Passo 5), tudo falha com erro `404`.**

Os dois passos são obrigatórios. Se você fizer tudo certo nestes dois, dificilmente vai dar problema.

E mais um cuidado de segurança, que vale repetir:

> **⚠️ O arquivo JSON é uma senha.** Nunca mande ele em grupo de WhatsApp, nunca poste um print do conteúdo, nunca jogue num lugar público. Trate como se fosse a chave do seu cofre.

---

## Passo 1 — Criar o projeto no Google Cloud

**Por que importa:** o "projeto" é só uma pasta onde o Google guarda toda essa configuração. Sem ele, não dá pra seguir.

1. Abra o **Chrome**. No canto superior direito tem uma bolinha com a sua foto ou inicial — confira que é a conta certa (a `agenda.nomedocliente@gmail.com`). Se for outra, clique nela e troque de conta.
   - ⚠️ **Estar na conta errada aqui é o erro mais caro de desfazer.** O projeto fica preso numa conta que não é a do negócio. Confira antes de continuar.
2. Na barra de endereço (lá em cima, onde aparece o endereço dos sites), digite: **console.cloud.google.com/projectcreate** e aperte **Enter**.
   - **O que aparece:** abre a tela escrita **"Novo projeto"**, com um campo de nome esperando. (Se for a primeiríssima vez, antes disso aparece uma tela de boas-vindas: escolha o país **Brasil**, marque o aceite dos termos e clique no botão de aceitar — pode se chamar **"Concordo e continuar"** ou **"Concordar e continuar"**. Essa tela só aparece uma vez. Aceitar os termos é **grátis** e **não pede cartão**.)
   - **Se cair na tela errada:** se depois de aceitar você for parar na tela inicial do Console em vez do **"Novo projeto"**, é só colar **console.cloud.google.com/projectcreate** de novo.
3. No campo **"Nome do projeto"**, digite algo fácil de reconhecer, como **`Agenda Edu Barbearia`**. (Regra: de 4 a 30 caracteres; **pode** ter espaço, mas **não** use acento nem ç.)
   - **O que aparece:** logo abaixo, um **"ID do projeto"** é gerado sozinho (algo como `agenda-edu-barbearia-123456`). Pode deixar como está.
4. Olhe o campo **"Local"**. Numa conta Gmail comum ele mostra **"Sem organização"** (ou **"Nenhuma organização"** — é a mesma coisa) — não mexa em nada.
5. Clique no botão **"Criar"**.
   - **O que aparece:** uma rodinha de carregando por 10 a 60 segundos, e um aviso no **sininho** (canto superior direito) dizendo **"Projeto criado"**. Em nenhum momento pediram cartão.
6. Confira que o **nome do projeto novo** aparece fixo no topo, ao lado de "Google Cloud".
   - **Por que importa:** se o projeto errado estiver selecionado, você configura tudo no lugar errado e fica sem entender por que "não funciona".
   - A notificação do sininho some sozinha em poucos segundos — não tem problema. O que importa é o **nome certo aparecer no topo**; se não aparecer, clique no seletor de projeto no topo, na aba **"Recentes"**, e abra o projeto novo.

> 💡 **Conta muito nova?** Em raríssimos casos, o Google pede uma verificação rápida por SMS (telefone) antes de liberar a criação de projetos. Isso continua sendo **gratuito** e **não é cobrança** — é só uma checagem de segurança. Se aparecer, conclua a verificação e siga.

---

## Passo 2 — Ativar a Google Calendar API

**Por que importa:** "ativar a API" é dar permissão pro Google deixar o nosso sistema mexer na sua agenda. **Sem isto, todo agendamento falha com erro `403`.**

1. Na barra de endereço, cole: **console.cloud.google.com/apis/library/calendar-json.googleapis.com** e aperte **Enter**.
   - **O que aparece:** a página da **"Google Calendar API"**.
2. ⚠️ **Antes de clicar em "Ativar", olhe o seletor de projeto no topo** (ao lado de "Google Cloud").
   - **Se ele NÃO mostrar o nome do seu projeto** (aparece "Selecione um projeto" ou outro nome), clique nesse seletor, vá na aba **"Recentes"** e escolha o projeto que você criou no Passo 1.
   - **Por que isto é crucial:** ao colar o link direto, o Console **muitas vezes abre sem nenhum projeto selecionado**. Quando isso acontece, o botão **"Ativar" fica cinza/apagado** e nada acontece ao clicar. **Isso não é bug** — é só o projeto que não está selecionado. Selecione-o primeiro e o botão fica clicável.
3. Clique no botão de ação principal escrito **"Ativar"** (geralmente azul).
   - **O que aparece:** uma carregada de poucos segundos e, no lugar do "Ativar", passa a aparecer **"Gerenciar"**. Esse é o sinal de que deu certo.
   - **Se aparecer um aviso de Termos de Serviço:** marque o aceite e confirme — é **gratuito** e **não pede cartão**. Depois disso o "Ativar" vira "Gerenciar" normalmente.
4. **Confira de novo** que o nome do **projeto certo** continua no topo depois de ativar.
   - **Por que importa:** ativar no projeto errado é a **causa nº1** do erro `403`.
5. **Espere de 1 a 2 minutos** antes de testar qualquer coisa.
   - **Por que importa:** logo após ativar, a primeira tentativa ainda pode dar `403` por alguns instantes. É só a ativação "se espalhar" pelos sistemas do Google. Não é erro seu — espere um minuto e tente de novo.

> 💡 Se você abriu a página e já aparece **"Gerenciar"** em vez de **"Ativar"**, ótimo: significa que a API **já estava ligada**. Pode seguir em frente.

---

## Passo 3 — Criar a conta de serviço (o robô)

**Por que importa:** é o "robô" que vai marcar os horários por você. Sem ele, não há quem mexa na agenda automaticamente.

1. Na barra de endereço, cole: **console.cloud.google.com/iam-admin/serviceaccounts** e aperte **Enter** (confira o projeto certo no topo).
   - **Alternativa pelo menu:** clique no **menu** (ícone de três tracinhos ☰) no canto superior **esquerdo** → **"IAM e administrador"** → **"Contas de serviço"**. Pode ser preciso **rolar o submenu** até achar "Contas de serviço".
   - **O que aparece:** a lista de robôs do projeto. Na primeira vez ela costuma estar vazia.
2. Clique em **"Criar conta de serviço"** no topo da tela.
   - **O que aparece:** um formulário em etapas.
3. No campo **"Nome da conta de serviço"**, digite algo como **`robo-agenda-cirilo`**. O campo de **ID** embaixo se preenche sozinho — não mexa. Clique em **"Criar e continuar"**.
4. As etapas seguintes (papéis/permissões e acesso) são **opcionais**: **não escolha nada** — clique em **"Continuar"** e depois em **"Concluído"** (ou em **"Concluído"** direto, se ele já aparecer).
   - **Por que importa:** muita gente trava aqui achando que precisa escolher uma permissão. **Não precisa.** O robô vai ser autorizado direto na sua agenda (Passo 5), não aqui. Pular é o caminho certo.
   - Se você **adicionou um papel sem querer**, não tem problema — pode remover ou deixar; o que autoriza o robô de verdade é o compartilhamento da agenda no Passo 5, não o papel aqui.
   - **O que aparece:** você volta para a lista, e o robô novo aparece com um e-mail terminando em **`.iam.gserviceaccount.com`** (esse e-mail estranho, que **não** termina em `@gmail.com`, é normal — é o "crachá" do robô).

---

## Passo 4 — Baixar a chave JSON (a "senha" do robô)

**Por que importa:** sem a chave, o sistema não tem como provar que é o robô. É ela que conecta tudo.

> **⚠️ Lembrete:** essa chave é uma senha. Nunca mande em grupo, nunca poste print, nunca suba para um repositório de código.

1. Na lista, **clique em cima do robô** que você acabou de criar (no nome ou no e-mail dele).
   - **O que aparece:** a página de detalhes do robô, com abas no topo (Detalhes, Permissões, **Chaves**, etc.).
2. Clique na aba **"Chaves"** → botão **"Adicionar chave"** → opção **"Criar nova chave"**.
   - **⚠️ Botão cinza/bloqueado?** Se **"Adicionar chave"** estiver desabilitado ou aparecer **"Service account key creation is disabled"** (criação de chave desativada), sua conta está numa **organização com política de segurança** que bloqueia chaves. **Não dá pra resolver sozinho por aqui** — fale com o responsável pela configuração. (Em conta Gmail pessoal "Sem organização" isso normalmente não acontece.)
   - **O que aparece (caso normal):** uma janelinha perguntando o tipo, com **"JSON"** já marcado.
3. Confirme que está em **"JSON"** (e **não** "P12") e clique em **"Criar"**.
   - **O que aparece:** o navegador **baixa automaticamente** um arquivo `.json` (geralmente na pasta Downloads), com nome tipo `agenda-edu-barbearia-123-abcdef.json`.
   - **Pode aparecer um aviso amarelo** de segurança sobre chaves de conta de serviço — **é esperado, NÃO é erro**. O arquivo já foi baixado. Clique em **"Fechar"**.
   - **Por que importa:** o Google **não guarda** uma segunda cópia desse arquivo. Se você perder, **não** dá pra baixar de novo o mesmo — só gerar uma chave nova. Guarde com cuidado já agora.
4. Abra o arquivo no **Bloco de Notas** e localize a linha **`client_email`** (dica: aperte **Ctrl+F** e digite `client_email`). Copie **só** o e-mail entre aspas — por exemplo `robo-agenda-cirilo@seu-projeto.iam.gserviceaccount.com` — **sem** as aspas e **sem** o texto `client_email`.
   - **Por que importa:** esse é o e-mail do robô que você vai "convidar" na agenda no próximo passo.

---

## Passo 5 — Compartilhar a agenda com o robô

**Por que importa:** este é o passo que dá ao robô o direito de marcar horários na sua agenda. **Sem ele, tudo falha com erro `404` ("agenda não encontrada")** — para o sistema, uma agenda que o robô não enxerga simplesmente "não existe".

> Atenção: este passo é no **Google Agenda** (calendar.google.com), **não** no Google Cloud. Use a **mesma conta dedicada** de sempre — a "conta dona da agenda" é essa mesma. Confira a bolinha do canto.

1. Abra **calendar.google.com**, logado na conta dedicada (`agenda.nomedocliente@gmail.com`).
2. **Crie a agenda dedicada** (se ainda não tem uma):
   - Na coluna da esquerda, ao lado de **"Outras agendas"**, clique no **+** → **"Criar nova agenda"** → dê um nome (ex.: **`Atendimento Edu Barbearia`**) → **"Criar agenda"**. Depois volte para a tela principal.
   - ⚠️ **Não use sua agenda pessoal.** Se você compartilhar a agenda pessoal, o robô passa a poder criar, mover e apagar os seus compromissos particulares. Uma agenda dedicada mantém tudo isolado.
3. Na coluna da esquerda, em **"Minhas agendas"**, passe o mouse sobre o **nome** da agenda dedicada; aparece um ícone de **três pontos** (com o aviso **"Opções"**) → clique nele → **"Configurações e compartilhamento"**.
   - **O que aparece:** a tela de configurações daquela agenda específica. (Se a lista de agendas não aparecer, a janela pode estar estreita: clique no menu ☰ no canto superior esquerdo para abrir a coluna.)
4. Role até a seção **"Compartilhar com pessoas ou grupos específicos"** e clique em **"Adicionar pessoas e grupos"** (em algumas versões aparece como **"Adicionar participantes e grupos"** — é o mesmo botão).
   - **O que aparece:** uma janelinha com um campo para digitar e-mail.
5. **Cole** o `client_email` do robô (que você copiou no Passo 4).
   - **O que aparece:** o Google pode mostrar "sem foto / não reconhecido". **Isso é normal** para um robô — adicione mesmo assim.
6. No seletor de permissão, escolha exatamente **"Fazer alterações nos eventos"**.
   - ⚠️ **Não escolha "Ver todos os detalhes do evento".** Essa opção é só leitura: o robô consegue *ver* a agenda, mas **não** consegue marcar horários (dá erro `403` na hora de criar).
   - E **não escolha "Fazer alterações e gerenciar compartilhamento"** (a opção logo abaixo): ela dá mais poder do que o robô precisa. O nível certo é, exatamente, **"Fazer alterações nos eventos"**.
7. Clique em **"Enviar"**.
   - **O que aparece:** a janelinha fecha e o e-mail do robô aparece na lista de compartilhamento **com "Fazer alterações nos eventos" escrito ao lado** — confira isso para ter certeza de que gravou.
   - **Por que importa:** como é uma **conta de serviço (robô)** e não uma pessoa, **não há caixa de e-mail** para receber convite nem nada para "aceitar" — o acesso vale **na hora**. Se o Google mostrar algum aviso sobre notificar a pessoa, pode confirmar normalmente. (Se você fechar a janela **sem** clicar **"Enviar"**, nada é salvo.)

---

## Passo 6 — Pegar o ID da agenda e conectar

**Por que importa:** o "ID" é o endereço da sua agenda. É ele que diz ao sistema *em qual* agenda marcar os horários.

1. Ainda na mesma tela de configurações da agenda, role para baixo até a seção **"Integrar agenda"**.
2. Localize o campo **"ID da agenda"** e copie o valor **inteiro**.
   - **O que aparece:** numa agenda dedicada, o ID é um código longo que termina em **`@group.calendar.google.com`** (algo como `c_3f8a...k2@group.calendar.google.com`).
   - ⚠️ **Copie só o campo "ID da agenda".** Nessa mesma seção aparecem também "URL público", "Código de incorporação" e "Endereço no formato iCal" — **ignore esses**, eles confundem.
3. Garanta que esse ID é o da **mesma** agenda que você compartilhou no Passo 5.
   - **Por que importa:** se o ID for de outra agenda (ou estiver incompleto), o sistema não encontra a agenda certa e dá `404`, mesmo com o compartilhamento feito.
   - ⚠️ **Se o ID for o seu próprio e-mail** (termina em `@gmail.com`), você pegou a **agenda pessoal** — pare e use a **agenda dedicada**, senão o robô enxerga seus compromissos particulares. Numa agenda dedicada o ID **sempre** termina em `@group.calendar.google.com`.
4. Entregue, por um **canal seguro**, a quem cuida da configuração: o **arquivo `.json`** e o **ID da agenda**.
   - **Como entregar com segurança:** **não** por grupo de WhatsApp comum. Prefira o canal combinado com quem configura (ex.: upload direto no painel, ou anexo num canal privado).
   - **Depois que a conexão estiver funcionando:** mova o arquivo `.json` para um local protegido ou **apague-o** do computador — quem configura já tem a cópia. Não deixe o `.json` "esquecido" na pasta Downloads.
5. **Pronto!** A conexão é ligada por quem configura. Pode levar **alguns minutos** até o primeiro horário aparecer. Se não aparecer em **~10 minutos**, avise o responsável (em vez de refazer tudo do zero).

---

## Já tenho isso configurado e quero trocar/refazer?

Você **não** precisa recriar tudo do zero:

- **Trocar só a chave (a antiga sumiu ou vazou):** reutilize o **mesmo projeto** e o **mesmo robô**. Vá na aba **"Chaves"** → **"Adicionar chave"** → **"Criar nova chave"** (JSON), entregue a nova e **apague a antiga** na mesma aba. Apagar a chave **revoga o acesso na hora**.
- **Trocar de agenda:** refaça o **Passo 5** e o **Passo 6** na agenda nova e reenvie o JSON + o novo **ID da agenda** a quem configura.
- **Reaproveitar:** o mesmo robô/projeto serve para várias trocas — só a chave e/ou a agenda mudam.

---

## Deu erro? Tabela rápida de soluções

| Sintoma / erro | Causa provável | Como resolver |
|---|---|---|
| **Erro `403`** ao agendar ("API has not been used in project... or it is disabled") | A Google Calendar API não foi **ativada**, ou foi ativada no **projeto errado**. | Refaça o **Passo 2** no projeto certo (confira o nome no topo). Se acabou de ativar, **espere 1-2 minutos** e tente de novo. |
| Botão **"Ativar"** está **cinza/apagado** e não clica | Nenhum projeto está selecionado no topo (link direto abre "no vazio"). | Clique no seletor de projeto no topo → aba **"Recentes"** → escolha seu projeto. O botão fica clicável. **Não é bug.** |
| **Erro `404`** ("Calendar not found" / agenda não encontrada) | A agenda **não foi compartilhada** com o robô, ou foi compartilhada com o e-mail errado. | Refaça o **Passo 5**: confira que o e-mail listado é **exatamente** o `client_email` do JSON (termina em `.iam.gserviceaccount.com`). Copie e cole, nunca digite à mão. |
| **Erro `403`** só ao **criar** horário (ler funciona) | O robô recebeu permissão de **só leitura** ("Ver todos os detalhes"). | Na agenda, edite a permissão do robô para **"Fazer alterações nos eventos"**. |
| Botão **"Adicionar chave"** está **cinza** / "Service account key creation is disabled" | A conta está numa **organização** com política que bloqueia chaves. | Não dá pra resolver sozinho — **fale com o responsável pela configuração**. |
| Baixou arquivo `.p12` e o sistema não aceita | Foi marcado "P12" em vez de "JSON". | Refaça o **Passo 4** e escolha **"JSON"** antes de clicar em "Criar". |
| O robô aparece "sem foto / não reconhecido" ao adicionar | Robôs não têm perfil Google visível. | É **normal**, não é erro. Adicione mesmo assim, só confira que o e-mail está completo. |
| Botão **"Ativar"** não aparece, só **"Gerenciar"** | A API **já estava ativada**. | Tudo certo, pode seguir. Se ainda der `403`, o problema está no compartilhamento (Passo 5) ou no projeto do robô. |
| Perdi o arquivo `.json` | O Google só entrega a chave **uma vez**. | Gere uma **chave nova** (Passo 4) e apague a antiga na aba "Chaves". |
| ID copiado termina em **`@gmail.com`** | Você pegou a agenda **pessoal**, não a dedicada. | Crie/use uma **agenda dedicada** e copie o ID dela (termina em `@group.calendar.google.com`). |
| Não acho os "três pontinhos" / a lista de agendas sumiu | Janela estreita esconde a coluna, ou o mouse não está sobre o nome. | Clique no menu ☰ (canto superior esquerdo) para abrir a coluna; passe o mouse devagar sobre o nome da agenda. |
| A tela do Google está toda **em inglês** | O Console abriu noutro idioma. | Troque no seletor de idioma do rodapé (Português do Brasil) ou use o glossário PT/EN lá do começo do guia. |
| Configurei tudo, mas estava na **conta Google errada** | Várias contas logadas no navegador. | Confira o e-mail na bolinha do canto superior direito. Faça tudo numa janela anônima logada **só** na conta certa. |

---

## Perguntas frequentes

**Vou ser cobrado por isso?**
Não. Criar o projeto e ativar a Google Calendar API são gratuitos e **não pedem cartão**. Se o Google oferecer "ativar avaliação gratuita" ou "adicionar forma de pagamento", pode ignorar/fechar — não é necessário aqui. (Em conta nova, o Google pode pedir uma verificação rápida por SMS antes de criar projetos: isso é só segurança, continua gratuito.)

**Por que criar uma conta Gmail e uma agenda só pra isto?**
Pra isolar. Se você compartilhar sua agenda **pessoal**, o robô passa a poder criar, mover e apagar os seus compromissos particulares também. Uma agenda dedicada mantém o atendimento separado da sua vida e facilita desligar o acesso depois.

**Preciso usar a mesma conta Google em todos os passos?**
Sim. Use a **mesma conta dedicada** do Passo 1 ao Passo 6. A "conta dona da agenda" do Passo 5 é exatamente essa — não é uma segunda conta. Quem tem várias contas abertas troca sem perceber, então confira a bolinha do canto a cada nova tela.

**Como crio a "agenda dedicada"?**
Em calendar.google.com, na coluna da esquerda, ao lado de **"Outras agendas"** clique no **+** → **"Criar nova agenda"** → dê um nome → **"Criar agenda"**. Pronto, ela aparece em "Minhas agendas".

**Esse "robô" vai ver minha agenda pessoal?**
Não. Ele só enxerga a agenda que você compartilhou com ele no Passo 5. Por isso recomendamos compartilhar uma agenda dedicada, e não a pessoal.

**O e-mail do robô não termina em @gmail.com. Está errado?**
Está certo. O e-mail do robô termina em `.iam.gserviceaccount.com` — é assim mesmo. Não procure por um e-mail "normal".

**A tela apareceu em inglês. E agora?**
Tranquilo: troque o idioma no seletor do rodapé da página (escolha Português do Brasil), ou use o glossário PT/EN do começo do guia — os botões são os mesmos, só com o nome traduzido.

**Por que o arquivo JSON é tão importante?**
Porque ele é a senha do robô. Quem tiver o arquivo consegue agir como o robô. Por isso: nunca mande em grupo de WhatsApp, nunca poste print, nunca suba para repositório de código. Depois que tudo estiver funcionando, mova-o para um lugar seguro ou apague-o do computador. Se ele vazar, apague a chave na aba "Chaves" e gere uma nova na hora.

**Cliquei em "Ativar" e ainda deu erro 403. Fiz algo errado?**
Provavelmente não. Logo após ativar, a primeira tentativa pode falhar por alguns instantes enquanto a ativação se espalha pelos sistemas do Google. Espere 1-2 minutos e tente de novo. (Se persistir, confira se ativou no **projeto certo** — é a causa nº1.)

**O botão "Ativar" está cinza e não clica. Por quê?**
Quase sempre porque **nenhum projeto está selecionado** no topo. Clique no seletor de projeto (ao lado de "Google Cloud") → aba "Recentes" → escolha o seu projeto. Aí o botão fica clicável.

**O robô precisa "aceitar" o convite da agenda?**
Não. Diferente de uma pessoa, o robô não recebe e nem aceita convite. Assim que ele aparece na lista de compartilhamento com "Fazer alterações nos eventos", o acesso já vale.

**Já tinha configurado antes e quero trocar. Refaço tudo?**
Não precisa. Para trocar só a chave, reutilize o mesmo projeto e robô e gere uma chave nova na aba "Chaves" (apague a antiga). Para trocar de agenda, refaça os Passos 5 e 6 na agenda nova e reenvie o JSON + o novo ID. Apagar a chave antiga revoga o acesso na hora.

**Quanto tempo até funcionar depois de entregar o JSON e o ID?**
A conexão é ligada por quem configura. Pode levar alguns minutos até o primeiro horário aparecer. Se passar de ~10 minutos sem nada, avise o responsável em vez de refazer tudo.
