"use client";

/**
 * 子路由渲染出错时显示（例如客户端异常），避免整页只有一句 Internal Server Error。
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-4 px-4 py-16 text-center text-[color:var(--sun-ink)]">
      <p className="text-lg font-bold">页面出了点问题</p>
      {error.digest ? (
        <p className="font-mono text-[0.65rem] text-[color:var(--sun-muted)]">参考号：{error.digest}</p>
      ) : null}
      <p className="text-sm text-[color:var(--sun-muted)]">可尝试清除缓存后刷新，或在项目目录执行 npm run dev:clean 再打开。</p>
      <button type="button" className="rounded-xl bg-amber-200 px-4 py-2 text-sm font-semibold text-amber-950" onClick={() => reset()}>
        再试一次
      </button>
    </div>
  );
}
