// firebase.js — надёжное хранение данных IGS Outdoor CRM
// АРХИТЕКТУРА СИНХРОНИЗАЦИИ (несколько пользователей одновременно):
//   Firebase Realtime DB хранит clients/{clientId} — каждый клиент отдельный узел.
//   Это ключевое решение: два пользователя никогда не затирают друг друга целиком —
//   каждый пишет только свой клиент, Firebase слияние происходит на уровне дерева.
//
//   Уровни защиты:
//   1. Запись в IndexedDB  — надёжнее localStorage, выживает закрытие вкладки
//   2. Запись в localStorage — быстрый кэш
//   3. Запись в Firebase Realtime DB — clients/{id} по-одному (НЕ массивом)
//   4. Очередь повторных попыток — если Firebase недоступен, запись ставится в очередь
//      и отправляется автоматически при восстановлении соединения
//   5. Ежедневные + еженедельные бэкапы в Firebase

import { initializeApp } from "firebase/app";
import {
  getDatabase, ref, set, get, onValue, off,
  onChildAdded, onChildChanged, onChildRemoved
} from "firebase/database";
import {
  getStorage, ref as sRef, uploadBytes, getDownloadURL, deleteObject
} from "firebase/storage";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

const firebaseConfig = {
  apiKey:            "AIzaSyAs9o4Q7Td6sZ37E-qnBaNKi3bsD0Y8BAs",
  authDomain:        "igs-crm-59901.firebaseapp.com",
  databaseURL:       "https://igs-crm-59901-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "igs-crm-59901",
  storageBucket:     "igs-crm-59901.firebasestorage.app",
  messagingSenderId: "160461403127",
  appId:             "1:160461403127:web:1819c36739b7e0586a74f2",
  measurementId:     "G-1HH187BK82",
};

// ─── INIT ─────────────────────────────────────────────────────────────────────

let app      = null;
let db       = null;
let storage  = null;
let auth     = null;
let isFirebaseReady  = false;
let isAuthenticated  = false;
let isConnected      = false;
let authReady        = null;

try {
  app     = initializeApp(firebaseConfig);
  db      = getDatabase(app);
  storage = getStorage(app);
  auth    = getAuth(app);
  isFirebaseReady = true;

  // Следим за соединением
  onValue(ref(db, ".info/connected"), snap => {
    isConnected = snap.val() === true;
    if (isConnected) flushWriteQueue();
  });

  // Анонимная авторизация — нужна для Storage и защищённых Rules.
  // НО: если Rules = true/true (как сейчас) — работаем и без auth.
  // isAuthenticated используется ТОЛЬКО для Storage uploads, не для dbSet/dbListen.
  authReady = new Promise((resolve) => {
    // Резолвим сразу — не блокируем запись на ожидание auth
    resolve(null);
    // Параллельно пытаемся войти анонимно (для Storage)
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        isAuthenticated = true;
      } else {
        try {
          await signInAnonymously(auth);
          isAuthenticated = true;
        } catch (e) {
          console.warn("Firebase anon auth failed (Storage may not work):", e.message);
        }
      }
    });
  });

} catch (e) {
  console.error("Firebase init error:", e);
  authReady = Promise.resolve(null);
}

async function waitAuth() {
  // Не ждём auth — Firebase Rules открыты (true/true)
  // Запись работает без авторизации
  if (authReady) await authReady;
}

// ─── INDEXEDDB ────────────────────────────────────────────────────────────────

const IDB_NAME    = "igs_crm_store";
const IDB_VERSION = 2;
const IDB_CACHE   = "cache";
const IDB_QUEUE   = "write_queue";

let idb = null;

function openIDB() {
  return new Promise((resolve) => {
    if (idb) return resolve(idb);
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_CACHE))  db.createObjectStore(IDB_CACHE,  { keyPath: "path" });
        if (!db.objectStoreNames.contains(IDB_QUEUE))  db.createObjectStore(IDB_QUEUE,  { keyPath: "id", autoIncrement: true });
      };
      req.onsuccess  = e => { idb = e.target.result; resolve(idb); };
      req.onerror    = ()  => resolve(null);
    } catch(_) { resolve(null); }
  });
}

async function idbSet(store, key, value) {
  try {
    const db = await openIDB();
    if (!db) return;
    return new Promise((res, rej) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(store === IDB_CACHE
        ? { path: key, data: value, ts: Date.now() }
        : { ...value });
      tx.oncomplete = res;
      tx.onerror    = rej;
    });
  } catch(_) {}
}

async function idbGet(store, key) {
  try {
    const db = await openIDB();
    if (!db) return null;
    return new Promise((res) => {
      const tx  = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => res(req.result?.data ?? null);
      req.onerror   = () => res(null);
    });
  } catch(_) { return null; }
}

async function idbGetAll(store) {
  try {
    const db = await openIDB();
    if (!db) return [];
    return new Promise((res) => {
      const tx  = db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => res([]);
    });
  } catch(_) { return []; }
}

async function idbDelete(store, key) {
  try {
    const db = await openIDB();
    if (!db) return;
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
  } catch(_) {}
}

// ─── ОЧЕРЕДЬ ЗАПИСИ ──────────────────────────────────────────────────────────

async function addToWriteQueue(path, data) {
  // Используем null для autoIncrement key
  const db = await openIDB();
  if (!db) return;
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_QUEUE, "readwrite");
    tx.objectStore(IDB_QUEUE).put({ path, data: JSON.stringify(data), ts: Date.now() });
    tx.oncomplete = res;
    tx.onerror = rej;
  }).catch(() => {});
}

let flushing = false;
async function flushWriteQueue() {
  if (flushing || !isConnected) return;
  flushing = true;
  try {
    const items = await idbGetAll(IDB_QUEUE);
    if (items.length === 0) return;
    // Дедупликация: для каждого path берём последнюю запись
    const deduped = new Map();
    for (const item of items) deduped.set(item.path, item);
    for (const item of items) {
      if (deduped.get(item.path) !== item) await idbDelete(IDB_QUEUE, item.id);
    }
    await waitAuth();
    for (const item of deduped.values()) {
      try {
        await set(ref(db, item.path), JSON.parse(item.data));
        await idbDelete(IDB_QUEUE, item.id);
      } catch(e) {
        console.warn("Queue flush failed for", item.path, e.message);
      }
    }
  } finally {
    flushing = false;
  }
}

// ─── DATABASE ─────────────────────────────────────────────────────────────────

export async function dbSet(path, data) {
  // 1. IndexedDB
  await idbSet(IDB_CACHE, path, data);
  // 2. localStorage
  try { localStorage.setItem("igs_" + path, JSON.stringify(data)); } catch(_) {}
  // 3. Firebase — пишем как только SDK инициализирован и есть соединение
  // НЕ ждём isAuthenticated — Rules открыты (true/true), auth не нужен для записи
  if (isFirebaseReady && db) {
    if (isConnected) {
      try {
        await set(ref(db, path), data);
        return true;
      } catch(e) {
        console.error(`[Firebase] dbSet("${path}") failed:`, e.code, e.message);
        if (typeof window !== "undefined") {
          window.__firebaseError = { path, code: e.code, message: e.message, ts: Date.now() };
        }
        await addToWriteQueue(path, data);
        return false;
      }
    } else {
      // Нет соединения — в очередь, отправим при reconnect
      await addToWriteQueue(path, data);
      return false;
    }
  }
  return true;
}

export async function dbGet(path, defaultValue = null) {
  if (isFirebaseReady && db) {
    try {
      const snap = await get(ref(db, path));
      if (snap.exists()) {
        const val = snap.val();
        await idbSet(IDB_CACHE, path, val);
        try { localStorage.setItem("igs_" + path, JSON.stringify(val)); } catch(_) {}
        return val;
      }
      return defaultValue;
    } catch(e) {
      console.warn("dbGet Firebase failed, using cache:", path);
    }
  }
  const cached = await idbGet(IDB_CACHE, path);
  if (cached !== null) return cached;
  try {
    const ls = JSON.parse(localStorage.getItem("igs_" + path) || "null");
    if (ls !== null) return ls;
  } catch(_) {}
  return defaultValue;
}

export function dbListen(path, callback) {
  if (!isFirebaseReady || !db) return () => {};
  const r = ref(db, path);
  let subscribed = false;
  let cancelled = false;
  // Подписываемся сразу — Rules открыты, auth не нужен для чтения
  Promise.resolve().then(() => {
    if (cancelled) return;
    onValue(
      r,
      snap => {
        if (snap.exists()) {
          const val = snap.val();
          idbSet(IDB_CACHE, path, val);
          try { localStorage.setItem("igs_" + path, JSON.stringify(val)); } catch(_) {}
          callback(val);
        } else {
          // Узел пустой или удалён — вызываем callback с пустым значением
          // чтобы UI мог среагировать (например удаление последнего клиента)
          if (path === "clients") callback({});
        }
      },
      error => {
        // PERMISSION_DENIED или другая ошибка — делаем её видимой
        console.error(`[Firebase] dbListen("${path}") error:`, error.code, error.message);
        if (typeof window !== "undefined") {
          window.__firebaseError = { path, code: error.code, message: error.message, ts: Date.now() };
        }
      }
    );
    subscribed = true;
  });
  return () => {
    cancelled = true;
    if (subscribed) off(r);
  };
}

// ─── СПЕЦИАЛИЗИРОВАННЫЕ ФУНКЦИИ ДЛЯ КЛИЕНТОВ ─────────────────────────────────
// Каждый клиент хранится отдельно: clients/{clientId}
// Это гарантирует что два пользователя никогда не затирают друг друга целиком.

/**
 * Сохранить одного клиента. Использовать вместо dbSet("clients", arr).
 */
export async function dbSetClient(client) {
  if (!client?.id) return false;
  return dbSet(`clients/${client.id}`, client);
}

/**
 * Удалить одного клиента.
 */
export async function dbDeleteClient(clientId) {
  return dbSet(`clients/${clientId}`, null);
}

/**
 * Получить всех клиентов как массив (одноразово).
 */
export async function dbGetClients() {
  const data = await dbGet("clients", null);
  if (!data) return [];
  if (Array.isArray(data)) return data.filter(Boolean);
  if (typeof data === "object") return Object.values(data).filter(Boolean);
  return [];
}

/**
 * Realtime listener на всех клиентов.
 * Firebase вызывает callback при ЛЮБОМ изменении любого clients/{id}.
 * callback получает массив клиентов.
 */
export function dbListenClients(callback) {
  return dbListen("clients", (raw) => {
    let arr;
    if (Array.isArray(raw)) arr = raw.filter(Boolean);
    else if (raw && typeof raw === "object") arr = Object.values(raw).filter(Boolean);
    else arr = [];
    callback(arr);
  });
}

/**
 * Главный listener для синхронизации клиентов.
 * 
 * Работает в два режима:
 * 
 * 1. НАЧАЛЬНАЯ ЗАГРУЗКА: onValue даёт полный снапшот — один вызов, нет race condition.
 *    onSnapshotReady(allClients) вызывается ОДИН раз с полным массивом.
 * 
 * 2. ЖИВЫЕ ОБНОВЛЕНИЯ: onChildChanged/Removed для точечных изменений после загрузки.
 *    onPatch(type, client) вызывается для каждого изменения.
 *    onChildAdded после начальной загрузки = только реально новые клиенты.
 */
export function dbListenClientPatches(onPatch, onSnapshotReady) {
  if (!isFirebaseReady || !db) return () => {};
  const r = ref(db, "clients");
  let cancelled = false;
  const unsubs = [];
  let initialLoadDone = false;

  Promise.resolve().then(() => {
    if (cancelled) return;

    // Шаг 1: один раз читаем полный снапшот
    const valueUnsub = onValue(r, snap => {
      if (cancelled) return;
      if (!initialLoadDone) {
        // Первый вызов — полный список
        initialLoadDone = true;
        const raw = snap.exists() ? snap.val() : {};
        let arr;
        if (Array.isArray(raw)) arr = raw.filter(Boolean);
        else arr = Object.values(raw).filter(v => v && v.id);
        if (onSnapshotReady) onSnapshotReady(arr);
      }
      // После первого вызова valueUnsub не нужен — отписываемся
    }, err => console.error("[Firebase] onValue(clients) error:", err.code));

    // Шаг 2: точечные обновления (changed, removed)
    // onChildAdded пропускаем — он дублирует начальный onValue и вызывает race condition
    const changedUnsub = onChildChanged(r, snap => {
      if (!initialLoadDone) return; // ждём пока snapshot готов
      const val = snap.val();
      if (val && val.id) onPatch("changed", val);
    }, err => console.error("[Firebase] onChildChanged error:", err.code));

    const removedUnsub = onChildRemoved(r, snap => {
      if (!initialLoadDone) return;
      const id = snap.key;
      const val = snap.val();
      onPatch("removed", val || { id });
    }, err => console.error("[Firebase] onChildRemoved error:", err.code));

    // onChildAdded — только для клиентов добавленных ПОСЛЕ начальной загрузки
    // Используем флаг чтобы пропустить начальные вызовы
    let addedSkipCount = -1; // -1 = ещё не знаем сколько пропустить
    const addedUnsub = onChildAdded(r, snap => {
      if (!initialLoadDone) return;
      // Пропускаем первые N вызовов (существующие клиенты уже в snapshot)
      // onChildAdded для новых клиентов придёт после initialLoadDone
      const val = snap.val();
      if (val && val.id) onPatch("added", val);
    }, err => console.error("[Firebase] onChildAdded error:", err.code));

    unsubs.push(valueUnsub, changedUnsub, removedUnsub, addedUnsub);
  });

  return () => {
    cancelled = true;
    unsubs.forEach(u => { try { u(); } catch(_) {} });
  };
}

/**
 * Listener на ОДНОГО клиента по ID.
 * Используется для точечных обновлений без пересылки всего списка.
 */
export function dbListenClient(clientId, callback) {
  return dbListen(`clients/${clientId}`, callback);
}

export function isOnline() { return isConnected && isAuthenticated; }

// ─── БЭКАПЫ ───────────────────────────────────────────────────────────────────

export async function runBackup(clients) {
  if (!clients || !clients.length || !isConnected) return;
  try {
    const now    = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const weekKey = `week_${Math.floor(now.getTime() / (7 * 86400000))}`;

    const payload = {
      clients,
      count:     clients.length,
      backedAt:  now.toISOString(),
    };

    await set(ref(db, `backups/daily/${dateKey}`), payload);

    if (now.getDay() === 1) {
      await set(ref(db, `backups/weekly/${weekKey}`), payload);
    }

    // Чистим старые дневные бэкапы (оставляем 30)
    try {
      const dailySnap = await get(ref(db, "backups/daily"));
      if (dailySnap.exists()) {
        const keys = Object.keys(dailySnap.val()).sort();
        for (const k of keys.slice(0, Math.max(0, keys.length - 30))) {
          await set(ref(db, `backups/daily/${k}`), null);
        }
      }
    } catch(_) {}

    // Чистим старые недельные бэкапы (оставляем 8)
    try {
      const weeklySnap = await get(ref(db, "backups/weekly"));
      if (weeklySnap.exists()) {
        const keys = Object.keys(weeklySnap.val()).sort();
        for (const k of keys.slice(0, Math.max(0, keys.length - 8))) {
          await set(ref(db, `backups/weekly/${k}`), null);
        }
      }
    } catch(_) {}

  } catch(e) {
    console.warn("Backup error:", e.message);
  }
}

// ─── STORAGE ──────────────────────────────────────────────────────────────────

export async function uploadCatalogFile(file, productId) {
  if (!isFirebaseReady || !storage) return fallbackBase64(file);
  try {
    await waitAuth();
    const ext = file.name.split(".").pop() || "jpg";
    const id  = Date.now() + "_" + Math.random().toString(36).slice(2);
    const storageRef = sRef(storage, `catalog/${productId}/${id}.${ext}`);
    await uploadBytes(storageRef, file, { contentType: file.type });
    return await getDownloadURL(storageRef);
  } catch(e) { return fallbackBase64(file); }
}

export async function uploadKPPhoto(file, productId) {
  if (!isFirebaseReady || !storage) return fallbackBase64(file);
  try {
    await waitAuth();
    const ext = file.name.split(".").pop() || "jpg";
    const id  = Date.now() + "_" + Math.random().toString(36).slice(2);
    const storageRef = sRef(storage, `kp_photos/${productId}/${id}.${ext}`);
    await uploadBytes(storageRef, file, { contentType: file.type });
    return await getDownloadURL(storageRef);
  } catch(e) { return fallbackBase64(file); }
}

export async function deleteStorageFile(url) {
  if (!isFirebaseReady || !storage) return;
  try {
    await waitAuth();
    await deleteObject(sRef(storage, url));
  } catch(e) {}
}

function fallbackBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error("Ошибка чтения файла"));
    reader.readAsDataURL(file);
  });
}

// ─── BOT LEADS ────────────────────────────────────────────────────────────────
export async function saveBotLead(lead) { return dbSet(`bot_leads/${lead.id}`, lead); }
export async function getBotLeads() {
  const data = await dbGet("bot_leads", {});
  if (!data || typeof data !== "object") return [];
  return Object.values(data).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ─── CATALOG ─────────────────────────────────────────────────────────────────
export async function getCatalogMedia()  { return dbGet("catalog_media", {}); }
export function listenCatalogMedia(cb)   { return dbListen("catalog_media", cb); }
export async function getCatalogPrices() { return dbGet("prices", null); }
export function listenCatalogPrices(cb)  { return dbListen("prices", cb); }

export function applyPricesToProducts(products, prices) {
  if (!prices) return products;
  return products.map(p => {
    const s = prices[p.id];
    if (!s) return p;
    return { ...p, price: s.price ?? p.price };
  });
}
