/**
 * ------------------------------------------------------------------
 *  Title    |  Icons
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The family's hand-drawn line set: 16 grid, 1.5 stroke,
 *           |  round caps, currentColor, no fill. No icon library, so
 *           |  every glyph sits on the same pen.
 * ------------------------------------------------------------------
 */

const PATHS = {
  branch:
    'M5 2.5v7M5 9.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM11 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM11 6.5c0 3-6 1.5-6 5',
  check: 'M3.5 8.5l3 3 6-7',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  edit: 'M3 13l1-3.5 7-7 2.5 2.5-7 7L3 13ZM9.5 4l2.5 2.5',
  regenerate: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3',
  model: 'M8 2.5l5 2.75v5.5L8 13.5l-5-2.75v-5.5L8 2.5ZM3 5.25l5 2.75 5-2.75M8 8v5.5',
  cite: 'M4 4.5h8M4 8h8M4 11.5h5',
  factcheck: 'M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4l5-2ZM5.75 8l1.6 1.6 3-3.2',
  close: 'M4 4l8 8M12 4l-8 8',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM10.6 10.6 14 14',
  plus: 'M8 3v10M3 8h10',
  chevronLeft: 'M10 3.5 5.5 8l4.5 4.5',
  chevronRight: 'M6 3.5 10.5 8 6 12.5',
  chevronDown: 'M3.5 6 8 10.5 12.5 6',
  notebook: 'M4 2.5h7.5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4zM4 2.5v11M6.5 5.5h4',
  thread:
    'M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5A1.5 1.5 0 0 1 12 10.5H7l-3 3v-3a1.5 1.5 0 0 1-1.5-1.5Z',
  // Sliders, not a gear: the old rayed gear read as the theme sun at 14px.
  settings: 'M2.5 4h6M11.5 4h2M2.5 8h2M7.5 8h6M2.5 12h7.5M13 12h.5M10 2.5v3M6 6.5v3M11.5 10.5v3',
  pulse: 'M1.5 8h3l1.5-4 3 8 1.5-4h4',
  node: 'M2.5 3.5h11v4h-11zM2.5 8.5h11v4h-11zM5 5.5h.01M5 10.5h.01',
  shield: 'M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4l5-2Z',
  sun: 'M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1',
  moon: 'M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z',
  monitor: 'M2 3h12v8H2zM6 14h4M8 11v3',
  upload: 'M8 10.5V2.5M5 5.5l3-3 3 3M3 10v3h10v-3',
  logs: 'M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5',
  tree: 'M4 3v10M4 5.5h4.5M4 10.5h4.5M10.5 5.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0ZM10.5 10.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Z',
  why: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.4M8 11.3h.01',
  evidence: 'M3 13V5l5-2.5L13 5v8M6 13V8h4v5',
  sources: 'M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3',
  warn: 'M8 2.5l6 10.5H2L8 2.5ZM8 6.5v3M8 11.25h.01',
  alert: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM8 5v3.5M8 10.75h.01',
  question: 'M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.4M8 11.3h.01',
  keyboard: 'M2 4.5h12v7H2zM4.5 7h.01M7 7h.01M9.5 7h.01M12 7h.01M5 9.5h6',
  panelLeft: 'M2.5 3h11v10h-11zM6 3v10',
  panelRight: 'M2.5 3h11v10h-11zM10 3v10',
  bell: 'M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3L4 11ZM6.5 14h3',
  send: 'M8 13V3M4 7l4-4 4 4',
  stop: 'M4.5 4.5h7v7h-7z',
  attach: 'M10.5 5 6 9.5a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4-4',
  memory: 'M3.5 3h9v10h-9zM6 6h4M6 8.5h4M6 11h2',
  key: 'M10 9.5a3.5 3.5 0 1 0-3.4-2.7L2.5 11v2.5H5V12h1.5v-1.5H8l.7-.7c.4.1.9.2 1.3.2ZM11 5h.01',
  copyDebug: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7M8 8h2.5M8 10h1.5',
  dot: 'M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  ext: 'M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5',
  undo: 'M5 5.5H10a3 3 0 0 1 0 6H6M5 5.5 7.5 3M5 5.5 7.5 8',
  merge: 'M4 2.5v3c0 2 4 3 4 5v3M12 2.5v3c0 2-4 3-4 5',
  compare: 'M3 3h4v10H3zM9 3h4v10H9z',
  pin: 'M9.5 2.5l4 4M11.5 4.5l-3 3-3-.5-1.5 1.5 4 4 1.5-1.5-.5-3 3-3M5.5 10.5l-3 3',
  archive: 'M2.5 3.5h11v3h-11zM3.5 6.5v6h9v-6M6.5 9h3',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4',
  more: 'M3 8a1 1 0 1 0 2 0 1 1 0 0 0-2 0ZM7 8a1 1 0 1 0 2 0 1 1 0 0 0-2 0ZM11 8a1 1 0 1 0 2 0 1 1 0 0 0-2 0Z',
  file: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1',
  text: 'M3 4h10M3 7h10M3 10h7M3 13h5',
  globe:
    'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2.5 8h11M8 2.5c1.6 1.7 2.3 3.5 2.3 5.5S9.6 11.8 8 13.5M8 2.5C6.4 4.2 5.7 6 5.7 8s.7 3.8 2.3 5.5',
  book: 'M3 3.5h3.5A1.5 1.5 0 0 1 8 5v8.5A1.5 1.5 0 0 0 6.5 12H3zM13 3.5H9.5A1.5 1.5 0 0 0 8 5v8.5A1.5 1.5 0 0 1 9.5 12H13z',
  star: 'M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1l-3.4 1.8.7-3.8-2.8-2.6 3.8-.5L8 2.5Z',
  user: 'M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 13.5c.6-2.4 2.6-3.5 5-3.5s4.4 1.1 5 3.5',
  lock: 'M4 7.5h8v6H4zM5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2',
  download: 'M8 2.5v8M5 7.5l3 3 3-3M3 13.5h10',
  paint:
    'M8 2.5a5.5 5.5 0 0 0 0 11c1 0 1.3-.8.9-1.5-.5-.9 0-1.8 1.1-1.8H12a1.5 1.5 0 0 0 1.5-1.5C13.5 5.2 11 2.5 8 2.5ZM5.2 7.2h.01M7.5 5h.01M10.5 5.8h.01',
  type: 'M3.5 4.5v-1h9v1M8 3.5v9M6.5 12.5h3',
  layout: 'M2.5 3.5h11v9h-11zM6 3.5v9M6 7.5h7.5',
  eye: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  play: 'M5 3.5v9l7-4.5-7-4.5Z',
  sparkle: 'M8 2.5l1.2 3.3 3.3 1.2-3.3 1.2L8 11.5 6.8 8.2 3.5 7l3.3-1.2L8 2.5ZM12.5 11v2.5M11.25 12.25h2.5',
  filter: 'M2.5 3.5h11l-4 5v4l-3 1.5v-5.5l-4-5Z',
  grid: 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z',
  folder: 'M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z',
  arrowUp: 'M8 13V3M4 7l4-4 4 4',
  arrowDown: 'M8 3v10M4 9l4 4 4-4',
  arrowRight: 'M3 8h10M9 4l4 4-4 4',
  command:
    'M5.5 5.5h5v5h-5zM5.5 5.5H4a1.5 1.5 0 1 1 1.5-1.5zM10.5 5.5V4A1.5 1.5 0 1 1 12 5.5zM10.5 10.5H12a1.5 1.5 0 1 1-1.5 1.5zM5.5 10.5V12A1.5 1.5 0 1 1 4 10.5z',
  note: 'M3.5 2.5h9v11h-9zM6 5.5h4M6 8h4M6 10.5h2',
  minus: 'M3.5 8h9',
  seal: 'M8 2l1.4 1.2 1.8-.3.6 1.7 1.7.6-.3 1.8L14 8l-1.2 1.4.3 1.8-1.7.6-.6 1.7-1.8-.3L8 14l-1.4-1.2-1.8.3-.6-1.7-1.7-.6.3-1.8L2 8l1.2-1.4-.3-1.8 1.7-.6.6-1.7 1.8.3L8 2ZM5.8 8.2l1.5 1.5 3-3',
  hash: 'M6 2.5l-1 11M11 2.5l-1 11M3 6h10.5M2.5 10H13',
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10.5 6h.01',
  quote: 'M3.5 11.5V9a3 3 0 0 1 3-3M9.5 11.5V9a3 3 0 0 1 3-3M3.5 9h2.5v2.5H3.5M9.5 9H12v2.5H9.5',
  expand: 'M9.5 2.5h4v4M13.5 2.5l-4.5 4.5M6.5 13.5h-4v-4M2.5 13.5L7 9',
  zap: 'M9 2L3.5 9H8l-1 5 5.5-7H8l1-5Z',
  clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM8 5v3.2l2 1.3',
  inbox: 'M2.5 9l1.5-5.5h8L13.5 9v4h-11zM2.5 9h3l1 1.5h3l1-1.5h3',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  label,
  className,
}: {
  name: IconName;
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <svg
      className={['icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
