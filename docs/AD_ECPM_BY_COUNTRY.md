# Programmatic & Rewarded Ad Network eCPM Benchmarks by Country & Format

**Document ID:** `MWAR-REF-AD-ECPM-2026`  
**Target Platform:** MWAR.WIN Casual 3D Shooter & Social Commerce Engine  
**Currency Standard:** Micro-USD (`1 USD = 1,000,000 micro_usd = 10,000 MWAR Coins`)  
**Specification Date:** November 2026  
**Status:** Canonical Reference

---

## 1. Executive Summary & Mathematical Foundations

In programmatic mobile and web advertising, ad networks quote inventory pricing in **eCPM (Effective Cost Per Mille)**, representing gross revenue generated per 1,000 completed impressions or views in United States Dollars (USD).

### Core Conversion Formulas

1. **Gross Revenue per Single Impression (USD):**
   $$\text{USD per View} = \frac{\text{eCPM}}{1,000}$$

2. **Micro-USD per Single Impression:**
   $$\text{micro\_usd} = \left(\frac{\text{eCPM}}{1,000}\right) \times 1,000,000 = \text{eCPM} \times 1,000$$

3. **MWAR Coins per Single Impression:**
   $$\text{Coins} = \frac{\text{micro\_usd}}{100} = \text{eCPM} \times 10$$
   *(Since 1 Coin = 100 micro_usd = $0.0001 USD)*

### 100% Economy Revenue Split per Ad View
Every ad impression processed by the MWAR platform (via Server-to-Server postback from AdswedMedia, OnClickA, Google AdMob, AppLovin MAX, or Unity Ads) distributes 100% of the gross value $V$ according to the system specification:

| Beneficiary | Split Rate | Basis Points | Calculation Formula |
|:---|:---:|:---:|:---|
| **Ad Watcher (Shooter)** | **75%** | 7,500 bps | $\text{watcher} = \lfloor V \times 0.75 \rfloor$ |
| **Level 1 Direct Sponsor** | **5%** | 500 bps | $\text{L1} = \lfloor V \times 0.05 \rfloor$ |
| **Level 2 Upline** | **4%** | 400 bps | $\text{L2} = \lfloor V \times 0.04 \rfloor$ |
| **Level 3 Upline** | **3%** | 300 bps | $\text{L3} = \lfloor V \times 0.03 \rfloor$ |
| **Level 4 Upline** | **2%** | 200 bps | $\text{L4} = \lfloor V \times 0.02 \rfloor$ |
| **Level 5 Upline** | **1%** | 100 bps | $\text{L5} = \lfloor V \times 0.01 \rfloor$ |
| **Head Bounty Pool** | **5%** | 500 bps | Added directly to earner's 3D arena death bounty |
| **Platform System Fee** | **5% + remainder** | 500 bps + rem | Unclaimed uplines & rounding remainders roll to system |

---

## 2. Master Reference Table across Countries and Formats

All figures reflect realistic programmatic publisher net yields across mobile web and hybrid HTML5/WebAssembly gaming environments.

| Country Name | Code | Tier | Banner eCPM ($) | 5s Video eCPM ($) | 15s Video eCPM ($) | 30s Video eCPM ($) | 30s Single View (`micro_usd`) | 30s Total Coins | 75% Earner Coins |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **United States** | `US` | **Tier 1** | **$1.50** | **$6.50** | **$18.00** | **$32.00** | 32,000 µ$ | 320 | **240** |
| **Australia** | `AU` | **Tier 1** | **$1.30** | **$5.50** | **$15.00** | **$27.00** | 27,000 µ$ | 270 | **202** |
| **United Kingdom** | `GB` | **Tier 1** | **$1.20** | **$5.20** | **$14.50** | **$26.00** | 26,000 µ$ | 260 | **195** |
| **Canada** | `CA` | **Tier 1** | **$1.15** | **$5.00** | **$14.00** | **$25.00** | 25,000 µ$ | 250 | **187** |
| **Japan** | `JP` | **Tier 1** | **$1.10** | **$4.80** | **$13.50** | **$24.00** | 24,000 µ$ | 240 | **180** |
| **Germany** | `DE` | **Tier 1** | **$1.00** | **$4.50** | **$13.00** | **$23.00** | 23,000 µ$ | 230 | **172** |
| **Singapore** | `SG` | **Tier 1** | **$1.05** | **$4.60** | **$13.00** | **$22.50** | 22,500 µ$ | 225 | **168** |
| **South Korea** | `KR` | **Tier 1** | **$0.95** | **$4.20** | **$12.00** | **$21.00** | 21,000 µ$ | 210 | **157** |
| **United Arab Emirates** | `AE` | **Tier 2** | **$0.70** | **$3.00** | **$8.50** | **$15.00** | 15,000 µ$ | 150 | **112** |
| **Taiwan** | `TW` | **Tier 2** | **$0.65** | **$2.80** | **$8.00** | **$14.00** | 14,000 µ$ | 140 | **105** |
| **Saudi Arabia** | `SA` | **Tier 2** | **$0.60** | **$2.60** | **$7.50** | **$13.50** | 13,500 µ$ | 135 | **101** |
| **Malaysia** | `MY` | **Tier 2** | **$0.40** | **$1.80** | **$5.00** | **$9.50** | 9,500 µ$ | 95 | **71** |
| **Thailand** | `TH` | **Tier 2** | **$0.35** | **$1.60** | **$4.50** | **$8.50** | 8,500 µ$ | 85 | **63** |
| **Mexico** | `MX` | **Tier 2** | **$0.32** | **$1.40** | **$4.00** | **$7.50** | 7,500 µ$ | 75 | **56** |
| **Brazil** | `BR` | **Tier 2** | **$0.30** | **$1.30** | **$3.80** | **$7.00** | 7,000 µ$ | 70 | **52** |
| **Russia** | `RU` | **Tier 2** | **$0.25** | **$1.10** | **$3.20** | **$6.00** | 6,000 µ$ | 60 | **45** |
| **Turkey** | `TR` | **Tier 2** | **$0.22** | **$1.00** | **$2.90** | **$5.50** | 5,500 µ$ | 55 | **41** |
| **Vietnam** | `VN` | **Tier 3** | **$0.18** | **$0.80** | **$2.20** | **$4.20** | 4,200 µ$ | 42 | **31** |
| **Philippines** | `PH` | **Tier 3** | **$0.18** | **$0.75** | **$2.10** | **$4.00** | 4,000 µ$ | 40 | **30** |
| **Indonesia** | `ID` | **Tier 3** | **$0.16** | **$0.70** | **$2.00** | **$3.80** | 3,800 µ$ | 38 | **28** |
| **Cambodia** | `KH` | **Tier 3** | **$0.12** | **$0.55** | **$1.50** | **$2.80** | 2,800 µ$ | 28 | **21** |
| **India** | `IN` | **Tier 3** | **$0.12** | **$0.50** | **$1.40** | **$2.80** | 2,800 µ$ | 28 | **21** |
| **Myanmar** | `MM` | **Tier 3** | **$0.10** | **$0.45** | **$1.30** | **$2.50** | 2,500 µ$ | 25 | **18** |
| **Laos** | `LA` | **Tier 3** | **$0.10** | **$0.45** | **$1.30** | **$2.50** | 2,500 µ$ | 25 | **18** |
| **Bangladesh** | `BD` | **Tier 3** | **$0.08** | **$0.35** | **$1.00** | **$2.00** | 2,000 µ$ | 20 | **15** |
| **Pakistan** | `PK` | **Tier 3** | **$0.08** | **$0.35** | **$1.00** | **$2.00** | 2,000 µ$ | 20 | **15** |
| **Global Fallback** | `GLOBAL` | **Default** | **$0.25** | **$1.10** | **$3.20** | **$6.00** | 6,000 µ$ | 60 | **45** |

---

## 3. Detailed Exact Micro-USD Lookup Matrix (Per Single Impression)

To avoid floating-point inaccuracies, all financial ledgers in MWAR execute in whole integer `micro_usd` units:

| Country Code | Country Name | Banner (`320x50`) | 5s Short Video | 15s Interstitial | 30s Rewarded Video |
|:---:|:---|:---:|:---:|:---:|:---:|
| `US` | United States | `1,500 µ$` | `6,500 µ$` | `18,000 µ$` | `32,000 µ$` |
| `AU` | Australia | `1,300 µ$` | `5,500 µ$` | `15,000 µ$` | `27,000 µ$` |
| `GB` | United Kingdom | `1,200 µ$` | `5,200 µ$` | `14,500 µ$` | `26,000 µ$` |
| `CA` | Canada | `1,150 µ$` | `5,000 µ$` | `14,000 µ$` | `25,000 µ$` |
| `JP` | Japan | `1,100 µ$` | `4,800 µ$` | `13,500 µ$` | `24,000 µ$` |
| `DE` | Germany | `1,000 µ$` | `4,500 µ$` | `13,000 µ$` | `23,000 µ$` |
| `SG` | Singapore | `1,050 µ$` | `4,600 µ$` | `13,000 µ$` | `22,500 µ$` |
| `KR` | South Korea | `950 µ$` | `4,200 µ$` | `12,000 µ$` | `21,000 µ$` |
| `AE` | United Arab Emirates | `700 µ$` | `3,000 µ$` | `8,500 µ$` | `15,000 µ$` |
| `TW` | Taiwan | `650 µ$` | `2,800 µ$` | `8,000 µ$` | `14,000 µ$` |
| `SA` | Saudi Arabia | `600 µ$` | `2,600 µ$` | `7,500 µ$` | `13,500 µ$` |
| `MY` | Malaysia | `400 µ$` | `1,800 µ$` | `5,000 µ$` | `9,500 µ$` |
| `TH` | Thailand | `350 µ$` | `1,600 µ$` | `4,500 µ$` | `8,500 µ$` |
| `MX` | Mexico | `320 µ$` | `1,400 µ$` | `4,000 µ$` | `7,500 µ$` |
| `BR` | Brazil | `300 µ$` | `1,300 µ$` | `3,800 µ$` | `7,000 µ$` |
| `RU` | Russia | `250 µ$` | `1,100 µ$` | `3,200 µ$` | `6,000 µ$` |
| `TR` | Turkey | `220 µ$` | `1,000 µ$` | `2,900 µ$` | `5,500 µ$` |
| `VN` | Vietnam | `180 µ$` | `800 µ$` | `2,200 µ$` | `4,200 µ$` |
| `PH` | Philippines | `180 µ$` | `750 µ$` | `2,100 µ$` | `4,000 µ$` |
| `ID` | Indonesia | `160 µ$` | `700 µ$` | `2,000 µ$` | `3,800 µ$` |
| `KH` | Cambodia | `120 µ$` | `550 µ$` | `1,500 µ$` | `2,800 µ$` |
| `IN` | India | `120 µ$` | `500 µ$` | `1,400 µ$` | `2,800 µ$` |
| `MM` | Myanmar | `100 µ$` | `450 µ$` | `1,300 µ$` | `2,500 µ$` |
| `LA` | Laos | `100 µ$` | `450 µ$` | `1,300 µ$` | `2,500 µ$` |
| `BD` | Bangladesh | `80 µ$` | `350 µ$` | `1,000 µ$` | `2,000 µ$` |
| `PK` | Pakistan | `80 µ$` | `350 µ$` | `1,000 µ$` | `2,000 µ$` |
| `GLOBAL` | Conservative Fallback | `250 µ$` | `1,100 µ$` | `3,200 µ$` | `6,000 µ$` |

---

## 4. Market Tier Dynamics & Behavioral Analysis

### Tier 1 Markets (High-Value GDP & Fierce Bidding)
- **Countries:** `US`, `GB`, `CA`, `AU`, `DE`, `JP`, `KR`, `SG`
- **Characteristics:**
  - Premium advertiser density with aggressive performance campaigns (fintech, e-commerce, gaming IAP).
  - High eCPM variance between mobile operating systems: iOS users consistently command a 25%–40% premium over Android devices.
  - Rewarded 30s videos routinely clear **$25.00 to $40.00+ eCPM**, enabling individual ad rewards of **$0.025 to $0.040 USD (250–400 Coins)** per view.
  - Strict ad-fraud verification and stringent telemetry (IP reputation, device fingerprinting, ATT compliance).

### Tier 2 Markets (Emerging Digital Economies & Rapid Growth)
- **Countries:** `TH`, `MY`, `TW`, `AE`, `SA`, `BR`, `MX`, `RU`, `TR`
- **Characteristics:**
  - Highly active mobile gaming user bases with surging programmatic fill rates (>85%).
  - The Gulf region (`AE`, `SA`) and East Asia (`TW`) yield exceptionally strong eCPMs ($13.50–$15.00 for 30s video), approaching Tier 1 baselines.
  - Southeast Asian hubs (`TH`, `MY`) deliver healthy sustainable yields ($8.50–$9.50 eCPM), matching MWAR's target primary demographics.
  - Latin American powerhouses (`BR`, `MX`) exhibit massive engagement and stable eCPMs around $7.00–$7.50.

### Tier 3 Markets (High-Volume Scale & Southeast Asia Core)
- **Countries:** `MM`, `LA`, `KH`, `VN`, `ID`, `PH`, `IN`, `BD`, `PK`
- **Characteristics:**
  - Enormous user volume and high social sharing velocity (ideal for 5-tier MLM viral referral loops).
  - While individual impression yield is lower ($2.00–$4.20 eCPM for 30s video), user volume can be 10x–50x greater than Tier 1.
  - Serving a 30s video in Vietnam (`VN`) or Philippines (`PH`) provides **30–31 Coins** to the earner, which holds significant local micro-purchasing power.
  - In frontier Southeast Asian markets (`MM`, `LA`, `KH`), conservative baselines ($2.50–$2.80 eCPM) guarantee reliable 18–21 Coins per video.

---

## 5. Ad Format Engineering & Integration Strategy

### 1. Display Banner (`320x50` Mobile / `468x60` Tablet)
- **Integration Point:** Fixed footer or top-bar placement in non-intrusive zones (Lobby `/`, Marketplace `/marketplace`, Chat `/chat`).
- **Refresh Interval:** Standard auto-refresh timer set to **30–45 seconds** (viewability enforced via IntersectionObserver).
- **Economic Role:** Provides passive baseline revenue while players chat, browse items, or inspect MLM network trees.

### 2. 5-Second Short / Skippable Video (`5s`)
- **Integration Point:** Post-match transition screens or pre-match lobby countdowns.
- **Completion Rate:** Exceeds 92% due to minimal user friction.
- **Economic Role:** Fast micro-rewards for quick turnaround without disrupting competitive gameplay flow.

### 3. 15-Second Interstitial / Rewarded Video (`15s`)
- **Integration Point:** Practice arena death respawn, or 1-ticket mini recharge.
- **Market Alignment:** Matches modern short-form video consumption habits (TikTok/Reels format).
- **Economic Role:** High conversion velocity, balancing good eCPM with excellent player retention.

### 4. 30-Second Full Rewarded Video (`30s`)
- **Integration Point:**
  - Daily Quest `Q_WATCH_AD` ("Watch 2 rewarded video ads").
  - Energy Ticket (`EC`) instant recharge (+1 EC or +50% progress).
  - Cash Arena Victory multiplier.
- **Completion Rate:** High value exchange ensures 90–95% completion.
- **Economic Role:** Primary revenue driver for the 75/15/5/5 distribution engine and head bounty pool accumulation.

---

## 6. Implementation Reference

The values in this specification are codified as typed constants in `@mwar/shared`:
- Source file: `packages/shared/src/constants/adEcpm.ts`
- Exported matrix: `COUNTRY_AD_ECPM_USD`
- Helper function:
  ```ts
  getStatisticalAdMicroUsd(countryCode?: string | null, format?: AdFormat): number
  ```

When an ad network S2S postback does not provide an explicit `payout` or `reward_usd` query parameter, or when the system operates in local development mode (`DEV_MOCK_MODE=true`), `processAdReward()` in `apps/api-worker/src/routes/ads.ts` invokes `getStatisticalAdMicroUsd(country, 'video_30s')` to obtain the exact statistical payout.
