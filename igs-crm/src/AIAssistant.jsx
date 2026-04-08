// src/AIAssistant.jsx — Дастан, AI-ассистент IGS Outdoor CRM
// claude-haiku-4-5-20251001 · tool_use · toggle FAB · Firebase logging
import React, { useState, useRef, useEffect, useCallback } from "react";
import { dbSet, dbGet } from "./firebase.js";

const MODEL = "claude-haiku-4-5-20251001";

const T = {
  bg:      "#09090b",
  card:    "#111113",
  surface: "#16161a",
  border:  "rgba(255,255,255,0.07)",
  gold:    "#b8965a",
  goldBr:  "#d4ac6a",
  goldBg:  "rgba(184,150,90,0.10)",
  goldRim: "rgba(184,150,90,0.22)",
  text:    "#eae6e1",
  mid:     "rgba(255,255,255,0.50)",
  dim:     "rgba(255,255,255,0.28)",
  red:     "#c45454",
  green:   "#4caf78",
};

// ─── calcItem (зеркало CRM) ──────────────────────────────────────────────────
function calcItem(item, products) {
  const p = products.find(x => x.id === item.productId);
  if (!p) return 0;
  const w = item.width || 0, d = item.depth || 0, qty = item.quantity || 1;
  let t = w * d * p.price;
  (item.selectedOptions || []).forEach(oid => {
    const o = p.options?.find(o => o.id === oid);
    if (!o) return;
    if (o.flat) t += o.price;
    else if (oid === "screen") t += o.price * (w + d) * 2 * 3;
    else t += o.price * w * d;
  });
  return t * qty;
}

const fmtN = n => new Intl.NumberFormat("ru-RU").format(Math.round(n));

// ─── Системный промпт ────────────────────────────────────────────────────────
function buildSystemPrompt(products, clients) {
  const prodList = products.map(p => ({
    id: p.id, name: p.name, price: p.price,
    options: (p.options || []).map(o => ({ id: o.id, label: o.label, price: o.price, flat: !!o.flat })),
  }));

  // Компактный индекс клиентов для промпта (не раздувает токены)
  const clientIndex = (clients || []).slice(0, 80)
    .map(c => `${c.name}|${c.id}|${c.status}|${c.phone || ""}`)
    .join("\n");

  return `Ты — Дастан, AI-ассистент CRM системы компании IGS Outdoor (Алматы, Казахстан).

ХАРАКТЕР: умная, тёплая, деловая. Знаешь продукты назубок, быстро считаешь. Общаешься на «ты», дружелюбно, иногда с эмодзи.

═══════════════════════════════════════
КАТАЛОГ IGS OUTDOOR — ПОЛНЫЕ ЗНАНИЯ
═══════════════════════════════════════

━━━ БИОКЛИМАТИЧЕСКАЯ ПЕРГОЛА (ПОВОРОТНАЯ) — id: greenawn ━━━
Цена: 250 000 ₸/м²
Описание: Алюминиевая пергола с моторизированными поворотными ламелями. При закрытии ламели образуют герметичную крышу, при открытии — максимум света и вентиляции. Встроенный водосток через колонны. Работает в любую погоду.

Технические характеристики:
• Профиль: Алюминий 6063-T6, порошковая окраска RAL
• Колонны: 164×164×2.7 мм усиленные
• Ламели: 250×53 мм Pro / 250×46 мм Basic — поворот 0°–110°
• Балка: 164×260 мм, встроенный сливной лоток по периметру, пролёт до 8 м
• Привод: Электродвигатель IP65, функция TANDEM для больших площадей
• Ветроустойчивость: до 120 км/ч
• Снеговая нагрузка: до 100 кг/м²
• Водосток: ламели → балка → колонны → дренаж
• Подсветка: LED / RGB по периметру с диммером
• Монтаж: отдельностоящий / настенный / подвесной / интегрированный
• Цвет: RAL 9016 (белый) / RAL 7016 (антрацит) / любой RAL
• Макс. размер: 7×8 м на 4 опорах (TANDEM — без ограничений)
• Гарантия покрытия: 10 лет

Преимущества:
✓ Полная герметичность при закрытых ламелях
✓ Автоматический дренаж без видимых труб
✓ Работает при температуре −30°C…+60°C
✓ Управление: пульт ДУ / смартфон / датчики дождя и ветра
✓ Интегрируется с умным домом (KNX, Somfy, HomeKit)

Доступные опции:
• LED подсветка (+12 000 ₸/м²)
• ИК обогреватель (+45 000 ₸, фиксированно)
• Zip-шторы по периметру (+75 000 ₸/м² по периметру)

━━━ БИОКЛИМАТИЧЕСКАЯ ПЕРГОЛА PREMIUM — id: igs_premium ━━━
Цена: 280 000 ₸/м²
Описание: Улучшенная версия с поворотно-сдвижными ламелями. 5 конфигураций монтажа, гибкие размеры до 7×7.25 м.

Технические характеристики:
• Колонны: 164×164 мм с интегрированным водоотводом
• Ламели: поворотные + сдвижные (двойная система)
• Балка: 164×260 мм, интегрированный лоток
• Ветроустойчивость: до 100 км/ч
• 5 конфигураций: настенная / потолочная / двойная / отдельностоящая / на крыше
• Макс. размер: 7×7.25 м

Опции: LED (+12 000 ₸/м²), ИК обогреватель (+45 000 ₸), утеплённые ламели (+28 000 ₸/м²)

━━━ ТЕНТОВАЯ ПЕРГОЛА — id: toscana ━━━
Цена: 130 000 ₸/м²
Описание: Пергола с выдвижным влагостойким тентом на алюминиевом каркасе. 100% защита от дождя при закрытии, максимум воздуха при открытии. Один модуль 4.5 м, комбинируются без ограничений.

Технические характеристики:
• Ткань: 850 г/м², 100% PES, водонепроницаемое покрытие, UPF 50+, UV Protect 80
• Вылет: до 13.5 м (модули по 4.5 м, комбинируются)
• Ветроустойчивость (открытое положение): 50–70 км/ч
• Водонепроницаемость (закрытое): 100%
• Каркас: алюминиевый сплав, порошковая окраска
• Монтаж: 6 типов — настенный / подвесной / отдельностоящий / беседка / консольный / интегрированный
• Управление: электромотор + пульт ДУ (в комплекте)
• Цвет каркаса: любой RAL
• Ткань: 200+ расцветок
• Гарантия ткани: 5 лет

Преимущества:
✓ Самый большой вылет в классе — до 13.5 м
✓ Быстрое открытие/закрытие — 60 секунд
✓ Интегрированный LED-профиль
✓ Автоматическое закрытие при ветре (с датчиком)
✓ Возможность установки боковых zip-штор

Доступные опции:
• LED подсветка (+10 000 ₸/м²)
• Моторизация (+18 000 ₸, фиксированно — если не включена)

━━━ ТЕНТОВАЯ ПЕРГОЛА MAXI — id: toscana_maxi ━━━
Цена: 230 000 ₸/м²
Описание: Тентовая пергола Maxi — усиленная версия с увеличенным вылетом. Ткань 850 г/м², UPF 50+, 100% защита от дождя. Электромотор + пульт ДУ в комплекте. Любой RAL.
Опции: LED (+10 000 ₸/м²), моторизация (+18 000 ₸)

━━━ ТЕНТОВАЯ ПЕРГОЛА GUHHER — id: guhher ━━━
Цена: 110 000 ₸/м²  
Описание: Экономичная тентовая пергола. Акриловая ткань, быстрый монтаж.
Опции: LED (+10 000 ₸/м²), моторизация (+18 000 ₸)

━━━ РАЗДВИЖНОЕ ОСТЕКЛЕНИЕ — id: sliding ━━━
Цена: 100 000 ₸/м²
S500 (тёплая серия): стеклопакет 20 мм (4+12+4 закалённый)
S200/S150/S100 (холодная): закалённое 10 мм
3–12 панелей, высота до 3.1 м, ролики 120 кг/шт, 4 контура уплотнения
Опции: двойное остекление (+15 000 ₸/м²)

━━━ ГИЛЬОТИННОЕ ОСТЕКЛЕНИЕ — id: guillotine ━━━
Цена: 200 000 ₸/м²
W500: стеклопакет 20 мм / W600: 28 мм / W700: 28 мм с терморазрывом −10…+40°C
Без вертикальных стоек, цепной подъём, автоматика
Опции: автоматизация (+30 000 ₸, фиксированно)

━━━ ZIP-ШТОРЫ — id: zip ━━━
Цена: 75 000 ₸/м²
ZIP-фиксация по всей высоте — нет парусения. Высота до 4 м.
Ткань: акриловая / затемняющая / ПВХ / москитная сетка
Опции: моторизация (+15 000 ₸), москитная сетка (+5 000 ₸/м²)

━━━ МАРКИЗЫ — id: marquise ━━━
Цена: 100 000 ₸/м²
Алюминий 6063-T5, кассетная. Ткань 100% акрил 300 г/м², водостойкость 360 мм.
Ширина до 7 м, вылет до 3.5 м, угол 15°–25°
Опции: моторизация (+12 000 ₸)

━━━ ТЕРРАСНАЯ ДОСКА PANNO — id: panno ━━━
Цена: 23 000 ₸/м²
Описание: ДПК премиум класса. Не гниёт, не красится, гарантия 10 лет. Ширина 140–150 мм, толщина 25 мм. Скрытые крепления.
Оттенки: серый, коричневый, венге, натуральное дерево
Опции: скрытые крепления (+800 ₸/м²), торцевая планка (+1 200 ₸/м²), лаги + подложка (+3 500 ₸/м²)

━━━ ТЕРРАСНАЯ ДОСКА BILANCIO — id: bilancio ━━━
Цена: 16 000 ₸/м²
Описание: ДПК стандарт. Оптимальная цена/качество. Гарантия 7 лет. Ширина 140–150 мм, толщина 22 мм. Скрытые крепления.
Оттенки: серый, коричневый, натуральное дерево
Опции: скрытые крепления (+800 ₸/м²), торцевая планка (+1 200 ₸/м²), лаги + подложка (+3 500 ₸/м²)

━━━ ПЕРИЛА — id: railings ━━━
Цена: 100 000 ₸/м²
Алюминий, заполнение стекло 10 мм / нержавейка, любой RAL, гарантия 1 год
Опции: стекло (+15 000 ₸/м²), нержавейка (+8 000 ₸/м²), LED (+10 000 ₸/м²)

═══════════════════════════════════════
ТЕКУЩИЕ ЦЕНЫ (актуальные из CRM):
${prodList.map(p => `${p.id}: ${new Intl.NumberFormat("ru-RU").format(p.price)} ₸/м²`).join("\n")}
═══════════════════════════════════════

ЦВЕТА КАРКАСА (ВАЖНО):
Все перголы и системы IGS Outdoor выпускаются в 2 стандартных цветах:
• RAL 7016 — Антрацит (тёмно-серый, самый популярный)
• RAL 9016 — Белый (белоснежный)
Под заказ — любой цвет RAL (согласуется отдельно, может влиять на срок).
Если клиент не указал цвет — обязательно уточни: антрацит или белый?

УСЛОВИЯ РАБОТЫ:
• Предоплата: 70% при заключении договора
• Остаток: 30% перед монтажом
• Срок производства: 45 рабочих дней
• Гарантия конструкции: 1 год
• Бесплатный замер на объекте
• Монтаж включён в стоимость (под ключ)

КЛИЕНТЫ В CRM (имя|id|статус|телефон):
${clientIndex || "(нет клиентов)"}

Когда пользователь называет имя клиента — сначала найди его через search_clients, потом работай с ним.
При open_kp ВСЕГДА передавай clientId если клиент найден.

ФОРМУЛА РАСЧЁТА:
• Позиция = ширина × глубина × цена/м² × количество
• Опция flat:true = фиксированная сумма (не × площадь)
• Zip по периметру (screen) = (ширина+глубина) × 2 × 3м × 75 000 ₸/м²

ИНСТРУМЕНТЫ TRELLO:
• get_trello_lists — получить список колонок доски
• create_trello_card(name, desc, list_name, due) — создать карточку в СУЩЕСТВУЮЩИЙ список
  ВАЖНО: НИКОГДА не создавай новые списки! Только вписывай в имеющиеся.
  Существующие списки доски:
  - "Новый список" — новые необработанные заявки
  - "Считаем / В работе" — считаем КП, в работе
  - "Выезд на замер" — назначен замер
  - "КП отправлено" — КП отправлено клиенту
  - "Ждем ответ (Ожидание)" — ждём решения клиента
  - "Договор / Аванс" — договор подписан, аванс получен
  - "Встреча в шоуруме" — клиент едет в шоурум
  - "Ожидает свой заказ" — заказ в производстве
  - "Отложенные" — клиент отложил

  Маппинг статуса CRM → Trello список:
  lead/negotiation → "Новый список"
  kp_sent → "КП отправлено"
  measure → "Выезд на замер"
  install → "Ожидает свой заказ"
  closed → "Договор / Аванс"

ИНСТРУМЕНТЫ УПРАВЛЕНИЯ КЛИЕНТАМИ:
• update_client — изменить имя, телефон, адрес, источник, заметки клиента
• change_status — поменять статус: lead→negotiation→kp_sent→measure→install→closed/lost
• add_task — добавить задачу клиенту (call/measure/start/order), можно с датой и временем

ИНСТРУМЕНТЫ FIREBASE (используй для актуальных данных):
• get_firebase_data — читает любую ноду: clients, bot_leads, meetings, prices, kp_templates

ТВОИ ВОЗМОЖНОСТИ — ПОЛНЫЙ СПИСОК:

📋 КП И РАСЧЁТЫ:
• calculate_kp — посчитать КП (вызывай перед open_kp)
• open_kp — открыть КП в калькуляторе CRM
• Умеешь считать надбавку (_priceMultiplier) за нестандартный размер

👥 КЛИЕНТЫ:
• search_clients — найти клиента по имени или телефону
• add_client — создать нового клиента
• update_client — изменить имя, телефон, адрес, источник, заметки
• add_client_note — добавить заметку к клиенту (не затирает старые)
• change_status — поменять статус (lead→negotiation→kp_sent→measure→install→closed/lost)
• add_task — добавить задачу (call/measure/start/order) с датой и временем
• go_to_client — открыть карточку клиента в CRM
• navigate — перейти на страницу CRM (dashboard/clients/calculator/meetings/bot_leads/prices)

💰 ЦЕНЫ:
• set_price — изменить цену любого продукта (сохраняется в Firebase, применяется сразу)
  Пример: "поставь цену на зип 80 тысяч" → set_price(productId:"zip", price:80000)

📊 АНАЛИТИКА:
• get_stats — статистика: клиенты по статусам, сумма КП, активные задачи
• get_firebase_data — читает любую ноду Firebase (clients/bot_leads/meetings/prices/kp_templates)

📋 TRELLO:
• get_trello_lists — список колонок доски
• create_trello_card — создать карточку

📸 ФОТО:
• Пользователь может прислать фото — ты видишь их и анализируешь
• Применения: анализ объекта для подбора продукта, оценка размеров, проверка монтажа
• Когда видишь фото — описывай что на нём и предлагай подходящие продукты IGS

ПРАВИЛА:
• Отвечай только на русском
• Не хватает размеров — спроси
• Перед open_kp всегда делай calculate_kp
• Ответы краткие и по делу
• При упоминании имени клиента — сначала search_clients, потом работай с clientId
• Если создаёшь КП — вызови open_kp чтобы открыть его
• При изменении цены — подтверди что именно меняешь и на сколько`;
}

// ─── Инструменты ─────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "search_clients",
    description: "Поиск клиентов по имени или телефону",
    input_schema: { type:"object", properties:{ query:{type:"string"} }, required:["query"] },
  },
  {
    name: "add_client",
    description: "Создать нового клиента в CRM",
    input_schema: {
      type:"object",
      properties:{ name:{type:"string"}, phone:{type:"string"}, address:{type:"string"}, source:{type:"string"} },
      required:["name"],
    },
  },
  {
    name: "calculate_kp",
    description: "Рассчитать стоимость КП — вызывай перед open_kp",
    input_schema: {
      type:"object",
      properties:{
        items:{
          type:"array",
          items:{
            type:"object",
            properties:{
              productId:{type:"string"},
              width:{type:"number"},
              depth:{type:"number"},
              quantity:{type:"number"},
              selectedOptions:{type:"array",items:{type:"string"}},
            },
            required:["productId","width","depth"],
          },
        },
        discount:{type:"number"},
      },
      required:["items"],
    },
  },
  {
    name: "open_kp",
    description: "Открыть КП в калькуляторе CRM (всегда после calculate_kp)",
    input_schema: {
      type:"object",
      properties:{
        clientId:{type:"string"},
        clientName:{type:"string"},
        clientPhone:{type:"string"},
        items:{type:"array",items:{type:"object",properties:{productId:{type:"string"},width:{type:"number"},depth:{type:"number"},quantity:{type:"number"},selectedOptions:{type:"array",items:{type:"string"}}}}},
        discount:{type:"number"},
      },
      required:["items"],
    },
  },
  {
    name: "navigate",
    description: "Перейти на страницу CRM",
    input_schema: {
      type:"object",
      properties:{ page:{type:"string",enum:["dashboard","clients","calculator","meetings","bot_leads","glass","prices","kp_templates"]} },
      required:["page"],
    },
  },
  {
    name: "go_to_client",
    description: "Открыть карточку клиента",
    input_schema: { type:"object", properties:{ clientId:{type:"string"} }, required:["clientId"] },
  },
  {
    name: "update_client",
    description: "Обновить данные существующего клиента (имя, телефон, адрес, источник, заметки)",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "ID клиента" },
        name:     { type: "string" },
        phone:    { type: "string" },
        address:  { type: "string" },
        source:   { type: "string" },
        notes:    { type: "string" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "change_status",
    description: "Изменить статус клиента в CRM",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string" },
        status: {
          type: "string",
          enum: ["lead","negotiation","kp_sent","measure","install","closed","lost"],
          description: "lead=Лид, negotiation=Переговоры, kp_sent=КП отправлен, measure=Замер, install=Монтаж, closed=Закрыт, lost=Потерян",
        },
      },
      required: ["clientId", "status"],
    },
  },
  {
    name: "add_task",
    description: "Добавить задачу клиенту",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string" },
        type:     { type: "string", enum: ["call","measure","start","order"], description: "call=Созвон, measure=Замер, start=Запуск работ, order=Заказать" },
        text:     { type: "string", description: "Текст задачи" },
        date:     { type: "string", description: "Дата YYYY-MM-DD (опционально)" },
        time:     { type: "string", description: "Время HH:MM (опционально)" },
      },
      required: ["clientId", "type", "text"],
    },
  },
  {
    name: "create_trello_card",
    description: "Создать карточку в Trello в СУЩЕСТВУЮЩИЙ список. НИКОГДА не создавай новые списки. Используй только имеющиеся: 'Новый список', 'Считаем / В работе', 'Выезд на замер', 'КП отправлено', 'Ждем ответ (Ожидание)', 'Договор / Аванс', 'Встреча в шоуруме', 'Ожидает свой заказ', 'Отложенные'. Выбирай список по контексту.",
    input_schema: {
      type: "object",
      properties: {
        name:      { type: "string", description: "Название карточки (обычно имя клиента + объект)" },
        desc:      { type: "string", description: "Описание: размеры, продукт, телефон, детали" },
        list_name: { type: "string", description: "ТОЧНОЕ название существующего списка. Варианты: 'Новый список' | 'Считаем / В работе' | 'Выезд на замер' | 'КП отправлено' | 'Ждем ответ (Ожидание)' | 'Договор / Аванс' | 'Встреча в шоуруме' | 'Ожидает свой заказ' | 'Отложенные'" },
        due:       { type: "string", description: "Срок ISO 8601, например 2025-05-01" },
      },
      required: ["name", "list_name"],
    },
  },
  {
    name: "get_trello_lists",
    description: "Получить список колонок (списков) на Trello доске. Вызывай перед create_trello_card если не знаешь названия списков.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_firebase_data",
    description: "Читает данные из Firebase Realtime Database. Используй для получения актуальных клиентов, лидов, встреч, цен, шаблонов КП.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "clients | bot_leads | meetings | prices | kp_templates | kp_counter | custom_products" },
        limit: { type: "number", description: "Макс записей (по умолчанию 20, макс 50)" },
      },
      required: ["path"],
    },
  },
  {
    name: "set_price",
    description: "Изменить цену продукта в CRM. Цена сохраняется в Firebase и применяется во всех новых КП.",
    input_schema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "ID продукта: greenawn | igs_premium | toscana | toscana_maxi | guhher | sliding | guillotine | zip | marquise | railings | panno | bilancio" },
        price: { type: "number", description: "Новая цена в тенге за м²" },
      },
      required: ["productId", "price"],
    },
  },
  {
    name: "add_client_note",
    description: "Добавить заметку к клиенту (дополняет существующие, не перезаписывает)",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string" },
        note: { type: "string", description: "Текст заметки" },
      },
      required: ["clientId", "note"],
    },
  },
  {
    name: "get_stats",
    description: "Получить статистику CRM: количество клиентов по статусам, сумма КП, активные задачи",
    input_schema: { type: "object", properties: {} },
  },
];

const PAGE_LABELS = {
  dashboard:"Главная", clients:"Клиенты", calculator:"Калькулятор КП",
  meetings:"Встречи", bot_leads:"Лиды бота", glass:"Расчёт остекления",
  prices:"Редактор цен", kp_templates:"Шаблоны КП",
};

// ─── Сохранение сессии в Firebase ────────────────────────────────────────────
async function saveAiSession(sessionId, msgs, metadata = {}) {
  try {
    await dbSet(`ai_chats/${sessionId}`, {
      id: sessionId,
      updatedAt: new Date().toISOString(),
      messageCount: msgs.length,
      messages: msgs.map(m => ({
        role: m.k === "user" ? "user" : "ai",
        text: m.text || (m.k === "calc" ? `[Расчёт КП: ${fmtN(m.data?.total)} ₸]` : `[${m.k}]`),
        ts: m.ts || Date.now(),
        type: m.k,
      })),
      ...metadata,
    });
  } catch (e) {
    console.warn("AI session save error:", e);
  }
}

// ─── Десктопные уведомления ──────────────────────────────────────────────────
function sendDesktopNotif(title, body) {
  if (typeof window === "undefined") return;
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    try {
      new Notification(title, {
        body,
        icon: "/favicon.png",
        badge: "/favicon.png",
        tag: "dastan-" + Date.now(),
      });
    } catch (_) {}
  } else if (Notification.permission === "default") {
    Notification.requestPermission().then(perm => {
      if (perm === "granted") {
        try { new Notification(title, { body, icon: "/favicon.png" }); } catch (_) {}
      }
    });
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
export default function AIAssistant({
  clients, products, onAddClient, onUpdateClient, onStartKP, onGoToClient, onGoToPage, isMobile,
}) {
  const [open, setOpen]       = useState(false);
  const [history, setHistory] = useState([]);
  const [msgs, setMsgs]       = useState([]);
  const [input, setInput]     = useState("");
  const [busy, setBusy]       = useState(false);
  const [unread, setUnread]   = useState(0);
  const [kbH, setKbH]        = useState(0);
  const [attachedImages, setAttachedImages] = useState([]); // [{base64, mediaType, preview}]
  const fileInputRef = useRef(null);

  // Уникальный ID сессии — создаётся один раз при монтировании
  const sessionId = useRef("ai_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7));
  const sessionStart = useRef(new Date().toISOString());

  const msgAreaRef = useRef(null);
  const inputRef   = useRef(null);

  // ── Keyboard tracking (Visual Viewport API) ───────────────────────────────
  useEffect(() => {
    if (!isMobile) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const diff = window.innerHeight - vv.height - vv.offsetTop;
      setKbH(diff > 80 ? diff : 0);
    };
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);
    return () => { vv.removeEventListener("resize", onResize); vv.removeEventListener("scroll", onResize); };
  }, [isMobile]);

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    const el = msgAreaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, busy]);

  // ── Focus on open ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (open) {
      setUnread(0);
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [open]);

  // ── Запрос разрешения на уведомления при первом открытии ────────────────
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      // Запрашиваем только после первого взаимодействия — не сразу
      const handler = () => {
        Notification.requestPermission();
        window.removeEventListener("click", handler);
      };
      window.addEventListener("click", handler, { once: true });
    }
  }, []);

  // ── Toggle ────────────────────────────────────────────────────────────────
  const toggle = () => setOpen(v => !v);

  // ── Execute tool ──────────────────────────────────────────────────────────
  const execTool = useCallback((name, inp) => {
    switch (name) {

      case "search_clients": {
        const raw    = (inp.query || "").trim();
        const digits = raw.replace(/\D/g, "");
        const alpha  = raw.replace(/[\d\s\-\+\(\)]/g, "");
        const isPhone = digits.length >= 5 && alpha.length <= 2;
        const q = raw.toLowerCase();
        // Поиск по всем словам запроса (напр. "александр дели" найдёт "Александр Делишин")
        const words = q.split(/\s+/).filter(Boolean);
        const found = clients.filter(c => {
          if (isPhone) return (c.phone || "").replace(/\D/g, "").includes(digits);
          const name = (c.name || "").toLowerCase();
          return words.every(w => name.includes(w)) || name.includes(q);
        }).slice(0, 8);
        if (!found.length) {
          // Нечёткий фоллбэк — хотя бы одно слово
          const fuzzy = clients.filter(c => {
            const name = (c.name || "").toLowerCase();
            return words.some(w => w.length >= 3 && name.includes(w));
          }).slice(0, 5);
          return {
            found: fuzzy.length,
            clients: fuzzy.map(c => ({
              id: c.id, name: c.name, phone: c.phone || "",
              address: c.address || "", status: c.status,
              kps: (c.kps || []).length,
            })),
            hint: "Точного совпадения нет, показаны похожие",
          };
        }
        return {
          found: found.length,
          clients: found.map(c => ({
            id: c.id, name: c.name, phone: c.phone || "",
            address: c.address || "", status: c.status,
            kps: (c.kps || []).length,
          })),
        };
      }

      case "add_client": {
        const c = onAddClient({
          name: inp.name, phone: inp.phone || "",
          address: inp.address || "", source: inp.source || "Другое",
        });
        return { ok: true, clientId: c?.id, name: inp.name };
      }

      case "calculate_kp": {
        const items = (inp.items || []).map(i => ({
          ...i, quantity: i.quantity || 1, selectedOptions: i.selectedOptions || [],
        }));
        const disc = inp.discount || 0;
        const sub  = items.reduce((s, i) => s + calcItem(i, products), 0);
        const tot  = Math.round(sub * (1 - disc / 100));
        const lines = items.map(item => {
          const p    = products.find(x => x.id === item.productId);
          const opts = (item.selectedOptions || [])
            .map(oid => p?.options?.find(o => o.id === oid)?.label)
            .filter(Boolean).join(", ");
          return {
            productId: item.productId,
            name:  p?.name || item.productId,
            width: item.width, depth: item.depth,
            area:  +(item.width * item.depth).toFixed(2),
            qty:   item.quantity || 1,
            options: opts,
            sum:   Math.round(calcItem(item, products)),
          };
        });
        return {
          lines, discount: disc,
          subtotal: Math.round(sub), total: tot,
          prepay: Math.round(tot * 0.7),
          rest:   Math.round(tot * 0.3),
        };
      }

      case "open_kp": {
        const items = (inp.items || []).map(i => ({
          productId: i.productId, width: i.width || 0, depth: i.depth || 0,
          quantity: i.quantity || 1, selectedOptions: i.selectedOptions || [],
        }));
        const disc = inp.discount || 0;
        let cid = inp.clientId || null;

        if (!cid && inp.clientName) {
          const qn = inp.clientName.toLowerCase().trim();
          // Точное совпадение
          let ex = clients.find(c => c.name?.toLowerCase() === qn);
          // Частичное совпадение
          if (!ex) ex = clients.find(c => c.name?.toLowerCase().includes(qn) || qn.includes(c.name?.toLowerCase() || "xxx"));
          // По телефону
          if (!ex && inp.clientPhone) ex = clients.find(c => c.phone?.replace(/\D/g,"") === inp.clientPhone.replace(/\D/g,""));
          if (ex) { cid = ex.id; }
          else {
            const nc = onAddClient({ name: inp.clientName, phone: inp.clientPhone || "", source: "Другое" });
            cid = nc?.id || null;
          }
        }

        setTimeout(() => { onStartKP(cid, { items, discount: disc }); setOpen(false); }, 350);
        return { ok: true };
      }

      case "navigate": {
        setTimeout(() => { onGoToPage(inp.page); setOpen(false); }, 280);
        return { ok: true, label: PAGE_LABELS[inp.page] || inp.page };
      }

      case "go_to_client": {
        setTimeout(() => { onGoToClient(inp.clientId); setOpen(false); }, 280);
        return { ok: true };
      }

      case "update_client": {
        const { clientId, ...fields } = inp;
        const client = clients.find(c => c.id === clientId);
        if (!client) return { error: `Клиент ${clientId} не найден` };
        const update = {};
        if (fields.name    !== undefined) update.name    = fields.name;
        if (fields.phone   !== undefined) update.phone   = fields.phone;
        if (fields.address !== undefined) update.address = fields.address;
        if (fields.source  !== undefined) update.source  = fields.source;
        if (fields.notes   !== undefined) update.notes   = fields.notes;
        onUpdateClient(clientId, update);
        sendDesktopNotif("✏️ Клиент обновлён", `${client.name}: данные изменены`);
        return { ok: true, clientId, updated: Object.keys(update) };
      }

      case "change_status": {
        const client = clients.find(c => c.id === inp.clientId);
        if (!client) return { error: `Клиент ${inp.clientId} не найден` };
        const STATUS_LABELS = { lead:"Лид", negotiation:"Переговоры", kp_sent:"КП отправлен", measure:"Замер", install:"Монтаж", closed:"Закрыт ✓", lost:"Потерян" };
        onUpdateClient(inp.clientId, { status: inp.status });
        sendDesktopNotif("🔄 Статус изменён", `${client.name} → ${STATUS_LABELS[inp.status] || inp.status}`);
        return { ok: true, clientId: inp.clientId, name: client.name, newStatus: inp.status };
      }

      case "add_task": {
        const client = clients.find(c => c.id === inp.clientId);
        if (!client) return { error: `Клиент ${inp.clientId} не найден` };
        const TASK_ICONS = { call:"📞", measure:"📐", start:"🏗️", order:"📦" };
        const TASK_LABELS = { call:"Созвон", measure:"Замер", start:"Запуск работ", order:"Заказать" };
        const task = {
          id: Date.now().toString(),
          type: inp.type,
          text: inp.text,
          date: inp.date || "",
          time: inp.time || "",
          done: false,
          createdAt: new Date().toISOString(),
        };
        const existingTasks = client.tasks || [];
        onUpdateClient(inp.clientId, { tasks: [task, ...existingTasks] });
        sendDesktopNotif(
          `${TASK_ICONS[inp.type]} Задача добавлена`,
          `${client.name}: ${TASK_LABELS[inp.type]}${inp.date ? " · " + inp.date : ""}`
        );
        return { ok: true, taskId: task.id, clientId: inp.clientId, clientName: client.name, type: inp.type, text: inp.text };
      }

      case "get_firebase_data": {
        // Handled as async in the agentic loop via execToolAsync
        return { deferred: true, path: inp.path, limit: inp.limit || 20 };
      }

      case "create_trello_card":
      case "get_trello_lists": {
        // Handled as async in execToolAsync
        return { deferred: true, trello: name };
      }

      case "add_client_note": {
        const client = clients.find(c => c.id === inp.clientId);
        if (!client) return { error: `Клиент ${inp.clientId} не найден` };
        const ts = new Date().toLocaleString("ru-RU", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
        const newNote = `[${ts}] ${inp.note}`;
        const existingNotes = client.notes || "";
        onUpdateClient(inp.clientId, { notes: existingNotes ? `${existingNotes}
${newNote}` : newNote });
        return { ok: true, clientName: client.name };
      }

      case "get_stats": {
        const statusCounts = {};
        let totalKP = 0, totalKPSum = 0, activeTasks = 0;
        clients.forEach(c => {
          statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
          totalKP += (c.kps || []).length;
          totalKPSum += (c.kps || []).reduce((s, k) => s + (k.total || 0), 0);
          activeTasks += (c.tasks || []).filter(t => !t.done).length;
        });
        return { totalClients: clients.length, statusCounts, totalKP, totalKPSum: Math.round(totalKPSum), activeTasks };
      }

      case "set_price": {
        // Handled async in execToolAsync
        return { deferred: true, setPriceAsync: true };
      }

      default: return { error: `Неизвестный инструмент: ${name}` };
    }
  }, [clients, products, onAddClient, onUpdateClient, onStartKP, onGoToClient, onGoToPage]);

  // ── Async tool executor (Firebase + Trello) ─────────────────────────────
  const execToolAsync = useCallback(async (name, inp) => {
    const ASYNC_TOOLS = ["get_firebase_data", "get_trello_lists", "create_trello_card", "set_price"];
    if (!ASYNC_TOOLS.includes(name)) return execTool(name, inp);

    // ── Firebase ─────────────────────────────────────────────────────────
    if (name === "get_firebase_data") {
    const path  = inp.path || "clients";
    const limit = Math.min(inp.limit || 20, 50);

    // Whitelist безопасных путей
    const ALLOWED = ["clients","bot_leads","meetings","prices","kp_templates","kp_counter","custom_products"];
    const basePath = path.split("/")[0];
    if (!ALLOWED.includes(basePath)) {
      return { error: `Путь '${path}' недоступен. Доступны: ${ALLOWED.join(", ")}` };
    }

    try {
      const raw = await dbGet(path, null);
      if (raw === null) return { found: 0, data: null, message: `Нода '${path}' пуста или не существует` };

      // Если объект — конвертируем в массив и обрезаем
      if (typeof raw === "object" && !Array.isArray(raw)) {
        const arr = Object.values(raw).filter(Boolean);
        const sliced = arr.slice(0, limit);

        // Специальная обработка clients — возвращаем краткую сводку
        if (basePath === "clients") {
          const summary = sliced.map(c => ({
            id: c.id, name: c.name, phone: c.phone || "",
            status: c.status, address: c.address || "",
            kps: (c.kps || []).length,
            tasks: (c.tasks || []).filter(t => !t.done).length,
            updatedAt: c.updatedAt,
          }));
          return { found: arr.length, shown: sliced.length, data: summary };
        }

        // bot_leads — краткая сводка
        if (basePath === "bot_leads") {
          const summary = sliced.map(l => ({
            id: l.id, name: l.name, phone: l.phone,
            productType: l.productType || l.product_type,
            status: l.status, notes: l.notes,
            createdAt: l.createdAt,
          }));
          return { found: arr.length, shown: sliced.length, data: summary };
        }

        return { found: arr.length, shown: sliced.length, data: sliced };
      }

      // Scalar (kp_counter, etc.)
      return { data: raw };
    } catch (e) {
      return { error: `Ошибка чтения '${path}': ${e.message}` };
    }
  }

  // set_price — изменяет цену в Firebase и применяет в UI
  if (name === "set_price") {
    const PRODUCT_NAMES_RU = {
      greenawn:"Биоклим. (Поворот.)", igs_premium:"Биоклим. Premium", toscana:"Тент. Toscana",
      toscana_maxi:"Тент. Maxi", guhher:"Тент. Guhher", sliding:"Раздвижное", guillotine:"Гильотина",
      zip:"Zip-шторы", marquise:"Маркиза", railings:"Перила", panno:"Panno", bilancio:"Bilancio",
    };
    const { productId, price } = inp;
    if (!productId || !price || price < 100) return { error: "Неверные параметры" };
    try {
      const { dbSet, dbGet } = await import("./firebase.js");
      const prices = await dbGet("prices") || {};
      const updated = { ...(prices[productId] || {}), price };
      await dbSet(`prices/${productId}`, updated);
      // Диспатч события чтобы CRM обновил цены без перезагрузки
      window.dispatchEvent(new CustomEvent("prices-updated"));
      sendDesktopNotif("💰 Цена обновлена", `${PRODUCT_NAMES_RU[productId] || productId}: ${new Intl.NumberFormat("ru-RU").format(price)} ₸/м²`);
      return { ok: true, productId, price, name: PRODUCT_NAMES_RU[productId] };
    } catch(e) { return { error: e.message }; }
  }

  // Trello tools — внутри execToolAsync
  if (name === "get_trello_lists") {
    try {
      const r = await fetch("/api/trello?action=board");
      const data = await r.json();
      if (!r.ok) return { error: data.error || "Ошибка Trello" };
      return {
        lists: (data.lists || []).map(l => ({ id: l.id, name: l.name })),
        hint: "Используй id нужного списка в create_trello_card",
      };
    } catch(e) { return { error: e.message }; }
  }

  if (name === "create_trello_card") {
    try {
      // First get lists to resolve list_name → id
      const boardRes = await fetch("/api/trello?action=board");
      const boardData = await boardRes.json();
      if (!boardRes.ok) return { error: boardData.error || "Ошибка Trello" };

      const lists = boardData.lists || [];
      let listId = null;

      if (inp.list_name) {
        const q = inp.list_name.toLowerCase().trim();
        // Точное совпадение
        let match = lists.find(l => l.name.toLowerCase() === q);
        // Частичное — список содержит запрос
        if (!match) match = lists.find(l => l.name.toLowerCase().includes(q));
        // Частичное — запрос содержит список
        if (!match) match = lists.find(l => q.includes(l.name.toLowerCase()));
        if (match) listId = match.id;
      }
      // Фоллбэк: "Новый список" или первый список — НИКОГДА не создаём новый
      if (!listId) {
        const fallback = lists.find(l => l.name.toLowerCase().includes("новый")) || lists[0];
        if (fallback) listId = fallback.id;
      }
      if (!listId) return { error: "Нет доступных списков на доске" };

      const body = { name: inp.name, idList: listId };
      if (inp.desc) body.desc = inp.desc;
      if (inp.due)  body.due  = inp.due;

      const r = await fetch("/api/trello?action=card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) return { error: data.error || "Ошибка создания карточки" };

      sendDesktopNotif("📋 Trello", `Карточка создана: ${inp.name}`);
      return {
        ok: true,
        cardName: data.card?.name,
        listName: lists.find(l => l.id === listId)?.name,
        cardUrl: data.card?.url,
      };
    } catch(e) { return { error: e.message }; }
  }

    return execTool(name, inp); // fallback
  }, [execTool]);

  // ── Agentic loop + Firebase save ──────────────────────────────────────────
  const send = useCallback(async (text, extraImages = []) => {
    const trimmed = text.trim();
    const images = extraImages.length > 0 ? extraImages : attachedImages;
    if (!trimmed && images.length === 0) return;
    if (busy) return;

    const ts = Date.now();
    const displayText = trimmed + (images.length > 0 ? ` 📎 ${images.length} фото` : "");
    const userMsg = { k: "user", text: displayText || "📎 Отправил фото", ts };

    // Формируем content для API — текст + изображения
    const userContent = images.length > 0
      ? [
          ...images.map(img => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } })),
          ...(trimmed ? [{ type: "text", text: trimmed }] : [{ type: "text", text: "Проанализируй это фото в контексте IGS Outdoor" }]),
        ]
      : trimmed;

    let curHist = [...history, { role: "user", content: userContent }];
    let curMsgs = [...msgs, userMsg];

    setHistory(curHist);
    setMsgs(curMsgs);
    setInput("");
    setAttachedImages([]);
    setBusy(true);

    try {
      let finalText = "";

      for (let turn = 0; turn < 10; turn++) {
        // Обрезаем историю — макс 10 ходов (20 сообщений) чтобы не превышать rate limit
        const MAX_HIST = 20;
        const trimmedHist = curHist.length > MAX_HIST
          ? curHist.slice(curHist.length - MAX_HIST)
          : curHist;

        const res = await fetch("/api/ai-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: MODEL, max_tokens: 800,
            system: buildSystemPrompt(products, clients),
            tools: TOOLS,
            messages: trimmedHist,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          // Rate limit — понятное сообщение
          if (res.status === 429 || (data.error?.message || "").includes("rate limit")) {
            throw new Error("⏳ Слишком много запросов. Подожди 30–60 секунд и попробуй снова.");
          }
          throw new Error(data.error?.message || `Ошибка сервера ${res.status}`);
        }

        const texts   = data.content.filter(b => b.type === "text");
        const toolUse = data.content.filter(b => b.type === "tool_use");
        curHist = [...curHist, { role: "assistant", content: data.content }];

        if (toolUse.length === 0) {
          finalText = texts.map(b => b.text).join("\n").trim();
          break;
        }

        const results  = [];
        const uiPushes = [];

        for (const tb of toolUse) {
          const r = await execToolAsync(tb.name, tb.input);
          results.push({ type: "tool_result", tool_use_id: tb.id, content: JSON.stringify(r) });

          if (tb.name === "calculate_kp" && r.lines)
            uiPushes.push({ k:"calc", data:r, rawItems:tb.input.items, rawDiscount:tb.input.discount||0, ts:Date.now() });
          if (tb.name === "open_kp"      && r.ok) uiPushes.push({ k:"action", icon:"📋", text:"Открываю КП в калькуляторе…", ts:Date.now() });
          if (tb.name === "update_client" && r.ok) uiPushes.push({ k:"action", icon:"✏️", text:`Клиент обновлён: ${r.updated?.join(", ")}` });
          if (tb.name === "change_status" && r.ok) uiPushes.push({ k:"action", icon:"🔄", text:`${r.name} → ${r.newStatus}` });
          if (tb.name === "add_task"      && r.ok) uiPushes.push({ k:"action", icon:"📌", text:`Задача: ${r.clientName}` });
          if (tb.name === "create_trello_card" && r.ok) uiPushes.push({ k:"action", icon:"📋", text:`Trello: ${r.cardName} → ${r.listName}` });
          if (tb.name === "set_price"         && r.ok) uiPushes.push({ k:"action", icon:"💰", text:`Цена обновлена: ${r.name} → ${new Intl.NumberFormat("ru-RU").format(r.price)} ₸/м²`, ts:Date.now() });
          if (tb.name === "add_client_note"   && r.ok) uiPushes.push({ k:"action", icon:"📝", text:`Заметка добавлена: ${r.clientName}`, ts:Date.now() });
          if (tb.name === "get_stats"         && r.totalClients !== undefined) uiPushes.push({ k:"action", icon:"📊", text:`Статистика: ${r.totalClients} клиентов`, ts:Date.now() });
          if (tb.name === "navigate"     && r.ok) uiPushes.push({ k:"action", icon:"🔀", text:`Перехожу: ${r.label}`, ts:Date.now() });
          if (tb.name === "go_to_client" && r.ok) uiPushes.push({ k:"action", icon:"👤", text:"Открываю карточку клиента", ts:Date.now() });
          if (tb.name === "add_client"   && r.ok) uiPushes.push({ k:"action", icon:"✅", text:`Клиент создан: ${r.name}`, ts:Date.now() });
        }

        if (uiPushes.length) {
          curMsgs = [...curMsgs, ...uiPushes];
          setMsgs(curMsgs);
        }

        curHist = [...curHist, { role: "user", content: results }];
        if (data.stop_reason === "end_turn") { finalText = texts.map(b=>b.text).join("\n").trim(); break; }
      }

      // Финальный ответ
      setHistory(curHist);
      if (finalText) {
        const aiMsg = { k: "ai", text: finalText, ts: Date.now() };
        curMsgs = [...curMsgs, aiMsg];
        setMsgs(curMsgs);
        if (!open) setUnread(n => n + 1);
      }

      // ── Сохраняем сессию в Firebase ──
      await saveAiSession(sessionId.current, curMsgs, {
        createdAt: sessionStart.current,
        source: "crm_ai",
        device: isMobile ? "mobile" : "desktop",
      });

    } catch (err) {
      console.error("Дастан error:", err);
      const errMsg = { k:"err", text: err.message || "Что-то пошло не так 🙏", ts: Date.now() };
      curMsgs = [...curMsgs, errMsg];
      setMsgs(curMsgs);
      // Сохраняем даже при ошибке
      saveAiSession(sessionId.current, curMsgs, {
        createdAt: sessionStart.current,
        source: "crm_ai",
        device: isMobile ? "mobile" : "desktop",
        hasError: true,
      });
    } finally {
      setBusy(false);
    }
  }, [history, msgs, busy, products, clients, execTool, execToolAsync, open, isMobile]);

  const handleKey = e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
  };

  const CHIPS = [
    { l:"🧾 Новый КП",      t:"Помоги создать новый КП" },
    { l:"🔍 Найти клиента", t:"Найди клиента в базе" },
    { l:"💰 Цены",          t:"Покажи цены на все продукты" },
    { l:"📊 Статистика",    t:`У нас ${clients.length} клиентов. Дай краткую статистику по статусам.` },
  ];

  const panelBottom = isMobile ? kbH : 28;
  const panelH      = isMobile ? `calc(82svh - ${kbH}px)` : "560px";

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── FAB — всегда видна, toggles open/close ── */}
      <button
        onClick={toggle}
        aria-label={open ? "Закрыть Дастан" : "Открыть Дастан"}
        style={{
          position: "fixed",
          bottom: isMobile ? (open ? `calc(${panelH} + ${panelBottom}px + 12px)` : "76px") : (open ? `calc(560px + 40px)` : "28px"),
          right: 18,
          zIndex: 132,
          width: 54, height: 54,
          borderRadius: "50%",
          border: open ? `2px solid ${T.goldRim}` : "none",
          background: open
            ? T.card
            : `linear-gradient(145deg, ${T.goldBr}, ${T.gold}, #8a6e3a)`,
          boxShadow: open
            ? `0 4px 20px rgba(0,0,0,0.5), 0 0 0 1px ${T.goldRim}`
            : `0 4px 20px rgba(184,150,90,0.45), 0 2px 8px rgba(0,0,0,0.5)`,
          cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "all 0.25s cubic-bezier(.22,1,.36,1)",
        }}
      >
        {open ? (
          // Крестик когда открыто
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={T.gold} strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        ) : (
          // Аватар А когда закрыто
          <span style={{ fontSize: 22, fontWeight: 800, color: "#09090b", fontFamily: "Georgia,serif", letterSpacing: -0.5 }}>Д</span>
        )}

        {/* Unread badge — только когда закрыто */}
        {!open && unread > 0 && (
          <span style={{
            position: "absolute", top: -2, right: -2,
            minWidth: 18, height: 18, borderRadius: 9,
            background: T.red, color: "#fff",
            fontSize: 11, fontWeight: 700,
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "0 4px", border: `2px solid ${T.bg}`,
          }}>
            {unread}
          </span>
        )}
      </button>

      {/* ── Panel ── */}
      {open && (
        <>
          {/* Backdrop (mobile) */}
          {isMobile && (
            <div
              onClick={toggle}
              style={{
                position: "fixed", inset: 0, zIndex: 128,
                background: "rgba(0,0,0,0.55)",
                backdropFilter: "blur(3px)",
              }}
            />
          )}

          <div style={{
            position: "fixed",
            bottom: panelBottom,
            right: isMobile ? 0 : 18,
            left: isMobile ? 0 : "auto",
            width: isMobile ? "100%" : 400,
            height: panelH,
            maxHeight: isMobile ? "90svh" : "none",
            zIndex: 129,
            background: T.card,
            borderRadius: isMobile ? "22px 22px 0 0" : 18,
            border: `1px solid ${T.goldRim}`,
            boxShadow: "0 -4px 40px rgba(0,0,0,0.65), 0 0 0 1px rgba(184,150,90,0.06)",
            display: "flex", flexDirection: "column",
            overflow: "hidden",
            transition: "bottom 0.2s ease",
            animation: "aiSlideUp 0.3s cubic-bezier(.22,1,.36,1)",
          }}>
            <style>{`
              @keyframes aiSlideUp {
                from { opacity:0; transform:translateY(18px) }
                to   { opacity:1; transform:none }
              }
            `}</style>

            {/* Header */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "13px 16px 11px",
              background: T.bg,
              borderBottom: `1px solid ${T.border}`,
              flexShrink: 0,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <AvatarEl size={38} />
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: T.text, fontFamily: "system-ui" }}>Дастан</span>
                    <span style={{ fontSize: 10, color: T.green, fontWeight: 600 }}>● онлайн</span>
                  </div>
                  <div style={{ fontSize: 11, color: T.dim, marginTop: 1 }}>AI-ассистент IGS Outdoor</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {msgs.length > 0 && (
                  <button
                    onClick={() => { setMsgs([]); setHistory([]); sessionId.current = "ai_" + Date.now() + "_" + Math.random().toString(36).slice(2,7); sessionStart.current = new Date().toISOString(); }}
                    style={{ background:"transparent", border:`1px solid ${T.border}`, borderRadius:8, padding:"5px 10px", fontSize:11, color:T.dim, cursor:"pointer", fontFamily:"system-ui" }}
                  >
                    Сбросить
                  </button>
                )}
                {/* Кнопка закрыть в хедере — дублирует FAB */}
                <button
                  onClick={toggle}
                  style={{ background:"transparent", border:"none", color:T.dim, fontSize:24, cursor:"pointer", lineHeight:1, padding:"0 4px", borderRadius:6 }}
                >
                  ×
                </button>
              </div>
            </div>

            {/* Messages */}
            <div
              ref={msgAreaRef}
              style={{
                flex: 1, overflowY: "auto", overflowX: "hidden",
                padding: "14px 14px 8px",
                display: "flex", flexDirection: "column", gap: 10,
                WebkitOverflowScrolling: "touch",
              }}
            >
              {msgs.length === 0 && <WelcomeScreen chips={CHIPS} onChip={send} clients={clients} />}
              {msgs.map((m, i) => (
                <Bubble key={i} m={m} onOpenKP={(items, disc) => {
                  onStartKP(null, { items, discount: disc });
                  setOpen(false);
                }} />
              ))}
              {busy && <ThinkRow />}
            </div>

            {/* Input */}
            <div style={{
              flexShrink: 0,
              padding: `8px 12px calc(8px + env(safe-area-inset-bottom, 0px))`,
              borderTop: `1px solid ${T.border}`,
              background: T.bg,
            }}>
              {/* Превью прикреплённых фото */}
              {attachedImages.length > 0 && (
                <div style={{ display:"flex", gap:6, marginBottom:8, flexWrap:"wrap" }}>
                  {attachedImages.map((img, i) => (
                    <div key={i} style={{ position:"relative" }}>
                      <img src={img.preview} alt="" style={{ width:54, height:54, borderRadius:10, objectFit:"cover", border:`1px solid ${T.goldRim}` }}/>
                      <button onClick={()=>setAttachedImages(prev=>prev.filter((_,j)=>j!==i))}
                        style={{ position:"absolute", top:-5, right:-5, width:18, height:18, borderRadius:"50%", background:T.red, border:"none", color:"#fff", fontSize:11, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", lineHeight:1 }}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 7, alignItems: "flex-end" }}>
                {/* Кнопка прикрепить фото */}
                <input ref={fileInputRef} type="file" accept="image/*" multiple style={{display:"none"}}
                  onChange={async e => {
                    const files = Array.from(e.target.files || []);
                    const loaded = await Promise.all(files.slice(0,4).map(file => new Promise(res => {
                      const reader = new FileReader();
                      reader.onload = ev => {
                        const b64 = ev.target.result.split(",")[1];
                        res({ base64: b64, mediaType: file.type || "image/jpeg", preview: ev.target.result });
                      };
                      reader.readAsDataURL(file);
                    })));
                    setAttachedImages(prev => [...prev, ...loaded].slice(0,4));
                    e.target.value = "";
                  }}
                />
                <button onClick={()=>fileInputRef.current?.click()}
                  style={{ width:40, height:40, borderRadius:12, border:`1px solid ${attachedImages.length>0?T.goldRim:T.border}`, background:attachedImages.length>0?T.goldBg:T.surface, color:attachedImages.length>0?T.gold:T.dim, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:18, transition:"all 0.2s" }}
                  title="Прикрепить фото">
                  📎
                </button>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKey}
                  placeholder={attachedImages.length > 0 ? "Опиши что нужно сделать с фото…" : "Напиши Дастан…"}
                  rows={1}
                  style={{
                    flex: 1, background: T.surface,
                    border: `1px solid ${input||attachedImages.length>0 ? T.goldRim : T.border}`,
                    borderRadius: 14, padding: "10px 14px",
                    color: T.text, fontSize: 15, fontFamily: "system-ui",
                    resize: "none", outline: "none", lineHeight: 1.45,
                    maxHeight: 120, overflowY: "auto",
                    WebkitAppearance: "none", transition: "border-color 0.2s",
                  }}
                />
                <button
                  onClick={() => send(input)}
                  disabled={(!input.trim() && attachedImages.length === 0) || busy}
                  style={{
                    width: 44, height: 44, borderRadius: 14,
                    border: `1px solid ${(input.trim()||attachedImages.length>0) && !busy ? "transparent" : T.border}`,
                    background: (input.trim()||attachedImages.length>0) && !busy
                      ? `linear-gradient(135deg, ${T.goldBr}, ${T.gold})`
                      : T.surface,
                    color: (input.trim()||attachedImages.length>0) && !busy ? "#09090b" : T.dim,
                    cursor: (input.trim()||attachedImages.length>0) && !busy ? "pointer" : "not-allowed",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0, transition: "all 0.2s",
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                </button>
              </div>
              <div style={{ textAlign: "center", fontSize: 10, color: T.dim, marginTop: 6, letterSpacing: 0.3 }}>
                Enter — отправить · Shift+Enter — строка · 📎 — фото
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
function AvatarEl({ size = 30 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: `linear-gradient(145deg, ${T.goldBr}, ${T.gold}, #8a6e3a)`,
      display: "flex", alignItems: "center", justifyContent: "center",
      boxShadow: size > 36 ? "0 0 0 2px rgba(184,150,90,0.2)" : "none",
    }}>
      <span style={{ fontSize: size * 0.46, fontWeight: 800, color: "#09090b", fontFamily: "Georgia,serif", lineHeight: 1 }}>Д</span>
    </div>
  );
}

// ─── Welcome ──────────────────────────────────────────────────────────────────
function WelcomeScreen({ chips, onChip, clients }) {
  const hot = clients.filter(c => c.status === "hot" || c.status === "negotiation").length;
  return (
    <div style={{ padding: "10px 4px 4px", textAlign: "center" }}>
      <div style={{
        width: 68, height: 68, borderRadius: "50%", margin: "0 auto 14px",
        background: `linear-gradient(145deg, ${T.goldBr}, ${T.gold}, #8a6e3a)`,
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: "0 6px 28px rgba(184,150,90,0.3)",
      }}>
        <span style={{ fontSize: 32, fontWeight: 800, color: "#09090b", fontFamily: "Georgia,serif" }}>Д</span>
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: T.text, marginBottom: 6, fontFamily: "system-ui" }}>Привет! Я Дастан 👋</div>
      <div style={{ fontSize: 13, color: T.mid, lineHeight: 1.7, marginBottom: 6 }}>
        Твой AI-ассистент по КП, клиентам<br/>и всему в CRM
      </div>
      {hot > 0 && (
        <div style={{ display:"inline-block", background:"rgba(196,84,84,0.09)", border:"1px solid rgba(196,84,84,0.18)", borderRadius:10, padding:"4px 12px", fontSize:12, color:"#e07070", margin:"6px 0 10px" }}>
          🔥 {hot} горячих клиентов ждут
        </div>
      )}
      <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
        {chips.map((c, i) => (
          <button key={i} onClick={() => onChip(c.t)} style={{
            background: T.goldBg, border: `1px solid ${T.goldRim}`,
            borderRadius: 22, padding: "8px 16px",
            fontSize: 13, color: T.gold, cursor: "pointer",
            fontWeight: 600, fontFamily: "system-ui",
          }}>
            {c.l}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 18, fontSize: 11, color: T.dim, lineHeight: 1.75 }}>
        Например: <em style={{ color: T.mid }}>"КП для Арман, биоклим 5×4 + zip 3×3, скидка 5%"</em>
      </div>
    </div>
  );
}

// ─── Thinking ─────────────────────────────────────────────────────────────────
function ThinkRow() {
  return (
    <div style={{ display:"flex", gap:9, alignItems:"center" }}>
      <AvatarEl size={30} />
      <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:"4px 14px 14px 14px", padding:"10px 14px", display:"flex", gap:5, alignItems:"center" }}>
        {[0,1,2].map(i => (
          <span key={i} style={{ width:6, height:6, borderRadius:"50%", background:T.gold, display:"inline-block", animation:`aiDot 1.2s ${i*0.2}s infinite ease-in-out` }} />
        ))}
        <style>{`@keyframes aiDot{0%,100%{transform:translateY(0);opacity:.35}50%{transform:translateY(-5px);opacity:1}}`}</style>
      </div>
      <span style={{ fontSize:11, color:T.dim, fontStyle:"italic" }}>думаю…</span>
    </div>
  );
}

// ─── Bubble ───────────────────────────────────────────────────────────────────
function Bubble({ m, onOpenKP }) {
  if (m.k === "user") return (
    <div style={{ display:"flex", justifyContent:"flex-end" }}>
      <div style={{ maxWidth:"80%", background:`linear-gradient(135deg,${T.goldBr},${T.gold})`, color:"#09090b", borderRadius:"18px 18px 4px 18px", padding:"10px 14px", fontSize:14, fontFamily:"system-ui", lineHeight:1.5, fontWeight:500 }}>
        {m.text}
      </div>
    </div>
  );
  if (m.k === "ai") return (
    <div style={{ display:"flex", gap:8, alignItems:"flex-start" }}>
      <AvatarEl size={30} />
      <div style={{ maxWidth:"86%", background:T.surface, border:`1px solid ${T.border}`, borderRadius:"4px 18px 18px 18px", padding:"11px 14px", fontSize:14, fontFamily:"system-ui", lineHeight:1.65, color:T.text, whiteSpace:"pre-wrap", wordBreak:"break-word" }}>
        {m.text}
      </div>
    </div>
  );
  if (m.k === "err") return (
    <div style={{ display:"flex", gap:8 }}>
      <AvatarEl size={30} />
      <div style={{ background:"rgba(196,84,84,0.08)", border:"1px solid rgba(196,84,84,0.18)", borderRadius:"4px 14px 14px 14px", padding:"10px 14px", fontSize:13, color:T.red, lineHeight:1.5 }}>
        ⚠️ {m.text}
      </div>
    </div>
  );
  if (m.k === "action") return (
    <div style={{ display:"flex", justifyContent:"center" }}>
      <div style={{ fontSize:12, color:T.gold, background:T.goldBg, border:`1px solid ${T.goldRim}`, borderRadius:22, padding:"5px 14px", fontFamily:"system-ui", fontWeight:600 }}>
        {m.icon} {m.text}
      </div>
    </div>
  );
  if (m.k === "calc") return <CalcCard data={m.data} rawItems={m.rawItems} rawDiscount={m.rawDiscount} onOpenKP={onOpenKP} />;
  return null;
}

// ─── CalcCard ─────────────────────────────────────────────────────────────────
function CalcCard({ data, rawItems, rawDiscount, onOpenKP }) {
  return (
    <div style={{ marginLeft:38, background:"#0d0d10", border:`1px solid ${T.goldRim}`, borderRadius:16, overflow:"hidden" }}>
      <div style={{ padding:"10px 14px 8px", background:"rgba(184,150,90,0.07)", borderBottom:"1px solid rgba(184,150,90,0.12)", display:"flex", alignItems:"center", gap:7 }}>
        <span style={{ fontSize:13 }}>🧾</span>
        <span style={{ fontSize:11, color:T.gold, fontWeight:700, letterSpacing:2, textTransform:"uppercase" }}>Расчёт КП</span>
      </div>
      <div style={{ padding:"12px 14px" }}>
        {(data.lines || []).map((item, i) => (
          <div key={i} style={{ padding:"8px 0", borderBottom:`1px solid ${T.border}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
              <div style={{ flex:1, marginRight:8 }}>
                <div style={{ fontSize:13, fontWeight:600, color:T.text }}>{item.name}</div>
                <div style={{ fontSize:11, color:T.dim, marginTop:2 }}>
                  {item.width} × {item.depth} м · {item.area} м²
                  {item.qty > 1 && ` · ${item.qty} шт.`}
                  {item.options && <span style={{ color:T.gold }}> · {item.options}</span>}
                </div>
              </div>
              <div style={{ fontSize:14, fontWeight:700, color:T.gold, flexShrink:0 }}>{fmtN(item.sum)} ₸</div>
            </div>
          </div>
        ))}
        <div style={{ marginTop:10, borderTop:`1px solid ${T.border}`, paddingTop:10 }}>
          {data.discount > 0 && (
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:T.mid, marginBottom:4 }}>
              <span>Скидка {data.discount}%</span>
              <span>−{fmtN(data.subtotal - data.total)} ₸</span>
            </div>
          )}
          <div style={{ display:"flex", justifyContent:"space-between", fontSize:18, fontWeight:700, color:T.text, marginBottom:10 }}>
            <span>Итого</span>
            <span style={{ color:T.goldBr }}>{fmtN(data.total)} ₸</span>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            <div style={{ background:T.surface, borderRadius:10, padding:"8px 10px", border:`1px solid ${T.border}` }}>
              <div style={{ fontSize:10, color:T.dim, marginBottom:2 }}>Предоплата 70%</div>
              <div style={{ fontSize:13, fontWeight:700, color:T.green }}>{fmtN(data.prepay)} ₸</div>
            </div>
            <div style={{ background:T.surface, borderRadius:10, padding:"8px 10px", border:`1px solid ${T.border}` }}>
              <div style={{ fontSize:10, color:T.dim, marginBottom:2 }}>Остаток 30%</div>
              <div style={{ fontSize:13, fontWeight:700, color:T.mid }}>{fmtN(data.rest)} ₸</div>
            </div>
          </div>
        </div>
        <button
          onClick={() => onOpenKP(rawItems || [], rawDiscount || 0)}
          style={{ marginTop:12, width:"100%", background:`linear-gradient(135deg,${T.goldBr},${T.gold})`, color:"#09090b", border:"none", borderRadius:12, padding:"12px 0", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"system-ui", letterSpacing:0.3 }}
        >
          📋 Открыть в калькуляторе
        </button>
      </div>
    </div>
  );
}
