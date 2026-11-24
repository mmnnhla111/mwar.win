import React from 'react';
import Link from 'next/link';
import { LemonLogo } from '../ui/Icon';

export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-4 py-10 relative overflow-hidden">
      {/* soft pastel blobs */}
      <div className="pointer-events-none absolute -top-24 -left-24 w-72 h-72 rounded-full bg-[#FFF6C2] blur-3xl opacity-70" />
      <div className="pointer-events-none absolute -bottom-24 -right-16 w-72 h-72 rounded-full bg-[#D1FAE5] blur-3xl opacity-60" />
      <div className="pointer-events-none absolute top-1/3 -right-24 w-56 h-56 rounded-full bg-[#FFE4E6] blur-3xl opacity-60" />

      <Link href="/login" className="relative flex items-center gap-2.5 mb-6" aria-label="mwar.win">
        <LemonLogo size={46} />
        <span className="font-extrabold text-2xl tracking-tight text-stone-900">
          mwar<span className="text-[#E5B800]">.win</span>
        </span>
      </Link>

      <div className="relative w-full max-w-[400px] bg-white rounded-[28px] border border-stone-200/80 shadow-[0_8px_40px_rgba(0,0,0,0.06)] p-6 sm:p-8">
        <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-stone-500 mt-1">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
      {footer && <div className="relative mt-5 text-sm text-stone-600">{footer}</div>}
      <p className="relative mt-8 text-[11px] text-stone-400">Play fair · Post kind · Have fun 🍋</p>
    </div>
  );
}

export function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor: string }) {
  return (
    <label htmlFor={htmlFor} className="block text-xs font-bold text-stone-600 mb-1.5 ml-1">
      {children}
    </label>
  );
}

export function FormError({ msg }: { msg?: string | null }) {
  if (!msg) return null;
  return <p className="rounded-2xl bg-[#FFE4E6] text-rose-600 text-sm font-semibold px-4 py-2.5">{msg}</p>;
}

export function FormSuccess({ msg }: { msg?: string | null }) {
  if (!msg) return null;
  return <p className="rounded-2xl bg-[#D1FAE5] text-emerald-700 text-sm font-semibold px-4 py-2.5">{msg}</p>;
}
