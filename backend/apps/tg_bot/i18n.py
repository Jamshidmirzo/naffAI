"""
Tiny translation table for the Telegram bot.

`t(key, lang, **kwargs)` returns the localized string for `key`, falling
back to the Russian text if the language doesn't have it. `**kwargs` are
substituted via `str.format` so the call sites can stay readable.
"""

from __future__ import annotations

SUPPORTED_LANGUAGES = ("ru", "uz")
DEFAULT_LANGUAGE = "ru"

TRANSLATIONS: dict[str, dict[str, str]] = {
    # --- intro / generic ---
    "intro": {
        "ru": "Добавляем новую продажу 🛒\n\nНапиши *модель телефона* (например: «iPhone 13 128GB»).",
        "uz": "Yangi sotuv qoʻshamiz 🛒\n\n*Telefon modeli*ni yozing (masalan: «iPhone 13 128GB»).",
    },
    "cancel_nothing": {
        "ru": "Нечего отменять.",
        "uz": "Bekor qiladigan narsa yoʻq.",
    },
    "cancel_done": {
        "ru": "Отменено. /new — чтобы начать заново.",
        "uz": "Bekor qilindi. /new — qaytadan boshlash uchun.",
    },
    "model_empty": {
        "ru": "Модель не может быть пустой. Напиши ещё раз.",
        "uz": "Model boʻsh boʻla olmaydi. Qaytadan yozing.",
    },
    "ask_imei": {
        "ru": "Теперь *IMEI* (6–15 цифр).",
        "uz": "Endi *IMEI* (6–15 raqam).",
    },
    "imei_bad": {
        "ru": "IMEI должен быть из 6–15 цифр. Попробуй ещё раз.",
        "uz": "IMEI 6–15 raqamdan iborat boʻlishi kerak. Qaytadan urinib koʻring.",
    },
    "ask_amount": {
        "ru": "Сумма продажи в сумах (например: `4500000`).",
        "uz": "Sotuv summasi soʻmda (masalan: `4500000`).",
    },
    "amount_bad": {
        "ru": "Сумма должна быть числом ≥ 1 000. Попробуй ещё раз.",
        "uz": "Summa ≥ 1 000 boʻlishi kerak. Qaytadan urinib koʻring.",
    },

    # --- operator / partner picker ---
    "no_operators": {
        "ru": "Нет активных операторов. Создай их в дашборде сначала.",
        "uz": "Faol sotuvchilar yoʻq. Avval dashbordda qoʻshing.",
    },
    "no_partners": {
        "ru": "Нет активных партнёров. Создай их в дашборде сначала.",
        "uz": "Faol hamkorlar yoʻq. Avval dashbordda qoʻshing.",
    },
    "ask_operator": {
        "ru": "Кто продал? Выбери из списка или впиши имя.",
        "uz": "Kim sotdi? Roʻyxatdan tanlang yoki ismni yozing.",
    },
    "ask_partner": {
        "ru": "Через какого партнёра оплата? (Alif/Birzum/Hamroh/Cash/...)",
        "uz": "Qaysi hamkor orqali toʻlov? (Alif/Birzum/Hamroh/Cash/...)",
    },
    "type_operator_name": {
        "ru": "Впиши имя оператора.",
        "uz": "Sotuvchi ismini yozing.",
    },
    "type_partner_name": {
        "ru": "Впиши название партнёра.",
        "uz": "Hamkor nomini yozing.",
    },
    "name_empty": {
        "ru": "Имя не может быть пустым.",
        "uz": "Ism boʻsh boʻla olmaydi.",
    },
    "operator_not_found": {
        "ru": "Не нашёл оператора",
        "uz": "Sotuvchi topilmadi",
    },
    "partner_not_found": {
        "ru": "Не нашёл партнёра",
        "uz": "Hamkor topilmadi",
    },

    # --- split flow ---
    "ask_op_split": {
        "ru": "Сколько для *{label}*?",
        "uz": "*{label}* uchun qancha?",
    },
    "ask_op_amount_rem": {
        "ru": "Сколько для *{label}*? Осталось распределить: *{rem}*.",
        "uz": "*{label}* uchun qancha? Qolgan: *{rem}*.",
    },
    "ask_op_amount_type": {
        "ru": "Сколько для *{label}*? Напиши сумму.",
        "uz": "*{label}* uchun qancha? Summani yozing.",
    },
    "ask_partner_split": {
        "ru": "Сколько через *{label}*?",
        "uz": "*{label}* orqali qancha?",
    },
    "ask_partner_amount_rem": {
        "ru": "Сколько через *{label}*? Осталось распределить: *{rem}*.",
        "uz": "*{label}* orqali qancha? Qolgan: *{rem}*.",
    },
    "ask_partner_amount_type": {
        "ru": "Сколько через *{label}*? Напиши сумму.",
        "uz": "*{label}* orqali qancha? Summani yozing.",
    },
    "amount_too_big": {
        "ru": "Слишком много — осталось всего *{rem}*. Попробуй ещё раз.",
        "uz": "Juda koʻp — atigi *{rem}* qolgan. Qaytadan urinib koʻring.",
    },
    "ops_done": {
        "ru": "👤 Операторы распределены:\n{summary}",
        "uz": "👤 Sotuvchilar boʻlindi:\n{summary}",
    },
    "partners_done": {
        "ru": "🤝 Партнёры распределены:\n{summary}",
        "uz": "🤝 Hamkorlar boʻlindi:\n{summary}",
    },
    "remaining_to_whom": {
        "ru": "Осталось *{rem}* — кому?",
        "uz": "*{rem}* qoldi — kimga?",
    },
    "remaining_via_whom": {
        "ru": "Осталось *{rem}* — через кого?",
        "uz": "*{rem}* qoldi — kim orqali?",
    },
    "saved_one_op": {
        "ru": "Записал на одного.",
        "uz": "Bittasiga yozildi.",
    },

    # --- date ---
    "ask_date": {"ru": "Какая дата продажи?", "uz": "Sotuv sanasi qaysi?"},
    "ask_date_text": {
        "ru": "Впиши дату в формате `YYYY-MM-DD` (например `2026-06-12`).",
        "uz": "Sanani `YYYY-MM-DD` formatda yozing (masalan `2026-06-12`).",
    },
    "date_bad": {
        "ru": "Не понял дату. Формат: `YYYY-MM-DD`, например `2026-06-12`.",
        "uz": "Sanani tushunmadim. Format: `YYYY-MM-DD`, masalan `2026-06-12`.",
    },

    # --- comment + preview + confirm ---
    "ask_comment": {
        "ru": "Комментарий? Напиши текст или `-` чтобы пропустить.",
        "uz": "Izoh? Matn yozing yoki oʻtkazib yuborish uchun `-`.",
    },
    "preview_header": {
        "ru": "📋 *Проверь продажу:*",
        "uz": "📋 *Sotuvni tekshiring:*",
    },
    "preview_model": {"ru": "📱 *Модель:* {x}", "uz": "📱 *Model:* {x}"},
    "preview_imei": {"ru": "🔢 *IMEI:* `{x}`", "uz": "🔢 *IMEI:* `{x}`"},
    "preview_amount": {"ru": "💰 *Сумма:* {x}", "uz": "💰 *Summa:* {x}"},
    "preview_operators": {"ru": "👤 *Операторы:*", "uz": "👤 *Sotuvchilar:*"},
    "preview_partners": {"ru": "🤝 *Партнёры:*", "uz": "🤝 *Hamkorlar:*"},
    "preview_date": {"ru": "📅 *Дата:* {x}", "uz": "📅 *Sana:* {x}"},
    "preview_comment": {"ru": "📝 *Комментарий:* {x}", "uz": "📝 *Izoh:* {x}"},
    "preview_dash": {"ru": "—", "uz": "—"},
    "saving": {"ru": "Сохраняю…", "uz": "Saqlayapman…"},
    "save_fail": {
        "ru": "❌ Не получилось сохранить: `{exc}`",
        "uz": "❌ Saqlab boʻlmadi: `{exc}`",
    },
    "save_ok": {
        "ru": "✅ Продажа `#{id}` сохранена!\n\n/new — добавить ещё одну.",
        "uz": "✅ Sotuv `#{id}` saqlandi!\n\n/new — yana bittasini qoʻshish.",
    },
    "cancel_confirm": {
        "ru": "Отменено. /new — чтобы добавить ещё одну.",
        "uz": "Bekor qilindi. /new — yana bittasini qoʻshish uchun.",
    },

    # --- subscription / report ---
    "sub_already": {
        "ru": "Уже подписан. /report — отчёт сейчас.",
        "uz": "Allaqachon obuna boʻlgansiz. /report — hozir hisobot.",
    },
    "sub_ok": {
        "ru": "✅ Подписался! Каждый день в *{hour:02d}:00* отправлю отчёт сюда.\n"
              "/unsubscribe — отписаться.\n/report — отчёт сейчас.",
        "uz": "✅ Obuna boʻldim! Har kuni *{hour:02d}:00* da bu yerga hisobot yuboraman.\n"
              "/unsubscribe — obunani bekor qilish.\n/report — hozir hisobot.",
    },
    "unsub_ok": {"ru": "👋 Отписался.", "uz": "👋 Obuna bekor qilindi."},
    "unsub_none": {
        "ru": "Не нашёл активной подписки.",
        "uz": "Faol obuna topilmadi.",
    },

    # --- language ---
    "ask_language": {
        "ru": "Выбери язык бота:",
        "uz": "Bot tilini tanlang:",
    },
    "lang_set": {
        "ru": "✅ Готово. Я теперь говорю по-русски.",
        "uz": "✅ Tayyor. Endi men oʻzbek tilida gaplashaman.",
    },

    # --- buttons ---
    "btn_take_all": {
        "ru": "✅ Весь объём ({label})",
        "uz": "✅ Toʻliq summa ({label})",
    },
    "btn_split": {
        "ru": "➕ Поделить с другим",
        "uz": "➕ Boshqasi bilan boʻlish",
    },
    "btn_type_op": {"ru": "✏️ Ввести имя", "uz": "✏️ Ism kiritish"},
    "btn_type_partner": {
        "ru": "✏️ Ввести название",
        "uz": "✏️ Nom kiritish",
    },
    "btn_today": {"ru": "Сегодня · {d}", "uz": "Bugun · {d}"},
    "btn_yesterday": {"ru": "Вчера · {d}", "uz": "Kecha · {d}"},
    "btn_day_before": {"ru": "Позавчера · {d}", "uz": "Olloy · {d}"},
    "btn_custom_date": {"ru": "📅 Другая дата", "uz": "📅 Boshqa sana"},
    "btn_save": {"ru": "✅ Сохранить", "uz": "✅ Saqlash"},
    "btn_cancel": {"ru": "❌ Отменить", "uz": "❌ Bekor qilish"},
    "btn_ru": {"ru": "🇷🇺 Русский", "uz": "🇷🇺 Русский"},
    "btn_uz": {"ru": "🇺🇿 Oʻzbekcha", "uz": "🇺🇿 Oʻzbekcha"},

    # --- bot command descriptions (set_my_commands) ---
    "cmd_new": {"ru": "🛒 Новая продажа", "uz": "🛒 Yangi sotuv"},
    "cmd_report": {"ru": "📊 Отчёт за сегодня", "uz": "📊 Bugungi hisobot"},
    "cmd_subscribe": {
        "ru": "🔔 Получать отчёт каждый день",
        "uz": "🔔 Har kuni hisobot olish",
    },
    "cmd_unsubscribe": {
        "ru": "🔕 Отписаться от отчётов",
        "uz": "🔕 Hisobotdan voz kechish",
    },
    "cmd_cancel": {
        "ru": "❌ Отменить текущий ввод",
        "uz": "❌ Joriy kiritishni bekor qilish",
    },
    "cmd_start": {"ru": "ℹ️ Запустить бота", "uz": "ℹ️ Botni ishga tushirish"},
    "cmd_language": {"ru": "🌍 Сменить язык", "uz": "🌍 Tilni almashtirish"},

    # --- daily report ---
    "rep_header": {"ru": "📊 *Отчёт за {date}*", "uz": "📊 *{date} hisoboti*"},
    "rep_today": {
        "ru": "💰 Оборот: *{total}*  ·  {count} продаж",
        "uz": "💰 Aylanma: *{total}*  ·  {count} ta sotuv",
    },
    "rep_yest": {
        "ru": "📅 Вчера:  {total} · {count} продаж",
        "uz": "📅 Kecha:  {total} · {count} ta sotuv",
    },
    "rep_diff": {"ru": "        {diff}", "uz": "        {diff}"},
    "rep_diff_label": {
        "ru": "{amount} {emoji} к вчера",
        "uz": "{amount} {emoji} kechagidan",
    },
    "rep_operators": {"ru": "👤 *Операторы:*", "uz": "👤 *Sotuvchilar:*"},
    "rep_partners": {"ru": "🤝 *Партнёры:*", "uz": "🤝 *Hamkorlar:*"},
    "rep_no_ops": {
        "ru": "👤 *Операторы:* — нет продаж",
        "uz": "👤 *Sotuvchilar:* — sotuv yoʻq",
    },
    "rep_no_partners": {
        "ru": "🤝 *Партнёры:* —",
        "uz": "🤝 *Hamkorlar:* —",
    },
    "rep_currency": {"ru": "сум", "uz": "soʻm"},
}


def t(key: str, lang: str | None = None, **kwargs) -> str:
    """Look up a translation by key + language, then `.format(**kwargs)` it."""
    if lang not in SUPPORTED_LANGUAGES:
        lang = DEFAULT_LANGUAGE
    table = TRANSLATIONS.get(key, {})
    text = table.get(lang) or table.get(DEFAULT_LANGUAGE) or key
    if kwargs:
        try:
            return text.format(**kwargs)
        except (KeyError, IndexError):
            return text
    return text
