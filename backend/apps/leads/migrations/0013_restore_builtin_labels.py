"""
Restore builtin `new` / `assigned` labels that were manually renamed
in the DB — the manager repurposed them because a couple of concepts
didn't have their own code yet. Now that the domain has explicit
codes for those concepts, revert the two builtins so the DB matches
the semantics the code assumes.

- `new` → "Новый / Yangi" (this is the initial state before an
  operator picks up the lead).
- `assigned` → "Назначен / Tayinlangan" (lead has been assigned to
  an operator but no work happened yet).

The concepts the manager was actually tracking with those codes are
already covered:
- "Rad etildi" (rejected) → covered by builtin `lost`.
- "Yangi" (fresh) → semantically same as `new`, no need for a
  separate code — restore the label and it disappears from the "new
  status" mental model.

No shape change — pure data.
"""

from django.db import migrations


def upgrade(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")
    LeadStatusLabel.objects.filter(code="new").update(
        label_ru="Новый",
        label_uz="Yangi",
        tone="info",
        emoji="📋",
        sort_order=10,
    )
    LeadStatusLabel.objects.filter(code="assigned").update(
        label_ru="Назначен",
        label_uz="Tayinlangan",
        tone="info",
        emoji="👤",
        sort_order=20,
    )


def downgrade(apps, schema_editor):
    # Manager's previous labels were arbitrary — not restoring them.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0012_lead_phone_alt"),
    ]

    operations = [
        migrations.RunPython(upgrade, downgrade),
    ]
