import { useEffect, useRef, type ReactNode } from 'react';

export type EntryCard = 'create' | 'join';

const cards = [
  { id: 'create', label: '创建房间', suit: '♠', rank: 'A' },
  { id: 'join', label: '加入房间', suit: '♥', rank: 'K' },
] as const;

export function CamelotSeat({ card, onChoose, children }: {
  card: EntryCard | null;
  onChoose?: (card: EntryCard | null) => void;
  children?: ReactNode;
}) {
  const formSurface = useRef<HTMLDivElement>(null);
  const cardButtons = useRef<HTMLDivElement>(null);
  const lastCard = useRef<EntryCard | null>(null);

  useEffect(() => {
    if (card) {
      lastCard.current = card;
      formSurface.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    } else if (lastCard.current) {
      cardButtons.current?.querySelector<HTMLButtonElement>(`[data-card="${lastCard.current}"]`)?.focus();
    }
  }, [card]);

  if (!card) {
    return (
      <div className="camelot-deck" ref={cardButtons} aria-label="选择入席方式">
        {cards.map(item => (
          <button key={item.id} data-card={item.id} className="camelot-card" type="button"
            onClick={() => onChoose?.(item.id)}>
            <span className="camelot-card-face">
              <span className="camelot-card-back" aria-hidden="true">
                <span className="camelot-card-corner">{item.rank}<br />{item.suit}</span>
                <span className="camelot-card-suit">{item.suit}</span>
                <span className="camelot-card-corner opposite">{item.rank}<br />{item.suit}</span>
              </span>
              <span className="camelot-card-label">{item.label}</span>
            </span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <section className="camelot-seat" aria-label="你的席位">
      <div className="camelot-seat-marker">
        <span aria-hidden="true">{card === 'create' ? '♠' : '♥'}</span>
        <span>{card === 'create' ? '房主席' : '来宾席'}</span>
        {onChoose && <button type="button" className="text-button" onClick={() => onChoose(null)}>返回选牌</button>}
      </div>
      <div className="camelot-form-surface" ref={formSurface} key={card}>
        {children}
      </div>
    </section>
  );
}
