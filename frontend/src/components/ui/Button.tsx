import React from 'react';
import { Link } from 'react-router-dom';

type Variant = 'primary' | 'accent' | 'secondary' | 'ghost';
type Size = 'md' | 'sm';

const cls = (variant: Variant, size: Size, extra?: string) =>
  [`btn-${variant}`, size === 'sm' ? 'btn-sm' : '', extra].filter(Boolean).join(' ');

interface CommonProps { variant?: Variant; size?: Size; className?: string; children: React.ReactNode }

/** <button>. Use ButtonLink for navigation. */
export const Button: React.FC<CommonProps & React.ButtonHTMLAttributes<HTMLButtonElement>> = ({
  variant = 'primary', size = 'md', className, type = 'button', children, ...rest
}) => (
  <button type={type} className={cls(variant, size, className)} {...rest}>{children}</button>
);

/** A react-router <Link> that looks like a button. */
export const ButtonLink: React.FC<CommonProps & { to: string } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>> = ({
  variant = 'primary', size = 'md', className, to, children, ...rest
}) => (
  <Link to={to} className={cls(variant, size, className)} {...rest}>{children}</Link>
);
