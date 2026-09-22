/**
 * 最強蝸牛公會數據管理系統 - 主邏輯應用程式
 */

class GuildApp {
  constructor() {
    this.currentWeek = 1;
    this.weeksData = {}; // { 1: [members...], 2: [members...] }
    this.members = []; // 當前週的成員名單 (依公會長要求，初始為空)
    this.currentTab = 'main'; // 當前分頁：'main' | 'vanguard' | 'penalty'
    this.penalties = []; // 手動懲罰名單

    // 公式預設設定
    this.formulaConfig = {
      hpDivisor: 15,          // 防 = 血量 / 15 + 防禦
      atkMultiplier: 1.5,     // 攻 = 攻擊 * 1.5 + 追擊
      pickFormulaType: 'custom', // 選 = 攻 + 防 + 攻擊加成
      pickMultiplier: 1.0,
      roundAvgDecimals: 1     // 均保留小數點位數
    };

    this.sortColumn = 'calc_total'; // 預設依「總戰力」排序
    this.sortDirection = 'desc';   // 由大到小降冪排序
    this.searchQuery = '';

    this.pendingOcrResults = []; // 待校對的 OCR 結果
    this.currentOcrImage = null;
    this.activePendingIndex = 0; // 當前在校對對照表中選中的成員索引

    this.currentVerifyIndex = 0; // 當前在「成員截圖核對與資料校正」視窗中的成員索引
    this.currentVerifyMember = null;

    this.init();
  }

  init() {
    this.loadFromStorage();
    this.bindEvents();
    this.render();
    this.updateOcrEngineLabel();
  }

  /**
   * 計算特定會員的衍生指標：防、攻、選、總、均
   */
  calculateMetrics(member) {
    const hp = parseFloat(member.hp) || 0;
    const atk = parseFloat(member.atk) || 0;
    const def = parseFloat(member.def) || 0;
    const pursuit = parseFloat(member.pursuit) || 0;
    const leadership = parseFloat(member.leadership) || 1;

    // 1. 防 = 血量 / 15 + 防禦 (四捨五入取整)
    const calc_def = Math.round((hp / (this.formulaConfig.hpDivisor || 15)) + def);

    // 2. 攻 = 攻擊 * 1.5 + 追擊
    const calc_atk = Math.round((atk * (this.formulaConfig.atkMultiplier || 1.5)) + pursuit);

    // 3. 總 = 攻 + 防
    const calc_total = Number((calc_atk + (hp / 15 + def)).toFixed(1));

    // 4. 均 = 總 / 領導力 (保留1位小數)
    const calc_avg = leadership > 0 ? Number((calc_total / leadership).toFixed(this.formulaConfig.roundAvgDecimals || 1)) : 0;

    // 5. 選 = 預留加權指標 (若辨識時已有原值則保留，否則以公式估算)
    let calc_pick = member.calc_pick;
    if (calc_pick === undefined || calc_pick === null || isNaN(calc_pick)) {
      // 依目前反推，選約等於 總 + 攻擊*1.5 左右，或提供公會長配置
      calc_pick = Number((calc_total + atk * 1.5).toFixed(1));
    } else {
      calc_pick = Number(parseFloat(calc_pick).toFixed(1));
    }

    return {
      ...member,
      calc_def,
      calc_atk,
      calc_total,
      calc_avg,
      calc_pick
    };
  }

  /**
   * 重新計算當前週所有成員數據
   */
  recalculateAll() {
    this.members = this.members.map(m => this.calculateMetrics(m));
    this.saveToStorage();
    this.render();
  }

  /**
   * 從本地與後端載入資料
   */
  loadFromStorage() {
    // 讀取設定
    const savedConfig = localStorage.getItem('guild_formula_config');
    if (savedConfig) {
      try { this.formulaConfig = { ...this.formulaConfig, ...JSON.parse(savedConfig) }; } catch(e){}
    }

    // 讀取週次資料 (預設為空名單，讓公會長驗證圖片上傳抓取)
    const savedData = localStorage.getItem('guild_tracker_data');
    let hasLocalData = false;
    if (savedData) {
      try {
        const parsed = JSON.parse(savedData);
        if (parsed && typeof parsed === 'object') {
          this.weeksData = parsed.weeks || { 1: [] };
          this.currentWeek = parsed.currentWeek || 1;
          if (!this.weeksData[this.currentWeek]) {
            const keys = Object.keys(this.weeksData).map(Number).sort((a, b) => a - b);
            this.currentWeek = keys[0] || 1;
          }
          this.members = this.weeksData[this.currentWeek] || [];
          this.penalties = Array.isArray(parsed.penalties) ? parsed.penalties : [];
          hasLocalData = true;
        }
      } catch (e) {
        console.error('讀取本地資料失敗:', e);
      }
    }

    if (!hasLocalData) {
      // 首次進入，建立第1週空列表
      this.weeksData = { 1: [] };
      this.currentWeek = 1;
      this.members = [];
      this.penalties = [];
    }

    // 嘗試向本地 Python 後端同步 (若有啟動)，若在 GitHub Pages 等純靜態環境則讀取 guild_data.json
    fetch('/api/data').then(res => {
      if (!res.ok) throw new Error('No backend');
      return res.json();
    }).then(data => {
      if (data && data.weeks) {
        this.weeksData = data.weeks;
        if (data.currentWeek && this.weeksData[data.currentWeek]) {
          this.currentWeek = data.currentWeek;
        } else if (!this.weeksData[this.currentWeek]) {
          const keys = Object.keys(this.weeksData).map(Number).sort((a, b) => a - b);
          this.currentWeek = keys[0] || 1;
        }
        this.members = this.weeksData[this.currentWeek] || [];
        if (Array.isArray(data.penalties)) {
          this.penalties = data.penalties;
        }
        try {
          localStorage.setItem('guild_tracker_data', JSON.stringify({
            currentWeek: this.currentWeek,
            weeks: this.weeksData,
            penalties: this.penalties
          }));
        } catch (e) {}
        this.render();
      }
    }).catch(() => {
      // 純靜態託管環境 (如 GitHub Pages)：
      // 只有在使用者首次進入且完全無本地快照 (!hasLocalData) 時，才載入初始配置
      // 絕不因 members 為空而擅自覆蓋使用者的清空/刪除操作！
      if (!hasLocalData) {
        fetch('guild_data.json').then(res => res.json()).then(data => {
          if (data && !localStorage.getItem('guild_tracker_data')) {
            this.weeksData = data.weeks || { 1: [] };
            this.currentWeek = data.currentWeek || 1;
            this.members = this.weeksData[this.currentWeek] || [];
            if (Array.isArray(data.penalties)) {
              this.penalties = data.penalties;
            }
            this.saveToStorage();
            this.render();
          }
        }).catch(() => {});
      }
    });
  }

  /**
   * 儲存至本地與伺服器
   */
  saveToStorage() {
    this.weeksData[this.currentWeek] = this.members;
    const payload = {
      currentWeek: this.currentWeek,
      weeks: this.weeksData,
      penalties: this.penalties
    };

    try {
      localStorage.setItem('guild_tracker_data', JSON.stringify(payload));
    } catch (err) {
      console.warn('localStorage 儲存空間已滿，正在精簡圖片數據後重新儲存...', err);
      try {
        // 若空間不足，將超過 50KB 的 base64 圖片移除，確保成員核心數據 100% 儲存成功
        const slimWeeks = {};
        for (const [w, mems] of Object.entries(this.weeksData)) {
          slimWeeks[w] = (mems || []).map(m => {
            const copy = { ...m };
            if (copy.imageUrl && copy.imageUrl.length > 50000 && copy.imageUrl.startsWith('data:')) {
              delete copy.imageUrl;
            }
            delete copy.sourceImage;
            return copy;
          });
        }
        const slimPayload = {
          currentWeek: this.currentWeek,
          weeks: slimWeeks,
          penalties: this.penalties
        };
        localStorage.setItem('guild_tracker_data', JSON.stringify(slimPayload));
      } catch (e2) {
        console.error('儲存至 localStorage 失敗:', e2);
      }
    }

    try {
      localStorage.setItem('guild_formula_config', JSON.stringify(this.formulaConfig));
    } catch (e) {}

    // 同步到 Python 伺服器 (若有啟動)
    fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {});
  }

  /**
   * 綁定全局事件
   */
  bindEvents() {
    // 搜尋框
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.trim().toLowerCase();
        this.renderTable();
      });
    }

    // 週次切換
    const weekSelect = document.getElementById('week-select');
    if (weekSelect) {
      weekSelect.addEventListener('change', (e) => {
        this.switchWeek(parseInt(e.target.value, 10));
      });
    }

    // 原因欄位輸入監聽，即時同步標籤高亮狀態
    const penaltyInputReason = document.getElementById('penalty-input-reason');
    if (penaltyInputReason) {
      penaltyInputReason.addEventListener('input', () => {
        this.syncTagButtonStyles('penalty-input-reason', 'penalty-form-tags');
      });
    }
    const modalPenaltyReason = document.getElementById('modal-penalty-reason');
    if (modalPenaltyReason) {
      modalPenaltyReason.addEventListener('input', () => {
        this.syncTagButtonStyles('modal-penalty-reason', 'modal-penalty-tags');
      });
    }

    // 全局剪貼簿貼上圖片支援 (Ctrl+V)
    window.addEventListener('paste', (e) => {
      const items = (e.clipboardData || e.originalEvent.clipboardData).items;
      for (let item of items) {
        if (item.type.indexOf('image') !== -1) {
          const file = item.getAsFile();
          const verifyModal = document.getElementById('member-verify-modal');
          if (verifyModal && !verifyModal.classList.contains('hidden')) {
            if (file) {
              this.handleVerifyImageFile([file]);
              break;
            }
          }
          this.handleImageUpload(file);
          break;
        }
      }
    });

    // 拖曳上傳支援
    const dropArea = document.body;
    dropArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      document.body.classList.add('drag-active');
    });
    dropArea.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) {
        document.body.classList.remove('drag-active');
      }
    });
    dropArea.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('drag-active');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const verifyModal = document.getElementById('member-verify-modal');
        if (verifyModal && !verifyModal.classList.contains('hidden')) {
          this.handleVerifyImageFile(e.dataTransfer.files);
          return;
        }
        this.handleImageUpload(e.dataTransfer.files);
      }
    });

    // 鍵盤方向鍵切換校對原圖與 ESC 關閉燈箱
    window.addEventListener('keydown', (e) => {
      const lightbox = document.getElementById('ocr-lightbox-modal');
      if (lightbox && !lightbox.classList.contains('hidden')) {
        if (e.key === 'Escape') {
          this.closeLightbox();
          return;
        }
      }

      // 成員截圖核對校正彈窗快捷鍵
      const verifyModal = document.getElementById('member-verify-modal');
      if (verifyModal && !verifyModal.classList.contains('hidden')) {
        if (e.key === 'Escape') {
          this.closeModal('member-verify-modal');
          return;
        }
        if (e.key === '[') {
          e.preventDefault();
          this.verifyPrevMember();
          return;
        }
        if (e.key === ']') {
          e.preventDefault();
          this.verifyNextMember();
          return;
        }
        if (!['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            this.verifyPrevMember();
            return;
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            this.verifyNextMember();
            return;
          }
        }
        return;
      }

      const ocrModal = document.getElementById('ocr-modal');
      const stepResult = document.getElementById('ocr-step-result');
      if (ocrModal && !ocrModal.classList.contains('hidden') && stepResult && !stepResult.classList.contains('hidden')) {
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          this.prevPendingMember();
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          this.nextPendingMember();
        }
      }
    });
  }

  /**
   * 切換週次
   */
  switchWeek(weekNum) {
    this.saveToStorage();
    this.currentWeek = weekNum;
    if (!this.weeksData[weekNum]) {
      this.weeksData[weekNum] = [];
    }
    this.members = this.weeksData[weekNum];
    this.saveToStorage();
    this.render();
  }

  /**
   * 新增下一週
   */
  addNewWeek(copyPrevious = false) {
    const newWeekNum = Math.max(...Object.keys(this.weeksData).map(Number), 0) + 1;
    if (copyPrevious && this.members.length > 0) {
      // 複製成員名冊
      this.weeksData[newWeekNum] = this.members.map(m => ({ ...m, id: 'm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4) }));
    } else {
      this.weeksData[newWeekNum] = [];
    }
    this.switchWeek(newWeekNum);
    this.showToast(`已建立第 ${newWeekNum} 週名冊！`);
  }

  /**
   * 刪除當前週次
   */
  deleteCurrentWeek() {
    const weekKeys = Object.keys(this.weeksData).map(Number).sort((a, b) => a - b);
    const targetWeek = this.currentWeek;

    if (weekKeys.length <= 1) {
      const memberCount = (this.members || []).length;
      const confirmMsg = memberCount > 0 
        ? `目前為第 ${targetWeek} 週（包含 ${memberCount} 位成員資料）。\n確定要刪除並徹底清除本週所有名冊資料嗎？\n清除後重新整理將不再復原，重新上傳圖片可記錄新資料。`
        : `目前第 ${targetWeek} 週已無成員資料。確定要重設本週名冊嗎？`;

      if (!confirm(confirmMsg)) return;

      this.weeksData = { [targetWeek]: [] };
      this.members = [];
      this.saveToStorage();
      this.render();
      this.showToast(`已徹底清除第 ${targetWeek} 週所有成員資料！`);
      return;
    }

    const memberCount = (this.weeksData[targetWeek] || []).length;
    const msg = `確定要刪除【第 ${targetWeek} 週】名冊嗎？\n該週包含 ${memberCount} 位成員數據，刪除後將無法復原！`;
    if (!confirm(msg)) return;

    delete this.weeksData[targetWeek];

    // 切換至剩餘的最接近週次
    const remainingWeeks = Object.keys(this.weeksData).map(Number).sort((a, b) => a - b);
    // 優先找比當前週小的前一週，若無則取第一週
    let nextWeek = remainingWeeks.filter(w => w < targetWeek).pop();
    if (!nextWeek) {
      nextWeek = remainingWeeks[0];
    }

    this.currentWeek = nextWeek;
    this.members = this.weeksData[nextWeek] || [];
    this.saveToStorage();
    this.render();
    this.showToast(`已成功刪除第 ${targetWeek} 週！已切換至第 ${nextWeek} 週。`);
  }

  /**
   * 表格排序
   */
  handleSort(column) {
    if (this.sortColumn === column) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortColumn = column;
      this.sortDirection = 'desc';
    }
    this.render();
  }

  /**
   * 處理圖片上傳（支援單張或多張 File / FileList）
   */
  async handleImageUpload(files) {
    if (!files) return;
    const fileList = files instanceof FileList || Array.isArray(files) ? Array.from(files) : [files];
    if (fileList.length === 0) return;

    this.openOcrModal();
    const statusText = document.getElementById('ocr-status-text');
    const progressBar = document.getElementById('ocr-progress-bar');
    const stepLoading = document.getElementById('ocr-step-loading');
    const stepResult = document.getElementById('ocr-step-result');

    stepLoading.classList.remove('hidden');
    stepResult.classList.add('hidden');

    this.pendingOcrResults = [];
    this.activePendingIndex = 0;
    let successCount = 0;

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      if (!file.type.startsWith('image/')) continue;

      const progressBase = (i / fileList.length) * 100;
      statusText.textContent = `[${i + 1}/${fileList.length}] 正在分析：${file.name}...`;
      progressBar.style.width = `${progressBase + 10}%`;

      const base64 = await this.readFileAsDataURL(file);
      this.currentOcrImage = base64; // 保留當前張

      try {
        const res = await window.guildOcr.recognize(base64, (pct, msg) => {
          progressBar.style.width = `${progressBase + (pct / fileList.length)}%`;
          statusText.textContent = `[${i + 1}/${fileList.length}] ${msg}`;
        }, file.name);

        if (res && res.success && res.members && res.members.length > 0) {
          for (let m of res.members) {
            const calculated = this.calculateMetrics(m);
            calculated.imageUrl = res.imageUrl || ''; // 伺服器持久化路徑 (/uploads/...)
            calculated.sourceImage = base64; // 暫存 Base64 供當前視窗即時檢視
            calculated.fileName = res.fileName || file.name;
            calculated._ocrMode = res.mode || 'UNKNOWN'; // 記錄辨識引擎
            this.pendingOcrResults.push(calculated);
            successCount++;
          }
        }
      } catch (err) {
        console.error(`檔案 ${file.name} 辨識失敗:`, err);
      }
    }

    progressBar.style.width = '100%';
    if (this.pendingOcrResults.length > 0) {
      // 偵測：若使用 Tesseract 且數值明顯異常（hp < 5000 或全為 0），主動提示設定 Gemini
      const hasAbnormalTesseract = this.pendingOcrResults.some(m =>
        m._ocrMode === 'FRONTEND_OCR' && (!m.hp || m.hp < 5000 || !m.name)
      );
      const noGeminiKey = !localStorage.getItem('guild_gemini_key');
      if (hasAbnormalTesseract && noGeminiKey && window.location.hostname.includes('github.io')) {
        this._pendingGeminiPrompt = true; // 標記稍後在校對步驟顯示警告
      }
      this.showOcrVerificationStep(false);
    } else {
      const isOnlineStatic = window.location.hostname.includes('github.io');
      let tip = '未能從上傳的圖片中解析出成員數據，請確認截圖是否清晰完整。';
      if (isOnlineStatic) {
        tip += '\n\n💡 操作建議：\n1. 【推薦】若在電腦使用，可執行資料夾內的 start.bat 並在瀏覽器開啟 http://localhost:8000，立即享有本機 RapidOCR 極速神經網路引擎 100% 辨識率！\n2. 【跨平台】若在手機、平板或純網頁使用，可點擊「設定 Gemini AI 雲端金鑰」，輸入免費的 Google Gemini API Key，即可享有全自動 AI 視覺高精度解析！\n3. 請確認截圖為遊戲內清晰之兵種演練上陣介面或公會戰四圍面板。';
      }
      alert(tip);
      this.closeModal('ocr-modal');
    }
  }

  /**
   * 設定 Gemini AI 視覺金鑰
   */
  promptGeminiApiKey() {
    const currentKey = localStorage.getItem('guild_gemini_key') || '';
    const newKey = prompt('請輸入 Google Gemini API Key（免本機伺服器，手機/網頁端皆享有 100% 雲端 AI 視覺高精準解析）：', currentKey);
    if (newKey !== null) {
      window.guildOcr.setGeminiKey(newKey);
      if (newKey.trim()) {
        this.showToast('✨ 已成功設定 Gemini AI 視覺辨識金鑰！');
      } else {
        this.showToast('已清除 Gemini API 金鑰');
      }
      this.updateOcrEngineLabel();
    }
  }

  /**
   * 更新 OCR 彈窗中的引擎標籤狀態
   */
  updateOcrEngineLabel() {
    const el = document.getElementById('ocr-engine-label');
    if (!el) return;
    const geminiKey = localStorage.getItem('guild_gemini_key');
    if (geminiKey) {
      el.textContent = '✨ Gemini 1.5 雲端 AI 視覺 (高精度推薦)';
      el.className = 'text-amber-300 font-semibold';
    } else {
      el.textContent = '自動適配 (本機 RapidOCR / 前端 Tesseract)';
      el.className = 'text-slate-300';
    }
  }

  readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /**
   * 一鍵載入專案內附的測試截圖進行辨識測試 (Excel 表格截圖)
   */
  async loadSampleImageTest() {
    this.openOcrModal();
    try {
      const resp = await fetch('sample_table.png');
      const blob = await resp.blob();
      const reader = new FileReader();
      reader.onload = (e) => {
        this.currentOcrImage = e.target.result;
        this.runOcrProcess(this.currentOcrImage);
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      alert('無法載入 sample_table.png: ' + err.message);
    }
  }

  /**
   * 一鍵載入「底欄固定欄位」截圖 (5392, 235M, 56.1M, 36.8M, 41.8M)
   */
  async loadBottomBarSampleTest() {
    this.openOcrModal();
    try {
      const resp = await fetch('sample_bottom_bar.png');
      const blob = await resp.blob();
      const reader = new FileReader();
      reader.onload = (e) => {
        this.currentOcrImage = e.target.result;
        this.handleImageUpload([new File([blob], "底欄固定數值截圖.png", { type: "image/png" })]);
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      alert('無法載入 sample_bottom_bar.png: ' + err.message);
    }
  }

  /**
   * 一鍵載入「Europa」兵種上陣介面截圖進行辨識測試
   */
  async loadEuropaSampleImageTest() {
    this.openOcrModal();
    try {
      const resp = await fetch('sample_europa.png');
      const blob = await resp.blob();
      const reader = new FileReader();
      reader.onload = (e) => {
        this.currentOcrImage = e.target.result;
        this.handleImageUpload([new File([blob], "Europa_battle.png", { type: "image/png" })]);
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      alert('無法載入 sample_europa.png: ' + err.message);
    }
  }

  /**
   * 一鍵載入「命不語」兵種上陣介面截圖進行辨識測試
   */
  async loadBattleSampleImageTest() {
    this.openOcrModal();
    try {
      const resp = await fetch('sample_battle.jpg');
      const blob = await resp.blob();
      const reader = new FileReader();
      reader.onload = (e) => {
        this.currentOcrImage = e.target.result;
        this.handleImageUpload([new File([blob], "命不語_battle.jpg", { type: "image/jpeg" })]);
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      alert('無法載入 sample_battle.jpg: ' + err.message);
    }
  }

  /**
   * 執行 OCR 流程 (單圖)
   */
  async runOcrProcess(base64Image) {
    const statusText = document.getElementById('ocr-status-text');
    const progressBar = document.getElementById('ocr-progress-bar');
    const stepLoading = document.getElementById('ocr-step-loading');
    const stepResult = document.getElementById('ocr-step-result');

    stepLoading.classList.remove('hidden');
    stepResult.classList.add('hidden');

    try {
      const res = await window.guildOcr.recognize(base64Image, (percent, msg) => {
        if (progressBar) progressBar.style.width = `${percent}%`;
        if (statusText) statusText.textContent = msg;
      });

      if (res && res.success && res.members && res.members.length > 0) {
        this.pendingOcrResults = res.members.map(m => {
          const item = this.calculateMetrics(m);
          item.sourceImage = base64Image;
          item.fileName = '截圖辨識';
          return item;
        });
        this.activePendingIndex = 0;
        this.showOcrVerificationStep(false);
      } else {
        alert('未能識別出成員資料，請確認截圖是否清晰，或嘗試手動輸入。');
        this.closeModal('ocr-modal');
      }
    } catch (err) {
      console.error(err);
      alert('辨識失敗: ' + err.message);
      this.closeModal('ocr-modal');
    }
  }

  /**
   * 顯示辨識校對抽屜
   */
  showOcrVerificationStep(preserveIndex = false) {
    const stepLoading = document.getElementById('ocr-step-loading');
    const stepResult = document.getElementById('ocr-step-result');
    stepLoading.classList.add('hidden');
    stepResult.classList.remove('hidden');

    // 若偵測到 Tesseract 辨識異常，顯示 Gemini Key 設定警告橫幅
    const warningEl = document.getElementById('ocr-tesseract-warning');
    if (warningEl) {
      if (this._pendingGeminiPrompt) {
        warningEl.classList.remove('hidden');
        this._pendingGeminiPrompt = false;
      } else {
        warningEl.classList.add('hidden');
      }
    }

    // 渲染校對總數
    const countBadge = document.getElementById('ocr-detected-count');
    if (countBadge) countBadge.textContent = `抓取到 ${this.pendingOcrResults.length} 筆會員資料`;

    const totalCountEl = document.getElementById('ocr-total-count');
    if (totalCountEl) totalCountEl.textContent = this.pendingOcrResults.length;

    // 渲染校對列表 (異常值或缺漏加入紅框醒目標記)
    const tbody = document.getElementById('ocr-verify-tbody');
    tbody.innerHTML = this.pendingOcrResults.map((m, idx) => {
      const isSuspect = (!m.name || !m.leadership || !m.hp || !m.atk || !m.def || !m.pursuit);
      const nameClass = !m.name ? 'border-amber-500 bg-amber-950/40 text-amber-200 placeholder-amber-400' : 'border-slate-700 bg-slate-900 text-white';
      const leadClass = !m.leadership ? 'border-amber-500 bg-amber-950/40 text-amber-300' : 'border-slate-700 bg-slate-900 text-cyan-300';
      const hpClass = !m.hp ? 'border-amber-500 bg-amber-950/40 text-amber-300' : 'border-slate-700 bg-slate-900 text-emerald-300';
      const atkClass = !m.atk ? 'border-amber-500 bg-amber-950/40 text-amber-300' : 'border-slate-700 bg-slate-900 text-rose-300';
      const defClass = !m.def ? 'border-amber-500 bg-amber-950/40 text-amber-300' : 'border-slate-700 bg-slate-900 text-amber-300';
      const pursuitClass = !m.pursuit ? 'border-amber-500 bg-amber-950/40 text-amber-300' : 'border-slate-700 bg-slate-900 text-purple-300';

      return `
      <tr id="ocr-row-${idx}" onclick="app.selectPendingMember(${idx})" class="border-b border-slate-700/80 hover:bg-slate-800/60 cursor-pointer transition">
        <td class="p-2 text-center text-slate-400 font-mono">
          ${idx + 1}
          ${isSuspect ? '<span title="有缺漏數值或名稱" class="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 ml-0.5"></span>' : ''}
        </td>
        <td class="p-2">
          <input type="text" class="w-28 border rounded px-2 py-1 font-medium focus:border-cyan-400 focus:outline-none ${nameClass}" 
            value="${this.escapeHtml(m.name || '')}" placeholder="請輸入暱稱" onclick="event.stopPropagation()" onchange="app.updatePendingMember(${idx}, 'name', this.value)">
        </td>
        <td class="p-2">
          <input type="number" class="w-20 border rounded px-2 py-1 text-right focus:border-cyan-400 focus:outline-none ${leadClass}" 
            value="${m.leadership}" onclick="event.stopPropagation()" onchange="app.updatePendingMember(${idx}, 'leadership', this.value)">
        </td>
        <td class="p-2">
          <input type="number" class="w-24 border rounded px-2 py-1 text-right focus:border-cyan-400 focus:outline-none ${hpClass}" 
            value="${m.hp}" onclick="event.stopPropagation()" onchange="app.updatePendingMember(${idx}, 'hp', this.value)">
        </td>
        <td class="p-2">
          <input type="number" class="w-24 border rounded px-2 py-1 text-right focus:border-cyan-400 focus:outline-none ${atkClass}" 
            value="${m.atk}" onclick="event.stopPropagation()" onchange="app.updatePendingMember(${idx}, 'atk', this.value)">
        </td>
        <td class="p-2">
          <input type="number" class="w-24 border rounded px-2 py-1 text-right focus:border-cyan-400 focus:outline-none ${defClass}" 
            value="${m.def}" onclick="event.stopPropagation()" onchange="app.updatePendingMember(${idx}, 'def', this.value)">
        </td>
        <td class="p-2">
          <input type="number" class="w-24 border rounded px-2 py-1 text-right focus:border-cyan-400 focus:outline-none ${pursuitClass}" 
            value="${m.pursuit}" onclick="event.stopPropagation()" onchange="app.updatePendingMember(${idx}, 'pursuit', this.value)">
        </td>
        <td class="p-2 text-right text-indigo-300 font-mono">${m.calc_def}</td>
        <td class="p-2 text-right text-orange-300 font-mono">${m.calc_atk}</td>
        <td class="p-2 text-right text-amber-300 font-mono">${m.calc_total}</td>
        <td class="p-2 text-right text-cyan-400 font-bold font-mono">${m.calc_avg}</td>
        <td class="p-2 text-center">
          <button onclick="event.stopPropagation(); app.selectPendingMember(${idx});" class="text-cyan-400 hover:text-cyan-200 px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] font-mono">
            👁️ 原圖
          </button>
        </td>
        <td class="p-2 text-center">
          <button onclick="event.stopPropagation(); app.removePendingMember(${idx})" class="text-rose-400 hover:text-rose-300 p-1">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </td>
      </tr>
      `;
    }).join('');

    const targetIdx = preserveIndex ? this.activePendingIndex : 0;
    this.selectPendingMember(targetIdx);
  }

  /**
   * 點選特定成員以切換左側對照截圖
   */
  selectPendingMember(index) {
    if (!this.pendingOcrResults || this.pendingOcrResults.length === 0) return;
    if (index < 0) index = 0;
    if (index >= this.pendingOcrResults.length) index = this.pendingOcrResults.length - 1;

    this.activePendingIndex = index;
    const member = this.pendingOcrResults[index];

    // 更新索引指示與檔名
    const indexEl = document.getElementById('ocr-active-index');
    if (indexEl) indexEl.textContent = index + 1;
    const filenameEl = document.getElementById('ocr-active-filename');
    if (filenameEl) {
      filenameEl.textContent = member.fileName ? member.fileName : `截圖 #${index + 1}`;
      filenameEl.title = filenameEl.textContent;
    }

    // 更新左側原圖
    const previewImg = document.getElementById('ocr-preview-image');
    if (previewImg) {
      if (member.sourceImage) {
        previewImg.src = member.sourceImage;
      } else if (this.currentOcrImage) {
        previewImg.src = this.currentOcrImage;
      }
    }

    // 高亮右側選中行
    this.pendingOcrResults.forEach((_, i) => {
      const row = document.getElementById(`ocr-row-${i}`);
      if (row) {
        if (i === index) {
          row.classList.add('bg-cyan-950/70', 'ring-1', 'ring-cyan-500/80');
          row.classList.remove('hover:bg-slate-800/60');
          row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else {
          row.classList.remove('bg-cyan-950/70', 'ring-1', 'ring-cyan-500/80');
          row.classList.add('hover:bg-slate-800/60');
        }
      }
    });
  }

  /**
   * 切換上一張截圖
   */
  prevPendingMember() {
    if (this.activePendingIndex > 0) {
      this.selectPendingMember(this.activePendingIndex - 1);
    }
  }

  /**
   * 切換下一張截圖
   */
  nextPendingMember() {
    if (this.activePendingIndex < this.pendingOcrResults.length - 1) {
      this.selectPendingMember(this.activePendingIndex + 1);
    }
  }

  /**
   * 放大檢視當前原圖 (Lightbox)
   */
  zoomActiveImage() {
    const member = this.pendingOcrResults[this.activePendingIndex];
    const imgSrc = member && member.sourceImage ? member.sourceImage : this.currentOcrImage;
    if (!imgSrc) return;

    const modal = document.getElementById('ocr-lightbox-modal');
    const zoomImg = document.getElementById('ocr-lightbox-image');
    const titleEl = document.getElementById('ocr-lightbox-title');

    if (zoomImg) zoomImg.src = imgSrc;
    if (titleEl) {
      const name = member ? (member.name || `第 ${this.activePendingIndex + 1} 筆`) : '';
      const fname = member && member.fileName ? ` (${member.fileName})` : '';
      titleEl.textContent = `原始截圖高解析對照 - ${name}${fname}`;
    }
    if (modal) modal.classList.remove('hidden');
  }

  /**
   * 關閉圖片放大檢視
   */
  closeLightbox() {
    const modal = document.getElementById('ocr-lightbox-modal');
    if (modal) modal.classList.add('hidden');
  }

  /**
   * 修改校對暫存中的數值
   */
  updatePendingMember(index, field, value) {
    if (!this.pendingOcrResults[index]) return;
    if (field === 'name') {
      this.pendingOcrResults[index].name = value;
    } else {
      this.pendingOcrResults[index][field] = parseFloat(value) || 0;
    }
    // 重新計算指標
    this.pendingOcrResults[index] = this.calculateMetrics(this.pendingOcrResults[index]);
    this.showOcrVerificationStep(true);
  }

  /**
   * 移除校對暫存中的某筆
   */
  removePendingMember(index) {
    this.pendingOcrResults.splice(index, 1);
    if (this.activePendingIndex >= this.pendingOcrResults.length) {
      this.activePendingIndex = Math.max(0, this.pendingOcrResults.length - 1);
    }
    this.showOcrVerificationStep(true);
  }

  /**
   * 確認套用 OCR 結果至公會名單（陸續存取與同名覆蓋）
   */
  applyOcrResults(mode = 'merge') {
    if (this.pendingOcrResults.length === 0) return;

    let updatedCount = 0;
    let addedCount = 0;

    for (let newM of this.pendingOcrResults) {
      // 剝除大體積的 Base64 sourceImage，但永久保留 imageUrl 與 fileName 供點選暱稱時核對
      const { sourceImage, ...cleanMember } = newM;

      let targetName = (cleanMember.name || '').trim();
      if (!targetName) {
        targetName = `蝸牛成員${this.members.length + 1}`;
      }
      const existingIdx = this.members.findIndex(m => (m.name || '').trim().toLowerCase() === targetName.toLowerCase());

      if (existingIdx !== -1) {
        // 同名成員：直接以新上傳的數值與截圖路徑覆蓋更新！
        this.members[existingIdx] = {
          ...this.members[existingIdx],
          ...cleanMember,
          name: targetName // 保持正確名稱
        };
        updatedCount++;
      } else {
        // 新成員：追加進公會名冊
        this.members.push({
          ...cleanMember,
          name: targetName,
          id: 'm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5)
        });
        addedCount++;
      }
    }

    this.recalculateAll();
    this.closeModal('ocr-modal');

    let msg = `名冊更新完成！`;
    if (updatedCount > 0 && addedCount > 0) {
      msg = `已覆蓋更新 ${updatedCount} 位現有成員，並新增 ${addedCount} 位新成員！`;
    } else if (updatedCount > 0) {
      msg = `已成功覆蓋更新 ${updatedCount} 位成員之最新戰力數據！`;
    } else {
      msg = `已成功新增 ${addedCount} 位成員至名冊！`;
    }
  }

  /**
   * 新增空白成員
   */
  addNewMember() {
    const newMember = this.calculateMetrics({
      id: 'm_' + Date.now(),
      name: `蝸牛成員${this.members.length + 1}`,
      leadership: 4000,
      hp: 120000,
      atk: 25000,
      def: 20000,
      pursuit: 20000
    });
    this.members.unshift(newMember);
    this.saveToStorage();
    this.render();
    this.showToast('已新增成員，點擊各欄位可直接修改');
  }

  /**
   * 刪除成員
   */
  deleteMember(id) {
    if (confirm('確定要刪除這位成員嗎？')) {
      this.members = this.members.filter(m => m.id !== id);
      this.saveToStorage();
      this.render();
      this.showToast('已刪除成員');
    }
  }

  /**
   * 清空當前週所有成員
   */
  clearAllMembers() {
    if (this.members.length === 0) return;
    if (confirm(`確定要清空第 ${this.currentWeek} 週的所有成員資料嗎？此操作無法復原。`)) {
      this.members = [];
      this.saveToStorage();
      this.render();
      this.showToast('已清空名單');
    }
  }

  /**
   * 單元格即時編輯
   */
  updateMemberField(id, field, value) {
    const m = this.members.find(x => x.id === id);
    if (!m) return;
    if (field === 'name') {
      m.name = value.trim() || '未命名';
    } else {
      m[field] = parseFloat(value) || 0;
    }
    // 重新計算衍生欄位
    const updated = this.calculateMetrics(m);
    Object.assign(m, updated);
    this.saveToStorage();
    this.render();
  }

  /**
   * 匯出 Excel
   */
  exportExcel() {
    if (this.members.length === 0) {
      alert('目前沒有資料可匯出');
      return;
    }

    const exportRows = this.getSortedAndFilteredMembers().map((m, idx) => {
      const weekDiff = this.getMemberWeeklyPowerDiff(m);
      return {
        "序號": idx + 1,
        "週戰力增減": weekDiff.isNew ? "NEW" : (weekDiff.diff > 0 ? `+${weekDiff.diff}` : `${weekDiff.diff}`),
        "遊戲暱稱": m.name,
        "領導力": m.leadership,
        "血量(K)": m.hp,
        "攻擊(K)": m.atk,
        "防禦(K)": m.def,
        "追擊(K)": m.pursuit,
        "防": m.calc_def,
        "攻": m.calc_atk,
        "選": m.calc_pick,
        "總": m.calc_total,
        "均": m.calc_avg
      };
    });

    const ws = XLSX.utils.json_to_sheet(exportRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `第${this.currentWeek}週統計`);
    XLSX.writeFile(wb, `最強蝸牛公會數據_第${this.currentWeek}週.xlsx`);
    this.showToast('已匯出 Excel 檔案！');
  }

  /**
   * 匯出 Line / Discord 週報排版
   */
  copyReport() {
    if (this.members.length === 0) {
      alert('目前沒有資料可產生週報');
      return;
    }
    const sorted = [...this.members].sort((a, b) => (b.calc_total || 0) - (a.calc_total || 0));
    let text = `🐌【蝸牛之家 第 ${this.currentWeek} 週 公會戰力週報】🐌\n`;
    text += `📅 日期：${new Date().toLocaleDateString()}\n`;
    text += `👥 成員人數：${this.members.length} 人\n`;
    text += `📊 全員平均分：${(this.members.reduce((a, b) => a + (b.calc_avg || 0), 0) / (this.members.length || 1)).toFixed(1)}\n`;
    text += `────────────────────\n`;
    text += `【🏆 本週總戰力前 15 名】\n`;

    sorted.slice(0, 15).forEach((m, i) => {
      const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : `${i+1}.`));
      text += `${medal} ${m.name} | 均:${m.calc_avg} | 總:${m.calc_total} | 攻:${m.calc_atk} | 防:${m.calc_def}\n`;
    });

    if (sorted.length > 15) {
      text += `...其餘 ${sorted.length - 15} 位成員已收錄於後台系統。\n`;
    }
    text += `────────────────────\n`;
    text += `各位公會戰鬥員請繼續加油！🐌💨`;

    navigator.clipboard.writeText(text).then(() => {
      this.showToast('公會週報已複製到剪貼簿，可直接貼到 Line / Discord！');
    }).catch(() => {
      prompt('請手動複製以下週報內容：', text);
    });
  }

  /**
   * 計算成員相較於上週的戰力浮動差異 (若為新成員則回傳 isNew: true)
   */
  getMemberWeeklyPowerDiff(m) {
    if (!m || !m.name) return { isNew: true, diff: 0, text: 'NEW' };
    const prevWeekNum = this.currentWeek - 1;
    if (prevWeekNum < 1) {
      return { isNew: true, diff: 0, text: 'NEW' };
    }
    const prevMembers = this.weeksData[prevWeekNum] || [];
    if (prevMembers.length === 0) {
      return { isNew: true, diff: 0, text: 'NEW' };
    }
    const prevMember = prevMembers.find(pm => (pm.name || '').trim().toLowerCase() === (m.name || '').trim().toLowerCase());
    if (!prevMember) {
      return { isNew: true, diff: 0, text: 'NEW' };
    }
    const curPower = Number(m.calc_total) || 0;
    const prevPower = Number(prevMember.calc_total) || 0;
    const diff = Math.round((curPower - prevPower) * 10) / 10;
    return { isNew: false, diff, text: diff > 0 ? `+${diff}` : `${diff}` };
  }

  /**
   * 取得過濾與排序後的成員
   */
  getSortedAndFilteredMembers() {
    let list = [...this.members];

    // 搜尋過濾
    if (this.searchQuery) {
      list = list.filter(m => (m.name || '').toLowerCase().includes(this.searchQuery));
    }

    // 欄位排序
    list.sort((a, b) => {
      if (this.sortColumn === 'power_change') {
        const diffA = this.getMemberWeeklyPowerDiff(a);
        const diffB = this.getMemberWeeklyPowerDiff(b);
        const valA = diffA.isNew ? 99999999 : diffA.diff;
        const valB = diffB.isNew ? 99999999 : diffB.diff;
        return this.sortDirection === 'asc' ? valA - valB : valB - valA;
      }

      let valA = a[this.sortColumn];
      let valB = b[this.sortColumn];

      if (typeof valA === 'string') {
        return this.sortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      valA = parseFloat(valA) || 0;
      valB = parseFloat(valB) || 0;
      return this.sortDirection === 'asc' ? valA - valB : valB - valA;
    });

    return list;
  }

  /**
   * 渲染整個應用
   */
  render() {
    this.renderHeaderStats();
    this.renderWeekSelector();
    this.renderTable();
    this.renderVanguardTable();
    this.renderPenaltyTable();
    this.updatePenaltyMemberDatalist();
  }

  /**
   * 渲染頂部指標
   */
  renderHeaderStats() {
    const totalMembers = this.members.length;
    const avgScore = totalMembers > 0 ? (this.members.reduce((a, b) => a + (b.calc_avg || 0), 0) / totalMembers).toFixed(1) : 0;
    const totalPower = totalMembers > 0 ? Math.round(this.members.reduce((a, b) => a + (b.calc_total || 0), 0)) : 0;
    // 依使用者需求：本週戰力 MVP 顯示「總戰力第一名」
    const topMember = totalMembers > 0 ? [...this.members].sort((a,b) => (b.calc_total || 0) - (a.calc_total || 0))[0] : null;

    document.getElementById('stat-member-count').textContent = totalMembers;
    document.getElementById('stat-avg-score').textContent = avgScore;
    document.getElementById('stat-total-power').textContent = totalPower.toLocaleString();
    document.getElementById('stat-mvp').textContent = topMember ? topMember.name : '暫無';
  }

  /**
   * 渲染週次選單
   */
  renderWeekSelector() {
    const select = document.getElementById('week-select');
    if (!select) return;
    const weeks = Object.keys(this.weeksData).map(Number).sort((a, b) => a - b);
    select.innerHTML = weeks.map(w => `
      <option value="${w}" ${w === this.currentWeek ? 'selected' : ''}>第 ${w} 週</option>
    `).join('');
  }

  /**
   * 取得懲罰標籤之樣式 Class
   */
  getPenaltyBadgeClass(pen) {
    if (!pen) return '';
    if (pen.status === '已銷假/補救') {
      return 'bg-slate-800/80 text-slate-400 border border-slate-700 line-through opacity-75';
    }
    const act = (pen.action || '').replace(/\s+/g, '');
    if (act.includes('取消敢死隊')) {
      return 'bg-rose-950 text-rose-200 border border-rose-600 ring-1 ring-rose-500/50';
    }
    if (act.includes('警告2')) {
      return 'bg-amber-950 text-orange-200 border border-orange-600';
    }
    return 'bg-amber-950/90 text-amber-300 border border-amber-700';
  }

  /**
   * 渲染主表格內容
   */
  renderTable() {
    const list = this.getSortedAndFilteredMembers();
    const tbody = document.getElementById('guild-tbody');
    const emptyState = document.getElementById('table-empty-state');
    const tableContainer = document.getElementById('table-container');

    if (list.length === 0) {
      if (this.searchQuery) {
        tbody.innerHTML = `<tr><td colspan="12" class="text-center py-12 text-slate-400">找不到包含「${this.escapeHtml(this.searchQuery)}」的成員</td></tr>`;
        emptyState.classList.add('hidden');
        tableContainer.classList.remove('hidden');
      } else {
        tableContainer.classList.add('hidden');
        emptyState.classList.remove('hidden');
      }
      return;
    }

    tableContainer.classList.remove('hidden');
    emptyState.classList.add('hidden');

    tbody.innerHTML = list.map((m, idx) => {
      const pen = this.penalties.find(p => (p.name || '').trim().toLowerCase() === (m.name || '').trim().toLowerCase());
      const weekDiff = this.getMemberWeeklyPowerDiff(m);

      let diffHtml = '';
      if (weekDiff.isNew) {
        diffHtml = `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-extrabold bg-emerald-950/90 text-emerald-300 border border-emerald-700/80 shadow-sm font-mono tracking-wider">NEW</span>`;
      } else if (weekDiff.diff > 0) {
        diffHtml = `<span class="text-emerald-400 font-mono font-bold text-xs inline-flex items-center gap-0.5" title="相較上週提升 ${weekDiff.diff.toLocaleString()} 戰力">▲+${weekDiff.diff.toLocaleString()}</span>`;
      } else if (weekDiff.diff < 0) {
        diffHtml = `<span class="text-rose-400 font-mono font-bold text-xs inline-flex items-center gap-0.5" title="相較上週下降 ${Math.abs(weekDiff.diff).toLocaleString()} 戰力">▼${weekDiff.diff.toLocaleString()}</span>`;
      } else {
        diffHtml = `<span class="text-slate-500 font-mono text-xs" title="戰力與上週持平">-</span>`;
      }

      const safeId = encodeURIComponent(m.id || '');
      const safeName = encodeURIComponent(m.name || '');

      return `
      <tr class="hover:bg-slate-800/60 transition-colors border-b border-slate-800">
        <td class="text-center py-1.5">
          ${diffHtml}
        </td>
        <td class="text-left font-medium text-white py-1.5">
          <div class="flex items-center space-x-1.5">
            <span class="text-xs text-slate-500 font-mono w-5 inline-block shrink-0">${idx + 1}</span>
            <span class="cursor-pointer hover:text-cyan-400 font-bold truncate max-w-[110px] flex items-center gap-1 group" title="點擊開啟截圖核對與資料校正：${this.escapeHtml(m.name)}" onclick="app.openMemberVerifyModal(${idx})">
              <span>${this.escapeHtml(m.name)}</span>
              <span class="text-[10px] text-slate-500 group-hover:text-cyan-400">🔍</span>
            </span>
          </div>
        </td>
        <td>
          <input type="number" class="w-12 bg-transparent text-right font-mono text-cyan-300 hover:bg-slate-800/80 focus:bg-slate-900 focus:border-cyan-400 border border-transparent rounded px-1 py-0.5 focus:outline-none"
            value="${m.leadership}" onchange="app.updateMemberField('${m.id}', 'leadership', this.value)">
        </td>
        <td>
          <input type="number" class="w-16 bg-transparent text-right font-mono text-emerald-300 hover:bg-slate-800/80 focus:bg-slate-900 focus:border-cyan-400 border border-transparent rounded px-1 py-0.5 focus:outline-none"
            value="${m.hp}" onchange="app.updateMemberField('${m.id}', 'hp', this.value)">
        </td>
        <td>
          <input type="number" class="w-16 bg-transparent text-right font-mono text-rose-300 hover:bg-slate-800/80 focus:bg-slate-900 focus:border-cyan-400 border border-transparent rounded px-1 py-0.5 focus:outline-none"
            value="${m.atk}" onchange="app.updateMemberField('${m.id}', 'atk', this.value)">
        </td>
        <td>
          <input type="number" class="w-16 bg-transparent text-right font-mono text-amber-300 hover:bg-slate-800/80 focus:bg-slate-900 focus:border-cyan-400 border border-transparent rounded px-1 py-0.5 focus:outline-none"
            value="${m.def}" onchange="app.updateMemberField('${m.id}', 'def', this.value)">
        </td>
        <td>
          <input type="number" class="w-16 bg-transparent text-right font-mono text-purple-300 hover:bg-slate-800/80 focus:bg-slate-900 focus:border-cyan-400 border border-transparent rounded px-1 py-0.5 focus:outline-none"
            value="${m.pursuit}" onchange="app.updateMemberField('${m.id}', 'pursuit', this.value)">
        </td>
        <td class="font-mono text-indigo-300 font-semibold bg-indigo-950/20">${(m.calc_def || 0).toLocaleString()}</td>
        <td class="font-mono text-orange-300 font-semibold bg-orange-950/20">${(m.calc_atk || 0).toLocaleString()}</td>
        <td class="font-mono text-amber-200 font-medium">${(m.calc_pick || 0).toLocaleString()}</td>
        <td class="font-mono text-cyan-200 font-bold bg-cyan-950/20">${(m.calc_total || 0).toLocaleString()}</td>
        <td class="font-mono font-extrabold text-cyan-400 text-sm bg-cyan-900/30">${Number(m.calc_avg || 0).toFixed(1)}</td>
        <td class="text-center">
          ${pen ? `
            <button onclick="app.openPenaltyModalByIndex(${idx})" title="點擊修改處分：${this.escapeHtml(pen.action)} [${this.escapeHtml(pen.reason)}] - 狀態:${pen.status}" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold ${this.getPenaltyBadgeClass(pen)} hover:scale-105 transition shadow-sm cursor-pointer">
              <span>${pen.action === '取消敢死隊資格' ? '🚫' : '⚠️'}</span>
              <span class="truncate max-w-[70px]">${this.escapeHtml(pen.action)}</span>
            </button>
          ` : `
            <button onclick="app.openPenaltyModalByIndex(${idx})" title="在總表上直接登記處分與原因" class="text-slate-400 hover:text-rose-300 hover:bg-rose-950/40 border border-slate-700/80 px-2.5 py-0.5 rounded text-[11px] transition cursor-pointer font-medium hover:border-rose-600">
              + 登記
            </button>
          `}
        </td>
        <td class="text-center">
          <button onclick="app.deleteMember('${m.id}')" title="刪除成員" class="text-slate-500 hover:text-rose-400 p-0.5 transition-colors">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </td>
      </tr>
      `;
    }).join('');
  }

  /**
   * 依總表索引開啟成員懲罰彈窗 (絕對安全傳遞)
   */
  openPenaltyModalByIndex(idx) {
    const list = this.getSortedAndFilteredMembers();
    const m = list[idx];
    if (!m) return;
    this.openPenaltyModalForMember(m.id, m.name);
  }

  /**
   * 開啟成員截圖核對與資料校正彈窗
   */
  openMemberVerifyModal(idx) {
    const list = this.getSortedAndFilteredMembers();
    if (!list || list.length === 0) return;
    if (idx < 0) idx = 0;
    if (idx >= list.length) idx = list.length - 1;

    this.currentVerifyIndex = idx;
    const m = list[idx];
    this.currentVerifyMember = m;

    // 索引與成員數量顯示
    const curNumEl = document.getElementById('verify-cur-num');
    const totalNumEl = document.getElementById('verify-total-num');
    if (curNumEl) curNumEl.textContent = idx + 1;
    if (totalNumEl) totalNumEl.textContent = list.length;

    // 填入基礎表單數值
    const nameInput = document.getElementById('verify-input-name');
    const leadInput = document.getElementById('verify-input-leadership');
    const hpInput = document.getElementById('verify-input-hp');
    const atkInput = document.getElementById('verify-input-atk');
    const defInput = document.getElementById('verify-input-def');
    const pursuitInput = document.getElementById('verify-input-pursuit');

    if (nameInput) nameInput.value = m.name || '';
    if (leadInput) leadInput.value = m.leadership || 0;
    if (hpInput) hpInput.value = m.hp || 0;
    if (atkInput) atkInput.value = m.atk || 0;
    if (defInput) defInput.value = m.def || 0;
    if (pursuitInput) pursuitInput.value = m.pursuit || 0;

    // 填入截圖顯示
    const imgPreview = document.getElementById('verify-img-preview');
    const imgEmpty = document.getElementById('verify-img-empty');
    const filenameEl = document.getElementById('verify-img-filename');

    // 優先順序：m.imageUrl -> m.sourceImage -> pendingOcrResults 匹配
    let imgSrc = m.imageUrl || m.sourceImage || '';
    let fileName = m.fileName || '';

    if (!imgSrc && this.pendingOcrResults && this.pendingOcrResults.length > 0) {
      const matchPending = this.pendingOcrResults.find(p => (p.name || '').trim().toLowerCase() === (m.name || '').trim().toLowerCase());
      if (matchPending) {
        imgSrc = matchPending.imageUrl || matchPending.sourceImage || '';
        fileName = matchPending.fileName || '';
      }
    }

    if (imgSrc) {
      const safeSrc = (typeof imgSrc === 'string' && imgSrc.startsWith('/') && !imgSrc.startsWith('//') && !imgSrc.startsWith('data:')) ? imgSrc.slice(1) : imgSrc;
      if (imgPreview) {
        imgPreview.src = safeSrc;
        imgPreview.classList.remove('hidden');
      }
      if (imgEmpty) imgEmpty.classList.add('hidden');
      if (filenameEl) filenameEl.textContent = fileName || '已關聯截圖檔案';
    } else {
      if (imgPreview) {
        imgPreview.src = '';
        imgPreview.classList.add('hidden');
      }
      if (imgEmpty) imgEmpty.classList.remove('hidden');
      if (filenameEl) filenameEl.textContent = '尚未綁定截圖';
    }

    // 更新即時指標
    this.updateVerifyLiveMetrics();

    // 更新處分狀態
    const penaltyContainer = document.getElementById('verify-penalty-container');
    if (penaltyContainer) {
      const pen = this.penalties.find(p => (p.name || '').trim().toLowerCase() === (m.name || '').trim().toLowerCase());
      if (pen) {
        penaltyContainer.innerHTML = `
          <button type="button" onclick="app.openPenaltyModalForMember('${encodeURIComponent(m.id || '')}', '${encodeURIComponent(m.name || '')}')" class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold ${this.getPenaltyBadgeClass(pen)} hover:scale-105 transition shadow-sm cursor-pointer">
            <span>${pen.action === '取消敢死隊資格' ? '🚫' : '⚠️'}</span>
            <span>${this.escapeHtml(pen.action)} [${this.escapeHtml(pen.reason || '')}]</span>
          </button>
        `;
      } else {
        penaltyContainer.innerHTML = `
          <span class="text-slate-500 font-mono text-xs">尚無處分紀錄</span>
          <button type="button" onclick="app.openPenaltyModalForMember('${encodeURIComponent(m.id || '')}', '${encodeURIComponent(m.name || '')}')" class="text-slate-400 hover:text-rose-300 hover:bg-rose-950/40 border border-slate-700/80 px-2 py-0.5 rounded text-[11px] transition cursor-pointer font-medium ml-2">
            + 登記處分
          </button>
        `;
      }
    }

    const modal = document.getElementById('member-verify-modal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.style.display = 'flex';
    }
  }

  /**
   * 即時更新校對彈窗內的動態戰力衍生指標
   */
  updateVerifyLiveMetrics() {
    const lead = parseFloat(document.getElementById('verify-input-leadership')?.value) || 1;
    const hp = parseFloat(document.getElementById('verify-input-hp')?.value) || 0;
    const atk = parseFloat(document.getElementById('verify-input-atk')?.value) || 0;
    const def = parseFloat(document.getElementById('verify-input-def')?.value) || 0;
    const pursuit = parseFloat(document.getElementById('verify-input-pursuit')?.value) || 0;

    const calc = this.calculateMetrics({ leadership: lead, hp, atk, def, pursuit });

    const liveDef = document.getElementById('verify-live-def');
    const liveAtk = document.getElementById('verify-live-atk');
    const liveTotal = document.getElementById('verify-live-total');
    const liveAvg = document.getElementById('verify-live-avg');

    if (liveDef) liveDef.textContent = (calc.calc_def || 0).toLocaleString();
    if (liveAtk) liveAtk.textContent = (calc.calc_atk || 0).toLocaleString();
    if (liveTotal) liveTotal.textContent = (calc.calc_total || 0).toLocaleString();
    if (liveAvg) liveAvg.textContent = Number(calc.calc_avg || 0).toFixed(this.formulaConfig.roundAvgDecimals || 1);
  }

  /**
   * 儲存校正後的成員資料
   */
  saveVerifyMember(moveToNext = false) {
    if (!this.currentVerifyMember) return;
    const m = this.currentVerifyMember;

    const nameInput = document.getElementById('verify-input-name');
    const leadInput = document.getElementById('verify-input-leadership');
    const hpInput = document.getElementById('verify-input-hp');
    const atkInput = document.getElementById('verify-input-atk');
    const defInput = document.getElementById('verify-input-def');
    const pursuitInput = document.getElementById('verify-input-pursuit');

    const newName = nameInput ? nameInput.value.trim() : '';
    if (!newName) {
      alert('請填寫成員遊戲暱稱！');
      if (nameInput) nameInput.focus();
      return;
    }

    const oldName = m.name;
    const leadership = parseFloat(leadInput?.value) || 0;
    const hp = parseFloat(hpInput?.value) || 0;
    const atk = parseFloat(atkInput?.value) || 0;
    const def = parseFloat(defInput?.value) || 0;
    const pursuit = parseFloat(pursuitInput?.value) || 0;

    // 找到在 this.members 中的真實索引
    const idx = this.members.findIndex(mem => mem.id === m.id);
    if (idx !== -1) {
      const updated = this.calculateMetrics({
        ...this.members[idx],
        name: newName,
        leadership,
        hp,
        atk,
        def,
        pursuit
      });
      this.members[idx] = updated;
      this.currentVerifyMember = updated;
    }

    // 若改名且原先在懲罰名單中，同步更新受罰成員名稱
    if (oldName && newName !== oldName) {
      this.penalties.forEach(p => {
        if ((p.name || '').trim().toLowerCase() === oldName.trim().toLowerCase()) {
          p.name = newName;
        }
      });
    }

    this.saveToStorage();
    this.render();
    this.showToast(`已成功儲存【${newName}】之校對數據！`);

    if (moveToNext) {
      const list = this.getSortedAndFilteredMembers();
      const nextIdx = this.currentVerifyIndex + 1;
      if (nextIdx < list.length) {
        this.openMemberVerifyModal(nextIdx);
      } else {
        this.showToast('已完成全公會成員核對！');
        this.closeModal('member-verify-modal');
      }
    } else {
      this.openMemberVerifyModal(this.currentVerifyIndex);
    }
  }

  /**
   * 切換上一位成員
   */
  verifyPrevMember() {
    if (this.currentVerifyIndex > 0) {
      this.openMemberVerifyModal(this.currentVerifyIndex - 1);
    } else {
      this.showToast('已是名冊中的第一位成員！');
    }
  }

  /**
   * 切換下一位成員
   */
  verifyNextMember() {
    const list = this.getSortedAndFilteredMembers();
    if (this.currentVerifyIndex < list.length - 1) {
      this.openMemberVerifyModal(this.currentVerifyIndex + 1);
    } else {
      this.showToast('已是名冊中的最後一位成員！');
    }
  }

  /**
   * 放大檢視校對彈窗內的截圖
   */
  zoomVerifyImage() {
    if (!this.currentVerifyMember) return;
    const m = this.currentVerifyMember;
    let imgSrc = m.imageUrl || m.sourceImage;
    if (!imgSrc) {
      this.showToast('目前尚無關聯圖片可供放大');
      return;
    }
    const safeSrc = (typeof imgSrc === 'string' && imgSrc.startsWith('/') && !imgSrc.startsWith('//') && !imgSrc.startsWith('data:')) ? imgSrc.slice(1) : imgSrc;
    const modal = document.getElementById('ocr-lightbox-modal');
    const zoomImg = document.getElementById('ocr-lightbox-image');
    const titleEl = document.getElementById('ocr-lightbox-title');
    if (zoomImg) zoomImg.src = safeSrc;
    if (titleEl) {
      titleEl.textContent = `成員截圖高解析對照 - ${m.name || ''} ${m.fileName ? `(${m.fileName})` : ''}`;
    }
    if (modal) modal.classList.remove('hidden');
  }

  /**
   * 為當前成員手動上傳/更換截圖
   */
  async handleVerifyImageFile(files) {
    if (!files || files.length === 0 || !this.currentVerifyMember) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) {
      alert('請選取圖片檔案！');
      return;
    }

    try {
      this.showToast('正在上傳截圖檔案至伺服器...');
      const base64 = await this.readFileAsDataURL(file);
      
      // 傳送至後端儲存
      const resp = await fetch('/api/upload-member-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_base64: base64,
          fileName: file.name,
          memberId: this.currentVerifyMember.id
        })
      });

      let imageUrl = base64;
      let savedFileName = file.name;
      if (resp.ok) {
        const json = await resp.json();
        if (json.imageUrl) {
          imageUrl = json.imageUrl;
          savedFileName = json.fileName || file.name;
        }
      }

      // 更新成員資料
      this.currentVerifyMember.imageUrl = imageUrl;
      this.currentVerifyMember.sourceImage = base64;
      this.currentVerifyMember.fileName = savedFileName;

      const idx = this.members.findIndex(m => m.id === this.currentVerifyMember.id);
      if (idx !== -1) {
        this.members[idx].imageUrl = imageUrl;
        this.members[idx].sourceImage = base64;
        this.members[idx].fileName = savedFileName;
      }

      this.saveToStorage();
      this.openMemberVerifyModal(this.currentVerifyIndex);
      this.showToast('截圖已成功與該成員綁定！');

    } catch (err) {
      console.error('上傳截圖失敗:', err);
      alert('上傳截圖失敗: ' + err.message);
    }
  }

  promptEditName(id, currentName) {
    const newName = prompt('請輸入新的成員暱稱：', currentName);
    if (newName && newName.trim() && newName.trim() !== currentName) {
      this.updateMemberField(id, 'name', newName.trim());
    }
  }

  /**
   * 切換分頁（公會成員總表 / 敢死隊員名單 / 懲罰名單）
   */
  switchTab(tabName) {
    this.currentTab = tabName;
    const tabs = ['main', 'vanguard', 'penalty'];
    tabs.forEach(t => {
      const btn = document.getElementById(`tab-btn-${t}`);
      const view = document.getElementById(`view-${t}`);
      if (btn && view) {
        if (t === tabName) {
          view.classList.remove('hidden');
          if (t === 'main') {
            btn.className = 'tab-btn px-4 py-2 text-sm font-bold rounded-xl transition flex items-center gap-2 bg-cyan-950 text-cyan-300 border border-cyan-800 shadow-sm';
          } else if (t === 'vanguard') {
            btn.className = 'tab-btn px-4 py-2 text-sm font-bold rounded-xl transition flex items-center gap-2 bg-amber-950 text-amber-300 border border-amber-800 shadow-sm';
          } else if (t === 'penalty') {
            btn.className = 'tab-btn px-4 py-2 text-sm font-bold rounded-xl transition flex items-center gap-2 bg-rose-950 text-rose-300 border border-rose-800 shadow-sm';
          }
        } else {
          view.classList.add('hidden');
          btn.className = 'tab-btn px-4 py-2 text-sm font-bold rounded-xl transition flex items-center gap-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent';
        }
      }
    });

    if (tabName === 'vanguard') {
      this.renderVanguardTable();
    } else if (tabName === 'penalty') {
      this.renderPenaltyTable();
      this.updatePenaltyMemberDatalist();
      const pDate = document.getElementById('penalty-input-date');
      if (pDate && !pDate.value) {
        pDate.value = new Date().toISOString().split('T')[0];
      }
    }
  }

  /**
   * 切換敢死隊看盤模式 (grid: 3x10直排看盤, table: 完整數據表格)
   */
  setVanguardMode(mode) {
    this.vanguardMode = mode;
    const gridView = document.getElementById('vanguard-grid-view');
    const tableView = document.getElementById('vanguard-table-view');
    const btnGrid = document.getElementById('btn-vanguard-mode-grid');
    const btnTable = document.getElementById('btn-vanguard-mode-table');

    if (mode === 'grid') {
      if (gridView) gridView.classList.remove('hidden');
      if (tableView) tableView.classList.add('hidden');
      if (btnGrid) btnGrid.className = 'px-2.5 py-1 rounded-md font-bold bg-amber-950 text-amber-300 border border-amber-800/80 transition';
      if (btnTable) btnTable.className = 'px-2.5 py-1 rounded-md text-slate-400 hover:text-white transition';
    } else {
      if (gridView) gridView.classList.add('hidden');
      if (tableView) tableView.classList.remove('hidden');
      if (btnTable) btnTable.className = 'px-2.5 py-1 rounded-md font-bold bg-amber-950 text-amber-300 border border-amber-800/80 transition';
      if (btnGrid) btnGrid.className = 'px-2.5 py-1 rounded-md text-slate-400 hover:text-white transition';
    }
  }

  /**
   * 檢查成員是否因處分被取消敢死隊資格 (處分為「取消敢死隊資格」且狀態為「執行中」)
   */
  isDisqualifiedFromVanguard(m) {
    if (!m || !m.name) return false;
    const pen = this.penalties.find(p => (p.name || '').trim().toLowerCase() === m.name.trim().toLowerCase());
    if (!pen) return false;
    const isCancel = (pen.action || '').replace(/\s+/g, '').includes('取消敢死隊');
    const isActive = (pen.status || '').trim() === '執行中' || (pen.status || '').trim() === '已執行';
    return isCancel && isActive;
  }

  /**
   * 渲染敢死隊員名單
   * 左邊為敢死隊員 30 人（分為 3 個直排，每排 10 人）
   * 右邊為候補 5 人（1 個直排）
   * 處分為「取消敢死隊資格」且狀態為「執行中」之成員將被剔除，由後續成員自動往後替補
   */
  renderVanguardTable() {
    const weekNumEl = document.getElementById('vanguard-week-num');
    if (weekNumEl) weekNumEl.textContent = this.currentWeek;

    // 依「總戰力」由大到小降冪排序
    const sorted = [...this.members].sort((a, b) => (b.calc_total || 0) - (a.calc_total || 0));

    // 依公會長規定：取消敢死隊資格且執行中者不能擔任敢死隊員，由後續戰力成員自動往後遞補
    const disqualifiedMembers = sorted.filter(m => this.isDisqualifiedFromVanguard(m));
    const eligibleMembers = sorted.filter(m => !this.isDisqualifiedFromVanguard(m));

    const mainTeam = eligibleMembers.slice(0, 30);
    const subTeam = eligibleMembers.slice(30, 35);
    const top35 = eligibleMembers.slice(0, 35);

    const mainPower = Math.round(mainTeam.reduce((sum, m) => sum + (m.calc_total || 0), 0));
    const subPower = Math.round(subTeam.reduce((sum, m) => sum + (m.calc_total || 0), 0));
    const avgPower = top35.length > 0 ? (top35.reduce((sum, m) => sum + (m.calc_total || 0), 0) / top35.length).toFixed(1) : 0;

    const mainPowerEl = document.getElementById('vanguard-main-power');
    const mainCountEl = document.getElementById('vanguard-main-count');
    const subPowerEl = document.getElementById('vanguard-sub-power');
    const subCountEl = document.getElementById('vanguard-sub-count');
    const avgPowerEl = document.getElementById('vanguard-avg-power');
    const totalCountEl = document.getElementById('vanguard-total-count');

    if (mainPowerEl) mainPowerEl.textContent = mainPower.toLocaleString();
    if (mainCountEl) mainCountEl.textContent = `${mainTeam.length} / 30 人`;
    if (subPowerEl) subPowerEl.textContent = subPower.toLocaleString();
    if (subCountEl) subCountEl.textContent = `${subTeam.length} / 5 人`;
    if (avgPowerEl) avgPowerEl.textContent = Number(avgPower).toLocaleString();
    if (totalCountEl) totalCountEl.textContent = `共 ${top35.length} 人`;

    // 處分替補狀態通知條
    const disqContainer = document.getElementById('vanguard-disqualified-container');
    if (disqContainer) {
      if (disqualifiedMembers.length > 0) {
        disqContainer.classList.remove('hidden');
        disqContainer.innerHTML = `
          <div class="bg-rose-950/70 border border-rose-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 shadow-lg">
            <div class="flex items-center gap-2">
              <span class="p-1.5 rounded-lg bg-rose-900 text-rose-300 text-base">🚫</span>
              <div>
                <h4 class="text-xs font-bold text-rose-200">敢死隊處分替補生效中</h4>
                <p class="text-[11px] text-rose-300/80">以下 ${disqualifiedMembers.length} 位成員因「取消敢死隊資格 (執行中)」已被移出名單，正選與候補名額已由後續成員自動遞補：</p>
              </div>
            </div>
            <div class="flex flex-wrap gap-1.5">
              ${disqualifiedMembers.map(m => `
                <span class="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-rose-900/90 text-rose-100 border border-rose-600 font-mono">
                  <span class="line-through">${this.escapeHtml(m.name)}</span>
                  <span class="text-rose-300 font-bold">(${(m.calc_total || 0).toLocaleString()})</span>
                </span>
              `).join('')}
            </div>
          </div>
        `;
      } else {
        disqContainer.classList.add('hidden');
        disqContainer.innerHTML = '';
      }
    }

    // 輔助卡片渲染函式
    const renderCard = (m, rank) => {
      let medal = '';
      if (rank === 1) medal = '🥇 ';
      else if (rank === 2) medal = '🥈 ';
      else if (rank === 3) medal = '🥉 ';

      const isSub = rank > 30;
      const borderClass = isSub ? 'border-purple-900/50 hover:border-purple-500/70 bg-purple-950/20' : 'border-slate-800 hover:border-amber-500/70 bg-slate-900/80';
      const badgeClass = isSub ? 'bg-purple-950 text-purple-300 border-purple-800' : (rank <= 3 ? 'bg-amber-950 text-amber-300 border-amber-700 font-extrabold' : 'bg-slate-800 text-slate-300 border-slate-700');

      return `
        <div class="p-2 rounded-lg border ${borderClass} flex items-center justify-between transition shadow-sm hover:shadow-md">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="text-[10px] font-mono px-1.5 py-0.5 rounded border ${badgeClass}">#${rank}</span>
            <span class="font-bold text-white text-xs truncate max-w-[105px]" title="${this.escapeHtml(m.name)}">
              ${medal}${this.escapeHtml(m.name)}
            </span>
          </div>
          <div class="text-right ml-2 shrink-0">
            <div class="text-xs font-mono font-extrabold text-cyan-300">${(m.calc_total || 0).toLocaleString()}</div>
            <div class="text-[10px] font-mono text-cyan-400/80">均:${(m.calc_avg || 0).toFixed(1)}</div>
          </div>
        </div>
      `;
    };

    // 1. 渲染直排看盤 (使用遞補後的正選名單與候補名單)
    const col1El = document.getElementById('vanguard-col-1');
    const col2El = document.getElementById('vanguard-col-2');
    const col3El = document.getElementById('vanguard-col-3');
    const colSubEl = document.getElementById('vanguard-col-sub');

    const col1Members = mainTeam.slice(0, 10);
    const col2Members = mainTeam.slice(10, 20);
    const col3Members = mainTeam.slice(20, 30);
    const colSubMembers = subTeam.slice(0, 5);

    if (col1El) {
      col1El.innerHTML = col1Members.length > 0 
        ? col1Members.map((m, i) => renderCard(m, i + 1)).join('')
        : '<div class="py-8 text-center text-slate-500 text-xs font-medium">尚無名額</div>';
    }
    if (col2El) {
      col2El.innerHTML = col2Members.length > 0 
        ? col2Members.map((m, i) => renderCard(m, i + 11)).join('')
        : '<div class="py-8 text-center text-slate-500 text-xs font-medium">尚無名額</div>';
    }
    if (col3El) {
      col3El.innerHTML = col3Members.length > 0 
        ? col3Members.map((m, i) => renderCard(m, i + 21)).join('')
        : '<div class="py-8 text-center text-slate-500 text-xs font-medium">尚無名額</div>';
    }
    if (colSubEl) {
      colSubEl.innerHTML = colSubMembers.length > 0 
        ? colSubMembers.map((m, i) => renderCard(m, i + 31)).join('')
        : '<div class="py-8 text-center text-slate-500 text-xs font-medium">尚無候補隊員</div>';
    }

    // 2. 渲染右側本週違規懲罰名單專欄 (便於一頁式截圖)
    const colPenaltiesEl = document.getElementById('vanguard-col-penalties');
    const penaltyBadgeEl = document.getElementById('vanguard-penalty-badge');

    if (penaltyBadgeEl) {
      penaltyBadgeEl.textContent = `${this.penalties.length} 人受罰`;
    }

    if (colPenaltiesEl) {
      if (this.penalties.length === 0) {
        colPenaltiesEl.innerHTML = `
          <div class="py-4 text-center text-emerald-400/90 text-xs font-medium space-y-1">
            <span class="text-base">✅</span>
            <p class="font-bold">本週全員合格</p>
            <p class="text-[10px] text-slate-500">尚無任何違規或懲罰處分紀錄</p>
          </div>
        `;
      } else {
        colPenaltiesEl.innerHTML = this.penalties.map((p) => {
          const isCancel = (p.action || '').replace(/\s+/g, '').includes('取消敢死隊');
          const isWarn2 = (p.action || '').includes('2');
          const badgeClass = isCancel 
            ? 'bg-rose-950 text-rose-300 border-rose-800' 
            : (isWarn2 ? 'bg-amber-950 text-amber-300 border-amber-800' : 'bg-yellow-950/80 text-yellow-300 border-yellow-800/80');

          return `
            <div class="p-2 rounded-lg border border-slate-800 bg-slate-900/90 hover:border-rose-700/60 transition shadow-sm space-y-1">
              <div class="flex items-center justify-between gap-1.5">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="text-xs font-bold text-white truncate max-w-[100px]" title="${this.escapeHtml(p.name)}">
                    ${this.escapeHtml(p.name)}
                  </span>
                  <span class="text-[10px] px-1.5 py-0.5 rounded border font-semibold ${badgeClass} shrink-0">
                    ${this.escapeHtml(p.action)}
                  </span>
                </div>
                <span class="text-[10px] font-mono px-1.5 py-0.5 rounded ${p.status === '執行中' ? 'bg-rose-950/80 text-rose-300 border border-rose-800/50' : 'bg-slate-800 text-slate-400'} shrink-0">
                  ${this.escapeHtml(p.status || '執行中')}
                </span>
              </div>
              ${p.reason ? `
                <div class="flex flex-wrap gap-1 items-center pt-0.5">
                  ${p.reason.split('、').map(r => `
                    <span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                      ${this.escapeHtml(r.trim())}
                    </span>
                  `).join('')}
                  ${p.note ? `<span class="text-[9px] text-slate-400 italic truncate max-w-[120px]" title="${this.escapeHtml(p.note)}">(${this.escapeHtml(p.note)})</span>` : ''}
                </div>
              ` : ''}
            </div>
          `;
        }).join('');
      }
    }

    // 3. 渲染完整數據表格 (供切換檢視)
    const tbody = document.getElementById('vanguard-tbody');
    if (tbody) {
      if (top35.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" class="text-center py-12 text-slate-400">本週尚無合格成員資料，請先至「公會成員總表」上傳截圖或新增成員。</td></tr>`;
      } else {
        let html = top35.map((m, idx) => {
          const rank = idx + 1;
          const isMain = rank <= 30;
          const badge = isMain
            ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-950/80 text-amber-300 border border-amber-800">⚔️ 敢死隊員 #${rank}</span>`
            : `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-purple-950/80 text-purple-300 border border-purple-800">🛡️ 候補隊員 #${rank - 30}</span>`;

          let medal = '';
          if (rank === 1) medal = '<span class="text-base mr-1">🥇</span>';
          else if (rank === 2) medal = '<span class="text-base mr-1">🥈</span>';
          else if (rank === 3) medal = '<span class="text-base mr-1">🥉</span>';

          const rowBg = isMain ? 'hover:bg-amber-950/20' : 'hover:bg-purple-950/20 bg-purple-950/10';
          const pen = this.penalties.find(p => (p.name || '').trim().toLowerCase() === (m.name || '').trim().toLowerCase());
          const penBadge = pen 
            ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${this.getPenaltyBadgeClass(pen)}">${this.escapeHtml(pen.action)}</span>`
            : `<span class="text-slate-500 font-mono text-xs">-</span>`;

          return `
            <tr class="${rowBg} transition-colors border-b border-slate-800 text-xs">
              <td class="text-center font-mono font-bold text-slate-400 py-2.5">${rank}</td>
              <td class="text-center">${badge}</td>
              <td class="text-left font-medium text-white flex items-center py-2.5">
                ${medal}<span class="${rank <= 3 ? 'text-amber-300 font-bold' : ''}">${this.escapeHtml(m.name)}</span>
              </td>
              <td class="text-right font-mono font-extrabold text-cyan-300 text-sm bg-cyan-950/20">${(m.calc_total || 0).toLocaleString()}</td>
              <td class="text-right font-mono font-bold text-cyan-400 bg-cyan-900/30">${(m.calc_avg || 0).toFixed(1)}</td>
              <td class="text-right font-mono text-cyan-200">${(m.leadership || 0).toLocaleString()}</td>
              <td class="text-right font-mono text-emerald-300">${(m.hp || 0).toLocaleString()}</td>
              <td class="text-right font-mono text-rose-300">${(m.atk || 0).toLocaleString()}</td>
              <td class="text-right font-mono text-amber-300">${(m.def || 0).toLocaleString()}</td>
              <td class="text-right font-mono text-purple-300">${(m.pursuit || 0).toLocaleString()}</td>
              <td class="text-center">${penBadge}</td>
            </tr>
          `;
        }).join('');

        if (disqualifiedMembers.length > 0) {
          html += `
            <tr class="bg-rose-950/40 border-t-2 border-rose-800/80">
              <td colspan="11" class="text-left text-xs font-bold text-rose-300 py-2.5 px-3">
                🚫 以下成員因處分「取消敢死隊資格 (執行中)」移出名單，名額已由上方戰力成員自動遞補：
              </td>
            </tr>
          `;
          html += disqualifiedMembers.map(m => `
            <tr class="bg-rose-950/10 text-slate-400 border-b border-rose-950/40 opacity-75 text-xs">
              <td class="text-center font-mono text-rose-400 font-bold">-</td>
              <td class="text-center">
                <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-950 text-rose-300 border border-rose-800">
                  🚫 已取消資格
                </span>
              </td>
              <td class="text-left font-medium text-rose-300/90 line-through py-2.5">
                ${this.escapeHtml(m.name)}
              </td>
              <td class="text-right font-mono font-bold text-rose-300">${(m.calc_total || 0).toLocaleString()}</td>
              <td class="text-right font-mono text-slate-400">${(m.calc_avg || 0).toFixed(1)}</td>
              <td class="text-right font-mono text-slate-400">${(m.leadership || 0).toLocaleString()}</td>
              <td class="text-right font-mono text-slate-400">${(m.hp || 0).toLocaleString()}</td>
              <td class="text-right font-mono text-slate-400">${(m.atk || 0).toLocaleString()}</td>
              <td class="text-right font-mono text-slate-400">${(m.def || 0).toLocaleString()}</td>
              <td class="text-right font-mono text-slate-400">${(m.pursuit || 0).toLocaleString()}</td>
              <td class="text-center"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-950 text-rose-300 border border-rose-800">取消敢死隊資格</span></td>
            </tr>
          `).join('');
        }

        tbody.innerHTML = html;
      }
    }
  }

  /**
   * 一鍵複製敢死隊名單公告 (Line / Discord 格式)
   */
  copyVanguardReport() {
    if (this.members.length === 0) {
      alert('目前沒有成員資料可產生敢死隊名單');
      return;
    }
    const sorted = [...this.members].sort((a, b) => (b.calc_total || 0) - (a.calc_total || 0));
    const disqualified = sorted.filter(m => this.isDisqualifiedFromVanguard(m));
    const eligible = sorted.filter(m => !this.isDisqualifiedFromVanguard(m));

    const mainTeam = eligible.slice(0, 30);
    const subTeam = eligible.slice(30, 35);
    const mainPower = Math.round(mainTeam.reduce((sum, m) => sum + (m.calc_total || 0), 0));
    const subPower = Math.round(subTeam.reduce((sum, m) => sum + (m.calc_total || 0), 0));

    let text = `⚔️【蝸牛之家 第 ${this.currentWeek} 週 敢死隊選拔陣容】⚔️\n`;
    text += `📅 公告時間：${new Date().toLocaleDateString()}\n`;
    text += `📊 陣容指標：敢死隊 30 人 (戰力: ${mainPower.toLocaleString()}) | 候補 5 人 (戰力: ${subPower.toLocaleString()})\n`;
    if (disqualified.length > 0) {
      text += `🚫 處分替補：${disqualified.map(m => m.name).join('、')} (取消敢死隊資格執行中，名額已往後遞補)\n`;
    }
    text += `────────────────────\n`;
    text += `【⚔️ 敢死隊正選名單 (1～30名)】\n`;
    mainTeam.forEach((m, i) => {
      const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : `${i + 1}.`));
      text += `${medal} ${m.name} | 總戰力:${m.calc_total} | 均:${m.calc_avg} | 攻:${m.calc_atk} | 防:${m.calc_def}\n`;
    });

    if (subTeam.length > 0) {
      text += `────────────────────\n`;
      text += `【🛡️ 候補隊員名單 (31～35名)】\n`;
      subTeam.forEach((m, i) => {
        text += `${i + 31}. ${m.name} | 總戰力:${m.calc_total} | 均:${m.calc_avg} | 攻:${m.calc_atk} | 防:${m.calc_def}\n`;
      });
    }

    if (this.penalties.length > 0) {
      text += `────────────────────\n`;
      text += `【⚖️ 本週違規懲罰名單】\n`;
      this.penalties.forEach((p, idx) => {
        text += `${idx + 1}. ${p.name} ｜ 處分: ${p.action} ｜ 原因: ${p.reason || '無'} ｜ 狀態: ${p.status || '執行中'}\n`;
      });
    }

    text += `────────────────────\n`;
    text += `請全體敢死隊員務必於週戰開始前完成兵種配置與上陣，準時出席！🐌💥`;

    navigator.clipboard.writeText(text).then(() => {
      this.showToast('敢死隊名單公告已複製到剪貼簿！');
    }).catch(() => {
      prompt('請手動複製以下名單內容：', text);
    });
  }

  /**
   * 渲染手動懲罰名單表格
   */
  renderPenaltyTable() {
    const countEl = document.getElementById('penalty-total-count');
    const badgeEl = document.getElementById('tab-penalty-badge');
    const tbody = document.getElementById('penalty-tbody');

    if (countEl) countEl.textContent = this.penalties.length;
    if (badgeEl) badgeEl.textContent = this.penalties.length;

    if (!tbody) return;

    if (this.penalties.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center py-12 text-slate-400">目前尚無懲罰紀錄。請使用上方表單登記違規或未達標成員。</td></tr>`;
      return;
    }

    tbody.innerHTML = this.penalties.map((p, idx) => {
      let statusClass = 'bg-slate-800 text-slate-300 border-slate-700';
      if (p.status === '執行中' || p.status === '已執行') {
        statusClass = 'bg-rose-950 text-rose-300 border-rose-800 font-bold';
      } else if (p.status === '已銷假/補救') {
        statusClass = 'bg-emerald-950 text-emerald-300 border-emerald-800';
      }

      let actionClass = 'text-amber-300';
      let actionIcon = '⚠️';
      const act = (p.action || '').replace(/\s+/g, '');
      if (act.includes('取消敢死隊')) {
        actionClass = 'text-rose-400 font-bold';
        actionIcon = '🚫';
      } else if (act.includes('警告2')) {
        actionClass = 'text-orange-300 font-bold';
      }

      return `
        <tr class="hover:bg-slate-800/60 transition-colors border-b border-slate-800 text-xs">
          <td class="text-center font-mono text-slate-500 py-3">${idx + 1}</td>
          <td class="text-left font-bold text-white cursor-pointer hover:text-cyan-400" onclick="app.openEditPenaltyModalById('${p.id}')" title="點擊編輯此處分">
            ${this.escapeHtml(p.name)}
          </td>
          <td class="text-left text-rose-200 cursor-pointer" onclick="app.openEditPenaltyModalById('${p.id}')" title="點擊編輯此處分">
            <span class="bg-rose-950/40 border border-rose-900/50 rounded px-2 py-0.5 text-xs inline-block">
              ${this.escapeHtml(p.reason)}
            </span>
          </td>
          <td class="text-left ${actionClass} cursor-pointer" onclick="app.openEditPenaltyModalById('${p.id}')" title="點擊調整處分內容">
            <span class="inline-flex items-center gap-1">${actionIcon} ${this.escapeHtml(p.action)}</span>
          </td>
          <td class="text-center font-mono text-slate-400">${this.escapeHtml(p.date || '-')}</td>
          <td class="text-center">
            <button onclick="app.togglePenaltyStatus('${p.id}')" title="點擊快速切換狀態 (未執行 ⟳ 執行中 ⟳ 已銷假)" class="px-2.5 py-1 rounded-full text-[11px] font-bold border cursor-pointer transition hover:opacity-80 ${statusClass}">
              ${this.escapeHtml(p.status)} ⟳
            </button>
          </td>
          <td class="text-center">
            <div class="flex items-center justify-center gap-1.5">
              <button onclick="app.openEditPenaltyModalById('${p.id}')" title="調整處分內容與原因" class="text-cyan-400 hover:text-white p-1 rounded bg-slate-800 hover:bg-slate-700 transition">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
              </button>
              <button onclick="app.deletePenaltyRecord('${p.id}')" title="刪除此筆紀錄" class="text-slate-500 hover:text-rose-400 p-1 rounded hover:bg-slate-800 transition">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  /**
   * 手動新增懲罰紀錄
   */
  addPenaltyRecord() {
    const nameInput = document.getElementById('penalty-input-name');
    const reasonInput = document.getElementById('penalty-input-reason');
    const actionInput = document.getElementById('penalty-input-action');
    const dateInput = document.getElementById('penalty-input-date');
    const statusInput = document.getElementById('penalty-input-status');

    const name = nameInput ? nameInput.value.trim() : '';
    const reason = reasonInput ? reasonInput.value.trim() : '';
    const action = actionInput ? actionInput.value : '警告1次';
    const date = dateInput && dateInput.value ? dateInput.value : new Date().toISOString().split('T')[0];
    const status = statusInput ? statusInput.value : '未執行';

    if (!name) {
      alert('請填寫受罰成員暱稱！');
      if (nameInput) nameInput.focus();
      return;
    }
    if (!reason) {
      alert('請填寫或勾選懲罰原因！');
      if (reasonInput) reasonInput.focus();
      return;
    }

    const existingIdx = this.penalties.findIndex(p => (p.name || '').trim().toLowerCase() === name.toLowerCase());
    if (existingIdx >= 0) {
      this.penalties[existingIdx] = {
        ...this.penalties[existingIdx],
        action,
        status,
        reason,
        date
      };
      this.showToast(`已更新【${name}】的處分內容：${action} (${status})！`);
    } else {
      const record = {
        id: 'pen_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        name,
        reason,
        action,
        date,
        status
      };
      this.penalties.unshift(record);
      this.showToast(`已成功登記【${name}】之處分：${action}！`);
    }

    this.saveToStorage();
    this.render();

    // 清空輸入欄位並重設標籤樣式
    if (nameInput) nameInput.value = '';
    if (reasonInput) {
      reasonInput.value = '';
      this.syncTagButtonStyles('penalty-input-reason', 'penalty-form-tags');
    }
  }

  /**
   * 刪除懲罰紀錄
   */
  deletePenaltyRecord(id) {
    if (confirm('確定要刪除這筆懲罰紀錄嗎？')) {
      this.penalties = this.penalties.filter(p => p.id !== id);
      this.saveToStorage();
      this.render();
      this.showToast('已刪除懲罰紀錄');
    }
  }

  /**
   * 切換懲罰狀態 (未執行 ⟳ 執行中 ⟳ 已銷假/補救)
   */
  togglePenaltyStatus(id) {
    const rec = this.penalties.find(p => p.id === id);
    if (!rec) return;
    const cycle = {
      '未執行': '執行中',
      '執行中': '已銷假/補救',
      '已執行': '已銷假/補救',
      '已銷假/補救': '未執行'
    };
    rec.status = cycle[rec.status] || '未執行';
    this.saveToStorage();
    this.render();
    this.showToast(`【${rec.name}】處分狀態更新為：${rec.status}`);
  }

  /**
   * 標籤多選切換 (可同時選擇多個原因標籤)
   */
  togglePenaltyTag(inputId, containerId, tag) {
    const input = document.getElementById(inputId);
    if (!input) return;

    let currentText = input.value.trim();
    let currentTags = currentText 
      ? currentText.split(/[、，,]+/).map(t => t.trim()).filter(Boolean)
      : [];

    const idx = currentTags.indexOf(tag);
    if (idx >= 0) {
      currentTags.splice(idx, 1);
    } else {
      currentTags.push(tag);
    }

    input.value = currentTags.join('、');
    this.syncTagButtonStyles(inputId, containerId);
    input.focus();
  }

  /**
   * 同步標籤按鈕高亮狀態
   */
  syncTagButtonStyles(inputId, containerId) {
    const input = document.getElementById(inputId);
    const container = document.getElementById(containerId);
    if (!input || !container) return;

    const currentText = input.value.trim();
    const currentTags = currentText 
      ? currentText.split(/[、，,]+/).map(t => t.trim()).filter(Boolean)
      : [];

    const buttons = container.querySelectorAll('button[data-tag]');
    buttons.forEach(btn => {
      const tag = btn.getAttribute('data-tag');
      if (currentTags.includes(tag)) {
        btn.className = 'reason-tag px-2.5 py-0.5 rounded text-[11px] font-bold bg-rose-900/90 text-rose-200 border border-rose-500 shadow-sm transition ring-1 ring-rose-400/40';
      } else {
        btn.className = 'reason-tag px-2.5 py-0.5 rounded text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition';
      }
    });
  }

  /**
   * 快速填入懲罰原因標籤 (相容保留)
   */
  quickFillPenaltyReason(reason) {
    this.togglePenaltyTag('penalty-input-reason', 'penalty-form-tags', reason);
  }

  /**
   * 一鍵複製懲罰名單公告 (Line / Discord 格式)
   */
  copyPenaltyReport() {
    if (this.penalties.length === 0) {
      alert('目前沒有懲罰紀錄可產生公告');
      return;
    }
    let text = `⚖️【蝸牛之家 公會懲罰名單公告】⚖️\n`;
    text += `📅 公告時間：${new Date().toLocaleDateString()}\n`;
    text += `👥 懲罰登記人數：共 ${this.penalties.length} 人\n`;
    text += `────────────────────\n`;
    this.penalties.forEach((p, idx) => {
      text += `${idx + 1}. 【${p.name}】\n`;
      text += `   • 處分內容：${p.action}\n`;
      text += `   • 懲罰原因：${p.reason}\n`;
      text += `   • 登記日期：${p.date || '無'}\n`;
      text += `   • 執行狀態：${p.status}\n`;
    });
    text += `────────────────────\n`;
    text += `公會戰為全體團結賽事，請各位成員共同遵守紀律！如有特殊理由請主動向幹部銷假。🐌`;

    navigator.clipboard.writeText(text).then(() => {
      this.showToast('懲罰名單公告已複製到剪貼簿！');
    }).catch(() => {
      prompt('請手動複製以下懲罰內容：', text);
    });
  }

  /**
   * 更新懲罰名單成員自動完成選單
   */
  updatePenaltyMemberDatalist() {
    const datalist = document.getElementById('penalty-member-datalist');
    if (datalist) {
      const names = [...new Set(this.members.map(m => m.name).filter(Boolean))];
      datalist.innerHTML = names.map(n => `<option value="${this.escapeHtml(n)}">`).join('');
    }
  }

  /**
   * 依懲罰紀錄 ID 開啟編輯彈窗
   */
  openEditPenaltyModalById(penaltyId) {
    const pen = this.penalties.find(p => p.id === penaltyId);
    if (!pen) return;
    this.openPenaltyModalForMember(null, pen.name);
  }

  /**
   * 從總表直接開啟成員快速懲罰/處分設定彈窗 (或從懲罰清單點擊編輯)
   */
  openPenaltyModalForMember(targetId, targetName) {
    const id = targetId ? decodeURIComponent(targetId) : '';
    const name = targetName ? decodeURIComponent(targetName) : '';

    let member = null;
    if (id) {
      member = this.members.find(m => m.id === id);
    }
    if (!member && name) {
      member = this.members.find(m => (m.name || '').trim().toLowerCase() === name.trim().toLowerCase());
    }
    if (!member && id) {
      member = this.members.find(m => (m.name || '').trim().toLowerCase() === id.trim().toLowerCase());
    }
    const memberName = member ? member.name : (name || id);
    if (!memberName) {
      alert('請先選擇或輸入成員暱稱！');
      return;
    }

    const nameEl = document.getElementById('modal-penalty-name');
    const actionEl = document.getElementById('modal-penalty-action');
    const statusEl = document.getElementById('modal-penalty-status');
    const reasonEl = document.getElementById('modal-penalty-reason');
    const dateEl = document.getElementById('modal-penalty-date');
    const deleteBtn = document.getElementById('modal-penalty-delete-btn');

    if (nameEl) nameEl.value = memberName;

    // 檢查該成員是否已有登記處分
    const existing = this.penalties.find(p => (p.name || '').trim().toLowerCase() === memberName.trim().toLowerCase());
    if (existing) {
      const act = (existing.action || '').replace(/\s+/g, '');
      if (actionEl) {
        if (act.includes('取消敢死隊')) actionEl.value = '取消敢死隊資格';
        else if (act.includes('警告2')) actionEl.value = '警告2次';
        else actionEl.value = '警告1次';
      }

      const st = (existing.status || '').trim();
      if (statusEl) {
        if (st === '已銷假/補救') statusEl.value = '已銷假/補救';
        else if (st === '未執行') statusEl.value = '未執行';
        else statusEl.value = '執行中';
      }

      if (reasonEl) reasonEl.value = existing.reason || '';
      if (dateEl) dateEl.value = existing.date || new Date().toISOString().split('T')[0];
      if (deleteBtn) deleteBtn.classList.remove('hidden');
    } else {
      if (actionEl) actionEl.value = '警告1次';
      if (statusEl) statusEl.value = '執行中'; // 預設處分登記即刻生效執行中
      if (reasonEl) reasonEl.value = '';
      if (dateEl) dateEl.value = new Date().toISOString().split('T')[0];
      if (deleteBtn) deleteBtn.classList.add('hidden');
    }

    this.syncTagButtonStyles('modal-penalty-reason', 'modal-penalty-tags');

    const modal = document.getElementById('penalty-modal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.style.display = 'flex';
    }
  }

  /**
   * 彈窗快速填入懲罰原因標籤 (相容保留)
   */
  quickFillModalPenaltyReason(reason) {
    this.togglePenaltyTag('modal-penalty-reason', 'modal-penalty-tags', reason);
  }

  /**
   * 從彈窗儲存處分 (新增或更新，允許隨時調整處分內容，即時同步至懲罰名單)
   */
  savePenaltyFromModal() {
    const nameEl = document.getElementById('modal-penalty-name');
    const actionEl = document.getElementById('modal-penalty-action');
    const statusEl = document.getElementById('modal-penalty-status');
    const reasonEl = document.getElementById('modal-penalty-reason');
    const dateEl = document.getElementById('modal-penalty-date');

    const name = nameEl ? nameEl.value.trim() : '';
    const action = actionEl ? actionEl.value : '警告1次';
    const status = statusEl ? statusEl.value : '執行中';
    const reason = reasonEl ? reasonEl.value.trim() : '';
    const date = dateEl && dateEl.value ? dateEl.value : new Date().toISOString().split('T')[0];

    if (!name) {
      alert('無效的成員暱稱！');
      return;
    }

    const finalReason = reason || '未達公會戰標準';

    const existingIdx = this.penalties.findIndex(p => (p.name || '').trim().toLowerCase() === name.toLowerCase());
    if (existingIdx >= 0) {
      this.penalties[existingIdx] = {
        ...this.penalties[existingIdx],
        action,
        status,
        reason: finalReason,
        date
      };
      this.showToast(`已更新【${name}】的處分內容：${action} (${status})！`);
    } else {
      const record = {
        id: 'pen_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        name,
        reason: finalReason,
        action,
        date,
        status
      };
      this.penalties.unshift(record);
      this.showToast(`已成功為【${name}】登記處分：${action}！`);
    }

    this.saveToStorage();
    this.closeModal('penalty-modal');
    this.render();
  }

  /**
   * 從彈窗解除當前成員之處分
   */
  deletePenaltyForCurrentModal() {
    const nameEl = document.getElementById('modal-penalty-name');
    const name = nameEl ? nameEl.value.trim() : '';
    if (!name) return;

    if (confirm(`確定要解除【${name}】的處分紀錄嗎？`)) {
      this.penalties = this.penalties.filter(p => (p.name || '').trim().toLowerCase() !== name.toLowerCase());
      this.saveToStorage();
      this.closeModal('penalty-modal');
      this.render();
      this.showToast(`已解除【${name}】的處分！`);
    }
  }

  // 模態彈窗輔助函式
  openOcrModal() {
    const modal = document.getElementById('ocr-modal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.style.display = 'flex';
    }
  }

  openFormulaModal() {
    document.getElementById('input-formula-hp-div').value = this.formulaConfig.hpDivisor;
    document.getElementById('input-formula-atk-mult').value = this.formulaConfig.atkMultiplier;
    document.getElementById('input-formula-decimals').value = this.formulaConfig.roundAvgDecimals;
    const modal = document.getElementById('formula-modal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.style.display = 'flex';
    }
  }

  saveFormulaConfig() {
    this.formulaConfig.hpDivisor = parseFloat(document.getElementById('input-formula-hp-div').value) || 15;
    this.formulaConfig.atkMultiplier = parseFloat(document.getElementById('input-formula-atk-mult').value) || 1.5;
    this.formulaConfig.roundAvgDecimals = parseInt(document.getElementById('input-formula-decimals').value, 10) || 1;
    this.closeModal('formula-modal');
    this.recalculateAll();
    this.showToast('公式設定已更新並完成全表格重新計算！');
  }

  closeModal(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.add('hidden');
      el.style.display = 'none';
    }
  }

  showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.remove('opacity-0', 'translate-y-4');
    toast.classList.add('opacity-100', 'translate-y-0');
    setTimeout(() => {
      toast.classList.remove('opacity-100', 'translate-y-0');
      toast.classList.add('opacity-0', 'translate-y-4');
    }, 3000);
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

window.app = new GuildApp();
