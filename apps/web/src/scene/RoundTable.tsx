import { useEffect, useRef, useState } from 'react';
import { createRoundTableScene, type RoundTableHandle } from './tableScene';

interface RoundTableProps {
  memberCount: number;
  myIndex: number;
  stepKey: number;
}

export default function RoundTable({ memberCount, myIndex, stepKey }: RoundTableProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<RoundTableHandle | undefined>(undefined);
  const initialRef = useRef({ memberCount, myIndex });
  const membersRef = useRef({ memberCount, myIndex });
  const [activeSeat, setActiveSeat] = useState<number | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const handle = createRoundTableScene(hostRef.current, {
      memberCount: initialRef.current.memberCount,
      myIndex: initialRef.current.myIndex,
      reducedMotion,
      onSeatChange: setActiveSeat,
    });
    sceneRef.current = handle;
    handle.burst();
    return () => {
      handle.dispose();
      sceneRef.current = undefined;
    };
  }, []);

  // 名单变化（加入 / 移除 / 移交房主）必须同步到圆桌人数与本人光环，
  // 否则场景会停留在挂载时的快照，与真实成员状态不一致。
  useEffect(() => {
    const previous = membersRef.current;
    if (previous.memberCount === memberCount && previous.myIndex === myIndex) return;
    membersRef.current = { memberCount, myIndex };
    sceneRef.current?.updateMembers(memberCount, myIndex);
  }, [memberCount, myIndex]);

  useEffect(() => {
    sceneRef.current?.burst();
  }, [stepKey]);

  return (
    <>
      <div className="round-table-scene" ref={hostRef} aria-hidden="true" />
      {activeSeat !== null && (
        <span className="seat-tag" aria-hidden="true">
          {activeSeat === myIndex ? '你' : `成员 ${activeSeat + 1}`}
        </span>
      )}
    </>
  );
}
