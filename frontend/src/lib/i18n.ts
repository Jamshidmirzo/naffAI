import { useLang, type Lang } from "../store/lang";

/**
 * Тонкий словарный i18n без внешних зависимостей.
 *
 * — Одно место (`STRINGS`) для всех переводов.
 * — Хук `useT()` возвращает функцию `t("key")` — берёт активный `lang`
 *   из zustand-store и подписывается на его смену.
 * — Ключи — плоские `namespace.field` (например `sidebar.dashboard`).
 * — Fallback: если UZ отсутствует — возвращаем RU. Если ключа нет
 *   вообще — возвращаем сам ключ (заметно в UI, легко найти дыру).
 * — Интерполяция примитивная: `{n}` → `t("k", { n: 42 })`.
 */

type Dict = Record<string, string>;
type Lookup = Record<Lang, Dict>;

const STRINGS: Lookup = {
  ru: {
    // ------ common ------
    "common.save": "Сохранить",
    "common.cancel": "Отмена",
    "common.delete": "Удалить",
    "common.edit": "Редактировать",
    "common.back": "Назад",
    "common.next": "Далее",
    "common.close": "Закрыть",
    "common.loading": "Загрузка…",
    "common.empty": "Пусто",
    "common.search": "Поиск",
    "common.export": "Excel",
    "common.filters": "Фильтры",
    "common.today": "Сегодня",
    "common.week": "Неделя",
    "common.month": "Месяц",
    "common.quarter": "Квартал",
    "common.total": "Всего",
    "common.of": "из",
    "common.new": "Новый",
    "common.done": "Готово",
    "common.retry": "Повторить",
    "common.reset": "Сбросить",
    "common.actions": "Действия",
    "common.logout": "Выйти",
    "common.language": "Язык",
    "common.theme_light": "Светлая",
    "common.theme_dark": "Тёмная",
    "common.forgot_password": "Забыли пароль?",
    "common.copied": "Скопировано",

    // ------ roles ------
    "role.manager": "Менеджер",
    "role.operator": "Оператор",

    // ------ sidebar sections ------
    "sidebar.analytics": "Аналитика",
    "sidebar.attendance": "Посещаемость",
    "sidebar.team": "Команда",
    "sidebar.catalogs": "Справочники",
    "sidebar.ai_tg": "AI & Telegram",

    // ------ sidebar items ------
    "nav.dashboard": "Дашборд",
    "nav.sales": "Продажи",
    "nav.leads": "Лиды",
    "nav.analytics": "Аналитика",
    "nav.reports": "Отчёты",
    "nav.screen": "Табло",
    "nav.attendance_today": "Сегодня",
    "nav.attendance_report": "Отчёт",
    "nav.operators": "Операторы",
    "nav.payroll": "Зарплата",
    "nav.lessons": "Уроки",
    "nav.users": "Пользователи",
    "nav.stickers": "Стикеры",
    "nav.catalog": "Каталог",
    "nav.partners": "Партнёры",
    "nav.sheet_sources": "Google-Sheets",
    "nav.calls": "Звонки",
    "nav.ai_chat": "AI-чат",
    "nav.tg_queue": "Очередь Telegram",
    "nav.marketing": "Маркетинг",
    "nav.audit": "Аудит",
    "nav.my_leads": "Мои лиды",
    "nav.notifications": "Уведомления",
    "nav.lesson_today": "Уроки — сегодня",
    "nav.lesson_history": "Уроки — история",
    "nav.profile": "Профиль",

    // ------ login ------
    "login.title": "Вход в систему",
    "login.subtitle": "Учёт продаж и управление операторами",
    "login.username": "Логин",
    "login.password": "Пароль",
    "login.demo_role": "Демо-роль",
    "login.demo_hint": "Демо: пароль по умолчанию",
    "login.submit": "Войти",
    "login.submitting": "Вход…",
    "login.op_hint_prefix": "Оператор — номер в формате",

    // ------ dashboard ------
    "dash.eyebrow": "ДАШБОРД · СЕГОДНЯ",
    "dash.greeting": "Доброго дня.",
    "dash.today_zero": "Пока ни одной продажи сегодня.",
    "dash.today_some_prefix": "Уже",
    "dash.today_some_suffix": "продаж сегодня.",
    "dash.operators_online": "{n} операторов на смене · сводка обновляется автоматически.",
    "dash.new_sale": "+ Новая продажа",
    "dash.open_screen": "Открыть табло",
    "dash.kpi_sales_today": "Продажи сегодня",
    "dash.kpi_sum_today": "Сумма сегодня",
    "dash.kpi_month": "За месяц",
    "dash.kpi_online": "На смене",
    "dash.chart_title": "Динамика продаж",
    "dash.top_operators": "Топ операторов",
    "dash.sales_feed": "Лента продаж",
    "dash.realtime": "реалтайм",
    "dash.subtitle": "Сводка по продажам и операторам",

    // ------ pieces used by many pages ------
    "sales.title": "Продажи",
    "sales.subtitle": "Все продажи и возвраты",
    "sales.new": "Новая продажа",
    "sales.search_ph": "Поиск по IMEI, модели, оператору…",
    "sales.tab_all": "Все",
    "sales.tab_regular": "Продажи",
    "sales.tab_returns": "Возвраты",
    "sales.tab_gifts": "Подарки",
    "sales.empty": "Ничего не найдено — измените запрос или фильтры",

    "leads.title": "Лиды",
    "leads.subtitle": "Управление воронкой и назначением",
    "leads.tab_all": "Все лиды",
    "leads.tab_review": "Нужна проверка",
    "leads.tab_unassigned": "Без оператора",
    "leads.assign": "Назначить оператора",
    "leads.picked": "Выбрано: {n}",
    "leads.overdue": "{n} просрочено",

    // ------ page shells ------
    "attendance.today.title": "Посещаемость",
    "attendance.today.subtitle": "Кто на смене сейчас",
    "attendance.report.title": "Посещаемость — отчёт",
    "operators.title": "Операторы",
    "operators.subtitle": "Управление командой",
    "analytics.title": "Аналитика",
    "reports.title": "Отчёты",
    "payroll.title": "Зарплата",
    "audit.title": "Аудит",
    "ai_chat.title": "AI-ассистент",
    "ai_chat.subtitle": "Спрашивайте про данные",
    "tg_queue.title": "Очередь Telegram",
    "tg_queue.subtitle": "Подключение операторов и загрузка их переписки",
    "marketing.title": "Маркетинг",

    "my.title": "Мои лиды",
    "my.subtitle": "Рабочая станция оператора",
    "my.morning": "Доброе утро",
    "my.tab_active": "Активные",
    "my.tab_postponed": "Отложенные",
    "my.tab_all": "Все",
    "my.leads_count": "{n} лидов",

    // ------ misc ------
    "toast.saved": "Сохранено",
    "toast.deleted": "Удалено",
    "toast.copied_login": "Логин скопирован",
    "toast.copied_password": "Пароль скопирован",
  },

  uz: {
    // ------ common ------
    "common.save": "Saqlash",
    "common.cancel": "Bekor qilish",
    "common.delete": "O'chirish",
    "common.edit": "Tahrirlash",
    "common.back": "Orqaga",
    "common.next": "Keyingi",
    "common.close": "Yopish",
    "common.loading": "Yuklanmoqda…",
    "common.empty": "Bo'sh",
    "common.search": "Qidirish",
    "common.export": "Excel",
    "common.filters": "Filtrlar",
    "common.today": "Bugun",
    "common.week": "Hafta",
    "common.month": "Oy",
    "common.quarter": "Chorak",
    "common.total": "Jami",
    "common.of": "dan",
    "common.new": "Yangi",
    "common.done": "Tayyor",
    "common.retry": "Qayta",
    "common.reset": "Tozalash",
    "common.actions": "Amallar",
    "common.logout": "Chiqish",
    "common.language": "Til",
    "common.theme_light": "Yorug'",
    "common.theme_dark": "Qorong'i",
    "common.forgot_password": "Parolni unutdingizmi?",
    "common.copied": "Nusxalandi",

    // ------ roles ------
    "role.manager": "Menejer",
    "role.operator": "Operator",

    // ------ sidebar sections ------
    "sidebar.analytics": "Tahlil",
    "sidebar.attendance": "Davomat",
    "sidebar.team": "Jamoa",
    "sidebar.catalogs": "Ma'lumotnomalar",
    "sidebar.ai_tg": "AI & Telegram",

    // ------ sidebar items ------
    "nav.dashboard": "Boshqaruv paneli",
    "nav.sales": "Sotuvlar",
    "nav.leads": "Lidlar",
    "nav.analytics": "Tahlil",
    "nav.reports": "Hisobotlar",
    "nav.screen": "Tablo",
    "nav.attendance_today": "Bugun",
    "nav.attendance_report": "Hisobot",
    "nav.operators": "Operatorlar",
    "nav.payroll": "Oylik",
    "nav.lessons": "Darslar",
    "nav.users": "Foydalanuvchilar",
    "nav.stickers": "Stikerlar",
    "nav.catalog": "Katalog",
    "nav.partners": "Hamkorlar",
    "nav.sheet_sources": "Google-Sheets",
    "nav.calls": "Qo'ng'iroqlar",
    "nav.ai_chat": "AI-chat",
    "nav.tg_queue": "Telegram navbati",
    "nav.marketing": "Marketing",
    "nav.audit": "Audit",
    "nav.my_leads": "Mening lidlarim",
    "nav.notifications": "Bildirishnomalar",
    "nav.lesson_today": "Darslar — bugun",
    "nav.lesson_history": "Darslar — tarix",
    "nav.profile": "Profil",

    // ------ login ------
    "login.title": "Tizimga kirish",
    "login.subtitle": "Sotuv hisobi va operatorlarni boshqarish",
    "login.username": "Login",
    "login.password": "Parol",
    "login.demo_role": "Demo-rol",
    "login.demo_hint": "Demo: standart parol",
    "login.submit": "Kirish",
    "login.submitting": "Kirish…",
    "login.op_hint_prefix": "Operator — raqam formatda",

    // ------ dashboard ------
    "dash.eyebrow": "BOSHQARUV PANELI · BUGUN",
    "dash.greeting": "Xayrli kun.",
    "dash.today_zero": "Bugun hali sotuv yo'q.",
    "dash.today_some_prefix": "Allaqachon",
    "dash.today_some_suffix": "ta sotuv bugun.",
    "dash.operators_online": "{n} operator smenada · ma'lumot avto yangilanadi.",
    "dash.new_sale": "+ Yangi sotuv",
    "dash.open_screen": "Tabloni ochish",
    "dash.kpi_sales_today": "Bugun sotuvlar",
    "dash.kpi_sum_today": "Bugun summa",
    "dash.kpi_month": "Oy uchun",
    "dash.kpi_online": "Smenada",
    "dash.chart_title": "Sotuvlar dinamikasi",
    "dash.top_operators": "Top operatorlar",
    "dash.sales_feed": "Sotuvlar oqimi",
    "dash.realtime": "realtayn",
    "dash.subtitle": "Sotuv va operatorlar bo'yicha xulosa",

    // ------ pieces used by many pages ------
    "sales.title": "Sotuvlar",
    "sales.subtitle": "Barcha sotuv va qaytarishlar",
    "sales.new": "Yangi sotuv",
    "sales.search_ph": "IMEI, model, operator bo'yicha qidirish…",
    "sales.tab_all": "Barchasi",
    "sales.tab_regular": "Sotuvlar",
    "sales.tab_returns": "Qaytarishlar",
    "sales.tab_gifts": "Sovg'alar",
    "sales.empty": "Hech narsa topilmadi — filtrlarni o'zgartiring",

    "leads.title": "Lidlar",
    "leads.subtitle": "Voronka va tayinlashni boshqarish",
    "leads.tab_all": "Barcha lidlar",
    "leads.tab_review": "Tekshirish kerak",
    "leads.tab_unassigned": "Operatorsiz",
    "leads.assign": "Operator tayinlash",
    "leads.picked": "Tanlangan: {n}",
    "leads.overdue": "{n} muddati o'tgan",

    // ------ page shells ------
    "attendance.today.title": "Davomat",
    "attendance.today.subtitle": "Hozir smenada kim bor",
    "attendance.report.title": "Davomat — hisobot",
    "operators.title": "Operatorlar",
    "operators.subtitle": "Jamoani boshqarish",
    "analytics.title": "Tahlil",
    "reports.title": "Hisobotlar",
    "payroll.title": "Oylik",
    "audit.title": "Audit",
    "ai_chat.title": "AI-yordamchi",
    "ai_chat.subtitle": "Ma'lumotlar haqida so'rang",
    "tg_queue.title": "Telegram navbati",
    "tg_queue.subtitle": "Operatorlarni ulash va yozishmalarni yuklab olish",
    "marketing.title": "Marketing",

    "my.title": "Mening lidlarim",
    "my.subtitle": "Operator ish stansiyasi",
    "my.morning": "Xayrli tong",
    "my.tab_active": "Faol",
    "my.tab_postponed": "Kechiktirilgan",
    "my.tab_all": "Barchasi",
    "my.leads_count": "{n} ta lid",

    // ------ misc ------
    "toast.saved": "Saqlandi",
    "toast.deleted": "O'chirildi",
    "toast.copied_login": "Login nusxalandi",
    "toast.copied_password": "Parol nusxalandi",
  },
};

export function translate(lang: Lang, key: string, params?: Record<string, string | number>) {
  const value = STRINGS[lang]?.[key] ?? STRINGS.ru[key] ?? key;
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ""));
}

export function useT() {
  const lang = useLang((s) => s.lang);
  return (key: string, params?: Record<string, string | number>) =>
    translate(lang, key, params);
}

export function useLangValue(): Lang {
  return useLang((s) => s.lang);
}
