# MWAR - คู่มือการรันและทดสอบระบบทั้งหมดบนเครื่อง Localhost (100% Offline Local-First)

ระบบถูกออกแบบให้สามารถรันและทดสอบทุกฟีเจอร์ได้ครบ 100% บนเครื่องของคุณ โดยไม่ต้องสมัครบัญชี Cloudflare, ไม่ต้องเตรียมเครื่อง Ubuntu Server, และไม่ต้องซื้อโดเมนในระหว่างการพัฒนา

---

## 1. พอร์ตและเซอร์วิสใน Monorepo (Port Allocation Matrix)

| Service | Technology | Port / URL | รายละเอียดและหน้าที่ |
| :--- | :--- | :--- | :--- |
| **API Worker** (`apps/api-worker`) | Cloudflare Workers + Hono | `http://127.0.0.1:8787` | ประมวลผล D1 (`core_db`, `chat_2026_11`), R2, Auth, MLM 5 ชั้น, ตลาดลูกข่าย |
| **Game Server** (`apps/game-server`) | Colyseus v0.15+ (Node.js) | `ws://localhost:2567` | เซิร์ฟเวอร์เกมยิงสด 20 Hz, ห้อง 30 คน และ 100 คน, หีบ 15 วิ, แปลงร่างกล่อง, โหมดผี, กัน AFK |
| **Log Receiver** (`apps/log-receiver`) | Fastify + PostgreSQL 16 | `http://localhost:3000` | ตัวรับ Log การเงินฝั่ง Mini PC + ถังพัก Buffer ใน RAM เมื่อ DB ออฟไลน์ |
| **Web Client** (`apps/web`) | Next.js 15 + Three.js + Tailwind | `http://localhost:3001` | หน้าเว็บหลัก, ฉากยิง 3D (PC Mouse Lock + Mobile Touch), ผัง MLM 5 ชั้น, ตลาดซื้อขาย |
| **PostgreSQL 16** (Docker) | `postgres:16-alpine` | `localhost:5432` | ฐานข้อมูล Audit Log `logs_2026_11` |
| **Redis 7** (Docker) | `redis:7-alpine` | `localhost:6379` | แคชค้นหาห้องเกม (Game Room Discovery) |

---

## 2. คำสั่งเริ่มต้นใช้งาน (Quickstart Commands)

### 2.1 รัน Docker Services (PostgreSQL & Redis)
```bash
docker compose up -d
```
*(หากยังไม่ได้เปิด Docker Desktop เซิร์ฟเวอร์เกมและ Log Receiver จะทำงานผ่าน RAM Fallback ได้โดยอัตโนมัติ)*

### 2.2 สั่ง Migrate ฐานข้อมูล Cloudflare D1 Local
```bash
pnpm --filter @mwar/api-worker db:migrate:local
```

### 2.3 รัน API Worker (Wrangler Local Mode)
```bash
pnpm --filter @mwar/api-worker dev
```

### 2.4 รัน Colyseus Authoritative Game Server
```bash
pnpm --filter @mwar/game-server dev
```

### 2.5 รัน Fastify Financial Log Receiver
```bash
pnpm --filter @mwar/log-receiver dev
```

### 2.6 รัน Next.js Web Client & 3D Game Canvas
```bash
pnpm --filter @mwar/web dev
```
เปิดเบราว์เซอร์เข้าที่: `http://localhost:3001`

---

## 3. วิธีการทดสอบ Dev Simulation Tools (ปุ่มจำลองบนหน้าจอ)

ในโหมดพัฒนา (`DEV_MOCK_MODE=true`) จะมีปุ่มสีเหลืองลอยอยู่มุมขวาล่างของหน้าจอ: **`🛠️ DEV MOCK PANEL`** ซึ่งรองรับการทดสอบ 4 ระบบหลัก:

### 3.1 WhatsApp OTP
- กดปุ่ม **"Send OTP (Terminal)"** ระบบจะพิมพ์รหัส 6 หลักลงในคอนโซลของ API Worker
- ใน Dev Mode สามารถกรอกรหัส **`123456`** เพื่อยืนยันและล็อกอินเข้าสู่ระบบได้ทันที

### 3.2 Telegram Login Widget
- กดปุ่ม **"Mock Telegram Login"** ระบบจะจำลองข้อมูลยืนยันตัวตนจาก Telegram (User ID, Phone Number) และล็อกอินให้ทันทีโดยไม่ต้องเปิด Bot จริง

### 3.3 S2S Ad Postbacks & พลังงาน (AdswedMedia & OnClickA)
- เลือก Country Tier เช่น:
  - **US Tier:** ได้รับ $0.05 USD (500 Coins)
  - **TH Tier:** ได้รับ $0.01 USD (100 Coins)
- กดปุ่ม **"Trigger Fake Ad Postback"** ระบบจะจำลองการดูโฆษณา แจกเงินให้ผู้เล่น และ **คำนวณแบ่งเงิน 5 ชั้น (MLM 5-Level)** ให้กับ Upline ของผู้เล่นคนนั้นทันที

### 3.4 AI Fraud Audit & ระบบถอนเงิน
- กดปุ่ม **"Faucet: Add $20 USD"** เพื่อเติมเงินทดสอบเข้ากระเป๋า
- ไปที่เมนู **"Wallet & Cashout"** แล้วกดขอถอนเงิน (ขั้นต่ำ $10 USD)
- กดปุ่ม **"AI Approve (0.99)"** หรือ **"AI Reject & Refund"** เพื่อจำลองกระบวนการตรวจจับ Aimbot และ Anomaly ของระบบ AI 3 ชั้น

---

## 4. ความปลอดภัยและการคำนวณตัวเลข (Financial Precision)
- ตัวเลขเงินทั้งหมดในระบบใช้ **BigInt Micro-USD** ($1\text{ USD} = 1,000,000\text{ Micro-USD}$)
- $0.01\text{ USD} = 100\text{ Coins} = 10,000\text{ Micro-USD}$
- การแบ่งส่วนแบ่ง MLM: Platform Fee $5\%$, Net Pool $95\%$ แบ่งเข้า 5 ชั้น ($50\%, 20\%, 15\%, 10\%, 5\%$) รับประกันความถูกต้องระดับ 1 Micro-USD ไม่มีปัญหา Floating Point Error แม้แต่จุดเดียว
