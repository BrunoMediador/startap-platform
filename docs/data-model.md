# Data Model

Este documento define o modelo alvo. As migracoes devem ser pequenas, revisaveis e compativeis com o estado atual de producao.

## Product Catalog

### `products`

Representa um produto homologado.

Campos principais:

- `id`
- `slug`
- `name`
- `description`
- `category`
- `status`
- `created_at`
- `updated_at`

Status permitidos:

```text
draft, homologation, active, deprecated, archived
```

### `product_versions`

Versiona comportamento, prompt e defaults do produto.

Campos principais:

- `id`
- `product_id`
- `version`
- `status`
- `base_prompt`
- `rules_json`
- `default_business_data_json`
- `default_tools_json`
- `default_model_config_json`
- `created_at`
- `published_at`
- `created_by`

Regras:

- Versao publicada nao deve ser editada.
- Mudanca de produto ativo cria nova versao.
- Demos e clientes registram a versao usada.

## Demo Commercial

### `demo_instances`

Instancias de teste comercial.

Campos principais:

- `id`
- `product_id`
- `product_version_id`
- `name`
- `status`
- `prompt_override`
- `business_data_json`
- `tools_config_json`
- `model_config_json`
- `shared_calendar_profile_id`
- `created_at`
- `updated_at`

Status permitidos:

```text
draft, active, paused, archived
```

### `routing_clientes`

Continua existindo, mas apenas para demo/teste comercial.

Campos novos recomendados:

- `demo_instance_id`
- `product_id`
- `expires_at`
- `notes`

## Production Clients

### `clients`

Cliente contratado.

Campos principais:

- `id`
- `slug`
- `name`
- `legal_name`
- `document`
- `contact_name`
- `contact_phone`
- `contact_email`
- `status`
- `created_at`
- `updated_at`

### `client_projects`

Projeto, unidade ou servico de um cliente.

Campos principais:

- `id`
- `client_id`
- `slug`
- `name`
- `product_id`
- `source_demo_instance_id`
- `status`
- `created_at`
- `updated_at`

### `client_instances`

Instancia real de producao.

Campos principais:

- `id`
- `client_id`
- `project_id`
- `product_id`
- `product_version_id`
- `source_demo_instance_id`
- `prompt_config`
- `business_data_json`
- `tools_config_json`
- `model_config_json`
- `status`
- `created_at`
- `updated_at`

### `client_integrations`

Configuracoes de integracao por cliente/projeto.

Campos principais:

- `id`
- `client_id`
- `project_id`
- `integration_type`
- `display_name`
- `status`
- `config_public_json`
- `secret_ref`
- `created_at`
- `updated_at`

`secret_ref` aponta para o mecanismo de segredo. Tokens e senhas nao devem ser salvos em texto aberto.

## Media

### `media_assets`

Midias vinculadas a produto, demo ou cliente.

Campos principais:

- `id`
- `owner_type`
- `owner_id`
- `kind`
- `label`
- `file_name`
- `mime_type`
- `public_url`
- `storage_path`
- `size_bytes`
- `checksum`
- `status`
- `created_at`
- `updated_at`

## Chat Memory

### `chat_threads`

Thread isolada por `ConversationScope`.

Campos principais:

- `id`
- `environment`
- `product_id`
- `instance_type`
- `instance_id`
- `client_id`
- `project_id`
- `user_phone`
- `waha_session`
- `status`
- `created_at`
- `updated_at`

### `chat_messages`

Mensagens dentro de uma thread.

Campos principais:

- `id`
- `chat_thread_id`
- `role`
- `content`
- `metadata_json`
- `message_id`
- `created_at`

Roles permitidos:

```text
human, ai, system, tool
```

## Usage

### `model_usage`

Deve medir custo e volume por ambiente, produto, instancia, cliente e projeto.

Campos principais:

- `id`
- `environment`
- `product_id`
- `instance_id`
- `client_id`
- `project_id`
- `slot`
- `provider`
- `model`
- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- `cost_usd`
- `telefone`
- `created_at`

