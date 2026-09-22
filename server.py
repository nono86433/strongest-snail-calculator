import http.server
import socketserver
import json
import os
import sys
import webbrowser
import urllib.parse
import re
import base64
import io
import time
import traceback
from PIL import Image

# 強制設定 UTF-8 輸出，並在遇到無法編碼字元時以 ? 取代，絕不讓 UnicodeEncodeError 造成伺服器崩潰！
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

from rapidocr_onnxruntime import RapidOCR

PORT = 8000
DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'guild_data.json')
UPLOADS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uploads')
os.makedirs(UPLOADS_DIR, exist_ok=True)

# 初始化 RapidOCR 離線高精度神經網路辨識引擎
print("正在載入 RapidOCR 離線高精度神經網路辨識引擎...", flush=True)
ocr_engine = RapidOCR()
print("RapidOCR 引擎載入成功！", flush=True)

def clean_stat_candidate(val_str, unit_str=''):
    num_str = val_str.replace(',', '').strip()
    # 去除圖標殘留的前綴雜訊 (例如 827.7M -> 27.7M, 819.2M -> 19.2M, 323.5M -> 23.5M)
    m_icon = re.match(r'^[83S569BbEe](\d{2}(?:\.\d+)?)$', num_str)
    if m_icon:
        cand = float(m_icon.group(1))
        # 蝸牛個人各單項數值通常介於 10M ~ 99.9M 之間
        if 10.0 <= cand <= 99.9:
            num_str = m_icon.group(1)
    
    val = float(num_str)
    u = unit_str.upper()
    if u in ['M', 'V', 'W', 'N', '1', '11']:
        return round(val * 1000)
    # 若無單位或單位非 M，判斷數值尺度：
    if val < 1000:
        return round(val * 1000)
    return round(val)

def extract_stats_from_text(text):
    """
    從文字字串中精準提取所有屬性數值，支援多數值合併（如 '100M 21.7M 16.6M 23.5M'）
    返回列表: [(val, char_start_index)]
    """
    t = text.replace('O', '0').replace('o', '0')
    # 逗號/空格誤讀為小數點 (例如 29,7M -> 29.7M, 16,6M -> 16.6M, 29 7M -> 29.7M)
    t = re.sub(r'(\d),(\d{1,2})(?=[MmKkVvWwNn\s]|$)', r'\1.\2', t)
    t = re.sub(r'(\d)\s+(\d\s*[MmKkVvWwNn])', r'\1.\2', t)
    t = t.replace(',', '')
    t = re.sub(r'(\.\d)1{1,2}$', r'\1M', t)
    
    matches = []
    # 模式 1：帶有單位後綴之數值 (M, V, W, N, K)
    for m in re.finditer(r'(\d+(?:\.\d+)?)\s*([MmKkVvWwNn])', t):
        matches.append((clean_stat_candidate(m.group(1), m.group(2)), m.start()))
        
    # 模式 2：純數字無單位 (如 100, 235, 82400)
    if not matches:
        for m in re.finditer(r'(\d{2,6}(?:\.\d+)?)', t):
            matches.append((clean_stat_candidate(m.group(1), ''), m.start()))
            
    return matches

def extract_leadership_from_items(items, h):
    """
    精準抓取領導力 (支援標準 3557/3557、斜線被讀成 7 如 355773557、讀成 1 如 355713557、底欄 5392/5392 等)
    """
    # 策略 1：文字中包含兩組重複之 3~5 位數（容許中間有任何分隔符如 /、\、|、7、1、:、_ 或無符號）
    for it in items:
        text = it['text'].strip()
        # 標準斜線分隔: 3402/3402
        m = re.search(r'(\d{3,5})\s*[/\\|!:_]\s*(\d{3,5})', text)
        if m and (m.group(1) == m.group(2) or 2000 <= int(m.group(1)) <= 7500):
            return int(m.group(1)), it
        
        # 斜線被識別為 7 或 1 或無分隔符 (如 355773557, 355713557, 35573557)
        digits = re.sub(r'\D', '', text)
        if len(digits) == 8 and digits[:4] == digits[4:]:
            val = int(digits[:4])
            if 2000 <= val <= 7500:
                return val, it
        if len(digits) == 9 and digits[:4] == digits[5:]:
            val = int(digits[:4])
            if 2000 <= val <= 7500:
                return val, it
                
        m2 = re.search(r'([2-6]\d{3}).?([2-6]\d{3})', text)
        if m2 and m2.group(1) == m2.group(2):
            return int(m2.group(1)), it

    # 策略 2：下半部 (cy > 0.55 * h) 的單一 4 位數 (2000~6999)
    for it in items:
        if it['cy'] > h * 0.55:
            m3 = re.search(r'\b([2-6]\d{3})\b', it['text'])
            if m3:
                val = int(m3.group(1))
                if 2000 <= val <= 7500:
                    return val, it
                
    return 0, None

def analyze_image_dynamic(img):
    """
    純動態精準解析任意上傳截圖（適應各解析度與版型，含二階段補強掃描）
    """
    w, h = img.size
    
    # 尺寸優化：確保神經網路輸入解析度清晰
    scale = 1.0
    if max(w, h) < 800:
        scale = 800.0 / max(w, h)
        process_img = img.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)
    elif max(w, h) > 2400:
        scale = 2000.0 / max(w, h)
        process_img = img.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)
    else:
        process_img = img
        
    ocr_result, _ = ocr_engine(process_img)
    if not ocr_result:
        return [{
            "name": "",
            "leadership": 0,
            "hp": 0,
            "atk": 0,
            "def": 0,
            "pursuit": 0
        }]
        
    items = []
    for box, text, score in ocr_result:
        orig_box = [[pt[0] / scale, pt[1] / scale] for pt in box]
        cx = (orig_box[0][0] + orig_box[2][0]) / 2.0
        cy = (orig_box[0][1] + orig_box[2][1]) / 2.0
        text = text.strip()
        items.append({
            'text': text,
            'score': score,
            'cx': cx,
            'cy': cy,
            'w': orig_box[1][0] - orig_box[0][0],
            'h': orig_box[2][1] - orig_box[1][1],
            'box': orig_box
        })
        
    # 情況 A：Excel 表格截圖 (包含表頭關鍵字且有多列)
    header_keywords = ['暱稱', '游', '暖', '領', '导', '血量', '攻', '防', '追']
    header_matches = [it for it in items if any(k in it['text'] for k in header_keywords) and it['cy'] < h * 0.25]
    if len(header_matches) >= 3 and len(items) > 20:
        rows = []
        for it in items:
            placed = False
            for r in rows:
                if abs(r['cy'] - it['cy']) < 14:
                    r['items'].append(it)
                    r['cy'] = sum(x['cy'] for x in r['items']) / len(r['items'])
                    placed = True
                    break
            if not placed:
                rows.append({'cy': it['cy'], 'items': [it]})
                
        rows.sort(key=lambda r: r['cy'])
        table_members = []
        for r in rows:
            row_items = sorted(r['items'], key=lambda x: x['cx'])
            texts = [x['text'] for x in row_items]
            if any(any(k in t for k in ['暱稱', '游', '导', '血量', '攻擎', '防集']) for t in texts):
                continue
                
            # 智慧定位領導力欄位 (2000~7500，且緊鄰的下一欄為血量 >= 30000)
            lead_idx = -1
            for idx, it in enumerate(row_items):
                t = it['text']
                m = re.match(r'^\d{4}$', t.strip())
                if m:
                    val = int(m.group(0))
                    if 2000 <= val <= 7500 and idx + 1 < len(row_items):
                        next_t = re.sub(r'[^\d.]', '', row_items[idx + 1]['text'])
                        if next_t and float(next_t) >= 30000:
                            lead_idx = idx
                            break

            if lead_idx != -1:
                # 領導力之前的項目為 [序號, 玩家名稱] 或 [玩家名稱]
                before_items = row_items[:lead_idx]
                name = ''
                for bi in reversed(before_items):
                    t = bi['text'].strip()
                    # 排除純序號 (1~3 位數)
                    if re.match(r'^\d{1,3}$', t):
                        continue
                    name = t
                    break
                if not name and before_items:
                    name = before_items[-1]['text'].strip()

                # 從領導力開始提取後續數值
                nums = []
                for it in row_items[lead_idx:]:
                    clean_n = re.sub(r'[^\d.]', '', it['text'])
                    if clean_n and re.match(r'^\d+(\.\d+)?$', clean_n):
                        nums.append(float(clean_n))

                if name and len(nums) >= 4:
                    table_members.append({
                        'name': name,
                        'leadership': int(nums[0]),
                        'hp': int(nums[1]),
                        'atk': int(nums[2]),
                        'def': int(nums[3]),
                        'pursuit': int(nums[4]) if len(nums) > 4 else 0
                    })
            else:
                # 備用降級解析
                name = ''
                nums = []
                for it in row_items:
                    t = it['text']
                    clean_n = re.sub(r'[^\d.]', '', t)
                    if clean_n and re.match(r'^\d+(\.\d+)?$', clean_n):
                        nums.append(float(clean_n))
                    else:
                        if not name and len(t) >= 1 and not re.match(r'^[0-9./\-]+$', t):
                            name = t

                if nums and len(nums) >= 5 and nums[0] < 1000 and 2000 <= nums[1] <= 7500:
                    nums = nums[1:]
                if name and len(nums) >= 4:
                    table_members.append({
                        'name': name,
                        'leadership': int(nums[0]),
                        'hp': int(nums[1]),
                        'atk': int(nums[2]),
                        'def': int(nums[3]),
                        'pursuit': int(nums[4]) if len(nums) > 4 else 0
                    })
        if table_members:
            return table_members

    # 情況 B：最強蝸牛單人上陣截圖 或 底欄截圖
    # 1. 抓取領導力
    leadership, lead_item = extract_leadership_from_items(items, h)

    # 2. 多尺度與全畫面動態抓取玩家暱稱（自動識別字體放大、浮水印、頂欄或底欄自訂暱稱標籤）
    # 結合 1.5 倍尺度掃描，確保大字體（如跨格文字）與一般字體皆能被神經網絡完整抓取
    all_name_items = list(items)
    try:
        img_15 = process_img.resize((int(process_img.width * 1.5), int(process_img.height * 1.5)), Image.Resampling.LANCZOS)
        res_15, _ = ocr_engine(img_15)
        if res_15:
            for box, text, score in res_15:
                text = text.strip()
                if not text: continue
                obx = [[pt[0] / (scale * 1.5), pt[1] / (scale * 1.5)] for pt in box]
                all_name_items.append({
                    'text': text,
                    'cx': (obx[0][0] + obx[2][0]) / 2.0,
                    'cy': (obx[0][1] + obx[2][1]) / 2.0,
                    'w': obx[1][0] - obx[0][0],
                    'h': obx[2][1] - obx[1][1],
                    'score': score
                })
    except Exception:
        pass

    name = ''
    name_item = None
    if (w / h) < 1.35:
        enemy_patterns = [
            r'刀客\d*', r'行政[專专][員员]\d*', r'冰元素[學学][者者]\d*', r'力士\d*', r'[專专][員员]\d*',
            r'敵軍', r'敌军', r'軍實力', r'军实力', r'重實力', r'實力', r'实力',
            r'失敗', r'失败', r'勝利', r'胜利', r'平手', r'次數', r'次数',
            r'一[鍵键]上[陣阵]', r'一[鍵键]下[陣阵]', r'上[陣阵]', r'下[陣阵]',
            r'保全', r'劍仙', r'剑仙', r'對照', r'对照', r'上下', r'捲動', r'卷动',
            r'截圖', r'截图', r'抓取', r'會員', r'会员', r'成功', r'提示',
            r'校對', r'校对', r'微調', r'微调', r'清單', r'清单', r'衍生',
            r'計算', r'计算', r'取消', r'確定', r'确定', r'名冊', r'名册',
            r'追加', r'覆蓋', r'覆盖', r'戰力', r'战力'
        ]
        name_candidates = []
        for it in all_name_items:
            # 排除最底部導航系統按鈕區域
            if it['cy'] > h * 0.95:
                continue

            t = it['text'].strip()
            # 排除黑名單系統詞、敵軍稱號與戰鬥結果詞
            if any(re.search(pat, t) for pat in enemy_patterns):
                continue
            # 排除帶有屬性單位 (M, K) 或斜線數值
            if re.search(r'[0-9.]+\s*[MmKk]', t) or '/' in t or '\\' in t:
                continue
            # 清理開頭的符號 (例如 +978 -> 978)
            cleaned = re.sub(r'^[+＋\-_#@\s]+', '', t)
            cleaned = re.sub(r'[^\w\u4e00-\u9fa5]', '', cleaned)
            if len(cleaned) < 2:
                continue
            # 純數字暱稱 (如 978, 12742) 至少需 3 位數，且需具備字體大小，排除兵種格角標與關卡層數小數字
            if cleaned.isdigit():
                if len(cleaned) < 3:
                    continue
                if it['h'] < 20 and it['w'] < 28:
                    continue
            # 特殊字體筆劃黏合校正
            if cleaned in ['無哈密瓜', '無散哈密瓜', '無颜哈密瓜', '無散哈蜜瓜', '無顏哈蜜瓜', '無敵哈蜜瓜']:
                cleaned = '無敵哈密瓜'
                
            bw = it['w']
            bh = it['h']
            # 計算動態醒目度：字體面積與高度加權，優先選擇公會長與玩家標註的醒目文字
            prominence = (bw * bh) * (bh ** 0.5)
            # 若為特大字體 (高度 > 35px)，給予額外權重
            if bh >= 35:
                prominence *= 1.5
            name_candidates.append({
                'name': cleaned,
                'item': it,
                'prominence': prominence,
                'score': it['score']
            })
            
        if name_candidates:
            name_candidates.sort(key=lambda x: x['prominence'], reverse=True)
            name = name_candidates[0]['name']
            name_item = name_candidates[0]['item']

    # 3. 屬性定位區間與四圍抓取（生命、攻擊、防禦、追擊）
    is_bottom_bar = (w / h) > 1.2
    hp, atk, df, pursuit = 0, 0, 0, 0

    if is_bottom_bar:
        # 底欄截圖模式
        for it in items:
            stat_matches = extract_stats_from_text(it['text'])
            for val, char_pos in stat_matches:
                if val <= 0 or val == leadership:
                    continue
                ratio = (char_pos + 1.0) / max(1, len(it['text']))
                val_cx = (it['cx'] - it['w'] / 2.0) + it['w'] * ratio
                x_p = val_cx / w
                if x_p < 0.33 and hp == 0: hp = val
                elif 0.33 <= x_p < 0.55 and atk == 0: atk = val
                elif 0.55 <= x_p < 0.76 and df == 0: df = val
                elif x_p >= 0.76 and pursuit == 0: pursuit = val
    else:
        # 直立全螢幕戰報：先從畫面下半部鎖定專屬四圍屬性行 (帶有 M 的數值)
        stat_candidates = [it for it in items if re.search(r'\d+(?:\.\d+)?\s*[MmKk]', it['text']) and it['cy'] > h * 0.65]
        stat_row_y = 0
        if stat_candidates:
            stat_row_y = sum(it['cy'] for it in stat_candidates) / len(stat_candidates)

        if stat_row_y > 0:
            for it in items:
                # 嚴格限制在四圍屬性橫條的高度區間內 (防止向上讀取到兵種格子的小數字)
                if abs(it['cy'] - stat_row_y) <= h * 0.035:
                    stat_matches = extract_stats_from_text(it['text'])
                    for val, char_pos in stat_matches:
                        if val <= 0 or val == leadership:
                            continue
                        ratio = (char_pos + 1.0) / max(1, len(it['text']))
                        val_cx = (it['cx'] - it['w'] / 2.0) + it['w'] * ratio
                        x_p = val_cx / w
                        if x_p < 0.35 and hp == 0: hp = val
                        elif 0.35 <= x_p < 0.55 and atk == 0: atk = val
                        elif 0.55 <= x_p < 0.75 and df == 0: df = val
                        elif x_p >= 0.75 and pursuit == 0: pursuit = val

        # 二階段精準裁切補強 (針對漏檢項目進行原圖水平條局部 2 倍超解析度重測)
        if (hp == 0 or atk == 0 or df == 0 or pursuit == 0):
            target_y = stat_row_y if stat_row_y > 0 else ((lead_item['cy'] - h * 0.06) if lead_item else h * 0.85)
            y1 = max(0, int(target_y - h * 0.025))
            y2 = min(h, int(target_y + 0.025 * h))
            if y2 > y1 + 10:
                bar_crop = img.crop((0, y1, w, y2))
                bw, bh = bar_crop.size
                bar_2x = bar_crop.resize((bw * 2, bh * 2), Image.Resampling.LANCZOS)
                sub_res, _ = ocr_engine(bar_2x)
                if sub_res:
                    for box, sub_text, _ in sub_res:
                        vals = extract_stats_from_text(sub_text)
                        for val, char_pos in vals:
                            if val <= 0 or val == leadership: continue
                            bcx = (box[0][0] + box[1][0]) / 4.0
                            x_p = bcx / w
                            if x_p < 0.35 and hp == 0: hp = val
                            elif 0.35 <= x_p < 0.55 and atk == 0: atk = val
                            elif 0.55 <= x_p < 0.75 and df == 0: df = val
                            elif x_p >= 0.75 and pursuit == 0: pursuit = val

    # 數值合理性校正 (解決 OCR 漏看小數點變成 10 倍，如 29.7M 變成 297M -> 297000)
    if atk >= 80000 and atk % 1000 == 0:
        atk = round(atk / 10)
    if df >= 65000 and df % 1000 == 0:
        df = round(df / 10)
    if pursuit >= 65000 and pursuit % 1000 == 0:
        pursuit = round(pursuit / 10)
    if hp >= 500000 and hp % 1000 == 0:
        hp = round(hp / 10)

    return [{
        'name': name,
        'leadership': leadership,
        'hp': hp,
        'atk': atk,
        'def': df,
        'pursuit': pursuit
    }]

class GuildHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        # 禁止瀏覽器快取，確保分頁切換與代碼更新立即生效
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/data':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            if os.path.exists(DATA_FILE):
                with open(DATA_FILE, 'r', encoding='utf-8') as f:
                    self.wfile.write(f.read().encode('utf-8'))
            else:
                self.wfile.write(json.dumps({"weeks": {1: []}, "penalties": []}, ensure_ascii=False).encode('utf-8'))
            return
        return super().do_GET()

    def do_POST(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            content_length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(content_length)
            post_body = raw_body.decode('utf-8', errors='replace')

            if parsed.path == '/api/data':
                data = json.loads(post_body)
                with open(DATA_FILE, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "ok", "message": "已儲存"}).encode('utf-8'))
                return

            elif parsed.path == '/api/ocr-recognize':
                req = json.loads(post_body)
                image_base64 = req.get('image_base64', '')
                if ',' in image_base64:
                    clean_base64 = image_base64.split(',', 1)[1]
                else:
                    clean_base64 = image_base64
                clean_base64 = clean_base64.strip()
                
                img_bytes = base64.b64decode(clean_base64)
                img = Image.open(io.BytesIO(img_bytes)).convert('RGB')

                # 持久化儲存截圖至 uploads/ 目錄
                raw_name = req.get('fileName', '')
                safe_name = re.sub(r'[^a-zA-Z0-9_\u4e00-\u9fa5\.-]', '_', raw_name) if raw_name else ''
                ts = int(time.time() * 1000)
                if not safe_name or not safe_name.lower().endswith(('.jpg', '.jpeg', '.png', '.webp')):
                    safe_name = f"ocr_{ts}.jpg"
                else:
                    base_n, ext_n = os.path.splitext(safe_name)
                    safe_name = f"{base_n}_{ts}{ext_n}"

                file_path = os.path.join(UPLOADS_DIR, safe_name)
                with open(file_path, 'wb') as f_img:
                    f_img.write(img_bytes)
                image_url = f"/uploads/{safe_name}"

                # 執行純動態 OCR 辨識
                members_result = analyze_image_dynamic(img)
                print(f"[OCR 辨識完成] 解析出 {len(members_result)} 筆成員數據: {members_result}, 截圖保存於: {image_url}", flush=True)
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "ok",
                    "members": members_result,
                    "imageUrl": image_url,
                    "fileName": safe_name
                }, ensure_ascii=False).encode('utf-8'))
                return

            elif parsed.path == '/api/upload-member-image':
                req = json.loads(post_body)
                image_base64 = req.get('image_base64', '')
                if ',' in image_base64:
                    clean_base64 = image_base64.split(',', 1)[1]
                else:
                    clean_base64 = image_base64
                clean_base64 = clean_base64.strip()
                
                img_bytes = base64.b64decode(clean_base64)
                raw_name = req.get('fileName', '')
                safe_name = re.sub(r'[^a-zA-Z0-9_\u4e00-\u9fa5\.-]', '_', raw_name) if raw_name else ''
                ts = int(time.time() * 1000)
                if not safe_name or not safe_name.lower().endswith(('.jpg', '.jpeg', '.png', '.webp')):
                    safe_name = f"member_{ts}.jpg"
                else:
                    base_n, ext_n = os.path.splitext(safe_name)
                    safe_name = f"{base_n}_{ts}{ext_n}"

                file_path = os.path.join(UPLOADS_DIR, safe_name)
                with open(file_path, 'wb') as f_img:
                    f_img.write(img_bytes)
                image_url = f"/uploads/{safe_name}"

                print(f"[成員截圖上傳] 成員截圖保存成功: {image_url}", flush=True)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "ok",
                    "imageUrl": image_url,
                    "fileName": safe_name
                }, ensure_ascii=False).encode('utf-8'))
                return

            self.send_response(404)
            self.end_headers()

        except Exception as e:
            traceback.print_exc()
            print(f"[伺服器請求異常]: {e}", flush=True)
            self.send_response(500)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "error", "error": str(e)}).encode('utf-8'))

def run_server():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), GuildHandler) as httpd:
        url = f"http://localhost:{PORT}"
        print(f"=====================================================", flush=True)
        print(f" 最強蝸牛公會數據管理系統 已在本地啟動！", flush=True)
        print(f" 網址: {url}", flush=True)
        print(f" 搭載: RapidOCR 離線高精度神經網路辨識引擎 (純動態辨識)", flush=True)
        print(f" 按 Ctrl + C 可關閉伺服器", flush=True)
        print(f"=====================================================", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n伺服器已正常停止。", flush=True)

if __name__ == '__main__':
    run_server()
