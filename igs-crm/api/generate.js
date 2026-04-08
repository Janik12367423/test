export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const {
    imageBase64, productDesc, stateDesc, frameColor, fabricColor,
    markerX, markerY, customPrompt, isChainedFrame, addons,
    generateVideo,
  } = req.body;

  if (!imageBase64 || !productDesc) {
    return res.status(400).json({ error: 'imageBase64 and productDesc required' });
  }

  try {
    /* ═══════════════════════════════════════════
       STEP 1 — Claude Vision (skip if chained frame)
       ═══════════════════════════════════════════ */
    let analysis = {
      position_landmarks: 'at the marked position',
      light_direction: 'natural daylight',
      shadow_direction: 'match existing shadows',
      ground_surface: 'existing surface',
      camera_angle: 'eye-level',
      perspective_vanishing: 'to center',
      ambient_mood: 'neutral daylight',
      color_palette: 'existing palette',
      installation_area_width_meters: '4-5',
      installation_area_height_meters: '3',
      installation_area_depth_meters: '3-4',
      attachment_method: 'freestanding',
      scene_text_description: 'outdoor architectural space with natural lighting',
    };

    if (!isChainedFrame) {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1200,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
              { type: 'text', text: `Analyze this outdoor photo for architectural product installation. Product will be placed at ~${markerX}% from left, ~${markerY}% from top.
Respond in JSON ONLY (no markdown):
{
  "scene_type": "terrace/balcony/garden/facade/restaurant/commercial/residential",
  "camera_angle": "eye-level/low-angle/elevated",
  "perspective_vanishing": "vanishing point direction",
  "light_direction": "direction and quality of light",
  "shadow_direction": "shadow direction and strength",
  "ground_surface": "surface type",
  "wall_material": "wall/facade material",
  "existing_roof_or_overhang": "any existing overhead structure",
  "installation_area_width_meters": "estimated width",
  "installation_area_height_meters": "estimated clearance height",
  "installation_area_depth_meters": "estimated depth",
  "attachment_method": "wall-mount/freestanding/between-columns/ceiling-mount",
  "position_landmarks": "describe placement using visible elements in the photo",
  "color_palette": "dominant colors",
  "ambient_mood": "lighting mood: evening warm/bright daylight/overcast/sunset",
  "scene_text_description": "2-3 sentences describing the scene for video: location, architectural style, surfaces, lighting"
}` }
            ],
          }],
        }),
      });
      if (claudeRes.ok) {
        const d = await claudeRes.json();
        let txt = d.content?.map(b => b.type === 'text' ? b.text : '').join('') || '{}';
        txt = txt.replace(/```(?:json)?\n?/g, '').replace(/```$/g, '').trim();
        try { analysis = { ...analysis, ...JSON.parse(txt) }; } catch {}
      }
    }

    /* ═══════════════════════════════════════════
       Addon descriptions
       ═══════════════════════════════════════════ */
    const addonList = Array.isArray(addons) ? addons : [];
    const addonDesc = addonList.map(a => {
      if (a === 'zip-blinds') return 'Zip blinds: retractable fabric side screens on all open sides of the pergola, providing wind/rain/sun protection.';
      if (a === 'sliding-glass') return 'Sliding glass: frameless floor-to-ceiling glass panels closing the perimeter on minimal aluminum tracks.';
      if (a === 'led-lighting') {
        // LED placement depends on product type
        if (isAwning) {
          return 'ВЕЧЕРНЯЯ LED ПОДСВЕТКА МАРКИЗЫ — ТОЧНОЕ РАСПОЛОЖЕНИЕ ЛАМП: LED лента установлена в ТРЁХ местах только на самой конструкции маркизы (НЕ на стене здания, НЕ на фасаде): (1) КАССЕТНЫЙ КОРОБ (вал) — яркая горизонтальная LED полоса вдоль нижней передней кромки короба на стене, короб светится горизонтальной линией на высоте 2.8м. (2) ОБА РЫЧАГА — LED лента вдоль всей длины левого и правого рычага, рычаги светятся двумя диагональными линиями в воздухе от стены до штанги. (3) ПЕРЕДНЯЯ ШТАНГА — яркая LED полоса внутри профиля штанги светит ВНИЗ, штанга висит в воздухе на 2.2–2.5м и светится горизонтальной линией. Итог: три светящихся алюминиевых элемента образуют трапецию в воздухе — горизонталь на стене (короб), две диагонали (рычаги), горизонталь в воздухе (штанга). Тёплый золотисто-белый яркий свет. Лужа света на земле под штангой. СТЕНА ЗДАНИЯ НЕ СВЕТИТСЯ — только сама конструкция.';
        } else {
          return 'LED LIGHTING (IMPORTANT — must be clearly visible and BRIGHT): LED strip lights are integrated into the aluminum frame profiles — running along the inner face of ALL perimeter beams and along arm/bar profiles. The LEDs emit a STRONG warm golden-white glow (not subtle, not dim). The light illuminates the deck/ground below with visible brightness, creates light bloom on surrounding surfaces, the underside of any fabric or roof structure glows from the LED light. Think professional architectural night photography — dramatic, vivid, Instagram-quality evening ambiance. Make the LED glow clearly dominant in the image.';
        }
      }
      return a;
    }).join('\n');

    /* ═══════════════════════════════════════════
       STEP 2 — Gemini image generation
       ═══════════════════════════════════════════ */
    const imagePrompt = isChainedFrame
      ? `This photo already shows a ${productDesc} installed. ONLY change the movable parts state to: ${stateDesc}. Keep EVERYTHING else identical — structure, position, color (${frameColor}), background, lighting. Update shadow pattern to match new state. Result must look like a stop-motion frame of the SAME structure.`
      : `CRITICAL: Edit this EXACT photo. Keep ALL original pixels identical — walls, ground, sky, furniture, shadows. ONLY add the product below.

PRODUCT SPECIFICATION:
${productDesc}

CURRENT STATE TO SHOW:
${stateDesc}

MATERIALS & COLORS:
Frame: ${frameColor}
${fabricColor ? `Fabric: ${fabricColor}` : ''}
${addonDesc ? `Addons: ${addonDesc}` : ''}

SCENE CONTEXT:
Camera: ${analysis.camera_angle}, Light: ${analysis.light_direction}, Mood: ${analysis.ambient_mood}
Ground: ${analysis.ground_surface}
Placement: ${analysis.position_landmarks || `~${markerX}% from left, ~${markerY}% from top`}
Size: ${analysis.installation_area_width_meters}m wide × ${analysis.installation_area_height_meters}m tall
${customPrompt ? `Client notes: ${customPrompt}` : ''}

MANDATORY RULES:
1. SHADOW: Cast realistic shadow matching direction (${analysis.shadow_direction}). Structure without shadow is WRONG.
2. PERSPECTIVE: Match exact camera angle and vanishing point of the photo.
3. SCALE: Size proportional to doors/windows visible in photo.
4. INTEGRATION: Product looks physically installed, not pasted on top.
Professional architectural photograph quality. NOT AI-looking.`;

    // Gemini image generation — try models in order
    const geminiModelConfigs = [
      'gemini-2.0-flash-preview-image-generation',
      'gemini-2.0-flash-exp',
      'gemini-2.5-flash-preview-05-20',
    ];

    let generatedImageBase64 = null;
    let generatedMimeType = 'image/jpeg';
    let usedModel = null;

    for (const model of geminiModelConfigs) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [
                { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
                { text: imagePrompt },
              ]}],
              generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
            }),
          }
        );
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          const errMsg = e?.error?.message || r.statusText;
          lastError = `${model}: HTTP ${r.status} — ${errMsg}`;
          if (r.status === 401 || r.status === 403) {
            return res.status(200).json({ success: false, error: `Auth error: ${errMsg}. Check GEMINI_API_KEY.` });
          }
          if (r.status === 429) {
            return res.status(200).json({ success: false, error: `Rate limit exceeded. Try again in a moment.` });
          }
          continue; // try next model
        }
        const d = await r.json();
        const parts = d?.candidates?.[0]?.content?.parts || [];
        const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
        if (!imgPart?.inlineData?.data) {
          lastError = `${model}: response OK but no image found. Parts: ${JSON.stringify(parts.map(p=>Object.keys(p)))}`;
          continue;
        }
        generatedImageBase64 = imgPart.inlineData.data;
        generatedMimeType = imgPart.inlineData.mimeType || 'image/jpeg';
        usedModel = model;
        break;
      } catch (e) {
        lastError = `${model}: ${e.message}`;
        continue;
      }
    }
    if (!generatedImageBase64) {
      // Return detailed error so we can debug
      return res.status(200).json({ 
        success: false,
        error: `Gemini image generation failed: ${lastError}. Check GEMINI_API_KEY and model availability.`,
        analysis,
        debug: 'Tried models: gemini-2.0-flash-exp, gemini-1.5-flash-latest, gemini-1.5-pro-latest'
      });
    }

    /* ═══════════════════════════════════════════
       STEP 3 — Veo 3 video generation (optional)
       Correct endpoint: :predictLongRunning
       Correct auth: x-goog-api-key header
       Body: { instances: [{ prompt }], parameters: {} }
       ═══════════════════════════════════════════ */
    if (generateVideo) {
      const isLouver = productDesc.toLowerCase().includes('louver') || productDesc.toLowerCase().includes('bioclimatic') || productDesc.toLowerCase().includes('pergola');
      const isAwning = productDesc.toLowerCase().includes('awning') || productDesc.toLowerCase().includes('marquise');
      const isGlass  = productDesc.toLowerCase().includes('glass') || productDesc.toLowerCase().includes('sliding') || productDesc.toLowerCase().includes('guillotine');

      const sceneCtx = analysis.scene_text_description || 'modern outdoor architectural space with natural lighting';
      const productColor = frameColor.split(' ')[0].toLowerCase();


      // ═══════════════════════════════════════════════════════════════════════
      // PRODUCT MOTION DESCRIPTIONS — PRECISE MECHANICAL PHYSICS FOR EACH TYPE
      // These descriptions teach the AI exactly HOW each product works before
      // animating it. Every physical detail matters for correct visualization.
      // ═══════════════════════════════════════════════════════════════════════

      let motionDesc;

      // ══════════════════════════════════════════════════════════════════════════════
      // ██████████████████ ТОЧНЫЕ ОПИСАНИЯ МЕХАНИКИ КАЖДОГО ПРОДУКТА ████████████████
      // Эти тексты — инструкция для AI-генерации. Каждое слово важно.
      // AI должен прочитать всё до конца перед тем как генерировать изображение.
      // ══════════════════════════════════════════════════════════════════════════════

      // ────────────────────────────────────────────────────────────────────────────
      // МАРКИЗА (CASSETTE AWNING) — НАСТЕННЫЙ КАССЕТНЫЙ НАВЕС
      // ────────────────────────────────────────────────────────────────────────────
      if (isAwning) {
        motionDesc = `
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
СТОП. ПРОЧИТАЙ ВСЁ ЭТО ПОЛНОСТЬЮ ПРЕЖДЕ ЧЕМ ГЕНЕРИРОВАТЬ ЧТО-ЛИБО.
ЭТО РЕАЛЬНЫЙ ПРОДУКТ. ГЕНЕРИРУЙ СТРОГО ПО ОПИСАНИЮ. НИКАКИХ ОТКЛОНЕНИЙ.
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓

ПРОДУКТ: МАРКИЗА — кассетный навес, крепится к стене здания.

═══════════════ ЧТО ЭТО ТАКОЕ ═══════════════
Маркиза — это навес над террасой или входом, который:
- крепится только к стене здания (как полка)
- выдвигается ГОРИЗОНТАЛЬНО от стены наружу (как выдвижной ящик, только горизонтально)
- создаёт над пространством плоскую наклонную крышу из ткани
- НЕ касается земли ни одной своей частью кроме стены
Представь: ты прикрепил к стене горизонтальную лопасть вентилятора — она торчит горизонтально от стены в воздухе. Маркиза работает так же — горизонтальная плоскость ткани выдвигается горизонтально от стены.

═══════════════ ДЕТАЛЬ 1: КАССЕТНЫЙ КОРОБ (CASSETTE BOX) ═══════════════
ФОРМА: Прямоугольный алюминиевый ящик/профиль.
РАЗМЕР: Ширина = вся ширина маркизы (3–6 метров). Высота ≈ 25–35 см. Глубина ≈ 25 см.
ЦВЕТ: ${productColor} порошковая покраска.
МЕСТО: Прикручен горизонтально к стене здания на высоте 2.5–3.0 метра от земли.
ОРИЕНТАЦИЯ: Длинная сторона короба идёт вдоль стены горизонтально. Короб параллелен земле.
ВНЕШНИЙ ВИД: Выглядит как толстая алюминиевая балка приделанная к стене. Чистый прямоугольный профиль.
СОДЕРЖИМОЕ: Внутри короба находится всё — вал с тканью и сложенные рычаги. Снаружи видна только коробка.
ЗАКРЫТОЕ СОСТОЯНИЕ: Видна только эта коробка на стене. Больше НИЧЕГО. Стена выглядит чисто.
ОТКРЫТОЕ СОСТОЯНИЕ: Из щели в нижней передней части короба выходит ткань и тянется вперёд от стены.

═══════════════ ДЕТАЛЬ 2: ВАЛ (ROLLER DRUM) ВНУТРИ КОРОБА ═══════════════
ФОРМА: Стальной цилиндр на всю ширину короба. Находится внутри — снаружи не виден.
ФУНКЦИЯ: Вокруг вала намотана ткань как рулон туалетной бумаги.
МОТОР: Электромотор вращает вал.
ОТКРЫТИЕ → мотор крутит вал → ткань разматывается → выходит из щели в нижней части короба → тянется ВПЕРЁД от стены (не вниз, а вперёд!).
ЗАКРЫТИЕ → мотор крутит вал в обратную сторону → ткань наматывается обратно → всё прячется в короб.
КЛЮЧЕВОЕ: Ткань выходит ГОРИЗОНТАЛЬНО ВПЕРЁД от стены. Ткань НЕ падает вниз.

═══════════════ ДЕТАЛЬ 3: ДВА РЫЧАГА (ПАНТОГРАФЫ) ═══════════════
КОЛИЧЕСТВО: Ровно 2 рычага. Один слева, один справа.
КОНСТРУКЦИЯ КАЖДОГО РЫЧАГА:
  - Каждый рычаг состоит из ДВУХ параллельных алюминиевых брусков идущих рядом (не один брусок, а два).
  - Эти два бруска соединены в ЦЕНТРАЛЬНОЙ ТОЧКЕ шарниром с шестернёй (пантограф / параллелограмм).
  - Шарнир в центре позволяет рычагу складываться пополам как складной метр или раскладной нож.
СЛОЖЕННОЕ СОСТОЯНИЕ (маркиза закрыта):
  - Оба бруска рычага сложены параллельно друг другу.
  - Рычаг уменьшен до половины своей открытой длины.
  - Рычаг спрятан внутри кассетного короба. Снаружи не виден.
РАСКЛАДЫВАНИЕ (маркиза открывается):
  - Центральный шарнир раздвигается, два бруска расходятся.
  - Рычаг разворачивается и вытягивается ВПЕРЁД от боковой стенки короба.
  - Одновременно рычаг немного наклоняется вниз (примерно на 20° ниже горизонта).
ПОЛНОСТЬЮ ОТКРЫТЫЙ РЫЧАГ:
  - Прямой, вытянутый, длина 3–4 метра.
  - Идёт от стены (точка крепления к боковине короба) наружу и чуть вниз (угол 20°).
  - Выглядит как наклонная распорка держащая переднюю штангу в воздухе.
  - В центре рычага виден шарнирный узел (небольшое утолщение посередине).
  - Два параллельных бруска видны — рычаг не одна труба, а двойной.
ПРИКРЕПЛЕНИЕ: Внутренний конец → боковина кассетного короба. Внешний конец → торец передней штанги.

═══════════════ ДЕТАЛЬ 4: ПЕРЕДНЯЯ ШТАНГА (FRONT BAR) ═══════════════
ФОРМА: Жёсткий алюминиевый профиль/труба на всю ширину маркизы.
ЦВЕТ: ${productColor} алюминий.
МЕСТО КОГДА ОТКРЫТА:
  - 3–4 метра ГОРИЗОНТАЛЬНО от стены здания
  - 2.0–2.2 метра НАД ЗЕМЛЁЙ (примерно на уровне головы или чуть выше)
  - Параллельна стене и параллельна земле
  - Висит в воздухе, удерживается ТОЛЬКО двумя рычагами
КРЕПЛЕНИЕ: Левый торец → к концу левого рычага. Правый торец → к концу правого рычага.
ЧТО НАХОДИТСЯ ПОД ШТАНГОЙ: НИЧЕГО. Пустой воздух от штанги до земли (около 2 метров).
Человек ростом 1.8м стоит под штангой — у него над головой штанга, ещё 20–40см до неё.
Под штангой можно свободно ходить — никаких преград.
LED ВАРИАНТ: Внутри профиля штанги встроена LED лента. Штанга светится тёплым белым светом вниз.
Рычаги тоже могут иметь LED по всей длине — они тоже светятся.

═══════════════ ДЕТАЛЬ 5: ТКАНЬ — САМОЕ ГЛАВНОЕ ═══════════════
ЧЕМ ЯВЛЯЕТСЯ ТКАНЬ:
Ткань маркизы — это ПЛОСКАЯ ГОРИЗОНТАЛЬНАЯ (или слегка наклонная) ПОВЕРХНОСТЬ.
Как крыша автомобиля. Как наклонная кровля. Как доска лежащая на столе.
Ты смотришь НА НЕЁ СНИЗУ — видишь нижнюю сторону ткани у себя над головой.
Ткань создаёт ТЕНЬ на пространстве под ней.

КАК НАТЯНУТА ТКАНЬ:
- Задний край (у стены): выходит из щели в нижней части кассетного короба на высоте ~2.8м.
- Передний край: прикреплён к передней штанге которая висит на ~2.0м.
- Ткань натянута между этими двумя точками — от стены до штанги.
- Ткань абсолютно ПЛОСКАЯ и ТУГАЯ — никаких складок, провисаний, морщин.
- Наклон: от стены вниз к штанге, угол ~20°. Стена — выше, штанга — ниже.
- Вид сбоку: ткань выглядит как наклонная прямая линия идущая от стены к штанге.
- Вид снизу: ты видишь плоскую поверхность ткани над собой (как потолок, только наклонный).
- Вид спереди: ткань заполняет всё пространство от стены до штанги, слева направо.

ЧЕМ ТКАНЬ НЕ ЯВЛЯЕТСЯ:
✗ ТКАНЬ НЕ ВИСИТ ВЕРТИКАЛЬНО ВНИЗ как занавеска или штора — ЗАПРЕЩЕНО
✗ ТКАНЬ НЕ ОБРАЗУЕТ ВЕРТИКАЛЬНУЮ СТЕНУ — ЗАПРЕЩЕНО
✗ ТКАНЬ НЕ КАСАЕТСЯ ЗЕМЛИ — ЗАПРЕЩЕНО
✗ ТКАНЬ НЕ СВИСАЕТ ВНИЗ ИЗ КОРОБА — ЗАПРЕЩЕНО
✗ ТКАНЬ НЕ ЯВЛЯЕТСЯ БОКОВОЙ СТЕНКОЙ — ЗАПРЕЩЕНО

═══════════════ ЗАПРЕЩЁННЫЕ ОШИБКИ (AI ДЕЛАЛ ЭТО РАНЬШЕ — НЕ ПОВТОРЯЙ) ═══════════════
✗ НЕЛЬЗЯ: рисовать ткань вертикально как стену или занавеску
✗ НЕЛЬЗЯ: добавлять любые стойки, ноги, колонны от штанги до земли
✗ НЕЛЬЗЯ: рычаги идущие ВНИЗ к земле — рычаги идут ВПЕРЁД от стены (с наклоном 20° вниз)
✗ НЕЛЬЗЯ: ткань касающаяся земли
✗ НЕЛЬЗЯ: любые опоры снизу кроме самой стены здания
✗ НЕЛЬЗЯ: ткань складками или провисаниями — только тугая и плоская

═══════════════ КАК ВЫГЛЯДИТ МАРКИЗА ВИД СБОКУ (профиль) ═══════════════

СТЕНА ЗДАНИЯ (вертикальная):
│
│  ← высота 2.8м от земли
├══════[КАССЕТНЫЙ КОРОБ]══╗   ← короб на стене, горизонтальный
│                         ║
│    Здесь ткань — плоская║поверхность, наклон 20° вниз от стены к штанге
│                         ╚══════════════════════════════════════╗
│           ← 3–4 метра от стены →                              ║
│  Рычаг (диагональный,                                    ▼ штанга
│  идёт вперёд и 20° вниз)                    [ШТАНГА] ← 2.0–2.2м над землёй
│                                                  │
│                                             ВОЗДУХ (2м)
│                                                  │
│                                             ВОЗДУХ
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ЗЕМЛЯ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓

═══════════════ ИТОГОВЫЙ ОБРАЗ ═══════════════
Готовая маркиза выглядит как КОЗЫРЁК НАД ВХОДОМ В ЗДАНИЕ или НАВЕС НАД ТЕРРАСОЙ:
- На стене — прямоугольный алюминиевый короб
- От него вперёд и чуть вниз тянутся два наклонных рычага (слева и справа)
- На концах рычагов — горизонтальная штанга висит в воздухе
- Между коробом и штангой натянута плоская ткань (как наклонная крыша над пространством)
- Под тканью и штангой — открытое пространство где стоят люди, двери, окна
- Ничто кроме стены не касается земли

═══════════════ АНИМАЦИЯ ═══════════════
КАМЕРА: АБСОЛЮТНО НЕПОДВИЖНА. Никакого движения камеры. Фиксированная точка съёмки.
СТЕНА ЗДАНИЯ, ЗЕМЛЯ: Неподвижны и жёстки.

Шаг 1 (0–1с): ЗАКРЫТО. Только кассетный короб виден на стене. Стена чистая. Ничего больше.
Шаг 2 (1–5с): ОТКРЫВАНИЕ:
  - Мотор запускается, вал начинает вращаться внутри короба
  - Оба рычага одновременно начинают раскладываться из боковин короба, вытягиваясь ВПЕРЁД и чуть вниз
  - Ткань начинает выходить из щели в нижней части короба и тянется ВПЕРЁД горизонтально
  - Поверхность ткани растёт от стены вперёд — всегда плоская, всегда горизонтальная/наклонная
  - Штанга движется вперёд от стены, слегка снижаясь до уровня 2.0м
Шаг 3 (5–7с): ПОЛНОСТЬЮ ОТКРЫТО. Держать и рендерить фотореалистично:
  - Короб на стене (не изменился) на высоте 2.8м
  - Два рычага полностью вытянуты (3–4м, наклон 20°), слева и справа
  - Штанга висит в воздухе на ВЫСОТЕ 2.2–2.5м (НЕ НИЖЕ 2.0м!) и 3–4м от стены
  - Если есть LED: короб светится горизонтально на стене, оба рычага светятся диагонально, штанга светится горизонтально в воздухе
  - Ткань — плоская тугая поверхность от короба до штанги, наклон 20° как козырёк
  - Под тканью и штангой: открытое пространство, человек 1.8м проходит свободно
Шаг 4 (7–8с): Рычаги начинают складываться, ткань наматывается обратно.
Итого: 8 секунд. ${productColor} алюминий, тугая уличная ткань. Фотореализм.`;

      // ────────────────────────────────────────────────────────────────────────────
      // БИОКЛИМАТИЧЕСКАЯ ПЕРГОЛА — ПОВОРОТНЫЕ АЛЮМИНИЕВЫЕ ЛАМЕЛИ
      // ────────────────────────────────────────────────────────────────────────────
      } else if (isLouver && !productDesc.toLowerCase().includes('tent') && !productDesc.toLowerCase().includes('toscana') && !productDesc.toLowerCase().includes('guhher')) {
        motionDesc = `
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
СТОП. ПРОЧИТАЙ ВСЁ ПОЛНОСТЬЮ. ГЕНЕРИРУЙ СТРОГО ПО ОПИСАНИЮ.
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓

ПРОДУКТ: БИОКЛИМАТИЧЕСКАЯ ПЕРГОЛА С ПОВОРОТНЫМИ ЛАМЕЛЯМИ.

═══════════════ ЧТО ЭТО ТАКОЕ ═══════════════
Биоклиматическая пергола — это отдельностоящая уличная конструкция (не крепится к стене).
Выглядит как беседка или навес на 4 ногах с крышей из поворотных алюминиевых пластин.
Крыша состоит из множества плоских алюминиевых ламелей которые поворачиваются как жалюзи.

═══════════════ ДЕТАЛЬ 1: ЧЕТЫРЕ КОЛОННЫ ═══════════════
ФОРМА: Четыре квадратных алюминиевых профиля (~150×150мм).
РАСПОЛОЖЕНИЕ: По углам прямоугольника. Стоят ВЕРТИКАЛЬНО на земле.
КРЕПЛЕНИЕ: Каждая колонна приварена/прикручена к основанию (пластина на земле) болтами.
ВЫСОТА: 2.5–3.5 метра (зависит от проекта).
ВНЕШНИЙ ВИД: Выглядят как толстые квадратные столбы — массивные, чёткие, ${productColor} цвет.
ЧТО НЕ ДОЛЖНО БЫТЬ: Колонны НЕ тонкие, НЕ круглые, НЕ декоративные — они квадратные и массивные.

═══════════════ ДЕТАЛЬ 2: ЧЕТЫРЕ БАЛКИ (ПЕРИМЕТР) ═══════════════
ФОРМА: Прямоугольные алюминиевые профили соединяющие вершины колонн.
ДВЕ ДЛИННЫЕ БОКОВЫЕ БАЛКИ: Соединяют левые колонны с правыми. Идут по бокам.
ДВЕ КОРОТКИЕ ТОРЦЕВЫЕ БАЛКИ: Соединяют передние колонны с задними. Идут спереди и сзади.
ИТОГ: Четыре балки образуют жёсткий горизонтальный прямоугольный периметр на вершинах колонн.
Вид сверху: прямоугольная рамка. Как рамка картины лежащая горизонтально.
ВНУТРИ БАЛОК: Встроенные водостоки (не видны снаружи, вода уходит через колонны в дренаж).
ЦВЕТ: ${productColor} порошковая покраска.

═══════════════ ДЕТАЛЬ 3: ЛАМЕЛИ (ГЛАВНАЯ ДВИЖУЩАЯСЯ ЧАСТЬ) ═══════════════
ЧТО ТАКОЕ ОДНА ЛАМЕЛЬ:
Одна ламель — это плоская широкая алюминиевая планка.
Ширина ламели: 150–250мм (примерно как ширина ладони).
Длина ламели: от передней балки до задней (полная глубина перголы).
Толщина: 5–8мм — тонкая плоская пластина.
Внешний вид: как широкая линейка или кухонная лопатка, только алюминиевая.

СКОЛЬКО ЛАМЕЛЕЙ:
Ламели заполняют ВСЮ ширину крыши (от левой балки до правой) без зазоров когда закрыты.
Если пергола 4м шириной — ламелей 15–25 штук, стоят вплотную друг к другу.
Все ламели параллельны друг другу.

КАК РАСПОЛОЖЕНЫ:
Все ламели лежат горизонтально (когда закрыты) внутри прямоугольника балок.
Если смотреть снизу на закрытую крышу — видишь СПЛОШНОЙ МЕТАЛЛИЧЕСКИЙ ПОТОЛОК.
Как жалюзи на окне, только горизонтальные, алюминиевые, уличного размера.

ОСЬ ВРАЩЕНИЯ (САМОЕ ВАЖНОЕ):
У каждой ламели сквозь неё по длине проходит стальной стержень (ось вращения).
Этот стержень расположен точно в ЦЕНТРЕ ширины ламели — ровно посередине.
Пример: ламель 200мм шириной → стержень на 100мм от каждого края.
Стержни с одной стороны подключены к общей тяге связанной с одним мотором.

МОТОР:
Один электромотор управляет всеми ламелями через общую механическую тягу.
Все ламели поворачиваются ОДНОВРЕМЕННО и на ОДИНАКОВЫЙ УГОЛ — синхронно, как одно целое.
Нельзя повернуть одни ламели и не повернуть другие.

═══════════════ ДЕТАЛЬ 4: КАК ПОВОРАЧИВАЮТСЯ ЛАМЕЛИ (ФИЗИКА КАЧЕЛЕЙ) ═══════════════
Поскольку ось вращения в ЦЕНТРЕ ламели (не у края!):
Когда ламель поворачивается — один край идёт ВВЕРХ, другой идёт ВНИЗ на равное расстояние.
Как КАЧЕЛИ на детской площадке. Как весы.
Это НЕ как форточка которая открывается от края. Ламель качается от центра.

ТРИ ПОЛОЖЕНИЯ ЛАМЕЛЕЙ:

ЗАКРЫТО (0°):
  Все ламели лежат ГОРИЗОНТАЛЬНО. Передний и задний края каждой ламели на одном уровне.
  Соседние ламели касаются друг друга краями — зазоров НОЛЬ.
  Вид снизу: сплошной алюминиевый потолок. Непрозрачный. Водонепроницаемый. Неба не видно.
  Вид сверху: плоская алюминиевая поверхность как металлическая кровля.

ПОЛУОТКРЫТО (45°):
  Все ламели повёрнуты на 45°. Один край выше, другой ниже.
  Между соседними ламелями образуются равные зазоры.
  Вид снизу: чередование — алюминиевая планка, зазор (небо), алюминиевая планка, зазор...
  Тень от солнца: полосатая диагональная тень на полу внутри перголы.
  Через крышу видно примерно 40–50% неба.

ПОЛНОСТЬЮ ОТКРЫТО (90°):
  Все ламели стоят ВЕРТИКАЛЬНО — на ребро.
  Каждая ламель показывает только свой торец (3–8мм толщиной) — очень тонкий.
  Зазоры между ламелями максимальные (почти равны ширине ламели).
  Вид снизу: почти открытое небо — видны облака, солнце, небо. Лишь тонкие рёбра ламелей.
  Максимальная вентиляция. Максимальный свет.

═══════════════ ЗАПРЕЩЁННЫЕ ОШИБКИ ═══════════════
✗ НЕЛЬЗЯ: двигать камеру — только ламели вращаются
✗ НЕЛЬЗЯ: двигать колонны или балки — они жёсткие и неподвижные
✗ НЕЛЬЗЯ: делать зазоры неравномерными — все зазоры одинаковые (один мотор)
✗ НЕЛЬЗЯ: показывать одни ламели открытыми, другие закрытыми — все синхронно
✗ НЕЛЬЗЯ: рисовать ось вращения у края ламели — только по центру
✗ НЕЛЬЗЯ: добавлять верёвки, ткань, занавески — только жёсткие алюминиевые пластины

═══════════════ КАК ВЫГЛЯДИТ ПЕРГОЛА ════════════════

ВИД СПЕРЕДИ (с улицы):
  [ЛЕВАЯ ПЕРЕДНЯЯ КОЛОННА]  ══ ПЕРЕДНЯЯ БАЛКА ══  [ПРАВАЯ ПЕРЕДНЯЯ КОЛОННА]
       |                    | ламели ламели ламели |                    |
       |                    | ════ ════ ════ ════  |                    |
       |                    | ════ ════ ════ ════  |                    |
  [ЛЕВ.ЗАДНЯЯ КОЛОННА]      ══ ЗАДНЯЯ БАЛКА ══    [ПР.ЗАДНЯЯ КОЛОННА]

ВИД СБОКУ — ЛАМЕЛИ ЗАКРЫТЫ:
  ═══════════════════ ← сплошная крыша из ламелей (горизонтальная)
  |                  |
  | ← колонна        | ← колонна
  |                  |

ВИД СБОКУ — ЛАМЕЛИ ОТКРЫТЫ 90°:
  | | | | | | | | | | ← тонкие рёбра ламелей (почти не видны)
  |                  |
  | ← колонна        | ← колонна
  |                  |

═══════════════ АНИМАЦИЯ ═══════════════
КАМЕРА: АБСОЛЮТНО НЕПОДВИЖНА. Ни поворота, ни зума, ни сдвига. Строго фиксированная точка.
КОЛОННЫ: Стоят на земле. Не двигаются никогда.
БАЛКИ: Жёсткие, неподвижные.
ДВИГАЮТСЯ ТОЛЬКО ЛАМЕЛИ — БОЛЬШЕ НИЧЕГО.

0–1с: Все ламели закрыты (0°). Сплошной алюминиевый потолок. Тени максимальные.
1–3с: Мотор включается. ВСЕ ламели начинают ОДНОВРЕМЕННО поворачиваться.
   На 45°: видны равные зазоры, полосатые тени на полу.
3–5с: Все ламели достигают 90° — стоят вертикально на ребре. Максимум неба и воздуха.
5–6с: Пауза в открытом положении.
6–8с: Все ламели возвращаются в 0° — крыша закрывается.
Итого: 8 секунд. Фотореалистичный ${productColor} алюминий.`;

      // ────────────────────────────────────────────────────────────────────────────
      // ТЕНТОВАЯ ПЕРГОЛА — ТКАНЬ-ГАРМОШКА НА НАПРАВЛЯЮЩИХ РЕЛЬСАХ
      // ────────────────────────────────────────────────────────────────────────────
      } else if (productDesc.toLowerCase().includes('tent') || productDesc.toLowerCase().includes('toscana') || productDesc.toLowerCase().includes('guhher')) {
        motionDesc = `
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
СТОП. ПРОЧИТАЙ ВСЁ ПОЛНОСТЬЮ. ГЕНЕРИРУЙ СТРОГО ПО ОПИСАНИЮ.
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓

ПРОДУКТ: ТЕНТОВАЯ ПЕРГОЛА С ВЫДВИЖНОЙ ТКАНЕВОЙ КРЫШЕЙ.
ВАЖНО: ЭТО НЕ МАРКИЗА. Это отдельностоящая пергола (4 колонны) у которой тканевая крыша выдвигается горизонтально по рельсам.

═══════════════ ЧТО ЭТО ТАКОЕ ═══════════════
Тентовая пергола — беседка/навес на 4 колоннах, крыша которой сделана из складывающейся ткани.
Ткань может выдвигаться вперёд покрывая всю крышу, или убираться обнажая скелет.
Как раздвижная шторка в театре, только горизонтальная и уличная.

═══════════════ ДЕТАЛЬ 1: КАРКАС (КОЛОННЫ + БАЛКИ) ═══════════════
4 КОЛОННЫ: Квадратные алюминиевые профили, стоят ВЕРТИКАЛЬНО.
  Прикручены к земле через основания. Высота 2.5–3.5м.
  Расставлены по углам прямоугольника — образуют стороны перголы.
  ВАЖНО: Пергола ОТДЕЛЬНОСТОЯЩАЯ — не крепится к стене здания.
4 БАЛКИ: Прямоугольные профили на вершинах колонн.
  2 длинные боковые балки (идут по длинным сторонам — по глубине).
  2 короткие торцевые балки (идут по коротким сторонам — по ширине).
  Образуют горизонтальный прямоугольный периметр наверху.

═══════════════ ДЕТАЛЬ 2: РЕЛЬСЫ ДЛЯ ТКАНИ ═══════════════
На внутренней стороне ДВУХ ДЛИННЫХ БОКОВЫХ БАЛОК установлены РЕЛЬСЫ (направляющие).
По одному рельсу на каждой боковой балке.
Рельсы идут по всей длине балки от одного торца до другого.
По этим рельсам движется ведущая планка с тканью.

═══════════════ ДЕТАЛЬ 3: БАРАБАН С ТКАНЬЮ (КОРПУС) ═══════════════
На ОДНОМ ТОРЦЕВОМ КОНЦЕ перголы установлен КОРПУС (housing box).
Внутри корпуса: барабан (рулон) вокруг которого намотана водостойкая уличная ткань.
Электромотор вращает этот барабан.
ОТКРЫТИЕ → барабан крутится → ткань разматывается → ведущая планка едет вперёд по рельсам.
ЗАКРЫТИЕ → барабан крутится обратно → ткань наматывается → ведущая планка едет назад.

═══════════════ ДЕТАЛЬ 4: ВЕДУЩАЯ ПЛАНКА (LEAD BAR) ═══════════════
Жёсткая алюминиевая планка прикреплённая к переднему краю ткани.
Длина = вся ширина перголы (от одного рельса до другого).
Катится по двум рельсам одновременно, сохраняя ткань натянутой.
Когда закрыто: планка у корпуса, ткань намотана.
Когда открыто: планка у противоположного торца, ткань натянута горизонтально.

═══════════════ ДЕТАЛЬ 5: ТКАНЬ ═══════════════
МАТЕРИАЛ: Водостойкая уличная ткань (акрил, ПВХ или полиэстер с покрытием).
ФОРМА КОГДА ОТКРЫТА: Полностью ГОРИЗОНТАЛЬНАЯ плоскость (не наклонная как у маркизы!).
  Ткань лежит горизонтально как плоский потолок.
  Натянута тугая, без провисаний и морщин.
  Вид снизу: ровный горизонтальный тканевый потолок по всей площади перголы.
ФОРМА КОГДА ЗАКРЫТА: Ткань намотана на барабан в корпусе — НЕ ВИДНА.
  Скелет перголы открыт — сверху только балки и небо.

═══════════════ ОТЛИЧИЯ ОТ МАРКИЗЫ (важно!) ═══════════════
Маркиза: крепится к СТЕНЕ здания.       Тентовая: 4 колонны, отдельностоящая.
Маркиза: ткань НАКЛОНЕНА (20°).         Тентовая: ткань ГОРИЗОНТАЛЬНАЯ.
Маркиза: ткань разматывается вперёд.    Тентовая: ткань едет по рельсам.
Маркиза: два рычага по бокам.           Тентовая: только ведущая планка.
Маркиза: короб на стене.               Тентовая: корпус у торца перголы.

═══════════════ ЧТО ВИДНО НА КАЖДОМ ЭТАПЕ ═══════════════
ЗАКРЫТА (ткань убрана):
  Четыре колонны + четыре балки + корпус у одного торца. Неба видно через крышу.
  Ткани нет вообще — всё смотано в корпус.

ПОЛУОТКРЫТА:
  Ведущая планка прошла половину пути по рельсам.
  Ткань покрывает половину площади крыши — от корпуса до планки горизонтально.
  Вторая половина крыши ещё открыта — видно небо.

ПОЛНОСТЬЮ ОТКРЫТА:
  Ведущая планка у противоположного (дальнего) торца.
  Ткань покрывает ВСЮ площадь крыши от одного торца до другого.
  Горизонтальный тканевый потолок по всей перголе. Неба не видно.
  Ткань абсолютно плоская, тугая, горизонтальная.
  Под тканью: защита от дождя и солнца на всей площади.

═══════════════ ЗАПРЕЩЁННЫЕ ОШИБКИ ═══════════════
✗ НЕЛЬЗЯ: показывать ткань свисающей вниз или наклонённой — только горизонтально
✗ НЕЛЬЗЯ: добавлять рычаги или пантографы — их нет в тентовой перголе
✗ НЕЛЬЗЯ: крепить конструкцию к стене — она отдельностоящая
✗ НЕЛЬЗЯ: двигать камеру — только ткань движется

═══════════════ АНИМАЦИЯ ═══════════════
КАМЕРА: АБСОЛЮТНО НЕПОДВИЖНА.
КОЛОННЫ, БАЛКИ: Жёсткие, неподвижные.
ТОЛЬКО ТКАНЬ ДВИЖЕТСЯ (едет по рельсам).

0–1с: ЗАКРЫТА — только каркас. Ткани нет. Небо сверху.
1–5с: Мотор запускается. Барабан крутится. Ведущая планка начинает ехать по рельсам
  от корпуса к дальнему торцу. Ткань постепенно разворачивается, покрывая крышу.
  Горизонтальная тканевая поверхность растёт от корпуса вперёд.
5–7с: Ведущая планка у дальнего торца. Вся крыша покрыта горизонтальной тканью. Пауза.
7–8с: Мотор реверс, планка едет обратно, ткань сматывается.
Итого: 8 секунд. Фотореалистичный ${productColor} алюминий, уличная ткань.`;

      } else if (isGlass && !productDesc.toLowerCase().includes('guillotine')) {
        motionDesc = `
PRODUCT: ${productColor} aluminum FRAMELESS SLIDING GLASS SYSTEM.
Multiple tall floor-to-ceiling tempered glass panels hang from top-mount rollers on an aluminum track, bottom in guide channel. Panels slide horizontally and stack overlapping at one side to open (like stacking playing cards). 75-80% of opening becomes free when open.
CAMERA COMPLETELY STATIC. 1) START: all panels aligned, seamless glass wall. 2) Panels slide one by one to one side, stacking. 3) OPEN: all stacked, full opening exposed. 4) Slide back closed.
8 seconds. Photorealistic glass with ${productColor} aluminum.`;

      } else if (productDesc.toLowerCase().includes('guillotine')) {
        motionDesc = `
PRODUCT: ${productColor} aluminum GUILLOTINE VERTICAL-LIFT GLASS SYSTEM.
Glass panels travel straight UPWARD in vertical aluminum guide channels on each side, into an overhead header box above. Chain/cable drive lifts panels.
CAMERA COMPLETELY STATIC. 1) START CLOSED: full-height glass wall, panels in floor channel. 2) Panels rise straight up in channels. 3) MID: gap visible at bottom. 4) FULLY RAISED: panels hidden in header box, space fully open below. 5) Descend back down.
8 seconds. Photorealistic glass with ${productColor} aluminum channels.`;

      } else if (productDesc.toLowerCase().includes('zip') || productDesc.toLowerCase().includes('blind')) {
        motionDesc = `
PRODUCT: ${productColor} aluminum ZIP BLIND SCREENS.
Top housing box with motor. Two vertical aluminum guide channels on sides (full height). Fabric has ZIP CORD on each side edge locking into channels — fabric stays perfectly flat, no billowing. Weighted bottom bar.
CAMERA COMPLETELY STATIC. 1) START: housing at top, opening exposed. 2) Fabric unrolls downward, zip edges lock into channels, fabric is flat and taut. 3) Bottom bar reaches floor — complete flat screen. 4) Rolls back up.
8 seconds. Photorealistic flat fabric and ${productColor} aluminum.`;

      } else {
        motionDesc = `${productColor} aluminum outdoor structure. CAMERA STAYS STILL. Movable elements animate from closed to open and back. 8 seconds. Photorealistic.`;
      }
      const veoPrompt = `Professional architectural product visualization. STRICT RULES: camera is COMPLETELY STATIC throughout (no pan, no zoom, no rotation), building/ground/sky/frame are RIGID and STILL, ONLY the mechanical moving parts of the product animate, use the input image as exact reference for scene composition and proportions. SCENE: ${sceneCtx} PRODUCT MOTION: ${motionDesc} Photorealistic quality. No people.`;

      // Try Veo 3 models — use x-goog-api-key header (NOT ?key= query param)
      const veoModels = [
        'veo-3-generate',
        'veo-3-fast-generate',
        'veo-3-lite-generate',
        'veo-3.0-generate-preview',
        'veo-2.0-generate-001',
      ];

      let veoError = null;

      for (const veoModel of veoModels) {
        try {
          const veoUrl = `https://generativelanguage.googleapis.com/v1beta/models/${veoModel}:predictLongRunning`;
          const veoRes = await fetch(veoUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': geminiKey,
            },
            body: JSON.stringify({
              instances: [{
                prompt: veoPrompt,
                image: {
                  bytesBase64Encoded: generatedImageBase64,
                  mimeType: generatedMimeType,
                },
              }],
              parameters: {
                aspectRatio: '16:9',
                sampleCount: 1,
                durationSeconds: 8,
              },
            }),
          });

          if (!veoRes.ok) {
            const errData = await veoRes.json().catch(() => ({}));
            const errMsg = errData?.error?.message || `HTTP ${veoRes.status}`;
            veoError = `${veoModel}: ${errMsg}`;
            if (veoRes.status === 404 || errMsg.includes('not found') || errMsg.includes('not supported')) continue;
            return res.status(200).json({
              success: true,
              image: { data: generatedImageBase64, mimeType: generatedMimeType },
              analysis, model: usedModel,
              videoError: `Veo (${veoModel}): ${errMsg}`,
            });
          }

          const veoData = await veoRes.json();
          const operationName = veoData.name;
          if (!operationName) {
            veoError = `${veoModel}: no operation name in response`;
            continue;
          }

          const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${operationName}`;
          let videoBase64 = null, videoMime = 'video/mp4', videoUrl = null;

          for (let attempt = 0; attempt < 30; attempt++) {
            await new Promise(r => setTimeout(r, 5000));
            const pr = await fetch(pollUrl, { headers: { 'x-goog-api-key': geminiKey } });
            if (!pr.ok) { veoError = `Poll HTTP ${pr.status}`; break; }
            const pd = await pr.json();
            if (pd.error) { veoError = pd.error.message; break; }
            if (pd.done) {
              const resp = pd.response;
              const gv = resp?.generatedVideos?.[0]?.video;
              if (gv?.bytesBase64Encoded) { videoBase64 = gv.bytesBase64Encoded; videoMime = gv.mimeType || 'video/mp4'; }
              else if (gv?.uri) videoUrl = gv.uri;
              const sv = resp?.generateVideoResponse?.generatedSamples?.[0]?.video;
              if (sv?.bytesBase64Encoded) videoBase64 = sv.bytesBase64Encoded;
              else if (sv?.uri) videoUrl = sv.uri;
              const vs = resp?.generateVideoResponse?.videos || resp?.videos;
              if (vs?.[0]?.bytesBase64Encoded) videoBase64 = vs[0].bytesBase64Encoded;
              break;
            }
          }

          if (videoUrl && !videoBase64) {
            try {
              const dlRes = await fetch(videoUrl, { headers: { 'x-goog-api-key': geminiKey } });
              if (dlRes.ok) {
                const buf = await dlRes.arrayBuffer();
                videoBase64 = Buffer.from(buf).toString('base64');
                videoMime = dlRes.headers.get('content-type') || 'video/mp4';
                videoUrl = null;
              }
            } catch (dlErr) {}
          }

          return res.status(200).json({
            success: true,
            image: { data: generatedImageBase64, mimeType: generatedMimeType },
            analysis, model: usedModel, videoModel: veoModel,
            video: videoBase64 ? { base64: videoBase64, mimeType: videoMime }
                 : videoUrl    ? { url: videoUrl, mimeType: 'video/mp4' }
                 : null,
            videoError: (!videoUrl && !videoBase64)
              ? (veoError || 'Veo generation timed out. Try again.')
              : null,
          });

        } catch (e) {
          veoError = `${veoModel}: ${e.message}`;
          continue;
        }
      }

      // All Veo models failed
      return res.status(200).json({
        success: true,
        image: { data: generatedImageBase64, mimeType: generatedMimeType },
        analysis, model: usedModel,
        videoError: `Veo: ${veoError}`,
      });
    }

    // Photo-only response
    return res.status(200).json({
      success: true,
      image: { data: generatedImageBase64, mimeType: generatedMimeType },
      analysis, model: usedModel,
    });

  } catch (err) {
    console.error('generate.js error:', err.message);
    return res.status(200).json({ success: false, error: err.message || 'Unknown server error' });
  }
}
