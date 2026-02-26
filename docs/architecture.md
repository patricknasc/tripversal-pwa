# Tripversal — Arquitetura do Sistema de Orçamento Flexível

> **Versão:** 2.0
> **Data:** 2026-02-25
> **Stack:** Next.js 14 (App Router) · Supabase (PostgreSQL) · React 18
> **Convenção de nomes:** tabelas e colunas em `snake_case`; tipos TypeScript em `camelCase/PascalCase`

---

## Índice

1. [Visão Geral](#1-visão-geral)
2. [Schema do Banco de Dados](#2-schema-do-banco-de-dados)
3. [Dicionário de Dados](#3-dicionário-de-dados)
4. [Regras de Negócio](#4-regras-de-negócio)
5. [Algoritmos](#5-algoritmos)
6. [Componentes de UI](#6-componentes-de-ui)
7. [Decisões de Arquitetura (ADRs)](#7-decisões-de-arquitetura-adrs)

---

## 1. Visão Geral

O sistema suporta viagens em grupo com:

- **Orçamento pessoal por participante** — cada membro da viagem define suas próprias fontes de pagamento e escolhe sua moeda base de visualização
- **Rastreabilidade cambial histórica** — as taxas de câmbio são congeladas no momento de cada transação e jamais recalculadas
- **Divisão de despesas em grupo** — despesas podem ser divididas em cotas entre participantes, mantendo as dívidas na moeda original da transação
- **Simplificação de dívidas por moeda** — algoritmo de minimização de fluxo de caixa agrupa e otimiza as transferências necessárias por moeda

---

## 2. Schema do Banco de Dados

### 2.1 Diagrama de Entidades

```
trips
  │
  ├─── trip_participants  (1 por membro por viagem)
  │         │
  │         └─── payment_sources  (N fontes por participante)
  │
  ├─── expenses  (N despesas por viagem)
  │         │
  │         └─── expense_shares  (1 cota por participante por despesa)
  │
  ├─── trip_segments
  └─── invite_tokens
```

### 2.2 Script SQL completo

```sql
-- ─── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── trips ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trips (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  destination  TEXT,
  start_date   DATE        NOT NULL,
  end_date     DATE        NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── trip_participants ────────────────────────────────────────────────────────
-- Substitui trip_members. Armazena dados de convite E preferências financeiras
-- pessoais de cada membro naquela viagem específica.
CREATE TABLE IF NOT EXISTS trip_participants (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id                UUID        REFERENCES trips(id) ON DELETE CASCADE,
  email                  TEXT        NOT NULL,
  name                   TEXT,
  avatar_url             TEXT,
  google_sub             TEXT,
  role                   TEXT        NOT NULL DEFAULT 'member'
                                     CHECK (role IN ('admin', 'member')),
  status                 TEXT        NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending', 'accepted')),
  invited_at             TIMESTAMPTZ DEFAULT NOW(),
  accepted_at            TIMESTAMPTZ,
  -- Moeda base pessoal: cada membro escolhe em qual moeda quer ver
  -- seu orçamento consolidado (ex: BRL para brasileiro, USD para americano)
  personal_base_currency TEXT        NOT NULL DEFAULT 'EUR',
  UNIQUE(trip_id, email)
);

-- ─── payment_sources ─────────────────────────────────────────────────────────
-- Fontes de pagamento pessoais de um participante para esta viagem.
-- Extraído do JSONB budget.sources que existia em trips.
CREATE TABLE IF NOT EXISTS payment_sources (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id  UUID        REFERENCES trip_participants(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,      -- ex: "Wise EUR", "Dinheiro USD"
  type            TEXT        NOT NULL
                              CHECK (type IN ('credit', 'balance')),
  currency        TEXT        NOT NULL,      -- ISO 4217: EUR, USD, BRL…
  color           TEXT        DEFAULT '#00e5ff',
  -- Para tipo 'credit': teto máximo de gasto nesta moeda
  credit_limit    NUMERIC(12,2),
  -- Para tipo 'balance': saldo inicial carregado pelo usuário
  initial_balance NUMERIC(12,2),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── expenses ─────────────────────────────────────────────────────────────────
-- Migrado de localStorage para Supabase.
-- Núcleo da rastreabilidade cambial: dois campos de taxa congelados.
CREATE TABLE IF NOT EXISTS expenses (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id                  UUID        REFERENCES trips(id) ON DELETE CASCADE,
  payer_id                 UUID        REFERENCES trip_participants(id),
  source_id                UUID        REFERENCES payment_sources(id),
  description              TEXT        NOT NULL,
  category                 TEXT        NOT NULL,
  type                     TEXT        NOT NULL DEFAULT 'personal'
                                       CHECK (type IN ('personal', 'group')),
  city                     TEXT,
  receipt_url              TEXT,
  date                     TIMESTAMPTZ NOT NULL,

  -- Valor e moeda como aparece na nota fiscal / recibo
  local_amount             NUMERIC(12,4) NOT NULL,
  local_currency           TEXT          NOT NULL,

  -- Taxa congelada no momento da transação: local_currency → currency da fonte
  -- Uso: conciliar com o extrato bancário ("quanto debitou no cartão?")
  local_to_source_rate     NUMERIC(16,8) NOT NULL DEFAULT 1,

  -- Taxa congelada no momento da transação: local_currency → personal_base_currency do pagador
  -- Uso: relatórios da viagem ("quanto custou na minha moeda?")
  local_to_payer_base_rate NUMERIC(16,8) NOT NULL DEFAULT 1,

  created_at               TIMESTAMPTZ DEFAULT NOW()
);

-- ─── expense_shares ──────────────────────────────────────────────────────────
-- Cotas de cada participante em uma despesa de grupo.
-- share_amount SEMPRE na mesma moeda da expense (local_currency) — nunca converter.
CREATE TABLE IF NOT EXISTS expense_shares (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id     UUID          REFERENCES expenses(id) ON DELETE CASCADE,
  participant_id UUID          REFERENCES trip_participants(id),
  share_amount   NUMERIC(12,4) NOT NULL,
  is_settled     BOOLEAN       DEFAULT FALSE,
  settled_at     TIMESTAMPTZ,
  UNIQUE(expense_id, participant_id)
);

-- ─── trip_segments ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trip_segments (
  id                   UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id              UUID      REFERENCES trips(id) ON DELETE CASCADE,
  name                 TEXT      NOT NULL,
  start_date           DATE,
  end_date             DATE,
  origin               TEXT,
  destination          TEXT,
  color                TEXT      DEFAULT '#00e5ff',
  assigned_member_ids  UUID[]    DEFAULT '{}',
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ─── invite_tokens ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invite_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     UUID        REFERENCES trips(id) ON DELETE CASCADE,
  member_id   UUID        REFERENCES trip_participants(id) ON DELETE CASCADE,
  email       TEXT        NOT NULL,
  token       TEXT        UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
  expires_at  TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
  used_at     TIMESTAMPTZ
);

-- ─── Row Level Security ───────────────────────────────────────────────────────
ALTER TABLE trips              ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_participants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_sources    ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_shares     ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_segments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_tokens      ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON trips             FOR ALL USING (true);
CREATE POLICY "service_role_all" ON trip_participants FOR ALL USING (true);
CREATE POLICY "service_role_all" ON payment_sources   FOR ALL USING (true);
CREATE POLICY "service_role_all" ON expenses          FOR ALL USING (true);
CREATE POLICY "service_role_all" ON expense_shares    FOR ALL USING (true);
CREATE POLICY "service_role_all" ON trip_segments     FOR ALL USING (true);
CREATE POLICY "service_role_all" ON invite_tokens     FOR ALL USING (true);

-- ─── Índices ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_trip_participants_trip    ON trip_participants(trip_id);
CREATE INDEX IF NOT EXISTS idx_payment_sources_part     ON payment_sources(participant_id);
CREATE INDEX IF NOT EXISTS idx_expenses_trip            ON expenses(trip_id);
CREATE INDEX IF NOT EXISTS idx_expenses_payer           ON expenses(payer_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date            ON expenses(date DESC);
CREATE INDEX IF NOT EXISTS idx_expense_shares_expense   ON expense_shares(expense_id);
CREATE INDEX IF NOT EXISTS idx_expense_shares_part      ON expense_shares(participant_id);
```

---

## 3. Dicionário de Dados

### `trips`

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | UUID PK | Identificador único da viagem |
| `owner_id` | TEXT | `google_sub` do criador da viagem |
| `name` | TEXT | Nome da viagem (ex: "Europa 2026") |
| `destination` | TEXT | Destino principal |
| `start_date` | DATE | Data de início |
| `end_date` | DATE | Data de término |
| `created_at` | TIMESTAMPTZ | Timestamp de criação |

---

### `trip_participants`

Entidade intermediária entre o usuário e a viagem. Armazena tanto os dados de convite quanto as **preferências financeiras pessoais** daquele membro naquela viagem específica.

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | UUID PK | Identificador único |
| `trip_id` | UUID FK → `trips` | Viagem associada |
| `email` | TEXT | Email do participante |
| `name` | TEXT | Nome de exibição |
| `avatar_url` | TEXT | URL do avatar (Google) |
| `google_sub` | TEXT | Subject JWT do Google OAuth |
| `role` | TEXT | `'admin'` ou `'member'` |
| `status` | TEXT | `'pending'` ou `'accepted'` |
| `invited_at` | TIMESTAMPTZ | Quando foi convidado |
| `accepted_at` | TIMESTAMPTZ | Quando aceitou o convite |
| `personal_base_currency` | TEXT | **Moeda base pessoal de visualização.** Ex: `'BRL'` para brasileiro, `'USD'` para americano. Usada para consolidar o orçamento e os gastos de todas as fontes em uma única moeda. |

> **Por que não em `trips`?** A moeda base é uma preferência *pessoal* de cada participante *naquela viagem*. O mesmo usuário pode usar BRL numa viagem e USD em outra. Ver [ADR-01](#adr-01-trip_participants-em-vez-de-estender-trip_members).

---

### `payment_sources`

Fontes de pagamento cadastradas por um participante para a viagem. Substituem o array `budget.sources` que era um JSONB desnormalizado em `trips`.

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | UUID PK | Identificador único |
| `participant_id` | UUID FK → `trip_participants` | Dono da fonte |
| `name` | TEXT | Nome de exibição (ex: "Wise EUR", "Dinheiro USD") |
| `type` | TEXT | `'credit'` — tem limite de gasto; `'balance'` — tem saldo que decresce |
| `currency` | TEXT | Moeda nativa desta fonte (ISO 4217) |
| `color` | TEXT | Cor de destaque na UI (hex) |
| `credit_limit` | NUMERIC | *Apenas para `type='credit'`*: teto máximo de gasto |
| `initial_balance` | NUMERIC | *Apenas para `type='balance'`*: saldo inicial carregado |
| `created_at` | TIMESTAMPTZ | Timestamp de criação |

**Saldo disponível atual** não é armazenado — é calculado em runtime:
```
disponível (credit)  = credit_limit - Σ(gastos nesta fonte em sua moeda)
disponível (balance) = initial_balance - Σ(gastos nesta fonte em sua moeda)
```

---

### `expenses`

Cada registro é uma transação financeira realizada por um participante durante a viagem.

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | UUID PK | Identificador único |
| `trip_id` | UUID FK → `trips` | Viagem |
| `payer_id` | UUID FK → `trip_participants` | Quem pagou |
| `source_id` | UUID FK → `payment_sources` | Qual fonte de pagamento foi usada |
| `description` | TEXT | Descrição da despesa |
| `category` | TEXT | Categoria (food, transport, accommodation…) |
| `type` | TEXT | `'personal'` ou `'group'` |
| `city` | TEXT | Cidade onde ocorreu |
| `receipt_url` | TEXT | URL do comprovante (Supabase Storage) |
| `date` | TIMESTAMPTZ | Data e hora da transação |
| `local_amount` | NUMERIC | **Valor como aparece no recibo**, na moeda local |
| `local_currency` | TEXT | **Moeda do recibo** (ex: `'EUR'` num restaurante em Roma) |
| `local_to_source_rate` | NUMERIC | **Taxa congelada**: `local_currency → currency da fonte`. Usada para conciliação com extrato bancário. |
| `local_to_payer_base_rate` | NUMERIC | **Taxa congelada**: `local_currency → personal_base_currency do pagador`. Usada para relatórios da viagem. |
| `created_at` | TIMESTAMPTZ | Timestamp de criação |

> Ver [ADR-02](#adr-02-dois-campos-de-taxa-cambial) para a explicação detalhada dos dois campos de taxa.

---

### `expense_shares`

Cotas de cada participante em uma despesa do tipo `'group'`.

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | UUID PK | Identificador único |
| `expense_id` | UUID FK → `expenses` | Despesa associada |
| `participant_id` | UUID FK → `trip_participants` | Participante que deve esta cota |
| `share_amount` | NUMERIC | **Valor desta cota na `local_currency` da despesa** — nunca converter |
| `is_settled` | BOOLEAN | Se esta cota foi quitada |
| `settled_at` | TIMESTAMPTZ | Quando foi quitada |

> **Invariante crítica:** `Σ(share_amount de todas as cotas de uma expense) = expense.local_amount`

---

### `trip_segments`

Etapas ou trechos da viagem (voo, hotel, city break).

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | UUID PK | Identificador único |
| `trip_id` | UUID FK → `trips` | Viagem |
| `name` | TEXT | Nome do segmento |
| `start_date` | DATE | Início do segmento |
| `end_date` | DATE | Fim do segmento |
| `origin` | TEXT | Cidade/aeroporto de origem |
| `destination` | TEXT | Cidade/aeroporto de destino |
| `color` | TEXT | Cor de destaque na UI |
| `assigned_member_ids` | UUID[] | Participantes neste trecho |

---

### `invite_tokens`

Tokens de convite com validade de 7 dias enviados por email via Resend.

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | UUID PK | Identificador único |
| `trip_id` | UUID FK → `trips` | Viagem do convite |
| `member_id` | UUID FK → `trip_participants` | Participante convidado |
| `email` | TEXT | Email de destino |
| `token` | TEXT UNIQUE | Token único para o link de convite |
| `expires_at` | TIMESTAMPTZ | Expiração (padrão: +7 dias) |
| `used_at` | TIMESTAMPTZ | Quando foi usado (null = não usado) |

---

## 4. Regras de Negócio

### 4.1 Cálculo do orçamento pessoal

```
Para cada payment_source do participante:
  se type = 'credit':
    disponível_na_moeda = credit_limit - Σ(local_amount × local_to_source_rate)
                          para todas as expenses onde source_id = source.id

  se type = 'balance':
    disponível_na_moeda = initial_balance - Σ(local_amount × local_to_source_rate)
                          para todas as expenses onde source_id = source.id

  disponível_em_base = disponível_na_moeda × taxa_live(source.currency → personal_base_currency)

total_budget  = Σ(disponível_em_base) de todas as fontes
total_spent   = Σ(local_amount × local_to_payer_base_rate)
                para todas as expenses onde payer_id = participant.id
remaining     = total_budget - total_spent
```

### 4.2 Congelamento de câmbio

Ao registrar uma despesa, o app deve:

1. Fazer duas chamadas à API de câmbio (ou uma com múltiplos targets):
   - `local_currency → source.currency` → salvar em `local_to_source_rate`
   - `local_currency → payer.personal_base_currency` → salvar em `local_to_payer_base_rate`

2. Ambas as taxas são escritas no banco **uma única vez**, no `INSERT`.

3. **Nunca** recalcular ou sobrescrever taxas em registros existentes.

### 4.3 Divisão de grupo

- Uma `expense` com `type = 'group'` deve ter pelo menos 2 `expense_shares`
- O participante que pagou (`payer_id`) pode ou não ter uma cota — depende do acordo do grupo
- `Σ(expense_shares.share_amount) = expenses.local_amount`
- Todas as cotas usam a mesma moeda da despesa (`local_currency`)

---

## 5. Algoritmos

### 5.1 `useBudgetSummary` (hook React)

**Arquivo:** `lib/hooks/useBudgetSummary.ts`

**Inputs:**
- `participant: TripParticipant` — o participante logado
- `paymentSources: PaymentSource[]` — fontes deste participante
- `paidExpenses: Expense[]` — despesas onde `payer_id = participant.id`

**Output:** `BudgetSummary`

```typescript
interface BudgetSummary {
  total_budget:           number; // em personal_base_currency
  total_spent:            number; // em personal_base_currency (via taxa histórica)
  remaining:              number;
  pct:                    number; // 0–1
  personal_base_currency: string;
  source_breakdown: Array<{
    source:           PaymentSource;
    available:        number; // na moeda da fonte
    available_in_base: number; // convertido para personal_base_currency
    spent:            number; // na moeda da fonte
  }>;
}
```

**Notas de implementação:**
- Taxas ao vivo são buscadas da API `open.er-api.com` apenas para converter `available_in_base`
- Cache de 10 minutos por par de moedas para evitar chamadas desnecessárias
- `total_spent` usa `local_to_payer_base_rate` (taxa histórica) — nunca re-fetcha câmbio para isso

---

### 5.2 `calculateSettleUps` — Minimização de Fluxo de Caixa

**Arquivo:** `lib/algorithms/settle_up.ts`

**Input:** `expenses: ExpenseWithShares[]`

**Output:** `SettleUp[]`

```typescript
interface SettleUp {
  from_id:  string; // quem paga
  to_id:    string; // quem recebe
  amount:   number;
  currency: string; // moeda original da dívida
}
```

**Pseudocódigo:**

```
Para cada expense do tipo 'group':
  Agrupa pelo local_currency da expense

Para cada moeda distinta:
  Para cada participante:
    saldo[participante] =
      + Σ(share_amount) de cotas onde ele É o payer_id da expense pai
      - Σ(share_amount) de cotas onde ele É o participant_id

  credores = participantes com saldo > 0  (devem RECEBER)
  devedores = participantes com saldo < 0 (devem PAGAR)

  Ordena ambas as listas por valor decrescente

  Greedy matching:
    enquanto houver credores e devedores:
      transferência = min(credor.saldo, devedor.saldo)
      emite SettleUp { from: devedor, to: credor, amount: transferência, currency }
      reduz ambos os saldos pela transferência
      avança o ponteiro do lado que zerou
```

**Propriedade garantida:** O algoritmo produz no máximo `N-1` transferências para `N` participantes por moeda (ótimo para grafos completos).

**Restrição fundamental:** dívidas nunca são convertidas entre moedas. Um SettleUp em EUR é sempre quitado em EUR, independente da `personal_base_currency` de cada parte.

---

## 6. Componentes de UI

### 6.1 `TabbedAnalyticsCard`

**Arquivo:** `components/tabbed_analytics_card.tsx`

Card central que substitui o antigo card "Spending Trend". Contém um segmented control com três abas:

| Aba | Conteúdo | Dados necessários |
|---|---|---|
| **Trend** | Gráfico de barras inline — gastos dos últimos 7 dias | `expenses[]` |
| **Burndown** | Gráfico de linha (recharts) — orçamento restante ideal vs real | `expenses[]`, `total_budget`, `trip.start_date`, `trip.end_date` |
| **Balances** | Lista de saldos líquidos do usuário logado, agrupados por moeda | `SettleUp[]`, `participants[]` |

**Dependência externa:** `recharts` (apenas para a aba Burndown)
```bash
npm install recharts
```

### 6.2 Aba Burndown — lógica dos dados

```
Para cada dia da viagem (start_date até end_date):
  ideal[dia] = total_budget - (total_budget / total_dias) × índice_do_dia
               → linha reta do teto ao zero

  gasto_acumulado += Σ gastos reais daquele dia
  actual[dia] = total_budget - gasto_acumulado
               → só plotado para dias no passado (≤ hoje)
```

### 6.3 Aba Balances — estrutura

```
Balances
├── EUR
│   ├── [avatar] João te deve €15.00          [+€15.00 · RECEIVE]
│   └── [avatar] Você deve €8.50 para Maria   [-€8.50  · PAY   ]
└── USD
    └── [avatar] Carlos te deve $22.00        [+$22.00 · RECEIVE]
```

Positivo (verde) = você recebe. Negativo (amarelo) = você deve.

---

## 7. Decisões de Arquitetura (ADRs)

### ADR-01: `trip_participants` em vez de estender `trip_members`

**Contexto:** O sistema existia com a tabela `trip_members` que armazenava apenas dados de convite (email, status, role). Precisávamos adicionar preferências financeiras pessoais como `personal_base_currency`.

**Decisão:** Renomear para `trip_participants` e fazer da tabela o ponto central de identidade do participante naquela viagem.

**Justificativa:**

A coluna `personal_base_currency` não é uma propriedade de "um usuário convidado". É uma propriedade de "um usuário participando *desta* viagem específica". O mesmo usuário pode viajar com o grupo em Janeiro para Europa e querer ver tudo em BRL, e em Julho para os EUA e querer ver em USD. Se o campo estivesse em uma tabela global de usuário, seria impossível ter essa diferença por viagem sem um design mais complexo.

```
trip_members     = responde "quem foi convidado e aceitou?"
                   → domínio: autenticação / convite

trip_participants = responde "como este membro configura sua participação
                   financeira nesta viagem?"
                   → domínio: finanças / orçamento
```

As responsabilidades são distintas. Misturá-las em uma tabela viola o Princípio da Responsabilidade Única no nível do schema.

**Consequência:** `invite_tokens.member_id` passa a referenciar `trip_participants.id`. A lógica de convite permanece intacta.

---

### ADR-02: Dois campos de taxa cambial

**Contexto:** Uma despesa tem `local_currency` (moeda do recibo), e o pagador tem dois contextos de moeda distintos: a `currency` da fonte de pagamento usada, e sua `personal_base_currency`.

**Decisão:** Armazenar dois campos de taxa congelados por despesa.

| Campo | Conversão | Uso |
|---|---|---|
| `local_to_source_rate` | `local_currency → payment_source.currency` | Conciliação bancária: "quanto debitou no cartão?" |
| `local_to_payer_base_rate` | `local_currency → personal_base_currency` | Relatório da viagem: "quanto custou na minha moeda?" |

**Exemplo prático:**

Patrick (BRL) usa cartão Wise (EUR) para pagar táxi de £30 em Londres.

```
local_amount             = 30
local_currency           = GBP
local_to_source_rate     = 1.17   → cartão debitado em €35.10
local_to_payer_base_rate = 6.33   → custo para Patrick: R$189,90
```

**Por que congelar e não calcular ao vivo?**

Se recalculássemos com a taxa atual, o histórico da viagem mudaria com a flutuação cambial. Uma despesa de R$189,90 registrada hoje poderia aparecer como R$203,00 em três meses. O extrato do banco não muda; o app não pode mudar. O congelamento garante que o histórico financeiro seja imutável e auditável.

---

### ADR-03: Dívidas mantidas em `local_currency`, nunca convertidas

**Contexto:** O algoritmo `calculateSettleUps` processa despesas de grupo com participantes de moedas base diferentes.

**Decisão:** As dívidas em `expense_shares` são armazenadas e processadas exclusivamente em `local_currency`. O algoritmo de simplificação roda independentemente por moeda.

**Justificativa:** Converter uma dívida de EUR para BRL para simplificar cria uma exposição cambial implícita. Se João deve €10 a Maria e Maria deve R$60 a João, não podemos cancelar essas dívidas — elas precisam ser quitadas nas moedas originais. Forçar conversão arbitrária penaliza o devedor ou o credor dependendo de quando a transferência é feita.

**Consequência:** O app pode exibir múltiplos "Settle Ups" para o mesmo par de participantes, um por moeda envolvida.
