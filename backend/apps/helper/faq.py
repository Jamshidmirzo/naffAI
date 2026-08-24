"""
Статические FAQ — ru+uz, отдаются одним куском в /operator-suggestions/.

Правки — через код + деплой. Если менеджер захочет менять сам —
Phase-2: SystemSetting + admin CRUD.
"""

from __future__ import annotations

FAQ: list[dict] = [
    {
        "id": "why_no_leads",
        "q_ru": "Почему мне не приходят новые лиды?",
        "q_uz": "Nega menga yangi lidlar kelmayapti?",
        "a_ru": (
            "Система выдаёт новых лидов только когда у вас в работе меньше 5. "
            "Закройте старые (no_answer / lost / won) — придут свежие. "
            "Ещё возможные причины: смена не отмечена, есть просроченный callback, "
            "или менеджер выключил авто-раздачу."
        ),
        "a_uz": (
            "Tizim yangi lidlarni faqat ish jarayonida 5 tadan kam bo'lganda beradi. "
            "Eskisini yoping (no_answer / lost / won) — yangilari keladi. "
            "Boshqa sabablar: smena belgilanmagan, muddati o'tgan callback bor, "
            "yoki menejer avto-tarqatishni o'chirib qo'ygan."
        ),
    },
    {
        "id": "how_upload_contract_photo",
        "q_ru": "Как загрузить фото договора при продаже?",
        "q_uz": "Sotuv paytida shartnoma suratini qanday yuklash mumkin?",
        "a_ru": (
            "На форме создания продажи блок «Shartnoma surati». Можно "
            "перетащить фото, нажать «Kamera» и снять на месте, или вставить "
            "из буфера обмена (Ctrl+V). До 5 штук на одну продажу."
        ),
        "a_uz": (
            "Sotuv formasida «Shartnoma surati» bloki bor. Suratni sudrab "
            "tashlashingiz, «Kamera» tugmasini bosib joyida olishingiz yoki "
            "buferdan qo'yishingiz (Ctrl+V) mumkin. Bir sotuvga 5 tagacha."
        ),
    },
    {
        "id": "how_check_in",
        "q_ru": "Как отметиться на смене?",
        "q_uz": "Smenaga qanday belgilanish mumkin?",
        "a_ru": (
            "Два способа: 1) отсканировать QR-код камерой телефона у менеджера "
            "(киоск на большом экране); 2) открыть /scan в браузере и приложить "
            "лицо к камере. При выходе — повторите операцию, смена закроется."
        ),
        "a_uz": (
            "Ikki yo'l: 1) menejerdagi katta ekrandagi QR-kodni telefon "
            "kamerasi bilan skanerlash; 2) brauzerda /scan sahifasini ochib, "
            "yuzingizni kameraga ko'rsatish. Ishdan chiqishda ham xuddi shu "
            "amalni takrorlang — smena yopiladi."
        ),
    },
    {
        "id": "forgot_pin",
        "q_ru": "Забыл PIN — как восстановить?",
        "q_uz": "PIN esimdan chiqdi — qanday tiklash mumkin?",
        "a_ru": (
            "PIN нужен только менеджеру для attendance-раздела. Обратитесь к "
            "супер-админу — он сбросит PIN через настройки. У оператора PIN "
            "не запрашивается вообще."
        ),
        "a_uz": (
            "PIN faqat menejerga kerak (attendance bo'limi uchun). Super-adminga "
            "murojaat qiling — u sozlamalar orqali PIN'ni qayta tiklaydi. "
            "Operatorda PIN umuman so'ralmaydi."
        ),
    },
    {
        "id": "imei_lookup",
        "q_ru": "Как узнать модель по IMEI?",
        "q_uz": "IMEI orqali modelni qanday bilish mumkin?",
        "a_ru": (
            "Просто вставьте IMEI (15 цифр) в поле «IMEI» на форме продажи — "
            "модель подставится автоматически из TAC-базы. Если модели нет — "
            "введите вручную, потом IMEI-справочник обновится."
        ),
        "a_uz": (
            "IMEI'ni (15 raqam) sotuv formasidagi «IMEI» maydoniga kiriting — "
            "model TAC bazasidan avtomatik tarzda to'ldiriladi. Model bazada "
            "bo'lmasa — qo'lda kiriting, keyin TAC yangilanadi."
        ),
    },
    {
        "id": "phone_on",
        "q_ru": "Что ставить, если телефон включён но не берут?",
        "q_uz": "Telefon yoqilgan lekin javob berilmasa nima qo'yish kerak?",
        "a_ru": (
            "Ставьте статус `phone_on` — лид уйдёт в carry-хвост, а после 13:00 "
            "снова всплывёт в активной вкладке, чтобы перезвонить после обеда. "
            "Ставить `no_answer` тоже нормально — правило то же."
        ),
        "a_uz": (
            "`phone_on` statusini qo'ying — lid carry-ro'yxatiga o'tadi, "
            "13:00'dan keyin yana faol yorliqda paydo bo'ladi (tushdan keyin "
            "qo'ng'iroq qilish uchun). `no_answer` ham to'g'ri — qoida bir xil."
        ),
    },
    {
        "id": "customer_not_answering",
        "q_ru": "Клиент вообще не берёт трубку 3+ раза — что делать?",
        "q_uz": "Mijoz 3+ marta trubkani ko'tarmaydi — nima qilish kerak?",
        "a_ru": (
            "Попробуйте написать в Telegram (если номер в TG), поставьте "
            "`contacted_telegram`. Если и там молчит — закрывайте `lost` с "
            "комментарием «не отвечает 3 попытки»."
        ),
        "a_uz": (
            "Telegram'ga yozib ko'ring (raqam TG'da bo'lsa), `contacted_telegram` "
            "qo'ying. U yerda ham javob bermasa — «3 marta javob bermadi» "
            "izohi bilan `lost` qilib yoping."
        ),
    },
    {
        "id": "return_sale",
        "q_ru": "Как оформить возврат по продаже?",
        "q_uz": "Sotuv bo'yicha qaytarishni qanday rasmiylashtirish mumkin?",
        "a_ru": (
            "Возврат оформляет менеджер — напишите ему в чате: номер продажи "
            "(в разделе «Мои продажи»), IMEI, причину возврата. Ваша зарплата "
            "автоматически пересчитается — сумма продажи вычтется."
        ),
        "a_uz": (
            "Qaytarishni menejer rasmiylashtiradi — unga chatda yozing: sotuv "
            "raqami («Mening sotuvlarim» bo'limida), IMEI, qaytarish sababi. "
            "Oyligingiz avtomatik qayta hisoblanadi — sotuv summasi ayiriladi."
        ),
    },
    {
        "id": "view_stats",
        "q_ru": "Где посмотреть свою статистику за месяц?",
        "q_uz": "O'zimning oylik statistikamni qayerdan ko'rish mumkin?",
        "a_ru": (
            "В боковом меню — «Табло». Там ваша позиция среди операторов, "
            "сумма месяца, план и достижения. Обновляется в реальном времени."
        ),
        "a_uz": (
            "Yon menyuda «Tablo». U yerda operatorlar orasidagi o'rningiz, "
            "oylik summa, reja va yutuqlaringiz. Real vaqtda yangilanadi."
        ),
    },
    {
        "id": "calculator",
        "q_ru": "Как посчитать рассрочку клиенту?",
        "q_uz": "Mijozga bo'lib to'lashni qanday hisoblash mumkin?",
        "a_ru": (
            "Откройте «Калькулятор» в боковом меню — введите цену телефона, "
            "выберите срок и первоначальный взнос, получите ежемесячный платёж. "
            "Тарифы настроены менеджером, всегда актуальны."
        ),
        "a_uz": (
            "Yon menyudan «Kalkulyator»'ni oching — telefon narxini kiriting, "
            "muddat va boshlang'ich to'lovni tanlang, oylik to'lovni oling. "
            "Tariflar menejer tomonidan sozlangan, doim yangi."
        ),
    },
    {
        "id": "marketing_copy",
        "q_ru": "Как использовать готовые тексты для WhatsApp/Telegram?",
        "q_uz": "WhatsApp/Telegram uchun tayyor matnlarni qanday ishlatish mumkin?",
        "a_ru": (
            "В карточке лида — блок «Marketing» с готовыми шаблонами. Нажмите "
            "«Копировать» и вставьте в чат клиенту. Тексты обновляет менеджер."
        ),
        "a_uz": (
            "Lid kartochkasida «Marketing» bloki bor — tayyor shablonlar. "
            "«Nusxa olish»'ni bosib mijoz chatiga qo'ying. Matnlarni menejer yangilaydi."
        ),
    },
    {
        "id": "how_use_partners",
        "q_ru": "Что такое «партнёр» на продаже и когда его указывать?",
        "q_uz": "Sotuvda «partner» nima va qachon ko'rsatish kerak?",
        "a_ru": (
            "Партнёр — это внешний менеджер (например с рынка), приведший "
            "клиента. Указывайте на форме продажи в блоке «Partner» — сумма "
            "разделится согласно проценту, настроенному в справочнике партнёров."
        ),
        "a_uz": (
            "Partner — bu mijozni olib kelgan tashqi menejer (masalan, bozordan). "
            "Sotuv formasidagi «Partner» blokida ko'rsating — summa partner "
            "spravochnigidagi foizga qarab bo'linadi."
        ),
    },
    {
        "id": "bulk_upload",
        "q_ru": "Можно ли загрузить много продаж сразу через Excel?",
        "q_uz": "Ko'p sotuvni bir vaqtda Excel orqali yuklash mumkinmi?",
        "a_ru": (
            "Массовая загрузка — только у менеджера (раздел «Продажи → Import»). "
            "Оператор создаёт продажи по одной; менеджер потом может импортировать "
            "старые данные пачкой."
        ),
        "a_uz": (
            "Ommaviy yuklash faqat menejerda («Sotuvlar → Import» bo'limi). "
            "Operator sotuvlarni bittalab yaratadi; menejer keyinroq eski "
            "ma'lumotlarni to'plam bilan import qila oladi."
        ),
    },
]
