/**
 * 最強蝸牛公會數據統計 - 圖片 OCR 與智能數據萃取模組
 * 純動態辨識，絕不預設任何寫死名單，上傳多少張就辨識多少位成員！
 */

class GuildOcrProcessor {
  constructor() {
    // 從 localStorage 安全載入金鑰（避免寫死在 public repo 被 Google 自動吊銷）
    this.geminiApiKey = localStorage.getItem('guild_gemini_key') || '';
  }

  setGeminiKey(key) {
    this.geminiApiKey = key.trim();
    localStorage.setItem('guild_gemini_key', this.geminiApiKey);
  }

  /**
   * 辨識總入口
   * @param {string} base64Image - 圖片 Base64 或 Blob URL
   * @param {Function} progressCallback - 進度回調 (percent, statusText)
   */
  async recognize(base64Image, progressCallback = () => {}, fileName = '') {
    progressCallback(10, '正在分析圖像結構與尺寸...');

    // 取得圖片長寬與比例
    const imgInfo = await this.getImageDimensions(base64Image);
    
    // 判定是否為《最強蝸牛》手遊截圖：
    // 1. 直立式截圖 (ratio < 0.85，如全螢幕上陣截圖)
    // 2. 橫條式底欄截圖 (ratio > 1.2 且 height < 450，如局部截取底盤數值)
    const isSnailGameScreen = imgInfo.ratio < 0.85 || (imgInfo.ratio > 1.2 && imgInfo.height < 500);

    // 1. 若有配置 Gemini API Key，調用高精度 AI 多模態辨識
    if (this.geminiApiKey) {
      try {
        progressCallback(30, '🤖 Gemini AI 視覺辨識中，請稍候...');
        const aiResult = await this.recognizeWithGemini(base64Image, isSnailGameScreen);
        if (aiResult && aiResult.length > 0) {
          progressCallback(100, `✅ Gemini AI 辨識完成！抓取到 ${aiResult.length} 筆會員資料`);
          return { success: true, mode: 'AI_VISION', members: aiResult, fileName };
        } else {
          progressCallback(35, '⚠️ Gemini 回傳空結果，嘗試備用引擎...');
        }
      } catch (err) {
        const errMsg = err.message || String(err);
        console.warn('[Gemini] 辨識異常，自動切換至備用辨識流程:', errMsg);
        progressCallback(35, '啟動備用辨識引擎...');
      }
    }

    // 2. 調用本機 Python RapidOCR 神經網路引擎 (純動態辨識)
    try {
      progressCallback(30, '傳送至本機 RapidOCR 神經網路引擎動態解析中...');
      const serverResp = await fetch('/api/ocr-recognize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64Image, is_snail_game: isSnailGameScreen, fileName })
      });
      if (serverResp.ok) {
        const json = await serverResp.json();
        if (json.status === 'ok' && json.members && json.members.length > 0) {
          progressCallback(100, `辨識成功！抓取到 ${json.members.length} 筆資料`);
          return {
            success: true,
            mode: 'SERVER_OCR',
            members: json.members,
            imageUrl: json.imageUrl,
            fileName: json.fileName || fileName
          };
        } else {
          throw new Error(json.error || '未能在截圖中偵測到有效數值');
        }
      } else {
        const errJson = await serverResp.json().catch(() => ({}));
        throw new Error(errJson.error || `本機伺服器辨識異常 (HTTP ${serverResp.status})`);
      }
    } catch(e) {
      console.warn('後端 RapidOCR 伺服器不可用 (例如在 GitHub Pages)，自動切換至純前端 Tesseract 引擎...', e);
      progressCallback(35, '本機伺服器未連線，啟動純前端辨識中...');
      try {
        const frontendRes = await this.recognizeBattleScreenFrontend(base64Image, imgInfo, progressCallback);
        if (frontendRes && frontendRes.members && frontendRes.members.length > 0) {
          progressCallback(100, `前端辨識完成！提取到 ${frontendRes.members.length} 筆資料`);
          return {
            success: true,
            mode: 'FRONTEND_OCR',
            members: frontendRes.members,
            imageUrl: base64Image,
            fileName: fileName || '上傳截圖'
          };
        }
      } catch(fe) {
        console.error('前端 OCR 亦解析失敗:', fe);
      }
      throw new Error(`辨識失敗: 未能從截圖中解析出數值。若在本地運行請開啟 start.bat。`);
    }
  }

  /**
   * 取得圖片長寬與比例
   */
  getImageDimensions(base64Image) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.width, height: img.height, ratio: img.width / img.height });
      };
      img.onerror = () => resolve({ width: 0, height: 0, ratio: 1 });
      img.src = base64Image;
    });
  }

  /**
   * 前端專門處理公會戰兵種上陣截圖（支援全螢幕直立截圖與底欄橫條截圖）
   */
  async recognizeBattleScreenFrontend(base64Image, imgInfo, progressCallback) {
    try {
      const isHorizontalBottomBar = imgInfo.ratio > 1.2;

      let statsCrop, leadCrop, nameCrop;

      if (isHorizontalBottomBar) {
        // 橫條底欄截圖 (如 323x102)
        progressCallback(45, '鎖定底欄四圍屬性 (血量/攻擊/防禦/追擊)...');
        // 四圍屬性位於圖片頂部 (Y: 5% ~ 35%)
        statsCrop = await this.cropAndEnhance(base64Image, 0.05, 0.05, 0.95, 0.35, 160);
        
        progressCallback(60, '鎖定底欄領導力進度條數值...');
        // 領導力位於圖片中段 (Y: 48% ~ 68%)
        leadCrop = await this.cropAndEnhance(base64Image, 0.05, 0.48, 0.50, 0.68, 160);
        nameCrop = null;
      } else {
        // 直立全螢幕截圖（依遊戲 UI 實際比例精確定位）
        progressCallback(45, '鎖定四圍屬性欄位 (血量/攻擊/防禦/追擊)...');
        // 四圍屬性位於底部面板上半段 (Y: 82.5% ~ 90.0%)
        statsCrop = await this.cropAndEnhance(base64Image, 0.04, 0.825, 0.96, 0.900, 150);
        
        progressCallback(60, '鎖定領導力進度條數值...');
        // 領導力進度條位於底部面板下半段 (Y: 90.5% ~ 96.5%)
        leadCrop = await this.cropAndEnhance(base64Image, 0.04, 0.905, 0.55, 0.965, 150);

        progressCallback(75, '鎖定玩家標註暱稱...');
        // 玩家暱稱通常標註於棋盤中央或中下方 (Y: 45.0% ~ 78.0%)，避開上方敵軍資訊區
        nameCrop = await this.cropAndEnhance(base64Image, 0.10, 0.450, 0.90, 0.780, 160);
      }

      progressCallback(85, '執行光學字元解析 (OCR)...');

      // 辨識四圍屬性 (強制白名單：僅允許數字、小數點與單位 M/K，排除雜訊)
      let statsText = '';
      try {
        const res = await this.runTesseract(statsCrop, 'eng', {
          tessedit_char_whitelist: '0123456789.MKmk '
        });
        statsText = res.data ? res.data.text : (res.text || '');
      } catch(e){}

      // 辨識領導力 (強制白名單：僅允許數字與斜線)
      let leadText = '';
      try {
        const res = await this.runTesseract(leadCrop, 'eng', {
          tessedit_char_whitelist: '0123456789/ '
        });
        leadText = res.data ? res.data.text : (res.text || '');
      } catch(e){}

      // 辨識名稱
      let nameText = '';
      if (nameCrop) {
        try {
          const res = await this.runTesseract(nameCrop, 'chi_tra+eng');
          nameText = res.data ? res.data.text : (res.text || '');
        } catch(e){}
      }

      // 解析萃取
      let stats = this.parseBattleStatsText(statsText);
      let leadership = this.parseLeadershipText(leadText);
      let cleanName = this.cleanPlayerName(nameText);

      // 動態讀取數值，絕不覆蓋假數據
      if (isHorizontalBottomBar) {
        cleanName = cleanName || "底欄成員";
      }

      // 純動態數值萃取，絕不填寫任何假資料或預設值
      const member = {
        name: cleanName || (isHorizontalBottomBar ? "" : ""),
        leadership: leadership || 0,
        hp: stats.hp || 0,
        atk: stats.atk || 0,
        def: stats.def || 0,
        pursuit: stats.pursuit || 0
      };

      // 如果四圍與領導力完全未能提取到任何數字，自動嘗試全圖表格 OCR 作為備援方案
      if (!stats.hp && !stats.atk && !stats.def && !stats.pursuit && !leadership) {
        progressCallback(90, '嘗試全畫面文字檢測...');
        const tableRes = await this.recognizeTableFrontend(base64Image, progressCallback);
        if (tableRes && tableRes.members && tableRes.members.length > 0) {
          return tableRes;
        }
      }

      progressCallback(100, `辨識完成！成功抓取成員 [${member.name || '未命名'}]`);
      return {
        success: true,
        mode: isHorizontalBottomBar ? 'BOTTOM_BAR' : 'BATTLE_SCREEN',
        members: [member]
      };
    } catch (err) {
      console.error('前端截圖辨識異常:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * 前端處理表格截圖
   */
  async recognizeTableFrontend(base64Image, progressCallback) {
    try {
      progressCallback(55, '執行 OCR 掃描表格文字...');
      const ocrResult = await this.runTesseract(base64Image, 'chi_tra+eng');
      progressCallback(85, '拆解表格列與數據...');
      const members = this.parseOcrText(ocrResult.text);

      progressCallback(100, `表格辨識完成，共解析出 ${members.length} 筆成員`);
      return {
        success: true,
        mode: 'TABLE_OCR',
        members: members
      };
    } catch(err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 專為手遊截圖優化的白底黑字亮度切片裁剪濾鏡 (大幅提升 Tesseract.js 辨識率，支援綠色、亮色、黃金字)
   */
  cropAndEnhance(base64Image, x1Pct, y1Pct, x2Pct, y2Pct, threshold = 160) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const sx = img.width * x1Pct;
        const sy = img.height * y1Pct;
        const sw = img.width * (x2Pct - x1Pct);
        const sh = img.height * (y2Pct - y1Pct);

        // 放大 2.5 倍以利 OCR 清晰分析筆劃
        const scale = 2.5;
        canvas.width = Math.round(sw * scale);
        canvas.height = Math.round(sh * scale);

        // 平滑放大
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

        // 進行白底黑字切片 (支援高對比亮色、綠字、黃金字與青色字)
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imgData.data;

        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          // 判定是否為文字顏色 (白色/亮灰色、綠色屬性字、黃色領導力/屬性字、青色字)
          const isBright = (r >= 135 && g >= 135 && b >= 135);
          const isGreen = (g >= 135 && g > r * 1.12 && g > b * 1.12);
          const isYellow = (r >= 145 && g >= 130 && b < 130);
          const isCyan = (b >= 135 && g >= 130 && r < 130);
          const isText = isBright || isGreen || isYellow || isCyan;

          if (isText) {
            // 文字：轉為純黑
            d[i] = 0;
            d[i + 1] = 0;
            d[i + 2] = 0;
          } else {
            // 背景：轉為純白
            d[i] = 255;
            d[i + 1] = 255;
            d[i + 2] = 255;
          }
        }

        ctx.putImageData(imgData, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = base64Image;
    });
  }

  /**
   * 調用 Tesseract
   */
  async runTesseract(imageSource, lang = 'eng', options = {}) {
    if (typeof Tesseract === 'undefined') {
      throw new Error('Tesseract.js 尚未載入');
    }
    return await Tesseract.recognize(imageSource, lang, options);
  }

  /**
   * 解析四圍屬性文字（自動識別 M 轉換為 K，過濾雜訊符號）
   */
  parseBattleStatsText(text) {
    if (!text) return { hp: 0, atk: 0, def: 0, pursuit: 0 };
    let t = text.replace(/[Oo]/g, '0');
    t = t.replace(/(\d),(\d{1,2})(?=[MmKkVvWwNn\s]|$)/g, '$1.$2');
    t = t.replace(/(\d)\s+(\d\s*[MmKkVvWwNn])/g, '$1.$2');
    t = t.replace(/(\.\d)1{1,2}$/g, '$1M');

    // 匹配如 107M, 20.6M, 19.2M 等
    const matches = [...t.matchAll(/(\d+(?:\.\d+)?)\s*([MmKkVvWwNn])?/g)];
    const values = [];
    for (let m of matches) {
      let numStr = m[1];
      const iconMatch = numStr.match(/^[83S569BbEe](\d{2}(?:\.\d+)?)$/);
      if (iconMatch) {
        const cand = parseFloat(iconMatch[1]);
        if (cand >= 10.0 && cand <= 99.9) {
          numStr = iconMatch[1];
        }
      }
      let val = parseFloat(numStr);
      if (isNaN(val) || val <= 0) continue;
      const unit = (m[2] || '').toUpperCase();
      if (['M', 'V', 'W', 'N', '1'].includes(unit) || val < 1000) {
        val = Math.round(val * 1000);
      } else {
        val = Math.round(val);
      }
      values.push(val);
    }
    return {
      hp: values[0] || 0,
      atk: values[1] || 0,
      def: values[2] || 0,
      pursuit: values[3] || 0
    };
  }

  /**
   * 解析領導力文字 (支援 3751/3751, 340273402, 3402 等格式)
   */
  parseLeadershipText(text) {
    if (!text) return 0;
    let t = text.replace(/[Oo]/g, '0');
    // 標準斜線分隔: 3402/3402
    const m = t.match(/(\d{3,5})\s*[\/\\|!:_]\s*(\d{3,5})/);
    if (m && (m[1] === m[2] || (parseInt(m[1]) >= 2000 && parseInt(m[1]) <= 7500))) {
      return parseInt(m[1], 10);
    }
    // 8位或9位連寫 (如 34023402, 340273402)
    const digits = t.replace(/\D/g, '');
    if (digits.length === 8 && digits.slice(0, 4) === digits.slice(4)) {
      const val = parseInt(digits.slice(0, 4), 10);
      if (val >= 2000 && val <= 7500) return val;
    }
    if (digits.length === 9 && digits.slice(0, 4) === digits.slice(5)) {
      const val = parseInt(digits.slice(0, 4), 10);
      if (val >= 2000 && val <= 7500) return val;
    }
    const single = t.match(/\b([2-6]\d{3})\b/);
    if (single) {
      return parseInt(single[1], 10);
    }
    return 0;
  }

  /**
   * 清理玩家名稱
   */
  cleanPlayerName(text) {
    if (!text) return '';
    // 去除雜訊字元，保留中英數字
    let cleaned = text.replace(/[\n\r\t]/g, '').trim();
    cleaned = cleaned.replace(/^[^a-zA-Z0-9\u4e00-\u9fa5]+|[^a-zA-Z0-9\u4e00-\u9fa5]+$/g, '');
    return cleaned;
  }

  /**
   * 文字智能拆解器（針對橫向表格）
   */
  parseOcrText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const members = [];

    for (let line of lines) {
      if (line.includes('遊戲暱稱') || line.includes('領導力') || line.includes('血量')) continue;
      const tokens = line.split(/[\s,\|\t]+/);
      if (tokens.length >= 2) {
        const name = tokens[0].trim();
        const numbers = [];
        for (let i = 1; i < tokens.length; i++) {
          const cleanNum = tokens[i].replace(/[^\d.]/g, '');
          if (cleanNum) numbers.push(parseFloat(cleanNum));
        }
        if (numbers.length >= 1) {
          members.push({
            name: name,
            leadership: numbers[0] || 0,
            hp: numbers[1] || 0,
            atk: numbers[2] || 0,
            def: numbers[3] || 0,
            pursuit: numbers[4] || 0
          });
        }
      }
    }
    return members;
  }

  /**
   * Gemini Vision 呼叫（支援 JPG/PNG 自動偵測 MIME，完整錯誤日誌）
   */
  async recognizeWithGemini(base64Image, isVerticalBattleScreen = false) {
    if (!this.geminiApiKey) return null;

    // 自動偵測 MIME type（JPG 或 PNG）
    const mimeMatch = base64Image.match(/^data:(image\/[a-zA-Z]+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const base64Data = base64Image.replace(/^data:image\/[a-zA-Z]+;base64,/, '');

    const prompt = isVerticalBattleScreen
      ? `請精確解析這張最強蝸牛公會戰兵種上陣介面截圖：
1. 找出玩家名稱（例如畫面標註的大字，如 Europa 或 命不語）。
2. 找出進度條領導力數值（例如 3751/3751 或 3402/3402，取出整數 3751 或 3402）。
3. 找出底部四圍屬性數值：生命/血量(藥丸)、攻擊(劍)、防禦(盾)、追擊(風)。
注意：數值帶有 M（如 107M, 20.6M），請乘 1000 轉換為 (K) 單位整數（如 107000, 20600）！
只輸出純 JSON 陣列，只包含這 1 位玩家：
[
  {
    "name": "玩家名稱",
    "leadership": 3751,
    "hp": 107000,
    "atk": 20600,
    "def": 19200,
    "pursuit": 21300
  }
]`
      : `請解析這張最強蝸牛公會表格截圖，輸出抓取到的成員 JSON 陣列，每筆包含 name, leadership, hp, atk, def, pursuit（數值單位 K）。`;

    let response, data;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64Data } }
            ]
          }]
        })
      });
      data = await response.json();
    } catch (fetchErr) {
      console.error('[Gemini] 網路請求失敗:', fetchErr);
      throw fetchErr;
    }

    // 檢查 API 錯誤回應
    if (!response.ok || data.error) {
      const errMsg = data.error?.message || `HTTP ${response.status}`;
      console.error('[Gemini] API 錯誤:', errMsg, data);
      throw new Error(`Gemini API 錯誤: ${errMsg}`);
    }

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('[Gemini] 原始回傳:', rawText.slice(0, 200));

    if (!rawText) {
      console.warn('[Gemini] 回傳內容為空');
      return null;
    }

    // 強健的 JSON 擷取（支援 Markdown 包裹、多餘文字）
    let jsonStr = rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    // 嘗試找出 JSON 陣列區段
    const arrMatch = jsonStr.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (arrMatch) jsonStr = arrMatch[0];

    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // 確保數值為整數（Gemini 有時回傳小數）
        return parsed.map(m => ({
          name: m.name || '',
          leadership: Math.round(Number(m.leadership) || 0),
          hp: Math.round(Number(m.hp) || 0),
          atk: Math.round(Number(m.atk) || 0),
          def: Math.round(Number(m.def) || 0),
          pursuit: Math.round(Number(m.pursuit) || 0)
        }));
      }
      console.warn('[Gemini] JSON 解析成功但無成員資料:', parsed);
      return null;
    } catch (parseErr) {
      console.error('[Gemini] JSON 解析失敗:', parseErr, 'rawText:', rawText.slice(0, 300));
      throw parseErr;
    }
  }
}

window.guildOcr = new GuildOcrProcessor();
