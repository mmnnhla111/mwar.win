# พิมพ์เขียวระบบเกมยิงปืน 3D Real-Time & ระบบการเงิน MLM 5 ชั้น (Master System Specification)

---

## 1. บทสรุปผู้บริหารและหลักการประมวลผล (Executive Summary & Core Principles)

โครงการนี้คือระบบนิเวศเกมยิงปืน 3D แบบ Multi-player Real-Time ที่รวมเข้ากับระบบเศรษฐกิจและการสร้างรายได้แบบ MLM 5 ชั้น โดยออกแบบสถาปัตยกรรมเน้น **ความปลอดภัยสูงสุด**, **ความเสถียรของระบบการเงิน**, และ **ต้นทุนการดำเนินงานที่ต่ำที่สุด (Zero-Egress Cost & Serverless First)**

### 1.1 หลักการออกแบบสำคัญ (Core Architecture Principles)
1. **Zero Open Ports on Core DB:** ระบบฐานข้อมูลหลัก (`core_db`) และระบบแชต (`chat_YYYY_MM`) ทำงานอยู่บน **Cloudflare D1** แบบ Serverless 100% ไม่มีพอร์ตหรือ IP Public เปิดสู่โลกภายนอก ป้องกันการถูกสแกนเจาะระบบและยิง DDoS 100%
2. **Stateless Game Servers with Zero DB Overhead:** เครื่อง Game Server (Mini PC / VPS) มีหน้าที่ประมวลผลฟิสิกส์ การยิง และสถานะห้องสดใน **RAM (Colyseus) และ Local Redis** เท่านั้น **ห้ามลงฐานข้อมูล PostgreSQL บนเครื่องเกม** เพื่อรักษาความเร็วระดับมิลลิวินาที ($< 20\text{ ms}$) และทำให้การขยับขยาย Node เกมทำได้ง่ายเพียงแค่สั่งรัน Docker Container เพิ่ม
3. **Decoupled Financial Audit Log System:** ระบบบันทึก Log การเงิน (`logs_YYYY_MM`) แยกออกไปรันบน **Self-Hosted PostgreSQL** บนเครื่อง Mini PC / Ubuntu Server ผ่าน **Cloudflare Tunnel (`cloudflared`)** และมี **Cloudflare Queues** เป็นถังพักข้อมูลฉุกเฉิน หากไฟดับหรือเน็ตบ้านหลุด ข้อมูล Log จะไม่สูญหายแม้แต่บรรทัดเดียว
4. **Micro-USD Precise Accounting:** ข้อมูลตัวเลขเงินทั้งหมดในฐานข้อมูล SQLite/D1 และ PostgreSQL จะถูกบันทึกเป็น **จำนวนเต็ม (Integer)** ในหน่วย **Micro-USD** ($1\text{ USD} = 1,000,000\text{ Micro-USD}$) ป้องกันปัญหาคลาดเคลื่อนของจุดทศนิยม ($Floating\ Point\ Error$) ในการคำนวณส่วนแบ่ง $5\%$ และ $95\%$

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
```

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

### 7.1 สูตรแบ่ง 100% ของมูลค่ารางวัล ($V$)
สำหรับทุก **100%** ของรายได้โฆษณาที่ตรวจสอบแล้ว หรือมูลค่ารางวัล ($V$, หน่วย Micro-USD จำนวนเต็ม) เช่น ค่าหัวจากการยิง (Kill), หีบสมบัติ (Chest), การดูโฆษณา (Ad):

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
*(ตัวอย่างเศษ: $V = 333$ ครบ 5 ชั้น → 183 / 16·13·9·6·3 / 16 / 16 / 66 = 328 เศษ 5 เข้า Platform → Platform 21)*

### 7.3 Energy Ticket (EC) — ได้จากโฆษณาเท่านั้น — อัปเดต 2026-11-25

* สมัครใหม่ได้ **`1 EC`** (`INITIAL_ENERGY_TICKETS = 1`) เพดาน **`300 EC`** (`MAX_ENERGY_TICKETS = 300`) ทุกหน้าจอแสดงเป็น **`X / 300 EC`**
* **ไม่มีการชาร์จ EC อัตโนมัติ / รายชั่วโมง / ตามเวลา** ในทุกส่วน (`api-worker`, `game-server`, `web`) — ยกเลิก `ENERGY_RECHARGE_SECONDS` และ `secondsToNextRecharge` แล้ว
* หลังสมัคร EC ได้จาก: วิดีโอรางวัล, impression แบนเนอร์ที่ตรวจแล้ว, การ "ให้กำลังใจ" (§7.4) หรือ Admin ปรับให้เท่านั้น
* การฆ่าบอทในโหมด Practice / Solo Bot ได้ **0 EC และ 0 Micro-USD**
* **แบนเนอร์** (Practice / Solo Bot และ Ghost Spectator): ทุก 20 วินาทีที่แท็บมองเห็น นับ 1 impression เพิ่ม EC % ตามมูลค่าแบนเนอร์เทียบกับวิดีโอ 30 วินาทีของประเทศเดียวกัน (100% = +1 EC)
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
* เมื่อสำเร็จ: ผู้ให้กำลังใจได้ EC progress (`creditEcProgress`, log `AD_EC_RECHARGE`), เพิ่ม `social_posts.cheer_count` / `users.cheer_count` ของเจ้าของ, บันทึก `cheer_events` + `ad_impressions` (provider `mwar_cheer`) และ `ENERGY_POOL_DRAW`
* **กันบอท / จำกัดสิทธิ์ (บังคับใน D1 ด้วย INSERT … SELECT เงื่อนไขเดียว กันยิงพร้อมกัน):**
  1. คูลดาวน์อย่างน้อย **45 วินาที** ระหว่างการให้กำลังใจที่สำเร็จ (`CHEER_COOLDOWN_SECONDS`)
  2. สูงสุด **15 ครั้ง / ผู้ใช้ / วัน (UTC)** (`CHEER_DAILY_CAP`)
  3. สูงสุด **3 ครั้ง / ผู้ใช้ / ผู้สร้างคนเดียวกัน / วัน** นับรวมทุกโพสต์และโปรไฟล์ (`CHEER_PER_TARGET_DAILY_CAP`)
  4. ให้กำลังใจโพสต์ / โปรไฟล์ของตัวเองไม่ได้ (ใช้ปุ่มชาร์จพลังงานแทน), เปิด session ค้างได้ไม่เกิน 3 อันใน 2 นาที, session หมดอายุ 30 นาที

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
- [ ] **ระยะที่ 2: สรุปฉากเกม 3D & อุปกรณ์ประกอบฉาก (Props)** (กล่องไม้, ต้นไม้, หีบสมบัติ)
- [ ] **ระยะที่ 3: พัฒนา Cloudflare Workers API & D1 Database Logic** (Auth, MLM 5 ชั้น, Market)
- [ ] **ระยะที่ 4: พัฒนา Colyseus Real-Time Engine & Local Redis integration** (No DB on Game Server)
- [ ] **ระยะที่ 5: พัฒนา Log Receiver & Cloudflare Tunnel บน Mini PC** (Fastify + PostgreSQL)
- [ ] **ระยะที่ 6: พัฒนา AI Layer 1 (Log Verification) & Layer 2 (Anti-Cheat)**
- [ ] **ระยะที่ 7: ทดสอบ Load Test (การยิงพร้อมกัน 1,000 คน) & Security Penetration Test**
- [ ] **ระยะที่ 8: เปิดตัวระบบเวอร์ชัน V1.0 (Production Launch)**