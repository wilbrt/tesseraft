import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  onClose: () => void;
  open: boolean;
  testId?: string;
};

type Position = { left: number; top: number; minWidth: number; maxHeight: number };

/**
 * A viewport-anchored overlay rendered outside application layout containers.
 * Portalling prevents headers, tables, and panels with overflow rules from
 * clipping menus while preserving a stable anchor for responsive positioning.
 */
export const Popover = ({ anchorRef, children, className = '', onClose, open, testId }: Props): JSX.Element | null => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position>({ left: 8, top: 8, minWidth: 192, maxHeight: 320 });

  useLayoutEffect(() => {
    if (!open) return undefined;
    const updatePosition = (): void => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const anchorBox = anchor.getBoundingClientRect();
      const popoverBox = popoverRef.current?.getBoundingClientRect();
      const margin = 8;
      const gap = 4;
      const width = Math.max(anchorBox.width, popoverBox?.width || 192);
      const left = Math.max(margin, Math.min(anchorBox.left, window.innerWidth - width - margin));
      const spaceBelow = window.innerHeight - anchorBox.bottom - margin - gap;
      const spaceAbove = anchorBox.top - margin - gap;
      const useAbove = Boolean(popoverBox && popoverBox.height > spaceBelow && spaceAbove > spaceBelow);
      const top = useAbove
        ? Math.max(margin, anchorBox.top - (popoverBox?.height || 0) - gap)
        : anchorBox.bottom + gap;
      setPosition({ left, top, minWidth: anchorBox.width, maxHeight: Math.max(96, useAbove ? spaceAbove : spaceBelow) });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorRef, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (!anchorRef.current?.contains(target) && !popoverRef.current?.contains(target)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        anchorRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchorRef, onClose, open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={popoverRef}
      className={`popover-layer ${className}`.trim()}
      data-testid={testId}
      style={{ left: position.left, top: position.top, minWidth: position.minWidth, maxHeight: position.maxHeight }}
    >
      {children}
    </div>,
    document.body
  );
};
