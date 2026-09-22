/**
 * 最強蝸牛公會數據統計 - 圖片 OCR 與智能數據萃取模組
 * 純動態辨識，絕不預設任何寫死名單，上傳多少張就辨識多少位成員！
 */

class GuildOcrProcessor {
  constructor() {
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
        progressCallback(30, '使用 AI 智能視覺高精度辨識中...');
        const aiResult = await this.recognizeWithGemini(base64Image, isSnailGameScreen);
        if (aiResult && aiResult.length > 0) {
          progressCallback(100, `AI 辨識完成！抓取到 ${aiResult.length} 筆會員資料`);
          return { success: true, mode: 'AI_VISION', members: aiResult, fileName };
        }
      } catch (err) {
        console.warn('Gemini 辨識失敗，轉用本機引擎:', err);
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

      let bottomCrop, nameCrop;

      if (isHorizontalBottomBar) {
        // 橫條底欄截圖 (如 323x102)
        progressCallback(45, '鎖定底欄四圍與領導力數值...');
        bottomCrop = await this.cropAndEnhance(base64Image, 0.02, 0.02, 0.98, 0.98);
        nameCrop = null;
      } else {
        // 直立全螢幕截圖：全底欄動態捕捉 (覆蓋任何機型之屬性橫條與領導力進度條)
        progressCallback(45, '鎖定四圍屬性與領導力欄位...');
        bottomCrop = await this.cropAndEnhance(base64Image, 0.02, 0.70, 0.98, 0.94);

        progressCallback(65, '鎖定玩家名稱與資訊欄...');
        nameCrop = await this.cropAndEnhance(base64Image, 0.05, 0.14, 0.95, 0.42);
      }

      progressCallback(80, '執行光學字元解析 (OCR)...');

      // 辨識底部數值 (英文數字模式，速度極快且精確度最高)
      let bottomText = '';
      try {
        const res = await this.runTesseract(bottomCrop, 'eng');
        bottomText = res.data ? res.data.text : (res.text || '');
      } catch(e){}

      // 辨識名稱 (中英混合模式)
      let nameText = '';
      if (nameCrop) {
        try {
          const res = await this.runTesseract(nameCrop, 'chi_tra+eng');
          nameText = res.data ? res.data.text : (res.text || '');
        } catch(e){}
      }

      // 解析萃取
      let leadership = this.parseLeadershipText(bottomText);
      let stats = this.parseBattleStatsText(bottomText, leadership);
      let cleanName = this.cleanPlayerName(nameText);

      if (isHorizontalBottomBar) {
        cleanName = cleanName || "底欄成員";
      }

      // 如果四圍與領導力完全未能提取到任何數字，自動嘗試全圖表格 OCR 作為備援方案
      if (!stats.hp && !stats.atk && !stats.def && !stats.pursuit && !leadership) {
        progressCallback(90, '嘗試全畫面文字檢測...');
        const tableRes = await this.recognizeTableFrontend(base64Image, progressCallback);
        if (tableRes && tableRes.members && tableRes.members.length > 0) {
          return tableRes;
        }
      }

      const member = {
        name: cleanName || (isHorizontalBottomBar ? "底欄成員" : "蝸牛成員"),
        leadership: leadership || 0,
        hp: stats.hp || 0,
        atk: stats.atk || 0,
        def: stats.def || 0,
        pursuit: stats.pursuit || 0
      };

      progressCallback(100, `辨識完成！成功抓取成員 [${member.name}]`);
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
   * 圖像裁剪與高動態對比增強 (平滑放大 + 對比度自適應拉伸，絕不硬切黑白)
   */
  cropAndEnhance(base64Image, x1Pct, y1Pct, x2Pct, y2Pct) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const sx = img.width * x1Pct;
        const sy = img.height * y1Pct;
        const sw = img.width * (x2Pct - x1Pct);
        const sh = img.height * (y2Pct - y1Pct);

        // 放大 2.0 倍以利字元筆劃辨識
        const scale = 2.0;
        canvas.width = Math.round(sw * scale);
        canvas.height = Math.round(sh * scale);

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

        // 進行對比度拉伸，避免文字被硬門檻截斷
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imgData.data;

        let minLum = 255;
        let maxLum = 0;
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (lum < minLum) minLum = lum;
          if (lum > maxLum) maxLum = lum;
        }

        const range = Math.max(1, maxLum - minLum);
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          const stretched = Math.min(255, Math.max(0, ((lum - minLum) / range) * 255));
          d[i] = stretched;
          d[i + 1] = stretched;
          d[i + 2] = stretched;
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
  async runTesseract(imageSource, lang = 'eng') {
    if (typeof Tesseract === 'undefined') {
      throw new Error('Tesseract.js 尚未載入');
    }
    return await Tesseract.recognize(imageSource, lang);
  }

  /**
   * 解析四圍屬性文字（自動識別 M 轉換為 K，過濾雜訊符號，排除領導力干擾）
   */
  parseBattleStatsText(text, leadership = 0) {
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
      // 避免把領導力重複抓成屬性 (例如 3377)
      if (leadership > 0 && Math.abs(val - leadership) < 10) continue;
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
   * 清理玩家名稱（排除敵軍、關卡boss與系統干擾詞彙）
   */
  cleanPlayerName(text) {
    if (!text) return '';
    const enemyKeywords = [
      '保全', '行政專員', '專員', '失敗', '勝利', '重實力', '實力',
      '刀客', '冰元素', '力士', '一鍵上陣', '一鍵下陣', '上陣', '下陣',
      '失敗次數', '次數', '敵軍'
    ];
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length >= 2);
    for (let line of lines) {
      let cleaned = line.replace(/^[+＋\-_#@\s\(\)（）]+/, '');
      cleaned = cleaned.replace(/[^\w\u4e00-\u9fa5]/g, '').trim();
      if (cleaned.length < 2) continue;
      if (enemyKeywords.some(kw => cleaned.includes(kw))) continue;
      if (/^[0-9]+$/.test(cleaned) && cleaned.length < 3) continue;
      if (/[0-9.]+[MmKk]/.test(cleaned)) continue;
      return cleaned;
    }
    return '';
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
   * Gemini Vision 呼叫
   */
  async recognizeWithGemini(base64Image, isVerticalBattleScreen = false) {
    if (!this.geminiApiKey) return null;
    const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');

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
      : `請解析這張最強蝸牛公會表格截圖，輸出抓取到的成員 JSON 陣列。`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${this.geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/png", data: base64Data } }
          ]
        }]
      })
    });

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanJson);
  }
}

window.guildOcr = new GuildOcrProcessor();
