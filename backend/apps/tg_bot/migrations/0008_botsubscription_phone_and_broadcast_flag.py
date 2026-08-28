"""
Phone-based bot broadcast management (2026-08-28).

Adds:
  - `BotSubscription.phone` — normalised +998XXXXXXXXX captured from
    `Message.contact` after `/start`. Empty for legacy subs.
  - `BotSubscription.linked_operator` / `linked_profile` — auto-linked
    when the contact arrives (see runner.py + services.py).
  - `BotSubscription.receives_broadcasts` — manager-controlled opt-in
    consumed by the 3-hour leaderboard cron. Default False; the data
    migration below flips the four known manager subs to True while
    keeping the operator (Dilafruz) off.
  - `BotSubscription.last_seen_at` — auto_now, promotes list-sort
    stability in the manager UI.

The data-migration matches by `chat_id` so it's a no-op on empty
databases (tests, fresh envs, local dev).
"""

from django.db import migrations, models

# Prod snapshot 2026-08-28 — 4 known active subs:
#   88938071   → Jamshidmirzo (team_lead) — ON
#   8360040547 → "д" (manager)            — ON
#   7144045955 → Naff_uz D (manager)      — ON
#   8570548654 → Dilafruz (operator)      — OFF (she gets DMs personally,
#                                            not the manager digest)
_BROADCAST_ON_CHAT_IDS = [88938071, 8360040547, 7144045955]
_BROADCAST_OFF_CHAT_IDS = [8570548654]


def seed_broadcast_flags(apps, schema_editor):
    BotSubscription = apps.get_model("tg_bot", "BotSubscription")
    BotSubscription.objects.filter(chat_id__in=_BROADCAST_ON_CHAT_IDS).update(
        receives_broadcasts=True
    )
    BotSubscription.objects.filter(chat_id__in=_BROADCAST_OFF_CHAT_IDS).update(
        receives_broadcasts=False
    )


def unseed_broadcast_flags(apps, schema_editor):
    # Reverse migration is a no-op — flipping every sub back to default
    # would clobber whatever the manager chose in the UI meanwhile. If a
    # rollback is genuinely needed, do it via ORM/shell manually.
    return


class Migration(migrations.Migration):

    dependencies = [
        ("tg_bot", "0007_bot_templates"),
        ("operators", "0001_initial"),
        ("users", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="botsubscription",
            name="phone",
            field=models.CharField(
                blank=True, db_index=True, default="", max_length=16
            ),
        ),
        migrations.AddField(
            model_name="botsubscription",
            name="linked_operator",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.deletion.SET_NULL,
                related_name="+",
                to="operators.operator",
            ),
        ),
        migrations.AddField(
            model_name="botsubscription",
            name="linked_profile",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.deletion.SET_NULL,
                related_name="+",
                to="users.profile",
            ),
        ),
        migrations.AddField(
            model_name="botsubscription",
            name="receives_broadcasts",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="botsubscription",
            name="last_seen_at",
            field=models.DateTimeField(auto_now=True),
        ),
        migrations.RunPython(seed_broadcast_flags, unseed_broadcast_flags),
    ]
