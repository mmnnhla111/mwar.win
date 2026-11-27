# พิมพ์เขียวระบบเกมยิงปืน 3D Real-Time & ระบบการเงิน MLM 5 ชั้น (Master System Specification)

---

## 1. บทสรุปผู้บริหารและหลักการประมวลผล (Executive Summary & Core Principles)

โครงการนี้คือระบบนิเวศเกมยิงปืน 3D แบบ Multi-player Real-Time ที่รวมเข้ากับระบบเศรษฐกิจและการสร้างรายได้แบบ MLM 5 ชั้น โดยออกแบบสถาปัตยกรรมเน้น **ความปลอดภัยสูงสุด**, **ความเสถียรของระบบการเงิน**, และ **ต้นทุนการดำเนินงานที่ต่ำที่สุด (Zero-Egress Cost & Serverless First)**

### 1.1 หลักการออกแบบสำคัญ (Core Architecture Principles)
1. **Zero Open Ports on Core DB:** ระบบฐานข้อมูลหลัก (`core_db`) และระบบแชต (`chat_YYYY_MM`) ทำงานอยู่บน **Cloudflare D1** แบบ Serverless 100% ไม่มีพอร์ตหรือ IP Public เปิดสู่โลกภายนอก ป้องกันการถูกสแกนเจาะระบบและยิง DDoS 100%
2. **Stateless Game Servers with Zero DB Overhead:** เครื่อง Game Server (Mini PC / VPS) มีหน้าที่ประมวลผลฟิสิกส์ การยิง และสถานะห้องสดใน **RAM (Colyseus) และ Local Redis** เท่านั้น **ห้ามลงฐานข้อมูล PostgreSQL บนเครื่องเกม** เพื่อรักษาความเร็วระดับมิลลิวินาที ($< 20\text{ ms}$) และทำให้การขยับขยาย Node เกมทำได้ง่ายเพียงแค่สั่งรัน Docker Container เพิ่ม
3. **Decoupled Financial Audit Log System:** ระบบบันทึก Log การเงิน (`logs_YYYY_MM`) แยกออกไปรันบน **Self-Hosted PostgreSQL** บนเครื่อง Mini PC / Ubuntu Server ผ่าน **Cloudflare Tunnel (`cloudflared`)** และมี **Cloudflare Queues** เป็นถังพักข้อมูลฉุกเฉิน หากไฟดับหรือเน็ตบ้านหลุด ข้อมูล Log จะไม่สูญหายแม้แต่บรรทัดเดียว
4. **Micro-USD Precise Accounting:** ข้อมูลตัวเลขเงินทั้งหมดในฐานข้อมูล SQLite/D1 และ PostgreSQL จะถูกบันทึกเป็น **จำนวนเต็ม (Integer)** ในหน่วย **Micro-USD** ($1\text{ USD} = 1,000,000\text{ Micro-USD}$) ป้องกันปัญหาคลาดเคลื่อนของจุดทศนิยม ($Floating\ Point\ Error$) ในการคำนวณส่วนแบ่ง $5\%$ และ $95\%$
5. **Zero-Deficit Ticket-Backed Economy (V1.1, 2026-11-27):** ระบบ **ไม่จ่ายเงินที่ไม่มีรายได้จริงรองรับแม้แต่ 1 Micro-USD** — ทุก Energy Ticket (EC) ถูกบันทึกเป็นแถวใน `user_energy_tickets` พร้อมมูลค่าที่รองรับจริง (`backed_micro_usd`) ซึ่งมาจากรายได้โฆษณาจริงหลังหัก **Safety Haircut 0.90–0.95 (ค่าเริ่มต้น 0.92, env `AD_SAFETY_MULTIPLIER`)** หรือดึงจาก Energy Pool ที่มีเงินอยู่จริง (ห้ามดึงเกินยอดคงเหลือ — เช็กใน SQL แบบ atomic) การฆ่าผู้เล่นได้มูลค่า **เท่ากับตั๋วของเหยื่อพอดี** (ไม่มีค่าหัวคงที่ $0.10 อีกต่อไป) แต่ละตั๋วถูกปิดบัญชี (settle) **ได้ครั้งเดียว** และผลรวมทุกการจ่าย ≤ มูลค่าที่รองรับเสมอ หน่วยแสดงผล **1 C = 100 Micro-USD** (ทศนิยม 2 ตำแหน่ง = 1 Micro-USD) ปัดเศษด้วยกฎ **0.007 C** (§7.1)

---

## 2. สถาปัตยกรรมระบบภาพรวม (System Architecture & Network Topology)

```
[ Web Client / Mobile Web / Unity Client ]
                    |
                    +--- (HTTPS / WSS) ---> [ Cloudflare Edge Network ]
                                                     |
            +----------------------------------------+----------------------------------------+
            |                                        |                                        |
    [ Cloudflare Pages ]                  [ Cloudflare Workers API ]                   [ Cloudflare R2 ]
 (React / Tailwind App)                   (Authentication & Logic)                 (Assets, Media, Replays)
                                                     |
            +----------------------------------------+----------------------------------------+
            |                                        |                                        |
   [ Cloudflare D1 ]                        [ Cloudflare Queues ]                   [ Cloudflare D1 ]
  (`core_db`: Users, Wallet,               (Async Financial Log Buffer)            (`chat_YYYY_MM`: 1-on-1 Chats)
   Network, Market, Cashout)                         |
                                                     v (Cloudflare Tunnel - Encrypted)
                                            [ Log Server: Mini PC ]
                                            - Fastify Log Receiver (Node.js)
                                            - Native PostgreSQL (`logs_YYYY_MM`)
                                            - Cron Job Archive to R2 (90 Days)

                    +----------------------------------------------------------------+
                    |                                                                |
                    v (Encrypted WebSockets / Internal API)                          v (Game Logic Sync)
 [ Game Server Node 1: Mini PC / PC ]                             [ Game Server Node 2: VPS / Cloud ]
 - Colyseus Room Engine (RAM Only)                                - Colyseus Room Engine (RAM Only)
 - Local Redis (Transient Room States)                            - Local Redis (Transient Room States)
```

---

## 3. สถาปัตยกรรมฐานข้อมูลและการจัดเก็บข้อมูล (Database & Storage Architecture)

| ชื่อชุดข้อมูล | เทคโนโลยีที่ใช้ | ที่ตั้ง / โครงสร้าง | หน้าที่และนโยบายการจัดเก็บ |
| :--- | :--- | :--- | :--- |
| **`core_db`** | **Cloudflare D1** (SQLite) | Cloudflare Edge (Global) | ข้อมูลบัญชีผู้ใช้, รหัสผ่าน (Argon2id), กระเป๋าเงิน, ผัง MLM 5 ชั้น, ตลาดซื้อขายลูกข่าย, และรายการคำขอถอนเงิน *(เก็บถาวร)* |
| **`chat_YYYY_MM`** | **Cloudflare D1** (SQLite) | Cloudflare Edge *(แยกก้อนตามเดือน)* | ประวัติการแชต 1 ต่อ 1 ระหว่างผู้เล่น *(ลบทิ้งอัตโนมัติเมื่อครบ 12 เดือน)* |
| **`logs_YYYY_MM`** | **Native PostgreSQL** | Self-Hosted Mini PC via Cloudflare Tunnel | Log รายละเอียดการเงิน, การยิงกัน, การเก็บหีบสมบัติ, การดูโฆษณา และการแบ่งเงิน 5 ชั้น *(ย้ายขึ้น R2 และลบทิ้งจาก DB เมื่อครบ 90 วัน)* |
| **`transient_game_state`** | **RAM + Local Redis** | เครื่อง Game Server (Mini PC / VPS) | พิกัดผู้เล่นสด, เลือด, สถานะแปลงร่างเป็นกล่องไม้, หีบสมบัติ 15 วินาที, AFK Timers *(ล้างข้อมูลเมื่อจบห้อง)* |
| **`static_and_archives`** | **Cloudflare R2** | Cloudflare Object Storage | ไฟล์โมเดล 3D (.glb), รูปภาพแชต, ไฟล์ Replay เกม (.json.gz), และ Log การเงินฉบับบีบอัดย้อนหลัง *(เก็บ 24 เดือน)* |

---

## 4. โครงสร้างตารางฐานข้อมูล (Database Schemas)

### 4.1 Cloudflare D1: `core_db`

```sql
-- 1. ตารางผู้ใช้งานหลัก (Users)
CREATE TABLE users (
    id TEXT PRIMARY KEY,                       -- UUID v4
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,               -- Argon2id
    referrer_id TEXT REFERENCES users(id),     -- สายงานตรง (Upline ชั้นที่ 1)
    role TEXT DEFAULT 'player',                 -- 'player', 'admin', 'auditor'
    status TEXT DEFAULT 'active',               -- 'active', 'suspended', 'banned'
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_users_referrer ON users(referrer_id);

-- 2. ตารางกระเป๋าเงินหลัก (Wallets) - หน่วย Micro-USD ($1 = 1,000,000)
CREATE TABLE wallets (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    balance_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (balance_micro_usd >= 0),
    total_earned_micro_usd INTEGER NOT NULL DEFAULT 0,
    total_withdrawn_micro_usd INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 3. ตารางผังสายงาน MLM 5 ชั้น (Network Hierarchy)
CREATE TABLE network_trees (
    ancestor_id TEXT NOT NULL REFERENCES users(id),   -- แม่ทีม (Upline)
    descendant_id TEXT NOT NULL REFERENCES users(id), -- ลูกทีม (Downline)
    depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 5), -- ระดับชั้น (1 - 5)
    PRIMARY KEY (ancestor_id, descendant_id)
);
CREATE INDEX idx_network_descendant ON network_trees(descendant_id);

-- 4. ตารางตลาดซื้อขายลูกข่าย (Referral Marketplace)
CREATE TABLE marketplace_listings (
    id TEXT PRIMARY KEY,
    seller_id TEXT NOT NULL REFERENCES users(id),
    target_user_id TEXT NOT NULL REFERENCES users(id), -- ลูกข่ายที่นำมาลงขาย
    price_micro_usd INTEGER NOT NULL CHECK (price_micro_usd > 0),
    status TEXT DEFAULT 'active',                      -- 'active', 'sold', 'cancelled'
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_market_status ON marketplace_listings(status);

-- 5. ตารางการถอนเงิน (Withdrawal Requests)
CREATE TABLE withdrawal_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    amount_micro_usd INTEGER NOT NULL CHECK (amount_micro_usd >= 10000000), -- ขั้นต่ำ $10
    fee_micro_usd INTEGER NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'ai_verifying', 'approved', 'rejected'
    ai_audit_score REAL,           -- คะแนนความถูกต้องจาก AI (0.00 - 1.00)
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    processed_at INTEGER
);
CREATE INDEX idx_withdrawal_status ON withdrawal_requests(status);

-- 6. (V1.1, migration 0021) Energy Ticket แบบมีมูลค่ารองรับ — 1 แถว = 1 EC
--    users.energy_tickets = จำนวนแถว status 'available' (ซิงก์ในทุก batch ที่แก้ตั๋ว)
CREATE TABLE user_energy_tickets (
    id TEXT PRIMARY KEY,                          -- 'tkt_<uuid>' (อยู่ใน entry token ที่เซ็น HMAC: tid / tv)
    user_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('ad_charge','cheer_pool','signup_promo','admin_grant')),
    country_code TEXT NOT NULL DEFAULT 'GLOBAL',  -- request.cf.country ตอนชาร์จ
    backed_micro_usd INTEGER NOT NULL CHECK (backed_micro_usd >= 0), -- มูลค่ารายได้จริงที่รองรับ (หลัง haircut)
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','in_match','settled')), -- CHECK นี้คือตัวกันจ่ายซ้ำ
    match_id TEXT,                                -- arena_entries.id ตอนล็อกเข้าห้อง
    created_at INTEGER NOT NULL,
    consumed_at INTEGER,                          -- เวลาล็อกเข้าห้อง (POST /api/game/enter)
    settled_at INTEGER,
    settle_action TEXT,                           -- GAME_KILL | CHEST_OPEN | TICKET_FORFEIT[:reason] | STALE_FORFEIT | ADMIN_REVOKE
    settled_to_user_id TEXT,                      -- ผู้ยิง / ผู้เปิดหีบ (NULL = เข้า Platform)
    settled_micro_usd INTEGER,                    -- มูลค่าที่จ่ายผ่านสูตร 55/15/5/5/20
    settle_ref TEXT                               -- game id
);
-- index: (user_id, status, created_at) ล็อกแบบ FIFO · (match_id) · (status, consumed_at) cron กวาดตั๋วค้าง

-- 7. (V1.1) EC progress ที่ยังไม่ครบ 1 ตั๋ว ถือมูลค่ารองรับค้างไว้ที่นี่ (ไม่สูญ ไม่เสก)
ALTER TABLE users ADD COLUMN pending_ec_micro_usd INTEGER NOT NULL DEFAULT 0;

-- 8. (V1.1) ใบรับ payout id ของ item ที่ไม่ผูกกับตั๋ว (BOUNTY_CLAIM, AFK_FORFEIT) — ส่งซ้ำ = duplicate
CREATE TABLE game_payout_receipts (
    payout_id TEXT PRIMARY KEY,                   -- metadata.pid ของแต่ละ item
    game_id TEXT,
    created_at INTEGER NOT NULL
);
```

* **Backfill (0021):** EC เดิมของผู้ใช้แต่ละคนแปลงเป็นแถวตั๋ว ถ้า Energy Pool คงเหลือ (`energy_pool_micro_usd − energy_pool_drawn_micro_usd`) พอสำหรับทุกตั๋ว จะให้มูลค่า 1,800 Micro-USD/ตั๋ว (วิดีโอ 30 วินาทีที่ถูกที่สุดในตาราง eCPM 2,000 × 0.90, source `admin_grant`) และบวกเข้า `energy_pool_drawn_micro_usd` มิฉะนั้นทุกตั๋วเป็น 0 (`signup_promo` — เล่นได้แต่ฆ่าแล้วไม่มีเงิน)
* **วงจรตั๋ว:** `available` → `/api/game/enter` ล็อกตั๋วเก่าสุด (FIFO) เป็น `in_match` และเซ็น `tid` + `tv` (backed) ลง entry token → `/api/game/batch-payout` ปิดเป็น `settled` ครั้งเดียว (guard `CASE … 'conflict'` ทำให้ทั้ง D1 batch rollback ถ้าตั๋วไม่ใช่ `in_match` ของเหยื่อคนนั้น)

### 4.1.1 ทีมงานหลายตำแหน่ง (Multi-Role Staff) — V1.1 รอบที่ 5 (migration `0022_multi_role_staff.sql`)
```sql
CREATE TABLE user_staff_roles (
    user_id TEXT NOT NULL,
    role_key TEXT NOT NULL,      -- moderator | support | finance_auditor | ops_manager | admin (legacy)
    granted_by TEXT NOT NULL,    -- user id ของ super_admin ที่ให้สิทธิ์ ('migration' = คัดลอกจากระบบเดิม)
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, role_key)
);
ALTER TABLE game_nodes ADD COLUMN mod_pending INTEGER;   -- คิวตรวจเนื้อหาที่โหนด moderator รายงาน
ALTER TABLE game_nodes ADD COLUMN mod_processed INTEGER;
ALTER TABLE game_nodes ADD COLUMN pg_status TEXT;        -- 'ok' | 'down' (โหนด log: PostgreSQL)
```
* **ตำแหน่งจริงอยู่ที่ `users.staff_role`** (ไม่ใช่ `users.role` ซึ่งเป็นค่า JWT เดิม): `users.staff_role` ยังเก็บ "ตำแหน่งสูงสุด" ไว้เพื่อแสดงผลและความเข้ากันได้ ส่วนสิทธิ์จริง = **union ของทุกแถวใน `user_staff_roles`** + `super_admin` (จาก `SUPER_ADMIN_USERNAMES` หรือ `users.staff_role = 'super_admin'`) ระบบอ่านจาก D1 ทุกคำขอ (`middleware/staff.ts` → `getStaffRoles`) การเปลี่ยนตำแหน่งมีผลทันที
* **ตำแหน่งที่มอบได้:** `moderator`, `support`, `finance_auditor`, `ops_manager` (ใหม่: เซิร์ฟเวอร์ ห้องเกม และเกม = สิทธิ์ `games` + `nodes`). ตำแหน่ง `admin` เดิมถูกคัดลอกเข้า `user_staff_roles` ตอน migrate เพื่อไม่ให้ใครเสียสิทธิ์ แต่มอบใหม่ไม่ได้ (บันทึกแถวที่ไม่ติ๊ก `admin` = ถอด `admin` ออก)
* **API (super_admin เท่านั้น):** `GET /api/admin/staff` (รายชื่อทีมงาน), `GET /api/admin/staff/search-users?q=` (ค้นหาสมาชิกด้วย username / ชื่อที่แสดง), `PUT /api/admin/staff/:userId/roles { roles: [...] }` (แทนที่ชุดตำแหน่งทั้งหมด; `[]` = ถอดทุกตำแหน่ง ลบแถวใน `user_staff_roles` และตั้ง `users.staff_role='user'`, `users.role='player'`), `GET /api/admin/staff/audit`. `PATCH /api/admin/staff` เดิมยังอยู่เพื่อ client เก่า (= `roles:[role]`)
* **`super_admin` ห้ามให้ / แก้ / ถอดผ่าน API ทุกกรณี** (ตอบ `403 SUPER_ADMIN_PROTECTED`) ทั้งการส่ง `super_admin` ใน `roles` และการแก้ไขบัญชีที่เป็น super_admin อยู่แล้ว
* **Audit:** ทุกการเปลี่ยนบันทึกลง `staff_audit_log` ด้วย action `staff_roles` (`old_value`/`new_value` = รายการตำแหน่งคั่นด้วย `,` หรือ `user`)
* **หน้า `/admin` (Next.js static export → guard ฝั่ง client):** ไม่ได้ล็อกอินหรือไม่มีตำแหน่งทีมงานเลย → `router.replace('/')` โดยไม่ mount คอนโซล จึงไม่มีการเรียก API ของแอดมินเลย (ตรวจจาก `/api/bootstrap` ที่ดึงใหม่ 1 ครั้ง ไม่ใช้แคช 60 วินาที). แท็บที่เห็น = สิทธิ์ที่ union ของตำแหน่งอนุญาต (`moderator` → สมาชิก(อ่าน)/รายงาน, `finance_auditor` → ถอนเงิน(อ่าน)/สมาชิก, `support` → สมาชิก, `ops_manager` → เซิร์ฟเวอร์/เกม, `super_admin` → ทุกแท็บ). API ตอบ 403 ซ้ำทุกเส้นทาง
* **การ์ดโหนดตามบทบาท (เซิร์ฟเวอร์ Ubuntu และ VPS):** `all`/`game` = CPU, RAM, ห้องต่อสู้, ผู้เล่นออนไลน์, ความจุ Mini (20P/30P/40P) และ 100P (60P/100P/120P), IP/heartbeat; `moderator` = CPU, RAM, สถานะ AI Content Moderation (NSFW + 480p Video Worker), จำนวนรอตรวจ/ตรวจแล้ว (ถ้า heartbeat ส่ง `modPending`/`modProcessed`) และ IP/heartbeat โดย **ไม่แสดง** ห้อง/ผู้เล่น/ปุ่มความจุ; `log` (ตัวติดตั้งรายงานเป็น `logs`) = CPU, RAM, สถานะ PostgreSQL (`pgStatus`) และ IP/heartbeat

### 4.1.2 ยศ 12 ขั้นตามจำนวนลูกข่าย (Downline-Based Rank) — V1.1 รอบที่ 5
ยศคำนวณจาก **จำนวนลูกข่ายทั้งหมด 5 ชั้น** (`COUNT(*) FROM network_trees WHERE ancestor_id = ? AND depth BETWEEN 1 AND 5`) ไม่ใช้ EXP อีกต่อไป (`users.exp` ยังสะสมและส่งใน bootstrap เป็นสถิติ):

| ยศ | ลูกข่ายขั้นต่ำ | ยศ | ลูกข่ายขั้นต่ำ |
|---|---|---|---|
| Bronze I | 0 | Gold I | 250 |
| Bronze II | 3 | Gold II | 500 |
| Bronze III | 10 | Gold III | 1,000 |
| Silver I | 25 | Platinum I | 2,500 |
| Silver II | 50 | Platinum II | 5,000 |
| Silver III | 100 | Platinum III | 10,000 |

* ตารางอยู่ที่ `packages/shared/src/ranks` (`RANK_TIERS`, `getRankStatus`); ไอคอน PNG ที่ `/assets/ranks/<family>_<level>.png`
* `/api/bootstrap` → `user.rank = { id, name, image, family, level, totalDownlines, nextRank: { id, name, image, minDownlines } | null, downlinesNeeded, progress }` และ `/api/social/profile` → `profile.rank` (รูปแบบเดียวกัน)
* คลิกป้ายยศบนแถบสถานะ (StatusBar) เปิด `RankProgressionModal` (ยศปัจจุบัน ไอคอนใหญ่ จำนวนลูกข่าย แถบความคืบหน้า และตารางครบ 12 ขั้น "ต้องมีลูกข่าย X คน" พร้อมไฮไลต์ขั้นปัจจุบัน) แทนการไปหน้า `/profile`

### 4.2 Cloudflare D1: `chat_YYYY_MM`

```sql
CREATE TABLE direct_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    message_text TEXT,
    media_r2_url TEXT,
    is_read INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_chat_dialog ON direct_messages(sender_id, receiver_id);
```

### 4.3 Self-Hosted PostgreSQL (Mini PC): `logs_YYYY_MM`

```sql
-- ตาราง Log การเงินและธุรกรรมแบบละเอียด (Audit Trail)
CREATE TABLE logs_2026_11 (
    id BIGSERIAL PRIMARY KEY,
    transaction_id VARCHAR(64) UNIQUE NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    action_type VARCHAR(32) NOT NULL, -- 'GAME_KILL', 'CHEST_OPEN', 'AD_WATCH', 'MLM_COMMISSION', 'MARKET_BUY'
    amount_micro_usd BIGINT NOT NULL,
    balance_after_micro_usd BIGINT NOT NULL,
    source_game_id VARCHAR(64),
    related_user_id VARCHAR(36),      -- ลูกทีมที่สร้างรายได้ให้
    mlm_level INT CHECK (mlm_level BETWEEN 1 AND 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_logs_user_date ON logs_2026_11(user_id, created_at DESC);
CREATE INDEX idx_logs_action ON logs_2026_11(action_type);
```

---

## 5. กลไกการประมวลผลเกม Real-Time (Colyseus Game Engine)

### 5.1 สเปกการประมวลผลและระบบห้องสด
* **Architecture Pattern:** Client-Side Prediction + Server Authoritative (เซิร์ฟเวอร์เป็นผู้กำหนดความถูกต้องของฟิสิกส์ การยิง และความเสียหาย $100\%$)
* **Tick Rate:** $20\text{ Hz}$ (อัปเดตสถานะห้องทุก $50\text{ ms}$)
* **State Management:** ข้อมูลตำแหน่งผู้เล่น ($x, y, z$), ทิศทางการมอง, เลือด, และสถานะแปลงร่างจะอยู่ใน RAM ของ Colyseus Room Instance
* **Local Redis Cache:** ใช้สำหรับแชร์สถานะห้องย่อย เช่น จำนวนคนในห้องปัจจุบัน, สถิติการยิงสะสมในรอบนั้น เพื่อให้ Worker อ่านสถานะได้เร็วโดยไม่ต้องกวน RAM ตัวเกม

### 5.2 กลไกหีบสมบัติ 15 วินาที (15-Second Chest Event)
1. ~~ระบบ Colyseus จะทำการสุ่มพิกัด ($x, y, z$) เกิดหีบสมบัติในแมปทุกๆ $15\text{ วินาที}$~~ **(อัปเดต 2026-11-22)** ไม่มีหีบสุ่มอีกต่อไป หีบสมบัติ (อายุ $15\text{ วินาที}$) จะเกิด **เฉพาะ** ที่จุดตายของผู้เล่นที่ตายเอง / ตายจากสิ่งแวดล้อม (ระเบิดตัวเอง, ตกจากที่สูง, คำสั่ง `/suicide`) เท่านั้น การฆ่าผู้เล่นอื่นไม่ทำให้เกิดหีบ และโหมด Practice/Bot ไม่จ่าย Micro-USD/Coins
2. หีบสมบัติต้องถูกยิงทำลายเพื่อเก็บเงินรางวัล
3. เมื่อหีบถูกทำลาย เซิร์ฟเวอร์ Colyseus จะคำนวณการกระจายเงิน $Micro-USD$ ให้ผู้เล่นที่ทำความเสียหายสูงสุด และบันทึกยอดชั่วคราวไว้ใน RAM มูลค่าหีบแบ่งตามสูตร 100% ในข้อ 7 และ **ค่าหัวสะสม (Head Bounty) ของผู้ตาย** ที่อยู่ในหีบจะโอนให้ผู้เปิดหีบทั้งหมด (ถ้าหีบหมดอายุโดยไม่มีใครเปิด ค่าหัวยังคงเป็นของเจ้าของเดิม)
4. ทุกๆ $10\text{ วินาที}$ หรือเมื่อผู้เล่นออกจากห้อง เครื่อง Colyseus จะรวบยอด (Batching) แล้วยิง HTTPS POST API เข้ารหัสไปยัง **Cloudflare Workers** เพื่อบันทึกเข้า D1 และ Queue

### 5.3 ระบบตรวจจับการฝากเครื่องและ AFK (Anti-AFK System)
* **กฎ 5 นาที (Inactive Detection):** หากผู้เล่นไม่เปิดเผยการขยับตัว หรือไม่มีการกดปุ่มใดๆ ต่อเนื่อง 5 นาที ระบบจะปรับสถานะเป็น `AFK_WARNING` และแสดงปุ่มทดสอบมนุษย์ (Captcha แบบ 1 คลิก) บนหน้าจอ
* **กฎ 30 นาที (Auto-Kick & Penalty):** หากไม่มีการตอบสนองครบ 30 นาที ระบบจะตัดออกจากห้องเกมทันที และคืนเงินสะสมในรอบนั้นกลับเข้าสู่ระบบกลางเพื่อป้องกันการตั้งบอทฟาร์มเงิน

### 5.4 ฟิสิกส์บันไดทึบ / กระสุนชนบันได / ปุ่มผู้ชม / Z-Fighting แมพ 100 คน — V1.1 รอบที่ 4
* **บันไดทึบ (Solid Stairs):** `Kit.stairs()` (`apps/web/src/game/assets/kit.ts`) สร้างบันไดเป็นบล็อกทึบ 1 ก้อนต่อ 1 ขั้น ตั้งแต่พื้นเชิงบันไดถึงหน้าขั้น (ไม่มีโพรงใต้/หลัง/ข้างบันได) ลงทะเบียนเป็น AABB `walkable + blocksMovement + blocksBullets + pushOut` ใน `CollisionWorld` พร้อมคง Ramp เดิมไว้เป็นพื้นเดินลื่น
* **กันมุด/ดันออก:** `CollisionWorld.pushOutOfStairs()` ทำงานทุกเฟรมหลัง `moveBody` — ถ้าจุดศูนย์กลางตัวละครตกลงมาอยู่ใน footprint ของบล็อกบันได (เช่น กระโดดจากหน้าต่างลงบันได) จะยกขึ้นยืนบนหน้าขั้น ถ้าแค่ทับขอบ/มุมหลัง/ข้าง จะดันออกตามแนวตั้งฉากสั้นที่สุด จึงไม่มีทางค้างอยู่ในบันไดจากทุกทิศ
* **กระสุนไม่ทะลุบันได:** raycast ฝั่ง client ชนบล็อกขั้นบันไดแล้ว (`blocksBullets`). ฝั่ง server: เรขาคณิตกลางอยู่ที่ `packages/shared/src/maps/stairs.ts` (`StairVolume`, `stairStepBoxes`, `StairIndex`) และข้อมูลบันไดของแต่ละแมพที่ generate จาก map builder จริงอยู่ที่ `packages/shared/src/maps/stairData.ts` (สร้างใหม่ด้วย `pnpm --filter @mwar/web gen:stairs`; เทสต์จะล้มถ้าข้อมูลไม่ตรงกับ builder). `ShootingRoom.handlePlayerHit` เรียก `shotBlockedByStairs()` (`apps/game-server/src/stairLineOfSight.ts`) — เส้นจากตาผู้ยิงไปหัว/อก/เท้าเป้าหมายต้องถูกบันไดบังครบทั้ง 3 เส้นจึงนับว่าบัง (damage = 0) ใช้ดัชนีบันไดตามแมพของห้อง (`largeMap` → แมพ 960 ม., ไม่ใช่ → แมพเล็ก 240 ม.). **เจตนาให้หลวม:** มีเฉพาะบันไดที่บังกระสุนฝั่ง server (ไม่เพิ่มกำแพง/ภูมิประเทศ) เพื่อไม่ให้ปฏิเสธการยิงที่ถูกต้อง
* **Ghost Spectator:** บินขึ้น = `Space` / `E`, ลง = `Shift` / `C` / `Q`, เคลื่อนที่ = `WASD` — ไม่ผูก `Ctrl` อีกต่อไป (กัน `Ctrl+W` ปิดแท็บ); ปุ่มมือถือ "ลง" ส่ง `KeyC`; ข้อความสรุปปุ่มบน HUD แปล 10 ภาษา (`spectate.*`). กล้องผู้ชมใช้ `near = 0.3` (ผู้เล่นแมพใหญ่ `0.1`, แมพเล็ก `0.05`) เพื่อเพิ่มความละเอียด depth buffer
* **Z-Fighting แมพ 100 คน:** ถนนทั้งหมดถูกรวมเป็นสี่เหลี่ยมแล้วตัดเป็นไทล์ที่ **ไม่ซ้อนทับกัน** (`apps/web/src/game/maps/roadGeometry.ts`: ช่วงถนนตรง = ไทล์ลายถนน UV อิงพิกัดโลก, ทางแยก = ไทล์แอสฟัลต์เรียบ `makeAsphaltTexture`) ผิวถนนยกเป็น `y = 0.05` + `polygonOffset`; ฐานภูเขาไม่มีแผ่น flange แบนที่ y = 0 อีก (จุดแบนจมลง −0.6 ม. จุดแรกที่สูงขึ้นยก +0.14 ม. แล้วไล่ลง) + `polygonOffset` ให้ภูเขาชนะหญ้า
* **เทสต์:** `pnpm --filter @mwar/web test:geometry` (node:test) — แคปซูลไม่ทะลุบันไดทุกตัว/ทุกทิศ/ตกจากหน้าต่าง/มุมหลัง, กระสุนถูกบันไดบัง, ข้อมูลบันได server ตรง client, ไทล์ถนน 100P ไม่ซ้อนกัน

---

## 6. ระบบตรวจสอบและป้องการทุจริตแบบ 3 ชั้น (Multi-Tiered Anti-Cheat AI)

```
[ คำขอถอนเงิน (Cashout Request) ]
                 |
                 v
 +-----------------------------------------------+
 | Layer 1: Rule-Based & PostgreSQL Audit Check  |  <--- ตรวจสอบด่วนใน 1 วินาที (เทียบ Log 90 วัน)
 +-----------------------------------------------+
                 | (ผ่าน)
                 v
 +-----------------------------------------------+
 | Layer 2: Async Behavioral Anomaly Detection   |  <--- ตรวจพฤติกรรมการเล่นสถิติกราฟ
 +-----------------------------------------------+
                 | (ผ่าน)
                 v
 +-----------------------------------------------+
 | Layer 3: Machine Learning Pattern Detection   |  <--- ตรวจสอบการฮั้วกันระหว่างบัญชี
 +-----------------------------------------------+
                 |
                 +---> [ อนุมัติการโอนเงิน (Approved) ]
```

### 6.1 Layer 1: Deterministic Log Audit (ตรวจเป๊ะ 100%)
ทำหน้าที่ตรวจสอบยอดเงิน ณ วันที่กดถอน โดยดึงข้อมูลจาก **Self-Hosted PostgreSQL** ย้อนหลัง 90 วัน:
$$\text{Calculated Balance} = \sum \text{Earnings (Game, Ads, MLM)} - \sum \text{Withdrawals} - \sum \text{Purchases}$$
* **เงื่อนไขอนุมัติ:** ยอดเงินใน `core_db` (D1) ต้องตรงกับ $\text{Calculated Balance}$ ใน PostgreSQL แบบ $100.00\%$ หากมีความคลาดเคลื่อนแม้แต่ $1\text{ Micro-USD}$ ระบบจะระงับการถอนและส่ง Alert ไปยัง Admin

### 6.2 Layer 2: Behavioral Anomaly Detection
* ตรวจสอบสถิติมุมมองการเล็ง ($Aim\ Headshot\ Ratio > 85\%$)
* ตรวจสอบความถี่ในการเก็บหีบสมบัติ ($Chest\ Collect\ Rate$) หากสูงเกินค่าเฉลี่ยสถิติมนุษย์ $3\sigma$ ระบบจะทำลายหีบนั้นทันทีและมาร์กหัวบัญชีไว้ตรวจสอบ

### 6.3 Layer 3: ML Network Graph Integrity (Anti-Collusion)
* วิเคราะห์กราฟเครือข่ายผัง MLM เพื่อหาการสมัครบัญชีม้ามาฆ่ากันเองในห้องเกม (Kill Farming)
* หากพบกลุ่ม IP หรือ Device Fingerprint เดียวกันฆ่ากันซ้ำๆ ระบบจะปรับมูลค่าเงินรางวัลจากการยิงกันของกลุ่มนั้นเป็น $0\text{ Micro-USD}$ อัตโนมัติ

---

## 7. สูตรแบ่งรายได้ / รางวัล 100% (Revenue / Reward Split) — อัปเดต 2026-11-25

> แทนที่สูตรเดิม 75 / 15 / 5 / 5 (2026-11-23) ด้วยสูตร **55 / 15 / 5 / 5 / 20** ที่มีบ่อพลังงาน (Energy Recharge Reserve Pool)
>
> **V1.1 (2026-11-27):** ปัดเศษด้วยกฎ 0.007 C, มูลค่า Kill = ตั๋วของเหยื่อ (ไม่มี $0.10 คงที่), Safety Haircut 0.92, Cheer 55/15/5/5/20 โดย 20% รองรับ EC ของผู้ดู, แบนเนอร์สุ่ม 30–45 วินาที — ดู §7.5–§7.7

### 7.1 สูตรแบ่ง 100% ของมูลค่ารางวัล ($V$)
สำหรับทุก **100%** ของรายได้โฆษณาที่ตรวจสอบแล้ว หรือมูลค่ารางวัล ($V$, หน่วย Micro-USD จำนวนเต็ม) เช่น มูลค่าตั๋วของเหยื่อเมื่อถูกยิง (Kill), หีบสมบัติจากการตาย (Chest = ตั๋วของผู้ตาย), การให้กำลังใจ (Cheer):

> **กฎปัดเศษ V1.1 (0.007 C):** ทุกส่วนที่ไม่ใช่ Platform = `roundCoinShare(V, rate)` — ถ้าเศษ ≥ 0.7 Micro-USD (= 0.007 C) ปัดขึ้น ไม่ถึงปัดลง (คำนวณด้วย BigInt) Platform ได้ส่วนที่เหลือทั้งหมด (5% + ชั้นที่ขาด + เศษ) และ **ไม่ต่ำกว่า `floor(V × 5%)`** — ถ้าการปัดขึ้นทำให้ต่ำกว่านั้น จะตัด 1 Micro-USD จากส่วนที่ใหญ่ที่สุดจนกว่าจะไม่ต่ำกว่า ผลรวม = $V$ พอดีเสมอ (สูตร `Math.floor` ด้านล่างคือค่าเดิมก่อน V1.1 ใช้กับ V ที่หารลงตัว)

1. **ผู้ยิง / ผู้ได้รับรางวัล (Shooter / Earner): $55\%$** — `Math.floor(V * 0.55)` เครดิตเข้ากระเป๋าผู้เล่นทันที
2. **สายงาน 5 ชั้น (Uplines): $15\%$ รวม**
   * **ชั้นที่ 1:** $5\%$ (`Math.floor(V * 0.05)`)
   * **ชั้นที่ 2:** $4\%$ (`Math.floor(V * 0.04)`)
   * **ชั้นที่ 3:** $3\%$ (`Math.floor(V * 0.03)`)
   * **ชั้นที่ 4:** $2\%$ (`Math.floor(V * 0.02)`)
   * **ชั้นที่ 5:** $1\%$ (`Math.floor(V * 0.01)`)
   * ชั้นที่ไม่มีคนอยู่ → ส่วนนั้นเข้า Platform อัตโนมัติ
   * ยังอยู่ภายใต้กฎ Daily Proof-of-Activity (ทำเควสครบ 4 ข้อ มิฉะนั้นยอดสีเทาของวันนั้นถูกยึดเข้า Platform) ตาม `mlm_daily_unlock_engine.md`
3. **ค่าหัวสะสมของผู้ยิง (Shooter's Head Bounty): $5\%$** — `Math.floor(V * 0.05)` บวกเข้า `wallets.bounty_micro_usd` ของผู้ยิงเอง ผู้ที่ยิงผู้เล่นคนนี้ได้ภายหลังจะได้ค่าหัวทั้งหมด (ตายเอง / ตายจากสิ่งแวดล้อม → ค่าหัวตกอยู่ในหีบสมบัติ)
4. **ค่าธรรมเนียมระบบ (Platform / System Fee): $5\%$** — `Math.floor(V * 0.05)`
5. **บ่อพลังงาน (Energy Recharge Reserve Pool): $20\%$** — `Math.floor(V * 0.20)` เข้า `system_balances.energy_pool_micro_usd` (core_db) และ ledger `ENERGY_POOL_CREDIT` (บัญชี `SYSTEM_ENERGY_POOL`) เพื่อเป็นทุนรองรับการชาร์จ EC จากโฆษณาและการให้กำลังใจ

**ตรวจยอดรวม:** $55\% + (5\% + 4\% + 3\% + 2\% + 1\%) + 5\% + 5\% + 20\% = 100\%$

* ทุกจำนวนเป็น **Micro-USD จำนวนเต็ม** เศษจากการหาร (`V − ผลรวมทุกส่วน`) เข้า Platform เพื่อให้ยอดรวมเท่ากับ $V$ พอดีทุกรายการ (โค้ด: `calculateRewardSplit()` ใน `packages/shared/src/math/mlm.ts`, ทดสอบใน `packages/shared/test/reward-split.test.mjs`)
* Platform รวม (ค่าธรรมเนียม 5% + ชั้นที่ขาด + เศษ) ถูกสะสมใน `system_balances.platform_micro_usd`
* ค่าหัวสะสมถอนไม่ได้โดยตรง โอนให้ผู้ที่ฆ่าได้ครั้งเดียว และไม่จ่ายกรณี Kill ที่ตรวจพบการฮั้ว (Layer 3)

### 7.2 ตัวอย่างการคำนวณ (หน่วย Micro-USD)
$V = 10.00\text{ USD} = 10,000,000\text{ Micro-USD}$ และมีสายงานครบ 5 ชั้น:

| ผู้รับ | สัดส่วน | Micro-USD | USD |
| :--- | :---: | ---: | ---: |
| ผู้ยิง / ผู้ได้รับรางวัล | $55\%$ | 5,500,000 | 5.50 |
| ชั้นที่ 1 | $5\%$ | 500,000 | 0.50 |
| ชั้นที่ 2 | $4\%$ | 400,000 | 0.40 |
| ชั้นที่ 3 | $3\%$ | 300,000 | 0.30 |
| ชั้นที่ 4 | $2\%$ | 200,000 | 0.20 |
| ชั้นที่ 5 | $1\%$ | 100,000 | 0.10 |
| ค่าหัวสะสมของผู้ยิง | $5\%$ | 500,000 | 0.50 |
| Platform / System | $5\%$ | 500,000 | 0.50 |
| บ่อพลังงาน (Energy Pool) | $20\%$ | 2,000,000 | 2.00 |
| **รวม** | **$100\%$** | **10,000,000** | **10.00** |

*(ถ้ามีสายงานเพียงชั้นที่ 1–2 ส่วนของชั้นที่ 3–5 รวม $6\%$ = 600,000 จะเข้า Platform ทำให้ Platform ได้ $11\%$ = 1,100,000)*
*(ตัวอย่างเศษ V1.1: $V = 333$ ครบ 5 ชั้น → ผู้ยิง 183 (183.15 ปัดลง) / ชั้น 16·13·**10**·6·3 (ชั้น 3 = 9.99 ปัดขึ้นตามกฎ 0.007 C) / ค่าหัว 16 / Energy Pool 66 → Platform 16 + เศษ 4 = **20** รวม 333)*
*(ตัวอย่างตั๋วจริง: banner US 3,000 Micro-USD × 0.95 = 2,850 → ผู้ยิง 1,567 / ชั้น 142·114·85·57·28 / ค่าหัว 142 / Pool 570 / Platform 145 — แสดงผล "15.67 C ($0.0016)")*

### 7.3 Energy Ticket (EC) — ได้จากโฆษณาเท่านั้น — อัปเดต 2026-11-25

* สมัครใหม่ได้ **`1 EC`** (`INITIAL_ENERGY_TICKETS = 1`) เพดาน **`300 EC`** (`MAX_ENERGY_TICKETS = 300`) ทุกหน้าจอแสดงเป็น **`X / 300 EC`**
* **ไม่มีการชาร์จ EC อัตโนมัติ / รายชั่วโมง / ตามเวลา** ในทุกส่วน (`api-worker`, `game-server`, `web`) — ยกเลิก `ENERGY_RECHARGE_SECONDS` และ `secondsToNextRecharge` แล้ว
* หลังสมัคร EC ได้จาก: วิดีโอรางวัล, impression แบนเนอร์ที่ตรวจแล้ว, การ "ให้กำลังใจ" (§7.4) หรือ Admin ปรับให้เท่านั้น
* การฆ่าบอทในโหมด Practice / Solo Bot ได้ **0 EC และ 0 Micro-USD**
* **แบนเนอร์** (Practice / Solo Bot และ Ghost Spectator): ทุก **รอบสุ่ม 30–45 วินาที** (V1.1, `nextBannerIntervalSeconds()`, สุ่มใหม่ทุก impression) ที่แท็บมองเห็น นับ 1 impression — เซิร์ฟเวอร์บังคับระยะห่างขั้นต่ำ **28 วินาที** (`AD_BANNER_MIN_GAP_SECONDS`) และยังคงตัวกัน AFK 35 วินาที เพิ่ม EC % ตามมูลค่าแบนเนอร์เทียบกับวิดีโอ 30 วินาทีของประเทศเดียวกัน (100% = +1 EC)
* **วิดีโอรางวัล**: 15 วินาที = +50%, 30 วินาที = +100% (1 EC)
* **มูลค่าโฆษณา 3 ชั้น**: P1 ยอดจ่ายจริง → P2 ค่าเฉลี่ยเมื่อวาน (ประเทศ + รูปแบบ) → P3 ตาราง eCPM ตามประเทศ (`docs/AD_ECPM_BY_COUNTRY.md`)
* ทุก ad event อยู่ใน `ad_impressions` และ EC ที่เพิ่มบันทึกเป็น `AD_EC_RECHARGE` ใน audit log มูลค่าโฆษณาที่ใช้ชาร์จ EC บันทึกเป็น `ENERGY_POOL_DRAW` และสะสมใน `system_balances.energy_pool_drawn_micro_usd`

### 7.4 "ให้กำลังใจ" (Cheer / Support via Ad) — ใหม่ 2026-11-25

* **ตำแหน่งปุ่ม:** ปุ่ม "ให้กำลังใจ" บนโพสต์ในฟีด (โพสต์ของคนอื่น), หน้าโปรไฟล์ของคนอื่น, และแผงชาร์จพลังงาน (Sidebar ขวา, หน้า XSHOT Room Lobby, โปรไฟล์ตัวเอง)
* **โมดัลเลือกโฆษณา:** แสดงเฉพาะรูปแบบที่พร้อมตอนนี้ (เช็กจากเซิร์ฟเวอร์ `GET /api/ads/cheer/status`):
  * วิดีโอรางวัล 30 วินาที → **+1 EC**
  * วิดีโอรางวัล 15 วินาที → **+50% EC**
  * แบนเนอร์สปอนเซอร์ (Boost) 10 วินาที → EC % ตามมูลค่าแบนเนอร์ (ปิดได้ด้วย env `CHEER_DISABLED_FORMATS`)
  * แสดง "เหลือสิทธิ์วันนี้ X/15 ครั้ง" และสิทธิ์ต่อคนที่เหลือ ตัวเลือกที่ใช้ไม่ได้ถูกปิดพร้อมเหตุผล เมื่อครบโควตารายวันจะซ่อนตัวเลือกทั้งหมด
* **การนับ (เซิร์ฟเวอร์เป็นคนจับเวลา):** `POST /api/ads/cheer/start` เปิด session ใน `ad_video_views` (purpose `cheer`) → ดูจนจบ → `POST /api/ads/cheer {viewId}` ถ้าเร็วกว่าเวลาโฆษณาได้ 425, ซ้ำได้ 409
* เมื่อสำเร็จ: ผู้ให้กำลังใจได้ EC progress (`creditEcProgress`, log `AD_EC_RECHARGE`), เพิ่ม `social_posts.cheer_count` / `users.cheer_count` ของเจ้าของ, บันทึก `cheer_events` + `ad_impressions` (provider `mwar_cheer`) และ `ENERGY_POOL_DRAW` — การแบ่งเงิน V1.1 ดู §7.6
* **กันบอท / จำกัดสิทธิ์ (บังคับใน D1 ด้วย INSERT … SELECT เงื่อนไขเดียว กันยิงพร้อมกัน):**
  1. คูลดาวน์อย่างน้อย **45 วินาที** ระหว่างการให้กำลังใจที่สำเร็จ (`CHEER_COOLDOWN_SECONDS`)
  2. สูงสุด **15 ครั้ง / ผู้ใช้ / วัน (UTC)** (`CHEER_DAILY_CAP`)
  3. สูงสุด **3 ครั้ง / ผู้ใช้ / ผู้สร้างคนเดียวกัน / วัน** นับรวมทุกโพสต์และโปรไฟล์ (`CHEER_PER_TARGET_DAILY_CAP`)
  4. ให้กำลังใจโพสต์ / โปรไฟล์ของตัวเองไม่ได้ (ใช้ปุ่มชาร์จพลังงานแทน), เปิด session ค้างได้ไม่เกิน 3 อันใน 2 นาที, session หมดอายุ 30 นาที
     — V1.1: บังคับที่เซิร์ฟเวอร์ `POST /api/ads/cheer/start`, claim และ direct-link start/claim ตอบ **400 `SELF_CHEER`**; หน้าเว็บไม่แสดงปุ่มให้กำลังใจบนคอนเทนต์ของตัวเอง ไอคอนใหม่ "มือประคองหัวใจ" แทนนิ้วโป้ง

### 7.5 Ticket-Backed Kill Economy (V1.1) — ใหม่ 2026-11-27

* **มูลค่า Kill = `backed_micro_usd` ของตั๋วเหยื่อ ($V$)** ซึ่งเดินทางใน entry token ที่เซ็น HMAC (`tid`, `tv`) game server แนบ `ticketId` + `pid` (payout id ไม่ซ้ำ) ในทุก item
* Worker (`/api/game/batch-payout`) ตรวจทุก `GAME_KILL` / `CHEST_OPEN` / `BOUNTY_CLAIM` กับแถวตั๋ว: ต้องเป็น `in_match` ของเหยื่อคนนั้น, ผู้รับต้องเข้าห้องภายใน 24 ชม., จ่าย `min(amount, backed)` (ส่วนเกินที่ server ขอมาไม่มีการจ่าย), settle ครั้งเดียว (ส่ง batch ซ้ำ / ขนานกัน = duplicate ไม่จ่ายซ้ำ), item ชนิดอื่น (เช่น `AD_WATCH`) ถูกปฏิเสธ
* $V$ ถูกแบ่ง 55/15/5/5/20 ตาม §7.1 — ผู้ยิงได้ 55% ของตั๋วเหยื่อ (+ ค่าหัวสะสมของเหยื่อ)
* **ตั๋วของคนที่ออก / ถูกเตะ AFK (การตัดสินใจ V1.1):** ตั๋ว `in_match` ของผู้เล่นที่ (ก) ออกจากห้องขณะยังมีชีวิตหลังหมดเวลา reconnect 20 วินาที, (ข) ถูกเตะ AFK, (ค) ย้ายไปที่นั่งผู้ชม, (ง) ถูกฆ่าแบบฮั้ว (Layer 3) หรือโดยผู้เล่นที่ไม่มีสิทธิ์รับเงิน (guest), (จ) ตายแล้วหีบไม่มีใครเปิด / หมดอายุ / เปิดหีบตัวเอง → **ถูกริบ (`TICKET_FORFEIT`) มูลค่าเข้า `system_balances.platform_micro_usd` และไม่คืน** (ตรงกับกฎเดิม: เข้าห้อง 1 ครั้ง = ใช้ 1 EC) ตั๋วที่ค้าง `in_match` เกิน 6 ชม. ถูก cron รายวันกวาดเข้า Platform (`STALE_FORFEIT`)
* หลังตั๋วถูก settle ผู้เล่นยัง respawn ได้ในรอบเดียวกัน แต่การตายครั้งต่อไปมีมูลค่าตั๋ว 0 (ได้เฉพาะค่าหัวสะสม)
* HUD แสดง Round Earned / Head Bounty / มูลค่าตั๋ว เป็น **C ทศนิยม 2 ตำแหน่ง + $** (`formatCoins2`, `formatUsdPrecise`)

### 7.6 Safety Haircut & Cheer Split (V1.1)

* **Safety Haircut:** มูลค่ารองรับ EC จากโฆษณาจริง = `floor(min(effective, gross ทางสถิติ) × AD_SAFETY_MULTIPLIER)` ช่วงที่ยอมรับ 0.90–0.95 (ค่าเริ่มต้น 0.92; ค่านอกช่วงถูก clamp) เช่น 3,000 → 2,760 (0.92) / 2,700–2,850
* โฆษณา / Cheer แบบจำลอง (test mode) **ไม่สร้างเงินใหม่**: มูลค่ารองรับ EC ดึงจาก Energy Pool เฉพาะเมื่อมีคงเหลือพอ (เงื่อนไขอยู่ใน UPDATE เดียวกับการให้ EC — ไม่มีวันติดลบ)
* **Cheer (ดูโฆษณาให้ผู้สร้าง):** มูลค่าโฆษณาหลัง haircut $V$ แบ่ง **55% ผู้สร้าง · 15% สายงานของผู้สร้าง · 5% ค่าหัว (ผู้สร้าง) · 5% Platform · 20% รองรับ EC ของผู้ดู** (`calculateCheerSplit()`, action `CHEER_REWARD`) — ส่วน 20% ผ่าน Energy Pool (เข้าและถูกดึงทันที, log `ENERGY_POOL_DRAW`) แล้วกลายเป็นตั๋ว `cheer_pool` ของผู้ดู ตัวอย่าง $V = 2,760$: ผู้สร้าง 1,518 / ชั้น 138·110·83·55·27 / ค่าหัว 138 / Platform 139 / EC ผู้ดู 552
* EC progress (basis points) ที่ยังไม่ครบตั๋วเก็บมูลค่ารองรับไว้ใน `users.pending_ec_micro_usd` และแบ่งเข้าตั๋วที่ mint ตามสัดส่วน (`allocateEcProgress()`) — ผลรวมตั๋ว + pending = มูลค่าที่ได้รับเสมอ

### 7.7 การทดสอบ (V1.1)

* `pnpm --filter @mwar/shared test` — `packages/shared/test/ticket-economy.test.mjs` (กฎปัด 0.007 C, haircut, ตาราง eCPM × รูปแบบ × haircut × สายงาน, brute force V = 1–20,000 ว่ารวม = V และ Platform ≥ floor(5%), cheer split, `allocateEcProgress`, แบนเนอร์ 30–45 วินาที)
* `scripts/load-test/run-load-and-security-test.mjs` — Part A: ทุก Kill/Chest = ตั๋วเหยื่อ, ทุกตั๋วปิดครั้งเดียว, จ่ายรวม ≤ มูลค่ารองรับ; Part B6 (กับ worker จริง): settle ครั้งเดียวแม้ส่ง batch ซ้ำ/ขนาน, ledger = balance, self-cheer 400, Energy Pool ไม่ติดลบ

---

## 8. ระบบสำรองข้อมูลและจัดการคิว (Disaster Recovery & Queuing System)

```
[ Game Server / Workers ]
            |
            v
 [ Cloudflare Queues ]  <--- พักข้อมูล Log การเงินได้สูงสุด 14 วัน (กรณี Log Server ดับ)
            |
            v (Cloudflare Tunnel)
 [ Fastify Log Receiver (Mini PC) ]
            |
            +---> [ Native PostgreSQL (logs_YYYY_MM) ]
            |
            +---> (ครบ 90 วัน) ---> [ Gzip Compress ] ---> [ Upload to Cloudflare R2 ]
                                                                       |
                                                                       v
                                                           [ Delete Local Table ]
```

### 8.1 การทนทานต่อเหตุการณ์เน็ตบ้านหลุด / ไฟดับ (Downtime Resilience)
1. **คิวพักข้อมูลบนคลาวด์:** เมื่อระบบบันทึกเงินสำเร็จใน D1 แล้ว รายละเอียด Log จะถูกโยนลง **Cloudflare Queues**
2. **การทำงานเมื่อ Mini PC ออฟไลน์:** หาก Mini PC ที่บ้านไฟดับหรือเน็ตหลุด Cloudflare Queues จะทำหน้าที่กักเก็บ Log ไว้บนคลาวด์โดยไม่ลบออก (เก็บได้สูงสุด 14 วัน)
3. **Automatic Catch-up:** เมื่อ Mini PC กลับมาออนไลน์ โปรแกรม Fastify Receiver จะทำการดึงข้อมูลจาก Cloudflare Queues มาทยอยบันทึกลง PostgreSQL ตามลำดับเวลา ($FIFO$) จนครบโดยอัตโนมัติ

---

## 9. ขั้นตอนและคำสั่งสำหรับติดตั้ง Log Server บน Mini PC (Ubuntu Setup Guide)

### 9.1 ติดตั้ง PostgreSQL & Node.js Environment
```bash
# 1. อัปเดตระบบและติดตั้ง PostgreSQL
sudo apt update && sudo apt upgrade -y
sudo apt install -y postgresql postgresql-contrib nodejs npm git

# 2. เริ่มทำงานและตั้งค่า PostgreSQL
sudo systemctl enable postgresql
sudo systemctl start postgresql

# 3. สร้าง Database และ User สำหรับ Log Server
sudo -u postgres psql -c "CREATE DATABASE game_audit_logs;"
sudo -u postgres psql -c "CREATE USER log_writer WITH PASSWORD 'Secure_Password_Here';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE game_audit_logs TO log_writer;"
```

### 9.2 ติดตั้ง Cloudflare Tunnel (`cloudflared`)
```bash
# 1. ดาวน์โหลดและติดตั้ง cloudflared
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb

# 2. ล็อกอินเข้า Cloudflare Account
cloudflared tunnel login

# 3. สร้าง Tunnel สำหรับ Log Server
cloudflared tunnel create mini-pc-log-server

# 4. ตั้งค่าไฟล์ /etc/cloudflared/config.yml
# tunnel: <TUNNEL-UUID>
# credentials-file: /etc/cloudflared/<TUNNEL-UUID>.json
# ingress:
#   - hostname: log-receiver.yourdomain.com
#     service: http://localhost:3000
#   - service: http_status:404

# 5. สั่งให้ Cloudflare Tunnel ทำงานเป็น Background Service
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

---

## 10. รายการแผนงานการพัฒนา (Development Roadmap Checklist)

- [x] **ระยะที่ 1: กำหนดสถาปัตยกรรมและ Schema ฐานข้อมูล** (D1, PostgreSQL, R2)
- [x] **ระยะที่ 2: สรุปฉากเกม 3D & อุปกรณ์ประกอบฉาก (Props)** (กล่องไม้, ต้นไม้, หีบสมบัติ)
- [x] **ระยะที่ 3: พัฒนา Cloudflare Workers API & D1 Database Logic** (Auth, MLM 5 ชั้น, Market)
- [x] **ระยะที่ 4: พัฒนา Colyseus Real-Time Engine & Local Redis integration** (No DB on Game Server)
- [x] **ระยะที่ 5: พัฒนา Log Receiver & Cloudflare Tunnel บน Mini PC** (Fastify + PostgreSQL)
- [x] **ระยะที่ 6: พัฒนา AI Layer 1 (Log Verification) & Layer 2 (Anti-Cheat)**
- [x] **ระยะที่ 7: ทดสอบ Load Test (การยิงพร้อมกัน 1,000 คน) & Security Penetration Test**
  - สคริปต์: `node scripts/load-test/run-load-and-security-test.mjs` (1,000 ผู้เล่นใน 25 ห้อง + RBAC / race / OAuth replay / postback secret / media gate) — ผลรอบเปิดตัว 2026-11-26 ดูที่ `docs/SOCIAL_PLATFORM_DEPLOY.md` หัวข้อ Load & security test
- [x] **ระยะที่ 8: เปิดตัวระบบเวอร์ชัน V1.0 (Production Launch)**
  - ก่อนเปิดจริงบน production: ใช้ migration `0019`/`0020` กับ D1 remote, สร้างคิว `mwar-financial-logs`, ตั้ง secrets และรันสคริปต์ทดสอบกับเครื่องเกมจริง (ดู `docs/SOCIAL_PLATFORM_DEPLOY.md`)