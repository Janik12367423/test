// ─── IGS CRM Service Worker — iOS 16.4+ compatible ───────────────────────────
const CACHE = "igs-crm-v4";

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(["/","/index.html"]).catch(()=>{}))
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(() => clients.claim())
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = e.request.url;
  if (url.includes("/api/") || url.includes("firebase") || url.includes("googleapis")) return;
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if (resp && resp.status===200 && resp.type==="basic") {
          caches.open(CACHE).then(c=>c.put(e.request, resp.clone()));
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then(r=>r||caches.match("/index.html")))
  );
});

// ── PUSH — iOS 16.4+ PWA compatible ─────────────────────────────────────────
self.addEventListener("push", e => {
  let data = { title:"IGS CRM", body:"Новое уведомление", icon:"/favicon.png", tag:"igs-notif", url:"/" };
  try { if(e.data) data={...data,...e.data.json()}; } catch(_){}

  const ua = (self.navigator?.userAgent||"");
  const isiOS = /iPad|iPhone|iPod/.test(ua);

  const opts = {
    body: data.body,
    icon: data.icon||"/favicon.png",
    badge: "/favicon.png",
    tag: data.tag||"igs-notif",
    data: { url: data.url||"/" },
    silent: false,
  };
  // Actions не работают надёжно на iOS
  if (!isiOS) {
    opts.requireInteraction = true;
    opts.actions = [
      {action:"open", title:"Открыть CRM"},
      {action:"dismiss", title:"Закрыть"},
    ];
  }

  e.waitUntil(self.registration.showNotification(data.title, opts));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  if (e.action==="dismiss") return;
  const url = e.notification.data?.url||"/";
  e.waitUntil(
    clients.matchAll({type:"window",includeUncontrolled:true}).then(list => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin)) {
          c.focus();
          if ("navigate" in c) c.navigate(url);
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ── Планировщик через postMessage ────────────────────────────────────────────
const timers = new Map();

self.addEventListener("message", e => {
  if (e.data?.type==="SCHEDULE_NOTIFICATION") {
    const {task, clientName, delay} = e.data;
    if (delay<=0) return;
    const ICONS  = {call:"📞",measure:"📐",start:"🏗️",order:"📦",kp:"📄"};
    const LABELS = {call:"Созвон",measure:"Замер",start:"Запуск работ",order:"Заказать",kp:"КП"};
    const icon  = ICONS[task.type]||"📋";
    const label = LABELS[task.type]||"Задача";
    const tag   = "task-"+task.id;

    // Отменяем предыдущие таймеры
    if(timers.has(tag))         { clearTimeout(timers.get(tag));         timers.delete(tag); }
    if(timers.has(tag+"_r"))    { clearTimeout(timers.get(tag+"_r"));    timers.delete(tag+"_r"); }

    timers.set(tag, setTimeout(()=>{
      self.registration.showNotification(`${icon} ${label} — ${clientName}`, {
        body: task.text+(task.date?`\n📅 ${task.date}${task.time?" в "+task.time:""}`:""  ),
        icon:"/favicon.png", badge:"/favicon.png", tag, data:{url:"/"}, silent:false,
      });
      timers.delete(tag);
    }, delay));

    if (delay > 15*60*1000) {
      timers.set(tag+"_r", setTimeout(()=>{
        self.registration.showNotification(`⏰ Через 15 мин: ${icon} ${label} — ${clientName}`, {
          body: task.text, icon:"/favicon.png", badge:"/favicon.png",
          tag:tag+"_r", data:{url:"/"}, silent:false,
        });
        timers.delete(tag+"_r");
      }, delay-15*60*1000));
    }
  }

  if (e.data?.type==="CANCEL_NOTIFICATION") {
    const tag="task-"+e.data.taskId;
    [tag, tag+"_r"].forEach(k=>{ if(timers.has(k)){clearTimeout(timers.get(k));timers.delete(k);} });
    self.registration.getNotifications({tag}).then(ns=>ns.forEach(n=>n.close()));
  }

  if (e.data?.type==="SKIP_WAITING") self.skipWaiting();
});
