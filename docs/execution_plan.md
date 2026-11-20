# แผนการดำเนินงานพัฒนา ระบบเกม 3D & MLM 5 ชั้น (Execution Plan for Google Antigravity)

เอกสารนี้ใช้สำหรับให้ AI Agent (Google Antigravity) ปฏิบัติงานตามลำดับขั้นตอน (Step-by-Step Task Execution) เพื่อสร้างระบบให้เสร็จสมบูรณ์ ปลอดภัย และตรงตามสถาปัตยกรรมที่กำหนด

---

## ระยะที่ 1: การจัดโครงสร้างโปรเจกต์และวางระบบพื้นฐาน (Project Scaffolding & Core Setup)

*   [ ] **Task 1.1: สร้าง Monorepo และกำหนดโฟลเดอร์หลัก**
    *   สร้างโครงสร้างโฟลเดอร์: `apps/web` (React + Vite + Tailwind), `apps/workers-api` (Cloudflare Workers), `apps/game-server` (Colyseus + Node.js), `apps/log-receiver` (Fastify + PostgreSQL Node)
    *   ตั้งค่า TypeScript Strict Mode (`tsconfig.json`) และ ESLint/Prettier ในทุกแพ็กเกจ
*   [ ] **Task 1.2: ติดตั้งและตั้งค่า Cloudflare Environment**
    *   สร้างไฟล์ `wrangler.toml` สำหรับ Cloudflare Workers
    *   ผูกการเชื่อมต่อ Cloudflare D1 (`core_db`, `chat_2026_11`), Cloudflare Queues (`financial-log-queue`), และ Cloudflare R2 Bucket (`game-assets-bucket`)

---

## ระยะที่ 2: ระบบยืนยันตัวตนและฐานข้อมูลหลัก (Authentication & Core D1 Subsystem)

*   [ ] **Task 2.1: Implement D1 Database Migration Scripts (`core_db`)**
    *   สร้างไฟล์ Migration SQL ตาม Schema: `users`, `wallets`, `network_trees`, `marketplace_listings`, `withdrawal_requests`
    *   สร้าง Index ในคอลัมน์ที่ต้องใช้ค้นหาเพื่อประหยัด Rows Read/Write บน D1
*   [ ] **Task 2.2: ระบบสมัครสมาชิกและเข้าสู่ระบบ (Auth API)**
    *   พัฒนา API `/api/auth/register`: รองรับการส่ง `referrer_id` (Upline) เพื่อสร้างความสัมพันธ์ในระบบ MLM
    *   ใช้ **Argon2id** หรือ **WebCrypto HMAC-SHA256** ในการแฮชรหัสผ่าน (ห้ามใช้ bcrypt เก่า)
    *   ออก JWT Token แบบมีวันหมดอายุ และตั้งค่า HttpOnly Cookie ป้องกัน XSS
*   [ ] **Task 2.3: ระบบสร้างผังเครือข่าย MLM 5 ชั้น (Closure Table Logic)**
    *   เมื่อมีผู้สมัครใหม่ ให้ Insert ข้อมูลความสัมพันธ์ลงในตาราง `network_trees` แบบคำนวณลำดับชั้น 1 ถึง 5 โดยอัตโนมัติ

---

## ระยะที่ 3: ระบบการเงิน Micro-USD และการแบ่งรายได้ 5 ชั้น (Financial & MLM Engine)

*   [ ] **Task 3.1: พัฒนาคำนวณการเงินหน่วย Integer Micro-USD**
    *   เขียน Utility Class/Function สำหรับการคำนวณเงิน $1\text{ USD} = 1,000,000\text{ Micro-USD}$ ป้องกันปัญหา floating point error
*   [ ] **Task 3.2: พัฒนาฟังก์ชันแบ่งเงินรายได้ 5 ชั้น (`processMlmPayout`)**
    *   หัก Platform Fee $5\%$
    *   แบ่ง Net Pool ($95\%$) เข้าชั้นที่ 1 ($50\%$), ชั้นที่ 2 ($20\%$), ชั้นที่ 3 ($15\%$), ชั้นที่ 4 ($10\%$), ชั้นที่ 5 ($5\%$)
    *   อัปเดตยอดเงินในตาราง `wallets` บน D1 ด้วย Atomic Transaction
*   [ ] **Task 3.3: โยนข้อมูล Log การเงินเข้า Cloudflare Queues**
    *   ทุกครั้งที่มีการอัปเดตเงินใน D1 ให้ส่งข้อมูลธุรกรรมแบบละเอียดเข้า `financial-log-queue` เพื่อเตรียมเทลง Log Server

---

## ระยะที่ 4: ระบบรับ Log การเงินฝั่ง Mini PC (Self-Hosted PostgreSQL Log Receiver)

*   [ ] **Task 4.1: พัฒนา Fastify Log Receiver (`apps/log-receiver`)**
    *   สร้าง Web Server ด้วย Fastify + TypeScript รับ HTTP POST จาก Cloudflare Tunnel
    *   เชื่อมต่อ Native PostgreSQL ผ่าน `pg-pool` หรือ `Kysely`
*   [ ] **Task 4.2: พัฒนา Cloudflare Queues Consumer Worker**
    *   เขียน Worker Consumer ให้คอยดึง Message จาก `financial-log-queue` ส่งผ่าน Cloudflare Tunnel ไปยัง Log Receiver
    *   ตั้งค่า Retry Backoff กรณี Mini PC ออฟไลน์ เพื่อให้ Queue เก็บข้อมูลรอไว้บนคลาวด์
*   [ ] **Task 4.3: ตั้งระบบ Cron Job บีบอัดย้าย Log เก่าขึ้น R2**
    *   เขียนสคริปต์รันทุกเที่ยงคืน เช็คตาราง `logs_YYYY_MM` ที่มีอายุเกิน 90 วัน ให้ Export เป็น `.csv.gz` อัปโหลดเข้า Cloudflare R2 แล้วลบตารางออกจาก PostgreSQL

---

## ระยะที่ 5: ระบบเกม 3D Real-Time (Colyseus Game Engine)

*   [ ] **Task 5.1: ตั้งค่า Colyseus Server (Stateless & RAM-Only)**
    *   สร้าง `ShootingRoom` คลาสสืบทอดจาก Colyseus `Room`
    *   เชื่อมต่อ Local Redis สำหรับเก็บ Room Discovery / Matchmaking metadata
    *   **ห้ามใส่การเชื่อมต่อ PostgreSQL หรือ D1 โดยตรงในลูปเกม**
*   [ ] **Task 5.2: พัฒนาฟิสิกส์และการยิง (Server-Authoritative Physics)**
    *   ตั้งค่า Tick Rate $20\text{ Hz}$ ($50\text{ ms}$)
    *   ประมวลผลตำแหน่งผู้เล่น ($x, y, z$), ความเร็ว, มุมมอง, และคำนวณการยิงโดน (Raycasting / Hitbox)
*   [ ] **Task 5.3: พัฒนาหีบสมบัติ 15 วินาที (Chest Spawner)**
    *   สุ่มเกิดหีบสมบัติตามพิกัดที่กำหนดในสเปกแมปทุก 15 วินาที
    *   แจกจ่ายเงินรางวัลตาม Micro-USD ให้ผู้เล่นที่ยิงทำลายได้
*   [ ] **Task 5.4: ระบบ Batching ยิงยอดเงินกลับไปยัง Cloudflare Workers**
    *   สะสมสถิติการยิงและเงินที่ได้ใน RAM แล้วยิง API สรุปก้อนใหญ่กลับ Workers ทุก 10 วินาที หรือเมื่อผู้เล่นออกจากห้อง
*   [ ] **Task 5.5: ระบบ AFK Detection**
    *   ตรวจจับผู้เล่นนิ่งเกิน 5 นาที (แจ้งเตือน) และ 30 นาที (Auto-Kick)

---

## ระยะที่ 6: ระบบแชต 1 ต่อ 1 (`chat_YYYY_MM`)

*   [ ] **Task 6.1: สร้าง D1 Migration สำหรับ `chat_YYYY_MM`**
    *   เขียนสคริปต์สร้างตาราง `direct_messages` ในก้อน D1 ประจำเดือน
*   [ ] **Task 6.2: พัฒนา API แชต และระบบอัปโหลดรูปภาพ**
    *   รับส่งข้อความผ่าน Workers WebSocket / Polling
    *   ส่งรูปภาพ/มีเดียขึ้น Cloudflare R2 แล้วเก็บเฉพาะ URL ลงใน D1

---

## ระยะที่ 7: ระบบตรวจถอนเงิน AI & Anti-Cheat (Audit Pipeline)

*   [ ] **Task 7.1: พัฒนา Layer 1 Log Summation Verification Engine**
    *   เมื่อผู้เล่นยื่นคำขอถอนเงิน ให้ AI ยิงคำสั่งไปค้นหา PostgreSQL ย้อนหลัง 90 วันของคนนั้น
    *   รวมยอดเงิน ($\sum \text{Earned} - \sum \text{Withdrawn}$) หากตรงกับ D1 $100.00\%$ จึงจะอนุมัติ
*   [ ] **Task 7.2: พัฒนา Layer 2 Behavioral Check (Aimbot / Chest Farm Detection)**
    *   ตรวจสอบ Headshot Ratio และ Chest Collection Speed
*   [ ] **Task 7.3: พัฒนา Layer 3 Referral Network Graph Audit**
    *   ตรวจกลุ่มบัญชีม้าที่สมัครมาฆ่ากันเองในห้อง

---

## ระยะที่ 8: การทดสอบสอบทานระบบ (Integration & Verification)

*   [ ] **Task 8.1: Load Test Colyseus Game Server**
    *   จำลอง Bot 30 คน, 100 คน และ 100+ คน วิ่งยิงกันในแมปเพื่อวัด Tick Rate และการใช้ RAM
*   [ ] **Task 8.2: Failover Test Mini PC Offline**
    *   ปิดเครื่อง Mini PC จำลองไฟดับ แล้วให้ผู้เล่นเล่นเกม/หาเงิน ตรวจสอบว่า Queue กักเก็บ Log บน Cloudflare ได้ครบถ้วนเมื่อเปิด Mini PC กลับมา