import { z } from 'zod';

/** Player cashout ($10 minimum) + 3-layer anti-cheat audit (migration 0019). */
export const CASHOUT_MIN_MICRO_USD = 10_000_000; // $10.00
export const CASHOUT_MAX_MICRO_USD = 5_000_000_000; // $5,000 per request (sanity cap)

export const PAYOUT_METHODS = ['usdt_trc20', 'usdt_bep20', 'promptpay', 'bank_transfer'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

/** Flat fee per method (Micro-USD), shown to the player before submitting. */
export const PAYOUT_FEE_MICRO_USD: Record<PayoutMethod, number> = {
  usdt_trc20: 500_000, // $0.50
  usdt_bep20: 500_000,
  promptpay: 500_000,
  bank_transfer: 500_000,
};

export type CashoutStatus = 'pending' | 'ai_verifying' | 'approved' | 'flagged_review' | 'rejected';

const ACCOUNT_RULES: Record<PayoutMethod, { re: RegExp; hint: string }> = {
  usdt_trc20: { re: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, hint: 'TRC20 address starts with T (34 characters)' },
  usdt_bep20: { re: /^0x[a-fA-F0-9]{40}$/, hint: 'BEP20 address is 0x + 40 hex characters' },
  // PromptPay: phone 0XXXXXXXXX, 13-digit national / tax ID, or 15-digit e-wallet ID
  promptpay: { re: /^(0\d{9}|\d{13}|\d{15})$/, hint: 'PromptPay = phone (10 digits), ID (13) or e-wallet (15)' },
  // Bank: "Bank name / account number / account name" (account number 6–20 digits)
  bank_transfer: { re: /^(?=.*\d{6,20})[\p{L}\p{N} .,/()_-]{8,120}$/u, hint: 'Bank / account number / account name' },
};

/** Removes spaces and dashes from number-only methods (people paste "081-234-5678"). */
export function normalizePayoutAccount(method: PayoutMethod, raw: string): string {
  const s = String(raw || '').trim();
  return method === 'promptpay' ? s.replace(/[\s-]/g, '') : method === 'bank_transfer' ? s.replace(/\s+/g, ' ') : s.replace(/\s/g, '');
}

export function validatePayoutAccount(method: PayoutMethod, raw: string): string | null {
  const v = normalizePayoutAccount(method, raw);
  return ACCOUNT_RULES[method].re.test(v) ? null : ACCOUNT_RULES[method].hint;
}

/** "TQn9…4kLm", "081****678", "Kasikorn / ******7890 / …" — for every view except the owner's form and super_admin. */
export function maskPayoutAccount(method: string, account: string | null | undefined): string {
  const a = String(account || '');
  if (!a) return '';
  if (method === 'usdt_trc20' || method === 'usdt_bep20') return a.length > 10 ? `${a.slice(0, 5)}…${a.slice(-4)}` : '••••';
  if (method === 'promptpay') return a.length > 6 ? `${a.slice(0, 3)}${'*'.repeat(Math.max(3, a.length - 6))}${a.slice(-3)}` : '••••';
  // bank: keep the bank name, mask digits except the last 4
  const digits = a.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  const bank = a.split('/')[0].trim().slice(0, 24);
  return `${bank} / ******${last4}`;
}

export const CashoutCreateSchema = z
  .object({
    amount_micro_usd: z
      .number()
      .int('Amount must be an integer Micro-USD')
      .min(CASHOUT_MIN_MICRO_USD, 'Minimum cashout amount is $10.00')
      .max(CASHOUT_MAX_MICRO_USD, 'Maximum cashout per request is $5,000'),
    payout_method: z.enum(PAYOUT_METHODS),
    payout_account: z.string().min(4).max(160),
  })
  .superRefine((d, ctx) => {
    const err = validatePayoutAccount(d.payout_method, d.payout_account);
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payout_account'], message: err });
  });
export type CashoutCreateInput = z.infer<typeof CashoutCreateSchema>;

export const CashoutReviewSchema = z.object({
  withdrawal_id: z.string().uuid(),
  action: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(255).optional(),
  /** Reject only: keep the Layer-3 collusive earnings for the platform instead of refunding them. */
  forfeit_collusive: z.boolean().optional(),
});

// ---- 3-layer audit report (stored in withdrawal_requests.audit_report_json) ----------------------
export type FlagSeverity = 'low' | 'medium' | 'critical';

export interface AuditLayer1 {
  status: 'match' | 'mismatch';
  /** Σ credits − Σ debits from the D1 wallet ledger, after this request's own debit. */
  expectedBalanceMicroUsd: number;
  actualBalanceMicroUsd: number;
  diffMicroUsd: number;
  creditsMicroUsd: number;
  withdrawalsMicroUsd: number;
  purchasesMicroUsd: number;
  otherDebitsMicroUsd: number;
  ledgerRows: number;
  /** Mini PC PostgreSQL cross-check (only when LOG_RECEIVER_URL is configured). */
  postgres: { status: 'match' | 'mismatch' | 'unreachable' | 'not_configured'; calculatedMicroUsd?: number; reason?: string };
}

export interface AuditLayer2 {
  status: 'clean' | 'suspicious';
  kills: number;
  hits: number;
  headshots: number;
  headshotRatio: number | null;
  chests: number;
  /** Highest chest-count z-score in a room (≥ 11 players needed for 3σ to be reachable). */
  maxChestZ: number | null;
  reasons: string[];
}

export interface AuditLayer3 {
  status: 'clean' | 'suspicious' | 'collusion';
  kills: number;
  suspiciousKills: number;
  collusionRatio: number;
  sharedIpPartners: number;
  sharedDevicePartners: number;
  referralLoopPartners: number;
  collusiveEarningsMicroUsd: number;
  topPartners: Array<{ userId: string; username: string | null; kills: number; reasons: string[] }>;
}

export interface CashoutAuditReport {
  version: 1;
  ranAt: number;
  score: number;
  decision: 'pending' | 'flagged_review';
  layer1: AuditLayer1;
  layer2: AuditLayer2;
  layer3: AuditLayer3;
  openFlags: number;
  flagsCreated: Array<{ layer: 1 | 2 | 3; type: string; severity: FlagSeverity }>;
}

export interface CashoutItem {
  id: string;
  amountMicroUsd: number;
  feeMicroUsd: number;
  netPayoutMicroUsd: number;
  payoutMethod: PayoutMethod;
  /** Masked except for super_admin. */
  payoutAccount: string;
  status: CashoutStatus;
  aiAuditScore: number | null;
  rejectReason: string | null;
  createdAt: number;
  processedAt: number | null;
}

export interface AdminCashoutItem extends CashoutItem {
  userId: string;
  username: string;
  reviewedBy: string | null;
  forfeitedMicroUsd: number;
  report: CashoutAuditReport | null;
}
