import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  dbSet, dbGet, dbListen, isOnline,
  dbSetClient, dbDeleteClient, dbGetClients, dbListenClients, dbListenClientPatches,
  uploadCatalogFile, uploadKPPhoto, runBackup
} from "./firebase.js";
import AIAssistant from "./AIAssistant.jsx";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const STORAGE_KEY = "igs_crm_clients_v3";

// ── PWA Install prompt ────────────────────────────────────────────────────────
let _pwaPrompt = null;
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    _pwaPrompt = e;
    // Показываем кнопку установки через кастомное событие
    window.dispatchEvent(new CustomEvent("pwa-installable"));
  });
}
const PRICES_KEY  = "igs_crm_prices_v1";
const CUSTOM_PRODUCTS_KEY = "igs_crm_custom_products";
const CATALOG_MEDIA_KEY = "igs_catalog_media_v1";

// ─── PUSH УВЕДОМЛЕНИЯ (Web Push API) ─────────────────────────────────────────
const VAPID_PUBLIC_KEY = "BJbd_lEYgwJeUhbtLjhg8scd8rY49Kmse_XrW94Vw9wun8_Rhn4iZEaBXSszpstBwByjhD1JBvY7Pqx8cFYWABY";
const PUSH_SUB_KEY = "igs_push_subscription";

function urlBase64ToUint8Array(b64) {
  const pad = "=".repeat((4 - b64.length%4)%4);
  const raw = atob((b64+pad).replace(/-/g,"+").replace(/_/g,"/"));
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

async function subscribeToPush() {
  if(!("serviceWorker" in navigator)||!("PushManager" in window)) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if(!sub) sub = await reg.pushManager.subscribe({
      userVisibleOnly:true,
      applicationServerKey:urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    const subJson = sub.toJSON();
    try{localStorage.setItem(PUSH_SUB_KEY,JSON.stringify(subJson));}catch(_){}
    dbSet("push_subscriptions/"+btoa(sub.endpoint).replace(/[^a-z0-9]/gi,"").slice(-20), subJson);
    return sub;
  }catch(e){console.warn("Push subscribe:",e);return null;}
}

async function requestNotifPermission() {
  if(!("Notification" in window)) return false;
  if(Notification.permission==="denied") return false;
  let perm=Notification.permission;
  if(perm!=="granted") perm=await Notification.requestPermission();
  if(perm==="granted"){ await subscribeToPush(); return true; }
  return false;
}

async function sendPushViaSW(task, clientName, delay) {
  if(!("serviceWorker" in navigator)) return;
  try{
    const reg=await navigator.serviceWorker.ready;
    reg.active?.postMessage({type:"SCHEDULE_NOTIFICATION",task,clientName,delay});
  }catch(_){}
}

async function scheduleNotification(task, clientName) {
  if(!task.date||!task.time) return;
  const dt=new Date(`${task.date}T${task.time}`);
  const delay=dt-new Date();
  if(delay<=0) return;
  // Через SW — работает пока браузер открыт
  await sendPushViaSW(task,clientName,delay);
  if(delay>15*60*1000) await sendPushViaSW(task,clientName,delay-15*60*1000);
  // Сохраняем в Firebase — для будущей серверной отправки
  const LABELS={call:"Созвон",measure:"Замер",start:"Запуск работ",order:"Заказать"};
  const ICONS={call:"📞",measure:"📐",start:"🏗️",order:"📦"};
  try{
    const subStr=localStorage.getItem(PUSH_SUB_KEY);
    if(subStr){
      await dbSet("push_tasks/"+task.id,{
        subscription:JSON.parse(subStr), task, clientName,
        title:`${ICONS[task.type]||"📋"} ${LABELS[task.type]||"Задача"} — ${clientName}`,
        body:task.text+(task.date?`\n📅 ${task.date} в ${task.time}`:""),
        sendAt:dt.toISOString(), sent:false,
      });
    }
  }catch(_){}
}

if(typeof window!=="undefined"){
  if(Notification.permission==="granted") subscribeToPush().catch(()=>{});
}

// ─── iOS-SAFE PDF PRINT ───────────────────────────────────────────────────────
// window.open("","_blank") на iOS Safari открывает новую вкладку и
// пользователь теряет CRM — невозможно вернуться назад.
// Решение: рендерим HTML в скрытый <iframe> внутри текущей страницы,
// вызываем print() на нём, затем удаляем. Работает на iOS 15+, Android, Desktop.
function printHtmlSafe(html) {
  // Удаляем старый iframe если есть
  const old = document.getElementById("__igs_print_frame__");
  if (old) old.remove();

  const iframe = document.createElement("iframe");
  iframe.id = "__igs_print_frame__";
  iframe.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none;opacity:0;pointer-events:none;";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) {
    // Fallback для старых браузеров — Blob URL в той же вкладке
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return;
  }

  doc.open();
  doc.write(html);
  doc.close();

  // Ждём загрузку ресурсов (шрифты, картинки) потом печатаем
  const doprint = () => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch(e) { console.warn("print:", e); }
    // Убираем iframe после закрытия диалога печати
    setTimeout(() => { try { iframe.remove(); } catch(_){} }, 3000);
  };

  if (doc.readyState === "complete") {
    setTimeout(doprint, 400);
  } else {
    iframe.onload = () => setTimeout(doprint, 400);
    // Запасной таймер
    setTimeout(doprint, 1200);
  }
}

function loadCatalogMedia(){try{const r=JSON.parse(localStorage.getItem(CATALOG_MEDIA_KEY)||"null");if(r&&typeof r==="object")return r;}catch(_){}return{};}
function saveCatalogMedia(data){
  try{localStorage.setItem(CATALOG_MEDIA_KEY,JSON.stringify(data));}catch(_){}
  dbSet("catalog_media", data);
}

const DEFAULT_PRODUCTS = [
  // ── БИОКЛИМАТИЧЕСКИЕ ПЕРГОЛЫ ─────────────────────────────────────────────────
  { id:"greenawn", name:"Биоклиматическая пергола (Поворотная)", shortName:"Биоклим. пергола", tag:"Биоклиматическая · Поворотные ламели", price:250000, color:"#2d7a4f", emoji:"🌿",
    desc:"Поворотные ламели 0–110°, электропривод IP65, встроенный водосток",
    features:["Поворот ламелей до 110°","Электропривод IP65","Водосток в колоннах","Алюминий 6063-T6","Снег до 100 кг/м²"],
    options:[
      {id:"led",          label:"LED / RGB подсветка",             price:12000},
      {id:"heater",       label:"ИК обогреватель",                 price:45000, flat:true},
      {id:"screen",       label:"Zip-шторы по периметру",          price:75000},
      {id:"sliding_side", label:"Раздвижное остекление (боковое)", price:100000},
      {id:"sensor_wind",  label:"Датчик ветра (авто-закрытие)",    price:18000, flat:true},
      {id:"sensor_rain",  label:"Датчик дождя (авто-закрытие)",    price:15000, flat:true},
      {id:"fan",          label:"Встроенный вентилятор",           price:35000, flat:true},
      {id:"remote",       label:"Пульт ДУ / управление с телефона",price:8000,  flat:true},
    ]
  },

  { id:"igs_premium", name:"Биоклиматическая пергола Premium", shortName:"Биоклим. Premium", tag:"Биоклиматическая · Сдвижные ламели", price:280000, color:"#1a5276", emoji:"⭐",
    desc:"Поворотно-сдвижная система, герметичная конструкция, вынос до 7.25 м",
    features:["Поворотно-сдвижная система","Утеплённые пенные ламели","Герметичная конструкция","Премиум профиль","Макс. ширина 12м"],
    options:[
      {id:"insulated",    label:"Утеплённые пенные ламели",        price:28000},
      {id:"led",          label:"LED / RGB подсветка",             price:12000},
      {id:"heater",       label:"ИК обогреватель",                 price:45000, flat:true},
      {id:"screen",       label:"Zip-шторы по периметру",          price:75000},
      {id:"sliding_side", label:"Раздвижное остекление (боковое)", price:100000},
      {id:"sensor_wind",  label:"Датчик ветра (авто-закрытие)",    price:18000, flat:true},
      {id:"sensor_rain",  label:"Датчик дождя (авто-закрытие)",    price:15000, flat:true},
      {id:"remote",       label:"Пульт ДУ / управление с телефона",price:8000,  flat:true},
    ]
  },

  // ── ТЕНТОВЫЕ ПЕРГОЛЫ ─────────────────────────────────────────────────────────
  { id:"toscana", name:"Тентовая пергола", shortName:"Тентовая", tag:"Тентовая · Моторизованная", price:130000, color:"#7d6608", emoji:"⛺",
    desc:"Выдвижная влагостойкая крыша, вылет до 13.5 м, электромотор в комплекте",
    features:["Выдвижная ПВХ-крыша","Проекция до 13.5м","Алюминиевый каркас","Европейский дизайн"],
    options:[
      {id:"led",         label:"LED подсветка в балках",           price:10000},
      {id:"motor",       label:"Моторизация",                      price:18000, flat:true},
      {id:"heater",      label:"ИК обогреватель",                  price:45000, flat:true},
      {id:"screen",      label:"Zip-шторы по периметру",           price:75000},
      {id:"sensor_wind", label:"Датчик ветра (авто-уборка ткани)", price:18000, flat:true},
      {id:"sensor_rain", label:"Датчик дождя (авто-уборка ткани)", price:15000, flat:true},
    ]
  },

  { id:"guhher", name:"Тентовая пергола Guhher", shortName:"Guhher", tag:"Тентовая · Эконом", price:110000, color:"#6e5a2a", emoji:"🏕️",
    desc:"Тентовая пергола Guhher, надёжная конструкция, оптимальное соотношение цены и качества",
    features:["Тентовая ПВХ-крыша","Алюминиевый каркас","Ручное/моторизированное","Быстрая установка"],
    options:[
      {id:"led",         label:"LED подсветка в балках",           price:10000},
      {id:"motor",       label:"Моторизация",                      price:18000, flat:true},
      {id:"heater",      label:"ИК обогреватель",                  price:45000, flat:true},
      {id:"screen",      label:"Zip-шторы по периметру",           price:75000},
      {id:"sensor_wind", label:"Датчик ветра",                     price:18000, flat:true},
    ]
  },

  { id:"toscana_maxi", name:"Тентовая пергола Maxi", shortName:"Тент. Maxi", tag:"Тентовая · Maxi", price:230000, color:"#7d6608", emoji:"⛺",
    desc:"Тентовая пергола Maxi — увеличенная версия с усиленным каркасом",
    features:["Выдвижная ПВХ-крыша","Усиленный каркас","Электромотор","Европейский дизайн"],
    options:[
      {id:"led",         label:"LED подсветка в балках",           price:10000},
      {id:"motor",       label:"Моторизация",                      price:18000, flat:true},
      {id:"heater",      label:"ИК обогреватель",                  price:45000, flat:true},
      {id:"screen",      label:"Zip-шторы по периметру",           price:75000},
      {id:"sensor_wind", label:"Датчик ветра (авто-уборка ткани)", price:18000, flat:true},
      {id:"sensor_rain", label:"Датчик дождя",                     price:15000, flat:true},
    ]
  },

  // ── ОСТЕКЛЕНИЕ ───────────────────────────────────────────────────────────────
  { id:"sliding", name:"Раздвижное остекление", shortName:"Раздвижное", tag:"Панорамное", price:100000, color:"#1a6b8a", emoji:"🪟",
    desc:"Панорамное раздвижное остекление, 2–4 секции",
    features:["2–4 секции","Одинарное/двойное стекло","Алюминиевый профиль","Бесшумное движение"],
    options:[
      {id:"double",      label:"Двойное стекло (теплее)",          price:15000},
      {id:"motor",       label:"Моторизация (электропривод)",      price:25000, flat:true},
      {id:"tinted",      label:"Тонировка стекла",                 price:8000},
      {id:"soft_close",  label:"Доводчик (мягкое закрытие)",       price:5000,  flat:true},
    ]
  },

  { id:"guillotine", name:"Гильотинное остекление", shortName:"Гильотинное", tag:"Автоматизированная", price:200000, color:"#6c3483", emoji:"🔳",
    desc:"Автоматизированный стеклянный барьер, цепной привод",
    features:["2–3 секции","Цепной привод","Ламинированное стекло","Автоматизация"],
    options:[
      {id:"auto",        label:"Автоматизация (пульт ДУ)",         price:30000, flat:true},
      {id:"led",         label:"LED подсветка рамки",              price:10000, flat:true},
      {id:"tinted",      label:"Тонировка стекла",                 price:8000},
      {id:"double",      label:"Двойное стекло",                   price:18000},
    ]
  },

  // ── ЗИП-ШТОРЫ И МАРКИЗА ──────────────────────────────────────────────────────
  { id:"zip", name:"Zip-шторы", shortName:"Zip-шторы", tag:"Ветрозащита", price:75000, color:"#784212", emoji:"🌬️",
    desc:"ZIP-фиксация без парусения, высота до 4 м, кассетная система",
    features:["ZIP-фиксация без парусения","Высота до 4 м","Защита от насекомых","Кассетная система"],
    options:[
      {id:"motor",       label:"Моторизация",                      price:15000, flat:true},
      {id:"mesh",        label:"Москитная сетка",                  price:5000},
      {id:"led",         label:"LED подсветка верхней балки",      price:8000,  flat:true},
      {id:"sensor_wind", label:"Датчик ветра (авто-подъём)",       price:18000, flat:true},
      {id:"tinted",      label:"Затемняющая ткань (блэкаут)",      price:6000},
    ]
  },

  { id:"marquise", name:"Маркиза", shortName:"Маркиза", tag:"Мобильное затенение", price:100000, color:"#1e8449", emoji:"☂️",
    desc:"Кассетная маркиза с поворотными рычагами-пантографами, вылет до 4 м, угол 20°",
    features:["Кассетный короб — всё скрыто","Вал с тканью внутри кассеты","Рычаги-пантографы с шестернёй","Вылет до 4 м, угол 20°"],
    options:[
      {id:"motor",       label:"Моторизация (электропривод вала)", price:12000, flat:true},
      {id:"led",         label:"LED подсветка штанги и рычагов",   price:10000, flat:true},
      {id:"sensor_wind", label:"Датчик ветра (авто-уборка)",       price:18000, flat:true},
      {id:"sensor_rain", label:"Датчик дождя (авто-уборка)",       price:15000, flat:true},
      {id:"remote",      label:"Пульт-брелок / смартфон",          price:6000,  flat:true},
      {id:"fabric_plus", label:"Ткань премиум (акрил 350 г/м²)",   price:8000},
    ]
  },

  // ── ОГРАЖДЕНИЯ И НАСТИЛ ───────────────────────────────────────────────────────
  { id:"railings", name:"Перила", shortName:"Перила", tag:"Ограждения", price:100000, color:"#94a3b8", emoji:"🔩",
    desc:"Алюминиевые перила для террас, балконов и лестниц. Надёжная конструкция, широкий выбор цветов RAL, стекло или нержавейка.",
    features:["Алюминиевый профиль","Выбор цветов RAL","Стекло / нержавейка","Быстрая установка","Гарантия 1 год"],
    options:[
      {id:"glass",       label:"Стеклянное заполнение (10 мм)",    price:15000},
      {id:"steel",       label:"Нержавеющие вставки",              price:8000},
      {id:"led",         label:"LED подсветка поручня",            price:10000},
      {id:"ral_custom",  label:"Любой цвет RAL под заказ",         price:5000,  flat:true},
      {id:"cap_deco",    label:"Декоративный торец-заглушка",      price:2000,  flat:true},
    ]
  },

  { id:"panno", name:"Террасная доска Panno", shortName:"Panno", tag:"Террасная доска · Премиум", price:23000, color:"#8b6914", emoji:"🪵",
    desc:"Композитная террасная доска Panno премиум класса",
    features:["ДПК — дерево+полимер","Не гниёт и не трескается","Устойчива к UV","Скрытые крепления"],
    options:[
      {id:"fasteners",   label:"Скрытые крепления",                price:800},
      {id:"edging",      label:"Торцевая планка",                  price:1200},
      {id:"base",        label:"Лаги + подложка",                  price:3500},
      {id:"lights_deck", label:"Подсветка настила (LED в лагах)",  price:4500},
    ]
  },

  { id:"bilancio", name:"Террасная доска Bilancio", shortName:"Bilancio", tag:"Террасная доска · Стандарт", price:16000, color:"#6b5a3a", emoji:"🪵",
    desc:"Композитная террасная доска Bilancio оптимальная цена/качество",
    features:["ДПК — дерево+полимер","Не гниёт и не трескается","Устойчива к UV","Скрытые крепления"],
    options:[
      {id:"fasteners",   label:"Скрытые крепления",                price:800},
      {id:"edging",      label:"Торцевая планка",                  price:1200},
      {id:"base",        label:"Лаги + подложка",                  price:3500},
      {id:"lights_deck", label:"Подсветка настила (LED в лагах)",  price:4500},
    ]
  },
];

let PRODUCTS = [...DEFAULT_PRODUCTS];

function loadCustomProducts(){try{const r=JSON.parse(localStorage.getItem(CUSTOM_PRODUCTS_KEY)||"null");if(Array.isArray(r))return r;}catch(_){}return[];}
function saveCustomProducts(arr){
  try{localStorage.setItem(CUSTOM_PRODUCTS_KEY,JSON.stringify(arr));}catch(_){}
  dbSet("custom_products",arr);
}
function mergeProducts(custom){
  PRODUCTS=[...DEFAULT_PRODUCTS,...(custom||[])];
  // BUG FIX: re-apply saved prices after merging so custom product prices survive
  try{const p=JSON.parse(localStorage.getItem("igs_crm_prices_v1")||"null");if(p)applyPrices(p);}catch(_){}
}

const STATUSES = [
  {id:"lead",        label:"Лид",          color:"#6b7280", light:"rgba(107,114,128,0.12)"},
  {id:"negotiation", label:"Переговоры",   color:"#d97706", light:"rgba(217,119,6,0.12)"},
  {id:"kp_sent",     label:"КП отправлен", color:"#2563eb", light:"rgba(37,99,235,0.12)"},
  {id:"measure",     label:"Замер",        color:"#7c3aed", light:"rgba(124,58,237,0.12)"},
  {id:"install",     label:"Монтаж",       color:"#0891b2", light:"rgba(8,145,178,0.12)"},
  {id:"closed",      label:"Закрыт ✓",    color:"#16a34a", light:"rgba(22,163,74,0.12)"},
  {id:"lost",        label:"Потерян",      color:"#dc2626", light:"rgba(220,38,38,0.12)"},
];
const SOURCES = ["Instagram","WhatsApp","Рекомендация","Сайт","Выставка","Другое"];

// ─── STORAGE ──────────────────────────────────────────────────────────────────
function loadPrices(){try{const r=JSON.parse(localStorage.getItem(PRICES_KEY)||"null");if(r)return r;}catch(_){}return null;}
function savePrices(p){
  try{localStorage.setItem(PRICES_KEY,JSON.stringify(p));}catch(_){}
  dbSet("prices", p);
  // Диспатчим событие чтобы все компоненты знали об изменении цен
  window.dispatchEvent(new CustomEvent("prices-updated"));
}
function applyPrices(prices){
  if(!prices) return;
  // BUG FIX: apply to current PRODUCTS (includes custom products), not just DEFAULT_PRODUCTS
  PRODUCTS = PRODUCTS.map(p=>{
    const s=prices[p.id];
    if(!s) return p;
    return{...p, price:s.price??p.price, options:(p.options||[]).map(o=>({...o, price:s.options?.[o.id]??o.price}))};
  });
}
function loadClients(){
  try{const r=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");if(Array.isArray(r)&&r.length>0)return r;}catch(_){}
  // Защита: если localStorage пуст — пробуем sessionStorage
  try{const s=JSON.parse(sessionStorage.getItem(STORAGE_KEY+"_session")||"null");if(Array.isArray(s)&&s.length>0){console.warn("⚠️ Восстановление из sessionStorage");return s;}}catch(_){}
  return[];
}
function saveClients(data){
  // Только локальное сохранение — Firebase пишем точечно в addClient/updateClient/deleteClient
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(data));}catch(e){return false;}
  try{sessionStorage.setItem(STORAGE_KEY+"_session", JSON.stringify(data));}catch(_){}
  return true;
}

// Объединяет два массива клиентов по id.
// Если клиент есть в обоих — берётся версия с более новым updatedAt.
// Новые клиенты из любого источника добавляются.
function mergeTasks(localTasks, remoteTasks) {
  // Объединяем массивы задач: побеждает более новая версия каждой задачи
  const map = new Map();
  (localTasks || []).forEach(t => t && t.id && map.set(t.id, t));
  (remoteTasks || []).forEach(t => {
    if (!t || !t.id) return;
    const existing = map.get(t.id);
    if (!existing) {
      map.set(t.id, t); // новая задача из Firebase
    } else {
      const tL = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
      const tR = new Date(t.updatedAt || t.createdAt || 0).getTime();
      if (tR > tL + 200) map.set(t.id, t); // Firebase задача новее — берём
    }
  });
  return Array.from(map.values());
}

function mergeClients(a, b) {
  const map = new Map();
  // Сначала все из a (локальные)
  (a||[]).forEach(c => { if(c && c.id) map.set(c.id, c); });
  // Потом из b — для каждого клиента мержим умно
  (b||[]).forEach(c => {
    if(!c || !c.id) return;
    const existing = map.get(c.id);
    if(!existing) {
      map.set(c.id, c); // новый клиент из Firebase
    } else {
      const tA = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
      const tB = new Date(c.updatedAt || c.createdAt || 0).getTime();
      if(tB > tA + 500) {
        // Firebase клиент новее — берём его, но мержим задачи чтобы не потерять локальные
        map.set(c.id, {
          ...c,
          tasks: mergeTasks(existing.tasks, c.tasks),
        });
      } else {
        // Локальный клиент новее или равен — держим локального, но добавляем новые задачи из Firebase
        map.set(c.id, {
          ...existing,
          tasks: mergeTasks(existing.tasks, c.tasks),
        });
      }
    }
  });
  return Array.from(map.values()).filter(Boolean);
}


function can(session,perm){if(!session)return false;if(session.role==="admin")return true;return!!(session.perms?.[perm]);}

// ── Editing lock helpers ──────────────────────────────────────────────────────
const LOCK_TTL = 30000;
async function acquireLock(clientId, login) {
  await dbSet("editing/"+clientId, { login, ts: Date.now(), expires: Date.now()+LOCK_TTL });
}
async function releaseLock(clientId, login) {
  const lock = await dbGet("editing/"+clientId);
  if (lock && lock.login === login) await dbSet("editing/"+clientId, null);
}
async function getLock(clientId) {
  const lock = await dbGet("editing/"+clientId);
  if (!lock) return null;
  if (Date.now() > lock.expires) return null;
  return lock;
}
async function checkConflict(clientId, localUpdatedAt) {
  const remote = await dbGet("clients/"+clientId);
  if (!remote) return false;
  const remoteTs = new Date(remote.updatedAt || remote.createdAt || 0).getTime();
  const localTs  = new Date(localUpdatedAt || 0).getTime();
  return remoteTs > localTs ? remote : false;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const fmt=n=>new Intl.NumberFormat("ru-KZ").format(Math.round(n))+" ₸";
// Полные названия для КП (как в документах)
const KP_NAMES = {
  greenawn:    "Биоклиматическая пергола (Поворотная)",
  igs_premium: "Биоклиматическая пергола Premium (Поворотная)",
  toscana:     "Тентовая пергола",
  guhher:      "Тентовая пергола Guhher",
  sliding:     "Раздвижное остекление",
  guillotine:  "Гильотинное остекление",
  zip:         "Zip-шторы",
  marquise:    "Маркиза",
  railings:    "Перила алюминиевые",
  panno:       "Террасная доска Panno",
  bilancio:    "Террасная доска Bilancio",
  toscana_maxi: "Тентовая пергола Maxi",
};
// Технические характеристики продуктов для PDF КП
const PRODUCT_SPECS = {
  greenawn: {
    profile:  "Алюминий 6063-T6, порошковая окраска",
    post:     "164×164×2.7 мм (усиленная колонна)",
    lamels:   "250×53 мм Pro / 250×46 мм Basic — поворот до 110°",
    beam:     "164×260 мм, сливной лоток по периметру, пролёт до 8 м",
    motor:    "Электропривод IP65, функция TANDEM при больших площадях",
    load:     "Снеговая нагрузка до 100 кг/м²",
    wind:     "до 120 км/ч",
    drainage: "Ламели → балка со сливным лотком → колонны → дренаж",
    led:      "LED / RGB подсветка по периметру с диммером",
    install:  "Отдельностоящий / настенный / подвесной / интегрированный",
    ral:      "RAL 9016 (белый) / RAL 7016 (антрацит) / любой RAL",
    maxSize:  "Ширина до 7 м, вынос до 8 м",
  },
  igs_premium: {
    profile:  "Алюминий 6063-T6, порошковая окраска",
    post:     "164×164 мм с интегрированным водоотводом",
    lamels:   "Поворотные / сдвижные ламели, герметичность при закрытии",
    beam:     "164×260 мм, интегрированный сливной лоток",
    motor:    "Электропривод, возможен TANDEM",
    wind:     "до 100 км/ч",
    drainage: "Ламели → лоток → колонны → дренаж",
    install:  "5 конфигураций: настенный / потолочный / двойной / отдельностоящий / на крыше",
    ral:      "RAL 9016 (белый) / RAL 7016 (антрацит) / любой RAL",
    maxSize:  "Ширина до 7 м, вынос до 7.25 м",
  },
  toscana: {
    profile:  "Алюминиевый сплав, порошковая окраска, любой RAL",
    fabric:   "850 г/м², водонепроницаемое покрытие, UPF 50+",
    control:  "Электромотор + пульт ДУ в комплекте",
    guides:   "Алюминиевые рельсы, вылет до 13.5 м (модуль 4.5 м)",
    install:  "6 типов: настенный / подвесной / отдельностоящий / беседка",
    ral:      "Любой RAL",
  },
  toscana_maxi: {
    profile:  "Алюминиевый сплав, порошковая окраска, любой RAL",
    fabric:   "850 г/м², водонепроницаемое покрытие, UPF 50+",
    control:  "Электромотор + пульт ДУ в комплекте",
    guides:   "Усиленные алюминиевые рельсы, увеличенный вылет",
    install:  "Настенный / подвесной / отдельностоящий",
    ral:      "Любой RAL",
  },
  guhher: {
    profile:  "Алюминий, порошковая окраска",
    fabric:   "Акриловая ткань, защита от солнца",
    control:  "Ручное / моторизированное",
    install:  "Монтаж на готовое основание",
    ral:      "Любой RAL",
  },
  sliding: {
    profile:  "Алюминий, все детали из нержавеющей стали",
    glass:    "Тёплая серия: стеклопакет 20 мм (4+12+4) · Холодная серия: закалённое 10 мм",
    control:  "Слайдерное открывание, ролики нагрузка 120 кг/шт, 4 контура уплотнения",
    panels:   "3–12 панелей, парковка параллельно проёму, неограниченное кол-во направляющих",
    install:  "В проём / накладной, высота до 3.1 м",
    ral:      "Графит / мат. белый / любой RAL",
  },
  guillotine: {
    profile:  "Алюминиевый профиль, горизонтальная рама 30 мм, без вертикальных импостов",
    glass:    "Стеклопакет 20 мм / стеклопакет 28 мм / 28 мм с терморазрывом",
    control:  "Цепной подъёмный механизм, автоматическое управление с пультом",
    install:  "В проём / пергола / веранда / терраса",
    ral:      "Графит / мат. белый / любой RAL",
    cert:     "Серия с терморазрывом — круглогодичная эксплуатация −10°C…+40°C",
  },
  zip: {
    profile:  "Кассета 100×100×1.6 мм · Направляющие 49×39×1.6 мм · Нижняя планка 45×25.4×1.5 мм",
    fabric:   "Акриловая / затемняющая / прозрачный ПВХ / москитная сетка",
    control:  "Ручное / электромотор + пульт ДУ",
    guides:   "ZIP-фиксация ткани по всей высоте, без парусения",
    install:  "В проём / настенный, высота до 4 м",
    ral:      "Любой RAL, порошковая окраска",
  },
  marquise: {
    profile:  "Алюминий 6063-T5, кассетная конструкция",
    fabric:   "100% акрил, 300 г/м², водостойкость 360 мм",
    control:  "Электромотор + пульт / управление со смартфона",
    angle:    "Регулируемый угол наклона 15°–25°",
    size:     "Ширина до 7 м · Вылет до 3.5 м",
    install:  "Настенный монтаж",
    ral:      "Любой RAL",
  },
  panno: {
    material: "Древесно-полимерный композит (ДПК)",
    surface:  "Текстура под натуральное дерево, матовая поверхность",
    size:     "Ширина 140–150 мм, толщина 25 мм",
    install:  "На алюминиевые лаги, скрытые крепления — нет видимых саморезов",
    ral:      "Серый, коричневый, венге, натуральное дерево",
    care:     "Мытьё водой, не требует окраски и обработки",
  },
  bilancio: {
    material: "Древесно-полимерный композит (ДПК)",
    surface:  "Текстура под натуральное дерево, матовая поверхность",
    size:     "Ширина 140–150 мм, толщина 22 мм",
    install:  "На лаги, скрытые крепления",
    ral:      "Серый, коричневый, натуральное дерево",
    care:     "Мытьё водой, не требует окраски и обработки",
  },
  railings: {
    profile:  "Алюминиевый профиль, порошковая окраска",
    fill:     "Стекло 10 мм / нержавеющие вставки",
    install:  "Монтаж на готовое основание",
    ral:      "Любой RAL",
  },
};

const fmtK=n=>{if(n>=1000000)return(n/1000000).toFixed(1)+"М ₸";if(n>=1000)return Math.round(n/1000)+"К ₸";return n+" ₸";};
const fmtDate=iso=>{if(!iso)return"—";return new Date(iso).toLocaleDateString("ru-KZ",{day:"numeric",month:"short"});};
const fmtDateFull=iso=>{if(!iso)return"—";return new Date(iso).toLocaleDateString("ru-KZ",{day:"numeric",month:"short",year:"numeric"});};

// Надбавка за нестандартный размер — задаётся вручную через _priceMultiplier
// Функция-заглушка для обратной совместимости с generateClientKPHtml
function getOversizeInfo(item) { return null; }

function calcItem(item){
  const p=PRODUCTS.find(p=>p.id===item.productId);
  if(!p)return 0;
  const w=(item.width||0), d=(item.depth||0);
  const area=w*d;
  const qty=item.quantity||1;
  let t=area*p.price;
  (item.selectedOptions||[]).forEach(oid=>{
    const o=p.options.find(o=>o.id===oid);
    if(!o) return;
    if(o.flat) {
      t+=o.price;
    } else if(oid==="screen") {
      const screenArea=(w+d)*2*3;
      t+=o.price*screenArea;
    } else {
      t+=o.price*area;
    }
  });
  // Надбавка за нестандартный размер — только если задана вручную
  const multiplier = item._priceMultiplier || 1;
  return t * multiplier * qty;
}
function generateClientKPHtml(client, items, discount, kpPhoto=null, kpTemplates={}) {
  const sub    = items.reduce((s, i) => s + calcItem(i), 0);
  const total  = Math.round(sub * (1 - discount / 100));
  const prepay = Math.round(total * 0.7);
  const date   = new Date().toLocaleDateString("ru-KZ", {day:"numeric",month:"long",year:"numeric"});
  const fmtN   = n => new Intl.NumberFormat("ru-RU").format(Math.round(n));
  const LOGO   = "data:image/jpeg;base64,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";

  // Строки позиций
  const rows = items.map((item, i) => {
    const p         = PRODUCTS.find(pr => pr.id === item.productId);
    const name      = KP_NAMES[item.productId] || p?.name || item.productId;
    const area      = ((item.width || 0) * (item.depth || 0)).toFixed(1);
    const qty       = item.quantity || 1;
    const sale      = calcItem(item);
    const selOpts   = (item.selectedOptions || []).map(oid => p?.options?.find(o => o.id === oid)?.label).filter(Boolean);
    const priceNote = item._priceNote || "";
    const tpl       = (kpTemplates || {})[item.productId] || {};
    const desc      = tpl.desc || (typeof KP_PRODUCT_DESC !== "undefined" ? KP_PRODUCT_DESC[item.productId] : "") || "";
    const dimsText  = `${item.width} \u00d7 ${item.depth} \u043c = ${area} \u043c\u00b2${qty > 1 ? ", " + qty + " \u0448\u0442." : ""}`;

    return `
    <tr>
      <td class="col-num">${i+1}</td>
      <td>
        <div class="item-name">${name}</div>
        <div class="item-dims">${dimsText}${selOpts.length > 0 ? " &nbsp;·&nbsp; " + selOpts.join(" &middot; ") : ""}</div>
        ${desc ? `<div class="item-desc">${desc}</div>` : ""}
        ${priceNote ? `<div class="item-note">${priceNote}</div>` : ""}
      </td>
      <td class="col-unit">комплект</td>
      <td class="col-price">${fmtN(sale)}&nbsp;₸</td>
    </tr>`;
  }).join("");

  const included = [
    ["Оборудование + доставка + монтаж", "Включено"],
    ["Количество изделий", items.reduce((s,i)=>s+(i.quantity||1),0) + " шт."],
  ];

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>КП — ${client.name} — IGS Outdoor</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Inter',Arial,Helvetica,sans-serif;font-size:13px;color:#232b35;background:#ffffff;-webkit-text-size-adjust:100%;line-height:1.55;}
  @page{margin:12mm 10mm;size:A4;}
  @media print{*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}}
  .wrap{max-width:740px;margin:0 auto;padding:28px 32px;}

  /* ── HEADER ── */
  .kp-header{display:flex;align-items:center;justify-content:space-between;padding-bottom:18px;border-bottom:2px solid #b8965a;margin-bottom:24px;}
  .kp-header-right{text-align:right;}
  .kp-header-right .kp-label{font-size:9px;font-weight:700;color:#b8965a;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;}
  .kp-header-right .kp-subtitle{font-size:10px;color:#6b7a8d;letter-spacing:0.5px;text-transform:uppercase;}
  .kp-header-right .kp-date{font-size:11px;color:#6b7a8d;margin-top:2px;}

  /* ── CLIENT BLOCK ── */
  .kp-client{display:flex;align-items:stretch;margin-bottom:${kpPhoto ? 0 : 24}px;border:1px solid #e8ecf0;border-radius:8px;overflow:hidden;}
  .kp-client-bar{width:5px;background:linear-gradient(180deg,#b8965a 0%,#8a6f3e 100%);flex-shrink:0;}
  .kp-client-body{padding:16px 20px;flex:1;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;background:#fafbfc;}
  .kp-client-name{font-size:18px;font-weight:800;color:#3d4a5c;margin-bottom:4px;letter-spacing:-0.3px;}
  .kp-client-meta{font-size:11px;color:#6b7a8d;margin-top:2px;}
  .kp-discount{background:linear-gradient(135deg,#3d4a5c 0%,#4d5e73 100%);color:#b8965a;font-size:11px;font-weight:800;padding:7px 18px;letter-spacing:1px;border-radius:20px;white-space:nowrap;}

  /* ── PHOTO ── */
  .kp-photo{margin:0 -32px 24px;position:relative;}
  .kp-photo img{width:100%;display:block;max-height:460px;object-fit:cover;}
  .kp-photo-badge{position:absolute;bottom:10px;right:12px;background:rgba(0,0,0,0.55);backdrop-filter:blur(4px);color:rgba(255,255,255,0.75);font-size:9px;padding:3px 9px;border-radius:10px;letter-spacing:0.5px;}

  /* ── SECTION TITLES ── */
  .kp-section{margin:28px 0 12px;}
  .kp-section-title{font-size:9px;font-weight:700;color:#b8965a;letter-spacing:2.5px;text-transform:uppercase;display:flex;align-items:center;gap:10px;}
  .kp-section-title::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,#b8965a40,transparent);}

  /* ── PROJECT INFO GRID ── */
  .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:4px;}
  .info-cell{padding:10px 14px;background:#fafbfc;border:1px solid #e8ecf0;border-radius:6px;}
  .info-cell-label{font-size:9px;font-weight:700;color:#b8965a;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:3px;}
  .info-cell-value{font-size:12px;color:#3d4a5c;font-weight:500;}

  /* ── ITEMS TABLE ── */
  .items-table{width:100%;border-collapse:collapse;margin-bottom:4px;}
  .items-table thead tr{background:#3d4a5c;}
  .items-table thead th{padding:10px 14px;font-size:10px;font-weight:700;color:#b8965a;text-transform:uppercase;letter-spacing:1px;border:none;}
  .items-table thead th:first-child{border-radius:6px 0 0 0;text-align:center;width:36px;}
  .items-table thead th:last-child{border-radius:0 6px 0 0;text-align:right;white-space:nowrap;}
  .items-table thead th.col-name{text-align:left;}
  .items-table thead th.col-unit{text-align:center;white-space:nowrap;}
  .items-table tbody tr{border-bottom:1px solid #e8ecf0;}
  .items-table tbody tr:last-child{border-bottom:none;}
  .items-table tbody tr:nth-child(even){background:#fafbfc;}
  .items-table tbody td{padding:12px 14px;font-size:12px;vertical-align:top;color:#232b35;}
  .items-table tbody td.col-num{text-align:center;font-weight:700;color:#b8965a;width:36px;}
  .items-table tbody td.col-unit{text-align:center;color:#6b7a8d;white-space:nowrap;}
  .items-table tbody td.col-price{text-align:right;font-weight:700;color:#3d4a5c;white-space:nowrap;font-size:13px;}
  .item-name{font-weight:700;color:#232b35;margin-bottom:3px;font-size:13px;}
  .item-dims{font-size:11px;color:#8a96a3;margin-bottom:2px;}
  .item-desc{font-size:11px;color:#555e6b;line-height:1.65;margin-top:6px;padding-top:6px;border-top:1px solid #e8ecf0;}
  .item-note{font-size:11px;color:#7a6228;margin-top:5px;padding:4px 10px;background:#fdf8ee;border-left:2px solid #b8965a;border-radius:0 4px 4px 0;}

  /* ── TOTALS ── */
  .totals-wrap{border:1px solid #e8ecf0;border-radius:8px;overflow:hidden;margin-bottom:8px;}
  .totals-row{display:flex;justify-content:space-between;padding:9px 16px;border-bottom:1px solid #e8ecf0;font-size:12px;}
  .totals-row:last-child{border-bottom:none;}
  .totals-row.total-final{background:#3d4a5c;padding:12px 16px;}
  .totals-row.total-final .t-label{color:#fff;font-weight:700;font-size:12px;}
  .totals-row.total-final .t-value{color:#b8965a;font-weight:800;font-size:15px;letter-spacing:-0.5px;}
  .t-label{color:#6b7a8d;font-weight:500;}
  .t-value{font-weight:600;color:#3d4a5c;}
  .kp-footnote{font-size:10px;color:#9aa3ae;font-style:italic;margin-bottom:4px;}

  /* ── CONDITIONS ── */
  .cond-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
  .cond-cell{padding:10px 14px;border:1px solid #e8ecf0;border-radius:6px;background:#fafbfc;}
  .cond-label{font-size:9px;font-weight:700;color:#b8965a;letter-spacing:1px;text-transform:uppercase;margin-bottom:3px;}
  .cond-value{font-size:11px;color:#3d4a5c;font-weight:500;}

  /* ── FOOTER ── */
  .kp-footer{margin-top:32px;padding-top:20px;border-top:1px solid #e8ecf0;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:16px;}
  .kp-footer-brand{font-size:16px;font-weight:800;color:#3d4a5c;letter-spacing:-0.5px;margin-bottom:4px;}
  .kp-footer-brand span{color:#b8965a;}
  .kp-footer-contacts{font-size:11px;color:#6b7a8d;line-height:1.7;}
  .kp-footer-slogan{font-size:9px;color:#b8965a;letter-spacing:2px;text-transform:uppercase;}
</style>
</head>
<body>
<div class="wrap">

  <!-- ── ШАПКА ─────────────────────────────────── -->
  <div class="kp-header">
    <div>
      <img src="${LOGO}" alt="IGS Outdoor" style="height:56px;display:block;object-fit:contain;object-position:left center;"/>
      <div style="font-size:8px;color:#9aa3ae;margin-top:5px;letter-spacing:2px;text-transform:uppercase;">Системы для комфорта на открытом воздухе · Алматы</div>
    </div>
    <div class="kp-header-right">
      <div class="kp-label">Коммерческое предложение</div>
      <div class="kp-subtitle">+7 705 333 37 72</div>
      <div class="kp-date">${date}</div>
    </div>
  </div>

  <!-- ── КЛИЕНТ ─────────────────────────────────── -->
  <div class="kp-client">
    <div class="kp-client-bar"></div>
    <div class="kp-client-body">
      <div>
        <div style="font-size:8px;font-weight:700;color:#b8965a;letter-spacing:2px;text-transform:uppercase;margin-bottom:5px;">Подготовлено для</div>
        <div class="kp-client-name">${client.name}</div>
        ${client.phone ? `<div class="kp-client-meta">${client.phone}</div>` : ""}
        ${client.address ? `<div class="kp-client-meta">📍 ${client.address}</div>` : ""}
      </div>
      ${discount > 0 ? `<div class="kp-discount">СКИДКА ${discount}%</div>` : ""}
    </div>
  </div>

  <!-- ── ФОТО ─────────────────────────────────── -->
  ${kpPhoto ? `
  <div class="kp-photo">
    <img src="${kpPhoto}" alt="Визуализация объекта"/>
    <div class="kp-photo-badge">AI-визуализация · IGS Outdoor</div>
  </div>` : `<div style="margin-bottom:24px;"></div>`}

  <!-- ── ИНФОРМАЦИЯ О ПРОЕКТЕ ─────────────────── -->
  <div class="kp-section"><div class="kp-section-title">Информация о проекте</div></div>
  <div class="info-grid" style="margin-bottom:24px;">
    <div class="info-cell">
      <div class="info-cell-label">Клиент</div>
      <div class="info-cell-value">${client.name}</div>
    </div>
    <div class="info-cell">
      <div class="info-cell-label">Монтаж</div>
      <div class="info-cell-value">Под ключ — оборудование, доставка, монтаж</div>
    </div>
    ${client.address ? `<div class="info-cell">
      <div class="info-cell-label">Объект</div>
      <div class="info-cell-value">${client.address}</div>
    </div>` : ""}
    ${client.phone ? `<div class="info-cell">
      <div class="info-cell-label">Телефон</div>
      <div class="info-cell-value">${client.phone}</div>
    </div>` : ""}
  </div>

  <!-- ── СОСТАВ ПРЕДЛОЖЕНИЯ ───────────────────── -->
  <div class="kp-section"><div class="kp-section-title">Состав предложения</div></div>
  <table class="items-table" style="margin-bottom:24px;">
    <thead>
      <tr>
        <th>№</th>
        <th class="col-name">Наименование</th>
        <th class="col-unit">Ед.</th>
        <th>Стоимость</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <!-- ── СТОИМОСТЬ ────────────────────────────── -->
  <div class="kp-section"><div class="kp-section-title">Стоимость</div></div>
  <div class="totals-wrap" style="margin-bottom:24px;">
    <div class="totals-row"><span class="t-label">Оборудование + доставка + монтаж</span><span class="t-value">Включено</span></div>
    <div class="totals-row"><span class="t-label">Количество изделий</span><span class="t-value">${items.reduce((s,i)=>s+(i.quantity||1),0)} шт.</span></div>
    <div class="totals-row total-final">
      <span class="t-label">ИТОГО под ключ${discount > 0 ? ` (скидка ${discount}%)` : ""}</span>
      <span class="t-value">${fmtN(total)}&nbsp;₸</span>
    </div>
  </div>
  <div class="kp-footnote">* Цена указана за полный комплект под ключ: оборудование, доставка, монтаж.</div>

  <!-- ── УСЛОВИЯ ──────────────────────────────── -->
  <div class="kp-section"><div class="kp-section-title">Условия сотрудничества</div></div>
  <div class="cond-grid" style="margin-bottom:32px;">
    <div class="cond-cell"><div class="cond-label">Срок действия КП</div><div class="cond-value">5 рабочих дней</div></div>
    <div class="cond-cell"><div class="cond-label">Предоплата</div><div class="cond-value">70% при подписании — ${fmtN(prepay)} ₸</div></div>
    <div class="cond-cell"><div class="cond-label">Остаток</div><div class="cond-value">30% перед монтажом — ${fmtN(total - prepay)} ₸</div></div>
    <div class="cond-cell"><div class="cond-label">Срок изготовления</div><div class="cond-value">45 рабочих дней с предоплаты</div></div>
    <div class="cond-cell"><div class="cond-label">Гарантия</div><div class="cond-value">1 год на конструкцию и комплектующие</div></div>
    <div class="cond-cell"><div class="cond-label">Замер</div><div class="cond-value">Бесплатный выезд на объект</div></div>
  </div>

  <!-- ── ПОДПИСЬ ──────────────────────────────── -->
  <div class="kp-footer">
    <div>
      <div class="kp-footer-brand">IGS <span>Outdoor</span></div>
      <div class="kp-footer-slogan">Комфорт на открытом воздухе</div>
    </div>
    <div class="kp-footer-contacts">
      <div>+7 707 577 12 34 &nbsp;|&nbsp; +7 705 333 37 72</div>
      <div>Алматы · ул. Сагдат Нурмагамбетова 140/10</div>
      <div>Ежедневно 9:00 – 22:00</div>
    </div>
  </div>

</div>
</body></html>`;}


function generateKPText(client,items,discount=0){const sub=items.reduce((s,i)=>s+calcItem(i),0);const total=Math.round(sub*(1-discount/100));const prepay=Math.round(total*0.7);const date=new Date().toLocaleDateString("ru-KZ",{day:"numeric",month:"long",year:"numeric"});let t=`🌿 *КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ*\n━━━━━━━━━━━━━━━━━━━━\n🏢 *IGS Outdoor*\n📅 ${date}\n👤 *${client.name}*\n`;if(client.address)t+=`📍 ${client.address}\n`;t+="\n";items.forEach((item,i)=>{const p=PRODUCTS.find(p=>p.id===item.productId);const area=(item.width*item.depth).toFixed(1);const qty=item.quantity||1;t+=`*${i+1}. ${KP_NAMES[item.productId]||p.name}*${item._autoGlazing?` _(${item._parentNote})_`:""}
\n   📐 ${item.width} × ${item.depth} м = ${(item.width*item.depth).toFixed(1)} м²\n   🔢 Количество: ${qty} шт\n   💰 ${fmt(p.price)}/м²\n`;const opts=(item.selectedOptions||[]).map(oid=>p.options.find(o=>o.id===oid)?.label).filter(Boolean);if(opts.length)t+=`   ⚙️ ${opts.join(", ")}\n`;t+=`   💵 *${fmt(calcItem(item))}*\n\n`;});t+=`━━━━━━━━━━━━━━━━━━━━\n`;if(discount>0)t+=`🏷️ Скидка: *${discount}%*\n`;t+=`💳 *ИТОГО: ${fmt(total)}*\n\n✅ Предоплата 70%: *${fmt(prepay)}*\n✅ Остаток 30%: *${fmt(total-prepay)}*\n\n📞 IGS Outdoor\n_Комфорт под открытым небом_ 🌿`;return t;}

// ─── THEME ────────────────────────────────────────────────────────────────────
const T = {
  bg: "#09090b",
  surface: "#111113",
  card: "#151517",
  elevated: "#1a1a1d",
  glass: "rgba(255,255,255,0.02)",
  border: "rgba(255,255,255,0.07)",
  borderHover: "rgba(184,150,90,0.35)",
  gold: "#b8965a",
  goldDim: "rgba(184,150,90,0.25)",
  goldBg: "rgba(184,150,90,0.06)",
  green: "#5a9a6a",
  greenBg: "rgba(90,154,106,0.08)",
  text: "#eae6e1",
  textSec: "rgba(255,255,255,0.45)",
  textDim: "rgba(255,255,255,0.2)",
  danger: "#c45454",
  dangerBg: "rgba(196,84,84,0.08)",
  font: "'General Sans',system-ui,-apple-system,sans-serif",
  mono: "'IBM Plex Mono',monospace",
  serif: "'Instrument Serif',Georgia,serif",
};

// ─── HOOKS ────────────────────────────────────────────────────────────────────
function useIsMobile(){const[m,setM]=useState(()=>window.innerWidth<768);useEffect(()=>{const fn=()=>setM(window.innerWidth<768);window.addEventListener("resize",fn);return()=>window.removeEventListener("resize",fn);},[]);return m;}

// ─── WEB PUSH УВЕДОМЛЕНИЯ ─────────────────────────────────────────────────────
function useNotifications() {
  const [permission, setPermission] = useState(()=>
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );

  // Регистрируем Service Worker при загрузке
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(e => console.log('SW:', e));
    }
  }, []);

  async function requestPermission() {
    if (typeof Notification === 'undefined') return false;
    const result = await Notification.requestPermission();
    setPermission(result);
    return result === 'granted';
  }

  function notify(title, body, url='/') {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    // Через Service Worker для лучшей совместимости
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(reg => {
        reg.showNotification(title, {
          body,
          icon: '/favicon.ico',
          tag: 'igs-lead-' + Date.now(),
          requireInteraction: true,
          data: { url },
        });
      });
    } else {
      // Fallback — обычное уведомление
      new Notification(title, { body, icon: '/favicon.ico' });
    }
  }

  return { permission, requestPermission, notify };
}


// ─── GLOBAL STYLES ────────────────────────────────────────────────────────────
function GlobalStyles(){return(<style>{`
  @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
  @import url('https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  html,body,#root{height:100%;}
  body{background:${T.bg};color:${T.text};font-family:${T.font};-webkit-tap-highlight-color:transparent;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;}
  ::-webkit-scrollbar{width:4px;height:4px;}
  ::-webkit-scrollbar-track{background:transparent;}
  ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:4px;}
  ::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.15);}
  input,textarea,select,button{font-family:${T.font};}
  a{text-decoration:none;}
  ::selection{background:rgba(184,150,90,0.25);color:#fff;}
  @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  @keyframes slideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
  .fade-in{animation:fadeIn 0.5s cubic-bezier(0.22,1,0.36,1) forwards;}
  .stagger-1{animation-delay:0.06s;opacity:0;}
  .stagger-2{animation-delay:0.12s;opacity:0;}
  .stagger-3{animation-delay:0.18s;opacity:0;}
  .stagger-4{animation-delay:0.24s;opacity:0;}
  .hover-lift{transition:transform 0.25s cubic-bezier(0.22,1,0.36,1),box-shadow 0.25s,border-color 0.25s;}
  .hover-lift:hover{transform:translateY(-1px);box-shadow:0 12px 40px rgba(0,0,0,0.4);}
  select option{background:#1a1a1d;color:#eae6e1;}
`}</style>);}

// ─── SHARED UI ────────────────────────────────────────────────────────────────
const Tag=({color,children,style={}})=>(
  <span style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:11,fontWeight:600,color,letterSpacing:0.3,...style}}>
    <span style={{width:6,height:6,borderRadius:3,background:color,flexShrink:0}}/>
    {children}
  </span>
);

const Btn=({variant="primary",onClick,disabled,children,style={},href,...rest})=>{
  const base={display:"inline-flex",alignItems:"center",gap:7,borderRadius:10,padding:"10px 20px",fontWeight:600,fontSize:13,cursor:disabled?"not-allowed":"pointer",border:"none",fontFamily:T.font,transition:"all 0.25s cubic-bezier(0.22,1,0.36,1)",opacity:disabled?0.35:1,letterSpacing:0.2,...style};
  const vs={
    primary:{background:T.gold,color:"#0a0a0b"},
    green:{background:T.green,color:"#0a0a0b"},
    ghost:{background:"transparent",color:T.text,border:`1px solid ${T.border}`},
    danger:{background:T.dangerBg,color:T.danger,border:`1px solid rgba(196,84,84,0.15)`},
    elevated:{background:T.elevated,color:T.text,border:`1px solid ${T.border}`}
  };
  if(href)return<a href={href} style={{...base,...vs[variant]}} {...rest}>{children}</a>;
  return<button onClick={disabled?undefined:onClick} style={{...base,...vs[variant]}} {...rest}>{children}</button>;
};

const Inp=({style={},...props})=>(
  <input style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,padding:"11px 14px",color:T.text,fontSize:14,width:"100%",outline:"none",transition:"all 0.2s ease",fontFamily:T.font,...style}} onFocus={e=>{e.target.style.borderColor="rgba(184,150,90,0.4)";e.target.style.boxShadow="0 0 0 2px rgba(184,150,90,0.08)";}} onBlur={e=>{e.target.style.borderColor=T.border;e.target.style.boxShadow="none";}} {...props}/>
);

const Card=({children,style={},className="",...rest})=>(
  <div className={`hover-lift ${className}`} style={{background:T.card,borderRadius:12,border:`1px solid ${T.border}`,transition:"all 0.25s",...style}} {...rest}>{children}</div>
);

const GlassCard=({children,style={},...rest})=>(
  <div style={{background:T.card,borderRadius:12,border:`1px solid ${T.border}`,boxShadow:"0 2px 16px rgba(0,0,0,0.2)",...style}} {...rest}>{children}</div>
);

// ─── BAR CHART ────────────────────────────────────────────────────────────────
function BarChart({data,color=T.gold}){
  const max=Math.max(...data.map(d=>d.value),1);
  return(
    <div style={{display:"flex",alignItems:"flex-end",gap:6,height:64}}>
      {data.map((d,i)=>(
        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
          <div style={{width:"100%",background:`${color}08`,borderRadius:"6px 6px 0 0",height:50,display:"flex",alignItems:"flex-end",overflow:"hidden"}}>
            <div style={{width:"100%",height:`${(d.value/max)*100}%`,background:`linear-gradient(180deg,${color},${color}66)`,borderRadius:"6px 6px 0 0",transition:"height 0.8s cubic-bezier(0.16,1,0.3,1)",minHeight:d.value?4:0}}/>
          </div>
          <div style={{fontSize:9,color:T.textDim,fontFamily:T.mono,letterSpacing:-0.3}}>{d.label}</div>
        </div>
      ))}
    </div>
  );
}

// ─── DONUT CHART ──────────────────────────────────────────────────────────────
function Donut({segs,size=120}){
  const total=segs.reduce((s,g)=>s+g.value,0)||1;
  const r=42,cx=60,cy=60,sw=11,C2=2*Math.PI*r;
  let cum=0;
  return(
    <svg width={size} height={size} viewBox="0 0 120 120">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={sw}/>
      {segs.filter(s=>s.value>0).map((s,i)=>{
        const pct=s.value/total,dash=C2*pct,off=C2*(1-cum);
        const el=<circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth={sw} strokeDasharray={`${dash} ${C2-dash}`} strokeDashoffset={off} strokeLinecap="round" style={{transform:"rotate(-90deg)",transformOrigin:`${cx}px ${cy}px`,transition:"stroke-dasharray 0.8s cubic-bezier(0.16,1,0.3,1)"}}/>;
        cum+=pct;return el;
      })}
      <text x={cx} y={cy-2} textAnchor="middle" fill={T.gold} fontSize="22" fontWeight="800" fontFamily={T.mono}>{total}</text>
      <text x={cx} y={cy+14} textAnchor="middle" fill={T.textSec} fontSize="9" fontFamily={T.font}>клиентов</text>
    </svg>
  );
}

// ─── DRAWER ───────────────────────────────────────────────────────────────────
function Drawer({open,onClose,title,children,width=440}){
  if(!open)return null;
  return createPortal(
    <>
      <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:8000,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(6px)"}}/>
      <div style={{position:"fixed",top:0,right:0,bottom:0,width:Math.min(width,window.innerWidth-16),background:"#111113",borderLeft:`1px solid ${T.border}`,zIndex:8001,display:"flex",flexDirection:"column",boxShadow:"-12px 0 48px rgba(0,0,0,0.5)",animation:"slideIn 0.3s cubic-bezier(0.16,1,0.3,1)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"20px 22px",borderBottom:`1px solid ${T.border}`,flexShrink:0}}>
          <div style={{fontSize:16,fontWeight:700}}>{title}</div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,borderRadius:10,width:34,height:34,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:16,color:T.textSec,transition:"all 0.2s"}}>✕</button>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"20px 22px"}}>{children}</div>
      </div>
    </>,
    document.body
  );
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────
// Баннер включения уведомлений — с iOS-инструкцией
function NotifPermissionBanner() {
  const [show, setShow] = useState(false);
  const [granted, setGranted] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  const ios = isIOS();
  const iosPwa = isIOSPWA();

  useEffect(() => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") { setGranted(true); return; }
    if (Notification.permission === "denied") return;
    const t = setTimeout(() => setShow(true), 4000);
    return () => clearTimeout(t);
  }, []);

  if (granted || !show) return null;

  return (
    <>
      <div style={{
        position:"fixed", bottom:70, left:12, right:12, zIndex:200,
        background:"linear-gradient(135deg,#1a1a1d,#111)",
        border:"1px solid rgba(184,150,90,0.35)",
        borderRadius:16, padding:"14px 16px",
        boxShadow:"0 8px 32px rgba(0,0,0,0.5)",
        display:"flex", alignItems:"center", gap:12,
      }}>
        <div style={{fontSize:28, flexShrink:0}}>🔔</div>
        <div style={{flex:1}}>
          <div style={{fontSize:13, fontWeight:700, color:"#fff", marginBottom:2}}>
            {ios&&!iosPwa ? "Установите CRM на экран" : "Включить уведомления"}
          </div>
          <div style={{fontSize:11, color:"rgba(255,255,255,0.45)", lineHeight:1.4}}>
            {ios&&!iosPwa
              ? "На iPhone уведомления работают только через иконку на главном экране"
              : "Напоминания о звонках и замерах даже когда приложение закрыто"
            }
          </div>
        </div>
        <div style={{display:"flex", flexDirection:"column", gap:6, flexShrink:0}}>
          <button onClick={async () => {
            if (ios && !iosPwa) { setShowGuide(true); return; }
            const ok = await requestNotifPermission();
            setGranted(ok); setShow(false);
          }} style={{
            background:"linear-gradient(135deg,#b8965a,#d4b878)",
            color:"#09090b", border:"none", borderRadius:10,
            padding:"8px 14px", fontSize:12, fontWeight:800,
            cursor:"pointer", fontFamily:T.font, whiteSpace:"nowrap",
            WebkitTapHighlightColor:"transparent",
          }}>
            {ios&&!iosPwa ? "Как?" : "Включить"}
          </button>
          <button onClick={() => setShow(false)} style={{
            background:"transparent", border:"none",
            color:"rgba(255,255,255,0.3)", fontSize:11,
            cursor:"pointer", fontFamily:T.font,
          }}>
            Не сейчас
          </button>
        </div>
      </div>

      {/* iOS Install Guide */}
      {showGuide&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:9000,
          display:"flex",alignItems:"flex-end",justifyContent:"center",padding:16}}
          onClick={()=>setShowGuide(false)}>
          <div style={{background:"#1a1a1d",border:"1px solid rgba(184,150,90,0.4)",
            borderRadius:20,padding:28,width:"100%",maxWidth:420,marginBottom:8}}
            onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:20,fontWeight:800,color:T.gold,marginBottom:16,textAlign:"center"}}>
              📲 Установка на iPhone
            </div>
            {[
              ["1", "Нажмите", "кнопку «Поделиться» (□↑) внизу Safari"],
              ["2", "Выберите", "«На экран Домой»"],
              ["3", "Откройте", "CRM через иконку на экране"],
              ["4", "Нажмите", "«Включить уведомления»"],
            ].map(([n,bold,rest])=>(
              <div key={n} style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:14}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:T.gold,color:"#09090b",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:13,fontWeight:800,flexShrink:0}}>{n}</div>
                <div style={{fontSize:14,color:"rgba(255,255,255,0.8)",lineHeight:1.5}}>
                  <span style={{fontWeight:700,color:"#fff"}}>{bold}</span> {rest}
                </div>
              </div>
            ))}
            <div style={{background:"rgba(184,150,90,0.08)",border:"1px solid rgba(184,150,90,0.2)",
              borderRadius:10,padding:12,fontSize:12,color:T.textSec,marginBottom:16,lineHeight:1.5}}>
              ℹ️ iOS 16.4+ обязателен. Уведомления работают только из PWA-режима (через иконку, не Safari).
            </div>
            <button onClick={()=>{setShowGuide(false);setShow(false);}}
              style={{width:"100%",padding:13,background:T.gold,color:"#09090b",
                border:"none",borderRadius:12,fontWeight:700,fontSize:14,cursor:"pointer",
                WebkitTapHighlightColor:"transparent"}}>
              Понятно
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function PWAInstallBtn() {
  const [canInstall, setCanInstall] = useState(false);
  const [showIosHint, setShowIosHint] = useState(false);

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isInStandalone = window.navigator.standalone === true;
  const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);

  useEffect(()=>{
    if(_pwaPrompt) setCanInstall(true);
    const h = () => setCanInstall(true);
    window.addEventListener("pwa-installable", h);
    return () => window.removeEventListener("pwa-installable", h);
  },[]);

  // Уже установлено
  if (isInStandalone) return null;

  // Android — стандартная кнопка
  if (canInstall) return (
    <button onClick={()=>{
      if(_pwaPrompt){
        _pwaPrompt.prompt();
        _pwaPrompt.userChoice.then(()=>{ _pwaPrompt=null; setCanInstall(false); });
      }
    }} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:7,width:"100%",
      background:"rgba(184,150,90,0.08)",border:"1px solid rgba(184,150,90,0.25)",
      borderRadius:8,padding:"7px",color:T.gold,fontSize:11,cursor:"pointer",
      fontFamily:T.font,fontWeight:700,marginBottom:6}}>
      📲 Установить приложение
    </button>
  );

  // iOS Safari — показываем инструкцию
  if (isIOS && isSafari) return (
    <>
      <button onClick={()=>setShowIosHint(!showIosHint)}
        style={{display:"flex",alignItems:"center",justifyContent:"center",gap:7,width:"100%",
          background:"rgba(184,150,90,0.08)",border:"1px solid rgba(184,150,90,0.25)",
          borderRadius:8,padding:"7px",color:T.gold,fontSize:11,cursor:"pointer",
          fontFamily:T.font,fontWeight:700,marginBottom:showIosHint?0:6}}>
        📲 Установить на iPhone
      </button>
      {showIosHint&&(
        <div style={{background:"rgba(184,150,90,0.06)",border:"1px solid rgba(184,150,90,0.2)",
          borderRadius:"0 0 8px 8px",padding:"12px 14px",marginBottom:6,fontSize:11,color:T.textSec,lineHeight:1.7}}>
          <div style={{fontWeight:700,color:T.gold,marginBottom:6}}>Как установить на iPhone:</div>
          <div style={{marginBottom:8}}>Открой эту страницу в <b style={{color:T.text}}>Safari</b> (не Chrome)</div>
          <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:6}}>
            <div style={{background:"rgba(184,150,90,0.2)",borderRadius:"50%",width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:11,fontWeight:700,color:T.gold}}>1</div>
            <div>Нажми кнопку <b style={{color:T.text}}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{verticalAlign:"middle",margin:"0 2px"}}>
                <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13"/>
              </svg>
              Поделиться
            </b> — она в адресной строке справа <b style={{color:T.text}}>(или внизу экрана)</b></div>
          </div>
          <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:6}}>
            <div style={{background:"rgba(184,150,90,0.2)",borderRadius:"50%",width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:11,fontWeight:700,color:T.gold}}>2</div>
            <div>Прокрути список вниз → выбери <b style={{color:T.text}}>«На экран "Домой"»</b></div>
          </div>
          <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:8}}>
            <div style={{background:"rgba(184,150,90,0.2)",borderRadius:"50%",width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:11,fontWeight:700,color:T.gold}}>3</div>
            <div>Нажми <b style={{color:T.text}}>«Добавить»</b> — готово!</div>
          </div>
          <div style={{color:T.textDim,fontSize:10,borderTop:"1px solid rgba(255,255,255,0.06)",paddingTop:6}}>
            💡 Если не видишь «На экран "Домой"» — прокрути список иконок в меню влево
          </div>
        </div>
      )}
    </>
  );

  return null;
}

function Sidebar({page,setPage,currentUser,onLogout,onShowUserManager}){
  const allTabs=[
    {id:"dashboard",label:"Главная",perm:"view_dashboard"},
    {id:"clients",label:"Клиенты",perm:"view_clients"},
    {id:"bot_leads",label:"Лиды 🤖",perm:"view_dashboard"},
    {id:"meetings",label:"Встречи 📅",perm:"view_dashboard"},
    {id:"glass",label:"Стекло 🪟",perm:"view_calculator"},
    {id:"calculator",label:"Расчёт КП",perm:"view_calculator"},
    {id:"catalog",label:"Каталог",perm:"view_catalog"},
    {id:"kp_templates",label:"Редактор КП",perm:"edit_prices"},
    {id:"prices",label:"Цены",perm:"edit_prices"},
    {id:"visualizer",label:"Визуализация",perm:"view_calculator"},
    {id:"trello",label:"Задачи 📋",perm:"view_dashboard"},
  ];
  const tabs=allTabs.filter(t=>can(currentUser,t.perm));
  return(
    <div style={{width:220,minHeight:"100vh",background:T.surface,borderRight:`1px solid ${T.border}`,display:"flex",flexDirection:"column",position:"fixed",top:0,left:0,zIndex:40}}>
      <div style={{padding:"28px 24px 24px"}}>
        <div style={{fontSize:16,fontWeight:600,color:T.gold,fontFamily:T.serif,letterSpacing:0.3}}>IGS Outdoor</div>
        <div style={{fontSize:9,color:T.textDim,letterSpacing:3,fontWeight:600,marginTop:4,textTransform:"uppercase"}}>CRM</div>
      </div>

      <div style={{margin:"0 20px",height:1,background:T.border}}/>

      <nav style={{flex:1,padding:"16px 12px",display:"flex",flexDirection:"column",gap:2}}>
        {tabs.map(t=>{
          const active=page===t.id;
          return(
            <button key={t.id} onClick={()=>setPage(t.id)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:8,background:active?T.goldBg:"transparent",border:"none",cursor:"pointer",textAlign:"left",transition:"all 0.2s",width:"100%"}}>
              {active&&<div style={{width:3,height:16,borderRadius:2,background:T.gold,flexShrink:0}}/>}
              <span style={{fontSize:13,fontWeight:active?600:400,color:active?T.text:T.textSec,transition:"color 0.2s"}}>{t.label}</span>
            </button>
          );
        })}
      </nav>

      <div style={{padding:"16px 20px 24px",borderTop:`1px solid ${T.border}`}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
          <div style={{width:32,height:32,borderRadius:8,background:T.elevated,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:T.textSec,fontWeight:700,fontFamily:T.mono}}>
            {currentUser?.login?.[0]?.toUpperCase()||"?"}
          </div>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:T.text}}>{currentUser?.login}</div>
            <div style={{fontSize:10,color:T.textDim,marginTop:1}}>{currentUser?.role==="admin"?"Администратор":"Пользователь"}</div>
          </div>
        </div>
        <PWAInstallBtn/>
        <div style={{display:"flex",gap:6}}>
          {onShowUserManager&&<button onClick={onShowUserManager} style={{flex:1,background:T.elevated,border:`1px solid ${T.border}`,borderRadius:7,padding:"6px",color:T.textSec,fontSize:11,cursor:"pointer",fontFamily:T.font,fontWeight:500}}>Юзеры</button>}
          <button onClick={onLogout} style={{flex:1,background:T.dangerBg,border:`1px solid rgba(196,84,84,0.12)`,borderRadius:7,padding:"6px",color:T.danger,fontSize:11,cursor:"pointer",fontFamily:T.font,fontWeight:500}}>Выйти</button>
        </div>
      </div>
    </div>
  );
}

// ─── BOTTOM NAV ───────────────────────────────────────────────────────────────
function BottomNav({page,setPage,currentUser}){
  const mainTabs=[
    {id:"dashboard", label:"Главная", emoji:"🏠", perm:"view_dashboard"},
    {id:"clients",   label:"Клиенты", emoji:"👥", perm:"view_clients"},
    {id:"calculator",label:"Расчёт",  emoji:"🧮", perm:"view_calculator"},
    {id:"meetings",  label:"Встречи", emoji:"📅", perm:"view_dashboard"},
    {id:"more",      label:"Ещё",     emoji:"···",perm:"view_dashboard"},
  ];
  const moreTabs=[
    {id:"bot_leads",     label:"Лиды",        perm:"view_dashboard"},
    {id:"glass",         label:"Стекло",      perm:"view_calculator"},
    {id:"catalog",       label:"Каталог",     perm:"view_catalog"},
    {id:"kp_templates",  label:"Редактор КП", perm:"edit_prices"},
    {id:"prices",        label:"Цены",        perm:"edit_prices"},
    {id:"visualizer",    label:"Визуализация",perm:"view_calculator"},
    {id:"trello",        label:"Задачи",      perm:"view_dashboard"},
  ];
  const [showMore, setShowMore] = useState(false);
  const tabs=mainTabs.filter(t=>can(currentUser,t.perm));
  const moreVisible=moreTabs.filter(t=>can(currentUser,t.perm));
  const isMorePage=moreTabs.some(t=>t.id===page);

  return(
    <>
      {showMore&&<div onClick={()=>setShowMore(false)} style={{position:"fixed",inset:0,zIndex:49,background:"rgba(0,0,0,0.4)"}}/>}
      {showMore&&(
        <div style={{position:"fixed",bottom:58,left:0,right:0,zIndex:50,background:T.surface,borderTop:`1px solid ${T.border}`,boxShadow:"0 -8px 24px rgba(0,0,0,0.4)"}}>
          {moreVisible.map(t=>(
            <button key={t.id} onClick={()=>{setPage(t.id);setShowMore(false);}}
              style={{width:"100%",background:page===t.id?"rgba(184,150,90,0.1)":"none",border:"none",
                padding:"15px 20px",cursor:"pointer",display:"flex",alignItems:"center",
                justifyContent:"space-between",borderBottom:`1px solid ${T.border}`}}>
              <span style={{fontSize:14,color:page===t.id?T.gold:T.text,fontWeight:page===t.id?700:400,fontFamily:T.font}}>{t.label}</span>
              {page===t.id&&<div style={{width:6,height:6,borderRadius:3,background:T.gold}}/>}
            </button>
          ))}
        </div>
      )}
      <div style={{position:"fixed",bottom:0,left:0,right:0,background:T.surface,
        borderTop:`1px solid ${T.border}`,display:"flex",zIndex:50,
        paddingBottom:"env(safe-area-inset-bottom)",height:58}}>
        {tabs.map(t=>{
          const isMore=t.id==="more";
          const active=isMore?(showMore||isMorePage):page===t.id;
          return(
            <button key={t.id}
              onClick={()=>{isMore?setShowMore(s=>!s):(setPage(t.id),setShowMore(false));}}
              style={{flex:1,background:"none",border:"none",cursor:"pointer",
                display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                gap:2,padding:0}}>
              <div style={{fontSize:t.id==="more"?16:18,lineHeight:1,color:active?T.gold:T.textDim}}>{t.emoji}</div>
              <div style={{fontSize:9,fontWeight:active?700:400,color:active?T.gold:T.textDim,fontFamily:T.font,letterSpacing:0.2,lineHeight:1}}>{t.label}</div>
              {active&&<div style={{width:14,height:2,borderRadius:1,background:T.gold,marginTop:1}}/>}
            </button>
          );
        })}
      </div>
    </>
  );
}

// ─── STORAGE BADGE ────────────────────────────────────────────────────────────
function StorageBadge({status, syncStatus, page, isMobile}){
  if(page==="client-detail") return null;

  // На мобильном — размещаем над нижней навигацией, не мешаем верхним кнопкам
  const pos = isMobile
    ? {position:"fixed", bottom:66, left:"50%", transform:"translateX(-50%)", zIndex:999}
    : {position:"fixed", top:16, right:16, zIndex:999};

  const online = isOnline();

  // Определяем что показывать — приоритет: syncStatus > storageStatus
  let color, text, dot;
  if (syncStatus === "syncing") {
    color = "rgba(96,165,250,0.9)"; text = "Синхронизация…"; dot = "#60a5fa";
  } else if (syncStatus === "ok") {
    color = T.green; text = "Синхронизировано"; dot = T.green;
  } else if (status === "saving") {
    color = "rgba(255,255,255,0.4)"; text = online ? "Сохранение…" : "Офлайн…"; dot = online ? "#60a5fa" : "#f59e0b";
  } else if (status === "saved") {
    color = T.green; text = online ? "Сохранено" : "Локально"; dot = T.green;
  } else {
    // В idle состоянии — ничего не показываем, не мешаем интерфейсу
    return null;
  }

  // Показываем Firebase ошибку если есть (PERMISSION_DENIED и т.д.)
  const [fbErr, setFbErr] = useState(null);
  useEffect(() => {
    const check = () => {
      const e = window.__firebaseError;
      if (e && Date.now() - e.ts < 10000) {
        if (e.code === "PERMISSION_DENIED") {
          setFbErr("Firebase: нет доступа. Исправь Rules в консоли Firebase.");
        } else {
          setFbErr(`Firebase: ${e.code || e.message}`);
        }
      } else {
        setFbErr(null);
      }
    };
    const iv = setInterval(check, 2000);
    return () => clearInterval(iv);
  }, []);

  if (fbErr) return (
    <div style={{...pos, display:"flex",alignItems:"center",gap:6,
      background:"rgba(220,38,38,0.15)",borderRadius:8,padding:"6px 14px",
      fontSize:11,fontWeight:600,border:"1px solid rgba(220,38,38,0.4)",
      boxShadow:"0 4px 20px rgba(0,0,0,0.4)",color:"#f87171",maxWidth:320,
      cursor:"pointer"}} onClick={()=>window.__firebaseError=null}>
      🔴 {fbErr}
    </div>
  );

  return (
    <div style={{...pos, display:"flex",alignItems:"center",gap:6,
      background:T.surface,borderRadius:8,padding:"5px 12px",
      fontSize:11,fontWeight:500,border:`1px solid ${T.border}`,
      boxShadow:"0 4px 20px rgba(0,0,0,0.4)",color}}>
      <div style={{width:6,height:6,borderRadius:3,background:dot,
        animation:syncStatus==="syncing"||status==="saving"?"pulse 1s infinite":undefined}}/>
      {text}
    </div>
  );
}

// ─── ADDRESS INPUT WITH AUTOCOMPLETE ──────────────────────────────────────────
const CITY_STREETS = {
  "Алматы": ["Абая","Абылай хана","Аль-Фараби","Ауэзова","Байтурсынова","Богенбай батыра","Гагарина","Гоголя","Достык","Жандосова","Жарокова","Желтоксан","Жибек жолы","Кабанбай батыра","Калдаякова","Карасай батыра","Курмангазы","Макатаева","Манаса","Мауленова","Муканова","Мустафина","Назарбаева","Навои","Наурызбай батыра","Розыбакиева","Сатпаева","Сейфуллина","Тимирязева","Толе би","Тулебаева","Утепова","Фурманова","Хаджи Мукана","Шевченко"],
  "Астана": ["Абая","Бейбітшілік","Иманбаева","Кабанбай батыра","Кенесары","Кошкарбаева","Кунаева","Мангилик Ел","Республика","Сарыарка","Сауран","Сыганак","Туран","Улы Дала","Ханов Керея и Жанибека"],
  "Шымкент": ["Абая","Байтурсынова","Жибек жолы","Казыбек би","Момышулы","Республика","Тауке хана","Темирлановское шоссе","Толе би","Туркестанская"],
  "Караганда": ["Бухар жырау","Ерубаева","Казахстан","Кривогуза","Ленина","Мичурина","Мустафина","Назарбаева","Нуркена Абдирова","Сатпаева"],
  "Актобе": ["Абая","Алтынсарина","Братьев Жубановых","Есет батыра","Маресьева","Молдагуловой","Некрасова","Санкибай батыра","Тургенева"],
  "Тараз": ["Абая","Байзак батыра","Желтоксан","Казыбек би","Сулейменова","Толе би","Тулебаева"],
  "Павлодар": ["1 Мая","Академика Бектурова","Ак. Сатпаева","Естая","Кутузова","Ломова","Назарбаева","Торайгырова"],
  "Усть-Каменогорск": ["Абая","Бажова","Казахстан","Кабанбай батыра","Назарбаева","Протозанова","Тохтарова"],
  "Семей": ["Абая","Аймаутова","Ауэзова","Гагарина","Достоевского","Найманбаева","Шакарима"],
  "Костанай": ["Абая","Алтынсарина","Байтурсынова","Баймагамбетова","Гоголя","Дулатова","Тарана"],
  "Петропавловск": ["Абая","Букетова","Жамбыла","Интернациональная","Назарбаева","Сутюшева"],
  "Кызылорда": ["Абая","Ауэзова","Желтоксан","Назарбаева","Сулейменова","Тасбогетова"],
  "Атырау": ["Абая","Азаттык","Алиева","Баймуханова","Курмангазы","Махамбета","Сатпаева"],
  "Актау": ["1 мкр","2 мкр","3 мкр","4 мкр","5 мкр","6 мкр","7 мкр","8 мкр","9 мкр","10 мкр","11 мкр","12 мкр","14 мкр","15 мкр"],
  "Туркестан": ["Абая","Жибек жолы","Назарбаева","Тауке хана"],
  "Талдыкорган": ["Абая","Жансугурова","Кабанбай батыра","Назарбаева","Тауелсиздик"],
  "Кокшетау": ["Абая","Ауэзова","Горького","Назарбаева","Уалиханова"],
  "Экибастуз": ["Абая","Ауэзова","Мәшһүр Жүсіп","Назарбаева"],
  "Конаев": ["Назарбаева","Республика","Тауелсиздик"],
};
const CITIES = Object.keys(CITY_STREETS);

function AddressAuto({value,onChange}){
  const [focused,setFocused]=useState(false);
  const [suggestions,setSuggestions]=useState([]);
  const [selectedIdx,setSelectedIdx]=useState(-1);
  const wrapRef=useRef(null);

  useEffect(()=>{
    function handleClick(e){if(wrapRef.current&&!wrapRef.current.contains(e.target))setFocused(false);}
    document.addEventListener("mousedown",handleClick);
    return()=>document.removeEventListener("mousedown",handleClick);
  },[]);

  useEffect(()=>{
    if(!value||!focused){setSuggestions([]);return;}
    const v=value.trim();const parts=v.split(",").map(s=>s.trim());
    let results=[];

    if(parts.length<=1){
      // Suggest cities
      const q=parts[0].toLowerCase();
      results=CITIES.filter(c=>c.toLowerCase().startsWith(q)).slice(0,6).map(c=>({text:c+", ",display:"🏙️ "+c,type:"city"}));
      // Also check if city matches exactly, then suggest streets
      const exactCity=CITIES.find(c=>c.toLowerCase()===q);
      if(exactCity){
        results=CITY_STREETS[exactCity].slice(0,8).map(s=>({text:exactCity+", ул. "+s+" ",display:"📍 ул. "+s,type:"street"}));
      }
    } else {
      // City is parts[0], street search in parts[1]
      const cityQ=parts[0].toLowerCase();
      const city=CITIES.find(c=>c.toLowerCase()===cityQ)||CITIES.find(c=>c.toLowerCase().startsWith(cityQ));
      if(city){
        let streetPart=parts[1].replace(/^ул\.?\s*/i,"").trim().toLowerCase();
        const streets=CITY_STREETS[city]||[];
        if(!streetPart){
          results=streets.slice(0,8).map(s=>({text:city+", ул. "+s+" ",display:"📍 ул. "+s,type:"street"}));
        } else {
          results=streets.filter(s=>s.toLowerCase().startsWith(streetPart)).slice(0,6).map(s=>({text:city+", ул. "+s+" ",display:"📍 ул. "+s,type:"street"}));
          // Also show partial matches
          if(results.length<4){
            const more=streets.filter(s=>s.toLowerCase().includes(streetPart)&&!s.toLowerCase().startsWith(streetPart)).slice(0,4-results.length).map(s=>({text:city+", ул. "+s+" ",display:"📍 ул. "+s,type:"street"}));
            results=[...results,...more];
          }
        }
      }
    }
    setSuggestions(results);
    setSelectedIdx(-1);
  },[value,focused]);

  function handleKeyDown(e){
    if(!suggestions.length)return;
    if(e.key==="ArrowDown"){e.preventDefault();setSelectedIdx(i=>Math.min(i+1,suggestions.length-1));}
    else if(e.key==="ArrowUp"){e.preventDefault();setSelectedIdx(i=>Math.max(i-1,0));}
    else if(e.key==="Enter"&&selectedIdx>=0){e.preventDefault();pick(suggestions[selectedIdx]);}
    else if(e.key==="Escape"){setFocused(false);}
  }
  function pick(s){onChange(s.text);setSuggestions([]);setSelectedIdx(-1);}

  return(
    <div ref={wrapRef} style={{position:"relative"}}>
      <Inp value={value} onChange={e=>onChange(e.target.value)} onFocus={()=>setFocused(true)} onKeyDown={handleKeyDown} placeholder="Начните вводить город…"/>
      {focused&&suggestions.length>0&&(
        <div style={{position:"absolute",top:"100%",left:0,right:0,marginTop:4,background:"#111113",border:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden",zIndex:100,boxShadow:"0 12px 36px rgba(0,0,0,0.5)",maxHeight:240,overflowY:"auto"}}>
          {suggestions.map((s,i)=>(
            <button key={i} onClick={()=>pick(s)} onMouseEnter={()=>setSelectedIdx(i)} style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"10px 14px",background:i===selectedIdx?"rgba(201,168,76,0.08)":"transparent",border:"none",borderBottom:i<suggestions.length-1?`1px solid ${T.border}`:"none",cursor:"pointer",textAlign:"left",color:i===selectedIdx?T.gold:T.text,fontSize:13,fontFamily:T.font,transition:"background 0.1s"}}>
              <span style={{fontSize:13,opacity:0.7}}>{s.type==="city"?"🏙️":"📍"}</span>
              <span style={{fontWeight:s.type==="city"?600:400}}>{s.display.replace(/^[🏙️📍]\s*/,"")}</span>
            </button>
          ))}
          <div style={{padding:"6px 14px",fontSize:10,color:T.textDim,borderTop:`1px solid ${T.border}`}}>↑↓ навигация · Enter выбрать</div>
        </div>
      )}
    </div>
  );
}

// ─── ADD CLIENT MODAL ─────────────────────────────────────────────────────────
function AddClientModal({open,onClose,onAdd}){
  const[name,setName]=useState("");const[phone,setPhone]=useState("");const[address,setAddress]=useState("");const[source,setSource]=useState("");const[notes,setNotes]=useState("");
  function handleAdd(){if(!name.trim())return;onAdd({name:name.trim(),phone:phone.trim(),address:address.trim(),source,notes:notes.trim()});setName("");setPhone("");setAddress("");setSource("");setNotes("");}
  if(!open)return null;
  return createPortal(
    <div style={{position:"fixed",inset:0,zIndex:8000,background:"rgba(0,0,0,0.7)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#111113",borderRadius:22,width:"100%",maxWidth:460,maxHeight:"90vh",overflowY:"auto",border:`1px solid ${T.border}`,boxShadow:"0 24px 64px rgba(0,0,0,0.6),inset 0 1px 0 rgba(255,255,255,0.03)",animation:"fadeIn 0.25s cubic-bezier(0.16,1,0.3,1)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"20px 24px",borderBottom:`1px solid ${T.border}`}}>
          <div style={{fontSize:17,fontWeight:700}}>✨ Новый клиент</div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,borderRadius:10,width:34,height:34,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:16,color:T.textSec}}>✕</button>
        </div>
        <div style={{padding:"20px 24px",display:"flex",flexDirection:"column",gap:15}}>
          <div><div style={{fontSize:11,color:T.textSec,marginBottom:6,fontWeight:700,letterSpacing:1}}>ИМЯ *</div><Inp value={name} onChange={e=>setName(e.target.value)} placeholder="Иванов Иван" autoFocus/></div>
          <div><div style={{fontSize:11,color:T.textSec,marginBottom:6,fontWeight:700,letterSpacing:1}}>ТЕЛЕФОН</div><Inp value={phone} onChange={e=>setPhone(e.target.value.replace(/[^\d+\-()\ s]/g,""))} placeholder="+7 (777) 000-00-00" type="tel" inputMode="tel"/></div>
          <div><div style={{fontSize:11,color:T.textSec,marginBottom:6,fontWeight:700,letterSpacing:1}}>АДРЕС / ОБЪЕКТ</div><AddressAuto value={address} onChange={setAddress}/></div>
          <div>
            <div style={{fontSize:11,color:T.textSec,marginBottom:7,fontWeight:700,letterSpacing:1}}>ИСТОЧНИК</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:7}}>
              {SOURCES.map(s=><button key={s} onClick={()=>setSource(s===source?"":s)} style={{background:s===source?T.goldBg:"rgba(255,255,255,0.03)",color:s===source?T.gold:T.textSec,border:`1px solid ${s===source?"rgba(201,168,76,0.2)":T.border}`,borderRadius:10,padding:"7px 13px",fontSize:12,cursor:"pointer",fontFamily:T.font,fontWeight:600,transition:"all 0.2s"}}>{s}</button>)}
            </div>
          </div>
          <div><div style={{fontSize:11,color:T.textSec,marginBottom:6,fontWeight:700,letterSpacing:1}}>ЗАМЕТКИ</div><textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Дополнительная информация…" style={{background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,borderRadius:12,padding:"12px 15px",color:T.text,fontSize:14,width:"100%",outline:"none",minHeight:90,resize:"vertical",fontFamily:T.font}} onFocus={e=>{e.target.style.borderColor="rgba(201,168,76,0.4)";}} onBlur={e=>{e.target.style.borderColor=T.border;}}/></div>
          <Btn variant="primary" disabled={!name.trim()} onClick={handleAdd} style={{justifyContent:"center",width:"100%",padding:"14px",fontSize:15}}>Добавить клиента</Btn>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({clients,onGoToClient,onStartKP,onGoToPage,isMobile,currentUser,onLogout,onShowUserManager,onGDriveBackup,gdriveStatus,gdriveInfo}){
  const active=clients.filter(c=>!["closed","lost"].includes(c.status));
  const totalKPs=clients.reduce((s,c)=>s+(c.kps?.length||0),0);
  const pipeline=clients.filter(c=>c.kps?.length>0&&!["closed","lost"].includes(c.status)).reduce((s,c)=>s+(c.kps?.[0]?.total||0),0);
  const recent=[...clients].sort((a,b)=>new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt)).slice(0,isMobile?5:10);
  const monthlyData=Array.from({length:6},(_,i)=>{const d=new Date();d.setMonth(d.getMonth()-5+i);const m=d.getMonth(),y=d.getFullYear();return{label:d.toLocaleDateString("ru-KZ",{month:"short"}),value:clients.filter(c=>{const cd=new Date(c.createdAt);return cd.getMonth()===m&&cd.getFullYear()===y;}).length};});
  const donutSegs=STATUSES.map(st=>({color:st.color,value:clients.filter(c=>c.status===st.id).length,label:st.label})).filter(s=>s.value>0);

  const Stat=({icon,label,value,color=T.gold,delay=0})=>(
    <GlassCard className={`fade-in stagger-${delay}`} style={{padding:"18px 20px",display:"flex",alignItems:"center",gap:14}}>
      <div style={{width:46,height:46,borderRadius:13,background:`${color}12`,border:`1px solid ${color}20`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>{icon}</div>
      <div><div style={{fontSize:isMobile?22:24,fontWeight:800,color,fontFamily:T.mono,lineHeight:1}}>{value}</div><div style={{fontSize:11,color:T.textSec,marginTop:3,fontWeight:500}}>{label}</div></div>
    </GlassCard>
  );

  return(
    <div className="fade-in">
      {isMobile&&(
        <div style={{padding:"20px 16px 14px",background:"linear-gradient(180deg,rgba(17,17,19,0.98),transparent)",borderBottom:`1px solid ${T.border}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div>
              <div style={{fontSize:10,color:T.textDim,letterSpacing:2.5,marginBottom:3,fontWeight:600}}>IGS OUTDOOR</div>
              <div style={{fontSize:24,fontWeight:800,fontFamily:T.serif}}><span style={{color:T.gold}}>Добрый день</span> 👋</div>
            </div>
            <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:5}}>
              <div style={{fontSize:11,color:T.textSec,fontWeight:500}}>👤 {currentUser?.login}</div>
              {onShowUserManager&&<button onClick={onShowUserManager} style={{background:"rgba(255,255,255,0.03)",border:`1px solid ${T.border}`,borderRadius:8,padding:"3px 9px",color:T.textSec,fontSize:10,cursor:"pointer",fontWeight:600}}>👥</button>}
              <button onClick={onLogout} style={{background:T.dangerBg,border:"1px solid rgba(224,82,82,0.12)",borderRadius:8,padding:"3px 9px",color:T.danger,fontSize:10,cursor:"pointer",fontWeight:600}}>Выйти</button>
            </div>
          </div>
        </div>
      )}
      {!isMobile&&(
        <div style={{marginBottom:30}}>
          <div style={{fontSize:10,color:T.textDim,letterSpacing:3,marginBottom:6,fontWeight:600}}>ОБЗОР</div>
          <div style={{fontSize:30,fontWeight:800,fontFamily:T.serif}}>Добрый день, <span style={{color:T.gold}}>{currentUser?.login}</span> 👋</div>
          <div style={{fontSize:13,color:T.textSec,marginTop:4}}>{new Date().toLocaleDateString("ru-KZ",{weekday:"long",day:"numeric",month:"long"})}</div>
          {onGDriveBackup&&(
            <div style={{marginTop:12,display:"inline-flex",alignItems:"center",gap:8}}>
              <button onClick={()=>onGDriveBackup(false)} disabled={gdriveStatus==="saving"}
                style={{display:"inline-flex",alignItems:"center",gap:6,background:gdriveStatus==="ok"?"rgba(74,222,128,0.08)":gdriveStatus==="error"?"rgba(196,84,84,0.08)":gdriveStatus==="unconfigured"?"rgba(255,255,255,0.03)":"rgba(255,255,255,0.04)",border:`1px solid ${gdriveStatus==="ok"?"rgba(74,222,128,0.2)":gdriveStatus==="error"?"rgba(196,84,84,0.2)":"rgba(255,255,255,0.07)"}`,borderRadius:8,padding:"6px 14px",color:gdriveStatus==="ok"?"#4ade80":gdriveStatus==="error"?"#f87171":gdriveStatus==="unconfigured"?"rgba(255,255,255,0.2)":T.textSec,fontSize:11,fontWeight:600,cursor:gdriveStatus==="saving"||gdriveStatus==="unconfigured"?"default":"pointer",fontFamily:T.font,transition:"all 0.2s"}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                {gdriveStatus==="saving"?"Сохраняю в Drive...":gdriveStatus==="ok"?`Drive: ${gdriveInfo?.count||""} кл.`:gdriveStatus==="error"?"Ошибка Drive":gdriveStatus==="unconfigured"?"Drive не настроен":"Бэкап в Google Drive"}
              </button>
              {gdriveInfo&&gdriveStatus!=="saving"&&<div style={{fontSize:10,color:T.textDim}}>Последний: {new Date(gdriveInfo.savedAt).toLocaleTimeString("ru",{hour:"2-digit",minute:"2-digit"})}</div>}
            </div>
          )}
        </div>
      )}

      <div style={{padding:isMobile?"12px 12px 110px":0}}>
        <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)",gap:10,marginBottom:18}}>
          <Stat icon="👥" label="Клиентов" value={clients.length} delay={1}/>
          <Stat icon="🔥" label="Активных" value={active.length} color={T.green} delay={2}/>
          <Stat icon="📄" label="КП создано" value={totalKPs} color="#60a5fa" delay={3}/>
          <Stat icon="💰" label="Воронка" value={fmtK(pipeline)} color={T.gold} delay={4}/>
        </div>

        <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"2.2fr 1fr 1.1fr",gap:12,marginBottom:16}}>
          <GlassCard style={{padding:20}}>
            <div style={{fontSize:11,color:T.textSec,fontWeight:700,marginBottom:12,letterSpacing:1.5}}>НОВЫЕ КЛИЕНТЫ · 6 МЕС.</div>
            <BarChart data={monthlyData} color={T.gold}/>
          </GlassCard>
          <GlassCard style={{padding:20,display:"flex",flexDirection:"column",alignItems:"center"}}>
            <div style={{fontSize:11,color:T.textSec,fontWeight:700,marginBottom:10,letterSpacing:1.5,alignSelf:"flex-start"}}>ПО СТАТУСАМ</div>
            <Donut segs={donutSegs} size={isMobile?100:120}/>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:10,justifyContent:"center"}}>
              {donutSegs.slice(0,4).map(s=>(
                <div key={s.label} style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:T.textSec}}>
                  <div style={{width:7,height:7,borderRadius:4,background:s.color,flexShrink:0}}/>
                  {s.label}({s.value})
                </div>
              ))}
            </div>
          </GlassCard>
          <GlassCard style={{padding:20}}>
            <div style={{fontSize:11,color:T.textSec,fontWeight:700,marginBottom:12,letterSpacing:1.5}}>ВОРОНКА</div>
            {STATUSES.filter(st=>st.id!=="lost").map(st=>{const count=clients.filter(c=>c.status===st.id).length;return(
              <div key={st.id} style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:10,color:st.color,fontWeight:600}}>{st.label}</span>
                  <span style={{fontSize:10,color:T.textSec,fontFamily:T.mono}}>{count}</span>
                </div>
                <div style={{height:4,background:"rgba(255,255,255,0.04)",borderRadius:3,overflow:"hidden"}}>
                  <div style={{width:clients.length?`${(count/clients.length)*100}%`:"0%",height:"100%",background:`linear-gradient(90deg,${st.color},${st.color}88)`,borderRadius:3,transition:"width 0.8s cubic-bezier(0.16,1,0.3,1)"}}/>
                </div>
              </div>
            );})}
          </GlassCard>
        </div>

        <div style={{display:"flex",gap:10,marginBottom:16}}>
          <Btn variant="primary" onClick={onStartKP} style={{padding:"12px 22px"}}>🧮 Новый расчёт КП</Btn>
          <Btn variant="ghost" onClick={()=>onGoToPage("clients")} style={{padding:"12px 22px"}}>➕ Добавить клиента</Btn>
        </div>

        {recent.length>0&&(
          <GlassCard style={{overflow:"hidden"}}>
            <div style={{padding:"14px 20px 10px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontSize:11,color:T.textSec,fontWeight:700,letterSpacing:1.5}}>ПОСЛЕДНИЕ КЛИЕНТЫ</div>
              <button onClick={()=>onGoToPage("clients")} style={{background:"none",border:"none",fontSize:12,color:T.gold,cursor:"pointer",fontFamily:T.font,fontWeight:600}}>Все →</button>
            </div>
            {isMobile?(
              <div style={{display:"flex",flexDirection:"column"}}>
                {recent.map((c,i)=>{const st=STATUSES.find(s=>s.id===c.status);const lkp=c.kps?.[0];return(
                  <button key={c.id} onClick={()=>onGoToClient(c.id)} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",background:"none",border:"none",borderTop:i>0?`1px solid ${T.border}`:"none",cursor:"pointer",textAlign:"left",width:"100%",transition:"background 0.15s"}}>
                    <div style={{width:38,height:38,borderRadius:11,background:st?.light,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,color:st?.color,flexShrink:0,border:`1px solid ${st?.color}20`}}>{c.name?.[0]?.toUpperCase()}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:14,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:T.text}}>{c.name}</div>
                      <div style={{fontSize:12,color:T.textSec}}>{c.phone||"—"}</div>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
                      <Tag color={st?.color} light={st?.light}>{st?.label}</Tag>
                      {lkp&&<div style={{fontSize:10,color:T.gold,fontFamily:T.mono}}>{fmtK(lkp.total)}</div>}
                    </div>
                  </button>
                );})}
              </div>
            ):(
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead>
                  <tr style={{borderTop:`1px solid ${T.border}`}}>
                    {["Клиент","Телефон","Источник","Статус","Последнее КП","Дата"].map(h=>(
                      <th key={h} style={{padding:"10px 20px",fontSize:10,color:T.textDim,fontWeight:700,textAlign:"left",letterSpacing:1}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recent.map((c,i)=>{const st=STATUSES.find(s=>s.id===c.status);const lkp=c.kps?.[0];return(
                    <tr key={c.id} onClick={()=>onGoToClient(c.id)} style={{borderTop:`1px solid ${T.border}`,cursor:"pointer",transition:"background 0.15s"}} onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.02)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <td style={{padding:"12px 20px"}}>
                        <div style={{display:"flex",alignItems:"center",gap:10}}>
                          <div style={{width:32,height:32,borderRadius:9,background:st?.light,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:st?.color,border:`1px solid ${st?.color}20`}}>{c.name?.[0]?.toUpperCase()}</div>
                          <span style={{fontSize:14,fontWeight:600}}>{c.name}</span>
                        </div>
                      </td>
                      <td style={{padding:"12px 20px",fontSize:12,color:T.textSec,fontFamily:T.mono}}>{c.phone||"—"}</td>
                      <td style={{padding:"12px 20px",fontSize:13,color:T.textSec}}>{c.source||"—"}</td>
                      <td style={{padding:"12px 20px"}}><Tag color={st?.color} light={st?.light}>{st?.label}</Tag></td>
                      <td style={{padding:"12px 20px",fontSize:13,color:lkp?T.gold:T.textDim,fontFamily:T.mono,fontWeight:lkp?600:400}}>{lkp?fmtK(lkp.total):"—"}</td>
                      <td style={{padding:"12px 20px",fontSize:12,color:T.textDim}}>{fmtDate(c.updatedAt||c.createdAt)}</td>
                    </tr>
                  );})}
                </tbody>
              </table>
            )}
          </GlassCard>
        )}

        {clients.length===0&&(
          <GlassCard style={{textAlign:"center",padding:"56px 24px"}}>
            <div style={{fontSize:52,marginBottom:16}}>🌿</div>
            <div style={{fontSize:20,fontWeight:800,marginBottom:8,fontFamily:T.serif}}>Начните работу</div>
            <div style={{fontSize:14,color:T.textSec,marginBottom:24}}>Добавьте первого клиента или создайте расчёт КП</div>
            <Btn variant="primary" onClick={onStartKP}>Новый расчёт</Btn>
          </GlassCard>
        )}
      </div>
    </div>
  );
}

// ─── CLIENT LIST ──────────────────────────────────────────────────────────────
function ClientList({clients,onGoToClient,onAddClient,onDeleteClient,isMobile,currentUser}){
  const[search,setSearch]=useState("");const[filterStatus,setFilterStatus]=useState("all");const[showAdd,setShowAdd]=useState(false);const[sortBy,setSortBy]=useState("date");
  const filtered=clients.filter(c=>{const q=search.toLowerCase();return(!search||c.name?.toLowerCase().includes(q)||c.phone?.includes(q))&&(filterStatus==="all"||c.status===filterStatus);}).sort((a,b)=>sortBy==="name"?a.name?.localeCompare(b.name,"ru")||0:sortBy==="kp"?(b.kps?.[0]?.total||0)-(a.kps?.[0]?.total||0):new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt));

  return(
    <div className="fade-in">
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12,marginBottom:16}}>
        <div>
          {!isMobile&&<div style={{fontSize:10,color:T.textDim,letterSpacing:3,marginBottom:3,fontWeight:600}}>БАЗА</div>}
          <div style={{fontSize:isMobile?22:28,fontWeight:800,fontFamily:T.serif}}>Клиенты <span style={{fontSize:14,color:T.textSec,fontWeight:400,fontFamily:T.font}}>({clients.length})</span></div>
        </div>
        {can(currentUser,"add_clients")&&<Btn variant="primary" onClick={()=>setShowAdd(true)}>➕ Добавить</Btn>}
      </div>

      <div style={{display:"flex",gap:9,marginBottom:12,flexWrap:"wrap"}}>
        <div style={{position:"relative",flex:1,minWidth:180}}>
          <span style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",fontSize:14,color:T.textSec}}>🔍</span>
          <Inp value={search} onChange={e=>setSearch(e.target.value)} placeholder="Поиск…" style={{paddingLeft:36}}/>
        </div>
        {!isMobile&&(
          <select value={sortBy} onChange={e=>setSortBy(e.target.value)} style={{background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,borderRadius:12,padding:"0 16px",color:T.text,fontSize:13,cursor:"pointer",fontFamily:T.font,outline:"none"}}>
            <option value="date">По дате</option><option value="name">По имени</option><option value="kp">По сумме КП</option>
          </select>
        )}
      </div>

      <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:4,marginBottom:14}}>
        <button onClick={()=>setFilterStatus("all")} style={{background:filterStatus==="all"?T.goldBg:"rgba(255,255,255,0.03)",color:filterStatus==="all"?T.gold:T.textSec,border:`1px solid ${filterStatus==="all"?"rgba(201,168,76,0.2)":T.border}`,borderRadius:10,padding:"5px 13px",fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",fontFamily:T.font,transition:"all 0.2s"}}>Все ({clients.length})</button>
        {STATUSES.map(s=>{const count=clients.filter(c=>c.status===s.id).length;if(!count)return null;return(
          <button key={s.id} onClick={()=>setFilterStatus(s.id===filterStatus?"all":s.id)} style={{background:filterStatus===s.id?s.light:"rgba(255,255,255,0.03)",color:filterStatus===s.id?s.color:T.textSec,border:`1px solid ${filterStatus===s.id?`${s.color}30`:T.border}`,borderRadius:10,padding:"5px 13px",fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",fontFamily:T.font,transition:"all 0.2s"}}>{s.label} ({count})</button>
        );})}
      </div>

      {filtered.length===0?(
        <div style={{textAlign:"center",padding:56,color:T.textSec,fontSize:14}}>{search?"Ничего не найдено":"Нет клиентов"}</div>
      ):isMobile?(
        <div style={{display:"flex",flexDirection:"column",gap:8,paddingBottom:110}}>
          {filtered.map(c=>{const st=STATUSES.find(s=>s.id===c.status);const lkp=c.kps?.[0];return(
            <Card key={c.id} style={{padding:"14px 15px",display:"flex",alignItems:"center",gap:12}}>
              <div onClick={()=>onGoToClient(c.id)} style={{display:"flex",alignItems:"center",gap:12,flex:1,minWidth:0,cursor:"pointer"}}>
                <div style={{width:42,height:42,borderRadius:12,background:st?.light,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:700,color:st?.color,flexShrink:0,border:`1px solid ${st?.color}20`}}>{c.name?.[0]?.toUpperCase()}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:15,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name}</div>
                  <div style={{fontSize:12,color:T.textSec,marginTop:2}}>{c.phone||"—"}</div>
                  {lkp&&<div style={{fontSize:11,color:T.gold,marginTop:2,fontFamily:T.mono}}>💰 {fmt(lkp.total)}</div>}
                </div>
              </div>
              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:5,flexShrink:0}}>
                <Tag color={st?.color} light={st?.light}>{st?.label}</Tag>
                <div style={{fontSize:10,color:T.textDim}}>{fmtDate(c.updatedAt||c.createdAt)}</div>
                {can(currentUser,"delete_clients")&&<button onClick={e=>{e.stopPropagation();if(window.confirm("Удалить «"+c.name+"»?"))onDeleteClient(c.id);}} style={{background:"rgba(224,82,82,0.06)",border:"1px solid rgba(224,82,82,0.12)",borderRadius:7,padding:"3px 8px",fontSize:11,color:T.danger,cursor:"pointer",fontFamily:T.font,marginTop:2}}>🗑️</button>}
              </div>
            </Card>
          );})}
        </div>
      ):(
        <GlassCard style={{overflow:"hidden"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead>
              <tr style={{borderBottom:`1px solid ${T.border}`}}>
                {["Клиент","Телефон","Адрес","Источник","Статус","Сумма КП","КП","Обновлён",can(currentUser,"delete_clients")?"":""].filter(Boolean).map(h=>(
                  <th key={h} style={{padding:"11px 16px",fontSize:10,color:T.textDim,fontWeight:700,textAlign:"left",letterSpacing:1}}>{h}</th>
                ))}
                {can(currentUser,"delete_clients")&&<th style={{padding:"11px 10px",width:44}}/>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c,i)=>{const st=STATUSES.find(s=>s.id===c.status);const lkp=c.kps?.[0];return(
                <tr key={c.id} onClick={()=>onGoToClient(c.id)} style={{borderTop:i>0?`1px solid ${T.border}`:"none",cursor:"pointer",transition:"background 0.15s"}} onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.02)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <td style={{padding:"12px 16px"}}><div style={{display:"flex",alignItems:"center",gap:10}}><div style={{width:32,height:32,borderRadius:9,background:st?.light,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:st?.color,border:`1px solid ${st?.color}20`}}>{c.name?.[0]?.toUpperCase()}</div><span style={{fontSize:14,fontWeight:600}}>{c.name}</span></div></td>
                  <td style={{padding:"12px 16px",fontSize:12,color:T.textSec,fontFamily:T.mono}}>{c.phone||"—"}</td>
                  <td style={{padding:"12px 16px",fontSize:12,color:T.textSec,maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.address||"—"}</td>
                  <td style={{padding:"12px 16px",fontSize:12,color:T.textSec}}>{c.source||"—"}</td>
                  <td style={{padding:"12px 16px"}}><Tag color={st?.color} light={st?.light}>{st?.label}</Tag></td>
                  <td style={{padding:"12px 16px",fontSize:12,color:lkp?T.gold:T.textDim,fontFamily:T.mono,fontWeight:lkp?600:400}}>{lkp?fmt(lkp.total):"—"}</td>
                  <td style={{padding:"12px 16px",fontSize:12,color:T.textSec,textAlign:"center"}}>{c.kps?.length||0}</td>
                  <td style={{padding:"12px 16px",fontSize:11,color:T.textDim}}>{fmtDate(c.updatedAt||c.createdAt)}</td>
                  {can(currentUser,"delete_clients")&&<td style={{padding:"8px 10px"}}><button onClick={e=>{e.stopPropagation();if(window.confirm("Удалить «"+c.name+"»?"))onDeleteClient(c.id);}} style={{background:"rgba(224,82,82,0.06)",border:"1px solid rgba(224,82,82,0.12)",borderRadius:8,padding:"5px 8px",fontSize:13,color:T.danger,cursor:"pointer",opacity:0.6,transition:"opacity 0.2s"}} onMouseEnter={e=>e.target.style.opacity="1"} onMouseLeave={e=>e.target.style.opacity="0.6"}>🗑️</button></td>}
                </tr>
              );})}
            </tbody>
          </table>
        </GlassCard>
      )}

      {isMobile&&can(currentUser,"add_clients")&&<button onClick={()=>setShowAdd(true)} style={{position:"fixed",bottom:82,right:16,width:54,height:54,borderRadius:16,background:"linear-gradient(135deg,#c9a84c,#a8893a)",border:"none",fontSize:24,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 6px 24px rgba(201,168,76,0.35)",zIndex:10}}>➕</button>}
      {can(currentUser,"add_clients")&&<AddClientModal open={showAdd} onClose={()=>setShowAdd(false)} onAdd={data=>{onAddClient(data);setShowAdd(false);}}/>}
    </div>
  );
}


// ── Умный маппинг задачи → список Trello ─────────────────────────────────────
// Логика: по ключевым словам в названии списка определяем куда класть задачу.
// Приоритет: точное совпадение типа → ключевые слова → первый список как fallback.
function findBestList(lists, taskType, taskText="") {
  if (!lists || lists.length === 0) return null;

  // Словарь: тип задачи → ключевые слова для поиска в названии списка
  const TYPE_KEYWORDS = {
    measure:  ["замер","measure","замеры","выезд","на объект","объект"],
    call:     ["звонок","созвон","call","звонки","контакт","связь","лид","leads","новые"],
    start:    ["монтаж","установка","работы","install","запуск","старт","в работе","производство"],
    order:    ["заказ","order","поставка","закупка","склад"],
    meeting:  ["встреча","meeting","переговоры","показ","шоурум"],
    kp_sent:  ["кп","предложение","proposal","согласование","в работе"],
    closed:   ["готово","закрыт","сделано","done","complete","завершён","архив"],
    lost:     ["отказ","потерян","lost","не купил"],
  };

  const nameLower = (s) => s.toLowerCase().trim();
  const keywords = TYPE_KEYWORDS[taskType] || [];

  // 1) Точный поиск по ключевым словам типа в названии списка
  for (const list of lists) {
    const n = nameLower(list.name);
    if (keywords.some(kw => n.includes(kw))) return list;
  }

  // 2) Ищем по тексту задачи в названиях списков
  const textWords = taskText.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  for (const list of lists) {
    const n = nameLower(list.name);
    if (textWords.some(w => n.includes(w))) return list;
  }

  // 3) Универсальные fallback-списки по приоритету
  const fallbacks = ["в работе","работа","активные","active","todo","задачи","backlog","текущие"];
  for (const fb of fallbacks) {
    const found = lists.find(l => nameLower(l.name).includes(fb));
    if (found) return found;
  }

  // 4) Просто первый список
  return lists[0];
}

// ── Форматирование даты из задачи CRM → ISO для Trello due ───────────────────
// Принимает {date:"2026-04-17", time:"17:00"} → "2026-04-17T17:00:00.000Z" (UTC)
function taskToDueDate(date, time) {
  if (!date) return null;
  const t = time || "09:00";
  try {
    // Создаём дату в локальном времени Алматы (UTC+5)
    const dt = new Date(`${date}T${t}:00`);
    if (isNaN(dt.getTime())) return null;
    // Сдвигаем: Алматы UTC+5 → вычитаем 5 часов чтобы Trello показывал правильное время
    const utc = new Date(dt.getTime() - 5 * 60 * 60 * 1000);
    return utc.toISOString();
  } catch { return null; }
}

// ── Форматирование даты для отображения в CRM ─────────────────────────────────
function fmtDue(isoStr) {
  if (!isoStr) return null;
  try {
    const d = new Date(isoStr);
    // Добавляем 5 часов обратно для отображения в Алматы
    const local = new Date(d.getTime() + 5 * 60 * 60 * 1000);
    const day   = String(local.getUTCDate()).padStart(2,"0");
    const month = String(local.getUTCMonth()+1).padStart(2,"0");
    const hh    = String(local.getUTCHours()).padStart(2,"0");
    const mm    = String(local.getUTCMinutes()).padStart(2,"0");
    const time  = (hh !== "00" || mm !== "00") ? ` ${hh}:${mm}` : "";
    return `${day}.${month}${time}`;
  } catch { return null; }
}

// ── Имя карточки из задачи CRM ───────────────────────────────────────────────
function taskToCardName(task, clientName) {
  const ICONS = { call:"📞", measure:"📐", start:"🏗️", order:"📦", meeting:"🤝" };
  const LABELS = { call:"Звонок", measure:"Замер", start:"Монтаж", order:"Заказ", meeting:"Встреча" };
  const icon  = ICONS[task.type]  || "📋";
  const label = LABELS[task.type] || "Задача";
  const name  = clientName || "";
  const text  = task.text ? ` — ${task.text}` : "";
  return `${icon} ${label}: ${name}${text}`;
}


// ── Кнопка «Отправить в Trello» для задачи клиента ────────────────────────────
function SendToTrelloBtn() { return null; } // Trello removed — using internal Kanban

function useTrelloLists() { return []; } // Trello removed — using internal Kanban

function VisualsTab({ client, onUpdate }) {
  const [saving, setSaving] = useState(false);
  const visuals = client.visuals || [];

  async function deleteVisual(idx) {
    if (!window.confirm("Удалить этот визуал?")) return;
    const updated = visuals.filter((_, i) => i !== idx);
    onUpdate({ visuals: updated });
  }

  function useInKP(visual) {
    // Store selected visual URL in sessionStorage so Calculator can pick it up
    sessionStorage.setItem("igs_kp_visual_" + client.id, visual.url);
    window.dispatchEvent(new CustomEvent("kp-visual-selected", { detail: { clientId: client.id, url: visual.url } }));
    alert("✓ Визуал выбран! Откройте КП для этого клиента — фото будет вставлено автоматически.");
  }

  if (visuals.length === 0) return (
    <div style={{textAlign:"center",padding:"48px 20px",color:T.textSec}}>
      <div style={{fontSize:48,marginBottom:12}}>🖼</div>
      <div style={{fontSize:15,fontWeight:600,marginBottom:8}}>Нет визуализаций</div>
      <div style={{fontSize:13,color:T.textDim,lineHeight:1.6}}>
        Перейдите в раздел <strong style={{color:T.gold}}>Визуализация</strong>,<br/>
        загрузите фото объекта и нажмите<br/>
        <strong style={{color:T.gold}}>«Прикрепить к клиенту»</strong>
      </div>
    </div>
  );

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div style={{fontSize:11,color:T.textDim,marginBottom:2}}>
        {visuals.length} визуал{visuals.length===1?"":"а/ов"} · Нажмите «В КП» чтобы использовать в коммерческом предложении
      </div>
      {visuals.map((v, i) => (
        <GlassCard key={i} style={{overflow:"hidden"}}>
          {/* Превью */}
          <div style={{position:"relative",background:"#000",borderRadius:"11px 11px 0 0",overflow:"hidden"}}>
            <img src={v.url} alt={v.product||"Визуал"} style={{width:"100%",display:"block",maxHeight:260,objectFit:"cover"}}/>
            <div style={{position:"absolute",top:8,left:8,background:"rgba(0,0,0,0.65)",backdropFilter:"blur(4px)",borderRadius:8,padding:"3px 10px",fontSize:11,color:"#fff",fontWeight:600}}>
              {v.product} {v.state ? `· ${v.state}` : ""} {v.color ? `· ${v.color}` : ""}
            </div>
            <div style={{position:"absolute",top:8,right:8,fontSize:10,color:"rgba(255,255,255,0.5)",background:"rgba(0,0,0,0.5)",borderRadius:6,padding:"2px 7px"}}>
              {v.time}
            </div>
          </div>
          {/* Actions */}
          <div style={{padding:"10px 12px",display:"flex",gap:8,alignItems:"center"}}>
            <button onClick={()=>useInKP(v)}
              style={{flex:1,background:"linear-gradient(135deg,#b8965a,#9a7d4a)",color:"#09090b",border:"none",borderRadius:9,padding:"10px 14px",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:T.font,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
              📄 Использовать в КП
            </button>
            <a href={v.url} download={`igs-visual-${i+1}.jpg`} target="_blank" rel="noreferrer"
              style={{background:"rgba(255,255,255,0.05)",border:`1px solid ${T.border}`,borderRadius:9,padding:"10px 12px",color:T.textSec,textDecoration:"none",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center"}}
              title="Скачать">⬇</a>
            <button onClick={()=>deleteVisual(i)}
              style={{background:"rgba(196,84,84,0.06)",border:"1px solid rgba(196,84,84,0.15)",borderRadius:9,padding:"10px 12px",color:T.danger,cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center"}}
              title="Удалить">🗑️</button>
          </div>
        </GlassCard>
      ))}
    </div>
  );
}


// ─── CLIENT DETAIL ────────────────────────────────────────────────────────────
function ClientDetail({client,onBack,onUpdate,onDelete,onStartKP,isMobile,currentUser}){
  const[tab,setTab]=useState("info");const[editing,setEditing]=useState(false);
  // Kanban: задачи автоматически появляются на доске задач
  const[editData,setEditData]=useState({name:client.name,phone:client.phone,address:client.address,source:client.source,notes:client.notes});
  const[showSP,setShowSP]=useState(false);const[newTask,setNewTask]=useState("");
  const[taskType,setTaskType]=useState("call");
  const[taskDate,setTaskDate]=useState("");
  const[taskTime,setTaskTime]=useState("");
  const[showTaskForm,setShowTaskForm]=useState(false);const[copied,setCopied]=useState(null);
  const[lockInfo,setLockInfo]=useState(null);       // кто сейчас редактирует
  const[conflict,setConflict]=useState(null);       // remote версия при конфликте
  const[saving,setSaving]=useState(false);
  const st=STATUSES.find(s=>s.id===client.status)||STATUSES[0];
  const login = currentUser?.login || "менеджер";

  // Проверяем lock при открытии страницы
  useEffect(()=>{
    getLock(client.id).then(lock=>{
      if(lock && lock.login !== login) setLockInfo(lock);
    });
    // Realtime подписка на lock
    const unsub = dbListen("editing/"+client.id, (lock)=>{
      if(lock && lock.login !== login && Date.now() < lock.expires) setLockInfo(lock);
      else setLockInfo(null);
    });
    return ()=>{ unsub(); releaseLock(client.id, login); };
  },[]);

  // Обновляем lock каждые 15 сек пока редактируем
  useEffect(()=>{
    if(!editing) return;
    acquireLock(client.id, login);
    const interval = setInterval(()=>acquireLock(client.id, login), 15000);
    return ()=>{ clearInterval(interval); releaseLock(client.id, login); };
  },[editing]);

  async function saveEdit(){
    setSaving(true);
    // Проверяем конфликт перед сохранением
    const remoteClient = await checkConflict(client.id, client.updatedAt);
    if(remoteClient) {
      setConflict(remoteClient);
      setSaving(false);
      return;
    }
    onUpdate(editData);
    await releaseLock(client.id, login);
    setEditing(false);
    setSaving(false);
  }
  function forceOverwrite(){
    onUpdate(editData);
    releaseLock(client.id, login);
    setEditing(false);
    setConflict(null);
  }
  function acceptRemote(){
    setEditData({
      name:conflict.name, phone:conflict.phone,
      address:conflict.address, source:conflict.source, notes:conflict.notes
    });
    setConflict(null);
  }
  function addTask(){
    if(!newTask.trim()) return;
    const task={
      id:Date.now().toString(),
      text:newTask.trim(),
      type:taskType,
      date:taskDate||null,
      time:taskTime||null,
      done:false,
      kanbanCol:autoColumn({type:taskType,text:newTask.trim()},client),
      createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString(),
    };
    onUpdate({tasks:[...(client.tasks||[]),task]});
    setNewTask("");setTaskDate("");setTaskTime("");setShowTaskForm(false);
    // Планируем push-уведомление если есть дата+время
    if(taskDate&&taskTime){
      scheduleNotification(task, client.name);
    }
    // Auto-sync to Trello if lists are loaded and task has a date
    // Задача автоматически появится в Kanban через allCards memo
  }
  function toggleTask(id){onUpdate({tasks:(client.tasks||[]).map(t=>t.id===id?{...t,done:!t.done}:t)});}
  function deleteTask(id){onUpdate({tasks:(client.tasks||[]).filter(t=>t.id!==id)});}
  function deleteKP(kpId){onUpdate({kps:(client.kps||[]).filter(k=>k.id!==kpId)});}
  function copyKP(kp){const text=generateKPText(client,kp.items,kp.discount||0);navigator.clipboard?.writeText(text).catch(()=>{});setCopied(kp.id);setTimeout(()=>setCopied(null),2000);}

  return(
    <div className="fade-in" style={{minHeight:"100vh",background:T.bg,paddingBottom:isMobile?80:0}}>

      {/* Баннер: кто-то редактирует */}
      {lockInfo&&!editing&&(
        <div style={{background:"rgba(217,119,6,0.1)",borderBottom:"1px solid rgba(217,119,6,0.2)",padding:"10px 20px",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:16}}>✏️</span>
          <div style={{fontSize:13,color:"#d97706",fontWeight:600}}>
            <b>{lockInfo.login}</b> сейчас редактирует этого клиента
          </div>
          <span style={{fontSize:11,color:"rgba(217,119,6,0.6)",marginLeft:"auto"}}>Изменения могут конфликтовать</span>
        </div>
      )}

      {/* Модал конфликта */}
      {conflict&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:T.surface,borderRadius:16,maxWidth:460,width:"100%",padding:"24px",border:"1px solid rgba(220,38,38,0.3)"}}>
            <div style={{fontSize:18,fontWeight:800,marginBottom:6,fontFamily:T.serif}}>⚠️ Конфликт изменений</div>
            <div style={{fontSize:13,color:T.textSec,marginBottom:18,lineHeight:1.6}}>
              Пока ты редактировал, <b style={{color:T.text}}>{conflict.updatedAt ? new Date(conflict.updatedAt).toLocaleTimeString("ru-KZ",{hour:"2-digit",minute:"2-digit"}) : "кто-то"}</b> уже сохранил изменения по этому клиенту.
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
              <div style={{background:T.card,borderRadius:10,padding:"12px",border:`1px solid ${T.border}`}}>
                <div style={{fontSize:10,color:T.textSec,fontWeight:700,letterSpacing:1,marginBottom:6}}>ТВОЯ ВЕРСИЯ</div>
                <div style={{fontSize:13,fontWeight:600}}>{editData.name}</div>
                <div style={{fontSize:11,color:T.textSec,marginTop:2}}>{editData.phone}</div>
                {editData.notes&&<div style={{fontSize:11,color:T.textDim,marginTop:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{editData.notes}</div>}
              </div>
              <div style={{background:"rgba(220,38,38,0.06)",borderRadius:10,padding:"12px",border:"1px solid rgba(220,38,38,0.15)"}}>
                <div style={{fontSize:10,color:"#dc2626",fontWeight:700,letterSpacing:1,marginBottom:6}}>ЧУЖАЯ ВЕРСИЯ</div>
                <div style={{fontSize:13,fontWeight:600}}>{conflict.name}</div>
                <div style={{fontSize:11,color:T.textSec,marginTop:2}}>{conflict.phone}</div>
                {conflict.notes&&<div style={{fontSize:11,color:T.textDim,marginTop:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{conflict.notes}</div>}
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              <button onClick={forceOverwrite}
                style={{background:"linear-gradient(135deg,#c9a84c,#a8893a)",color:"#060b07",border:"none",borderRadius:10,padding:"12px",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:T.font}}>
                💪 Сохранить мою версию (перезаписать)
              </button>
              <button onClick={acceptRemote}
                style={{background:T.elevated,color:T.text,border:`1px solid ${T.border}`,borderRadius:10,padding:"12px",fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:T.font}}>
                📥 Принять чужую версию (отменить мои правки)
              </button>
              <button onClick={()=>setConflict(null)}
                style={{background:"transparent",color:T.textSec,border:"none",padding:"8px",fontSize:12,cursor:"pointer",fontFamily:T.font}}>
                Продолжить редактировать
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{background:"linear-gradient(180deg,rgba(17,17,19,0.98),transparent)",borderBottom:`1px solid ${T.border}`,padding:"16px 20px"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
          <button onClick={onBack} style={{background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,borderRadius:10,width:36,height:36,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,cursor:"pointer",color:T.textSec}}>←</button>
          <div style={{flex:1}}>
            {editing?<Inp value={editData.name} onChange={e=>setEditData({...editData,name:e.target.value})} style={{fontSize:17,fontWeight:700}}/>:<div style={{fontSize:19,fontWeight:800,fontFamily:T.serif}}>{client.name}</div>}
          </div>
          {!editing&&can(currentUser,"edit_clients")&&<button onClick={()=>setEditing(true)} style={{background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,borderRadius:10,width:36,height:36,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,cursor:"pointer",color:T.textSec}}>✏️</button>}
          {!editing&&can(currentUser,"delete_clients")&&<button onClick={()=>{if(window.confirm("Удалить клиента «"+client.name+"»? Это действие нельзя отменить."))onDelete();}} style={{background:"rgba(224,82,82,0.06)",border:"1px solid rgba(224,82,82,0.15)",borderRadius:10,width:36,height:36,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,cursor:"pointer",color:T.danger}}>🗑️</button>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:9,flexWrap:"wrap",marginBottom:12}}>
          <button onClick={()=>setShowSP(!showSP)} style={{background:st.light,color:st.color,border:`1px solid ${st.color}25`,borderRadius:9,padding:"4px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:T.font}}>{st.label} ▾</button>
          {client.phone&&<a href={`tel:${client.phone}`} style={{color:T.green,fontSize:13,fontWeight:500}}>📞 {client.phone}</a>}
        </div>
        {showSP&&(<div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>{STATUSES.map(s=><button key={s.id} onClick={()=>{onUpdate({status:s.id});setShowSP(false);}} style={{background:s.light,color:s.color,border:s.id===client.status?`2px solid ${s.color}`:`1px solid ${s.color}25`,borderRadius:9,padding:"4px 11px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:T.font,transition:"all 0.2s"}}>{s.label}</button>)}</div>)}
        <div style={{display:"flex",gap:9}}>
          <Btn variant="primary" onClick={onStartKP} style={{flex:1,justifyContent:"center",padding:"10px"}}>🧮 Новое КП</Btn>
          {client.phone&&<a href={`https://wa.me/${client.phone.replace(/\D/g,"")}`} target="_blank" rel="noreferrer" style={{flex:1,background:"#25D366",color:"#fff",border:"none",borderRadius:13,padding:"10px 16px",fontWeight:600,fontSize:14,cursor:"pointer",fontFamily:T.font,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>💬 WhatsApp</a>}
        </div>
      </div>

      <div style={{display:"flex",background:"rgba(17,17,19,0.8)",borderBottom:`1px solid ${T.border}`}}>
        {[["info","ℹ️ Инфо"],["kps",`📄 КП (${client.kps?.length||0})`],["tasks",`✅ Задачи (${(client.tasks||[]).filter(t=>!t.done).length})`],["visuals",`🖼 Визуалы${(client.visuals||[]).length>0?" ("+client.visuals.length+")":""}`]].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flex:1,minWidth:0,background:"none",border:"none",borderBottom:`2px solid ${tab===id?T.gold:"transparent"}`,padding:"12px 4px",color:tab===id?T.gold:T.textSec,fontWeight:tab===id?700:400,fontSize:12,cursor:"pointer",fontFamily:T.font,transition:"all 0.2s",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{label}</button>
        ))}
      </div>

      <div style={{padding:"16px 20px"}}>
        {tab==="info"&&(
          <div style={{display:"flex",flexDirection:"column",gap:11}}>
            {editing?(
              <>
                {[["Телефон","phone","tel"],["Заметки","notes","text"]].map(([label,key,type])=>(
                  <div key={key}>
                    <div style={{fontSize:11,color:T.textSec,marginBottom:5,fontWeight:700,letterSpacing:1}}>{label.toUpperCase()}</div>
                    {key==="notes"?<textarea value={editData[key]||""} onChange={e=>setEditData({...editData,[key]:e.target.value})} style={{background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,borderRadius:12,padding:"12px 15px",color:T.text,fontSize:14,width:"100%",outline:"none",minHeight:80,resize:"vertical",fontFamily:T.font}}/>:<Inp type={type} value={editData[key]||""} onChange={e=>setEditData({...editData,[key]:key==="phone"?e.target.value.replace(/[^\d+\-()\s]/g,""):e.target.value})}/>}
                  </div>
                ))}
                <div><div style={{fontSize:11,color:T.textSec,marginBottom:5,fontWeight:700,letterSpacing:1}}>АДРЕС</div><AddressAuto value={editData.address||""} onChange={v=>setEditData({...editData,address:v})}/></div>
                <div>
                  <div style={{fontSize:11,color:T.textSec,marginBottom:6,fontWeight:700,letterSpacing:1}}>ИСТОЧНИК</div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:6}}>{SOURCES.map(s=><button key={s} onClick={()=>setEditData({...editData,source:s===editData.source?"":s})} style={{background:s===editData.source?T.goldBg:"rgba(255,255,255,0.03)",color:s===editData.source?T.gold:T.textSec,border:`1px solid ${s===editData.source?"rgba(201,168,76,0.2)":T.border}`,borderRadius:9,padding:"5px 12px",fontSize:12,cursor:"pointer",fontFamily:T.font,fontWeight:600}}>{s}</button>)}</div>
                </div>
                <div style={{display:"flex",gap:9}}>
                  <Btn variant="primary" onClick={saveEdit} disabled={saving} style={{flex:1,justifyContent:"center"}}>{saving?"⏳ Проверка...":"Сохранить"}</Btn>
                  <Btn variant="ghost" onClick={()=>setEditing(false)} style={{flex:1,justifyContent:"center"}}>Отмена</Btn>
                </div>
              </>
            ):(
              <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:10}}>
                {[["📞 Телефон",client.phone],["📍 Адрес",client.address],["📣 Источник",client.source],["📅 Добавлен",fmtDateFull(client.createdAt)]].map(([label,val])=>val?(
                  <GlassCard key={label} style={{padding:"14px 16px"}}><div style={{fontSize:10,color:T.textSec,marginBottom:3,fontWeight:600}}>{label}</div><div style={{fontSize:14,fontWeight:500}}>{val}</div></GlassCard>
                ):null)}
                {client.notes&&<GlassCard style={{padding:"14px 16px",gridColumn:isMobile?"auto":"1/-1"}}><div style={{fontSize:10,color:T.textSec,marginBottom:3,fontWeight:600}}>📝 Заметки</div><div style={{fontSize:14,whiteSpace:"pre-wrap"}}>{client.notes}</div></GlassCard>}
              </div>
            )}
          </div>
        )}
        {tab==="kps"&&(
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {(client.kps||[]).length===0&&<div style={{textAlign:"center",padding:40,color:T.textSec,fontSize:14}}>Нет КП. Создайте первый расчёт!</div>}
            {(client.kps||[]).map(kp=>(
              <GlassCard key={kp.id} style={{padding:16}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                  <div style={{fontSize:12,color:T.textSec}}>{fmtDateFull(kp.createdAt)}</div>
                  <div style={{fontSize:18,fontWeight:800,color:T.gold,fontFamily:T.mono}}>{fmt(kp.total)}</div>
                </div>
                {kp.items?.map((item,i)=>{const p=PRODUCTS.find(pr=>pr.id===item.productId);return<div key={i} style={{fontSize:13,color:T.textSec,marginBottom:4}}>{p?.emoji} {p?.shortName} — {item.width}×{item.depth}м ({fmt(calcItem(item))})</div>;})}
                <div style={{display:"flex",gap:8,marginTop:10}}>
                  <Btn variant={copied===kp.id?"green":"ghost"} onClick={()=>copyKP(kp)} style={{flex:1,fontSize:12,padding:"7px 14px",justifyContent:"center"}}>{copied===kp.id?"✓ Скопировано!":"📋 Копировать КП"}</Btn>
                  <button onClick={()=>onStartKP(client.id,kp)}
                    style={{background:"rgba(184,150,90,0.08)",border:"1px solid rgba(184,150,90,0.2)",borderRadius:13,padding:"7px 12px",fontSize:13,color:T.gold,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.2s"}}
                    title="Редактировать КП">✏️</button>
                  <button onClick={()=>{if(window.confirm("Удалить это КП на "+fmt(kp.total)+"?"))deleteKP(kp.id);}} style={{background:"rgba(224,82,82,0.06)",border:"1px solid rgba(224,82,82,0.15)",borderRadius:13,padding:"7px 12px",fontSize:13,color:T.danger,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.2s"}}>🗑️</button>
                </div>
              </GlassCard>
            ))}
          </div>
        )}
        {tab==="tasks"&&(
          <div style={{display:"flex",flexDirection:"column",gap:10}}>

            {/* Типы задач — быстрые кнопки */}
            {(()=>{
              const TYPES=[
                {id:"call",    label:"Созвон",       icon:"📞", color:"#2563eb"},
                {id:"measure", label:"Замер",         icon:"📐", color:"#7c3aed"},
                {id:"start",   label:"Запуск работ", icon:"🏗️", color:"#d97706"},
                {id:"order",   label:"Заказать",     icon:"📦", color:"#059669"},
              ];
              return(
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:4}}>
                  {TYPES.map(type=>(
                    <button key={type.id}
                      onClick={()=>{setTaskType(type.id);setShowTaskForm(true);setNewTask("");setTaskDate("");setTaskTime("");}}
                      style={{
                        display:"flex",alignItems:"center",gap:8,padding:"11px 14px",
                        background:`${type.color}14`,border:`1px solid ${type.color}30`,
                        borderRadius:12,cursor:"pointer",fontFamily:T.font,
                        fontSize:13,fontWeight:600,color:T.text,textAlign:"left",
                        transition:"all 0.2s",
                      }}
                      onMouseEnter={e=>{e.currentTarget.style.background=`${type.color}28`;}}
                      onMouseLeave={e=>{e.currentTarget.style.background=`${type.color}14`;}}>
                      <span style={{fontSize:18}}>{type.icon}</span>
                      <span>{type.label}</span>
                    </button>
                  ))}
                </div>
              );
            })()}

            {/* Форма добавления задачи */}
            {showTaskForm&&(()=>{
              const TYPES={call:{label:"Созвон",icon:"📞",color:"#2563eb"},measure:{label:"Замер",icon:"📐",color:"#7c3aed"},start:{label:"Запуск работ",icon:"🏗️",color:"#d97706"},order:{label:"Заказать",icon:"📦",color:"#059669"}};
              const t=TYPES[taskType]||TYPES.call;
              return(
                <GlassCard style={{padding:"16px",border:`1px solid ${t.color}30`}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                    <span style={{fontSize:20}}>{t.icon}</span>
                    <div style={{fontSize:14,fontWeight:700,color:T.text}}>{t.label}</div>
                    <button onClick={()=>setShowTaskForm(false)} style={{marginLeft:"auto",background:"none",border:"none",color:T.textDim,cursor:"pointer",fontSize:16}}>✕</button>
                  </div>
                  <Inp value={newTask} onChange={e=>setNewTask(e.target.value)}
                    placeholder={`Описание: ${t.label.toLowerCase()}…`}
                    style={{marginBottom:10,width:"100%"}}/>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                    <div>
                      <div style={{fontSize:10,color:T.textSec,marginBottom:4,fontWeight:600}}>ДАТА</div>
                      <input type="date" value={taskDate} onChange={e=>setTaskDate(e.target.value)}
                        style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,padding:"9px 11px",color:T.text,fontSize:13,width:"100%",outline:"none",fontFamily:T.font}}/>
                    </div>
                    <div>
                      <div style={{fontSize:10,color:T.textSec,marginBottom:4,fontWeight:600}}>ВРЕМЯ</div>
                      <input type="time" value={taskTime} onChange={e=>setTaskTime(e.target.value)}
                        style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,padding:"9px 11px",color:T.text,fontSize:13,width:"100%",outline:"none",fontFamily:T.font}}/>
                    </div>
                  </div>
                  {taskDate&&taskTime&&(
                    <div style={{fontSize:11,color:T.gold,marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
                      🔔 Уведомление придёт {taskDate} в {taskTime} (и за 15 мин)
                    </div>
                  )}
                  <Btn variant="primary" onClick={()=>{
                    requestNotifPermission();
                    addTask();
                  }} style={{width:"100%",justifyContent:"center"}}>
                    Добавить задачу
                  </Btn>
                </GlassCard>
              );
            })()}

            {/* Список задач */}
            {(client.tasks||[]).length===0&&!showTaskForm&&(
              <div style={{textAlign:"center",padding:32,color:T.textSec,fontSize:14}}>
                Нажмите на тип задачи выше чтобы добавить
              </div>
            )}
            {(()=>{
              const TYPES={call:{label:"Созвон",icon:"📞",color:"#2563eb"},measure:{label:"Замер",icon:"📐",color:"#7c3aed"},start:{label:"Запуск работ",icon:"🏗️",color:"#d97706"},order:{label:"Заказать",icon:"📦",color:"#059669"}};
              const active=(client.tasks||[]).filter(t=>!t.done);
              const done=(client.tasks||[]).filter(t=>t.done);
              return(
                <>
                  {active.map(task=>{
                    const tType=TYPES[task.type]||{label:"Задача",icon:"📋",color:T.gold};
                    const isOverdue=task.date&&new Date(`${task.date}T${task.time||"23:59"}`)<new Date()&&!task.done;
                    return(
                      <GlassCard key={task.id} style={{padding:"12px 15px",borderLeft:`3px solid ${isOverdue?"#ef4444":tType.color}`}}>
                        <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
                          <button onClick={()=>toggleTask(task.id)}
                            style={{width:22,height:22,borderRadius:11,border:`2px solid ${tType.color}`,background:"transparent",cursor:"pointer",flexShrink:0,marginTop:1,display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.2s"}}>
                          </button>
                          <div style={{flex:1}}>
                            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                              <span style={{fontSize:14}}>{tType.icon}</span>
                              <span style={{fontSize:11,color:tType.color,fontWeight:700}}>{tType.label}</span>
                              {isOverdue&&<span style={{fontSize:10,color:"#ef4444",fontWeight:700}}>ПРОСРОЧЕНО</span>}
                            </div>
                            <div style={{fontSize:14,color:T.text,marginBottom:task.date?4:0}}>{task.text}</div>
                            {task.date&&<div style={{fontSize:11,color:T.textSec,display:"flex",alignItems:"center",gap:4}}>
                              🗓 {task.date}{task.time&&` · ${task.time}`}
                            </div>}
                          </div>
                          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4,flexShrink:0}}>

                            <button onClick={()=>deleteTask(task.id)}
                              style={{background:"none",border:"none",fontSize:14,cursor:"pointer",color:T.textDim}}>✕</button>
                          </div>
                        </div>
                      </GlassCard>
                    );
                  })}
                  {done.length>0&&(
                    <div style={{fontSize:11,color:T.textDim,marginTop:4,marginBottom:4,letterSpacing:1}}>ВЫПОЛНЕННЫЕ</div>
                  )}
                  {done.map(task=>{
                    const tType=TYPES[task.type]||{label:"Задача",icon:"📋",color:T.gold};
                    return(
                      <GlassCard key={task.id} style={{padding:"11px 15px",opacity:0.5}}>
                        <div style={{display:"flex",alignItems:"center",gap:10}}>
                          <button onClick={()=>toggleTask(task.id)}
                            style={{width:22,height:22,borderRadius:11,border:"2px solid #3db96a",background:"linear-gradient(135deg,#3db96a,#2d9a54)",cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                            <span style={{color:"#fff",fontSize:11,fontWeight:700}}>✓</span>
                          </button>
                          <div style={{flex:1,fontSize:13,color:T.textDim,textDecoration:"line-through"}}>
                            {tType.icon} {task.text}
                          </div>
                          <button onClick={()=>deleteTask(task.id)} style={{background:"none",border:"none",fontSize:14,cursor:"pointer",color:T.textDim}}>✕</button>
                        </div>
                      </GlassCard>
                    );
                  })}
                </>
              );
            })()}
          </div>
        )}

        {/* ── ВКЛАДКА ВИЗУАЛЫ ───────────────────────────────────── */}
        {tab==="visuals"&&(
          <VisualsTab client={client} onUpdate={onUpdate}/>
        )}
      </div>
    </div>
  );
}

// ─── CALCULATOR ───────────────────────────────────────────────────────────────

// ─── НОМЕР РУКОВОДИТЕЛЯ Для СОГЛАСОВАНИЯ ────────────────────────────────────
// ⚠️ ВАЖНО: этот номер виден только в коде, менеджеры его не видят на экране
// ⚠️ Себестоимость и маржа считаются ТОЛЬКО на сервере (/api/send-approval)
// Фронтенд не знает цифр — отправляет данные на сервер и получает письмо

// Фолбэк курс для отображения в UI (реальный курс подтягивается в ApproveModal)
const USD_RATE = 505;

// Фото продуктов для PDF КП
const KP_PRODUCT_PHOTOS = {
  "greenawn": "data:image/jpeg;base64,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",
  "igs_premium": "data:image/jpeg;base64,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",
  "toscana": "data:image/jpeg;base64,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",
  "guhher": "data:image/jpeg;base64,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",
  "guillotine": "data:image/jpeg;base64,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",
  "sliding": "data:image/jpeg;base64,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",
  "zip": "data:image/jpeg;base64,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",
  "marquise": "data:image/jpeg;base64,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",
  "railings": "data:image/jpeg;base64,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",
};

const KP_PRODUCT_DESC = {
  "greenawn":    "Биоклиматическая пергола с моторизированными поворотными ламелями (0°–110°). При закрытии ламели образуют герметичную крышу, при открытии — максимум света и вентиляции. Дождевая вода незаметно уходит через встроенный сливной лоток в колонны. Электропривод IP65 работает при любой погоде. Ветроустойчивость до 120 км/ч, снеговая нагрузка до 100 кг/м². Цвет каркаса: антрацит (RAL 7016), белый (RAL 9016) или любой RAL. Гарантия конструкции 1 год, покрытия 10 лет.",
  "igs_premium": "Биоклиматическая пергола Premium с поворотными и сдвижными ламелями. Полная герметичность при закрытии — ни капли воды внутрь. Вода отводится через колонны. 5 конфигураций монтажа: настенная, потолочная, двойная, отдельностоящая, на крыше. Ширина до 7 м, вынос до 7.25 м. Ветроустойчивость до 100 км/ч. Цвет: антрацит, белый или любой RAL. Гарантия 1 год.",
  "toscana":     "Тентовая пергола с выдвижным влагостойким покрытием на алюминиевом каркасе. В закрытом положении — 100% защита от дождя, в открытом — полная вентиляция и солнечный свет. Ткань 850 г/м², UPF 50+, 200+ расцветок. Вылет одного модуля 4.5 м, модули комбинируются, общий вылет до 13.5 м. Электромотор с пультом ДУ в комплекте. 6 типов монтажа. Каркас — любой RAL. Гарантия ткани 5 лет.",
  "toscana_maxi": "Тентовая пергола Maxi — усиленная версия на алюминиевом каркасе с увеличенным вылетом. Выдвижное влагостойкое покрытие 850 г/м², UPF 50+, 100% защита от дождя при закрытии. Электромотор с пультом ДУ в комплекте. Стандартные цвета: антрацит (RAL 7016) и белый (RAL 9016), а также любой RAL под заказ. Гарантия ткани 5 лет.",
  "guhher":      "Тентовая пергола Guhher с акриловой тканью на алюминиевом каркасе. Надёжная защита от солнца и осадков. Ручное или моторизированное управление. Быстрый монтаж на готовое основание. Каркас — любой RAL. Гарантия 1 год.",
  "sliding":     "Раздвижное панорамное остекление. Тёплая серия S500: стеклопакет 20 мм (4+12+4 закалённый), повышенная шумо- и теплоизоляция. Холодная серия: закалённое стекло 10 мм. Створки бесшумно складываются параллельно проёму на роликах (120 кг/шт). 4 контура уплотнения. До 12 панелей, высота до 3.1 м. Цвет: графит, матовый белый, любой RAL.",
  "guillotine":  "Гильотинное остекление — секции поднимаются вертикально вверх. Нет вертикальных стоек — максимальная прозрачность. Стеклопакет 20–28 мм. Серия с терморазрывом для круглогодичной эксплуатации (−10°C…+40°C). Автоматика с пультом ДУ, функция обнаружения препятствий. Фиксация в любом положении для вентиляции. Цвет: графит, матовый белый, любой RAL.",
  "zip":         "Zip-шторы с боковой фиксацией полотна по всей высоте — исключают парусение при ветре. Ткань и механизм скрыты в алюминиевой кассете. Высота до 4 м. Выбор ткани: акриловая, затемняющая, прозрачный ПВХ, москитная сетка. Ручное или моторное управление. Любой RAL. Гарантия 1 год.",
  "marquise":    "Маркиза кассетного типа на алюминиевом каркасе. Ткань 100% акрил 300 г/м², водостойкость 360 мм, защита от UV. Механизм и ткань полностью убираются в кассету. Стандартные цвета: антрацит (RAL 7016) и белый (RAL 9016), а также любой RAL под заказ. Ширина до 7 м, вылет до 4 м. Регулируемый угол наклона 15°–25°. Электромотор с пультом ДУ или управлением со смартфона. Монтаж к стене. Гарантия 1 год.",
  "panno":       "Террасная доска Panno из древесно-полимерного композита (ДПК) премиум класса. Не гниёт, не трескается, не требует окраски и лакировки. Поверхность имитирует натуральное дерево. Ширина доски 140–150 мм, толщина 25 мм. Монтаж на алюминиевые лаги со скрытыми креплениями — саморезов не видно. Оттенки: серый, коричневый, венге, натуральное дерево. Уход — только мытьё водой. Гарантия 10 лет.",
  "bilancio":    "Террасная доска Bilancio из древесно-полимерного композита (ДПК). Оптимальное соотношение цены и качества. Не гниёт, устойчива к UV и перепадам температур. Ширина 140–150 мм, толщина 22 мм. Монтаж на лаги со скрытыми креплениями. Оттенки: серый, коричневый, натуральное дерево. Гарантия 7 лет.",
  "railings":    "Алюминиевые перила для террас, балконов и лестниц. Заполнение: закалённое стекло 10 мм или нержавеющие вставки. Порошковая окраска в любой цвет RAL. Монтаж на готовое основание. Гарантия 1 год.",
};

const KP_PRODUCT_BENEFITS = {
  "greenawn":    ["Ламели до 110° — полная тень или максимум света", "Сливной лоток по периметру — дождь уходит незаметно", "Ветер до 120 км/ч, снег до 100 кг/м²", "Электропривод IP65 — работает при любой погоде", "LED / RGB подсветка с диммером в комплекте", "Ширина до 7 м, вынос до 8 м", "Настенный / отдельностоящий / подвесной монтаж"],
  "igs_premium": ["Полная герметичность при закрытии — ни капли воды", "Поворотные или сдвижные ламели на выбор", "Вода отводится через колонны незаметно", "5 конфигураций монтажа — любой объект", "Ветроустойчивость до 100 км/ч", "Ширина до 7 м, вынос до 7.25 м"],
  "toscana":     ["100% водонепроницаемость при закрытии", "Вылет до 13.5 м, модули без ограничений", "Ткань 850 г/м², водостойкое покрытие, UPF 50+", "Электромотор + пульт ДУ в комплекте", "6 типов монтажа", "Любой RAL по каталогу"],
  "toscana_maxi": ["100% водонепроницаемость при закрытии", "Усиленный каркас — увеличенный вылет", "Ткань 850 г/м², водостойкое покрытие, UPF 50+", "Электромотор + пульт ДУ в комплекте", "Любой RAL по каталогу"],
  "guhher":      ["Защита от солнца и осадков", "Акриловая ткань UPF 50+", "Ручное или моторное управление", "Любой RAL, быстрый монтаж"],
  "sliding":     ["Стеклопакет 20 мм (тёплая) / закалённое 10 мм (холодная)", "Ролики 120 кг — плавное бесшумное скольжение", "4 контура уплотнения — герметичность", "До 12 панелей, высота до 3.1 м"],
  "guillotine":  ["Нет вертикальных стоек — максимальная прозрачность", "Стеклопакет 20–28 мм, вариант с терморазрывом", "Круглогодичная эксплуатация −10°C…+40°C", "Автоматика с функцией обнаружения препятствий", "Фиксация в любом положении для вентиляции"],
  "zip":         ["ZIP-фиксация — без парусения при ветре", "Высота до 4 м", "Акриловая / затемняющая / ПВХ / москитная сетка", "Ручное или моторное управление"],
  "marquise":    ["Ткань 100% акрил, водостойкость 360 мм", "Ширина до 7 м, вылет до 3.5 м", "Угол наклона 15°–25° регулируемый", "Управление со смартфона", "Ткань и механизм скрыты в кассете"],
  "panno":       ["Не гниёт, не красится — 10 лет без забот", "Текстура натурального дерева", "Скрытые крепления — нет видимых саморезов", "Устойчивость к UV, морозу, влаге", "Гарантия 10 лет"],
  "bilancio":    ["Оптимальная цена при высоком качестве", "Не гниёт и не требует ухода", "Скрытые крепления", "Устойчивость к UV и перепадам температур", "Гарантия 7 лет"],
  "railings":    ["Любой RAL — порошковая окраска", "Стекло 10 мм или нержавейка", "Гарантия 1 год", "Быстрый монтаж"],
};



function ApproveModal({ client, items, discount, onClose }) {
  const [sent, setSent] = useState(false);
  const sub   = items.reduce((s, i) => s + calcItem(i), 0);
  const total = Math.round(sub * (1 - discount / 100));

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [liveRate, setLiveRate] = useState(USD_RATE);

  useEffect(()=>{
    fetch("https://api.exchangerate-api.com/v4/latest/USD")
      .then(r=>r.json())
      .then(d=>{ if(d?.rates?.KZT>100) setLiveRate(Math.round(d.rates.KZT)); })
      .catch(()=>{});
  },[]);

  // Только продажные данные — себестоимость/маржа считается ТОЛЬКО на сервере
  const rows = items.map(item => {
    const p    = PRODUCTS.find(p => p.id === item.productId);
    const area = ((item.width || 0) * (item.depth || 0)).toFixed(2);
    const qty  = item.quantity || 1;
    const sale = calcItem(item);
    return { p, area, qty, sale };
  });
  const totalSale = Math.round(sub * (1 - discount / 100));

  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:9000,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div onClick={e=>e.stopPropagation()}
        style={{background:"#111113",borderRadius:"22px 22px 0 0",width:"100%",maxWidth:520,maxHeight:"92vh",overflowY:"auto",border:"1px solid rgba(184,150,90,0.2)",boxShadow:"0 -16px 64px rgba(0,0,0,0.7)",padding:"24px 20px 32px"}}>

        {/* Шапка */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
          <div>
            <div style={{fontSize:11,color:"rgba(184,150,90,0.7)",fontWeight:700,letterSpacing:2,textTransform:"uppercase",marginBottom:3}}>Согласование скидки</div>
            <div style={{fontSize:18,fontWeight:800}}>👑 Отправить руководителю</div>
          </div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,width:36,height:36,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:16,color:"rgba(255,255,255,0.5)"}}>✕</button>
        </div>

        {/* Клиент */}
        <div style={{background:"rgba(255,255,255,0.04)",borderRadius:12,padding:"12px 14px",marginBottom:16,fontSize:13,color:"rgba(255,255,255,0.6)"}}>
          👤 <b style={{color:"#f4f4f5"}}>{client.name}</b>{client.phone ? ` · ${client.phone}` : ""}
          {discount > 0 && <span style={{marginLeft:8,background:"rgba(184,150,90,0.15)",color:"#b8965a",borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:700}}>Скидка {discount}%</span>}
        </div>

        {/* Позиции — только продажные цены, без себестоимости */}
        <div style={{marginBottom:16}}>
          {items.map((item, i) => {
            const p    = PRODUCTS.find(pr => pr.id === item.productId);
            const sale = calcItem(item);
            const area = ((item.width||0)*(item.depth||0)).toFixed(2);
            const qty  = item.quantity || 1;
            return (
              <div key={i} style={{background:"#1a1a1d",borderRadius:12,padding:"13px 14px",marginBottom:8,borderLeft:`3px solid ${p?.color||"#444"}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#f4f4f5"}}>{p?.emoji} {p?.shortName}</div>
                  <div style={{fontSize:14,fontWeight:800,color:"#b8965a",fontFamily:"monospace"}}>{new Intl.NumberFormat("ru-KZ").format(Math.round(sale))} ₸</div>
                </div>
                <div style={{fontSize:11,color:"rgba(255,255,255,0.4)",marginTop:4}}>
                  📐 {item.width}×{item.depth}м = {area}м²
                  {qty > 1 && <span style={{marginLeft:8}}>· 🔢 {qty} шт</span>}
                </div>
              </div>
            );
          })}
        </div>

        {/* Итог — только сумма клиенту */}
        <div style={{background:"linear-gradient(135deg,rgba(184,150,90,0.08),rgba(184,150,90,0.03))",border:"1px solid rgba(184,150,90,0.15)",borderRadius:14,padding:"16px",marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.5)"}}>💳 Итого клиенту{discount>0?` (−${discount}%)`:""}</div>
            <div style={{fontSize:20,fontWeight:800,color:"#b8965a",fontFamily:"monospace"}}>{new Intl.NumberFormat("ru-KZ").format(totalSale)} ₸</div>
          </div>
        </div>

        {/* Кнопка отправки руководителю */}
        <button
          disabled={sent||sending}
          onClick={async()=>{
            setSending(true); setSendError("");
            try {
              const r = await fetch("/api/send-approval", {
                method:"POST",
                headers:{"Content-Type":"application/json"},
                body:JSON.stringify({client, items, discount}),
              });
              const d = await r.json();
              if(d.ok) { setSent(true); }
              else { setSendError(d.error||"Ошибка отправки"); }
            } catch(e) { setSendError("Нет соединения с сервером"); }
            setSending(false);
          }}
          style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,width:"100%",
            background:sent?"linear-gradient(135deg,#3db96a,#2d9a54)":sending?"rgba(184,150,90,0.3)":"linear-gradient(135deg,#b8965a,#d4b878)",
            color:sent||!sending?"#09090b":"#b8965a",border:"none",borderRadius:14,padding:"15px",fontWeight:800,fontSize:15,cursor:sent||sending?"not-allowed":"pointer",
            fontFamily:"inherit",boxShadow:sent?"0 4px 16px rgba(61,185,106,0.3)":"0 4px 16px rgba(184,150,90,0.25)",transition:"all 0.3s"}}>
          {sent ? "✓ Отправлено руководителю на email" : sending ? "⏳ Отправляем…" : "👑 Отправить руководителю"}
        </button>
        {sendError&&<div style={{textAlign:"center",fontSize:12,color:"#dc2626",marginTop:6}}>{sendError}</div>}
        <div style={{textAlign:"center",fontSize:11,color:"rgba(255,255,255,0.2)",marginTop:8}}>
          Менеджер не видит себестоимость и маржу · Письмо уйдёт на email руководителя · Курс: $1 = {liveRate}₸
        </div>
      </div>
    </div>
  );
}

function Calculator({clients,kpClientId,setKpClientId,kpItems,setKpItems,kpStep,setKpStep,kpDiscount,setKpDiscount,onSaveKP,onAddClient,isMobile}){
  const[cs,setCs]=useState("");const[showAC,setShowAC]=useState(false);const[showPP,setShowPP]=useState(false);const[editIdx,setEditIdx]=useState(null);
  const[cur,setCur]=useState({productId:null,width:"",depth:"",selectedOptions:[],quantity:1,glazing:false,glazingSides:{front:true,back:true,left:true,right:true},glazingHeight:3,_priceMultiplier:1,_priceNote:undefined,_surchargeInput:""});const[copied,setCopied]=useState(false);const[saved,setSaved]=useState(false);const[showApprove,setShowApprove]=useState(false);const[kpPhoto,setKpPhoto]=useState(()=>{
    // Auto-load visual if one was selected from Visualizer
    if(kpClientId) {
      const stored = sessionStorage.getItem("igs_kp_visual_"+kpClientId);
      if(stored) { sessionStorage.removeItem("igs_kp_visual_"+kpClientId); return stored; }
    }
    return null;
  });const[photoUploading,setPhotoUploading]=useState(false);const[kpTpls,setKpTpls]=useState(()=>loadKPTemplates());
  // Синхр шаблонов КП
  useEffect(()=>{
    const unsub=dbListen("kp_templates",(data)=>{if(data)setKpTpls(data);});
    return unsub;
  },[]);
  const client=clients.find(c=>c.id===kpClientId);const total=kpItems.reduce((s,i)=>s+calcItem(i),0)*(1-kpDiscount/100);

  function startNew(){setKpClientId(null);setKpItems([]);setKpStep(1);setKpDiscount(0);setCopied(false);setSaved(false);setKpPhoto(null);}
  function addItem(){if(!cur.productId||!cur.width||!cur.depth)return;
  const isBio = ["greenawn","igs_premium","toscana","guhher"].includes(cur.productId);
  const item={...cur,width:parseFloat(cur.width),depth:parseFloat(cur.depth),quantity:parseInt(cur.quantity)||1};
  // Если выбрано остекление — добавляем как отдельную позицию
  if(isBio && cur.glazing) {
    const h = parseFloat(cur.glazingHeight)||3;
    const w = parseFloat(cur.width); const d = parseFloat(cur.depth);
    const sides = cur.glazingSides||{front:true,back:true,left:true,right:true};
    const area = ((sides.front?w:0)+(sides.back?w:0)+(sides.left?d:0)+(sides.right?d:0))*h;
    const parentName = {greenawn:"Биоклим. (Поворотная)",igs_premium:"Биоклим. Premium",toscana:"Тентовая",guhher:"Guhher"}[cur.productId]||cur.productId;
    const newItems = [item];
    // Позиция 1: фронт + зад = ширина × высота × 2 шт
    const frontBack = (sides.front?1:0)+(sides.back?1:0);
    if(frontBack>0) newItems.push({
      id: Date.now().toString()+"_gl1",
      productId:"sliding", width:w, depth:h,
      quantity:frontBack, selectedOptions:[],
      _autoGlazing:true,
      _parentNote:`Остекление к ${parentName} (${w}×${d}м) — фронт/зад`,
    });
    // Позиция 2: левая + правая = глубина × высота × 2 шт
    const leftRight = (sides.left?1:0)+(sides.right?1:0);
    if(leftRight>0) newItems.push({
      id: Date.now().toString()+"_gl2",
      productId:"sliding", width:d, depth:h,
      quantity:leftRight, selectedOptions:[],
      _autoGlazing:true,
      _parentNote:`Остекление к ${parentName} (${w}×${d}м) — бок`,
    });
    if(editIdx!==null){const u=[...kpItems];u[editIdx]=item;setKpItems(u);setEditIdx(null);}
    else setKpItems(prev=>[...prev,...newItems]);
    setCur({productId:null,width:"",depth:"",selectedOptions:[],quantity:1,glazing:false,glazingSides:{front:true,back:true,left:true,right:true},glazingHeight:3,_priceMultiplier:1,_priceNote:undefined,_surchargeInput:""});
    setShowPP(false); return;
  }
  // Обычное добавление
  if(editIdx!==null){const u=[...kpItems];u[editIdx]=item;setKpItems(u);setEditIdx(null);}else setKpItems([...kpItems,item]);
  setCur({productId:null,width:"",depth:"",selectedOptions:[],quantity:1,glazing:false,glazingSides:{front:true,back:true,left:true,right:true},glazingHeight:3,_priceMultiplier:1,_priceNote:undefined,_surchargeInput:""});
  setShowPP(false);}
  function copyKP(){if(!client)return;navigator.clipboard?.writeText(generateKPText(client,kpItems,kpDiscount)).catch(()=>{});setCopied(true);setTimeout(()=>setCopied(false),3000);}
  function saveKP(){if(!client||kpItems.length===0)return;onSaveKP(kpClientId,kpItems,kpDiscount);setSaved(true);setTimeout(()=>setSaved(false),2000);}
  const fc=clients.filter(c=>{const q=cs.toLowerCase();return!cs||c.name?.toLowerCase().includes(q)||c.phone?.includes(q);});

  const Steps=()=>(
    <div style={{display:"flex",gap:6,alignItems:"center"}}>
      {["Клиент","Позиции","КП"].map((label,i)=>(
        <div key={i} style={{display:"flex",alignItems:"center",gap:5}}>
          <div style={{width:22,height:22,borderRadius:11,background:kpStep>i+1?"linear-gradient(135deg,#3db96a,#2d9a54)":kpStep===i+1?"linear-gradient(135deg,#c9a84c,#a8893a)":"rgba(255,255,255,0.06)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:kpStep>=i+1?"#fff":T.textDim,transition:"all 0.3s"}}>{kpStep>i+1?"✓":i+1}</div>
          <span style={{fontSize:11,color:kpStep===i+1?T.gold:T.textDim,fontWeight:kpStep===i+1?700:400}}>{label}</span>
          {i<2&&<span style={{color:T.textDim,fontSize:10}}>›</span>}
        </div>
      ))}
    </div>
  );

  return(
    <div className="fade-in">
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div>
          {!isMobile&&<div style={{fontSize:10,color:T.textDim,letterSpacing:3,marginBottom:3,fontWeight:600}}>РАСЧЁТ</div>}
          <div style={{fontSize:isMobile?22:28,fontWeight:800,fontFamily:T.serif}}>🧮 Расчёт КП</div>
        </div>
        <div style={{display:"flex",gap:9,alignItems:"center"}}>
          <Steps/>
          {(kpClientId||kpItems.length>0)&&<Btn variant="ghost" onClick={startNew} style={{fontSize:11,padding:"7px 13px"}}>Сбросить</Btn>}
        </div>
      </div>
      <div style={{paddingBottom:isMobile?110:0}}>
        {kpStep===1&&(
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <Inp value={cs} onChange={e=>setCs(e.target.value)} placeholder="Поиск клиента…"/>
            <Btn variant="ghost" onClick={()=>setShowAC(true)} style={{justifyContent:"center"}}>➕ Новый клиент</Btn>
            {fc.map(c=>{const st=STATUSES.find(s=>s.id===c.status);return(
              <Card key={c.id} onClick={()=>{setKpClientId(c.id);setKpStep(2);}} style={{padding:"13px 15px",display:"flex",alignItems:"center",gap:12,cursor:"pointer"}}>
                <div style={{flex:1}}><div style={{fontSize:14,fontWeight:600}}>{c.name}</div><div style={{fontSize:12,color:T.textSec}}>{c.phone}</div></div>
                <Tag color={st?.color} light={st?.light}>{st?.label}</Tag>
              </Card>
            );})}
          </div>
        )}
        {kpStep===2&&(
          <div style={{display:"flex",flexDirection:"column",gap:11}}>
            <GlassCard style={{padding:"13px 16px",display:"flex",alignItems:"center",gap:10}}>
              <div style={{fontSize:20}}>👤</div>
              <div style={{flex:1}}><div style={{fontSize:14,fontWeight:600}}>{client?.name}</div><div style={{fontSize:12,color:T.textSec}}>{client?.phone}</div></div>
              <button onClick={()=>setKpStep(1)} style={{background:"none",border:"none",color:T.textSec,cursor:"pointer",fontSize:12,fontFamily:T.font,fontWeight:600}}>Сменить</button>
            </GlassCard>

            {kpItems.map((item,idx)=>{const p=PRODUCTS.find(pr=>pr.id===item.productId);return(
              <GlassCard key={idx} style={{padding:"14px 16px",borderLeft:`3px solid ${p?.color||T.border}`}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <div style={{fontSize:14,fontWeight:700}}>{p?.emoji} {p?.shortName}</div>
                  <div style={{fontSize:16,fontWeight:800,color:T.gold,fontFamily:T.mono}}>{fmt(calcItem(item))}</div>
                </div>
                <div style={{fontSize:12,color:T.textSec}}>📐 {item.width}×{item.depth}м = {(item.width*item.depth).toFixed(2)}м²{item.quantity>1?` · 🔢 ${item.quantity} шт`:""}</div>
                {item._autoGlazing&&<div style={{fontSize:10,color:"#1a6b8a",marginTop:2}}>🔗 {item._parentNote}</div>}
                {item.selectedOptions?.length>0&&<div style={{fontSize:11,color:T.textSec,marginTop:3}}>⚙️ {item.selectedOptions.map(oid=>p?.options.find(o=>o.id===oid)?.label).join(", ")}</div>}
                <div style={{display:"flex",gap:10,marginTop:8}}>
                  <button onClick={()=>{setCur({productId:item.productId,width:String(item.width),depth:String(item.depth),selectedOptions:item.selectedOptions||[],quantity:item.quantity||1});setEditIdx(idx);setShowPP(true);}} style={{fontSize:12,background:"none",border:"none",color:T.textSec,cursor:"pointer",fontWeight:600}}>✏️ Изменить</button>
                  <button onClick={()=>setKpItems(kpItems.filter((_,i)=>i!==idx))} style={{fontSize:12,background:"none",border:"none",color:T.danger,cursor:"pointer",fontWeight:600}}>🗑️ Удалить</button>
                </div>
              </GlassCard>
            );})}

            {!showPP&&<Btn variant="ghost" onClick={()=>{setCur({productId:null,width:"",depth:"",selectedOptions:[]});setEditIdx(null);setShowPP(true);}} style={{justifyContent:"center"}}>➕ Добавить позицию</Btn>}

            {showPP&&(
              <GlassCard style={{padding:18,borderTop:`2px solid ${T.gold}`}}>
                <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:T.gold}}>{editIdx!==null?"Редактировать":"Новая позиция"}</div>
                <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
                  {PRODUCTS.map(p=>(
                    <button key={p.id} onClick={()=>setCur({...cur,productId:p.id,selectedOptions:[],glazing:false,glazingSides:{front:true,back:true,left:true,right:true}})} style={{background:cur.productId===p.id?`${p.color}15`:"rgba(255,255,255,0.02)",border:`1px solid ${cur.productId===p.id?`${p.color}40`:T.border}`,borderRadius:12,padding:"10px 13px",display:"flex",alignItems:"center",gap:10,cursor:"pointer",textAlign:"left",transition:"all 0.2s"}}>
                      <span style={{fontSize:18}}>{p.emoji}</span>
                      <div style={{flex:1}}><div style={{fontSize:12,fontWeight:600,color:T.text}}>{p.name}</div><div style={{fontSize:11,color:T.textSec}}>{fmt(p.price)}/м²</div></div>
                      {cur.productId===p.id&&<span style={{color:p.color,fontWeight:700}}>✓</span>}
                    </button>
                  ))}
                </div>
                {cur.productId&&(
                  <>
                    <div style={{display:"flex",gap:10,marginBottom:12}}>
                      {[["ШИРИНА (м)","width","4.5"],["ГЛУБИНА (м)","depth","3.0"]].map(([label,key,ph])=>(
                        <div key={key} style={{flex:1}}><div style={{fontSize:9,color:T.textDim,marginBottom:4,fontWeight:700,letterSpacing:1}}>{label}</div><Inp type="number" value={cur[key]} onChange={e=>setCur({...cur,[key]:e.target.value})} placeholder={ph} step="0.1" min="0"/></div>
                      ))}
                    </div>
                    <div style={{marginBottom:12}}>
                      <div style={{fontSize:9,color:T.textDim,marginBottom:4,fontWeight:700,letterSpacing:1}}>КОЛ-ВО (ШТ / СЕКЦИЙ)</div>
                      <div style={{display:"flex",gap:6,alignItems:"center"}}>
                        <button onClick={()=>setCur({...cur,quantity:Math.max(1,(parseInt(cur.quantity)||1)-1)})} style={{width:34,height:34,borderRadius:8,background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,color:T.text,fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:T.font,flexShrink:0}}>−</button>
                        <Inp type="number" value={cur.quantity||1} onChange={e=>setCur({...cur,quantity:Math.max(1,parseInt(e.target.value)||1)})} min="1" step="1" style={{textAlign:"center",fontWeight:700,fontSize:16}}/>
                        <button onClick={()=>setCur({...cur,quantity:(parseInt(cur.quantity)||1)+1})} style={{width:34,height:34,borderRadius:8,background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,color:T.text,fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:T.font,flexShrink:0}}>+</button>
                      </div>
                      <div style={{fontSize:10,color:T.textDim,marginTop:4}}>Напр. 3 секции слайдинга, 2 пролёта перголы</div>
                    </div>
                    {/* ── Остекление Слайдинг для биоперголы ── */}
                    {["greenawn","igs_premium","toscana","guhher"].includes(cur.productId)&&cur.width&&cur.depth&&(
                      <div style={{marginBottom:12}}>
                        <button onClick={()=>setCur({...cur,glazing:!cur.glazing})}
                          style={{display:"flex",alignItems:"center",gap:9,width:"100%",background:cur.glazing?T.goldBg:"rgba(255,255,255,0.02)",border:`1px solid ${cur.glazing?"rgba(201,168,76,0.3)":T.border}`,borderRadius:10,padding:"10px 13px",cursor:"pointer",textAlign:"left",transition:"all 0.2s"}}>
                          <div style={{width:18,height:18,borderRadius:9,border:`2px solid ${cur.glazing?T.gold:T.border}`,background:cur.glazing?T.gold:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.2s"}}>
                            {cur.glazing&&<span style={{color:"#060b07",fontSize:10,fontWeight:700}}>✓</span>}
                          </div>
                          <div style={{flex:1}}>
                            <div style={{fontSize:13,color:T.text,fontWeight:600}}>🪟 Добавить остекление Слайдинг</div>
                            <div style={{fontSize:11,color:T.textSec}}>Считается автоматически по размерам перголы</div>
                          </div>
                        </button>
                        {cur.glazing&&(
                          <div style={{background:"rgba(26,107,138,0.08)",border:"1px solid rgba(26,107,138,0.2)",borderRadius:12,padding:12,marginTop:8}}>
                            <div style={{fontSize:10,color:"rgba(26,107,138,0.9)",fontWeight:700,letterSpacing:1,marginBottom:10}}>СТОРОНЫ ОСТЕКЛЕНИЯ</div>
                            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:10}}>
                              {[["front","Фронт",parseFloat(cur.width)||0],["back","Зад",parseFloat(cur.width)||0],["left","Левая",parseFloat(cur.depth)||0],["right","Правая",parseFloat(cur.depth)||0]].map(([key,label,len])=>{
                                const sel=(cur.glazingSides||{})[key]!==false;
                                return(
                                  <button key={key} onClick={()=>setCur({...cur,glazingSides:{...(cur.glazingSides||{front:true,back:true,left:true,right:true}),[key]:!sel}})}
                                    style={{display:"flex",alignItems:"center",gap:7,background:sel?"rgba(26,107,138,0.15)":"rgba(255,255,255,0.02)",border:`1px solid ${sel?"rgba(26,107,138,0.4)":T.border}`,borderRadius:9,padding:"8px 10px",cursor:"pointer",textAlign:"left",transition:"all 0.2s"}}>
                                    <div style={{width:16,height:16,borderRadius:8,border:`2px solid ${sel?"#1a6b8a":T.border}`,background:sel?"#1a6b8a":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                                      {sel&&<span style={{color:"#fff",fontSize:9,fontWeight:700}}>✓</span>}
                                    </div>
                                    <div>
                                      <div style={{fontSize:11,color:T.text,fontWeight:600}}>{label}</div>
                                      <div style={{fontSize:10,color:T.textSec}}>{len}м × 3м</div>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                            {(()=>{
                              const h=3; const w=parseFloat(cur.width)||0; const d=parseFloat(cur.depth)||0;
                              const s=cur.glazingSides||{front:true,back:true,left:true,right:true};
                              const fb=(s.front?1:0)+(s.back?1:0);
                              const lr=(s.left?1:0)+(s.right?1:0);
                              const area1=w*h*fb; const area2=d*h*lr;
                              const total=(area1+area2)*100000;
                              return (area1>0||area2>0)?(
                                <div style={{background:"rgba(26,107,138,0.1)",borderRadius:8,padding:"8px 10px",fontSize:12}}>
                                  {area1>0&&<div style={{color:T.textSec}}>Фронт/зад: <b style={{color:"#1a6b8a"}}>{w}×3м × {fb} шт = {area1.toFixed(1)}м²</b></div>}
                                  {area2>0&&<div style={{color:T.textSec,marginTop:2}}>Боковые: <b style={{color:"#1a6b8a"}}>{d}×3м × {lr} шт = {area2.toFixed(1)}м²</b></div>}
                                  <div style={{color:T.textSec,marginTop:4,paddingTop:4,borderTop:"1px solid rgba(26,107,138,0.2)"}}>Итого: <b style={{color:"#1a6b8a",fontFamily:T.mono}}>{fmt(total)}</b></div>
                                </div>
                              ):null;
                            })()}
                          </div>
                        )}
                      </div>
                    )}
                    {cur.width&&cur.depth&&(
                      <div style={{background:T.goldBg,border:`1px solid ${cur._priceMultiplier&&cur._priceMultiplier>1?"rgba(217,119,6,0.35)":"rgba(201,168,76,0.15)"}`,borderRadius:12,padding:12,marginBottom:12}}>
                        <div style={{fontSize:11,color:T.textSec,marginBottom:2}}>Площадь: {(parseFloat(cur.width)*parseFloat(cur.depth)).toFixed(2)} м²</div>
                        <div style={{fontSize:18,fontWeight:800,color:T.gold,fontFamily:T.mono,marginTop:3}}>
                          ≈ {fmt(calcItem({...cur,width:parseFloat(cur.width),depth:parseFloat(cur.depth)}))}
                          {cur._priceMultiplier&&cur._priceMultiplier>1&&<span style={{fontSize:12,color:"#d97706",marginLeft:6}}>+{Math.round((cur._priceMultiplier-1)*100)}%</span>}
                        </div>
                        <div style={{marginTop:10}}>
                          <div style={{fontSize:9,color:T.textDim,fontWeight:700,letterSpacing:1,marginBottom:6}}>НАДБАВКА ЗА НЕСТАНДАРТНЫЙ РАЗМЕР (%)</div>
                          <div style={{display:"flex",gap:8,alignItems:"center"}}>
                            <div style={{position:"relative",flex:1}}>
                              <Inp
                                type="number" min="0" max="200" step="1"
                                placeholder="0"
                                value={cur._surchargeInput||""}
                                onChange={e=>{
                                  const pct=Math.max(0,parseFloat(e.target.value)||0);
                                  const mul=pct>0?1+pct/100:1;
                                  setCur({...cur,_surchargeInput:e.target.value,_priceMultiplier:mul,_priceNote:pct>0?`Индивидуальный заказ (+${pct}%)`:undefined});
                                }}
                                style={{paddingRight:28}}
                              />
                              <span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",fontSize:13,color:T.textSec,pointerEvents:"none"}}>%</span>
                            </div>
                            {cur._priceMultiplier>1&&(
                              <button onClick={()=>setCur({...cur,_surchargeInput:"",_priceMultiplier:1,_priceNote:undefined})}
                                style={{background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,borderRadius:8,padding:"8px 12px",fontSize:12,color:T.textSec,cursor:"pointer",fontFamily:T.font,whiteSpace:"nowrap"}}>
                                ✕ сброс
                              </button>
                            )}
                          </div>
                          {cur._priceMultiplier>1&&(
                            <div style={{marginTop:6,fontSize:10,color:"rgba(217,119,6,0.7)"}}>⚠️ Пояснение будет указано в КП клиенту</div>
                          )}
                        </div>
                      </div>
                    )}
                    {PRODUCTS.find(p=>p.id===cur.productId)?.options?.length>0&&(
                      <div style={{marginBottom:12}}>
                        <div style={{fontSize:10,color:T.textSec,marginBottom:7,fontWeight:700,letterSpacing:1}}>ОПЦИИ</div>
                        <div style={{display:"flex",flexDirection:"column",gap:6}}>
                          {PRODUCTS.find(p=>p.id===cur.productId).options.map(opt=>{
                            const sel=cur.selectedOptions.includes(opt.id);
                            const w=parseFloat(cur.width||0), d=parseFloat(cur.depth||0);
                            const area=w*d;
                            const optPrice = opt.flat ? opt.price : opt.id==="screen" ? opt.price*(w+d)*2*3 : opt.price*area;
                            const optLabel = opt.flat ? "(фикс)" : opt.id==="screen" ? `(${((w+d)*2*3).toFixed(1)}м² периметр×3м)` : "/м²";
                            return(
                              <button key={opt.id} onClick={()=>setCur({...cur,selectedOptions:sel?cur.selectedOptions.filter(o=>o!==opt.id):[...cur.selectedOptions,opt.id]})} style={{display:"flex",alignItems:"center",gap:9,background:sel?T.goldBg:"rgba(255,255,255,0.02)",border:`1px solid ${sel?"rgba(201,168,76,0.2)":T.border}`,borderRadius:10,padding:"9px 12px",cursor:"pointer",textAlign:"left",transition:"all 0.2s"}}>
                                <div style={{width:18,height:18,borderRadius:9,border:`2px solid ${sel?T.gold:T.border}`,background:sel?T.gold:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.2s"}}>{sel&&<span style={{color:"#060b07",fontSize:10,fontWeight:700}}>✓</span>}</div>
                                <div style={{flex:1}}><div style={{fontSize:13,color:T.text}}>{opt.label}</div><div style={{fontSize:11,color:T.textSec}}>+{fmt(optPrice)} {optLabel}</div></div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <div style={{display:"flex",gap:8}}>
                      <Btn variant="primary" disabled={!cur.width||!cur.depth} onClick={addItem} style={{flex:1,justifyContent:"center"}}>{editIdx!==null?"Сохранить":"Добавить"}</Btn>
                      <Btn variant="ghost" onClick={()=>{setShowPP(false);setEditIdx(null);}} style={{padding:"10px 15px"}}>✕</Btn>
                    </div>
                  </>
                )}
              </GlassCard>
            )}

            {kpItems.length>0&&(
              <GlassCard style={{padding:14}}>
                <div style={{fontSize:10,color:T.textSec,marginBottom:8,fontWeight:700,letterSpacing:1}}>СКИДКА (%)</div>
                <div style={{display:"flex",gap:6}}>{[0,3,5,7,10,15].map(d=><button key={d} onClick={()=>setKpDiscount(d)} style={{flex:1,background:kpDiscount===d?"linear-gradient(135deg,#c9a84c,#a8893a)":"rgba(255,255,255,0.03)",color:kpDiscount===d?"#060b07":T.text,border:`1px solid ${kpDiscount===d?"transparent":T.border}`,borderRadius:9,padding:"8px 0",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:T.font,transition:"all 0.2s"}}>{d}%</button>)}</div>
              </GlassCard>
            )}

            {kpItems.length>0&&(
              <>
                <div style={{background:"linear-gradient(135deg,rgba(201,168,76,0.1),rgba(201,168,76,0.04))",border:"1px solid rgba(201,168,76,0.15)",borderRadius:16,padding:18}}>
                  <div style={{fontSize:12,color:T.textSec,fontWeight:600}}>ИТОГО{kpDiscount>0?` (скидка ${kpDiscount}%)`:""}</div>
                  <div style={{fontSize:30,fontWeight:800,color:T.gold,fontFamily:T.mono,marginTop:2}}>{fmt(total)}</div>
                  <div style={{fontSize:12,color:T.textSec,marginTop:4}}>Предоплата 70%: {fmt(Math.round(total*0.7))}</div>
                </div>
                <Btn variant="primary" onClick={()=>setKpStep(3)} style={{justifyContent:"center",width:"100%",padding:"13px",fontSize:15}}>Сформировать КП →</Btn>
              </>
            )}
          </div>
        )}
        {kpStep===3&&client&&(
          <div style={{display:"flex",flexDirection:"column",gap:11}}>
            <Btn variant="ghost" onClick={()=>setKpStep(2)} style={{alignSelf:"flex-start",fontSize:12,padding:"7px 13px"}}>← Назад</Btn>

            {/* Живой превью КП в iframe */}
            <GlassCard style={{padding:0,overflow:"hidden",borderTop:`2px solid ${T.gold}`}}>
              <div style={{padding:"10px 14px",borderBottom:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontSize:10,color:T.gold,fontWeight:700,letterSpacing:2}}>ПРЕДПРОСМОТР КП</div>
                <div style={{fontSize:11,color:T.textSec}}>{fmt(total)}</div>
              </div>
              <iframe
                srcDoc={generateClientKPHtml(client, kpItems, kpDiscount, kpPhoto, kpTpls)}
                style={{width:"100%",height:420,border:"none",display:"block",background:"#fff"}}
                title="КП предпросмотр"
                sandbox="allow-same-origin"
              />
            </GlassCard>
            
              {/* ── Фото для КП ── */}
              <GlassCard style={{padding:"14px 16px",marginBottom:4}}>
                <div style={{fontSize:11,fontWeight:700,color:T.textSec,letterSpacing:1,marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  ФОТО В КП
                  <span style={{fontSize:10,color:T.textDim,fontWeight:400}}>Показывается под шапкой, на всю ширину</span>
                </div>
                {kpPhoto?(
                  <div style={{position:"relative",borderRadius:10,overflow:"hidden",marginBottom:8,border:"1px solid rgba(184,150,90,0.2)"}}>
                    <img src={kpPhoto} alt="" style={{width:"100%",display:"block",maxHeight:240,objectFit:"contain",background:"#000"}}/>
                    <button onClick={()=>setKpPhoto(null)}
                      style={{position:"absolute",top:6,right:6,background:"rgba(0,0,0,0.7)",border:"none",borderRadius:"50%",width:28,height:28,color:"#fff",cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                    <div style={{position:"absolute",bottom:6,left:8,fontSize:10,color:"rgba(255,255,255,0.5)",background:"rgba(0,0,0,0.5)",padding:"2px 7px",borderRadius:4}}>Полное фото в КП</div>
                  </div>
                ):null}
                {/* Визуалы клиента — быстрый выбор */}
                {client&&(client.visuals||[]).length>0&&(
                  <div style={{marginBottom:10}}>
                    <div style={{fontSize:10,color:T.textDim,marginBottom:6,fontWeight:600,letterSpacing:1}}>ВИЗУАЛЫ КЛИЕНТА</div>
                    <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                      {(client.visuals||[]).map((v,i)=>(
                        <button key={i} onClick={()=>setKpPhoto(v.url)}
                          style={{padding:0,border:`2px solid ${kpPhoto===v.url?"#b8965a":"rgba(255,255,255,0.1)"}`,borderRadius:9,overflow:"hidden",cursor:"pointer",background:"none",transition:"all 0.2s",flexShrink:0}}>
                          <img src={v.url} alt={v.product} style={{width:68,height:50,objectFit:"cover",display:"block"}}/>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <label style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"rgba(184,150,90,0.06)",border:"1px dashed rgba(184,150,90,0.25)",borderRadius:10,padding:"11px",cursor:"pointer"}}>
                  <input type="file" accept="image/*" style={{display:"none"}}
                    onChange={e=>{
                      const file=e.target.files?.[0];
                      if(!file) return;
                      setPhotoUploading(true);
                      const reader=new FileReader();
                      reader.onload=ev=>{ setKpPhoto(ev.target.result); setPhotoUploading(false); };
                      reader.onerror=()=>setPhotoUploading(false);
                      reader.readAsDataURL(file);
                    }}/>
                  <span style={{fontSize:13,color:T.gold,fontWeight:600}}>
                    {photoUploading?"Загружаю...":kpPhoto?"Заменить фото":"📷 Добавить фото в КП"}
                  </span>
                </label>
              </GlassCard>

<div style={{display:"flex",flexDirection:"column",gap:8}}>
              {/* ── Скачать КП как PDF ── */}
              <button onClick={()=>{
                const kpHtml = generateClientKPHtml(client, kpItems, kpDiscount, kpPhoto, kpTpls);
                printHtmlSafe(kpHtml);
                saveKP();
              }}
                style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"linear-gradient(135deg,#1e3a5f,#2d5a8e)",color:"#fff",border:"none",borderRadius:13,padding:"14px",fontWeight:700,fontSize:15,cursor:"pointer",fontFamily:T.font,boxShadow:"0 4px 16px rgba(30,58,95,0.3)"}}>
                Скачать КП (PDF)
              </button>
              {/* ── Отправить клиенту в WhatsApp (текст) ── */}
              {client.phone&&(
                <a href={`https://wa.me/${client.phone.replace(/\D/g,"")}?text=${encodeURIComponent(generateKPText(client,kpItems,kpDiscount))}`}
                  target="_blank" rel="noreferrer"
                  style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"rgba(37,211,102,0.1)",color:"#25D366",border:"1px solid rgba(37,211,102,0.25)",borderRadius:13,padding:"12px",fontWeight:600,fontSize:14,cursor:"pointer",fontFamily:T.font,textDecoration:"none"}}>
                  Текст в WhatsApp
                </a>
              )}
              {/* ── Согласовать скидку у руководителя ── */}
              <button onClick={()=>setShowApprove(true)}
                style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"rgba(184,150,90,0.08)",color:T.gold,border:`1px solid rgba(184,150,90,0.25)`,borderRadius:13,padding:"13px",fontWeight:600,fontSize:14,cursor:"pointer",fontFamily:T.font,transition:"all 0.2s"}}
                onMouseEnter={e=>{e.currentTarget.style.background="rgba(184,150,90,0.15)";}}
                onMouseLeave={e=>{e.currentTarget.style.background="rgba(184,150,90,0.08)";}}>
                Согласовать с руководителем
              </button>
              <Btn variant={saved?"green":"ghost"} onClick={saveKP} style={{justifyContent:"center",padding:"11px",fontSize:13}}>{saved?"Сохранено":"Сохранить в карточку"}</Btn>
            </div>
            {/* ── Модал согласования со скидкой ── */}
            {showApprove&&(
              <ApproveModal
                client={client}
                items={kpItems}
                discount={kpDiscount}
                onClose={()=>setShowApprove(false)}
              />
            )}
          </div>
        )}
      </div>
      <AddClientModal open={showAC} onClose={()=>setShowAC(false)} onAdd={data=>{const c=onAddClient(data);if(c){setKpClientId(c.id);setKpStep(2);}setShowAC(false);}}/>
    </div>
  );
}

// ─── PRODUCT VISUALIZATIONS ───────────────────────────────────────────────────
function Arrow({x1,y1,x2,y2,label,align="start",col="0.4"}){
  return<g>
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={`rgba(255,255,255,${col})`} strokeWidth={0.7} strokeDasharray="3,2"/>
    <circle cx={x1} cy={y1} r={1.5} fill={`rgba(255,255,255,${col})`}/>
    <text x={x2+(align==="end"?-4:4)} y={y2+3} textAnchor={align} fill="rgba(255,255,255,0.6)" fontSize="8" fontFamily="'Satoshi',sans-serif" fontWeight="500">{label}</text>
  </g>;
}

function ProductViz({productId,color}){
  const[pct,setPct]=useState(0);
  const[playing,setPlaying]=useState(false);
  const[opts,setOpts]=useState({});
  const[mode,setMode]=useState("day");
  const animRef=useRef(null);

  function animate(reverse){
    setPlaying(true);
    let start=null;const dur=2500;const from=pct;const to=reverse?0:100;
    function step(ts){
      if(!start)start=ts;const p=Math.min((ts-start)/dur,1);
      const ease=p<0.5?2*p*p:1-Math.pow(-2*p+2,2)/2;
      setPct(Math.round((from+(to-from)*ease)*10)/10);
      if(p<1)animRef.current=requestAnimationFrame(step);else setPlaying(false);
    }
    animRef.current=requestAnimationFrame(step);
  }
  useEffect(()=>()=>cancelAnimationFrame(animRef.current),[]);
  const tog=(k)=>setOpts(p=>({...p,[k]:!p[k]}));

  const W=400,H=300,floorY=250;
  const cc=(o)=>`rgba(255,255,255,${o})`;
  const isNight=mode==="night",isRain=mode==="rain";

  const Controls=({label,revLabel})=>(
    <div style={{display:"flex",gap:6,marginTop:10,flexWrap:"wrap",alignItems:"center"}}>
      <button onClick={()=>animate(pct>=50)} disabled={playing} style={{background:playing?"rgba(255,255,255,0.03)":"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:10,padding:"7px 16px",fontSize:12,color:playing?"rgba(255,255,255,0.3)":"#fff",cursor:playing?"not-allowed":"pointer",fontFamily:T.font,fontWeight:600}}>{pct<50?`▶ ${label}`:`◀ ${revLabel||"Назад"}`}</button>
      <input type="range" min={0} max={100} value={pct} onChange={e=>{if(!playing)setPct(+e.target.value);}} style={{flex:1,minWidth:80,accentColor:color}}/>
      <span style={{fontSize:11,color:cc("0.5"),fontFamily:T.mono,minWidth:35}}>{Math.round(pct)}%</span>
    </div>
  );
  const OptToggles=({options})=>(
    <div style={{display:"flex",gap:5,marginTop:8,flexWrap:"wrap"}}>
      {options.map(([key,label,icon])=><button key={key} onClick={()=>tog(key)} style={{background:opts[key]?"rgba(201,168,76,0.12)":"rgba(255,255,255,0.03)",border:`1px solid ${opts[key]?"rgba(201,168,76,0.3)":"rgba(255,255,255,0.08)"}`,borderRadius:8,padding:"5px 10px",fontSize:11,color:opts[key]?"#c9a84c":"rgba(255,255,255,0.5)",cursor:"pointer",fontFamily:T.font,fontWeight:600}}>{icon} {label}</button>)}
    </div>
  );
  const WeatherBtns=()=>(
    <div style={{display:"flex",gap:4,marginTop:8}}>
      {[["day","☀️ День"],["night","🌙 Ночь"],["rain","🌧️ Дождь"]].map(([m,l])=><button key={m} onClick={()=>setMode(m)} style={{background:mode===m?"rgba(255,255,255,0.1)":"transparent",border:`1px solid ${mode===m?"rgba(255,255,255,0.2)":"rgba(255,255,255,0.06)"}`,borderRadius:8,padding:"4px 10px",fontSize:11,color:mode===m?"#fff":"rgba(255,255,255,0.4)",cursor:"pointer",fontFamily:T.font}}>{l}</button>)}
    </div>
  );
  const StatusBar=({text})=>(<><rect x={W/2-75} y={H-18} width={150} height={16} fill={cc("0.04")} rx={6}/><text x={W/2} y={H-8} textAnchor="middle" fill={cc("0.5")} fontSize="9" fontFamily="'Satoshi',sans-serif" fontWeight="600">{text}</text></>);
  const FloorLine=()=>(<><rect x={20} y={floorY} width={W-40} height={1} fill={cc("0.12")}/><rect x={20} y={floorY+1} width={W-40} height={12} fill={cc("0.02")} rx={2}/></>);
  const DimH=({x,y1:a,y2:b,label})=>(<g><line x1={x} y1={a} x2={x} y2={b} stroke={cc("0.15")} strokeWidth={0.5}/><line x1={x-3} y1={a} x2={x+3} y2={a} stroke={cc("0.15")} strokeWidth={0.5}/><line x1={x-3} y1={b} x2={x+3} y2={b} stroke={cc("0.15")} strokeWidth={0.5}/><text x={x-3} y={(a+b)/2+3} textAnchor="end" fill={cc("0.25")} fontSize="7" fontFamily="'JetBrains Mono',monospace">{label}</text></g>);
  const DimW=({y,x1:a,x2:b,label})=>(<g><line x1={a} y1={y} x2={b} y2={y} stroke={cc("0.15")} strokeWidth={0.5}/><line x1={a} y1={y-3} x2={a} y2={y+3} stroke={cc("0.15")} strokeWidth={0.5}/><line x1={b} y1={y-3} x2={b} y2={y+3} stroke={cc("0.15")} strokeWidth={0.5}/><text x={(a+b)/2} y={y+12} textAnchor="middle" fill={cc("0.25")} fontSize="7" fontFamily="'JetBrains Mono',monospace">{label}</text></g>);

  // ═══ GREENAWN ═══
  if(productId==="greenawn"){
    const angle=pct/100*135,rad=angle*Math.PI/180;
    const numL=9,lW=26,lGap=4,topY=75;
    const lH=Math.max(Math.abs(Math.cos(rad))*16,2);
    const sideH=Math.sin(rad)*8;
    return(<div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{background:isNight?"rgba(0,0,20,0.5)":"rgba(0,0,0,0.3)",borderRadius:14}}>
        <rect x={40} y={topY-14} width={W-80} height={8} fill={cc("0.12")} rx={2}/>
        <rect x={40} y={topY-6} width={W-80} height={4} fill={cc("0.06")}/>
        <Arrow x1={W/2} y1={topY-14} x2={W/2} y2={topY-28} label="Алюминиевая рама 6063-T6"/>
        {[48,W/3+10,W*2/3-10,W-55].map((cx,i)=><g key={`c${i}`}>
          <rect x={cx} y={topY-2} width={9} height={floorY-topY+2} fill={cc("0.1")} rx={1}/>
          <rect x={cx+1} y={topY-2} width={3} height={floorY-topY+2} fill={cc("0.04")}/>
          <rect x={cx-3} y={floorY-5} width={15} height={6} fill={cc("0.08")} rx={1}/>
          {isRain&&<><line x1={cx+4.5} y1={topY+30} x2={cx+4.5} y2={floorY-8} stroke="rgba(100,180,255,0.25)" strokeWidth={1.5} strokeDasharray="4,3"/><circle cx={cx+4.5} cy={floorY-8} r={2} fill="rgba(100,180,255,0.15)"/></>}
        </g>)}
        <Arrow x1={48+4} y1={floorY/2+20} x2={25} y2={floorY/2+20} label="Колонна" align="end"/>
        {isRain&&<Arrow x1={W-51+4} y1={floorY/2+40} x2={W-20} y2={floorY/2+40} label="Водосток ↓"/>}
        {Array.from({length:numL}).map((_,i)=>{const x=65+i*(lW+lGap);return<g key={`l${i}`}>
          {angle>15&&<rect x={x+Math.sin(rad)*20} y={floorY-3} width={lW*0.7} height={2} fill={cc("0.04")} rx={1}/>}
          <rect x={x} y={topY+2-lH/2} width={lW} height={lH} fill={cc(angle<30?"0.75":"0.45")} rx={1}/>
          {angle>10&&<rect x={x} y={topY+2+lH/2} width={lW} height={sideH} fill={cc("0.15")} rx={0.5}/>}
        </g>;})}
        <Arrow x1={65+4*(lW+lGap)+lW/2} y1={topY+2} x2={65+4*(lW+lGap)+lW/2} y2={topY-28} label={`Ламели: ${Math.round(angle)}°`}/>
        {mode==="day"&&<text x={W/2} y={16} textAnchor="middle" fill="rgba(255,220,100,0.3)" fontSize="14">☀</text>}
        {mode==="day"&&angle<60&&Array.from({length:5}).map((_,i)=><line key={i} x1={100+i*55} y1={10} x2={110+i*55} y2={topY-16} stroke="rgba(255,220,100,0.1)" strokeWidth={1}/>)}
        {mode==="day"&&angle>=60&&<>{Array.from({length:5}).map((_,i)=>{const x=85+i*55;return<g key={i}><line x1={x} y1={10} x2={x+10} y2={topY-16} stroke="rgba(255,220,100,0.1)" strokeWidth={1}/><line x1={x+12} y1={topY+sideH+10} x2={x+20} y2={floorY-10} stroke="rgba(255,220,100,0.06)" strokeWidth={1.5}/></g>})}<Arrow x1={200} y1={topY+sideH+18} x2={260} y2={topY+sideH+18} label="Свет между ламелями"/></>}
        {isRain&&<>{Array.from({length:20}).map((_,i)=><line key={i} x1={50+i*16+Math.sin(i*3)*5} y1={10+Math.sin(i*7)*8} x2={47+i*16+Math.sin(i*3)*5} y2={topY-16} stroke="rgba(100,180,255,0.15)" strokeWidth={0.7}/>)}<text x={W/2} y={16} textAnchor="middle" fill="rgba(100,180,255,0.3)" fontSize="14">🌧</text></>}
        {isRain&&angle<40&&<Arrow x1={W/2} y1={topY+10} x2={W/2+70} y2={topY+10} label="Дождь → водосток в колоннах"/>}
        {opts.led&&<>{Array.from({length:numL}).map((_,i)=>{const x=65+i*(lW+lGap)+lW/2;return<g key={i}><circle cx={x} cy={topY+22} r={isNight?18:10} fill={`rgba(255,220,100,${isNight?"0.08":"0.03"})`}/><rect x={x-1} y={topY+4+lH/2+sideH} width={2} height={2} fill="rgba(255,220,100,0.6)" rx={1}/></g>})}<Arrow x1={65+lW/2} y1={topY+25} x2={30} y2={topY+38} label="LED лента" align="end"/></>}
        {opts.heater&&<><rect x={W/2-25} y={topY+5} width={50} height={6} fill="rgba(255,80,50,0.15)" rx={2}/>{Array.from({length:7}).map((_,i)=><line key={i} x1={W/2-18+i*7} y1={topY+12} x2={W/2-18+i*7} y2={topY+30+Math.sin(i)*5} stroke="rgba(255,80,50,0.08)" strokeWidth={1.5}/>)}<Arrow x1={W/2+25} y1={topY+8} x2={W/2+75} y2={topY-5} label="ИК обогреватель"/></>}
        {opts.screen&&<><rect x={46} y={topY} width={3} height={floorY-topY-5} fill={cc("0.07")} stroke={cc("0.1")} strokeWidth={0.5}/><rect x={W-55} y={topY} width={3} height={floorY-topY-5} fill={cc("0.07")} stroke={cc("0.1")} strokeWidth={0.5}/><Arrow x1={46} y1={topY+60} x2={20} y2={topY+60} label="Zip-штора" align="end"/></>}
        <FloorLine/>
        <DimW y={floorY+10} x1={40} x2={W-40} label="4 500 мм"/>
        <DimH x={28} y1={topY-2} y2={floorY} label="3 000"/>
        <rect x={W-80} y={topY+20} width={36} height={14} fill={cc("0.05")} rx={4} stroke={cc("0.1")} strokeWidth={0.5}/>
        <text x={W-62} y={topY+29} textAnchor="middle" fill={cc("0.35")} fontSize="7" fontWeight="600">SOMFY</text>
        <Arrow x1={W-62} y1={topY+34} x2={W-62} y2={topY+48} label="Мотор RTS"/>
        <rect x={W-80} y={floorY-22} width={22} height={14} fill={cc("0.04")} rx={2} stroke={cc("0.08")} strokeWidth={0.5}/>
        <text x={W-69} y={floorY-13} textAnchor="middle" fill={cc("0.3")} fontSize="8" fontWeight="700">CE</text>
        <StatusBar text={angle===0?"● Закрыто — полная тень":angle<70?`◐ ${Math.round(angle)}° — частичная тень`:"○ Открыто — свет и воздух"}/>
      </svg>
      <Controls label="Открыть ламели" revLabel="Закрыть"/>
      <OptToggles options={[["led","LED подсветка","💡"],["heater","ИК обогрев","🔥"],["screen","Zip-шторы","🪟"]]}/>
      <WeatherBtns/>
    </div>);
  }

  // ═══ IGS PREMIUM ═══
  if(productId==="igs_premium"){
    const ph1=Math.min(pct*2,100)/100,ph2=Math.max(0,pct*2-100)/100;
    const angle=ph1*135,rad=angle*Math.PI/180;
    const numL=9,lW=24,topY=75;
    const lH=Math.max(Math.abs(Math.cos(rad))*16,2),sideH=Math.sin(rad)*7;
    const slideOff=ph2*180;
    return(<div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{background:isNight?"rgba(0,0,20,0.5)":"rgba(0,0,0,0.3)",borderRadius:14}}>
        <rect x={40} y={topY-14} width={W-80} height={8} fill={cc("0.12")} rx={2}/>
        <Arrow x1={W/2} y1={topY-14} x2={W/2} y2={topY-30} label="Премиум профиль — макс. 12 м"/>
        <line x1={45} y1={topY-3} x2={W-45} y2={topY-3} stroke={cc("0.12")} strokeWidth={2.5}/>
        <line x1={45} y1={topY+20} x2={W-45} y2={topY+20} stroke={cc("0.12")} strokeWidth={2.5}/>
        {ph2>0&&<Arrow x1={W-60} y1={topY-3} x2={W-30} y2={topY-15} label="Рельс для сдвига"/>}
        {[48,W-55].map((cx,i)=><g key={i}><rect x={cx} y={topY-2} width={9} height={floorY-topY+2} fill={cc("0.1")} rx={1}/><rect x={cx+1} y={topY-2} width={3} height={floorY-topY+2} fill={cc("0.04")}/><rect x={cx-3} y={floorY-5} width={15} height={6} fill={cc("0.08")} rx={1}/></g>)}
        {Array.from({length:numL}).map((_,i)=>{const bx=65+i*(lW+3),x=bx+slideOff*(0.3+i*0.08);if(x>W-50)return null;return<g key={i}>
          <rect x={x} y={topY+4-lH/2} width={lW} height={lH} fill={cc(angle<30?"0.75":"0.45")} rx={1}/>
          {angle>10&&<rect x={x} y={topY+4+lH/2} width={lW} height={sideH} fill={cc("0.15")}/>}
          {opts.insulated&&lH>5&&<rect x={x+2} y={topY+4-lH/2+2} width={lW-4} height={lH-4} fill="rgba(255,180,50,0.08)" rx={0.5}/>}
        </g>;})}
        {opts.insulated&&<Arrow x1={65+2*(lW+3)+lW/2} y1={topY+4} x2={65+2*(lW+3)+lW/2-40} y2={topY+30} label="Утеплённые ламели" align="end"/>}
        {ph2>0.2&&<><rect x={60} y={topY-2} width={Math.min(slideOff*1.2,W-130)} height={22} fill="rgba(100,180,255,0.03)" rx={3}/><text x={60+Math.min(slideOff*0.6,100)} y={topY+12} textAnchor="middle" fill="rgba(100,180,255,0.3)" fontSize="9">☁ Открытое небо</text></>}
        {angle<20&&<><Arrow x1={65+4*(lW+3)} y1={topY+lH+8} x2={65+4*(lW+3)} y2={topY+lH+28} label="Герметичная конструкция"/></>}
        {opts.led&&Array.from({length:numL}).map((_,i)=>{const x=65+i*(lW+3)+slideOff*(0.3+i*0.08);if(x>W-50)return null;return<circle key={i} cx={x+lW/2} cy={topY+25} r={isNight?15:8} fill={`rgba(255,220,100,${isNight?"0.06":"0.02"})`}/>;}).filter(Boolean)}
        {opts.heater&&<><rect x={W/2-30} y={topY+6} width={60} height={5} fill="rgba(255,80,50,0.12)" rx={2}/>{Array.from({length:9}).map((_,i)=><line key={i} x1={W/2-25+i*7} y1={topY+12} x2={W/2-25+i*7} y2={topY+28+Math.sin(i*2)*4} stroke="rgba(255,80,50,0.07)" strokeWidth={1.5}/>)}<Arrow x1={W/2+30} y1={topY+9} x2={W/2+80} y2={topY-3} label="ИК обогрев"/></>}
        <FloorLine/>
        <DimW y={floorY+10} x1={40} x2={W-40} label="до 12 000 мм"/>
        <StatusBar text={pct===0?"● Закрыто и герметично":pct<50?`◐ Поворот: ${Math.round(angle)}°`:pct<75?`↔ Сдвиг: ${Math.round(ph2*100)}%`:"○ Полностью открыто"}/>
      </svg>
      <Controls label="Поворот → Сдвиг" revLabel="Закрыть"/>
      <OptToggles options={[["insulated","Утепление","🧱"],["led","LED","💡"],["heater","ИК обогрев","🔥"]]}/>
      <WeatherBtns/>
    </div>);
  }

  // ═══ TOSCANA ═══
  if(productId==="toscana"){
    const ext=pct/100,topY=65,endX=55+ext*(W-130);
    return(<div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{background:"rgba(0,0,0,0.3)",borderRadius:14}}>
        <rect x={40} y={topY-8} width={W-80} height={5} fill={cc("0.12")} rx={1}/>
        <Arrow x1={W/2} y1={topY-8} x2={W/2} y2={topY-25} label="Алюминиевый каркас"/>
        {[46,W-52].map((cx,i)=><g key={i}><rect x={cx} y={topY} width={8} height={floorY-topY} fill={cc("0.1")} rx={1}/><rect x={cx-2} y={floorY-4} width={12} height={5} fill={cc("0.07")} rx={1}/></g>)}
        <line x1={50} y1={topY+4} x2={W-50} y2={topY+4} stroke={cc("0.1")} strokeWidth={2}/>
        <line x1={50} y1={topY+24} x2={W-50} y2={topY+24} stroke={cc("0.1")} strokeWidth={2}/>
        <Arrow x1={W-55} y1={topY+4} x2={W-25} y2={topY-8} label="Направляющая"/>
        <rect x={42} y={topY-1} width={14} height={28} fill={cc("0.13")} rx={3}/>
        <Arrow x1={49} y1={topY+27} x2={25} y2={topY+42} label="Кассета" align="end"/>
        {ext>0.01&&<><rect x={55} y={topY+5} width={endX-55} height={18} fill={cc("0.08")} stroke={cc("0.12")} strokeWidth={0.5} rx={1}/>{Array.from({length:Math.floor(ext*12)}).map((_,i)=>{const fx=58+i*((endX-58)/Math.max(Math.floor(ext*12),1));return<line key={i} x1={fx} y1={topY+5} x2={fx} y2={topY+23} stroke={cc("0.04")} strokeWidth={0.5}/>})}<rect x={endX-4} y={topY+3} width={5} height={22} fill={cc("0.2")} rx={1}/><Arrow x1={(55+endX)/2} y1={topY+14} x2={(55+endX)/2+60} y2={topY+40} label="ПВХ-крыша"/></>}
        {ext>0.15&&<rect x={55} y={floorY-3} width={(endX-55)*0.85} height={4} fill={cc("0.03")} rx={2}/>}
        {opts.led&&ext>0.1&&<><rect x={56} y={topY+23} width={endX-58} height={1} fill="rgba(255,220,100,0.2)"/><Arrow x1={endX-20} y1={topY+23} x2={endX+15} y2={topY+35} label="LED"/></>}
        <FloorLine/>
        {ext>0.05&&<DimW y={floorY+10} x1={55} x2={endX} label={`${(ext*13.5).toFixed(1)} м`}/>}
        <StatusBar text={`Проекция: ${(ext*13.5).toFixed(1)} м из 13.5 м`}/>
      </svg>
      <Controls label="Выдвинуть" revLabel="Сложить"/>
      <OptToggles options={[["led","LED подсветка","💡"],["motor","Моторизация","⚡"]]}/>
    </div>);
  }

  // ═══ СЛАЙДИНГ ═══
  if(productId==="sliding"){
    const panels=4,fL=55,fR=W-55,tw=fR-fL,pW=tw/panels,topY=45,botY=floorY-5,slide=pct/100,isDbl=opts.double;
    return(<div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{background:"rgba(0,0,0,0.3)",borderRadius:14}}>
        <rect x={fL-5} y={topY-5} width={tw+10} height={botY-topY+10} fill="none" stroke={cc("0.2")} strokeWidth={3} rx={3}/>
        <Arrow x1={fL-5} y1={topY+30} x2={fL-30} y2={topY+30} label="Алюм. профиль" align="end"/>
        <rect x={fL} y={topY-2} width={tw} height={3} fill={cc("0.08")}/>
        <rect x={fL} y={botY} width={tw} height={4} fill={cc("0.08")} rx={1}/>
        {Array.from({length:panels}).map((_,i)=>{let x=fL+i*pW;if(i>=2)x+=slide*pW*(panels-i)*0.9;const pw=pW-4;return<g key={i}>
          <rect x={x+2} y={topY+2} width={pw} height={botY-topY-4} fill={cc("0.04")} stroke={cc("0.15")} strokeWidth={1.2} rx={1}/>
          {isDbl&&<rect x={x+5} y={topY+5} width={pw-6} height={botY-topY-10} fill="none" stroke={cc("0.06")} strokeWidth={0.5} rx={1}/>}
          <line x1={x+10} y1={topY+8} x2={x+10} y2={botY-8} stroke={cc("0.06")} strokeWidth={1.5}/>
          <rect x={x+pw-7} y={(topY+botY)/2-14} width={3} height={28} fill={cc("0.2")} rx={1}/>
          <circle cx={x+14} cy={botY+1} r={2.5} fill={cc("0.12")}/>
          <circle cx={x+pw-10} cy={botY+1} r={2.5} fill={cc("0.12")}/>
          <text x={x+pw/2+1} y={botY-10} textAnchor="middle" fill={cc("0.12")} fontSize="9" fontFamily="'JetBrains Mono',monospace">{i+1}</text>
        </g>})}
        {isDbl&&<Arrow x1={fL+pW/2} y1={topY+20} x2={fL-25} y2={topY+15} label="2× стекло" align="end"/>}
        <Arrow x1={fL+pW*3.5} y1={botY+1} x2={fL+pW*3.5} y2={botY+18} label="Бесшумные ролики"/>
        {slide>0.3&&<Arrow x1={fL+pW*1.8} y1={(topY+botY)/2} x2={fL+pW*1.2} y2={(topY+botY)/2-25} label="Открытый проём" align="end"/>}
        <StatusBar text={`${panels} секции · ${slide>0?`Открыто ${Math.round(slide*100)}%`:"Закрыто"}`}/>
      </svg>
      <Controls label="Раздвинуть" revLabel="Закрыть"/>
      <OptToggles options={[["double","Двойное стекло","🪟"]]}/>
    </div>);
  }

  // ═══ ГИЛЬОТИНА ═══
  if(productId==="guillotine"){
    const topY=40,railH=55,fullH=floorY-topY,glassH=fullH-railH;
    const glassTop=topY+(pct/100)*(fullH-railH),isRail=pct>70,isAuto=opts.auto;
    return(<div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{background:"rgba(0,0,0,0.3)",borderRadius:14}}>
        <rect x={50} y={topY-6} width={W-100} height={7} fill={cc("0.15")} rx={2}/>
        <Arrow x1={W/2} y1={topY-6} x2={W/2} y2={topY-22} label="Верхняя рама"/>
        <rect x={53} y={topY} width={5} height={fullH} fill={cc("0.1")} rx={1}/>
        <rect x={W-58} y={topY} width={5} height={fullH} fill={cc("0.1")} rx={1}/>
        {Array.from({length:10}).map((_,i)=><g key={i}><rect x={54} y={topY+8+i*18} width={3} height={6} fill={cc("0.05")} rx={0.5}/><rect x={W-57} y={topY+8+i*18} width={3} height={6} fill={cc("0.05")} rx={0.5}/></g>)}
        <Arrow x1={53} y1={topY+fullH/2} x2={30} y2={topY+fullH/2} label="Пазы" align="end"/>
        {[0,1].map(i=>{const pw=(W-135)/2,px=64+i*(pw+10);return<g key={i}>
          <rect x={px} y={glassTop} width={pw} height={glassH} fill={cc("0.04")} stroke={cc("0.18")} strokeWidth={1.5} rx={2}/>
          <rect x={px+3} y={glassTop+3} width={pw-6} height={glassH-6} fill="none" stroke={cc("0.05")} strokeWidth={0.5} rx={1} strokeDasharray="4,4"/>
          <line x1={px+10} y1={glassTop+6} x2={px+10} y2={glassTop+glassH-6} stroke={cc("0.07")} strokeWidth={2}/>
          <rect x={px} y={glassTop} width={pw} height={4} fill={cc("0.12")} rx={1}/>
          <rect x={px} y={glassTop+glassH-4} width={pw} height={4} fill={cc("0.12")} rx={1}/>
          <text x={px+pw/2} y={glassTop+glassH/2+3} textAnchor="middle" fill={cc("0.08")} fontSize="7">ЛАМИНИРОВАННОЕ</text>
        </g>})}
        <Arrow x1={64+(W-135)/4} y1={glassTop+glassH/2} x2={35} y2={glassTop+glassH/2-15} label="Стекло ↓" align="end"/>
        {isRail&&<><rect x={60} y={glassTop-4} width={W-120} height={6} fill={cc("0.3")} rx={3}/><Arrow x1={W/2} y1={glassTop-4} x2={W/2} y2={glassTop-22} label="Поручень (перила)"/>{Array.from({length:6}).map((_,i)=>{const sx=75+i*((W-150)/5);return<rect key={i} x={sx} y={glassTop+2} width={2.5} height={floorY-glassTop-2} fill={cc("0.07")} rx={0.5}/>})}</>}
        <rect x={W-48} y={topY+2} width={12} height={16} fill={cc("0.1")} rx={3}/>
        <circle cx={W-42} cy={topY+10} r={4} fill="none" stroke={cc("0.2")} strokeWidth={1}/>
        <line x1={W-42} y1={topY+16} x2={W-42} y2={topY+16+pct*0.4} stroke={cc("0.1")} strokeWidth={1} strokeDasharray="2,2"/>
        <Arrow x1={W-42} y1={topY+2} x2={W-20} y2={topY-8} label={isAuto?"Авто-привод":"Цепной привод"}/>
        {isAuto&&<><rect x={W-50} y={topY+20} width={16} height={8} fill="rgba(100,150,255,0.1)" rx={2}/><text x={W-42} y={topY+26} textAnchor="middle" fill="rgba(100,150,255,0.4)" fontSize="5">AUTO</text></>}
        <FloorLine/>
        <DimH x={35} y1={topY} y2={floorY} label="3 000"/>
        <StatusBar text={isRail?"✓ Режим перил — открытый вид":"Стеклянный барьер — защита от ветра"}/>
      </svg>
      <Controls label="Опустить → Перила" revLabel="Поднять → Барьер"/>
      <OptToggles options={[["auto","Автоматизация","⚡"]]}/>
    </div>);
  }

  // ═══ ZIP-ШТОРЫ ═══
  if(productId==="zip"){
    const topY=48,dropH=pct/100*(floorY-topY-15);
    return(<div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{background:"rgba(0,0,0,0.3)",borderRadius:14}}>
        <rect x={55} y={topY-10} width={W-110} height={20} fill={cc("0.15")} rx={6}/>
        <rect x={60} y={topY-7} width={W-120} height={14} fill={cc("0.08")} rx={4}/>
        <Arrow x1={W/2} y1={topY-10} x2={W/2} y2={topY-28} label="Кассетная система"/>
        <rect x={55} y={topY+10} width={6} height={floorY-topY-10} fill={cc("0.1")} rx={1}/>
        <rect x={W-61} y={topY+10} width={6} height={floorY-topY-10} fill={cc("0.1")} rx={1}/>
        {Array.from({length:6}).map((_,i)=><g key={i}><rect x={56} y={topY+15+i*28} width={4} height={12} fill={cc("0.06")} rx={1}/><rect x={W-60} y={topY+15+i*28} width={4} height={12} fill={cc("0.06")} rx={1}/></g>)}
        <Arrow x1={55} y1={topY+60} x2={28} y2={topY+60} label="ZIP-замок" align="end"/>
        <Arrow x1={W-61} y1={topY+90} x2={W-25} y2={topY+90} label="Направляющая"/>
        {dropH>3&&<><rect x={62} y={topY+10} width={W-124} height={dropH} fill={cc("0.07")} stroke={cc("0.1")} strokeWidth={0.5}/>{Array.from({length:Math.floor(dropH/12)}).map((_,i)=><line key={i} x1={62} y1={topY+16+i*12} x2={W-62} y2={topY+16+i*12} stroke={cc("0.03")} strokeWidth={0.5}/>)}<rect x={62} y={topY+10+dropH-6} width={W-124} height={6} fill={cc("0.18")} rx={2}/><Arrow x1={W/2} y1={topY+10+dropH/2} x2={W/2+85} y2={topY+10+dropH/2} label="Ткань Dickson"/></>}
        {pct>30&&<>{Array.from({length:5}).map((_,i)=><g key={i}><path d={`M${W-20},${60+i*35} Q${W-10},${62+i*35} ${W-2},${58+i*35}`} fill="none" stroke={cc("0.15")} strokeWidth={1}/><polygon points={`${W-2},${58+i*35} ${W+2},${56+i*35} ${W},${60+i*35}`} fill={cc("0.15")}/></g>)}<text x={W-12} y={50} textAnchor="middle" fill={cc("0.3")} fontSize="9">💨</text><Arrow x1={W-15} y1={55} x2={W-15} y2={42} label="до 180 км/ч"/></>}
        {pct>50&&<><text x={W-18} y={floorY-30} textAnchor="middle" fill={cc("0.25")} fontSize="10">🦟</text><line x1={W-24} y1={floorY-38} x2={W-12} y2={floorY-24} stroke="rgba(255,80,80,0.3)" strokeWidth={1.5}/><line x1={W-12} y1={floorY-38} x2={W-24} y2={floorY-24} stroke="rgba(255,80,80,0.3)" strokeWidth={1.5}/></>}
        {opts.motor&&<><rect x={W/2-15} y={topY-7} width={30} height={10} fill="rgba(100,150,255,0.1)" rx={3} stroke="rgba(100,150,255,0.2)" strokeWidth={0.5}/><text x={W/2} y={topY} textAnchor="middle" fill="rgba(100,150,255,0.4)" fontSize="6">МОТОР</text></>}
        <FloorLine/>
        <StatusBar text={pct===0?"Штора поднята":pct<50?`Опущено ${Math.round(pct)}%`:"Полная защита — ветер, солнце, насекомые"}/>
      </svg>
      <Controls label="Опустить штору" revLabel="Поднять"/>
      <OptToggles options={[["motor","Моторизация","⚡"],["mesh","Москитная сетка","🦟"]]}/>
    </div>);
  }

  // ═══ МАРКИЗЫ ═══
  if(productId==="marquise"){
    const ext=pct/100,wallX=35,topY=55,extX=ext*(W-120),drop=ext*0.28;
    return(<div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{background:"rgba(0,0,0,0.3)",borderRadius:14}}>
        <rect x={wallX-10} y={20} width={16} height={floorY-20} fill={cc("0.08")} rx={1}/>
        {Array.from({length:12}).map((_,i)=><line key={i} x1={wallX-9} y1={28+i*18} x2={wallX+5} y2={28+i*18} stroke={cc("0.03")} strokeWidth={0.5}/>)}
        <Arrow x1={wallX-2} y1={38} x2={wallX-25} y2={38} label="Стена" align="end"/>
        <rect x={wallX+3} y={topY-12} width={22} height={24} fill={cc("0.15")} rx={5}/>
        <circle cx={wallX+14} cy={topY} r={6} fill={cc("0.08")} stroke={cc("0.12")} strokeWidth={1}/>
        <Arrow x1={wallX+25} y1={topY} x2={wallX+55} y2={topY-15} label="Кассета"/>
        {ext>0.02&&<><path d={`M${wallX+22},${topY-6} L${wallX+22+extX},${topY-6+extX*drop} L${wallX+22+extX},${topY+10+extX*drop} L${wallX+22},${topY+10} Z`} fill={cc("0.08")} stroke={cc("0.15")} strokeWidth={1}/>{Array.from({length:Math.floor(ext*12)}).map((_,i)=>{const fx=wallX+28+i*(extX/Math.max(Math.floor(ext*12),1));if(fx>wallX+22+extX-5)return null;const fy1=topY-6+(fx-wallX-22)*drop;const fy2=topY+10+(fx-wallX-22)*drop;return<line key={i} x1={fx} y1={fy1} x2={fx} y2={fy2} stroke={cc("0.04")} strokeWidth={0.5}/>}).filter(Boolean)}{ext>0.3&&<path d={`M${wallX+22+extX},${topY+10+extX*drop} ${Array.from({length:8}).map((_,i)=>{const vx=wallX+22+extX-i*(extX/8);const vy=topY+10+(vx-wallX-22)*drop;return`Q${vx+extX/16},${vy+10} ${vx-extX/16},${vy}`}).join(" ")}`} fill="none" stroke={cc("0.1")} strokeWidth={0.5}/>}<Arrow x1={wallX+22+extX/2} y1={topY+2+extX/2*drop} x2={wallX+22+extX/2+40} y2={topY+35+extX/2*drop} label="Ткань"/></>}
        {ext>0.05&&<><line x1={wallX+22} y1={topY+8} x2={wallX+22+extX*0.45} y2={topY+8+extX*0.22} stroke={cc("0.18")} strokeWidth={2}/><line x1={wallX+22+extX*0.45} y1={topY+8+extX*0.22} x2={wallX+22+extX} y2={topY+6+extX*drop} stroke={cc("0.18")} strokeWidth={2}/><circle cx={wallX+22+extX*0.45} cy={topY+8+extX*0.22} r={4} fill={cc("0.1")} stroke={cc("0.2")} strokeWidth={1}/><circle cx={wallX+22} cy={topY+8} r={2.5} fill={cc("0.15")}/><Arrow x1={wallX+22+extX*0.45} y1={topY+8+extX*0.22+5} x2={wallX+22+extX*0.45+35} y2={topY+8+extX*0.22+25} label="Шарнир"/></>}
        {opts.motor&&<><rect x={wallX+5} y={topY+14} width={14} height={8} fill="rgba(100,150,255,0.1)" rx={2}/><text x={wallX+12} y={topY+20} textAnchor="middle" fill="rgba(100,150,255,0.4)" fontSize="5">⚡</text></>}
        {ext>0.2&&<ellipse cx={wallX+22+extX*0.45} cy={floorY-2} rx={extX*0.4} ry={6} fill={cc("0.03")}/>}
        <g transform={`translate(${W-60},${floorY-80})`}><circle cx={0} cy={0} r={6} fill="none" stroke={cc("0.12")} strokeWidth={1}/><line x1={0} y1={6} x2={0} y2={36} stroke={cc("0.12")} strokeWidth={1}/><line x1={0} y1={14} x2={-10} y2={26} stroke={cc("0.12")} strokeWidth={1}/><line x1={0} y1={14} x2={10} y2={26} stroke={cc("0.12")} strokeWidth={1}/><line x1={0} y1={36} x2={-7} y2={52} stroke={cc("0.12")} strokeWidth={1}/><line x1={0} y1={36} x2={7} y2={52} stroke={cc("0.12")} strokeWidth={1}/></g>
        <text x={W-60} y={floorY+12} textAnchor="middle" fill={cc("0.2")} fontSize="7">~180 см</text>
        <FloorLine/>
        {ext>0.1&&<DimW y={floorY+10} x1={wallX+22} x2={wallX+22+extX} label={`${(ext*4).toFixed(1)} м`}/>}
        <StatusBar text={ext<0.05?"Компактно сложено у стены":`Навес: ${(ext*4).toFixed(1)} м`}/>
      </svg>
      <Controls label="Выдвинуть" revLabel="Сложить"/>
      <OptToggles options={[["motor","Моторизация","⚡"]]}/>
    </div>);
  }

  return null;
}

// ─── ADD PRODUCT MODAL ────────────────────────────────────────────────────────
function AddProductModal({open,onClose,onAdd}){
  const[name,setName]=useState("");
  const[shortName,setShortName]=useState("");
  const[tag,setTag]=useState("");
  const[price,setPrice]=useState("");
  const[color,setColor]=useState("#2d7a4f");
  const[emoji,setEmoji]=useState("📦");
  const[desc,setDesc]=useState("");
  const[featuresText,setFeaturesText]=useState("");
  const[options,setOptions]=useState([]);
  const[optLabel,setOptLabel]=useState("");
  const[optPrice,setOptPrice]=useState("");
  const[optFlat,setOptFlat]=useState(false);

  function addOption(){
    if(!optLabel.trim()||!optPrice)return;
    setOptions(prev=>[...prev,{id:Date.now().toString(),label:optLabel.trim(),price:parseInt(optPrice)||0,flat:optFlat}]);
    setOptLabel("");setOptPrice("");setOptFlat(false);
  }
  function removeOption(id){setOptions(prev=>prev.filter(o=>o.id!==id));}

  function handleAdd(){
    if(!name.trim()||!shortName.trim()||!price)return;
    const product={
      id:"custom_"+Date.now(),
      name:name.trim(),
      shortName:shortName.trim(),
      tag:tag.trim()||"Пользовательский продукт",
      price:parseInt(price)||0,
      color,
      emoji:emoji||"📦",
      desc:desc.trim(),
      features:featuresText.split("\n").map(f=>f.trim()).filter(Boolean),
      options:[...options],
      isCustom:true,
    };
    onAdd(product);
    setName("");setShortName("");setTag("");setPrice("");setColor("#2d7a4f");setEmoji("📦");setDesc("");setFeaturesText("");setOptions([]);
  }

  if(!open)return null;
  const COLORS=["#2d7a4f","#1a5276","#7d6608","#1a6b8a","#6c3483","#784212","#1e8449","#b8965a","#c45454","#2563eb"];
  const EMOJIS=["📦","🏗️","🪟","☂️","⛺","🌿","⭐","🔳","🌬️","🏠","💎","🛠️","🪵","🧱","🔩"];

  return createPortal(
    <div style={{position:"fixed",inset:0,zIndex:8000,background:"rgba(0,0,0,0.7)",backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.surface,borderRadius:12,width:"100%",maxWidth:520,maxHeight:"92vh",overflowY:"auto",border:`1px solid ${T.border}`,boxShadow:"0 24px 64px rgba(0,0,0,0.6)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"20px 24px",borderBottom:`1px solid ${T.border}`,position:"sticky",top:0,background:T.surface,zIndex:1}}>
          <div style={{fontSize:16,fontWeight:600}}>Новый продукт</div>
          <button onClick={onClose} style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:14,color:T.textSec}}>✕</button>
        </div>
        <div style={{padding:"20px 24px",display:"flex",flexDirection:"column",gap:16}}>
          {/* Основное */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <div style={{gridColumn:"1/-1"}}><div style={{fontSize:10,color:T.textSec,marginBottom:5,fontWeight:600,letterSpacing:1}}>НАЗВАНИЕ *</div><Inp value={name} onChange={e=>setName(e.target.value)} placeholder="Биоклиматическая пергола XYZ" autoFocus/></div>
            <div><div style={{fontSize:10,color:T.textSec,marginBottom:5,fontWeight:600,letterSpacing:1}}>КОРОТКОЕ ИМЯ *</div><Inp value={shortName} onChange={e=>setShortName(e.target.value)} placeholder="XYZ"/></div>
            <div><div style={{fontSize:10,color:T.textSec,marginBottom:5,fontWeight:600,letterSpacing:1}}>ТЕГ</div><Inp value={tag} onChange={e=>setTag(e.target.value)} placeholder="Премиум серия"/></div>
            <div><div style={{fontSize:10,color:T.textSec,marginBottom:5,fontWeight:600,letterSpacing:1}}>ЦЕНА ЗА М² (₸) *</div><Inp type="number" value={price} onChange={e=>setPrice(e.target.value)} placeholder="250000" inputMode="numeric"/></div>
            <div><div style={{fontSize:10,color:T.textSec,marginBottom:5,fontWeight:600,letterSpacing:1}}>ОПИСАНИЕ</div><textarea value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Краткое описание продукта…" style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 14px",color:T.text,fontSize:13,width:"100%",outline:"none",minHeight:60,resize:"vertical",fontFamily:T.font,gridColumn:"1/-1"}}/></div>
          </div>

          {/* Эмодзи */}
          <div>
            <div style={{fontSize:10,color:T.textSec,marginBottom:6,fontWeight:600,letterSpacing:1}}>ИКОНКА</div>
            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
              {EMOJIS.map(e=><button key={e} onClick={()=>setEmoji(e)} style={{width:34,height:34,borderRadius:8,background:emoji===e?T.goldBg:T.elevated,border:`1px solid ${emoji===e?T.goldDim:T.border}`,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center"}}>{e}</button>)}
            </div>
          </div>

          {/* Цвет */}
          <div>
            <div style={{fontSize:10,color:T.textSec,marginBottom:6,fontWeight:600,letterSpacing:1}}>ЦВЕТ АКЦЕНТА</div>
            <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
              {COLORS.map(c=><button key={c} onClick={()=>setColor(c)} style={{width:28,height:28,borderRadius:7,background:c,border:color===c?"2px solid #fff":`2px solid transparent`,cursor:"pointer",transition:"all 0.15s"}}/>)}
              <input type="color" value={color} onChange={e=>setColor(e.target.value)} style={{width:28,height:28,borderRadius:7,border:"none",cursor:"pointer",padding:0}}/>
            </div>
          </div>

          {/* Преимущества */}
          <div>
            <div style={{fontSize:10,color:T.textSec,marginBottom:5,fontWeight:600,letterSpacing:1}}>ПРЕИМУЩЕСТВА (по одному на строку)</div>
            <textarea value={featuresText} onChange={e=>setFeaturesText(e.target.value)} placeholder={"Преимущество 1\nПреимущество 2\nПреимущество 3"} style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 14px",color:T.text,fontSize:13,width:"100%",outline:"none",minHeight:70,resize:"vertical",fontFamily:T.font}}/>
          </div>

          {/* Доп. опции */}
          <div>
            <div style={{fontSize:10,color:T.textSec,marginBottom:6,fontWeight:600,letterSpacing:1}}>ДОП. ОПЦИИ</div>
            {options.length>0&&<div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:10}}>
              {options.map(o=>(
                <div key={o.id} style={{display:"flex",alignItems:"center",gap:8,background:T.elevated,borderRadius:8,padding:"8px 12px",border:`1px solid ${T.border}`}}>
                  <div style={{flex:1,fontSize:13}}>{o.label}</div>
                  <div style={{fontSize:12,color:T.gold,fontFamily:T.mono}}>{fmt(o.price)}{o.flat?"":" /м²"}</div>
                  <button onClick={()=>removeOption(o.id)} style={{background:"none",border:"none",color:T.danger,cursor:"pointer",fontSize:13,padding:"0 2px"}}>✕</button>
                </div>
              ))}
            </div>}
            <div style={{display:"flex",gap:6,alignItems:"flex-end",flexWrap:"wrap"}}>
              <div style={{flex:2,minWidth:120}}><div style={{fontSize:9,color:T.textDim,marginBottom:3}}>Название</div><Inp value={optLabel} onChange={e=>setOptLabel(e.target.value)} placeholder="LED подсветка" style={{padding:"8px 10px",fontSize:12}}/></div>
              <div style={{flex:1,minWidth:80}}><div style={{fontSize:9,color:T.textDim,marginBottom:3}}>Цена ₸</div><Inp type="number" value={optPrice} onChange={e=>setOptPrice(e.target.value)} placeholder="12000" style={{padding:"8px 10px",fontSize:12}} inputMode="numeric"/></div>
              <button onClick={()=>setOptFlat(!optFlat)} style={{background:optFlat?T.goldBg:T.elevated,border:`1px solid ${optFlat?T.goldDim:T.border}`,borderRadius:7,padding:"8px 10px",fontSize:10,color:optFlat?T.gold:T.textSec,cursor:"pointer",fontFamily:T.font,whiteSpace:"nowrap"}}>{optFlat?"Фикс":"За м²"}</button>
              <button onClick={addOption} style={{background:T.gold,color:T.bg,border:"none",borderRadius:7,padding:"8px 14px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:T.font}}>+</button>
            </div>
          </div>

          {/* Превью */}
          {name&&<div style={{background:T.bg,borderRadius:10,padding:16,border:`1px solid ${T.border}`,borderLeft:`3px solid ${color}`}}>
            <div style={{fontSize:10,color:T.textDim,marginBottom:8,letterSpacing:1}}>ПРЕВЬЮ КАРТОЧКИ</div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:24}}>{emoji}</span>
              <div><div style={{fontSize:14,fontWeight:600}}>{shortName||name}</div><div style={{fontSize:10,color:T.textSec}}>{tag||"—"}</div></div>
              <div style={{marginLeft:"auto",fontSize:16,fontWeight:700,color,fontFamily:T.mono}}>{price?fmt(parseInt(price)):""}</div>
            </div>
          </div>}

          <Btn variant="primary" disabled={!name.trim()||!shortName.trim()||!price} onClick={handleAdd} style={{justifyContent:"center",width:"100%",padding:"12px"}}>Добавить продукт в каталог</Btn>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── CATALOG ─────────────────────────────────────────────────────────────────
function Catalog({isMobile,currentUser}){
  const[media,setMedia]=useState(()=>loadCatalogMedia());
  const[selected,setSelected]=useState("bio");
  const[activeIdx,setActiveIdx]=useState(0);
  const[showUpload,setShowUpload]=useState(false);
  const[uploading,setUploading]=useState(false);
  const[uploadPct,setUploadPct]=useState(0);
  const touchX=useRef(null);

  // 7 слотов — точно как на публичном каталоге
  // key = Firebase ключ, name = название на сайте
  const CATALOG_SLOTS = [
    { key:"bio",        name:"Биоклиматическая пергола", note:"Биоклим. · Premium · IGS Premium" },
    { key:"toscana",    name:"Тентовая пергола",         note:"Guhher · Тентовая" },
    { key:"sliding",    name:"Раздвижное остекление",      note:"Закалённое стекло 8 мм" },
    { key:"guillotine", name:"Гильотинное остекление",     note:"Стекло 10 мм · Без стоек" },
    { key:"zip",        name:"Zip-шторы",                note:"ZIP-направляющие" },
    { key:"marquise",   name:"Маркиза",                  note:"Выдвижные козырьки" },
    { key:"railings",   name:"Перила",                   note:"Алюминиевые ограждения" },
  ];

  useEffect(()=>{
    dbGet("catalog_media").then(data=>{
      if(data&&typeof data==="object"){setMedia(data);localStorage.setItem(CATALOG_MEDIA_KEY,JSON.stringify(data));}
    });
    const unsub=dbListen("catalog_media",(data)=>{
      if(data&&typeof data==="object"){setMedia(data);localStorage.setItem(CATALOG_MEDIA_KEY,JSON.stringify(data));}
    });
    return unsub;
  },[]);

  useEffect(()=>{ setActiveIdx(0); },[selected]);

  function saveMedia(updated){
    try{localStorage.setItem(CATALOG_MEDIA_KEY,JSON.stringify(updated));}catch(_){}
    dbSet("catalog_media",updated);
  }

  function getUrls(key){
    const m=media[key];
    if(!m) return [];
    if(m?.urls) return m.urls.filter(Boolean);
    if(Array.isArray(m)) return m.filter(Boolean);
    return [];
  }

  function deleteItem(key,idx){
    const urls=getUrls(key).filter((_,i)=>i!==idx);
    const updated={...media,[key]:{...(media[key]||{}),urls}};
    setMedia(updated);saveMedia(updated);
    if(activeIdx>=urls.length) setActiveIdx(Math.max(0,urls.length-1));
  }

  function moveItem(key,idx,dir){
    const arr=[...getUrls(key)];
    const to=idx+dir;
    if(to<0||to>=arr.length) return;
    [arr[idx],arr[to]]=[arr[to],arr[idx]];
    const updated={...media,[key]:{...(media[key]||{}),urls:arr}};
    setMedia(updated);saveMedia(updated);
    setActiveIdx(to);
  }

  function isVideo(url){return url&&(url.includes(".mp4")||url.includes(".mov")||url.includes(".webm")||url.startsWith("data:video"));}

  const slot=CATALOG_SLOTS.find(s=>s.key===selected)||CATALOG_SLOTS[0];
  const urls=getUrls(selected);

  // Стиль — светлый минимализм как публичный каталог
  const S={
    bg:"#f7f6f3",white:"#fff",black:"#0d0d0d",
    border:"#e4e2de",mid:"#666",light:"#aaa",
    gold:"#b8965a",serif:"'Georgia',serif",sans:T.font,
  };

  return(
    <div style={{fontFamily:S.sans,background:S.bg,minHeight:"100vh",paddingBottom:isMobile?120:0}}>

      {/* Заголовок */}
      <div style={{background:S.white,borderBottom:`1px solid ${S.border}`,padding:isMobile?"14px 16px":"18px 24px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <div style={{fontSize:9,color:S.gold,fontWeight:700,letterSpacing:3,textTransform:"uppercase",marginBottom:3}}>Управление</div>
          <div style={{fontSize:isMobile?18:22,fontWeight:700,color:S.black,fontFamily:S.serif}}>Каталог сайта</div>
        </div>
        <div style={{fontSize:11,color:S.mid,textAlign:"right",lineHeight:1.5,maxWidth:160}}>
          Фото обновляются на сайте в реальном времени
        </div>
      </div>

      <div style={{display:"flex",flexDirection:isMobile?"column":"row"}}>

        {/* ── ЛЕВАЯ ПАНЕЛЬ: 7 слотов ── */}
        <div style={{
          width:isMobile?"100%":220,flexShrink:0,background:S.white,
          borderRight:isMobile?"none":`1px solid ${S.border}`,
          ...(isMobile?{overflowX:"auto",display:"flex",gap:8,padding:"12px 16px",borderBottom:`1px solid ${S.border}`}:{})
        }}>
          {CATALOG_SLOTS.map((s,i)=>{
            const cnt=getUrls(s.key).length;
            const active=selected===s.key;
            return isMobile?(
              <button key={s.key} onClick={()=>setSelected(s.key)} style={{
                flexShrink:0,padding:"8px 14px",fontSize:12,fontWeight:700,cursor:"pointer",
                border:`1px solid ${active?S.black:S.border}`,
                background:active?S.black:"transparent",
                color:active?"#fff":S.mid,borderRadius:0,fontFamily:S.sans,whiteSpace:"nowrap",
              }}>
                {s.name}
                {cnt>0&&<span style={{marginLeft:6,background:active?"rgba(255,255,255,0.2)":"rgba(0,0,0,0.08)",borderRadius:10,padding:"1px 7px",fontSize:10}}>{cnt}</span>}
              </button>
            ):(
              <div key={s.key} onClick={()=>setSelected(s.key)} style={{
                padding:"13px 18px",cursor:"pointer",borderBottom:`1px solid ${S.border}`,
                background:active?"#f0ede8":S.white,
                borderLeft:active?`3px solid ${S.black}`:"3px solid transparent",
                transition:"all 0.15s",
              }}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
                  <div style={{fontSize:13,fontWeight:600,color:active?S.black:S.mid}}>{s.name}</div>
                  {cnt>0&&<div style={{fontSize:10,background:active?S.black:"rgba(0,0,0,0.07)",color:active?"#fff":S.mid,borderRadius:10,padding:"1px 7px",fontWeight:700}}>{cnt}</div>}
                </div>
                <div style={{fontSize:10,color:S.light}}>{s.note}</div>
              </div>
            );
          })}
        </div>

        {/* ── ПРАВАЯ ЧАСТЬ ── */}
        <div style={{flex:1,minWidth:0}}>

          {/* ПРЕВЬЮ — точно как публичный каталог */}
          <div style={{background:S.white,borderBottom:`1px solid ${S.border}`}}>

            {/* Заголовок продукта */}
            <div style={{padding:isMobile?"14px 16px":"18px 24px",borderBottom:`1px solid ${S.border}`,display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div>
                <div style={{fontSize:9,color:S.light,letterSpacing:2,marginBottom:4}}>
                  {(CATALOG_SLOTS.findIndex(s=>s.key===selected)+1).toString().padStart(2,"0")} / {CATALOG_SLOTS.length.toString().padStart(2,"0")}
                </div>
                <div style={{fontFamily:S.serif,fontSize:isMobile?20:26,fontWeight:400,color:S.black,lineHeight:1.2,marginBottom:3}}>{slot.name}</div>
                <div style={{fontSize:11,color:S.mid}}>{slot.note}</div>
              </div>
              <div style={{fontSize:10,color:S.light,textAlign:"right",lineHeight:1.6}}>
                Превью<br/>публичного каталога
              </div>
            </div>

            {/* Главный слайдер */}
            {urls.length>0?(
              <div style={{position:"relative",background:S.bg}}
                onTouchStart={e=>{touchX.current=e.touches[0].clientX;}}
                onTouchEnd={e=>{
                  if(!touchX.current) return;
                  const diff=touchX.current-e.changedTouches[0].clientX;
                  if(Math.abs(diff)>40){
                    if(diff>0&&activeIdx<urls.length-1) setActiveIdx(i=>i+1);
                    if(diff<0&&activeIdx>0) setActiveIdx(i=>i-1);
                  }
                  touchX.current=null;
                }}>
                <div style={{position:"relative",aspectRatio:"3/2",maxHeight:300,overflow:"hidden",background:"#e0ddd8"}}>
                  {isVideo(urls[activeIdx])
                    ?<video src={urls[activeIdx]} controls muted playsInline style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
                    :<img src={urls[activeIdx]} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}
                        onError={e=>{e.target.style.display="none";}}/>
                  }
                  {/* Оверлей как на публичном */}
                  <div style={{position:"absolute",inset:0,background:"linear-gradient(to top,rgba(0,0,0,0.5) 0%,transparent 60%)",pointerEvents:"none"}}/>
                  <div style={{position:"absolute",bottom:14,left:16}}>
                    <div style={{fontSize:9,color:"rgba(255,255,255,0.5)",letterSpacing:2,marginBottom:3}}>
                      {(CATALOG_SLOTS.findIndex(s=>s.key===selected)+1).toString().padStart(2,"0")} / {CATALOG_SLOTS.length.toString().padStart(2,"0")}
                    </div>
                    <div style={{fontFamily:S.serif,fontSize:16,color:"#fff",fontWeight:500}}>{slot.name}</div>
                  </div>
                  {/* Стрелки */}
                  {activeIdx>0&&<button onClick={()=>setActiveIdx(i=>i-1)} style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",background:"rgba(255,255,255,0.85)",border:`1px solid rgba(0,0,0,0.08)`,color:S.black,width:32,height:32,borderRadius:"50%",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>‹</button>}
                  {activeIdx<urls.length-1&&<button onClick={()=>setActiveIdx(i=>i+1)} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"rgba(255,255,255,0.85)",border:`1px solid rgba(0,0,0,0.08)`,color:S.black,width:32,height:32,borderRadius:"50%",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>›</button>}
                  {urls.length>1&&<div style={{position:"absolute",top:10,right:10,background:"rgba(0,0,0,0.4)",color:"rgba(255,255,255,0.9)",fontSize:10,fontWeight:600,padding:"3px 8px",borderRadius:10}}>{activeIdx+1}/{urls.length}</div>}
                </div>
                {urls.length>1&&(
                  <div style={{display:"flex",justifyContent:"center",gap:5,padding:"10px 0",background:S.white}}>
                    {urls.map((_,i)=><div key={i} onClick={()=>setActiveIdx(i)} style={{width:i===activeIdx?20:6,height:6,borderRadius:3,background:i===activeIdx?S.black:"rgba(0,0,0,0.15)",cursor:"pointer",transition:"all 0.3s"}}/>)}
                  </div>
                )}
              </div>
            ):(
              <div style={{aspectRatio:"16/9",maxHeight:220,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10,background:"#f0ede8",cursor:"pointer"}}
                onClick={()=>can(currentUser,"edit_prices")&&setShowUpload(true)}>
                <div style={{fontSize:11,color:S.light,letterSpacing:3,textTransform:"uppercase"}}>фото не добавлены</div>
                {can(currentUser,"edit_prices")&&<div style={{fontSize:12,color:S.gold,fontWeight:600}}>Нажмите чтобы добавить →</div>}
              </div>
            )}
          </div>

          {/* ── РЕДАКТОР ── */}
          {can(currentUser,"edit_prices")&&(
            <div style={{padding:isMobile?"16px":"20px 24px",background:S.bg}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
                <div>
                  <div style={{fontSize:11,fontWeight:700,color:S.black,letterSpacing:1}}>Фото для: {slot.name}</div>
                  <div style={{fontSize:10,color:S.mid,marginTop:2}}>Первое фото — главное на карточке</div>
                </div>
                <button onClick={()=>setShowUpload(true)} style={{background:S.black,color:"#fff",border:"none",padding:"9px 18px",fontSize:11,fontWeight:700,letterSpacing:1,textTransform:"uppercase",cursor:"pointer",fontFamily:S.sans}}>
                  + Добавить фото
                </button>
              </div>

              {/* Сетка миниатюр */}
              {urls.length>0?(
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(90px,1fr))",gap:8}}>
                  {urls.map((url,i)=>(
                    <div key={i} style={{position:"relative",border:i===activeIdx?`2px solid ${S.black}`:`1px solid ${S.border}`,cursor:"pointer",aspectRatio:"4/3",overflow:"hidden",background:S.bg}}
                      onClick={()=>setActiveIdx(i)}>
                      {isVideo(url)
                        ?<div style={{width:"100%",height:"100%",background:"#1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,color:"#fff"}}>▶</div>
                        :<img src={url} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}
                            onError={e=>{e.target.style.display="none";}}/>
                      }
                      {/* Контролы при наведении */}
                      <div className="thumb-ctrl" style={{position:"absolute",inset:0,background:"rgba(0,0,0,0)",display:"flex",flexDirection:"column",justifyContent:"space-between",padding:3,transition:"background 0.2s"}}>
                        <div style={{display:"flex",justifyContent:"flex-end",gap:3}}>
                          {i>0&&<button onClick={e=>{e.stopPropagation();moveItem(selected,i,-1);}}
                            title="Влево" style={{background:"rgba(255,255,255,0.95)",border:"none",borderRadius:3,width:22,height:22,cursor:"pointer",fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700}}>←</button>}
                          {i<urls.length-1&&<button onClick={e=>{e.stopPropagation();moveItem(selected,i,1);}}
                            title="Вправо" style={{background:"rgba(255,255,255,0.95)",border:"none",borderRadius:3,width:22,height:22,cursor:"pointer",fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700}}>→</button>}
                          <button onClick={e=>{e.stopPropagation();if(window.confirm("Удалить?"))deleteItem(selected,i);}}
                            title="Удалить" style={{background:"rgba(220,38,38,0.9)",border:"none",borderRadius:3,width:22,height:22,cursor:"pointer",fontSize:11,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700}}>✕</button>
                        </div>
                        <div style={{fontSize:9,color:"#fff",background:"rgba(0,0,0,0.5)",textAlign:"center",padding:"2px 0",letterSpacing:0.5}}>
                          {i===0?"главное":i+1}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ):(
                <div style={{border:`2px dashed ${S.border}`,padding:"28px 20px",textAlign:"center",cursor:"pointer",background:S.white}}
                  onClick={()=>setShowUpload(true)}>
                  <div style={{fontSize:11,color:S.light,letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>Нет фото</div>
                  <div style={{fontSize:12,color:S.gold,fontWeight:600}}>Нажмите чтобы загрузить</div>
                </div>
              )}

              <style>{`.thumb-ctrl:hover{background:rgba(0,0,0,0.35)!important}`}</style>

              {urls.length>0&&<div style={{marginTop:10,fontSize:10,color:S.light,lineHeight:1.6}}>
                Нажмите на миниатюру — появится в превью. ← → меняет порядок. Первое = главное на сайте.
              </div>}
            </div>
          )}
        </div>
      </div>

      {/* ── МОДАЛ ЗАГРУЗКИ ── */}
      {showUpload&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:9999,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
          <div style={{background:S.white,width:"100%",maxWidth:500,padding:"22px 20px 36px",borderRadius:"16px 16px 0 0",fontFamily:S.sans}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
              <div>
                <div style={{fontSize:14,fontWeight:700,color:S.black}}>{slot.name}</div>
                <div style={{fontSize:11,color:S.mid,marginTop:2}}>Фото появится на сайте сразу после загрузки</div>
              </div>
              <button onClick={()=>setShowUpload(false)} style={{background:"#f0ede8",border:"none",borderRadius:"50%",width:32,height:32,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",color:S.black}}>✕</button>
            </div>

            {/* Загрузка файла */}
            <label style={{display:"block",border:`2px dashed ${S.border}`,padding:"24px",textAlign:"center",cursor:"pointer",marginBottom:14,background:"#fafaf8"}}>
              <input type="file" multiple accept="image/*,video/*" style={{display:"none"}}
                onChange={async e=>{
                  const files=Array.from(e.target.files);
                  if(!files.length) return;
                  setUploading(true);setUploadPct(0);
                  const uploaded=[];
                  for(let i=0;i<files.length;i++){
                    try{
                      const url=await uploadCatalogFile(files[i],selected);
                      uploaded.push(url);
                      setUploadPct(Math.round((i+1)/files.length*100));
                    }catch(err){console.error(err);}
                  }
                  if(uploaded.length>0){
                    const cur=media[selected]||{urls:[]};
                    const newUrls=[...(cur.urls||[]),...uploaded];
                    const updated={...media,[selected]:{...cur,urls:newUrls}};
                    setMedia(updated);saveMedia(updated);
                    setActiveIdx(cur.urls?.length||0);
                  }
                  setUploading(false);setUploadPct(0);setShowUpload(false);
                }}/>
              {uploading?(
                <div>
                  <div style={{fontSize:13,color:S.black,fontWeight:600,marginBottom:10}}>Загружаю... {uploadPct}%</div>
                  <div style={{height:3,background:S.border,borderRadius:2}}>
                    <div style={{height:"100%",width:`${uploadPct}%`,background:S.black,borderRadius:2,transition:"width 0.3s"}}/>
                  </div>
                </div>
              ):(
                <>
                  <div style={{fontSize:13,color:S.black,fontWeight:600,marginBottom:4}}>Нажмите или перетащите</div>
                  <div style={{fontSize:11,color:S.light}}>JPG, PNG, MP4, MOV — можно несколько сразу</div>
                </>
              )}
            </label>

            {/* Ссылка */}
            <div style={{fontSize:11,color:S.mid,marginBottom:8}}>Или вставить ссылку:</div>
            <div style={{display:"flex",gap:8}}>
              <input id="cat-url" type="url" placeholder="https://..." style={{flex:1,border:`1px solid ${S.border}`,padding:"10px 12px",fontSize:12,fontFamily:S.sans,background:S.white,color:S.black,outline:"none"}}/>
              <button onClick={()=>{
                const val=document.getElementById("cat-url")?.value?.trim();
                if(!val) return;
                const cur=media[selected]||{urls:[]};
                const newUrls=[...(cur.urls||[]),val];
                const updated={...media,[selected]:{...cur,urls:newUrls}};
                setMedia(updated);saveMedia(updated);
                setActiveIdx(cur.urls?.length||0);
                setShowUpload(false);
              }} style={{background:S.black,color:"#fff",border:"none",padding:"10px 16px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:S.sans}}>
                Добавить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ─── KP EDITOR ────────────────────────────────────────────────────────────────
const KP_TEMPLATES_KEY = "igs_kp_templates_v1";
function loadKPTemplates(){try{const r=JSON.parse(localStorage.getItem(KP_TEMPLATES_KEY)||"null");if(r)return r;}catch(_){}return {};}
function saveKPTemplatesLocal(data){
  try{localStorage.setItem(KP_TEMPLATES_KEY,JSON.stringify(data));}catch(_){}
  dbSet("kp_templates", data);
}

function KPEditor({isMobile}) {
  const[tab,setTab]=useState("products");
  const[templates,setTemplates]=useState(()=>loadKPTemplates());
  const[selected,setSelected]=useState(PRODUCTS[0]?.id||"greenawn");
  const[combo,setCombo]=useState([]);
  const[uploading,setUploading]=useState(false);
  const[saved,setSaved]=useState(false);

  useEffect(()=>{
    dbGet("kp_templates").then(d=>{if(d){setTemplates(d);localStorage.setItem(KP_TEMPLATES_KEY,JSON.stringify(d));}});
    const u=dbListen("kp_templates",d=>{if(d){setTemplates(d);localStorage.setItem(KP_TEMPLATES_KEY,JSON.stringify(d));}});
    return u;
  },[]);

  function getTpl(id){return templates[id]||{};}

  function saveTpl(id,field,value){
    const updated={...templates,[id]:{...(templates[id]||{}),[field]:value}};
    setTemplates(updated);
    saveKPTemplatesLocal(updated);
    setSaved(true);setTimeout(()=>setSaved(false),1800);
  }

  async function uploadPhoto(id,file){
    setUploading(true);
    try{
      // Загружаем в Firebase Storage — оригинальное качество, реальный HTTPS URL
      const url = await uploadKPPhoto(file, id);
      saveTpl(id,"photo",url);
    }catch(e){
      console.error("Upload error:",e);
    }
    setUploading(false);
  }

  function previewKP(productIds){
    const mockClient={name:"Клиент",address:"Алматы",phone:"+7 700 000 0000"};
    const items=productIds.map(pid=>({productId:pid,width:5,depth:4,quantity:1,selectedOptions:[]}));
    const photo=getTpl(productIds[0])?.photo||null;
    const html=generateClientKPHtml(mockClient,items,0,photo,templates);
    printHtmlSafe(html);
  }

  const p=PRODUCTS.find(pr=>pr.id===selected)||PRODUCTS[0];
  const tpl=getTpl(selected);
  const effPhoto=tpl.photo||null;
  const effDesc=tpl.desc||KP_PRODUCT_DESC[selected]||"";
  const effBenefits=Array.isArray(tpl.benefits)?tpl.benefits:(KP_PRODUCT_BENEFITS[selected]||[]);

  const W={bg:"#f7f6f3",white:"#fff",black:"#0d0d0d",border:"#e4e2de",mid:"#666",light:"#aaa",gold:"#b8965a",serif:"'Georgia',serif"};
  const inp={background:W.white,border:`1px solid ${W.border}`,borderRadius:0,padding:"10px 12px",color:W.black,fontSize:12,width:"100%",outline:"none",fontFamily:T.font,resize:"vertical"};

  return(
    <div style={{fontFamily:T.font,background:W.bg,minHeight:"100vh",paddingBottom:isMobile?120:0}}>

      {/* Шапка */}
      <div style={{background:W.white,borderBottom:`1px solid ${W.border}`,padding:isMobile?"14px 16px":"18px 28px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:9,color:W.gold,fontWeight:700,letterSpacing:3,textTransform:"uppercase",marginBottom:3}}>Настройки</div>
          <div style={{fontFamily:W.serif,fontSize:isMobile?18:22,fontWeight:400,color:W.black}}>Редактор КП</div>
          <div style={{fontSize:11,color:W.mid,marginTop:2}}>Настройте фото и описание для каждого продукта</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          {saved&&<span style={{fontSize:11,color:"#3db96a",fontWeight:600}}>✓ Сохранено</span>}
          <div style={{display:"flex",border:`1px solid ${W.border}`}}>
            {[["products","По продуктам"],["combos","Комбинации"]].map(([k,l])=>(
              <button key={k} onClick={()=>setTab(k)} style={{
                padding:"9px 16px",fontSize:11,fontWeight:700,cursor:"pointer",border:"none",
                background:tab===k?W.black:"transparent",color:tab===k?"#fff":W.mid,
                fontFamily:T.font,letterSpacing:0.5,whiteSpace:"nowrap",
              }}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      {/* ТАБ 1: ПО ПРОДУКТАМ */}
      {tab==="products"&&(
        <div style={{display:"flex",flexDirection:isMobile?"column":"row"}}>

          {/* Список */}
          <div style={{
            width:isMobile?"100%":200,flexShrink:0,background:W.white,
            borderRight:isMobile?"none":`1px solid ${W.border}`,
            ...(isMobile?{display:"flex",overflowX:"auto",gap:6,padding:"12px 16px",borderBottom:`1px solid ${W.border}`}:{})
          }}>
            {PRODUCTS.map(pr=>{
              const hasPh=!!getTpl(pr.id).photo;
              const active=selected===pr.id;
              return isMobile?(
                <button key={pr.id} onClick={()=>setSelected(pr.id)} style={{
                  flexShrink:0,padding:"7px 14px",fontSize:11,fontWeight:700,cursor:"pointer",
                  whiteSpace:"nowrap",fontFamily:T.font,
                  background:active?W.black:"transparent",color:active?"#fff":W.mid,
                  border:`1px solid ${active?W.black:W.border}`,
                }}>
                  {pr.shortName}{hasPh&&<span style={{marginLeft:4,color:active?"rgba(255,255,255,0.5)":W.gold}}>●</span>}
                </button>
              ):(
                <div key={pr.id} onClick={()=>setSelected(pr.id)} style={{
                  padding:"12px 18px",cursor:"pointer",borderBottom:`1px solid ${W.border}`,
                  background:active?"#f0ede8":W.white,
                  borderLeft:active?`3px solid ${W.black}`:"3px solid transparent",transition:"all 0.15s",
                }}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
                    <span style={{fontSize:12,fontWeight:600,color:active?W.black:W.mid}}>{pr.shortName}</span>
                    {hasPh&&<span style={{fontSize:8,color:W.gold,fontWeight:700,letterSpacing:0.5}}>ФОТО</span>}
                  </div>
                  <div style={{fontSize:9,color:W.light}}>{pr.tag}</div>
                </div>
              );
            })}
          </div>

          {/* Редактор */}
          <div style={{flex:1,padding:isMobile?"14px":"20px 24px",display:"flex",flexDirection:"column",gap:14}}>

            {/* Заголовок продукта + превью */}
            <div style={{background:W.white,border:`1px solid ${W.border}`,padding:"16px 18px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap"}}>
              <div>
                <div style={{fontFamily:W.serif,fontSize:18,color:W.black,fontWeight:400}}>{p?.name}</div>
                <div style={{fontSize:10,color:W.light,marginTop:2}}>{p?.tag}</div>
              </div>
              <button onClick={()=>previewKP([selected])}
                style={{background:"rgba(184,150,90,0.1)",border:`1px solid ${W.gold}`,color:W.gold,
                  padding:"9px 16px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:T.font,flexShrink:0}}>
                👁 Превью КП
              </button>
            </div>

            {/* Фото */}
            <div style={{background:W.white,border:`1px solid ${W.border}`,padding:"16px 18px"}}>
              <div style={{fontSize:9,fontWeight:700,color:W.black,letterSpacing:2,textTransform:"uppercase",marginBottom:10}}>
                Фото в КП
              </div>
              {effPhoto&&(
                <div style={{position:"relative",marginBottom:10}}>
                  <img src={effPhoto} alt="" style={{width:"100%",height:140,objectFit:"cover",display:"block"}}/>
                  <div style={{position:"absolute",bottom:8,left:10,fontSize:10,color:"rgba(255,255,255,0.8)",background:"rgba(0,0,0,0.45)",padding:"2px 8px"}}>
                    {p?.shortName}
                  </div>
                  <button onClick={()=>saveTpl(selected,"photo",null)}
                    style={{position:"absolute",top:8,right:8,background:"rgba(0,0,0,0.55)",border:"none",color:"#fff",width:26,height:26,borderRadius:"50%",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                </div>
              )}
              <label style={{display:"flex",alignItems:"center",gap:10,padding:"12px",border:`1px dashed ${W.border}`,cursor:"pointer",background:W.bg}}>
                <input type="file" accept="image/*" style={{display:"none"}}
                  onChange={e=>{const f=e.target.files?.[0];if(f)uploadPhoto(selected,f);}}/>
                <span style={{fontSize:12,color:W.mid,fontWeight:500}}>
                  {uploading?"Загружаю...":(effPhoto?"🔄 Заменить фото":"📷 Загрузить фото")}
                </span>
              </label>
              <div style={{fontSize:10,color:W.light,marginTop:6}}>
                Это фото автоматически появится в КП когда выбирают этот продукт
              </div>
            </div>

            {/* Описание */}
            <div style={{background:W.white,border:`1px solid ${W.border}`,padding:"16px 18px"}}>
              <div style={{fontSize:9,fontWeight:700,color:W.black,letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Описание</div>
              <textarea value={effDesc} rows={4} style={inp}
                onChange={e=>{const u={...templates,[selected]:{...(templates[selected]||{}),desc:e.target.value}};setTemplates(u);}}
                onBlur={e=>saveTpl(selected,"desc",e.target.value)}
                placeholder="Описание продукта в КП..."/>
            </div>

            {/* Преимущества */}
            <div style={{background:W.white,border:`1px solid ${W.border}`,padding:"16px 18px"}}>
              <div style={{fontSize:9,fontWeight:700,color:W.black,letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>
                Преимущества
              </div>
              <div style={{fontSize:10,color:W.light,marginBottom:8}}>Каждая строка = один пункт</div>
              <textarea value={effBenefits.join("\n")} rows={6} style={inp}
                onChange={e=>{const v=e.target.value.split("\n");const u={...templates,[selected]:{...(templates[selected]||{}),benefits:v}};setTemplates(u);}}
                onBlur={e=>saveTpl(selected,"benefits",e.target.value.split("\n").filter(l=>l.trim()))}
                placeholder={"Поворот ламелей 0°–135°\nГерметичная крыша\nВодосток в колоннах"}/>
            </div>

            <button onClick={()=>{const u={...templates};delete u[selected];setTemplates(u);saveKPTemplatesLocal(u);}}
              style={{background:"transparent",border:`1px solid ${W.border}`,color:W.light,padding:"9px",fontSize:11,cursor:"pointer",fontFamily:T.font}}>
              Сбросить к значениям по умолчанию
            </button>
          </div>
        </div>
      )}

      {/* ТАБ 2: КОМБИНАЦИИ */}
      {tab==="combos"&&(
        <div style={{padding:isMobile?"14px":"24px",display:"flex",flexDirection:"column",gap:16,maxWidth:700}}>

          <div style={{background:W.white,border:`1px solid ${W.border}`,padding:"16px 18px"}}>
            <div style={{fontSize:9,fontWeight:700,color:W.black,letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>
              Выберите продукты для комбо-КП
            </div>
            <div style={{fontSize:10,color:W.light,marginBottom:14}}>
              Выберите несколько — увидите как будет выглядеть КП с несколькими позициями
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8}}>
              {PRODUCTS.map(pr=>{
                const sel=combo.includes(pr.id);
                const hasPh=!!getTpl(pr.id).photo;
                return(
                  <button key={pr.id}
                    onClick={()=>setCombo(c=>sel?c.filter(x=>x!==pr.id):[...c,pr.id])}
                    style={{
                      padding:"10px 12px",fontSize:11,fontWeight:600,cursor:"pointer",
                      textAlign:"left",fontFamily:T.font,
                      background:sel?W.black:"transparent",
                      color:sel?"#fff":W.mid,
                      border:`1px solid ${sel?W.black:W.border}`,
                      display:"flex",alignItems:"center",justifyContent:"space-between",
                      transition:"all 0.15s",
                    }}>
                    <span>{pr.shortName}</span>
                    {hasPh&&<span style={{fontSize:8,opacity:0.5}}>●</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {combo.length>0?(
            <>
              <div style={{background:W.white,border:`1px solid ${W.border}`,padding:"16px 18px"}}>
                <div style={{fontSize:9,fontWeight:700,color:W.black,letterSpacing:2,textTransform:"uppercase",marginBottom:12}}>
                  Выбрано: {combo.length} продукт(а)
                </div>
                {combo.map((pid,i)=>{
                  const pr=PRODUCTS.find(p2=>p2.id===pid);
                  const hasPh=!!getTpl(pid).photo;
                  return(
                    <div key={pid} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:i<combo.length-1?`1px solid ${W.border}`:"none"}}>
                      <div style={{width:5,height:5,borderRadius:"50%",background:W.gold,flexShrink:0}}/>
                      <div style={{flex:1}}>
                        <div style={{fontSize:13,fontWeight:600,color:W.black}}>{pr?.name}</div>
                        <div style={{fontSize:10,color:W.light,marginTop:1}}>
                          {hasPh?"📷 Фото настроено":"⚠️ Нет фото — настройте в «По продуктам»"}
                        </div>
                      </div>
                      <div style={{fontSize:12,color:W.gold,fontWeight:700,fontFamily:"monospace"}}>
                        {new Intl.NumberFormat("ru-RU").format(pr?.price||0)} ₸/м²
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{display:"flex",gap:10}}>
                <button onClick={()=>previewKP(combo)}
                  style={{flex:1,background:W.black,color:"#fff",border:"none",padding:"13px",
                    fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:T.font,letterSpacing:0.5}}>
                  👁 Открыть превью КП
                </button>
                <button onClick={()=>setCombo([])}
                  style={{background:"transparent",border:`1px solid ${W.border}`,color:W.mid,
                    padding:"13px 18px",fontSize:11,cursor:"pointer",fontFamily:T.font}}>
                  Сбросить
                </button>
              </div>

              <div style={{fontSize:11,color:W.light,lineHeight:1.6,padding:"12px 14px",background:W.white,border:`1px solid ${W.border}`}}>
                💡 Фото берётся из первого продукта в списке. Для каждого продукта настройте фото в табе «По продуктам».
              </div>
            </>
          ):(
            <div style={{background:W.white,border:`1px solid ${W.border}`,padding:"40px",textAlign:"center"}}>
              <div style={{fontSize:12,color:W.light,letterSpacing:1}}>Выберите продукты выше</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ─── PRICE EDITOR ─────────────────────────────────────────────────────────────
function PriceEditor({onPricesChanged, isMobile}) {
  const [draft, setDraft] = useState(() => {
    const saved = loadPrices();
    return DEFAULT_PRODUCTS.map(dp => {
      const s = saved?.[dp.id];
      return {
        id: dp.id, name: dp.shortName, emoji: dp.emoji,
        price: s?.price ?? dp.price,
        options: dp.options.map(o => ({
          id: o.id, label: o.label, flat: o.flat,
          price: s?.options?.[o.id] ?? o.price
        }))
      };
    });
  });
  const [saved, setSaved] = useState(false);

  function updatePrice(id, val) {
    setDraft(d => d.map(p => p.id === id ? {...p, price: parseFloat(val)||0} : p));
  }
  function updateOpt(pid, oid, val) {
    setDraft(d => d.map(p => p.id === pid ? {
      ...p,
      options: p.options.map(o => o.id === oid ? {...o, price: parseFloat(val)||0} : o)
    } : p));
  }

  function handleSave() {
    // Формируем объект для сохранения
    const pricesObj = {};
    draft.forEach(p => {
      const opts = {};
      p.options.forEach(o => { opts[o.id] = o.price; });
      pricesObj[p.id] = { price: p.price, options: opts };
    });
    // Применяем к PRODUCTS
    applyPrices(pricesObj);
    // Сохраняем
    savePrices(pricesObj);
    // Триггерим ре-рендер
    onPricesChanged();
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  const inputStyle = {
    background: T.elevated, border: `1px solid ${T.border}`, borderRadius: 8,
    padding: "8px 11px", color: T.text, fontSize: 13, width: "100%",
    outline: "none", fontFamily: T.mono, textAlign: "right",
  };

  return (
    <div style={{ padding: isMobile ? "16px 14px" : "0", paddingBottom: isMobile ? 120 : 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 10, color: T.textDim, letterSpacing: 3, marginBottom: 3, fontWeight: 600 }}>НАСТРОЙКИ</div>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: T.serif }}>Цены продуктов</div>
        </div>
        <button onClick={handleSave}
          style={{ background: saved ? "linear-gradient(135deg,#3db96a,#2d9a54)" : "linear-gradient(135deg,#b8965a,#d4b878)", color: saved ? "#fff" : "#09090b", border: "none", borderRadius: 12, padding: "11px 20px", fontSize: 13, fontWeight: 800, cursor: "pointer", fontFamily: T.font, transition: "all 0.3s" }}>
          {saved ? "Сохранено" : "💾 Сохранить"}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {draft.map(p => (
          <GlassCard key={p.id} style={{ padding: "16px 18px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: p.options.length > 0 ? 12 : 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 22 }}>{p.emoji}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{p.name}</div>
                  <div style={{ fontSize: 10, color: T.textDim, marginTop: 1 }}>Базовая цена за м²</div>
                </div>
              </div>
              <div style={{ width: 130 }}>
                <input type="number" value={p.price} onChange={e => updatePrice(p.id, e.target.value)} style={inputStyle}/>
              </div>
            </div>
            {p.options.length > 0 && (
              <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                {p.options.map(o => (
                  <div key={o.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ fontSize: 12, color: T.textSec }}>{o.label} {o.flat ? "(фикс.)" : "/м²"}</div>
                    <div style={{ width: 110 }}>
                      <input type="number" value={o.price} onChange={e => updateOpt(p.id, o.id, e.target.value)} style={{...inputStyle, fontSize: 12}}/>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </GlassCard>
        ))}
      </div>

      <div style={{ marginTop: 16, padding: "12px 14px", background: "rgba(184,150,90,0.06)", border: "1px solid rgba(184,150,90,0.15)", borderRadius: 10, fontSize: 11, color: T.textSec, lineHeight: 1.6 }}>
        💡 Изменения применяются ко всем новым КП сразу после сохранения. Текущие сохранённые КП не меняются.
      </div>
    </div>
  );
}

// ─── BOT LEADS ────────────────────────────────────────────────────────────────
// Защитный протокол
const BOT_LEADS_CACHE_KEY = "igs_bot_leads_cache_v1";
// Защитный протокол: все операции логируются, данные не удаляются физически
// а помечаются как deleted=true, реальное удаление только по явному подтверждению

function BotLeads({isMobile}) {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(null); // лид на редактирование
  const [filter, setFilter] = useState("all");
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const STATUS_COLORS = {
    new:       {label:"Новый",           color:"#d97706", bg:"rgba(217,119,6,0.12)"},
    contacted: {label:"Связались",       color:"#2563eb", bg:"rgba(37,99,235,0.12)"},
    converted: {label:"Конвертирован",   color:"#16a34a", bg:"rgba(22,163,74,0.12)"},
    lost:      {label:"Потерян",         color:"#dc2626", bg:"rgba(220,38,38,0.12)"},
  };

  // ── ЗАГРУЗКА + REALTIME ─────────────────────────────────────────────────────
  useEffect(() => {
    // 1) Мгновенно из localStorage кэша
    try {
      const cached = JSON.parse(localStorage.getItem(BOT_LEADS_CACHE_KEY)||"null");
      if(Array.isArray(cached) && cached.length > 0) { setLeads(cached); setLoading(false); }
    } catch(_) {}
    setLoading(true);
    // 2) Из Firebase
    dbGet("bot_leads").then(data => {
      if (data && typeof data === "object") {
        const arr = Object.values(data)
          .filter(l => !l.deleted)
          .sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt));
        setLeads(arr);
        try { localStorage.setItem(BOT_LEADS_CACHE_KEY, JSON.stringify(arr)); } catch(_) {}
      }
      setLoading(false);
    });
    // Realtime — любое изменение с любого устройства
    const unsub = dbListen("bot_leads", (data) => {
      if (data && typeof data === "object") {
        const arr = Object.values(data)
          .filter(l => !l.deleted)
          .sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt));
        setLeads(arr);
        setLoading(false);
      }
    });
    return unsub;
  }, []);

  // ── ОБНОВЛЕНИЕ СТАТУСА ──────────────────────────────────────────────────────
  async function updateLeadStatus(id, status) {
    const lead = leads.find(l => l.id === id);
    if (!lead) return;
    const updated = {...lead, status, updatedAt: new Date().toISOString()};
    // Пишем в Firebase
    await dbSet(`bot_leads/${id}`, updated);
    // Обновляем локально
    setLeads(prev => prev.map(l => l.id === id ? updated : l));
    // Если открыт detail — обновляем и его
    if (selected?.id === id) setSelected(updated);
  }

  // ── СОХРАНЕНИЕ ИЗМЕНЕНИЙ ─────────────────────────────────────────────────────
  async function saveLead(editedLead) {
    const updated = {...editedLead, updatedAt: new Date().toISOString()};
    // Защита: сначала бэкап старой версии
    const old = leads.find(l => l.id === editedLead.id);
    if (old) await dbSet(`bot_leads_backup/${old.id}_${Date.now()}`, old);
    // Сохраняем новую версию
    await dbSet(`bot_leads/${updated.id}`, updated);
    setLeads(prev => prev.map(l => l.id === updated.id ? updated : l));
    setSelected(updated);
    setEditing(null);
  }

  // ── МЯГКОЕ УДАЛЕНИЕ (с защитой) ─────────────────────────────────────────────
  async function deleteLead(id) {
    const lead = leads.find(l => l.id === id);
    if (!lead) return;
    // Защита: сохраняем копию в корзину Firebase перед удалением
    await dbSet(`bot_leads_trash/${id}`, {...lead, deletedAt: new Date().toISOString()});
    // Помечаем как удалённый (не удаляем физически)
    await dbSet(`bot_leads/${id}`, {...lead, deleted: true, deletedAt: new Date().toISOString()});
    setLeads(prev => prev.filter(l => l.id !== id));
    setSelected(null);
    setDeleteConfirm(null);
  }

  // ── ФОРМАТИРОВАНИЕ ВРЕМЕНИ ──────────────────────────────────────────────────
  const fmtTime = iso => {
    if (!iso) return "—";
    const d = new Date(iso);
    const diff = Date.now() - d;
    if (diff < 60000) return "только что";
    if (diff < 3600000) return Math.floor(diff/60000) + " мин назад";
    if (diff < 86400000) return Math.floor(diff/3600000) + " ч назад";
    return d.toLocaleDateString("ru-KZ", {day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
  };

  const filtered = filter === "all" ? leads : leads.filter(l => l.status === filter);

  // ── КАРТОЧКА ЛИДА ───────────────────────────────────────────────────────────
  const LeadCard = ({lead}) => {
    const sc = STATUS_COLORS[lead.status] || STATUS_COLORS.new;
    return (
      <div onClick={() => setSelected(lead)}
        style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"13px 15px",cursor:"pointer",transition:"all 0.2s",position:"relative"}}
        onMouseEnter={e=>{e.currentTarget.style.borderColor=T.borderHover;e.currentTarget.style.background=T.elevated;}}
        onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border;e.currentTarget.style.background=T.card;}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
          <div style={{display:"flex",alignItems:"center",gap:9}}>
            <div style={{width:34,height:34,borderRadius:9,background:"rgba(184,150,90,0.1)",border:`1px solid ${T.goldDim}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>🤖</div>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:T.text}}>{lead.name||"Неизвестно"}</div>
              {lead.phone&&<div style={{fontSize:11,color:T.textSec,fontFamily:T.mono,marginTop:1}}>{lead.phone}</div>}
            </div>
          </div>
          <span style={{background:sc.bg,color:sc.color,borderRadius:20,padding:"3px 10px",fontSize:10,fontWeight:700,flexShrink:0}}>{sc.label}</span>
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:6}}>
          {lead.product_type&&<span style={{background:"rgba(184,150,90,0.08)",color:T.gold,borderRadius:6,padding:"2px 8px",fontSize:11}}>🌿 {lead.product_type}</span>}
          {lead.productType&&<span style={{background:"rgba(184,150,90,0.08)",color:T.gold,borderRadius:6,padding:"2px 8px",fontSize:11}}>🌿 {lead.productType}</span>}
          {lead.dimensions&&<span style={{background:T.elevated,color:T.textSec,borderRadius:6,padding:"2px 8px",fontSize:11,fontFamily:T.mono}}>📐 {lead.dimensions}</span>}
          {lead.hasMedia&&<span style={{background:"rgba(96,165,250,0.1)",color:"#60a5fa",borderRadius:6,padding:"2px 8px",fontSize:11}}>📸 Фото</span>}
          {lead.wants_measure&&<span style={{background:"rgba(90,154,106,0.1)",color:T.green,borderRadius:6,padding:"2px 8px",fontSize:11}}>📅 Замер</span>}
        </div>
        {lead.notes&&<div style={{fontSize:12,color:T.textSec,borderTop:`1px solid ${T.border}`,paddingTop:6,marginTop:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{lead.notes}</div>}
        <div style={{fontSize:10,color:T.textDim,marginTop:6,textAlign:"right"}}>{fmtTime(lead.createdAt)}</div>
      </div>
    );
  };

  // ── ФОРМА РЕДАКТИРОВАНИЯ ────────────────────────────────────────────────────
  const EditForm = ({lead, onClose}) => {
    const [form, setForm] = useState({
      name: lead.name||"",
      phone: lead.phone||"",
      address: lead.address||"",
      product_type: lead.product_type||lead.productType||"",
      dimensions: lead.dimensions||"",
      notes: lead.notes||"",
      wants_measure: lead.wants_measure||"",
    });
    return (
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:9999,overflowY:"auto"}}>
        <div style={{minHeight:"100%",display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:T.surface,borderRadius:16,width:"100%",maxWidth:500,padding:"22px 24px",fontFamily:T.font}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
              <div style={{fontSize:16,fontWeight:700,fontFamily:T.serif}}>✏️ Редактировать лид</div>
              <button onClick={onClose} style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,color:T.textSec}}>✕</button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {[
                ["Имя клиента","name","text"],
                ["Телефон","phone","tel"],
                ["Адрес / локация","address","text"],
                ["Тип конструкции","product_type","text"],
                ["Размеры","dimensions","text"],
                ["Дата замера","wants_measure","text"],
              ].map(([label,key,type])=>(
                <div key={key}>
                  <div style={{fontSize:10,color:T.textSec,fontWeight:600,letterSpacing:1,marginBottom:5,textTransform:"uppercase"}}>{label}</div>
                  <Inp type={type} value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))} placeholder={label}/>
                </div>
              ))}
              <div>
                <div style={{fontSize:10,color:T.textSec,fontWeight:600,letterSpacing:1,marginBottom:5,textTransform:"uppercase"}}>Заметки</div>
                <textarea value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))}
                  style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,padding:"11px 14px",color:T.text,fontSize:14,width:"100%",outline:"none",minHeight:80,resize:"vertical",fontFamily:T.font}}/>
              </div>
              <div style={{display:"flex",gap:8,marginTop:4}}>
                <button onClick={()=>saveLead({...lead,...form})}
                  style={{flex:1,background:T.gold,color:"#0a0a0b",border:"none",borderRadius:10,padding:"12px",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:T.font}}>
                  💾 Сохранить
                </button>
                <button onClick={onClose}
                  style={{flex:1,background:T.elevated,color:T.text,border:`1px solid ${T.border}`,borderRadius:10,padding:"12px",fontWeight:600,fontSize:14,cursor:"pointer",fontFamily:T.font}}>
                  Отмена
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ── ДЕТАЛЬНАЯ КАРТОЧКА ──────────────────────────────────────────────────────
  const LeadDetail = ({lead, onClose}) => {
    const sc = STATUS_COLORS[lead.status] || STATUS_COLORS.new;
    return (
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:9998,overflowY:"auto"}}>
        <div style={{minHeight:"100%",display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:T.surface,borderRadius:16,width:"100%",maxWidth:500,padding:"22px 24px",fontFamily:T.font}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
              <div style={{fontSize:16,fontWeight:700,fontFamily:T.serif}}>🤖 Лид от бота</div>
              <div style={{display:"flex",gap:7}}>
                <button onClick={()=>{setEditing(lead);onClose();}}
                  style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,padding:"5px 12px",cursor:"pointer",fontSize:12,color:T.gold,fontFamily:T.font,fontWeight:600}}>✏️ Изменить</button>
                <button onClick={()=>setDeleteConfirm(lead.id)}
                  style={{background:T.dangerBg,border:"1px solid rgba(196,84,84,0.2)",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontSize:12,color:T.danger,fontFamily:T.font,fontWeight:600}}>🗑️</button>
                <button onClick={onClose}
                  style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,color:T.textSec}}>✕</button>
              </div>
            </div>

            {/* Статус */}
            <div style={{marginBottom:14}}>
              <div style={{fontSize:10,color:T.textSec,fontWeight:600,letterSpacing:1,marginBottom:7,textTransform:"uppercase"}}>Статус</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {Object.entries(STATUS_COLORS).map(([k,v])=>(
                  <button key={k} onClick={()=>updateLeadStatus(lead.id,k)}
                    style={{background:lead.status===k?v.bg:T.elevated,color:lead.status===k?v.color:T.textSec,border:`1px solid ${lead.status===k?v.color:T.border}`,borderRadius:8,padding:"5px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:T.font,transition:"all 0.15s"}}>
                    {v.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Данные */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
              {[
                ["👤 Имя",     lead.name],
                ["📞 Телефон", lead.phone],
                ["🌿 Продукт", lead.product_type||lead.productType],
                ["📐 Размеры", lead.dimensions],
                ["🏠 Объект",  lead.objectType],
                ["📍 Адрес",   lead.address],
                ["📅 Замер",   lead.wants_measure],
              ].filter(([,v])=>v).map(([label,val])=>(
                <div key={label} style={{background:T.card,borderRadius:9,padding:"10px 12px",border:`1px solid ${T.border}`}}>
                  <div style={{fontSize:9,color:T.textSec,marginBottom:3,fontWeight:600,letterSpacing:0.5}}>{label}</div>
                  <div style={{fontSize:13,fontWeight:500}}>{val}</div>
                </div>
              ))}
            </div>

            {lead.notes&&(
              <div style={{marginBottom:14}}>
                <div style={{fontSize:10,color:T.textSec,fontWeight:600,letterSpacing:1,marginBottom:6,textTransform:"uppercase"}}>Резюме / Этап</div>
                <div style={{background:T.card,borderRadius:9,padding:"11px 13px",border:`1px solid ${T.border}`,fontSize:13,lineHeight:1.6}}>{lead.notes}</div>
              </div>
            )}

            {/* Действия */}
            <div style={{display:"flex",gap:8}}>
              {lead.phone&&(
                <a href={`https://wa.me/${(lead.phone||"").replace(/\D/g,"")}`} target="_blank" rel="noreferrer"
                  style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:"rgba(90,154,106,0.1)",color:T.green,border:`1px solid rgba(90,154,106,0.2)`,borderRadius:9,padding:"10px",fontWeight:600,fontSize:13,textDecoration:"none",fontFamily:T.font}}>
                  💬 WhatsApp
                </a>
              )}
              {lead.phone&&(
                <a href={`tel:${lead.phone}`}
                  style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:T.elevated,color:T.text,border:`1px solid ${T.border}`,borderRadius:9,padding:"10px",fontWeight:600,fontSize:13,textDecoration:"none",fontFamily:T.font}}>
                  📞 Позвонить
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ── ПОДТВЕРЖДЕНИЕ УДАЛЕНИЯ ──────────────────────────────────────────────────
  const DeleteConfirm = ({id, onClose}) => (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
      <div style={{background:T.surface,borderRadius:16,padding:"24px",maxWidth:360,width:"100%",fontFamily:T.font,textAlign:"center"}}>
        <div style={{fontSize:32,marginBottom:12}}>🗑️</div>
        <div style={{fontSize:16,fontWeight:700,marginBottom:8}}>Удалить лид?</div>
        <div style={{fontSize:13,color:T.textSec,marginBottom:20}}>Лид будет перемещён в корзину Firebase. Его можно восстановить через консоль Firebase.</div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>deleteLead(id)}
            style={{flex:1,background:T.dangerBg,color:T.danger,border:"1px solid rgba(196,84,84,0.25)",borderRadius:10,padding:"11px",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:T.font}}>
            Удалить
          </button>
          <button onClick={onClose}
            style={{flex:1,background:T.elevated,color:T.text,border:`1px solid ${T.border}`,borderRadius:10,padding:"11px",fontWeight:600,fontSize:14,cursor:"pointer",fontFamily:T.font}}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  );

  // ── РЕНДЕР ──────────────────────────────────────────────────────────────────
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10,marginBottom:20}}>
        <div>
          {!isMobile&&<div style={{fontSize:11,color:T.textSec,letterSpacing:2,marginBottom:4,fontWeight:600}}>АВТОМАТИЗАЦИЯ</div>}
          <div style={{fontSize:isMobile?20:26,fontWeight:800,fontFamily:T.serif}}>
            Лиды от бота
            {leads.filter(l=>l.status==="new").length > 0 && (
              <span style={{marginLeft:10,background:"rgba(217,119,6,0.15)",color:"#d97706",borderRadius:8,padding:"2px 9px",fontSize:13,fontWeight:700,fontFamily:T.font}}>
                {leads.filter(l=>l.status==="new").length} новых
              </span>
            )}
          </div>
        </div>
        <div style={{fontSize:11,color:T.textSec,background:T.elevated,borderRadius:8,padding:"5px 11px",border:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:5}}>
          <span style={{width:6,height:6,borderRadius:3,background:"#ef4444",display:"inline-block",animation:"pulse 1.5s infinite"}}/>
          live из Firebase
        </div>
      </div>

      {/* Фильтры */}
      <div style={{display:"flex",gap:5,overflowX:"auto",paddingBottom:4,marginBottom:14}}>
        {[["all","Все",leads.length],...Object.entries(STATUS_COLORS).map(([k,v])=>[k,v.label,leads.filter(l=>l.status===k).length])].map(([k,label,count])=>{
          if(k!=="all"&&!count) return null;
          const sc = STATUS_COLORS[k];
          const active = filter===k;
          return(
            <button key={k} onClick={()=>setFilter(k)}
              style={{background:active?(sc?.bg||T.goldBg):"rgba(255,255,255,0.03)",color:active?(sc?.color||T.gold):T.textSec,border:`1px solid ${active?(sc?.color||T.gold):T.border}`,borderRadius:20,padding:"5px 13px",fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",fontFamily:T.font,transition:"all 0.2s",flexShrink:0}}>
              {label} ({count})
            </button>
          );
        })}
      </div>

      {loading&&<div style={{textAlign:"center",padding:48,color:T.textSec}}>Загрузка…</div>}

      {!loading&&filtered.length===0&&(
        <div style={{textAlign:"center",padding:60}}>
          <div style={{fontSize:40,marginBottom:14}}>🤖</div>
          <div style={{fontSize:16,fontWeight:700,fontFamily:T.serif,marginBottom:8}}>Лидов пока нет</div>
          <div style={{fontSize:13,color:T.textSec,maxWidth:300,margin:"0 auto",lineHeight:1.6}}>
            Когда бот квалифицирует клиента — он появится здесь автоматически.
          </div>
        </div>
      )}

      <div style={{display:"flex",flexDirection:"column",gap:8,paddingBottom:isMobile?100:0}}>
        {filtered.map(lead=><LeadCard key={lead.id} lead={lead}/>)}
      </div>

      {selected&&<LeadDetail lead={selected} onClose={()=>setSelected(null)}/>}
      {editing&&<EditForm lead={editing} onClose={()=>setEditing(null)}/>}
      {deleteConfirm&&<DeleteConfirm id={deleteConfirm} onClose={()=>setDeleteConfirm(null)}/>}
    </div>
  );
}


// ─── MEETINGS (Встречи) ───────────────────────────────────────────────────────
const MEETINGS_KEY = "igs_meetings_v1";

function loadMeetings(){try{const r=JSON.parse(localStorage.getItem(MEETINGS_KEY)||"null");if(Array.isArray(r))return r;}catch(_){}return[];}

// Сохраняет только ОДНУ встречу в Firebase (без echo-цикла)
function saveMeeting(m){
  try{
    const all = loadMeetings();
    const updated = all.find(x=>x.id===m.id) ? all.map(x=>x.id===m.id?m:x) : [...all,m];
    localStorage.setItem(MEETINGS_KEY, JSON.stringify(updated));
  }catch(_){}
  if(m.id) dbSet(`meetings/${m.id}`, m);
}
function deleteMeetingFb(id){
  try{
    const all = loadMeetings().filter(x=>x.id!==id);
    localStorage.setItem(MEETINGS_KEY, JSON.stringify(all));
  }catch(_){}
  dbSet(`meetings/${id}`, null);
}

function Meetings({isMobile, clients=[]}) {
  const [meetings, setMeetings] = useState(()=>loadMeetings());
  const [filter, setFilter] = useState("upcoming");
  const [selected, setSelected] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  // Форма
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [meetType, setMeetType] = useState("measure"); // measure | showroom
  const [meetDate, setMeetDate] = useState("");
  const [meetTime, setMeetTime] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("scheduled"); // scheduled | done | cancelled

  const SHOWROOM_ADDR = "ул. Сагдат Нурмагамбетова 140/10";

  const meetSubsRef = useRef(new Map());

  function subscribeMeeting(id) {
    if (meetSubsRef.current.has(id)) return;
    const unsub = dbListen(`meetings/${id}`, (remote) => {
      if (!remote || !remote.id) return;
      setMeetings(prev => {
        if (remote.deleted) {
          const updated = prev.filter(m => m.id !== id);
          try { localStorage.setItem(MEETINGS_KEY, JSON.stringify(updated)); } catch(_) {}
          return updated;
        }
        const local = prev.find(m => m.id === id);
        if (!local) {
          // Новая встреча с другого устройства
          const updated = [...prev, remote].sort((a,b)=>new Date(a.meetDate+" "+a.meetTime)-new Date(b.meetDate+" "+b.meetTime));
          try { localStorage.setItem(MEETINGS_KEY, JSON.stringify(updated)); } catch(_) {}
          return updated;
        }
        const localTs  = new Date(local.updatedAt  || local.createdAt  || 0).getTime();
        const remoteTs = new Date(remote.updatedAt || remote.createdAt || 0).getTime();
        // Локальная >= удалённой — это наше эхо или мы актуальнее, не трогаем
        if (localTs >= remoteTs) return prev;
        // Удалённая новее — применяем (другое устройство)
        const updated = prev.map(m => m.id === id ? remote : m)
          .sort((a,b)=>new Date(a.meetDate+" "+a.meetTime)-new Date(b.meetDate+" "+b.meetTime));
        try { localStorage.setItem(MEETINGS_KEY, JSON.stringify(updated)); } catch(_) {}
        return updated;
      });
    });
    meetSubsRef.current.set(id, unsub);
  }

  useEffect(()=>{
    // Начальная загрузка
    dbGet("meetings").then(data=>{
      if(data && typeof data==="object"){
        const arr = Object.values(data).filter(m=>m&&!m.deleted)
          .sort((a,b)=>new Date(a.meetDate+" "+a.meetTime)-new Date(b.meetDate+" "+b.meetTime));
        setMeetings(arr);
        localStorage.setItem(MEETINGS_KEY, JSON.stringify(arr));
        // Подписываемся на каждую встречу
        arr.forEach(m => subscribeMeeting(m.id));
      }
    });
    return () => {
      meetSubsRef.current.forEach(unsub => unsub());
      meetSubsRef.current.clear();
    };
  },[]);

  function resetForm(){
    setClientName(""); setClientPhone(""); setMeetType("showroom");
    setMeetDate(""); setMeetTime(""); setAddress(""); setNotes(""); setStatus("scheduled");
    setEditId(null); setShowForm(false);
  }

  function handleSave(){
    if(!clientName.trim()||!meetDate||!meetTime) return;
    const now = new Date().toISOString();
    const meeting = {
      id: editId || Date.now().toString(),
      clientName: clientName.trim(),
      clientPhone: clientPhone.trim(),
      meetType,
      meetDate,
      meetTime,
      address: meetType==="measure" ? address.trim() : SHOWROOM_ADDR,
      notes: notes.trim(),
      status,
      createdAt: editId ? (meetings.find(m=>m.id===editId)?.createdAt||now) : now,
      updatedAt: now,
    };
    if(editId) dbSet(`meetings_backup/${editId}_${Date.now()}`, meetings.find(m=>m.id===editId)||{});
    const updated = editId ? meetings.map(m=>m.id===editId?meeting:m) : [...meetings, meeting].sort((a,b)=>new Date(a.meetDate+" "+a.meetTime)-new Date(b.meetDate+" "+b.meetTime));
    setMeetings(updated);
    saveMeeting(meeting);
    if (!editId) subscribeMeeting(meeting.id); // подписываемся на новую встречу
    if(selected?.id===editId) setSelected(meeting);

    // Telegram уведомление только при создании новой встречи
    if(!editId) {
      const typeLabel = meeting.meetType==="measure" ? "📐 Замер на объекте" : "🏠 Визит в шоурум";
      const d = new Date(meeting.meetDate);
      const dateStr = d.toLocaleDateString("ru-KZ",{weekday:"long",day:"numeric",month:"long"});
      const tgText = [
        "📅 *НОВАЯ ВСТРЕЧА*",
        "━━━━━━━━━━━━━━━━",
        `👤 *${meeting.clientName}*`,
        meeting.clientPhone ? `📞 ${meeting.clientPhone}` : "",
        ``,
        `${typeLabel}`,
        `🗓 ${dateStr}, ${meeting.meetTime}`,
        `📍 ${meeting.address}`,
        meeting.notes ? `📝 ${meeting.notes}` : "",
        "━━━━━━━━━━━━━━━━",
        `🔗 [Открыть CRM](https://igs-luxurry-terrasa.vercel.app)`,
      ].filter(Boolean).join("\n");

      fetch(`https://api.telegram.org/bot8688553798:AAG9OzcKxzAvQCwq37Wv-UBoPziRzh7HyHY/sendMessage`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          chat_id:"-4996071438",
          text:tgText,
          parse_mode:"Markdown",
        }),
      }).catch(()=>{});
    }

    resetForm();
  }

  function startEdit(m){
    setClientName(m.clientName); setClientPhone(m.clientPhone||"");
    setMeetType(m.meetType); setMeetDate(m.meetDate); setMeetTime(m.meetTime);
    setAddress(m.meetType==="measure"?m.address:""); setNotes(m.notes||"");
    setStatus(m.status); setEditId(m.id); setSelected(null); setShowForm(true);
  }

  function handleDelete(id){
    const m = meetings.find(x=>x.id===id);
    if(m) dbSet(`meetings_trash/${id}`,{...m,deletedAt:new Date().toISOString()});
    deleteMeetingFb(id);
    const unsub = meetSubsRef.current.get(id);
    if(unsub){ unsub(); meetSubsRef.current.delete(id); }
    setMeetings(meetings.filter(x=>x.id!==id));
    setSelected(null); setDeleteConfirm(null);
  }

  function updateStatus(id, st){
    const upd = meetings.find(m=>m.id===id);
    if(!upd) return;
    const updated_m = {...upd, status:st, updatedAt:new Date().toISOString()};
    const updated = meetings.map(m=>m.id===id?updated_m:m);
    setMeetings(updated);
    saveMeeting(updated_m);
    if(selected?.id===id) setSelected(updated_m);
  }

  function generateWAText(m){
    const typeLabel = m.meetType==="measure"?"замер на объекте":"визит в шоурум";
    return [
      `Ассаламуалейкум, это Жандильда — IGS Outdoor 🌿`,
      ``,
      `Подтверждаю вашу запись на ${typeLabel}:`,
      ``,
      `📅 ${formatDate(m.meetDate)}, ${m.meetTime}`,
      `📍 ${m.address}`,
      ``,
      m.meetType==="showroom"
        ? `В шоуруме вы сможете вживую посмотреть все образцы конструкций.`
        : `Наш специалист приедет по указанному адресу.`,
      ``,
      `Если планы изменятся — напишите заранее 🙏`,
    ].join("\n");
  }

  function formatDate(dateStr){
    if(!dateStr) return "—";
    const d = new Date(dateStr);
    return d.toLocaleDateString("ru-KZ",{weekday:"long",day:"numeric",month:"long"});
  }

  function isUpcoming(m){
    const dt = new Date(m.meetDate+"T"+m.meetTime);
    return dt >= new Date() && m.status==="scheduled";
  }
  function isPast(m){
    const dt = new Date(m.meetDate+"T"+m.meetTime);
    return dt < new Date() || m.status==="done" || m.status==="cancelled";
  }
  function isToday(m){
    return m.meetDate===new Date().toISOString().slice(0,10);
  }

  const STATUS_CFG = {
    scheduled: {label:"Запланирована", color:"#d97706", bg:"rgba(217,119,6,0.12)"},
    done:      {label:"Состоялась",    color:"#16a34a", bg:"rgba(22,163,74,0.12)"},
    cancelled: {label:"Отменена",      color:"#dc2626", bg:"rgba(220,38,38,0.12)"},
  };

  const filtered = filter==="upcoming"
    ? meetings.filter(m=>isUpcoming(m)||isToday(m))
    : filter==="today"
    ? meetings.filter(m=>isToday(m))
    : meetings.filter(m=>isPast(m));

  const todayCount = meetings.filter(m=>isToday(m)&&m.status==="scheduled").length;
  const upcomingCount = meetings.filter(m=>isUpcoming(m)).length;

  const MeetCard = ({m}) => {
    const sc = STATUS_CFG[m.status]||STATUS_CFG.scheduled;
    const today = isToday(m);
    const meetTasks = Array.isArray(m.tasks) ? m.tasks : [];
    const activeTasks = meetTasks.filter(t=>!t.done);
    return(
      <div onClick={()=>setSelected(m)}
        style={{background:today?`rgba(184,150,90,0.06)`:T.card,border:`1px solid ${today?"rgba(184,150,90,0.25)":T.border}`,borderRadius:12,padding:"13px 16px",cursor:"pointer",transition:"all .2s"}}
        onMouseEnter={e=>{e.currentTarget.style.borderColor=T.borderHover;e.currentTarget.style.background=T.elevated;}}
        onMouseLeave={e=>{e.currentTarget.style.borderColor=today?"rgba(184,150,90,0.25)":T.border;e.currentTarget.style.background=today?`rgba(184,150,90,0.06)`:T.card;}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:7}}>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:T.text}}>{m.clientName}</div>
            {m.clientPhone&&<div style={{fontSize:11,color:T.textSec,fontFamily:T.mono,marginTop:1}}>{m.clientPhone}</div>}
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
            <span style={{background:sc.bg,color:sc.color,borderRadius:20,padding:"2px 9px",fontSize:10,fontWeight:700}}>{sc.label}</span>
            {today&&<span style={{background:"rgba(184,150,90,0.15)",color:T.gold,borderRadius:6,padding:"1px 7px",fontSize:9,fontWeight:700}}>СЕГОДНЯ</span>}
          </div>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <span style={{fontSize:12,color:T.text,fontWeight:600}}>📅 {formatDate(m.meetDate)}, {m.meetTime}</span>
        </div>
        <div style={{fontSize:11,color:T.textSec,marginTop:4,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span>{m.meetType==="measure"?"📐 Замер":"🏠 Шоурум"} · {m.address}</span>
          {activeTasks.length>0&&(
            <span style={{background:"rgba(184,150,90,0.12)",color:T.gold,borderRadius:6,padding:"1px 7px",fontSize:10,fontWeight:700}}>
              ✅ {activeTasks.length} задач
            </span>
          )}
        </div>
        {m.notes&&<div style={{fontSize:11,color:T.textDim,marginTop:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.notes}</div>}
      </div>
    );
  };

  const MeetDetail = ({m}) => {
    const sc = STATUS_CFG[m.status]||STATUS_CFG.scheduled;
    const waText = generateWAText(m);
    const waUrl = m.clientPhone ? `https://wa.me/${m.clientPhone.replace(/\D/g,"")}?text=${encodeURIComponent(waText)}` : null;
    const [copied, setCopied] = useState(false);
    const [tab, setTab] = useState("info"); // "info" | "tasks"
    const [newTaskText, setNewTaskText] = useState("");
    const [newTaskType, setNewTaskType] = useState("call");
    const [newTaskDate, setNewTaskDate] = useState(m.meetDate||"");
    const [newTaskDateTo, setNewTaskDateTo] = useState("");
    const [newTaskTime, setNewTaskTime] = useState(m.meetTime||"");
    const [taskSaving, setTaskSaving] = useState(false);

    const TTYPES_MEET = [
      {id:"call",    label:"Созвон",  icon:"📞"},
      {id:"measure", label:"Замер",   icon:"📐"},
      {id:"kp",      label:"КП",      icon:"📄"},
      {id:"start",   label:"Монтаж",  icon:"🏗️"},
      {id:"order",   label:"Заказ",   icon:"📦"},
    ];

    const meetTasks = Array.isArray(m.tasks) ? m.tasks : [];
    const activeTasks = meetTasks.filter(t=>!t.done);
    const doneTasks   = meetTasks.filter(t=>t.done);

    function saveTasksToMeeting(tasks) {
      const updated = {...m, tasks, updatedAt: new Date().toISOString()};
      const allUpdated = meetings.map(x=>x.id===m.id ? updated : x);
      setMeetings(allUpdated);
      setSelected(updated);
      try { localStorage.setItem(MEETINGS_KEY, JSON.stringify(allUpdated)); } catch(_) {}
      saveMeeting(updated);
    }

    function addTask() {
      if (!newTaskText.trim()) return;
      setTaskSaving(true);
      const task = {
        id: Date.now().toString(),
        text: newTaskText.trim(),
        type: newTaskType,
        date: newTaskDate || null,
        dateTo: newTaskDateTo || null,
        time: newTaskTime || null,
        done: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveTasksToMeeting([...meetTasks, task]);
      // Уведомление если есть дата+время
      if (task.date && task.time) {
        const cl = clients.find(c=>c.name===m.clientName);
        scheduleNotification(task, m.clientName);
      }
      setNewTaskText(""); setNewTaskDateTo(""); setTaskSaving(false);
    }

    function toggleTask(taskId) {
      const tasks = meetTasks.map(t=>
        t.id===taskId ? {...t, done:!t.done, doneAt:!t.done?new Date().toISOString():null, updatedAt:new Date().toISOString()} : t
      );
      saveTasksToMeeting(tasks);
    }

    function deleteTask(taskId) {
      saveTasksToMeeting(meetTasks.filter(t=>t.id!==taskId));
    }

    const inpS = {background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,padding:"8px 11px",color:T.text,fontSize:12,outline:"none",fontFamily:T.font,colorScheme:"dark",width:"100%",boxSizing:"border-box"};

    return(
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:9999,overflowY:"auto"}}>
        <div style={{minHeight:"100%",display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:T.surface,borderRadius:16,width:"100%",maxWidth:480,fontFamily:T.font}}>

            {/* Header */}
            <div style={{padding:"18px 22px",borderBottom:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:15,fontWeight:700,fontFamily:T.serif}}>📅 Встреча</div>
                <div style={{fontSize:12,color:T.textSec,marginTop:2}}>{m.clientName} {m.clientPhone&&`· ${m.clientPhone}`}</div>
              </div>
              <div style={{display:"flex",gap:7}}>
                <button onClick={()=>{setSelected(null);startEdit(m);}} style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,padding:"5px 11px",cursor:"pointer",fontSize:12,color:T.gold,fontFamily:T.font,fontWeight:600}}>✏️</button>
                <button onClick={()=>setDeleteConfirm(m.id)} style={{background:T.dangerBg,border:"1px solid rgba(196,84,84,0.2)",borderRadius:8,padding:"5px 11px",cursor:"pointer",fontSize:12,color:T.danger,fontFamily:T.font}}>🗑️</button>
                <button onClick={()=>setSelected(null)} style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,color:T.textSec}}>✕</button>
              </div>
            </div>

            {/* Tabs */}
            <div style={{display:"flex",borderBottom:`1px solid ${T.border}`}}>
              {[["info","📋 Детали"],["tasks",`✅ Задачи${meetTasks.length>0?" ("+meetTasks.length+")":""}`]].map(([id,label])=>(
                <button key={id} onClick={()=>setTab(id)}
                  style={{flex:1,background:"none",border:"none",borderBottom:`2px solid ${tab===id?T.gold:"transparent"}`,
                    padding:"11px 8px",color:tab===id?T.gold:T.textSec,fontWeight:tab===id?700:400,
                    fontSize:13,cursor:"pointer",fontFamily:T.font,transition:"all 0.15s",
                    WebkitTapHighlightColor:"transparent"}}>
                  {label}
                  {id==="tasks"&&activeTasks.length>0&&(
                    <span style={{marginLeft:6,background:T.gold,color:"#09090b",borderRadius:10,
                      padding:"1px 6px",fontSize:10,fontWeight:800}}>{activeTasks.length}</span>
                  )}
                </button>
              ))}
            </div>

            <div style={{padding:"18px 22px",display:"flex",flexDirection:"column",gap:12,maxHeight:"70vh",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>

              {/* ── Вкладка Детали ── */}
              {tab==="info"&&(<>
                {/* Статус */}
                <div>
                  <div style={{fontSize:10,color:T.textSec,fontWeight:600,letterSpacing:1,marginBottom:7,textTransform:"uppercase"}}>Статус</div>
                  <div style={{display:"flex",gap:6}}>
                    {Object.entries(STATUS_CFG).map(([k,v])=>(
                      <button key={k} onClick={()=>updateStatus(m.id,k)}
                        style={{background:m.status===k?v.bg:T.elevated,color:m.status===k?v.color:T.textSec,border:`1px solid ${m.status===k?v.color:T.border}`,borderRadius:8,padding:"5px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:T.font,WebkitTapHighlightColor:"transparent"}}>
                        {v.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Детали */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {[
                    ["📅 Дата", formatDate(m.meetDate)],
                    ["🕐 Время", m.meetTime],
                    ["🏠 Тип", m.meetType==="measure"?"Замер на объекте":"Шоурум"],
                    ["📍 Адрес", m.address],
                  ].map(([label,val])=>val&&(
                    <div key={label} style={{background:T.card,borderRadius:9,padding:"10px 12px",border:`1px solid ${T.border}`,gridColumn:label==="📍 Адрес"?"1/-1":"auto"}}>
                      <div style={{fontSize:9,color:T.textSec,marginBottom:3,fontWeight:600}}>{label}</div>
                      <div style={{fontSize:13,fontWeight:500}}>{val}</div>
                    </div>
                  ))}
                </div>

                {m.notes&&(
                  <div style={{background:T.card,borderRadius:9,padding:"10px 12px",border:`1px solid ${T.border}`}}>
                    <div style={{fontSize:9,color:T.textSec,marginBottom:3,fontWeight:600}}>📝 ЗАМЕТКИ</div>
                    <div style={{fontSize:13}}>{m.notes}</div>
                  </div>
                )}

                {/* Подтверждение клиенту */}
                <div style={{background:T.card,borderRadius:10,padding:"12px 14px",border:`1px solid ${T.border}`,fontSize:12,lineHeight:1.7,whiteSpace:"pre-wrap",color:T.text}}>
                  {waText}
                </div>

                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{navigator.clipboard?.writeText(waText).catch(()=>{});setCopied(true);setTimeout(()=>setCopied(false),2500);}}
                    style={{flex:1,background:copied?"rgba(90,154,106,0.15)":T.elevated,color:copied?T.green:T.text,border:`1px solid ${copied?"rgba(90,154,106,0.3)":T.border}`,borderRadius:10,padding:"10px",fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:T.font}}>
                    {copied?"✓ Скопировано":"📋 Копировать"}
                  </button>
                  {waUrl&&(
                    <a href={waUrl} target="_blank" rel="noreferrer"
                      style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:"rgba(90,154,106,0.1)",color:T.green,border:"1px solid rgba(90,154,106,0.25)",borderRadius:10,padding:"10px",fontWeight:600,fontSize:13,textDecoration:"none",fontFamily:T.font}}>
                      💬 WhatsApp
                    </a>
                  )}
                </div>
              </>)}

              {/* ── Вкладка Задачи ── */}
              {tab==="tasks"&&(<>

                {/* Форма добавления задачи */}
                <div style={{background:"rgba(184,150,90,0.05)",border:"1px solid rgba(184,150,90,0.15)",borderRadius:12,padding:"13px 14px"}}>
                  <div style={{fontSize:11,color:T.gold,fontWeight:700,letterSpacing:1,marginBottom:10,textTransform:"uppercase"}}>+ Новая задача</div>

                  {/* Тип */}
                  <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:10}}>
                    {TTYPES_MEET.map(t=>(
                      <button key={t.id} onClick={()=>setNewTaskType(t.id)}
                        style={{padding:"5px 10px",borderRadius:7,border:`1px solid ${newTaskType===t.id?T.gold:T.border}`,
                          background:newTaskType===t.id?"rgba(184,150,90,0.12)":"rgba(255,255,255,0.02)",
                          color:newTaskType===t.id?T.gold:T.textSec,cursor:"pointer",fontSize:11,
                          fontFamily:T.font,fontWeight:newTaskType===t.id?700:400,
                          WebkitTapHighlightColor:"transparent",touchAction:"manipulation"}}>
                        {t.icon} {t.label}
                      </button>
                    ))}
                  </div>

                  {/* Текст */}
                  <input value={newTaskText} onChange={e=>setNewTaskText(e.target.value)}
                    onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&addTask()}
                    placeholder="Описание задачи..."
                    style={{...inpS, marginBottom:8}}/>

                  {/* Даты */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 80px",gap:6,marginBottom:10}}>
                    <div>
                      <div style={{fontSize:9,color:T.textDim,marginBottom:3,fontWeight:600}}>ОТ</div>
                      <input type="date" value={newTaskDate} onChange={e=>setNewTaskDate(e.target.value)} style={inpS}/>
                    </div>
                    <div>
                      <div style={{fontSize:9,color:T.textDim,marginBottom:3,fontWeight:600}}>ДО</div>
                      <input type="date" value={newTaskDateTo} min={newTaskDate||undefined} onChange={e=>setNewTaskDateTo(e.target.value)} style={inpS}/>
                    </div>
                    <div>
                      <div style={{fontSize:9,color:T.textDim,marginBottom:3,fontWeight:600}}>ВРЕМЯ</div>
                      <input type="time" value={newTaskTime} onChange={e=>setNewTaskTime(e.target.value)} style={inpS}/>
                    </div>
                  </div>

                  <button onClick={addTask} disabled={!newTaskText.trim()||taskSaving}
                    style={{width:"100%",padding:"10px",background:newTaskText.trim()?T.gold:"rgba(255,255,255,0.06)",
                      color:newTaskText.trim()?"#09090b":T.textDim,border:"none",borderRadius:9,
                      fontWeight:700,fontSize:13,cursor:newTaskText.trim()?"pointer":"not-allowed",
                      fontFamily:T.font,WebkitTapHighlightColor:"transparent"}}>
                    {taskSaving?"Сохранение...":"✅ Добавить задачу"}
                  </button>
                </div>

                {/* Активные задачи */}
                {activeTasks.length>0&&(
                  <div>
                    <div style={{fontSize:10,color:T.textSec,fontWeight:700,letterSpacing:1,marginBottom:8,textTransform:"uppercase"}}>
                      В работе ({activeTasks.length})
                    </div>
                    {activeTasks.map(t=>{
                      const TI={call:"📞",measure:"📐",kp:"📄",start:"🏗️",order:"📦"};
                      const due = t.date ? new Date(t.date+"T"+(t.time||"23:59")) : null;
                      const overdue = due && due < new Date() && !t.dateTo;
                      const overdueRange = t.dateTo && new Date(t.dateTo+"T23:59") < new Date();
                      const isOverdue = overdue || overdueRange;
                      return(
                        <div key={t.id} style={{display:"flex",gap:10,alignItems:"flex-start",
                          background:T.card,borderRadius:10,padding:"11px 12px",marginBottom:6,
                          border:`1px solid ${isOverdue?"rgba(248,113,113,0.3)":T.border}`,
                          borderLeft:`3px solid ${isOverdue?"#f87171":T.gold}`}}>
                          <button onClick={()=>toggleTask(t.id)}
                            style={{width:20,height:20,borderRadius:"50%",border:`2px solid ${T.border}`,
                              background:"transparent",cursor:"pointer",flexShrink:0,marginTop:1,
                              display:"flex",alignItems:"center",justifyContent:"center",
                              WebkitTapHighlightColor:"transparent",touchAction:"manipulation"}}>
                          </button>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:13,color:T.text,fontWeight:500,marginBottom:3}}>
                              <span style={{fontSize:12,marginRight:4}}>{TI[t.type]||"📋"}</span>{t.text}
                            </div>
                            {(t.date||t.dateTo||t.time)&&(
                              <div style={{fontSize:11,color:isOverdue?"#f87171":T.textDim,display:"flex",gap:5,flexWrap:"wrap"}}>
                                {t.date&&<span>{isOverdue?"⚠ ":"📅 "}{new Date(t.date+"T12:00").toLocaleDateString("ru-RU",{day:"2-digit",month:"2-digit"})}</span>}
                                {t.dateTo&&<span>→ {new Date(t.dateTo+"T12:00").toLocaleDateString("ru-RU",{day:"2-digit",month:"2-digit"})}</span>}
                                {t.time&&<span>🕐 {t.time}</span>}
                              </div>
                            )}
                          </div>
                          <button onClick={()=>deleteTask(t.id)}
                            style={{background:"none",border:"none",color:T.textDim,cursor:"pointer",
                              fontSize:15,padding:"0 2px",flexShrink:0,
                              WebkitTapHighlightColor:"transparent"}}>✕</button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Выполненные задачи */}
                {doneTasks.length>0&&(
                  <div>
                    <div style={{fontSize:10,color:T.textDim,fontWeight:700,letterSpacing:1,marginBottom:8,textTransform:"uppercase"}}>
                      Выполнено ({doneTasks.length})
                    </div>
                    {doneTasks.map(t=>{
                      const TI={call:"📞",measure:"📐",kp:"📄",start:"🏗️",order:"📦"};
                      return(
                        <div key={t.id} style={{display:"flex",gap:10,alignItems:"center",
                          background:"rgba(5,150,105,0.04)",borderRadius:10,padding:"9px 12px",marginBottom:5,
                          border:"1px solid rgba(5,150,105,0.15)",borderLeft:"3px solid #059669",opacity:0.7}}>
                          <button onClick={()=>toggleTask(t.id)}
                            style={{width:20,height:20,borderRadius:"50%",border:"2px solid #059669",
                              background:"rgba(5,150,105,0.2)",cursor:"pointer",flexShrink:0,
                              display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#34d399",
                              WebkitTapHighlightColor:"transparent"}}>✓</button>
                          <div style={{flex:1,fontSize:12,color:T.textDim,textDecoration:"line-through"}}>
                            {TI[t.type]||"📋"} {t.text}
                          </div>
                          <button onClick={()=>deleteTask(t.id)}
                            style={{background:"none",border:"none",color:T.textDim,cursor:"pointer",fontSize:14,
                              WebkitTapHighlightColor:"transparent"}}>✕</button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {meetTasks.length===0&&(
                  <div style={{textAlign:"center",padding:"28px 0",color:T.textDim,fontSize:13}}>
                    Нет задач. Добавьте первую ↑
                  </div>
                )}
              </>)}

            </div>
          </div>
        </div>
      </div>
    );
  };

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10,marginBottom:20}}>
        <div>
          {!isMobile&&<div style={{fontSize:11,color:T.textSec,letterSpacing:2,marginBottom:4,fontWeight:600}}>РАСПИСАНИЕ</div>}
          <div style={{fontSize:isMobile?20:26,fontWeight:800,fontFamily:T.serif}}>
            Встречи 📅
            {todayCount>0&&<span style={{marginLeft:10,background:"rgba(184,150,90,0.15)",color:T.gold,borderRadius:8,padding:"2px 9px",fontSize:13,fontWeight:700,fontFamily:T.font}}>{todayCount} сегодня</span>}
          </div>
        </div>
        <Btn variant="primary" onClick={()=>{resetForm();setShowForm(true);}}>+ Записать встречу</Btn>
      </div>

      {/* Фильтры */}
      <div style={{display:"flex",gap:5,marginBottom:14}}>
        {[["upcoming",`Предстоящие (${upcomingCount})`],["today",`Сегодня (${todayCount})`],["past","Прошедшие"]].map(([k,label])=>(
          <button key={k} onClick={()=>setFilter(k)}
            style={{background:filter===k?T.goldBg:"rgba(255,255,255,0.03)",color:filter===k?T.gold:T.textSec,border:`1px solid ${filter===k?"rgba(184,150,90,0.2)":T.border}`,borderRadius:20,padding:"5px 13px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:T.font,transition:"all .2s"}}>
            {label}
          </button>
        ))}
      </div>

      {filtered.length===0&&(
        <div style={{textAlign:"center",padding:60}}>
          <div style={{fontSize:40,marginBottom:14}}>📅</div>
          <div style={{fontSize:16,fontWeight:700,fontFamily:T.serif,marginBottom:8}}>
            {filter==="upcoming"?"Предстоящих встреч нет":filter==="today"?"Сегодня встреч нет":"Прошедших встреч нет"}
          </div>
          <div style={{fontSize:13,color:T.textSec,marginBottom:20}}>Записывайте визиты в шоурум и замеры</div>
          <Btn variant="primary" onClick={()=>setShowForm(true)}>+ Записать встречу</Btn>
        </div>
      )}

      <div style={{display:"flex",flexDirection:"column",gap:8,paddingBottom:isMobile?100:0}}>
        {filtered.map(m=><MeetCard key={m.id} m={m}/>)}
      </div>

      {/* Форма */}
      {showForm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:9999,overflowY:"auto"}}>
          <div style={{minHeight:"100%",display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
            <div style={{background:T.surface,borderRadius:16,width:"100%",maxWidth:480,padding:"22px 24px",fontFamily:T.font}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
                <div style={{fontSize:16,fontWeight:700,fontFamily:T.serif}}>{editId?"✏️ Редактировать":"📅 Новая встреча"}</div>
                <button onClick={resetForm} style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,color:T.textSec}}>✕</button>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:13}}>
                {/* Клиент из CRM */}
                <div>
                  <div style={{fontSize:10,color:T.textSec,marginBottom:4,fontWeight:600,textTransform:"uppercase",letterSpacing:1}}>Клиент *</div>
                  <div style={{position:"relative"}}>
                    <Inp value={clientName} onChange={e=>{setClientName(e.target.value);}} placeholder="Имя клиента" autoFocus/>
                    {clientName.length>0&&clients.filter(c=>c.name?.toLowerCase().includes(clientName.toLowerCase())).slice(0,4).length>0&&!clients.find(c=>c.name===clientName)&&(
                      <div style={{position:"absolute",top:"100%",left:0,right:0,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,zIndex:100,overflow:"hidden",marginTop:2}}>
                        {clients.filter(c=>c.name?.toLowerCase().includes(clientName.toLowerCase())).slice(0,4).map(c=>(
                          <button key={c.id} onClick={()=>{setClientName(c.name);setClientPhone(c.phone||"");}}
                            style={{width:"100%",background:"none",border:"none",padding:"9px 13px",cursor:"pointer",textAlign:"left",fontSize:13,color:T.text,fontFamily:T.font,display:"flex",justifyContent:"space-between",borderBottom:`1px solid ${T.border}`}}
                            onMouseEnter={e=>e.currentTarget.style.background=T.elevated}
                            onMouseLeave={e=>e.currentTarget.style.background="none"}>
                            <span>{c.name}</span>
                            <span style={{fontSize:11,color:T.textSec}}>{c.phone}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <div style={{fontSize:10,color:T.textSec,marginBottom:4,fontWeight:600,textTransform:"uppercase",letterSpacing:1}}>Телефон</div>
                  <Inp value={clientPhone} onChange={e=>setClientPhone(e.target.value)} placeholder="+7 777..." type="tel"/>
                </div>

                {/* Тип */}
                <div>
                  <div style={{fontSize:10,color:T.textSec,marginBottom:8,fontWeight:600,textTransform:"uppercase",letterSpacing:1}}>Тип встречи</div>
                  <div style={{display:"flex",gap:8}}>
                    {[["measure","📐 Замер на объекте"],["showroom","🏠 Шоурум"]].map(([k,label])=>(
                      <button key={k} onClick={()=>setMeetType(k)}
                        style={{flex:1,background:meetType===k?T.goldBg:T.elevated,color:meetType===k?T.gold:T.textSec,border:`1px solid ${meetType===k?"rgba(184,150,90,0.3)":T.border}`,borderRadius:10,padding:"10px",fontSize:13,fontWeight:meetType===k?700:400,cursor:"pointer",fontFamily:T.font}}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {meetType==="showroom"&&(
                    <div style={{marginTop:7,fontSize:11,color:T.textSec,background:T.card,borderRadius:8,padding:"7px 11px",border:`1px solid ${T.border}`}}>
                      📍 {SHOWROOM_ADDR} · 9:00–22:00
                    </div>
                  )}
                </div>

                {/* Дата и время */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div>
                    <div style={{fontSize:10,color:T.textSec,marginBottom:4,fontWeight:600,textTransform:"uppercase",letterSpacing:1}}>Дата *</div>
                    <Inp type="date" value={meetDate} onChange={e=>setMeetDate(e.target.value)}/>
                  </div>
                  <div>
                    <div style={{fontSize:10,color:T.textSec,marginBottom:4,fontWeight:600,textTransform:"uppercase",letterSpacing:1}}>Время *</div>
                    <Inp type="time" value={meetTime} onChange={e=>setMeetTime(e.target.value)} min="09:00" max="22:00"/>
                  </div>
                </div>

                {/* Адрес для замера */}
                {meetType==="measure"&&(
                  <div>
                    <div style={{fontSize:10,color:T.textSec,marginBottom:4,fontWeight:600,textTransform:"uppercase",letterSpacing:1}}>Адрес объекта</div>
                    <Inp value={address} onChange={e=>setAddress(e.target.value)} placeholder="Алматы, ул. ..."/>
                  </div>
                )}

                {/* Статус */}
                {editId&&(
                  <div>
                    <div style={{fontSize:10,color:T.textSec,marginBottom:7,fontWeight:600,textTransform:"uppercase",letterSpacing:1}}>Статус</div>
                    <div style={{display:"flex",gap:6}}>
                      {Object.entries(STATUS_CFG).map(([k,v])=>(
                        <button key={k} onClick={()=>setStatus(k)}
                          style={{flex:1,background:status===k?v.bg:T.elevated,color:status===k?v.color:T.textSec,border:`1px solid ${status===k?v.color:T.border}`,borderRadius:8,padding:"6px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:T.font}}>
                          {v.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div style={{fontSize:10,color:T.textSec,marginBottom:4,fontWeight:600,textTransform:"uppercase",letterSpacing:1}}>Заметки</div>
                  <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Что интересует клиент…"
                    style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 13px",color:T.text,fontSize:13,width:"100%",outline:"none",minHeight:60,resize:"vertical",fontFamily:T.font}}/>
                </div>

                {!editId&&<div style={{fontSize:11,color:T.textSec,background:T.card,borderRadius:8,padding:"7px 11px",border:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:6}}>
                  <span>📨</span> При сохранении придёт уведомление в Telegram группу IGS
                </div>}
                <button onClick={handleSave} disabled={!clientName.trim()||!meetDate||!meetTime}
                  style={{background:clientName.trim()&&meetDate&&meetTime?T.gold:"rgba(255,255,255,0.1)",color:clientName.trim()&&meetDate&&meetTime?"#0a0a0b":T.textDim,border:"none",borderRadius:10,padding:"13px",fontWeight:700,fontSize:14,cursor:clientName.trim()&&meetDate&&meetTime?"pointer":"not-allowed",fontFamily:T.font}}>
                  {editId?"💾 Сохранить":"📅 Записать встречу"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {selected&&<MeetDetail m={selected}/>}
      {deleteConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:T.surface,borderRadius:16,padding:"24px",maxWidth:340,width:"100%",fontFamily:T.font,textAlign:"center"}}>
            <div style={{fontSize:30,marginBottom:12}}>🗑️</div>
            <div style={{fontSize:15,fontWeight:700,marginBottom:8}}>Удалить встречу?</div>
            <div style={{fontSize:12,color:T.textSec,marginBottom:20}}>Встреча будет перемещена в корзину Firebase.</div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>handleDelete(deleteConfirm)} style={{flex:1,background:T.dangerBg,color:T.danger,border:"1px solid rgba(196,84,84,0.25)",borderRadius:10,padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:T.font}}>Удалить</button>
              <button onClick={()=>setDeleteConfirm(null)} style={{flex:1,background:T.elevated,color:T.text,border:`1px solid ${T.border}`,borderRadius:10,padding:"11px",fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:T.font}}>Отмена</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ─── GLASS CALCULATOR (Калькулятор стекла Orizzonte) ─────────────────────────
const GLASS_STORAGE_KEY = "igs_glass_calcs_v1";

function loadGlassCalcs(){try{const r=JSON.parse(localStorage.getItem(GLASS_STORAGE_KEY)||"null");if(Array.isArray(r))return r;}catch(_){}return[];}

function saveGlassCalc(c){
  try{
    const all = loadGlassCalcs();
    const updated = all.find(x=>x.id===c.id) ? all.map(x=>x.id===c.id?c:x) : [c,...all];
    localStorage.setItem(GLASS_STORAGE_KEY, JSON.stringify(updated));
  }catch(_){}
  if(c.id) dbSet(`glass_calcs/${c.id}`, c);
}
function deleteGlassCalcFb(id){
  try{
    const all = loadGlassCalcs().filter(x=>x.id!==id);
    localStorage.setItem(GLASS_STORAGE_KEY, JSON.stringify(all));
  }catch(_){}
  dbSet(`glass_calcs/${id}`, null);
}

// Формулы из файлов Orizzonte
function calcGlass(W, H, N, openFromCenter=false) {
  if(!W||!H||!N) return null;
  let glassW, glassH;
  if(openFromCenter) {
    // Открывание от центра (формула из правой части файла)
    glassW = (W - 15.4*2 + 8.6*(N-2) - 11.5) / N;
  } else {
    // Стандартное (формула из левой части файла)
    glassW = (W - 15.4*2 + 8.6*(N-1)) / N;
  }
  glassH = H - 73;
  return { glassW: Math.round(glassW*100)/100, glassH: Math.round(glassH), count: N };
}

// Раскрой профиля — точные формулы из файлов Orizzonte
// Проверено: N=4 W=2940 H=2221 и N=5 W=3580 H=2215
function calcProfile(W, H, N) {
  if(!W||!H||!N) return null;
  const isEven = N % 2 === 0;

  // Нижний профиль створки: (W - 15.4*2 + 8.6*(N-1)) / N
  const profileLen = Math.round(((W - 15.4*2 + 8.6*(N-1))/N)*100)/100;
  // Боковой профиль рамы: H - 47
  const sideFrameLen = Math.round(H - 47);
  // Боковой профиль створки: H - 103
  const sideSashLen = Math.round(H - 103);
  // Кол-во боковых профилей створки: N*2 - 2
  const sideSashQty = N * 2 - 2;

  // Кол-во профилей на 6м штанге: ROUNDUP(qty / ROUNDDOWN(6000/len))
  // ROUNDDOWN(6000/len, 1 знак) как в Excel, затем ROUNDUP(qty/result)
  const pcs = (len, qty) => { if(!qty||!len) return 0; const perBar = Math.floor(6000/len*10)/10; return perBar>0 ? Math.ceil(qty/perBar) : qty; };

  const profiles = [
    { name:"Нижний направляющий профиль 2 полосы",      len:W, qty: isEven?2:1, pcs: pcs(W, isEven?2:1) },
    { name:"Нижний направляющий профиль 3 полосы",      len:W, qty: isEven?0:1, pcs: pcs(W, isEven?0:1) },
    { name:"Верхний направляющий профиль рамы 2 полосы",len:W, qty: isEven?2:1, pcs: pcs(W, isEven?2:1) },
    { name:"Верхний направляющий профиль рамы 3 полосы",len:W, qty: isEven?0:1, pcs: pcs(W, isEven?0:1) },
    { name:"Алюминиевый рельс",                         len:W, qty: N,          pcs: pcs(W, N) },
    { name:"Нижний профиль створки под стекло 10 мм",   len:profileLen,  qty:N, pcs: pcs(profileLen, N) },
    { name:"Боковой профиль рамы",                      len:sideFrameLen,qty:2, pcs: pcs(sideFrameLen, 2) },
    { name:"Боковой профиль створки",                   len:sideSashLen, qty:sideSashQty, pcs: pcs(sideSashLen, sideSashQty) },
  ].filter(p=>p.qty>0);

  // Аксессуары — точно из файлов
  const accessories = [
    { name:"Алюминиевая конечная заглушка", qty:2 },
    { name:"Межстворочная заглушка",        qty: N*2-2 },
    { name:"Верхний ролик",                 qty: N*2 },
    { name:"Фетровый уплотнитель 5мм",      len:sideSashLen, qty: sideSashQty, note:"по боковым профилям створки" },
    { name:"Фетровый уплотнитель 7мм",      qty:12, note:"по направляющим (12 кусков)" },
    { name:"Ручка",                          qty:2 },
    { name:"Нижний ролик",                  qty: N*2 },
  ];

  // Итого профилей
  const totalPcs = profiles.reduce((s,p)=>s+p.pcs,0);

  return { profiles, accessories, totalPcs, totalQty: profiles.reduce((s,p)=>s+p.qty,0) };
}

// Рекомендация по количеству створок
function recommendSashes(W) {
  if(W <= 1800) return [2];
  if(W <= 2500) return [3,4];
  if(W <= 3500) return [4,5];
  if(W <= 4500) return [5,6];
  return [6,7,8];
}

function generateWhatsAppText(calc, phone) {
  const g = calc.glass;
  const lines = [
    `Ассаламуалейкум, это Жандильда — IGS Outdoor 🌿`,
    ``,
    `По вашему остеклению *Слайдинг (Orizzonte)*:`,
    ``,
    `📐 *Проём:* ${calc.width} × ${calc.height} мм`,
    `🔢 *Створок:* ${calc.sashes} шт`,
    ``,
    `🪟 *Размер стекла:* ${g.glassW} × ${g.glassH} мм`,
    `📦 *Количество:* ${g.count} шт`,
    `⚙️ *Тип:* под стекло 10 мм`,
    ``,
    `Пожалуйста, при заказе укажите эти размеры стекольщику.`,
    `Если есть вопросы — обращайтесь! 🙏`,
  ];
  return lines.join("\n");
}

function GlassCalc({isMobile}) {
  const [calcs, setCalcs] = useState(()=>loadGlassCalcs());
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [selected, setSelected] = useState(null);
  const [copied, setCopied] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  // Форма
  const [width, setWidth] = useState("");
  const [ral, setRal] = useState("");
  const [height, setHeight] = useState("");
  const [sashes, setSashes] = useState("");
  const [openCenter, setOpenCenter] = useState(false);
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [notes, setNotes] = useState("");

  const glassSubsRef   = useRef(new Map());

  function subscribeGlassCalc(id) {
    if (glassSubsRef.current.has(id)) return;
    const unsub = dbListen(`glass_calcs/${id}`, (remote) => {
      if (!remote || !remote.id) return;
      setCalcs(prev => {
        if (remote.deleted) {
          const updated = prev.filter(c => c.id !== id);
          try { localStorage.setItem(GLASS_STORAGE_KEY, JSON.stringify(updated)); } catch(_) {}
          return updated;
        }
        const local = prev.find(c => c.id === id);
        if (!local) {
          const updated = [remote, ...prev].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
          try { localStorage.setItem(GLASS_STORAGE_KEY, JSON.stringify(updated)); } catch(_) {}
          return updated;
        }
        const localTs  = new Date(local.updatedAt  || local.createdAt  || 0).getTime();
        const remoteTs = new Date(remote.updatedAt || remote.createdAt || 0).getTime();
        // Локальная >= удалённой — эхо или мы актуальнее
        if (localTs >= remoteTs) return prev;
        // Удалённая новее — применяем
        const updated = prev.map(c => c.id === id ? remote : c)
          .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
        try { localStorage.setItem(GLASS_STORAGE_KEY, JSON.stringify(updated)); } catch(_) {}
        return updated;
      });
    });
    glassSubsRef.current.set(id, unsub);
  }

  // Синхронизация с Firebase — per-item
  useEffect(()=>{
    dbGet("glass_calcs").then(data=>{
      if(data && typeof data==="object") {
        const arr = Object.values(data).filter(c=>c&&!c.deleted)
          .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
        setCalcs(arr);
        localStorage.setItem(GLASS_STORAGE_KEY, JSON.stringify(arr));
        arr.forEach(c => subscribeGlassCalc(c.id));
      }
    });
    return () => {
      glassSubsRef.current.forEach(unsub => unsub());
      glassSubsRef.current.clear();
    };
  },[]);

  const W = parseFloat(width), H = parseFloat(height), N = parseInt(sashes);
  const glass = W&&H&&N ? calcGlass(W,H,N,openCenter) : null;
  const profile = W&&H&&N ? calcProfile(W,H,N) : null;
  const recommended = W ? recommendSashes(W) : [];

  function resetForm() {
    setWidth(""); setHeight(""); setSashes(""); setOpenCenter(false);
    setClientName(""); setClientPhone(""); setNotes(""); setRal("");
    setEditId(null); setShowForm(false);
  }

  function handleSave() {
    if(!W||!H||!N||!glass) return;
    const now = new Date().toISOString();
    const calc = {
      id: editId || Date.now().toString(),
      width:W, height:H, sashes:N, openCenter, ral: ral.trim(),
      glass, profile,
      clientName: clientName.trim(),
      clientPhone: clientPhone.trim().replace(/[^\d+\-()\s]/g,""),
      notes: notes.trim(),
      createdAt: editId ? (calcs.find(c=>c.id===editId)?.createdAt||now) : now,
      updatedAt: now,
    };
    if(editId) dbSet(`glass_calcs_backup/${editId}_${Date.now()}`, calcs.find(c=>c.id===editId)||{});
    const updated = editId ? calcs.map(c=>c.id===editId?calc:c) : [calc,...calcs];
    setCalcs(updated);
    saveGlassCalc(calc);
    if (!editId) subscribeGlassCalc(calc.id);
    resetForm();
  }

  function startEdit(calc) {
    setWidth(String(calc.width)); setHeight(String(calc.height));
    setSashes(String(calc.sashes)); setOpenCenter(calc.openCenter||false);
    setClientName(calc.clientName||""); setClientPhone(calc.clientPhone||"");
    setNotes(calc.notes||""); setRal(calc.ral||""); setEditId(calc.id);
    setSelected(null); setShowForm(true);
  }

  function handleDelete(id) {
    const calc = calcs.find(c=>c.id===id);
    if(calc) dbSet(`glass_calcs_trash/${id}`, {...calc, deletedAt:new Date().toISOString()});
    deleteGlassCalcFb(id);
    const unsub = glassSubsRef.current.get(id);
    if(unsub){ unsub(); glassSubsRef.current.delete(id); }
    setCalcs(calcs.filter(c=>c.id!==id));
    setSelected(null); setDeleteConfirm(null);
  }

  function copyWA(calc) {
    const text = generateWhatsAppText(calc);
    navigator.clipboard?.writeText(text).catch(()=>{});
    setCopied(calc.id); setTimeout(()=>setCopied(null),2500);
  }

  const fmtDate = iso => iso ? new Date(iso).toLocaleDateString("ru-KZ",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}) : "—";

  // ── ФОРМА РАСЧЁТА ──────────────────────────────────────────────────────────
  const CalcForm = () => (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:9999,overflowY:"auto"}}>
      <div style={{minHeight:"100%",display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
        <div style={{background:T.surface,borderRadius:16,width:"100%",maxWidth:520,padding:"22px 24px",fontFamily:T.font}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
            <div style={{fontSize:16,fontWeight:700,fontFamily:T.serif}}>{editId?"✏️ Редактировать":"🪟 Новый расчёт стекла"}</div>
            <button onClick={resetForm} style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,color:T.textSec}}>✕</button>
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:13}}>
            {/* Клиент */}
            <div style={{background:T.card,borderRadius:10,padding:"12px 14px",border:`1px solid ${T.border}`}}>
              <div style={{fontSize:10,color:T.textSec,fontWeight:600,letterSpacing:1,marginBottom:8,textTransform:"uppercase"}}>Клиент (необязательно)</div>
              <div style={{display:"flex",gap:8}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,color:T.textSec,marginBottom:4}}>Имя</div>
                  <Inp value={clientName} onChange={e=>setClientName(e.target.value)} placeholder="Имя клиента"/>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,color:T.textSec,marginBottom:4}}>Телефон WhatsApp</div>
                  <Inp value={clientPhone} onChange={e=>setClientPhone(e.target.value)} placeholder="+7 777 000 00 00" type="tel"/>
                </div>
              </div>
            </div>

            {/* Габариты */}
            <div>
              <div style={{fontSize:10,color:T.textSec,fontWeight:600,letterSpacing:1,marginBottom:8,textTransform:"uppercase"}}>Габариты проёма (мм)</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                <div>
                  <div style={{fontSize:10,color:T.textSec,marginBottom:4}}>Ширина (W)</div>
                  <Inp type="number" value={width} onChange={e=>setWidth(e.target.value)} placeholder="2495" inputMode="numeric"/>
                </div>
                <div>
                  <div style={{fontSize:10,color:T.textSec,marginBottom:4}}>Высота (H)</div>
                  <Inp type="number" value={height} onChange={e=>setHeight(e.target.value)} placeholder="2335" inputMode="numeric"/>
                </div>
              </div>
            </div>

            {/* Рекомендация по створкам */}
            {recommended.length>0&&(
              <div>
                <div style={{fontSize:10,color:T.textSec,marginBottom:6}}>Рекомендуем для ширины {W} мм:</div>
                <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  {recommended.map(n=>(
                    <button key={n} onClick={()=>setSashes(String(n))}
                      style={{background:parseInt(sashes)===n?T.goldBg:T.elevated,color:parseInt(sashes)===n?T.gold:T.textSec,border:`1px solid ${parseInt(sashes)===n?"rgba(184,150,90,0.3)":T.border}`,borderRadius:8,padding:"5px 14px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:T.font}}>
                      {n} створок
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Количество створок */}
            <div>
              <div style={{fontSize:10,color:T.textSec,marginBottom:4,textTransform:"uppercase",fontWeight:600,letterSpacing:1}}>Количество створок</div>
              <Inp type="number" value={sashes} onChange={e=>setSashes(e.target.value)} placeholder="4" min="2" max="10" inputMode="numeric"/>
            </div>

            {/* Тип открывания */}
            <button onClick={()=>setOpenCenter(!openCenter)}
              style={{display:"flex",alignItems:"center",gap:10,background:openCenter?T.goldBg:T.elevated,border:`1px solid ${openCenter?"rgba(184,150,90,0.3)":T.border}`,borderRadius:10,padding:"10px 13px",cursor:"pointer",textAlign:"left",transition:"all .15s",fontFamily:T.font}}>
              <div style={{width:18,height:18,borderRadius:9,border:`2px solid ${openCenter?T.gold:T.border}`,background:openCenter?T.gold:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {openCenter&&<span style={{color:"#0a0a0b",fontSize:10,fontWeight:800}}>✓</span>}
              </div>
              <div>
                <div style={{fontSize:13,color:T.text,fontWeight:500}}>Открывание от центра</div>
                <div style={{fontSize:10,color:T.textSec,marginTop:1}}>Для чётного числа створок с центральным разъёмом</div>
              </div>
            </button>

            {/* Предпросмотр результата */}
            {glass&&(
              <div style={{background:"rgba(184,150,90,0.06)",border:"1px solid rgba(184,150,90,0.2)",borderRadius:12,padding:14}}>
                <div style={{fontSize:10,color:T.textSec,fontWeight:600,letterSpacing:1,marginBottom:10,textTransform:"uppercase"}}>Предварительный расчёт</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div style={{background:T.card,borderRadius:9,padding:"10px 12px",border:`1px solid ${T.border}`}}>
                    <div style={{fontSize:9,color:T.textSec,marginBottom:3}}>ШИРИНА СТЕКЛА</div>
                    <div style={{fontSize:18,fontWeight:700,color:T.gold,fontFamily:T.mono}}>{glass.glassW} <span style={{fontSize:11,color:T.textSec}}>мм</span></div>
                  </div>
                  <div style={{background:T.card,borderRadius:9,padding:"10px 12px",border:`1px solid ${T.border}`}}>
                    <div style={{fontSize:9,color:T.textSec,marginBottom:3}}>ВЫСОТА СТЕКЛА</div>
                    <div style={{fontSize:18,fontWeight:700,color:T.gold,fontFamily:T.mono}}>{glass.glassH} <span style={{fontSize:11,color:T.textSec}}>мм</span></div>
                  </div>
                </div>
                <div style={{marginTop:8,fontSize:12,color:T.textSec,display:"flex",gap:12}}>
                  <span>📦 Количество: <b style={{color:T.text}}>{glass.count} шт</b></span>
                  <span>⚙️ Под стекло 10 мм</span>
                </div>
              </div>
            )}

            <div>
              <div style={{fontSize:10,color:T.textSec,marginBottom:4,textTransform:"uppercase",fontWeight:600,letterSpacing:1}}>Цвет RAL (необязательно)</div>
              <Inp value={ral} onChange={e=>setRal(e.target.value)} placeholder="Например: RAL 9005, RAL 7016, Белый..."/>
            </div>
            <div>
              <div style={{fontSize:10,color:T.textSec,marginBottom:4,textTransform:"uppercase",fontWeight:600,letterSpacing:1}}>Заметки</div>
              <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Дополнительная информация…"
                style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 13px",color:T.text,fontSize:13,width:"100%",outline:"none",minHeight:60,resize:"vertical",fontFamily:T.font}}/>
            </div>

            <button onClick={handleSave} disabled={!glass}
              style={{background:glass?T.gold:"rgba(255,255,255,0.1)",color:glass?"#0a0a0b":T.textDim,border:"none",borderRadius:10,padding:"13px",fontWeight:700,fontSize:14,cursor:glass?"pointer":"not-allowed",fontFamily:T.font,transition:"all .2s"}}>
              {editId?"💾 Сохранить изменения":"💾 Сохранить расчёт"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // ── ДЕТАЛЬНАЯ КАРТОЧКА ─────────────────────────────────────────────────────
  const CalcDetail = ({calc}) => {
    const g = calc.glass;
    const p = calc.profile;
    const [tab, setTab] = useState("glass");
    const waText = generateWhatsAppText(calc);
    const waUrl = calc.clientPhone ? `https://wa.me/${(calc.clientPhone||"").replace(/\D/g,"")}?text=${encodeURIComponent(waText)}` : null;

    return (
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:9998,overflowY:"auto"}}>
        <div style={{minHeight:"100%",display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:T.surface,borderRadius:16,width:"100%",maxWidth:540,fontFamily:T.font}}>
            {/* Header */}
            <div style={{padding:"18px 22px",borderBottom:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:15,fontWeight:700,fontFamily:T.serif}}>🪟 Расчёт стекла</div>
                {calc.clientName&&<div style={{fontSize:12,color:T.textSec,marginTop:2}}>👤 {calc.clientName} {calc.clientPhone&&`· ${calc.clientPhone}`}</div>}
              </div>
              <div style={{display:"flex",gap:7}}>
                <button onClick={()=>{setSelected(null);startEdit(calc);}} style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,padding:"5px 11px",cursor:"pointer",fontSize:12,color:T.gold,fontFamily:T.font,fontWeight:600}}>✏️</button>
                <button onClick={()=>setDeleteConfirm(calc.id)} style={{background:T.dangerBg,border:"1px solid rgba(196,84,84,0.2)",borderRadius:8,padding:"5px 11px",cursor:"pointer",fontSize:12,color:T.danger,fontFamily:T.font}}>🗑️</button>
                <button onClick={()=>setSelected(null)} style={{background:T.elevated,border:`1px solid ${T.border}`,borderRadius:8,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,color:T.textSec}}>✕</button>
              </div>
            </div>

            {/* Tabs */}
            <div style={{display:"flex",borderBottom:`1px solid ${T.border}`}}>
              {[["glass","🪟 Стекло"],["profile","⚙️ Профиль"],["msg","💬 Сообщение"]].map(([id,label])=>(
                <button key={id} onClick={()=>setTab(id)} style={{flex:1,background:"none",border:"none",borderBottom:`2px solid ${tab===id?T.gold:"transparent"}`,padding:"10px 0",color:tab===id?T.gold:T.textSec,fontWeight:tab===id?600:400,fontSize:12,cursor:"pointer",fontFamily:T.font}}>
                  {label}
                </button>
              ))}
            </div>

            <div style={{padding:"18px 22px",maxHeight:"60vh",overflowY:"auto"}}>
              {/* Стекло */}
              {tab==="glass"&&(
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    {[["📐 Проём",`${calc.width} × ${calc.height} мм`],["🔢 Створок",`${calc.sashes} шт`],["🪟 Ширина стекла",`${g.glassW} мм`],["📏 Высота стекла",`${g.glassH} мм`]].map(([label,val])=>(
                      <div key={label} style={{background:T.card,borderRadius:9,padding:"11px 13px",border:`1px solid ${T.border}`}}>
                        <div style={{fontSize:9,color:T.textSec,marginBottom:3,fontWeight:600}}>{label}</div>
                        <div style={{fontSize:14,fontWeight:600,fontFamily:T.mono,color:T.gold}}>{val}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{background:"rgba(184,150,90,0.06)",border:"1px solid rgba(184,150,90,0.15)",borderRadius:10,padding:"11px 14px",fontSize:13}}>
                    <b>Итого:</b> {g.glassW} × {g.glassH} мм — <b>{g.count} шт</b> · под стекло 10 мм{calc.openCenter?" · от центра":""}{calc.ral?` · Цвет: ${calc.ral}`:""}
                  </div>
                  {calc.notes&&<div style={{background:T.card,borderRadius:9,padding:"10px 13px",border:`1px solid ${T.border}`,fontSize:12,color:T.textSec}}>{calc.notes}</div>}
                </div>
              )}

              {/* Профиль */}
              {tab==="profile"&&p&&(
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  <div style={{fontSize:11,color:T.textSec,fontWeight:600,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>Профили</div>
                  {calc.ral&&<div style={{background:T.elevated,borderRadius:9,padding:"8px 12px",border:`1px solid ${T.border}`,fontSize:12,color:T.textSec,marginBottom:4}}>🎨 Цвет RAL: <b style={{color:T.text}}>{calc.ral}</b></div>}
                  {p.profiles.filter(pr=>pr.qty>0).map((pr,i)=>(
                    <div key={i} style={{background:T.card,borderRadius:9,border:`1px solid ${T.border}`,padding:"9px 12px"}}>
                      <div style={{fontSize:12,color:T.text,marginBottom:5,fontWeight:500}}>{pr.name}</div>
                      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                        <span style={{fontSize:11,color:T.textSec,fontFamily:T.mono}}>📏 {Math.round(pr.len)} мм</span>
                        <span style={{fontSize:11,color:T.gold,fontFamily:T.mono,fontWeight:700}}>× {pr.qty} шт</span>
                        <span style={{fontSize:11,color:T.textSec}}>= <b style={{color:T.text}}>{pr.pcs} штанг</b> по 6м</span>
                      </div>
                    </div>
                  ))}
                  <div style={{fontSize:11,color:T.textSec,fontWeight:600,letterSpacing:1,textTransform:"uppercase",marginTop:4}}>Аксессуары</div>
                  {p.accessories.filter(a=>a.qty>0).map((a,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 12px",background:T.card,borderRadius:9,border:`1px solid ${T.border}`}}>
                      <div style={{fontSize:12,color:T.text,flex:1}}>
                        {a.name}
                        {a.note&&<span style={{fontSize:10,color:T.textDim,marginLeft:6}}>{a.note}</span>}
                        {a.len&&<span style={{fontSize:10,color:T.textSec,marginLeft:6,fontFamily:T.mono}}>{Math.round(a.len)} мм</span>}
                      </div>
                      <span style={{fontSize:12,fontWeight:700,color:T.gold,fontFamily:T.mono,flexShrink:0}}>{a.qty} шт</span>
                    </div>
                  ))}
                  <div style={{background:T.goldBg,borderRadius:9,padding:"9px 12px",border:`1px solid rgba(184,150,90,0.15)`}}>
                    <div style={{fontSize:11,color:T.textSec}}>ИТОГО профилей: <b style={{color:T.gold}}>{p.totalQty} шт</b> · штанг 6м: <b style={{color:T.gold}}>{p.totalPcs} шт</b></div>
                  </div>
                </div>
              )}

              {/* Сообщение */}
              {tab==="msg"&&(
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  <div style={{background:T.card,borderRadius:10,padding:"13px 15px",border:`1px solid ${T.border}`,fontSize:13,lineHeight:1.7,whiteSpace:"pre-wrap",color:T.text}}>
                    {waText.replace(/\\n/g,"\n")}
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>copyWA(calc)}
                      style={{flex:1,background:copied===calc.id?"rgba(90,154,106,0.15)":T.elevated,color:copied===calc.id?T.green:T.text,border:`1px solid ${copied===calc.id?"rgba(90,154,106,0.3)":T.border}`,borderRadius:10,padding:"11px",fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:T.font}}>
                      {copied===calc.id?"✓ Скопировано!":"📋 Копировать текст"}
                    </button>
                    {waUrl&&(
                      <a href={waUrl} target="_blank" rel="noreferrer"
                        style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:"rgba(90,154,106,0.1)",color:T.green,border:"1px solid rgba(90,154,106,0.25)",borderRadius:10,padding:"11px",fontWeight:600,fontSize:13,textDecoration:"none",fontFamily:T.font}}>
                        💬 Открыть WhatsApp
                      </a>
                    )}
                  </div>
                  {!calc.clientPhone&&<div style={{fontSize:11,color:T.textSec,textAlign:"center"}}>Добавьте телефон клиента для прямой отправки в WhatsApp</div>}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ── РЕНДЕР ─────────────────────────────────────────────────────────────────
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10,marginBottom:20}}>
        <div>
          {!isMobile&&<div style={{fontSize:11,color:T.textSec,letterSpacing:2,marginBottom:4,fontWeight:600}}>ORIZZONTE</div>}
          <div style={{fontSize:isMobile?20:26,fontWeight:800,fontFamily:T.serif}}>Стекло 🪟 <span style={{fontSize:14,color:T.textSec,fontWeight:400,fontFamily:T.font}}>({calcs.length})</span></div>
        </div>
        <Btn variant="primary" onClick={()=>{resetForm();setShowForm(true);}}>+ Новый расчёт</Btn>
      </div>

      {calcs.length===0&&(
        <div style={{textAlign:"center",padding:60}}>
          <div style={{fontSize:40,marginBottom:14}}>🪟</div>
          <div style={{fontSize:16,fontWeight:700,fontFamily:T.serif,marginBottom:8}}>Расчётов пока нет</div>
          <div style={{fontSize:13,color:T.textSec,marginBottom:20}}>Введите габариты проёма и количество створок</div>
          <Btn variant="primary" onClick={()=>setShowForm(true)}>+ Первый расчёт</Btn>
        </div>
      )}

      <div style={{display:"flex",flexDirection:"column",gap:8,paddingBottom:isMobile?100:0}}>
        {calcs.map(calc=>{
          const g = calc.glass;
          return(
            <div key={calc.id} onClick={()=>setSelected(calc)}
              style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"13px 16px",cursor:"pointer",transition:"all .2s"}}
              onMouseEnter={e=>{e.currentTarget.style.borderColor=T.borderHover;e.currentTarget.style.background=T.elevated;}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border;e.currentTarget.style.background=T.card;}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                <div>
                  <div style={{fontSize:14,fontWeight:700,color:T.text}}>{calc.clientName||"Без имени"} {calc.clientPhone&&<span style={{fontSize:11,color:T.textSec,fontFamily:T.mono}}>· {calc.clientPhone}</span>}</div>
                  <div style={{fontSize:11,color:T.textSec,marginTop:2}}>Проём: {calc.width} × {calc.height} мм · {calc.sashes} створок</div>
                </div>
                <div style={{fontSize:10,color:T.textDim,flexShrink:0}}>{fmtDate(calc.createdAt)}</div>
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <span style={{background:"rgba(184,150,90,0.08)",color:T.gold,borderRadius:6,padding:"3px 10px",fontSize:12,fontFamily:T.mono,fontWeight:600}}>
                  {g.glassW} × {g.glassH} мм
                </span>
                <span style={{background:T.elevated,color:T.textSec,borderRadius:6,padding:"3px 10px",fontSize:11}}>
                  {g.count} шт · 10 мм
                </span>
                {calc.openCenter&&<span style={{background:"rgba(37,99,235,0.1)",color:"#60a5fa",borderRadius:6,padding:"3px 10px",fontSize:11}}>от центра</span>}
              </div>
              {calc.notes&&<div style={{fontSize:11,color:T.textSec,marginTop:6,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{calc.notes}</div>}
            </div>
          );
        })}
      </div>

      {showForm&&<CalcForm/>}
      {selected&&<CalcDetail calc={selected}/>}
      {deleteConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:T.surface,borderRadius:16,padding:"24px",maxWidth:340,width:"100%",fontFamily:T.font,textAlign:"center"}}>
            <div style={{fontSize:30,marginBottom:12}}>🗑️</div>
            <div style={{fontSize:15,fontWeight:700,marginBottom:8}}>Удалить расчёт?</div>
            <div style={{fontSize:12,color:T.textSec,marginBottom:20}}>Расчёт будет перемещён в корзину Firebase.</div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>handleDelete(deleteConfirm)} style={{flex:1,background:T.dangerBg,color:T.danger,border:"1px solid rgba(196,84,84,0.25)",borderRadius:10,padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:T.font}}>Удалить</button>
              <button onClick={()=>setDeleteConfirm(null)} style={{flex:1,background:T.elevated,color:T.text,border:`1px solid ${T.border}`,borderRadius:10,padding:"11px",fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:T.font}}>Отмена</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



// ─── KANBAN BOARD — внутренняя доска задач (полная замена Trello) ──────────────

const KANBAN_COLS = [
  { id:"new",     label:"Новые лиды",       color:"#6b7280", icon:"🌱", bg:"rgba(107,114,128,0.08)" },
  { id:"call",    label:"Созвоны / Встречи", color:"#2563eb", icon:"📞", bg:"rgba(37,99,235,0.08)"   },
  { id:"measure", label:"Выезд на замер",    color:"#7c3aed", icon:"📐", bg:"rgba(124,58,237,0.08)"  },
  { id:"kp",      label:"КП / Ждём ответа", color:"#0891b2", icon:"📄", bg:"rgba(8,145,178,0.08)"   },
  { id:"start",   label:"Договор / Монтаж", color:"#d97706", icon:"🏗️", bg:"rgba(217,119,6,0.08)"   },
  { id:"order",   label:"Ожидает заказ",    color:"#7c3aed", icon:"📦", bg:"rgba(124,58,237,0.06)"  },
  { id:"done",    label:"Завершено",         color:"#059669", icon:"✅", bg:"rgba(5,150,105,0.08)"   },
];

function autoColumn(task, client) {
  const t = (task.type||"").toLowerCase();
  const text = (task.text||"").toLowerCase();
  if (t==="measure"||text.includes("замер")||text.includes("выезд")) return "measure";
  if (t==="call"||text.includes("звон")||text.includes("созвон")||text.includes("встреч")||text.includes("шоурум")) return "call";
  if (t==="start"||text.includes("монтаж")||text.includes("установк")||text.includes("договор")||text.includes("аванс")) return "start";
  if (t==="order"||text.includes("ожидает заказ")||text.includes("поставк")) return "order";
  if (t==="kp"||text.includes("кп")||text.includes("предложен")||text.includes("ждём ответ")||text.includes("отправлен")) return "kp";
  if (t==="done"||text.includes("готов")||text.includes("оплат")||text.includes("завершён")) return "done";
  const s = client?.status||"";
  if (s==="kp_sent") return "kp";
  if (s==="measure")  return "measure";
  if (s==="negotiation") return "call";
  if (s==="install") return "start";
  if (s==="closed"||s==="won") return "done";
  return "call";
}

// ─── iOS Push Notification Helper ────────────────────────────────────────────
// iOS 16.4+ поддерживает Web Push ТОЛЬКО если приложение добавлено на главный экран
// Стратегия: показываем чёткую инструкцию + запрашиваем разрешение + fallback на SW-таймеры
function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.MSStream; }
function isIOSPWA() { return isIOS()&&window.navigator.standalone===true; }
function iosVersion() {
  const m=navigator.userAgent.match(/OS (\d+)_/); return m?parseInt(m[1]):0;
}

// Панель уведомлений (встроена в Kanban) — полностью переписана для iOS
function NotifPanel({ clients, onUpdateTask }) {
  const [open, setOpen] = React.useState(false);
  const [perm, setPerm] = React.useState(
    typeof Notification!=="undefined" ? Notification.permission : "default"
  );
  const [showIOSGuide, setShowIOSGuide] = React.useState(false);

  const ios = isIOS();
  const iosPwa = isIOSPWA();
  const iosVer = iosVersion();
  const pushSupported = "PushManager" in window && "serviceWorker" in navigator;

  async function requestPerm() {
    if (ios && !iosPwa) { setShowIOSGuide(true); return; }
    if (!("Notification" in window)) return;
    try {
      const r = await Notification.requestPermission();
      setPerm(r);
      if (r === "granted") {
        await subscribeToPush();
      }
    } catch(e) { console.warn("Push permission:", e); }
  }

  const now = new Date();
  const in7d = new Date(now.getTime() + 7*864e5);
  const upcoming = [];
  (clients||[]).forEach(cl=>{
    (cl.tasks||[]).filter(t=>!t.done&&t.date).forEach(t=>{
      const dt = new Date(t.date+"T"+(t.time||"09:00"));
      if (dt >= now && dt <= in7d) upcoming.push({...t, clientName:cl.name, clientId:cl.id, dt});
    });
  });
  upcoming.sort((a,b)=>a.dt-b.dt);

  const TYPE_ICONS = {call:"📞",measure:"📐",start:"🏗️",order:"📦",kp:"📄"};
  const overdue = (clients||[]).flatMap(cl=>
    (cl.tasks||[]).filter(t=>!t.done&&t.date&&new Date(t.date+"T"+(t.time||"23:59"))<now)
      .map(t=>({...t,clientName:cl.name,clientId:cl.id}))
  );

  const total = overdue.length + upcoming.length;

  return (
    <div style={{position:"relative"}}>
      <button onClick={()=>setOpen(o=>!o)}
        style={{position:"relative",background:open?"rgba(184,150,90,0.15)":"rgba(255,255,255,0.04)",
          border:`1px solid ${open?T.gold:T.border}`,borderRadius:10,padding:"8px 14px",
          color:open?T.gold:T.text,cursor:"pointer",display:"flex",alignItems:"center",gap:6,
          fontSize:13,fontFamily:T.font,WebkitTapHighlightColor:"transparent",touchAction:"manipulation"}}>
        🔔
        {total>0&&(
          <span style={{background:overdue.length?T.danger:T.gold,color:"#fff",borderRadius:10,
            padding:"1px 6px",fontSize:10,fontWeight:800,minWidth:18,textAlign:"center"}}>
            {total}
          </span>
        )}
      </button>

      {/* iOS-инструкция */}
      {showIOSGuide&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:9000,
          display:"flex",alignItems:"flex-end",justifyContent:"center",padding:16}}
          onClick={()=>setShowIOSGuide(false)}>
          <div style={{background:"#1a1a1d",border:"1px solid rgba(184,150,90,0.4)",borderRadius:20,
            padding:24,width:"100%",maxWidth:420,marginBottom:16}}
            onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:18,fontWeight:800,color:T.gold,marginBottom:12,textAlign:"center"}}>
              📲 Установите приложение
            </div>
            <div style={{fontSize:13,color:"rgba(255,255,255,0.7)",lineHeight:1.8,marginBottom:16}}>
              На iPhone уведомления работают только если CRM добавлена на главный экран:<br/>
              <br/>
              <span style={{color:"#fff",fontWeight:600}}>1.</span> Нажмите <span style={{color:T.gold}}>Поделиться</span> (квадрат со стрелкой внизу Safari)<br/>
              <span style={{color:"#fff",fontWeight:600}}>2.</span> Выберите <span style={{color:T.gold}}>«На экран Домой»</span><br/>
              <span style={{color:"#fff",fontWeight:600}}>3.</span> Откройте CRM <span style={{color:T.gold}}>через иконку</span> на экране<br/>
              <span style={{color:"#fff",fontWeight:600}}>4.</span> Включите уведомления
            </div>
            {iosVer < 16 && (
              <div style={{background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",
                borderRadius:10,padding:10,fontSize:12,color:"#f87171",marginBottom:12}}>
                ⚠ iOS {iosVer} не поддерживает Push. Обновитесь до iOS 16.4+
              </div>
            )}
            <button onClick={()=>setShowIOSGuide(false)}
              style={{width:"100%",padding:12,background:T.gold,color:"#09090b",border:"none",
                borderRadius:12,fontWeight:700,fontSize:14,cursor:"pointer"}}>
              Понятно
            </button>
          </div>
        </div>
      )}

      {open&&(
        <>
          <div style={{position:"fixed",inset:0,zIndex:190}} onClick={()=>setOpen(false)}/>
          <div style={{position:"absolute",top:"calc(100% + 8px)",right:0,width:Math.min(340,window.innerWidth-24),
            background:T.card,border:`1px solid ${T.border}`,borderRadius:14,
            boxShadow:"0 8px 32px rgba(0,0,0,0.6)",zIndex:200,overflow:"hidden"}}>

            {/* Заголовок */}
            <div style={{padding:"12px 16px",borderBottom:`1px solid ${T.border}`,
              display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontWeight:700,fontSize:14,color:T.text}}>🔔 Уведомления</div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                {perm==="granted"
                  ? <span style={{fontSize:11,color:"#4ade80",fontWeight:700}}>✓ Включены</span>
                  : <button onClick={requestPerm}
                      style={{fontSize:11,background:T.gold,color:"#09090b",border:"none",
                        borderRadius:8,padding:"5px 10px",cursor:"pointer",fontWeight:700,
                        WebkitTapHighlightColor:"transparent"}}>
                      {ios&&!iosPwa?"📲 Установить":"Включить"}
                    </button>
                }
                <button onClick={()=>setOpen(false)}
                  style={{background:"rgba(255,255,255,0.06)",border:"none",borderRadius:6,
                    width:24,height:24,color:T.textDim,cursor:"pointer",fontSize:12,
                    display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
              </div>
            </div>

            <div style={{maxHeight:400,overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
              {/* Просроченные */}
              {overdue.length>0&&(
                <div>
                  <div style={{padding:"7px 16px",fontSize:10,fontWeight:700,color:T.danger,
                    letterSpacing:1,background:"rgba(196,84,84,0.06)"}}>
                    ⚠ ПРОСРОЧЕНО ({overdue.length})
                  </div>
                  {overdue.map((t,i)=>(
                    <div key={i} style={{padding:"10px 16px",borderBottom:`1px solid ${T.border}`,
                      background:"rgba(196,84,84,0.04)"}}>
                      <div style={{fontSize:12,fontWeight:600,color:"#f87171"}}>
                        {TYPE_ICONS[t.type]||"📋"} {t.text}
                      </div>
                      <div style={{fontSize:11,color:T.textDim,marginTop:2,display:"flex",justifyContent:"space-between"}}>
                        <span>{t.clientName}</span>
                        <span style={{color:"#f87171"}}>{t.date}{t.time?" "+t.time:""}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {/* Ближайшие */}
              {upcoming.length>0&&(
                <div>
                  <div style={{padding:"7px 16px",fontSize:10,fontWeight:700,color:T.gold,letterSpacing:1}}>
                    БЛИЖАЙШИЕ 7 ДНЕЙ ({upcoming.length})
                  </div>
                  {upcoming.map((t,i)=>{
                    const isSoon=(t.dt-now)<864e5*2;
                    return(
                      <div key={i} style={{padding:"10px 16px",borderBottom:`1px solid ${T.border}`}}>
                        <div style={{fontSize:12,fontWeight:600,color:isSoon?T.gold:T.text}}>
                          {TYPE_ICONS[t.type]||"📋"} {t.text}
                        </div>
                        <div style={{fontSize:11,color:T.textDim,marginTop:2,display:"flex",justifyContent:"space-between"}}>
                          <span>{t.clientName}</span>
                          <span style={{color:isSoon?"#fb923c":T.textDim}}>
                            {isSoon?"⏰ ":""}{t.date}{t.time?" "+t.time:""}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {overdue.length===0&&upcoming.length===0&&(
                <div style={{padding:28,textAlign:"center",color:T.textDim,fontSize:13}}>
                  Нет предстоящих задач 🎉
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function KanbanBoard({ isMobile, clients = [], onUpdateClient }) {
  const [dragCard,  setDragCard]  = React.useState(null);
  const [dragOver,  setDragOver]  = React.useState(null);
  const [filter,    setFilter]    = React.useState("");
  const [showForm,  setShowForm]  = React.useState(false);
  const [newTask,   setNewTask]   = React.useState({text:"",clientId:"",type:"call",date:"",dateTo:"",time:""});
  const [saving,    setSaving]    = React.useState(false);
  const [popup,     setPopup]     = React.useState(null);
  const [collapsed, setCollapsed] = React.useState({});
  // inline date editing: editingDate = { cardId, field }
  const [editingDate, setEditingDate] = React.useState(null);

  const now = new Date();

  // Все задачи со всех клиентов
  const allCards = React.useMemo(()=>{
    const cards=[];
    clients.forEach(cl=>{
      (cl.tasks||[]).forEach(t=>{
        if(t.done) return;
        cards.push({
          id:t.id, clientId:cl.id, clientName:cl.name, clientPhone:cl.phone||"",
          text:t.text, type:t.type||"call",
          date:t.date, dateTo:t.dateTo||null, time:t.time,
          col:t.kanbanCol||autoColumn(t,cl),
          createdAt:t.createdAt,
        });
      });
    });
    return cards.sort((a,b)=>{
      if(a.date&&b.date) return new Date(a.date+"T"+(a.time||"00:00"))-new Date(b.date+"T"+(b.time||"00:00"));
      if(a.date) return -1; if(b.date) return 1;
      return 0;
    });
  },[clients]);

  const filtered = filter.trim()
    ? allCards.filter(c=>c.clientName?.toLowerCase().includes(filter.toLowerCase())||c.text?.toLowerCase().includes(filter.toLowerCase()))
    : allCards;

  function moveCard(clientId,taskId,newCol){
    const cl=clients.find(c=>c.id===clientId); if(!cl) return;
    const tasks=(cl.tasks||[]).map(t=>t.id===taskId?{...t,kanbanCol:newCol,updatedAt:new Date().toISOString()}:t);
    if(onUpdateClient) onUpdateClient(clientId,{tasks});
  }
  function doneCard(clientId,taskId){
    const cl=clients.find(c=>c.id===clientId); if(!cl) return;
    const tasks=(cl.tasks||[]).map(t=>t.id===taskId?{...t,done:true,doneAt:new Date().toISOString(),updatedAt:new Date().toISOString()}:t);
    if(onUpdateClient) onUpdateClient(clientId,{tasks});
  }

  // Обновляем поле задачи (дата, время, текст)
  function updateCardField(clientId, taskId, fields) {
    const cl = clients.find(c=>c.id===clientId); if(!cl) return;
    const tasks = (cl.tasks||[]).map(t=>
      t.id===taskId ? {...t,...fields,updatedAt:new Date().toISOString()} : t
    );
    if(onUpdateClient) onUpdateClient(clientId,{tasks});
    // Перепланируем уведомление если изменилась дата
    if(fields.date||fields.time) {
      const updated = tasks.find(t=>t.id===taskId);
      if(updated?.date&&updated?.time) scheduleNotification(updated,cl.name);
    }
  }

  async function createTask(){
    if(!newTask.text.trim()||!newTask.clientId) return;
    setSaving(true);
    const cl=clients.find(c=>c.id===newTask.clientId);
    if(!cl){setSaving(false);return;}
    const task={
      id:Date.now().toString(), text:newTask.text.trim(), type:newTask.type,
      date:newTask.date||null, dateTo:newTask.dateTo||null,
      time:newTask.time||null, done:false,
      kanbanCol:autoColumn({type:newTask.type,text:newTask.text},cl),
      createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    };
    const tasks=[...(cl.tasks||[]),task];
    if(onUpdateClient) onUpdateClient(newTask.clientId,{tasks});
    if(task.date&&task.time) scheduleNotification(task,cl.name);
    setNewTask({text:"",clientId:newTask.clientId,type:"call",date:"",dateTo:"",time:""});
    setSaving(false); setShowForm(false);
  }

  const TTYPES=[
    {id:"call",label:"Созвон",icon:"📞"},
    {id:"measure",label:"Замер",icon:"📐"},
    {id:"kp",label:"КП",icon:"📄"},
    {id:"start",label:"Монтаж",icon:"🏗️"},
    {id:"order",label:"Заказ",icon:"📦"},
    {id:"done",label:"Завершено",icon:"✅"},
  ];

  // ── Inline date input style ────────────────────────────────────────────────
  const dateInpStyle = {
    background:"rgba(255,255,255,0.06)",border:`1px solid ${T.border}`,
    borderRadius:5,padding:"2px 5px",color:T.text,fontSize:10,
    outline:"none",fontFamily:T.font,colorScheme:"dark",
    WebkitAppearance:"none",cursor:"pointer",width:"100%",touchAction:"manipulation",
  };

  return (
    <>
    {/* ── Попап профиля клиента ── */}
    {popup&&(()=>{
      const cl=clients.find(c=>c.id===popup); if(!cl) return null;
      const active=(cl.tasks||[]).filter(t=>!t.done);
      const lastKP=(cl.kps||[])[0];
      const SL={lead:"Лид",negotiation:"Переговоры",kp_sent:"КП отправлен",measure:"Замер",install:"Монтаж",closed:"Закрыт",lost:"Отказ"};
      return(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}
          onClick={()=>setPopup(null)}>
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:20,width:"100%",maxWidth:400,overflow:"hidden"}}
            onClick={e=>e.stopPropagation()}>
            <div style={{background:"linear-gradient(135deg,#1a1f26,#252b34)",padding:"20px 24px 16px",borderBottom:`1px solid ${T.border}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div>
                  <div style={{fontSize:20,fontWeight:800,color:"#fff",marginBottom:4}}>{cl.name}</div>
                  {cl.status&&<span style={{fontSize:11,background:`${T.gold}20`,color:T.gold,borderRadius:20,padding:"3px 10px",fontWeight:600}}>{SL[cl.status]||cl.status}</span>}
                </div>
                <button onClick={()=>setPopup(null)} style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:"50%",width:30,height:30,color:"#fff",cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
              </div>
            </div>
            <div style={{padding:"16px 24px"}}>
              {cl.phone&&<a href={`tel:${cl.phone}`} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"rgba(255,255,255,0.03)",borderRadius:10,border:`1px solid ${T.border}`,marginBottom:8,textDecoration:"none"}}>
                <span style={{fontSize:20}}>📞</span>
                <div>
                  <div style={{fontSize:11,color:T.textDim,fontWeight:600}}>ТЕЛЕФОН</div>
                  <div style={{fontSize:15,fontWeight:700,color:T.gold}}>{cl.phone}</div>
                </div>
                <a href={`https://wa.me/${cl.phone.replace(/\D/g,"")}`} target="_blank" rel="noreferrer"
                  onClick={e=>e.stopPropagation()}
                  style={{marginLeft:"auto",background:"rgba(37,211,102,0.1)",border:"1px solid rgba(37,211,102,0.3)",borderRadius:8,padding:"5px 10px",color:"#25D366",textDecoration:"none",fontSize:11,fontWeight:700}}>WA</a>
              </a>}
              {cl.address&&<div style={{padding:"10px 14px",background:"rgba(255,255,255,0.03)",borderRadius:10,border:`1px solid ${T.border}`,marginBottom:8,fontSize:13,color:T.text}}>📍 {cl.address}</div>}
              {active.length>0&&<div style={{marginBottom:8}}>
                <div style={{fontSize:10,color:T.textDim,fontWeight:700,letterSpacing:1,marginBottom:6}}>ЗАДАЧИ ({active.length})</div>
                {active.slice(0,3).map(t=><div key={t.id} style={{padding:"7px 12px",background:"rgba(255,255,255,0.02)",borderRadius:8,border:`1px solid ${T.border}`,marginBottom:3,fontSize:12,color:T.textSec}}>
                  {t.type==="call"?"📞":t.type==="measure"?"📐":"📋"} {t.text}
                  {t.date&&<span style={{color:T.textDim,marginLeft:8,fontSize:11}}>📅{t.date}{t.dateTo?"→"+t.dateTo:""}</span>}
                </div>)}
              </div>}
              {lastKP&&<div style={{padding:"10px 14px",background:"rgba(184,150,90,0.06)",borderRadius:10,border:`1px solid rgba(184,150,90,0.2)`}}>
                <div style={{fontSize:10,color:T.gold,fontWeight:700}}>ПОСЛЕДНЕЕ КП</div>
                <div style={{fontSize:16,fontWeight:800,color:T.gold}}>{new Intl.NumberFormat("ru-RU").format(lastKP.total)} ₸</div>
              </div>}
            </div>
          </div>
        </div>
      );
    })()}

    {/* ── Форма новой задачи ── */}
    {showForm&&(
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}
        onClick={e=>{ if(e.target===e.currentTarget) setShowForm(false); }}>
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:18,padding:24,width:"100%",maxWidth:420,
          maxHeight:"90vh",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
          <div style={{fontSize:17,fontWeight:800,color:T.text,marginBottom:18}}>➕ Новая задача</div>
          {/* Тип */}
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
            {TTYPES.map(t=><button key={t.id} onClick={()=>setNewTask(p=>({...p,type:t.id}))}
              style={{padding:"7px 12px",borderRadius:8,border:`1px solid ${newTask.type===t.id?T.gold:T.border}`,
                background:newTask.type===t.id?"rgba(184,150,90,0.12)":"rgba(255,255,255,0.02)",
                color:newTask.type===t.id?T.gold:T.textSec,cursor:"pointer",fontSize:12,fontFamily:T.font,
                fontWeight:newTask.type===t.id?700:400,WebkitTapHighlightColor:"transparent",touchAction:"manipulation"}}>
              {t.icon} {t.label}
            </button>)}
          </div>
          {/* Клиент */}
          <select value={newTask.clientId} onChange={e=>setNewTask(p=>({...p,clientId:e.target.value}))}
            style={{width:"100%",background:"rgba(255,255,255,0.06)",border:`1px solid ${T.border}`,borderRadius:10,
              padding:"10px 12px",color:newTask.clientId?T.text:T.textDim,fontSize:13,outline:"none",
              fontFamily:T.font,colorScheme:"dark",marginBottom:10,boxSizing:"border-box"}}>
            <option value="">— Выберите клиента —</option>
            {[...clients].sort((a,b)=>a.name.localeCompare(b.name,"ru")).map(c=>
              <option key={c.id} value={c.id}>{c.name}{c.phone?" · "+c.phone:""}</option>)}
          </select>
          {/* Текст */}
          <textarea value={newTask.text} onChange={e=>setNewTask(p=>({...p,text:e.target.value}))}
            placeholder="Описание задачи..." rows={2}
            style={{width:"100%",background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,
              borderRadius:10,padding:"10px 12px",color:T.text,fontSize:13,outline:"none",
              fontFamily:T.font,resize:"none",marginBottom:10,boxSizing:"border-box"}}/>
          {/* Дата ОТ / ДО */}
          <div style={{marginBottom:6}}>
            <div style={{fontSize:10,color:T.textDim,fontWeight:700,letterSpacing:1,marginBottom:6}}>
              📅 ДАТА НАЧАЛА → ДАТА ОКОНЧАНИЯ
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
              <div style={{flex:1}}>
                <label style={{fontSize:10,color:T.textDim,display:"block",marginBottom:3}}>От</label>
                <input type="date" value={newTask.date} onChange={e=>setNewTask(p=>({...p,date:e.target.value}))}
                  style={{width:"100%",background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,
                    borderRadius:10,padding:"9px 12px",color:T.text,fontSize:13,outline:"none",
                    colorScheme:"dark",boxSizing:"border-box"}}/>
              </div>
              <div style={{color:T.textDim,fontSize:16,marginTop:16}}>→</div>
              <div style={{flex:1}}>
                <label style={{fontSize:10,color:T.textDim,display:"block",marginBottom:3}}>До (опционально)</label>
                <input type="date" value={newTask.dateTo} onChange={e=>setNewTask(p=>({...p,dateTo:e.target.value}))}
                  min={newTask.date||undefined}
                  style={{width:"100%",background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,
                    borderRadius:10,padding:"9px 12px",color:newTask.dateTo?T.text:T.textDim,fontSize:13,
                    outline:"none",colorScheme:"dark",boxSizing:"border-box"}}/>
              </div>
            </div>
            <div style={{flex:1}}>
              <label style={{fontSize:10,color:T.textDim,display:"block",marginBottom:3}}>Время напоминания</label>
              <input type="time" value={newTask.time} onChange={e=>setNewTask(p=>({...p,time:e.target.value}))}
                style={{background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,borderRadius:10,
                  padding:"9px 12px",color:T.text,fontSize:13,outline:"none",colorScheme:"dark",boxSizing:"border-box"}}/>
            </div>
          </div>
          {/* Кнопки */}
          <div style={{display:"flex",gap:8,marginTop:16}}>
            <button onClick={createTask} disabled={!newTask.text.trim()||!newTask.clientId||saving}
              style={{flex:2,padding:"13px",background:newTask.text.trim()&&newTask.clientId?`linear-gradient(135deg,${T.gold},#9a7d4a)`:"rgba(255,255,255,0.04)",
                color:newTask.text.trim()&&newTask.clientId?"#09090b":T.textDim,border:"none",borderRadius:12,
                fontWeight:700,fontSize:14,cursor:newTask.text.trim()&&newTask.clientId?"pointer":"not-allowed",
                fontFamily:T.font,WebkitTapHighlightColor:"transparent"}}>
              {saving?"Сохранение...":"Создать задачу"}
            </button>
            <button onClick={()=>setShowForm(false)}
              style={{flex:1,padding:"13px",background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,
                borderRadius:12,color:T.textSec,cursor:"pointer",fontFamily:T.font,WebkitTapHighlightColor:"transparent"}}>
              Отмена
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ── Главный контейнер ── */}
    <div style={{height:"100%",display:"flex",flexDirection:"column",background:T.bg,overflow:"hidden"}}>

      {/* ── Шапка ── */}
      <div style={{padding:"12px 16px 10px",borderBottom:`1px solid ${T.border}`,
        background:"rgba(184,150,90,0.04)",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <div style={{fontSize:18,fontWeight:800,color:T.text,fontFamily:T.font}}>📋 Задачи</div>
          <div style={{flex:1}}/>
          <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="🔍 Поиск..."
            style={{background:"rgba(255,255,255,0.05)",border:`1px solid ${T.border}`,borderRadius:8,
              padding:"6px 12px",color:T.text,fontSize:12,outline:"none",fontFamily:T.font,width:140}}/>
          <NotifPanel clients={clients}/>
          <button onClick={()=>setShowForm(true)}
            style={{background:`linear-gradient(135deg,${T.gold},#9a7d4a)`,color:"#09090b",border:"none",
              borderRadius:9,padding:"8px 14px",fontWeight:700,fontSize:13,cursor:"pointer",
              display:"flex",alignItems:"center",gap:5,WebkitTapHighlightColor:"transparent",touchAction:"manipulation"}}>
            ＋ Задача
          </button>
        </div>
      </div>

      {/* ── Kanban колонки ── */}
      <div style={{flex:1,overflowX:"auto",overflowY:"hidden",display:"flex",padding:"12px",gap:10,minHeight:0,
        WebkitOverflowScrolling:"touch"}}>
        {KANBAN_COLS.map(col=>{
          const cards=filtered.filter(c=>c.col===col.id);
          const isOver=dragOver===col.id;
          const isCollapsed=collapsed[col.id];
          return(
            <div key={col.id} style={{width:isCollapsed?42:280,minWidth:isCollapsed?42:280,flexShrink:0,
              display:"flex",flexDirection:"column",transition:"width 0.2s",height:"100%"}}
              onDragOver={e=>{e.preventDefault();setDragOver(col.id);}}
              onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget))setDragOver(null);}}
              onDrop={e=>{e.preventDefault();if(dragCard)moveCard(dragCard.clientId,dragCard.taskId,col.id);setDragCard(null);setDragOver(null);}}>

              {/* Заголовок колонки */}
              <div style={{
                padding:"10px 12px",borderRadius:isCollapsed?"10px":"10px 10px 0 0",
                background:isOver?`${col.color}25`:col.bg,
                border:`1px solid ${isOver?col.color:col.color+"35"}`,
                borderBottom:isCollapsed?undefined:"none",
                display:"flex",alignItems:"center",gap:6,cursor:"pointer",flexShrink:0,
                writingMode:isCollapsed?"vertical-rl":"horizontal-tb",
                minHeight:isCollapsed?120:undefined,
                justifyContent:isCollapsed?"center":"space-between",
              }} onClick={()=>setCollapsed(p=>({...p,[col.id]:!p[col.id]}))}>
                {isCollapsed?(
                  <span style={{fontSize:11,fontWeight:700,color:col.color,letterSpacing:0.5}}>
                    {col.icon} {col.label} ({cards.length})
                  </span>
                ):(
                  <>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{fontSize:15}}>{col.icon}</span>
                      <span style={{fontSize:12,fontWeight:700,color:col.color}}>{col.label}</span>
                      <span style={{background:`${col.color}25`,color:col.color,borderRadius:10,
                        padding:"1px 7px",fontSize:11,fontWeight:800}}>{cards.length}</span>
                    </div>
                    <span style={{fontSize:14,color:T.textDim,opacity:0.5}}>‹</span>
                  </>
                )}
              </div>

              {/* Карточки */}
              {!isCollapsed&&(
                <div style={{
                  flex:1,overflowY:"auto",padding:"6px",
                  background:isOver?"rgba(255,255,255,0.025)":"rgba(255,255,255,0.015)",
                  border:`1px solid ${isOver?col.color:col.color+"25"}`,
                  borderTop:"none",borderRadius:"0 0 10px 10px",
                  scrollbarWidth:"thin",scrollbarColor:`${T.border} transparent`,
                  WebkitOverflowScrolling:"touch",
                }}>
                  {cards.length===0&&(
                    <div style={{padding:16,textAlign:"center",color:T.textDim,fontSize:12,opacity:0.4,userSelect:"none"}}>
                      Пусто
                    </div>
                  )}
                  {cards.map(card=>{
                    const due = card.date ? new Date(card.date+"T"+(card.time||"23:59")) : null;
                    const dueTo = card.dateTo ? new Date(card.dateTo+"T23:59") : null;
                    const overdue = due&&due<now&&!dueTo; // если диапазон — просрочен только после dateTo
                    const overdueRange = dueTo&&dueTo<now;
                    const isOverdue = overdue||overdueRange;
                    const soon = due&&!isOverdue&&(due-now)<864e5*2;
                    const TI={call:"📞",measure:"📐",start:"🏗️",order:"📦",kp:"📄",done:"✅"};
                    const isEditingDateFrom = editingDate?.cardId===card.id&&editingDate?.field==="date";
                    const isEditingDateTo   = editingDate?.cardId===card.id&&editingDate?.field==="dateTo";
                    const isEditingTime     = editingDate?.cardId===card.id&&editingDate?.field==="time";

                    return(
                      <div key={card.id} draggable
                        onDragStart={()=>setDragCard({clientId:card.clientId,taskId:card.id})}
                        onDragEnd={()=>{setDragCard(null);setDragOver(null);}}
                        style={{
                          background:T.card,
                          border:`1px solid ${isOverdue?"rgba(248,113,113,0.5)":soon?"rgba(251,146,60,0.4)":T.border}`,
                          borderLeft:`3px solid ${isOverdue?"#f87171":soon?"#fb923c":col.color}`,
                          borderRadius:8,padding:"10px 10px 8px",marginBottom:6,cursor:"grab",
                          userSelect:"none",transition:"box-shadow 0.15s",
                          boxShadow:dragCard?.taskId===card.id?"0 6px 24px rgba(0,0,0,0.5)":"none",
                          opacity:dragCard?.taskId===card.id?0.7:1,
                        }}>

                        {/* Имя клиента */}
                        <button onClick={()=>setPopup(card.clientId)}
                          style={{background:"none",border:"none",padding:0,cursor:"pointer",
                            color:T.gold,fontSize:11,fontWeight:700,fontFamily:T.font,
                            textDecoration:"underline",textDecorationStyle:"dotted",
                            textUnderlineOffset:2,marginBottom:5,display:"block",
                            WebkitTapHighlightColor:"transparent"}}>
                          {card.clientName}
                        </button>

                        {/* Задача */}
                        <div style={{fontSize:12,color:T.text,lineHeight:1.4,marginBottom:7}}>
                          <span style={{marginRight:4,fontSize:11}}>{TI[card.type]||"📋"}</span>{card.text}
                        </div>

                        {/* ── Даты — инлайн редактирование ── */}
                        <div style={{display:"flex",gap:4,marginBottom:7,alignItems:"center",flexWrap:"wrap"}}
                          onClick={e=>e.stopPropagation()}>

                          {/* Дата ОТ */}
                          <div style={{position:"relative",flex:1,minWidth:80}}>
                            {isEditingDateFrom ? (
                              <input type="date" autoFocus
                                defaultValue={card.date||""}
                                style={dateInpStyle}
                                onChange={e=>{
                                  updateCardField(card.clientId,card.id,{date:e.target.value||null});
                                }}
                                onBlur={()=>setEditingDate(null)}
                                onKeyDown={e=>e.key==="Escape"&&setEditingDate(null)}
                              />
                            ) : (
                              <button onClick={()=>setEditingDate({cardId:card.id,field:"date"})}
                                style={{width:"100%",background:isOverdue?"rgba(248,113,113,0.12)":soon?"rgba(251,146,60,0.1)":"rgba(255,255,255,0.04)",
                                  border:`1px solid ${isOverdue?"rgba(248,113,113,0.3)":soon?"rgba(251,146,60,0.3)":"rgba(255,255,255,0.08)"}`,
                                  borderRadius:5,padding:"3px 7px",cursor:"pointer",fontFamily:T.font,
                                  display:"flex",alignItems:"center",gap:4,
                                  WebkitTapHighlightColor:"transparent",touchAction:"manipulation"}}>
                                <span style={{fontSize:9}}>{isOverdue?"⚠":soon?"⏰":"📅"}</span>
                                <span style={{fontSize:10,color:isOverdue?"#f87171":soon?"#fb923c":T.textSec,fontWeight:600}}>
                                  {card.date
                                    ? new Date(card.date+"T12:00").toLocaleDateString("ru-RU",{day:"2-digit",month:"2-digit"})
                                    : <span style={{color:T.textDim,fontWeight:400}}>+ дата</span>
                                  }
                                </span>
                              </button>
                            )}
                          </div>

                          {/* Стрелка от→до */}
                          {(card.date||card.dateTo)&&<span style={{fontSize:10,color:T.textDim,flexShrink:0}}>→</span>}

                          {/* Дата ДО */}
                          <div style={{position:"relative",flex:1,minWidth:80}}>
                            {isEditingDateTo ? (
                              <input type="date" autoFocus
                                defaultValue={card.dateTo||""}
                                min={card.date||undefined}
                                style={dateInpStyle}
                                onChange={e=>{
                                  updateCardField(card.clientId,card.id,{dateTo:e.target.value||null});
                                }}
                                onBlur={()=>setEditingDate(null)}
                                onKeyDown={e=>e.key==="Escape"&&setEditingDate(null)}
                              />
                            ) : (
                              <button onClick={()=>setEditingDate({cardId:card.id,field:"dateTo"})}
                                style={{width:"100%",background:overdueRange?"rgba(248,113,113,0.12)":"rgba(255,255,255,0.03)",
                                  border:`1px solid ${overdueRange?"rgba(248,113,113,0.3)":"rgba(255,255,255,0.06)"}`,
                                  borderRadius:5,padding:"3px 7px",cursor:"pointer",fontFamily:T.font,
                                  display:"flex",alignItems:"center",gap:4,
                                  WebkitTapHighlightColor:"transparent",touchAction:"manipulation"}}>
                                <span style={{fontSize:10,color:overdueRange?"#f87171":T.textDim,fontWeight:600}}>
                                  {card.dateTo
                                    ? new Date(card.dateTo+"T12:00").toLocaleDateString("ru-RU",{day:"2-digit",month:"2-digit"})
                                    : <span style={{color:"rgba(255,255,255,0.15)",fontWeight:400,fontSize:9}}>до</span>
                                  }
                                </span>
                              </button>
                            )}
                          </div>

                          {/* Время */}
                          <div style={{flexShrink:0}}>
                            {isEditingTime ? (
                              <input type="time" autoFocus
                                defaultValue={card.time||""}
                                style={{...dateInpStyle,width:70}}
                                onChange={e=>{
                                  updateCardField(card.clientId,card.id,{time:e.target.value||null});
                                }}
                                onBlur={()=>setEditingDate(null)}
                                onKeyDown={e=>e.key==="Escape"&&setEditingDate(null)}
                              />
                            ) : (
                              <button onClick={()=>setEditingDate({cardId:card.id,field:"time"})}
                                style={{background:"rgba(255,255,255,0.03)",
                                  border:"1px solid rgba(255,255,255,0.06)",
                                  borderRadius:5,padding:"3px 7px",cursor:"pointer",fontFamily:T.font,
                                  WebkitTapHighlightColor:"transparent",touchAction:"manipulation"}}>
                                <span style={{fontSize:10,color:card.time?T.textSec:"rgba(255,255,255,0.15)",fontWeight:card.time?600:400}}>
                                  {card.time||<span style={{fontSize:9}}>⏱</span>}
                                </span>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Действия */}
                        <div style={{display:"flex",gap:4,alignItems:"center"}}>
                          <select value={card.col}
                            onChange={e=>{e.stopPropagation();moveCard(card.clientId,card.id,e.target.value);}}
                            style={{flex:1,background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,
                              borderRadius:6,padding:"3px 5px",color:T.textSec,fontSize:10,outline:"none",
                              fontFamily:T.font,cursor:"pointer",colorScheme:"dark",touchAction:"manipulation"}}>
                            {KANBAN_COLS.map(c=><option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
                          </select>
                          <button onClick={()=>doneCard(card.clientId,card.id)} title="Выполнено"
                            style={{padding:"4px 10px",background:"rgba(5,150,105,0.1)",
                              border:"1px solid rgba(5,150,105,0.3)",borderRadius:6,
                              color:"#34d399",cursor:"pointer",fontSize:13,fontWeight:700,flexShrink:0,
                              WebkitTapHighlightColor:"transparent",touchAction:"manipulation"}}>
                            ✓
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {/* Добавить задачу в колонку */}
                  <button onClick={()=>{
                    const typeMap={call:"call",measure:"measure",kp:"kp",start:"start",order:"order"};
                    setNewTask(p=>({...p,type:typeMap[col.id]||"call"}));
                    setShowForm(true);
                  }} style={{width:"100%",padding:"7px",background:"rgba(255,255,255,0.02)",
                    border:`1px dashed ${col.color}30`,borderRadius:7,color:T.textDim,
                    cursor:"pointer",fontSize:11,fontFamily:T.font,textAlign:"center",
                    WebkitTapHighlightColor:"transparent",touchAction:"manipulation"}}>
                    + Добавить задачу
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
    </>
  );
}

// ─── VISUALIZER CONSTANTS ─────────────────────────────────────────────────────
const VIZ_FRAME_COLORS = [
  { name:"Белый",         ral:"RAL 9016", hex:"#f1f0eb" },
  { name:"Антрацит",      ral:"RAL 7016", hex:"#383e42" },
  { name:"Чёрный",        ral:"RAL 9005", hex:"#0a0a0a" },
  { name:"Серебристый",   ral:"RAL 9006", hex:"#a5a5a5" },
  { name:"Бронза",        ral:"RAL 8017", hex:"#4a2c1a" },
  { name:"Шампань",       ral:"RAL 1013", hex:"#e8e0d0" },
  { name:"Серый графит",  ral:"RAL 7024", hex:"#474a50" },
  { name:"Коричневый",    ral:"RAL 8014", hex:"#4e3524" },
  { name:"Оливковый",     ral:"RAL 6003", hex:"#515941" },
  { name:"Кремовый",      ral:"RAL 9001", hex:"#f4f0e7" },
];

const VIZ_FABRIC_COLORS = [
  { name:"Бежевый",       hex:"#c8b89a" },
  { name:"Белый",         hex:"#f5f5f0" },
  { name:"Серый",         hex:"#8a8a8a" },
  { name:"Антрацит",      hex:"#3c3c3c" },
  { name:"Тёмно-синий",   hex:"#1a2a4a" },
  { name:"Терракота",     hex:"#a0522d" },
  { name:"Оливковый",     hex:"#6b7c45" },
  { name:"Кремовый",      hex:"#f0e8d0" },
  { name:"Бордо",         hex:"#6b1a2a" },
  { name:"Светло-серый",  hex:"#c0c0c0" },
];

const VIZ_PRODUCTS = [
  {
    id: "bio-pergola",
    name: "Биоклим. пергола",
    productDesc: "Bioclimatic pergola with rotating aluminum louvers (blades) that open and close 0-110 degrees. Modern architectural structure with integrated gutters in columns, powder-coated aluminum frame. The louvers are horizontal slats running the full width of the roof.",
    states: [
      { label:"Закрыта (0°)",   desc:"Louvers fully closed at 0 degrees, forming a solid weatherproof roof. All slats horizontal and touching each other." },
      { label:"Открыта (110°)", desc:"Louvers fully open at 110 degrees, allowing full airflow and sunlight through the gaps between rotated slats." },
      { label:"Полуоткрыта",    desc:"Louvers at 45 degrees, partially open for filtered light and ventilation." },
    ],
  },
  {
    id: "tent-pergola",
    name: "Тентовая пергола",
    productDesc: "Motorized retractable awning pergola with fabric canopy stretched over aluminum frame. The waterproof acrylic fabric slides along guide rails and can be fully extended or retracted into a compact cassette box.",
    states: [
      { label:"Раскрыта",  desc:"Fabric canopy fully extended, covering the entire pergola area. Fabric is taut and flat." },
      { label:"Убрана",    desc:"Fabric fully retracted into the cassette housing at one end. Only the clean aluminum frame structure visible." },
      { label:"Частично",  desc:"Fabric extended about halfway, partial coverage." },
    ],
  },
  {
    id: "marquise",
    name: "Маркиза",
    productDesc: "Wall-mounted cassette awning (marquise) with articulated arms (pantograph mechanism). The fabric rolls out from a compact cassette box mounted on the wall, supported by extending aluminum arms at 20-degree angle.",
    states: [
      { label:"Раскрыта",  desc:"Awning fully extended, fabric stretched on articulated arms projecting 3-4 meters from the wall at 20 degrees downward angle." },
      { label:"Убрана",    desc:"Awning fully retracted into wall-mounted cassette box. Only small rectangular cassette housing visible on wall." },
    ],
  },
  {
    id: "sliding-glass",
    name: "Раздвижное остекление",
    productDesc: "Frameless sliding glass panels on aluminum top and bottom tracks. 3-4 large glass panels that slide horizontally to stack at one side, creating an open or closed transparent enclosure.",
    states: [
      { label:"Закрыто",   desc:"All glass panels in closed position forming a continuous transparent glass wall." },
      { label:"Открыто",   desc:"All glass panels slid to one side, stacked together, leaving the space completely open." },
      { label:"Частично",  desc:"Some panels open, some closed." },
    ],
  },
  {
    id: "guillotine",
    name: "Гильотинное остекление",
    productDesc: "Automated guillotine glass system where large glass panels slide vertically upward into a frame above, controlled by electric chain drive mechanism. Creates a seamless glass barrier that disappears into the ceiling.",
    states: [
      { label:"Закрыто",   desc:"Glass panel in down position, creating a full-height transparent barrier from floor to ceiling frame." },
      { label:"Открыто",   desc:"Glass panel raised fully up into the overhead frame structure, completely open passage." },
    ],
  },
  {
    id: "zip-screen",
    name: "Zip-шторы",
    productDesc: "Vertical zip-guided outdoor roller screen/blind with fabric locked in aluminum side channels (zip guides). Fabric rolls up into a compact cassette at the top. Provides wind-resistant transparent or opaque barrier.",
    states: [
      { label:"Опущена",   desc:"Fabric screen fully lowered to the floor, locked in zip side channels. Full vertical coverage." },
      { label:"Поднята",   desc:"Fabric fully rolled up into top cassette housing. No fabric visible, open view." },
      { label:"Наполовину",desc:"Fabric lowered halfway." },
    ],
  },
  {
    id: "toscana-maxi",
    name: "Тент. Maxi пергола",
    productDesc: "Large motorized retractable fabric pergola (Toscana Maxi) with reinforced aluminum frame. Extra-wide fabric canopy with enhanced support structure, suitable for large terraces up to 13.5m projection.",
    states: [
      { label:"Раскрыта",  desc:"Large fabric canopy fully extended across the entire frame. Heavy-duty fabric taut and flat." },
      { label:"Убрана",    desc:"Fabric fully retracted. Strong aluminum frame structure visible." },
    ],
  },
];

// ─── END VISUALIZER CONSTANTS ─────────────────────────────────────────────────

function Visualizer({isMobile, clients=[]}) {
  const [photo,setPhoto]=useState(null);
  const [step,setStep]=useState(0);
  const [marker,setMarker]=useState(null);
  const [productId,setProductId]=useState("bio-pergola");
  const [prodState,setProdState]=useState(0);
  const [frameColor,setFrameColor]=useState(VIZ_FRAME_COLORS[0]);
  const [fabricColor,setFabricColor]=useState(VIZ_FABRIC_COLORS[0]);
  const [loading,setLoading]=useState(false);
  const [progress,setProgress]=useState("");
  const [error,setError]=useState("");
  const [resultImage,setResultImage]=useState(null);
  const [showOriginal,setShowOriginal]=useState(false);
  const [history,setHistory]=useState([]);
  const [sceneAnalysis,setSceneAnalysis]=useState(null);
  const [outputMode,setOutputMode]=useState("photo"); // "photo" | "video"
  const [customPrompt,setCustomPrompt]=useState("");
  const [addons,setAddons]=useState([]);
  const [videoResult,setVideoResult]=useState(null);
  const [videoError,setVideoError]=useState("");
  const [attachClientId,setAttachClientId]=useState("");
  const [attachSaving,setAttachSaving]=useState(false);
  const [attachDone,setAttachDone]=useState(false);
  const fileRef=useRef(null);
  const prod = VIZ_PRODUCTS.find(p=>p.id===productId) || VIZ_PRODUCTS[0];
  const safeState = Math.min(prodState, (prod?.states?.length||1)-1);
  const hasFabric=["marquise","tent-pergola","toscana-maxi"].includes(productId);

  const handleUpload=useCallback((file)=>{
    if(!file)return;
    const reader=new FileReader();
    reader.onload=(e)=>{
      const img=new Image();
      img.onload=()=>{
        const MAX=1536;let w=img.width,h=img.height;
        if(w>MAX||h>MAX){const r=Math.min(MAX/w,MAX/h);w=Math.round(w*r);h=Math.round(h*r);}
        const c=document.createElement("canvas");c.width=w;c.height=h;
        c.getContext("2d").drawImage(img,0,0,w,h);
        setPhoto(c.toDataURL("image/jpeg",0.85));setStep(1);setMarker(null);setResultImage(null);setVideoResult(null);setVideoError("");setError("");
      };img.src=e.target.result;
    };reader.readAsDataURL(file);
  },[]);

  const handleCanvasClick=useCallback((e)=>{
    if(step!==1&&step!==2)return;
    const r=e.currentTarget.getBoundingClientRect();
    setMarker({x:((e.clientX-r.left)/r.width)*100,y:((e.clientY-r.top)/r.height)*100});
  },[step]);

  async function generate(){
    if(!photo||!marker||!prod)return;
    const curState = prod.states[safeState] || prod.states[0];
    setLoading(true);setError("");setResultImage(null);setVideoResult(null);setVideoError("");setSceneAnalysis(null);

    if(outputMode==="photo"){
      setProgress("Claude Vision анализирует сцену...");
      const t1=setTimeout(()=>setProgress("Gemini генерирует изображение..."),6000);
      const t2=setTimeout(()=>setProgress("Финализация рендера..."),20000);
      try{
        const res=await fetch("/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
          imageBase64:photo.split(",")[1],productDesc:prod.productDesc,stateDesc:curState.desc,
          frameColor:`${frameColor.name} aluminum (${frameColor.ral}, hex: ${frameColor.hex}). Powder-coated.`,
          fabricColor:hasFabric?`${fabricColor.name} premium outdoor fabric (${fabricColor.hex})`:null,
          markerX:Math.round(marker.x),markerY:Math.round(marker.y),
          customPrompt:customPrompt.trim()||null,addons,
        })});
        clearTimeout(t1);clearTimeout(t2);
        const data=await res.json();
        if(!res.ok||!data.success)throw new Error(data.error||"Generation failed");
        if(data.analysis)setSceneAnalysis(data.analysis);
        const img=`data:${data.image.mimeType};base64,${data.image.data}`;
        setResultImage(img);setStep(3);
        setHistory(prev=>[{image:img,product:prod.name,state:curState.label,color:frameColor.name,time:new Date().toLocaleTimeString("ru"),model:data.model,mode:"photo"},...prev.slice(0,9)]);
      }catch(err){clearTimeout(t1);clearTimeout(t2);setError(err.message||"Ошибка генерации");}
      finally{setLoading(false);setProgress("");}

    } else {
      // Video mode: Gemini photo → Veo API video
      setProgress("Claude Vision анализирует сцену...");
      const t1=setTimeout(()=>setProgress("Gemini генерирует фото с перголой..."),6000);
      const t2=setTimeout(()=>setProgress("Veo генерирует видео... (~60-90 сек)"),25000);
      try{
        const res=await fetch("/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
          imageBase64:photo.split(",")[1],productDesc:prod.productDesc,stateDesc:curState.desc,
          frameColor:`${frameColor.name} aluminum (${frameColor.ral}, hex: ${frameColor.hex}). Powder-coated.`,
          fabricColor:hasFabric?`${fabricColor.name} premium outdoor fabric (${fabricColor.hex})`:null,
          markerX:Math.round(marker.x),markerY:Math.round(marker.y),
          customPrompt:customPrompt.trim()||null,addons,
          generateVideo:true,
        })});
        clearTimeout(t1);clearTimeout(t2);
        const data=await res.json();
        if(!res.ok||!data.success)throw new Error(data.error||"Generation failed");
        if(data.analysis)setSceneAnalysis(data.analysis);
        const img=`data:${data.image.mimeType};base64,${data.image.data}`;
        setResultImage(img);setStep(3);
        if(data.video){
          const v=data.video;
          // Prefer base64 (already server-downloaded), fall back to URL
          const src=v.base64?`data:${v.mimeType||"video/mp4"};base64,${v.base64}`:v.url;
          setVideoResult({url:src,mimeType:v.mimeType||"video/mp4",isBase64:!!v.base64});
        } else if(data.videoError){
          setVideoError(data.videoError);
        }
        setHistory(prev=>[{image:img,product:prod.name,state:"Видео",color:frameColor.name,time:new Date().toLocaleTimeString("ru"),model:data.model,mode:"video"},...prev.slice(0,9)]);
      }catch(err){clearTimeout(t1);clearTimeout(t2);setError(err.message||"Ошибка генерации");}
      finally{setLoading(false);setProgress("");}
    }
  }


  function download(){
    if(resultImage){const a=document.createElement("a");a.href=resultImage;a.download=`igs-viz-${productId}-${Date.now()}.png`;a.click();}
  }
  function reset(){setStep(0);setPhoto(null);setMarker(null);setResultImage(null);setVideoResult(null);setVideoError("");setError("");}


  const GOLD="#b8965a";const BG="#09090b";const SURF="#111113";const BORD="rgba(255,255,255,0.07)";const DIM="rgba(255,255,255,0.28)";

  const sideBtn=(on,label,onClick,extra={})=>(
    <button onClick={onClick} style={{width:"100%",textAlign:"left",padding:"8px 12px",borderRadius:8,border:`1px solid ${on?GOLD:BORD}`,background:on?`rgba(184,150,90,0.1)`:"rgba(255,255,255,0.02)",color:on?"#fff":DIM,cursor:"pointer",fontSize:12,fontWeight:on?600:400,fontFamily:"system-ui",marginBottom:3,...extra}}>{label}</button>
  );

  return(
    <div style={{display:"flex",height:"100%",background:BG,overflow:"hidden",flexDirection:isMobile?"column":"row"}}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      {/* ── Sidebar ─────────────────────────────────────── */}
      <div style={{width:isMobile?"100%":260,flexShrink:0,borderRight:isMobile?"none":`1px solid ${BORD}`,borderBottom:isMobile?`1px solid ${BORD}`:"none",padding:14,overflowY:"auto",background:SURF,display:"flex",flexDirection:"column",gap:12,maxHeight:isMobile?280:"100%"}}>

        {step===0&&(
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontSize:13,color:DIM,marginBottom:12,lineHeight:1.6}}>Загрузите фото террасы,<br/>веранды или балкона —<br/>AI вставит продукт</div>
            <label style={{display:"inline-block",padding:"10px 22px",background:`linear-gradient(135deg,${GOLD},#9a7d4a)`,color:"#09090b",borderRadius:10,cursor:"pointer",fontSize:13,fontWeight:700}}>
              Загрузить фото
              <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files[0];e.target.value="";handleUpload(f);}}/>
            </label>
          </div>
        )}

        {step===1&&(
          <div style={{padding:10,background:"rgba(184,150,90,0.06)",border:`1px solid rgba(184,150,90,0.2)`,borderRadius:10}}>
            <div style={{fontSize:12,fontWeight:700,color:GOLD,marginBottom:4}}>Кликните на фото</div>
            <div style={{fontSize:11,color:DIM}}>Укажите место установки</div>
            {marker&&<button onClick={()=>setStep(2)} style={{marginTop:10,width:"100%",padding:"9px",background:`linear-gradient(135deg,${GOLD},#9a7d4a)`,color:"#09090b",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700,fontFamily:"system-ui"}}>Далее →</button>}
          </div>
        )}

        {step>=2&&(<>
          {error&&<div style={{padding:10,background:"rgba(196,84,84,0.08)",border:"1px solid rgba(196,84,84,0.2)",borderRadius:8,color:"#e07070",fontSize:12}}>{error}</div>}

          <div>
            <div style={{fontSize:9,color:DIM,letterSpacing:2,textTransform:"uppercase",marginBottom:6,fontWeight:700}}>Продукт</div>
            {VIZ_PRODUCTS.map(p=>sideBtn(productId===p.id,p.name,()=>{setProductId(p.id);setProdState(0);setResultImage(null);setStep(2);}))}
          </div>

          <div>
            <div style={{fontSize:9,color:DIM,letterSpacing:2,textTransform:"uppercase",marginBottom:6,fontWeight:700}}>
              Состояние <span style={{color:GOLD,fontWeight:800,fontSize:10}}>· {(prod.states[safeState]||prod.states[0]).label}</span>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:3}}>
              {prod.states.map((s,i)=>{
                const isLed=s.label.includes("LED")||s.label.includes("🌙");
                const active=prodState===i;
                return(
                  <button key={i} onClick={()=>{setProdState(i);setResultImage(null);setStep(2);}}
                    style={{
                      width:"100%",textAlign:"left",padding:"9px 12px",borderRadius:8,
                      border:`1px solid ${active?(isLed?"#f0c040":GOLD):BORD}`,
                      background:active?(isLed?"rgba(240,192,64,0.12)":"rgba(184,150,90,0.12)"):"rgba(255,255,255,0.02)",
                      color:active?"#fff":DIM,cursor:"pointer",fontSize:11,
                      fontWeight:active?700:400,fontFamily:"system-ui",
                      display:"flex",alignItems:"center",gap:8,
                      boxShadow:active?`0 0 0 1px ${isLed?"#f0c040":GOLD}`:"none",
                      transition:"all 0.15s",
                    }}>
                    <span style={{
                      width:14,height:14,borderRadius:"50%",flexShrink:0,
                      border:`2px solid ${active?(isLed?"#f0c040":GOLD):BORD}`,
                      background:active?(isLed?"#f0c040":GOLD):"transparent",
                      display:"inline-flex",alignItems:"center",justifyContent:"center",
                      fontSize:7,color:"#09090b",fontWeight:900,
                    }}>{active?"●":""}</span>
                    <span>{s.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div style={{fontSize:9,color:DIM,letterSpacing:2,textTransform:"uppercase",marginBottom:6,fontWeight:700}}>Цвет рамы</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4}}>
              {VIZ_FRAME_COLORS.map(c=>(
                <button key={c.name} onClick={()=>{setFrameColor(c);setResultImage(null);setStep(2);}} style={{padding:"6px 4px",borderRadius:7,border:`1px solid ${frameColor.name===c.name?GOLD:BORD}`,background:"rgba(255,255,255,0.02)",cursor:"pointer",textAlign:"center",fontFamily:"system-ui"}}>
                  <div style={{width:20,height:20,borderRadius:4,background:c.hex,border:"1px solid rgba(255,255,255,0.1)",margin:"0 auto 3px"}}/>
                  <div style={{fontSize:9,color:frameColor.name===c.name?"#fff":DIM}}>{c.name}</div>
                </button>
              ))}
            </div>
          </div>

          {hasFabric&&(
            <div>
              <div style={{fontSize:9,color:DIM,letterSpacing:2,textTransform:"uppercase",marginBottom:6,fontWeight:700}}>Цвет ткани</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4}}>
                {VIZ_FABRIC_COLORS.map(c=>(
                  <button key={c.name} onClick={()=>{setFabricColor(c);setResultImage(null);setStep(2);}} style={{padding:"6px 4px",borderRadius:7,border:`1px solid ${fabricColor.name===c.name?GOLD:BORD}`,background:"rgba(255,255,255,0.02)",cursor:"pointer",textAlign:"center",fontFamily:"system-ui"}}>
                    <div style={{width:20,height:20,borderRadius:4,background:c.hex,border:"1px solid rgba(255,255,255,0.1)",margin:"0 auto 3px"}}/>
                    <div style={{fontSize:9,color:fabricColor.name===c.name?"#fff":DIM}}>{c.name}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Аддоны: зип-шторы, остекление, LED ─────── */}
          <div>
            <div style={{fontSize:9,color:DIM,letterSpacing:2,textTransform:"uppercase",marginBottom:6,fontWeight:700}}>Дополнения к конструкции</div>
            {[
              {id:"zip-blinds",   label:"🪟 Зип-шторы",          desc:"Боковые шторы с направляющими", accent:GOLD},
              {id:"sliding-glass",label:"🔲 Слайдинг остекление", desc:"Стеклянное остекление периметра", accent:GOLD},
              {id:"led-lighting", label:"💡 LED подсветка",        desc:"Яркая лента по периметру рамы", accent:"#f0c040"},
            ].map(a=>{
              const on=addons.includes(a.id);
              return(
                <button key={a.id} onClick={()=>setAddons(prev=>on?prev.filter(x=>x!==a.id):[...prev,a.id])}
                  style={{width:"100%",textAlign:"left",padding:"8px 10px",borderRadius:8,border:`1px solid ${on?a.accent:BORD}`,background:on?`rgba(${a.accent==="#f0c040"?"240,192,64":"184,150,90"},0.1)`:"rgba(255,255,255,0.02)",color:on?"#fff":DIM,cursor:"pointer",fontSize:11,fontFamily:"system-ui",marginBottom:4,display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:16,lineHeight:1}}>{on?"☑":"☐"}</span>
                  <div>
                    <div style={{fontWeight:on?700:400,color:on?a.accent:undefined}}>{a.label}</div>
                    <div style={{fontSize:9,opacity:0.6,marginTop:1}}>{a.desc}</div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* ── Промпт ──────────────────────────────────── */}
          <div>
            <div style={{fontSize:9,color:DIM,letterSpacing:2,textTransform:"uppercase",marginBottom:6,fontWeight:700}}>Пожелания (необязательно)</div>
            <textarea
              value={customPrompt}
              onChange={e=>setCustomPrompt(e.target.value)}
              placeholder="Напр.: без опорных балок, крепление к стене..."
              rows={2}
              style={{width:"100%",boxSizing:"border-box",padding:"8px 10px",background:"rgba(255,255,255,0.03)",border:`1px solid ${BORD}`,borderRadius:8,color:"#ddd",fontSize:11,fontFamily:"system-ui",resize:"vertical",outline:"none",lineHeight:1.5}}
            />
          </div>

          {/* ── Режим вывода ─────────────────────────────── */}
          <div>
            <div style={{fontSize:9,color:DIM,letterSpacing:2,textTransform:"uppercase",marginBottom:6,fontWeight:700}}>Режим вывода</div>
            <div style={{display:"flex",gap:4}}>
              {[
                {id:"photo", label:"📷 Фото",    hint:"~20 сек"},
                {id:"video", label:"🎬 Veo видео",hint:"~90 сек"},
              ].map(m=>(
                <button key={m.id} onClick={()=>setOutputMode(m.id)}
                  style={{flex:1,padding:"10px 8px",borderRadius:8,border:`1px solid ${outputMode===m.id?GOLD:BORD}`,background:outputMode===m.id?"rgba(184,150,90,0.1)":"rgba(255,255,255,0.02)",color:outputMode===m.id?"#fff":DIM,cursor:"pointer",fontFamily:"system-ui",textAlign:"center"}}>
                  <div style={{fontSize:12,fontWeight:outputMode===m.id?700:400}}>{m.label}</div>
                  <div style={{fontSize:9,opacity:0.5,marginTop:2}}>{m.hint}</div>
                </button>
              ))}
            </div>
          </div>

          <button onClick={generate} disabled={loading} style={{padding:"13px",background:`linear-gradient(135deg,${GOLD},#9a7d4a)`,color:"#09090b",border:"none",borderRadius:10,cursor:loading?"not-allowed":"pointer",fontSize:14,fontWeight:700,fontFamily:"system-ui",opacity:loading?0.7:1}}>
            {loading?(progress||"Генерирую..."):(outputMode==="photo"?"✨ Визуализировать":"🎬 Сгенерировать видео")}
          </button>

          {videoError&&(
            <div style={{padding:8,background:"rgba(255,80,80,0.08)",border:"1px solid rgba(255,80,80,0.2)",borderRadius:8,color:"#ff7070",fontSize:11}}>
              ⚠️ {videoError}
            </div>
          )}

          {step===3&&resultImage&&(
            <div style={{display:"flex",flexDirection:"column",gap:6,borderTop:`1px solid ${BORD}`,paddingTop:10}}>
              {outputMode==="video"&&videoResult&&(
                <div>
                  <video src={videoResult.url} controls autoPlay loop playsInline
                    style={{width:"100%",borderRadius:8,border:`1px solid ${GOLD}`,maxHeight:180}}/>
                  <a href={videoResult.url} download={`igs-veo-${productId}-${Date.now()}.mp4`}
                    style={{display:"block",marginTop:6,padding:"9px",textAlign:"center",background:`linear-gradient(135deg,${GOLD},#9a7d4a)`,color:"#09090b",borderRadius:8,fontSize:12,fontWeight:700,textDecoration:"none"}}>
                    ⬇ Скачать видео
                  </a>
                </div>
              )}

              {/* ── Прикрепить к клиенту ── */}
              {clients&&clients.length>0&&(
                <div style={{background:"rgba(184,150,90,0.05)",border:`1px solid rgba(184,150,90,0.2)`,borderRadius:10,padding:"10px"}}>
                  <div style={{fontSize:9,color:DIM,letterSpacing:2,fontWeight:700,marginBottom:6,textTransform:"uppercase"}}>Прикрепить визуал к клиенту</div>
                  <select
                    value={attachClientId||""}
                    onChange={e=>setAttachClientId(e.target.value)}
                    style={{width:"100%",background:"rgba(255,255,255,0.06)",border:`1px solid ${BORD}`,borderRadius:7,padding:"7px 10px",color:"#fff",fontSize:12,outline:"none",fontFamily:"system-ui",marginBottom:6,colorScheme:"dark"}}>
                    <option value="">— выберите клиента —</option>
                    {[...clients].sort((a,b)=>a.name.localeCompare(b.name,"ru")).map(c=>(
                      <option key={c.id} value={c.id}>{c.name}{c.phone?" · "+c.phone:""}</option>
                    ))}
                  </select>
                  <button
                    onClick={async()=>{
                      if(!attachClientId||!resultImage||attachSaving) return;
                      setAttachSaving(true);
                      try {
                        // Convert base64 to blob and upload to Firebase Storage
                        const resp = await fetch(resultImage);
                        const blob = await resp.blob();
                        const file = new File([blob], `viz-${Date.now()}.jpg`, {type:"image/jpeg"});
                        const url = await uploadKPPhoto(file, attachClientId);
                        // Save to client.visuals array
                        const cl = clients.find(c=>c.id===attachClientId);
                        if(cl) {
                          const existing = cl.visuals || [];
                          const newVisual = {
                            url,
                            product: prod.name,
                            state: (prod.states[safeState]||prod.states[0]).label,
                            color: frameColor.name,
                            time: new Date().toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}),
                            addedAt: new Date().toISOString(),
                          };
                          const updatedVisuals = [newVisual, ...existing].slice(0, 20);
                          // Передаём через onUpdateClient если он доступен,
                          // иначе пишем напрямую (Visualizer получает clients но не onUpdateClient)
                          if (typeof window.__crmUpdateClient === "function") {
                            window.__crmUpdateClient(attachClientId, { visuals: updatedVisuals });
                          } else {
                            await dbSetClient({...cl, visuals: updatedVisuals, updatedAt: new Date().toISOString()});
                          }
                          setAttachDone(true);
                          setTimeout(()=>{setAttachDone(false);setAttachClientId("");},2500);
                        }
                      } catch(e) { alert("Ошибка загрузки: "+e.message); }
                      setAttachSaving(false);
                    }}
                    disabled={!attachClientId||attachSaving||attachDone}
                    style={{width:"100%",padding:"9px",background:attachDone?"linear-gradient(135deg,#3db96a,#2d9a54)":attachClientId?`linear-gradient(135deg,${GOLD},#9a7d4a)`:"rgba(255,255,255,0.04)",color:attachDone||attachClientId?"#09090b":DIM,border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:attachClientId&&!attachSaving?"pointer":"not-allowed",fontFamily:"system-ui",transition:"all 0.3s"}}>
                    {attachDone?"✓ Прикреплено!":attachSaving?"Загружаю в Firebase...":"📎 Прикрепить к клиенту"}
                  </button>
                </div>
              )}

              <button onClick={download} style={{padding:"10px",background:"rgba(184,150,90,0.08)",border:`1px solid ${GOLD}`,color:GOLD,borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"system-ui"}}>⬇ Скачать фото</button>
              <button onClick={()=>{setResultImage(null);setVideoResult(null);setStep(2);generate();}} disabled={loading} style={{padding:"10px",background:"rgba(255,255,255,0.03)",border:`1px solid ${BORD}`,color:DIM,borderRadius:8,cursor:"pointer",fontSize:12,fontFamily:"system-ui"}}>↺ Перегенерировать</button>
              <button onClick={reset} style={{padding:"10px",background:"rgba(255,255,255,0.03)",border:`1px solid ${BORD}`,color:DIM,borderRadius:8,cursor:"pointer",fontSize:12,fontFamily:"system-ui"}}>🔄 Новое фото</button>
            </div>
          )}
        </>)}

        {history.length>0&&(
          <div>
            <div style={{fontSize:9,color:DIM,letterSpacing:2,textTransform:"uppercase",marginBottom:6,fontWeight:700}}>История ({history.length})</div>
            {history.map((r,i)=>(
              <button key={i} onClick={()=>{setResultImage(r.image);setStep(3);}} style={{width:"100%",display:"flex",gap:8,alignItems:"center",padding:"7px 10px",borderRadius:8,border:`1px solid ${BORD}`,background:"rgba(255,255,255,0.02)",cursor:"pointer",marginBottom:3,fontFamily:"system-ui"}}>
                <img src={r.image} alt="" style={{width:36,height:36,borderRadius:5,objectFit:"cover",flexShrink:0}}/>
                <div style={{textAlign:"left"}}>
                  <div style={{fontSize:11,fontWeight:600,color:"#eae6e1"}}>{r.product}</div>
                  <div style={{fontSize:9,color:DIM}}>{r.state} · {r.color} · {r.mode==="video"?"🎬":"📷"}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>


      {/* ── Canvas ─────────────────────────────────────── */}
      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",position:"relative",background:"#060608",cursor:(step===1||step===2)?"crosshair":"default"}}
        onClick={handleCanvasClick}
        onDrop={step===0?(e)=>{e.preventDefault();handleUpload(e.dataTransfer.files[0]);}:undefined}
        onDragOver={step===0?(e)=>e.preventDefault():undefined}>

        {step===0&&(
          <div style={{textAlign:"center",padding:"40px 28px",border:`2px dashed ${BORD}`,borderRadius:20}}>
            <div style={{fontSize:42,opacity:0.2,marginBottom:12}}>📷</div>
            <div style={{fontSize:18,fontWeight:700,color:"#ccc",marginBottom:8}}>Перетащите фото сюда</div>
            <div style={{fontSize:12,color:DIM,marginBottom:20,lineHeight:1.6}}>Терраса, веранда, балкон, фасад<br/>AI вставит продукт фотореалистично</div>
            <button
              onClick={(e)=>{e.stopPropagation();fileRef.current?.click();}}
              style={{padding:"11px 28px",background:`linear-gradient(135deg,${GOLD},#9a7d4a)`,color:"#09090b",borderRadius:10,cursor:"pointer",fontSize:13,fontWeight:700,border:"none",fontFamily:"system-ui"}}>
              📷 Выбрать фото
            </button>
          </div>
        )}

        {step>=1&&photo&&(
          <div style={{position:"relative",maxWidth:"100%",maxHeight:"100%",userSelect:"none"}}>

            {/* Veo video overlay */}
            {outputMode==="video"&&videoResult&&step===3&&!loading&&(
              <div style={{position:"absolute",inset:0,zIndex:10,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.93)"}}>
                <video src={videoResult.url} controls autoPlay loop playsInline
                  style={{maxWidth:"100%",maxHeight:"calc(100% - 80px)",borderRadius:10}}/>
                <div style={{display:"flex",gap:10,marginTop:14,flexWrap:"wrap",justifyContent:"center"}}>
                  <a href={videoResult.url} download={`igs-veo-${productId}-${Date.now()}.mp4`}
                    style={{padding:"11px 26px",background:`linear-gradient(135deg,#b8965a,#9a7d4a)`,color:"#09090b",borderRadius:9,fontWeight:700,fontSize:13,textDecoration:"none",fontFamily:"system-ui"}}>
                    ⬇ Скачать видео mp4
                  </a>
                  <button onClick={()=>setVideoResult(null)}
                    style={{padding:"11px 18px",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",color:"#fff",borderRadius:9,cursor:"pointer",fontSize:13,fontFamily:"system-ui"}}>
                    ✕ Закрыть
                  </button>
                </div>
              </div>
            )}

            <img
              src={step===3&&resultImage&&!showOriginal ? resultImage : photo}
              alt="scene"
              style={{maxWidth:"100%",maxHeight:"calc(100vh - 120px)",display:"block"}}
            />

            {marker&&step<3&&(
              <div style={{position:"absolute",left:`${marker.x}%`,top:`${marker.y}%`,transform:"translate(-50%,-50%)",pointerEvents:"none"}}>
                <div style={{width:44,height:44,borderRadius:"50%",border:`2px solid ${GOLD}`,background:`rgba(184,150,90,0.15)`,display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <span style={{color:GOLD,fontSize:22}}>+</span>
                </div>
              </div>
            )}

            {loading&&(
              <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.65)",backdropFilter:"blur(6px)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
                <div style={{width:44,height:44,border:"3px solid #222",borderTopColor:GOLD,borderRadius:"50%",animation:"spin 0.7s linear infinite",marginBottom:14}}/>
                <div style={{color:"#fff",fontSize:14,fontWeight:600,textAlign:"center",padding:"0 20px"}}>{progress}</div>
                {outputMode==="video"&&<div style={{color:DIM,fontSize:11,marginTop:8,textAlign:"center"}}>Veo генерирует видео...<br/>~60-90 секунд</div>}
              </div>
            )}

            {step===3&&resultImage&&!loading&&(
              <div style={{position:"absolute",top:10,left:10,display:"flex",gap:6,flexWrap:"wrap"}}>
                {outputMode==="photo"&&(
                  <button onMouseDown={()=>setShowOriginal(true)} onMouseUp={()=>setShowOriginal(false)} onMouseLeave={()=>setShowOriginal(false)}
                    style={{padding:"5px 12px",background:"rgba(0,0,0,0.6)",border:`1px solid ${BORD}`,color:showOriginal?"#fff":GOLD,borderRadius:6,cursor:"pointer",fontSize:11,fontWeight:600,backdropFilter:"blur(8px)",fontFamily:"system-ui"}}>
                    {showOriginal?"Оригинал":"Удерж. = оригинал"}
                  </button>
                )}
                {outputMode==="video"&&videoResult&&(
                  <div style={{padding:"5px 12px",background:"rgba(0,0,0,0.6)",border:`1px solid ${GOLD}`,color:GOLD,borderRadius:6,fontSize:11,fontWeight:600,backdropFilter:"blur(8px)",fontFamily:"system-ui"}}>
                    🎬 Veo видео готово
                  </div>
                )}
              </div>
            )}

            {step===1&&!marker&&(
              <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none"}}>
                <div style={{padding:"11px 22px",background:"rgba(0,0,0,0.7)",backdropFilter:"blur(8px)",color:"#fff",fontSize:13,fontWeight:600,borderRadius:10}}>
                  + Кликните куда установить конструкцию
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CRM({currentUser:propUser,onShowUserManager:propShowUM,onLogout:propLogout}){
  const isMobile=useIsMobile();
  const[page,setPage]=useState(()=>{
    const init=window.__IGS_INIT_PAGE__;
    if(init){delete window.__IGS_INIT_PAGE__;return init;}
    const urlPage = new URLSearchParams(window.location.search).get("page");
    const validPages = ["dashboard","clients","calculator","catalog","meetings","bot_leads","glass","prices","kp_templates","visualizer","trello"];
    if(urlPage && validPages.includes(urlPage)) return urlPage;
    return "dashboard";
  });
  const[clients,setClients]=useState([]);
  const[selectedClientId,setSelectedClientId]=useState(null);
  const[loading,setLoading]=useState(true);
  const[storageStatus,setStorageStatus]=useState("idle");
  const[syncStatus,setSyncStatus]=useState("idle");
  const[pricesVersion,setPricesVersion]=useState(0);
  const[kpClientId,setKpClientId]=useState(null);
  const[kpItems,setKpItems]=useState([]);
  const[kpStep,setKpStep]=useState(1);
  const[kpDiscount,setKpDiscount]=useState(0);

  const currentUser=propUser||{login:"zhan",role:"admin"};
  const onLogout=propLogout||(()=>{});
  const onShowUserManager=propShowUM||null;

  // Уникальный ID этой вкладки — чтобы listener знал когда данные от НАС
  const DEVICE_ID = useRef(
    sessionStorage.getItem("igs_device_id") || (()=>{
      const id="d_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,6);
      sessionStorage.setItem("igs_device_id",id); return id;
    })()
  );

  // Время последней нашей записи по clientId.
  // Listener игнорирует эхо если оно пришло раньше чем через 5 сек после записи.
  const lastWriteTs = useRef(new Map());

  const clientsRef=useRef([]);
  const[customProducts,setCustomProducts]=useState([]);
  const[catalogVersion,setCatalogVersion]=useState(0);

  function handleAddProduct(product){
    const updated=[...customProducts,product];
    setCustomProducts(updated);saveCustomProducts(updated);mergeProducts(updated);setCatalogVersion(v=>v+1);
  }
  function handleDeleteProduct(id){
    const updated=customProducts.filter(p=>p.id!==id);
    setCustomProducts(updated);saveCustomProducts(updated);mergeProducts(updated);setCatalogVersion(v=>v+1);
  }

  useEffect(()=>{
    // ─── АРХИТЕКТУРА СИНХРОНИЗАЦИИ ────────────────────────────────────────────
    // Единственный источник правды: Firebase Realtime DB
    // Порядок загрузки:
    //   1. localStorage → мгновенный показ (пока Firebase грузится)
    //   2. Firebase onValue snapshot → ОДИН вызов с полным списком → мерж
    //   3. onChildChanged/Removed → точечные живые обновления
    //   4. onChildAdded (только новые, после snapshot) → новый клиент от другого юзера
    //
    // НЕТ race condition: snapshot приходит один раз, живые обновления — точечно.
    // НЕТ дублирования: dbGetClients() убран, всё через один listener.

    // 1) Показываем localStorage мгновенно
    const customLocal=loadCustomProducts();
    setCustomProducts(customLocal);mergeProducts(customLocal);
    applyPrices(loadPrices());
    const localClients=loadClients();
    setClients(localClients);clientsRef.current=localClients;
    setLoading(false);

    // 2+3+4) Один listener — три роли
    setSyncStatus("syncing");

    // Загружаем цены и кастомные продукты параллельно
    dbGet("prices").then(fbPrices=>{
      if(fbPrices){applyPrices(fbPrices);localStorage.setItem(PRICES_KEY,JSON.stringify(fbPrices));}
    }).catch(()=>{});
    dbGet("custom_products").then(fbCustomProds=>{
      if(Array.isArray(fbCustomProds)&&fbCustomProds.length>0){
        setCustomProducts(fbCustomProds);mergeProducts(fbCustomProds);
        localStorage.setItem(CUSTOM_PRODUCTS_KEY,JSON.stringify(fbCustomProds));
        setCatalogVersion(v=>v+1);
      }
    }).catch(()=>{});

    const unsubClients = dbListenClientPatches(
      // onPatch — живые обновления (changed/removed/added после snapshot)
      (type, remote) => {
        if (!remote?.id) return;
        const now = Date.now();
        // Эхо-фильтр: игнорируем свои записи 5 сек
        if (now - (lastWriteTs.current.get(remote.id)||0) < 5000) return;

        if (type === "removed") {
          setClients(prev => {
            const next = prev.filter(c => c.id !== remote.id);
            try{localStorage.setItem(STORAGE_KEY,JSON.stringify(next));}catch(_){}
            clientsRef.current = next;
            return next;
          });
          return;
        }
        // added | changed
        setClients(prev => {
          const idx = prev.findIndex(c => c.id === remote.id);
          if (idx === -1) {
            // Новый клиент
            const next = [remote, ...prev];
            try{localStorage.setItem(STORAGE_KEY,JSON.stringify(next));}catch(_){}
            clientsRef.current = next;
            setSyncStatus("ok"); setTimeout(()=>setSyncStatus("idle"),1000);
            return next;
          }
          // Обновляем если Firebase новее
          const tL = new Date(prev[idx].updatedAt||prev[idx].createdAt||0).getTime();
          const tR = new Date(remote.updatedAt||remote.createdAt||0).getTime();
          if (tR <= tL + 500) return prev;
          const next = [...prev];
          next[idx] = {...remote, tasks: mergeTasks(prev[idx].tasks, remote.tasks)};
          try{localStorage.setItem(STORAGE_KEY,JSON.stringify(next));}catch(_){}
          clientsRef.current = next;
          setSyncStatus("ok"); setTimeout(()=>setSyncStatus("idle"),1000);
          return next;
        });
      },
      // onSnapshotReady — ОДИН вызов с полным списком из Firebase
      (fbArr) => {
        setClients(prev => {
          // prev = localStorage клиенты (загружены в шаге 1)
          // fbArr = полный список из Firebase
          // Мерж: для каждого ID берём более новую версию
          const localMap = new Map(prev.filter(c=>c&&c.id).map(c=>[c.id,c]));
          const fbMap    = new Map(fbArr.filter(c=>c&&c.id).map(c=>[c.id,c]));
          const allIds   = new Set([...localMap.keys(), ...fbMap.keys()]);
          const merged   = [];
          const toUpload = []; // офлайн-созданные → загрузить в Firebase

          for (const id of allIds) {
            const loc = localMap.get(id);
            const fb  = fbMap.get(id);
            if (!fb && loc) {
              // Только локально (офлайн) → сохраняем и загружаем
              merged.push(loc);
              toUpload.push(loc);
            } else if (!loc && fb) {
              // Только в Firebase → принимаем
              merged.push(fb);
            } else if (loc && fb) {
              const tL = new Date(loc.updatedAt||loc.createdAt||0).getTime();
              const tF = new Date(fb.updatedAt||fb.createdAt||0).getTime();
              if (tL >= tF) {
                // Локальная новее → держим, мержим задачи
                const c = {...loc, tasks: mergeTasks(loc.tasks, fb.tasks)};
                merged.push(c);
                if (tL > tF + 500) toUpload.push(c);
              } else {
                // Firebase новее → принимаем, мержим задачи
                merged.push({...fb, tasks: mergeTasks(loc.tasks, fb.tasks)});
              }
            }
          }

          // Загружаем офлайн-клиентов в Firebase
          toUpload.forEach(c => {
            lastWriteTs.current.set(c.id, Date.now());
            dbSetClient(c).catch(()=>{});
          });

          const result = merged.filter(Boolean);
          try{localStorage.setItem(STORAGE_KEY,JSON.stringify(result));}catch(_){}
          clientsRef.current = result;
          setSyncStatus("ok"); setTimeout(()=>setSyncStatus("idle"),2000);
          return result;
        });
      }
    );

    // 4) Цены
    const unsubPrices=dbListen("prices",(data)=>{
      if(data){applyPrices(data);localStorage.setItem(PRICES_KEY,JSON.stringify(data));setPricesVersion(v=>v+1);}
    });

    // 5) Кастомные продукты
    const unsubCustomProds=dbListen("custom_products",(data)=>{
      if(Array.isArray(data)){
        setCustomProducts(prev=>{
          const map=new Map();(prev||[]).forEach(p=>p&&p.id&&map.set(p.id,p));
          data.forEach(p=>p&&p.id&&map.set(p.id,p));
          const merged=Array.from(map.values());
          mergeProducts(merged);localStorage.setItem(CUSTOM_PRODUCTS_KEY,JSON.stringify(merged));
          return merged;
        });setCatalogVersion(v=>v+1);
      }
    });

    return()=>{unsubClients();unsubPrices();unsubCustomProds();};
  },[]);

  useEffect(()=>{
    clientsRef.current=clients;
    if(loading) return;
    saveClients(clients);
  },[clients]);

  useEffect(()=>{
    if(loading) return;
    const snap=()=>{
      if(!clients.length) return;
      const now=new Date(),dk=now.toISOString().slice(0,10),tk=now.toTimeString().slice(0,5).replace(":","-");
      dbSet("snapshots/latest",{clients:clients.map(c=>({id:c.id,name:c.name,phone:c.phone||"",address:c.address||"",status:c.status,kpsCount:(c.kps||[]).length,lastKP:(c.kps||[])[0]?.total||0,activeTasks:(c.tasks||[]).filter(t=>!t.done).length,updatedAt:c.updatedAt})),count:clients.length,savedAt:now.toISOString()});
      dbSet(`snapshots/daily/${dk}/${tk}`,{count:clients.length,savedAt:now.toISOString()});
      runBackup(clients);
    };
    snap();const iv=setInterval(snap,5*60*1000);return()=>clearInterval(iv);
  },[loading,clients]);

  useEffect(()=>{
    if(loading) return;
    const h=()=>{try{localStorage.setItem(STORAGE_KEY,JSON.stringify(clients));}catch(_){}};
    window.addEventListener("beforeunload",h);return()=>window.removeEventListener("beforeunload",h);
  },[loading,clients]);

  const[gdriveStatus,setGdriveStatus]=useState("idle");
  const[gdriveInfo,setGdriveInfo]=useState(null);

  async function backupToGDrive(silent=false){
    if(!clients.length) return;
    if(!silent) setGdriveStatus("saving");
    try{
      const res=await fetch("/api/gdrive-backup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clients})});
      const data=await res.json();
      if(!res.ok){setGdriveStatus(data.error?.includes("не настроен")?"unconfigured":"error");return;}
      setGdriveStatus("ok");setGdriveInfo(data);setTimeout(()=>setGdriveStatus("idle"),3000);
    }catch(e){setGdriveStatus("error");}
  }

  useEffect(()=>{
    if(loading||!clients.length) return;
    const KEY="igs_gdrive_last_backup";
    if((Date.now()-parseInt(localStorage.getItem(KEY)||"0"))/(1000*3600)>=24){
      backupToGDrive(true);localStorage.setItem(KEY,Date.now().toString());
    }
    const iv=setInterval(()=>{backupToGDrive(true);localStorage.setItem(KEY,Date.now().toString());},24*60*60*1000);
    return()=>clearInterval(iv);
  },[loading]);

  // CRUD — записываем timestamp ДО отправки в Firebase
  // Listener проигнорирует эхо в течение 5 секунд после записи
  function addClient(data){
    // Используем crypto.randomUUID() вместо Date.now() — гарантированная уникальность
    // даже если два пользователя добавляют клиента в одну миллисекунду
    const uid = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
    const c={id:uid,...data,status:"lead",kps:[],tasks:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    setClients(prev=>{const updated=[c,...prev];try{localStorage.setItem(STORAGE_KEY,JSON.stringify(updated));}catch(_){}return updated;});
    setStorageStatus("saving");setTimeout(()=>{setStorageStatus("saved");setTimeout(()=>setStorageStatus("idle"),1200);},400);
    lastWriteTs.current.set(c.id,Date.now());
    // dbSetClient пишет только clients/{id} — не затрагивает других клиентов
    dbSetClient(c).catch(()=>setTimeout(()=>{lastWriteTs.current.set(c.id,Date.now());dbSetClient(c).catch(()=>{});},3000));
    return c;
  }

  function updateClient(id,data){
    const existing=clientsRef.current.find(c=>c.id===id)||{};
    const updatedClient={...existing,...data,id,updatedAt:new Date().toISOString()};
    setClients(prev=>{const updated=prev.map(c=>c.id!==id?c:updatedClient);try{localStorage.setItem(STORAGE_KEY,JSON.stringify(updated));}catch(_){}return updated;});
    setStorageStatus("saving");setTimeout(()=>{setStorageStatus("saved");setTimeout(()=>setStorageStatus("idle"),1200);},400);
    lastWriteTs.current.set(id,Date.now());
    // dbSetClient пишет только clients/{id} — атомарная операция
    dbSetClient(updatedClient).catch(()=>{
      let att=0;
      const retry=()=>{if(att++>4)return;setTimeout(()=>{lastWriteTs.current.set(id,Date.now());dbSetClient(updatedClient).catch(retry);},2000*att);};
      retry();
    });
    if(window._gdriveBackupTimer) clearTimeout(window._gdriveBackupTimer);
    window._gdriveBackupTimer=setTimeout(()=>backupToGDrive(true),30000);
  }

  function deleteClient(id){
    setClients(prev=>{const updated=prev.filter(c=>c.id!==id);try{localStorage.setItem(STORAGE_KEY,JSON.stringify(updated));}catch(_){}return updated;});
    lastWriteTs.current.delete(id);
    // dbDeleteClient пишет clients/{id}=null — атомарно, не затрагивает других клиентов
    dbDeleteClient(id).catch(()=>setTimeout(()=>dbDeleteClient(id).catch(()=>{}),3000));
  }

  function saveKP(clientId,items,discount){
    const kp={id:Date.now().toString(),items,discount,total:items.reduce((s,i)=>s+calcItem(i),0)*(1-discount/100),createdAt:new Date().toISOString()};
    const existing=clientsRef.current.find(c=>c.id===clientId)||{};
    const updC={...existing,kps:[kp,...(existing.kps||[])],status:existing.status==="lead"?"kp_sent":existing.status,updatedAt:new Date().toISOString()};
    setClients(prev=>{const updated=prev.map(c=>c.id!==clientId?c:updC);try{localStorage.setItem(STORAGE_KEY,JSON.stringify(updated));}catch(_){}return updated;});
    lastWriteTs.current.set(clientId,Date.now());
    dbSetClient(updC).catch(()=>setTimeout(()=>{lastWriteTs.current.set(clientId,Date.now());dbSetClient(updC).catch(()=>{});},3000));
  }

  function goToClient(id){setSelectedClientId(id);setPage("client-detail");}
  function startKP(clientId=null,existingKP=null){
    setKpClientId(clientId);
    if(existingKP){setKpItems(existingKP.items||[]);setKpDiscount(existingKP.discount||0);setKpStep(3);}
    else{setKpItems([]);setKpDiscount(0);setKpStep(1);}
    setPage("calculator");
  }

  const selectedClient=clients.find(c=>c.id===selectedClientId);

  if(loading)return(
    <div style={{minHeight:"100vh",background:T.bg,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
      <GlobalStyles/>
      <div style={{color:T.gold,fontFamily:T.serif,fontSize:20}}>IGS Outdoor</div>
      <div style={{color:T.textDim,fontFamily:T.font,fontSize:12}}>Загрузка…</div>
    </div>
  );

  const showNav=page!=="client-detail";
  const dashProps={clients,onGoToClient:goToClient,onStartKP:startKP,onGoToPage:setPage,currentUser,onLogout,onShowUserManager,onGDriveBackup:backupToGDrive,gdriveStatus,gdriveInfo};
  const calcProps={clients,kpClientId,setKpClientId,kpItems,setKpItems,kpStep,setKpStep,kpDiscount,setKpDiscount,onSaveKP:saveKP,onAddClient:addClient};

  // Делаем updateClient доступным глобально для Visualizer (он не получает onUpdateClient через props)
  window.__crmUpdateClient = updateClient;

  if(!isMobile)return(
    <div style={{display:"flex",minHeight:"100vh",background:T.bg}}>
      <GlobalStyles/>
      <StorageBadge status={storageStatus} syncStatus={syncStatus} page={page} isMobile={false}/>
      {showNav&&<Sidebar page={page} setPage={setPage} currentUser={currentUser} onLogout={onLogout} onShowUserManager={onShowUserManager}/>}
      <main style={{flex:1,marginLeft:showNav?220:0,padding:"32px 40px",minHeight:"100vh",overflowY:"auto"}}>
        {page==="dashboard"&&<Dashboard {...dashProps} isMobile={false}/>}
        {page==="clients"&&<ClientList clients={clients} onGoToClient={goToClient} onAddClient={addClient} onDeleteClient={id=>{deleteClient(id);}} isMobile={false} currentUser={currentUser}/>}
        {page==="client-detail"&&selectedClient&&<ClientDetail client={selectedClient} onBack={()=>setPage("clients")} onUpdate={data=>updateClient(selectedClient.id,data)} onDelete={()=>{deleteClient(selectedClient.id);setPage("clients");}} onStartKP={(cid,kp)=>startKP(cid||selectedClient.id,kp)} isMobile={false} currentUser={currentUser}/>}
        {page==="calculator"&&<Calculator key={pricesVersion} {...calcProps} isMobile={false}/>}
        {page==="catalog"&&<Catalog key={catalogVersion} isMobile={false} currentUser={currentUser} onAddProduct={handleAddProduct} onDeleteProduct={handleDeleteProduct}/>}
        {page==="meetings"&&<Meetings isMobile={false} clients={clients}/>}
        {page==="bot_leads"&&<BotLeads isMobile={false}/>}
        {page==="glass"&&<GlassCalc isMobile={false}/>}
        {page==="prices"&&can(currentUser,"edit_prices")&&<PriceEditor key={pricesVersion} onPricesChanged={()=>setPricesVersion(v=>v+1)} isMobile={false}/>}
        {page==="kp_templates"&&can(currentUser,"edit_prices")&&<KPEditor isMobile={false}/>}
        {page==="visualizer"&&can(currentUser,"view_calculator")&&<div style={{height:"calc(100vh - 52px)"}}><Visualizer isMobile={false} clients={clients}/></div>}
        {page==="trello"&&<KanbanBoard isMobile={false} clients={clients} onUpdateClient={updateClient}/>}
      </main>
      <AIAssistant
        clients={clients}
        products={PRODUCTS}
        onAddClient={addClient}
        onUpdateClient={updateClient}
        onStartKP={startKP}
        onGoToClient={goToClient}
        onGoToPage={setPage}
        isMobile={false}
      />
    </div>
  );

  return(
    <div style={{background:T.bg,minHeight:"100vh"}}>
      <GlobalStyles/>
      <StorageBadge status={storageStatus} syncStatus={syncStatus} page={page} isMobile={true}/>
      {page==="dashboard"&&<Dashboard {...dashProps} isMobile/>}
      {page==="clients"&&<div style={{padding:"16px 0 0"}}><ClientList clients={clients} onGoToClient={goToClient} onAddClient={addClient} onDeleteClient={id=>{deleteClient(id);}} isMobile currentUser={currentUser}/></div>}
      {page==="client-detail"&&selectedClient&&<ClientDetail client={selectedClient} onBack={()=>setPage("clients")} onUpdate={data=>updateClient(selectedClient.id,data)} onDelete={()=>{deleteClient(selectedClient.id);setPage("clients");}} onStartKP={(cid,kp)=>startKP(cid||selectedClient.id,kp)} isMobile currentUser={currentUser}/>}
      {page==="calculator"&&<div style={{padding:"16px 13px 0"}}><Calculator {...calcProps} key={pricesVersion} isMobile/></div>}
      {page==="catalog"&&<Catalog key={catalogVersion} isMobile currentUser={currentUser} onAddProduct={handleAddProduct} onDeleteProduct={handleDeleteProduct}/>}
      {page==="bot_leads"&&<div style={{padding:"16px 13px 0"}}><BotLeads isMobile/></div>}
      {page==="meetings"&&<div style={{padding:"16px 13px 0"}}><Meetings isMobile clients={clients}/></div>}
      {page==="glass"&&<div style={{padding:"16px 13px 0"}}><GlassCalc isMobile/></div>}
      {page==="prices"&&can(currentUser,"edit_prices")&&<div style={{padding:"16px 13px 0"}}><PriceEditor key={pricesVersion} onPricesChanged={()=>setPricesVersion(v=>v+1)} isMobile/></div>}
      {page==="kp_templates"&&can(currentUser,"edit_prices")&&<KPEditor isMobile/>}
        {page==="visualizer"&&can(currentUser,"view_calculator")&&<div style={{height:"calc(100vh - 110px)"}}><Visualizer isMobile clients={clients}/></div>}
      {page==="trello"&&<div style={{padding:"16px 13px 0"}}><KanbanBoard isMobile clients={clients} onUpdateClient={updateClient}/></div>}
      {showNav&&<BottomNav page={page} setPage={setPage} currentUser={currentUser}/>}
      <NotifPermissionBanner/>
      <AIAssistant
        clients={clients}
        products={PRODUCTS}
        onAddClient={addClient}
        onUpdateClient={updateClient}
        onStartKP={startKP}
        onGoToClient={goToClient}
        onGoToPage={setPage}
        isMobile={true}
      />
    </div>
  );
}