// api/gdrive-backup.js — Резервная копия клиентов IGS CRM в Google Drive
// Создаёт/обновляет файл "IGS_CRM_Backup_YYYY-MM-DD.json" в папке Drive
//
// ENV переменные в Vercel:
//   GDRIVE_CLIENT_EMAIL  — email сервисного аккаунта Google
//   GDRIVE_PRIVATE_KEY   — приватный ключ (-----BEGIN RSA PRIVATE KEY-----)
//   GDRIVE_FOLDER_ID     — ID папки Google Drive (из URL: /folders/XXXXX)
//
// Как получить:
//   1. console.cloud.google.com → Создать проект → APIs → Google Drive API → Включить
//   2. IAM → Сервисные аккаунты → Создать → Скачать JSON ключ
//   3. Из JSON взять client_email и private_key
//   4. Создать папку в Google Drive → Расшарить на email сервисного аккаунта (Редактор)
//   5. ID папки — из URL https://drive.google.com/drive/folders/FOLDER_ID

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const CLIENT_EMAIL = process.env.GDRIVE_CLIENT_EMAIL;
  const PRIVATE_KEY  = (process.env.GDRIVE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const FOLDER_ID    = process.env.GDRIVE_FOLDER_ID;

  if (!CLIENT_EMAIL || !PRIVATE_KEY || !FOLDER_ID) {
    return res.status(500).json({
      error: "Google Drive не настроен. Добавьте GDRIVE_CLIENT_EMAIL, GDRIVE_PRIVATE_KEY, GDRIVE_FOLDER_ID в Vercel Environment Variables.",
      setup: "https://console.cloud.google.com/",
    });
  }

  const { clients } = req.body || {};
  if (!Array.isArray(clients) || clients.length === 0) {
    return res.status(400).json({ error: "Нет данных клиентов" });
  }

  try {
    // ── Получаем OAuth2 токен через JWT ──────────────────────────────────────
    const token = await getGoogleToken(CLIENT_EMAIL, PRIVATE_KEY);

    const now     = new Date();
    const dateStr = now.toISOString().slice(0, 10); // 2025-04-06
    const timeStr = now.toTimeString().slice(0, 5).replace(":", "-"); // 14-30
    const fileName = `IGS_CRM_Clients_${dateStr}.json`;

    // Строим JSON с полными данными клиентов
    const backupData = {
      exportedAt:   now.toISOString(),
      count:        clients.length,
      exportedBy:   "IGS CRM",
      clients:      clients.map(c => ({
        id:          c.id,
        name:        c.name        || "",
        phone:       c.phone       || "",
        address:     c.address     || "",
        source:      c.source      || "",
        status:      c.status      || "",
        notes:       c.notes       || "",
        kpsCount:    (c.kps || []).length,
        kpsTotal:    (c.kps || []).reduce((s, k) => s + (k.total || 0), 0),
        lastKP:      (c.kps || [])[0]?.createdAt || "",
        activeTasks: (c.tasks || []).filter(t => !t.done).length,
        createdAt:   c.createdAt   || "",
        updatedAt:   c.updatedAt   || "",
        kps:         (c.kps || []).map(k => ({
          id:        k.id,
          total:     k.total || 0,
          discount:  k.discount || 0,
          createdAt: k.createdAt || "",
          items:     (k.items || []).map(i => ({
            product:  i.productId,
            width:    i.width,
            depth:    i.depth,
            qty:      i.quantity || 1,
          })),
        })),
      })),
    };

    const jsonContent = JSON.stringify(backupData, null, 2);
    const jsonBytes   = Buffer.from(jsonContent, "utf-8");

    // ── Ищем существующий файл с таким именем ────────────────────────────────
    const searchRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=name='${fileName}' and '${FOLDER_ID}' in parents and trashed=false&fields=files(id,name,modifiedTime)`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const searchData  = await searchRes.json();
    const existingFile = searchData.files?.[0];

    let fileId;
    let action;

    if (existingFile) {
      // Обновляем существующий файл
      const updateRes = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${existingFile.id}?uploadType=media`,
        {
          method: "PATCH",
          headers: {
            Authorization:  `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: jsonBytes,
        }
      );
      const updateData = await updateRes.json();
      fileId = updateData.id || existingFile.id;
      action = "updated";
    } else {
      // Создаём новый файл с метаданными
      const boundary = "igs_crm_boundary";
      const metaData = JSON.stringify({
        name:    fileName,
        parents: [FOLDER_ID],
        mimeType: "application/json",
        description: `IGS CRM backup — ${clients.length} клиентов — ${now.toISOString()}`,
      });

      const multipart = [
        `--${boundary}\r\n`,
        `Content-Type: application/json; charset=utf-8\r\n\r\n`,
        metaData + "\r\n",
        `--${boundary}\r\n`,
        `Content-Type: application/json; charset=utf-8\r\n\r\n`,
        jsonContent + "\r\n",
        `--${boundary}--`,
      ].join("");

      const createRes = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`,
        {
          method: "POST",
          headers: {
            Authorization:  `Bearer ${token}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body: multipart,
        }
      );
      const createData = await createRes.json();
      if (!createRes.ok) throw new Error(createData.error?.message || "Drive upload failed");
      fileId = createData.id;
      action = "created";
    }

    // Также создаём исторический файл с временем (не перезаписывается)
    const histFileName = `IGS_CRM_${dateStr}_${timeStr}.json`;
    const histMeta = JSON.stringify({
      name:    histFileName,
      parents: [FOLDER_ID],
      mimeType: "application/json",
      description: `IGS CRM история — ${clients.length} клиентов`,
    });
    const histBoundary = "igs_hist_boundary";
    const histMultipart = [
      `--${histBoundary}\r\n`,
      `Content-Type: application/json; charset=utf-8\r\n\r\n`,
      histMeta + "\r\n",
      `--${histBoundary}\r\n`,
      `Content-Type: application/json; charset=utf-8\r\n\r\n`,
      jsonContent + "\r\n",
      `--${histBoundary}--`,
    ].join("");
    fetch(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`,
      {
        method: "POST",
        headers: {
          Authorization:  `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${histBoundary}`,
        },
        body: histMultipart,
      }
    ).catch(e => console.warn("History file failed:", e.message));

    return res.status(200).json({
      ok:       true,
      action,
      fileId,
      fileName,
      count:    clients.length,
      savedAt:  now.toISOString(),
    });

  } catch (e) {
    console.error("GDrive backup error:", e);
    return res.status(500).json({ error: e.message || "Ошибка сохранения в Google Drive" });
  }
}

// ── JWT → OAuth2 token для Google Service Account ─────────────────────────────
async function getGoogleToken(clientEmail, privateKey) {
  const now    = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim  = btoa(JSON.stringify({
    iss:   clientEmail,
    scope: "https://www.googleapis.com/auth/drive.file",
    aud:   "https://oauth2.googleapis.com/token",
    exp:   now + 3600,
    iat:   now,
  }));

  const sigInput  = `${header}.${claim}`;
  const signature = await rsaSign(sigInput, privateKey);
  const jwt       = `${sigInput}.${signature}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion:  jwt,
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error("Google auth failed: " + (tokenData.error_description || tokenData.error || "unknown"));
  }
  return tokenData.access_token;
}

// ── RSA-SHA256 подпись через Web Crypto API (Node 18+) ───────────────────────
async function rsaSign(data, pemKey) {
  // Убираем PEM заголовки
  const b64 = pemKey
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, "")
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  const keyBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const encoder   = new TextEncoder();
  const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
