import type { ReactNode } from 'react';

/**
 * Корень хрома редактора локации. Краски живут в public/ui/editor-chrome.css
 * (класс .uk-editor): тот же файл мост KNS Paint вешает на свою страницу.
 * Сюда не переносится логика инструментов — только общая оболочка.
 */
export function EditorShell({
  label,
  className,
  collapsed,
  children,
}: {
  label: string;
  className?: string;
  collapsed?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={className ? `uk-editor ${className}` : 'uk-editor'} data-collapsed={collapsed} aria-label={label}>
      {children}
    </div>
  );
}
