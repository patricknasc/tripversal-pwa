# Tripversal — Arquitetura do Sistema

> **Versão:** 2.2
> **Atualizado:** 2026-02-26
> **Stack:** Next.js 14 (App Router) · Supabase (PostgreSQL) · React 18
> **Convenção de nomes:** tabelas e colunas em `snake_case`; tipos TypeScript em `camelCase/PascalCase`

---

## Índice

1. [Visão Geral](#1-visão-geral)
2. [Schema do Banco de Dados](#2-schema-do-banco-de-dados)
3. [Dicionário de Dados](#3-dicionário-de-dados)
4. [Regras de Negócio](#4-regras-de-negócio) ← 4.4 Sobreposição de segmentos
5. [Algoritmos](#5-algoritmos) ← 5.3 detectSegmentConflicts
6. [Componentes de UI](#6-componentes-de-ui)
7. [Hooks](#7-hooks)
8. [Decisões de Arquitetura (ADRs)](#8-decisões-de-arquitetura-adrs)

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

Como cada `trip_participant` é um registro diferente por viagem, a identidade cross-trip de um usuário é rastreada pelo campo `google_sub`:

```
Usuário X  →  trip_participants.google_sub = "google|abc123"
               ├── participant_id_1  (Viagem A)  → segmento S1 (Jan 10–15)
               └── participant_id_2  (Viagem B)  → segmento S2 (Jan 13–18)
               ↑ mesmos google_sub → conflict detectável
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

**Arquivo proposto:** `lib/algorithms/segment_conflicts.ts`

#### Inputs

```typescript
interface AssignedSegment {
  id:         string;
  trip_id:    string;
  trip_name:  string;
  name:       string;
  start_date: string;   // "YYYY-MM-DD"
  end_date:   string;   // "YYYY-MM-DD"
}

interface ConflictPair {
  a: AssignedSegment;
  b: AssignedSegment;
}
```

#### Output

`ConflictPair[]` — cada par de segmentos de viagens diferentes que se sobrepõem para o usuário. Lista vazia = sem conflitos.

#### Pseudocódigo

```
1. Recebe todos os segmentos onde o usuário está atribuído, de todas as suas viagens

2. Ordena por start_date asc

3. Para cada par (i, j) com j > i:
     se sorted[j].start_date > sorted[i].end_date → break (j e qualquer j+n nunca vão sobrepor com i)
     se sorted[i].trip_id ≠ sorted[j].trip_id     → emite ConflictPair { a: i, b: j }

4. Retorna lista de pares conflitantes
```

#### Implementação TypeScript

```typescript
export function detectSegmentConflicts(segments: AssignedSegment[]): ConflictPair[] {
  const sorted = [...segments]
    .filter(s => s.start_date && s.end_date)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  const conflicts: ConflictPair[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      // sorted[j].start_date > sorted[i].end_date → todos os j futuros também não vão sobrepor
      if (sorted[j].start_date > sorted[i].end_date) break;
      // só conflitos cross-trip são relevantes
      if (sorted[i].trip_id !== sorted[j].trip_id) {
        conflicts.push({ a: sorted[i], b: sorted[j] });
      }
    }
  }

  return conflicts;
}
```

**Complexidade:** O(n²) no pior caso, O(n log n) na média (o `break` corta a iteração interna cedo quando os segmentos não se sobrepõem). Para o volume esperado (< 50 segmentos por usuário), o custo é desprezível.

#### Query SQL para buscar os segmentos atribuídos ao usuário

```sql
SELECT
  ts.id,
  ts.trip_id,
  t.name   AS trip_name,
  ts.name,
  ts.start_date,
  ts.end_date
FROM trip_segments ts
JOIN trips t ON t.id = ts.trip_id
JOIN trip_participants tp
  ON tp.trip_id = ts.trip_id
 AND tp.google_sub = $1                          -- google_sub do usuário logado
WHERE ts.assigned_member_ids @> ARRAY[tp.id]     -- participante atribuído ao segmento
  AND ts.start_date IS NOT NULL
  AND ts.end_date   IS NOT NULL
ORDER BY ts.start_date;
```

#### Pontos de validação

| Camada | Quando | Ação |
|---|---|---|
| **Client (UI)** | Ao atribuir um membro a um segmento | Exibir banner de aviso amarelo com as viagens em conflito |
| **Server (API)** | `PUT /api/trips/[id]/segments/[segId]` | Rodar `detectSegmentConflicts` e incluir `warnings: ConflictPair[]` na resposta — não rejeitar o save |
| **Itinerary screen** | Ao carregar a tela | Marcar visualmente eventos conflitantes com ícone ⚠️ |

#### Exemplo de conflito visualizado

```
⚠️  Conflito de agenda detectado

   [Trip A] Barcelona Leg 1       Jan 10 – Jan 15
   [Trip B] Paris Weekend         Jan 13 – Jan 16   ← sobrepõe 3 dias

   Você está atribuído a ambos os segmentos.
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
  const rows = await fetch(`/api/trips?userId=${user.sub}`)
    .then(r => r.ok ? r.json() : []).catch(() => []);
  if (rows.length > 0) setTrips(rows.map(rowToTrip));
}, [user]);

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

## 8. Decisões de Arquitetura (ADRs)

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
