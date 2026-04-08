// api/send-approval.js — Vercel Serverless Function
// Отправляет КП руководителю в формате Word (.docx)
// Клиент получает: IGS_KP_№N_ИмяКлиента.docx
// Босс получает: IGS_Kalkulacia_№N_ИмяКлиента.docx (с себестоимостью)

const GMAIL_USER = "dastanshakhatov@gmail.com";
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;
const BOSS_EMAIL = "zhanskii@gmail.com";

// ── Firebase счётчик КП ───────────────────────────────────────────────────────
const FB_URL    = process.env.FIREBASE_DB_URL || "https://igs-crm-59901-default-rtdb.europe-west1.firebasedatabase.app";
const FB_SECRET = process.env.FIREBASE_SECRET;

async function getNextKpNumber() {
  try {
    const res = await fetch(`${FB_URL}/kp_counter.json?auth=${FB_SECRET}`);
    const current = await res.json();
    const next = (current || 0) + 1;
    await fetch(`${FB_URL}/kp_counter.json?auth=${FB_SECRET}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    return next;
  } catch(e) {
    return Date.now().toString().slice(-4);
  }
}

async function getUsdRate() {
  try {
    const res = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
    const data = await res.json();
    const rate = data?.rates?.KZT;
    if (rate && rate > 100) return Math.round(rate);
  } catch(e) {}
  return 505;
}

// ── Справочники ───────────────────────────────────────────────────────────────
const COST_USD = {
  greenawn:    285.00,
  igs_premium: 351.50,
  toscana:     195.00,
  guhher:      152.60,
  toscana_maxi: 195.00,
  zip:          72.00,
  sliding:        0,
  guillotine:     0,
  marquise:       0,
  railings:       0,
};

const COST_DETAILS = {
  greenawn:    { weight: 35, logistics_per_kg: 2, install: 45, exw: 170 },
  igs_premium: { weight: 35, logistics_per_kg: 2, install: 45, exw: 236.5 },
  toscana:     { weight: 15, logistics_per_kg: 2, install: 45, exw: 120 },
  guhher:      { weight: 15, logistics_per_kg: 2, install: 45, exw: 77.6 },
  toscana_maxi: { weight: 15, logistics_per_kg: 2, install: 45, exw: 120 },
  zip:         { weight: 6,  logistics_per_kg: 2, install: 15, exw: 45 },
  sliding:     null,
  guillotine:  null,
  marquise:    null,
  railings:    null,
  panno:       null,
  bilancio:    null,
};

const SALE_PRICES_KZT = {
  greenawn:    250000,
  igs_premium: 280000,
  toscana:     130000,
  guhher:      110000,
  toscana_maxi: 230000,
  zip:          75000,
  sliding:     100000,
  guillotine:  200000,
  marquise:    100000,
  railings:    100000,
  panno:       23000,
  bilancio:    16000,
};

const PRODUCT_NAMES = {
  greenawn:    "Биоклиматическая пергола Greenawn (Поворотная)",
  igs_premium: "Биоклиматическая пергола IGS Premium (Поворотная)",
  toscana:     "Тентовая пергола Toscana (Pergotek)",
  guhher:      "Тентовая пергола Guhher",
  toscana_maxi: "Тентовая пергола Maxi",
  zip:         "Zip-шторы",
  sliding:     "Остекление Слайдинг",
  guillotine:  "Остекление Гильотина",
  marquise:    "Маркизы",
  railings:    "Перила алюминиевые",
  panno:       "Террасная доска Panno",
  bilancio:    "Террасная доска Bilancio",
};

const OPT_LABELS = {
  led:       "LED подсветка",
  heater:    "ИК обогреватель",
  screen:    "Zip-шторы (периметр)",
  insulated: "Утеплённые ламели",
  motor:     "Моторизация",
  double:    "Двойное остекление",
  auto:      "Автоматизация",
  mesh:      "Москитная сетка",
  glass:     "Стеклянное заполнение",
  fasteners: "Скрытые крепления",
  edging:    "Торцевая планка",
  base:      "Лаги + подложка",
  steel:     "Нержавеющие вставки",
};

const OPTIONS_PRICES = {
  greenawn:    [{id:"led",price:12000,flat:false},{id:"heater",price:45000,flat:true},{id:"screen",price:75000,flat:false}],
  igs_premium: [{id:"insulated",price:28000,flat:false},{id:"led",price:12000,flat:false},{id:"heater",price:45000,flat:true}],
  toscana:     [{id:"led",price:10000,flat:false},{id:"motor",price:18000,flat:true},{id:"screen",price:75000,flat:false}],
  guhher:      [{id:"led",price:10000,flat:false},{id:"motor",price:18000,flat:true},{id:"screen",price:75000,flat:false}],
  sliding:     [{id:"double",price:15000,flat:false}],
  guillotine:  [{id:"auto",price:30000,flat:true}],
  zip:         [{id:"motor",price:15000,flat:true},{id:"mesh",price:5000,flat:false}],
  marquise:    [{id:"motor",price:12000,flat:true}],
  railings:    [{id:"glass",price:15000,flat:false},{id:"steel",price:8000,flat:false},{id:"led",price:10000,flat:false}],
  panno:       [{id:"fasteners",price:800,flat:false},{id:"edging",price:1200,flat:false},{id:"base",price:3500,flat:false}],
  bilancio:    [{id:"fasteners",price:800,flat:false},{id:"edging",price:1200,flat:false},{id:"base",price:3500,flat:false}],
};

function calcSale(item) {
  const w = item.width || 0, d = item.depth || 0;
  const area = w * d;
  const qty  = item.quantity || 1;
  let total  = (SALE_PRICES_KZT[item.productId] || 0) * area * qty;
  const opts = OPTIONS_PRICES[item.productId] || [];
  (item.selectedOptions || []).forEach(oid => {
    const opt = opts.find(o => o.id === oid);
    if (!opt) return;
    if (opt.flat) {
      total += opt.price * qty;
    } else if (oid === "screen") {
      const screenArea = (w + d) * 2 * 3;
      total += opt.price * screenArea * qty;
    } else {
      total += opt.price * area * qty;
    }
  });
  // Надбавка — только если задана вручную
  const multiplier = item._priceMultiplier || 1;
  return total * multiplier;
}

function calcCostItem(item, USD_RATE) {
  const area    = (item.width || 0) * (item.depth || 0);
  const qty     = item.quantity || 1;
  const perM2   = COST_USD[item.productId] || 0;
  const costUSD = perM2 * area * qty;
  const costKZT = costUSD * USD_RATE * 1.05;
  const hasCost = perM2 > 0;
  const det     = COST_DETAILS[item.productId];
  let details   = null;
  if (det) {
    const totalArea = area * qty;
    const logistics = det.weight * det.logistics_per_kg;
    details = {
      exwM2:        det.exw,
      logisticsM2:  logistics,
      installM2:    det.install,
      totalM2:      det.exw + logistics + det.install,
      totalUSD:     (det.exw + logistics + det.install) * totalArea,
      bufferPct:    5,
    };
  }
  return { costUSD, costKZT, hasCost, perM2, details };
}

function fmtKZT(n) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(n)) + " ₸";
}
function fmtUSD(n) {
  return "$" + n.toFixed(2);
}
function safeName(str) {
  return (str || "").replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_").slice(0, 40);
}

// ── Генерация клиентского КП (.docx) ─────────────────────────────────────────
async function buildClientKPDocx(client, items, discount, kpNumber) {
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign,
    HeadingLevel,
  } = await import("docx");

  const sub    = items.reduce((s, i) => s + calcSale(i), 0);
  const total  = Math.round(sub * (1 - discount / 100));
  const prepay = Math.round(total * 0.7);
  const date   = new Date().toLocaleDateString("ru-RU", { day:"numeric", month:"long", year:"numeric" });

  const FONT = "Arial";
  const BLUE = "1e3a5f";
  const LIGHT = "f1f5f9";
  const border = { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" };
  const borders = { top: border, bottom: border, left: border, right: border };
  const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

  function cell(text, opts = {}) {
    const { bold = false, color = "1e293b", bg = null, align = AlignmentType.LEFT, size = 22, width = 2000 } = opts;
    return new TableCell({
      borders,
      width: { size: width, type: WidthType.DXA },
      shading: bg ? { fill: bg, type: ShadingType.CLEAR } : undefined,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({
        alignment: align,
        children: [new TextRun({ text, font: FONT, size, bold, color })],
      })],
    });
  }

  // Шапка
  const header = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({ text: "IGS OUTDOOR", font: FONT, size: 48, bold: true, color: BLUE }),
    ],
    spacing: { after: 80 },
  });

  const subHeader = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "Биоклиматические перголы • Остекление • Маркизы • Автоматизация", font: FONT, size: 18, color: "64748b" })],
    spacing: { after: 280 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BLUE } },
  });

  const kpTitle = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ", font: FONT, size: 32, bold: true, color: "1e293b" })],
    spacing: { before: 200, after: 80 },
  });

  const kpNum = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: `КП № ${kpNumber}  ·  ${date}`, font: FONT, size: 22, color: "64748b" })],
    spacing: { after: 240 },
  });

  // Таблица клиента
  const clientTable = new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [1800, 2880, 1800, 2880],
    rows: [
      new TableRow({ children: [
        cell("Клиент", { bold: true, bg: LIGHT, color: "475569", size: 20, width: 1800 }),
        cell(client.name || "—", { bold: true, size: 22, width: 2880 }),
        cell("Телефон", { bold: true, bg: LIGHT, color: "475569", size: 20, width: 1800 }),
        cell(client.phone || "—", { size: 22, width: 2880 }),
      ]}),
      new TableRow({ children: [
        cell("Срок производства", { bold: true, bg: LIGHT, color: "475569", size: 20, width: 1800 }),
        cell("45 рабочих дней", { size: 22, width: 2880 }),
        cell("Гарантия", { bold: true, bg: LIGHT, color: "475569", size: 20, width: 1800 }),
        cell("1 год", { size: 22, width: 2880 }),
      ]}),
      ...(client.address ? [new TableRow({ children: [
        cell("Адрес", { bold: true, bg: LIGHT, color: "475569", size: 20, width: 1800 }),
        new TableCell({
          borders, columnSpan: 3,
          width: { size: 7560, type: WidthType.DXA },
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [new Paragraph({ children: [new TextRun({ text: client.address, font: FONT, size: 22 })] })],
        }),
      ]})] : []),
    ],
  });

  const spacer = () => new Paragraph({ children: [new TextRun("")], spacing: { after: 160 } });

  const sectionTitle = (text) => new Paragraph({
    children: [new TextRun({ text, font: FONT, size: 22, bold: true, color: BLUE, allCaps: true })],
    spacing: { before: 200, after: 100 },
  });

  // Шапка таблицы позиций
  const itemsHeaderRow = new TableRow({
    tableHeader: true,
    children: [
      new TableCell({ borders, width: { size: 3800, type: WidthType.DXA }, shading: { fill: BLUE, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: "НАИМЕНОВАНИЕ", font: FONT, size: 18, bold: true, color: "FFFFFF" })] })] }),
      new TableCell({ borders, width: { size: 2000, type: WidthType.DXA }, shading: { fill: BLUE, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "ПЛОЩАДЬ", font: FONT, size: 18, bold: true, color: "FFFFFF" })] })] }),
      new TableCell({ borders, width: { size: 1400, type: WidthType.DXA }, shading: { fill: BLUE, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "ЕД.", font: FONT, size: 18, bold: true, color: "FFFFFF" })] })] }),
      new TableCell({ borders, width: { size: 1760, type: WidthType.DXA }, shading: { fill: BLUE, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "ЦЕНА / М²", font: FONT, size: 18, bold: true, color: "FFFFFF" })] })] }),
      new TableCell({ borders, width: { size: 2400, type: WidthType.DXA }, shading: { fill: BLUE, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "СТОИМОСТЬ", font: FONT, size: 18, bold: true, color: "FFFFFF" })] })] }),
    ],
  });

  // Строки позиций
  const itemRows = items.map((item, i) => {
    const name  = PRODUCT_NAMES[item.productId] || item.productId;
    const area  = (item.width || 0) * (item.depth || 0);
    const qty   = item.quantity || 1;
    const price = SALE_PRICES_KZT[item.productId] || 0;
    const sale  = calcSale(item);
    const bg    = i % 2 === 0 ? "FFFFFF" : "f8fafc";
    const selOpts = (item.selectedOptions || []).map(oid => OPT_LABELS[oid]).filter(Boolean);
    const priceNote = item._priceNote || "";
    const nameChildren = [new TextRun({ text: `${i + 1}. ${name}`, font: FONT, size: 22, bold: true })];
    if (selOpts.length > 0) nameChildren.push(new TextRun({ text: `⚙️ ${selOpts.join(", ")}`, font: FONT, size: 18, color: "64748b", break: 1 }));
    if (priceNote) nameChildren.push(new TextRun({ text: priceNote, font: FONT, size: 18, color: "92400e", italics: true, break: 1 }));

    return new TableRow({ children: [
      new TableCell({ borders, width: { size: 3800, type: WidthType.DXA }, shading: { fill: bg, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ children: nameChildren })] }),
      new TableCell({ borders, width: { size: 2000, type: WidthType.DXA }, shading: { fill: bg, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${item.width} × ${item.depth} м = ${area.toFixed(1)} м²${qty > 1 ? ` × ${qty} шт` : ""}`, font: FONT, size: 20, color: "475569" })] })] }),
      new TableCell({ borders, width: { size: 1400, type: WidthType.DXA }, shading: { fill: bg, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "комплект", font: FONT, size: 20, color: "64748b" })] })] }),
      new TableCell({ borders, width: { size: 1760, type: WidthType.DXA }, shading: { fill: bg, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `${fmtKZT(price)} / м²`, font: FONT, size: 20, color: "475569" })] })] }),
      new TableCell({ borders, width: { size: 2400, type: WidthType.DXA }, shading: { fill: bg, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: fmtKZT(sale), font: FONT, size: 22, bold: true, color: "1e40af" })] })] }),
    ]});
  });

  // Итоговый блок
  const totalRows = [];
  if (discount > 0) {
    totalRows.push(new TableRow({ children: [
      new TableCell({ borders: noBorders, columnSpan: 2, width: { size: 9360, type: WidthType.DXA }, margins: { top: 60, bottom: 60, left: 120, right: 120 },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `Скидка ${discount}%:  -${fmtKZT(Math.round(sub * discount / 100))}`, font: FONT, size: 22, color: "92400e", bold: true })] })] }),
    ]}));
  }
  totalRows.push(
    new TableRow({ children: [
      new TableCell({ borders, width: { size: 4680, type: WidthType.DXA }, shading: { fill: "f8fafc", type: ShadingType.CLEAR }, margins: { top: 100, bottom: 100, left: 180, right: 120 },
        children: [
          new Paragraph({ children: [new TextRun({ text: "УСЛОВИЯ ОПЛАТЫ", font: FONT, size: 20, bold: true, color: "64748b", allCaps: true })] }),
          new Paragraph({ children: [new TextRun({ text: `Предоплата 70%:  ${fmtKZT(prepay)}`, font: FONT, size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: `Остаток 30%:  ${fmtKZT(total - prepay)}`, font: FONT, size: 22 })] }),
        ],
      }),
      new TableCell({ borders, width: { size: 4680, type: WidthType.DXA }, shading: { fill: BLUE, type: ShadingType.CLEAR }, margins: { top: 100, bottom: 100, left: 180, right: 120 },
        verticalAlign: VerticalAlign.CENTER,
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "ИТОГО", font: FONT, size: 22, bold: true, color: "93c5fd", allCaps: true })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: fmtKZT(total), font: FONT, size: 40, bold: true, color: "FFFFFF" })] }),
          ...(discount > 0 ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `скидка ${discount}%`, font: FONT, size: 20, color: "fbbf24" })] })] : []),
        ],
      }),
    ]}),
  );

  const footer = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "IGS Outdoor  ·  г. Алматы  ·  ул. Сагдат Нурмагамбетова 140/10  ·  Ежедневно 9:00–22:00", font: FONT, size: 18, color: "94a3b8" })],
    spacing: { before: 280 },
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: "e2e8f0" } },
  });

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
        },
      },
      children: [
        header,
        subHeader,
        kpTitle,
        kpNum,
        clientTable,
        spacer(),
        sectionTitle("СОСТАВ ПРЕДЛОЖЕНИЯ"),
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [3800, 2000, 1400, 1760, 2400],
          rows: [itemsHeaderRow, ...itemRows],
        }),
        spacer(),
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [4680, 4680],
          rows: totalRows,
        }),
        spacer(),
        new Paragraph({
          children: [new TextRun({ text: "✅  Срок производства: 45 рабочих дней  ·  Гарантия: 1 год  ·  Замер бесплатно", font: FONT, size: 20, color: "0369a1" })],
          shading: { fill: "f0f9ff", type: ShadingType.CLEAR },
          border: {
            top:    { style: BorderStyle.SINGLE, size: 4, color: "bae6fd" },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: "bae6fd" },
            left:   { style: BorderStyle.SINGLE, size: 4, color: "bae6fd" },
            right:  { style: BorderStyle.SINGLE, size: 4, color: "bae6fd" },
          },
          spacing: { before: 120, after: 120 },
        }),
        footer,
      ],
    }],
  });

  return Packer.toBuffer(doc);
}

// ── Генерация внутренней калькуляции (.docx) ──────────────────────────────────
async function buildBossKPDocx(client, items, discount, USD_RATE, kpNumber) {
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign,
  } = await import("docx");

  const sub         = items.reduce((s, i) => s + calcSale(i), 0);
  const saleTotal   = Math.round(sub * (1 - discount / 100));
  const prepay      = Math.round(saleTotal * 0.7);
  const date        = new Date().toLocaleDateString("ru-RU", { day:"2-digit", month:"2-digit", year:"numeric" });

  let grandCostUSD = 0;
  let grandCostKZT = 0;

  const FONT  = "Arial";
  const DARKBLUE = "1e3a5f";
  const border = { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" };
  const borders = { top: border, bottom: border, left: border, right: border };

  function hCell(text, width = 2000) {
    return new TableCell({
      borders, width: { size: width, type: WidthType.DXA },
      shading: { fill: DARKBLUE, type: ShadingType.CLEAR },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ children: [new TextRun({ text, font: FONT, size: 18, bold: true, color: "FFFFFF" })] })],
    });
  }
  function dCell(text, opts = {}) {
    const { bold = false, color = "1e293b", bg = "FFFFFF", align = AlignmentType.LEFT, size = 20, width = 2000 } = opts;
    return new TableCell({
      borders, width: { size: width, type: WidthType.DXA },
      shading: { fill: bg, type: ShadingType.CLEAR },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ alignment: align, children: [new TextRun({ text, font: FONT, size, bold, color })] })],
    });
  }

  // Строки позиций с себестоимостью
  const positionRows = [];
  items.forEach((item, i) => {
    const name   = PRODUCT_NAMES[item.productId] || item.productId;
    const area   = (item.width || 0) * (item.depth || 0);
    const qty    = item.quantity || 1;
    const sale   = calcSale(item);
    const { costUSD, costKZT, hasCost, perM2, details } = calcCostItem(item, USD_RATE);
    const margin    = sale - costKZT;
    const marginPct = sale > 0 ? Math.round((margin / sale) * 100) : 0;
    const mc = marginPct > 20 ? "16a34a" : marginPct > 0 ? "d97706" : "dc2626";
    const bg = i % 2 === 0 ? "FFFFFF" : "f8fafc";
    const selOpts = (item.selectedOptions || []).map(oid => OPT_LABELS[oid]).filter(Boolean);

    grandCostUSD += costUSD;
    grandCostKZT += costKZT;

    positionRows.push(new TableRow({ children: [
      new TableCell({ borders, width: { size: 2800, type: WidthType.DXA }, shading: { fill: bg, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [
          new Paragraph({ children: [new TextRun({ text: `${i + 1}. ${name}`, font: FONT, size: 20, bold: true })] }),
          ...(selOpts.length > 0 ? [new Paragraph({ children: [new TextRun({ text: `⚙️ ${selOpts.join(", ")}`, font: FONT, size: 17, color: "64748b" })] })] : []),
        ] }),
      dCell(`${item.width} × ${item.depth} м\n${area.toFixed(1)} м² × ${qty}`, { align: AlignmentType.CENTER, size: 19, color: "475569", width: 1500, bg }),
      dCell(fmtKZT(sale), { align: AlignmentType.RIGHT, bold: true, color: "1e40af", size: 22, width: 1800, bg }),
      dCell(hasCost ? `${fmtUSD(perM2)}/м²\n${fmtKZT(costKZT)}` : "нет данных", { align: AlignmentType.RIGHT, size: 19, color: hasCost ? "475569" : "94a3b8", width: 1800, bg }),
      dCell(hasCost ? `${fmtKZT(margin)}\n(${marginPct}%)` : "—", { align: AlignmentType.RIGHT, bold: true, color: mc, size: 20, width: 1460, bg }),
    ]}));

    // Строка деталей себестоимости
    if (details) {
      positionRows.push(new TableRow({ children: [
        new TableCell({ borders, columnSpan: 5, width: { size: 9360, type: WidthType.DXA }, shading: { fill: "f8fafc", type: ShadingType.CLEAR }, margins: { top: 40, bottom: 60, left: 200, right: 100 },
          children: [new Paragraph({ children: [
            new TextRun({ text: `   Закуп EXW: ${fmtUSD(details.exwM2)}/м²  ·  Логистика: ${fmtUSD(details.logisticsM2)}/м²  ·  Монтаж: ${fmtUSD(details.installM2)}/м²  ·  Итого: ${fmtUSD(details.totalM2)}/м²  ·  +5% буфер`, font: FONT, size: 17, color: "64748b", italics: true }),
          ] })] }),
      ]}));
    }
  });

  const totalMargin  = saleTotal - grandCostKZT;
  const totalMargPct = saleTotal > 0 ? Math.round((totalMargin / saleTotal) * 100) : 0;
  const totalMargColor = totalMargPct > 20 ? "16a34a" : totalMargPct > 0 ? "d97706" : "dc2626";

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1000, right: 900, bottom: 1000, left: 900 },
        },
      },
      children: [
        // Шапка
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "IGS OUTDOOR", font: FONT, size: 48, bold: true, color: DARKBLUE })], spacing: { after: 60 } }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "КОНФИДЕНЦИАЛЬНО — Внутренняя калькуляция", font: FONT, size: 24, bold: true, color: "dc2626" })], spacing: { after: 60 } }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${date}  ·  Курс: $1 = ${USD_RATE} ₸  ·  КП № ${kpNumber}`, font: FONT, size: 20, color: "64748b" })], spacing: { after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: DARKBLUE } } }),

        // Клиент
        new Paragraph({ children: [new TextRun({ text: "КЛИЕНТ", font: FONT, size: 20, bold: true, color: DARKBLUE, allCaps: true })], spacing: { before: 160, after: 80 } }),
        new Table({
          width: { size: 9560, type: WidthType.DXA },
          columnWidths: [1600, 3180, 1600, 3180],
          rows: [
            new TableRow({ children: [
              dCell("Имя", { bold: true, bg: "f1f5f9", color: "475569", width: 1600 }),
              dCell(client.name || "—", { bold: true, width: 3180 }),
              dCell("Телефон", { bold: true, bg: "f1f5f9", color: "475569", width: 1600 }),
              dCell(client.phone || "—", { width: 3180 }),
            ]}),
            ...(client.address ? [new TableRow({ children: [
              dCell("Адрес", { bold: true, bg: "f1f5f9", color: "475569", width: 1600 }),
              new TableCell({ borders, columnSpan: 3, width: { size: 7960, type: WidthType.DXA }, margins: { top: 60, bottom: 60, left: 100, right: 100 },
                children: [new Paragraph({ children: [new TextRun({ text: client.address, font: FONT, size: 20 })] })],
              }),
            ]})] : []),
          ],
        }),

        // Позиции
        new Paragraph({ children: [new TextRun({ text: "ДЕТАЛЬНЫЙ РАСЧЁТ ПО ПОЗИЦИЯМ", font: FONT, size: 20, bold: true, color: DARKBLUE, allCaps: true })], spacing: { before: 200, after: 80 } }),
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [2800, 1500, 1800, 1800, 1460],
          rows: [
            new TableRow({ tableHeader: true, children: [
              hCell("НАИМЕНОВАНИЕ", 2800),
              hCell("ПЛОЩАДЬ", 1500),
              hCell("ПРОДАЖА", 1800),
              hCell("СЕБЕСТОИМОСТЬ", 1800),
              hCell("МАРЖА", 1460),
            ]}),
            ...positionRows,
          ],
        }),

        // Итоговая сводка
        new Paragraph({ children: [new TextRun({ text: "ИТОГОВАЯ СВОДКА", font: FONT, size: 20, bold: true, color: DARKBLUE, allCaps: true })], spacing: { before: 200, after: 80 } }),
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [4680, 4680],
          rows: [
            new TableRow({ children: [
              new TableCell({ borders, width: { size: 4680, type: WidthType.DXA }, shading: { fill: DARKBLUE, type: ShadingType.CLEAR }, margins: { top: 100, bottom: 100, left: 180, right: 120 },
                children: [
                  new Paragraph({ children: [new TextRun({ text: "Сумма клиенту", font: FONT, size: 20, color: "93c5fd" })] }),
                  new Paragraph({ children: [new TextRun({ text: fmtKZT(saleTotal), font: FONT, size: 36, bold: true, color: "FFFFFF" })] }),
                  new Paragraph({ children: [new TextRun({ text: `Предоплата 70%: ${fmtKZT(prepay)}`, font: FONT, size: 19, color: "86efac" })] }),
                  new Paragraph({ children: [new TextRun({ text: `Остаток 30%: ${fmtKZT(saleTotal - prepay)}`, font: FONT, size: 19, color: "93c5fd" })] }),
                  ...(discount > 0 ? [new Paragraph({ children: [new TextRun({ text: `Скидка: ${discount}%  (-${fmtKZT(Math.round(sub * discount / 100))})`, font: FONT, size: 19, color: "fbbf24" })] })] : []),
                ],
              }),
              new TableCell({ borders, width: { size: 4680, type: WidthType.DXA }, shading: { fill: "f8fafc", type: ShadingType.CLEAR }, margins: { top: 100, bottom: 100, left: 180, right: 120 },
                children: [
                  new Paragraph({ children: [new TextRun({ text: "Общая себестоимость", font: FONT, size: 20, color: "64748b" })] }),
                  new Paragraph({ children: [new TextRun({ text: `${fmtUSD(grandCostUSD)} × ${USD_RATE} = ${fmtKZT(grandCostKZT)}`, font: FONT, size: 22, bold: true, color: "1e293b" })] }),
                  new Paragraph({ children: [new TextRun({ text: " ", font: FONT, size: 10 })] }),
                  new Paragraph({ children: [new TextRun({ text: "Итоговая маржа", font: FONT, size: 20, color: "64748b" })] }),
                  new Paragraph({ children: [new TextRun({ text: `${fmtKZT(totalMargin)} (${totalMargPct}%)`, font: FONT, size: 32, bold: true, color: totalMargColor })] }),
                ],
              }),
            ]}),
          ],
        }),

        // Футер
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: "IGS Outdoor CRM  ·  Внутренняя калькуляция  ·  Менеджер не видит себестоимость и маржу", font: FONT, size: 17, color: "94a3b8" })],
          spacing: { before: 240 },
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: "e2e8f0" } },
        }),
      ],
    }],
  });

  return Packer.toBuffer(doc);
}

// ── Главный handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { client, items, discount } = req.body || {};
    if (!client || !items?.length) return res.status(400).json({ error: "Нет данных" });

    const [USD_RATE, kpNumber] = await Promise.all([getUsdRate(), getNextKpNumber()]);
    const date = new Date().toLocaleDateString("ru-RU", { day:"2-digit", month:"2-digit", year:"numeric" }).replace(/\./g, "-");
    const nameSlug = safeName(client.name);

    const [clientDocx, bossDocx] = await Promise.all([
      buildClientKPDocx(client, items, discount || 0, kpNumber),
      buildBossKPDocx(client, items, discount || 0, USD_RATE, kpNumber),
    ]);

    const subject = `👑 КП №${kpNumber} — ${client.name}${discount > 0 ? ` (скидка ${discount}%)` : ""}`;

    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.default.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_PASS.replace(/\s/g, "") },
    });

    await transporter.sendMail({
      from: `"IGS Outdoor CRM" <${GMAIL_USER}>`,
      to:   BOSS_EMAIL,
      subject,
      text: `КП №${kpNumber} для клиента ${client.name}\nДата: ${date}\nКурс: $1 = ${USD_RATE} ₸`,
      attachments: [
        {
          filename: `IGS_KP_№${kpNumber}_${nameSlug}_${date}.docx`,
          content:  clientDocx,
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
        {
          filename: `IGS_Kalkulacia_№${kpNumber}_${nameSlug}_${date}.docx`,
          content:  bossDocx,
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ],
    });

    return res.status(200).json({ ok: true, kpNumber });
  } catch (err) {
    console.error("send-approval error:", err);
    return res.status(500).json({ error: err.message || "Ошибка отправки" });
  }
}
