# คู่มือทักษะและมาตรฐานโค้ดสำหรับ AI Agent (Antigravity Skills & Guidelines)

ไฟล์นี้สรุปทักษะ ข้อกำหนดทางเทคนิค มาตรฐานความปลอดภัย และข้อจำกัด เพื่อให้ AI Agent (Google Antigravity) ใช้เป็นบริบทในการเขียนโค้ด (Prompt Rules & Modern Standards) ป้องกันการสับสนหรือใช้โค้ดตระกูลเก่าที่มีช่องโหว่

---

## 1. ทักษะการวางผังแมป 3D เกมยิงปืน (3D Map Architecture & Sizing Specs)

ในการเขียนโค้ดวางพิกัดวัตถุในเกม (Colyseus / Three.js / Unity) ให้ใช้อัตราส่วนขนาดแมป ความหนาแน่นของตึก ป่า และจุดเกิดหีบสมบัติ ดังนี้:

### 1.1 ตารางสเปกขนาดแมป (Map Dimensions & Density Matrix)

| สเปก / ขนาดห้อง | ห้องขนาดเล็ก (30 คน) | ห้องขนาดกลาง (100 คน) | ห้องขนาดใหญ่ (100+ คน / Warzone) |
| :--- | :--- | :--- | :--- |
| **ขนาดพื้นที่ ($X \times Z$)** | **$250\text{ m} \times 250\text{ m}$** ($62,500\text{ m}^2$) | **$600\text{ m} \times 600\text{ m}$** ($360,000\text{ m}^2$) | **$1,000\text{ m} \times 1,000\text{ m}$** ($1,000,000\text{ m}^2$) |
| **ความหนาแน่นตึก/สิ่งปลูกสร้าง** | $25\%$ ของพื้นที่ (ประมาณ 8–12 หลัง) | $35\%$ ของพื้นที่ (ประมาณ 40–60 หลัง) | $40\%$ ของพื้นที่ (ประมาณ 120+ หลัง) |
| **โซนป่าไม้/ทิวเขา (Forest/Foliage)** | $30\%$ (ล้อมรอบเมือง/จุดซุ่ม) | $35\%$ (ผืนป่าใหญ่เชื่อมระหว่างโซน) | $40\%$ (ป่าทึบ เขาลูกใหญ่ ร่องน้ำ) |
| **พื้นที่โล่ง/ถนน (Open Tactical Zones)** | $45\%$ | $30\%$ | $20\%$ |
| **จำนวนจุดเกิดหีบสมบัติ 15 วิ** | 10–15 จุด (เกิดสุ่มครั้งละ 2–3 หีบ) | 35–50 จุด (เกิดสุ่มครั้งละ 8–10 หีบ) | 100+ จุด (เกิดสุ่มครั้งละ 20–25 หีบ) |
| **ระยะการมองเห็นชัด (Sightlines)** | ไม่เกิน $80\text{ m}$ (บังด้วยตึก/ต้นไม้) | ไม่เกิน $120\text{ m}$ | ไม่เกิน $200\text{ m}$ (เน้นสไนเปอร์) |

### 1.2 กฎการวางสิ่งกีดขวาง (Obstacle Placement Rules)
*   **ตึก (Buildings):** ต้องมีทางเข้าอย่างน้อย 2 ทางเสมอ (ป้องกันคนซุ่มทางเดียว) และตั้งค่า Collision Box ให้กระชับ
*   **ป่าไม้ (Forest):** ต้นไม้ต้องมีระยะห่างระหว่างต้น $3–5\text{ เมตร}$ เพื่อให้ผู้เล่นเดินผ่านได้โดยไม่ติด Collider แต่บังวิศัยทัศน์การยิง
*   **หีบสมบัติ (Chests):** สุ่มเกิดเฉพาะจุดบนพื้นราบหรือบนดาดฟ้าตึก (ห้ามเกิดจมในวัตถุหรือกลางอากาศ)

---

## 2. ทักษะความปลอดภัย Web & TypeScript (TypeScript Web & Worker Security Rules)

 Agent ต้องปฏิบัติตามมาตรฐานความปลอดภัยต่อไปนี้อย่างเคร่งครัดในการเขียนโค้ด TypeScript บน Cloudflare Workers และ Node.js:

### 2.1 ป้องกัน SQL Injection บน Cloudflare D1 100%
*   **ห้าม:** ใช้ String Concatenation หรือ Template Literals ในการต่อ SQL Query เด็ดขาด
    ```typescript
    // ❌ ห้ามทำเด็ดขาด (มีช่องโหว่ SQL Injection)
    const result = await env.DB.prepare(`SELECT * FROM users WHERE username = '${input}'`).bind();
    ```
*   **ต้อง:** ใช้ Parameterized Binding (`.bind()`) เท่านั้น
    ```typescript
    // ✅ มาตรฐานที่ถูกต้อง
    const result = await env.DB.prepare("SELECT * FROM users WHERE username = ?1").bind(input).first();
    ```

### 2.2 Strict Schema Validation ด้วย Zod
*   ข้อมูลที่รับมาจาก HTTP Request Body, Query String หรือ WebSockets **ต้องถูก Validate ด้วย Zod Schema** ก่อนนำไปประมวลผลเสมอ
    ```typescript
    import { z } from "zod";

    export const RegisterSchema = z.object({
      username: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/),
      email: z.string().email(),
      password: z.string().min(8),
      referrer_id: z.string().uuid().optional(),
    });
    ```

### 2.3 การจัดการตัวเลขการเงิน Micro-USD (Safe Integer Arithmetic)
*   **ห้าม:** ใช้ชนิดข้อมูล `number` (Float) ของ JS ในการบวกลบคูณหารคำนวณเงินเด็ดขาด
*   **ต้อง:** ปรับเงินเป็น integer Micro-USD ($1\text{ USD} = 1,000,000$) และใช้ `Math.floor()` หรือ `BigInt` ในการคำนวณส่วนแบ่ง MLM 5 ชั้น เพื่อให้ได้ผลลัพธ์เป็นจำนวนเต็มเสมอ

### 2.4 การแฮชรหัสผ่านและการจัดการ Token
*   ใช้ **Argon2id** (`argon2` npm package) สำหรับ Node.js หรือใช้ **WebCrypto SubtleCrypto API** บน Cloudflare Workers
*   ตั้งค่า CORS Header ให้ระบุ Domain ที่อนุญาตแบบเจาะจง (ห้ามใส่ `Access-Control-Allow-Origin: *` สำหรับ API ที่เกี่ยวข้องกับการเงิน)

---

## 3. ทักษะ Colyseus Game Engine เวอร์ชันปัจจุบัน (Modern Colyseus Best Practices)

 Agent ต้องเขียนโค้ด Colyseus ตามโครงสร้างเวอร์ชัน $v0.15+$ ดังนี้:

### 3.1 โครงสร้าง Schema การเก็บสถานะ (State Management)
*   ใช้ Decorator `@type` ร่วมกับ `Schema`, `MapSchema`, หรือ `ArraySchema` จาก `@colyseus/schema`
    ```typescript
    import { Schema, MapSchema, type } from "@colyseus/schema";

    export class PlayerState extends Schema {
      @type("string") id: string = "";
      @type("number") x: number = 0;
      @type("number") y: number = 0;
      @type("number") z: number = 0;
      @type("number") health: number = 100;
      @type("number") microUsdBalance: number = 0;
      @type("boolean") isProp: boolean = false; // แปลงร่างเป็นกล่องไม้
    }

    export class GameRoomState extends Schema {
      @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
    }
    ```

### 3.2 กฎความเร็วและการห้ามต่อ DB ในลูปเกม (Stateless Engine Rules)
*   **ห้าม:** เรียกใช้งาน `async/await` ไปยัง D1, PostgreSQL หรือ external API ภายในลูปประมวลผลเกม (`this.setSimulationInterval()`) เด็ดขาด เพราะจะทำให้ห้องเกมกระตุก (Lag)
*   **ต้อง:** สะสมสถิติธุรกรรมการเงินไว้ใน RAM ของ Colyseus State แล้วใช้ `this.clock.setInterval()` ส่งสรุปข้อมูลแบบก้อน (Batching) ไปยัง Cloudflare Workers ทุกๆ $10\text{ วินาที}$

### 3.3 ระบบตรวจจับและตัดผู้เล่น AFK (AFK Timer Logic)
```typescript
// ตัวอย่างรูปแบบการรับส่งการเคลื่อนไหวเพื่อรีเซ็ตเวลา AFK
onMessage("player_move", (client, data) => {
  const player = this.state.players.get(client.sessionId);
  if (player) {
    player.x = data.x;
    player.y = data.y;
    player.z = data.z;
    player.lastActiveTime = Date.now(); // อัปเดตเวลาทำกิจกรรมล่าสุด
  }
});
```