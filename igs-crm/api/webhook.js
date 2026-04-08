// api/webhook.js — объединённый вебхук: лиды от бота + Telegram команды
// Маршрутизация по source:
//   POST /api/webhook?source=bot  → принимает лиды от WhatsApp бота
//   POST /api/webhook?source=tg   → принимает апдейты от Telegram бота
//
// Telegram webhook: https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://igs-luxurry-terrasa.vercel.app/api/webhook?source=tg

const TG_TOKEN  = "8688553798:AAG9OzcKxzAvQCwq37Wv-UBoPziRzh7HyHY";
const TG_CHAT   = "-4996071438";
const ALLOWED   = ["-4996071438", "7587676711", "1382101739"];
const DB_URL    = process.env.FIREBASE_DB_URL;
const DB_SECRET = process.env.FIREBASE_SECRET;

// ── Firebase helpers ──────────────────────────────────────────────────────────
async function fbGet(path) {
  const res = await fetch(`${DB_URL}/${path}.json?auth=${DB_SECRET}`);
  return res.json();
}
async function fbSet(path, data) {
  await fetch(`${DB_URL}/${path}.json?auth=${DB_SECRET}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ── Telegram helpers ──────────────────────────────────────────────────────────
async function tgSend(chatId, text, extra = {}) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...extra }),
  });
}
async function tgAnswer(id, text = "") {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text }),
  });
}

// ── Категории лидов ───────────────────────────────────────────────────────────
function categorizeLead(lead) {
  const stage = (lead.notes || lead.stage || "").toLowerCase();
  if (stage.includes("горяч")) return "hot";
  if (stage.includes("тёпл") || stage.includes("тепл")) return "warm";
  if (stage.includes("холодн")) return "cold";
  if (lead.status === "converted") return "hot";
  if (lead.status === "contacted") return "warm";
  if (lead.wants_measure && lead.wants_measure !== "Не назначено") return "hot";
  if (lead.dimensions && lead.dimensions !== "Не указано") return "warm";
  if (lead.product_type || lead.productType) return "warm";
  return "cold";
}

const CATS = {
  hot:  { label: "🔥 Горячие",  emoji: "🔥" },
  warm: { label: "🟡 Тёплые",   emoji: "🟡" },
  cold: { label: "❄️ Холодные", emoji: "❄️" },
};

function formatLead(lead, i) {
  const lines = [`<b>${i + 1}. ${lead.name || "Неизвестно"}</b>`];
  if (lead.phone)        lines.push(`📞 ${lead.phone}`);
  if (lead.product_type || lead.productType) lines.push(`🌿 ${lead.product_type || lead.productType}`);
  if (lead.dimensions && lead.dimensions !== "Не указано") lines.push(`📐 ${lead.dimensions}`);
  if (lead.address)      lines.push(`📍 ${lead.address}`);
  if (lead.wants_measure && lead.wants_measure !== "Не назначено") lines.push(`📅 ${lead.wants_measure}`);
  if (lead.notes && lead.notes !== "Не указано") lines.push(`📝 ${lead.notes}`);
  const date = lead.createdAt ? new Date(lead.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) : "";
  if (date) lines.push(`🕐 ${date}`);
  return lines.join("\n");
}

function buildTgLeadMsg(lead) {
  const lines = ["🤖 <b>НОВЫЙ ЛИД ОТ БОТА</b>", "━━━━━━━━━━━━━━━━"];
  if (lead.name && lead.name !== "Неизвестно") lines.push(`👤 <b>${lead.name}</b>`);
  if (lead.phone)        lines.push(`📞 <code>${lead.phone}</code>`);
  if (lead.productType)  lines.push(`🌿 ${lead.productType}`);
  if (lead.dimensions)   lines.push(`📐 ${lead.dimensions}`);
  if (lead.objectType)   lines.push(`🏠 ${lead.objectType}`);
  if (lead.address)      lines.push(`📍 ${lead.address}`);
  if (lead.hasMedia)     lines.push(`📸 Прислал фото`);
  if (lead.wantsMeasure) lines.push(`📅 Хочет замер`);
  if (lead.notes)        lines.push(`\n📝 ${lead.notes}`);
  lines.push("━━━━━━━━━━━━━━━━");
  lines.push(`🔗 <a href="https://igs-luxurry-terrasa.vercel.app">Открыть CRM</a>`);
  return lines.join("\n");
}

// ── Обработчик лида от бота ───────────────────────────────────────────────────
async function handleBotLead(req, res) {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers["x-webhook-secret"] !== secret)
    return res.status(401).json({ error: "Unauthorized" });

  const body = req.body || {};
  const lead = {
    id: Date.now().toString(),
    createdAt: new Date().toISOString(),
    source: "bot",
    name:        body.name    || body.client_name  || body.contact_name  || "Неизвестно",
    phone:       body.phone   || body.whatsapp     || body.contact_phone || "",
    address:     body.address || body.location     || body.city          || "",
    productType: body.product_type || body.solution || body.product      || "",
    dimensions:  body.dimensions   || body.size    || "",
    objectType:  body.object_type  || body.object  || "",
    hasMedia:    body.has_media    || body.media   || false,
    notes:       body.notes        || body.summary || body.message       || "",
    isWarm:      body.is_warm ?? body.warm ?? true,
    wantsMeasure: body.wants_measure ?? body.measure ?? false,
    conversation: body.conversation || body.dialog || "",
    status: "new",
  };

  if (DB_URL && DB_SECRET) {
    await fetch(`${DB_URL}/bot_leads/${lead.id}.json?auth=${DB_SECRET}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead),
    });
  }

  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: buildTgLeadMsg(lead), parse_mode: "HTML" }),
    });
  } catch (e) { console.error("TG send error:", e); }

  return res.status(200).json({ ok: true, id: lead.id });
}

// ── Обработчик Telegram команд ────────────────────────────────────────────────
async function handleTgWebhook(req, res) {
  const body = req.body || {};
  const chatId = body.message?.chat?.id || body.callback_query?.message?.chat?.id;
  if (!ALLOWED.includes(String(chatId))) return res.status(200).end();

  // Callback кнопки
  if (body.callback_query) {
    const data = body.callback_query.data;
    await tgAnswer(body.callback_query.id);

    if (data.startsWith("cat_")) {
      const catKey = data.replace("cat_", "");
      const cat = CATS[catKey];
      if (!cat) return res.status(200).end();
      const fbLeads = await fbGet("bot_leads");
      const all = fbLeads ? Object.values(fbLeads).filter(l => !l.deleted) : [];
      const filtered = all.filter(l => categorizeLead(l) === catKey);
      if (!filtered.length) {
        await tgSend(chatId, `${cat.emoji} <b>${cat.label}</b>\n\nЛидов нет.`);
        return res.status(200).end();
      }
      for (let i = 0; i < filtered.length; i += 5) {
        const chunk = filtered.slice(i, i + 5);
        const header = i === 0 ? `${cat.emoji} <b>${cat.label}</b> — ${filtered.length} лидов\n━━━━━━━━━━━━━━━━\n\n` : "";
        await tgSend(chatId, header + chunk.map((l, j) => formatLead(l, i + j)).join("\n\n━━━━━━━━━━━━━━━━\n\n"));
      }
    }

    if (data.startsWith("search_")) {
      await tgSend(chatId, "🔍 Введите имя или номер телефона:");
      await fbSet(`tg_state/${chatId}`, { action: "search", ts: Date.now() });
    }
    return res.status(200).end();
  }

  // Сообщения
  if (body.message) {
    const text = (body.message.text || "").trim();
    const cmd = text.split("@")[0];

    // Проверка состояния поиска
    const state = await fbGet(`tg_state/${chatId}`);
    if (state?.action === "search" && Date.now() - state.ts < 120000) {
      await fbSet(`tg_state/${chatId}`, null);
      const query = text.toLowerCase();
      const fbLeads = await fbGet("bot_leads");
      const results = fbLeads ? Object.values(fbLeads).filter(l =>
        !l.deleted && (
          (l.name || "").toLowerCase().includes(query) ||
          (l.phone || "").replace(/\D/g,"").includes(query.replace(/\D/g,""))
        )
      ) : [];
      if (!results.length) {
        await tgSend(chatId, `🔍 По запросу <b>"${text}"</b> ничего не найдено.`);
      } else {
        const cat = l => CATS[categorizeLead(l)]?.emoji || "❓";
        await tgSend(chatId, `🔍 Найдено: <b>${results.length}</b>\n\n` +
          results.map((l, i) => `${cat(l)} ` + formatLead(l, i)).join("\n\n━━━━━━━━━━━━━━━━\n\n"));
      }
      return res.status(200).end();
    }

    if (cmd === "/start" || cmd === "/help") {
      await tgSend(chatId, "👋 <b>IGS Outdoor CRM Bot</b>\n\n<b>Лиды:</b>\n/clients — По категориям\n/search — Поиск\n/stats — Статистика\n/new — Новые сегодня\n/hot — Горячие лиды\n\n<b>Цены:</b>\n/prices — Текущие цены\n/setprice &lt;id&gt; &lt;сумма&gt; — Изменить цену\n/resetprice &lt;id&gt; — Сбросить к базовой");
      return res.status(200).end();
    }

    if (cmd === "/clients") {
      const fbLeads = await fbGet("bot_leads");
      const all = fbLeads ? Object.values(fbLeads).filter(l => !l.deleted) : [];
      const counts = { hot: 0, warm: 0, cold: 0 };
      all.forEach(l => { const c = categorizeLead(l); if (counts[c] !== undefined) counts[c]++; });
      await tgSend(chatId, "📊 <b>Выберите категорию:</b>", {
        reply_markup: { inline_keyboard: [
          [{ text: `🔥 Горячие (${counts.hot})`,  callback_data: "cat_hot"  }],
          [{ text: `🟡 Тёплые (${counts.warm})`,  callback_data: "cat_warm" }],
          [{ text: `❄️ Холодные (${counts.cold})`, callback_data: "cat_cold" }],
          [{ text: `🔍 Поиск`,                     callback_data: "search_"  }],
        ]}
      });
      return res.status(200).end();
    }

    if (cmd === "/search") {
      await tgSend(chatId, "🔍 Введите имя или номер:");
      await fbSet(`tg_state/${chatId}`, { action: "search", ts: Date.now() });
      return res.status(200).end();
    }

    if (cmd === "/hot") {
      const fbLeads = await fbGet("bot_leads");
      const hot = fbLeads ? Object.values(fbLeads).filter(l => !l.deleted && categorizeLead(l) === "hot") : [];
      if (!hot.length) { await tgSend(chatId, "🔥 Горячих лидов пока нет."); return res.status(200).end(); }
      await tgSend(chatId, `🔥 <b>Горячие — ${hot.length}</b>\n━━━━━━━━━━━━━━━━\n\n` + hot.map((l, i) => formatLead(l, i)).join("\n\n━━━━━━━━━━━━━━━━\n\n"));
      return res.status(200).end();
    }

    if (cmd === "/new") {
      const fbLeads = await fbGet("bot_leads");
      const all = fbLeads ? Object.values(fbLeads).filter(l => !l.deleted) : [];
      const today = new Date().toDateString();
      const newToday = all.filter(l => l.createdAt && new Date(l.createdAt).toDateString() === today);
      if (!newToday.length) { await tgSend(chatId, "📭 Сегодня новых лидов нет."); return res.status(200).end(); }
      await tgSend(chatId, `📅 <b>Новые сегодня — ${newToday.length}</b>\n━━━━━━━━━━━━━━━━\n\n` +
        newToday.map((l, i) => `${CATS[categorizeLead(l)]?.emoji} ` + formatLead(l, i)).join("\n\n━━━━━━━━━━━━━━━━\n\n"));
      return res.status(200).end();
    }

    if (cmd === "/prices") {
      // Показать текущие цены
      const prices = await fbGet("prices");
      const lines = ["💰 <b>Текущие цены (₸/м²)</b>
━━━━━━━━━━━━━━━━"];
      const PNAMES = {greenawn:"🌿 Биоклим. (Поворот.)",igs_premium:"⭐ Биоклим. Premium",toscana:"⛺ Тент. Toscana",guhher:"🏕️ Tент. Guhher",sliding:"🪟 Раздвижное",guillotine:"🔳 Гильотина",zip:"🌬️ Zip-шторы",marquise:"☂️ Маркиза",railings:"🔩 Перила"};
      const DEFAULTS = {greenawn:250000,igs_premium:280000,toscana:130000,guhher:110000,zip:75000,sliding:100000,guillotine:200000,marquise:100000,railings:100000};
      for (const [id, label] of Object.entries(PNAMES)) {
        const cur = prices?.[id]?.price ?? DEFAULTS[id];
        const def = DEFAULTS[id];
        const mark = cur !== def ? " ✏️" : "";
        lines.push(`${label}: <b>${new Intl.NumberFormat("ru-RU").format(cur)} ₸</b>${mark}`);
      }
      lines.push("
<i>Чтобы изменить цену:
/setprice greenawn 270000</i>");
      await tgSend(chatId, lines.join("
"));
      return res.status(200).end();
    }

    if (cmd === "/setprice") {
      // /setprice <productId> <цена>
      const parts = text.trim().split(/\s+/);
      const productId = parts[1];
      const newPrice  = parseInt(parts[2]);
      const PNAMES = {greenawn:"🌿 Биоклим. (Поворот.)",igs_premium:"⭐ Биоклим. Premium",toscana:"⛺ Тент. Toscana",guhher:"🏕️ Тент. Guhher",sliding:"🪟 Раздвижное",guillotine:"🔳 Гильотина",zip:"🌬️ Zip-шторы",marquise:"☂️ Маркиза",railings:"🔩 Перила"};
      if (!productId || !PNAMES[productId] || !newPrice || newPrice < 1000) {
        await tgSend(chatId, `❌ Неверный формат.

Пример: <code>/setprice greenawn 270000</code>

Доступные ID:
${Object.entries(PNAMES).map(([id,n])=>`<code>${id}</code> — ${n}`).join("
")}`);
        return res.status(200).end();
      }
      // Читаем текущие цены
      const prices = await fbGet("prices") || {};
      const oldPrice = prices[productId]?.price ?? null;
      // Обновляем
      const updated = { ...(prices[productId] || {}), price: newPrice };
      await fbSet(`prices/${productId}`, updated);
      const label = PNAMES[productId];
      const fmt = n => new Intl.NumberFormat("ru-RU").format(n);
      await tgSend(chatId, `✅ <b>Цена обновлена!</b>

${label}
${oldPrice ? `Было: ${fmt(oldPrice)} ₸
` : ""}Стало: <b>${fmt(newPrice)} ₸/м²</b>

Цена сохранена в Firebase и применится автоматически в новых КП.`);
      return res.status(200).end();
    }

    if (cmd === "/resetprice") {
      // /resetprice <productId> — сброс к дефолту
      const DEFAULTS = {greenawn:250000,igs_premium:280000,toscana:130000,guhher:110000,zip:75000,sliding:100000,guillotine:200000,marquise:100000,railings:100000};
      const PNAMES   = {greenawn:"🌿 Биоклим.",igs_premium:"⭐ Premium",toscana:"⛺ Toscana",guhher:"🏕️ Guhher",sliding:"🪟 Раздвижное",guillotine:"🔳 Гильотина",zip:"🌬️ Zip",marquise:"☂️ Маркиза",railings:"🔩 Перила"};
      const pid = text.trim().split(/\s+/)[1];
      if (!pid || !DEFAULTS[pid]) {
        await tgSend(chatId, "❌ Укажи productId. Пример: <code>/resetprice greenawn</code>");
        return res.status(200).end();
      }
      const prices = await fbGet("prices") || {};
      const updated = { ...(prices[pid] || {}), price: DEFAULTS[pid] };
      await fbSet(`prices/${pid}`, updated);
      await tgSend(chatId, `🔄 <b>${PNAMES[pid]}</b> сброшена к базовой: <b>${new Intl.NumberFormat("ru-RU").format(DEFAULTS[pid])} ₸/м²</b>`);
      return res.status(200).end();
    }

    if (cmd === "/stats") {
      const fbLeads = await fbGet("bot_leads");
      const all = fbLeads ? Object.values(fbLeads).filter(l => !l.deleted) : [];
      const counts = { hot: 0, warm: 0, cold: 0 };
      all.forEach(l => { const c = categorizeLead(l); if (counts[c] !== undefined) counts[c]++; });
      const today = new Date().toDateString();
      const todayCount = all.filter(l => l.createdAt && new Date(l.createdAt).toDateString() === today).length;
      await tgSend(chatId, `📊 <b>Статистика</b>\n━━━━━━━━━━━━━━━━\n\nВсего: <b>${all.length}</b>\nСегодня: <b>${todayCount}</b>\n\n🔥 ${counts.hot} · 🟡 ${counts.warm} · ❄️ ${counts.cold}`);
      return res.status(200).end();
    }
  }

  return res.status(200).end();
}

// ── Главный роутер ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-webhook-secret");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(200).end();

  const source = req.query?.source || req.url?.split("source=")[1]?.split("&")[0];

  try {
    if (source === "tg") return await handleTgWebhook(req, res);
    return await handleBotLead(req, res);  // default: bot lead
  } catch (err) {
    console.error("webhook error:", err);
    return res.status(200).json({ error: "Internal error" });
  }
}
