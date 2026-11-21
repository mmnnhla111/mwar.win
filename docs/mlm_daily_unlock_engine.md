# Master Specification: Daily Quests & MLM Proof-of-Activity Engine

## 1. Executive Summary & Core Rules
ระบบนี้ถูกออกแบบมาเพื่อแก้ไขปัญหา **"Passive MLM Parasite"** (แม่ทีมที่มีลูกข่ายเยอะ แต่ไม่เคยเข้ามาใช้งานหรือดูโฆษณาในแอปพลิเคชัน) 

### กฎการจ่ายเงิน MLM รายวัน (Daily MLM Proof-of-Activity Rule)
1. **Daily Quests (4-6 เควสต่อวัน):** ผู้ใช้ทุกคนต้องทำเควสรายวันอย่างน้อยตามเกณฑ์ที่กำหนด (เช่น 4 จาก 5 เควส หรือ ครบ 100%) เพื่อปลดล็อกสิทธิ์รับรายได้จากลูกข่าย 5 ชั้นประจำวันนั้นๆ
2. **Real-time Visual Status (Grey vs. Green):**
   - **สีเทา (Grey / Pending Status):** ยอดเงินคอมมิชชั่น MLM ที่ลูกข่ายสร้างขึ้นในวันนั้น ($T$) จะแสดงเป็น **สีเทา** พร้อมแจ้งว่า "ต้องทำเควสเพิ่มอีก X ข้อเพื่อปลดล็อก"
   - **สีเขียว (Green / Unlocked Status):** เมื่อผู้ใช้ทำเควสครบตามกำหนด ยอดเงินสีเทาจะเปลี่ยนเป็น **สีเขียว** ทันที พร้อมสำหรับการตัดยอดเข้า Wallet
3. **Daily Midnight Settlement (ตัดยอดวันละ 1 ครั้ง):**
   - เวลา 00:00 UTC (หรือ 07:00 น. ไทย): ระบบ Cron Job จะทำการประมวลผลยอดเงินประจำวัน
   - **ถ้าทำเควสสำเร็จ:** ยอดสีเขียวจะถูกโอนเข้าสู่ Balance หลัก (`users.balance_micro_usd`)
   - **ถ้าทำเควสไม่สำเร็จ:** ยอดสีเทาทั้งหมดของวันนั้นจะถูก **Forfeited (ยึดเข้าสมาคม/รายได้ระบบ)** ทันที ลูกข่ายยังทำงานปกติ แต่นายหน้าไม่ได้เงินวันนั้น

---

## 2. Daily Quests Pool (รายการเควสประจำวัน)

ผู้ใช้ต้องผ่านอย่างน้อย **4 เควส** จากรายการต่อไปนี้ในแต่ละวัน (รีเซ็ตทุก 24 ชม.):

| Quest ID | ชื่อเควส | เงื่อนไขการผ่าน | ประเภท Action |
|---|---|---|---|
| `Q_SPECTATE` | ชมการแข่งขัน Live | ส่องดูผู้เล่นอื่นในเกมอย่างน้อย 1.5 นาที (90 วินาที) | `spectate_timer` |
| `Q_PLAY_MATCH` | เข้าร่วมสังเวียน | เล่นเกมต่อสู้ใน 3D Arena อย่างน้อย 1 รอบ | `finish_game_match` |
| `Q_WATCH_AD` | ดูโฆษณาประจําวัน | รับชม Rewarded Video Ads 2 โฆษณา | `watch_rewarded_ad` |
| `Q_DAILY_CHECKIN` | เช็กอินเข้าใช้งาน | กดปุ่มรับเช็กอินประจำวันในแอป | `daily_checkin` |
| `Q_COMMUNITY` | มีปฏิสัมพันธ์ชุมชน | ส่งข้อความแชตหาลูกข่าย หรือ เข้าดูแผนภูมิ Network Tree 1 ครั้ง | `view_network_tree` |

---

## 3. Database Schema Updates (Cloudflare D1 / SQLite)

### 3.1 ตารางกำหนดเควสรายวัน (`daily_quest_definitions`)
```sql
CREATE TABLE IF NOT EXISTS daily_quest_definitions (
    quest_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    target_count INTEGER NOT NULL DEFAULT 1,
    action_type TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 3.2 ตารางบันทึกความคืบหน้าเควสของผู้ใช้ (`user_daily_quests`)
```sql
CREATE TABLE IF NOT EXISTS user_daily_quests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    date_key TEXT NOT NULL, -- Format: YYYY-MM-DD
    quest_id TEXT NOT NULL,
    current_count INTEGER DEFAULT 0,
    is_completed BOOLEAN DEFAULT FALSE,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (quest_id) REFERENCES daily_quest_definitions(quest_id),
    UNIQUE(user_id, date_key, quest_id)
);
```

### 3.3 ตารางพักยอด MLM รายวัน (`daily_mlm_pending_ledger`)
```sql
CREATE TABLE IF NOT EXISTS daily_mlm_pending_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,          -- ผู้รับคอมมิชชั่น (Sponsor)
    date_key TEXT NOT NULL,         -- YYYY-MM-DD
    downline_user_id TEXT NOT NULL, -- ลูกข่ายที่สร้างรายได้
    depth_level INTEGER NOT NULL,   -- ชั้นที่ 1-5
    amount_micro_usd INTEGER NOT NULL, -- ยอดเงิน (Micro-USD)
    status TEXT CHECK(status IN ('pending_grey', 'unlocked_green', 'forfeited_burned', 'settled_paid')) DEFAULT 'pending_grey',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

---

## 4. API Endpoints Specification

### 4.1 `GET /api/quests/today`
- **Response:**
```json
{
  "dateKey": "2026-11-20",
  "totalQuests": 5,
  "completedQuests": 3,
  "requiredToUnlock": 4,
  "isMlmUnlocked": false,
  "quests": [
    {
      "questId": "Q_SPECTATE",
      "title": "ชมการแข่งขัน Live (1.5 นาที)",
      "target": 90,
      "current": 45,
      "isCompleted": false
    },
    {
      "questId": "Q_DAILY_CHECKIN",
      "title": "เช็กอินประจำวัน",
      "target": 1,
      "current": 1,
      "isCompleted": true
    }
  ]
}
```

### 4.2 `POST /api/quests/progress`
- **Request Body:** `{ "questId": "Q_SPECTATE", "increment": 15 }`
- **Logic:** อัปเดตความคืบหน้า ถ้า `completedQuests >= 4` ให้ทำการอัปเดตสถานะใน `daily_mlm_pending_ledger` ของวันนั้นจาก `pending_grey` $\rightarrow$ `unlocked_green` ทันที

### 4.3 `GET /api/wallet/daily-mlm-summary`
- **Response:**
```json
{
  "dateKey": "2026-11-20",
  "isUnlocked": false,
  "pendingGreyMicroUsd": 450000,   -- $0.45 USD (แสดงสีเทา)
  "unlockedGreenMicroUsd": 0,      -- แสดงสีเขียวเมื่อเควสครบ
  "forfeitedMicroUsd": 0,
  "message": "ทำเควสอีก 1 ข้อเพื่อปลดล็อกเงิน $0.45 USD เข้ากระเป๋าคืนนี้"
}
```

### 4.4 `POST /api/cron/settle-daily-mlm` (Daily Midnight Execution)
- **Logic:**
  1. ดึงรายการ `daily_mlm_pending_ledger` ทั้งหมดของ `date_key` เมื่อวาน
  2. ถ้าผู้ใช้ `isMlmUnlocked == true`:
     - โอนยอดเงินรวมเข้า `users.balance_micro_usd`
     - เปลี่ยนสถานะเป็น `settled_paid`
  3. ถ้าผู้ใช้ `isMlmUnlocked == false`:
     - เปลี่ยนสถานะเป็น `forfeited_burned`
     - ยิง Financial Audit Log ไปยัง `log-receiver` ระบุเหตุผล "MLM Commission Forfeited due to Inactivity"

---

## 5. UI/UX Implementation Plan (`apps/web`)

1. **Top Header / Lobby Progress Bar:**
   - แสดง Badges: `Daily Quests: 3/4 [Unlock MLM Status: 🔒 Grey]`
2. **Wallet & Dashboard UI:**
   - **Today's Downline Earnings Box:**
     - ยอดเงินแสดงด้วยตัวอักษรสีเทาเข้ม ($\text{Grey} = \$X.XX$) เมื่อยังทำเควสไม่ครบ พร้อมไอคอนแม่ล็อก
     - เมื่อปลดล็อกเรียบร้อย ตัวเลขจะเปลี่ยนเป็นแสงเรืองสีเขียวสด ($\text{Green} = \$X.XX$) พร้อมไอคอนติ๊กถูก
3. **Spectator Mode Timer Integration (`/game`):**
   - เมื่อส่องดูเพื่อนในโหมด Ghost Mode จะมี Overlay นับถอยหลัง `Spectate for Daily Quest: 90s` และส่ง Heartbeat ไปยัง `/api/quests/progress` ทุกๆ 15 วินาที