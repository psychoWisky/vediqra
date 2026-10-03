import React from 'react';

type Tone = 'neutral' | 'accent' | 'dark' | 'danger';

export const Badge: React.FC<{ tone?: Tone; className?: string; children: React.ReactNode }> = ({ tone = 'neutral', className = '', children }) => (
  <span className={`badge-${tone} ${className}`}>{children}</span>
);
