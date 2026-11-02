"""
Meta Marketing API (Graph API) — реальная статистика рекламы таргетологов.

- `client.py` — тонкий HTTP-клиент: аккаунты, Insights (level=ad, по дням),
  объявления с креативами, срок жизни токена.
- `sync.py` — upsert статистики в `marketing.MetaAd` / `MetaAdInsightDaily`.
- `fx.py` — курс ЦБ Узбекистана для пересчёта расхода в сумы.
"""
