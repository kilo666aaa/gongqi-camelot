import type { ReactNode } from 'react';

type SpotlightCardProps = {
  children: ReactNode;
  className?: string | undefined;
};

// 候选卡只承担信息分组。指针跟随光斑是纯装饰，已移除；
// 保留组件名与 children/className 接口，不改动调用点的业务结构。
export function SpotlightCard({ children, className }: SpotlightCardProps) {
  return (
    <article className={['candidate-card', className].filter(Boolean).join(' ')}>
      {children}
    </article>
  );
}
