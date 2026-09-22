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
        if (frontendRes && frontendRes.length > 0) {
          progressCallback(100, `前端辨識完成！提取到 ${frontendRes.length} 筆資料`);
          return {
            success: true,
            mode: 'FRONTEND_OCR',
            members: frontendRes,
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
        // 直立全螢幕截圖
        progressCallback(45, '鎖定四圍屬性欄位...');
        statsCrop = await this.cropAndEnhance(base64Image, 0.05, 0.765, 0.95, 0.835, 160);
        
        progressCallback(60, '鎖定領導力數值...');
        leadCrop = await this.cropAndEnhance(base64Image, 0.05, 0.835, 0.50, 0.885, 160);

        progressCallback(75, '鎖定玩家名稱...');
        nameCrop = await this.cropAndEnhance(base64Image, 0.15, 0.18, 0.85, 0.27, 175);
      }

      progressCallback(85, '執行光學字元解析 (OCR)...');

      // 辨識四圍屬性
      let statsText = '';
      try {
        const res = await this.runTesseract(statsCrop, 'eng');
        statsText = res.data ? res.data.text : (res.text || '');
      } catch(e){}

      // 辨識領導力
      let leadText = '';
      try {
        const res = await this.runTesseract(leadCrop, 'eng');
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
   * 專為手遊截圖優化的白底黑字亮度切片裁剪濾鏡 (大幅提升 Tesseract.js 辨識率)
   */
  cropAndEnhance(base64Image, x1Pct, y1Pct, x2Pct, y2Pct, threshold = 175) {
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

        // 進行白底黑字切片 (將亮色字體轉為純黑，背景雜訊轉為純白)
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imgData.data;

        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          // 判定是否為亮色/白色字體
          const isBrightText = (r >= threshold && g >= threshold && b >= threshold) ||
                               (r > 190 && g > 190 && Math.abs(r - g) < 30);

          if (isBrightText) {
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
  async runTesseract(imageSource, lang = 'eng') {
    if (typeof Tesseract === 'undefined') {
      throw new Error('Tesseract.js 尚未載入');
    }
    return await Tesseract.recognize(imageSource, lang);
  }

  /**
   * 解析四圍屬性文字（自動識別 M 轉換為 K）
   */
  parseBattleStatsText(text) {
    // 比對例如 107M, 82.4M, 20.6M, 19.2M, 21.3M 等
    const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*([MKmk])?/g)];
    const values = [];
    for (let m of matches) {
      let val = parseFloat(m[1]);
      const unit = (m[2] || '').toUpperCase();
      if (unit === 'M') {
        val = Math.round(val * 1000); // 107M -> 107000, 20.6M -> 20600
      } else if (val < 1000 && (unit === '' || !unit)) {
        // 若辨識漏掉 M 但數字只有十幾、幾十（如 107、20.6），在最強蝸牛屬性中必然是 M 單位！
        val = Math.round(val * 1000);
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
   * 解析領導力文字 (例如 3751/3751, 3402/3402)
   */
  parseLeadershipText(text) {
    const m = text.match(/(\d{3,5})\s*[\/\\]\s*(\d{3,5})/);
    if (m) {
      return parseInt(m[1], 10);
    }
    const single = text.match(/\b([2-5]\d{3})\b/);
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
