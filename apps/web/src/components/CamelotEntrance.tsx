import { useEffect, useRef, useState } from 'react';

export function camelotAsset(name: string): string {
  return `${import.meta.env.BASE_URL}camelot/${name}`;
}

export function CamelotEntrance() {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'playing' | 'buffering' | 'fallback' | 'done'>('idle');
  const film = useRef<HTMLVideoElement>(null);
  const launch = useRef<HTMLButtonElement>(null);
  const skip = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    launch.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (phase === 'idle' || phase === 'done') return;
    skip.current?.focus({ preventScroll: true });
    if (phase === 'playing') return;
    if (phase === 'fallback') film.current?.pause();
    const timer = window.setTimeout(
      () => setPhase(phase === 'fallback' ? 'done' : 'fallback'),
      phase === 'fallback' ? 1200 : 12_000,
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase === 'done') document.querySelector<HTMLElement>('.camelot-deck button')?.focus({ preventScroll: true });
  }, [phase]);

  function start() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPhase('fallback');
      return;
    }
    setPhase('loading');
    void film.current?.play().catch(useFallback);
  }

  function useFallback() {
    setPhase(current => current === 'loading' || current === 'playing' || current === 'buffering'
      ? 'fallback' : current);
  }

  if (phase === 'done') return null;

  return (
    <div className="camelot-entrance" role="dialog" aria-modal="true" aria-label="卡美洛门厅"
      onKeyDown={event => {
        if (event.key === 'Escape') setPhase('done');
        if (event.key === 'Tab') {
          event.preventDefault();
          const next = document.activeElement === launch.current ? skip.current : launch.current ?? skip.current;
          next?.focus();
        }
      }}>
      <img src={camelotAsset('gate.png')} alt="" />
      <video ref={film} className={phase === 'playing' || phase === 'buffering' ? 'visible' : ''}
        src={camelotAsset('entry.mp4')} muted playsInline preload="metadata" aria-hidden="true"
        onPlaying={() => setPhase(current => current === 'loading' || current === 'buffering' ? 'playing' : current)}
        onWaiting={() => setPhase(current => current === 'playing' ? 'buffering' : current)}
        onEnded={() => setPhase(current => current === 'playing' || current === 'buffering' ? 'done' : current)}
        onError={useFallback} />
      {(phase === 'idle' || phase === 'loading') && <div className="camelot-wordmark" aria-hidden="true">CAMELOT</div>}
      {phase === 'idle' && <button ref={launch} type="button" className="camelot-launch"
        onClick={start}>点击进入 · Enter</button>}
      {phase === 'loading' && <p className="camelot-loading" role="status">法阵正在点亮…</p>}
      {phase === 'buffering' && <p className="camelot-loading" role="status">正在载入下一幕…</p>}
      {phase === 'fallback' && <div className="camelot-arrival" role="status"><span>圆桌议事厅</span></div>}
      <button ref={skip} type="button" className="camelot-skip" onClick={() => setPhase('done')}>跳过动画</button>
    </div>
  );
}
