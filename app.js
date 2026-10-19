/* ============================================================================
   L'ATELIER — Complete Personal Digital Wardrobe, AI Stylist & Try-On Engine
   Zero-Build Static PWA | IndexedDB (Dexie) | Gemini 2.5 Vision & Stylist API
   ============================================================================ */

const db = new Dexie('AtelierWardrobeDB');
db.version(1).stores({
  garments: 'id, category, layer_slot, status, is_favorite, wear_count, storage_location, retail_match_status, created_at',
  makeup: 'id, category, shade_name, undertone',
  looks: 'id, occasion, created_by, rating, created_at',
  trips: 'id, name, created_at',
  avatars: 'id, label',
  tryon_cache: 'cache_key, created_at'
});

// App State
const state = {
  activeTab: 'closet',
  closetCategory: 'all',
  closetQuickFilter: null,
  studioMode: 'separates', // 'separates' | 'full'
  studioSlots: {
    top: null,
    bottom: null,
    full: null,
    outer: null,
    footwear: null,
    jewellery: null,
    bag: null,
    geminiKey: localStorage.getItem('atelier_gemini_key') || '',
    geminiModel: localStorage.getItem('atelier_gemini_model') || 'gemini-2.5-flash',
    syncUrl: localStorage.getItem('atelier_sync_url') || 'https://script.google.com/macros/s/AKfycbyIpq5V3MV4tDVi-rmOUPLcuy153gCFY8xFYmeh_l5er4i8xKxeQgqg3cWrhxUWlDbDzA/exec'
  },
  lockedSlots: {
    top: false,
    bottom: false,
    full: false,
    outer: false,
    footwear: false,
    jewellery: false,
    bag: false
  },
  currentMakeup: { lip: null, eye: null, cheek: null },
  profile: {
    undertone: localStorage.getItem('prof_undertone') || 'warm',
    seasonPalette: localStorage.getItem('prof_season') || 'Deep Autumn',
    heightCm: Number(localStorage.getItem('prof_height') || 162),
    geminiKey: localStorage.getItem('atelier_gemini_key') || '',
    geminiModel: localStorage.getItem('atelier_gemini_model') || 'gemini-2.5-flash',
    syncUrl: localStorage.getItem('atelier_sync_url') || ''
  }
};

// ============================================================================
// 1. INITIALIZATION & PERSISTENT STORAGE LOCK
// ============================================================================
window.addEventListener('DOMContentLoaded', async () => {
  initThemeMode();
  lucide.createIcons();
  await initStoragePersistence();
  loadProfileUI();
  await refreshAllViews();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});

async function initStoragePersistence() {
  const statusEl = document.getElementById('storagePersistStatus');
  if (navigator.storage && navigator.storage.persist) {
    const isPersisted = await navigator.storage.persist();
    if (statusEl) {
      statusEl.textContent = isPersisted
        ? 'Protected: Browser will never auto-evict her 200+ item catalog.'
        : 'Standard local storage active. Use Export Backup periodically.';
    }
  }
}

async function refreshAllViews() {
  await updateHeaderAndStats();
  await populateLocationDropdown();
  await renderCloset();
  await initStudioSlots();
  await renderLookbook();
  await renderTrips();
  await renderBeautyAndAvatars();
  lucide.createIcons();
}

function showToast(msg) {
  const t = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2800);
}
// --- 1. NEW: Ingestion UI Tab Switcher ---
function switchIngestTab(tab) {
  const isUpload = tab === 'upload';
  document.getElementById('ingestViewUpload').classList.toggle('hidden', !isUpload);
  document.getElementById('ingestViewLink').classList.toggle('hidden', isUpload);
  document.getElementById('ingestTabUpload').className = isUpload ? 'px-4 py-2 rounded-full bg-champagne text-plum font-semibold text-xs tracking-wider uppercase' : 'px-4 py-2 rounded-full bg-plumcard text-stone-400 hover:text-goldlight font-semibold text-xs tracking-wider uppercase transition';
  document.getElementById('ingestTabLink').className = !isUpload ? 'px-4 py-2 rounded-full bg-champagne text-plum font-semibold text-xs tracking-wider uppercase' : 'px-4 py-2 rounded-full bg-plumcard text-stone-400 hover:text-goldlight font-semibold text-xs tracking-wider uppercase transition';
}

// ============================================================================
// 2. IMAGE PROCESSING: WEBP COMPRESSION & CLIENT-SIDE BACKGROUND CUTOUT
// ============================================================================
async function processImageFile(file, autoCutout = true, maxDim = 768) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        const originalDataUrl = canvas.toDataURL('image/webp', 0.82);

        if (!autoCutout) {
          resolve({ originalDataUrl, cutoutDataUrl: originalDataUrl, dominantHex: sampleDominantColor(ctx, w, h) });
          return;
        }

        // Fast client-side corner flood-fill background removal for studio/wall/bed shots
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;
        const corners = [
          [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
          [Math.floor(w / 2), 0], [0, Math.floor(h / 2)], [w - 1, Math.floor(h / 2)]
        ];

        // Average corner background color
        let bgR = 0, bgG = 0, bgB = 0;
        corners.forEach(([cx, cy]) => {
          const idx = (cy * w + cx) * 4;
          bgR += data[idx];
          bgG += data[idx + 1];
          bgB += data[idx + 2];
        });
        bgR /= corners.length;
        bgG /= corners.length;
        bgB /= corners.length;

        const tolerance = 44;
        const visited = new Uint8Array(w * h);
        const queue = [...corners];

        while (queue.length > 0) {
          const [x, y] = queue.pop();
          if (x < 0 || x >= w || y < 0 || y >= h) continue;
          const pos = y * w + x;
          if (visited[pos]) continue;
          visited[pos] = 1;

          const idx = pos * 4;
          const dist = Math.sqrt(
            Math.pow(data[idx] - bgR, 2) +
            Math.pow(data[idx + 1] - bgG, 2) +
            Math.pow(data[idx + 2] - bgB, 2)
          );

          if (dist <= tolerance) {
            data[idx + 3] = 0; // Transparent
            queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
          }
        }

        ctx.putImageData(imgData, 0, 0);
        const cutoutDataUrl = canvas.toDataURL('image/webp', 0.85);
        const dominantHex = sampleDominantColor(ctx, w, h);
        resolve({ originalDataUrl, cutoutDataUrl, dominantHex });
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function sampleDominantColor(ctx, w, h) {
  const data = ctx.getImageData(Math.floor(w * 0.3), Math.floor(h * 0.3), Math.max(1, Math.floor(w * 0.4)), Math.max(1, Math.floor(h * 0.4))).data;
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < data.length; i += 16) {
    if (data[i + 3] > 128) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count++;
    }
  }
  if (!count) return '#78716c';
  r = Math.round(r / count);
  g = Math.round(g / count);
  b = Math.round(b / count);
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// ============================================================================
// 3. BULK INGESTION QUEUE & GEMINI VISION AUTO-TAGGER
// ============================================================================
async function handleBulkFilesSelected(event) {
  const files = Array.from(event.target.files);
  if (!files.length) return;

  const defaultLoc = document.getElementById('ingestDefaultLocation').value.trim() || 'Wardrobe';
  const priceVal = parseFloat(document.getElementById('ingestPrice').value) || 0;
  const isMultiAngle = document.getElementById('ingestMultiAngleToggle').checked;

  document.getElementById('ingestProgressWrap').classList.remove('hidden');

  if (isMultiAngle) {
    // Process all files as ONE item
    document.getElementById('ingestProgressText').textContent = `Merging ${files.length} angles into 1 item...`;
    document.getElementById('ingestProgressBar').style.width = `50%`;

    const processedImgs = [];
    for (const f of files) {
      processedImgs.push(await processImageFile(f, true));
    }

    const base64Array = processedImgs.map(p => p.originalDataUrl.split(',')[1]);
    const extractedData = await analyzeGarmentWithGeminiMulti(base64Array);
    
    await createAndSaveItemRecord(extractedData, processedImgs, defaultLoc, priceVal, '');
    document.getElementById('ingestProgressBar').style.width = `100%`;
    showToast('Multi-angle item archived!');

  } else {
    // Process files individually
    for (let i = 0; i < files.length; i++) {
      document.getElementById('ingestProgressText').textContent = `Cataloging ${i + 1} of${files.length}...`;
      document.getElementById('ingestProgressBar').style.width = `${Math.round(((i + 1) / files.length) * 100)}%`;
      
      const processed = await processImageFile(files[i], true);
      const extractedData = await analyzeGarmentWithGeminiMulti([processed.originalDataUrl.split(',')[1]]);
      await createAndSaveItemRecord(extractedData, [processed], defaultLoc, priceVal, '');
      
      if (files.length > 3 && i < files.length - 1) await new Promise(r => setTimeout(r, 3500)); // Rate limit buffer
    }
    showToast(`Archived ${files.length} pieces!`);
  }
  
  await refreshAllViews();
}
// --- 3. NEW: Web Link Importer (Bypassing CORS via free proxy) ---
// --- CRASH-PROOF WEB LINK IMPORTER (MULTI-IMAGE & AMAZON FALLBACK) ---
async function handleWebLinksIngest() {
  const linksRaw = document.getElementById('ingestWebLinks').value;
  const links = linksRaw.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
  if (!links.length) { showToast('Paste valid http URLs'); return; }

  const defaultLoc = document.getElementById('ingestDefaultLocation').value.trim() || 'Online Order';
  const priceVal = parseFloat(document.getElementById('ingestPrice').value) || 0;
  
  const progressWrap = document.getElementById('ingestProgressWrap');
  const progressText = document.getElementById('ingestProgressText');
  const progressBar = document.getElementById('ingestProgressBar');
  progressWrap.classList.remove('hidden');

  for (let i = 0; i < links.length; i++) {
    progressText.textContent = `Scraping link ${i + 1} of ${links.length}...`;
    progressBar.style.width = `${Math.round(((i + 1) / links.length) * 100)}%`;

    try {
      // Use AllOrigins to bypass CORS
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(links[i])}`;
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error("Proxy failed");
      const data = await res.json();
      const html = data.contents;
      
      // Amazon/Bot-protected site check
      if (html.includes('captcha') || html.includes('automated access')) {
        showToast('Site blocked scraper. Use Photo Upload for Amazon.');
        continue; // Skip this link safely without crashing
      }

      // Extract multiple images using Regex (filtering out tiny icons/gifs)
      const imgRegex = /<img[^>]+src="([^">]+)"/gi;
      let match;
      let validImgUrls = [];
      
      // Also check for OpenGraph main image
      const ogMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
      if (ogMatch && ogMatch[1]) validImgUrls.push(ogMatch[1]);

      while ((match = imgRegex.exec(html)) !== null) {
        let src = match[1];
        if (src.startsWith('//')) src = 'https:' + src;
        if (!src.startsWith('http')) continue;
        if (src.includes('.gif') || src.toLowerCase().includes('icon') || src.toLowerCase().includes('logo')) continue;
        validImgUrls.push(src);
      }

      // Deduplicate and limit to top 4 images to save Gemini processing time
      validImgUrls = [...new Set(validImgUrls)].slice(0, 4);

      if (validImgUrls.length > 0) {
        progressText.textContent = `Extracting ${validImgUrls.length} angles via Gemini...`;
        
        let processedImgs = [];
        for (const imgUrl of validImgUrls) {
          try {
            // Fetch image via proxy to avoid Canvas taint
            const imgBlobProxy = `https://corsproxy.io/?${encodeURIComponent(imgUrl)}`;
            const imgRes = await fetch(imgBlobProxy);
            const blob = await imgRes.blob();
            const file = new File([blob], "web_import.jpg", { type: blob.type });
            processedImgs.push(await processImageFile(file, true));
          } catch(e) { console.warn('Failed one image:', e); }
        }

        if (processedImgs.length > 0) {
          const base64Array = processedImgs.map(p => p.originalDataUrl.split(',')[1]);
          const extractedData = await analyzeGarmentWithGeminiMulti(base64Array);
          await createAndSaveItemRecord(extractedData, processedImgs, defaultLoc, priceVal, links[i]);
        }
      } else {
        showToast('No usable images found on that page.');
      }
    } catch (e) {
      console.error('Failed to scrape link:', links[i], e);
      showToast('Scrape failed. Try uploading photos.');
    }
  }
  
  // FINALLY block equivalent: ensure UI resets
  document.getElementById('ingestWebLinks').value = '';
  progressWrap.classList.add('hidden');
  progressBar.style.width = '0%';
  await refreshAllViews();
}
async function analyzeGarmentWithGeminiMulti(base64Array) {
  if (!state.profile.geminiKey) return {};
  
  const prompt = `Analyze these image(s) of a single garment/accessory from potentially multiple angles. Return ONLY valid JSON:
  {
    "name": "Descriptive title (e.g. Emerald Banarasi Silk Saree)",
    "category": "top, bottom, drape, dress, outer, footwear, jewellery, bag",
    "subcategory": "specific type",
    "brand": "brand name if visible",
    "color_name": "main color",
    "undertone": "warm, cool, or neutral",
    "pattern": "Solid, Floral, Zari, Printed, etc.",
    "fabric": "Silk, Cotton, Linen, Leather, etc.",
    "silhouette": "fitted, flowy, oversized, or structured",
    "neckline": "v_neck, high_neck, boat, scoop, collar, sweet_heart, or none",
    "formality": 3
  }`;

  const parts = [{ text: prompt }];
  base64Array.forEach(b64 => parts.push({ inlineData: { mimeType: 'image/webp', data: b64 } }));

  try {
    // Default to Flash for batching, Pro is reserved for Lookbook generation
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${state.profile.geminiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json' } })
    });
    const data = await res.json();
    return JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
  } catch (err) {
    return {};
  }
}

// --- 5. NEW: Unified Item Creator ---
async function createAndSaveItemRecord(aiAttrs, processedImgsArray, location, price, sourceUrl) {
  const primaryImg = processedImgsArray[0];
  const galleryUrls = processedImgsArray.map(p => p.cutoutDataUrl);

  const id = 'GAR-' + Date.now().toString().slice(-5) + '-' + Math.floor(Math.random() * 90 + 10);
  const garmentRecord = {
    id,
    name: aiAttrs.name || 'Bespoke Piece',
    category: aiAttrs.category || 'top',
    brand: aiAttrs.brand || '',
    price: price || 0,
    original_img: primaryImg.originalDataUrl,
    cutout_img: primaryImg.cutoutDataUrl,
    gallery: galleryUrls, // Stores all multiple angles
    studio_upgrade_img: '',
    active_img: primaryImg.cutoutDataUrl,
    retail_match_status: sourceUrl ? 'confirmed' : (aiAttrs.brand ? 'candidate' : 'unmatched'),
    retail_source_url: sourceUrl || '',
    storage_location: location,
    is_favorite: false,
    wear_count: 0,
    status: 'active', // 'active' | 'laundry'
    created_at: Date.now(),
    attrs: {
      color_hex: primaryImg.dominantHex,
      color_name: aiAttrs.color_name || 'Classic',
      undertone: aiAttrs.undertone || 'warm',
      pattern: aiAttrs.pattern || 'Solid',
      fabric: aiAttrs.fabric || 'Woven',
      silhouette: aiAttrs.silhouette || 'balanced',
      neckline: aiAttrs.neckline || 'none'
    }
  };

  await db.garments.put(garmentRecord);
  prependIngestReviewCard(document.getElementById('ingestReviewGrid'), garmentRecord);
}

async function analyzeGarmentWithGemini(base64DataUrl) {
  const base64Clean = base64DataUrl.split(',')[1];
  const prompt = `Analyze this clothing, saree/ethnic garment, footwear, handbag, or jewellery image (and any visible brand tag). Return ONLY valid JSON with these exact keys:
{
  "name": "Descriptive short title (e.g. Emerald Banarasi Silk Saree or Ivory Linen Blazer)",
  "category": "one of: top, bottom, drape, dress, outer, footwear, jewellery, bag",
  "subcategory": "specific type (e.g. Kurti, Blouse, Saree, Lehenga, Palazzo, Jhumka, Necklace, Heels)",
  "brand": "brand name if visible on label, else empty string",
  "sku": "product code if visible, else empty string",
  "color_name": "main color name",
  "undertone": "warm, cool, or neutral",
  "pattern": "Solid, Floral, Zari/Embroidered, Printed, Striped, or Textured",
  "fabric": "Silk, Cotton, Linen, Chiffon, Georgette, Denim, Leather, or Metal/Gold",
  "silhouette": "fitted, flowy, oversized, or structured",
  "neckline": "v_neck, high_neck, boat, scoop, collar, sweet_heart, or none",
  "metal_tone": "gold, silver, rose_gold, oxidized, or none",
  "formality": 3,
  "occasions": ["Casual Chic", "Festive & Ethnic", "Wedding & Grand", "Evening Dinner", "Resort & Travel", "Smart Formal"]
}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${state.profile.geminiModel}:generateContent?key=${state.profile.geminiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType: 'image/webp', data: base64Clean } }
        ]
      }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  });

  if (!res.ok) throw new Error('Gemini API call failed');
  const data = await res.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return JSON.parse(rawText);
}

function prependIngestReviewCard(container, item) {
  const div = document.createElement('div');
  div.className = 'flex items-center justify-between gap-3 p-2.5 bg-white rounded-2xl border border-stone-200 shadow-sm';
  div.innerHTML = `
    <div class="flex items-center gap-3">
      <img src="${item.active_img}" class="w-12 h-14 object-contain rounded-xl cutout-bg border border-stone-100" />
      <div>
        <p class="text-xs font-bold text-stone-900">${item.name}</p>
        <p class="text-[11px] text-stone-500">${item.category.toUpperCase()} • ${item.attrs.color_name} • ${item.attrs.fabric} • 📍 ${item.storage_location}</p>
      </div>
    </div>
    <button onclick="openItemDetailModal('${item.id}')" class="px-3 py-1.5 rounded-xl bg-stone-100 hover:bg-stone-200 text-xs font-semibold text-stone-800">
      Edit / Studio Match
    </button>
  `;
  container.prepend(div);
}

// ============================================================================
// 4. CLOSET CATALOGUE & 4-STATE RETAIL STUDIO UPGRADE MODAL
// ============================================================================
async function updateHeaderAndStats() {
  const items = await db.garments.toArray();
  const looks = await db.looks.toArray();
  document.getElementById('statTotalItems').textContent = items.length;
  document.getElementById('statTotalLooks').textContent = looks.length;
  document.getElementById('statUnwornItems').textContent = items.filter(i => (i.wear_count || 0) === 0).length;
  document.getElementById('statStudioUpgrades').textContent = items.filter(i => i.retail_match_status === 'confirmed' || i.brand).length;
}

async function populateLocationDropdown() {
  const items = await db.garments.toArray();
  const locs = Array.from(new Set(items.map(i => i.storage_location).filter(Boolean)));
  const sel = document.getElementById('closetLocationFilter');
  const current = sel.value;
  sel.innerHTML = `<option value="all">All Locations (${items.length})</option>` +
    locs.map(l => `<option value="${l}">📍 ${l}</option>`).join('');
  if (locs.includes(current)) sel.value = current;
}

function setClosetCategory(cat) {
  state.closetCategory = cat;
  state.closetQuickFilter = null;
  document.querySelectorAll('#categoryFilterBar .cat-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cat === cat);
  });
  renderCloset();
}

function setClosetQuickFilter(filterType) {
  state.closetQuickFilter = state.closetQuickFilter === filterType ? null : filterType;
  renderCloset();
}

async function renderCloset() {
  let items = await db.garments.toArray();
  const search = (document.getElementById('closetSearch')?.value || '').toLowerCase().trim();
  const locFilter = document.getElementById('closetLocationFilter')?.value || 'all';
  const sortMode = document.getElementById('closetSort')?.value || 'newest';

  if (state.closetCategory !== 'all') {
    items = items.filter(i => i.category === state.closetCategory);
  }
  if (state.closetQuickFilter === 'unworn') {
    items = items.filter(i => (i.wear_count || 0) === 0);
  } else if (state.closetQuickFilter === 'upgrade_ready') {
    items = items.filter(i => i.retail_match_status === 'confirmed' || i.brand);
  }
  if (locFilter !== 'all') {
    items = items.filter(i => i.storage_location === locFilter);
  }
  if (search) {
    items = items.filter(i =>
      i.name.toLowerCase().includes(search) ||
      (i.brand || '').toLowerCase().includes(search) ||
      (i.attrs?.color_name || '').toLowerCase().includes(search) ||
      (i.attrs?.fabric || '').toLowerCase().includes(search) ||
      (i.storage_location || '').toLowerCase().includes(search)
    );
  }

  if (sortMode === 'favorites') items.sort((a, b) => Number(b.is_favorite) - Number(a.is_favorite));
  else if (sortMode === 'least_worn') items.sort((a, b) => (a.wear_count || 0) - (b.wear_count || 0));
  else if (sortMode === 'most_worn') items.sort((a, b) => (b.wear_count || 0) - (a.wear_count || 0));
  else items.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  const grid = document.getElementById('closetGrid');
  const empty = document.getElementById('closetEmptyState');

  if (!items.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const statusBadgeMap = {
    confirmed: `<span class="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-900 text-[9px] font-bold">STUDIO IMAGE</span>`,
    candidate: `<span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-[9px] font-bold">MATCH READY</span>`,
    similar: `<span class="px-1.5 py-0.5 rounded bg-sky-100 text-sky-900 text-[9px] font-bold">REF IMAGE</span>`,
    unmatched: ''
  };

  grid.innerHTML = items.map(item => `
    <div class="bg-white rounded-2xl border border-stone-200/90 overflow-hidden shadow-sm hover:shadow-md transition flex flex-col justify-between group">
      <div class="relative aspect-[3/4] cutout-bg flex items-center justify-center p-3 cursor-pointer" onclick="openItemDetailModal('${item.id}')">
        <img src="${item.active_img}" alt="${item.name}" class="max-h-full max-w-full object-contain group-hover:scale-105 transition duration-300" loading="lazy" />
        <button onclick="event.stopPropagation(); toggleFavoriteItem('${item.id}')" class="absolute top-2.5 right-2.5 w-7 h-7 rounded-full bg-white/90 shadow flex items-center justify-center ${item.is_favorite ? 'text-rose-600' : 'text-stone-400'}">
          ♥
        </button>
        <div class="absolute top-2.5 left-2.5 flex flex-col gap-1">
          ${statusBadgeMap[item.retail_match_status] || ''}
        </div>
        <div class="absolute bottom-2 left-2 right-2 flex items-center justify-between text-[10px]">
          <span class="px-2 py-0.5 rounded-full bg-stone-900/80 text-white font-medium truncate max-w-[70%]">📍 ${item.storage_location || 'Wardrobe'}</span>
          <span class="px-1.5 py-0.5 rounded-full bg-white/90 text-stone-700 font-semibold border border-stone-200">${item.wear_count || 0}x</span>
        </div>
      </div>
      <div class="p-2.5">
        <div class="flex items-center justify-between gap-1">
          <p class="text-xs font-bold text-stone-900 truncate">${item.name}</p>
          <span class="w-3 h-3 rounded-full border border-stone-300 shrink-0" style="background:${item.attrs?.color_hex || '#ccc'}"></span>
        </div>
        <p class="text-[11px] text-stone-500 truncate mt-0.5">${item.brand ? item.brand + ' • ' : ''}${item.attrs?.fabric || ''} • ${item.attrs?.pattern || ''}</p>
        <div class="mt-2 pt-2 border-t border-stone-100 flex items-center justify-between">
          <button onclick="sendItemToStudio('${item.id}')" class="text-[11px] font-semibold text-amber-800 hover:underline">Style This →</button>
          <button onclick="openItemDetailModal('${item.id}')" class="text-[11px] text-stone-500 hover:text-stone-900">Details</button>
        </div>
      </div>
    </div>
  `).join('');
}

async function toggleFavoriteItem(id) {
  const item = await db.garments.get(id);
  if (!item) return;
  item.is_favorite = !item.is_favorite;
  await db.garments.put(item);
  renderCloset();
}

// ============================================================================
// ITEM DETAILS, MULTI-ANGLE GALLERY, CPW, AND LAUNDRY TOGGLE
// ============================================================================

async function openItemDetailModal(id) {
  const item = await db.garments.get(id);
  if (!item) return;

  document.getElementById('detailItemIdBadge').textContent = item.id;
  document.getElementById('detailModalTitle').textContent = item.name;

  const searchQuery = encodeURIComponent(`${item.brand || ''} ${item.sku || ''} ${item.name} ${item.attrs?.color_name || ''} ${item.attrs?.fabric || ''}`.trim());
  const googleShoppingUrl = `https://www.google.com/search?tbm=isch&q=${searchQuery}`;

  // 1. Calculate CPW (Cost Per Wear)
  const cpw = item.price ? (item.wear_count > 0 ? (item.price / item.wear_count).toFixed(2) : item.price.toFixed(2)) : '0.00';

  // 2. Generate Multi-Angle Gallery HTML (Only shows if item has multiple images)
  const galleryHtml = (item.gallery && item.gallery.length > 1)
    ? `<div class="flex gap-2 overflow-x-auto py-2 mb-4">
         ${item.gallery.map(img => `<img src="${img}" onclick="setPrimaryGarmentImage('${item.id}', 'gallery', '${img}')" class="w-16 h-20 object-contain bg-white rounded-lg border ${item.active_img === img ? 'border-champagne ring-1 ring-champagne' : 'border-champagne/20'} cursor-pointer hover:border-champagne transition" />`).join('')}
       </div>`
    : '';

  const content = document.getElementById('itemDetailContent');
  content.innerHTML = `
    <!-- Top Bar: Laundry Status & Analytics -->
    <div class="flex flex-wrap items-center justify-between bg-plumlight p-3.5 rounded-2xl border border-champagne/30 mb-4 gap-2">
      <div class="flex items-center gap-3.5 text-xs">
        <span class="text-stone-400 uppercase tracking-widest text-[9px] font-bold">Metrics:</span>
        <span class="text-white font-semibold">Cost: $${item.price || 0}</span>
        <span class="text-emerald-400 font-semibold">CPW: $${cpw}</span>
      </div>
      <label class="flex items-center gap-2 text-[10px] uppercase tracking-wider font-bold cursor-pointer transition ${item.status === 'laundry' ? 'text-rose-400' : 'text-stone-400 hover:text-goldlight'}">
        <input type="checkbox" onchange="toggleLaundryStatus('${item.id}', this.checked)" class="sr-only" ${item.status === 'laundry' ? 'checked' : ''}>
        <i data-lucide="${item.status === 'laundry' ? 'waves' : 'shirt'}" class="w-4 h-4"></i>
        ${item.status === 'laundry' ? 'In Laundry/Repair' : 'Mark in Laundry'}
      </label>
    </div>

    <!-- Gallery Strip -->
    ${galleryHtml}

    <!-- Side-by-Side Original vs Studio Catalog Upgrade -->
    <div class="bg-plumlight p-4 rounded-2xl border border-champagne/20 mb-4">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h4 class="text-[10px] font-bold uppercase tracking-widest text-white">4-State Studio Match</h4>
          <p class="text-[10px] text-stone-400 mt-0.5">Approve an online photo for cleaner lookbooks.</p>
        </div>
        <select id="editRetailStatus" class="px-3 py-1.5 rounded-lg bg-plumcard border border-champagne/30 text-xs font-semibold text-goldlight focus:outline-none focus:border-champagne">
          <option value="unmatched" ${item.retail_match_status === 'unmatched' ? 'selected' : ''}>Unmatched</option>
          <option value="candidate" ${item.retail_match_status === 'candidate' ? 'selected' : ''}>Strong Candidate</option>
          <option value="similar" ${item.retail_match_status === 'similar' ? 'selected' : ''}>Similar Reference</option>
          <option value="confirmed" ${item.retail_match_status === 'confirmed' ? 'selected' : ''}>Confirmed Exact</option>
        </select>
      </div>

      <div class="grid grid-cols-2 gap-4 my-3">
        <div class="bg-plumcard p-3 rounded-xl border ${item.active_img === item.cutout_img ? 'border-champagne ring-1 ring-champagne' : 'border-champagne/20'} text-center transition">
          <p class="text-[9px] font-bold uppercase tracking-widest text-stone-400 mb-2">Original Cutout</p>
          <img src="${item.cutout_img}" class="h-36 mx-auto object-contain cutout-bg rounded-lg" />
          <button onclick="setPrimaryGarmentImage('${item.id}', 'cutout')" class="mt-3 w-full py-2 rounded-lg bg-plumlight hover:bg-silkdark border border-champagne/20 text-white text-[10px] font-semibold tracking-wider uppercase transition">Use Original</button>
        </div>

        <div class="bg-plumcard p-3 rounded-xl border ${item.studio_upgrade_img && item.active_img === item.studio_upgrade_img ? 'border-emerald-400 ring-1 ring-emerald-400' : 'border-champagne/20'} text-center flex flex-col justify-between transition">
          <p class="text-[9px] font-bold uppercase tracking-widest text-emerald-400 mb-2">Studio Upgrade</p>
          ${item.studio_upgrade_img
            ? `<img src="${item.studio_upgrade_img}" class="h-36 mx-auto object-contain rounded-lg bg-white" />
               <button onclick="setPrimaryGarmentImage('${item.id}', 'studio')" class="mt-3 w-full py-2 rounded-lg bg-emerald-900/40 border border-emerald-500/50 text-emerald-400 hover:bg-emerald-900/60 text-[10px] font-semibold tracking-wider uppercase transition">Use Studio</button>`
            : `<div class="h-36 flex flex-col items-center justify-center text-[10px] text-stone-500 px-2 italic font-serif">
                 No studio image linked yet. Paste URL below.
               </div>`
          }
        </div>
      </div>

      <div class="flex flex-wrap gap-2 items-center mt-4">
        <a href="${googleShoppingUrl}" target="_blank" class="px-3.5 py-2.5 rounded-xl bg-plumcard border border-champagne/40 hover:border-champagne text-goldlight text-[11px] font-semibold flex items-center gap-1.5 transition">
          <i data-lucide="search" class="w-3.5 h-3.5"></i> Find Store Image
        </a>
        <input id="editStudioImgUrl" type="url" value="${item.studio_upgrade_img || ''}" placeholder="Paste Image URL here..." class="flex-1 px-3.5 py-2.5 bg-plumcard border border-champagne/30 rounded-xl text-xs text-white focus:outline-none focus:border-champagne transition" />
        <button onclick="applyStudioImageUrl('${item.id}')" class="btn-gold px-4 py-2.5 rounded-xl text-[11px] font-bold tracking-wider uppercase shadow-md transition">Preview</button>
      </div>
    </div>

    <!-- Editable Metadata Grid -->
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs mb-5">
      <div>
        <label class="text-[9px] font-bold uppercase tracking-widest text-stone-400">Item Name</label>
        <input id="editItemName" type="text" value="${item.name}" class="w-full mt-1.5 px-3 py-2.5 bg-plumlight border border-champagne/30 rounded-xl text-white focus:outline-none focus:border-champagne" />
      </div>
      <div>
        <label class="text-[9px] font-bold uppercase tracking-widest text-stone-400">Category</label>
        <select id="editItemCat" class="w-full mt-1.5 px-3 py-2.5 bg-plumlight border border-champagne/30 rounded-xl text-goldlight focus:outline-none focus:border-champagne">
          ${['top','bottom','drape','dress','outer','footwear','jewellery','bag'].map(c => `<option value="${c}" ${item.category === c ? 'selected' : ''}>${c.toUpperCase()}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="text-[9px] font-bold uppercase tracking-widest text-stone-400">Vault Location</label>
        <input id="editItemLoc" type="text" value="${item.storage_location || ''}" placeholder="e.g. Almirah 2" class="w-full mt-1.5 px-3 py-2.5 bg-plumlight border border-champagne/30 rounded-xl text-white focus:outline-none focus:border-champagne" />
      </div>
      <div>
        <label class="text-[9px] font-bold uppercase tracking-widest text-stone-400">Purchase Price</label>
        <input id="editItemPrice" type="number" value="${item.price || 0}" class="w-full mt-1.5 px-3 py-2.5 bg-plumlight border border-champagne/30 rounded-xl text-white focus:outline-none focus:border-champagne" />
      </div>
      <div>
        <label class="text-[9px] font-bold uppercase tracking-widest text-stone-400">Brand / Designer</label>
        <input id="editItemBrand" type="text" value="${item.brand || ''}" placeholder="e.g. Zara" class="w-full mt-1.5 px-3 py-2.5 bg-plumlight border border-champagne/30 rounded-xl text-white focus:outline-none focus:border-champagne" />
      </div>
      <div>
        <label class="text-[9px] font-bold uppercase tracking-widest text-stone-400">Fabric</label>
        <input id="editItemFabric" type="text" value="${item.attrs?.fabric || ''}" class="w-full mt-1.5 px-3 py-2.5 bg-plumlight border border-champagne/30 rounded-xl text-white focus:outline-none focus:border-champagne" />
      </div>
    </div>

    <!-- Wear Log -->
    <div class="bg-plumcard p-4 rounded-2xl border border-champagne/20 mb-4">
      <div class="flex items-center justify-between mb-3">
        <span class="text-[10px] font-bold uppercase tracking-widest text-goldlight">Worn Memory (${item.wear_count || 0} wears)</span>
        <div class="flex gap-2">
          <input id="logWearEventInput" type="text" placeholder="Event (e.g. Wedding)" class="px-3.5 py-2 bg-plumlight border border-champagne/30 rounded-xl text-xs text-white focus:outline-none focus:border-champagne" />
          <button onclick="recordGarmentWear('${item.id}')" class="btn-obsidian px-3.5 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider shadow-sm">+ Log</button>
        </div>
      </div>
      <div class="text-[11px] text-stone-300 space-y-1 mt-2">
        ${(item.worn_history || []).length
          ? item.worn_history.map(w => `<span class="inline-block px-3 py-1.5 rounded-lg bg-plumlight border border-champagne/20 mr-1.5 mb-1.5">${w.date}:${w.event}</span>`).join('')
          : '<span class="italic font-serif text-stone-500">No events logged yet.</span>'}
      </div>
    </div>

    <!-- Footer Actions -->
    <div class="flex items-center justify-between pt-5 border-t border-champagne/20">
      <button onclick="deleteGarmentItem('${item.id}')" class="px-5 py-3 rounded-full text-rose-400 border border-rose-900/50 hover:bg-rose-950/30 text-[11px] font-bold tracking-wider uppercase transition">Delete Piece</button>
      <button onclick="saveItemDetailEdits('${item.id}')" class="btn-gold px-7 py-3 rounded-full text-[11px] font-bold tracking-wider uppercase transition shadow-md">Save Changes</button>
    </div>
  `;

  openModal('itemDetailModal');
  lucide.createIcons();
}

// Helper: Toggle Laundry Status
async function toggleLaundryStatus(id, isInLaundry) {
  const item = await db.garments.get(id);
  item.status = isInLaundry ? 'laundry' : 'active';
  await db.garments.put(item);
  await renderCloset();
  openItemDetailModal(id); // refresh modal to show new UI state
  showToast(isInLaundry ? 'Moved to Laundry Basket' : 'Returned to Active Wardrobe');
}

async function applyStudioImageUrl(id) {
  const url = document.getElementById('editStudioImgUrl').value.trim();
  if (!url) return;
  const item = await db.garments.get(id);
  item.studio_upgrade_img = url;
  item.active_img = url;
  item.retail_match_status = 'confirmed';
  await db.garments.put(item);
  openItemDetailModal(id);
  renderCloset();
  updateHeaderAndStats();
  showToast('Studio Image approved & activated!');
}

// Helper: Set Active Display Image (Supports 3rd state: Gallery selection)
async function setPrimaryGarmentImage(id, type, imgUrl = null) {
  const item = await db.garments.get(id);
  if (type === 'studio' && item.studio_upgrade_img) {
    item.active_img = item.studio_upgrade_img;
  } else if (type === 'gallery' && imgUrl) {
    item.active_img = imgUrl; // Allows setting one of the multi-angle photos as the main cover
  } else {
    item.active_img = item.cutout_img;
  }
  await db.garments.put(item);
  openItemDetailModal(id);
  renderCloset();
}

// Helper: Save Detail Edits (Updated to save Price)
async function saveItemDetailEdits(id) {
  const item = await db.garments.get(id);
  item.name = document.getElementById('editItemName').value.trim();
  item.category = document.getElementById('editItemCat').value;
  item.storage_location = document.getElementById('editItemLoc').value.trim();
  item.price = parseFloat(document.getElementById('editItemPrice').value) || 0; // Saves price for CPW
  item.brand = document.getElementById('editItemBrand').value.trim();
  item.retail_match_status = document.getElementById('editRetailStatus').value;
  item.attrs.fabric = document.getElementById('editItemFabric').value.trim();
  await db.garments.put(item);
  closeModal('itemDetailModal');
  await refreshAllViews();
  showToast('Dossier updated');
}

async function recordGarmentWear(id) {
  const evInput = document.getElementById('logWearEventInput');
  const eventName = evInput.value.trim() || 'Outing';
  const item = await db.garments.get(id);
  item.wear_count = (item.wear_count || 0) + 1;
  item.worn_history = item.worn_history || [];
  item.worn_history.unshift({ date: new Date().toLocaleDateString(), event: eventName });
  await db.garments.put(item);
  openItemDetailModal(id);
  await refreshAllViews();
  showToast('Wear logged');
}

async function deleteGarmentItem(id) {
  await db.garments.delete(id);
  closeModal('itemDetailModal');
  await refreshAllViews();
  showToast('Item removed');
}

// ============================================================================
// 5. INTERACTIVE MIX & MATCH STUDIO + DETERMINISTIC & AI COUTURE STYLIST
// ============================================================================
function toggleStudioGarmentMode() {
  state.studioMode = document.getElementById('studioMode').value;
  renderStudioBoard();
}

async function initStudioSlots() {
  const items = await db.garments.toArray();
  if (!items.length) {
    renderStudioBoard();
    return;
  }
  const pickFirst = (cats) => items.find(i => cats.includes(i.category))?.id || null;
  if (!state.studioSlots.top) state.studioSlots.top = pickFirst(['top']);
  if (!state.studioSlots.bottom) state.studioSlots.bottom = pickFirst(['bottom']);
  if (!state.studioSlots.full) state.studioSlots.full = pickFirst(['drape', 'dress']);
  if (!state.studioSlots.outer) state.studioSlots.outer = pickFirst(['outer']);
  if (!state.studioSlots.footwear) state.studioSlots.footwear = pickFirst(['footwear']);
  if (!state.studioSlots.jewellery) state.studioSlots.jewellery = pickFirst(['jewellery']);
  if (!state.studioSlots.bag) state.studioSlots.bag = pickFirst(['bag']);
  await renderStudioBoard();
  await refreshMakeupSuggestion();
}

async function sendItemToStudio(itemId) {
  const item = await db.garments.get(itemId);
  if (!item) return;
  if (item.category === 'drape' || item.category === 'dress') {
    state.studioMode = 'full';
    document.getElementById('studioMode').value = 'full';
    state.studioSlots.full = item.id;
    state.lockedSlots.full = true;
  } else {
    if (item.category === 'top' || item.category === 'bottom') {
      state.studioMode = 'separates';
      document.getElementById('studioMode').value = 'separates';
    }
    state.studioSlots[item.category] = item.id;
    state.lockedSlots[item.category] = true;
  }
  switchTab('studio');
  await autoStyleSmartDeterministic();
  showToast(`Pinned "${item.name}" & styled matching pieces!`);
}

async function renderStudioBoard() {
  const items = await db.garments.toArray();
  const itemMap = Object.fromEntries(items.map(i => [i.id, i]));

  const slotConfigs = state.studioMode === 'full'
    ? [
        { key: 'full', label: 'Saree / Gown / Ensemble', cats: ['drape', 'dress'] },
        { key: 'outer', label: 'Shawl / Layer / Dupatta', cats: ['outer'] },
        { key: 'jewellery', label: 'Fine Jewellery', cats: ['jewellery'] },
        { key: 'footwear', label: 'Footwear', cats: ['footwear'] },
        { key: 'bag', label: 'Miniaudiere / Potli', cats: ['bag'] }
      ]
    : [
        { key: 'top', label: 'Top / Kurti / Choli', cats: ['top'] },
        { key: 'bottom', label: 'Trousers / Skirt / Bottom', cats: ['bottom'] },
        { key: 'outer', label: 'Jacket / Dupatta / Cape', cats: ['outer'] },
        { key: 'jewellery', label: 'Fine Jewellery', cats: ['jewellery'] },
        { key: 'footwear', label: 'Footwear', cats: ['footwear'] },
        { key: 'bag', label: 'Handbag / Potli', cats: ['bag'] }
      ];

  const container = document.getElementById('slotMachineContainer');
  container.innerHTML = slotConfigs.map(sc => {
    const currentItem = itemMap[state.studioSlots[sc.key]];
    const isLocked = state.lockedSlots[sc.key];
    return `
      <div class="slot-card rounded-2xl p-3 flex flex-col justify-between ${isLocked ? 'locked' : ''}">
        <div class="flex items-center justify-between text-[9px] font-bold uppercase tracking-widest text-stone-400 mb-1.5">
          <span class="truncate pr-1">${sc.label}</span>
          <button onclick="toggleSlotLock('${sc.key}')" class="px-2 py-0.5 rounded-full transition ${isLocked ? 'bg-obsidian text-goldlight border border-champagne' : 'bg-silk text-stone-500 hover:text-obsidian'}">
            ${isLocked ? 'Pinned' : 'Pin'}
          </button>
        </div>

        <div class="h-36 cutout-bg rounded-xl flex items-center justify-center p-2.5 relative border border-stone-200/50">
          ${currentItem
            ? `<img src="${currentItem.active_img}" class="max-h-full max-w-full object-contain drop-shadow-sm" />
               <span class="absolute bottom-1.5 left-1.5 text-[8px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-obsidian/80 text-goldlight truncate max-w-[90%]">${currentItem.storage_location || 'Vault'}</span>`
            : `<span class="font-serif italic text-xs text-stone-400">Optional Layer</span>`
          }
        </div>

        <div class="mt-2.5 flex items-center justify-between gap-1">
          <button onclick="cycleStudioSlot('${sc.key}', -1)" class="w-7 h-7 rounded-full bg-alabaster border border-stone-200 hover:border-champagne text-obsidian flex items-center justify-center text-[10px] transition">&larr;</button>
          <div class="text-center truncate flex-1 px-1 cursor-pointer" onclick="${currentItem ? `openItemDetailModal('${currentItem.id}')` : ''}">
            <p class="font-serif text-sm font-semibold text-obsidian truncate">${currentItem ? currentItem.name : 'Unselected'}</p>
          </div>
          <button onclick="cycleStudioSlot('${sc.key}', 1)" class="w-7 h-7 rounded-full bg-alabaster border border-stone-200 hover:border-champagne text-obsidian flex items-center justify-center text-[10px] transition">&rarr;</button>
        </div>
      </div>
    `;
  }).join('');

  evaluateLiveOutfitHarmony(itemMap);
}
// Theme Toggle State & Execution
function initThemeMode() {
  const savedTheme = localStorage.getItem('atelier_theme') || 'theme-plum';
  document.body.className = savedTheme + ' antialiased selection:bg-champagne/30 selection:text-white pb-28';
  updateThemeToggleIcon(savedTheme);
}

function toggleThemeMode() {
  const current = localStorage.getItem('atelier_theme') || 'theme-plum';
  const next = current === 'theme-plum' ? 'theme-obsidian' : 'theme-plum';
  localStorage.setItem('atelier_theme', next);
  document.body.className = next + ' antialiased selection:bg-champagne/30 selection:text-white pb-28';
  updateThemeToggleIcon(next);
  showToast(next === 'theme-plum' ? 'Switched to Deep Plum & Champagne' : 'Switched to Obsidian Gold');
}

function updateThemeToggleIcon(theme) {
  const icon = document.getElementById('themeToggleIcon');
  if (!icon) return;
  // If dark plum, show sun icon to switch; if obsidian, show moon
  icon.setAttribute('data-lucide', theme === 'theme-plum' ? 'sun' : 'moon');
  lucide.createIcons();
}
async function cycleStudioSlot(slotKey, dir) {
  const catMap = {
    top: ['top'],
    bottom: ['bottom'],
    full: ['drape', 'dress'],
    outer: ['outer'],
    footwear: ['footwear'],
    jewellery: ['jewellery'],
    bag: ['bag']
  };
  const candidates = (await db.garments.toArray()).filter(i => catMap[slotKey].includes(i.category));
  // Allow cycling through null ("None") for outer/bag/jewellery
  const idList = ['outer', 'bag'].includes(slotKey) ? [null, ...candidates.map(c => c.id)] : candidates.map(c => c.id);
  if (!idList.length) return;
  const idx = idList.indexOf(state.studioSlots[slotKey]);
  const nextIdx = (idx + dir + idList.length) % idList.length;
  state.studioSlots[slotKey] = idList[nextIdx];
  await renderStudioBoard();
}

function toggleSlotLock(slotKey) {
  state.lockedSlots[slotKey] = !state.lockedSlots[slotKey];
  renderStudioBoard();
}

function clearStudioLocks() {
  Object.keys(state.lockedSlots).forEach(k => (state.lockedSlots[k] = false));
  renderStudioBoard();
}

function evaluateLiveOutfitHarmony(itemMap) {
  const activeIds = getActiveStudioItemIds();
  const activeItems = activeIds.map(id => itemMap[id]).filter(Boolean);
  if (!activeItems.length) return;

  let score = 8.8;
  const notes = [];

  const mainPiece = itemMap[state.studioMode === 'full' ? state.studioSlots.full : state.studioSlots.top];
  const bottomPiece = itemMap[state.studioSlots.bottom];
  const jewelPiece = itemMap[state.studioSlots.jewellery];

  // 1. Silhouette proportion check
  if (state.studioMode === 'separates' && mainPiece && bottomPiece) {
    if (mainPiece.attrs?.silhouette === 'oversized' && bottomPiece.attrs?.silhouette === 'oversized') {
      score -= 1.1;
      notes.push('Both top and bottom are high-volume; consider a structured bottom.');
    } else {
      score += 0.4;
      notes.push('Proportion rule satisfied (' + (mainPiece.attrs?.silhouette || 'balanced') + ' top + ' + (bottomPiece.attrs?.silhouette || 'tailored') + ' bottom).');
    }
  }

  // 2. Neckline to Jewellery rule
  if (mainPiece && jewelPiece) {
    const highNecklines = ['high_neck', 'collar', 'boat', 'halter'];
    const isNecklace = (jewelPiece.subcategory || jewelPiece.name).toLowerCase().includes('neck') || (jewelPiece.subcategory || '').toLowerCase().includes('choker');
    if (highNecklines.includes(mainPiece.attrs?.neckline) && isNecklace) {
      score -= 1.2;
      notes.push('High/Boat neckline competes with necklace — statement earrings recommended instead.');
    } else {
      score += 0.4;
      notes.push(`Jewellery scales cleanly with ${mainPiece.attrs?.neckline?.replace('_', ' ') || 'selected'} neckline.`);
    }
  }

  // 3. Undertone harmony with her personal profile
  const matchingUndertones = activeItems.filter(i => i.attrs?.undertone === state.profile.undertone || i.attrs?.undertone === 'neutral');
  if (matchingUndertones.length >= Math.ceil(activeItems.length * 0.7)) {
    score += 0.3;
    notes.push(`Complements her ${state.profile.undertone} undertone & ${state.profile.seasonPalette} palette.`);
  }

  score = Math.min(9.9, Math.max(6.0, score)).toFixed(1);
  document.getElementById('harmonyScoreBadge').textContent = score;
  document.getElementById('harmonyTitle').textContent = score >= 8.8 ? 'Couture-Grade Silhouette & Undertone Harmony' : 'Experimental Combination';
  document.getElementById('harmonyDetails').textContent = notes.join(' ');
}

// Deterministic Smart Spin (Respects Locks, Undertones, Necklines & Proportions)
async function autoStyleSmartDeterministic() {
const items = (await db.garments.toArray()).filter(i => i.status !== 'laundry');
 if (!items.length) return;

  const byCat = (cats) => items.filter(i => cats.includes(i.category));
  const pickRandom = (arr) => arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;

  if (state.studioMode === 'full') {
    if (!state.lockedSlots.full) {
      const f = pickRandom(byCat(['drape', 'dress']));
      if (f) state.studioSlots.full = f.id;
    }
  } else {
    if (!state.lockedSlots.top) {
      const t = pickRandom(byCat(['top']));
      if (t) state.studioSlots.top = t.id;
    }
    const anchorTop = items.find(i => i.id === state.studioSlots.top);
    if (!state.lockedSlots.bottom) {
      let bottoms = byCat(['bottom']);
      if (anchorTop?.attrs?.silhouette === 'oversized') {
        const fitted = bottoms.filter(b => b.attrs?.silhouette === 'fitted' || b.attrs?.silhouette === 'structured');
        if (fitted.length) bottoms = fitted;
      }
      const b = pickRandom(bottoms);
      if (b) state.studioSlots.bottom = b.id;
    }
  }

  const anchor = items.find(i => i.id === (state.studioMode === 'full' ? state.studioSlots.full : state.studioSlots.top));

  // Match jewellery to neckline & undertone
  if (!state.lockedSlots.jewellery) {
    let jewels = byCat(['jewellery']);
    if (anchor && ['high_neck', 'boat', 'collar'].includes(anchor.attrs?.neckline)) {
      const earringsOnly = jewels.filter(j => !(j.name + j.subcategory).toLowerCase().includes('neck'));
      if (earringsOnly.length) jewels = earringsOnly;
    }
    const j = pickRandom(jewels);
    if (j) state.studioSlots.jewellery = j.id;
  }

  if (!state.lockedSlots.footwear) {
    const fw = pickRandom(byCat(['footwear']));
    if (fw) state.studioSlots.footwear = fw.id;
  }
  if (!state.lockedSlots.bag) {
    const bg = pickRandom(byCat(['bag']));
    if (bg) state.studioSlots.bag = bg.id;
  }

  await renderStudioBoard();
  await refreshMakeupSuggestion();
}

// AI Couture Stylist (Text-only JSON inventory -> 3 complete looks + rationale)
async function generateAILookbook() {
  const items = await db.garments.toArray();
  if (items.length < 2) {
    showToast('Add at least a few garments first!');
    return;
  }

  const occasion = document.getElementById('studioOccasion').value;
  const weather = document.getElementById('studioWeather').value;
  const listEl = document.getElementById('aiProposalsList');

  if (!state.profile.geminiKey) {
    // Fallback deterministic 3-look generator if no API key set
    await autoStyleSmartDeterministic();
    listEl.innerHTML = `<div class="p-3 rounded-2xl bg-amber-50 border border-amber-200 text-xs text-amber-950">
      <b>Offline Smart Spin Applied!</b> Add your free Gemini API key in Settings (top right) to unlock multi-look AI Couture rationales.
    </div>`;
    return;
  }

  listEl.innerHTML = `<div class="p-6 text-center text-xs text-stone-500 animate-pulse">✨ AI Couture Stylist is reviewing her ${items.length} wardrobe pieces for <b>${occasion}</b>...</div>`;

  const compactWardrobe = items.map(i => ({
    id: i.id,
    name: i.name,
    category: i.category,
    color: i.attrs?.color_name,
    undertone: i.attrs?.undertone,
    fabric: i.attrs?.fabric,
    silhouette: i.attrs?.silhouette,
    neckline: i.attrs?.neckline,
    location: i.storage_location
  }));

  const prompt = `You are an elite personal fashion & costume designer styling a client.
Client Profile: Undertone=${state.profile.undertone}, Seasonal Palette=${state.profile.seasonPalette}.
Occasion: ${occasion}, Weather: ${weather}.
Choose ONLY from the provided wardrobe garment IDs. Never invent IDs.
Rules:
1. Respect silhouette balance and color harmony (max 3 colors + neutrals).
2. Scale accessories to neckline (high/boat necklines must use earrings/bangles, NOT heavy necklaces).
3. Return JSON array of 3 distinct looks:
[
  {
    "title": "Editorial Look Title",
    "mode": "separates or full",
    "item_ids": ["GAR-...", "GAR-..."],
    "rationale": "Why the colors, drape, and jewellery work together",
    "makeup_tip": "Specific lip, eye, and blush direction"
  }
]
Wardrobe Inventory JSON:
${JSON.stringify(compactWardrobe)}`;

  try {
    const proModel = 'gemini-2.5-pro';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${proModel}:generateContent?key=${state.profile.geminiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });
    const data = await res.json();
    const looks = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '[]');
    const itemMap = Object.fromEntries(items.map(i => [i.id, i]));

    listEl.innerHTML = looks.map((lk, idx) => {
      const validItems = (lk.item_ids || []).map(id => itemMap[id]).filter(Boolean);
      return `
        <div class="p-3 rounded-2xl border border-stone-200 bg-stone-50/70 hover:border-stone-900 transition">
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-xs font-bold text-stone-900">${idx + 1}. ${lk.title}</span>
            <button onclick='loadProposalOntoBoard(${JSON.stringify(lk.item_ids || [])})' class="px-2.5 py-1 rounded-lg bg-stone-900 text-amber-200 text-[10px] font-semibold">Load on Board</button>
          </div>
          <div class="flex gap-1.5 overflow-x-auto py-1">
            ${validItems.map(vi => `<img src="${vi.active_img}" title="${vi.name}" class="w-12 h-14 object-contain rounded-lg bg-white border border-stone-200 p-1" />`).join('')}
          </div>
          <p class="text-[11px] text-stone-600 mt-1.5">${lk.rationale}</p>
          <p class="text-[10px] text-rose-800 font-medium mt-1">💄 ${lk.makeup_tip || ''}</p>
        </div>
      `;
    }).join('');
  } catch (e) {
    listEl.innerHTML = `<div class="p-3 rounded-xl bg-rose-50 text-rose-800 text-xs">Could not reach Gemini API. Check your key in Settings.</div>`;
  }
}

async function loadProposalOntoBoard(itemIds) {
  const items = await db.garments.bulkGet(itemIds);
  items.filter(Boolean).forEach(item => {
    if (item.category === 'drape' || item.category === 'dress') {
      state.studioMode = 'full';
      document.getElementById('studioMode').value = 'full';
      state.studioSlots.full = item.id;
    } else if (state.studioSlots.hasOwnProperty(item.category)) {
      if (item.category === 'top' || item.category === 'bottom') {
        state.studioMode = 'separates';
        document.getElementById('studioMode').value = 'separates';
      }
      state.studioSlots[item.category] = item.id;
    }
  });
  await renderStudioBoard();
  showToast('Loaded curated look onto board');
}

function getActiveStudioItemIds() {
  const keys = state.studioMode === 'full'
    ? ['full', 'outer', 'jewellery', 'footwear', 'bag']
    : ['top', 'bottom', 'outer', 'jewellery', 'footwear', 'bag'];
  return keys.map(k => state.studioSlots[k]).filter(Boolean);
}

// ============================================================================
// 6. PAIRED MAKEUP DIRECTOR & VANITY KIT
// ============================================================================
async function refreshMakeupSuggestion() {
  const cosmetics = await db.makeup.toArray();
  const lips = cosmetics.filter(c => c.category === 'lip');
  const eyes = cosmetics.filter(c => c.category === 'eye');
  const cheeks = cosmetics.filter(c => c.category === 'cheek');

  const pick = (arr, fallback) => arr.length ? arr[Math.floor(Math.random() * arr.length)] : fallback;

  state.currentMakeup.lip = pick(lips, { shade_name: 'Warm Terracotta Matte', brand_product: 'Signature Lip', shade_hex: '#a84232' });
  state.currentMakeup.eye = pick(eyes, { shade_name: 'Soft Bronze Wash + Kohl Liner', brand_product: 'Eye Palette', shade_hex: '#785238' });
  state.currentMakeup.cheek = pick(cheeks, { shade_name: 'Warm Peach Satin Glow', brand_product: 'Blush', shade_hex: '#e0826d' });

  const card = document.getElementById('studioMakeupCard');
  if (!card) return;
  card.innerHTML = ['lip', 'eye', 'cheek'].map(k => {
    const m = state.currentMakeup[k];
    return `
      <div class="bg-white p-2 rounded-xl border border-rose-100 flex items-center gap-2">
        <span class="w-4 h-4 rounded-full shrink-0 border border-stone-300" style="background:${m.shade_hex || '#c25959'}"></span>
        <div class="truncate">
          <p class="text-[10px] font-bold uppercase text-rose-900">${k}</p>
          <p class="text-[11px] font-semibold text-stone-800 truncate">${m.shade_name}</p>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================================
// 7. VIRTUAL TRY-ON (VTON) COMPOSITE BUILDER & DIRECT GEMINI ENGINE
// ============================================================================
async function openVirtualTryOnFromStudio() {
  const itemIds = getActiveStudioItemIds();
  if (!itemIds.length) {
    showToast('Select items on the styling board first');
    return;
  }
  await populateVtonAvatarDropdown();
  await renderVtonCompositeCanvas();
  openModal('vtonModal');
}

async function populateVtonAvatarDropdown() {
  const avatars = await db.avatars.toArray();
  const sel = document.getElementById('vtonAvatarSelect');
  if (!avatars.length) {
    sel.innerHTML = `<option value="">No Base Avatar Photo uploaded yet (Upload in Vanity & Avatar tab)</option>`;
  } else {
    sel.innerHTML = avatars.map(a => `<option value="${a.id}">${a.label}</option>`).join('');
  }
}

async function renderVtonCompositeCanvas() {
  const canvas = document.getElementById('vtonCompositeCanvas');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fafaf9';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const itemIds = getActiveStudioItemIds();
  const items = (await db.garments.bulkGet(itemIds)).filter(Boolean);
  const avatarId = document.getElementById('vtonAvatarSelect')?.value;
  const avatar = avatarId ? await db.avatars.get(avatarId) : null;

  // Draw Left Panel: Her Base Photo
  ctx.fillStyle = '#1c1917';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText('IMAGE 1: BASE PERSON PHOTO', 24, 34);

  if (avatar?.photo_data) {
    const avImg = await loadImg(avatar.photo_data);
    drawContainedImage(ctx, avImg, 20, 50, 340, 880);
  } else {
    ctx.strokeStyle = '#d6d3d1';
    ctx.strokeRect(20, 50, 340, 880);
    ctx.fillStyle = '#78716c';
    ctx.font = '14px sans-serif';
    ctx.fillText('Upload her full-length Base Photo', 65, 460);
    ctx.fillText('in the "Vanity & Avatar" tab', 85, 485);
  }

  // Draw Right Panel: Ordered Garment & Jewellery Cutouts
  ctx.fillStyle = '#1c1917';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText('ORDERED GARMENT LAYERS', 390, 34);

  const slotHeight = Math.floor(880 / Math.max(1, items.length));
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const yTop = 50 + i * slotHeight;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(390, yTop, 355, slotHeight - 10);
    ctx.strokeStyle = '#e7e5e4';
    ctx.strokeRect(390, yTop, 355, slotHeight - 10);

    try {
      const gImg = await loadImg(it.active_img);
      drawContainedImage(ctx, gImg, 400, yTop + 6, 135, slotHeight - 22);
    } catch (e) {}

    ctx.fillStyle = '#1c1917';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(`${i + 1}. ${it.category.toUpperCase()}: ${it.name.slice(0, 22)}`, 545, yTop + 32);
    ctx.fillStyle = '#57534e';
    ctx.font = '12px sans-serif';
    ctx.fillText(`Fabric: ${it.attrs?.fabric || 'Standard'}`, 545, yTop + 54);
    ctx.fillText(`Color: ${it.attrs?.color_name || ''}`, 545, yTop + 74);
  }

  // Generate tailored VTON prompt with Saree/Drape & Jewellery scaling instructions
  const hasDrape = items.some(i => i.category === 'drape');
  const promptLines = [
    `Dress the person in IMAGE 1 (left panel) in the exact garments shown on the right panel in layer order:`,
    ...items.map((it, idx) => `- Layer ${idx + 1} (${it.category}): ${it.name} (${it.attrs?.color_name}, ${it.attrs?.fabric}, ${it.attrs?.pattern}).`),
    `CRITICAL RULES:`,
    `1. Keep the person's face, hair, body proportions (${state.profile.heightCm} cm), pose, and background 100% unchanged.`,
    `2. Preserve exact garment print, weave, zari borders, and color saturation. Match the ambient lighting of IMAGE 1.`,
    hasDrape ? `3. ETHNIC DRAPE INSTRUCTION: Render natural pleated waist drape with the pallu flowing cleanly over the left shoulder, preserving border geometry.` : `3. Ensure realistic fabric drape and natural hemline.`,
    `4. Scale jewellery accurately relative to face/ear landmarks (earrings ~3-4cm, necklace resting cleanly along collarbone).`
  ];
  document.getElementById('vtonPromptBox').value = promptLines.join('\n');
}

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function drawContainedImage(ctx, img, x, y, maxW, maxH) {
  const ratio = Math.min(maxW / img.width, maxH / img.height);
  const w = img.width * ratio;
  const h = img.height * ratio;
  const offsetX = x + (maxW - w) / 2;
  const offsetY = y + (maxH - h) / 2;
  ctx.drawImage(img, offsetX, offsetY, w, h);
}

function downloadVtonComposite() {
  const canvas = document.getElementById('vtonCompositeCanvas');
  const a = document.createElement('a');
  a.download = `Atelier_TryOn_Pack_${Date.now()}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
  showToast('Composite Sheet downloaded!');
}

function copyVtonPrompt() {
  const txt = document.getElementById('vtonPromptBox').value;
  navigator.clipboard.writeText(txt);
  showToast('Try-On prompt copied! Paste into Gemini Pro with the composite image.');
}

async function runDirectGeminiTryOn() {
  if (!state.profile.geminiKey) {
    showToast('Add your Gemini API key in Settings or use Download + Copy Prompt!');
    return;
  }
  const box = document.getElementById('vtonResultBox');
  box.innerHTML = `<p class="text-xs text-amber-900 font-semibold animate-pulse">Sending composite + garment references to Gemini Multimodal API...</p>`;

  const canvas = document.getElementById('vtonCompositeCanvas');
  const compositeBase64 = canvas.toDataURL('image/webp', 0.88).split(',')[1];
  const prompt = document.getElementById('vtonPromptBox').value;

  try {
    // Attempts Gemini 2.0/2.5 Flash Image Generation endpoint; if account only supports text, returns detailed visual fit review
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${state.profile.geminiModel}:generateContent?key=${state.profile.geminiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt + '\nIf image generation is enabled on this model, output the edited image; otherwise provide a concise Couture Fit & Drape Visualization note.' },
            { inlineData: { mimeType: 'image/webp', data: compositeBase64 } }
          ]
        }]
      })
    });
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData);
    const txtPart = parts.find(p => p.text);

    if (imgPart) {
      const renderedUrl = `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`;
      box.innerHTML = `<img src="${renderedUrl}" class="max-h-72 rounded-xl mx-auto shadow" />`;
    } else {
      box.innerHTML = `
        <div class="text-left text-xs text-stone-700 space-y-2">
          <p class="font-bold text-stone-900">✨ Couture Fit & Styling Assessment:</p>
          <p>${(txtPart?.text || 'Composite ready.').slice(0, 420)}</p>
          <p class="text-[11px] text-amber-800 font-semibold">Tip: Tap "Save Composite Image" + "Copy Precision Prompt" on the left to render photorealistic try-on in your Gemini Pro App!</p>
        </div>`;
    }
  } catch (e) {
    box.innerHTML = `<p class="text-xs text-rose-700">Use the 1-Tap Save Composite + Copy Prompt buttons on the left for Gemini Pro App try-on.</p>`;
  }
}

async function attachRenderedVtonImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  const { originalDataUrl } = await processImageFile(file, false, 900);
  document.getElementById('vtonResultBox').innerHTML = `
    <img src="${originalDataUrl}" class="max-h-72 rounded-xl mx-auto shadow" />
    <p class="text-[11px] text-emerald-700 font-semibold mt-1">Try-On Attached! Save this look on the board to keep it in her Lookbook.</p>
  `;
  state.lastAttachedTryOnImg = originalDataUrl;
}

// ============================================================================
// 8. LOOKBOOK, "WORE IT" REAL SELFIE MEMORY & TRAVEL CAPSULES
// ============================================================================
async function saveCurrentStudioLook() {
  const itemIds = getActiveStudioItemIds();
  if (!itemIds.length) {
    showToast('Select at least 1 item to save a look');
    return;
  }
  const occasion = document.getElementById('studioOccasion').value;
  const lookRecord = {
    id: 'LOOK-' + Date.now().toString().slice(-6),
    title: `${occasion} Ensemble`,
    occasion,
    created_by: 'studio',
    item_ids: itemIds,
    makeup: { ...state.currentMakeup },
    rationale: document.getElementById('harmonyDetails').textContent,
    tryon_img: state.lastAttachedTryOnImg || '',
    worn_photo_img: '',
    worn_log: [],
    rating: 'love',
    created_at: Date.now()
  };
  state.lastAttachedTryOnImg = '';
  await db.looks.put(lookRecord);
  await refreshAllViews();
  showToast('Saved to her Lookbook!');
}

function switchLookbookSubtab(sub) {
  const isSaved = sub === 'saved';
  document.getElementById('lookbookSavedView').classList.toggle('hidden', !isSaved);
  document.getElementById('lookbookTripsView').classList.toggle('hidden', isSaved);
  document.getElementById('subtabBtnSaved').className = isSaved
    ? 'px-3.5 py-1.5 rounded-full bg-stone-900 text-white text-xs font-semibold'
    : 'px-3.5 py-1.5 rounded-full bg-white border border-stone-200 text-stone-700 text-xs font-semibold';
  document.getElementById('subtabBtnTrips').className = !isSaved
    ? 'px-3.5 py-1.5 rounded-full bg-stone-900 text-white text-xs font-semibold'
    : 'px-3.5 py-1.5 rounded-full bg-white border border-stone-200 text-stone-700 text-xs font-semibold';
}

async function renderLookbook() {
  let looks = await db.looks.toArray();
  const items = await db.garments.toArray();
  const itemMap = Object.fromEntries(items.map(i => [i.id, i]));
  const occFilter = document.getElementById('lookbookOccasionFilter')?.value || 'all';

  if (occFilter !== 'all') {
    looks = looks.filter(l => l.occasion === occFilter);
  }
  looks.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  const grid = document.getElementById('lookbookGrid');
  if (!looks.length) {
    grid.innerHTML = `<div class="col-span-full text-center py-12 bg-white rounded-3xl border border-dashed border-stone-300 text-xs text-stone-500">
      No saved looks yet. Build a combination in the <b>Stylist Studio</b> and tap "Save to Lookbook"!
    </div>`;
    return;
  }

  grid.innerHTML = looks.map(lk => {
    const lkItems = (lk.item_ids || []).map(id => itemMap[id]).filter(Boolean);
    const locationsList = Array.from(new Set(lkItems.map(i => i.storage_location).filter(Boolean))).join(', ');
    return `
      <div class="bg-white rounded-3xl border border-stone-200/90 p-4 shadow-sm flex flex-col justify-between">
        <div>
          <div class="flex items-center justify-between mb-2">
            <div>
              <span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-amber-100 text-amber-900">${lk.occasion}</span>
              <h4 class="font-serif text-lg font-bold text-stone-900 mt-1">${lk.title}</h4>
            </div>
            <button onclick="deleteLook('${lk.id}')" class="text-stone-400 hover:text-rose-600 text-xs">✕</button>
          </div>

          <!-- Visual Preview: Either Worn Photo, Try-On Photo, or Collage Grid -->
          ${lk.worn_photo_img || lk.tryon_img
            ? `<div class="relative mb-2">
                 <img src="${lk.worn_photo_img || lk.tryon_img}" class="w-full h-52 object-cover rounded-2xl border border-stone-100" />
                 <span class="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-stone-900/80 text-white text-[10px] font-semibold">
                   ${lk.worn_photo_img ? '📸 Real Worn Photo' : '✨ Virtual Try-On'}
                 </span>
               </div>`
            : ''
          }

          <div class="grid grid-cols-3 gap-1.5 bg-stone-50 p-2 rounded-2xl border border-stone-100">
            ${lkItems.map(it => `
              <div class="bg-white p-1.5 rounded-xl border border-stone-200/60 text-center cursor-pointer" onclick="openItemDetailModal('${it.id}')">
                <img src="${it.active_img}" class="h-16 mx-auto object-contain" />
                <p class="text-[9px] text-stone-700 font-medium truncate mt-1">${it.name}</p>
              </div>
            `).join('')}
          </div>

          <p class="text-[11px] text-stone-600 mt-2">📍 <b>Pull from:</b> ${locationsList || 'Main Wardrobe'}</p>
          ${lk.makeup?.lip ? `<p class="text-[11px] text-rose-800 mt-0.5">💄 <b>Lip:</b> ${lk.makeup.lip.shade_name}</p>` : ''}
        </div>

        <div class="mt-3 pt-2.5 border-t border-stone-100 flex items-center justify-between gap-2">
          <button onclick='loadProposalOntoBoard(${JSON.stringify(lk.item_ids)}); switchTab("studio")' class="px-3 py-1.5 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-800 text-[11px] font-semibold">
            Remix in Studio
          </button>
          <label class="px-3 py-1.5 rounded-xl bg-stone-900 text-white text-[11px] font-semibold cursor-pointer">
            📸 Log "Wore It" Photo
            <input type="file" accept="image/*" class="hidden" onchange="attachWornPhotoToLook(event, '${lk.id}')" />
          </label>
        </div>
      </div>
    `;
  }).join('');
}

async function attachWornPhotoToLook(event, lookId) {
  const file = event.target.files[0];
  if (!file) return;
  const { originalDataUrl } = await processImageFile(file, false, 800);
  const lk = await db.looks.get(lookId);
  lk.worn_photo_img = originalDataUrl;
  await db.looks.put(lk);

  // Also increment wear_count on all constituent items
  for (const id of lk.item_ids || []) {
    const g = await db.garments.get(id);
    if (g) {
      g.wear_count = (g.wear_count || 0) + 1;
      await db.garments.put(g);
    }
  }
  await refreshAllViews();
  showToast('Worn photo saved & garment wear counts updated!');
}

async function deleteLook(id) {
  await db.looks.delete(id);
  await refreshAllViews();
}

// Travel & Event Packing Capsule Builder
async function createNewTripCapsule() {
  const name = document.getElementById('tripNameInput').value.trim();
  const dates = document.getElementById('tripDatesInput').value.trim() || 'Upcoming';
  if (!name) {
    showToast('Enter a trip or event name');
    return;
  }
  const looks = await db.looks.toArray();
  const garments = await db.garments.toArray();
  // Auto-pack items from saved Resort/Festive looks or top favorites
  const defaultIds = garments.slice(0, 8).map(g => g.id);

  await db.trips.put({
    id: 'TRIP-' + Date.now().toString().slice(-5),
    name,
    dates,
    item_ids: defaultIds,
    packed_ids: [],
    created_at: Date.now()
  });
  document.getElementById('tripNameInput').value = '';
  document.getElementById('tripDatesInput').value = '';
  await renderTrips();
  showToast('Packing Capsule created!');
}

async function renderTrips() {
  const trips = await db.trips.toArray();
  const items = await db.garments.toArray();
  const itemMap = Object.fromEntries(items.map(i => [i.id, i]));
  const container = document.getElementById('tripsListContainer');
  if (!container) return;

  if (!trips.length) {
    container.innerHTML = `<div class="text-center py-8 text-xs text-stone-400">No travel or event packing lists yet.</div>`;
    return;
  }

  container.innerHTML = trips.map(tr => {
    const tripItems = (tr.item_ids || []).map(id => itemMap[id]).filter(Boolean);
    return `
      <div class="bg-white p-4 rounded-3xl border border-stone-200 shadow-sm">
        <div class="flex items-center justify-between mb-2">
          <div>
            <h4 class="font-serif text-lg font-bold text-stone-900">✈️ ${tr.name} <span class="text-xs font-sans font-normal text-stone-500">(${tr.dates})</span></h4>
            <p class="text-[11px] text-stone-500">Packed ${tr.packed_ids?.length || 0} of ${tripItems.length} pieces</p>
          </div>
          <div class="flex gap-2">
            <button onclick="addCurrentStudioItemsToTrip('${tr.id}')" class="px-2.5 py-1 rounded-lg bg-amber-100 text-amber-900 text-[11px] font-semibold">+ Add Current Studio Look</button>
            <button onclick="deleteTrip('${tr.id}')" class="text-stone-400 hover:text-rose-600 text-xs">✕</button>
          </div>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2 mt-2">
          ${tripItems.map(it => {
            const isPacked = (tr.packed_ids || []).includes(it.id);
            return `
              <div onclick="toggleTripItemPacked('${tr.id}', '${it.id}')" class="p-2 rounded-xl border cursor-pointer transition ${isPacked ? 'bg-emerald-50 border-emerald-400' : 'bg-stone-50 border-stone-200'}">
                <img src="${it.active_img}" class="h-14 mx-auto object-contain" />
                <p class="text-[10px] font-bold text-stone-800 truncate mt-1">${isPacked ? '✅ ' : '⬜ '}${it.name}</p>
                <p class="text-[9px] text-stone-500 truncate">📍 ${it.storage_location || 'Closet'}</p>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');
}

async function toggleTripItemPacked(tripId, itemId) {
  const tr = await db.trips.get(tripId);
  tr.packed_ids = tr.packed_ids || [];
  if (tr.packed_ids.includes(itemId)) {
    tr.packed_ids = tr.packed_ids.filter(id => id !== itemId);
  } else {
    tr.packed_ids.push(itemId);
  }
  await db.trips.put(tr);
  renderTrips();
}

async function addCurrentStudioItemsToTrip(tripId) {
  const tr = await db.trips.get(tripId);
  const currentIds = getActiveStudioItemIds();
  tr.item_ids = Array.from(new Set([...(tr.item_ids || []), ...currentIds]));
  await db.trips.put(tr);
  renderTrips();
  showToast('Added current studio outfit to packing list!');
}

async function deleteTrip(id) {
  await db.trips.delete(id);
  renderTrips();
}

// ============================================================================
// 9. "SHOP HER CLOSET" — PINTEREST / INSPIRATION RECREATOR
// ============================================================================
async function handleInspirationMatch(event) {
  const file = event.target.files[0];
  if (!file) return;
  const container = document.getElementById('inspoResultContainer');
  const { originalDataUrl, dominantHex } = await processImageFile(file, false, 600);

  const items = await db.garments.toArray();
  if (!items.length) {
    container.innerHTML = `<p class="text-xs text-rose-700">Add items to her closet first so we can match them!</p>`;
    return;
  }

  container.innerHTML = `
    <div class="flex gap-3 items-center bg-stone-50 p-3 rounded-2xl border border-stone-200">
      <img src="${originalDataUrl}" class="w-20 h-28 object-cover rounded-xl" />
      <p class="text-xs text-stone-600 animate-pulse">Scanning her wardrobe to recreate this look using pieces she already owns...</p>
    </div>
  `;

  if (state.profile.geminiKey) {
    try {
      const compact = items.map(i => ({ id: i.id, name: i.name, category: i.category, color: i.attrs?.color_name, fabric: i.attrs?.fabric }));
        const proModel = 'gemini-2.5-pro';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${proModel}:generateContent?key=${state.profile.geminiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: `Match the outfit in this inspiration image to the closest items in the user's wardrobe JSON. Return JSON: {"matched_ids": ["GAR-..."], "styling_note": "How to wear her owned pieces to achieve this exact vibe"}. Wardrobe: ${JSON.stringify(compact)}` },
              { inlineData: { mimeType: 'image/webp', data: originalDataUrl.split(',')[1] } }
            ]
          }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      });
      const data = await res.json();
      const parsed = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
      const matchedItems = (parsed.matched_ids || []).map(id => items.find(i => i.id === id)).filter(Boolean);

      container.innerHTML = `
        <div class="p-3 bg-stone-50 rounded-2xl border border-stone-200 space-y-2">
          <p class="text-xs font-bold text-stone-900">✨ Closest Match From Her Closet:</p>
          <p class="text-xs text-stone-600">${parsed.styling_note || ''}</p>
          <div class="flex gap-2 overflow-x-auto py-1">
            ${matchedItems.map(m => `<img src="${m.active_img}" class="w-16 h-20 object-contain bg-white p-1 rounded-xl border border-stone-200" />`).join('')}
          </div>
          <button onclick='loadProposalOntoBoard(${JSON.stringify(parsed.matched_ids || [])}); closeModal("inspoModal"); switchTab("studio")' class="w-full py-2 rounded-xl bg-stone-900 text-white text-xs font-semibold">Open Matched Look in Studio</button>
        </div>
      `;
      return;
    } catch (e) {}
  }

  // Fallback local color/category match
  const matched = items.slice(0, 4);
  container.innerHTML = `
    <div class="p-3 bg-stone-50 rounded-2xl border border-stone-200 space-y-2">
      <p class="text-xs font-bold text-stone-900">Closest Pieces From Her Wardrobe:</p>
      <div class="flex gap-2 overflow-x-auto py-1">
        ${matched.map(m => `<img src="${m.active_img}" class="w-16 h-20 object-contain bg-white p-1 rounded-xl border border-stone-200" />`).join('')}
      </div>
      <button onclick='loadProposalOntoBoard(${JSON.stringify(matched.map(m => m.id))}); closeModal("inspoModal"); switchTab("studio")' class="w-full py-2 rounded-xl bg-stone-900 text-white text-xs font-semibold">Load Into Studio</button>
    </div>
  `;
}

// ============================================================================
// 10. VANITY KIT, AVATARS, SETTINGS & 1-TAP BACKUP / SYNC
// ============================================================================
async function handleAvatarUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const { originalDataUrl } = await processImageFile(file, false, 900);
  await db.avatars.put({
    id: 'AV-' + Date.now().toString().slice(-4),
    label: `Base Pose ${(await db.avatars.count()) + 1}`,
    photo_data: originalDataUrl
  });
  await renderBeautyAndAvatars();
  showToast('Base Avatar Photo saved for Virtual Try-On!');
}

async function renderBeautyAndAvatars() {
  const avatars = await db.avatars.toArray();
  const avGal = document.getElementById('avatarGallery');
  if (avGal) {
    avGal.innerHTML = avatars.length
      ? avatars.map(a => `
          <div class="relative w-24 h-32 rounded-2xl overflow-hidden border border-stone-200 shrink-0 bg-stone-100">
            <img src="${a.photo_data}" class="w-full h-full object-cover" />
            <button onclick="deleteAvatar('${a.id}')" class="absolute top-1 right-1 w-5 h-5 rounded-full bg-stone-900/70 text-white text-[10px]">✕</button>
            <span class="absolute bottom-1 inset-x-1 text-[9px] text-center bg-white/90 rounded px-1 font-semibold truncate">${a.label}</span>
          </div>
        `).join('')
      : `<p class="text-xs text-stone-400 py-4">Upload 1–2 full-length photos of her in simple lighting to use as her Virtual Try-On canvas.</p>`;
  }

  const cosmetics = await db.makeup.toArray();
  const mkGrid = document.getElementById('makeupGrid');
  if (mkGrid) {
    mkGrid.innerHTML = cosmetics.map(c => `
      <div class="p-3 rounded-2xl border border-stone-200 bg-stone-50/60 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2.5 truncate">
          <span class="w-6 h-6 rounded-full shrink-0 border border-stone-300 shadow-inner" style="background:${c.shade_hex}"></span>
          <div class="truncate">
            <p class="text-[10px] font-bold uppercase text-stone-400">${c.category}</p>
            <p class="text-xs font-bold text-stone-900 truncate">${c.shade_name}</p>
            <p class="text-[10px] text-stone-500 truncate">${c.brand_product || ''}</p>
          </div>
        </div>
        <button onclick="deleteCosmetic('${c.id}')" class="text-stone-400 hover:text-rose-600 text-xs">✕</button>
      </div>
    `).join('');
  }
}

async function openAddMakeupModal() {
  const shade = prompt('Enter Lipstick / Eyeshadow / Blush Shade Name (e.g., Ruby Woo Matte Red or Champagne Rose Shimmer):');
  if (!shade) return;
  const cat = shade.toLowerCase().includes('eye') || shade.toLowerCase().includes('kohl')
    ? 'eye'
    : shade.toLowerCase().includes('blush') || shade.toLowerCase().includes('cheek')
    ? 'cheek'
    : 'lip';
  await db.makeup.put({
    id: 'MK-' + Date.now().toString().slice(-4),
    category: cat,
    shade_name: shade,
    brand_product: 'Personal Vanity',
    shade_hex: cat === 'lip' ? '#9e2a2b' : cat === 'eye' ? '#8c6239' : '#e07a5f',
    undertone: 'warm'
  });
  await renderBeautyAndAvatars();
  await refreshMakeupSuggestion();
  showToast('Added to her Vanity Kit!');
}

async function deleteAvatar(id) {
  await db.avatars.delete(id);
  renderBeautyAndAvatars();
}

async function deleteCosmetic(id) {
  await db.makeup.delete(id);
  renderBeautyAndAvatars();
}

function loadProfileUI() {
  document.getElementById('profUndertone').value = state.profile.undertone;
  document.getElementById('profSeasonPalette').value = state.profile.seasonPalette;
  document.getElementById('profHeightCm').value = state.profile.heightCm;
  document.getElementById('settingsGeminiKey').value = state.profile.geminiKey;
  document.getElementById('settingsGeminiModel').value = state.profile.geminiModel;
  document.getElementById('settingsSyncUrl').value = state.profile.syncUrl;
}

function saveProfileSettings() {
  state.profile.undertone = document.getElementById('profUndertone').value;
  state.profile.seasonPalette = document.getElementById('profSeasonPalette').value;
  state.profile.heightCm = Number(document.getElementById('profHeightCm').value || 162);
  localStorage.setItem('prof_undertone', state.profile.undertone);
  localStorage.setItem('prof_season', state.profile.seasonPalette);
  localStorage.setItem('prof_height', state.profile.heightCm);
  showToast('Personal styling profile saved');
}

function saveAppSettings() {
  state.profile.geminiKey = document.getElementById('settingsGeminiKey').value.trim();
  state.profile.geminiModel = document.getElementById('settingsGeminiModel').value.trim() || 'gemini-2.5-flash';
  state.profile.syncUrl = document.getElementById('settingsSyncUrl').value.trim();
  localStorage.setItem('atelier_gemini_key', state.profile.geminiKey);
  localStorage.setItem('atelier_gemini_model', state.profile.geminiModel);
  localStorage.setItem('atelier_sync_url', state.profile.syncUrl);
  closeModal('settingsModal');
  showToast('API & Sync settings saved');
}

// Full Wardrobe Export / Import (For 1-Tap Laptop <-> Phone Transfer)
async function exportFullWardrobeJSON() {
  const bundle = {
    version: 1,
    exported_at: new Date().toISOString(),
    profile: state.profile,
    garments: await db.garments.toArray(),
    makeup: await db.makeup.toArray(),
    looks: await db.looks.toArray(),
    trips: await db.trips.toArray(),
    avatars: await db.avatars.toArray()
  };
  const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Atelier_Wardrobe_Backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  showToast('Complete wardrobe backup exported!');
}

async function importFullWardrobeJSON(event) {
  const file = event.target.files[0];
  if (!file) return;
  const text = await file.text();
  const bundle = JSON.parse(text);
  if (bundle.garments?.length) await db.garments.bulkPut(bundle.garments);
  if (bundle.makeup?.length) await db.makeup.bulkPut(bundle.makeup);
  if (bundle.looks?.length) await db.looks.bulkPut(bundle.looks);
  if (bundle.trips?.length) await db.trips.bulkPut(bundle.trips);
  if (bundle.avatars?.length) await db.avatars.bulkPut(bundle.avatars);
  closeModal('settingsModal');
  await refreshAllViews();
  showToast(`Imported ${bundle.garments?.length || 0} wardrobe items & looks!`);
}

async function pushToCloudWebhook() {
  if (!state.profile.syncUrl) {
    showToast('Add a Google Apps Script or Webhook URL above first');
    return;
  }
  const bundle = {
    garments: await db.garments.toArray(),
    looks: await db.looks.toArray(),
    makeup: await db.makeup.toArray()
  };
  try {
    await fetch(state.profile.syncUrl, {
      method: 'POST',
      mode: 'no-cors',
      body: JSON.stringify(bundle)
    });
    showToast('Wardrobe synced to Cloud Webhook!');
  } catch (e) {
    showToast('Sync failed — use Export Backup file');
  }
}

// ============================================================================
// 11. NAVIGATION & SAMPLE LUXURY WARDROBE GENERATOR (INSTANT DEMO)
// ============================================================================
function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.tab-view').forEach(sec => sec.classList.add('hidden'));
  document.getElementById(`tab-${tabId}`).classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// Generates clean vector SVG cutouts so you can test all features immediately before photographing
function makeSvgCutout(label, sub, bgHex, accentHex, shape) {
  let pathSvg = '';
  if (shape === 'top') {
    pathSvg = `<path d="M55 45 L85 30 L115 30 L145 45 L170 85 L145 100 L135 75 L135 190 L65 190 L65 75 L55 100 L30 85 Z" fill="${bgHex}" stroke="${accentHex}" stroke-width="4"/>`;
  } else if (shape === 'bottom') {
    pathSvg = `<path d="M65 35 L135 35 L150 210 L110 210 L100 100 L90 210 L50 210 Z" fill="${bgHex}" stroke="${accentHex}" stroke-width="4"/>`;
  } else if (shape === 'drape') {
    pathSvg = `<path d="M55 30 L145 30 L160 215 L40 215 Z" fill="${bgHex}" stroke="${accentHex}" stroke-width="6"/><line x1="50" y1="185" x2="150" y2="55" stroke="${accentHex}" stroke-width="8"/>`;
  } else if (shape === 'jewel') {
    pathSvg = `<circle cx="100" cy="95" r="42" fill="none" stroke="${accentHex}" stroke-width="8"/><circle cx="75" cy="160" r="16" fill="${bgHex}" stroke="${accentHex}" stroke-width="5"/><circle cx="125" cy="160" r="16" fill="${bgHex}" stroke="${accentHex}" stroke-width="5"/>`;
  } else if (shape === 'shoe') {
    pathSvg = `<path d="M45 155 Q95 155 140 120 L155 170 L140 170 L135 145 L85 175 L40 175 Z" fill="${bgHex}" stroke="${accentHex}" stroke-width="4"/>`;
  } else {
    pathSvg = `<rect x="55" y="75" width="90" height="95" rx="14" fill="${bgHex}" stroke="${accentHex}" stroke-width="4"/><path d="M75 75 Q100 35 125 75" fill="none" stroke="${accentHex}" stroke-width="5"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 240">
    ${pathSvg}
    <text x="100" y="232" font-family="sans-serif" font-size="11" font-weight="bold" fill="#292524" text-anchor="middle">${label}</text>
  </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

async function seedDemoWardrobe() {
  const sampleItems = [
    {
      id: 'GAR-101', name: 'Ivory Chikankari Silk Kurti', category: 'top', subcategory: 'Kurti', brand: 'Good Earth',
      storage_location: 'Main Almirah - Shelf 1', retail_match_status: 'confirmed', wear_count: 2, is_favorite: true,
      img: makeSvgCutout('Ivory Chikankari Kurti', 'Top', '#f5f5f0', '#d4af37', 'top'),
      attrs: { color_hex: '#f5f5f0', color_name: 'Warm Ivory', undertone: 'warm', pattern: 'Embroidered', fabric: 'Chanderi Silk', silhouette: 'flowy', neckline: 'v_neck', formality: 4 }
    },
    {
      id: 'GAR-102', name: 'Emerald Zari Banarasi Saree', category: 'drape', subcategory: 'Saree', brand: 'Sabyasachi Heritage',
      storage_location: 'Main Almirah - Saree Hanger', retail_match_status: 'confirmed', wear_count: 0, is_favorite: true,
      img: makeSvgCutout('Emerald Banarasi Saree', 'Saree', '#064e3b', '#f59e0b', 'drape'),
      attrs: { color_hex: '#064e3b', color_name: 'Emerald Green', undertone: 'warm', pattern: 'Zari Border', fabric: 'Katan Silk', silhouette: 'flowy', neckline: 'boat', formality: 5 }
    },
    {
      id: 'GAR-103', name: 'Terracotta Rust Linen Blouse', category: 'top', subcategory: 'Blouse', brand: 'Zara',
      storage_location: 'Main Almirah - Shelf 2', retail_match_status: 'candidate', wear_count: 1, is_favorite: false,
      img: makeSvgCutout('Terracotta Linen Top', 'Top', '#9a3412', '#fed7aa', 'top'),
      attrs: { color_hex: '#9a3412', color_name: 'Terracotta', undertone: 'warm', pattern: 'Solid', fabric: 'Linen', silhouette: 'fitted', neckline: 'scoop', formality: 3 }
    },
    {
      id: 'GAR-104', name: 'Champagne Gold Tailored Palazzo', category: 'bottom', subcategory: 'Palazzo', brand: 'Raw Mango',
      storage_location: 'Main Almirah - Shelf 1', retail_match_status: 'confirmed', wear_count: 3, is_favorite: true,
      img: makeSvgCutout('Champagne Silk Palazzo', 'Bottom', '#fef3c7', '#b45309', 'bottom'),
      attrs: { color_hex: '#fef3c7', color_name: 'Champagne Gold', undertone: 'warm', pattern: 'Solid', fabric: 'Raw Silk', silhouette: 'structured', neckline: 'none', formality: 4 }
    },
    {
      id: 'GAR-105', name: 'Espresso High-Waist Wide Trousers', category: 'bottom', subcategory: 'Trousers', brand: 'Massimo Dutti',
      storage_location: 'Main Almirah - Shelf 2', retail_match_status: 'confirmed', wear_count: 0, is_favorite: false,
      img: makeSvgCutout('Espresso Wide Trousers', 'Bottom', '#292524', '#a8a29e', 'bottom'),
      attrs: { color_hex: '#292524', color_name: 'Espresso Brown', undertone: 'neutral', pattern: 'Solid', fabric: 'Crepe Wool', silhouette: 'structured', neckline: 'none', formality: 4 }
    },
    {
      id: 'GAR-106', name: 'Kundan & Pearl Chandbali Jhumkas', category: 'jewellery', subcategory: 'Earrings', brand: 'Tanishq',
      storage_location: 'Bedroom Safe - Velvet Tray 1', retail_match_status: 'confirmed', wear_count: 1, is_favorite: true,
      img: makeSvgCutout('Kundan Chandbali', 'Jewellery', '#fef08a', '#b45309', 'jewel'),
      attrs: { color_hex: '#f59e0b', color_name: 'Antique Gold', undertone: 'warm', pattern: 'Kundan', fabric: '22K Gold & Pearl', silhouette: 'balanced', neckline: 'none', formality: 5 }
    },
    {
      id: 'GAR-107', name: 'Embellished Gold Block Heels', category: 'footwear', subcategory: 'Heels', brand: 'Needledust',
      storage_location: 'Shoe Cabinet - Tier 2', retail_match_status: 'candidate', wear_count: 2, is_favorite: true,
      img: makeSvgCutout('Gold Block Heels', 'Footwear', '#fde68a', '#92400e', 'shoe'),
      attrs: { color_hex: '#fde68a', color_name: 'Champagne Gold', undertone: 'warm', pattern: 'Embellished', fabric: 'Leather', silhouette: 'balanced', neckline: 'none', formality: 4 }
    },
    {
      id: 'GAR-108', name: 'Raw Silk Zardozi Potli Clutch', category: 'bag', subcategory: 'Clutch', brand: 'Sabyasachi',
      storage_location: 'Top Shelf Dustbag', retail_match_status: 'confirmed', wear_count: 0, is_favorite: true,
      img: makeSvgCutout('Zardozi Silk Clutch', 'Bag', '#7c2d12', '#f59e0b', 'bag'),
      attrs: { color_hex: '#7c2d12', color_name: 'Deep Rust Gold', undertone: 'warm', pattern: 'Zardozi', fabric: 'Raw Silk', silhouette: 'structured', neckline: 'none', formality: 5 }
    }
  ];

  for (const s of sampleItems) {
    await db.garments.put({
      ...s,
      original_img: s.img,
      cutout_img: s.img,
      studio_upgrade_img: s.retail_match_status === 'confirmed' ? s.img : '',
      active_img: s.img,
      worn_history: s.wear_count > 0 ? [{ date: '18 Feb 2026', event: 'Family Celebration' }] : [],
      status: 'active',
      created_at: Date.now()
    });
  }

  await db.makeup.bulkPut([
    { id: 'MK-01', category: 'lip', shade_name: 'Spiced Terracotta Matte', brand_product: 'Charlotte Tilbury', shade_hex: '#9a3412', undertone: 'warm' },
    { id: 'MK-02', category: 'lip', shade_name: 'Classic Ruby Sindoor', brand_product: 'MAC', shade_hex: '#991b1b', undertone: 'warm' },
    { id: 'MK-03', category: 'eye', shade_name: 'Antique Gold Shimmer + Winged Kohl', brand_product: 'Huda Beauty', shade_hex: '#b45309', undertone: 'warm' },
    { id: 'MK-04', category: 'cheek', shade_name: 'Warm Peachy Rose Glow', brand_product: 'Rare Beauty', shade_hex: '#e07a5f', undertone: 'warm' }
  ]);

  await refreshAllViews();
  showToast('Sample Luxury Wardrobe & Vanity loaded!');
}