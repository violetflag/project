type P = { className?: string };
const base = "h-4 w-4 shrink-0";

export const HomeIcon = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="currentColor"><path d="M10 2.5 2.5 9v8.5h5v-5h5v5h5V9z" /></svg>
);
export const FolderIcon = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="currentColor"><path d="M2.5 4.5h5l1.5 2h8.5v9h-15z" /></svg>
);
export const BoardIcon = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="currentColor"><path d="M3 4h14v3H3zm0 5h14v3H3zm0 5h14v3H3z" /></svg>
);
export const PlugIcon = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="currentColor"><path d="M7 2v4H5v4a5 5 0 0 0 4 4.9V18h2v-3.1A5 5 0 0 0 15 10V6h-2V2h-2v4H9V2z" /></svg>
);
export const TrashIcon = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="currentColor"><path d="M7 2h6v2h4v2H3V4h4zm-2 5h10l-1 11H6z" /></svg>
);
export const BellIcon = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="currentColor"><path d="M10 2a5 5 0 0 0-5 5v4l-2 3h14l-2-3V7a5 5 0 0 0-5-5zm-2 14a2 2 0 0 0 4 0z" /></svg>
);
export const LockIcon = ({ className = "h-3 w-3 shrink-0" }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="currentColor"><path d="M6 8V6a4 4 0 1 1 8 0v2h1v10H5V8zm2 0h4V6a2 2 0 1 0-4 0z" /></svg>
);
export const ChevronDown = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m5 8 5 5 5-5" /></svg>
);
export const ArrowUp = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 16V4m-5 5 5-5 5 5" /></svg>
);
export const ArrowRight = ({ className = "h-3 w-3" }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 10h12m-5-5 5 5-5 5" /></svg>
);
export const Sparkle = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="currentColor"><path d="M10 1.5 12 8l6.5 2-6.5 2-2 6.5L8 12l-6.5-2L8 8z" /></svg>
);
export const Paperclip = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m14 7-6 6a2 2 0 0 1-3-3l7-7a3.5 3.5 0 0 1 5 5l-7 7a5 5 0 0 1-7-7l6-6" /></svg>
);
export const Close = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m5 5 10 10M15 5 5 15" /></svg>
);
export const Gear = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="currentColor"><path d="M8.5 2h3l.5 2.2 1.6.9 2.1-.8 1.5 2.6-1.6 1.5v1.8l1.6 1.5-1.5 2.6-2.1-.8-1.6.9-.5 2.2h-3L8 15.8l-1.6-.9-2.1.8-1.5-2.6 1.6-1.5V9.8L2.8 8.3l1.5-2.6 2.1.8L8 5.6zM10 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z" /></svg>
);
export const UserPlus = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="currentColor"><path d="M8 3a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zm-6 14a6 6 0 0 1 12 0zm13-9h2v2h2v2h-2v2h-2v-2h-2v-2h2z" /></svg>
);
export const Card = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="currentColor"><path d="M2 5h16v2H2zm0 4h16v6H2z" /></svg>
);
export const Plus = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10 4v12M4 10h12" /></svg>
);
export const Chat = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 4h14v10H8l-4 3v-3H3z" /><path d="M7 9h.01M10 9h.01M13 9h.01" strokeLinecap="round" strokeWidth="2.2" /></svg>
);
export const Megaphone = ({ className = base }: P) => (
  <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 8v4h3l6 4V4L6 8zm12 0a3 3 0 0 1 0 4" /></svg>
);
