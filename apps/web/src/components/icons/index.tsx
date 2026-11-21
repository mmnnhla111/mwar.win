import React from 'react';

interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
  className?: string;
}

// 1. Energy Ticket (EC) Icon
export function EnergyTicketIcon({ size = 24, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} {...props}>
      <defs>
        <linearGradient id="ecGrad" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FBBF24" />
          <stop offset="0.5" stopColor="#F59E0B" />
          <stop offset="1" stopColor="#D97706" />
        </linearGradient>
        <linearGradient id="ecBolt" x1="16" y1="6" x2="16" y2="26" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#FEF3C7" />
        </linearGradient>
      </defs>
      {/* Ticket Base */}
      <path
        d="M6 8C6 6.89543 6.89543 6 8 6H24C25.1046 6 26 6.89543 26 8V13C24.3431 13 23 14.3431 23 16C23 17.6569 24.3431 19 26 19V24C26 25.1046 25.1046 26 24 26H8C6.89543 26 6 25.1046 6 24V19C7.65685 19 9 17.6569 9 16C9 14.3431 7.65685 13 6 13V8Z"
        fill="url(#ecGrad)"
        stroke="#78350F"
        strokeWidth="1.5"
      />
      {/* Lightning Bolt */}
      <path
        d="M17 7L11 17H16L15 25L21 15H16L17 7Z"
        fill="url(#ecBolt)"
        stroke="#B45309"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 2. Gold Coin Icon
export function GoldCoinIcon({ size = 24, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} {...props}>
      <defs>
        <radialGradient id="coinGlow" cx="0.35" cy="0.3" r="0.65">
          <stop stopColor="#FFFBEB" />
          <stop offset="0.4" stopColor="#F59E0B" />
          <stop offset="1" stopColor="#B45309" />
        </radialGradient>
      </defs>
      <circle cx="16" cy="16" r="14" fill="url(#coinGlow)" stroke="#78350F" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="11" stroke="#FDE68A" strokeWidth="1" strokeDasharray="2 2" />
      <path
        d="M16 9L18.06 13.56L23 14.12L19.33 17.47L20.31 22.35L16 19.89L11.69 22.35L12.67 17.47L9 14.12L13.94 13.56L16 9Z"
        fill="#FFFFFF"
        fillOpacity="0.9"
      />
    </svg>
  );
}

// 3. USD Dollar Icon
export function UsdDollarIcon({ size = 24, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} {...props}>
      <defs>
        <linearGradient id="usdGrad" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#34D399" />
          <stop offset="0.6" stopColor="#10B981" />
          <stop offset="1" stopColor="#047857" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="14" fill="url(#usdGrad)" stroke="#064E3B" strokeWidth="1.5" />
      <text
        x="16"
        y="21.5"
        textAnchor="middle"
        fill="#FFFFFF"
        fontSize="16"
        fontWeight="900"
        fontFamily="system-ui, sans-serif"
      >
        $
      </text>
    </svg>
  );
}

// 4. Network Tree Icon
export function NetworkTreeIcon({ size = 24, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} {...props}>
      <defs>
        <linearGradient id="netGrad" x1="6" y1="4" x2="26" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#38BDF8" />
          <stop offset="1" stopColor="#6366F1" />
        </linearGradient>
      </defs>
      {/* Connection Lines */}
      <path d="M16 11V18M16 18H9V21M16 18H23V21" stroke="#38BDF8" strokeWidth="2" strokeLinecap="round" />
      {/* Root Node */}
      <circle cx="16" cy="8" r="4.5" fill="url(#netGrad)" stroke="#0284C7" strokeWidth="1.5" />
      {/* Downline Nodes */}
      <circle cx="9" cy="24" r="3.5" fill="url(#netGrad)" stroke="#0284C7" strokeWidth="1.2" />
      <circle cx="23" cy="24" r="3.5" fill="url(#netGrad)" stroke="#0284C7" strokeWidth="1.2" />
    </svg>
  );
}

// 5. Fight Combat Emblem
export function FightEmblemIcon({ size = 28, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} {...props}>
      <defs>
        <linearGradient id="fightGrad" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#EF4444" />
          <stop offset="0.5" stopColor="#DC2626" />
          <stop offset="1" stopColor="#7F1D1D" />
        </linearGradient>
      </defs>
      {/* Crossed Daggers */}
      <path
        d="M6 6L14 14M26 6L18 14M16 12L16 26M13 26H19"
        stroke="#FFFFFF"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="14" r="11" stroke="url(#fightGrad)" strokeWidth="2.5" fill="none" />
      <polygon points="16,3 19,8 13,8" fill="#F87171" />
    </svg>
  );
}

// 6. Story / Reels Icon
export function StoryReelIcon({ size = 24, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} {...props}>
      <defs>
        <linearGradient id="storyGrad" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F43F5E" />
          <stop offset="0.5" stopColor="#D946EF" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <rect x="5" y="4" width="22" height="24" rx="6" fill="url(#storyGrad)" stroke="#FFFFFF" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="6" stroke="#FFFFFF" strokeWidth="2" fill="none" />
      <circle cx="21" cy="9" r="1.5" fill="#FFFFFF" />
    </svg>
  );
}

// 7. Lock Grey (Locked MLM) Icon
export function LockGreyIcon({ size = 20, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} {...props}>
      <rect x="5" y="10" width="14" height="11" rx="2.5" fill="#475569" stroke="#64748B" strokeWidth="1.5" />
      <path d="M8 10V7C8 4.79086 9.79086 3 12 3C14.2091 3 16 4.79086 16 7V10" stroke="#94A3B8" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="15" r="1.5" fill="#CBD5E1" />
    </svg>
  );
}

// 8. Unlock Green (Unlocked MLM) Icon
export function UnlockGreenIcon({ size = 20, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} {...props}>
      <defs>
        <linearGradient id="greenLockGrad" x1="4" y1="10" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#10B981" />
          <stop offset="1" stopColor="#059669" />
        </linearGradient>
      </defs>
      <rect x="5" y="10" width="14" height="11" rx="2.5" fill="url(#greenLockGrad)" stroke="#34D399" strokeWidth="1.5" />
      <path d="M8 10V7C8 4.79086 9.79086 3 12 3C13.8 3 15.3 4.2 15.8 5.8" stroke="#34D399" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="15" r="1.5" fill="#FFFFFF" />
    </svg>
  );
}

// 9. Bounty Treasure Chest Icon (15s)
export function BountyChestIcon({ size = 24, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} {...props}>
      <defs>
        <linearGradient id="chestGrad" x1="4" y1="6" x2="28" y2="26" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F59E0B" />
          <stop offset="0.5" stopColor="#B45309" />
          <stop offset="1" stopColor="#78350F" />
        </linearGradient>
      </defs>
      <rect x="5" y="14" width="22" height="13" rx="2" fill="url(#chestGrad)" stroke="#451A03" strokeWidth="1.5" />
      <path d="M5 14C5 9.5 9 6 16 6C23 6 27 9.5 27 14H5Z" fill="#D97706" stroke="#451A03" strokeWidth="1.5" />
      <rect x="13.5" y="13" width="5" height="5" rx="1" fill="#FDE68A" stroke="#78350F" strokeWidth="1" />
      <line x1="5" y1="14" x2="27" y2="14" stroke="#FEF3C7" strokeWidth="1.5" />
    </svg>
  );
}

// 10. Prop Crate Disguise Icon
export function PropCrateIcon({ size = 24, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} {...props}>
      <rect x="5" y="5" width="22" height="22" rx="2" fill="#92400E" stroke="#451A03" strokeWidth="1.5" />
      <line x1="5" y1="5" x2="27" y2="27" stroke="#B45309" strokeWidth="1.5" />
      <line x1="27" y1="5" x2="5" y2="27" stroke="#B45309" strokeWidth="1.5" />
      <rect x="7" y="7" width="18" height="18" fill="none" stroke="#78350F" strokeWidth="1" />
    </svg>
  );
}

// 11. Ghost Spectator Icon
export function GhostSpectatorIcon({ size = 24, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} {...props}>
      <defs>
        <linearGradient id="ghostGrad" x1="6" y1="4" x2="26" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#C084FC" />
          <stop offset="1" stopColor="#6366F1" />
        </linearGradient>
      </defs>
      <path
        d="M7 16C7 10 11 5 16 5C21 5 25 10 25 16V26L21.5 23.5L18 26L16 24L14 26L10.5 23.5L7 26V16Z"
        fill="url(#ghostGrad)"
        stroke="#4C1D95"
        strokeWidth="1.5"
      />
      <ellipse cx="12" cy="13" rx="2" ry="3" fill="#1E1B4B" />
      <ellipse cx="20" cy="13" rx="2" ry="3" fill="#1E1B4B" />
      <circle cx="12.5" cy="12" r="0.8" fill="#FFFFFF" />
      <circle cx="20.5" cy="12" r="0.8" fill="#FFFFFF" />
    </svg>
  );
}

// 12. Daily Quest Badges:
// 12a. Video Ad Quest
export function QuestAdVideoIcon({ size = 24, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} {...props}>
      <rect x="4" y="6" width="24" height="18" rx="4" fill="#3B82F6" stroke="#1D4ED8" strokeWidth="1.5" />
      <polygon points="13,11 21,15 13,19" fill="#FFFFFF" />
      <line x1="12" y1="27" x2="20" y2="27" stroke="#1D4ED8" strokeWidth="2" strokeLinecap="round" />
      <line x1="16" y1="24" x2="16" y2="27" stroke="#1D4ED8" strokeWidth="2" />
    </svg>
  );
}

// 12b. Crosshair Match Play Quest
export function QuestCrosshairIcon({ size = 24, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} {...props}>
      <circle cx="16" cy="16" r="10" stroke="#EF4444" strokeWidth="2" />
      <circle cx="16" cy="16" r="4" fill="#EF4444" />
      <line x1="16" y1="3" x2="16" y2="9" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" />
      <line x1="16" y1="23" x2="16" y2="29" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" />
      <line x1="3" y1="16" x2="9" y2="16" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" />
      <line x1="23" y1="16" x2="29" y2="16" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// 12c. Spectate Eye Quest
export function QuestSpectateIcon({ size = 24, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} {...props}>
      <path
        d="M4 16C4 16 8 8 16 8C24 8 28 16 28 16C28 16 24 24 16 24C8 24 4 16 4 16Z"
        fill="#4338CA"
        stroke="#818CF8"
        strokeWidth="1.8"
      />
      <circle cx="16" cy="16" r="5" fill="#E0E7FF" stroke="#312E81" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="2.5" fill="#312E81" />
    </svg>
  );
}

// 12d. Chat Bubble Quest
export function QuestChatIcon({ size = 24, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} {...props}>
      <path
        d="M6 8C6 6.34315 7.34315 5 9 5H23C24.6569 5 26 6.34315 26 8V19C26 20.6569 24.6569 22 23 22H13L7 27V22H9C7.34315 22 6 20.6569 6 19V8Z"
        fill="#10B981"
        stroke="#047857"
        strokeWidth="1.5"
      />
      <circle cx="11" cy="13.5" r="1.5" fill="#FFFFFF" />
      <circle cx="16" cy="13.5" r="1.5" fill="#FFFFFF" />
      <circle cx="21" cy="13.5" r="1.5" fill="#FFFFFF" />
    </svg>
  );
}

// 12e. Daily Check-in Quest
export function QuestCheckinIcon({ size = 24, className = '', ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} {...props}>
      <rect x="5" y="7" width="22" height="20" rx="4" fill="#F59E0B" stroke="#B45309" strokeWidth="1.5" />
      <path d="M5 12H27" stroke="#78350F" strokeWidth="1.5" />
      <line x1="10" y1="4" x2="10" y2="8" stroke="#78350F" strokeWidth="2" strokeLinecap="round" />
      <line x1="22" y1="4" x2="22" y2="8" stroke="#78350F" strokeWidth="2" strokeLinecap="round" />
      <path d="M11 19L14.5 22.5L21 16" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
