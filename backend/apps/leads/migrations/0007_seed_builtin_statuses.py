"""Seed the 13 historical LeadStatus enum values into LeadStatusLabel."""

from django.db import migrations


BUILTIN = [
    # code                emoji  tone      order  chip   button   ru                    uz
    ("new",               "📋", "info",    10,   True,  True,   "Новый",              "Yangi"),
    ("assigned",          "👤", "info",    20,   True,  True,   "Назначен",           "Tayinlangan"),
    ("in_progress",       "💬", "hot",     30,   True,  False,  "В работе",           "Ishda"),
    ("callback_scheduled","⏰", "info",    40,   True,  False,  "Callback",           "Callback"),
    ("contacted_telegram","💬", "info",    50,   True,  True,   "TG'га боғланди",     "TGga bog'landi"),
    ("no_answer",         "📵", "neutral", 60,   True,  True,   "Javob bermadi 1",    "Javob bermadi 1"),
    ("no_answer_2",       "⚠️", "hot",     70,   True,  True,   "Javob bermadi 2",    "Javob bermadi 2"),
    ("phone_on",          "📞", "info",    80,   True,  True,   "Telfoni ochiq",      "Telfoni ochiq"),
    ("has_debt",          "💸", "danger",  90,   True,  True,   "Qarzi bor",          "Qarzi bor"),
    ("won",               "💰", "success", 100,  False, False,  "Продажа",            "Sotildi"),
    ("lost",              "✖️", "danger",  110,  True,  False,  "Потерян",            "Yo'qotildi"),
    ("archived",          "📦", "neutral", 120,  False, False,  "Архив",              "Arxiv"),
    ("needs_review",      "🚩", "hot",     130,  True,  False,  "Требует проверки",   "Tekshirish kerak"),
]


def seed(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")
    for code, emoji, tone, order, chip, button, ru, uz in BUILTIN:
        LeadStatusLabel.objects.update_or_create(
            code=code,
            defaults={
                "emoji": emoji,
                "tone": tone,
                "sort_order": order,
                "show_in_chip": chip,
                "show_in_button": button,
                "label_ru": ru,
                "label_uz": uz,
                "is_active": True,
                "is_builtin": True,
            },
        )


def unseed(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")
    LeadStatusLabel.objects.filter(is_builtin=True).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0006_leadstatuslabel"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
