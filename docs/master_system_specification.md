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
1. ระบบ Colyseus จะทำการสุ่มพิกัด ($x, y, z$) เกิดหีบสมบัติในแมปทุกๆ $15\text{ วินาที}$
2. หีบสมบัติต้องถูกยิงทำลายเพื่อเก็บเงินรางวัล
3. เมื่อหีบถูกทำลาย เซิร์ฟเวอร์ Colyseus จะคำนวณการกระจายเงิน $Micro-USD$ ให้ผู้เล่นที่ทำความเสียหายสูงสุด และบันทึกยอดชั่วคราวไว้ใน RAM
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

## 7. ระบบการเงิน MLM 5 ชั้น และการจัดสรรรายได้ (MLM & Tax Distribution)

### 7.1 สูตรคำนวณการแบ่งเงิน ($95\%$ / $5\%$)
เมื่อเกิดธุรกรรมสร้างรายได้ในระบบ (เช่น การยิงผู้เล่นได้เงินค่าหัว หรือการเก็บหีบสมบัติ) ระบบจะทำการหักภาษีระบบ $5\%$ และนำเงินส่วนที่เหลือ $95\%$ มาแบ่งให้สายงาน 5 ชั้นตามสัดส่วนดังนี้:

* **ภาษีระบบ (Platform Fee):** $5\%$
* **เงินรางวัลสุทธิ (Net Pool):** $95\%$ ของมูลค่าธุรกรรม ($V$)
  * **ชั้นที่ 1 (Direct Sponsor):** $50\%$ ของ Net Pool ($0.95 \times V \times 0.50$)
  * **ชั้นที่ 2:** $20\%$ ของ Net Pool ($0.95 \times V \times 0.20$)
  * **ชั้นที่ 3:** $15\%$ ของ Net Pool ($0.95 \times V \times 0.15$)
  * **ชั้นที่ 4:** $10\%$ ของ Net Pool ($0.95 \times V \times 0.10$)
  * **ชั้นที่ 5:** $5\%$ ของ Net Pool ($0.95 \times V \times 0.05$)

### 7.2 ตัวอย่างการคำนวณ (หน่วย Micro-USD)
หากเกิดมูลค่าธุรกรรม $V = 10.00\text{ USD} = 10,000,000\text{ Micro-USD}$:
1. **Platform Fee ($5\%$):** $500,000\text{ Micro-USD}$ ($0.50\text{ USD}$)
2. **Net Pool ($95\%$):** $9,500,000\text{ Micro-USD}$ ($9.50\text{ USD}$)
   * **ชั้นที่ 1 ได้รับ:** $9,500,000 \times 0.50 = 4,750,000\text{ Micro-USD}$ ($4.75\text{ USD}$)
   * **ชั้นที่ 2 ได้รับ:** $9,500,000 \times 0.20 = 1,900,000\text{ Micro-USD}$ ($1.90\text{ USD}$)
   * **ชั้นที่ 3 ได้รับ:** $9,500,000 \times 0.15 = 1,425,000\text{ Micro-USD}$ ($1.425\text{ USD}$)
   * **ชั้นที่ 4 ได้รับ:** $9,500,000 \times 0.10 = 950,000\text{ Micro-USD}$ ($0.95\text{ USD}$)
   * **ชั้นที่ 5 ได้รับ:** $9,500,000 \times 0.05 = 475,000\text{ Micro-USD}$ ($0.475\text{ USD}$)

*(กรณีที่ผู้เล่นคนนั้นมีสายงานไม่ครบ 5 ชั้น เงินส่วนแบ่งของชั้นที่ขาดจะถูกตีเข้าบัญชีกลาง Platform Reserve อัตโนมัติ)*

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