# Tripversal — Arquitetura do Sistema

> **Versão:** 2.4
> **Atualizado:** 2026-02-26
> **Stack:** Next.js 14 (App Router) · Supabase (PostgreSQL) · React 18
> **Convenção de nomes:** tabelas e colunas em `snake_case`; tipos TypeScript em `camelCase/PascalCase`

---

## Índice

1. [Visão Geral](#1-visão-geral)
2. [Schema do Banco de Dados](#2-schema-do-banco-de-dados)
3. [Dicionário de Dados](#3-dicionário-de-dados)
4. [Regras de Negócio](#4-regras-de-negócio) ← 4.4 Sobreposição de segmentos cross-trip
5. [Algoritmos](#5-algoritmos) ← 5.3 detectSegmentConflicts (implementado)
6. [Componentes de UI](#6-componentes-de-ui) ← 6.4 ItineraryScreen + ICS export
7. [Hooks](#7-hooks)
8. [API Routes](#8-api-routes) ← 8.2 Expenses (novo)
9. [Estratégia de Sync localStorage ↔ Supabase](#9-estratégia-de-sync-localstorage--supabase) ← novo
10. [Decisões de Arquitetura (ADRs)](#10-decisões-de-arquitetura-adrs) ← ADR-05 novo

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

> **Nota:** existem duas versões desta tabela.
> - **v1 (produção atual):** schema simplificado, alinhado com a interface `Expense` do cliente. Implantado em 2026-02-26.
> - **v2 (planejada):** schema normalizado com `payer_id → trip_participants` e dois campos de taxa. Ainda não migrado.

#### `expenses` — v1 (produção)

Migrado de `localStorage` para Supabase. `id` é o `Date.now().toString()` gerado no cliente, o que garante idempotência nos `upsert` de retry offline.

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | TEXT PK | `Date.now().toString()` gerado no cliente |
| `trip_id` | UUID FK → `trips` | Viagem |
| `description` | TEXT | Descrição da despesa |
| `category` | TEXT | Categoria (food, transport, accommodation…) |
| `type` | TEXT | `'personal'` ou `'group'` |
| `date` | TIMESTAMPTZ | Data e hora da transação |
| `source_id` | TEXT | ID da fonte de pagamento (referência lógica ao JSONB `trips.budget`) |
| `local_amount` | NUMERIC | Valor como aparece no recibo, na moeda local |
| `local_currency` | TEXT | Moeda do recibo |
| `base_amount` | NUMERIC | Valor convertido para a moeda base pessoal |
| `base_currency` | TEXT | Moeda base do usuário no momento do registro |
| `local_to_base_rate` | NUMERIC | Taxa congelada `local_currency → base_currency` |
| `who_paid` | TEXT | Nome de quem pagou (despesas de grupo) |
| `splits` | JSONB | Mapa `{ [nome]: cotas }` para divisão de grupo |
| `city` | TEXT | Cidade onde ocorreu |
| `edit_history` | JSONB | Array de snapshots anteriores (imutável) |
| `deleted_at` | TIMESTAMPTZ | `NULL` = ativa; preenchido = soft-deleted |
| `created_at` | TIMESTAMPTZ | Timestamp de criação |
| `updated_at` | TIMESTAMPTZ | Timestamp da última atualização |

> `receiptDataUrl` (base64) é intencionalmente **excluído** do banco — permanece apenas no `localStorage`.

#### `expenses` — v2 (planejada)

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

### 4.4 Restrição de sobreposição de segmentos entre viagens

#### Motivação

Um usuário pode ser membro de múltiplas viagens cujos intervalos de datas se sobrepõem — isso é permitido e esperado (ex.: uma viagem de negócios e uma viagem de lazer planejadas para o mesmo mês). Porém, **um participante não pode estar fisicamente em dois lugares ao mesmo tempo**. Se ele está atribuído ao Segmento A da Viagem 1 e ao Segmento B da Viagem 2, e esses segmentos se sobrepõem em datas, há um conflito logístico real.

#### Definição formal

Dois segmentos `A` e `B` **conflitam para um membro** se:

1. O membro está atribuído a ambos (`A.assigned_member_ids @> [member.id]` e `B.assigned_member_ids @> [member.id]`)
2. Os segmentos pertencem a **viagens diferentes** (`A.trip_id ≠ B.trip_id`)
3. Os intervalos de data se sobrepõem:

```
A.start_date <= B.end_date  AND  B.start_date <= A.end_date
```

> **Nota:** sobreposições de segmentos *dentro da mesma viagem* não são capturadas por esta regra — um hotel e um voo no mesmo dia são segmentos irmãos legítimos na mesma Trip.

#### Severidade: Aviso, não erro fatal

A sobreposição é sinalizada como **warning** (não bloqueia o save). Motivo: o app não tem contexto suficiente para saber se o conflito é real (ex.: o usuário pode ter sido convidado para uma viagem mas ainda não confirmou presença num segmento específico). A decisão final é do viajante.

#### Identity cross-trip

Como cada `trip_members` é um registro diferente por viagem, a identidade cross-trip de um usuário é rastreada pelo campo `google_sub`:

```
Usuário X  →  trip_members.google_sub = "google|abc123"
               ├── member_id_1  (Viagem A)  → segmento S1 (Jan 10–15)
               └── member_id_2  (Viagem B)  → segmento S2 (Jan 13–18)
               ↑ mesmo google_sub → conflito detectável
```

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

### 5.3 `detectSegmentConflicts` — Detecção de sobreposição cross-trip

**Arquivo:** `lib/algorithms/segment_conflicts.ts`

#### Tipos exportados

```typescript
export interface AssignedSegment {
  id:         string;
  trip_id:    string;
  trip_name:  string;
  name:       string;
  start_date: string; // "YYYY-MM-DD"
  end_date:   string; // "YYYY-MM-DD"
}

export interface ConflictPair {
  a: AssignedSegment;
  b: AssignedSegment;
}
```

#### Output

`ConflictPair[]` — cada par de segmentos de viagens diferentes que se sobrepõem para o usuário. Lista vazia = nenhum conflito.

#### Algoritmo

```
1. Filtra segmentos sem start_date ou end_date
2. Ordena por start_date asc
3. Para cada par (i, j) com j > i:
     sorted[j].start_date > sorted[i].end_date → break   (early exit: j e todos posteriores não sobrepõem i)
     sorted[i].trip_id ≠ sorted[j].trip_id     → emite ConflictPair { a: i, b: j }
4. Retorna lista de pares
```

**Complexidade:** O(n log n) sort + O(n) inner scan na média (o `break` corta cedo). O(n²) apenas no pior caso teórico de total sobreposição. Volume esperado < 50 segmentos por usuário — custo desprezível.

#### Implementação

```typescript
export function detectSegmentConflicts(segments: AssignedSegment[]): ConflictPair[] {
  const sorted = [...segments]
    .filter(s => s.start_date && s.end_date)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  const conflicts: ConflictPair[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].start_date > sorted[i].end_date) break;  // early exit
      if (sorted[i].trip_id !== sorted[j].trip_id) {         // cross-trip only
        conflicts.push({ a: sorted[i], b: sorted[j] });
      }
    }
  }

  return conflicts;
}
```

#### API Route — `GET /api/users/[sub]/segment-conflicts`

**Arquivo:** `app/api/users/[sub]/segment-conflicts/route.ts`

**Estratégia de query:** duas etapas em aplicação (sem raw SQL), usando o operador `contains` do Supabase JS:

```typescript
// Etapa 1 — memberships aceitas do usuário
const { data: memberships } = await sb
  .from('trip_members')
  .select('id, trip_id, trips(id, name)')
  .eq('google_sub', params.sub)
  .eq('status', 'accepted');

// Etapa 2 — para cada membership, segmentos onde este membro está atribuído
const buckets = await Promise.all(
  memberships.map(m =>
    sb.from('trip_segments')
      .select('id, trip_id, name, start_date, end_date')
      .eq('trip_id', m.trip_id)
      .contains('assigned_member_ids', [m.id])  // @> [m.id] no Supabase JS
      .not('start_date', 'is', null)
      .not('end_date', 'is', null)
  )
);

const allSegments = buckets.flat();
const conflicts = detectSegmentConflicts(allSegments);
// response: { conflicts: ConflictPair[], segments: AssignedSegment[] }
```

> **Por que duas etapas e não um JOIN?** O Supabase JS v2 não expõe o operador `@>` com bind de parâmetro dinâmico por coluna de join. Uma chamada por membership é segura para o volume esperado (< 10 viagens por usuário).

**Resposta:**

```json
{
  "conflicts": [
    {
      "a": { "id": "...", "trip_id": "...", "trip_name": "Europa 2026", "name": "Roma Leg", "start_date": "2026-03-10", "end_date": "2026-03-15" },
      "b": { "id": "...", "trip_id": "...", "trip_name": "Negócios Paris", "name": "Paris Stay", "start_date": "2026-03-13", "end_date": "2026-03-18" }
    }
  ],
  "segments": [ ... ]
}
```

#### Pontos de validação implementados

| Camada | Arquivo | Quando dispara | Ação |
|---|---|---|---|
| **API (leitura)** | `GET /api/users/[sub]/segment-conflicts` | Ao carregar `ItineraryScreen` | Retorna `ConflictPair[]` para o client |
| **Itinerary screen** | `app/TripversalApp.tsx` | Ao montar o componente / trocar `userSub` | 3 sinais visuais (ver seção 6.4) |
| **API (escrita)** | `PUT /api/trips/[id]/segments/[segId]` *(futuro)* | Ao atribuir membro a segmento | Rodar `detectSegmentConflicts` e retornar `warnings` — não bloquear save |

#### Tipos mirror no client

`ItineraryEvent` recebe campo `segmentId?: string` — populado por `segmentsToEvents()` — para cruzar com os `ConflictPair` sem precisar reprocessar IDs compostos.

```typescript
// Em TripversalApp.tsx
interface ConflictSegment {
  id: string; trip_id: string; trip_name: string;
  name: string; start_date: string; end_date: string;
}
interface SegmentConflict { a: ConflictSegment; b: ConflictSegment; }
```

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

### 6.4 `ItineraryScreen`

**Arquivo:** `app/TripversalApp.tsx` (componente inline)

#### Props

```typescript
{
  activeTripId: string | null;
  activeTrip:   Trip | null;
  userSub?:     string;        // google_sub do usuário logado — aciona detecção de conflitos
}
```

#### Estado interno

| State | Tipo | Descrição |
|---|---|---|
| `now` | `Date` | Atualizado a cada 60 s via `setInterval` — base para o marcador NOW |
| `selectedDay` | `string` | Dia selecionado no seletor horizontal (`"YYYY-MM-DD"`) |
| `conflicts` | `SegmentConflict[]` | Pares conflitantes retornados pela API |

#### Fluxo de dados

```
activeTrip.segments
    │
    └── segmentsToEvents()   → ItineraryEvent[]   (inclui segmentId)
            │
            └── filter(e.date === selectedDay)     → dayEvents[]
                    │
                    ├── getStatus(event, now)       → "done" | "now" | "upcoming"
                    └── conflictingSegIds.has(e.segmentId) → isConflict: boolean

GET /api/users/[sub]/segment-conflicts
    │
    └── conflicts[]
            │
            ├── dayConflicts          (filtro: cobre selectedDay)
            ├── conflictingSegIds     (Set<segmentId> da activeTrip)
            └── conflictingTripNames  (nomes das outras viagens)
```

#### Derivações computadas (sem estado extra)

```typescript
// Conflitos que tocam o dia selecionado
const dayConflicts = conflicts.filter(c =>
  (c.a.start_date <= selectedDay && c.a.end_date >= selectedDay) ||
  (c.b.start_date <= selectedDay && c.b.end_date >= selectedDay)
);

// IDs de segmentos DESTA viagem que estão em algum conflito
const conflictingSegIds = new Set(
  conflicts.flatMap(c => [c.a, c.b])
    .filter(s => s.trip_id === activeTripId)
    .map(s => s.id)
);

// Nomes deduplcados das outras viagens conflitantes (para o banner)
const conflictingTripNames = Array.from(new Set(
  dayConflicts.flatMap(c => [c.a, c.b])
    .filter(s => s.trip_id !== activeTripId)
    .map(s => s.trip_name)
));
```

#### 3 camadas de sinalização de conflito

| Camada | Elemento | Condição |
|---|---|---|
| **Banner** | Tarja amarela acima da timeline com ⚠️ e nomes das viagens | `dayConflicts.length > 0` |
| **Círculo do evento** | Borda + ícone amarelos (em vez de cinza/verde/cyan) | `isConflict === true` |
| **Badge no horário** | Emoji ⚠️ ao lado do timestamp | `isConflict === true` |

Os 3 sinais são independentes: um dia sem conflito não renderiza nenhum elemento extra.

#### ICS Export

`<a href="/api/trips/[activeTripId]/ics" download>` — link direto para o endpoint ICS. Não depende de estado. Ver seção da API abaixo.

#### API Route ICS — `GET /api/trips/[id]/ics`

**Arquivo:** `app/api/trips/[id]/ics/route.ts`

Gera um feed `.ics` (iCalendar RFC 5545) a partir dos `trip_segments` da viagem:

| Segmento | VEVENTs gerados |
|---|---|
| `origin → destination` + `start_date` | 1 evento de viagem (todo-dia) |
| `start_date` | 1 evento check-in 14h–15h |
| `end_date ≠ start_date` | 1 evento check-out 11h–12h |

Headers da resposta: `Content-Type: text/calendar`, `Content-Disposition: attachment; filename="<TripName>.ics"`, `Cache-Control: no-store`.

---

## 7. Hooks

### 7.1 `useNetworkSync`

**Arquivo:** `lib/hooks/use_network_sync.ts`

**Propósito:** Monitorar conectividade do dispositivo e disparar sincronização automática com o Supabase assim que a rede é restabelecida.

**Assinatura:**

```typescript
function useNetworkSync(options?: {
  onReconnect?: () => Promise<void>; // callback async executado ao voltar online
  debounceMs?: number;               // padrão: 1500ms
}): {
  isOnline: boolean;   // estado real da rede
  isSyncing: boolean;  // true enquanto onReconnect estiver rodando
}
```

**Requisitos atendidos:**

| Requisito | Implementação |
|---|---|
| Monitorar rede | `window.addEventListener('online' / 'offline')` |
| Compatibilidade SSR | `useEffect` + guard `typeof window !== 'undefined'`; `useState(true)` no servidor, hidrata com `navigator.onLine` no client |
| Trigger de sync | `onReconnect()` chamado após debounce quando evento `'online'` dispara |
| Lock anti-race condition | `isSyncingRef` (useRef) — garante no máximo uma execução simultânea; refs não causam re-render extra |
| Debounce | `setTimeout` de `debounceMs` (padrão 1500ms) cancelado em novo evento `'offline'` — absorve oscilações de rede móvel |

**Por que `useRef` para o lock e não `useState`?**

`useState` causaria um re-render ao setar `true`, o que poderia disparar o `useCallback` de `runSync` antes do lock estar efetivamente aplicado (race no próprio React). `useRef` é síncrono e não agenda re-renders — o lock é imediato.

**Fluxo em sinal oscilante (exemplo: metrô de Madri):**

```
t=0ms   → evento 'online' #1  → debounce timer A inicia (1500ms)
t=200ms → evento 'offline'   → timer A cancelado, isSyncing permanece false
t=400ms → evento 'online' #2  → debounce timer B inicia (1500ms)
t=1900ms→ timer B dispara     → isSyncingRef = true, onReconnect() executa
t=2100ms→ evento 'online' #3  → isSyncingRef já é true → runSync retorna sem fazer nada
t=3500ms→ onReconnect resolve → isSyncingRef = false, isSyncing = false
```

**Integração no AppShell:**

```typescript
const handleReconnect = useCallback(async () => {
  if (!user) return;
  // 1. Re-fetch trips
  const rows = await fetch(`/api/trips?userId=${user.sub}`)
    .then(r => r.ok ? r.json() : []).catch(() => []);
  if (rows.length > 0) setTrips(rows.map(rowToTrip));
  // 2. Re-sync expenses do trip ativo
  if (!activeTripId) return;
  const expRows = await fetch(`/api/trips/${activeTripId}/expenses?callerSub=${user.sub}`)
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (expRows) {
    const stored = JSON.parse(localStorage.getItem('tripversal_expenses') ?? '[]');
    const merged = mergeServerExpenses(stored, expRows.map(rowToExpense), activeTripId);
    localStorage.setItem('tripversal_expenses', JSON.stringify(merged));
  }
}, [user, activeTripId]); // activeTripId nas deps

const { isOnline, isSyncing } = useNetworkSync({
  onReconnect: handleReconnect,
  debounceMs: 1500,
});

// offlineSim (Dev Controls) sobrepõe o estado real para testes
const effectiveIsOnline = isOnline && !offlineSim;
```

**Indicador visual no Header:**

- 🟢 Verde: online e idle
- 🟡 Amarelo pulsando + label "SYNC": sincronizando
- 🔴 Vermelho: offline

**`offlineSim` (Dev Controls):** estado levantado para `AppShell` e sobreposto via `effectiveIsOnline = isOnline && !offlineSim`. Permite simular offline sem desativar a rede real do dispositivo — útil para testar o comportamento de UI sem perder a conexão com o servidor de desenvolvimento.

---

## 8. API Routes

### 8.1 Trips

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/api/trips?userId=SUB` | — | Lista viagens do usuário (com members e segments) |
| GET | `/api/trips/[id]` | — | Detalhes de uma viagem |
| PUT | `/api/trips/[id]` | admin | Atualiza campos (name, destination, dates, budget) |
| DELETE | `/api/trips/[id]` | owner | Deleta a viagem |
| GET | `/api/trips/[id]/ics` | — | Feed iCalendar dos segments |

### 8.2 Expenses

**Arquivo:** `app/api/trips/[id]/expenses/route.ts`

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/api/trips/[id]/expenses?callerSub=SUB` | member | Retorna despesas ativas (`deleted_at IS NULL`), ordem decrescente por data |
| POST | `/api/trips/[id]/expenses` | member | Cria ou atualiza uma despesa (`upsert` por `id` — idempotente para retries offline) |
| PUT | `/api/trips/[id]/expenses/[expenseId]` | member | Atualiza campos específicos + `updated_at` |
| DELETE | `/api/trips/[id]/expenses/[expenseId]` | member | Soft-delete: seta `deleted_at = NOW()` |

**Auth:** verifica `trip_members WHERE google_sub = callerSub AND trip_id = id`. Qualquer membro (não só admin) pode operar despesas.

**Payload do POST/PUT (camelCase → o servidor converte para snake_case):**

```typescript
{
  callerSub: string;       // obrigatório em todos os métodos
  id: string;              // Date.now().toString()
  description: string;
  category: string;
  date: string;            // ISO 8601
  sourceId: string;
  type: "personal" | "group";
  localAmount: number;
  localCurrency: string;
  baseAmount: number;
  baseCurrency: string;
  localToBaseRate: number;
  whoPaid?: string;
  splits?: Record<string, number>;
  city?: string;
  editHistory?: Array<{ at: string; snapshot: object }>;
}
```

> `receiptDataUrl` é intencionalmente omitido — não vai ao servidor.

### 8.3 Users

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/users/[sub]/segment-conflicts` | Conflitos cross-trip de segmentos para o usuário |

---

## 9. Estratégia de Sync localStorage ↔ Supabase

### 9.1 Princípio: localStorage-first + write-through

O `localStorage` é a fonte de verdade imediata para a UI. O Supabase é o espelho durável. Nunca bloqueamos a UX esperando resposta do servidor.

```
Escrita:
  1. Salva em localStorage  → render instantâneo
  2. Fire-and-forget → POST/PUT/DELETE no Supabase em background
  3. Se offline: ignora o erro. localStorage continua válido.

Leitura:
  1. Lê localStorage → render instantâneo (dados "stale" mas imediatos)
  2. Fetch background → GET /expenses
  3. Se OK: mergeServerExpenses → salva em localStorage → atualiza state
  4. Se offline: ignora. O render do passo 1 persiste.
```

### 9.2 Mappers

```typescript
// DB snake_case → client camelCase
function rowToExpense(row: any): Expense

// client camelCase → DB snake_case (sem receiptDataUrl)
function expenseToRow(e: Expense): Record<string, unknown>

// Substitui a fatia do tripId pelos dados do servidor; preserva outras viagens e ordem
function mergeServerExpenses(stored: Expense[], server: Expense[], tripId: string): Expense[]
```

### 9.3 Cobertura por operação

| Operação | localStorage | Supabase | Quando |
|---|---|---|---|
| Criar despesa | ✅ síncrono | ✅ POST em background | AddExpenseScreen.handleSave, após `onBack()` |
| Editar despesa | ✅ síncrono | ✅ PUT em background | HomeScreen.handleHomeEdit, WalletScreen.handleEdit |
| Deletar despesa | ✅ síncrono | ✅ soft-delete em background | HomeScreen.handleHomeDelete, WalletScreen.handleDelete |
| Editar orçamento | ✅ síncrono | ✅ PUT /trips/[id] em background | SettingsScreen.saveBudget |
| Hydrate ao montar | — | ✅ GET + mergeServerExpenses | HomeScreen/WalletScreen useEffect |
| Reconexão | — | ✅ GET + mergeServerExpenses | handleReconnect (useNetworkSync) |

### 9.4 Dados intencionalmente sem espelho

| Key localStorage | Motivo |
|---|---|
| `tripversal_active_trip_id` | UI state — local por design |
| `tripversal_user` | Sessão Google — renovada pelo OAuth |
| `tripversal_profile` | Out of scope desta PR |
| `INVITE_EVENTS_KEY` | Notificação efêmera local |
| `tripversal_deleted_expenses` | Log de auditoria local; o soft-delete no server é suficiente |

---

## 10. Decisões de Arquitetura (ADRs)

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

---

### ADR-04: Sobreposição de segmentos cross-trip como aviso, não erro fatal

**Contexto:** Um usuário pode participar de múltiplas viagens com datas sobrepostas. Os segmentos dessas viagens onde ele está atribuído podem conflitar — alguém não pode estar fisicamente em dois lugares ao mesmo tempo.

**Decisão:** Tratar o conflito como **warning não-bloqueante**. O save do segmento ocorre normalmente; a API retorna `warnings: ConflictPair[]` junto da resposta de sucesso. A UI exibe um banner amarelo informativo.

**Por que não bloquear?**

- O app não tem contexto suficiente para determinar se o conflito é real. Um usuário pode ter sido adicionado a uma viagem como organizador sem pretender participar fisicamente de todos os segmentos.
- Forçar erro criaria fricção para casos válidos (ex.: overlap parcial onde o usuário saiu de um segmento cedo para embarcar em outro).
- O convite a um trip e a atribuição a um segmento são ações independentes — o grupo pode querer planejar e ajustar depois.

**Consequências:**

- A validação deve existir **em ambas as camadas** (client e server) para que o usuário receba feedback cedo, mas sem bloquear.
- A Itinerary Screen deve destacar visualmente eventos de viagens diferentes que se sobrepõem no mesmo dia, com ícone ⚠️ e label da viagem conflitante.
- A resolução do conflito é responsabilidade do usuário: remover-se de um segmento, ajustar as datas, ou simplesmente ignorar o aviso se a sobreposição for intencional.

---

### ADR-05: localStorage-first com write-through para expenses

**Contexto:** Despesas viviam exclusivamente em `localStorage`. Trocar de dispositivo ou limpar o cache significava perda de dados.

**Decisão:** Adotar o padrão **localStorage-first + write-through assíncrono**, sem nunca bloquear a UX por latência de rede.

**Por que não esperar o servidor antes de fazer `onBack()`?**

O P99 de uma chamada ao Supabase em rede móvel pode chegar a 2-3 segundos. Bloquear o usuário nesse tempo depois de clicar "Save Expense" destruiria a percepção de performance do app. O `localStorage` é síncrono e suficiente para garantir que os dados não se percam no device atual.

**Por que `upsert` e não `insert`?**

Se a conexão cair após o `localStorage.setItem` mas antes do `fetch` concluir, o retry ao reconectar enviaria o mesmo `id`. `upsert` com `onConflict: 'id'` é idempotente — submeter a mesma despesa duas vezes não cria duplicatas.

**Por que `id = Date.now().toString()` e não UUID v4?**

UUID v4 requer `crypto.randomUUID()` que em alguns browsers mais antigos não está disponível sem polyfill. `Date.now()` é universal. A colisão é teoricamente possível (dois dispositivos no mesmo milissegundo), mas improvável em escopo de viagem individual.

**Por que `receiptDataUrl` é excluído do banco?**

Uma imagem comprimida ainda tem ~60-80 KB. Com dezenas de despesas por viagem e múltiplas viagens por usuário, isso somaria rapidamente. A coluna `receipt_url` na v2 do schema aponta para Supabase Storage — pipeline separado, fora do escopo desta PR.

**Consequências:**

- O Supabase nunca é a fonte de verdade primária em tempo de escrita — é o backup durável.
- Ao reconectar (`handleReconnect`), o app refaz o GET de expenses e mescla com `mergeServerExpenses`, que prioriza os dados do servidor para o `tripId` ativo e preserva dados de outras viagens já no localStorage.
- Dados criados offline chegam ao servidor apenas no próximo `handleReconnect`. O máximo de perda de dados é o intervalo offline.
