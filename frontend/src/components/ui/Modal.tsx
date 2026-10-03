import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** Tailwind max-width class for the panel (centre placement). */
  widthClass?: string;
  /** centre = dialog (bottom sheet on phones); left / right = full-height drawer. */
  placement?: 'center' | 'left' | 'right';
  /** Hide the visual title bar text (the title stays as the accessible name). */
  hideTitle?: boolean;
}

const FOCUSABLE = 'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

/**
 * Accessible dialog: role=dialog + aria-modal, labelled by its title, closes on Escape / backdrop click,
 * traps Tab inside, locks page scroll and returns focus to whatever opened it.
 */
export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, widthClass = 'max-w-2xl', placement = 'center', hideTitle = false }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // keep the latest onClose without re-running the focus effect (which would steal focus on every parent render)
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { closeRef.current(); return; }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const isDrawer = placement !== 'center';
  const wrapper = isDrawer
    ? `fixed inset-0 z-[60] flex ${placement === 'right' ? 'justify-end' : 'justify-start'}`
    : 'fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4';
  const panel = isDrawer
    ? `relative flex h-full w-full max-w-md flex-col bg-white shadow-pop focus:outline-none`
    : `relative flex max-h-[90vh] w-full ${widthClass} flex-col rounded-t-2xl bg-white shadow-pop focus:outline-none sm:rounded-2xl`;

  return (
    <div className={wrapper} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-brand-ink/50" aria-hidden="true" onMouseDown={onClose} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={panel}>
        <div className="flex items-center justify-between border-b border-brand-line px-5 py-4 sm:px-6">
          <h2 id={titleId} className={hideTitle ? 'sr-only' : 'text-lg font-bold'}>{title}</h2>
          {hideTitle && <span aria-hidden="true" />}
          <button type="button" onClick={onClose} aria-label="Close" className="btn-ghost btn-sm !px-2">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{isDrawer ? children : <div className="px-5 py-5 sm:px-6">{children}</div>}</div>
      </div>
    </div>
  );
};
