// api/trello.js — Trello API прокси (ключи только на сервере)

const TRELLO_KEY   = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const BOARD_ID     = process.env.TRELLO_BOARD_ID;
const BASE         = "https://api.trello.com/1";

function auth(extra = "") {
  return `key=${TRELLO_KEY}&token=${TRELLO_TOKEN}${extra}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!TRELLO_KEY || !TRELLO_TOKEN) {
    return res.status(500).json({ error: "Trello API keys not configured. Add TRELLO_API_KEY and TRELLO_TOKEN in Vercel env vars." });
  }

  const { action } = req.query;

  try {
    // ── GET /api/trello?action=board ─────────────────────────────────────────
    // Возвращает списки + карточки всей доски
    if (req.method === "GET" && action === "board") {
      const bid = req.query.boardId || BOARD_ID;
      if (!bid) return res.status(400).json({ error: "TRELLO_BOARD_ID not set" });

      const [listsRes, cardsRes, labelsRes] = await Promise.all([
        fetch(`${BASE}/boards/${bid}/lists?${auth()}&fields=id,name,pos&filter=open`),
        fetch(`${BASE}/boards/${bid}/cards?${auth()}&fields=id,name,desc,idList,labels,due,url,pos,idMembers&filter=open`),
        fetch(`${BASE}/boards/${bid}/labels?${auth()}&fields=id,name,color&limit=50`),
      ]);

      const [lists, cards, labels] = await Promise.all([
        listsRes.json(), cardsRes.json(), labelsRes.json()
      ]);

      return res.json({ lists, cards, labels });
    }

    // ── GET /api/trello?action=boards ────────────────────────────────────────
    // Список досок пользователя (для выбора board_id)
    if (req.method === "GET" && action === "boards") {
      const r = await fetch(`${BASE}/members/me/boards?${auth()}&fields=id,name,url&filter=open`);
      return res.json(await r.json());
    }

    // ── POST /api/trello?action=card ─────────────────────────────────────────
    // Создать карточку
    if (req.method === "POST" && action === "card") {
      const { name, desc, idList, due, idLabels } = req.body || {};
      if (!name || !idList) return res.status(400).json({ error: "name and idList required" });

      const params = new URLSearchParams({ key: TRELLO_KEY, token: TRELLO_TOKEN });
      if (due)      params.set("due", due);
      if (idLabels) params.set("idLabels", idLabels);

      const r = await fetch(`${BASE}/cards?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, desc: desc || "", idList }),
      });
      const card = await r.json();
      if (!r.ok) return res.status(r.status).json(card);
      return res.json({ ok: true, card });
    }

    // ── PUT /api/trello?action=card&id={cardId} ───────────────────────────────
    // Переместить карточку в другой список
    if (req.method === "PUT" && action === "card") {
      const { id } = req.query;
      const { idList, name, desc, due, closed } = req.body || {};
      const body = {};
      if (idList  !== undefined) body.idList  = idList;
      if (name    !== undefined) body.name    = name;
      if (desc    !== undefined) body.desc    = desc;
      if (due     !== undefined) body.due     = due;
      if (closed  !== undefined) body.closed  = closed;

      const r = await fetch(`${BASE}/cards/${id}?${auth()}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const card = await r.json();
      if (!r.ok) return res.status(r.status).json(card);
      return res.json({ ok: true, card });
    }

    // ── DELETE /api/trello?action=card&id={cardId} ────────────────────────────
    if (req.method === "DELETE" && action === "card") {
      const { id } = req.query;
      await fetch(`${BASE}/cards/${id}?${auth()}`, { method: "DELETE" });
      return res.json({ ok: true });
    }

    return res.status(404).json({ error: "Unknown action" });

  } catch (e) {
    console.error("Trello proxy error:", e);
    return res.status(500).json({ error: e.message });
  }
}
