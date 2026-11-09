import { lazy, Suspense, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { camelotAsset } from './CamelotEntrance';

const KnightModel = lazy(() => import('./KnightModel'));

export function AssistantDock({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const position = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const sheetGesture = useRef<{ id: number; y: number } | null>(null);
  const sheetSwiped = useRef(false);

  function placePanel(x: number, y: number) {
    const element = panel.current;
    if (!element || !element.offsetWidth) return;
    const left = Math.max(8, Math.min(x, window.innerWidth - element.offsetWidth - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - element.offsetHeight - 8));
    position.current = { x: left, y: top };
    element.dataset.positioned = 'true';
    element.style.setProperty('--dock-left', `${left}px`);
    element.style.setProperty('--dock-top', `${top}px`);
  }

  useEffect(() => {
    if (!open || !panel.current) return;
    const element = panel.current;
    const mobile = window.matchMedia('(max-width: 560px)');
    const viewport = window.visualViewport;
    function fitViewport() {
      if (!mobile.matches && position.current) placePanel(position.current.x, position.current.y);
      element.style.setProperty('--dock-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
      element.style.setProperty('--dock-keyboard-inset',
        `${Math.max(0, window.innerHeight - (viewport ? viewport.height + viewport.offsetTop : window.innerHeight))}px`);
    }
    fitViewport();
    const observer = new ResizeObserver(fitViewport);
    observer.observe(element);
    window.addEventListener('resize', fitViewport);
    viewport?.addEventListener('resize', fitViewport);
    viewport?.addEventListener('scroll', fitViewport);
    if (mobile.matches) {
      const messages = element.querySelector('.assistant-messages');
      messages?.scrollTo(0, 0);
    }
    close.current?.focus({ preventScroll: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fitViewport);
      viewport?.removeEventListener('resize', fitViewport);
      viewport?.removeEventListener('scroll', fitViewport);
    };
  }, [open]);

  function dismiss() {
    setExpanded(false);
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (!open) return;
    function onDocumentKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      dismiss();
    }
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => document.removeEventListener('keydown', onDocumentKeyDown);
  }, [open]);

  const illustration = <img src={camelotAsset('card-knight.svg')} alt="" />;

  function startDrag(event: PointerEvent<HTMLElement>) {
    if (event.pointerType !== 'mouse' || event.button !== 0 ||
        window.matchMedia('(max-width: 560px)').matches || (event.target as HTMLElement).closest('button')) return;
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  return (
    <div className="assistant-dock" data-open={open}>
      <button ref={trigger} type="button" className="assistant-dock-trigger" aria-expanded={open}
        aria-controls="assistant-dock-panel" aria-label={open ? '关闭圆桌骑士' : '打开圆桌骑士'}
        onClick={() => {
          if (open) dismiss();
          else {
            setHasOpened(true);
            setOpen(true);
          }
        }}>
        <Suspense fallback={illustration}><KnightModel open={open} fallback={illustration} /></Suspense>
        <span className="assistant-dock-grip" aria-hidden="true" />
      </button>
      {hasOpened && (
        <aside ref={panel} className="assistant-dock-panel" id="assistant-dock-panel" hidden={!open}
          data-expanded={expanded}
          aria-labelledby="assistant-dock-title">
          {open && <span className="assistant-dock-toss" aria-hidden="true">♦</span>}
          <header className="assistant-dock-heading" onPointerDown={startDrag}
            onPointerMove={event => {
              const start = drag.current;
              if (start?.id === event.pointerId) {
                placePanel(start.left + event.clientX - start.x, start.top + event.clientY - start.y);
              }
            }}
            onLostPointerCapture={() => { drag.current = null; }}>
            <h2 id="assistant-dock-title">圆桌骑士</h2>
            <button type="button" className="assistant-sheet-handle"
              aria-label={expanded ? '缩小对话窗口' : '展开对话窗口'} aria-expanded={expanded}
              onClick={event => {
                if (event.detail === 0 || !sheetSwiped.current) setExpanded(value => !value);
              }}
              onPointerDown={event => {
                sheetSwiped.current = false;
                if (event.pointerType !== 'touch') return;
                sheetGesture.current = { id: event.pointerId, y: event.clientY };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerUp={event => {
                const start = sheetGesture.current;
                if (start?.id !== event.pointerId) return;
                const distance = event.clientY - start.y;
                if (Math.abs(distance) < 32) return;
                // Suppress the click synthesized after a completed swipe.
                sheetSwiped.current = true;
                if (distance < 0) setExpanded(true);
                else if (expanded) setExpanded(false);
                else dismiss();
              }}
              onLostPointerCapture={() => { sheetGesture.current = null; }} />
            <button ref={close} type="button" className="secondary" onClick={dismiss}>关闭对话</button>
          </header>
          {children}
        </aside>
      )}
    </div>
  );
}
