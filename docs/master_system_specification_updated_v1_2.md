# พิมพ์เขียวระบบเกมยิงปืน 3D Real-Time & ระบบการเงิน MLM 5 ชั้น (Master System Specification — V1.2)

---

## 1. บทสรุปผู้บริหารและหลักการประมวลผล (Executive Summary & Core Principles)

โครงการนี้คือระบบนิเวศเกมยิงปืน 3D แบบ Multi-player Real-Time ที่รวมเข้ากับระบบโซเชียล ไลฟ์สตรีมมิง ตลาดซื้อขายไอเทม และระบบสร้างรายได้แบบ MLM 5 ชั้น โดยออกแบบสถาปัตยกรรมเน้น **ความปลอดภัยสูงสุด (Server-Authoritative & Verified-Ad-Only Cash)**, **ความสมดุลทางการเงินแบบขาดทุนเป็นศูนย์ (Zero-Deficit Ticket-Backed Economy)**, และ **ต้นทุนการดำเนินงานที่ต่ำที่สุด (Zero-Egress Cost & Serverless First)**

### 1.1 หลักการออกแบบสำคัญ (Core Architecture Principles)
1. **Zero Open Ports on Core DB:** ระบบฐานข้อมูลหลัก (`core_db`) และระบบแชต (`chat_YYYY_MM`) ทำงานอยู่บน **Cloudflare D1** แบบ Serverless $100\%$ ไม่มีพอร์ตหรือ IP Public เปิดสู่โลกภายนอก
2. **Stateless Game Servers with Zero DB Overhead:** เครื่อง Game Server (`mwar-game-server-1`) ประมวลผลฟิสิกส์ การยิง (Server-Authoritative Raycast) และสถานะห้องสดใน **RAM (Colyseus) และ Local Redis** เท่านั้น
3. **Decoupled Financial Audit Log System:** ระบบบันทึก Log การเงิน (`logs_YYYY_MM`) รันบน **Self-Hosted PostgreSQL** ผ่าน **Cloudflare Tunnel (`cloudflared`)** โดยมี **Cloudflare Queues** และ `audit_outbox` เป็นถังพักข้อมูลฉุกเฉิน
4. **Verified-Ad-Only Cash Backing (ป้องกันเงินรั่วไหล 100%):**
   * เงินสดที่ถอนออกได้ (`wallets.balance_micro_usd`) และมูลค่าตั๋วพลังงานแบบมีทุนค้ำ (`backed_micro_usd > 0`) จะถูกสร้างขึ้น **เฉพาะเมื่อได้รับการยืนยันรายได้จริงจากเครือข่ายโฆษณา (S2S Postback ที่ผ่านการตรวจรหัสลับหรือยอดที่กระทบยอดบัญชีจริงแล้ว)** หรือจากกองทุนการตลาด/บ่อพลังงานที่มีเงินสำรองอยู่จริงเท่านั้น
   * การดูโฆษณาแบบจับเวลาฝั่ง Client เพียงอย่างเดียว (`claimed_via = 'timer'`) จะได้รับเฉพาะความคืบหน้าพลังงาน (`EC %`) ที่ไม่มีมูลค่าเงินสดค้ำ (`backed_micro_usd = 0`) เพื่อป้องกันสคริปต์ปลอมแปลงการดูโฆษณามาดูดเงินสดของระบบ
5. **Micro-USD & 2-Decimal Coin (`C`) Exact Accounting:**
   * ข้อมูลเงินทั้งหมดในฐานข้อมูลเก็บเป็น **จำนวนเต็ม (Integer)** หน่วย **Micro-USD** ($\$1.00 = 1,000,000\text{ Micro-USD}$)
   * **หน่วยแสดงผลคู่ในเกมและระบบ (`C` และ `$`):**
     $$100\text{ C} = \$0.01 = 10,000\text{ Micro-USD}$$
     $$1\text{ C} = \$0.0001 = 100\text{ Micro-USD}$$
     $$0.01\text{ C} = \$0.000001 = 1\text{ Micro-USD}$$
6. **กฎการปัดเศษทศนิยม `C` และเพดานป้องกันขาดทุน (Rounding & Anti-Loss Cap):**
   * ค่า `C` แสดงและคำนวณถึงทศนิยม $2$ ตำแหน่ง ($0.01\text{ C} = 1\text{ Micro-USD}$)
   * **กฎการปัดเศษตำแหน่งที่ 3 ของ `C` (`roundCoinMicroUsd`):** พิจารณาเศษทศนิยม $r \in [0, 0.01)$ ที่เกินมาจากตำแหน่งที่ 2:
     * หากเศษ $r \ge 0.007\text{ C}$ (เทียบเท่า $\ge 0.7\text{ Micro-USD}$) ให้ **ปัดขึ้น** เป็น $+0.01\text{ C}$
     * หากเศษ $r \le 0.006\text{ C}$ (หรือ $r < 0.007\text{ C}$) ให้ **ปัดลง**
   * **เพดานห้ามขาดทุน (Strict Zero-Deficit Cap):** ผลรวมของทุกส่วนแบ่งที่จ่ายออกจริงต้อง **น้อยกว่าหรือเท่ากับ** มูลค่ารายรับจริง $V$ เสมอ ($\sum \text{Payouts} \le V$) ห้ามจ่ายเกินรายรับจริงแม้แต่ $0.01\text{ C}$ ($1\text{ Micro-USD}$) โดยเศษส่วนต่างหรือการชดเชยการปัดเศษจะถูกปรับสมดุลที่ส่วนของ Platform เสมอ

---

## 2. สถาปัตยกรรมระบบภาพรวม (System Architecture & Network Topology)

```
[ Web Client / Mobile Web / PWA ]
                    |
                    +--- (HTTPS / WSS) ---> [ Cloudflare Edge Network ]
                                                     |
            +----------------------------------------+----------------------------------------+
            |                                        |                                        |
    [ Cloudflare Pages ]                  [ Cloudflare Workers API ]                   [ Cloudflare R2 ]
 (Next.js 15 Static Export)              (Auth, Economy, RBAC, Ads,                 (Assets, Media, Archives)
                                          Gifting, Skin Market, Promo)
                                                     |
            +----------------------------------------+----------------------------------------+
            |                                        |                                        |
   [ Cloudflare D1 ]                        [ Cloudflare Queues ]                   [ Cloudflare D1 ]
  (`core_db`: Users, Wallet,               (Financial Log Buffer +                 (`chat_YYYY_MM`: 1-on-1 Chats)
   Tickets, Network, Market,                D1 `audit_outbox` fallback)
   Gifts, Skins, Boss Pool)                          |
                                                     v (Cloudflare Tunnel - Encrypted)
                                            [ Ubuntu Node 1: mwar-game-server-1 ]
                                            - Colyseus Game Server (RAM + Redis + 3D Colliders)
                                            - Fastify Log Receiver + PostgreSQL (`logs_YYYY_MM`)
                                            - Cron Archive to R2 (90 Days)

                                            [ Ubuntu Node 2: mwar-mod-1 ]
                                            - AI Content Moderation Worker (NSFW / Video 480p)
```

---

## 3. สถาปัตยกรรมฐานข้อมูลและการจัดเก็บข้อมูล (Database & Storage Architecture)

| ชื่อชุดข้อมูล | เทคโนโลยีที่ใช้ | ที่ตั้ง / โครงสร้าง | หน้าที่และนโยบายการจัดเก็บ |
| :--- | :--- | :--- | :--- |
| **`core_db`** | **Cloudflare D1** (SQLite) | Cloudflare Edge (Global) | บัญชีผู้ใช้, กระเป๋าเงิน, ตั๋วพลังงานผูกมูลค่า (`user_energy_tickets`), ผัง MLM 5 ชั้น, สิทธิ์พนักงานหลายตำแหน่ง (`user_staff_roles`), กองทุนบอส/การตลาด (`system_balances`), ของขวัญสเปกเตเตอร์, ตลาดสกิน P2P, โค้ดโปรโมต, และคำขอถอนเงิน |
| **`chat_YYYY_MM`** | **Cloudflare D1** (SQLite) | Cloudflare Edge *(แยกก้อนตามเดือน)* | ประวัติการแชต 1 ต่อ 1 ระหว่างผู้เล่น *(ลบทิ้งอัตโนมัติเมื่อครบ 12 เดือน)* |
| **`logs_YYYY_MM`** | **Native PostgreSQL** | Self-Hosted Ubuntu via Cloudflare Tunnel | Log ธุรกรรมการเงิน (`GAME_KILL`, `FAST_MINI_KILL`, `BOSS_BOUNTY_CLAIM`, `GIFT_SEND`, `SKIN_MARKET_SALE`, `MLM_COMMISSION`, ฯลฯ) *(บีบอัดขึ้น R2 และลบตารางเก่าเมื่อครบ 90 วัน)* |
| **`transient_game_state`** | **RAM + Local Redis** | เครื่อง Game Server | พิกัดผู้เล่นสด, มูลค่าตั๋วที่ถือในรอบนั้น, สถานะตัวละครค้างสนามหลังหลุด/ออกเกม, สถานะแปลงร่างเป็นวัตถุ, และสถานะเป้าหมายค่าหัวทองคำ |
| **`static_and_archives`** | **Cloudflare R2** | Cloudflare Object Storage | รูปโปรไฟล์, สื่อโพสต์/แชต (ลบสื่อแชตใน 8 วัน), สกิน 3D, Log การเงิน `.json.gz` ย้อนหลัง |

---

## 4. โครงสร้างตารางฐานข้อมูลหลัก (Core Database Schemas — `core_db`)

นอกเหนือจากตารางพื้นฐาน (`users`, `wallets`, `network_trees`, `marketplace_listings`, `withdrawal_requests`, `ad_network_configs`, `oauth_states`, `user_missions`, `anticheat_flags`, `audit_outbox`) โครงสร้างหลักของเวอร์ชัน V1.1–V1.2 ประกอบด้วย:

### 4.1 ตารางตั๋วพลังงานแบบผูกมูลค่ารายใบ (`user_energy_tickets`)
```sql
CREATE TABLE IF NOT EXISTS user_energy_tickets (
    id TEXT PRIMARY KEY,                          -- UUID v4
    user_id TEXT NOT NULL,
    source_type TEXT NOT NULL,                    -- 'ad_charge' | 'cheer_pool' | 'signup_promo' | 'promo_code' | 'admin_grant'
    country_code TEXT NOT NULL DEFAULT 'GLOBAL',  -- ประเทศจาก request.cf.country
    backed_micro_usd INTEGER NOT NULL CHECK (backed_micro_usd >= 0), -- มูลค่าจริงหลังหักกันเสี่ยง 3% และกองทุนบอส 5% (คงเหลือ 92%)
    status TEXT NOT NULL DEFAULT 'available',     -- 'available' | 'in_match' | 'settled'
    match_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_user_energy_tickets_fifo ON user_energy_tickets(user_id, status, backed_micro_usd DESC, created_at ASC);
```
*(หมายเหตุ: การหักตั๋วเข้าห้อง Paid-EC จะดึงตั๋วที่มี `backed_micro_usd > 0` มาใช้ก่อนตามลำดับ FIFO และใช้ตั๋วฟรีมูลค่า `0` เป็นลำดับสุดท้าย เพื่อให้การสังหารในห้อง Paid-EC มีมูลค่ารางวัลจริงเสมอ)*

### 4.2 ระบบสิทธิ์พนักงานหลายตำแหน่ง (`user_staff_roles`)
```sql
CREATE TABLE IF NOT EXISTS user_staff_roles (
    user_id TEXT NOT NULL,
    role_key TEXT NOT NULL, -- 'moderator' | 'support' | 'finance_auditor' | 'ops_manager' (ห้ามใส่ 'super_admin')
    granted_by TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, role_key)
);
CREATE INDEX IF NOT EXISTS idx_user_staff_roles_role ON user_staff_roles(role_key);
```

### 4.3 ตารางกองทุนรางวัลบอส ของขวัญสเปกเตเตอร์ สกิน P2P และโค้ดโปรโมต (V1.2)
```sql
-- 1. ขยาย system_balances รองรับกองทุนค่าหัวบอสและกองทุนการตลาด
-- เพิ่มคอลัมน์: boss_bounty_pool_micro_usd INTEGER NOT NULL DEFAULT 0, marketing_pool_micro_usd INTEGER NOT NULL DEFAULT 0

-- 2. ประวัติการส่งสติ๊กเกอร์ / ของขวัญในโหมดผู้รับชม (Spectator Gifting)
CREATE TABLE IF NOT EXISTS gift_transactions (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    gift_code TEXT NOT NULL,                      -- 'ammo_box_ad' | 'golden_grenade_100' | 'champion_crown_500'
    gross_micro_usd INTEGER NOT NULL CHECK (gross_micro_usd >= 0),
    receiver_micro_usd INTEGER NOT NULL CHECK (receiver_micro_usd >= 0), -- 70% ของยอดจ่ายด้วยเหรียญ C
    platform_micro_usd INTEGER NOT NULL CHECK (platform_micro_usd >= 0), -- 30% ของยอดจ่ายด้วยเหรียญ C
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_gift_tx_receiver ON gift_transactions(receiver_id, created_at DESC);

-- 3. โค้ดโปรโมตเปิดตัว 500 คนแรก (Launch Promo Codes)
CREATE TABLE IF NOT EXISTS promo_codes (
    code TEXT PRIMARY KEY,
    backed_micro_usd_per_ticket INTEGER NOT NULL CHECK (backed_micro_usd_per_ticket >= 0),
    max_redemptions INTEGER NOT NULL DEFAULT 500,
    redeemed_count INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
    code TEXT NOT NULL,
    user_id TEXT NOT NULL,
    device_fp TEXT,
    ticket_id TEXT NOT NULL,
    redeemed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (code, user_id)
);

-- 4. คลังสกินและตลาดซื้อขายสกินระหว่างผู้เล่น (P2P Skin Marketplace)
CREATE TABLE IF NOT EXISTS user_skins (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    skin_slug TEXT NOT NULL,
    rarity TEXT NOT NULL,                         -- 'common' | 'rare' | 'epic' | 'legendary'
    is_tradeable INTEGER NOT NULL DEFAULT 1,
    is_listed INTEGER NOT NULL DEFAULT 0,
    acquired_from TEXT NOT NULL,                  -- 'mission_crate' | 'p2p_market' | 'admin_grant'
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_user_skins_owner ON user_skins(owner_id);

CREATE TABLE IF NOT EXISTS skin_market_listings (
    id TEXT PRIMARY KEY,
    skin_id TEXT NOT NULL UNIQUE,
    seller_id TEXT NOT NULL,
    price_micro_usd INTEGER NOT NULL CHECK (price_micro_usd >= 5000), -- ขั้นต่ำ 50 C (5,000 µUSD)
    status TEXT NOT NULL DEFAULT 'active',        -- 'active' | 'sold' | 'cancelled'
    buyer_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    sold_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_skin_market_status ON skin_market_listings(status, created_at DESC);
```

---

## 5. กลไกการประมวลผลเกม 3D Real-Time, โหมดการเล่น และการค้างสนาม (Colyseus Game Engine)

### 5.1 สเปกเซิร์ฟเวอร์เกมและการซ่อนห้องเมื่อ Server ออฟไลน์
* **Architecture Pattern:** Client-Side Prediction + Server Authoritative ($20\text{ Hz}$ Tick Rate)
* **Heartbeat & Offline Room Hiding:**
  * เครื่องเกม Ubuntu (`mwar-game-server-1`) ส่ง Heartbeat ทุก **`30 วินาที`**
  * หน้าเลือกห้อง (`/games`, `/game`) ตรวจสอบสถานะออนไลน์จริงของโหนดที่มีบทบาทเกม (`role IN ('all', 'game')` และ Heartbeat ล่าสุด $\le 90\text{ วินาที}$)
  * **หากเครื่อง Ubuntu Game Server ออฟไลน์ทั้งหมด:** ต้อง **ซ่อนรายการห้องออนไลน์ PvP ทั้งหมด** (ไม่แสดง Fast & Mini, Skirmish 30P, Warzone 100P, Streamer Room) และเปิดให้เข้าเล่นได้เฉพาะ **โหมดฝึกซ้อมกับบอท (Practice / Solo Bot)** เท่านั้น

### 5.2 กฎของแต่ละโหมดการเล่นและหน้าสรุปเมื่อตาย (Game Modes & Death Flow)

| โหมดการเล่น | ค่าเข้าเล่น (`EC`) | แหล่งเงินรางวัลต่อการฆ่า | การแบ่งเงินรางวัล | พฤติกรรมเมื่อตัวละครตาย |
| :--- | :---: | :--- | :--- | :--- |
| **Practice / Solo Bot** | ฟรี (`0 EC`) | ไม่มี (`0 C / $0.00`) | ไม่มี | นับถอยหลังแล้วเกิดใหม่อัตโนมัติ (ชาร์จ `EC` ผ่านแบนเนอร์ได้) |
| **Fast & Mini** | ฟรี (`0 EC`) | มูลค่าโฆษณาแบนเนอร์ที่ผู้เล่นดูในรอบนั้น (ระดับหลักหน่วย `C`) | **90% ผู้ยิง / 10% ระบบ** *(บันทึกแยกเป็น `FAST_MINI_KILL` — ไม่แบ่งสายงาน 5 ชั้น, ไม่เก็บค่าหัว, ไม่เข้าบ่อพลังงาน)* | **ไม่เกิดใหม่อัตโนมัติ** แสดงหน้าสรุป (จำนวนคิล, `C` และ `$` ที่ได้, ชาร์จ `EC` ไปกี่ `%`) + แสดงแบนเนอร์โฆษณา 1 อัน + ปุ่มเล่นต่อฟรี / กลับล็อบบี้ |
| **Paid-EC PvP** *(Skirmish 30P / Warzone 100P)* | หัก **`1 EC`** *(ดึงตั๋วมีมูลค่าก่อนตามลำดับ FIFO)* | **`backed_micro_usd` ของใบพลังงานที่ผู้ตายถืออยู่** + ค่าหัวสะสมของผู้ตาย + ค่าหัวบอส (หากเป็นเป้าหมายทองคำ) | **55% ผู้ยิง / 15% สายงาน 5 ชั้น / 5% ค่าหัวผู้ยิง / 5% ระบบ (หรือสมทบกองทุนบอส) / 20% บ่อพลังงาน** | **ไม่เกิดใหม่อัตโนมัติ** แสดงหน้าสรุป (จำนวนคิล, พลังงานและ `C`/`$` ที่ได้, แจ้งมูลค่าตั๋วที่ถูกเก็บไป) + ถาม **"ต้องการเล่นต่อไหม? (ใช้ตั๋ว 1 EC)"** + แสดงแบนเนอร์โฆษณาด้านล่าง 1 อัน |
| **Streamer Room** *(ยศ Silver I+)* | ฟรีสำหรับคนดู / ตามกติกาห้อง | คนดูส่งของขวัญ (`70/30`) + ส่วนแบ่งโฆษณาแบนเนอร์คนดู (`30%–50%` ให้สตรีมเมอร์) | โอนเข้ากระเป๋าสตรีมเมอร์โดยตรงตามยอดคนดูและของขวัญ | คนดูเข้าชมได้ไม่จำกัดจำนวน พร้อมแชทสดและส่งสติ๊กเกอร์ |

* **ป้ายแสดงมูลค่าค่าหัวบนศีรษะในสนาม 3D:** แสดงตัวเลขมูลค่าตั๋วและค่าหัวสะสมเหนือหัวศัตรู (เช่น `💰 162 C`) เพื่อให้ผู้เล่นมองเห็นเป้าหมายที่คุ้มค่าแก่การล่าชัดเจน

### 5.3 กลไกเมื่อผู้เล่นออกจากเกมหรือหลุดขณะยังมีชีวิต (Disconnect Persistence & Deferred Settlement)
* **ตัวละครค้างสนามในสถานะหยุดนิ่ง (ไม่เตะออกจนกว่าจะตาย):**
  * หากผู้เล่นปิดหน้าเกม ย้ายไปเปิดหน้าอื่น หรือหลุดการเชื่อมต่อ **ขณะที่ตัวละครยังไม่ตาย** ระบบจะ **ไม่เตะตัวละครออกจากห้อง**
  * ตัวละครจะยืนหยุดนิ่ง ณ ตำแหน่งเดิม และ **หากแปลงร่างเป็นวัตถุ (Prop-Hide) อยู่ ตัวละครต้องคงสภาพเป็นวัตถุนั้นไว้ตามเดิม** เพื่อให้ผู้เล่นอื่นค้นหาและยิงรับค่าหัวได้
  * หากห้องเหลือเพียงตัวละครที่หลุดการเชื่อมต่อทั้งหมดครบ `30 นาที` (`BODY_ONLY_ROOM_TTL_SECONDS = 1800`) หรือเซิร์ฟเวอร์รีสตาร์ท ตั๋ว `EC` และค่าหัวที่ยังไม่ถูกเก็บจะคืนกลับให้เจ้าของ (`TICKET_RETURN`)
* **การสรุปและแบ่งเงินรอจนกว่าตัวละครจะตาย (Deferred Settlement):** รายได้ในรอบนั้นจะยังไม่ถูกสรุปจนกว่าตัวละครตัวนั้นจะตาย
* **ป๊อปอัปกลับเข้าเกมลอยข้ามทุกหน้า (Global Floating Rejoin Popup):** แสดงป๊อปอัปขนาดเล็กพร้อมปุ่ม **"กลับเข้าเล่น (Rejoin)"** และปุ่ม **`✕`** ซ่อนเฉพาะกล่องแจ้งเตือนในแท็บนั้นบนทุกหน้าของเว็บจนกว่าตัวละครจะตายหรือกดกลับเข้าเล่น

### 5.4 มาตรฐานกราฟิก 3D, ฟิสิกส์การชน, Server Ballistics และปุ่มควบคุม
1. **Server-Authoritative Ballistics & Environment Raycast (`H1` — บังคับ 100%):**
   * เซิร์ฟเวอร์ (`ShootingRoom.ts`) **ห้ามเชื่อ** ค่า `headshot`, ระยะยิง หรือการยิงโดนที่ส่งมาจาก Client โดยตรง
   * ต้องตรวจสอบระยะทางไม่เกินระยะสูงสุดของปืน (`WEAPON_SPECS[weaponId].range`), ตรวจสอบมุมเล็งหน้ากล้อง (Aim Cone), และยิง Raycast ตรวจสอบการชนกับ **สิ่งกีดขวางทั้งแมพ** (อาคาร, กำแพง, กล่องบังเกอร์, ภูมิประเทศ และบันได)
   * คำนวณ **`headshot` บนเซิร์ฟเวอร์** จากความสูงจุดปะทะเทียบกับท่ายืน/หมอบของเป้าหมายเท่านั้น
2. **บันไดทึบ 100% (Solid Staircase Geometry & Raycast):** ปิดทึบทุกด้าน (หน้า, หลัง, ใต้บันได, ด้านข้าง) ทั้งในฟิสิกส์การเดิน/กระโดดจากหน้าต่าง และ Raycast กระสุนปืน
3. **ปุ่มควบคุมที่ปลอดภัยจาก `Ctrl + W` (`M4`):**
   * **โหมดเล่นปกติ:** ใช้ปุ่ม **`C` หรือ `Z`** เป็นปุ่มหมอบเริ่มต้น (ไม่ใช้ `Ctrl` เป็นค่าเริ่มต้น เพื่อไม่ให้ `Ctrl + W` ปิดแท็บเบราว์เซอร์)
   * **โหมดผู้รับชม (Ghost Spectator):** ใช้ **`Space` หรือ `E`** บินขึ้น และใช้ **`Shift`, `C` หรือ `Q`** บินลง
4. **แก้ปัญหาพื้นผิวกระพริบ (Z-Fighting) บนแมพใหญ่ 100 คน:** แยกสี่แยกถนนเป็นชิ้นพื้นผิวเฉพาะไม่ซ้อนทับระนาบ `Y` และปรับรอยต่อตีนภูเขากับพื้นหญ้าพร้อมระยะ Camera Near Plane ให้คมชัด

### 5.5 กลไกหีบสมบัติ 15 วินาที
* เกิดเฉพาะจุดตายของผู้เล่นที่ตายเองหรือตายจากสิ่งแวดล้อมเท่านั้น (ระเบิดตัวเอง, ตกจากที่สูง, `/suicide`) มูลค่าหีบคือมูลค่าใบพลังงานที่ผู้ตายถืออยู่ (แบ่งตามสูตร $55/15/5/5/20$) บวกกับค่าหัวสะสมของผู้ตายที่โอนให้ผู้ทำลายหีบทั้งหมด

### 5.6 ระบบช่วงตั้งไข่ (Cold Start) และรอบล่าบอสค่าหัวทองคำ (V1.2)
* **Golden Boss Bounty (`เป้าหมายค่าหัวทองคำ`):** ทุกๆ `10 นาที` ในห้อง PvP ที่มีผู้เล่นแข่งขัน (เมื่อ `boss_bounty_pool_micro_usd >= 50,000` = `500 C`) ระบบจะสุ่มเลือกผู้เล่น 1 คนในห้องเป็น **เป้าหมายค่าหัวทองคำ** พร้อมมงกุฎทองคำบนศีรษะและมูลค่ารางวัลพิเศษ (`500 C – 2,000 C` หักจาก `boss_bounty_pool_micro_usd` เท่านั้น) ผู้ที่สังหารบอสได้จะได้รับรางวัลตามสูตรแบ่งเงิน (`BOSS_BOUNTY_CLAIM`)
* **Smart Bot Fill:** ในช่วงเปิดตัว (0–1,000 คนแรก) หากผู้เล่นจริงในห้องยังไม่เต็ม ระบบสามารถเติมบอทอัจฉริยะที่มีค่าหัวขนาดเล็กซึ่งเบิกจาก `boss_bounty_pool_micro_usd` (หากกองทุนหมด บอทจะมีค่าหัว `0 C` เพื่อไม่ให้ขาดทุน)
* **Happy Hour 2x:** เปิดรอบคูณรางวัลพิเศษวันละ 1–2 รอบ (เช่น `20:00–21:00 น.`) โดยดึงส่วนต่างโบนัสจาก `boss_bounty_pool_micro_usd` เท่านั้น

---

## 6. ระบบตรวจสอบและป้องกันการทุจริต 3 ชั้น (Multi-Tiered Anti-Cheat AI)

1. **Layer 1 — Deterministic Financial Reconciliation ($100.00\%$ Exact Check) & Atomic Lock (`M1`):**
   * เทียบยอดเงินใน `core_db` กับผลรวม Log ใน PostgreSQL ย้อนหลัง 90 วัน ต้องตรงกันเป๊ะทุก `Micro-USD`
   * การจ่ายค่าคอมมิชชันรายวันต้องใช้คำสั่ง SQL แบบ Atomic (`UPDATE wallet_ledger SET status = 'settled' WHERE status = 'pending' ... RETURNING`) ป้องกันการจ่ายซ้ำเมื่อ Cron และปุ่มกดทำงานชนกัน
2. **Layer 2 — Behavioral Anomaly Detection (`M2`, `M3`, `H2`):**
   * ตรวจจับสถิติมุมมองการเล็ง (`headshot_ratio > 85%` เมื่อจำนวนคิล `kills >= 30` โดยใช้ค่า Headshot ที่เซิร์ฟเวอร์คำนวณเอง) และอัตราเก็บหีบผิดปกติ ($> 3\sigma$)
   * บังคับระบบ **Anti-Idle `35 วินาที`** (`AD_IDLE_REJECT_MS = 35000`) ทั้งฝั่ง Client และ Server และจำกัดเพดานแบนเนอร์ไม่เกิน **`60 ครั้ง / วัน / ผู้ใช้`** (`MAX_DAILY_BANNER_IMPRESSIONS = 60`)
3. **Layer 3 — Anti-Collusion Network Graph (`L9`):**
   * ตรวจจับกลุ่ม IP หรือ Device Fingerprint เดียวกันปั๊มคิลฆ่ากันเอง หรือการฆ่าคนเดิมซ้ำเกิน **`5 ครั้งใน 10 นาที`** (`SAME_VICTIM_KILL_LIMIT = 5`) หากเข้าข่ายจะปรับมูลค่ารางวัลจากการยิงคู่นั้นเป็น `0` ทันที

---

## 7. เศรษฐศาสตร์ใบพลังงาน, สูตรกันเสี่ยง `3%` + กองทุนบอส `10%`, การให้กำลังใจ และระบบของขวัญ/ตลาดสกิน

### 7.1 การคำนวณมูลค่าโฆษณาจริงตามประเทศ และหักกันเสี่ยง `3%` + กองทุนบอส `5%`
* อ่านรหัสประเทศจาก `request.cf.country` บน Cloudflare Edge เท่านั้น (26 ประเทศ + `GLOBAL`)
* **ลำดับการหามูลค่าฐานต่อ 1 การดู (`Gross Micro-USD` $G$):**
  1. **P1:** ราคาจริงจาก S2S Postback ของเครือข่ายโฆษณา (`estimated_price`) — **เฉพาะยอดที่ผ่าน P1 หรือยอดที่กระทบยอดแล้วเท่านั้นจึงสร้างตั๋วเงินสดหรือค่า Cheer ถอนได้**
  2. **P2:** ค่าเฉลี่ย eCPM จริงของประเทศ + รูปแบบโฆษณานั้นจากเมื่อวาน (ใช้สำหรับคำนวณ `EC %` และแบนเนอร์ที่กระทบยอดแล้ว)
  3. **P3:** ตารางสถิติรายประเทศ (`adEcpm.ts`) คูณตัวคูณปรับฐานของ Admin (`35%` Direct Link / `60%` Banner ช่วงเปิดตัว)
* **การหักชั้นที่ 1 จากยอดโฆษณารวม $G$ (`8%` รวม):**
  * **กันเสี่ยงแพลตฟอร์ม (`3%`):** $S_{\text{risk}} = \lfloor G \times 0.03 \rfloor$ เข้าบัญชีสำรองกันความผันผวนของระบบ
  * **สมทบกองทุนค่าหัวบอส (`5%`):** $B_{\text{gross}} = \lfloor G \times 0.05 \rfloor$ เข้า `system_balances.boss_bounty_pool_micro_usd`
  * **มูลค่าสุทธิของตั๋ว (`92%`):** $V = G - S_{\text{risk}} - B_{\text{gross}}$ (ห้ามเกิน $95\%$ ของ $G$ เด็ดขาด)

### 7.2 ใบพลังงานแบบผูกมูลค่ารายใบ (`user_energy_tickets`) และรอบเวลาแบนเนอร์สุ่ม `30–45` วินาที
* **การออกตั๋ว:** เมื่อสะสม `ec_progress_pct >= 100%` ระบบจะออกตั๋วใหม่ `1 ใบ` ลง `user_energy_tickets` พร้อมบันทึก `backed_micro_usd = pending_ec_micro_usd` (สูงสุด `300 EC`) ตั๋วฟรีตอนสมัครสมาชิกมี `backed_micro_usd = 0`
* **รอบรีเฟรชโฆษณาแบนเนอร์แบบสุ่ม (`30–45 วินาที`):** สุ่มระยะเวลาแต่ละรอบระหว่าง `30` ถึง `45 วินาที` (เซิร์ฟเวอร์บังคับขั้นต่ำ $\ge 28\text{ วินาที}$ ร่วมกับ Anti-Idle `35 วินาที` และเพดาน `60 ครั้ง/วัน`)

### 7.3 สูตรแบ่งรายได้ 100% สำหรับ Paid-EC PvP และหีบสมบัติ (`55 / 15 / 5 / 5 [Boss Pool] / 20`)
สำหรับมูลค่าสุทธิของใบพลังงาน $V$ (`92%` ของ $G$):
1. **ผู้ยิง (Shooter): $55\%$**
2. **สายงาน 5 ชั้น (Uplines): $15\%$ รวม** — ชั้น 1 ($5\%$), ชั้น 2 ($4\%$), ชั้น 3 ($3\%$), ชั้น 4 ($2\%$), ชั้น 5 ($1\%$) *(ต้องปลดล็อกภารกิจรายวัน 4/5 ข้อ มิฉะนั้นและชั้นที่ว่างจะโอนเข้า Platform)*
3. **ค่าหัวสะสมส่วนตัวของผู้ยิง (Personal Head Bounty): $5\%$**
4. **ค่าธรรมเนียมระบบ / กองทุนบอส: $5\%$**
   * เมื่อเปิดสวิตช์ `redirect_platform_fee_to_boss = true` ใน `/admin` (ค่าเริ่มต้นช่วงเปิดตัว): ส่วน `5%` นี้จะถูกโอนเข้า **`boss_bounty_pool_micro_usd`** รวมกับ `5%` จากชั้นที่ 1 กลายเป็น **`10%` กองทุนค่าหัวบอส** (และแอดมินสามารถกดปิดสวิตช์เพื่อดึง `5%` นี้กลับเป็นกำไรแพลตฟอร์มได้ทุกเมื่อ)
5. **บ่อพลังงาน (Energy Recharge Reserve Pool): $20\%$**

* **การปัดเศษและกันขาดทุน:** คำนวณด้วยกฎทศนิยม `C` 2 ตำแหน่ง (`0.007 C` ปัดขึ้น, `0.006 C` ปัดลง) โดยคงเพดานขั้นต่ำของส่วนระบบไว้ที่ $\lfloor V \times 0.05 \rfloor$ และปรับเศษส่วนต่างให้ผลรวมทุกส่วนเท่ากับ $V$ พอดี $100.00\%$

### 7.4 สูตรแบ่งรายได้โหมด Fast & Mini (`90 / 10`)
สำหรับมูลค่าโฆษณาแบนเนอร์สะสมของผู้ตาย $V_{\text{banner}}$ ในโหมด Fast & Mini:
1. **ผู้ยิง (Shooter): $90\%$**
2. **ค่าธรรมเนียมระบบ (Platform Fee): $10\%$** *(รวมเศษปัดลงทั้งหมด)*
3. **สายงาน 5 ชั้น / ค่าหัว / บ่อพลังงาน: $0\%$**

### 7.5 ระบบให้กำลังใจ (Cheer / Support via Ad)
* **ห้ามให้กำลังใจตัวเองเด็ดขาด** และใช้ **ไอคอนรูปมือประคองหัวใจ / หัวใจเปล่งประกาย** (ไม่ใช้ไอคอนยกนิ้ว `👍`)
* **การแบ่งรายได้ (เมื่อยืนยันรายได้โฆษณาจริงแล้ว):**
  * **55%** เจ้าของโพสต์/โปรไฟล์ + **15%** สายงาน 5 ชั้นของเจ้าของ + **5%** ค่าหัวเจ้าของ + **5%** ระบบ/กองทุนบอส + **20%** บ่อพลังงานและชาร์จ `EC` ให้ผู้กดให้กำลังใจ
  * *(หากเป็นการกดในโหมดทดสอบหรือ Timer-only ที่ยังไม่มียอด Postback จริง เจ้าของโพสต์จะได้ `0 µUSD` เพื่อไม่ให้ระบบขาดทุน)*

### 7.6 ระบบส่งสติ๊กเกอร์/ของขวัญ ห้องสตรีมเมอร์ และตลาดสกิน P2P (V1.2)
1. **Spectator Gifting (`ส่งสติ๊กเกอร์ / ของขวัญ` ในหน้าผู้รับชม):**
   * **ของขวัญสายฟรี (ดูโฆษณา):** ดูโฆษณา 15–30 วิ เพื่อส่งเอฟเฟกต์กล่องกระสุนในห้องแข่ง + ชาร์จ `EC` ให้ตัวเอง
   * **ของขวัญเหรียญ `C` (เช่น ระเบิดทอง `100 C`, มงกุฎแชมป์ `500 C`):** หักจากกระเป๋าผู้ส่ง $\rightarrow$ แบ่งให้ **ผู้เล่นที่ถูกส่งให้ `70%`** และ **แพลตฟอร์ม `30%`**
2. **Streamer Room (`ยศ Silver I+`):**
   * ผู้เล่นยศ `Silver I` ขึ้นไปเปิดห้องไลฟ์สดได้ รับส่วนแบ่งรายได้โฆษณาแบนเนอร์จากหน้าจอคนดูในห้องนั้น **`30%–50%` (ค่าเริ่มต้น `40%`)**
3. **Player-to-Player Skin Marketplace (`ตลาดซื้อขายสกิน/ไอเทม`):**
   * ผู้เล่นนำสกินที่ได้จากกล่องภารกิจมาตั้งขายแลกเหรียญ `C` (ขั้นต่ำ `50 C`) $\rightarrow$ **ผู้ขายได้รับ `90%`** และ **แพลตฟอร์มเก็บค่าธรรมเนียม `10%` (ปรับได้ `5%–10%` ใน `/admin`)**

---

## 8. ระบบยศ 12 ขั้นตามจำนวนลูกข่าย, ภารกิจรายวัน และระบบจัดการหลังบ้าน (`/admin`)

### 8.1 ระบบยศ 12 ขั้นตามจำนวนลูกข่ายในเครือข่าย (Downline-Based Ranks)
คำนวณจาก **จำนวนลูกข่ายรวมทั้งหมดในสายงาน 5 ชั้น (`total_downlines`)** และคลิกที่ตรายศบนแถบด้านบนเพื่อเปิด **หน้าต่างข้อมูลยศ (`RankProgressionModal`)**:

| ลำดับ | ชื่อยศ | ไฟล์ไอคอน | จำนวนลูกข่ายขั้นต่ำ | สิทธิพิเศษที่ปลดล็อก (V1.2) |
| :---: | :--- | :--- | ---: | :--- |
| 1–3 | **Bronze I – III** | `bronze_1..3.png` | `0` / `3` / `10` คน | สิทธิ์เล่นทุกโหมด, ระบบแนะนำเพื่อน 5 ชั้น, ตลาดสกิน P2P |
| 4–6 | **Silver I – III** | `silver_1..3.png` | `25` / `50` / `100` คน | **ปลดล็อกเปิดห้องไลฟ์สด (Streamer Room)** + กรอบยศสีเงิน |
| 7–9 | **Gold I – III** | `gold_1..3.png` | `250` / `500` / `1,000` คน | ห้องสตรีมเมอร์แนะนำพิเศษ + กรอบยศสีทอง |
| 10–12 | **Platinum I – III** | `platinum_1..3.png` | `2,500` / `5,000` / `10,000` คน | ตรายศสูงสุดระดับตำนาน + ลำดับความสำคัญบนลีดเดอร์บอร์ด |

### 8.1.1 ภารกิจรายวันและกฎปลดล็อกสายงาน 5 ชั้น (Daily Quests — `0 C` / `$0.00`)
* **ไม่มีรางวัลเป็นเงินสดหรือเหรียญ (`0 C` และ `$0.00`):** ภารกิจรายวันทั้งหมด (5 ภารกิจต่อวัน รีเซ็ตเวลา `00:00 UTC` / `07:00 ICT`) **ให้รางวัลเป็น `0 C` และ `$0.00` เท่านั้น**
* **หน้าที่เดียวของภารกิจรายวัน:** ใช้เพื่อ **ปลดล็อกสิทธิ์รับส่วนแบ่งค่าคอมมิชชัน MLM 5 ชั้น (`15%`)** สำหรับวันนั้นๆ เท่านั้น — เมื่อทำสำเร็จครบ **`4 / 5` ภารกิจ** สถานะจะเปลี่ยนเป็น **`Unlocked`** และรับส่วนแบ่งสายงานได้ตามปกติ (หากทำน้อยกว่า `4 / 5` ส่วนแบ่งสายงานของวันนั้นจะถูกโอนเข้าแพลตฟอร์ม)

### 8.2 การแสดงผลโหนดเซิร์ฟเวอร์แยกตามบทบาท (`/admin`)
* **โหนดเกม (`role = 'all' | 'game'`):** แสดง CPU/RAM, จำนวนห้องต่อสู้, ผู้เล่นออนไลน์, และปุ่มปรับความจุโหมดมินิ (`20P/30P/40P`) และโหมด 100 คน (`60P/100P/120P`)
* **โหนดตรวจสอบเนื้อหา (`role = 'moderator'`):** แสดงเฉพาะ CPU/RAM, สถานะ AI Moderation Worker, คิวตรวจรูป/วิดีโอ 480p และสัญญาณล่าสุด — **ซ่อนข้อมูลห้องต่อสู้ ผู้เล่นออนไลน์ และปุ่มตั้งค่าความจุผู้เล่นทั้งหมด**

### 8.3 การจัดการทีมงานและสิทธิ์การเข้าถึง `/admin` (Multi-Role Staff RBAC)
* ผู้ใช้ทั่วไปที่ไม่ใช่พนักงานจะถูกเด้งกลับหน้าแรก `https://mwar.win/` ทันที และ API แอดมินคืน `403`
* พนักงานสามารถถือครอง **หลายตำแหน่งพร้อมกัน** (`moderator`, `support`, `finance_auditor`, `ops_manager`) ยกเว้น `super_admin` ที่ล็อกสิทธิ์ไว้เฉพาะแอดมินสูงสุดเท่านั้น และสามารถเพิ่ม/แก้ไข/ถอดถอนกลับเป็นสมาชิกปกติได้จากหน้า `/admin`

---

## 9. ระบบสำรองข้อมูล, ความปลอดภัยระบบ และขั้นตอนติดตั้ง Ubuntu 1-Click

* **Financial Log Resilience:** ส่งธุรกรรมทั้งหมดผ่าน **Cloudflare Queues (`mwar-financial-logs`)** พร้อม `audit_outbox` + Cron `*/10 * * * *` ยิงผ่าน Cloudflare Tunnel ลง PostgreSQL (`logs_YYYY_MM`) และบีบอัดขึ้น R2 เมื่อครบ 90 วัน
* **Secret & Process Hardening (`L8`, `M7`):**
  * ตรวจสอบ `INTERNAL_API_SECRET` แบบ Constant-Time Comparison และห้าม `apps/game-server` เริ่มทำงานในโหมด `production` หากไม่มี `INTERNAL_API_SECRET` ที่ปลอดภัย
  * บันทึก Fatal Error (`uncaughtException` / `unhandledRejection`) ลง Log ก่อนออกโปรเซส และให้ PM2 รีสตาร์ทอัตโนมัติ
* **1-Click Ubuntu Reinstall:** สคริปต์ `/api/nodes/install.sh` รองรับการติดตั้งบน Ubuntu 22.04/24.04 ใหม่ในคำสั่งเดียว รวมการตั้งสิทธิ์ `OWNER TO log_writer`, การซิงก์ `.env`, `pm2 startup`, `cloudflared`, และการทดสอบตัวเองหลังติดตั้ง

---

## 10. รายการแผนงานการพัฒนา (Development Roadmap Checklist)

- [x] **ระยะที่ 1–8:** โครงสร้างหลัก V1.0, โซเชียล 10 ภาษา, โฆษณาแยกประเทศ, ล็อกอิน Telegram/LINE, AI ตรวจสอบ 3 ชั้น, Queue/PostgreSQL และ Load Test 1,000 คน
- [x] **ระยะที่ 9 (V1.1 Economic & Gameplay Polish):** ตั๋วผูกมูลค่าจริง, ปัดเศษ `0.007/0.006`, หน้าสรุปเมื่อตาย, Fast & Mini `90/10`, ค้างสนาม + Rejoin, บันไดทึบ, แยกการ์ดโหนด Moderator, พนักงานหลายตำแหน่ง และเหรียญยศ 12 ขั้น PNG
- [ ] **ระยะที่ 10 (V1.2 Security Hardening, Boss Bounty & Engagement Engine):**
  - [ ] **รอบ A (Server Ballistics & Gameplay Fairness):** Raycast กำแพง/ระยะปืน/Aim Cone/Headshot บนเซิร์ฟเวอร์ (`H1`), ใช้ตั๋วมีมูลค่าก่อนตั๋วฟรี, ป้ายค่าหัวลอยเหนือศีรษะ, ปุ่มหมอบ `C`/`Z` (`M4`), บันทึก `FAST_MINI_KILL` (`M5`), และ Crash Logging (`M7`/`L8`)
  - [ ] **รอบ B (Verified Ad Revenue & 3% + 10% Boss Bounty Pool):** ปิดช่องโหว่การนับรายได้จาก Timer-only (`H2`/`H3`), เพดานแบนเนอร์ `60 ครั้ง/วัน`, สูตรกันเสี่ยง `3%` + กองทุนค่าหัวบอส `10% (5%+5%)`, ระบบสุ่มเป้าหมายค่าหัวทองคำ (`500–2,000 C`), และ Atomic MLM Settlement (`M1`)
  - [ ] **รอบ C (Spectator Gifting & Cold-Start Growth):** ระบบส่งของขวัญในหน้าผู้รับชม (ดูโฆษณาฟรี / จ่าย `C` แบ่ง `70/30`), บอทอัจฉริยะเติมห้องช่วงตั้งไข่, Happy Hour 2x, และโค้ดโปรโมต 500 คนแรก (`MWAR500`)
  - [ ] **รอบ D (Streamer Rooms & P2P Skin Marketplace):** ห้องไลฟ์สดสำหรับยศ `Silver I+` (แบ่งค่าโฆษณาคนดู `30–50%`) และระบบคราฟต์/ขายสกินระหว่างผู้เล่นด้วยเหรียญ `C` (แบ่ง `90/10`)