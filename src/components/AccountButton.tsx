import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LoaderCircle, LogOut, UserRound, X } from 'lucide-react';
import { useAccount } from '../account/AccountProvider';
import './account.css';

export default function AccountButton() {
  const { user, loading, busy, isGoogle, error, signInGoogle, signInExistingGoogle, signOut, clearError } = useAccount();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open && !error) return;
    const outside = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); clearError(); } };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [open, error, clearError]);

  return <div className="account-control" ref={container}>
    {isGoogle ? <button className="account-trigger" aria-expanded={open} aria-label="Account menu" onClick={() => setOpen(value => !value)}><UserRound size={17} /><span>Account</span><ChevronDown size={13} /></button>
      : <button className="account-trigger account-google" aria-label="Sign in with Google" disabled={loading || busy} onClick={() => { void signInGoogle(); }}>{loading || busy ? <LoaderCircle className="spin" size={16} /> : <span className="account-google-g" aria-hidden="true">G</span>}<span>Sign in<span className="account-google-label"> with Google</span></span></button>}
    {(open || error) && <div className="account-popover">
      <button className="icon-button account-close" aria-label="Close account menu" onClick={() => { setOpen(false); clearError(); }}><X size={16} /></button>
      {isGoogle && <><strong>Your Numora account</strong><p className="account-email">{user?.email || 'Connected with Google'}</p><p>Your daily results and friends follow your account.</p><button className="secondary-button" disabled={busy} onClick={() => { void signOut().then(() => setOpen(false)); }}><LogOut size={15} /> Sign out</button></>}
      {error && <p className="account-error" role="alert">{error}</p>}
      {!isGoogle && error && <><p>Already have a Numora account? Signing in to it switches away from this browser’s guest identity.</p><button className="secondary-button" disabled={busy} onClick={() => { void signInExistingGoogle(); }}>Use an existing Google account</button></>}
    </div>}
  </div>;
}
