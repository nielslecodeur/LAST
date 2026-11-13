import type { ButtonHTMLAttributes, ReactNode } from "react";

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(" ");
}

export function Card(props: { title?: ReactNode; aside?: ReactNode; className?: string; children: ReactNode; id?: string }) {
  return (
    <section
      id={props.id}
      aria-label={typeof props.title === "string" ? props.title : undefined}
      className={cx("hard bg-panel p-5 sm:p-6", props.className)}
    >
      {(props.title || props.aside) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {props.title && <h2 className="font-poster text-xl uppercase tracking-wide text-text">{props.title}</h2>}
          {props.aside}
        </header>
      )}
      {props.children}
    </section>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({ variant = "primary", className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    primary: "hard press bg-acid text-panel-2 hover:bg-acid-deep disabled:border-line disabled:bg-panel-2 disabled:text-mute disabled:shadow-none",
    secondary: "border-2 border-text bg-panel-2 text-text hover:bg-flame/40 disabled:border-line disabled:text-mute disabled:hover:bg-panel-2",
    ghost: "text-mute hover:text-text disabled:opacity-50",
    danger: "hard press bg-heat text-panel-2 hover:brightness-110 disabled:border-line disabled:bg-panel-2 disabled:text-mute disabled:shadow-none",
  };
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-2 px-4 py-3 font-semibold transition-colors disabled:cursor-not-allowed",
        styles[variant],
        className,
      )}
    />
  );
}

type Tone = "acid" | "heat" | "gold" | "sky" | "mute";

export function Badge({ tone = "mute", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  const tones: Record<Tone, string> = {
    acid: "border-acid bg-acid text-panel-2",
    heat: "border-heat bg-heat text-panel-2",
    gold: "border-text bg-flame text-text",
    sky: "border-text bg-panel-2 text-text",
    mute: "border-line bg-panel-2 text-mute",
  };
  return (
    <span className={cx("inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Stat(props: { label: ReactNode; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cx("min-w-0 border border-line bg-panel-2 p-3", props.className)}>
      <div className="text-[11px] font-medium uppercase tracking-wider text-mute">{props.label}</div>
      <div className="mt-1 truncate font-mono text-base font-bold tabular text-text">{props.value}</div>
      {props.hint && <div className="mt-0.5 text-[11px] text-mute">{props.hint}</div>}
    </div>
  );
}

export function Row(props: { label: ReactNode; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="text-mute">{props.label}</span>
      <span className={cx("text-right font-mono tabular", props.strong ? "font-bold text-text" : "text-text/90")}>{props.value}</span>
    </div>
  );
}

export function Dash() {
  return <span className="text-mute">—</span>;
}

export function CrownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <path d="M12 46 9 20l13 10 10-16 10 16 13-10-3 26z" fill="currentColor" />
      <rect x="12" y="49" width="40" height="5" rx="2" fill="currentColor" />
    </svg>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cx("underline decoration-line underline-offset-4 hover:text-acid hover:decoration-acid", className)}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
