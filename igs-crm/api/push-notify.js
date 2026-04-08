// api/push-notify.js — Vercel Serverless
// Отправляет Web Push уведомление на подписанное устройство

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { subscription, title, body, tag, url } = req.body || {};
  if (!subscription?.endpoint) return res.status(400).json({ error: "No subscription" });

  const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || "BJbd_lEYgwJeUhbtLjhg8scd8rY49Kmse_XrW94Vw9wun8_Rhn4iZEaBXSszpstBwByjhD1JBvY7Pqx8cFYWABY";
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "gDjDY2m2R0QUEV12GBLjvejcVAGzawSfUUrNwhIl2kc";
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT     || "mailto:dastanshakhatov@gmail.com";

  try {
    const webpush = await import("web-push");
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

    await webpush.sendNotification(
      subscription,
      JSON.stringify({ title, body, icon: "/favicon.png", tag: tag || "igs", url: url || "/" })
    );

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Push error:", e);
    return res.status(500).json({ error: e.message });
  }
}
